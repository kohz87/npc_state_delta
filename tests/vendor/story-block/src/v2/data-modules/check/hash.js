// Data-modules checker, hash part: the memoised SHA-256 of a text, and the hashes of a checked definition and a whole pack.
// Pure: no state is read beyond the hash memo. check.js keeps the public path of each export.

import { stable } from './shape.js';
import { HASH_BASIS_V1 } from '../hash-basis-v1.js';
import { sha256Hex as sha256 } from '../../domains/digest.js';

// SHA-256 of a text, remembered by the text itself (a hash is a pure function of it, so a hit is always the same answer). The settings
// window asks for every installed pack's hash each time it opens; the packs' text is the same until a pack changes, and the new text misses.
const hashed = new Map();
function hashOf(text) {
    let hash = hashed.get(text);
    if (hash === undefined) {
        if (hashed.size >= 64) hashed.clear();
        hashed.set(text, hash = sha256(text));
    }
    return hash;
}

/** How many texts the hash memo holds (tests). */
export const hashMemoSize = () => hashed.size;

/** Hash checked normalized definitions only; envelope identity is deliberately separate. */
export function dataModuleHash(definition) {
    return hashOf(JSON.stringify(stable({ definition, ...HASH_BASIS_V1 })));
}

/** Whole normalized pack identity; added only for packs containing dataModules. */
export function dataModulesPackHash(pack) {
    return hashOf(JSON.stringify(stable(pack)));
}
