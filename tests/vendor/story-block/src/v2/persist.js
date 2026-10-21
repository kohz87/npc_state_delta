// Story Suite v2: where state lives in the chat (SPEC §2.2) and how its saves are batched (§3.3).
//
// A carrier is any non-user message. Its record is `message.extra.storySuite`:
//   { v: 2, checkpoint?, ops, receipts, narrated,   // the spec's fields
//     sid, swipe, spans, rev }                      // bookkeeping kept by the store (see below)
// * `sid` and `swipe` say which swipe wrote the record. SillyTavern copies `extra` into a new swipe, so a
//   record whose `swipe` is not the shown swipe is only trusted when no other swipe holds the same `sid`
//   (a swipe deleted before it shifted its index); otherwise it is a copy and the swipe has no record.
// * `spans` = [{ n, story }]: how many of `ops` each append added and whether it came from a story capture,
//   so a Re-read can replace the story ops and keep the rest.
// * `rev` = meta.rev of the state after this carrier, for the host's check after a save.
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

function wellFormed(record) {
    return isObject(record) && record.v === 2
        && Array.isArray(record.ops) && Array.isArray(record.receipts) && Array.isArray(record.narrated)
        && (record.checkpoint === undefined || isObject(record.checkpoint));
}

// The record of the swipe shown on this message, or null (none, v1-only extras, malformed, or a copy).
export function readRecord(message) {
    if (!isCarrier(message)) return null;
    const record = message.extra?.[KEY];
    if (!wellFormed(record)) return null;
    const swipe = swipeOf(message);
    if (record.swipe === undefined || record.swipe === swipe) return record;
    if (typeof record.sid !== 'string') return null;
    const copied = (message.swipe_info ?? []).some((info, at) => at !== swipe && info?.extra !== message.extra
        && info?.extra?.[KEY]?.sid === record.sid);
    return copied ? null : record;
}

// Writes the record for the shown swipe and keeps swipe_info in step. Touches nothing else in the message.
export function writeRecord(message, record) {
    const swipe = swipeOf(message);
    const stored = { ...record, swipe };
    if (!isObject(message.extra)) message.extra = {};
    message.extra[KEY] = stored;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipe] : null;
    if (isObject(info)) {
        if (!isObject(info.extra)) info.extra = {};
        if (info.extra !== message.extra) info.extra[KEY] = structuredClone(stored);
    }
    return stored;
}

// One save per burst. `touch()` marks a change; `schedule(ms)` saves `ms` after the last call; `flush()`
// saves now (waiting for a save already running) and rethrows a failure. A failed save leaves `dirty()`
// true so the next flush tries again.
export function createSaver({ save, onError = null, timers = globalThis } = {}) {
    if (typeof save !== 'function') throw new TypeError('createSaver needs a save function.');
    let version = 0;
    let saved = 0;
    let timer = null;
    let running = null;

    const dirty = () => version !== saved;

    function cancel() {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
    }

    async function saveNow() {
        while (running) await running.catch(() => {});
        if (!dirty()) return;
        const target = version;
        running = Promise.resolve().then(() => save());
        try {
            await running;
            saved = target;
        } finally {
            running = null;
        }
    }

    return {
        touch() { version++; },
        dirty,
        pending: () => timer !== null || running !== null,
        schedule(ms = 400) {
            cancel();
            timer = timers.setTimeout(() => {
                timer = null;
                saveNow().catch(error => { onError?.(error); });
            }, ms);
        },
        async flush() {
            cancel();
            await saveNow();
        },
        cancel,
    };
}
