// Story Suite v2: cached hashes of record bodies, replay chains and checkpoint windows.
// The caches belong to the store so a changed chat or record invalidates the same entries as before.

import { isCarrier, readRecord } from '../persist.js';
import { hashJson, isMetaSpan, replayInputsOf } from '../replay.js';
import { hasMeta, payloadHashOf } from './digest.js';

export function createChains(s, { blockParts }) {
    // What a record holds, as a hash: its swipe key and each block's id and ops. Records are never changed in
    // place (each write puts a new one), so it is worked out once per record.
    function bodyDigest(record) {
        let digest = s.bodies.get(record);
        if (!digest) {
            s.bodies.set(record, digest = hashJson({
                k: record.source?.swipeKey ?? record.sid ?? null,
                // (a guarded block by all of its metadata: guard, recorded inputs, evidence, claims, boundaries, result)
                b: blockParts(record).map(({ ops, span }) => [isMetaSpan(span) ? hashJson(span) : null, hashJson(ops)]),
            }));
        }
        return digest;
    }

    // The hash of everything on the carriers before `upTo` (block contents, swipe keys and, for carriers with
    // guarded blocks, their text), chained from the first; each link is kept per record while its input stays.
    // The hash before the head reply, kept for the next guarded block on it: valid while nothing but that reply is written
    // (write() drops it), the chat is the same array of the same length, and nothing is staged.
    function chainHash(arr, upTo) {
        if (!s.staged && s.tail && s.tail.arr === arr && s.tail.upTo === upTo && s.tail.length === arr.length) return s.tail.hash;
        const hash = chainHashUncached(arr, upTo);
        if (!s.staged) s.tail = { arr, upTo, length: arr.length, hash };
        return hash;
    }
    function chainHashUncached(arr, upTo) {
        let hash = '';
        for (let i = 0; i < upTo && i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = s.staged?.get(i) ?? readRecord(arr[i]);
            if (!record) continue;
            const text = hasMeta(record) ? payloadHashOf(arr[i]) : null;
            const hit = s.links.get(record);
            if (hit && hit.prev === hash && hit.text === text) {
                hash = hit.out;
                continue;
            }
            const out = hashJson({ p: hash, d: bodyDigest(record), t: text });
            s.links.set(record, { prev: hash, text, out });
            hash = out;
        }
        return hash;
    }

    // The exact prefix a checkpoint was made over (the gate of trust, REPLAY.md "Checkpoints and covers"): a hash chained over
    // every record before it as it is shown now, from the first: all of replay.js replayInputsOf (everything replay reads
    // from a record), the text of records that hold guarded blocks, and the first record's own starting point. Each link is kept per record while its input stays, so a read costs a lookup
    // per record and a change costs the records from it on.
    function spineDigest(record) {
        let digest = s.spineDigests.get(record);
        if (!digest) s.spineDigests.set(record, digest = hashJson(replayInputsOf(record)));
        return digest;
    }
    function spineStep(prev, record, message, first) {
        const text = hasMeta(record) ? payloadHashOf(message) : null;
        const hit = s.spineLinks.get(record);
        if (hit && hit.prev === prev && hit.text === text && hit.first === first) return hit.out;
        const out = hashJson({ p: prev, d: spineDigest(record), t: text, c: first ? hashJson(record.checkpoint ?? null) : null });
        s.spineLinks.set(record, { prev, text, first, out });
        return out;
    }
    // The prefix hash in front of carrier `upTo`; `at(i)` gives the record to use for carrier i (a Re-read passes the ones it is
    // about to write).
    function spineBefore(arr, upTo, at = i => readRecord(arr[i])) {
        let hash = '';
        let first = true;
        for (let i = 0; i < upTo && i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = at(i);
            if (!record) continue;
            hash = spineStep(hash, record, arr[i], first);
            first = false;
        }
        return hash;
    }

    // The identity of a checkpoint's window (chain): the records it covers, with the swipe keys, block
    // contents and text of the ones that hold guarded blocks. undefined when none does (nothing to add to
    // `covers`). `at(i)` gives the record to use for carrier i (a Re-read passes the ones it is about to write).
    function windowHash(arr, members, at = i => readRecord(arr[i])) {
        let guarded = false;
        const entries = members.map(i => {
            const record = at(i);
            if (!hasMeta(record)) return record?.sid ?? null;
            guarded = true;
            return { s: record.sid, k: record.source?.swipeKey ?? null, p: payloadHashOf(arr[i]), d: bodyDigest(record) };
        });
        return guarded ? hashJson(entries) : undefined;
    }

    return { chainHash, spineBefore, spineStep, windowHash };
}
