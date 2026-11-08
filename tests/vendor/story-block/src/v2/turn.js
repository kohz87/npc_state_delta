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

import { PRECHECK } from './assist/classifier.js';
import { makeView } from './sdk.js';
import { SLOT_NUMBER } from './skill-slots.js';
import { rpgLib } from './rpg-lazy.js';

// A story line that practises a skill (`practice-N`, data-modules/part.js): the lines a reply is marked for (see captureEach).
const PRACTICE_LINE = new RegExp(`\\|\\s*kind\\s*:\\s*practice-${SLOT_NUMBER}\\b`, 'iu');
import { contentText, contextRoom } from './turn/text.js';
import { createSession } from './turn/session.js';
import { createCaptureFlow } from './turn/capture-flow.js';
import { createReread } from './turn/reread.js';
import { createPromptBuild } from './turn/prompt-build.js';
import { createPromptHooks } from './turn/prompt-hooks.js';
import { createEvents } from './turn/events.js';
import { boardStartState, boardStep, restoreHint } from './turn/held-board.js';
import { pendingStart } from './turn/fight-start.js';
export { QUIET_MARK_MIN, QUIET_WAIT_MS, MAX_NAME, stripBattleMarker, contextRoom, defuseMacros, flatName, substituteNames, quietMark, restoreMissing } from './turn/text.js';

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
// A hook may declare its own, longer limit (`fn.timeoutMs`): the RPG's roll planner (removed in 2.25.0) was the one that made a model call of up to 20 s.
export const hookTimeout = fn => (Number.isFinite(fn?.timeoutMs) && fn.timeoutMs > HOOK_TIMEOUT_MS ? fn.timeoutMs : HOOK_TIMEOUT_MS);
// A reply that never ends (no MESSAGE_RECEIVED, GENERATION_ENDED or STOPPED) stops counting as in progress
// after this long, so Story Suite's own model calls on the chat's connection are not held up for good.
export const REPLY_BUSY_MAX_MS = 5 * 60_000;
// How long a send waits for the Assist safety net still reading the last reply (MODULES §F123): briefly.
// Lines that come later are kept on that reply and applied on the next one, right after its own lines.
export const ASSIST_WAIT_MS = 1500;
// How long the RPG's code (rpg-lazy.js) may take to load before a reply or a chat goes on without it: a stalled import never holds a generation or a chat open.
export const RPG_LOAD_WAIT_MS = 4000;
// Stripped history texts kept between prompts (each is read again for every later prompt).
const STRIP_CACHE = 500;
const HAS_BLOCK = /<changes/i;
// Story Block v1's envelope (capture.js adoptLegacy): never sent to the model. In a text completion prompt only a closed
// one, and never across another comment's start, so one left open cannot take the rest of the prompt with it.
const HAS_LEGACY = /<!--\s*(?:STORY_BLOCKS_V1|INVENTORY_BLOCK_V05)/i;
const LEGACY_IN_PROMPT = /\s*<!--\s*(?:STORY_BLOCKS_V1_CUT|STORY_BLOCKS_V1|INVENTORY_BLOCK_V05)\b(?:(?!<!--)[\s\S])*?-->/gi;

const defaultNotify = reason => globalThis.toastr?.warning?.(reason, 'Story Suite');

// Why the state was rebuilt, as the head event tells it (the public API's `story:rebuilt`; 'edit' is not announced).
const REBUILD_REASONS = new Set(['delete', 'swipe', 'edit']);

export const normalizeType = type => String(type ?? 'normal').trim().toLowerCase() || 'normal';
const holdsIn = chat => mark => chat.some(message => contentText(message?.content).includes(mark));
const isCarrier = message => Boolean(message) && !message.is_user;

/**
 * Wires one SillyTavern context. `deps`: { ctx, live?() (SillyTavern's live context, for its API settings;
 * default ctx), store, bus, registry, settings, events?,
 * onBlocked?(reason, moduleId), notify?(reason, moduleId) (default: a toastr warning),
 * initial?() → the initial State for a chat with none (default registry.initialState(); the host
 * adds the packs' start, SPEC §2.6), ownPrompt?(eventData) → true for the prompt of Story Suite's own model
 * call on the chat's connection (model-call.js createOwnCalls().owns): never taken for the reply's }.
 * `settings` is createSettings() (settings() → host settings, settings(id) → a module's).
 * Returns { interceptor, install, uninstall, onGenerationStarted, onPromptReady, onTextPromptReady, onMessageReceived,
 * onChatChanged, seed, onChatRenamed, onTimelineChanged, onGenerationEnded, preview, report, problems, clearProblems, blocked, blockers, unblock,
 * session, replyBusy, whenIdle }.
 */
export function createTurn({ ctx, live = () => ctx, store, bus, registry, settings, events = null, onBlocked = null, notify = defaultNotify, initial = () => registry.initialState(), ownPrompt = () => false, timeline = null, prepare = null }) {
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
    const s = {
        session: null,
        boardCapture: null,
        heldBoard: null,
        abortBoard: null,
        deferred: false,   // cues committed before a reply, left for the reply's save (runCues)
        listeners: [],
        problemLog: [],
        blocks: [],
        lastSize: null,   // the context size the last interceptor call was handed
        // Quiet generations told by GENERATION_STARTED: { mark, claimed (its interceptor ran, at this time) }, oldest first.
        quiets: [],
        // What the two slots hold now (setPrompts).
        slots: { staticText: '', tailText: '' },
        toldSmall: new Set(),   // chats whose reader was told the context is too small
        // A reply in progress: from its interceptor until it is received, ended, stopped or held back (or the
        // chat changes). Story Suite's own model calls on the chat's connection wait for it (whenIdle).
        replyBusy: false,
        // The Assist safety net's runs on the last reply (afterReply), until they settle.
        assistPending: null,
        busyTimer: null,
        idleWaiters: [],
        // Every earlier reply is in every prompt: what its text is without blocks is remembered, and a
        // text with no "<changes" in it at all is passed by without reading it further.
        stripped: new Map(),
        offModules: null,
        offBoard: [],
    };
    const liveContext = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const metadata = () => liveContext()?.chatMetadata ?? null;
    const contextNow = () => contextRoom(liveContext(), s.lastSize);
    const whenIdle = () => (s.replyBusy ? new Promise(resolve => s.idleWaiters.push(resolve)) : Promise.resolve());
    const boardError = (state, board) => {
        const start = boardStartState(bus, state, board);
        if (start.error) return start.error;
        const check = rpgLib()?.boardInputError;
        return typeof check === 'function' ? check(start.state, board) : 'The fight could not be checked.';
    };
    // Keep the witnessed inputs against reader edits while the reply is in flight. Capture runs its own changes in order.
    bus.setCommitGuard?.((next, receipt) => {
        if (receipt?.cause !== 'ui') return null;
        const board = s.replyBusy && boardStep(s.session)?.payload.board;
        if (!board) return null;
        return boardError(next(), board) ? 'Wait for the reply to finish before changing the fight sheet or gear.' : null;
    });
    // Our own model call's prompt (model-call.js) is never the reply's.
    const isOwn = eventData => {
        try { return ownPrompt(eventData) === true; } catch { return false; }
    };

    const view = () => makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader });
    const hasCarrier = () => (ctx?.chat ?? []).some(isCarrier);
    const lastCarrier = () => (ctx?.chat ?? []).findLastIndex(isCarrier);

    // The commands run as preludes: Assist's pre-roll, and any command a module marks `prelude` (registry.isPrelude).
    const isPrelude = type => type === PRECHECK || registry.isPrelude?.(type) === true;

    const refusal = (code, message) => ({ ok: false, code, message });

    // Session housekeeping and Re-read (turn/session.js, turn/reread.js): wired here, after every const they are given.
    const { markBusy, markIdle, setPrompt, setPrompts, clearPrompts, problem, trySave, ensureInitial, held, repairActions, repair, startOver, rebuild, planAgain, reconcileNow } = createSession(s, { ctx, store, bus, events, notify, initial, position, roles, hasCarrier, refusal, STATIC_KEY, TAIL_KEY, REPLY_BUSY_MAX_MS, MAX_PROBLEMS, ROLE_SYSTEM });
    const stopChangedBoard = () => {
        const current = s.session, board = s.replyBusy && boardStep(current)?.payload.board;
        if (!board || current.boardInvalid) return;
        const error = boardError(store.head(), board);
        if (!error) return;
        current.boardInvalid = true;
        const reason = `${error}${restoreHint(error, ' before retrying.')}`;
        problem({ module: 'story-block', code: 'BOARD_CHANGED', message: reason });
        try { s.abortBoard?.(true); } catch { /* the reason is still shown */ }
        try { notify?.(reason, 'story-block'); } catch { /* the problem remains visible */ }
    };
    // The capture flow (turn/capture-flow.js): wired here, after the session's `problem` it is given and before the Re-read that calls it.
    const { changeHeads, readBlock, strayProblems, legacyProblem, capped, assistRoom, lateLines, nowLines, captureLines, afterCapture, stepSeeds, captureEach, storySeeds, heldInReply, withCaps, LATE, NOW } = createCaptureFlow(s, { ctx, store, bus, registry, settings, events, hostSettings, view, viewReader, lateReader, problem, isCarrier, boardError, PRACTICE_LINE, HOOK_TIMEOUT_MS });
    const { reread, saveText, redraw } = createReread(s, { ctx, metadata, store, events, timeline, refusal, changeHeads, readBlock, strayProblems, capped, lateLines, assistRoom, nowLines, heldInReply, legacyProblem, storySeeds, afterCapture, captureEach, stepSeeds, withCaps, isPrelude, LATE, NOW, planAgain, problem, trySave });

    // The prompt side of a turn (turn/prompt-build.js, turn/prompt-hooks.js): wired here, after every const they are given. The interceptor asks for claimQuiet only when it runs.
    const { runCues, build, askCanGenerate, runOnBlocked, interceptor, battleOn, stripHistory, backgroundPrompt, foreignPrompt } = createPromptBuild(s, { ctx, metadata, store, bus, registry, settings, events, timeline, onBlocked, notify, initial, prepare, hostSettings, viewReader, view, contextNow, hasCarrier, lastCarrier, isPrelude, markBusy, markIdle, setPrompts, clearPrompts, problem, trySave, held, claimQuiet: () => claimQuiet(), FOREGROUND, HOOK_TIMEOUT_MS, ASSIST_WAIT_MS, RPG_LOAD_WAIT_MS, OWN_PROMPT_PARTS, OWN_PROMPT_CHARS, STRIP_CACHE, HAS_BLOCK, HAS_LEGACY, hookTimeout, normalizeType });
    const { onGenerationStarted, claimQuiet, onPromptReady, onTextPromptReady } = createPromptHooks(s, { isOwn, battleOn, stripHistory, backgroundPrompt, foreignPrompt, HAS_LEGACY, LEGACY_IN_PROMPT, holdsIn, normalizeType });

    // The SillyTavern event handlers (turn/events.js): wired here, after every part they are given. `getApi` is read only when install runs, after the api below exists.
    const { install, uninstall, onMessageReceived, onChatChanged, seed, onChatRenamed, onTimelineChanged, onGenerationEnded } = createEvents(s, { markIdle, clearPrompts, ctx, metadata, isCarrier, store, ensureInitial, problem, notify, stopChangedBoard, boardError, changeHeads, readBlock, strayProblems, legacyProblem, lateLines, captureLines, withCaps, timeline, trySave, saveText, redraw, events, registry, view, prepare, RPG_LOAD_WAIT_MS, rebuild, bus, hasCarrier, reconcileNow, REBUILD_REASONS, INTERCEPTOR_NAME, V1_KEYS, setPrompt, interceptor, onGenerationStarted, onPromptReady, onTextPromptReady, getApi: () => api });

    const api = {
        repairActions,
        repair,
        startOver,
        interceptor,
        install,
        uninstall,
        onGenerationStarted,
        onPromptReady,
        onTextPromptReady,
        onMessageReceived,
        onChatChanged,
        seed,
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
        // (`toast`: told at once too, not only listed)
        report: entry => {
            const item = problem(entry);
            if (entry?.toast === true) { try { notify?.(item.message, item.module); } catch { /* a missing toastr is not an error */ } }
            return item;
        },
        /** The Problems list, oldest first; `moduleId` narrows it (null: the host's own). */
        problems: moduleId => s.problemLog.filter(item => moduleId === undefined || item.module === moduleId).map(item => ({ ...item })),
        clearProblems: () => { s.problemLog.length = 0; },
        /** Generations a canGenerate hook stopped: [{ moduleId, reason }], oldest first. */
        blocked: () => s.blocks.map(item => ({ ...item })),
        /**
         * Every module holding the story back now (each canGenerate asked, none logged):
         * Promise<[{ moduleId, name, reason, action, canOpen }]> (`action`: the module's button words, '' for
         * the host's own, false for no button; `canOpen`: it has an onBlocked hook to run).
         */
        blockers: () => askCanGenerate({ all: true }),
        /** Runs module `moduleId`'s onBlocked(reason, moduleId) hook (Home's button). → true when it ran. */
        unblock: (moduleId, reason = '') => runOnBlocked(moduleId, reason),
        /** The pending reply's session (for status and tests), or null. */
        session: () => (s.session ? { ...s.session } : null),
        /** The held opening's private sheet, recreated with its saved seed. */
        fightStartPreview: () => {
            const pending = pendingStart(metadata(), ctx?.chat);
            if (!pending?.opening) return null;
            const preview = bus.run('rpg.resolve', pending.opening.payload, { cause: 'system', seed: pending.opening.seed });
            return preview?.ok ? { state: preview.state, result: preview.receipt?.data?.v2?.result } : null;
        },
        /** Whether a reply is being built or awaited (its interceptor ran; not yet received, ended or stopped). */
        replyBusy: () => s.replyBusy,
        /** Resolves when no reply is in progress (at once when none is). */
        whenIdle,
    };
    return api;
}
