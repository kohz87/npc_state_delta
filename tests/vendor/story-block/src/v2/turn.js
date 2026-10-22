// A turn (docs/v2/SPEC.md §4, §5): Story Suite's SillyTavern wiring.
//
// Before the reply (the generation interceptor, for normal, swipe, regenerate and continue):
// flush pending saves, let modules add cues (beforeGenerate), collect the untold receipts and
// assemble the two prompt texts; the static part goes in-prompt, this reply's part in-chat at
// depth 0. The interceptor's context size holds them to a share of it (prompt.js contextFit): the
// tail is cut to fit (what modules send under their own keys, their `ownPrompt` hooks, counts toward it
// too), and when the static part alone is too big the reader is told once per chat. Quiet and impersonate generations (and any other kind) get both slots emptied.
// At prompt-ready: hidden change blocks leave the prompt history, and when the preset left out
// the Main Prompt (SillyTavern then drops in-prompt text) the static part is put back at the
// start of this reply's part, for the story's own prompt only.
// A module's canGenerate hook may stop a story generation first (the interceptor's abort).
// After the reply (MESSAGE_RECEIVED for the carrier the interceptor prepared): read its
// <Changes> block, run each line as its owner's capture command (cause 'story'), append what
// was accepted, record what the reply was told, save once. A line no module takes, or one its
// owner rejects, goes to the Problems list; nothing is thrown at the reader.
// A failed save (before or after the reply) is told and logged but never drops the turn: the state
// stays in memory, marked unsaved, and the save is tried again after the reply.
//
// turn.js receives the SillyTavern context and the host parts; it never imports the store or
// the command bus (their interfaces are docs/v2/SPEC.md §12).

import { continuation, cutLine, defangMarker, extractBlock, grammarHeads, hideBlock, parseChanges, strayLines, stripBlock } from './capture.js';
import { readDisplayLine } from './extras.js';
import { hash, readRecord } from './persist.js';
import { CAPTURE_PREFIX } from './registry.js';
import { STATIC_MARKER, assemble, contextNotice, estimateTokens } from './prompt.js';
import { MAX_CHANGE_LINES, ensureModules, makeView } from './sdk.js';
import { cutAt } from '../text.js';

export const STATIC_KEY = 'story_suite_static';
export const TAIL_KEY = 'story_suite_tail_1';
// Story Block v1's keys (0.9.21+ and before), cleared on load so an old copy never lingers.
export const V1_KEYS = Object.freeze([
    ['story_suite_static_story_block', 'static'],
    ['story_suite_tail_1_story_block', 'tail'],
    ['story_block', 'static'],
]);
export const FOREGROUND = Object.freeze(['normal', 'swipe', 'regenerate', 'continue']);
// A module's `ownPrompt` hook: at most this many parts, each counted up to this many characters.
export const OWN_PROMPT_PARTS = 8;
export const OWN_PROMPT_CHARS = 200000;
export const INTERCEPTOR_NAME = 'storyBlockGenerationInterceptor';
// SillyTavern's extension_prompt_types and extension_prompt_roles, when the context lacks them.
const IN_PROMPT = 0;
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const MAX_PROBLEMS = 200;
// How long a canGenerate or beforeGenerate hook may take before the reply goes on without it.
export const HOOK_TIMEOUT_MS = 2500;
// A reply that never ends (no MESSAGE_RECEIVED, GENERATION_ENDED or STOPPED) stops counting as in progress
// after this long, so Story Suite's own model calls on the chat's connection are not held up for good.
export const REPLY_BUSY_MAX_MS = 5 * 60_000;
const TIMED_OUT = Symbol('timed out');

// `value`, or TIMED_OUT when it is a promise that has not settled within `ms`.
async function within(value, ms) {
    if (!value || typeof value.then !== 'function') return value;
    let timer;
    try {
        return await Promise.race([value, new Promise(resolve => { timer = setTimeout(resolve, ms, TIMED_OUT); })]);
    } finally {
        clearTimeout(timer);
    }
}
// A name filled in for {{user}} / {{char}} is one line of at most this many characters.
export const MAX_NAME = 80;
// Stripped history texts kept between prompts (each is read again for every later prompt).
const STRIP_CACHE = 500;
const HAS_BLOCK = /<changes/i;

const defaultNotify = reason => globalThis.toastr?.warning?.(reason, 'Story Suite');

/**
 * The room the prompt has, from the interceptor's `size` and SillyTavern's context `c`: { size (the
 * context size the reader set), reply (the reply's length, or null), room (tokens the prompt may take) }
 * or null. SillyTavern 1.19 hands the interceptor its context size less the reply's length
 * (getMaxContextSize); the API settings tell the context size the reader set and the reply's length, and
 * take the reply off a size that still holds it. Without a size, the settings alone (the settings' prompt
 * size before a reply).
 */
export function contextRoom(c, size = null) {
    const n = value => {
        const x = Number(value);
        return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
    };
    const cc = c?.mainApi === 'openai' ? c?.chatCompletionSettings : null;
    const full = n(cc ? cc.openai_max_context : c?.maxContext);
    const reply = n(cc ? cc.openai_max_tokens : c?.amount_gen ?? c?.amountGen);
    const given = n(size);
    if (given) {
        if (full && reply && given === full - reply) return { size: full, reply, room: given };
        if (full && reply && given === full && reply < full) return { size: full, reply, room: full - reply };
        return { size: given, reply: null, room: given };
    }
    if (full) return { size: full, reply, room: reply && reply < full ? full - reply : full };
    return null;
}

export const normalizeType = type => String(type ?? 'normal').trim().toLowerCase() || 'normal';

/**
 * SillyTavern runs its macros over extension prompts, which would rewrite a `{{user}}` or
 * `<USER>` inside a name the story introduced. A zero-width space keeps them as written.
 */
export function defuseMacros(text) {
    return String(text ?? '')
        .replace(/\{\{/g, '{​{')
        .replace(/<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi, '<​$1>');
}

// A persona or character name as it goes into a prompt: one line (no line breaks or other control
// characters, so it cannot start a [Happened] or <Changes> line of its own), at most MAX_NAME long.
export function flatName(value) {
    const flat = String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
    return flat.length > MAX_NAME ? `${cutAt(flat, MAX_NAME - 1).trimEnd()}…` : flat;
}

/**
 * `{{user}}` and `{{char}}` in the static and tail text become the persona's and the character's
 * names (SillyTavern's substituteParams when the context has it, else name1 / name2), flattened to
 * one short line (flatName); any other macro is left for defuseMacros. Both names are fixed for a
 * chat, so the static text stays byte-identical reply after reply.
 */
export function substituteNames(text, ctx) {
    const cache = new Map();
    const name = macro => {
        const key = macro.toLowerCase();
        if (!cache.has(key)) {
            let value = null;
            try { value = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(`{{${key}}}`) : null; } catch { value = null; }
            if (typeof value !== 'string' || value === `{{${key}}}`) value = key === 'user' ? ctx?.name1 : ctx?.name2;
            const flat = typeof value === 'string' ? flatName(value) : '';
            cache.set(key, flat || null);
        }
        return cache.get(key);
    };
    return String(text ?? '').replace(/\{\{\s*(user|char)\s*\}\}/gi, (whole, macro) => name(macro) ?? whole);
}

// Message content is a string or, for multimodal prompts, a list of parts.
function mapContent(content, transform) {
    if (typeof content === 'string') return transform(content);
    if (!Array.isArray(content)) return content;
    return content.map(part => {
        if (typeof part === 'string') return transform(part);
        if (part && typeof part === 'object' && typeof part.text === 'string') return { ...part, text: transform(part.text) };
        return part;
    });
}
function contentText(content) {
    const texts = [];
    mapContent(content, text => { texts.push(text); return text; });
    return texts.join('\n');
}
const firstLine = text => String(text ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
const isCarrier = message => Boolean(message) && !message.is_user;

/**
 * Chat completion, the story's own prompt: puts back what SillyTavern left out. When the static
 * text is missing (the preset has no Main Prompt) it goes at the start of this reply's part;
 * when that is missing too, both go in as one system message right before the reply (before a
 * trailing assistant message, a Continue's own text). Returns what it did: '' | 'static' | 'both'.
 */
export function restoreMissing(chat, staticText, tailText) {
    if (!Array.isArray(chat) || !staticText) return '';
    const has = text => {
        const marker = firstLine(text);
        return marker ? chat.findIndex(message => contentText(message?.content).includes(marker)) : -1;
    };
    if (has(STATIC_MARKER) >= 0 || has(staticText) >= 0) return '';
    const at = tailText ? has(tailText) : -1;
    if (at >= 0) {
        const message = chat[at];
        let done = false;
        message.content = mapContent(message.content, part => {
            if (done || !part.includes(firstLine(tailText))) return part;
            done = true;
            const index = part.indexOf(firstLine(tailText));
            return `${part.slice(0, index)}${staticText}\n\n${part.slice(index)}`;
        });
        return 'static';
    }
    const index = chat.length && chat.at(-1)?.role === 'assistant' ? chat.length - 1 : chat.length;
    chat.splice(index, 0, { role: 'system', content: [staticText, tailText].filter(Boolean).join('\n\n') });
    return 'both';
}

/**
 * Wires one SillyTavern context. `deps`: { ctx, live?() (SillyTavern's live context, for its API settings;
 * default ctx), store, bus, registry, settings, events?,
 * onBlocked?(reason, moduleId), notify?(reason, moduleId) (default: a toastr warning),
 * initial?() → the initial State for a chat with none (default registry.initialState(); the host
 * adds the packs' start, SPEC §2.6), ownPrompt?(eventData) → true for the prompt of Story Suite's own model
 * call on the chat's connection (model-call.js createOwnCalls().owns): never taken for the reply's }.
 * `settings` is createSettings() (settings() → host settings, settings(id) → a module's).
 * Returns { interceptor, install, uninstall, onPromptReady, onTextPromptReady, onMessageReceived,
 * onChatChanged, onChatRenamed, onTimelineChanged, onGenerationEnded, preview, report, problems, clearProblems, blocked, blockers, unblock,
 * session, replyBusy, whenIdle }.
 */
export function createTurn({ ctx, live = () => ctx, store, bus, registry, settings, events = null, onBlocked = null, notify = defaultNotify, initial = () => registry.initialState(), ownPrompt = () => false }) {
    const types = () => ctx?.extension_prompt_types ?? ctx?.extensionPromptTypes ?? {};
    const roles = () => ctx?.extension_prompt_roles ?? ctx?.extensionPromptRoles ?? {};
    const position = place => (place === 'static' ? types().IN_PROMPT ?? IN_PROMPT : types().IN_CHAT ?? IN_CHAT);
    const hostSettings = () => (typeof settings === 'function' ? settings() : settings ?? {});
    let session = null;
    let deferred = false;   // cues committed before a reply, left for the reply's save (runCues)
    let listeners = [];
    const problemLog = [];
    const blocks = [];
    let lastSize = null;          // the context size the last interceptor call was handed
    const toldSmall = new Set();  // chats whose reader was told the context is too small
    const liveContext = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const contextNow = () => contextRoom(liveContext(), lastSize);
    // A reply in progress: from its interceptor until it is received, ended, stopped or held back (or the
    // chat changes). Story Suite's own model calls on the chat's connection wait for it (whenIdle).
    let replyBusy = false;
    let busyTimer = null;
    let idleWaiters = [];
    function markBusy() {
        replyBusy = true;
        if (busyTimer !== null) clearTimeout(busyTimer);
        busyTimer = setTimeout(markIdle, REPLY_BUSY_MAX_MS);
        busyTimer?.unref?.();
    }
    function markIdle() {
        replyBusy = false;
        if (busyTimer !== null) clearTimeout(busyTimer);
        busyTimer = null;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
    }
    const whenIdle = () => (replyBusy ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve());
    // Our own model call's prompt (model-call.js) is never the reply's.
    const isOwn = eventData => {
        try { return ownPrompt(eventData) === true; } catch { return false; }
    };

    function setPrompt(key, text, place) {
        if (typeof ctx?.setExtensionPrompt !== 'function') return;
        ctx.setExtensionPrompt(key, text, position(place), 0, false, roles().SYSTEM ?? ROLE_SYSTEM);
    }
    function setPrompts(staticText, tailText) {
        setPrompt(STATIC_KEY, staticText, 'static');
        setPrompt(TAIL_KEY, tailText, 'tail');
    }
    const clearPrompts = () => setPrompts('', '');

    function problem(entry) {
        const item = { module: null, code: 'PROBLEM', ...entry };
        problemLog.push(item);
        if (problemLog.length > MAX_PROBLEMS) problemLog.splice(0, problemLog.length - MAX_PROBLEMS);
        // A quiet one (a line of a feature the reader turned off) is listed, not warned about.
        if (item.quiet !== true) console.warn(`[Story Suite] ${item.module ? `${item.module}: ` : ''}${item.message}`);
        return item;
    }

    // A save that fails never costs the turn (SPEC §3.3): the reader is told, the state stays in
    // memory marked unsaved, and the save is tried again after the reply (or with the next change).
    async function trySave(when) {
        try {
            await store.flush();
            return true;
        } catch (error) {
            const why = String(error?.message ?? error).trim().replace(/[.\s]*$/, '.');
            const reason = `The story could not be saved ${when}: ${why} It is kept and will be saved again.`;
            problem({ code: 'SAVE_FAILED', message: reason });
            try { notify?.(reason, null); } catch { /* a missing toastr is not an error */ }
            return false;
        }
    }

    const view = () => makeView({ store, registry, settings, chat: ctx?.chat });
    const hasCarrier = () => (ctx?.chat ?? []).some(isCarrier);
    const lastCarrier = () => (ctx?.chat ?? []).findLastIndex(isCarrier);

    // The chat's state starts on its first carrier; a damaged record set up again goes to the Problems.
    function ensureInitial() {
        const notes = store.ensureInitial(initial());
        for (const note of Array.isArray(notes) ? notes : []) problem({ code: 'DAMAGED', message: note });
    }

    function rebuild() {
        store.rebuild();
        if (hasCarrier()) ensureInitial();
        events?.emit('head', { index: store.headIndex() });
    }

    // beforeGenerate (§4.1 step 3): each hook may return lines for the tail, or commands to
    // commit now as `system` receipts: string[] | { lines?: string[], commands?: [{ type, payload }] }.
    // A Continue (the same reply goes on) commits nothing (B3-9): hooks are told `{ type, dryRun,
    // commit: false }` and their commands are not run. A dry run (SillyTavern counting tokens) never
    // gets here: SillyTavern 1.19 runs no interceptor for one (Generate: `if (!dryRun)`), so the
    // interceptor's own generation is never a dry run (r2-1).
    async function runCues(type = 'normal', { dryRun = false } = {}) {
        const cues = {};
        let committed = false;
        const commit = !dryRun && type !== 'continue';
        for (const { moduleId, fn } of registry.hookEntries('beforeGenerate')) {
            let out;
            try { out = await within(fn(view(), { type, dryRun, commit }), HOOK_TIMEOUT_MS); } catch (error) {
                problem({ module: moduleId, code: 'FAILED', message: `beforeGenerate failed: ${error?.message ?? error}` });
                continue;
            }
            if (out === TIMED_OUT) {
                problem({ module: moduleId, code: 'TIMEOUT', message: `beforeGenerate did not answer within ${HOOK_TIMEOUT_MS / 1000} s; the reply went on without its notes.` });
                continue;
            }
            const lines = Array.isArray(out) ? out : Array.isArray(out?.lines) ? out.lines : [];
            if (lines.length) cues[moduleId] = lines.filter(line => typeof line === 'string');
            for (const command of commit && Array.isArray(out?.commands) ? out.commands : []) {
                const result = await bus.command(command?.type, command?.payload ?? {}, { cause: 'system' });
                if (result?.ok) {
                    committed = true;
                    events?.emit('committed', { receipt: result.receipt });
                } else problem({ module: moduleId, code: result?.code ?? 'FAILED', message: `The cue "${command?.type}" was not committed: ${result?.message ?? 'unknown error'}` });
            }
        }
        // Saved with the reply (MESSAGE_RECEIVED), not now: each save writes the whole chat file, and the
        // reply's save comes moments later with these cues in it. A reply that never comes still has them
        // saved: GENERATION_ENDED / GENERATION_STOPPED and CHAT_CHANGED save what is unsaved.
        if (committed) {
            store.deferSave?.();
            deferred = true;
        }
        return cues;
    }

    // What modules send with the reply on their own, under their own prompt keys (SPEC §5: NPC State
    // Delta's dossiers): each `ownPrompt(view)` hook's [{ label, text }] (one { label, text } or a string
    // also do), read at once (a promise is not waited for), names filled in as SillyTavern fills them.
    // It is counted, never sent by Story Block: the share of the context (prompt.js contextFit) and the
    // settings' prompt size count it. A hook that throws or answers nothing counts nothing; the size is a
    // report, never a reason to hold the reply back. → [{ module, label, place: 'own', text, tokens }]
    function sentByModules(current) {
        const out = [];
        for (const { moduleId, fn } of registry.hookEntries('ownPrompt')) {
            let answer;
            try { answer = fn(current); } catch { continue; }
            if (typeof answer?.then === 'function') {
                answer.then?.(() => {}, () => {});
                continue;
            }
            const list = typeof answer === 'string' ? [{ text: answer }] : Array.isArray(answer) ? answer : answer && typeof answer === 'object' ? [answer] : [];
            const name = registry.module(moduleId)?.name ?? moduleId;
            for (const item of list.slice(0, OWN_PROMPT_PARTS)) {
                const raw = typeof item === 'string' ? item : item?.text;
                if (typeof raw !== 'string' || !raw.trim()) continue;
                const text = substituteNames(cutAt(raw, OWN_PROMPT_CHARS), ctx);
                const label = typeof item?.label === 'string' && item.label.trim() ? cutAt(item.label.replace(/\s+/g, ' ').trim(), 80) : name;
                out.push({ module: moduleId, label, place: 'own', text, tokens: estimateTokens(text) });
            }
        }
        return out;
    }

    function build(cues = {}) {
        const untold = store.untold();
        const current = view();
        const own = sentByModules(current);
        const ownTokens = own.reduce((sum, part) => sum + part.tokens, 0);
        const result = assemble({ registry, view: current, untold, settings: hostSettings(), cues, substitute: text => substituteNames(text, ctx), context: contextNow(), ownTokens });
        for (const message of result.problems) problem({ code: 'FAILED', message });
        return { ...result, own, untold };
    }

    /** SillyTavern's generate interceptor: (chat, contextSize, abort, type). */
    // canGenerate (MODULES §F12): every module may hold a story generation back, e.g. until the
    // player character exists. `false` or { ok: false, reason, action? } blocks; the first one is the answer.
    // A hook that throws, or does not answer within HOOK_TIMEOUT_MS, is logged and does not block
    // (a bug must not lock the reader out). `all` asks every module (Home's "Before you start"): the
    // list of those that hold back, nothing logged (it is asked again on each redraw).
    async function askCanGenerate({ all = false } = {}) {
        const found = [];
        for (const { moduleId, fn } of registry.hookEntries('canGenerate')) {
            let answer;
            try { answer = await within(fn(view()), HOOK_TIMEOUT_MS); } catch (error) {
                if (!all) problem({ module: moduleId, code: 'FAILED', message: `canGenerate failed: ${error?.message ?? error}` });
                continue;
            }
            if (answer === TIMED_OUT) {
                if (!all) problem({ module: moduleId, code: 'TIMEOUT', message: `canGenerate did not answer within ${HOOK_TIMEOUT_MS / 1000} s; the story went on.` });
                continue;
            }
            if (answer === false || (answer && typeof answer === 'object' && answer.ok === false)) {
                const name = registry.module(moduleId)?.name ?? moduleId;
                const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : `${name} is not ready for the story to go on yet.`;
                const entry = { moduleId, reason };
                if (all) {
                    // The button's words (a module's `action`, flattened, ≤ 40 code points), or false for none.
                    const action = answer?.action === false ? false
                        : typeof answer?.action === 'string' ? Array.from(answer.action.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()).slice(0, 40).join('').trim() : '';
                    entry.name = name;
                    entry.action = action;
                    entry.canOpen = action !== false && typeof onBlockedOf(moduleId) === 'function';
                } else return entry;
                found.push(entry);
            }
        }
        return all ? found : null;
    }
    const blockedBy = () => askCanGenerate();

    // A module's own onBlocked hook (what it does when it held the story back: RPG Battle opens the
    // character wizard). → true when it ran without throwing.
    // C3-2: through the off-aware hook list, so a hook whose feature is off is never called (nor offered).
    const onBlockedOf = moduleId => registry.hookEntries('onBlocked').find(entry => entry.moduleId === moduleId)?.fn ?? null;
    function runOnBlocked(moduleId, reason) {
        const fn = onBlockedOf(moduleId);
        if (typeof fn !== 'function') return false;
        try {
            fn(reason, moduleId);
            return true;
        } catch (error) {
            problem({ module: moduleId, code: 'FAILED', message: `onBlocked failed: ${error?.message ?? error}` });
            return false;
        }
    }

    function block({ moduleId, reason }, abort) {
        session = null;
        markIdle();
        clearPrompts();
        try { abort?.(true); } catch (error) { console.warn('[Story Suite] the generation could not be stopped', error); }
        try { notify?.(reason, moduleId); } catch { /* a missing toastr is not an error */ }
        runOnBlocked(moduleId, reason);
        if (typeof onBlocked === 'function') {
            try { onBlocked(reason, moduleId); } catch (error) {
                problem({ module: moduleId, code: 'FAILED', message: `onBlocked failed: ${error?.message ?? error}` });
            }
        }
        blocks.push({ moduleId, reason });
    }

    // The static part alone is over Story Suite's share of the context: told once per chat (a toast and the
    // Problems list); the reply still goes out with it.
    function tellTooSmall(fit) {
        if (!fit?.tooSmall) return;
        let chatId = null;
        try { chatId = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx?.chatId; } catch { chatId = null; }
        const key = String(chatId ?? '');
        if (toldSmall.has(key)) return;
        toldSmall.add(key);
        const reason = contextNotice(fit);
        problem({ code: 'CONTEXT_SMALL', message: reason });
        try { notify?.(reason, null); } catch { /* a missing toastr is not an error */ }
    }

    async function interceptor(_chat, contextSize, abort, type) {
        const kind = normalizeType(type);
        if (!FOREGROUND.includes(kind)) {
            // A quiet prompt built while the reply's own is pending must not carry its text; the
            // reply's prompt gets it back at the quiet prompt's prompt-ready (below).
            // A reply already on its way keeps its session, so it is still captured.
            if (session && !session.prompted) session.background += 1;
            clearPrompts();
            return;
        }
        if (!ctx?.chat) return;
        markBusy();
        if (Number.isFinite(Number(contextSize)) && Number(contextSize) > 0) lastSize = Number(contextSize);
        // B-b2-timeline-r2-1: never a dry run (SillyTavern runs interceptors only for real generations).
        // It is not read from GENERATION_STARTED: another caller's dry run (token counting) can start
        // between this generation's GENERATION_STARTED and this call, and would cost the reply its capture.
        try {
            await trySave('before the reply');
            // A Regenerate removes the old reply before this runs, without an event for it.
            if (store.headIndex() !== lastCarrier()) store.rebuild();
            if (hasCarrier()) store.ensureInitial(initial());
            await ensureModules({ store, bus, registry, events });
            const blocked = await blockedBy();
            if (blocked) {
                block(blocked, abort);
                return;
            }
            const cues = await runCues(kind);
            const built = build(cues);
            tellTooSmall(built.fit);
            const chat = ctx.chat;
            const last = chat.length - 1;
            const index = kind === 'swipe' || kind === 'continue' ? last : chat.length;
            session = {
                type: kind,
                index,
                untold: built.untold.map(receipt => receipt.id),
                staticText: defuseMacros(built.staticText),
                tailText: defuseMacros(built.tailText),
                parts: built.parts,
                // A Continue's reply was captured before: only blocks the continuation adds to this
                // text are read (capture.js continuation()).
                base: kind === 'continue' ? String(chat[last]?.mes ?? '') : null,
                prompted: false,
                background: 0,
                restored: '',
            };
            setPrompts(session.staticText, session.tailText);
        } catch (error) {
            session = null;
            markIdle();
            clearPrompts();
            problem({ code: 'FAILED', message: `The reply's notes could not be built: ${error?.message ?? error}` });
        }
    }

    // Every earlier reply is in every prompt: what its text is without blocks is remembered, and a
    // text with no "<changes" in it at all is passed by without reading it further.
    const stripped = new Map();
    function strippedText(text) {
        if (!HAS_BLOCK.test(text)) return text;
        let out = stripped.get(text);
        if (out === undefined) {
            out = extractBlock(text) === null ? text : stripBlock(text);
            if (stripped.size >= STRIP_CACHE) stripped.delete(stripped.keys().next().value);
            stripped.set(text, out);
        }
        return out;
    }
    function stripHistory(chat) {
        for (const message of chat) {
            if (message?.role !== 'assistant') continue;
            const content = mapContent(message.content, strippedText);
            if (content !== message.content) message.content = content;
        }
    }

    // A background prompt seen while the reply's own is pending: its slots were emptied for it;
    // fill them again for the reply. True when this prompt was the background one.
    function backgroundPrompt() {
        if (!session || session.prompted || session.background <= 0) return false;
        session.background -= 1;
        if (!session.background) setPrompts(session.staticText, session.tailText);
        return true;
    }

    /** CHAT_COMPLETION_PROMPT_READY: { chat, dryRun }. */
    function onPromptReady(eventData) {
        if (!eventData || eventData.dryRun === true || !Array.isArray(eventData.chat) || isOwn(eventData)) return;
        stripHistory(eventData.chat);
        if (backgroundPrompt() || !session || session.prompted) return;
        session.prompted = true;
        session.restored = restoreMissing(eventData.chat, session.staticText, session.tailText);
    }

    /** GENERATE_AFTER_COMBINE_PROMPTS (text completion): { prompt, dryRun }. */
    function onTextPromptReady(eventData) {
        if (!eventData || eventData.dryRun === true || typeof eventData.prompt !== 'string' || isOwn(eventData)) return;
        // Only the hidden form: the static text's own example block must stay.
        const hidden = new RegExp(`\\s*<!--\\s*STORY_SUITE_V2\\b[\\s\\S]*?-->`, 'g');
        eventData.prompt = eventData.prompt.replace(hidden, '');
        if (backgroundPrompt() || !session || session.prompted) return;
        session.prompted = true;
        const missing = [session.staticText, session.tailText].filter(text => text && !eventData.prompt.includes(firstLine(text)));
        if (missing.length) {
            session.restored = missing.length === 2 ? 'both' : missing[0] === session.staticText ? 'static' : 'tail';
            if (missing.includes(session.staticText)) eventData.prompt = `${session.staticText}\n${eventData.prompt}`;
            if (missing.includes(session.tailText)) eventData.prompt = `${eventData.prompt}\n${session.tailText}`;
        }
    }

    // Runs the reply's change lines; returns { receipts, problems }.
    // Each line runs on the state the lines before it left (bus.run's `state`), as its owner's
    // capture handler (bus.run's `capture`), and is stored on the reply before the next one runs.
    // A reply holds at most maxChangeLines change lines; the rest are one Problem (pushed to `found`).
    const lineCap = () => (Number.isInteger(hostSettings()?.maxChangeLines) && hostSettings().maxChangeLines > 0 ? hostSettings().maxChangeLines : MAX_CHANGE_LINES);

    // A block's lines read, at most maxChangeLines of them, change lines or not; the rest are one Problem.
    function readBlock(index, text) {
        const cap = lineCap();
        const parsed = parseChanges(text, { max: cap });
        const problems = parsed.problems.map(line => problem({ index, code: 'UNREADABLE', message: line }));
        if (parsed.over) {
            const { count, total, first } = parsed.over;
            problems.push(problem({ index, code: 'TOO_MANY', message: `The reply has ${total} change lines; only the first ${cap} were read, so ${count} ${count === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(first, 60)}").` }));
        }
        return { lines: parsed.lines, problems };
    }

    // The heads of the kinds the reply may write ("! encounter", "+ quest"), for the change lines a
    // model writes in the story near the block (capture.js strayLines). Read at each capture, so a
    // feature turned off takes its kinds' heads with it.
    function changeHeads() {
        try { return grammarHeads(registry.contexts().flatMap(context => context.kinds ?? [])); } catch { return new Set(); }
    }
    // The story's change lines that were not taken (too far up, written another way) as Problems.
    function strayProblems(index, text, heads, options) {
        return strayLines(text, heads, options).problems.map(({ line, reason }) => problem({ index, line, code: 'STRAY', message: `"${line}" was not used: ${reason}.` }));
    }

    function capped(index, all, found) {
        const cap = lineCap();
        if (all.length > cap) {
            const more = all.length - cap;
            found.push(problem({ index, code: 'TOO_MANY', message: `The reply has ${all.length} change lines; only the first ${cap} were read, so ${more} ${more === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(all[cap].raw, 60)}").` }));
        }
        return all.slice(0, cap);
    }

    async function captureLines(index, all) {
        const receipts = [];
        const found = [];
        const lines = capped(index, all, found);
        // One write of the reply's record for all its lines (store.batch), not one per line.
        await (store.batch ?? (fn => fn()))(() => captureEach(index, lines, receipts, found));
        return { receipts, problems: found };
    }

    // Runs `lines` as story captures on carrier `index`, each on the state the one before left. Stored on
    // the head as they go (append), or, with `base` (a Re-read), run on that state and returned as
    // { ops } for store.replaceStory, nothing stored.
    async function captureEach(index, lines, receipts, found, base = null, seeds = null) {
        const collected = [];
        let state = base ?? store.head();
        // ctx.carrier and ctx.chat for the capture handlers (MODULES §F2's capture context).
        const message = ctx?.chat?.[index];
        // `sid`: the reply's record ID, which stays with the reply when earlier messages are deleted.
        const carrier = { index, swipe: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0, sid: store.carrierSid?.(index) ?? null };
        const reader = (ctx?.chat ?? []).slice(0, index).findLast(item => item?.is_user);
        const chat = { lastUser: String(reader?.mes ?? ''), reply: stripBlock(String(message?.mes ?? ''), 'Changes', { heads: changeHeads() }) };
        // A Re-read (a2-3): the reply as it stands now, for bookkeeping its kept blocks wrote (ctx.standing).
        let standing = null;
        if (base) { try { standing = store.at(index); } catch { standing = null; } }
        // How many lines of each display kind this reply has shown so far (their cap per reply).
        const shown = new Map();
        for (const line of lines) {
            const entry = registry.capture(line.kind);
            if (!entry) {
                found.push(problem({ index, line: line.raw, code: 'UNKNOWN_KIND', message: `No module keeps "${line.kind}", so "${line.raw}" was not used.` }));
                continue;
            }
            const mark = lineMark(line.raw);
            const seed = seeds?.(entry.kind, mark);
            // C3-4: a Re-read runs a line that made a change before (its receipt gives the seed) even
            // while its feature is off, so turning a feature off never takes away what it already did.
            const again = base !== null && seed !== undefined;
            // A kind whose feature the reader turned off (MODULES §F100): not an error, just not used.
            if (entry.off && !again) {
                const label = registry.feature?.(entry.feature)?.label ?? entry.feature;
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: 'FEATURE_OFF', quiet: true, message: `"${line.raw}" was not used: ${label} is turned off (feature off).` }));
                continue;
            }
            // A display kind (Choices, Inner chatter; extras.js): read for the reader alone. No command
            // runs and nothing is stored; what is shown is read again from the reply's hidden block, by
            // the same rule (readDisplayLine), so only what the rule refuses is told here.
            if (entry.display) {
                const read = readDisplayLine(entry, line, shown);
                if (!read.ok) found.push(problem({ module: entry.moduleId, index, line: line.raw, code: read.code, message: `"${line.raw}" was not used: ${read.message}.` }));
                continue;
            }
            let result;
            try {
                const run = opts => bus.run(`${CAPTURE_PREFIX}${entry.kind}`, { ...line, kind: entry.kind, word: line.kind }, { cause: 'story', state, capture: entry, carrier, chat, standing, ...(seed === undefined ? {} : { seed }), ...opts });
                result = entry.off ? await run({ capture: { ...entry, off: false }, again: true }) : await run();
                // Refused by a feature that is off (a command it called, ctx.feature): run as it ran before.
                if (again && !entry.off && result?.code === 'FEATURE_OFF') result = await run({ again: true });
                // The receipt remembers which line made it (`line`), so a Re-read can give the line its seed again.
                if (result?.ok) result = { ...result, receipt: { ...result.receipt, line: mark } };
                if (result?.ok && base) collected.push(...result.ops);
                else if (result?.ok) store.append({ ops: result.ops, receipt: result.receipt });
            } catch (error) {
                result = { ok: false, code: 'FAILED', message: error?.message ?? String(error) };
            }
            if (!result?.ok) {
                // A line refused because a feature the reader turned off answered it (another module's
                // command it called, MODULES §F100): listed quietly, like a line of a kind that is off.
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: result?.code ?? 'FAILED', message: `"${line.raw}" was not used: ${result?.message ?? 'unknown error'}`, ...(result?.code === 'FEATURE_OFF' ? { quiet: true } : {}) }));
                continue;
            }
            state = result.state ?? (base ? state : store.head());
            receipts.push(result.receipt);
            // Used, but not all of it (a clamp): the owner says why, and that goes to the Problems list.
            if (typeof result.problem === 'string' && result.problem) {
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: 'LIMITED', message: result.problem }));
            }
            if (!base) events?.emit('committed', { receipt: result.receipt });
        }
        return { ops: collected };
    }

    const refusal = (code, message) => ({ ok: false, code, message });

    // A change line's mark: a hash of its text without spaces (hiding the block breaks up "--" with one).
    const lineMark = raw => hash(String(raw ?? '').replace(/\s+/g, ''));

    // For a Re-read (r2-3): each line run again gets the seed of the story receipt it made before, so the
    // records it makes keep their IDs and the reader's later actions on them still fit. The reply's story
    // receipts are taken in order, a line matching the next one of its kind made by the same line text
    // (`line`, lineMark); a line that made none before (it failed, was changed, or is new) gets a fresh
    // seed. → (kind, mark) => seed | undefined.
    function storySeeds(record) {
        const stored = (Array.isArray(record?.receipts) ? record.receipts : [])
            .filter(receipt => receipt?.cause === 'story' && typeof receipt.line === 'string' && Number.isInteger(receipt.seed));
        let next = 0;
        return (kind, mark) => {
            const at = stored.findIndex((receipt, n) => n >= next && receipt.type === `${CAPTURE_PREFIX}${kind}` && receipt.line === mark);
            if (at < 0) return undefined;
            next = at + 1;
            return stored[at].seed;
        };
    }

    /**
     * Re-read (F40): reads reply `index`'s <Changes> block again, as its shown swipe has it now, and
     * replaces the story changes stored on it the way a fresh capture would (store.replaceStory): its
     * `story` receipts go, the lines run again on the state before the reply, and the reader's own
     * actions and system steps on it stay after them (their claims too). Later replies are checked
     * again on top; if one of them no longer fits, nothing changes. Refused for the reader's messages,
     * system messages, messages that hold no story record, and while a reply is being written.
     * Saves once and emits `turn` ({ index, type: 'reread', receipts, problems, told: [] }).
     * → { ok: true, receipts, problems } | { ok: false, code, message }.
     */
    async function reread(index) {
        const chat = ctx?.chat ?? [];
        const message = Number.isInteger(index) ? chat[index] : undefined;
        if (!message) return refusal('NOT_FOUND', `There is no message ${index} in this chat.`);
        if (message.is_user) return refusal('REFUSED', 'This is the reader\'s own message; only replies hold story changes.');
        if (message.is_system) return refusal('REFUSED', 'This is a system message; it holds no story changes.');
        if (session) return refusal('REFUSED', 'A reply is being written; Re-read once it is done.');
        if (!readRecord(message)) return refusal('REFUSED', 'This reply keeps no story record, so there is nothing to read again.');
        const base = store.before?.(index);
        if (!base) return refusal('FAILED', 'This chat has no story state yet.');
        const mes = String(message.mes ?? '');
        const heads = changeHeads();
        const block = extractBlock(mes, 'Changes', null, { heads });
        const parsed = block === null ? { lines: [], problems: [] } : readBlock(index, block);
        const problems = [...parsed.problems, ...strayProblems(index, mes, heads)];
        const receipts = [];
        const lines = capped(index, parsed.lines, problems);
        const swipe = message.swipe_id;
        let ops;
        try {
            ({ ops } = await captureEach(index, lines, receipts, problems, base, storySeeds(readRecord(message))));
            // B-b2-timeline-r2: the lines ran while the reader could act (a capture handler may wait). A
            // message deleted, another chat opened, the reply swiped or edited, or a reply begun in that
            // time: what was read is no longer this reply's, so nothing is stored (not even on the
            // message that now stands at `index`).
            const live = ctx?.chat ?? [];
            if (live[index] !== message || message.swipe_id !== swipe || String(message.mes ?? '') !== mes || session) {
                return refusal('CONFLICT', 'The chat changed while the reply was read again (a message was deleted, swiped, edited or added); nothing was changed. Press Re-read again.');
            }
            store.replaceStory(index, { ops, receipts });
        } catch (error) {
            return refusal('CONFLICT', `${error?.message ?? error}`);
        }
        if (block !== null) {
            const hidden = hideBlock(mes, 'Changes', { heads });
            if (hidden !== mes) {
                message.mes = hidden;
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
                redraw(index, message);
            }
        }
        await trySave('after the Re-read');
        for (const receipt of receipts) events?.emit('committed', { receipt });
        events?.emit('head', { index: store.headIndex() });
        events?.emit('turn', { index, type: 'reread', receipts, problems, told: [] });
        return { ok: true, receipts, problems };
    }

    // Only the reply's text changed (its block hidden): SillyTavern's own save, told like any other.
    async function saveText() {
        try { await ctx.saveChat?.(); } catch (error) {
            problem({ code: 'SAVE_FAILED', message: `The reply could not be saved: ${error?.message ?? error}` });
        }
    }

    function redraw(index, message) {
        try { ctx.updateMessageBlock?.(index, message); } catch { /* not drawn yet: SillyTavern draws it from the saved text */ }
    }

    /** MESSAGE_RECEIVED: (messageId, type). */
    async function onMessageReceived(messageId) {
        const id = Number(messageId);
        const current = session;
        if (!current || !Number.isInteger(id) || id !== current.index) return null;
        session = null;
        markIdle();
        clearPrompts();
        const message = ctx?.chat?.[id];
        if (!isCarrier(message)) return null;
        try {
            if (store.headIndex() !== id) store.rebuild();
            ensureInitial();
            if (store.headIndex() !== id) {
                problem({ index: id, code: 'FAILED', message: 'The reply is not the last message that keeps the story, so its changes were not read.' });
                return null;
            }
            const written = String(message.mes ?? '');
            // A Continue: SillyTavern wrote the old text again, cleaned up, so it can be shorter than it
            // was; where the added text starts is found, not counted, or its block is left bare.
            const at = typeof current.base === 'string' ? continuation(current.base, written) : null;
            // C2-7: a copy of the hidden comment's marker the model wrote itself is defanged first, so the
            // reply is read live as Re-read will read the saved message.
            const text = defangMarker(written, at?.from ?? 0);
            let edited = false;
            if (text !== written) {
                message.mes = text;
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = text;
                edited = true;
            }
            // The reader stopped it (GENERATION_STOPPED): an open block's unfinished last line is left out.
            const stopped = current.stopped === true;
            // Change lines written in the story near the block are read with it (capture.js strayLines).
            const heads = changeHeads();
            const block = extractBlock(text, 'Changes', at, { stopped, heads });
            const parsed = block === null ? { lines: [], problems: [] } : readBlock(id, block);
            const problems = [...parsed.problems, ...strayProblems(id, text, heads, { from: at?.from ?? 0, tail: at?.tail === true, stopped })];
            const cut = block === null ? null : cutLine(text, 'Changes', at, { stopped });
            if (cut) problems.push(problem({ index: id, line: cut, code: 'CUT_OFF', message: `The reply stopped in the middle of the change line "${cutAt(cut, 80)}", so it was not used.` }));
            const result = await captureLines(id, parsed.lines);
            problems.push(...result.problems);

            // What this reply was told; a Continue keeps what the reply was told before.
            // (B-b2-timeline-9: read through readRecord, and only receipt IDs, whatever the chat holds.)
            const told = current.type === 'continue' ? readRecord(message)?.narrated ?? [] : [];
            const before = told.filter(id => typeof id === 'string');
            store.setNarrated(id, [...new Set([...before, ...current.untold])]);

            if (block !== null) {
                const hidden = hideBlock(message.mes, 'Changes', { ...(at ?? {}), stopped, heads });
                if (hidden !== message.mes) {
                    message.mes = hidden;
                    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
                    edited = true;
                }
            }
            deferred = false;
            if (store.dirty()) await trySave('after the reply');
            else if (edited) await saveText();
            // At MESSAGE_RECEIVED SillyTavern has not drawn the reply yet (it draws the text as saved), so
            // redrawing can fail; that is not a reason to lose the turn.
            if (edited) redraw(id, message);
            const turn = { index: id, type: current.type, receipts: result.receipts, problems, told: current.untold };
            events?.emit('turn', turn);
            if (!parsed.lines.length) afterReply(id, current.type, message);
            return turn;
        } catch (error) {
            problem({ index: id, code: 'FAILED', message: `The reply's changes could not be kept: ${error?.message ?? error}` });
            return null;
        }
    }

    // afterReply (the assist extractor): a reply that came without change lines may get them from a
    // module after all. Not awaited; a failure is logged. `capture(text, { index, swipe })` runs the
    // lines as story captures on that reply when it is still the head on the same swipe.
    function afterReply(index, type, message) {
        const swipe = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
        for (const { moduleId, fn } of registry.hookEntries('afterReply')) {
            Promise.resolve()
                .then(() => fn({ index, swipe, type, mes: String(message?.mes ?? ''), capture: (text, at = { index, swipe }) => captureLate(at, text) }))
                .catch(error => problem({ module: moduleId, index, code: 'FAILED', message: `afterReply failed: ${error?.message ?? error}` }))
                // C2-ext: what the hook made of the reply (the extractor read it, or failed to) can change
                // the reply's note, so the notes are drawn again.
                .finally(() => { if (store.headIndex() === index) events?.emit('head', { index }); });
        }
    }

    /** Change lines found after the reply (afterReply): captured on it and kept in its hidden block. */
    async function captureLate({ index, swipe } = {}, text = '') {
        const message = ctx?.chat?.[index];
        if (!isCarrier(message) || store.headIndex() !== index || (Number.isInteger(message.swipe_id) ? message.swipe_id : 0) !== swipe || session) {
            return { receipts: [], problems: ['The reply changed before its late change lines arrived; they were not used.'] };
        }
        const parsed = readBlock(index, String(text ?? ''));
        const problems = [...parsed.problems];
        const result = await captureLines(index, parsed.lines);
        problems.push(...result.problems);
        if (parsed.lines.length) {
            // Kept in the reply's hidden block, so Re-read finds them too.
            const before = extractBlock(message.mes);
            const body = [before?.trim(), ...parsed.lines.map(line => line.raw)].filter(Boolean).join('\n');
            const mes = hideBlock(`${stripBlock(message.mes)}\n\n<Changes>\n${body}\n</Changes>`);
            message.mes = mes;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = mes;
        }
        if (store.dirty()) await trySave('after the late change lines');
        else if (parsed.lines.length) await saveText();
        if (parsed.lines.length) redraw(index, message);
        const turn = { index, type: 'late', receipts: result.receipts, problems, told: [] };
        events?.emit('turn', turn);
        return turn;
    }

    /** CHAT_CHANGED: a new chat (or the same one reloaded). */
    async function onChatChanged() {
        session = null;
        markIdle();
        clearPrompts();
        rebuild();
        // A1-2: read-backs of a write that timed out before a reload of the page go on.
        try { store.resume?.(); } catch { /* only a guard */ }
        // A cue left for the reply's save (runCues) whose reply will not come here: saved now (into its
        // own chat's file when this is another chat, the store's rescue).
        if (deferred) {
            deferred = false;
            if (store.dirty?.()) store.scheduleSave?.();
        }
        await ensureModules({ store, bus, registry, events });
    }

    /**
     * CHAT_RENAMED: { oldFileName, newFileName } (file names with ".jsonl"). SillyTavern 1.19 renames the
     * file, reads the open chat back (CHAT_CHANGED), then tells this; a change not saved yet goes into the
     * renamed file (store.renamed, B-b2-timeline-r2-2). The server may clean the new name up (characters
     * it does not allow in a file name); when the open chat's ID is that name cleaned up, it is the one.
     */
    function onChatRenamed(data) {
        const name = value => String(value ?? '').trim().replace(/\.jsonl$/i, '');
        const from = name(data?.oldFileName);
        let to = name(data?.newFileName);
        if (!from || !to) return false;
        let open = null;
        try { open = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null; } catch { open = null; }
        const loose = id => String(id).replace(/[\/?<>\\:*|"\u0000-\u001f\u0080-\u009f]/g, '').replace(/[. ]+$/, '');
        if (typeof open === 'string' && open && open !== from && open !== to && loose(open) === loose(to)) to = open;
        return store.renamed?.(from, to) ?? false;
    }

    /** Deleted messages, swipes, a greeting picked: the state is rebuilt from what is stored. */
    function onTimelineChanged() {
        rebuild();
    }

    /** GENERATION_STOPPED: the reader stopped the reply being written (its last line may be unfinished). */
    function onGenerationStopped() {
        if (session) session.stopped = true;
        onGenerationEnded();
    }

    /** GENERATION_ENDED / GENERATION_STOPPED: a spent note never reaches a later prompt. */
    function onGenerationEnded() {
        if (session?.prompted) clearPrompts();
        deferred = false;
        markIdle();
        // A save that failed and was not made good after the reply (or the reply never came): again soon.
        if (store.dirty()) store.scheduleSave();
    }

    function install({ globalName = INTERCEPTOR_NAME } = {}) {
        for (const [key, place] of V1_KEYS) setPrompt(key, '', place);
        clearPrompts();
        if (globalName) globalThis[globalName] = interceptor;
        const source = ctx?.eventSource;
        const names = ctx?.eventTypes ?? ctx?.event_types ?? {};
        const on = (event, fn) => {
            if (!event || typeof source?.on !== 'function') return;
            source.on(event, fn);
            listeners.push([event, fn]);
        };
        on(names.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        on(names.GENERATE_AFTER_COMBINE_PROMPTS, onTextPromptReady);
        on(names.MESSAGE_RECEIVED, onMessageReceived);
        on(names.GENERATION_ENDED, onGenerationEnded);
        on(names.GENERATION_STOPPED, onGenerationStopped);
        on(names.CHAT_CHANGED, onChatChanged);
        on(names.CHAT_RENAMED, onChatRenamed);
        // MESSAGE_EDITED too: a record's swipe mark follows an edit (persist.js restamp), so a Continue
        // after it still finds the record.
        for (const event of [names.MESSAGE_DELETED, names.MESSAGE_SWIPED, names.MESSAGE_SWIPE_DELETED, names.CHARACTER_FIRST_MESSAGE_SELECTED, names.MESSAGE_EDITED]) on(event, onTimelineChanged);
        return api;
    }

    function uninstall({ globalName = INTERCEPTOR_NAME } = {}) {
        const source = ctx?.eventSource;
        for (const [event, fn] of listeners) (source?.removeListener ?? source?.off)?.call(source, event, fn);
        listeners = [];
        if (globalName && globalThis[globalName] === interceptor) delete globalThis[globalName];
        clearPrompts();
        markIdle();
    }

    const api = {
        interceptor,
        install,
        uninstall,
        onPromptReady,
        onTextPromptReady,
        onMessageReceived,
        onChatChanged,
        onChatRenamed,
        onTimelineChanged,
        onGenerationEnded,
        reread,
        /** What the next ordinary reply would be sent, without changing anything (no cues run). */
        preview: () => build().parts,
        /**
         * The same with how it fits the context and what modules send on their own: { parts, fit, own }
         * (fit: prompt.js contextFit, or null; own: [{ module, label, place: 'own', text, tokens }]).
         */
        previewFit: () => {
            const built = build();
            return { parts: built.parts, fit: built.fit, own: built.own };
        },
        /** Adds { module?, code?, message, index?, line? } to the Problems list (and the console). */
        report: entry => problem(entry),
        /** The Problems list, oldest first; `moduleId` narrows it (null: the host's own). */
        problems: moduleId => problemLog.filter(item => moduleId === undefined || item.module === moduleId).map(item => ({ ...item })),
        clearProblems: () => { problemLog.length = 0; },
        /** Generations a canGenerate hook stopped: [{ moduleId, reason }], oldest first. */
        blocked: () => blocks.map(item => ({ ...item })),
        /**
         * Every module holding the story back now (each canGenerate asked, none logged):
         * Promise<[{ moduleId, name, reason, action, canOpen }]> (`action`: the module's button words, '' for
         * the host's own, false for no button; `canOpen`: it has an onBlocked hook to run).
         */
        blockers: () => askCanGenerate({ all: true }),
        /** Runs module `moduleId`'s onBlocked(reason, moduleId) hook (Home's button). → true when it ran. */
        unblock: (moduleId, reason = '') => runOnBlocked(moduleId, reason),
        /** The pending reply's session (for status and tests), or null. */
        session: () => (session ? { ...session } : null),
        /** Whether a reply is being built or awaited (its interceptor ran; not yet received, ended or stopped). */
        replyBusy: () => replyBusy,
        /** Resolves when no reply is in progress (at once when none is). */
        whenIdle,
    };
    return api;
}
