// Story Suite v2: receipt retention. The display data of old receipts is dropped after the contract's
// carrier window; guarded-block data (`data.v2`) stays because replay needs it.

import { KEY, isObject, swipeOf } from './carrier.js';
import { readRecord } from './records.js';

/** How many carriers back (the head is 0) a record's receipts keep their `data`. */
export const RECEIPT_KEEP = 200;

// A receipt without its display data: `data` goes, except `data.v2` (a guarded block's guard, source and
// result), which stays alone. Returns the receipt itself when there is nothing to drop.
function trimmedReceipt(receipt) {
    if (!isObject(receipt) || !Object.hasOwn(receipt, 'data')) return receipt;
    const { data, ...rest } = receipt;
    if (isObject(data) && data.v2 !== undefined) {
        if (Object.keys(data).length === 1) return receipt;
        return { ...rest, data: { v2: data.v2 } };
    }
    return rest;
}

/**
 * Drops `data` from the receipts of the record shown on `message` (and from its kept copy), keeping
 * every other field, and `data.v2` of the receipts that have one. Nothing else in the record changes (no
 * new mark or swipe stamp). True when it did.
 */
export function trimReceipts(message) {
    const record = readRecord(message);
    if (!record) return false;
    let changed = false;
    const receipts = record.receipts.map(receipt => {
        const out = trimmedReceipt(receipt);
        if (out !== receipt) changed = true;
        return out;
    });
    if (!changed) return false;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
    const copied = isObject(info?.extra) && info.extra !== message.extra && isObject(info.extra[KEY]) && info.extra[KEY].sid === record.sid;
    message.extra[KEY] = { ...record, receipts };
    if (copied) info.extra[KEY] = structuredClone(message.extra[KEY]);
    return true;
}
