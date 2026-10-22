// Story Suite v2: the state store (SPEC §2, §12). State lives in carriers; this module replays it.
//
// * State at carrier N = the latest checkpoint at or before N, then every carrier's `ops` from there
//   through N. Head state = state at the last carrier. Rebuilding replays stored ops only; it never runs a
//   command handler.
// * A carrier that gets its first record also gets a checkpoint (the state before its own ops) when 100
//   carriers have passed since the last checkpoint, or the ops since then exceed 128 KB of JSON. Older
//   chats have them every 20 carriers / 32 KB: a checkpoint is read wherever it is.
// * Writes go to the head carrier (actions after reply N belong to reply N, so swiping or deleting reply N
//   takes them back) and only ever touch `extra.storySuite` and the matching `swipe_info` extra.
// * Each record is kept once (persist.js): the shown swipe's copy in `swipe_info` only on the last
//   carrier and on carriers with more than one swipe. When a reply gets its first record, the carrier
//   before it drops that copy, and the carrier `receiptKeep` back drops its receipts' `data`; a rebuild
//   does the same over the whole chat (so an older chat shrinks with its next save) and gives the last
//   carrier its copy back. Neither changes any state: replay reads `message.extra` only.
// * Told and untold (§4.1 step 2): a receipt is told once a carrier at or after its own lists its ID in
//   `narrated`. Untold receipts are the `narrate: true` ones that no such carrier lists, oldest first. "At
//   or after" rather than "after" so a cue committed on the head carrier while it is being re-generated
//   (a swipe) counts as told by that same carrier.
// * Replay goes block by block (`spans`: one block per stored receipt, one for a Re-read's story changes):
//   a block that no longer applies (a middle reply deleted, a hand-edited chat) is skipped and reported
//   alone; its receipts' revs still count. Everything stored before and after it still applies, so a
//   command committed onto such a carrier survives the next rebuild, and so does its claim.
// * Every state handed out is deep-frozen. The head and the checkpoints are cached; the cache is checked
//   against the chat on each read, and `rebuild()` drops it.

import { apply as applyOps, rebaseOps } from './ops.js';
import {
    KEY, RECEIPT_KEEP, carrierIndexes, carryRecord, createSaver, dropCopy, isCarrier, keepsCopy, lastCarrier,
    newRecordId, readRecord, recordFault, restamp, restoreCopy, swipeOf, trimReceipts, writeRecord,
} from './persist.js';

export const CHECKPOINT_EVERY = 100;
export const CHECKPOINT_BYTES = 128 * 1024;
// The bytes rule never puts checkpoints closer than this many carriers, and waits for at least twice
// the last checkpoint's own size of ops: one domain that rewrites a large list whole on every reply
// cannot make every few replies write the whole state again (b6-soak).
export const CHECKPOINT_MIN_GAP = 10;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();
const jsonBytes = value => utf8.encode(JSON.stringify(value)).length;

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

const revOf = state => (Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0);

/**
 * @param {object} options
 * @param {() => object[]} options.chat     the live chat array (SillyTavern's `chat`)
 * @param {(target, options) => Promise<void>} options.save  saves the open chat; it must start writing
 *     before it returns (see createSaver). `target` = { chatId, place, carrier } of the newest change.
 * @param {() => string} [options.chatId]    the open chat's ID (SillyTavern's getCurrentChatId)
 * @param {() => *} [options.place]          where the open chat is saved (kept in a change's target for rescue)
 * @param {(target, entries) => Promise<void>} [options.rescue]  writes changes made in a chat that is no
 *     longer open into that chat's file; `entries` = [{ message, index }] of the messages written
 * @param {{ holds, fresh, restore, forget }} [options.confirm]  after a write timed out: reads the stamped
 *     file back, so a late write of the timed-out one is found and put right (persist.js createSaver)
 * @param {{ get(chatId), set(chatId, value) }} [options.memo]  keeps a suspect chat's read-backs over a reload
 * @param {() => number} [options.now]       accepted for the §12 interface; the store keeps no clock
 * @param {(state, ops) => object} [options.apply]  defaults to ops.js; tests inject a fake
 * @param {(error) => void} [options.onSaveError]   told when a scheduled (not flushed) save fails, once until one works
 * @param {object} [options.timers]          { setTimeout, clearTimeout } for tests
 * @param {number} [options.checkpointEvery] / [options.checkpointBytes]  thresholds (default 100 / 128 KB)
 * @param {number} [options.receiptKeep]     carriers back (the head is 0) from which receipts drop `data` (200)
 * @param {() => string} [options.recordId]  ID of a new carrier record
 * @param {(state, domains: string[]) => string[]} [options.validate]  the domains' validators, run on a
 *   state whose counts were moved by a replay (ops.js rebaseOps), and on every replayed block's touched
 *   domains; a problem the block brings skips that block
 * @param {(domain: string) => string[]} [options.scratch]  a domain's per-reply scratch fields (ops.js)
 */
export function createStore({
    chat, save, now = null, apply = applyOps, onSaveError = null, timers = globalThis,
    checkpointEvery = CHECKPOINT_EVERY, checkpointBytes = CHECKPOINT_BYTES, recordId = newRecordId, validate = null,
    chatId = () => undefined, place = () => null, rescue = null, scratch = null, receiptKeep = RECEIPT_KEEP,
    confirm = null, memo = null,
} = {}) {
    if (typeof chat !== 'function') throw new TypeError('createStore needs a chat() function.');
    if (typeof apply !== 'function') throw new TypeError('createStore needs an apply(state, ops) function.');
    void now;
    let frozenCheckpoints = new WeakMap();
    const checkpointBytesOf = new WeakMap();
    let cache = null;          // { key, state, problems }
    let lastWrite = null;      // { message, swipe, sid, rev } of the last record written, for save verification
    let holding = 0;           // inside batch(): swipe_info copies wait until it ends
    const held = new Set();
    let known = null;          // the carriers (message objects) the last good head was built from
    let writes = 0;
    const unsaved = new Map(); // message → { index, chatId, n }: records written since their chat was saved
    const reserved = new WeakMap();   // message → { swipe, sid }: a record ID handed out before the record
    // Memos of what a reply reads over the whole chat (docs/v2/PERFORMANCE.md, "Long chats"): the stored
    // receipts and the untold ones, each kept until a record is written or the store rebuilds (`epoch`) or
    // the chat's last carrier, length or array changes (headKey); the state at an earlier carrier, kept
    // while the messages it was replayed from are the same objects with the same records and text.
    let epoch = 0;
    let lineMemo = null;       // { epoch, key, receipts?, untold? }
    let atMemo = new Map();    // index → { arr, epoch, from, refs: [message, record, swipe, mes][], state }
    const AT_MEMO_MAX = 64;
    const counts = { replays: 0, recordsRead: 0, lineScans: 0 };

    // Every record goes through here, so a save can be checked against the last one written, and a change
    // left in a chat that is no longer open can be found again (rescue).
    function write(message, record) {
        epoch++;
        if (holding) held.add(message);
        const keep = keeps(message);
        const stored = writeRecord(message, record, { mirror: !holding && keep });
        if (!keep) dropCopy(message);
        lastWrite = { message, swipe: stored.swipe, sid: stored.sid, rev: stored.rev };
        unsaved.set(message, { index: list().indexOf(message), chatId: chatId(), n: ++writes });
        return stored;
    }

    function forget(id, upTo) {
        for (const [message, entry] of unsaved) if (entry.chatId === id && entry.n <= upTo) unsaved.delete(message);
    }

    // B-b2-timeline-1: the chat a change belongs to, taken when it is made, and checked right before the
    // save starts. SillyTavern opens another chat by emptying this same array, then setting the new
    // chat's name, then reading it from the server: a save in between would write the wrong chat.
    function target() {
        const arr = list();
        return { chatId: chatId(), place: place(), carrier: arr[lastCarrier(arr)] ?? null };
    }
    function check(change) {
        const arr = list();
        if (chatId() !== change.chatId) return { moved: 'another chat is open' };
        if (!arr.length) return { wait: 'a chat is being opened' };
        if (change.carrier && !arr.includes(change.carrier)) {
            let left = false;
            for (const [message, entry] of unsaved) {
                if (entry.chatId !== change.chatId) continue;
                if (arr.includes(message)) left = true;
                // The same chat read again (a reload, or opened again before the save): the change goes
                // onto the same message as read back, when it still is that message.
                else if (carryRecord(message, arr[entry.index])) {
                    unsaved.delete(message);
                    unsaved.set(arr[entry.index], { ...entry, n: ++writes });
                    cache = null;
                    forgetMemos();
                    left = true;
                }
            }
            return left ? '' : { gone: 'the reply that held the change is no longer in the chat' };
        }
        return '';
    }

    // SPEC §3.3: after a save, the carrier last written must still hold the rev it was given. If
    // something replaced it while the save ran, the save counts as failed (the story stays marked
    // unsaved and the reader is told); the next save writes the chat as it is then.
    const verify = {
        before: () => lastWrite,
        after(token) {
            if (!token) return '';
            const arr = list();
            const index = arr.indexOf(token.message);
            if (index < 0) return '';   // deleted, or another chat: nothing of this one to check
            const message = token.message;
            const extra = swipeOf(message) === token.swipe ? message.extra : message.swipe_info?.[token.swipe]?.extra;
            let rev = extra?.[KEY]?.rev;
            // C1-2: an earlier swipe deleted since moved the record to another index (restamp): it is
            // found by its record ID, shown or in its swipe's copy.
            if (rev !== token.rev && typeof token.sid === 'string' && extra?.[KEY]?.sid !== token.sid) {
                const held = [message.extra, ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(info => info?.extra) : [])]
                    .map(where => where?.[KEY]).filter(record => isObject(record) && record.sid === token.sid);
                if (held.some(record => record.rev === token.rev)) return '';
                if (held.length) rev = held[0].rev;
            }
            if (rev === token.rev) return '';
            if (lastWrite === token) lastWrite = null;
            return `The story was saved, but message ${index} no longer holds its latest changes (change ${rev ?? 'none'} instead of ${token.rev ?? 'none'}); the story stays marked unsaved.`;
        },
    };
    const saver = createSaver({
        save: (change, options) => {
            const upTo = writes;
            return Promise.resolve(save(change, options)).then(result => {
                forget(change ? change.chatId : chatId(), upTo);
                return result;
            });
        },
        rescue: typeof rescue === 'function' ? (change, options = {}) => {
            const entries = [...unsaved].filter(([, entry]) => entry.chatId === change.chatId)
                .map(([message, entry]) => ({ message, index: entry.index }));
            return Promise.resolve(rescue(change, entries, options)).then(result => {
                forget(change.chatId, Infinity);
                return result;
            });
        } : null,
        target, check, onError: onSaveError, timers, verify, confirm, memo,
    });

    const list = () => {
        const arr = chat();
        return Array.isArray(arr) ? arr : [];
    };

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
        let state = frozenCheckpoints.get(raw);
        if (!state) frozenCheckpoints.set(raw, state = deepFreeze(structuredClone(raw)));
        return state;
    }

    // Ops are cloned on the way in so nothing the chat holds ends up inside (and frozen with) a state.
    // A count that stands elsewhere than when the op was made (a reply before it was deleted) takes the
    // op's change rather than its number (ops.js rebaseOps, B3-8), and per-reply scratch fits what is
    // there (ops.js scratch); the domains whose counts moved are checked by their validators, and a
    // problem there throws (the block is skipped and reported). With `replayed` (a stored block replayed,
    // r2-14) every domain the block touches is checked too: a block that leaves one invalid (a stack
    // whose definition a deleted reply made) throws the same way. Only problems the block brings count,
    // so a chat stored before a validator grew stricter still replays.
    function step(state, ops, { replayed = false } = {}) {
        if (!ops.length) return state;
        const { ops: rebased, rebased: moved } = rebaseOps(state, ops, { scratch, replayed });
        const next = deepFreeze(apply(state, structuredClone(rebased)));
        if (typeof validate !== 'function') return next;
        const names = new Set(moved);
        if (replayed) for (const op of rebased) if (/^\/domains\/[^/]/.test(op?.path ?? '')) names.add(op.path.split('/')[2].replace(/~1/g, '/').replace(/~0/g, '~'));
        if (!names.size) return next;
        const list = [...names].filter(name => next?.domains?.[name] !== undefined).sort();
        const problems = list.length ? validate(next, list) ?? [] : [];
        if (!problems.length) return next;
        const before = new Set(validate(state, list.filter(name => state?.domains?.[name] !== undefined)) ?? []);
        const brought = problems.filter(problem => !before.has(problem));
        if (brought.length) {
            throw new Error(moved.size
                ? `Taken onto the counts as they stand now, these changes no longer fit: ${brought.join(' ')}`
                : `Taken onto the story as it stands now, these changes no longer fit: ${brought.join(' ')}`);
        }
        return next;
    }

    // The checkpoint to replay from for carrier `upTo` and the records after it (B2-4). Each checkpoint
    // lists the records it was made over (`covers`: the record IDs from the checkpoint before it up to
    // itself), so one made before a reply was deleted, or another swipe was shown, is passed over: the
    // replay starts from an earlier one that still holds. A checkpoint without `covers` (older records,
    // the first one) is trusted. When no checkpoint holds, the latest one is used, as before.
    // → { from: index | -1, since: the record IDs from `from` through `upTo` }.
    function chain(arr, upTo) {
        let from = -1;
        let latest = -1;
        let since = [];
        const last = Math.min(upTo, arr.length - 1);
        for (let i = 0; i <= last; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = readRecord(arr[i]);
            if (!record) continue;
            if (record.checkpoint) {
                latest = i;
                const covers = Array.isArray(record.covers) ? record.covers : null;
                if (!covers || (from >= 0 && covers.length === since.length && covers.every((sid, at) => sid === since[at]))) {
                    from = i;
                    since = [];
                }
            }
            since.push(record.sid);
        }
        if (from < 0 && latest >= 0) {
            from = latest;
            since = [];
            for (let i = latest; i <= last; i++) if (isCarrier(arr[i]) && readRecord(arr[i])) since.push(readRecord(arr[i]).sid);
        }
        return { from, since };
    }

    // State after the last carrier at or before `upTo`, or null when no checkpoint precedes it. A block
    // of ops that no longer applies (a hand-edited chat, a middle reply deleted) is skipped and reported
    // on its own, so a bad change cannot take the rest of its carrier, or anything later, with it.
    function replay(arr, upTo) {
        counts.replays++;
        const { from } = chain(arr, upTo);
        // A damaged record (B-b2-timeline-7) is skipped, and said so.
        const problems = [];
        for (let i = Math.max(from, 0); i <= upTo && i < arr.length; i++) {
            const fault = recordFault(arr[i]);
            if (fault) {
                problems.push({ index: i, block: null, receipts: [], why: fault, code: 'DAMAGED',
                    message: `The story record on message ${i} is damaged and was skipped: ${fault}.` });
            }
        }
        if (from < 0) return { state: null, problems };
        let state = checkpointState(readRecord(arr[from]).checkpoint);
        for (let i = from; i <= upTo && i < arr.length; i++) {
            const record = readRecord(arr[i]);
            if (!record) continue;
            counts.recordsRead++;
            state = replayRecord(state, record, i, problems);
        }
        return { state, problems, from };
    }

    // One carrier's ops, block by block. `skip` (a Set of "index:block") names blocks to pass over
    // without trying them (Re-read keeps blocks that were already skipped skipped).
    function replayRecord(state, record, index, problems, skip = null) {
        blocksOf(record).forEach((ops, block) => {
            if (skip?.has(`${index}:${block}`)) {
                state = skipped(state, ops);
                return;
            }
            try {
                state = step(state, ops, { replayed: true });
            } catch (error) {
                const why = String(error?.message ?? error);
                problems.push({
                    index, block, receipts: receiptsOf(record, ops), why,
                    message: `Some changes stored on message ${index} no longer apply and were skipped: ${why}`,
                });
                state = skipped(state, ops);
            }
        });
        return state;
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

    const sameKey = (a, b) => Object.keys(a).every(name => a[name] === b[name]);

    // The cached head still holds when all that changed is messages after its carrier that hold no
    // record (the reader's next message, a reply not read yet): replaying them would give it again.
    function stillHolds(arr, key) {
        const old = cache?.key;
        if (!cache?.state || old.arr !== arr || old.index < 0 || key.index < old.index || arr.length < old.length) return false;
        const message = arr[old.index];
        if (message !== old.message || message?.swipe_id !== old.swipe || message?.extra !== old.extra || message?.extra?.[KEY] !== old.record) return false;
        for (let i = old.index + 1; i < arr.length; i++) if (arr[i]?.extra?.[KEY] !== undefined) return false;
        return true;
    }

    function current() {
        const arr = list();
        const key = headKey(arr);
        if (cache && !sameKey(cache.key, key) && stillHolds(arr, key)) {
            cache = { ...cache, key };
            known = carrierIndexes(arr).map(i => arr[i]);
        }
        if (!cache || !sameKey(cache.key, key)) {
            const { state, problems } = key.index < 0 ? { state: null, problems: [] } : replay(arr, key.index);
            cache = { key, state, problems };
            if (state) known = carrierIndexes(arr).map(i => arr[i]);
        }
        return cache;
    }

    // After a write that changed the head carrier's record: keep the cache, with the new key.
    function retain(arr, state, problems = cache?.problems ?? []) {
        cache = { key: headKey(arr), state, problems };
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
        const hit = atMemo.get(index);
        if (hit && hit.arr === arr && hit.refs.every(([message, record, swipe, mes], at) => {
            const now = arr[hit.from + at];
            return now === message && now?.extra?.[KEY] === record && now?.swipe_id === swipe && now?.mes === mes;
        })) {
            atMemo.delete(index);
            atMemo.set(index, hit);
            return hit.state;
        }
        const { state, from = -1 } = replay(arr, index);
        if (from >= 0) {
            const refs = [];
            for (let i = from; i <= index; i++) refs.push([arr[i], arr[i]?.extra?.[KEY], arr[i]?.swipe_id, arr[i]?.mes]);
            atMemo.delete(index);
            atMemo.set(index, { arr, from, refs, state });
            while (atMemo.size > AT_MEMO_MAX) atMemo.delete(atMemo.keys().next().value);
        }
        return state;
    }

    // A record's receipts as frozen copies, made once per record (a record is never changed in place: each
    // write puts a new one), so a pass over the chat copies only the receipts it has not seen yet.
    const receiptCopies = new WeakMap();
    function frozenReceipts(record) {
        let list = receiptCopies.get(record);
        if (!list) receiptCopies.set(record, list = deepFreeze(structuredClone(record.receipts.filter(isObject))));
        return list;
    }

    // Forgets the memos (a rebuild, or a write that is not on the head carrier alone).
    function forgetMemos() {
        epoch++;
        lineMemo = null;
        atMemo = new Map();
    }

    // The memo of the whole line of history (receipts, untold) for the chat as it is now.
    function lineOf(arr) {
        const key = headKey(arr);
        if (!lineMemo || lineMemo.epoch !== epoch || !sameKey(lineMemo.key, key)) lineMemo = { epoch, key };
        return lineMemo;
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
        let size = checkpointBytesOf.get(raw);
        if (size === undefined) checkpointBytesOf.set(raw, size = jsonBytes(raw));
        return size;
    }

    // The carrier's record to build on: its own, or a fresh one (with a checkpoint when one is due).
    // `before` is the state before the carrier when the caller already has it.
    function take(arr, index, before) {
        const message = carrierAt(arr, index);
        const own = readRecord(message);
        if (own) return { message, record: own, fresh: false };
        const record = { v: 2, sid: sidFor(message), ops: [], receipts: [], narrated: [], spans: [] };
        if (index === lastCarrier(arr)) settleBehind(arr, index);
        if (needsCheckpoint(arr, index)) {
            const base = before === undefined ? stateBefore(arr, index) : before;
            if (base) {
                record.checkpoint = structuredClone(base);
                record.covers = chain(arr, index - 1).since;
            }
        }
        return { message, record, fresh: true };
    }

    // The ID a new record on this message's shown swipe gets: the one handed out by carrierSid(), if any.
    function sidFor(message) {
        const kept = reserved.get(message);
        reserved.delete(message);
        return kept && kept.swipe === swipeOf(message) ? kept.sid : recordId();
    }

    // B-b2-timeline-3: the state the first carrier starts from when the carriers before it were deleted:
    // what they ended with, as the store last saw them (their message objects still hold their records).
    function carriedTo(message) {
        const at = known ? known.indexOf(message) : -1;
        if (at <= 0) return null;
        const { state } = replay(known, at - 1);
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
    // block (blocksOf); it stays one block, `mixed` (its story changes cannot be told apart, so Re-read
    // still refuses it), and the new block is one of its own, so a bad op in the old ones cannot take it
    // with them on the next rebuild.
    function spansFor(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) && span.n >= 0 ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans;
        return spansOf(record) ?? (record.ops.length ? [{ n: record.ops.length, story: true, mixed: true }] : []);
    }

    // The record's ops in the blocks they were stored in: one per append (one receipt), one for a
    // Re-read's story changes. A record whose spans are missing or do not add up is one block.
    function blocksOf(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const fits = spans && spans.every(span => Number.isInteger(span?.n) && span.n >= 0)
            && spans.reduce((sum, span) => sum + span.n, 0) === record.ops.length;
        if (!fits) return record.ops.length ? [record.ops] : [];
        const out = [];
        let at = 0;
        for (const span of spans) {
            if (span.n) out.push(record.ops.slice(at, at + span.n));
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

    return {
        head() {
            return current().state;
        },

        at(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
                throw new RangeError(`There is no message ${index} in this chat.`);
            }
            const head = current();
            if (index >= head.key.index) return head.state;
            return memoAt(arr, index);
        },

        headIndex() {
            return lastCarrier(list());
        },

        // Carrier `index`'s own ops (frozen copies), [] for a message with no record.
        opsAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            return deepFreeze(structuredClone(readRecord(arr[index])?.ops ?? []));
        },

        // The JSON Pointers carrier `index`'s ops touched, in first-touched order (for a card's
        // "only what changed" and changed(path)). [] for a message with no record.
        changesAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            const record = readRecord(arr[index]);
            return [...new Set((record?.ops ?? []).map(op => op?.path).filter(path => typeof path === 'string'))];
        },

        // Problems met by the last head rebuild: [{ index, block, receipts, why, message }], one per block
        // of stored ops that no longer applies (`receipts`: the IDs whose changes were skipped).
        problems() {
            return current().problems.map(problem => ({ ...problem, receipts: [...(problem.receipts ?? [])] }));
        },

        // A chat with no state yet gets one on its first carrier. A record already there is never
        // replaced: it gets the starting point it lacks (the state the deleted carriers before it ended
        // with, else `initialState`) and keeps its own changes. Returns notes for the Problems list
        // (a damaged record that was set up again).
        ensureInitial(initialState) {
            if (!isObject(initialState)) throw new TypeError('The initial state must be an object.');
            if (current().state) return [];
            const arr = list();
            const first = carrierIndexes(arr)[0];
            if (first === undefined) return [];
            const message = arr[first];
            const carried = carriedTo(message);
            const checkpoint = carried ?? structuredClone(initialState);
            const raw = message.extra?.[KEY];
            const fault = recordFault(message);
            const lists = isObject(raw) && Array.isArray(raw.ops) && Array.isArray(raw.receipts) && Array.isArray(raw.narrated);
            const own = readRecord(message) ?? (fault && lists ? raw : null);
            const notes = [];
            if (fault) {
                notes.push(own
                    ? `The story record on message ${first} was damaged (${fault}); it starts again from ${carried ? 'the state before it' : 'the story\'s start'} and keeps its own changes.`
                    : `The story record on message ${first} was damaged (${fault}); the story starts again from there.`);
            }
            const record = own
                ? { ...own, sid: typeof own.sid === 'string' ? own.sid : sidFor(message), checkpoint,
                    rev: Number.isInteger(own.rev) ? own.rev : revOf(checkpoint) }
                : { v: 2, sid: sidFor(message), checkpoint, ops: [], receipts: [], narrated: [], spans: [], rev: revOf(checkpoint) };
            write(message, record);
            saver.touch();
            cache = null;
            forgetMemos();
            return notes;
        },

        /**
         * The record ID of carrier `index`'s shown swipe (MODULES §F2's ctx.carrier.sid): its record's,
         * or one handed out now that its first record will get. null for a message that is not a carrier.
         */
        carrierSid(index) {
            const message = list()[index];
            if (!isCarrier(message)) return null;
            const own = readRecord(message);
            if (own) return typeof own.sid === 'string' ? own.sid : null;
            const swipe = swipeOf(message);
            const kept = reserved.get(message);
            if (kept && kept.swipe === swipe) return kept.sid;
            const sid = recordId();
            reserved.set(message, { swipe, sid });
            return sid;
        },

        append({ ops, receipt = null } = {}) {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) throw new Error('There is no reply in this chat to hold the change yet.');
            const base = current().state;
            if (!base) throw new Error('This chat has no story state yet.');
            const added = asOps(ops);
            if (receipt !== null && !isObject(receipt)) throw new TypeError('A receipt must be an object.');
            if (!added.length && !receipt) return;
            const next = step(base, added);       // throws on a bad op: nothing is written
            const { message, record } = take(arr, index, base);
            if (typeof receipt?.id === 'string' && record.receipts.some(known => known?.id === receipt.id)) {
                throw new Error(`Receipt ${receipt.id} is already stored on this reply.`);
            }
            write(message, {
                ...record,
                ops: [...record.ops, ...added],
                receipts: receipt ? [...record.receipts, structuredClone(receipt)] : record.receipts,
                spans: [...spansFor(record), { n: added.length, story: receipt?.cause === 'story' }],
                rev: revOf(next),
            });
            saver.touch();
            retain(arr, next);
        },

        // The state a Re-read of carrier `index` runs its lines on: its own checkpoint when it starts
        // one, else the state after the carrier before it (null without one). Frozen.
        before(index) {
            const arr = list();
            const message = carrierAt(arr, index);
            const startsHere = readRecord(message)?.checkpoint;
            return startsHere ? checkpointState(startsHere) : stateBefore(arr, index);
        },

        // Re-read: the carrier's `story` receipts and their ops are replaced; ui and system receipts stay,
        // after the new story ops. A kept block whose rev (its `/meta/rev` op and its receipt) is not after
        // the new story ops' last one is numbered on from it, so no two receipts on the carrier share one.
        // A kept system step marked `replan` (its receipt's `replan: { payload }`, B-a1-13: planned from the
        // story state, like a story-time heal) is not applied again as it was: `rerun(state, receipt)` runs
        // it again on the state as it now stands at its place (→ { ok, ops, receipt }); when it is not
        // done, its block goes. Later carriers are replayed on top so their checkpoints stay true; if any
        // later change no longer applies, nothing is written and this throws.
        replaceStory(index, { ops, receipts = [], rerun = null } = {}) {
            const arr = list();
            const message = carrierAt(arr, index);
            if (!Array.isArray(receipts) || receipts.some(receipt => !isObject(receipt) || receipt.cause !== 'story')) {
                throw new TypeError('Re-read takes story receipts only.');
            }
            const before = stateBefore(arr, index);
            const startsHere = readRecord(message)?.checkpoint;
            const base = startsHere ? checkpointState(startsHere) : before;
            if (!base) throw new Error('This chat has no story state yet.');
            const { record } = take(arr, index, before);
            const spans = spansOf(record);
            if (!spans) throw new Error('The story changes on this reply cannot be told apart from the others.');
            // The kept blocks, each with its receipt when they line up one to one (every append stores one).
            const blocks = [];
            let at = 0;
            for (const span of spans) {
                if (!span.story) blocks.push(record.ops.slice(at, at + span.n));
                at += span.n;
            }
            const keptReceipts = record.receipts.filter(receipt => receipt?.cause !== 'story').map(receipt => structuredClone(receipt));
            const paired = keptReceipts.length === blocks.length;
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
            const keptSpans = [];
            const moved = new Map();
            for (const [n, block] of blocks.entries()) {
                const receipt = paired ? keptReceipts[n] : null;
                let blockOps;
                let kept = receipt;
                if (receipt?.replan && typeof rerun === 'function') {
                    let out = null;
                    try { out = rerun(deepFreeze(structuredClone(state)), receipt); } catch { out = null; }
                    if (!out?.ok) continue;
                    blockOps = asOps(out.ops);
                    kept = { ...structuredClone(out.receipt), id: receipt.id };
                    const own = [...blockOps].reverse().find(op => op?.path === '/meta/rev' && Number.isInteger(op.value))?.value;
                    if (Number.isInteger(own)) rev = Math.max(rev, own);
                } else {
                    let renumbered = null;
                    blockOps = block.map(op => {
                        if (op?.path !== '/meta/rev' || !Number.isInteger(op.value)) return op;
                        if (op.value > rev) {
                            rev = op.value;   // already after the new story ops: kept as it is
                            return op;
                        }
                        rev += 1;
                        renumbered = [op.value, rev];
                        moved.set(op.value, rev);
                        return { ...op, value: rev };
                    });
                    if (renumbered && kept?.rev === renumbered[0]) kept.rev = renumbered[1];
                }
                try {
                    state = step(state, blockOps);
                } catch (error) {
                    throw fail(error);
                }
                nextOps.push(...blockOps);
                keptSpans.push({ n: blockOps.length, story: false });
                if (kept) nextReceipts.push(kept);
            }
            if (!paired) {
                for (const receipt of keptReceipts) if (moved.has(receipt.rev)) receipt.rev = moved.get(receipt.rev);
                nextReceipts.push(...keptReceipts);
            }
            const writes = [[message, {
                ...record,
                ops: nextOps,
                receipts: [...structuredClone(receipts), ...nextReceipts],
                spans: [{ n: fresh.length, story: true }, ...keptSpans],
                rev: revOf(state),
            }]];
            // Later blocks that were already skipped stay skipped; one that applied before must still apply.
            const broken = new Set(replay(arr, lastCarrier(arr)).problems.map(problem => `${problem.index}:${problem.block}`));
            for (let i = index + 1; i < arr.length; i++) {
                const later = readRecord(arr[i]);
                if (!later) continue;
                const checkpoint = later.checkpoint ? structuredClone(state) : undefined;
                const failed = [];
                state = replayRecord(state, later, i, failed, broken);
                if (failed.length) {
                    throw new Error(`A later change (message ${i}) depends on this reply's old story changes: ${failed[0].why}`);
                }
                if (checkpoint) writes.push([arr[i], { ...later, checkpoint, rev: revOf(state) }]);
            }
            for (const [target, next] of writes) write(target, next);
            saver.touch();
            forgetMemos();
            cache = null;   // rebuilt on the next read, with the blocks that stay skipped reported
        },

        setNarrated(index, ids) {
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
                throw new TypeError('Narrated receipts must be a list of receipt IDs.');
            }
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, narrated: [...new Set(ids)], ...(rev === undefined ? {} : { rev }) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        // Every stored receipt on the current line of history, in chat order: [{ index, receipt }]
        // (the carriers the head is built from; frozen copies).
        receipts() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.receipts) return memo.receipts;
            counts.lineScans++;
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
            const arr = dryRun && Array.isArray(messages) ? messages : list();
            if (index !== lastCarrier(arr)) throw new RangeError(`Message ${index} is not the last reply that keeps the story, so its changes cannot be taken back alone.`);
            if (!Number.isInteger(beforeRev) || beforeRev < 1) throw new TypeError('beforeRev must be a whole number of 1 or more.');
            const message = carrierAt(arr, index);
            const record = readRecord(message);
            if (!record) return { dropped: [], rev: revOf(arr === list() ? current().state : stateBefore(arr, index + 1)) };
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
            const base = record.checkpoint ? checkpointState(record.checkpoint) : stateBefore(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const ops = kept.flatMap(chunk => chunk.ops);
            const byRev = new Map(receipts.map(receipt => [receipt.rev, receipt]));
            const spans = kept.map(chunk => ({ n: chunk.ops.length, story: byRev.get(chunk.rev)?.cause === 'story' }));
            // C1-3: the kept changes are replayed as a rebuild replays them (block by block, by the
            // replay rules: a remove of what a deleted reply added is passed over), so a chat that
            // replays fine is not refused. A kept block that still does not apply refuses the rewind.
            const problems = [];
            const state = replayRecord(base, { ...record, ops, spans }, index, problems);
            if (problems.length) throw new Error(problems[0].why);
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
            // Only this carrier was rewritten (and its kept changes all applied): earlier problems stay.
            retain(arr, state, (cache?.problems ?? []).filter(problem => problem.index < index));
            return { dropped, rev: revOf(state) };
        },

        untold() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.untold) return memo.untold;
            counts.lineScans++;
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
         * passes for receipts or untold). A copy.
         */
        work() {
            return { ...counts };
        },

        rebuild() {
            frozenCheckpoints = new WeakMap();
            cache = null;
            forgetMemos();
            // The record copies and old receipts are settled over the whole chat, and a record whose
            // swipe moved is stamped again (settleAll).
            if (settleAll(list())) saver.touch();
            current();
        },

        // Runs `fn` (it may be async) with the swipe_info copies of every record it writes held back,
        // then copies each once: a reply's change lines are stored one by one (each must apply on its
        // own), but a long block is not copied once per line (B1-1).
        async batch(fn) {
            holding += 1;
            try {
                return await fn();
            } finally {
                holding -= 1;
                if (!holding) {
                    // The copies are written again as they are: a head cached before stays the head.
                    const arr = list();
                    const kept = cache && sameKey(cache.key, headKey(arr)) ? cache : null;
                    for (const message of held) {
                        const record = message.extra?.[KEY];
                        if (!record) continue;
                        if (keeps(message, arr)) writeRecord(message, record);
                        else dropCopy(message);
                    }
                    held.clear();
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
            for (const entry of unsaved.values()) {
                if (entry.chatId !== from) continue;
                entry.chatId = to;
                moved = true;
            }
            if (moved && saver.dirty()) saver.schedule();
            return moved;
        },

        scheduleSave(ms = 400) { saver.schedule(ms); },
        /**
         * Puts off a save that was only scheduled (not one already running): the turn's cues before a reply
         * are saved with the reply's own save, one write of the chat file instead of two. The change stays
         * dirty; the caller saves it (or schedules it again) when the reply comes or the generation ends.
         */
        deferSave() { saver.defer(); },
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
        /** True when changes are saved by the turn's idle save here (see saveIdle). */
        idleSaves() {
            try { return typeof rescue === 'function' && !!place(); } catch { return false; }
        },
        /** Saves now (a reader's action is saved at once); → Promise<true | false>, never throws: a failure is told and tried again. */
        saveSoon(options) { return saver.saveSoon(options); },
        /** The page is closing: the newest state goes out at once, even past a save still on its way. */
        saveUrgent(options) { return saver.urgent(options); },
        /** True while a save of the open chat is on its way. */
        inFlight() { return saver.inFlight(); },
        /** True while a timed-out write's file is still to be read back. */
        suspect() { return saver.suspect(); },
        /** A chat was opened: read-backs a reload of the page left for it go on (persist.js createSaver.resume). */
        resume() { return saver.resume(target()); },
        flush() { return saver.flush(); },
        dirty() { return saver.dirty(); },
        /** True while saves are failing (until one works again). */
        failing() { return saver.failing(); },
    };
}
