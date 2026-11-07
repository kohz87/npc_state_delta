// Story Suite v2: the store's pure hashing helpers (moved out of createStore unchanged): the hash of a reply's text and whether a
// record holds guarded blocks. Each is a function of its input alone; the cache is keyed by the message and checked against its text.
// The hashes that chain over records keep their per-store caches in chains.js.

import { payloadText } from '../persist.js';
import { hashJson, isMetaSpan } from '../replay.js';

// The hash of the text a record's evidence is (REPLAY.md): a reply that is edited or continued has another.
const payloadHashes = new WeakMap();    // message → { mes, hash }: worked out once per text
export function payloadHashOf(message) {
    const mes = message?.mes;
    const hit = payloadHashes.get(message);
    if (hit && hit.mes === mes) return hit.hash;
    const hash = hashJson(payloadText(message));
    if (message && typeof message === 'object') payloadHashes.set(message, { mes, hash });
    return hash;
}

export const hasMeta = record => Array.isArray(record?.spans) && record.spans.some(isMetaSpan);
