// Public sdk ids: a short random id from crypto, with the module owner's prefix.

const ID_PREFIX = /^[a-z][a-z0-9]*$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `<prefix>_<8 base36 chars>` from crypto randomness (§2.1), e.g. `it_k3f9a2qz`. */
export function newId(prefix) {
    if (typeof prefix !== 'string' || !ID_PREFIX.test(prefix)) throw new Error(`Story Suite: an id prefix is lowercase letters and digits (like "it"), not "${prefix}".`);
    let out = '';
    const bytes = new Uint8Array(16);
    while (out.length < 8) {
        globalThis.crypto.getRandomValues(bytes);
        // 252 = 7 × 36: values above it would favour the first letters.
        for (const byte of bytes) if (byte < 252 && out.length < 8) out += BASE36[byte % 36];
    }
    return `${prefix}_${out}`;
}
