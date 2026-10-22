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
// The record is written to `message.extra` and copied to `swipe_info[swipe_id].extra`, as v1 did.

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
export function restamp(message) {
    const record = readRecord(message);
    if (!record) return false;
    const shifted = record.swipe !== undefined && record.swipe !== swipeOf(message);
    if (!shifted && !(record.swipe !== undefined && markStale(record, message))) return false;
    writeRecord(message, record);
    return true;
}

// Writes the record for the shown swipe and keeps swipe_info in step (`mirror: false` leaves the
// swipe_info copy for later: the store writes a reply's lines one by one and copies once at the end).
// Touches nothing else in the message.
export function writeRecord(message, record, { mirror = true } = {}) {
    const swipe = swipeOf(message);
    const mark = swipeMark(message);
    const stored = { ...record, swipe };
    if (mark) stored.mark = mark;
    else delete stored.mark;
    if (!isObject(message.extra)) message.extra = {};
    message.extra[KEY] = stored;
    if (!mirror) return stored;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipe] : null;
    if (isObject(info)) {
        if (!isObject(info.extra)) info.extra = {};
        if (info.extra !== message.extra) info.extra[KEY] = structuredClone(stored);
    }
    return stored;
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
//                         one): nothing is written, it is tried again shortly (`waitMs`, up to `waits`
//                         times; a chat that stays empty has nothing of the change left to save);
//   { moved: reason }   → another chat is open: the change is the other chat's, so the chat that is open
//                         is NOT saved; `rescue(target)` puts the change into that chat's own file;
//   { gone: reason }    → nothing of the change is left in the chat (its reply was deleted): nothing to save.
// A change made in one chat while another chat's change is still unsaved hands that one to `rescue` too.
// A failed save stays dirty: the reader is told once (`onError`) until a save works again, and it is
// tried again after `retry` ms (growing). `verify` (SPEC §3.3): `{ before() → token, after(token) → '' |
// problem }` around each save; a problem counts as a failed save.
export function createSaver({
    save, onError = null, timers = globalThis, verify = null, target = null, check = null, rescue = null,
    retry = [1000, 2000, 4000, 8000, 15000], waitMs = 200, waits = 50,
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
    function failed(error) {
        if (error?.wait) later(waitMs);
        else {
            tell(error);
            later(backoff());
        }
    }

    // Another chat's change that could not be written yet is tried again later.
    function followUp() {
        if (orphans.length && timer === null) later(backoff());
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
                await exclusive(() => rescue(orphan.target));
                orphans.splice(orphans.indexOf(orphan), 1);
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
            if (verdict?.wait && ++waited <= waits) return verdict;
            waited = 0;
            if (verdict?.gone || verdict?.wait) {
                saved = goal;
                return 'clean';
            }
            if (verdict?.moved) {
                orphans.push({ target: now, tries: 0 });
                saved = goal;
                return 'moved';
            }
            token = verify?.before?.();
            return Promise.resolve(save(now, options)).then(() => 'saved', error => {
                failures++;
                throw error;
            });
        });
        if (outcome?.wait) {
            const error = new Error(`The story is not saved yet: ${outcome.wait}.`);
            error.wait = true;
            throw error;
        }
        if (outcome === 'moved') await rescueOrphans();
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
            return moved;
        },
        pending: () => timer !== null || running !== null,
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
                later(error?.wait ? waitMs : backoff());
                throw error;
            }
            followUp();
        },
        cancel,
    };
}
