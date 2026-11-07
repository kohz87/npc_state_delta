// Story Suite v2: the store's Re-read and reconcile writes: replaceStory (a carrier's story receipts and ops replaced,
// its kept blocks replayed in place, later carriers walked on top) and reconcile (guarded replan steps planned again).
// Moved out of createWrite unchanged; createWrite puts them in api at the places they were.

import { isObject, revOf, NO_LONGER_DONE, readerSetup } from '../constants.js';
import { allocator, occurrenceOf, spanOperationKey } from '../../evidence.js';
import { isMetaSpan } from '../../replay.js';

export function createReplace(s, deps) {
    const { advanced, asOps, baseFor, carrierAt, forgetMemos, guardHolds, intactReason, isGuardedBlock, list, ORPHAN, ownedAlready, publish, quarantined, receiptsFor, receiptsOf, replay, replayGuarded, replayLegacy, rerunBlock, saver, skipped, spansOf, stamp, stateBefore, step, take, walkSuffix, withSource, writable, write } = deps;

    return {
        // Re-read: the carrier's `story` receipts and their ops are replaced; ui and system receipts stay,
        // after the new story ops. A kept block whose rev (its `/meta/rev` op and its receipt) is not after
        // the new story ops' last one is numbered on from it, so no two receipts on the carrier share one.
        // A kept system step marked `replan` (its receipt's `replan: { payload }`, B-a1-13: planned from the
        // story state, like a story-time heal) is not applied again as it was: `rerun(state, receipt, { index,
        // span })` runs it again on the state as it now stands at its place (→ { ok, ops, receipt, block? });
        // when it is not done, its block goes. `settled` ([{ ops, receipt, block? }], system steps; SPEC §4.2
        // step 3): the reply's afterCapture steps as the Re-read ran them again after the new story lines.
        // They take the place of the kept blocks whose receipt is marked `afterCapture` and go right after
        // the new story ops, before the reader's actions; without `settled` such a block is kept as any other
        // system step. `blocks` ([{ n, block?, receipt }], one per story line, `n` its ops): what the lines'
        // guarded transactions handed over (REPLAY.md), so each of them is stored as a block of its own.
        // The kept blocks are replayed as a rebuild replays them (step with `replayed: true`): a guarded one
        // whose guard no longer holds stays stored and inactive instead of stopping the Re-read.
        // Later carriers are replayed on top so their checkpoints stay true (and their guarded system blocks
        // that carry a `replan` are planned again with `rerun`, REPLAY.md "Reconciling"); if any later change
        // no longer applies, nothing is written and this throws.
        replaceStory(index, { ops, receipts = [], rerun = null, settled = null, blocks: lines = null } = {}) {
            writable();
            const arr = list();
            const message = carrierAt(arr, index);
            if (!Array.isArray(receipts) || receipts.some(receipt => !isObject(receipt) || (receipt.cause !== 'story' && !(receipt.cause === 'system' && receipt.beforeGenerate === true)))) {
                throw new TypeError('Re-read takes story receipts and generated-reply preludes only.');
            }
            if (settled !== null && (!Array.isArray(settled) || settled.some(ran => !isObject(ran?.receipt) || ran.receipt.cause !== 'system'))) {
                throw new TypeError('Re-read\'s afterCapture steps are system steps, each { ops, receipt }.');
            }
            const before = stateBefore(arr, index);
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const taken = take(arr, index, before).record;
            const record = withSource(message, taken);
            const spans = spansOf(record);
            if (!spans) throw new Error('The story changes on this reply cannot be told apart from the others.');
            // The kept blocks, each with its receipt when they line up one to one (every append stores one).
            const blocks = [];
            let at = 0;
            for (const span of spans) {
                if (!span.story) blocks.push({ ops: record.ops.slice(at, at + span.n), span });
                at += span.n;
            }
            let keptReceipts = record.receipts.filter(receipt => receipt?.cause !== 'story').map(receipt => structuredClone(receipt));
            // A quarantined record applies nothing and is not rewritten: decided on the record as stored, before the story
            // receipts are filtered out or anything is renumbered.
            if (quarantined(record)) throw new Error(`This reply's story record is kept as it is and not read again: ${ORPHAN}.`);
            const paired = keptReceipts.length === blocks.length;
            // The old afterCapture steps go when the Re-read ran them again (only told apart one to one).
            const resettle = Array.isArray(settled) && paired;
            if (resettle) {
                for (let n = blocks.length - 1; n >= 0; n -= 1) {
                    if (keptReceipts[n]?.afterCapture !== true) continue;
                    blocks.splice(n, 1);
                    keptReceipts.splice(n, 1);
                }
            }
            const fresh = asOps(ops);
            let state;
            const fail = error => new Error(`The new story changes and this reply's other changes do not fit together: ${error?.message ?? error}`);
            try {
                state = step(base, fresh);
            } catch (error) {
                throw fail(error);
            }
            // The kept blocks' revs follow the new story ops' last one (they ran after the old ones).
            let rev = [...fresh].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value ?? revOf(base);
            const nextOps = [...fresh];
            const nextReceipts = [];
            const nextParts = [];     // [{ ops, span }] of the record being built, for the boundaries' prefix hashes
            // (the occurrences the blocks built so far hold, so a kept step that starts giving proof takes one nobody has)
            const keptAlloc = allocator(record, key => nextParts.reduce((most, part) => (occurrenceOf(part.span) !== null && spanOperationKey(part.span) === key ? Math.max(most, occurrenceOf(part.span) + 1) : most), 0));
            const storySpans = [];
            // The new story lines: each guarded one a block of its own, the others together as one (as before).
            const replacedIds = new Set(spans.filter(span => span.story && isMetaSpan(span)).map(span => span.id));
            const pieces = Array.isArray(lines) && lines.length && lines.every(piece => Number.isInteger(piece?.n) && piece.n >= 0)
                && lines.reduce((sum, piece) => sum + piece.n, 0) === fresh.length && lines.some(piece => piece.block || piece.receipt?.beforeGenerate === true) ? lines : null;
            if (pieces) {
                let offset = 0;
                let upTo = base;         // the state before the piece
                for (const piece of pieces) {
                    const own = fresh.slice(offset, offset + piece.n);
                    const story = piece.receipt?.beforeGenerate !== true;
                    if (piece.block) {
                        let span;
                        try {
                            span = { n: piece.n, story, ...stamp(arr, index, record, piece.block, own, piece.receipt, nextParts, offset) };
                            guardHolds(upTo, span, message);
                        } catch (error) {
                            throw fail(error);
                        }
                        publish(span, index);     // the lines applied to the state before this point
                        storySpans.push(span);
                        nextParts.push({ ops: own, span });
                    } else if (storySpans.length && storySpans.at(-1).story === story && !isMetaSpan(storySpans.at(-1))) {
                        storySpans.at(-1).n += piece.n;
                        nextParts.at(-1).ops = [...nextParts.at(-1).ops, ...own];
                    } else {
                        const span = { n: piece.n, story };
                        storySpans.push(span);
                        nextParts.push({ ops: own, span });
                    }
                    upTo = step(upTo, own);
                    offset += piece.n;
                }
            } else {
                const span = { n: fresh.length, story: true };
                storySpans.push(span);
                nextParts.push({ ops: fresh, span });
            }
            const keptSpans = [];
            const keptProblems = [];       // this reply's blocks that stay off (the checkpoints after it carry them)
            const moved = new Map();
            // The afterCapture steps run again, right after the new story ops (their revs follow them).
            for (const ran of resettle ? settled : []) {
                const blockOps = asOps(ran.ops);
                const before = state;
                try {
                    state = step(state, blockOps);
                } catch (error) {
                    throw fail(error);
                }
                const own = [...blockOps].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
                if (Number.isInteger(own)) rev = Math.max(rev, own);
                let span = { n: blockOps.length, story: false };
                if (ran.block) {
                    try {
                        span = { ...span, ...stamp(arr, index, record, ran.block, blockOps, ran.receipt, nextParts, nextOps.length) };
                        guardHolds(before, span, message);
                        publish(span, index);     // applied (step above)
                    } catch (error) {
                        throw fail(error);
                    }
                }
                nextOps.push(...blockOps);
                keptSpans.push(span);
                nextParts.push({ ops: blockOps, span });
                nextReceipts.push(structuredClone(ran.receipt));
            }
            for (const [n, { ops: block, span: was }] of blocks.entries()) {
                const receipt = paired ? keptReceipts[n] : null;
                // A reply-bound block goes when its reply is read again, its receipt with it (as a delete or a swipe takes it);
                // what was built on it is replayed below without it. The reader's own chat-block setup stays (readerSetup).
                if (was.guard?.replyBound === true && !readerSetup(was, paired ? (receipt ? [receipt] : []) : receiptsFor({ receipts: keptReceipts }, block))) {
                    if (!paired) for (const gone of receiptsFor({ receipts: keptReceipts }, block)) keptReceipts.splice(keptReceipts.indexOf(gone), 1);
                    continue;
                }
                let blockOps;
                let kept = receipt;
                let again = null;      // the block as planned again, when it was
                const asks = typeof rerun === 'function' && !(isMetaSpan(was) && intactReason(record, block, was, receipt)) && ((isMetaSpan(was) && was.guard && was.replan && receipt) || (receipt?.replan && !isGuardedBlock(was, paired ? receipt : receiptsFor({ receipts: keptReceipts }, block))));
                if (asks) {
                    let out = null;
                    try { out = rerunBlock(rerun, state, receipt, index, was, nextParts, keptAlloc); } catch { out = null; }
                    // A guarded step goes only when its owner says it is no longer done; when it cannot be asked it stays.
                    if (!out?.ok && isMetaSpan(was) && !(out?.ok === false && out.code === NO_LONGER_DONE)) {
                        // (it could not be asked: the block stays exactly as it was, replayed below as any kept block is)
                    } else if (!out?.ok) continue;
                    else if (ownedAlready(state, out.block?.evidence)) {
                        // (it would give a proof id a block that applied already owns: refused; the block stays as it was, replayed below)
                    } else {
                        again = out;
                        blockOps = asOps(out.ops);
                        kept = { ...structuredClone(out.receipt), id: receipt.id, ...(receipt.beforeGenerate === true ? { beforeGenerate: true } : {}) };
                        const own = [...blockOps].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
                        if (Number.isInteger(own)) rev = Math.max(rev, own);
                    }
                }
                if (!again) {
                    blockOps = block.map(op => {
                        if (op?.path !== '/meta/rev' || !Number.isInteger(op.value)) return op;
                        if (op.value > rev) {
                            rev = op.value;   // already after the new story ops: kept as it is
                            return op;
                        }
                        rev += 1;
                        moved.set(op.value, rev);
                        return { ...op, value: rev };
                    });
                }
                // A kept guarded block is asked again here (its guard may not hold on the new story): then
                // it stays stored and inactive. A block planned again is applied as a live command is.
                const meta = isMetaSpan(was);
                const heldBy = state;     // the state before this block
                const guarded = isGuardedBlock(was, paired ? receipt : receiptsFor({ receipts: keptReceipts }, block));       // (the one classifier: a stripped span is still a guarded block)
                let applied = true;      // the block applied: only then is its proof the guards' to see
                try {
                    state = again ? step(state, blockOps) : guarded ? replayGuarded(state, record, blockOps, was, message, receipt) : replayLegacy(state, blockOps);
                } catch (error) {
                    if (!guarded || again) throw fail(error);
                    applied = false;
                    state = skipped(state, blockOps);
                    keptProblems.push({ index, block: storySpans.filter(each => each.n).length + keptSpans.filter(each => each.n).length, receipts: receiptsOf({ receipts: keptReceipts }, block), why: String(error?.message ?? error), code: 'REPLAY_PREREQUISITE' });
                }
                let span = { n: blockOps.length, story: false };
                try {
                    if (again?.block) {
                        span = { ...span, ...stamp(arr, index, record, { ...again.block, ...(meta ? { id: was.id, source: { ...again.block.source, ordinal: was.source.ordinal } } : {}) }, blockOps, kept, nextParts, nextOps.length) };
                        guardHolds(heldBy, span, message);
                    } else if (meta && !again) {
                        if (intactReason(record, block, was, receipt)) {
                            // Not intact (damaged, another reply's, claims that are not its changes'): it stays exactly as stored, inactive.
                            span = { ...was, n: blockOps.length };
                        } else {
                            // A Re-read moves a kept block's position and nothing else: its cursor and prefix hash follow where it stands now,
                            // but its payload hash, evidence, claims, guard, source and results are the ones it was stored with.
                            const placed = stamp(arr, index, record, { module: was.module, source: was.source, guard: was.guard, operation: was.operation, recorded: was.recorded, result: was.result, evidence: was.evidence, occurrence: was.occurrence, id: was.id }, blockOps, kept, nextParts, nextOps.length);
                            span = { ...was, n: blockOps.length, story: false,
                                boundaries: was.boundaries.map((boundary, at) => (at === 0 ? { ...boundary, cursor: placed.boundaries[0].cursor, prefixHash: placed.boundaries[0].prefixHash } : boundary)) };
                        }
                    }
                } catch (error) {
                    throw fail(error);
                }
                if (applied) publish(span, index);
                nextOps.push(...blockOps);
                keptSpans.push(span);
                nextParts.push({ ops: blockOps, span });
                if (kept) nextReceipts.push(kept);
            }
            // Every kept receipt follows its ops through every rev they moved to (once: by the rev it had), the guarded one too.
            for (const receipt of keptReceipts) if (moved.has(receipt.rev)) receipt.rev = moved.get(receipt.rev);
            if (!paired) nextReceipts.push(...keptReceipts);
            const allSpans = [...storySpans, ...keptSpans];
            const rewritten = {
                ...record,
                ops: nextOps,
                receipts: [...structuredClone(receipts), ...nextReceipts],
                spans: allSpans,
                source: advanced(record.source, allSpans),
                rev: revOf(state),
            };
            const writes = [[message, rewritten]];
            // Later blocks that were already skipped stay skipped (a guarded block that is inactive is asked again);
            // one that applied before must still apply.
            const prior = [...replay(arr, index - 1).problems.filter(problem => problem.index < index), ...keptProblems];
            const walked = walkSuffix(arr, state, index + 1, { rerun, overlay: new Map([[index, rewritten]]), prior });
            writes.push(...walked.writes);
            for (const [target, next] of writes) write(target, next);
            saver.touch();
            forgetMemos();
            s.cache = null;   // rebuilt on the next read, with the blocks that stay skipped reported
        },

        // Plans the guarded system blocks that carry a `replan` again, from carrier `index` to the head, on the
        // state as it stands at each one's place (REPLAY.md "Reconciling"): after a swipe, a delete or a
        // rollback changed what they depended on. `rerun(state, receipt, { index, span })` is as in replaceStory
        // (→ { ok, ops, receipt, block? }). All or nothing: the old ops, claims and receipts of a block are
        // removed as the new ones are put in, or the block goes when it is not done any more; a later change
        // that no longer applies throws and nothing is written. → { changed: boolean }.
        reconcile(index, { rerun = null } = {}) {
            writable();
            const arr = list();
            const message = carrierAt(arr, index);
            if (typeof rerun !== 'function') return { changed: false, planned: 0, removed: 0 };
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const walked = walkSuffix(arr, base, index, { rerun, overlay: new Map() });
            if (!walked.any) return { changed: false, planned: 0, removed: 0 };
            for (const [target, next] of walked.writes) write(target, next);
            saver.touch();
            forgetMemos();
            s.cache = null;
            return { changed: true, planned: walked.planned, removed: walked.removed };
        },
    };
}
