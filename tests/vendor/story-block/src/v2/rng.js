// Seeded randomness for command handlers (SPEC §3.2): every receipt carries a uint32 seed and the
// handler's only source of chance is an sfc32 generator built from it, so a receipt's outcome can be
// worked out again from the receipt alone. No Math.random anywhere in v2 state.

const UINT32_MAX = 0xFFFFFFFF;
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_BONUS = 1000000;

/** True for a whole number from 0 to 2^32 - 1. */
export function isSeed(value) {
    return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

/** A fresh uint32 seed from crypto.getRandomValues (works on plain-HTTP hosts too). */
export function seed(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('This browser has no crypto random source for dice.');
    return cryptoApi.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

// splitmix32: spreads one 32-bit seed over sfc32's four words, so seeds 1 and 2 start far apart.
function splitmix32(state) {
    let x = state | 0;
    return () => {
        x = (x + 0x9E3779B9) | 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
        z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
        return (z ^ (z >>> 16)) >>> 0;
    };
}

/** rng(seed) → () => float in [0, 1): sfc32, seeded deterministically from one uint32. */
export function rng(seedValue) {
    if (!isSeed(seedValue)) throw new Error(`The dice seed must be a whole number from 0 to ${UINT32_MAX}.`);
    const expand = splitmix32(seedValue);
    let a = expand(), b = expand(), c = expand(), d = expand();
    const next = () => {
        const t = (((a + b) | 0) + d) | 0;
        d = (d + 1) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
    // Throw away the first outputs so the four words are well mixed before the first roll.
    for (let i = 0; i < 12; i++) next();
    return next;
}

const DICE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/**
 * roll(rng, '2d6+1') → { total, dice: [..], mod }. `N` defaults to 1 (`d20`); up to 100 dice of up to
 * 1000 sides; the bonus is optional and may be negative. Throws on anything else.
 */
export function roll(random, expression) {
    if (typeof random !== 'function') throw new Error('A roll needs a random source.');
    const match = DICE.exec(String(expression ?? ''));
    if (!match) throw new Error(`"${expression}" is not a dice roll like 2d6+1.`);
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    const mod = match[3] ? Number(match[4]) * (match[3] === '-' ? -1 : 1) : 0;
    if (count < 1 || count > MAX_DICE) throw new Error(`A roll takes 1 to ${MAX_DICE} dice, not ${count}.`);
    if (sides < 1 || sides > MAX_SIDES) throw new Error(`A die has 1 to ${MAX_SIDES} sides, not ${sides}.`);
    if (Math.abs(mod) > MAX_BONUS) throw new Error(`A roll's bonus must be at most ${MAX_BONUS}.`);
    const dice = [];
    for (let i = 0; i < count; i++) dice.push(1 + Math.floor(random() * sides));
    return { total: dice.reduce((sum, die) => sum + die, 0) + mod, dice, mod };
}
