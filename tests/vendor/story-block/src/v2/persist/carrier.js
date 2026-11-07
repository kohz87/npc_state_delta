// Story Suite v2: carrier identities, record keys and the shape check used by the persistence readers.
// `isObject` is shared by the persistence parts; `wellFormed` is the record shape a checkpoint reader trusts.

import { randomId } from '../../id.js';

export const KEY = 'storySuite';

export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

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

export function wellFormed(record) {
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
