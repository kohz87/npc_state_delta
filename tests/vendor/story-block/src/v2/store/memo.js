// Story Suite v2: what the store keeps of what it has read, moved out of createStore unchanged: the head state and its cache
// (current, retain), the state at an earlier carrier (memoAt), the memos a long chat is read through and when they are forgotten
// (forgetMemos, lineOf, frozenReceipts), the timeline witness memo of one generation (witnessKeyOf, walkChat, witnessEnv, witnessHolds,
// witnessGeneration, prefixWitnessUncached), and the record helpers a write builds on (carrierAt, baseFor, stateBefore, needsCheckpoint,
// checkpointSize, take, sidFor, carriedTo, spansOf, spansFor, blockParts, receiptsOf, asOps). `createMemo(s, deps)` is given the store's
// state holder `s` and the store functions it calls (walk.js and replay-blocks.js are wired before it and call it through wrappers);
// `deps.api` is only used as `api.sourceAt(...)`. It never imports store.js.

import { KEY, carrierIndexes, isCarrier, lastCarrier, readRecord, swipeOf } from '../persist.js';
import { isObject, deepFreeze, jsonBytes, CHECKPOINT_MIN_GAP } from './constants.js';
import { hashJson } from '../replay.js';
import { payloadHashOf } from './digest.js';

export function createMemo(s, deps) {
    const { KEPT_ASIDE, WHY, api, appliedOf, archive, blocksBefore, chain, chainHash, chatId, checkpointBytes, checkpointEvery, checkpointState, headKey, list, markNow, marked, metadata, packOwners, packProblems, preservedAt, proofBefore, proofsBefore, rawKind, rawSidAt, recordId, replay, replayEnv, replayRecord, sameKey, settleBehind, sourceFor, spineBefore, stillHolds, windowHash } = deps;

    // Memos of what a reply reads over the whole chat (docs/v2/PERFORMANCE.md, "Long chats"): the stored
    // receipts and the untold ones, each kept until a record is written or the store rebuilds (`epoch`) or
    // the chat's last carrier, length or array changes (headKey); the state at an earlier carrier, kept
    // while the messages it was replayed from are the same objects with the same records and text.
    const AT_MEMO_MAX = 64;

    function current() {
        const arr = list();
        const key = headKey(arr);
        if (s.guardSeen) {
            const mark = markNow();
            if (mark !== s.lastMark) {
                s.lastMark = mark;
                s.cache = null;
                forgetMemos();
            }
        }
        if (s.cache && !sameKey(s.cache.key, key) && stillHolds(arr, key)) {
            s.cache = { ...s.cache, key };
            s.known = carrierIndexes(arr).map(i => arr[i]);
        }
        if (!s.cache || !sameKey(s.cache.key, key)) {
            s.replanFrom = Infinity;
            const { state, problems, applied = [], from = -1 } = key.index < 0 ? { state: null, problems: [] } : replay(arr, key.index);
            const kept = !state && s.fallback ? preservedAt(arr, true) : null;
            s.cache = { key, state: kept ? s.fallback : state, problems, applied, from, ...(kept ? { readOnly: kept } : {}) };
            if (state) s.known = carrierIndexes(arr).map(i => arr[i]);
        }
        return s.cache;
    }

    // After a write that changed the head carrier's record: keep the cache, with the new key.
    // `applied`: the proof of the blocks that applied since the replay began (cache.applied), as it is after this write: undefined
    // keeps it, null says it is not known (the next read works it out again).
    function retain(arr, state, problems = s.cache?.problems ?? [], applied = s.cache?.applied ?? null) {
        s.cache = { key: headKey(arr), state, problems, applied, from: s.cache?.from ?? -1, ...(s.cache?.readOnly && s.cache.state === state ? { readOnly: s.cache.readOnly } : {}) };
    }

    function carrierAt(arr, index) {
        if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
            throw new RangeError(`There is no message ${index} in this chat.`);
        }
        if (!isCarrier(arr[index])) throw new RangeError(`Message ${index} is the user's; it holds no story state.`);
        return arr[index];
    }

    // The state after carrier `index` (not the head), replayed once and then kept (atMemo) while every
    // message it was replayed from (its checkpoint's carrier through `index`) is the same object at the same
    // place with the same record, swipe and text. A card drawn again, or a card under each of several replies
    // on screen, then costs a look at those messages, not a replay with every domain's validator.
    function memoAt(arr, index) {
        const hit = s.atMemo.get(index);
        if (hit && hit.arr === arr && hit.refs.every(([message, record, swipe, mes], at) => {
            const now = arr[hit.from + at];
            return now === message && now?.extra?.[KEY] === record && now?.swipe_id === swipe && now?.mes === mes;
        })) {
            s.atMemo.delete(index);
            s.atMemo.set(index, hit);
            return hit.state;
        }
        const { state, from = -1 } = replay(arr, index);
        if (from >= 0) {
            const refs = [];
            for (let i = from; i <= index; i++) refs.push([arr[i], arr[i]?.extra?.[KEY], arr[i]?.swipe_id, arr[i]?.mes]);
            s.atMemo.delete(index);
            s.atMemo.set(index, { arr, from, refs, state });
            while (s.atMemo.size > AT_MEMO_MAX) s.atMemo.delete(s.atMemo.keys().next().value);
        }
        return state;
    }

    // A record's receipts as frozen copies, made once per record (a record is never changed in place: each
    // write puts a new one), so a pass over the chat copies only the receipts it has not seen yet.
    function frozenReceipts(record) {
        let list = s.receiptCopies.get(record);
        if (!list) s.receiptCopies.set(record, list = deepFreeze(structuredClone(record.receipts.filter(isObject))));
        return list;
    }

    // Forgets the memos (a rebuild, or a write that is not on the head carrier alone).
    function forgetMemos() {
        s.epoch++;
        s.tail = null;
        s.lineMemo = null;
        s.atMemo = new Map();
        s.witnessGen = null;
    }

    // The timeline asks for the witness of every archived boundary on every read (sdk.query → settle → selectionPlan), and each
    // answer is a replay of that prefix plus hashes. Everything an answer reads is the same for all boundaries of one chat: the
    // chat's messages (their records, swipes, text and swipe copies), the guards' mark, the chat/metadata it is read in, the source
    // archive, the Features. So ONE generation holds that fingerprint once, checked once per call, and each boundary keeps only its
    // answer in it. The generation changes (and every answer of the old one is dropped) when anything it read is not the same:
    // another array or a message's record, swipe, text or swipe copies differing, another `epoch` (any write, rebuild, guard or
    // lifecycle change bumps it), mark, chat id, metadata, archive or Features. The memo holds every boundary of the generation (no
    // cap: the boundaries are the archive's, which the timeline walks in full each query); it is not read or written while a replay
    // is running (`applying`) or a Re-read's overlay is staged (`staged`). A caller gets a new object each time; the state in it is
    // deep-frozen.
    function witnessKeyOf(cursor) {
        if (!isObject(cursor) || typeof cursor.sid !== 'string' || typeof cursor.swipeKey !== 'string' || !Number.isSafeInteger(cursor.op)) return null;
        return `${cursor.sid}\u0000${cursor.swipeKey}\u0000${cursor.op}`;
    }

    // Every input of the chat the witness reads, as a flat list of values compared with ===. `visit` returns false to stop.
    function walkChat(arr, visit) {
        if (!visit(arr.length)) return false;
        for (const message of arr) {
            const info = message?.swipe_info;
            const infos = Array.isArray(info) ? info : null;
            if (!visit(message) || !visit(message?.extra) || !visit(message?.extra?.[KEY]) || !visit(message?.swipe_id) || !visit(message?.mes)
                || !visit(message?.is_user) || !visit(info) || !visit(infos?.length)) return false;
            if (infos) for (const each of infos) if (!visit(each?.extra?.[KEY])) return false;
        }
        return true;
    }

    // What else a replay's answer may hang on (the Features the reader has on: they change what the registry validates and scratches).
    const envNow = () => { try { return String(replayEnv()); } catch { return '?'; } };
    const metaNow = () => { try { return metadata(); } catch { return null; } };
    const markSeen = () => (s.guardSeen ? markNow() : '');

    function witnessEnv(arr) {
        const fingerprint = [];
        walkChat(arr, value => { fingerprint.push(value); return true; });
        return { epoch: s.epoch, arr, mark: markSeen(), chatId: chatId(), meta: metaNow(), archived: archive().size, marked: marked(), env: envNow(), fingerprint, answers: new Map() };
    }

    function witnessHolds(gen, arr) {
        if (gen.epoch !== s.epoch || gen.arr !== arr || gen.chatId !== chatId() || gen.marked !== marked() || gen.env !== envNow() || gen.archived !== archive().size) return false;
        if (gen.meta !== metaNow() || gen.mark !== markSeen()) return false;
        let at = 0;
        return walkChat(arr, value => gen.fingerprint[at++] === value) && at === gen.fingerprint.length;
    }

    // Inside `witnessScope` (one synchronous, read-only pass over many boundaries) the chat cannot change under the reader but through
    // a write or a lifecycle change, which move `epoch`: the generation is checked in full once at the start, then by `epoch` and
    // array alone.
    function witnessGeneration(arr) {
        if (s.witnessScoped && s.witnessGen && s.witnessScoped.gen === s.witnessGen && s.witnessScoped.epoch === s.epoch && s.witnessGen.arr === arr) return s.witnessGen;
        if (!s.witnessGen || !witnessHolds(s.witnessGen, arr)) s.witnessGen = witnessEnv(arr);
        if (s.witnessScoped) s.witnessScoped = { gen: s.witnessGen, epoch: s.epoch };
        return s.witnessGen;
    }

    // The memo of the whole line of history (receipts, untold) for the chat as it is now.
    function lineOf(arr) {
        const key = headKey(arr);
        if (!s.lineMemo || s.lineMemo.epoch !== s.epoch || !sameKey(s.lineMemo.key, key)) s.lineMemo = { epoch: s.epoch, key };
        return s.lineMemo;
    }

    // The state carrier `index`'s own ops start from: the state after the carrier before it, replayed through the
    // chain (a checkpoint that does not hold is never used), or, when nothing is before it, its own checkpoint if
    // the chain trusts it. Re-read, reconcile and rewind start here (not from whatever the record says it starts from).
    function baseFor(arr, index) {
        const before = stateBefore(arr, index);
        if (before) return before;
        const record = readRecord(arr[index]);
        return record?.checkpoint && chain(arr, index).from === index ? checkpointState(record.checkpoint) : null;
    }

    function stateBefore(arr, index) {
        const prev = lastCarrier(arr, index);
        return prev < 0 ? null : replay(arr, prev).state;
    }

    // Does a new record on carrier `index` need a checkpoint? Counts the carriers and the op JSON since
    // the last checkpoint before it: due after `checkpointEvery` carriers, or once the ops exceed
    // `checkpointBytes` and twice the last checkpoint's size, `CHECKPOINT_MIN_GAP` carriers on at least.
    function needsCheckpoint(arr, index) {
        let carriers = 0;
        let bytes = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            carriers++;
            const record = readRecord(arr[i]);
            if (record?.ops.length) bytes += jsonBytes(record.ops);
            if (record?.checkpoint) {
                if (carriers >= checkpointEvery) return true;
                const gap = Math.min(CHECKPOINT_MIN_GAP, checkpointEvery);
                return carriers >= gap && bytes > Math.max(checkpointBytes, 2 * checkpointSize(record.checkpoint));
            }
            if (carriers >= checkpointEvery) return true;
        }
        return false;
    }

    // A checkpoint's JSON size, worked out once per stored checkpoint.
    function checkpointSize(raw) {
        let size = s.checkpointBytesOf.get(raw);
        if (size === undefined) s.checkpointBytesOf.set(raw, size = jsonBytes(raw));
        return size;
    }

    // The carrier's record to build on: its own, or a fresh one (with a checkpoint when one is due).
    // `before` is the state before the carrier when the caller already has it.
    function take(arr, index, before) {
        const message = carrierAt(arr, index);
        const own = readRecord(message);
        if (own) return { message, record: own, fresh: false };
        // A record that is not ours is never taken for an absent one: it would be written over.
        const there = message.extra?.[KEY];
        if (KEPT_ASIDE.has(rawKind(there))) throw new Error(`The story record on this reply ${WHY[rawKind(there)](there)}; it is kept as it is and not written over.`);
        const sid = sidFor(message);
        const record = { v: 2, sid, ops: [], receipts: [], narrated: [], spans: [], source: sourceFor(arr, message, sid) };
        if (marked()) record.mv = 1;   // (the reply mark's version, only while hand-set gear is on: a chat that never used it keeps its bytes; runtime.js greetingOnly)
        if (index === lastCarrier(arr)) settleBehind(arr, index);
        if (needsCheckpoint(arr, index)) {
            const base = before === undefined ? stateBefore(arr, index) : before;
            if (base) {
                const { since, members, history } = chain(arr, index - 1);
                record.checkpoint = structuredClone(base);
                record.prefix = spineBefore(arr, index);
                const prior = index === lastCarrier(arr) ? current().problems : replay(arr, index - 1).problems;
                const carried = packProblems(prior.filter(problem => problem.index < index), i => rawSidAt(arr, i));
                if (carried.length) record.carried = carried;
                // The blocks before it that applied (the proof of an id belongs to the one that applied with it).
                const head = index === lastCarrier(arr) ? current() : replay(arr, index - 1);
                if (head.state && !head.readOnly && proofBefore(arr, index)) {
                    record.owned = packOwners([...proofsBefore(arr, head.from), ...appliedOf(arr, head)].filter(entry => entry.index < index), i => rawSidAt(arr, i));
                }
                record.covers = since;
                if (history) record.guardEnv = markNow();
                const hash = windowHash(arr, members);
                if (hash !== undefined) record.coverHash = hash;
            }
        }
        return { message, record, fresh: true };
    }

    // The ID a new record on this message's shown swipe gets: the one handed out by carrierSid(), if any.
    function sidFor(message) {
        const kept = s.reserved.get(message);
        s.reserved.delete(message);
        return kept && kept.swipe === swipeOf(message) ? kept.sid : recordId();
    }

    // B-b2-timeline-3: the state the first carrier starts from when the carriers before it were deleted:
    // what they ended with, as the store last saw them (their message objects still hold their records).
    // The deleted replies are replayed whole, from the first one's checkpoint: a later checkpoint among them holds what their
    // blocks did without asking them, and a block that must not outlive its reply (a reply-bound guard) is asked here again.
    function carriedTo(message) {
        const at = s.known ? s.known.indexOf(message) : -1;
        if (at <= 0) return null;
        const { state } = replay(s.known, at - 1, { whole: true });
        return state ? structuredClone(state) : null;
    }

    function spansOf(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans.some(span => span?.mixed) ? null : spans;
        // A record without usable spans: fine as one kept block if it holds no story receipts.
        if (!record.receipts.some(receipt => receipt?.cause === 'story')) return [{ n: record.ops.length, story: false }];
        return null;
    }

    // C1-1: the spans a new block is added after. A record whose spans do not add up is replayed as one
    // block (blockParts); it stays one block, `mixed` (its story changes cannot be told apart, so Re-read
    // still refuses it), and the new block is one of its own, so a bad op in the old ones cannot take it
    // with them on the next rebuild.
    function spansFor(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) && span.n >= 0 ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans;
        return spansOf(record) ?? (record.ops.length ? [{ n: record.ops.length, story: true, mixed: true }] : []);
    }

    // The record's ops in the blocks they were stored in: one per append (one receipt), one for a
    // Re-read's story changes, each with its span. A record whose spans are missing or do not add up is one
    // block (and has no span to read).
    function blockParts(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const fits = spans && spans.every(span => Number.isInteger(span?.n) && span.n >= 0)
            && spans.reduce((sum, span) => sum + span.n, 0) === record.ops.length;
        if (!fits) return record.ops.length ? [{ ops: record.ops, span: null }] : [];
        const out = [];
        let at = 0;
        for (const span of spans) {
            if (span.n) out.push({ ops: record.ops.slice(at, at + span.n), span });
            at += span.n;
        }
        return out;
    }

    // The IDs of the receipts whose changes are `ops` (each receipt's ops end with its /meta/rev op).
    function receiptsOf(record, ops) {
        const revs = new Set(ops.filter(op => op?.path === '/meta/rev').map(op => op.value));
        return record.receipts.filter(receipt => revs.has(receipt?.rev)).map(receipt => receipt.id);
    }

    function asOps(ops) {
        if (ops === undefined || ops === null) return [];
        if (!Array.isArray(ops)) throw new TypeError('Ops must be an array.');
        return structuredClone(ops);
    }

    function prefixWitnessUncached(arr, cursor) {
        const matches = carrierIndexes(arr).filter(index => {
            const source = api.sourceAt(index);
            return source?.sid === cursor.sid && source?.swipeKey === cursor.swipeKey;
        });
        if (matches.length !== 1) return null;
        const index = matches[0];
        const record = readRecord(arr[index]);
        if (!record || !Number.isSafeInteger(cursor.op) || cursor.op < 0) return null;
        const parts = blockParts(record);
        const earlier = [];
        let count = 0;
        for (const part of parts) {
            if (count === cursor.op) break;
            count += part.ops.length;
            earlier.push(part);
        }
        if (count !== cursor.op) return null;
        const base = baseFor(arr, index);
        if (!base) return null;
        const ops = earlier.flatMap(part => part.ops);
        const revs = new Set(ops.filter(op => op.path === '/meta/rev').map(op => op.value));
        const state = replayRecord(base, { ...record, ops, spans: earlier.map(part => ({ ...part.span, n: part.ops.length })), receipts: record.receipts.filter(receipt => revs.has(receipt.rev)) }, index, [], null, arr[index]);
        return {
            index, op: count, state,
            prefixHash: hashJson({ p: chainHash(arr, index), k: cursor.swipeKey, t: payloadHashOf(arr[index]), b: blocksBefore(earlier) }),
        };
    }

    return { current, retain, carrierAt, memoAt, frozenReceipts, forgetMemos, witnessKeyOf, markSeen, witnessGeneration, lineOf, baseFor, stateBefore, take, sidFor, carriedTo, spansOf, spansFor, blockParts, receiptsOf, asOps, prefixWitnessUncached };
}
