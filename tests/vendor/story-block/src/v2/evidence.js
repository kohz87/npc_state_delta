// Story Suite v2: proof and evidence (docs/v2/EVIDENCE.md, contract §6 "Proof submission" and "story.evidence").
//
// A module that owns a kind of proof (Story Director: visit, acceptance, event) calls `ctx.proof({ kind, payload, parents? })` inside a command. The host checks who is asking, what
// the payload is and what the reader really said, stamps the id, the Source and the payload hash, keeps the
// proof on the span of the block the command makes (`span.evidence`) and pins it in the state
// (`meta.proofs[id]`, written by the same ops as the block). The pin is what makes a proof ACTIVE: a block
// that does not apply, a reply that was deleted or a swipe that is not shown leave no pin, so the proof is
// not there. `story.evidence` shows a proof only while its bytes still match its pin, its owner and kind
// still match the table below, its payload is still closed and well formed, and every parent is visible too.
//
// This file is pure: it reads no chat and no registry. The command bus (commands.js) calls `submitProof`, the
// store (store.js) calls `recordEntries` and `evidenceProblem`, and `createEvidenceQuery` is the query the
// core module registers.

import { isObject, occurrenceOf, whole } from './evidence/constants.js';
import { hashJson } from './replay.js';

/**
 * What a root is, apart from where it stands in the reply: its command and, for a story line, the line as written (the same
 * thing store.js calls a line's key). Two blocks of one reply that did the same thing are told apart by their rank among them.
 */
export function operationKey(type, payload) {
    return hashJson({ type, line: typeof payload?.raw === 'string' ? payload.raw : payload ?? {} });
}

// ---------- occurrence ----------
//
// Two blocks of one reply that did exactly the same (two lines with the same text, two steps with the same command and payload) are told
// apart by their occurrence: a whole number given to a block once, when it is first stamped, kept in its span (`span.occurrence`) and
// never worked out again. A step planned again, a reconcile, a Re-read of text that did not change and a rebuild all use the one the
// block has, so an earlier block that goes cannot move the later ones onto its identity. A new block takes the next number nobody
// has used in that reply (`record.source.taken`, kept past the blocks that go, and the numbers of the blocks that stand). A block that
// gives proof and has no number was written by a build before proof was released: it is not supported (evidenceProblem) and fails closed.

/** The key a span's operation has (operationKey), or null. */
export function spanOperationKey(span) {
    try { return isObject(span?.operation) ? operationKey(span.operation.type, span.operation.payload) : null; } catch { return null; }
}

const takenKey = key => key.slice(0, 16);

/** `entry` (a record's source) with the occurrences of `spans` taken: undefined when none ever was (a store with no guarded block stays as it was). */
export function takenAfter(entry, spans) {
    const out = isObject(entry?.taken) ? { ...entry.taken } : {};
    for (const span of spans) {
        const at = occurrenceOf(span);
        const key = at === null ? null : spanOperationKey(span);
        if (key) out[takenKey(key)] = Math.max(whole(out[takenKey(key)]) ?? 0, at + 1);
    }
    return Object.keys(out).length ? out : undefined;
}

/** The next occurrence nobody has used in `record` (the reply) for the operation `key`. */
export function nextOccurrence(record, key) {
    let next = whole(record?.source?.taken?.[takenKey(key)]) ?? 0;
    for (const span of Array.isArray(record?.spans) ? record.spans : []) {
        if (!isObject(span) || spanOperationKey(span) !== key) continue;
        const at = occurrenceOf(span);
        if (at !== null) next = Math.max(next, at + 1);
    }
    return next;
}

/**
 * The one place a new occurrence is allocated. A plan (a Re-read, a reconcile of a record) works on one allocator per record: it starts from
 * what the record holds (`nextOccurrence`: `record.source.taken` and the numbers of the blocks that stand, `also(key)`: numbers the plan has
 * given in blocks not stored yet) and moves on after each number it gives, so two blocks of one plan never take the same one. Nothing is
 * kept in the record until the plan is stored (the span's `occurrence` and `takenAfter` do that).
 * → { peek(key), note(key, value), take(key) }: the next number for an operation, a number used, and both.
 */
export function allocator(record, also = () => 0) {
    const given = new Map();
    const peek = key => Math.max(nextOccurrence(record, key), also(key), given.get(key) ?? 0);
    const note = (key, value) => given.set(key, Math.max(given.get(key) ?? 0, value + 1));
    return { peek, note, take(key) { const value = peek(key); note(key, value); return value; } };
}

// The supported guarded spans a Re-read gives again, in record order. Old proofless spans have an id but no occurrence.
function regeneratedSpans(record) {
    const spans = Array.isArray(record?.spans) ? record.spans : [];
    const receipts = Array.isArray(record?.receipts) ? record.receipts : [];
    const out = new Map();
    let at = 0;
    for (const span of spans) {
        const ops = Array.isArray(record?.ops) && Number.isInteger(span?.n) ? record.ops.slice(at, at + span.n) : [];
        at += Number.isInteger(span?.n) ? span.n : 0;
        if (!isObject(span) || typeof span.id !== 'string') continue;
        const key = occurrenceOf(span) !== null || !span.evidence?.length ? spanOperationKey(span) : null;
        if (!key) continue;
        const rev = [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
        const step = !!span.replan && receipts.some(receipt => receipt?.rev === rev && receipt?.afterCapture === true);
        if (span.story !== true && !step) continue;
        (out.get(key) ?? out.set(key, []).get(key)).push(span);
    }
    return out;
}

/**
 * The occurrences for the blocks a Re-read of `record` plans. For an operation whose blocks are as many as before, the k-th block that is
 * given again takes the k-th number of the blocks of that operation it replaces (an unchanged Re-read gives every block its own). When
 * the number of blocks of an operation goes up or down, which old block each new one stands for is not known, so none of that
 * operation's old numbers is given again (`retire`, found with `ambiguous` after a first plan): every block of it takes a number
 * nobody has used, every old proof id of it is retired and what was built on them is hidden. A block with none to take back also takes
 * the next unused one. `peek(key)` → the number the next block of that operation would take; `commit(key, value)` once it was planned;
 * `span(key)` → the stored identity to reuse (including old proofless spans without an occurrence);
 * `ambiguous(planned)` → the operations (keys) whose block count differs from the one it replaces.
 */
export function reusePlan(record, retire = new Set()) {
    const pool = regeneratedSpans(record);
    const used = new Map();
    const fresh = allocator(record);
    const span = key => (retire.has(key) ? null : pool.get(key)?.[used.get(key) ?? 0] ?? null);
    return {
        span,
        peek(key) {
            return occurrenceOf(span(key)) ?? fresh.peek(key);
        },
        commit(key, value) {
            used.set(key, (used.get(key) ?? 0) + 1);
            if (whole(value) !== null) fresh.note(key, value);
        },
        ambiguous(planned) {
            const counts = new Map();
            for (const piece of planned) {
                const block = piece?.block;
                if (!isObject(block?.operation)) continue;
                let key = null;
                try { key = operationKey(block.operation.type, block.operation.payload); } catch { key = null; }
                if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return [...counts].filter(([key, count]) => !retire.has(key) && pool.has(key) && pool.get(key).length !== count).map(([key]) => key);
        },
    };
}

/**
 * The proof of the blocks of a record that a Re-read regenerates (its story lines and its planned steps), in record order. A
 * block regenerated by a Re-read may hold these ids again (its own and nobody else's); an id any other block holds is not
 * given to it (see submitProof).
 */
export function replacedProofs(record) {
    const out = [];
    for (const span of Array.isArray(record?.spans) ? record.spans : []) {
        if (!isObject(span) || typeof span.id !== 'string' || !(span.story === true || span.replan)) continue;
        for (const proof of Array.isArray(span.evidence) ? span.evidence : []) if (isObject(proof)) out.push(proof);
    }
    return out;
}

export { OWNERS, KINDS, STATS, LIMITS, occurrenceOf } from './evidence/constants.js';
export { payloadProblem, payloadKey, sentences, intentProblem } from './evidence/payloads.js';
export { proofProblem, pinOf, evidenceDigest, receiptEvidence, proofPins, pinOps, reachesBranch, touchesProof, proofWriteProblem, opShapeProblem, evidenceProblem } from './evidence/stored.js';
export { recordEntries, merged, visibleProofs, createEvidenceQuery } from './evidence/visible.js';
export { newRoot, submitProof } from './evidence/submit.js';
