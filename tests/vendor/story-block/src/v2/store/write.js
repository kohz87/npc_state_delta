// Story Suite v2: the store's writes (append, before, replaceStory, reconcile, setNarrated, setPracticeRule, receipts, truncate, untold, work,
// rebuild, archived, archiveList, batch, renamed, touch, lifecycleChanged, saveIdle, saveLate, idleSaves), moved out of createStore unchanged: the methods of
// `api` that change the chat's records or its saving. `createWrite(s, deps)` returns them as one object and createStore puts each in `api` at
// the place it was. It is given the store's state holder `s`, the store's options it reads (rescue, place) and the store functions it calls
// (the other parts' come from their factories). It never imports store.js.

import { KEY, carrierIndexes, dropCopy, lastCarrier, readRecord, writeRecord } from '../persist.js';
import { isObject, touchesHostDomain, hostBlock, revOf, deepFreeze, NO_LONGER_DONE, readerSetup } from './constants.js';
import { clockWriteProblem } from '../timeline/boundary.js';
import { gateProblem } from '../timeline/gate.js';
import { allocator, occurrenceOf, spanOperationKey } from '../evidence.js';
import { isMetaSpan } from '../replay.js';

export function createWrite(s, deps) {
    const { advanced, archive, asOps, baseFor, blockParts, bury2, carrierAt, current, forgetMemos, frozenReceipts, guardHolds, headKey, idsOf, intactReason, isGuardedBlock, keeps, lineOf, list, marked, markNow, ORPHAN, ownedAlready, place, publish, quarantined, receiptsFor, receiptsOf, replay, replayGuarded, replayLegacy, replayRecord, rerunBlock, rescue, retain, sameKey, saver, settleAll, skipped, spansFor, spansOf, stamp, stateBefore, step, take, walkSuffix, withSource, writable, write } = deps;

    return {
        /** Marks the chat as changed outside its records (the timeline's archive in the chat's metadata): the next save writes it. */
        touch() {
            saver.touch();
        },

        /**
         * The modules' lifecycle changed (a module turned ready or dormant, the `modules` event): the checkpoints over guarded
         * blocks that were made under other owners no longer hold (chain), so the head is replayed again from before them with
         * the guards asked, and only then does the caller publish a head. Guarded blocks before the checkpoint a replay would
         * start from are found by that replay. → true when the chat holds guarded blocks.
         */
        lifecycleChanged() {
            s.lastMark = markNow();
            s.cache = null;
            forgetMemos();
            current();
            return s.guardSeen;
        },

        // `block` (what the command bus hands over for a guarded transaction, REPLAY.md): { module, source, guard,
        // operation, recorded, result }. The host stamps the block id, the claims its ops make and the boundary
        // it starts at, and the record keeps all of it on the block's span, written together with the ops.
        append({ ops, receipt = null, block = null } = {}) {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) throw new Error('There is no reply in this chat to hold the change yet.');
            writable();
            const base = current().state;
            if (!base) throw new Error('This chat has no story state yet.');
            const added = asOps(ops);
            if (receipt !== null && !isObject(receipt)) throw new TypeError('A receipt must be an object.');
            if (block !== null && !isObject(block)) throw new TypeError('A block must be an object.');
            if (!added.length && !receipt) return;
            const clock = clockWriteProblem(block, added);
            if (clock) throw new Error(clock);
            if (added.some(touchesHostDomain) && !hostBlock(block?.module, block?.operation?.type)) throw new Error('The savepoints are the host\'s own; only its blocks write them.');
            if (block?.guard) {
                // A guard that replay would turn away (another epoch, other rules) is not stored: live and replay agree.
                const gate = gateProblem(base, block.guard);
                if (gate) throw new Error(`The guarded change cannot be stored: ${gate}.`);
            }
            const next = step(base, added);       // throws on a bad op: nothing is written
            const taken = take(arr, index, base);
            // (what a quarantined record would hold is never applied: a change put on it would be lost on the next replay)
            if (!taken.fresh && quarantined(taken.record)) throw new Error(`This reply's story record is kept as it is and nothing is added to it: ${ORPHAN}.`);
            const { message } = taken;
            const record = withSource(message, taken.record);
            if (typeof receipt?.id === 'string' && record.receipts.some(known => known?.id === receipt.id)) {
                throw new Error(`Receipt ${receipt.id} is already stored on this reply.`);
            }
            const spans = spansFor(record);
            const story = receipt?.cause === 'story';
            const span = block
                ? stamp(arr, index, record, block, added, receipt, blockParts({ ...record, spans, ops: record.ops }), record.ops.length)
                : null;
            if (span) guardHolds(base, span, message);
            write(message, {
                ...record,
                ops: [...record.ops, ...added],
                receipts: receipt ? [...record.receipts, structuredClone(receipt)] : record.receipts,
                spans: [...spans, { n: added.length, story, ...(span ?? {}) }],
                ...(span ? { source: advanced(record.source, [span]) } : {}),
                rev: revOf(next),
            });
            saver.touch();
            retain(arr, next, undefined, s.cache?.applied && span?.evidence?.length
                ? [...s.cache.applied, ...span.evidence.map(proof => Object.freeze({ proof, block: span.id, index }))] : undefined);
        },

        // The state a Re-read of carrier `index` runs its lines on: its own checkpoint when it starts
        // one, else the state after the carrier before it (null without one). Frozen.
        before(index) {
            const arr = list();
            const message = carrierAt(arr, index);
            return baseFor(arr, index);
        },

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

        // `reply`: the record is of a received message Story Block captured (never a greeting): it is marked `reply: true`.
        setNarrated(index, ids, { reply = false } = {}) {
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
                throw new TypeError('Narrated receipts must be a list of receipt IDs.');
            }
            writable();
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, narrated: [...new Set(ids)], ...(rev === undefined ? {} : { rev }), ...(reply && marked() ? { mv: 1, reply: true } : {}) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        /**
         * Marks the reply at `index` as captured under the rule that skill practice comes only from rolls: `practiceRule: 'rolls'` on its record, kept
         * with the reply (a Re-read, an edit, a rebuild and a reload keep it). Only replies with a story practice line get it (turn.js); an older reply
         * has none and keeps its practice lines. Not a replay input.
         */
        setPracticeRule(index) {
            writable();
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            if (record.practiceRule === 'rolls') return;
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, practiceRule: 'rolls', ...(rev === undefined ? {} : { rev }) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        // Every stored receipt on the current line of history, in chat order: [{ index, receipt }]
        // (the carriers the head is built from; frozen copies).
        receipts() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.receipts) return memo.receipts;
            s.counts.lineScans++;
            const out = [];
            let started = false;
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint) started = true;
                if (!started || !record) continue;
                for (const receipt of frozenReceipts(record)) out.push(Object.freeze({ index: i, receipt }));
            }
            memo.receipts = Object.freeze(out);
            return memo.receipts;
        },

        // Return in time (MODULES §F17): drops the head carrier's receipts with rev >= beforeRev and
        // their ops, so the head is the state just before the first of them. Each receipt's ops end with
        // its `/meta/rev` op, which is where they are cut. Only the head carrier (nothing after it holds
        // state that depends on it). Returns { dropped: receipt ids, rev }.
        // `{ dryRun: true, chat? }` works it all out and writes nothing, on `chat` (messages, default the
        // chat) if given: rewind asks it on the messages its branch will hold before it branches.
        truncate(index, beforeRev, { dryRun = false, chat: messages = null } = {}) {
            if (!dryRun) writable();
            const arr = dryRun && Array.isArray(messages) ? messages : list();
            if (index !== lastCarrier(arr)) throw new RangeError(`Message ${index} is not the last reply that keeps the story, so its changes cannot be taken back alone.`);
            if (!Number.isInteger(beforeRev) || beforeRev < 1) throw new TypeError('beforeRev must be a whole number of 1 or more.');
            const message = carrierAt(arr, index);
            const record = readRecord(message);
            if (!record) return { dropped: [], rev: revOf(arr === list() ? current().state : stateBefore(arr, index + 1)) };
            if (quarantined(record)) throw new Error(`This reply's story record cannot be cut down: ${ORPHAN}.`);
            const chunks = [];
            let start = 0;
            record.ops.forEach((op, at) => {
                if (op?.path === '/meta/rev') {
                    chunks.push({ ops: record.ops.slice(start, at + 1), rev: op.value });
                    start = at + 1;
                }
            });
            if (start < record.ops.length) chunks.push({ ops: record.ops.slice(start), rev: null });
            const cut = chunks.findIndex(chunk => chunk.rev === null || chunk.rev >= beforeRev);
            const kept = cut < 0 ? chunks : chunks.slice(0, cut);
            const keptRevs = new Set(kept.map(chunk => chunk.rev));
            const receipts = record.receipts.filter(receipt => keptRevs.has(receipt?.rev));
            const dropped = record.receipts.filter(receipt => !keptRevs.has(receipt?.rev)).map(receipt => receipt?.id);
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const ops = kept.flatMap(chunk => chunk.ops);
            const byRev = new Map(receipts.map(receipt => [receipt.rev, receipt]));
            // A kept block that was a guarded one keeps its span's record (id, guard, claims, …).
            const was = new Map();
            let from = 0;
            for (const span of spansFor(record)) {
                if (isMetaSpan(span)) was.set(`${from}:${span.n}`, span);
                from += span.n;
            }
            let offset = 0;
            const spans = kept.map(chunk => {
                const old = was.get(`${offset}:${chunk.ops.length}`);
                offset += chunk.ops.length;
                return { ...(old ?? {}), n: chunk.ops.length, story: byRev.get(chunk.rev)?.cause === 'story' };
            });
            // C1-3: the kept changes are replayed as a rebuild replays them (block by block, by the
            // replay rules: a remove of what a deleted reply added is passed over), so a chat that
            // replays fine is not refused. A kept block that still does not apply refuses the rewind.
            const problems = [];
            const earlier = (dryRun ? [] : current().problems).filter(problem => problem.index < index);     // (read before anything is written)
            const state = replayRecord(base, { ...record, ops, spans, receipts }, index, problems, null, message);
            // (a guarded block whose guard no longer holds stays stored and inactive; it does not refuse)
            const refusing = problems.filter(problem => problem.code !== 'REPLAY_PREREQUISITE');
            if (refusing.length) throw new Error(refusing[0].why);
            if (dryRun) return { dropped, rev: revOf(state) };
            write(message, {
                ...record,
                ops,
                receipts,
                spans,
                narrated: record.narrated.filter(id => !dropped.includes(id)),
                rev: revOf(state),
            });
            saver.touch();
            // Only this carrier was rewritten: earlier problems stay, and so do those of its kept blocks that are off.
            retain(arr, state, [...earlier, ...problems], null);
            return { dropped, rev: revOf(state) };
        },

        untold() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.untold) return memo.untold;
            s.counts.lineScans++;
            const records = [];
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint || (records.length && record)) records.push(record);
            }
            const told = new Set();
            const out = [];
            for (let r = records.length - 1; r >= 0; r--) {
                for (const id of records[r].narrated) told.add(id);
                const receipts = records[r].receipts;
                for (let k = receipts.length - 1; k >= 0; k--) {
                    if (receipts[k]?.narrate === true && !told.has(receipts[k].id)) out.push(receipts[k]);
                }
            }
            memo.untold = deepFreeze(structuredClone(out.reverse()));
            return memo.untold;
        },

        /**
         * How much replay work the store has done (for tests that count work rather than time): `replays`
         * (state rebuilt from a checkpoint), `recordsRead` (carriers replayed), `lineScans` (whole-chat
         * passes for receipts or untold), `witnessMisses` (timeline witnesses worked out, not found in the memo). A copy.
         */
        work() {
            return { ...s.counts };
        },

        rebuild() {
            s.frozenCheckpoints = new WeakMap();
            const previous = s.idIndex;
            s.idIndex = null;
            s.cache = null;
            forgetMemos();
            // The record copies and old receipts are settled over the whole chat, and a record whose
            // swipe moved is stamped again (settleAll).
            if (settleAll(list())) saver.touch();
            // Ids this session knew of this chat that are no longer in it were deleted: they are archived. The index is
            // (re)built on every rebuild, so what is there now is the baseline of the next one (a store just opened over
            // saved records has one from its first rebuild); another chat's ids are never carried over.
            const now = idsOf(list());
            if (previous && previous.arr === list() && previous.chat === now.chat) bury2(previous, now);
            current();
        },

        /** Is this canonical sid, swipe key or evidence id archived (its reply or swipe was deleted)? It confers no eligibility. */
        archived(id) {
            return archive().has(id);
        },
        /** The archive: the ids that were deleted, sorted. */
        archiveList() {
            return [...archive()].sort();
        },

        // Runs `fn` (it may be async) with the swipe_info copies of every record it writes held back,
        // then copies each once: a reply's change lines are stored one by one (each must apply on its
        // own), but a long block is not copied once per line (B1-1).
        async batch(fn) {
            s.holding += 1;
            try {
                return await fn();
            } finally {
                s.holding -= 1;
                if (!s.holding) {
                    // The copies are written again as they are: a head cached before stays the head.
                    const arr = list();
                    const kept = s.cache && sameKey(s.cache.key, headKey(arr)) ? s.cache : null;
                    for (const message of s.held) {
                        const record = message.extra?.[KEY];
                        if (!record) continue;
                        if (keeps(message, arr)) writeRecord(message, record);
                        else dropCopy(message);
                    }
                    s.held.clear();
                    if (kept) retain(arr, kept.state, kept.problems);
                }
            }
        },

        /**
         * B-b2-timeline-r2-2: chat `from` was renamed `to` (SillyTavern's CHAT_RENAMED). A change not yet
         * saved, or left for its old chat's file, goes into the renamed chat's file instead: the old one
         * is gone, and a renamed open chat is read back as new messages, which looks like another chat.
         */
        renamed(from, to) {
            if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) return false;
            let moved = saver.renamed(from, to);
            for (const entry of s.unsaved.values()) {
                if (entry.chatId !== from) continue;
                entry.chatId = to;
                moved = true;
            }
            if (moved && saver.dirty()) saver.schedule();
            return moved;
        },

        /**
         * The turn's save (docs/v2/PERFORMANCE.md, "Long chats"): the reply's capture and the reader's actions
         * after it are written once, a moment after the last of them (persist.js IDLE_MS, at most IDLE_MAX_MS
         * after the first). Only where a change left behind by a chat switch can still be put into its own
         * chat's file (a chat file and `rescue`): then → true. Elsewhere (no chat file this page can write,
         * e.g. a temporary chat) → false, and the caller saves at once as before.
         */
        saveIdle(wait, max) {
            let where = null;
            try { where = typeof rescue === 'function' ? place() : null; } catch { where = null; }
            if (!where) return false;
            saver.idle(wait, max);
            return true;
        },
        /**
         * A change after the reply (a module's command, a reader's action): as saveIdle, but within FOLLOW_MS of the
         * turn's save it joins one late window (persist.js LATE_MS / LATE_MAX_MS) instead of a save of its own. Same
         * condition as saveIdle: false where the caller must save at once.
         */
        saveLate() {
            let where = null;
            try { where = typeof rescue === 'function' ? place() : null; } catch { where = null; }
            if (!where) return false;
            saver.late();
            return true;
        },
        /** True when changes are saved by the turn's idle save here (see saveIdle). */
        idleSaves() {
            try { return typeof rescue === 'function' && !!place(); } catch { return false; }
        },
    };
}
