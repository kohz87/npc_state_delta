// Story Suite v2 evidence, visible part: the entries a record holds, which proofs are visible (visibleProofs, merged) and the
// story.evidence query (createEvidenceQuery). Pure. evidence.js keeps the public path of each export.

import { LIMITS, isObject, whole } from './constants.js';
import { evidenceProblem, pinOf, pinsOf, proofProblem } from './stored.js';
import { isRecordId, spanProblem } from '../replay.js';

const entries = new WeakMap();
// Whether a block could be applied, kept per span object (a record written again keeps the spans it had), so listing the
// proof of a record that grows by one block does not look at every block again.
const checked = new WeakMap();

/**
 * [{ proof, block }] a stored record holds on its blocks, in block order (kept per record). `parts` is the record's
 * blocks as the store replays them ([{ ops, span }], store/memo.js blockParts). Only a block that replay could apply
 * counts: it has changes (an empty span is never replayed), its metadata is whole and is the record's own, and it holds
 * exactly the proof its changes pin. A block that is none of these gives none, whatever its span says.
 */
export function recordEntries(record, parts) {
    let out = entries.get(record);
    if (out) return out;
    out = [];
    const own = record?.source;
    for (const { ops, span } of parts) {
        if (!isObject(span) || typeof span.id !== 'string' || !Array.isArray(span.evidence) || !span.evidence.length) continue;
        let whole = checked.get(span);
        if (whole === undefined) {
            whole = Array.isArray(ops) && ops.length > 0 && !spanProblem(span) && !evidenceProblem(span, ops);
            checked.set(span, whole);
        }
        if (!whole) continue;
        if (!isObject(own) || span.source.sid !== own.logical || span.source.swipeKey !== own.swipeKey || span.source.evidence !== own.evidence) continue;
        for (const proof of span.evidence) out.push(Object.freeze({ proof, block: span.id }));
    }
    Object.freeze(out);
    entries.set(record, out);
    return out;
}

// ---------- what is visible ----------

/** The entries with `pending` (this root's, not stored yet) laid over `stored`: a pending proof shadows a stored one of its id. */
export function merged(stored, pending) {
    if (!pending?.length) return stored;
    const ids = new Set(pending.map(entry => entry.proof.id));
    return [...stored.filter(entry => !ids.has(entry.proof.id)), ...pending];
}

// The proof of a list by id, and the ids given twice, kept for a frozen list (the store's, which is a new one whenever
// anything is written), so asking for an id does not look at every proof.
const indexes = new WeakMap();
export function indexOf(list) {
    const kept = indexes.get(list);
    if (kept) return kept;
    const byId = new Map();
    const twice = new Set();
    for (const { proof } of list) {
        if (!isObject(proof) || typeof proof.id !== 'string') continue;
        if (byId.has(proof.id)) twice.add(proof.id);
        else byId.set(proof.id, proof);
    }
    const index = { byId, twice };
    if (Object.isFrozen(list)) indexes.set(list, index);
    return index;
}

/**
 * The proofs of `list` ([{ proof }], in source order) that are visible on `state`: pinned in its `meta.proofs`
 * with the pin their bytes and parents give, whole, of an owner that owns the kind, given once, and every parent
 * visible too (a cycle is not visible). → Proof[] in the same order. With `only` (a list of ids) just those are
 * looked at, and their parents: the work is theirs, not the whole chat's. `over` ([{ proof }]: this root's, a
 * Re-read's): laid over the list, a proof of the same id shadows the listed one. The walk through parents is a loop,
 * not a recursion, so a chain of any length is read.
 */
export function visibleProofs(state, list, only = null, over = []) {
    const pins = pinsOf(state);
    const base = indexOf(list);
    const top = new Map();
    const twiceTop = new Set();
    for (const { proof } of over) {
        if (!isObject(proof) || typeof proof.id !== 'string') continue;
        if (top.has(proof.id)) twiceTop.add(proof.id);
        else top.set(proof.id, proof);
    }
    const find = id => (top.has(id) ? { proof: top.get(id), twice: twiceTop.has(id) } : { proof: base.byId.get(id), twice: base.twice.has(id) });
    const memo = new Map();
    const visible = start => {
        if (memo.has(start)) return memo.get(start);
        const stack = [{ id: start, proof: null, next: -1 }];
        const onPath = new Set([start]);
        while (stack.length) {
            const frame = stack.at(-1);
            if (frame.next === -1) {
                const { proof, twice } = find(frame.id);
                if (!proof || twice || !Object.hasOwn(pins, frame.id) || proofProblem(proof) || pins[frame.id] !== pinOf(proof, pins)) {
                    memo.set(frame.id, false);
                    onPath.delete(frame.id);
                    stack.pop();
                    continue;
                }
                frame.proof = proof;
                frame.next = 0;
            }
            let ok = true;
            let pushed = false;
            while (frame.next < frame.proof.parents.length) {
                const parent = frame.proof.parents[frame.next];
                if (memo.has(parent)) {
                    if (!memo.get(parent)) { ok = false; break; }
                    frame.next += 1;
                } else if (onPath.has(parent)) {
                    ok = false;     // a cycle
                    break;
                } else {
                    stack.push({ id: parent, proof: null, next: -1 });
                    onPath.add(parent);
                    pushed = true;
                    break;
                }
            }
            if (pushed) continue;
            memo.set(frame.id, ok);
            onPath.delete(frame.id);
            stack.pop();
        }
        return memo.get(start);
    };
    if (only) return only.filter(id => visible(id)).map(id => find(id).proof);
    const all = over.length ? merged(list, over.map(({ proof }) => ({ proof }))) : list;
    return all.map(entry => entry.proof).filter(proof => isObject(proof) && visible(proof.id));
}

/**
 * The `story.evidence` query (contract §6): `({ ids? }) → Proof[]`, the visible proof in source order, or in
 * the order of `ids` (once each) when they are given; unknown ids are left out and malformed arguments give [].
 * `stored()` → the stored entries (store.proofs); inside a command the transaction's own pending proofs come
 * with the query's tools (`tools.pendingProofs`), so a nested command sees them and a public query does not.
 */
export function createEvidenceQuery({ stored = () => [] } = {}) {
    return function storyEvidence(state, args, tools) {
        let ids = null;
        if (args !== undefined) {
            if (!isObject(args) || Object.keys(args).some(key => key !== 'ids')) return [];
            if (args.ids !== undefined) {
                if (!Array.isArray(args.ids) || args.ids.length > LIMITS.ids) return [];
                for (let at = 0; at < args.ids.length; at += 1) if (!(at in args.ids) || !isRecordId(args.ids[at])) return [];
                ids = [...new Set(args.ids)];
            }
        }
        let pending = [];
        try { pending = typeof tools?.pendingProofs === 'function' ? tools.pendingProofs() ?? [] : []; } catch { pending = []; }
        return visibleProofs(state, stored() ?? [], ids, pending);
    };
}
