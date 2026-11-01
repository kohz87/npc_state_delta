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
// was accepted, run each module's afterCapture hook once after the reply's last story line (its
// commands as `system` steps kept on the reply), record what the reply was told, save once. A line no module takes, or one its
// owner rejects, goes to the Problems list; nothing is thrown at the reader.
// A failed save (before or after the reply) is told and logged but never drops the turn: the state
// stays in memory, marked unsaved, and the save is tried again after the reply.
//
// turn.js receives the SillyTavern context and the host parts; it never imports the store or
// the command bus (their interfaces are docs/v2/SPEC.md §12).

import { assistSections, continuation, cutLine, defangMarker, extractBlock, grammarHeads, hasHidden, hideBlock, markOff, parseChanges, strayLines, stripBlock, withAssist } from './capture.js';
import { notWritten } from './assist/extractor.js';
import { PRECHECK } from './assist/classifier.js';
import { refusedWhy } from './assist/safety.js';
import { displayLines, readDisplayLine } from './extras.js';
import { occurrenceOf, operationKey, replacedProofs, reusePlan } from './evidence.js';
import { hash, readRecord, swipeLoading } from './persist.js';
import { CAPTURE_PREFIX, HOST_MODULE } from './registry.js';
import { STATIC_MARKER, assemble, contextNotice, estimateTokens } from './prompt.js';
import { MAX_CHANGE_LINES, ensureModules, makeView } from './sdk.js';
import { cutAt } from '../text.js';
import { CORE_FEATURE } from './features.js';
import { RESOLVE as RPG_RESOLVE } from './lean-rpg/names.js';
import { NO_ROLLS_LINE } from './lean-rpg/cue.js';

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
// A hook may declare its own, longer limit (`fn.timeoutMs`): the RPG's planner makes a model call of up to 20 s.
export const hookTimeout = fn => (Number.isFinite(fn?.timeoutMs) && fn.timeoutMs > HOOK_TIMEOUT_MS ? fn.timeoutMs : HOOK_TIMEOUT_MS);
// A reply that never ends (no MESSAGE_RECEIVED, GENERATION_ENDED or STOPPED) stops counting as in progress
// after this long, so Story Suite's own model calls on the chat's connection are not held up for good.
export const REPLY_BUSY_MAX_MS = 5 * 60_000;
// How long a send waits for the Assist safety net still reading the last reply (MODULES §F123): briefly.
// Lines that come later are kept on that reply and applied on the next one, right after its own lines.
export const ASSIST_WAIT_MS = 1500;
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
// The RPG's battle-log marker: a line `[battle]` of its own in a reply (src/v2/lean-rpg/view/battle-log.js draws the panel there).
// It is for the reader's eyes only, so it leaves the prompt history like the change blocks do: the narrator never sees its own old
// markers. The line goes with one blank line after it, so no gap is left.
const BATTLE_MARKER = /^[ \t]*\[battle\][ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)?/gim;
const HAS_BATTLE = /\[battle\]/i;
/** `text` without its `[battle]` marker lines. */
export function stripBattleMarker(text) {
    return typeof text === 'string' && HAS_BATTLE.test(text) ? text.replace(BATTLE_MARKER, '') : text;
}

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
export function createTurn({ ctx, live = () => ctx, store, bus, registry, settings, events = null, onBlocked = null, notify = defaultNotify, initial = () => registry.initialState(), ownPrompt = () => false, timeline = null }) {
    const types = () => ctx?.extension_prompt_types ?? ctx?.extensionPromptTypes ?? {};
    const roles = () => ctx?.extension_prompt_roles ?? ctx?.extensionPromptRoles ?? {};
    const position = place => (place === 'static' ? types().IN_PROMPT ?? IN_PROMPT : types().IN_CHAT ?? IN_CHAT);
    const hostSettings = () => (typeof settings === 'function' ? settings() : settings ?? {});
    // Story Block's readers of earlier messages that this turn owns, each asked for by name from the timeline's active-history filter
    // (timeline/active.js): messages a restore faded are not a module's last reader message nor a source of late lines. (A request is not
    // filtered here: SillyTavern leaves the hidden messages out of it, and a restore hides what it faded.) A host without a timeline has none.
    const reader = name => (typeof timeline?.active === 'function' ? timeline.active(name) : null);
    const lateReader = reader('assist.late');
    const viewReader = reader('view.lastUser');
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
    // The Assist safety net's runs on the last reply (afterReply), until they settle.
    let assistPending = null;
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

    const view = () => makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader });
    const hasCarrier = () => (ctx?.chat ?? []).some(isCarrier);
    const lastCarrier = () => (ctx?.chat ?? []).findLastIndex(isCarrier);

    // The chat's state starts on its first carrier; a damaged record set up again goes to the Problems.
    function ensureInitial() {
        const notes = store.ensureInitial(initial());
        for (const note of Array.isArray(notes) ? notes : []) problem({ code: 'DAMAGED', message: note, ...(repairActions().length ? { actions: repairActions() } : {}) });
    }

    // What the reader may do about a story that Story Block keeps as it is (read-only), only on their say, each asked
    // twice (never automatic): the actions the Problem carries and Settings → Diagnostics shows. A record from a newer
    // version has none: update Story Block.
    const START_OVER = Object.freeze({ id: 'start-over', label: 'Start this chat\'s story state over', confirm: 'The saved story state of this chat cannot be used as it is, and it is kept aside. Starting over begins the story\'s numbers (items, money, places) from their start, and the replies after it add their changes again. Start over?' });
    const KEEP_EARLIEST = Object.freeze({ id: 'keep-earliest', label: 'Keep the story state from the earliest saved point', confirm: 'The replies before the earliest saved point of this story are gone, and this session could not check what they did. Keeping it trusts that saved point as the start of the story, with whatever the deleted replies left in it. Keep it?' });
    function repairActions() {
        const kept = store.readOnly?.();
        if (!kept || kept.kind === 'future') return [];
        return kept.kind === 'unresolved' ? [KEEP_EARLIEST, START_OVER] : [START_OVER];
    }
    /** The reader's confirmed repair (store.startOver / keepEarliest): → { ok: true } | { ok: false, code, message }. */
    async function repair(id, { confirmed = false } = {}) {
        try {
            if (id === 'keep-earliest') store.keepEarliest?.({ confirmed });
            else if (id === 'start-over') store.startOver?.({ confirmed });
            else return refusal('NOT_FOUND', `There is no repair called "${id}".`);
        } catch (error) {
            return refusal('REFUSED', error?.message ?? String(error));
        }
        rebuild();
        await trySave('after the repair');
        return { ok: true };
    }
    const startOver = options => repair('start-over', options);

    // `publish: false`: the caller finishes its own work first (reconciling after a delete) and tells the screens once.
    function rebuild({ publish = true } = {}) {
        store.rebuild();
        if (hasCarrier()) ensureInitial();
        if (publish) events?.emit('head', { index: store.headIndex() });
    }

    // A guarded system step with a `replan` planned again (store.replaceStory / store.reconcile's `rerun`): as its
    // span saved it (type, payload, seed: `info.replan`; the receipt is only what was shown), on `state`, on the
    // reply it is kept on (`own` for the one a Re-read is on), keeping its ordinal.
    function planAgain(state, receipt, info = null, own = null) {
        const plan = info?.replan ?? { type: receipt.type, payload: receipt.replan?.payload ?? {}, seed: receipt.seed };
        const at = Number.isInteger(info?.index) ? info.index : null;
        const reply = own ?? (at !== null && store.carrierSid?.(at) ? { index: at, sid: store.carrierSid(at) } : null);
        const ordinal = info?.span?.source?.ordinal;
        // The proof of the block being planned again may be given again: the step keeps its ids.
        const replacing = Array.isArray(info?.span?.evidence) ? info.span.evidence : [];
        return bus.run(plan.type, plan.payload ?? {}, { cause: 'system', state, seed: plan.seed, replacing, reusing: typeof info?.span?.id === 'string' ? info.span : null, ...(Number.isInteger(info?.occurrence) ? { occurrence: info.occurrence } : {}), ...(reply ? { reply: { ...reply, ...(Number.isInteger(ordinal) ? { ordinal } : {}), ...(Number.isInteger(info?.opsBefore) ? { opsBefore: info.opsBefore } : {}) } } : {}) });
    }

    // After a delete or swipe (REPLAY.md "Reconciling"): the guarded steps that carry a `replan` are planned again
    // from the first one on, in the same save window; steps that come out as they were change nothing and write
    // nothing. Not while the story record is read-only. What was planned again is a Problem, quietly.
    function reconcileNow() {
        const from = store.replansFrom?.();
        if (!Number.isInteger(from) || store.readOnly?.()) return;
        try {
            const done = store.reconcile(from, { rerun: planAgain });
            if (!done.changed) return;
            store.scheduleSave?.();
            const parts = [done.planned ? `${done.planned} planned again` : '', done.removed ? `${done.removed} taken back` : ''].filter(Boolean).join(', ');
            if (!parts) return;     // (revs numbered on, nothing the reader needs told)
            problem({ code: 'REPLANNED', quiet: true, message: `The story before some steps changed, so ${parts || 'steps'} (their changes follow what is there now).` });
        } catch (error) {
            problem({ code: 'FAILED', message: `Steps that follow the change could not be planned again: ${error?.message ?? error}` });
        }
    }

    // The commands run as preludes: Assist's pre-roll, and any command a module marks `prelude` (registry.isPrelude).
    const isPrelude = type => type === PRECHECK || registry.isPrelude?.(type) === true;

    // beforeGenerate (§4.1 step 3): each hook may return lines for the tail, or commands to
    // commit now as `system` receipts: string[] | { lines?: string[], commands?: [{ type, payload }] }.
    // A Continue (the same reply goes on) commits nothing (B3-9): hooks are told `{ type, dryRun,
    // commit: false }` and their commands are not run. A dry run (SillyTavern counting tokens) never
    // gets here: SillyTavern 1.19 runs no interceptor for one (Generate: `if (!dryRun)`), so the
    // interceptor's own generation is never a dry run (r2-1).
    async function runCues(type = 'normal', { dryRun = false } = {}) {
        const cues = {};
        let committed = false;
        const prechecks = [];
        let previewState = null;
        const requested = [];
        const commit = !dryRun && type !== 'continue';
        // `again`: an earlier attempt at this reply was never captured (a retried interceptor), so a hook may reuse its work.
        const again = session !== null;
        for (const { moduleId, fn } of registry.hookEntries('beforeGenerate')) {
            let out;
            const limit = hookTimeout(fn);
            try { out = await within(fn(view(), { type, dryRun, commit, again }), limit); } catch (error) {
                problem({ module: moduleId, code: 'FAILED', message: `beforeGenerate failed: ${error?.message ?? error}` });
                continue;
            }
            if (out === TIMED_OUT) {
                problem({ module: moduleId, code: 'TIMEOUT', message: `beforeGenerate did not answer within ${limit / 1000} s; the reply went on without its notes.` });
                continue;
            }
            // A merged hook (domains/index.js mergeParts) keeps the answers of the parts that did answer and reports the others.
            for (const entry of Array.isArray(out?.problems) ? out.problems : []) problem({ module: moduleId, code: entry.code, message: entry.message });
            const lines = Array.isArray(out) ? out : Array.isArray(out?.lines) ? out.lines : [];
            // The RPG's rolls and its "no rolls" line outrank ordinary tail notes when the tail is trimmed (prompt.js).
            if (lines.length) cues[moduleId] = lines.filter(line => typeof line === 'string').map(line => (line === NO_ROLLS_LINE ? { text: line, keep: true } : line));
            for (const command of commit && Array.isArray(out?.commands) ? out.commands : []) {
                // A prelude (Assist's roll, the RPG's rolls) is previewed for the prompt, without writing on the
                // previous reply. Completion runs the same seed on the generated reply; only that transaction is stored.
                if (isPrelude(command?.type)) {
                    requested.push({ moduleId, type: command.type, payload: command.payload ?? {} });
                    continue;
                }
                const result = await bus.command(command?.type, command?.payload ?? {}, { cause: 'system' });
                if (result?.ok) {
                    committed = true;
                    events?.emit('committed', { receipt: result.receipt });
                } else problem({ module: moduleId, code: result?.code ?? 'FAILED', message: `The cue "${command?.type}" was not committed: ${result?.message ?? 'unknown error'}` });
            }
        }
        // Other cues may settle a fight or change a modifier. Preview on the state they leave,
        // which is also the state the generated reply's prelude will start from.
        for (const { moduleId, type: preludeType, payload } of requested) {
            const prior = session?.prechecks?.find(step => step.type === preludeType && JSON.stringify(step.payload) === JSON.stringify(payload));
            const result = bus.run(preludeType, payload, { cause: 'system', ...(prior ? { seed: prior.seed } : {}) });
            if (result?.ok) {
                // The RPG's rolls move bars (hits, heals, skill costs): the tail's block lines are read from the state they leave, so they say what the cue says.
                if (preludeType === RPG_RESOLVE && result.state) previewState = result.state;
                prechecks.push({ type: preludeType, payload, seed: result.receipt.seed });
                const told = `[Happened]\n${result.receipt.summary}`;
                cues[moduleId] = [...(cues[moduleId] ?? []), preludeType === RPG_RESOLVE ? { text: told, keep: true } : told];
            } else problem({ module: moduleId, code: result?.code ?? 'FAILED', message: `The cue "${preludeType}" was not prepared: ${result?.message ?? 'unknown error'}` });
        }
        // Saved with the reply (MESSAGE_RECEIVED), not now: each save writes the whole chat file, and the
        // reply's save comes moments later with these cues in it. A reply that never comes still has them
        // saved: GENERATION_ENDED / GENERATION_STOPPED and CHAT_CHANGED save what is unsaved.
        if (committed) {
            store.deferSave?.();
            deferred = true;
        }
        return { cues, prechecks, previewState };
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

    function build(cues = {}, state = null) {
        const untold = store.untold();
        // (`state`: the state the reply's prelude rolls leave, when it has one; the tail's lines are made from it)
        const current = state ? makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader, state }) : view();
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
    // A module that is dormant, or held by a restore barrier, is not asked at all (registry.hookEntries leaves
    // it out): its veto is suppressed, never answered false, since one refusal stops the whole story.
    async function askCanGenerate({ all = false } = {}) {
        const found = [];
        // A restore barrier (registry.setRestore) holds the story back for everyone until every part agrees;
        // the hooks of the modules it holds are not asked (registry.hookEntries leaves them out).
        const barrier = registry.restore?.();
        if (barrier?.state === 'pending') {
            const entry = { moduleId: HOST_MODULE, reason: registry.lifecycle?.(HOST_MODULE)?.reason ?? 'A restore is in progress.' };
            if (!all) return entry;
            found.push({ ...entry, name: registry.module(HOST_MODULE)?.name ?? HOST_MODULE, action: false, canOpen: false });
        }
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

    // A module's own onBlocked hook (what it does when it held the story back: an example module opens the
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
        // The safety net still reading the last reply: waited for briefly, so its lines are in this prompt.
        if (assistPending) await within(assistPending, ASSIST_WAIT_MS);
        markBusy();
        if (Number.isFinite(Number(contextSize)) && Number(contextSize) > 0) lastSize = Number(contextSize);
        // B-b2-timeline-r2-1: never a dry run (SillyTavern runs interceptors only for real generations).
        // It is not read from GENERATION_STARTED: another caller's dry run (token counting) can start
        // between this generation's GENERATION_STARTED and this call, and would cost the reply its capture.
        try {
            // What is waiting for the turn's idle save goes with the reply's own save (it is on its way);
            // without idle saves it is written now.
            if (store.idleSaves?.()) {
                if (store.dirty()) store.deferSave?.();
            } else await trySave('before the reply');
            // A Regenerate removes the old reply before this runs, without an event for it.
            if (store.headIndex() !== lastCarrier()) store.rebuild();
            if (hasCarrier()) store.ensureInitial(initial());
            await ensureModules({ store, bus, registry, events });
            const blocked = await blockedBy();
            if (blocked) {
                block(blocked, abort);
                return;
            }
            const { cues, prechecks, previewState } = await runCues(kind);
            const built = build(cues, previewState);
            tellTooSmall(built.fit);
            const chat = ctx.chat;
            const last = chat.length - 1;
            const index = kind === 'swipe' || kind === 'continue' ? last : chat.length;
            session = {
                type: kind,
                prechecks,
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
            // (A hidden comment may hold only lines left in the story, B-a1-3: it goes too.)
            out = extractBlock(text) === null && !hasHidden(text) ? text : stripBlock(text);
            if (stripped.size >= STRIP_CACHE) stripped.delete(stripped.keys().next().value);
            stripped.set(text, out);
        }
        return out;
    }
    // Only while the RPG is on: with it off a reply's text goes into the prompt as it always did.
    const battleOn = () => registry.featureOn?.(CORE_FEATURE.leanRpg) === true;
    function stripHistory(chat) {
        const strip = battleOn() ? text => stripBattleMarker(strippedText(text)) : strippedText;
        for (const message of chat) {
            if (message?.role !== 'assistant') continue;
            const content = mapContent(message.content, strip);
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
        if (battleOn()) eventData.prompt = stripBattleMarker(eventData.prompt);
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

    // The Assist safety net's marks on its receipts and Problems (MODULES §F123).
    const NOW = 'now';
    const LATE = 'late';
    // The safety net's lines that fit the reply's cap after `used` lines; the rest are one Problem.
    function assistRoom(index, items, used, found) {
        const room = Math.max(0, lineCap() - used);
        if (items.length > room) {
            const more = items.length - room;
            found.push(problem({ index, code: 'TOO_MANY', assist: items[room].mark, message: `(assist) The reply's lines fill its cap of ${lineCap()}, so ${more} safety-net ${more === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(items[room].line.raw, 60)}").` }));
        }
        return items.slice(0, room);
    }

    // The previous reply's safety-net lines read after the reader had sent (its <Changes-assist-next>),
    // for reply `index` (not a Continue's): parsed, through the stricter wall for late lines, without the
    // ones the reply's own lines (`own`, raw) already hold.
    function lateLines(index, own = []) {
        const chat = ctx?.chat ?? [];
        const from = chat.slice(0, Math.max(0, index)).findLastIndex(isCarrier);
        if (from < 0 || lateReader?.faded().has(from)) return [];
        const stored = assistSections(String(chat[from]?.mes ?? '')).next;
        if (!stored.length) return [];
        const safe = parseChanges(stored.join('\n')).lines.filter(line => !refusedWhy(line, null, { late: true }));
        const keep = new Set(notWritten(safe.map(line => line.raw), own));
        return safe.filter(line => keep.has(line.raw));
    }

    // A reply's own safety-net lines (its <Changes-assist>), parsed, without the ones `own` already holds.
    function nowLines(mes, own = []) {
        const stored = assistSections(String(mes ?? '')).now;
        if (!stored.length) return [];
        const parsed = parseChanges(stored.join('\n')).lines.filter(line => !refusedWhy(line, null));
        const keep = new Set(notWritten(parsed.map(line => line.raw), own));
        return parsed.filter(line => keep.has(line.raw));
    }

    // How many lines of each display kind `mes` already shows (extras.js displayLines, the rule the card
    // draws by): lines a Continue or the extractor adds count after these against the cap (F115), so a
    // choice past it is told as one of the original reply's would be.
    const shownIn = mes => new Map(Object.entries(displayLines(mes, { entryOf: word => registry.capture(word), max: lineCap() }))
        .map(([kind, values]) => [kind, values.length]));

    // `before`: the reply's text before these lines were added (a Continue's, the extractor's), or null.
    // `type`: the generation's (normal, swipe, regenerate, continue) or 'late' (the extractor's lines).
    // `late` / `assist` (MODULES §F123): the Assist safety net's lines, run after the reply's own as story
    // lines marked as its (late: read from the reply before, after the reader had sent), within the same
    // cap per reply (`used`: lines the reply already read in an earlier call).
    async function captureLines(index, all, before = null, type = 'normal', { late = [], assist = [], used = 0, prechecks = [] } = {}) {
        const receipts = [];
        const found = [];
        const lines = capped(index, all, found);
        const extra = assistRoom(index, [...late.map(line => ({ line, mark: LATE })), ...assist.map(line => ({ line, mark: NOW }))], used + lines.length, found);
        const shown = typeof before === 'string' ? shownIn(before) : new Map();
        // One write of the reply's record for all its lines and its afterCapture steps (store.batch).
        let off = [];
        let steps = [];
        await (store.batch ?? (fn => fn()))(async () => {
            // The seeded pre-roll precedes this reply's story lines, as it did in the prompt.
            // Its Source is now this reply's; the previous reply is never changed.
            const prepared = prechecks.length ? await afterCapture(index, { type, problems: found, prechecks, onlyPrechecks: true }) : [];
            ({ off } = await captureEach(index, lines, receipts, found, null, null, shown));
            for (const mark of [LATE, NOW]) {
                const group = extra.filter(item => item.mark === mark).map(item => item.line);
                if (group.length) off = [...new Set([...off, ...(await captureEach(index, group, receipts, found, null, null, shown, mark)).off])];
            }
            // A pre-roll is part of this reply even when its narration has no Changes block.
            if (receipts.length || prepared.length) steps = [...prepared, ...await afterCapture(index, { type, problems: found })];
        });
        return { receipts, problems: found, off, steps: steps.map(step => step.receipt) };
    }

    /**
     * afterCapture (SPEC §4.2 step 3): once the reply's story lines have run, each module's
     * `afterCapture(view, { index, type })` hook may return `{ commands: [{ type, payload }] }` to run as
     * `system` steps on the scene the reply ended up in (a turn-in its line read before the reply's own
     * `~ place` line). A step is stored on the reply right after its story lines, as part of that reply, its
     * receipt marked `afterCapture` (and `replan`), so a swipe or delete of the reply takes it back and a
     * Re-read runs the hook again on the new story lines. A Continue runs it again after the Continue's
     * lines. A hook that fails or takes longer than HOOK_TIMEOUT_MS, or a step that is refused, is a Problem.
     * Live (no `state`): each step is appended to the head as it runs. A Re-read passes `state` (the reply's
     * state after its new story lines), `reply` and `seeds` (the old steps' seeds by type, in order): nothing
     * is stored, and the steps come back as [{ ops, receipt, block? }] for store.replaceStory (`block`: what a
     * guarded step hands over, REPLAY.md; `plan` counts the guarded blocks the Re-read has planned so far, so
     * each gets its own ordinal). The same runner stores Assist's seeded pre-roll prelude with
     * `beforeGenerate: true`; Re-read plans that prelude before the story lines and replaces it too.
     */
    async function afterCapture(index, { type = 'normal', problems = [], state = null, reply = null, seeds = null, plan = null, prechecks = [], onlyPrechecks = false } = {}) {
        const steps = [];
        const live = state === null;
        let now = live ? store.head() : state;
        // A Re-read has stored nothing yet: the proof its lines and earlier steps planned is what the hooks and steps see.
        const planned = () => (live || !plan ? [] : [...plan.blocks.flatMap(piece => piece.block?.evidence ?? []), ...steps.flatMap(step => step.block?.evidence ?? [])]);
        const hooks = [
            ...(prechecks.length ? [{ moduleId: HOST_MODULE, precheck: true, fn: () => ({ commands: prechecks }) }] : []),
            ...(onlyPrechecks ? [] : registry.hookEntries('afterCapture')),
        ];
        for (const { moduleId, fn, precheck = false } of hooks) {
            const seen = live ? view() : makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader, state: now, reply, pendingProofs: () => planned().map(proof => ({ proof, block: null })) });
            let out;
            try { out = await within(fn(seen, { index, type }), HOOK_TIMEOUT_MS); } catch (error) {
                problems.push(problem({ module: moduleId, index, code: 'FAILED', message: `afterCapture failed: ${error?.message ?? error}` }));
                continue;
            }
            if (out === TIMED_OUT) {
                problems.push(problem({ module: moduleId, index, code: 'TIMEOUT', message: `afterCapture did not answer within ${HOOK_TIMEOUT_MS / 1000} s; its steps after the reply's lines were not run.` }));
                continue;
            }
            for (const command of Array.isArray(out?.commands) ? out.commands : []) {
                const payload = command?.payload ?? {};
                const seed = command.seed ?? seeds?.(command?.type);
                const taking = plan ? occurrenceFor(plan, command?.type, payload) : null;
                const result = bus.run(command?.type, payload, { cause: 'system', state: live ? store.head() : now, ...(reply ? { reply: plan ? { ...reply, ...(taking.span && (plan.preserveSources || occurrenceOf(taking.span) === null) ? { ordinal: taking.span.source.ordinal } : {}), pending: plan.pending, opsBefore: plan.blocks.reduce((sum, piece) => sum + (Number.isInteger(piece.n) ? piece.n : 0), 0) + steps.reduce((sum, step) => sum + (Array.isArray(step.ops) ? step.ops.length : 0), 0) } : reply } : {}), ...(plan ? { planned: planned(), replacing: plan.replacing, reusing: taking.span, ...(Number.isInteger(taking.value) ? { occurrence: taking.value } : {}) } : {}), ...(seed === undefined ? {} : { seed }) });
                if (!result?.ok) {
                    problems.push(problem({ module: moduleId, index, code: result?.code ?? 'FAILED', message: `The step "${command?.type}" after the reply's lines was not run: ${result?.message ?? 'unknown error'}` }));
                    continue;
                }
                let replan = result.receipt.replan;
                if (!replan) { try { replan = { payload: structuredClone(payload) }; } catch { replan = undefined; } }
                const receipt = { ...result.receipt, afterCapture: true, ...(precheck ? { beforeGenerate: true } : {}), ...(replan ? { replan } : {}) };
                if (live) {
                    store.append({ ops: result.ops, receipt, ...(result.block ? { block: result.block } : {}) });
                    now = store.head();
                    events?.emit('committed', { receipt });
                } else {
                    now = result.state;
                    if (result.block && plan) {
                        plan.pending += 1;
                        if (taking.key) plan.reuse.commit(taking.key, result.block.occurrence);
                    }
                }
                steps.push({ ops: result.ops, receipt, state: now, ...(result.block ? { block: result.block } : {}) });
            }
        }
        return steps;
    }

    // The occurrence a block of a Re-read that does `type` with `payload` takes (evidence.js reusePlan): the number of a block it replaces, else the next unused.
    function occurrenceFor(plan, type, payload) {
        try {
            const key = operationKey(type, payload);
            return { key, value: plan.reuse.peek(key), span: plan.reuse.span(key) };
        } catch { return { key: null, value: undefined }; }
    }

    // For a Re-read: each afterCapture step run again gets the seed of the old one of its type, in order.
    function stepSeeds(record) {
        const stored = (Array.isArray(record?.receipts) ? record.receipts : [])
            .filter(receipt => receipt?.cause === 'system' && receipt.afterCapture === true && Number.isInteger(receipt.seed));
        const used = new Set();
        return type => {
            const at = stored.findIndex((receipt, n) => !used.has(n) && receipt.type === type);
            if (at < 0) return undefined;
            used.add(at);
            return stored[at].seed;
        };
    }

    // The reply's lines in the order they run: as written, except a line of a kind with `after` (registry captureEntry) goes behind the
    // reply's last line of the kinds it names, so it reads what those lines set up. The others keep their order, and so do the moved ones.
    function linesInOrder(lines) {
        const kinds = lines.map(line => registry.capture(line.kind));
        if (!kinds.some(entry => entry?.after)) return lines;
        const key = (line, at) => {
            const after = kinds[at]?.after;
            const last = after ? kinds.reduce((found, entry, other) => (other > at && after.includes(entry?.kind) ? other : found), -1) : -1;
            return last < 0 ? [at, 0] : [last, at + 1];
        };
        return lines.map((line, at) => ({ line, order: key(line, at) }))
            .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
            .map(item => item.line);
    }

    // Runs `lines` as story captures on carrier `index`, each on the state the one before left. Stored on
    // the head as they go (append), or, with `base` (a Re-read), run on that state and returned as
    // { ops } for store.replaceStory, nothing stored.
    // `plan` ({ blocks: [], pending: 0 }, a Re-read's, shared by its calls): the guarded blocks planned so far
    // (REPLAY.md), so each line's block gets the next ordinal and replaceStory stores each as a block of its own.
    async function captureEach(index, lines, receipts, found, base = null, seeds = null, shown = new Map(), assist = null, plan = null) {
        const collected = [];
        const firstProblem = found.length;
        lines = linesInOrder(lines);
        // Display kinds (written words) whose lines were read while their feature was off (capture.js markOff).
        const off = new Set();
        let state = base ?? store.head();
        // ctx.carrier and ctx.chat for the capture handlers (MODULES §F2's capture context).
        const message = ctx?.chat?.[index];
        // `sid`: the reply's record ID, which stays with the reply when earlier messages are deleted.
        const carrier = { index, swipe: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0, sid: store.carrierSid?.(index) ?? null };
        // The message right before the reply (system messages aside), and only when it is the reader's: a reply that
        // follows another reply has no message of the reader's to quote (proof, EVIDENCE.md).
        const before = (ctx?.chat ?? []).slice(0, index).findLast(item => !item?.is_system);
        const reader = before?.is_user ? before : null;
        const chat = { lastUser: String(reader?.mes ?? ''), reply: stripBlock(String(message?.mes ?? ''), 'Changes', { heads: changeHeads() }) };
        // A Re-read (a2-3): the reply as it stands now, for bookkeeping its kept blocks wrote (ctx.standing).
        let standing = null;
        if (base) { try { standing = store.at(index); } catch { standing = null; } }
        // `shown`: how many lines of each display kind this reply has shown so far (their cap per reply).
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
                // B-a1-5: a display line told as not used stays unshown when the feature is turned on
                // later; a Re-read reads it again.
                if (entry.display) off.add(line.kind);
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
                const operation = { type: `${CAPTURE_PREFIX}${entry.kind}`, payload: { ...line, kind: entry.kind, word: line.kind } };
                const taking = plan ? occurrenceFor(plan, operation.type, operation.payload) : null;
                const run = opts => bus.run(operation.type, operation.payload, { cause: 'story', state, capture: entry, carrier: plan ? { ...carrier, ...(taking.span && (plan.preserveSources || occurrenceOf(taking.span) === null) ? { ordinal: taking.span.source.ordinal } : {}), pending: plan.pending, opsBefore: plan.blocks.reduce((sum, piece) => sum + (Number.isInteger(piece.n) ? piece.n : 0), 0) } : carrier, chat, standing, ...(plan ? { planned: plan.blocks.flatMap(piece => piece.block?.evidence ?? []), replacing: plan.replacing, reusing: taking.span, ...(Number.isInteger(taking.value) ? { occurrence: taking.value } : {}) } : {}), ...(seed === undefined ? {} : { seed }), ...opts });
                result = entry.off ? await run({ capture: { ...entry, off: false }, again: true }) : await run();
                // Refused by a feature that is off (a command it called, ctx.feature): run as it ran before.
                if (again && !entry.off && result?.code === 'FEATURE_OFF') result = await run({ again: true });
                // The receipt remembers which line made it (`line`), so a Re-read can give the line its seed again.
                // The safety net's lines are marked as its (receipt `assist`: 'now' | 'late', and the line).
                if (result?.ok) result = { ...result, receipt: { ...result.receipt, line: mark, ...(assist ? { assist, assistLine: cutAt(line.raw, 200) } : {}) } };
                if (result?.ok && base) {
                    collected.push(...result.ops);
                    if (plan) {
                        plan.blocks.push({ n: result.ops.length, receipt: result.receipt, ...(result.block ? { block: result.block } : {}) });
                        if (result.block) {
                            plan.pending += 1;
                            if (taking.key) plan.reuse.commit(taking.key, result.block.occurrence);
                        }
                    }
                } else if (result?.ok) store.append({ ops: result.ops, receipt: result.receipt, ...(result.block ? { block: result.block } : {}) });
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
        // What the safety net's lines met is marked as its in the Problems list.
        if (assist) {
            for (const item of found.slice(firstProblem)) {
                if (item.assist) continue;
                item.assist = assist;
                item.message = `(assist${assist === LATE ? ', from the previous reply' : ''}) ${item.message}`;
            }
        }
        return { ops: collected, off: [...off], state };
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
    // The first module held back (registry.heldModules) that the reply carries lines, receipts or ops of, as
    // { code, name, reason }, else null. `lines`: the change lines about to be read again.
    function heldInReply(message, lines) {
        const held = new Set(registry.heldModules?.() ?? []);
        if (!held.size) return null;
        const record = readRecord(message);
        const found = new Set();
        for (const line of lines) {
            const owner = registry.captureOwner?.(line?.kind);
            if (owner) found.add(owner);
        }
        for (const receipt of record?.receipts ?? []) if (typeof receipt?.module === 'string') found.add(receipt.module);
        for (const op of record?.ops ?? []) {
            const owner = typeof op?.path === 'string' ? registry.domainOwner?.(/^\/domains\/([^/]+)/.exec(op.path)?.[1] ?? '') : null;
            if (owner) found.add(owner);
        }
        const id = [...held].sort().find(item => found.has(item));
        if (!id) return null;
        const life = registry.lifecycle?.(id);
        return { code: life?.status === 'restore-pending' ? 'RESTORE_PENDING' : 'DEPENDENCY_UNAVAILABLE', name: registry.module?.(id)?.name ?? id, reason: life?.reason ?? 'It is not running.' };
    }

    async function reread(index) {
        const chat = ctx?.chat ?? [];
        const message = Number.isInteger(index) ? chat[index] : undefined;
        if (!message) return refusal('NOT_FOUND', `There is no message ${index} in this chat.`);
        if (message.is_user) return refusal('REFUSED', 'This is the reader\'s own message; only replies hold story changes.');
        // (a reply a restore hid keeps its record, and can be read again; a system message of SillyTavern's has none)
        if (message.is_system && !readRecord(message)) return refusal('REFUSED', 'This is a system message; it holds no story changes.');
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
        // The safety net's stored lines (MODULES §F123): the previous reply's late ones, then this reply's
        // own, as the live capture ran them. Never a new model call.
        const own = lines.map(line => line.raw);
        const late = lateLines(index, own);
        const extra = assistRoom(index, [...late.map(line => ({ line, mark: LATE })), ...nowLines(mes, [...own, ...late.map(line => line.raw)]).map(line => ({ line, mark: NOW }))], lines.length, problems);
        // A module held back (dormant, or a restore is pending) cannot read its lines again, and replacing the
        // reply's story without them would lose what it stored: nothing is replaced while one is involved.
        const waiting = heldInReply(message, [...lines, ...extra.map(item => item.line)]);
        if (waiting) return refusal(waiting.code, `Re-read is waiting for ${waiting.name}: ${waiting.reason} Nothing was changed.`);
        const swipe = message.swipe_id;
        let ops;
        let off = [];
        let steps = [];
        // `replacing`: the proof of the blocks this Re-read replaces (its story lines and its steps): ids of them may be held again by the blocks that replace
        // them. `reuse`: the occurrences those blocks have, given again per operation while the number of blocks of the operation is unchanged.
        let plan = null;
        const problemsFrom = problems.length;
        const reply = store.carrierSid?.(index) ? { index, sid: store.carrierSid(index) } : null;
        try {
            let after;
            // The Re-read is planned; when an operation has more or fewer blocks than it replaces it is planned again with none of that
            // operation's old occurrences given back (evidence.js reusePlan), and again while a plan finds another operation changed (the
            // retired set only grows). Every pass starts from the same inputs but that set: seeds, steps' seeds, plan and outputs are made anew.
            let retire = new Set();
            const bound = 32;     // (each pass retires at least one more operation, so a reply ends well before; a plan that does not is not stored)
            let settled = false;
            for (let pass = 0; pass <= bound; pass += 1) {
                receipts.length = 0;
                problems.length = problemsFrom;
                steps = [];
                const seeds = storySeeds(readRecord(message));
                const record = readRecord(message);
                // Native checkpoints name exact prefixes. An unchanged reply reusing the same roots must keep their
                // Sources too, or a fresh ordinal alone changes owner state and silently drops its native checkpoint.
                // Changed text and chats without published native work retain the ordinary allocation behavior.
                const preserveSources = timeline?.hasNativeChanges?.() === true
                    && record?.spans?.some(span => span.boundaries?.[0]?.payloadHash === store.payloadHashAt(index));
                plan = { blocks: [], pending: 0, replacing: replacedProofs(record), reuse: reusePlan(record, retire), preserveSources };
                const prechecks = (record?.receipts ?? [])
                    .filter(receipt => receipt.beforeGenerate === true && isPrelude(receipt.type))
                    .map(receipt => ({ type: receipt.type, payload: receipt.replan?.payload ?? {}, seed: receipt.seed }));
                const prepared = prechecks.length ? await afterCapture(index, { type: 'reread', problems, state: base, reply, plan, prechecks, onlyPrechecks: true }) : [];
                plan.blocks.push(...prepared.map(step => ({ n: step.ops.length, receipt: step.receipt, ...(step.block ? { block: step.block } : {}) })));
                receipts.push(...prepared.map(step => step.receipt));
                ({ ops, off, state: after } = await captureEach(index, lines, receipts, problems, prepared.at(-1)?.state ?? base, seeds, new Map(), null, plan));
                ops = [...prepared.flatMap(step => step.ops), ...ops];
                for (const mark of [LATE, NOW]) {
                    const group = extra.filter(item => item.mark === mark).map(item => item.line);
                    if (!group.length) continue;
                    const more = await captureEach(index, group, receipts, problems, after, seeds, new Map(), mark, plan);
                    ops = [...ops, ...more.ops];
                    off = [...new Set([...off, ...more.off])];
                    after = more.state;
                }
                // The reply's afterCapture steps, run again after its new story lines (none when none was kept).
                if (receipts.length) steps = await afterCapture(index, { type: 'reread', problems, state: after, reply, seeds: stepSeeds(readRecord(message)), plan });
                const unsure = plan.reuse.ambiguous([...plan.blocks, ...steps]);
                if (!unsure.length) { settled = true; break; }
                retire = new Set([...retire, ...unsure]);
            }
            // A plan that still reports a changed operation is never stored.
            if (!settled) return refusal('CONFLICT', 'The reply could not be read again without taking blocks for ones that went; nothing was changed.');
            // B-b2-timeline-r2: the lines ran while the reader could act (a capture handler may wait). A
            // message deleted, another chat opened, the reply swiped or edited, or a reply begun in that
            // time: what was read is no longer this reply's, so nothing is stored (not even on the
            // message that now stands at `index`).
            const live = ctx?.chat ?? [];
            if (live[index] !== message || message.swipe_id !== swipe || String(message.mes ?? '') !== mes || session) {
                return refusal('CONFLICT', 'The chat changed while the reply was read again (a message was deleted, swiped, edited or added); nothing was changed. Press Re-read again.');
            }
            // A kept system step marked `replan` (B-a1-13) runs again on the new story changes, as it ran
            // before: a system step, its own seed.
            // A guarded block of a later reply is planned again on its own reply, keeping its ordinal (info.span).
            const rerun = (state, receipt, info = null) => planAgain(state, receipt, info, !Number.isInteger(info?.index) || info.index === index ? reply : null);
            store.replaceStory(index, { ops, receipts, rerun, settled: steps, blocks: plan.blocks });
        } catch (error) {
            return refusal('CONFLICT', `${error?.message ?? error}`);
        }
        // The lines it left in the story are listed in the hidden comment (capture.js), and every comment's
        // display lines are marked as this read found their features (markOff).
        const hidden = markOff(hideBlock(mes, 'Changes', { heads }), off, 0);
        if (hidden !== mes) {
            message.mes = hidden;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
            redraw(index, message);
        }
        timeline?.settle();
        if (timeline?.needsRecovery()) await timeline.recover();
        await trySave('after the Re-read');
        for (const receipt of [...receipts, ...steps.map(step => step.receipt)]) events?.emit('committed', { receipt });
        events?.emit('head', { index: store.headIndex() });
        events?.emit('turn', { index, type: 'reread', receipts, steps: steps.map(step => step.receipt), problems, told: [] });
        return { ok: true, receipts, steps: steps.map(step => step.receipt), problems };
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
        // The turn's save window opens now, so the capture's lines are not saved one by one (400 ms each).
        const idle = store.saveIdle?.() === true;
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
            const cut = block === null ? null : cutLine(text, 'Changes', at);
            if (cut) problems.push(problem({ index: id, line: cut, code: 'CUT_OFF', message: `The reply ended in the middle of the change line "${cutAt(cut, 80)}" (nothing after it on its line, and the block was not closed), so it was not used. Continue finishes it; or end the line and close the block by hand, then Re-read.` }));
            // The previous reply's safety-net lines that came after the reader sent (not for a Continue).
            const late = current.type === 'continue' ? [] : lateLines(id, parsed.lines.map(line => line.raw));
            const result = await captureLines(id, parsed.lines, at ? current.base : null, current.type, { late, prechecks: current.prechecks });
            problems.push(...result.problems);
            receivedHooks(id, current.type);

            // What this reply was told; a Continue keeps what the reply was told before.
            // (B-b2-timeline-9: read through readRecord, and only receipt IDs, whatever the chat holds.)
            const told = current.type === 'continue' ? readRecord(message)?.narrated ?? [] : [];
            const before = told.filter(id => typeof id === 'string');
            store.setNarrated(id, [...new Set([...before, ...current.untold, ...result.steps.filter(receipt => receipt.beforeGenerate === true).map(receipt => receipt.id)])]);

            // Also with no block: the change lines left in the story are listed in the hidden comment, so a
            // Re-read leaves them too (B-a1-3, B-a1-10).
            let hidden = hideBlock(message.mes, 'Changes', { ...(at ?? {}), stopped, heads });
            if (result.off.length) hidden = markOff(hidden, result.off, at?.from ?? 0);
            if (hidden !== message.mes) {
                message.mes = hidden;
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
                edited = true;
            }
            if (timeline?.needsRecovery()) {
                const anchored = await timeline.recover();
                if (!anchored.ok) problem({ index: id, code: anchored.code, message: anchored.message });
            }
            deferred = false;
            // One write for the reply, its capture and the reader's actions after it (store.saveIdle).
            if (idle && store.dirty()) store.saveIdle();
            else if (store.dirty()) await trySave('after the reply');
            else if (edited) await saveText();
            // At MESSAGE_RECEIVED SillyTavern has not drawn the reply yet (it draws the text as saved), so
            // redrawing can fail; that is not a reason to lose the turn.
            if (edited) redraw(id, message);
            const turn = { index: id, type: current.type, receipts: result.receipts, steps: result.steps, problems, told: current.untold };
            events?.emit('turn', turn);
            afterReply(id, current.type, message, [...parsed.lines, ...late].map(line => line.raw));
            return turn;
        } catch (error) {
            problem({ index: id, code: 'FAILED', message: `The reply's changes could not be kept: ${error?.message ?? error}` });
            return null;
        }
    }

    // afterReply (the assist extractor): a reply that came without change lines may get them from a
    // module after all. Not awaited; a failure is logged. `capture(text, { index, swipe })` runs the
    // lines as story captures on that reply when it is still the head on the same swipe.
    // (The Assist safety net runs after every reply; `lines` are the change lines its capture read.) A send
    // waits for these runs briefly (assistPending, ASSIST_WAIT_MS).
    function afterReply(index, type, message, lines = []) {
        const swipe = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
        const runs = [];
        for (const { moduleId, fn } of registry.hookEntries('afterReply')) {
            runs.push(Promise.resolve()
                .then(() => fn({ index, swipe, type, lines: [...lines], mes: String(message?.mes ?? ''), capture: (text, at = { index, swipe }, opts = {}) => captureLate(at, text, opts) }))
                .catch(error => problem({ module: moduleId, index, code: 'FAILED', message: `afterReply failed: ${error?.message ?? error}` }))
                // C2-ext: what the hook made of the reply (the extractor read it, or failed to) can change
                // the reply's note, so the notes are drawn again.
                .finally(() => { if (store.headIndex() === index) events?.emit('head', { index }); }));
        }
        if (!runs.length) return;
        const all = Promise.allSettled(runs).then(() => { if (assistPending === all) assistPending = null; });
        assistPending = all;
    }

    // afterReceive: every reply that arrives, with or without change lines, once its lines have been read and before it is
    // saved (the RPG lets go of the plan it held for the reply). Nothing is asked of it; a failure is a Problem.
    function receivedHooks(index, type) {
        for (const { moduleId, fn } of registry.hookEntries('afterReceive')) {
            try { fn(view(), { index, type }); } catch (error) {
                problem({ module: moduleId, index, code: 'FAILED', message: `afterReceive failed: ${error?.message ?? error}` });
            }
        }
    }

    /** Change lines found after the reply (afterReply): captured on it and kept in its hidden block. */
    async function captureLate({ index, swipe } = {}, text = '', { assist = false } = {}) {
        const message = ctx?.chat?.[index];
        if (assist) return captureAssist({ index, swipe }, text, message);
        if (!isCarrier(message) || store.headIndex() !== index || (Number.isInteger(message.swipe_id) ? message.swipe_id : 0) !== swipe || session) {
            return { receipts: [], problems: ['The reply changed before its late change lines arrived; they were not used.'] };
        }
        const parsed = readBlock(index, String(text ?? ''));
        const problems = [...parsed.problems];
        const result = await captureLines(index, parsed.lines, String(message.mes ?? ''), 'late');
        problems.push(...result.problems);
        if (parsed.lines.length) {
            // Kept in a hidden block of their own after the reply's, so Re-read finds them too (and what the
            // reply's comment holds besides its block, the lines left in the story, stays as it was).
            const base = String(message.mes ?? '');
            const from = base.trimEnd().length;
            const mes = markOff(hideBlock(`${base}\n\n<Changes>\n${parsed.lines.map(line => line.raw).join('\n')}\n</Changes>`, 'Changes', { from }), result.off, from);
            message.mes = mes;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = mes;
        }
        if (store.dirty()) {
            if (store.saveIdle?.() !== true) await trySave('after the late change lines');
        } else if (parsed.lines.length) await saveText();
        if (parsed.lines.length) redraw(index, message);
        const turn = { index, type: 'late', receipts: result.receipts, steps: result.steps, problems, told: [] };
        events?.emit('turn', turn);
        return turn;
    }

    /**
     * The Assist safety net's lines for reply `index` (MODULES §F123). Still the head on the same swipe and
     * no send begun: run now as story lines marked `assist: 'now'`, after the reply's own, and kept in its
     * <Changes-assist> section. A send already begun (the brief wait is over): kept on the reply as
     * <Changes-assist-next>, through the stricter wall, for the next reply to apply after its own lines;
     * nothing changes now. Anything else (swiped, deleted, the next reply already in): not used.
     */
    async function captureAssist({ index, swipe }, text, message) {
        const same = isCarrier(message) && store.headIndex() === index && (Number.isInteger(message.swipe_id) ? message.swipe_id : 0) === swipe;
        if (!same) return { receipts: [], problems: ['The reply changed before the safety net\'s lines arrived; they were not used.'], dropped: true };
        const heads = changeHeads();
        const mes = String(message.mes ?? '');
        const block = extractBlock(mes, 'Changes', null, { heads });
        const own = [...(block === null ? [] : parseChanges(block).lines.map(line => line.raw)), ...lateLines(index, []).map(line => line.raw)];
        const parsed = parseChanges(String(text ?? '')).lines;
        const fresh = new Set(notWritten(parsed.map(line => line.raw), own));
        const kept = parsed.filter(line => fresh.has(line.raw) && !refusedWhy(line, null, { late: Boolean(session || replyBusy) }));
        const store1 = mes2 => {
            message.mes = mes2;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = mes2;
        };
        if (session || replyBusy) {
            if (!kept.length) return { receipts: [], problems: [], deferred: true };
            // Saved with the next reply (its own save writes the chat).
            store1(withAssist(mes, kept.map(line => line.raw), { next: true }));
            redraw(index, message);
            return { receipts: [], problems: [], deferred: true, lines: kept.map(line => line.raw) };
        }
        if (!kept.length) return { index, type: 'late', receipts: [], steps: [], problems: [], told: [] };
        const used = block === null ? 0 : readBlock(index, block).lines.length;
        const result = await captureLines(index, [], mes, 'late', { assist: kept, used });
        store1(markOff(withAssist(mes, kept.map(line => line.raw)), result.off, mes.trimEnd().length));
        if (store.dirty()) {
            if (store.saveIdle?.() !== true) await trySave('after the safety net\'s lines');
        } else await saveText();
        redraw(index, message);
        const turn = { index, type: 'late', receipts: result.receipts, steps: result.steps, problems: result.problems, told: [] };
        events?.emit('turn', turn);
        return turn;
    }

    /** CHAT_CHANGED: a new chat (or the same one reloaded). */
    async function onChatChanged() {
        session = null;
        markIdle();
        clearPrompts();
        rebuild({ publish: false });
        timeline?.settle();
        // A1-2: read-backs of a write that timed out before a reload of the page go on.
        try { store.resume?.(); } catch { /* only a guard */ }
        // A cue left for the reply's save (runCues) whose reply will not come here: saved now (into its
        // own chat's file when this is another chat, the store's rescue).
        if (deferred) {
            deferred = false;
            if (store.dirty?.()) store.scheduleSave?.();
        }
        await ensureModules({ store, bus, registry, events });
        events?.emit('head', { index: store.headIndex() });
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
    async function onTimelineChanged() {
        rebuild({ publish: false });
        reconcileNow();
        timeline?.settle();
        if (timeline?.needsRecovery()) await timeline.recover();
        events?.emit('head', { index: store.headIndex() });   // one head, after the steps that follow the change are planned again
    }

    /**
     * A deleted swipe. SillyTavern tells of the deletion of the swipe being shown before it shows the next one (`extra` is
     * still the deleted swipe's; MESSAGE_SWIPED follows). The shown swipe is told by whose record it holds, not by its text
     * (persist.js swipeLoading): while it is in flux nothing is rebuilt, restamped, reconciled or published, so no record is
     * written and no head is told of; the swipe load that follows does all of it once. Any other swipe deletion is a
     * change on its own.
     */
    function onSwipeDeleted(detail) {
        const live = ctx?.chat ?? [];
        const at = Number.isInteger(detail) ? detail : detail?.messageId;
        const message = live[Number.isInteger(at) ? at : live.length - 1];
        const deleted = Number.isInteger(detail?.swipeId) ? detail.swipeId : null;
        if (swipeLoading(message, deleted)) return;
        return onTimelineChanged();
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

    let offModules = null;
    function install({ globalName = INTERCEPTOR_NAME } = {}) {
        for (const [key, place] of V1_KEYS) setPrompt(key, '', place);
        clearPrompts();
        if (globalName) globalThis[globalName] = interceptor;
        // A module turned ready or dormant: guarded blocks of its are asked again (store.lifecycleChanged).
        offModules?.();
        offModules = events?.on?.('modules', () => {
            if (store.lifecycleChanged?.()) events?.emit('head', { index: store.headIndex() });
        }) ?? null;
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
        for (const event of [names.MESSAGE_DELETED, names.MESSAGE_SWIPED, names.CHARACTER_FIRST_MESSAGE_SELECTED, names.MESSAGE_EDITED]) on(event, onTimelineChanged);
        on(names.MESSAGE_SWIPE_DELETED, onSwipeDeleted);
        return api;
    }

    function uninstall({ globalName = INTERCEPTOR_NAME } = {}) {
        offModules?.();
        offModules = null;
        const source = ctx?.eventSource;
        for (const [event, fn] of listeners) (source?.removeListener ?? source?.off)?.call(source, event, fn);
        listeners = [];
        if (globalName && globalThis[globalName] === interceptor) delete globalThis[globalName];
        clearPrompts();
        markIdle();
    }

    const api = {
        repairActions,
        repair,
        startOver,
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
