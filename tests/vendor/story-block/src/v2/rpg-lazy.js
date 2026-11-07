// The RPG's code is loaded only when it is needed (Story Block 2.17.0, "lazy RPG").
//
// src/v2/lean-rpg/index.js (the part with the rolls, the pre-call, fight XP, practice, the companions who join and
// everything they pull in) is a dynamic import: nothing of it is fetched while the feature `story-block.rpg` is off
// and the chat holds nothing the RPG wrote. It IS fetched, before the chat is replayed,
//   - when the feature is on (at boot, or the moment the reader switches it on), or
//   - when the open chat holds the RPG's records: a stored roll, fight XP, practice or a joined companion (`holdsRpg`),
//     or a held plan / start note in the chat's metadata, so a chat with RPG receipts replays exactly as recorded
//     whatever the feature says now.
// The small helpers every block uses (names.js, blocks.js, formula.js, read.js, soul.js, tail.js, cue.js, foes.js, levels.js) stay static.
//
// This file holds: the loaded library's holder (`rpgLib`), the part's stand-in (`createLazyRpgPart`: the same commands,
// cards, queries, hooks, settings and guard as lean-rpg/index.js createLeanRpgPart, handed to the real part once the
// library is there), the loader (`createRpgLoader`) and the check of a chat (`holdsRpg`). No DOM, no SillyTavern.
import { CORE_FEATURE } from './features.js';
import { BOARD_SKILL, BOARD_SKILL_CARRY, FIGHT, LEAN_RPG_FEATURE, LEVEL, LEVEL_CAP_SETTING, NOROLL, PLANNER_LIMIT, PLANNER_LIMIT_SETTING, PRACTICE, PRACTICE_SETTING, PRACTICE_STEP, RESOLVE, ROLLS, ROLLS_SETTING, plannerLimitMs } from './lean-rpg/names.js';
import { noRoll } from './lean-rpg/noroll.js';
import { RANK_QUERY, SETTINGS_SCHEMA, XP_RATE, XP_RATE_SETTING, rankQuery } from './lean-rpg/levels.js';
import { rosterQueries } from './lean-rpg/roster.js';

let library = null;

/** The loaded RPG library (lean-rpg/index.js's exports), or null while it is not loaded. */
export const rpgLib = () => library;

/** Hands over the library (the loader does; a test host that wants the RPG at once does too). `null` lets it go. */
export function setRpgLib(lib) { library = lib && typeof lib === 'object' ? lib : null; }

// How much longer the pre-call hook may take than the planner's call (the same as lean-rpg/index.js HOOK_MARGIN_MS).
const HOOK_MARGIN_MS = 2000;
export const LAZY_HOOK_MARGIN_MS = HOOK_MARGIN_MS;
// The names join.js and index.js give these (a test holds them equal to the real part's keys).
const JOIN_NO = 'rpg.joinNo';
const JOINS_QUERY = 'rpg.joins';
const ROLLS_QUERY = 'rpg.rolls';
// (`capture.party` is the receipt of a `+ party` line; the guarded block it makes is `dm.join`.)
const GUARD_KINDS = new Set([RESOLVE, FIGHT, PRACTICE_STEP, 'dm.join', 'capture.party']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether the chat (SillyTavern's message array) and its metadata hold anything of the RPG's: a receipt or a guarded block
 * of `rpg.*`, `dm.join` or a `+ party` line on any carrier, or its plan hold / start notes in the metadata. Cheap: one pass over the records' receipts and spans.
 */
export function holdsRpg(chat, metadata = null) {
    try {
        if (isRecord(metadata) && (metadata.rpgPlan != null || isRecord(metadata.storySuite?.rpgStart))) return true;
        for (const message of Array.isArray(chat) ? chat : []) {
            const records = [message?.extra?.storySuite, ...(Array.isArray(message?.swipe_info) ? message.swipe_info.map(info => info?.extra?.storySuite) : [])];
            for (const record of records) {
                if (!isRecord(record)) continue;
                if ((record.receipts ?? []).some(receipt => GUARD_KINDS.has(receipt?.type))) return true;
                if ((record.spans ?? []).some(span => GUARD_KINDS.has(span?.guard?.predicate?.kind))) return true;
            }
        }
    } catch { /* an unreadable chat holds nothing we can name */ }
    return false;
}

/**
 * The loader: `ensure()` → a promise that settles once the library is there when it is needed (never rejects), else undefined.
 *   load()          → the module (default: import('./lean-rpg/index.js'))
 *   featureOn()     → whether the RPG feature is on
 *   chat(), metadata() → the open chat and its metadata
 *   problem(entry)  → the Problems list, for a load that failed (the RPG then stays out of the way: its stored rolls cannot replay until it loads)
 * `ensure({ scan: false })` looks at the feature only (the per-reply check: no pass over the chat).
 */
export function createRpgLoader({ load = () => import('./lean-rpg/index.js'), featureOn = () => false, chat = () => null, metadata = () => null, problem = null } = {}) {
    let pending = null;
    const needed = scan => {
        let on = false;
        try { on = featureOn() === true; } catch { on = false; }
        if (on || !scan) return on;
        let meta = null;
        try { meta = metadata(); } catch { meta = null; }
        let messages = null;
        try { messages = chat(); } catch { messages = null; }
        return holdsRpg(messages, meta);
    };
    // → a promise while the library is being fetched (or is to be), else undefined (nothing to wait for: not a tick on the reply's way).
    function ensure({ scan = true } = {}) {
        if (library) return undefined;
        if (!pending) {
            if (!needed(scan)) return undefined;
            pending = Promise.resolve().then(load).then(lib => { setRpgLib(lib); return library; }).catch(error => {
                pending = null;
                try { problem?.({ module: 'story-block', code: 'RPG_LOAD', message: `The RPG could not be loaded: ${error?.message ?? error}` }); } catch { /* the Problems list is optional */ }
                return null;
            });
        }
        return pending;
    }
    return { ensure, loaded: () => library !== null, needed: ({ scan = true } = {}) => needed(scan) };
}

/**
 * The RPG part's stand-in: the same shape as createLeanRpgPart (lean-rpg/index.js), registered at once. Until the library is
 * there it answers as the part answers with the feature off (nothing to do); a stored roll is never replayed through it, because
 * the loader brings the library in before a chat that holds one is read.
 */
export function createLazyRpgPart(deps = {}) {
    let real = null;
    const part = () => {
        if (!real) { const lib = rpgLib(); if (lib) real = lib.createLeanRpgPart(deps); }
        return real;
    };
    const waiting = ctx => ctx.fail('FAILED', 'The RPG is still loading. Try again in a moment.');
    const run = (name, fallback) => (...args) => { const made = part(); return made ? made.commands[name](...args) : fallback(...args); };
    const timeoutMs = deps?.timeoutMs;
    const plannerValues = () => { try { const values = deps?.plannerValues?.(); return values && typeof values === 'object' ? values : {}; } catch { return {}; } };
    return {
        commands: {
            [BOARD_SKILL]: Object.assign(run(BOARD_SKILL, ctx => waiting(ctx)), { feature: CORE_FEATURE.fightBoard }),
            // (no feature: a rename carries the reader's explicit flags even with the board off)
            [BOARD_SKILL_CARRY]: run(BOARD_SKILL_CARRY, ctx => waiting(ctx)),
            [RESOLVE]: Object.assign(run(RESOLVE, ctx => waiting(ctx)), { prelude: true, internal: true }),
            // (a tiny record with no state, answered at once, the library or not: a stored note replays whatever is loaded)
            [NOROLL]: Object.assign((ctx, payload) => noRoll(ctx, payload), { prelude: true, internal: true }),
            [FIGHT]: Object.assign(run(FIGHT, ctx => waiting(ctx)), { internal: true }),
            [PRACTICE_STEP]: Object.assign(run(PRACTICE_STEP, ctx => waiting(ctx)), { internal: true }),
            // "No" on a companion's card (join.js JOIN_NO): the reader's answer, only while the feature is on.
            [JOIN_NO]: Object.assign(run(JOIN_NO, ctx => waiting(ctx)), { feature: LEAN_RPG_FEATURE }),
        },
        cards: { 'rpg-join': { feature: LEAN_RPG_FEATURE, for: (...args) => part()?.cards['rpg-join'].for(...args) ?? null } },
        queries: {
            [JOINS_QUERY]: Object.assign((...args) => part()?.queries[JOINS_QUERY](...args) ?? [], { feature: LEAN_RPG_FEATURE }),
            [ROLLS_QUERY]: Object.assign((...args) => part()?.queries[ROLLS_QUERY](...args) ?? null, { feature: LEAN_RPG_FEATURE }),
            // (the ranks are a pure read of the packs: answered at once, the library or not)
            [RANK_QUERY]: Object.assign(rankQuery, { feature: LEAN_RPG_FEATURE }),
            // (the roster is a pure read of the Character blocks: answered at once too, roster.js)
            ...rosterQueries({ persona: deps?.persona, on: deps?.rosterOn }),
        },
        hooks: {
            canGenerate: Object.assign((view, info) => part()?.hooks.canGenerate(view, info), { feature: LEAN_RPG_FEATURE }),
            beforeGenerate: Object.defineProperty((view, info) => part()?.hooks.beforeGenerate(view, info), 'timeoutMs', { enumerable: true, get: () => plannerLimitMs(plannerValues(), timeoutMs) + HOOK_MARGIN_MS }),
            afterCapture: (view, info) => part()?.hooks.afterCapture(view, info),
            afterReceive: (view, info) => { part()?.hooks.afterReceive(view, info); },
        },
        settings: { defaults: { [ROLLS_SETTING]: ROLLS[0], [PRACTICE_SETTING]: PRACTICE.perUse, [XP_RATE_SETTING]: XP_RATE.default, [LEVEL_CAP_SETTING]: LEVEL.max, [PLANNER_LIMIT_SETTING]: PLANNER_LIMIT.default }, schema: SETTINGS_SCHEMA },
        guard: (view, info) => { const made = part(); return made ? made.guard(view, info) : { ok: false, reason: 'The RPG is not loaded.' }; },
    };
}
