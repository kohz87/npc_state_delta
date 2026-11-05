// Story Suite v2: replay, block by block (REPLAY.md), moved out of createStore unchanged: the state at a carrier from the checkpoint
// before it (replay, replayRecord), one record's blocks, with a guarded system step planned again when a Re-read or a reconcile asks
// (replayBlocks, replanned, rerunBlock, skipped), the head's key and when the cached head still holds (headKey, stillHolds), and the
// proof of the blocks that applied (proofsBefore, proofBefore, packOwners, listProofs, appliedOf). `createReplayBlocks(s, deps)` is
// given the store's state holder `s` and the store functions it calls (walk.js's functions come in from createWalk); it never imports store.js.

import { KEY, carrierIndexes, isCarrier, lastCarrier, readRecord, recordFault } from '../persist.js';
import { hashJson, isMetaSpan } from '../replay.js';
import { revOf, deepFreeze, NO_LONGER_DONE } from './constants.js';
import { allocator, evidenceDigest, merged, recordEntries } from '../evidence.js';
import { hasMeta } from './digest.js';

export function createReplayBlocks(s, deps) {
    const { ORPHAN, quarantined, receiptsFor, isGuardedBlock, arr0, intactReason, ownedAlready, publish, asOps, blockParts, receiptsOf, lineOf, current, list, guardHolds, occurrenceFor, withSource, replayGuarded, replayLegacy, advanced, chain, checkpointState, problemText, stamp, step, unpackProblems } = deps;

    // State after the last carrier at or before `upTo`, or null when no checkpoint precedes it. A block
    // of ops that no longer applies (a hand-edited chat, a middle reply deleted) is skipped and reported
    // on its own, so a bad change cannot take the rest of its carrier, or anything later, with it.
    // `whole`: from the first carrier's own checkpoint, past every later one (carriedTo, below).
    function replay(arr, upTo, { whole = false } = {}) {
        s.counts.replays++;
        let { from } = chain(arr, upTo);
        if (whole) {
            const first = carrierIndexes(arr)[0];
            if (first !== undefined && first <= upTo && readRecord(arr[first])?.checkpoint) from = first;
        }
        // A damaged record (B-b2-timeline-7) is skipped, and said so.
        const problems = from >= 0 ? unpackProblems(arr, from, readRecord(arr[from]).carried) : [];
        for (let i = Math.max(from, 0); i <= upTo && i < arr.length; i++) {
            const fault = recordFault(arr[i]);
            if (fault) {
                problems.push({ index: i, block: null, receipts: [], why: fault, code: 'DAMAGED', message: problemText(i, fault, 'DAMAGED') });
            }
        }
        if (from < 0) return { state: null, problems };
        let state = checkpointState(readRecord(arr[from]).checkpoint);
        // The proof of the blocks that applied, in the order they applied (replayGuarded adds to it).
        const outer = s.applying;
        const applied = [];
        s.applying = { list: applied, index: from, from };
        try {
            for (let i = from; i <= upTo && i < arr.length; i++) {
                const record = readRecord(arr[i]);
                if (!record) continue;
                s.counts.recordsRead++;
                s.applying.index = i;
                state = replayRecord(state, record, i, problems, null, arr[i]);
            }
        } finally {
            s.applying = outer;
        }
        return { state, problems, from, applied };
    }

    // One carrier's ops, block by block. `skip` (a Set of "index:block") names blocks to pass over
    // without trying them (Re-read keeps blocks that were already skipped skipped).
    function replayRecord(state, record, index, problems, skip = null, message = null) {
        return replayBlocks(state, record, index, problems, { skip, message }).state;
    }

    // The rev a block's last `/meta/rev` op sets, or null.
    const revOfOps = ops => [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value ?? null;

    // replayRecord, and with `rerun` (a Re-read's or reconcile's way of planning a system step again) the
    // record's guarded system blocks that carry a `replan` are planned again on the state as it stands at their
    // place (REPLAY.md "Reconciling"): the old block (ops, claims, receipt) is not applied, and the new one takes
    // its place, keeping its block id and source. The step is asked with what the span saved (`span.replan`:
    // type, payload, seed). Only an owner that says NO_LONGER_DONE removes a block; when the step cannot be asked
    // (the command is not there, the owner is held back, a feature is off, it threw, any other refusal) the old
    // block stays as it is, untouched, and is replayed as it was (its guard decides: off, REPLAY_PREREQUISITE, when it fails). A block planned again to what it was
    // changes nothing. A guarded block whose guard no longer holds stays stored and inactive and is asked again
    // the next time. → { state, fields }: `fields` ({ ops, receipts, spans, source, planned, removed }) is what
    // the record is to hold now, or null when nothing changed (the record stays as it is).
    function replayBlocks(state, record, index, problems, { skip = null, rerun = null, message = null, running = null } = {}) {
        const parts = blockParts(record);
        const replans = parts.some(({ span }) => isMetaSpan(span) && span.guard && span.replan);
        if (replans) s.replanFrom = Math.min(s.replanFrom, index);
        const plans = typeof rerun === 'function' && replans;
        // `running`: the rev the replies before this one ended on after a step was planned again; from there on the revs
        // are numbered on (so no two receipts share one), here and on the replies after.
        const rewrites = plans || running !== null;
        const out = rewrites ? { parts: [], gone: new Map(), changed: false, running, planned: 0, removed: 0 } : null;
        const anyGuardedReceipt = record.receipts.some(each => each?.guarded === true);
        const orphan = anyGuardedReceipt && quarantined(record);
        // Where each block of this record stands in the record that is written back (a planned-again step that is no longer
        // done takes its place out of it), so the Problems below name the block as a full replay will number it.
        const firstProblem = problems.length;
        const placed = new Map();
        // Quarantine is decided on the record as it is stored, before any rebase, renumbering or filtering below can touch it:
        // it applies nothing and is never rewritten (so nothing renumbered can reattach the receipt that is detached).
        if (orphan) {
            parts.forEach(({ ops }, block) => {
                problems.push({
                    index, block, receipts: receiptsOf(record, ops), why: ORPHAN,
                    message: `Some changes stored on message ${index} no longer apply and were skipped: ${ORPHAN}`,
                    code: 'REPLAY_PREREQUISITE',
                });
                state = skipped(state, ops);
            });
            return { state, fields: null, running };
        }
        parts.forEach(({ ops, span: stored }, block) => {
            let span = stored;
            // A block numbered at or below the rev the story is at (a swipe made before an earlier reply was read again, shown
            // now): a reconcile from here numbers it on (walkSuffix), so revs stay strictly increasing along the chat.
            const firstRev = ops.find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
            if (firstRev !== undefined && firstRev <= revOf(state)) s.replanFrom = Math.min(s.replanFrom, index);
            const receipt = rewrites || anyGuardedReceipt ? record.receipts.find(each => each?.rev === revOfOps(ops)) ?? null : null;
            let blockOps = ops;
            const stands = rewrites || anyGuardedReceipt ? receiptsFor(record, ops) : [];     // every receipt this block's ops are
            const remapped = new Map();                                                       // receipt → the same receipt at its new rev
            if (rewrites && out.running !== null) {
                const moves = new Map();
                blockOps = ops.map(op => {
                    if (op?.path !== '/meta/rev' || !Number.isInteger(op.value)) return op;
                    if (op.value > out.running) {
                        out.running = op.value;
                        return op;
                    }
                    out.running += 1;
                    moves.set(op.value, out.running);
                    return { ...op, value: out.running };
                });
                if (moves.size) {
                    out.changed = true;
                    // (every receipt of the block follows its ops, not only the last one: a block that stands for several
                    // receipts keeps each of them, the guarded one too, tied to its changes)
                    for (const each of stands) if (moves.has(each.rev)) remapped.set(each, { ...each, rev: moves.get(each.rev) });
                }
            }
            const keep = () => {
                if (!rewrites) return;
                out.parts.push({ ops: blockOps, span });
                placed.set(block, out.parts.length - 1);
                for (const [was, now] of remapped) out.gone.set(was, now);
            };
            if (skip?.has(`${index}:${block}`)) {
                state = skipped(state, blockOps);
                keep();
                return;
            }
            const guarded = isGuardedBlock(span, anyGuardedReceipt ? stands : null);
            if (plans && isMetaSpan(span) && span.guard && span.replan && receipt) {
                const done = replanned(state, record, index, span, receipt, blockOps, out, rerun);
                if (!done.kept) {
                    if (done.state) {
                        state = done.state;
                        if (done.same) {
                            if (done.span) {
                                out.changed = true;
                                span = done.span;
                            }
                            keep();
                        }
                    }
                    return;
                }
                // It could not be asked: the block stays as it was, replayed as any block is (its guard decides).
            }
            try {
                state = guarded ? replayGuarded(state, record, blockOps, span, message, receipt) : replayLegacy(state, blockOps);
                keep();
            } catch (error) {
                const why = String(error?.message ?? error);
                problems.push({
                    index, block, receipts: receiptsOf(record, ops), why,
                    message: `Some changes stored on message ${index} no longer apply and were skipped: ${why}`,
                    ...(guarded || error?.code === 'REPLAY_PREREQUISITE' ? { code: 'REPLAY_PREREQUISITE' } : {}),
                });
                state = skipped(state, blockOps);
                keep();
            }
        });
        if (!out?.changed) return { state, fields: null, running: out?.running ?? null };
        for (let at = firstProblem; at < problems.length; at += 1) {
            const entry = problems[at];
            if (entry.index === index && placed.has(entry.block)) entry.block = placed.get(entry.block);
        }
        const receipts = [];
        for (const each of record.receipts) {
            if (!out.gone.has(each)) receipts.push(each);
            else if (out.gone.get(each)) receipts.push(out.gone.get(each));
        }
        const spans = out.parts.map(part => part.span);
        const ops = out.parts.flatMap(part => part.ops);
        return { state, fields: { ops, receipts, spans, source: advanced(record.source, spans), planned: out.planned, removed: out.removed }, running: out.running };
    }

    // Every rerun sees the position the accepted blocks of this plan leave, rather than the old record's offset.
    function rerunBlock(rerun, state, receipt, index, span, earlier, alloc) {
        return rerun(deepFreeze(structuredClone(state)), receipt, {
            index, span, replan: span.replan ?? null, occurrence: occurrenceFor(span, receipt, alloc),
            opsBefore: earlier.reduce((sum, part) => sum + part.ops.length, 0),
        });
    }

    // One guarded system block planned again on `state` (replayBlocks). → { state } the state after the new block
    // (or after the old one when it comes out the same: nothing changes), { state: null } when the owner says the
    // step is NO_LONGER_DONE (the block, its claims and its receipt go), or { kept: true, why } when it could not
    // be asked (the old block stays exactly as it was, and is replayed as it was: its guard decides). A new block that does not apply, or cannot be stored, throws:
    // nothing is changed.
    function replanned(state, record, index, span, receipt, blockOps, out, rerun) {
        const broken = intactReason(record, blockOps, span, receipt);
        if (broken) return { kept: true, why: broken };
        let planned = null;
        let failure = '';
        try {
            planned = rerunBlock(rerun, state, receipt, index, span, out.parts, (out.alloc ??= allocator(record)));
        } catch (error) {
            failure = `it threw (${error?.message ?? error})`;
        }
        if (!planned?.ok) {
            if (planned?.ok === false && planned.code === NO_LONGER_DONE) {
                out.changed = true;
                out.removed += 1;
                out.gone.set(receipt, null);
                return { state: null };
            }
            const why = failure || `it was not asked (${planned?.code ?? 'no answer'}: ${planned?.message ?? 'nothing came back'})`;
            return { kept: true, why };
        }
        const clash = ownedAlready(state, planned.block?.evidence);
        if (clash) return { kept: true, why: `it would give proof ${clash.id}, which a block that applied already owns` };
        const fresh = asOps(planned.ops);
        let next;
        try {
            next = step(state, fresh);
        } catch (error) {
            throw new Error(`A step planned again on message ${index} does not apply: ${error?.message ?? error}`);
        }
        const own = revOfOps(fresh);
        if (Number.isInteger(own)) out.running = out.running === null ? own : Math.max(out.running, own);
        const newReceipt = { ...structuredClone(planned.receipt), id: receipt.id, ...(receipt.afterCapture === true ? { afterCapture: true } : {}), ...(receipt.beforeGenerate === true ? { beforeGenerate: true } : {}) };
        let newSpan = { n: fresh.length, story: false };
        if (planned.block) {
            const arr = list();
            const holder = withSource(arr[index], record);
            newSpan = { ...newSpan, ...stamp(arr, index, holder, { ...planned.block, id: span.id, source: { ...planned.block.source, ordinal: span.source.ordinal } }, fresh, newReceipt, out.parts, out.parts.reduce((sum, part) => sum + part.ops.length, 0)) };
        }
        // A block that would not hold on replay is not stored: the old block stays as it is, its own guard decides.
        if (newSpan.guard) {
            try { guardHolds(state, newSpan, arr0(index)); } catch (error) { return { kept: true, why: error.message }; }
        }
        // Its proof is the guards' to see only now: it applied and it is stored. A refusal above leaves no trace of it.
        publish(newSpan, index);
        // Planned to what it was: the old block stays as it is.
        const sameness = value => hashJson({ ops: value.ops, guard: value.span.guard ?? null, claims: value.span.claims ?? null, recorded: value.span.recorded ?? null,
            result: value.span.result ?? null, operation: value.span.operation ?? null, replan: value.span.replan ?? null, evidence: evidenceDigest(value.span.evidence) });
        if (sameness({ ops: blockOps, span }) === sameness({ ops: fresh, span: newSpan })) {
            // The same step; but where it stands may have moved (the boundaries' prefix hashes follow what is before
            // it), and then the new span is what is stored: ops, receipt and result stay as they were.
            return { state: next, same: true, ...(hashJson(span) === hashJson(newSpan) ? {} : { span: newSpan }) };
        }
        out.changed = true;
        out.planned += 1;
        out.parts.push({ ops: fresh, span: newSpan });
        out.gone.set(receipt, newReceipt);
        return { state: next };
    }

    // A skipped block still counts its receipts' revs, so every later receipt keeps a rev of its own.
    function skipped(state, ops) {
        const revs = ops.filter(op => op?.path === '/meta/rev' && Number.isInteger(op.value));
        if (!revs.length || revs.at(-1).value <= revOf(state)) return state;
        try { return step(state, [{ op: 'replace', path: '/meta/rev', value: revs.at(-1).value }]); } catch { return state; }
    }

    function headKey(arr) {
        const index = lastCarrier(arr);
        const message = arr[index];
        return { arr, length: arr.length, index, message, swipe: message?.swipe_id, extra: message?.extra,
            record: message?.extra?.[KEY] };
    }

    // The cached head still holds when all that changed is messages after its carrier that hold no
    // record (the reader's next message, a reply not read yet): replaying them would give it again.
    function stillHolds(arr, key) {
        const old = s.cache?.key;
        if (!s.cache?.state || old.arr !== arr || old.index < 0 || key.index < old.index || arr.length < old.length) return false;
        const message = arr[old.index];
        if (message !== old.message || message?.swipe_id !== old.swipe || message?.extra !== old.extra || message?.extra?.[KEY] !== old.record) return false;
        for (let i = old.index + 1; i < arr.length; i++) if (arr[i]?.extra?.[KEY] !== undefined) return false;
        return true;
    }

    // The proof of the blocks before the one replay starts from. When the checkpoint there says which blocks applied before it (`owned`: the
    // record's sid and the block's id), those and no others; else (an older checkpoint) every block that could apply (replay did not look
    // at them), and of two that give one id the first listed keeps it.
    function proofsBefore(arr, from) {
        const memo = lineOf(arr);
        const kept = memo.proofsBefore?.get(from);
        if (kept) return kept;
        const owned = from >= 0 ? readRecord(arr[from])?.owned : undefined;
        const on = Array.isArray(owned) ? new Set(owned.map(each => (Array.isArray(each) ? `${each[0]}\u0000${each[1]}` : ''))) : null;
        const out = [];
        for (const i of carrierIndexes(arr)) {
            if (i >= from) break;
            const record = readRecord(arr[i]);
            if (record && hasMeta(record)) for (const entry of recordEntries(record, blockParts(record))) if (!on || on.has(`${record.sid}\u0000${entry.block}`)) out.push(Object.freeze({ ...entry, index: i }));
        }
        // A checkpoint that does not say (one written before it did) is worked out by replaying what is before it.
        let listed = out;
        if (!on && out.length && from > 0) {
            const prior = replay(arr, from - 1);
            if (prior.state) listed = [...proofsBefore(arr, prior.from), ...(prior.applied ?? [])];
        }
        const seen = new Set();
        const once = listed.filter(entry => !seen.has(entry.proof.id) && seen.add(entry.proof.id));
        (memo.proofsBefore ??= new Map()).set(from, once);
        return once;
    }

    // Did any record before carrier `upTo` hold proof (a block with evidence)? A checkpoint carries `owned` only when one did, so a store
    // that never gave proof is written exactly as it was.
    function proofBefore(arr, upTo, at = i => readRecord(arr[i])) {
        for (let i = 0; i < upTo && i < arr.length; i++) {
            const record = isCarrier(arr[i]) ? at(i) : null;
            if (record && Array.isArray(record.spans) && record.spans.some(span => Array.isArray(span?.evidence) && span.evidence.length)) return true;
        }
        return false;
    }

    // The blocks that applied, as a checkpoint carries them (`owned`): [record sid, block id], each once.
    function packOwners(entries, sidAt) {
        const seen = new Set();
        const out = [];
        for (const entry of entries) {
            const sid = Number.isInteger(entry.index) ? sidAt(entry.index) : undefined;
            if (typeof sid !== 'string' || typeof entry.block !== 'string' || seen.has(`${sid}\u0000${entry.block}`)) continue;
            seen.add(`${sid}\u0000${entry.block}`);
            out.push([sid, entry.block]);
        }
        return out;
    }

    // store.proofs (see there).
    function listProofs(all) {
        const arr = list();
        const memo = lineOf(arr);
        const laid = base => (s.walkProofs?.size ? Object.freeze(merged(base, [...s.walkProofs.values()])) : base);
        // A replay or a walk is going on (a guard asks): the blocks that have applied so far, in the order they did.
        if (s.applying && !all) return laid(Object.freeze([...proofsBefore(arr, s.applying.from), ...s.applying.list]));
        const slot = all ? 'proofsAll' : 'proofsApplied';
        if (!memo[slot]) {
            let out = [];
            if (all) {
                for (const i of carrierIndexes(arr)) {
                    const record = readRecord(arr[i]);
                    if (record && hasMeta(record)) for (const entry of recordEntries(record, blockParts(record))) out.push(Object.freeze({ ...entry, index: i }));
                }
            } else {
                const head = current();
                if (head.state && !head.readOnly) {
                    appliedOf(arr, head);
                    out = [...proofsBefore(arr, head.from), ...head.applied];
                }
            }
            memo[slot] = Object.freeze(out);
        }
        return laid(memo[slot]);
    }

    // The head's applied proof, worked out again when a write left it unknown (a truncate).
    function appliedOf(arr, head) {
        if (!head.applied) {
            const again = replay(arr, head.key.index);
            head.applied = again.applied ?? [];
            head.from = again.from ?? -1;
        }
        return head.applied;
    }

    return { replay, replayRecord, replayBlocks, rerunBlock, skipped, headKey, stillHolds, proofsBefore, proofBefore, packOwners, listProofs, appliedOf };
}
