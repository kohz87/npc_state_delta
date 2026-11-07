// Story Suite v2: carrying a record back to the same message read from its chat file, for a timed-out
// save's rescue. It refuses any message that is not the same swipe, author and send date.

import { KEY, isObject, isCarrier, swipeOf } from './carrier.js';
import { writeRecord } from './records.js';

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
