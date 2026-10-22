// Story Suite v2: where state lives in the chat (SPEC §2.2) and how its saves are batched (§3.3).
//
// A carrier is any non-user message. Its record is `message.extra.storySuite`:
//   { v: 2, checkpoint?, ops, receipts, narrated,   // the spec's fields
//     sid, swipe, mark, spans, rev }                // bookkeeping kept by the store (see below)
// * `sid` and `swipe` say which swipe wrote the record. SillyTavern copies `extra` into a new swipe, so a
//   record whose `swipe` is not the shown swipe is only trusted when no other swipe holds the same `sid`
//   (a swipe deleted before it shifted its index); otherwise it is a copy and the swipe has no record.
//   The store stamps such a shifted record again on rebuild (`restamp`), so it never matches a later copy.
// * `mark` = { t, d }: the swipe the record was written for, by the start of its text (hashed) and its
//   send_date. When the swipe a copy was made from is deleted, the copy is the only one left with that
//   `sid` and slides into that swipe's index; its text and its date are the other swipe's, so it is still
//   a copy. Only both parts differing tells it: a Continue changes the date but not the start of the text,
//   an edit changes the text but not the date, so neither costs a reply its record (see `markFits`), and a
//   chat without dates is never judged by its text alone.
// * `spans` = [{ n, story }]: how many of `ops` each append added and whether it came from a story capture,
//   so a Re-read can replace the story ops and keep the rest.
// * `rev` = meta.rev of the state after this carrier, for the host's check after a save.
// * `covers` (with a checkpoint) = the `sid`s of the records from the checkpoint before it up to this one,
//   so the store can tell a checkpoint made over a reply since deleted (store.js chain).
// * An op on a count a domain keeps (`counters`) carries `was`, the number it replaced (ops.js).
// The record is written to `message.extra`. Its copy in `swipe_info[swipe_id].extra` (as v1 kept one on
// every message) is kept only where SillyTavern can read it back (`keepsCopy`): see below.
//
// Keeping each record once (docs/v2/PERFORMANCE.md). SillyTavern 1.19 sets `extra` from `swipe_info` in
// one function only, `syncSwipeToMes`, and calls it
// * when a message is swiped (script.js `swipe` → `loadFromSwipeId`): only the last message can be
//   swiped by the reader, and before it moves away from the shown swipe it copies `extra` into that
//   swipe's `swipe_info` itself (`syncMesToSwipe`), except when the shown swipe is being deleted (then
//   it moves to another swipe's own copy) or a failed swipe is turned back (to the swipe it just copied);
// * when a branch is made from a swipe picked in the swipe list (bookmarks.js `getBranchChatSnapshot`):
//   the picker opens on any message with more than one swipe, and it does NOT copy the shown swipe first,
//   so the branch takes the shown swipe's `extra` from its `swipe_info` copy.
// Nothing else reads it (deleting a message, editing, Continue, loading a chat read `extra` itself). So
// the shown swipe's copy is kept on the last carrier and on any carrier with more than one swipe, and
// dropped on the others. When a deletion makes an earlier carrier the last one, the store copies its
// record into its shown swipe again (`restoreCopy`, on rebuild). Other swipes' copies, SillyTavern's own
// (each holding that swipe's own record), are never touched.
// * Receipts RECEIPT_KEEP or more carriers back lose their `data` (`trimReceipts`). That is a contract
//   (SPEC §2.2): receipt data older than 200 carriers may be dropped, and modules must not rely on it;
//   what a module needs later it keeps in its own state. Story Block itself never reads it then (claims
//   live in meta.claims, Re-read uses `line` and `seed`, narration `summary` and `narrate`). Every other
//   field stays.

import { randomId } from '../id.js';

export const KEY = 'storySuite';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export const isCarrier = message => isObject(message) && !message.is_user;
export const swipeOf = message => (Number.isInteger(message?.swipe_id) ? message.swipe_id : 0);
export const newRecordId = () => `sw_${randomId().replace(/-/g, '').slice(0, 12)}`;

// Indexes of every carrier, oldest first.
export function carrierIndexes(chat) {
    const out = [];
    for (let i = 0; i < (chat?.length ?? 0); i++) if (isCarrier(chat[i])) out.push(i);
    return out;
}

export function lastCarrier(chat, before = chat?.length ?? 0) {
    for (let i = Math.min(before, chat?.length ?? 0) - 1; i >= 0; i--) if (isCarrier(chat[i])) return i;
    return -1;
}

// A checkpoint is a whole State: { v: 2, meta: { rev, … }, domains: { … } }.
const isState = value => isObject(value) && value.v === 2 && isObject(value.meta) && Number.isInteger(value.meta.rev)
    && isObject(value.domains);

function wellFormed(record) {
    return isObject(record) && record.v === 2
        && Array.isArray(record.ops) && Array.isArray(record.receipts) && Array.isArray(record.narrated)
        && (record.checkpoint === undefined || isState(record.checkpoint));
}

/**
 * Why the record on this carrier cannot be used, or '' (none there, a good one, another swipe's copy, or
 * not a v2 record at all). The store lists these as Problems: a damaged record is skipped, never taken
 * as the state.
 */
export function recordFault(message) {
    if (!isCarrier(message)) return '';
    const record = message.extra?.[KEY];
    if (!isObject(record) || record.v !== 2 || wellFormed(record)) return '';
    if (!Array.isArray(record.ops) || !Array.isArray(record.receipts) || !Array.isArray(record.narrated)) {
        return 'its list of changes is damaged';
    }
    return 'its saved starting point (checkpoint) is damaged';
}

// 32-bit FNV-1a, as 8 hex digits: enough to tell two swipes' openings apart (and two change lines).
export function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

const MARK_CHARS = 40;
// (trimmed at the end: hiding the change block puts a blank line before it)
const opening = message => String(message?.mes ?? '').split('<')[0].trimEnd();
const dateOf = value => {
    if (value === undefined || value === null || value === '') return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    return String(value);
};

// B-b2-timeline-r2-3: a new swipe being written still shows the swipe it was made from. SillyTavern's
// swipe() moves swipe_id past the swipes it has and leaves the old text and send_date until the reply
// is saved (saveReply sets them just before MESSAGE_RECEIVED, and the swipe's own slot after it).
// So while the shown swipe has no slot of its own and its text is another swipe's (or none), it has
// no text of its own to mark.
function borrowed(message) {
    const swipes = message?.swipes;
    const id = message?.swipe_id;
    if (!Array.isArray(swipes) || !Number.isInteger(id) || id < 0 || swipes[id] !== undefined) return false;
    const mes = String(message.mes ?? '');
    return !mes.trim() || swipes.some(text => text === mes);
}

/**
 * The shown swipe's mark, or null while its text has not started (a reply still being written, or a
 * new swipe still showing the old one's text, see `borrowed`):
 * `t` = "<hash>:<n>", the hash of the first n (at most 40) characters before any tag (a Continue only
 * adds after them, and the hidden change block comes after them), and `d` = its send_date ('' if none).
 */
export function swipeMark(message) {
    if (borrowed(message)) return null;
    const text = opening(message).slice(0, MARK_CHARS);
    if (!text.trim()) return null;
    return { t: `${hash(text)}:${text.length}`, d: dateOf(message?.send_date) };
}

// Each part of a stored mark against the shown swipe: true (agrees), false (differs), null (one side
// does not know it).
function markParts(mark, message) {
    const [h, n] = String(mark.t ?? '').split(':');
    const length = Number(n);
    const text = opening(message);
    const date = dateOf(message?.send_date);
    return {
        t: Number.isInteger(length) && length > 0 && text.length ? text.length >= length && hash(text.slice(0, length)) === h : null,
        d: typeof mark.d === 'string' && mark.d && date ? mark.d === date : null,
    };
}

/**
 * Does a stored mark fit the shown swipe? It does not only when both its text and its date are known on
 * both sides and both differ: a Continue changes the date, an edit the text, and neither makes the reply
 * another swipe. A record without a mark fits.
 */
export function markFits(mark, message) {
    if (!isObject(mark) || typeof mark.t !== 'string') return true;
    const { t, d } = markParts(mark, message);
    return !(t === false && d === false);
}

/** True when one part of a fitting mark no longer agrees (an edit, a Continue): write it again. */
function markStale(record, message) {
    if (!isObject(record.mark) || typeof record.mark.t !== 'string' || !swipeMark(message)) return false;
    const { t, d } = markParts(record.mark, message);
    return t === false || d === false;
}

// The record of the swipe shown on this message, or null (none, v1-only extras, malformed, or a copy).
export function readRecord(message) {
    if (!isCarrier(message)) return null;
    const record = message.extra?.[KEY];
    if (!wellFormed(record)) return null;
    const swipe = swipeOf(message);
    if (record.swipe === undefined) return record;
    if (record.swipe === swipe) return markFits(record.mark, message) ? record : null;
    if (typeof record.sid !== 'string') return null;
    const copied = (message.swipe_info ?? []).some((info, at) => at !== swipe && info?.extra !== message.extra
        && info?.extra?.[KEY]?.sid === record.sid);
    return copied || !markFits(record.mark, message) ? null : record;
}

// A trusted record stamped with another swipe (it moved down when an earlier swipe was deleted) is
// stamped again with the swipe it now is, so a copy SillyTavern makes of it for a new swipe at its old
// index is seen as a copy. A trusted record whose mark has moved on (the reply was edited, or continued)
// gets the swipe's mark as it is now, so the next change to the other part still finds it. True when it
// wrote.
export function restamp(message, { mirror = true } = {}) {
    const record = readRecord(message);
    if (!record) return false;
    const shifted = record.swipe !== undefined && record.swipe !== swipeOf(message);
    if (!shifted && !(record.swipe !== undefined && markStale(record, message))) return false;
    writeRecord(message, record, { mirror });
    return true;
}

// Writes the record for the shown swipe and keeps swipe_info in step (`mirror: false` leaves the
// swipe_info copy for later: the store writes a reply's lines one by one and copies once at the end, and
// drops it where it is not kept). Touches nothing else in the message.
export function writeRecord(message, record, { mirror = true } = {}) {
    const swipe = swipeOf(message);
    const mark = swipeMark(message);
    const stored = { ...record, swipe };
    if (mark) stored.mark = mark;
    else delete stored.mark;
    if (!isObject(message.extra)) message.extra = {};
    message.extra[KEY] = stored;
    if (mirror) mirrorCopy(message);
    return stored;
}

/**
 * Does this carrier keep its shown swipe's record in `swipe_info` too? Yes when it is the last carrier
 * (`last`: the one the reader can swipe), or when it has more than one swipe (a branch can be made from
 * one of them, see the top of this file).
 */
export function keepsCopy(message, last) {
    return !!last || (Array.isArray(message?.swipes) && message.swipes.length > 1);
}

/** Copies the record in `message.extra` into the shown swipe's `swipe_info` (when it has one). */
export function mirrorCopy(message) {
    const record = message?.extra?.[KEY];
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
    if (!isObject(record) || !isObject(info)) return false;
    if (!isObject(info.extra)) info.extra = {};
    if (info.extra !== message.extra) info.extra[KEY] = structuredClone(record);
    return true;
}

/**
 * The copy a rebuild gives the last carrier back (an earlier one became the last). Only for a message at
 * rest: its shown swipe's text is the one shown, and that swipe's `swipe_info` holds no other record.
 * SillyTavern's deleteSwipe tells of a deleted swipe (MESSAGE_SWIPE_DELETED) before it shows the next
 * one: then `extra` is still the deleted swipe's and the slot under `swipe_id` is the next swipe's own,
 * which must not be written over. True when it copied.
 */
export function restoreCopy(message) {
    const record = message?.extra?.[KEY];
    const swipe = swipeOf(message);
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipe] : null;
    if (!isObject(record) || !isObject(info) || info.extra === message.extra) return false;
    if (Array.isArray(message.swipes) && message.swipes[swipe] !== message.mes) return false;
    const there = isObject(info.extra) ? info.extra[KEY] : undefined;
    if (there !== undefined && !(isObject(there) && there.sid === record.sid)) return false;
    return mirrorCopy(message);
}

/**
 * Drops the shown swipe's copy of the record in `message.extra` from `swipe_info` (only a copy of that
 * same record, by `sid`; a copy of anything else is left alone). True when it dropped one.
 */
export function dropCopy(message) {
    const own = message?.extra?.[KEY];
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
    const copy = isObject(info?.extra) && info.extra !== message.extra ? info.extra[KEY] : undefined;
    if (!isObject(own) || !isObject(copy) || copy.sid !== own.sid) return false;
    delete info.extra[KEY];
    return true;
}

/** How many carriers back (the head is 0) a record's receipts keep their `data`. */
export const RECEIPT_KEEP = 200;

/**
 * Drops `data` from the receipts of the record shown on `message` (and from its kept copy), keeping
 * every other field. Nothing else in the record changes (no new mark or swipe stamp). True when it did.
 */
export function trimReceipts(message) {
    const record = readRecord(message);
    if (!record || !record.receipts.some(receipt => isObject(receipt) && Object.hasOwn(receipt, 'data'))) return false;
    const receipts = record.receipts.map(receipt => {
        if (!isObject(receipt) || !Object.hasOwn(receipt, 'data')) return receipt;
        const { data, ...rest } = receipt;
        void data;
        return rest;
    });
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
    const copied = isObject(info?.extra) && info.extra !== message.extra && isObject(info.extra[KEY]) && info.extra[KEY].sid === record.sid;
    message.extra[KEY] = { ...record, receipts };
    if (copied) info.extra[KEY] = structuredClone(message.extra[KEY]);
    return true;
}

/**
 * Rescue: puts the record `from` holds for its shown swipe on `to`, the same message as read back from
 * its chat file (same swipe, author and send_date; nothing else of `to` is touched). False when `to` is
 * not that message, so nothing is written over another one.
 */
export function carryRecord(from, to) {
    const record = from?.extra?.[KEY];
    if (!isCarrier(from) || !isCarrier(to) || !isObject(record)) return false;
    const same = swipeOf(to) === swipeOf(from) && String(to.name ?? '') === String(from.name ?? '')
        && JSON.stringify(to.send_date ?? null) === JSON.stringify(from.send_date ?? null);
    if (!same) return false;
    writeRecord(to, structuredClone(record));
    return true;
}

// One save per burst (SPEC §3.3). `touch()` marks a change; `schedule(ms)` saves `ms` after the last call;
// `saveSoon()` saves now and never throws (a failure is told and tried again); `flush()` saves now
// (waiting for a save already running) and rethrows a failure.
//
// Which chat a change belongs to is taken when it is made (`target()`, e.g. { chatId, carrier }), and
// `check(target)` is asked right before each save, in the same tick as the save starts (`save(target)`
// must start writing before it returns):
//   ''                  → save the chat that is open;
//   { wait: reason }    → a chat is being loaded (SillyTavern empties the chat before it reads the next
//                         one): nothing is written, it is tried again shortly (`waitMs`, `waits` times),
//                         then less often (`retry`'s longest) for as long as it takes: the change stays
//                         unsaved, never dropped (a big chat on a slow connection can take a while);
//   { moved: reason }   → another chat is open: the change is the other chat's, so the chat that is open
//                         is NOT saved; `rescue(target)` puts the change into that chat's own file;
//   { gone: reason }    → nothing of the change is left in the chat (its reply was deleted): nothing to save.
// A change made in one chat while another chat's change is still unsaved hands that one to `rescue` too.
// A failed save stays dirty: the reader is told once (`onError`) until a save works again, and it is
// tried again after `retry` ms (growing). `verify` (SPEC §3.3): `{ before() → token, after(token) → '' |
// problem }` around each save; a problem counts as a failed save.
// A save (or a rescue) the server does not answer within `timeout` ms counts as failed too: it is given
// up (`save` gets `{ signal }`, aborted then) and tried again, so a request left hanging (a dropped
// connection, a stuck proxy) never holds the next save, the reader's command or the next reply.
// A save of a chat renamed while it was on its way (`renamed`) landed under the old name: it does not
// count, and the change is saved again, into the renamed chat's file.
// A save given up that way may still be written: its body can already be at the server, which writes it
// when it gets to it, after the retry that carried a newer change (SillyTavern's integrity token is the
// same on both). So after a timeout of a save or a rescue, that chat is "suspect" (by its chat ID, kept
// through a rename, and in `memo` so a reload of the page goes on with it): each later write of it (a save
// or a rescue) is asked to stamp its file (`{ stamp: true }`; it resolves to `{ stamp }`, a rising number
// in the chat's metadata), and once one is answered the file is read back after each of `recheck` ms
// (`confirm.holds(target, stamp)` → true when the file holds that write or a newer one), whether the chat
// is open or not. A file holding an older one is put right at once: the open chat is saved again when it
// holds at least that write (`confirm.fresh(stamp)`); otherwise that write is put back
// (`confirm.restore(target, stamp)`, the page's copy of it), and when that is not possible either the
// reader is told. The read-backs end when the last delay has passed (about five minutes: a server drops a
// request whose body has not arrived by then). Without a timeout nothing is stamped or read. The
// read-backs never hold a save, the reader's command or the next reply.
export const RECHECK_MS = Object.freeze([10000, 20000, 40000, 80000, 160000]);
export function createSaver({
    save, onError = null, timers = globalThis, verify = null, target = null, check = null, rescue = null,
    retry = [1000, 2000, 4000, 8000, 15000], waitMs = 200, waits = 50, timeout = 20000,
    confirm = null, recheck = RECHECK_MS, memo = null,
} = {}) {
    if (typeof save !== 'function') throw new TypeError('createSaver needs a save function.');
    let version = 0;
    let saved = 0;
    let timer = null;
    let running = null;
    let latest = null;          // target of the newest change
    const orphans = [];         // [{ target, tries }]: changes of a chat that is no longer open
    let failures = 0;           // failed saves in a row
    let told = false;           // the reader was told about this run of failures
    let waited = 0;             // saves put off in a row because a chat was being opened
    let sending = null;         // { chatId, renamed } of the save on its way
    // chat ID → { target, good: stamp | null, step, stale, timer }: a write of that chat timed out.
    const suspects = new Map();

    const dirty = () => version !== saved || orphans.length > 0;
    const backoff = () => retry[Math.max(0, Math.min(failures, retry.length) - 1)];

    function cancel() {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
    }

    function later(ms) {
        cancel();
        timer = timers.setTimeout(() => {
            timer = null;
            saveNow().then(followUp, failed);
        }, ms);
        timer?.unref?.();
    }

    function tell(error) {
        if (told) return;
        told = true;
        try { onError?.(error); } catch { /* a missing toastr is not an error */ }
    }

    // A save that did not happen: told once, tried again later (a wait is not a failure).
    const waitDelay = () => (waited > waits ? retry[retry.length - 1] : waitMs);
    function failed(error) {
        if (error?.wait) later(waitDelay());
        else {
            tell(error);
            later(backoff());
        }
    }

    // Another chat's change that could not be written yet is tried again later.
    function followUp() {
        if (orphans.length && timer === null) later(backoff());
    }

    // The suspect chats, kept in `memo` (a reload of the page goes on with their read-backs).
    function remember(chatId, entry) {
        try { memo?.set?.(chatId, entry ? { good: entry.good, step: entry.step, place: entry.target?.place ?? null } : null); } catch { /* only a convenience */ }
    }
    function forgetStamp(stamp) {
        if (stamp === null || stamp === undefined) return;
        try { confirm?.forget?.(stamp); } catch { /* nothing kept */ }
    }
    function markSuspect(where, good = null) {
        const chatId = where?.chatId;
        if (chatId === undefined || chatId === null) return null;
        const old = suspects.get(chatId);
        if (old?.timer !== null && old?.timer !== undefined) timers.clearTimeout(old.timer);
        const entry = { target: where, good: good ?? old?.good ?? null, step: 0, stale: 0, timer: null };
        suspects.set(chatId, entry);
        remember(chatId, entry);
        return entry;
    }
    // A write of a suspect chat was answered: its stamp is what the file must hold from now on.
    function confirmed(entry, result) {
        const stamp = result?.stamp;
        if (!entry || stamp === null || stamp === undefined || ![...suspects.values()].includes(entry)) return;
        if (entry.good !== stamp) forgetStamp(entry.good);
        entry.good = stamp;
        remember(entry.target.chatId, entry);
    }
    function finish(entry) {
        const chatId = entry.target?.chatId;
        if (suspects.get(chatId) !== entry) return;
        suspects.delete(chatId);
        remember(chatId, null);
        forgetStamp(entry.good);
    }
    const suspectOf = chatId => (chatId === undefined || chatId === null ? null : suspects.get(chatId) ?? null);

    // After a timeout: is the newest answered write of the suspect chat still the one in its file? Read
    // back after each delay; an older one found there is put right at once, and read again at that delay.
    const MAX_STALE = 5;
    function startRechecks(chatId) {
        const run = suspectOf(chatId);
        if (!run || run.timer !== null || run.good === null || run.good === undefined || typeof confirm?.holds !== 'function') return;
        if (run.step >= recheck.length) {
            finish(run);
            return;
        }
        run.timer = timers.setTimeout(async () => {
            let holds = true;
            try { holds = await answered(() => confirm.holds(run.target, run.good)) !== false; } catch { holds = true; }
            run.timer = null;
            if (suspects.get(run.target?.chatId) !== run) return;     // a newer timeout started its own
            if (!holds && run.stale < MAX_STALE) {
                run.stale++;
                await putBack(run);
            } else run.step++;
            // (a put-back that timed out made the chat suspect anew: that entry goes on instead)
            const chatId = run.target?.chatId;
            if (suspects.get(chatId) === run) remember(chatId, run);
            startRechecks(chatId);
        }, recheck[run.step]);
        run.timer?.unref?.();
    }
    function startAll() {
        for (const chatId of [...suspects.keys()]) startRechecks(chatId);
    }

    // The file holds an older write than `run.good`.
    async function putBack(run) {
        const now = typeof target === 'function' ? target() : null;
        const open = now && now.chatId === run.target.chatId;
        if (open && (typeof confirm?.fresh !== 'function' || confirm.fresh(run.good) !== false)) {
            // The open chat holds that write or a newer one: saved again (stamped anew).
            if (version === saved) {
                version++;
                latest = now;
            }
            cancel();
            await saveNow().then(followUp, failed);
            return;
        }
        let why = '';
        try {
            const done = typeof confirm?.restore === 'function'
                ? await exclusive(() => answered(() => confirm.restore(run.target, run.good), () => markSuspect(run.target, run.good)))
                : false;
            if (done === false) {
                // Nothing of that write is kept on this page (it was reloaded since): it cannot be put back.
                run.stale = MAX_STALE;
                why = 'this page no longer holds the newer copy, so the latest changes before the reload may be missing';
            } else if (open) why = 'the newer copy is back in the file: reload the chat to see it';
        } catch (error) {
            why = `putting the newer copy back failed (${String(error?.message ?? error).trim().replace(/[.\s]*$/, '')}); it is tried again`;
        }
        if (!why || run.told) return;
        run.told = true;
        try {
            onError?.(new Error(`A save of chat "${run.target.chatId}" that took too long reached the server late and put an older copy of the chat back: ${why}.`));
        } catch { /* told in the console below */ }
        console.warn(`[Story Suite] a late save put an older copy of chat "${run.target.chatId}" back`);
    }

    // `start(signal)`'s promise, failed after `timeout` ms without an answer (and `signal` aborted).
    // `onTimeout()` is told when it is given up that way.
    function answered(start, onTimeout = null) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let job;
        try { job = Promise.resolve(start(controller?.signal)); } catch (error) { return Promise.reject(error); }
        if (!(timeout > 0)) return job;
        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(() => {
                try { controller?.abort(); } catch { /* nothing to abort */ }
                try { onTimeout?.(); } catch { /* only a note */ }
                reject(new Error(`the server did not answer within ${Math.round(timeout / 1000)} seconds`));
            }, timeout);
            timer?.unref?.();
            job.then(value => {
                timers.clearTimeout(timer);
                resolve(value);
            }, error => {
                timers.clearTimeout(timer);
                reject(error);
            });
        });
    }

    // One write at a time. `fn` runs in the same tick as the last wait ends: nothing can come between
    // what it checks and the write it starts.
    async function exclusive(fn) {
        while (running) await running.catch(() => {});
        let job;
        try { job = Promise.resolve(fn()); } catch (error) { job = Promise.reject(error); }
        running = job;
        try { return await job; } finally { if (running === job) running = null; }
    }

    // Changes left behind in a chat that is no longer open go to that chat's own file. Never throws:
    // the chat that is open is saved either way; a rescue that keeps failing is given up and told.
    async function rescueOrphans() {
        for (const orphan of [...orphans]) {
            // Its chat is open again (and still holds the change, or took it back on): saved with it.
            const verdict = typeof check === 'function' ? check(orphan.target) : { moved: true };
            if (!verdict?.moved && !verdict?.wait) {
                orphans.splice(orphans.indexOf(orphan), 1);
                if (!verdict?.gone) {
                    if (version === saved) version++;
                    latest = orphan.target;
                }
                continue;
            }
            try {
                if (typeof rescue !== 'function') throw new Error('this page cannot write to another chat');
                // A1-5: a rescue is a write of that chat's file too: the same stamp and read-backs.
                const watched = suspectOf(orphan.target?.chatId);
                const result = await exclusive(() => answered(() => rescue(orphan.target, watched ? { stamp: true } : {}), () => markSuspect(orphan.target)));
                confirmed(watched, result);
                orphans.splice(orphans.indexOf(orphan), 1);
                startRechecks(orphan.target?.chatId);
            } catch (error) {
                orphan.tries++;
                if (orphan.tries < 3) continue;
                orphans.splice(orphans.indexOf(orphan), 1);
                try {
                    // B-b2-timeline-r2-2: the reason is the one the rescue met, not a guess at what happened.
                    const why = String(error?.message ?? error).trim().replace(/[.\s]*$/, '');
                    onError?.(new Error(`A change made in chat "${orphan.target?.chatId ?? '?'}" was not saved: that chat was no longer open when it was saved, and ${why}.`));
                } catch { /* told in the console below */ }
                console.warn('[Story Suite] a change of another chat was not saved', error);
            }
        }
    }

    async function saveNow(options = {}) {
        await rescueOrphans();
        let goal = 0;
        let token;
        const outcome = await exclusive(() => {
            if (version === saved) return 'clean';
            goal = version;
            const now = latest;
            const verdict = now && typeof check === 'function' ? check(now) : '';
            // C4-3: a chat being opened is waited for however long it takes; the change is never
            // dropped for it (the same chat read again takes the change back on, see `check`).
            if (verdict?.wait) {
                waited++;
                return verdict;
            }
            waited = 0;
            if (verdict?.gone) {
                saved = goal;
                return 'clean';
            }
            if (verdict?.moved) {
                orphans.push({ target: now, tries: 0 });
                saved = goal;
                return 'moved';
            }
            token = verify?.before?.();
            const trip = { chatId: now?.chatId, renamed: false, goal };
            sending = trip;
            // After a timeout of this chat's write, this one is stamped, so a read-back can tell it from the
            // late one (startRechecks).
            const watched = suspectOf(trip.chatId);
            const opts = watched ? { ...options, stamp: true } : options;
            return answered(signal => save(now, signal ? { ...opts, signal } : opts), () => markSuspect(now)).then(result => {
                confirmed(watched, result);
                return trip.renamed ? 'renamed' : 'saved';
            }, error => {
                failures++;
                throw error;
            }).finally(() => {
                if (sending === trip) sending = null;
            });
        });
        if (outcome?.wait) {
            const error = new Error(`The story is not saved yet: ${outcome.wait}.`);
            error.wait = true;
            throw error;
        }
        if (outcome === 'moved') await rescueOrphans();
        // C4-2: it landed under the chat's old name; the renamed chat's file is written next.
        if (outcome === 'renamed') return saveNow(options);
        if (outcome !== 'saved') return;
        // A change made while the save ran goes with the next save, which checks it then.
        const problem = version === goal ? verify?.after?.(token) : '';
        if (problem) {
            failures++;
            throw new Error(problem);
        }
        saved = goal;
        failures = 0;
        told = false;
        startAll();
    }

    return {
        touch() {
            const wasDirty = version !== saved;
            version++;
            const now = typeof target === 'function' ? target() : null;
            if (wasDirty && latest && now && latest.chatId !== now.chatId) orphans.push({ target: latest, tries: 0 });
            latest = now ?? latest;
        },
        dirty,
        /**
         * Chat `from` is now called `to` (SillyTavern renamed its file): its unsaved changes, waiting or
         * left behind, belong to `to` and its file. True when there was any.
         */
        renamed(from, to) {
            if (!from || !to || from === to) return false;
            let moved = false;
            const move = change => {
                if (!change || change.chatId !== from) return change;
                moved = true;
                return { ...change, chatId: to, place: change.place ? { ...change.place, chatId: to } : change.place };
            };
            latest = move(latest);
            for (const orphan of orphans) orphan.target = move(orphan.target);
            // A1-3: a suspect chat's read-backs follow it to its new name.
            const entry = suspects.get(from);
            if (entry) {
                suspects.delete(from);
                remember(from, null);
                entry.target = move(entry.target) ?? { chatId: to };
                suspects.set(to, entry);
                remember(to, entry);
                moved = true;
            }
            if (sending && sending.chatId === from) {
                sending.renamed = true;
                moved = true;
            }
            return moved;
        },
        pending: () => timer !== null || running !== null,
        /** True while a write of some chat timed out and its file is still to be read back. */
        suspect: () => suspects.size > 0,
        /** True while a save of the open chat is on its way (the server has not answered yet). */
        inFlight: () => sending !== null,
        /**
         * A1-2: chat `now` (a target) was opened: the read-backs a reload of the page left (`memo`) go on.
         */
        resume(now) {
            const chatId = now?.chatId;
            if (chatId === undefined || chatId === null || suspects.has(chatId)) return false;
            let kept = null;
            try { kept = memo?.get?.(chatId) ?? null; } catch { kept = null; }
            if (!kept || !Number.isFinite(kept.good)) return false;
            const step = Number.isInteger(kept.step) && kept.step >= 0 ? kept.step : 0;
            suspects.set(chatId, { target: { ...now, place: now.place ?? kept.place ?? null }, good: kept.good, step, stale: 0, timer: null });
            startRechecks(chatId);
            return true;
        },
        /**
         * A1-4: the page is closing. With a save of the open chat still on its way, the newest state goes
         * out at once (with `options`, e.g. keepalive), not behind it; it is stamped and the chat is
         * suspect, as after a timeout (the page may stay). Otherwise as saveSoon. Never throws.
         * A save on its way that already carries the newest change is not sent twice, unless `force`
         * (the page is going away and may cut that request off).
         */
        urgent({ force = false, ...options } = {}) {
            if (!sending || version === saved || !latest) return this.saveSoon(options);
            if (!force && sending.goal === version) return Promise.resolve(false);
            const now = latest;
            const verdict = typeof check === 'function' ? check(now) : '';
            if (verdict) return this.saveSoon(options);
            const entry = markSuspect(now);
            try {
                return Promise.resolve(save(now, { ...options, stamp: true })).then(result => {
                    confirmed(entry, result);
                    return false;
                }, () => false);
            } catch {
                return Promise.resolve(false);
            }
        },
        /** True while the last save failed (until one works again). */
        failing: () => failures > 0,
        schedule(ms = 400) {
            later(ms);
        },
        /** Saves now; resolves to true when saved, false when not (told and tried again). */
        saveSoon(options = {}) {
            cancel();
            return saveNow(options).then(() => {
                followUp();
                return !dirty();
            }, error => {
                failed(error);
                return false;
            });
        },
        async flush() {
            cancel();
            try {
                await saveNow();
            } catch (error) {
                // The caller tells the reader; the save is still tried again.
                later(error?.wait ? waitDelay() : backoff());
                throw error;
            }
            followUp();
        },
        cancel,
    };
}
