// Memory facts (design MEMDESIGN2 §3): the event key. A synchronous SHA-256 (the browser's own is async, which would break the
// atomic merge transactions) over a canonical length-prefixed UTF-8 tuple, and the full 256 bits as unpadded base64url behind "v1:".
// Pure: no state, no DOM. Collision quarantine lives in memory-fact-store.js (it needs the stored tuple hash).

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(input) {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const total = Math.ceil((data.length + 9) / 64) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(data);
    buffer[data.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(total - 8, Math.floor((data.length * 8) / 0x100000000));
    view.setUint32(total - 4, (data.length * 8) >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < total; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i += 1) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i += 1) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    h.forEach((value, index) => outView.setUint32(index * 4, value));
    return out;
}

export function base64url(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63];
        if (i + 1 < bytes.length) out += alphabet[(chunk >> 6) & 63];
        if (i + 2 < bytes.length) out += alphabet[chunk & 63];
    }
    return out;
}

// The canonical tuple: each part as `<length in UTF-16 units>:<text>` so no two tuples share a byte string.
export function canonicalTuple(parts) {
    return (Array.isArray(parts) ? parts : []).map(part => { const text = String(part ?? ''); return `${text.length}:${text}`; }).join('|');
}

export function hashText(text) { return base64url(sha256Bytes(String(text ?? ''))); }

// The event key: namespace, the branch-owned source identity, the complete event id (kind and source subject included) and the occurrence.
// Full ids are hashed, never truncated.
export function factKey({ ns, source, eventId, phase = '' } = {}) {
    return `v1:${hashText(canonicalTuple([ns, source, eventId, phase]))}`;
}
// What one key stands for, hashed apart from the key, so the same key met with another identity is seen as a collision.
export function factIdentity({ ns, source, eventId, phase = '' } = {}) { return hashText(`id|${canonicalTuple([ns, source, eventId, phase])}`).slice(0, 12); }
