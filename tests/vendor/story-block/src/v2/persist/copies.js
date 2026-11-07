// Story Suite v2: the record copy SillyTavern keeps in `swipe_info`. Records are stored once on `extra`;
// only the last carrier and carriers with several swipes keep the shown swipe's copy for swipe/branch reads.

import { KEY, isObject, isCarrier, swipeOf } from './carrier.js';

/**
 * Does this carrier keep its shown swipe's record in `swipe_info` too? Yes when it is the last carrier
 * (`last`: the one the reader can swipe), or when it has more than one swipe (a branch can be made from
 * one of them, see the top of this file).
 */
export function keepsCopy(message, last) {
    return !!last || (Array.isArray(message?.swipes) && message.swipes.length > 1);
}

/**
 * SillyTavern's deleteSwipe tells of the deletion (MESSAGE_SWIPE_DELETED) before it shows the swipe that takes the
 * deleted one's place (then MESSAGE_SWIPED): until then `extra` and `mes` are the deleted swipe's and `swipe_id` is the
 * next one's. `deleted` is the index of the swipe that went (the event's `swipeId`). True while the shown swipe is in
 * that state, told by whose record `extra` holds, not by its text: the record is stamped with the deleted swipe's
 * index, or the shown slot holds another swipe's own record than `extra` does, or the text is not the slot's.
 * Nothing is written to a record meanwhile.
 */
export function swipeLoading(message, deleted = null) {
    if (!isCarrier(message) || !Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) return false;
    const swipe = message.swipe_id;
    if (!Number.isInteger(swipe) || swipe < 0 || swipe >= message.swipes.length) return false;     // (no swipe left to show)
    const record = message.extra?.[KEY];
    if (Number.isInteger(deleted) && isObject(record) && record.swipe === deleted) return true;
    const there = message.swipe_info[swipe]?.extra?.[KEY];
    if (isObject(record) && isObject(there) && message.swipe_info[swipe].extra !== message.extra && there.sid !== record.sid
        && !message.swipe_info.some(info => info?.extra?.[KEY]?.sid === record.sid)) return true;
    return message.swipes[swipe] !== message.mes;
}

/** Copies the record in `message.extra` into the shown swipe's `swipe_info` (when it has one). */
export function mirrorCopy(message) {
    const record = message?.extra?.[KEY];
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
    if (!isObject(record) || !isObject(info)) return false;
    // The slot already holds the record of another swipe that is stamped as this slot's own (a deleted shown swipe's record
    // is in `extra` until the next swipe is loaded): it is never written over.
    const there = info.extra?.[KEY];
    if (info.extra !== message.extra && isObject(there) && there.sid !== record.sid && there.swipe === swipeOf(message)) return false;
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
