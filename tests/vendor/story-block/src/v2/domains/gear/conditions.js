// Gear's condition words and prices (moved out of domains/gear.js unchanged; gear.js re-exports every public name).
// A piece's cond is 0...100; Good is unmarked and the other words set what a price is worth. Pure.

// The condition words (a piece's cond 0…100) and what a piece is worth in each: Good is unmarked, the rest show their word after the
// name in the prompt, and every price read through `inventory.items` is the def's value times the factor.
export const CONDITION = Object.freeze({
    good: Object.freeze({ min: 70, factor: 1 }),
    worn: Object.freeze({ min: 40, factor: 0.75 }),
    torn: Object.freeze({ min: 1, factor: 0.5 }),
    broken: Object.freeze({ min: 0, factor: 0.2 }),
});

/** good | worn | torn | broken for a condition 0…100 (a missing one is as new). */
export function condWord(cond) {
    const n = Number.isFinite(cond) ? cond : 100;
    return n >= CONDITION.good.min ? 'good' : n >= CONDITION.worn.min ? 'worn' : n >= CONDITION.torn.min ? 'torn' : 'broken';
}

/** The condition after `steps` steps down the words: good → worn (69) → torn (39) → broken (0). */
export function stepDown(cond, steps = 1) {
    let now = Number.isFinite(cond) ? cond : 100;
    for (let n = 0; n < steps; n += 1) now = condWord(now) === 'good' ? CONDITION.good.min - 1 : condWord(now) === 'worn' ? CONDITION.worn.min - 1 : 0;
    return now;
}

/** The condition after one step up the words (broken → torn 39 → worn 69 → good 100), or all the way (`restore`) back to Good. */
export function stepUp(cond, restore = false) {
    const word = condWord(cond);
    if (restore || word === 'worn') return 100;
    return word === 'good' ? 100 : word === 'torn' ? CONDITION.good.min - 1 : CONDITION.worn.min - 1;
}

/** The word the prompt shows after a name (`Cane Sword (worn)`), or '' for Good. */
export const condMark = cond => (condWord(cond) === 'good' ? '' : condWord(cond));

/** What a piece of condition `cond` is worth: `value` × the condition's factor (Good 100%, Worn 75%, Torn 50%, Broken 20%), whole. */
export const valueByCond = (value, cond) => Math.round(value * CONDITION[condWord(cond)].factor);
