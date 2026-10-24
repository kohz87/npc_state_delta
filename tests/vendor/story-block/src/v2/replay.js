// Story Suite v2: the pure pieces of guarded replay (docs/v2/REPLAY.md, contract §4 and §6), shared by the
// command bus (commands.js), the store (store.js) and the tests. Nothing here reads the chat or the registry.
//
// * Hash: SHA-256 of normalized JSON (sorted keys, array order kept), as 64 lowercase hex characters. The
//   contract's inputHash / prefixHash / payloadHash are all this; it is synchronous because replay is.
// * Canonical ids: `<prefix>_<8 base36>` worked out from a stored key (the shipped `sw_<12 hex>` record IDs
//   are kept byte for byte; only the canonical pair, swipe key and evidence ID are derived from them), with
//   a salt when another record already holds the result.
// * The shapes a guarded block's span carries (Guard, Source, the span itself), checked in one place so the
//   bus, the store and a hand-edited chat file are all held to the same rules.
// * Claim extraction: the claims a block's ops add (`/meta/claims/<key>`), so they can be listed on the span
//   and applied or skipped together with the block.
//
// The ID shapes are exactly check.js's RECORD_ID; nothing here widens a regex.

import { RECORD_ID } from './check.js';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();

// ---------- SHA-256 ----------

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string (as UTF-8) or bytes, as 64 lowercase hex characters. */
export function sha256(input) {
    const bytes = typeof input === 'string' ? utf8.encode(input) : input;
    const length = bytes.length;
    const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false);
    view.setUint32(padded.length - 4, (length << 3) >>> 0, false);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return Array.from(h, word => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------- normalized JSON ----------

/**
 * The normalized JSON of a value: object keys sorted, array order kept, no spaces. Plain JSON only (a number
 * that is not finite, undefined, a function or a class instance throws), so a hash never depends on what
 * JSON.stringify would quietly drop.
 */
export function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`${value} cannot be hashed; only plain JSON can.`);
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
    if (isObject(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw new TypeError('Only plain JSON can be hashed.');
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    throw new TypeError(`A ${typeof value} cannot be hashed; only plain JSON can.`);
}

/** SHA-256 of the normalized JSON of `value` (the contract's Hash). */
export const hashJson = value => sha256(canonicalJson(value));

/** True for a plain-JSON value (hashJson would accept it). */
export function isPlainJson(value) {
    try { canonicalJson(value); return true; } catch { return false; }
}

// ---------- ids ----------

const HASH = /^[0-9a-f]{64}$/;
export const isHash = value => typeof value === 'string' && HASH.test(value);
export const isRecordId = value => typeof value === 'string' && RECORD_ID.test(value);
const hasPrefix = (value, prefix) => isRecordId(value) && value.startsWith(`${prefix}_`);

/** `<prefix>_<8 base36>` from the first 40 bits of a hash. */
export function idFromHash(prefix, hex) {
    const n = parseInt(hex.slice(0, 10), 16);
    return `${prefix}_${n.toString(36).padStart(8, '0')}`;
}

/**
 * A canonical id worked out from `seed` (the same seed always gives the same id), skipping any in `taken`
 * (a Set of ids that other records hold): the first free salt wins and is then persisted by the caller.
 */
export function deriveId(prefix, seed, taken = null) {
    for (let salt = 0; salt < 1000; salt++) {
        const id = idFromHash(prefix, sha256(`${prefix}:${seed}:${salt}`));
        if (!taken?.has(id)) return id;
    }
    throw new Error(`No free ${prefix} id could be worked out for ${seed}.`);
}

// ---------- shapes ----------

const SAFE_ORDINAL = value => Number.isInteger(value) && value >= 0 && value <= 1000000;

/** '' when `source` is a Source ({ sid: sr_, swipeKey: sw_, evidence: ev_, ordinal }), else why not. */
export function sourceProblem(source) {
    if (!isObject(source)) return 'its source is not a record';
    if (!hasPrefix(source.sid, 'sr')) return 'its source has no canonical sid (sr_xxxxxxxx)';
    if (!hasPrefix(source.swipeKey, 'sw')) return 'its source has no swipe key (sw_xxxxxxxx)';
    if (!hasPrefix(source.evidence, 'ev')) return 'its source has no evidence id (ev_xxxxxxxx)';
    if (!SAFE_ORDINAL(source.ordinal)) return 'its source ordinal is not a whole number from 0 to 1000000';
    return '';
}

/** '' when `guard` is a Guard ({ owner, version: 2, epoch, rulesHash, inputHash, predicate }), else why not. */
export function guardProblem(guard) {
    if (!isObject(guard)) return 'a guard is a record';
    if (typeof guard.owner !== 'string' || !guard.owner) return 'a guard names its owner module';
    if (guard.version !== 2) return 'a guard is version 2';
    if (!isRecordId(guard.epoch)) return 'a guard names its epoch (an id like ep_k3f9a2qz)';
    if (guard.rulesHash !== null && !isHash(guard.rulesHash)) return 'a guard\'s rulesHash is null or a 64-character hash';
    if (!isHash(guard.inputHash)) return 'a guard\'s inputHash is a 64-character hash';
    if (!Object.hasOwn(guard, 'predicate') || !isPlainJson(guard.predicate)) return 'a guard\'s predicate is plain JSON';
    return '';
}

/** True for a span written by a guarded transaction (a legacy span is `{ n, story }` only). */
export const isMetaSpan = span => isObject(span) && typeof span.id === 'string';

function cursorProblem(cursor) {
    if (!isObject(cursor)) return 'a boundary has no cursor';
    if (!isRecordId(cursor.sid) || !isRecordId(cursor.swipeKey) || !isRecordId(cursor.block)) return 'a boundary cursor names no source or block';
    if (!Number.isInteger(cursor.op) || cursor.op < 0 || !Number.isInteger(cursor.rev) || cursor.rev < 0) return 'a boundary cursor has no op or rev';
    return '';
}

/** '' when a metadata span is well formed (the fields of contract §6 P12), else why not. */
export function spanProblem(span) {
    if (!isMetaSpan(span)) return 'it has no block id';
    if (!hasPrefix(span.id, 'bl')) return 'its block id is not bl_xxxxxxxx';
    if (typeof span.module !== 'string' || !span.module) return 'it names no module';
    const source = sourceProblem(span.source);
    if (source) return source;
    if (span.guard !== null) {
        const guard = guardProblem(span.guard);
        if (guard) return guard;
    }
    if (!Array.isArray(span.claims) || span.claims.some(key => typeof key !== 'string' || !key)) return 'its claims are not a list of keys';
    if (!Array.isArray(span.evidence)) return 'its evidence is not a list';
    if (!Array.isArray(span.boundaries) || !span.boundaries.length) return 'it has no boundary';
    for (const boundary of span.boundaries) {
        const bad = isObject(boundary) ? cursorProblem(boundary.cursor) : 'a boundary is not a record';
        if (bad) return bad;
        if (!isHash(boundary.prefixHash) || !isHash(boundary.payloadHash)) return 'a boundary has no prefix or payload hash';
    }
    if (!isObject(span.operation) || typeof span.operation.type !== 'string' || !span.operation.type || !Object.hasOwn(span.operation, 'payload')) return 'it has no operation';
    if (!isPlainJson(span.operation.payload) || !isPlainJson(span.recorded ?? null) || !isPlainJson(span.result ?? null)) return 'its operation, recorded inputs or result are not plain JSON';
    if (span.replan !== null && span.replan !== undefined) {
        const replan = span.replan;
        if (!isObject(replan) || typeof replan.type !== 'string' || !replan.type || !isPlainJson(replan.payload) || !Number.isInteger(replan.seed)) return 'its replan is not { type, payload, seed }';
    }
    return '';
}

// ---------- claims ----------

const unescapeKey = key => key.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * The claim keys a list of ops adds, in order: `/meta/claims/<key>` adds, or one `/meta/claims` add or
 * replace whose value is a record of keys. Removals are not claims.
 */
export function claimKeys(ops) {
    const out = [];
    for (const op of Array.isArray(ops) ? ops : []) {
        if (!isObject(op) || (op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string') continue;
        if (op.path === '/meta/claims') {
            if (isObject(op.value)) for (const key of Object.keys(op.value)) if (!out.includes(key)) out.push(key);
        } else if (op.path.startsWith('/meta/claims/') && !op.path.slice(13).includes('/')) {
            const key = unescapeKey(op.path.slice(13));
            if (key && !out.includes(key)) out.push(key);
        }
    }
    return out;
}
