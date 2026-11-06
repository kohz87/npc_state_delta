// Fixed streams for the board: a fight seed and exchange number select its dice.
// Opening and replay ask for the same stream without advancing shared state.
// The seeded generator is the host's existing dice source.

import { rng } from '../../rng.js';
import { hash } from '../../persist.js';

/** A fight opened on this carrier gets the same seed until the reader discards it. */
export function fightSeed(sid, attempt = 0) {
    return Number.parseInt(hash(`fight:${String(sid)}:${attempt}`), 16) >>> 0;
}

/** Each exchange has its own independent uint32 base. */
function exchangeSeed(seed, number) {
    return Number.parseInt(hash(`exchange:${seed >>> 0}:${number}`), 16) >>> 0;
}

/** One positional d20 stream per action, matching the regular roll's stream scheme. */
export function boardDice(seed, number) {
    const base = exchangeSeed(seed, number), kinds = { act: 1, foe: 2, check: 3, init: 4, open: 5, flee: 6 };
    return Object.assign((kind, at) => {
        const random = rng((base ^ Math.imul(kinds[kind] * 64 + at + 1, 0x9E3779B1)) >>> 0);
        return () => 1 + Math.floor(random() * 20);
    }, { positional: true });
}
