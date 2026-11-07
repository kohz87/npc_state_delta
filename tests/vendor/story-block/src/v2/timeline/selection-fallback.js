// Head-selection fallback (B group spec 3a): the boundary test shared by the selection plan and the
// fallback chain, the chain itself (matching prefix entries newest first, then the baseline), and the
// read-only walk that verifies candidates before preparing the first usable one. This is only for
// selecting a head. A reader's restore and every save point keep the exact rule and never fall back.
//
// Participant `verify` contract (optional):
//     verify({ checkpoint, hash }) -> { ok: true } | { ok: false, code, message }
// It reads the checkpoint file, checks that its bytes hash to `hash` and that it belongs to this
// chat's lineage, and changes nothing: it does not install, prepare, select, or write state, the
// journal, or the vault. A missing file is SNAPSHOT_UNAVAILABLE; another lineage is CONFLICT. A
// participant with no verify is walked with prepare itself; a prepare that fails changes nothing.
//
// The chain is a pure read of the archive and the current chat. The same journal and chat give the
// same chain, in the same order: there is no clock, randomness, or mutation-time ordering. Ties use
// the archive's sequence, exactly as the selection plan does.

import { stateHash } from './host-block.js';

export const FALLBACK_CODES = Object.freeze(['SNAPSHOT_UNAVAILABLE', 'CONFLICT']);

/** Is `code` a permanent failure the fallback may walk past? */
export const canFallback = code => FALLBACK_CODES.includes(code);

/**
 * The one boundary test: a mapping matches only when its cursor still names a uniquely witnessed
 * prefix, that prefix hash is the same, and the replayed state is the same. `through` is an optional
 * witness limit (the marker root), as in `selectionPlan`.
 */
export function boundaryMatches(mapping, witness, { through = null, stateHashOf = stateHash } = {}) {
    if (!mapping?.boundary || !mapping.after || !witness) return false;
    if (through && !(witness.index < through.index || (witness.index === through.index && witness.op <= through.op))) return false;
    return witness.prefixHash === mapping.boundary.prefixHash && stateHashOf(witness.state) === mapping.boundary.stateHash;
}

const oldestFirst = (a, b) => a.index - b.index || a.op - b.op || a.mapping.seq - b.mapping.seq;
const targetOf = value => ({ module: value.module, checkpoint: value.checkpoint, hash: value.hash, schema: value.schema });
const sameTarget = (from, candidate) => !!from && (typeof from === 'string' ? from === candidate.checkpoint
    : from.checkpoint === candidate.checkpoint && (from.hash === undefined || from.hash === candidate.hash));

/**
 * `createSelectionFallback({ archive, store, witnessStateHash })` closes over the timeline's archive
 * and store. It returns:
 *   - `fallbackChain(module, limit?)`: matching targets newest first, then `archive.baseline()[module]`;
 *   - `walkSelectionFallback(module, options)`: the verify-then-prepare walk (below).
 * `witnessStateHash` is the selection plan's memoising hasher when the coordinator supplies one.
 */
export function createSelectionFallback({ archive, store, witnessStateHash = stateHash }) {
    function fallbackChain(module, limit = null) {
        if (!archive.exists()) return [];
        return (store.witnessScope ?? (read => read()))(() => {
            const through = limit ? store.prefixWitness(limit) : null;
            if (limit && !through) throw new Error('The marker root no longer has a unique prefix.');
            const candidates = [];
            for (const mapping of archive.prefixes(module)) {
                if (!mapping.boundary || !mapping.after) continue;
                const witness = store.prefixWitness(mapping.boundary.cursor);
                if (boundaryMatches(mapping, witness, { through, stateHashOf: witnessStateHash })) {
                    candidates.push({ mapping, index: witness.index, op: witness.op });
                }
            }
            candidates.sort(oldestFirst);
            candidates.reverse();
            const chain = candidates.map(({ mapping, index, op }) => ({
                ...mapping.after, module, source: 'prefix', index, op, seq: mapping.seq,
            }));
            const baseline = archive.baseline()[module];
            if (baseline) chain.push({ ...baseline, module, source: 'baseline', index: null, op: null, seq: null });
            return chain;
        });
    }

    /**
     * Walk the chain from newest to oldest, skipping `from` (the head target whose prepare failed).
     * With `verify`, each candidate is read-only checked first; the first that verifies is prepared.
     * Without `verify`, prepare is the check. A successful prepare returns
     * `{ ok: true, target, prepared, fell }`, where `fell` is exactly
     * `{ module, from, to, replies }`; `replies` is the number of later chat replies when `headIndex`
     * is given, else null. A permanent candidate failure walks on. Any other failure is returned at
     * once. If nothing works, `failure` (the original prepare failure) is returned unchanged, as the
     * block stays today. Nothing here installs a checkpoint.
     */
    async function walkSelectionFallback(module, { from = null, headIndex = null, countReplies = null, verify = null, prepare, failure = null, chain = fallbackChain(module) } = {}) {
        if (typeof prepare !== 'function') throw new TypeError('walkSelectionFallback needs a prepare callback.');
        const tried = [];
        // The selected point may have left the current head while its prepare was waiting. Do not
        // mistake a newer point on the changed head for an earlier fallback in that case.
        const start = from ? chain.findIndex(target => sameTarget(from, target)) : -1;
        // (the head moved: the unfinished selection is planned again by the caller, not blocked for good)
        if (from && start < 0) return { ok: false, code: 'STALE', replan: true, message: 'The selected point is no longer on this head.' };
        for (const target of chain.slice(start + 1)) {
            if (sameTarget(from, target)) continue;
            if (from && target.schema !== from.schema) continue;
            const attempt = { checkpoint: target.checkpoint, hash: target.hash };
            tried.push(attempt);
            if (typeof verify === 'function') {
                const answer = await verify({ checkpoint: target.checkpoint, hash: target.hash });
                if (answer?.ok !== true) {
                    attempt.code = answer?.code ?? 'FAILED';
                    if (!canFallback(attempt.code)) return { ...answer, ok: false, code: attempt.code, target, tried };
                    continue;
                }
            }
            const prepared = await prepare({ checkpoint: target.checkpoint, hash: target.hash });
            if (prepared?.ok !== true) {
                attempt.code = prepared?.code ?? 'FAILED';
                if (!canFallback(attempt.code)) return { ...prepared, target, tried };
                continue;
            }
            if (prepared.hash !== target.hash) {
                return { ok: false, code: 'CONFLICT', message: 'The participant prepared other selected bytes.', target, tried };
            }
            const replies = countReplies ? countReplies(target.index) : (Number.isInteger(headIndex) && Number.isInteger(target.index)
                ? Math.max(0, headIndex - target.index) : null);
            return { ok: true, target, prepared, tried, fell: { module, from: from ? targetOf(from) : null, to: targetOf(target), replies } };
        }
        return failure ?? { ok: false, code: 'SNAPSHOT_UNAVAILABLE', message: 'No earlier saved point could be checked.', tried };
    }

    return { fallbackChain, walkSelectionFallback };
}

/**
 * The plan with the modules that fell put back the way the journal settled them. A completed selection that recorded
 * `fell: { module, from, to }` stood on `to` because `from` could not be prepared; while the plan still names `from` and the
 * selection holds `to`, that is settled, not a new selection to make (otherwise every look would try `from` again).
 */
export function settledPlan(plan, selection, entries) {
    let result = plan;
    for (const entry of entries) {
        // A module whose dossiers were started again from the chat has no selected checkpoint until it publishes the new one: the old plan is not a selection to make.
        if (entry.kind === 'selection' && entry.phase === 'rebuilt') {
            for (const [module, slot] of Object.entries(entry.slots ?? {})) {
                if (slot?.rebuilt === true && !selection[module] && result[module]) { result = { ...result }; delete result[module]; }
            }
            continue;
        }
        if (entry.kind !== 'selection' || entry.phase !== 'complete') continue;
        for (const fell of [].concat(entry.fell ?? [], entry.fellOthers ?? [])) {
            const { module, from, to } = fell;
            const wanted = plan[module];
            const held = selection[module];
            if (from && to && wanted?.checkpoint === from.checkpoint && wanted.hash === from.hash && held?.checkpoint === to.checkpoint && held.hash === to.hash) {
                result = { ...result, [module]: held };
            }
        }
    }
    return result;
}

/** The sentence the reader sees after a fallback (the approved wording). `index` is the reply the point stands at, or null for the baseline. */
export function fellNotice(label, { index, replies }) {
    const where = Number.isInteger(index) ? `reply ${index}` : 'the start of the chat';
    const later = Number.isInteger(replies) ? `${replies} later ${replies === 1 ? 'change is' : 'changes are'}` : 'Later changes are';
    return `${label} were restored to the nearest saved point (${where}). ${later} being read again from the chat.`;
}
