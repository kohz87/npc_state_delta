// Story Suite v2: the carrier source map (contract §4), moved out of createStore unchanged: the canonical pair of ids a record is
// stamped with, the Source a command run on a carrier stamps its block with, the stored ID a first record will get, and the
// occurrence a block gives its proof. `createSources(s, deps)` is given the store's state holder `s` and the few store functions it calls
// (the archive and the id index come from createTombs); it never imports store.js.

import { KEY, isCarrier, readRecord, swipeOf } from '../persist.js';
import { isObject } from './constants.js';
import { deriveId, isRecordId } from '../replay.js';
import { allocator, occurrenceOf, operationKey, spanOperationKey } from '../evidence.js';

export function createSources(s, deps) {
    const { recordId, list, archive, idsOf } = deps;

    // The canonical pair of a record: { sid: sr_, swipeKey: sw_, evidence: ev_, next }. `sid` is the logical
    // message's, shared by all its swipes (taken from a swipe that has one, else worked out from the stored
    // ID of the swipe it was copied from); `swipeKey` and `evidence` are this swipe's own, worked out from
    // its stored `sid` and moved on by a salt when another record already holds them. The stored `sid`
    // (`sw_<12 hex>`) is never changed. Persisted with the record by write().
    function sourceFor(arr, message, sid) {
        const own = message.extra?.[KEY];
        const siblings = [own, ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(info => info?.extra?.[KEY]) : [])]
            .filter(record => isObject(record));
        const index = idsOf(arr);
        let logical = siblings.map(record => record.source?.logical).find(value => isRecordId(value) && value.startsWith('sr_'));
        if (!logical) {
            const anchor = typeof own?.sid === 'string' ? own.sid : siblings.find(record => typeof record.sid === 'string')?.sid ?? sid;
            // (taken: canonical sids that belong to another message)
            const elsewhere = { has: id => archive().has(id) || [...(index.logicals.get(id) ?? [])].some(holder => holder !== message) };
            logical = deriveId('sr', anchor, elsewhere);
        }
        // (a record's own earlier ids are not "taken" from it)
        const heldBy = map => ({ has: id => archive().has(id) || (map.has(id) && map.get(id) !== sid) });
        return { logical, swipeKey: deriveId('sw', sid, heldBy(index.swipeKeys)), evidence: deriveId('ev', sid, heldBy(index.evidences)), next: 0 };
    }

    // A record that has no source map entry yet (one stored before this existed) gets one when it is written.
    function withSource(message, record) {
        if (!isObject(record) || isObject(record.source) || typeof record.sid !== 'string') return record;
        return { ...record, source: sourceFor(list(), message, record.sid) };
    }

    // The Source a command run on carrier `index` stamps its block with (REPLAY.md): the canonical pair, the
    // evidence ID and the block's ordinal. `pending` = blocks of this carrier that a Re-read has planned but
    // not stored yet; `ordinal` names one outright (a block planned again keeps its own). null for a message
    // that is not a carrier. The pair is worked out from the stored ID, so it is the one the record is
    // written with (before any block that carries it is).
    function sourceOf(index, { pending = 0, ordinal = undefined } = {}) {
        const arr = list();
        const message = arr[index];
        if (!isCarrier(message)) return null;
        const record = readRecord(message);
        const sid = record ? record.sid : reservedSid(message);
        if (typeof sid !== 'string') return null;
        const entry = isObject(record?.source) ? record.source : sourceFor(arr, message, sid);
        return { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence,
            ordinal: Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : (Number.isInteger(entry.next) ? entry.next : 0) + Math.max(0, pending) };
    }

    // The stored ID a first record on this message's shown swipe will get (handed out once, like carrierSid).
    function reservedSid(message) {
        const swipe = swipeOf(message);
        const kept = s.reserved.get(message);
        if (kept && kept.swipe === swipe) return kept.sid;
        const sid = recordId();
        s.reserved.set(message, { swipe, sid });
        return sid;
    }

    // The occurrence a block planned again gives its proof: the one it was stamped with, else (a block that gave no proof until now, guarded
    // or not) the next one nobody has used in its reply, from the plan's one allocator (evidence.js allocator). The operation is the one the
    // block is run again as: its replan's, else its own.
    function occurrenceFor(span, receipt, alloc) {
        const stored = occurrenceOf(span);
        if (stored !== null) return stored;
        let key = null;
        try {
            const again = isObject(span?.replan) ? span.replan : isObject(receipt?.replan) ? { type: receipt.type, payload: receipt.replan.payload ?? {} } : null;
            key = again ? operationKey(again.type, again.payload) : spanOperationKey(span);
        } catch { key = null; }
        return key ? alloc.take(key) : undefined;
    }

    /**
     * The record ID of carrier `index`'s shown swipe (MODULES §F2's ctx.carrier.sid): its record's,
     * or one handed out now that its first record will get. null for a message that is not a carrier.
     */
    function carrierSid(index) {
        const message = list()[index];
        if (!isCarrier(message)) return null;
        const own = readRecord(message);
        if (own) return typeof own.sid === 'string' ? own.sid : null;
        const swipe = swipeOf(message);
        const kept = s.reserved.get(message);
        if (kept && kept.swipe === swipe) return kept.sid;
        const sid = recordId();
        s.reserved.set(message, { swipe, sid });
        return sid;
    }

    /**
     * The Source of carrier `index` (contract §4): { sid: sr_…, swipeKey: sw_…, evidence: ev_…, ordinal }, the
     * canonical pair of its logical message and swipe, from the record's source map entry (worked out
     * from the stored ID when the record has none yet, and persisted with the record's next write).
     * `ordinal` is the next block ordinal, or `{ ordinal }` names one; `{ pending }` counts blocks a
     * Re-read has planned but not stored. null for a message that is not a carrier. Numeric message
     * and swipe indexes are never part of it.
     */
    function sourceAt(index, options) {
        return sourceOf(index, options);
    }

    /** A new block's occurrence for the operation `key` (operationKey) on carrier `index`: the next one nobody has used in its reply (evidence.js allocator). */
    function allocateOccurrence(index, key) {
        const arr = list();
        const record = isCarrier(arr[index]) ? readRecord(arr[index]) : null;
        return allocator(record ?? {}).take(key);
    }

    return { sourceFor, withSource, reservedSid, occurrenceFor, carrierSid, sourceAt, allocateOccurrence };
}
