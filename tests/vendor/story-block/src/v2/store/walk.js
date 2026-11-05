// Story Suite v2: walking the chain of records (REPLAY.md "Checkpoints and covers", "Reconciling"), moved out of createStore unchanged:
// the checkpoint to replay from (chain), applying a block's ops to a state (step), the span a guarded block is stored with (stamp,
// advanced), a Re-read's / reconcile's walk over the carriers from one on (walkSuffix), the copies and receipts a rebuild settles
// (keeps, settleAll, settleBehind), and the Problems a checkpoint carries (packProblems, unpackProblems). `createWalk(s, deps)` is given
// the store's state holder `s` and the store functions it calls (replay-blocks.js's functions come in as they are used, because the two
// parts call each other); it never imports store.js.

import { isObject, revOf, deepFreeze } from './constants.js';
import {
    allocator, evidenceProblem, occurrenceOf, opShapeProblem, operationKey, spanOperationKey, takenAfter,
} from '../evidence.js';
import { blockIdOf, claimKeys, hashJson, isMetaSpan, spanProblem } from '../replay.js';
import { hasMeta, payloadHashOf } from './digest.js';
import { clockWriteProblem } from '../timeline/boundary.js';
import {
    KEY, carrierIndexes, dropCopy, isCarrier, keepsCopy, lastCarrier, readRecord, restamp, restoreCopy, trimReceipts,
} from '../persist.js';
import { rebaseOps } from '../ops.js';

export function createWalk(s, deps) {
    const { apply, receiptKeep, scratch, validate, list, current, blocksBefore, markNow, seeGuards, chainHash, spineBefore, spineStep, windowHash, replay, replayBlocks, appliedOf, proofBefore, packOwners, listProofs } = deps;

    function stamp(arr, index, record, block, ops, receipt, earlier, offset) {
        const entry = record.source;
        const planned = block.source;
        if (!isObject(entry) || !isObject(planned) || planned.sid !== entry.logical || planned.swipeKey !== entry.swipeKey || planned.evidence !== entry.evidence) {
            throw new Error('The block was planned for another reply or swipe.');
        }
        const ordinal = planned.ordinal;
        // A block is named by what it is: the reply, its operation, and its occurrence among the reply's blocks of that operation (replay.js
        // blockIdOf). The occurrence is given once, when the block is first stamped, and kept in its span (evidence.js): a block planned again,
        // a Re-read of an unchanged line, a reload and an earlier block that goes all leave it as it was. A block stored before there was one
        // has the id it was stamped with, and keeps its rank among the blocks that did the same.
        let id = block.id;
        let occurrence = occurrenceOf(block);
        if (typeof id !== 'string') {
            let key = '';
            try { key = operationKey(block.operation?.type, block.operation?.payload); } catch { key = ''; }
            // (a block handed over with no number, by a caller that did not allocate one: the reply's next unused, from the same record the allocator reads)
            occurrence ??= allocator(record, other => earlier.reduce((most, part) => (occurrenceOf(part.span) !== null && spanOperationKey(part.span) === other ? Math.max(most, occurrenceOf(part.span) + 1) : most), 0)).take(key);
            id = blockIdOf({ sid: entry.logical, swipeKey: entry.swipeKey, key, rank: occurrence });
        }
        const revOp = [...ops].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value));
        const message = arr[index];
        const span = {
            ...(block.clockBoundaries ? { clockBoundaries: structuredClone(block.clockBoundaries) } : {}),
            id, module: block.module, source: { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence, ordinal },
            guard: block.guard ?? null, claims: claimKeys(ops), evidence: structuredClone(block.evidence ?? []),
            ...(occurrence !== null ? { occurrence } : {}),
            boundaries: [{
                cursor: { sid: entry.logical, swipeKey: entry.swipeKey, block: id, op: offset, rev: Math.max(0, (revOp ? revOp.value : 1) - 1) },
                prefixHash: hashJson({ p: chainHash(arr, index), k: entry.swipeKey, t: payloadHashOf(message), b: blocksBefore(earlier) }),
                payloadHash: payloadHashOf(message),
            }],
            operation: structuredClone(block.operation), recorded: structuredClone(block.recorded ?? null), result: structuredClone(block.result ?? null),
            replan: receipt?.replan && Number.isInteger(receipt.seed) && typeof receipt.type === 'string'
                ? { type: receipt.type, payload: structuredClone(receipt.replan.payload ?? {}), seed: receipt.seed } : null,
        };
        const bad = spanProblem(span) || evidenceProblem(span, ops) || clockWriteProblem(span, ops);
        if (bad) throw new Error(`The guarded block cannot be stored: ${bad}.`);
        // A command that read its cursor (ctx.cursor) was told which block it is: it is stored as that one, or it is not stored. (Where the block
        // starts, `op` and `rev`, is where it sits when it is told; a Re-read moves it.)
        if (block.cursor !== undefined && ['sid', 'swipeKey', 'block'].some(key => block.cursor[key] !== span.boundaries[0].cursor[key])) {
            throw new Error('The block is not the one the cursor its command read named; it is not stored.');
        }
        if (span.guard) seeGuards();
        if (span.guard && span.replan) s.replanFrom = Math.min(s.replanFrom, index);
        return span;
    }

    // `entry` with its `next` ordinal moved past the blocks in `spans`.
    function advanced(entry, spans) {
        let next = Number.isInteger(entry?.next) ? entry.next : 0;
        for (const span of spans) if (isMetaSpan(span) && Number.isInteger(span.source?.ordinal)) next = Math.max(next, span.source.ordinal + 1);
        const taken = takenAfter(entry, spans);     // (the occurrences of proof blocks, kept past the blocks that go)
        return { ...entry, next, ...(taken ? { taken } : {}) };
    }

    // The carriers from `first` on, replayed on `state` (a Re-read's, reconcile's suffix): a later change that
    // no longer applies throws; a guarded block whose guard no longer holds is inactive and does not. Blocks
    // already skipped on the chat as it stands stay skipped (a guarded one is asked again). Guarded system
    // blocks with a `replan` are planned again when `rerun` is given. → { state, writes: [[message, record]],
    // planned } (`writes`: the checkpoints made true again and the records that were planned again).
    function walkSuffix(arr, state, first, { rerun = null, overlay, prior = null }) {
        const known = replay(arr, lastCarrier(arr)).problems;
        const broken = new Set(known
            .filter(problem => problem.code !== 'REPLAY_PREREQUISITE').map(problem => `${problem.index}:${problem.block}`));
        // The Problems so far, for the checkpoints rewritten on the way (`carried`): those before the walk, then each record's.
        const acc = prior ?? known.filter(problem => problem.index < first);
        const sidAtNow = i => (overlay.get(i) ?? readRecord(arr[i]) ?? arr[i]?.extra?.[KEY])?.sid;
        const writes = [];
        const counted = { planned: 0, removed: 0 };
        let planned = false;
        s.staged = overlay;
        const outerApplying = s.applying;
        const head = current();
        // Seeded from the walk's own base: the blocks before `first` that replay applied, counted once. A walk that starts before the
        // checkpoint the head replays from lists the records before `first` as could-apply, and every record from `first` on is the walk's.
        const rooted = first <= (head.from ?? -1);
        s.applying = head.state && !head.readOnly
            ? { list: rooted ? [] : [...appliedOf(arr, head).filter(entry => entry.index < first)], index: first, from: rooted ? first : head.from }
            : null;
        try {
            let running = revOf(state);      // the rev the replies before ended on (a Re-read's new lines, a step planned again): the revs after are numbered on from it
            let history = false;     // guarded blocks before here: a checkpoint written here depends on their owners
            for (let i = 0; i < first && !history; i++) history = hasMeta(overlay.get(i) ?? readRecord(arr[i]));
            for (let i = first; i < arr.length; i++) {
                const later = readRecord(arr[i]);
                if (!later) continue;
                const guardedBefore = history;
                history ||= hasMeta(later);
                const checkpoint = later.checkpoint ? structuredClone(state) : undefined;
                const owners = checkpoint && s.applying && proofBefore(arr, i, j => overlay.get(j) ?? readRecord(arr[j])) ? packOwners(listProofs(false), sidAtNow) : null;     // (the blocks that applied before this record)
                const failed = [];
                if (s.applying) s.applying.index = i;
                const out = replayBlocks(state, later, i, failed, { skip: broken, rerun, message: arr[i], running });
                state = out.state;
                running = out.running;
                const refusing = failed.filter(problem => problem.code !== 'REPLAY_PREREQUISITE');
                if (refusing.length) throw new Error(`A later change (message ${i}) depends on this reply's old story changes: ${refusing[0].why}`);
                const snapshot = packProblems(acc, sidAtNow);      // (before this record: what a checkpoint here carries)
                // A block that stays skipped is passed over without a try: its Problem is the one it had.
                for (const old of known) if (old.index === i && broken.has(`${old.index}:${old.block}`) && !failed.some(problem => problem.block === old.block)) failed.push(old);
                acc.push(...failed);
                const { planned: made = 0, removed: gone = 0, ...fields } = out.fields ?? {};
                if (out.fields) {
                    planned = true;
                    counted.planned += made;
                    counted.removed += gone;
                }
                if (!checkpoint && !out.fields) continue;
                const next = { ...later, ...fields, ...(checkpoint ? { checkpoint } : {}), rev: revOf(state) };
                if (checkpoint) {
                    if (guardedBefore) next.guardEnv = markNow();
                    else delete next.guardEnv;
                    if (snapshot.length) next.carried = snapshot;
                    else delete next.carried;
                    if (owners) next.owned = owners;
                    else delete next.owned;
                }
                overlay.set(i, next);
                writes.push([arr[i], next]);
            }
        } finally {
            s.staged = null;
            s.applying = outerApplying;
        }
        // A rewritten checkpoint's state is the chat as it stands now, so its window is too (REPLAY.md "Checkpoints and covers"):
        // the records from the checkpoint before it (itself included) up to the carrier before this one. A window left as it
        // was could line up again after a later delete and make a state that includes a record trusted without it.
        for (const [target, next] of writes) {
            if (!next.checkpoint) continue;
            const at = arr.indexOf(target);
            // (whatever it was before, a rewritten checkpoint is the state over the records as they are now: its prefix says so)
            next.prefix = spineBefore(arr, at, i => overlay.get(i) ?? readRecord(arr[i]));
            if (!Array.isArray(next.covers)) continue;
            const members = [];
            for (let i = at - 1; i >= 0; i--) {
                const record = isCarrier(arr[i]) ? overlay.get(i) ?? readRecord(arr[i]) : null;
                if (!record) continue;
                members.unshift(i);
                if (record.checkpoint) break;
            }
            next.covers = members.map(i => (overlay.get(i) ?? readRecord(arr[i])).sid);
            const hash = windowHash(arr, members, i => overlay.get(i) ?? readRecord(arr[i]));
            if (hash === undefined) delete next.coverHash;
            else next.coverHash = hash;
        }
        return { state, writes, any: planned, ...counted };
    }

    // Is the shown swipe's copy of this carrier's record kept in swipe_info (persist.js keepsCopy)?
    function keeps(message, arr = list()) {
        return keepsCopy(message, arr[lastCarrier(arr)] === message);
    }

    // A rebuild's pass over the whole chat (persist.js): the last carrier gets its copy (again), the
    // others with one swipe drop theirs, and receipts `receiptKeep` or more carriers back drop `data`.
    // Only records that are the shown swipe's own are touched. In memory: the next save writes it.
    // True when a record was stamped again (that one is a change to save).
    function settleAll(arr) {
        const carriers = carrierIndexes(arr);
        let stamped = false;
        carriers.forEach((i, at) => {
            const message = arr[i];
            const last = at === carriers.length - 1;
            const keep = keepsCopy(message, last);
            // A swipe deleted before another shifts that one's index: stamp it again, so the copy
            // SillyTavern makes for the next new swipe is not taken for the new swipe's own.
            stamped = restamp(message, { mirror: keep }) || stamped;
            if (!readRecord(message)) return;
            if (last) restoreCopy(message);
            else if (!keep) dropCopy(message);
            if (carriers.length - 1 - at >= receiptKeep) trimReceipts(message);
        });
        return stamped;
    }

    // A new record on the last carrier `index`: the carrier before it is no longer the one the reader
    // can swipe, so it drops its copy (unless it has other swipes), and the one `receiptKeep` back drops
    // its receipts' data.
    function settleBehind(arr, index) {
        let back = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            back += 1;
            if (back === 1 && !keepsCopy(arr[i], false) && readRecord(arr[i])) dropCopy(arr[i]);
            if (back >= receiptKeep) {
                trimReceipts(arr[i]);
                return;
            }
        }
    }

    function checkpointState(raw) {
        let state = s.frozenCheckpoints.get(raw);
        if (!state) s.frozenCheckpoints.set(raw, state = deepFreeze(structuredClone(raw)));
        return state;
    }

    // Ops are cloned on the way in so nothing the chat holds ends up inside (and frozen with) a state.
    // A count that stands elsewhere than when the op was made (a reply before it was deleted) takes the
    // op's change rather than its number (ops.js rebaseOps, B3-8), and per-reply scratch fits what is
    // there (ops.js scratch); the domains whose counts moved are checked by their validators, and a
    // problem there throws (the block is skipped and reported). With `strict` (a guarded block) no problem that was
    // already there is forgiven. With `replayed` (a stored block replayed,
    // r2-14) every domain the block touches is checked too: a block that leaves one invalid (a stack
    // whose definition a deleted reply made) throws the same way. Only problems the block brings count,
    // so a chat stored before a validator grew stricter still replays.
    function step(state, ops, { replayed = false, strict = false } = {}) {
        if (!ops.length) return state;
        // Every change is looked at before any is rebased or passed over: a block with a change that is not one applies nothing.
        const shape = opShapeProblem(ops);
        if (shape) throw new Error(shape);
        const { ops: rebased, rebased: moved } = rebaseOps(state, ops, { scratch, replayed });
        const next = deepFreeze(apply(state, structuredClone(rebased)));
        if (typeof validate !== 'function') return next;
        const names = new Set(moved);
        if (replayed) for (const op of rebased) if (/^\/domains\/[^/]/.test(op?.path ?? '')) names.add(op.path.split('/')[2].replace(/~1/g, '/').replace(/~0/g, '~'));
        if (!names.size) return next;
        const list = [...names].filter(name => next?.domains?.[name] !== undefined).sort();
        const problems = list.length ? validate(next, list) ?? [] : [];
        if (!problems.length) return next;
        // A guarded block fails closed: every domain it touches must pass outright (no error that was already there
        // is forgiven, as it is for a legacy block whose chat was stored before a validator grew stricter).
        if (strict) throw new Error(`These changes leave the story invalid: ${problems.join(' ')}`);
        const before = new Set(validate(state, list.filter(name => state?.domains?.[name] !== undefined)) ?? []);
        const brought = problems.filter(problem => !before.has(problem));
        if (brought.length) {
            throw new Error(moved.size
                ? `Taken onto the counts as they stand now, these changes no longer fit: ${brought.join(' ')}`
                : `Taken onto the story as it stands now, these changes no longer fit: ${brought.join(' ')}`);
        }
        return next;
    }

    // The checkpoint to replay from for carrier `upTo` and the records after it (B2-4). A checkpoint is trusted only
    // when the prefix it was made over is exactly the prefix in front of it now (`prefix`, see spineStep): every record
    // before it as it is shown, so one made before a reply was deleted, edited, Re-read or another swipe was shown, and
    // a hidden swipe's, fails and the replay starts from an earlier one that still holds. One that stored no prefix
    // (older records) is trusted only as the first record there is. It must also hold under the owners it was made with
    // (`guardEnv`) and, when it has them, `covers` and `coverHash` (the records it covers and, for guarded blocks, their swipe
    // keys, contents and text). When no checkpoint holds there is no state to start from (the chat starts again from the
    // state ensureInitial gives it) rather than the latest one being taken unchecked.
    // → { from: index | -1, since: the record IDs from `from` through `upTo`, members: their indexes }.
    function chain(arr, upTo) {
        let from = -1;
        let since = [];
        let members = [];
        let guarded = false;     // a record in the window holds guarded blocks
        let history = false;     // a record before this point (anywhere) holds guarded blocks: a checkpoint here depends on its owners
        let running = '';        // the prefix hash in front of this record (spineStep)
        let seen = 0;            // records before this one
        const last = Math.min(upTo, arr.length - 1);
        for (let i = 0; i <= last; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = readRecord(arr[i]);
            if (!record) continue;
            if (record.checkpoint) {
                const covers = Array.isArray(record.covers) ? record.covers : null;
                // Over guarded blocks a checkpoint holds only under the owners it was made with (guardEnv): its state
                // carries what their guards allowed, and replay does not ask them again from here on.
                const under = !history ? true : record.guardEnv !== undefined && record.guardEnv === markNow();
                // The gate: the prefix it was made over is exactly the prefix in front of it now. One that stored none (older
                // records, a hidden swipe's) is trusted only as the first record there is.
                const exact = record.prefix !== undefined ? record.prefix === running : seen === 0;
                // (covers and coverHash are further checks when it has them)
                const holds = under && exact && (!covers || (from >= 0 && covers.length === since.length && covers.every((sid, at) => sid === since[at])
                    && (record.coverHash === undefined ? !guarded : record.coverHash === windowHash(arr, members))));
                if (holds) {
                    from = i;
                    since = [];
                    members = [];
                    guarded = false;
                }
            }
            running = spineStep(running, record, arr[i], seen === 0);
            seen += 1;
            since.push(record.sid);
            members.push(i);
            if (hasMeta(record)) {
                guarded = true;
                if (!history) {
                    history = true;
                    seeGuards();
                }
            }
        }
        return { from, since, members, history };
    }

    // The Problems of blocks before a checkpoint ride with it (`carried`), so a replay that starts from the checkpoint still
    // reports a block that is off in front of it: by the sid of the record it was on (a message index moves when a user
    // message is deleted), the block's position, why and its code.
    const problemText = (index, why, code) => (code === 'DAMAGED'
        ? `The story record on message ${index} is damaged and was skipped: ${why}.`
        : `Some changes stored on message ${index} no longer apply and were skipped: ${why}`);
    const rawSidAt = (arr, i) => (readRecord(arr[i]) ?? arr[i]?.extra?.[KEY])?.sid;
    function packProblems(problems, sidAt) {
        const out = [];
        for (const problem of problems) {
            const sid = sidAt(problem.index);
            if (typeof sid !== 'string') continue;
            out.push({ sid, block: problem.block ?? null, receipts: [...(problem.receipts ?? [])], why: String(problem.why), ...(problem.code ? { code: problem.code } : {}) });
        }
        return out;
    }
    function unpackProblems(arr, before, carried) {
        if (!Array.isArray(carried) || !carried.length) return [];
        const at = new Map();
        for (let i = 0; i < before && i < arr.length; i++) {
            const sid = rawSidAt(arr, i);
            if (typeof sid === 'string' && isCarrier(arr[i])) at.set(sid, i);
        }
        const out = [];
        for (const each of carried) {
            if (!isObject(each) || !at.has(each.sid)) continue;
            const index = at.get(each.sid);
            out.push({ index, block: each.block ?? null, receipts: Array.isArray(each.receipts) ? [...each.receipts] : [], why: String(each.why),
                message: problemText(index, each.why, each.code), ...(each.code ? { code: each.code } : {}) });
        }
        return out;
    }

    return { stamp, advanced, walkSuffix, keeps, settleAll, settleBehind, checkpointState, step, chain, problemText, rawSidAt, packProblems, unpackProblems };
}
