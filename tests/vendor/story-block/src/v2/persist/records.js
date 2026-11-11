// Story Suite v2: reading, stamping and writing the record on the shown swipe. A record copied into a
// new swipe is recognised by its sid and mark, and a shifted record is restamped before it can be copied.

import { KEY, isObject, isCarrier, swipeOf, wellFormed } from './carrier.js';
import { markFits, markStale, swipeMark } from './marks.js';
import { mirrorCopy } from './copies.js';

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

// Whether this chat is under a rule mark (turn/rule-marks.js) for static prompt text, which is one text for the whole chat: the first reply to the reader that has a
// record of its own decides (the greeting's record never carries marks; a chat begun before the rule has a first reply without the mark and keeps the earlier text
// for good), and a chat with no such reply yet is a new one. Later replies of an old chat carry every mark; they never change which text it is sent.
export function chatMarked(messages, name) {
    let asked = false;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.is_user) { asked = true; continue; }
        const record = asked ? readRecord(message) : null;
        if (record) return Array.isArray(record.rules) && record.rules.includes(name);
    }
    return true;
}
