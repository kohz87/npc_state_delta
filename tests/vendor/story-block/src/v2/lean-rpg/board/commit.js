// Commits staged board choices as the reply's one guarded RPG resolution.
// The engine replays the recorded setup and seed; only the resulting bars and gear wear are written.
// Its guard checks the recorded input against the prefix on delete, rewind and reload.

import { condWord } from '../../domains/gear.js';
import { hashJson } from '../../replay.js';
import { applyGear, earnedLegend, gearMatches, gearValid, wearGear } from '../gear.js';
import { LV_VERSION, PRACTICE, RESOLVE, practiceOf } from '../names.js';
import { readSheet } from '../read.js';
import { hasLevels, normalizeRules } from '../rules.js';
import { applyHurts, boardWitness, playBoard } from './engine.js';
import { settledNote } from './note.js';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keyPattern = /^(?:\d{1,7}-[0-9a-z]{1,7}|b:[^\s]{1,400})$/u;
const claim = (key, sid) => `rpg:resolve:${key}${key.startsWith('b:') && sid ? `:reply:${sid}` : ''}`;
const shape = board => isObject(board) && isObject(board.setup) && Array.isArray(board.exchanges) && board.exchanges.length <= 99
    && typeof board.id === 'string' && board.id.length > 0 && board.id.length <= 120
    && Array.isArray(board.groups) && board.groups.length > 0 && board.groups.length <= 64
    && board.groups.every(slot => Number.isInteger(slot) && slot >= 1 && slot <= 64)
    && (board.setup.bars === undefined || board.setup.bars === 2)
    && (board.setup.foesSix === undefined || (board.setup.foesSix === 1 && board.setup.members === 1))
    && (board.setup.areaAll === undefined || (board.setup.areaAll === 1 && board.setup.aoe === 1))
    && (board.setup.soak === undefined || (board.setup.soak === 1 && board.setup.bars === 2))
    && (board.setup.witness === undefined ? board.exchanges.length === 0
        : isObject(board.setup.witness) && board.setup.witness.offset === board.setup.offset && /^[0-9a-f]{64}$/u.test(board.setup.witness.hash));
// The guard's input witness. Records made before this hashed the whole dataModules domain, other replies' `perReply` scratch included,
// so deleting an earlier reply could drop a later fight. New records hash the domain with `perReply` emptied (the key stays, so a domain
// with no scratch hashes exactly as before and nothing stored changes). A guard verifies against either form: an old record keeps its old
// witness and replays unchanged, a new one ignores other replies' scratch.
const domainOf = state => state?.domains?.dataModules ?? null;
const witnessOld = state => ({ dataModules: domainOf(state) });
const witnessNew = state => { const domain = domainOf(state); return { dataModules: domain && typeof domain === 'object' && 'perReply' in domain ? { ...domain, perReply: {} } : domain }; };
const witness = witnessNew;
const startState = ctx => ({ domains: { dataModules: ctx.read('dataModules'), inventory: ctx.read('inventory'), scene: ctx.read('scene') } });

/** Check a pending segment before generation, using the same rules as the resolver. */
export function boardInputError(state, board) {
    try {
        if (!shape(board) || hashJson(normalizeRules(board.setup.rules)) !== hashJson(board.setup.rules)) return 'The saved fight is damaged. Discard the fight (Fight tab, Discard fight) to continue.';
        if (board.setup.witness && board.setup.witness.hash !== boardWitness(state, board.setup)) return 'The sheet or gear changed after the fight was rolled. Restore it or discard the fight (Fight tab, Discard fight).';
        if (board.setup.gear && (!gearValid(board.setup.gear) || !gearMatches(state, board.setup.gear, hashJson))) return 'The gear changed after the fight was rolled. Restore it or discard the fight (Fight tab, Discard fight).';
        return playBoard(state, board.setup, board.exchanges).error ?? null;
    } catch { return 'The saved fight is damaged. Discard the fight (Fight tab, Discard fight) to continue.'; }
}

/** Resolve a board payload only on the system prelude path. */
export function resolveBoard(ctx, payload) {
    const key = String(payload?.key ?? ''), board = payload?.board;
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'The fight is settled before the reply.');
    if (!keyPattern.test(key) || !shape(board)) ctx.fail('INVALID', 'The saved fight is damaged.');
    const rules = normalizeRules(board.setup.rules);
    if (ctx.hash(rules) !== ctx.hash(board.setup.rules)) ctx.fail('INVALID', 'The fight rules are damaged.');
    const state = startState(ctx), gear = board.setup.gear;
    if (board.setup.witness && board.setup.witness.hash !== boardWitness(state, board.setup)) ctx.fail('NO_LONGER_DONE', 'The sheet or gear changed after the fight was rolled. Restore it or discard the fight (Fight tab, Discard fight).');
    if (gear && (!gearValid(gear) || !gearMatches(state, gear, ctx.hash))) ctx.fail('NO_LONGER_DONE', 'The gear changed since this fight was opened.');
    const played = playBoard(state, board.setup, board.exchanges);
    if (played.error) ctx.fail('NO_LONGER_DONE', played.error);
    const claimId = claim(key, ctx.reply?.sid);
    if (!ctx.claim(claimId)) ctx.fail('CLAIMED', 'This message has already been rolled for.');
    const base = played.result, practice = practiceOf(payload.practice) ?? PRACTICE.perUse;
    const result = { v: 1, key, pace: 'careful', rules, flow: 2, fix: 3, practice, ...(hasLevels(rules) ? { lv: LV_VERSION } : {}),
        ...(gear ? { gear } : {}), checks: structuredClone(board.setup.approach ?? []), ...base,
        board: { id: board.id, seed: board.setup.seed, offset: board.setup.offset, groups: board.groups } };
    if (gear) {
        const wear = wearGear(ctx, gear, { opening: result.opening, rounds: result.rounds, rules, condWord });
        if (ctx.hash(wear) !== ctx.hash(result.wear ?? [])) ctx.fail('NO_LONGER_DONE', 'The gear wear changed. Restore the gear or discard the fight (Fight tab, Discard fight).');
        if (wear.length) result.wear = wear;
        if (earnedLegend(result, applyGear(readSheet(state), gear), hasLevels(rules))) result.legend = 1;
    }
    const predicate = { kind: RESOLVE, board: 1, key, setup: ctx.hash(board), rules: ctx.hash(rules), practice, ...(board.setup.bars === 2 ? { bars: 2 } : {}), ...(board.setup.soak === 1 ? { soak: 1 } : {}) };
    ctx.replayGuard({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate,
        inputHash: ctx.hash({ source: ctx.source, predicate, witness: witness(state) }) }, { key, board, practice });
    if (result.hurts.length) applyHurts(ctx.draft('dataModules'), result.hurts);
    return { summary: settledNote(result, board.setup), narrate: true, replan: true, data: { v2: { key: claimId, result } } };
}

/** The prefix witness for a board roll. Changed inputs cause the host to plan it again. */
export function boardGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    try {
        const predicate = guard?.predicate, board = recorded?.board;
        if (guard?.version !== 2 || guard.rulesHash !== null || predicate?.kind !== RESOLVE || predicate?.board !== 1
            || !shape(board) || recorded.key !== predicate.key || hash(board) !== predicate.setup || hash(normalizeRules(board.setup.rules)) !== predicate.rules
            || recorded.practice !== predicate.practice || (board.setup.bars === 2 ? 2 : undefined) !== predicate.bars || (board.setup.soak === 1 ? 1 : undefined) !== predicate.soak || practiceOf(recorded.practice) === null) return bad('The saved fight is damaged.');
        if (board.setup.gear && (!gearValid(board.setup.gear) || !gearMatches(state, board.setup.gear, hash))) return bad('The gear before the fight changed.');
        if (board.setup.witness && board.setup.witness.hash !== boardWitness(state, board.setup)) return bad('The sheet or gear before the fight changed.');
        return [witnessNew, witnessOld].some(make => hash({ source, predicate, witness: make(state) }) === guard.inputHash) ? { ok: true } : bad('The sheet before the fight changed.');
    } catch { return bad('The saved fight is damaged.'); }
}
