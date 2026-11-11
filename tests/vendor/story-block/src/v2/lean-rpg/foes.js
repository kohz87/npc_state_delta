// Foes by level (Levels release). A foe group has a level, 1..99, instead of a Soul Class. Pure helpers, no imports but the seeded generator:
// - the roll term (`levelBonus`) and a Standard foe's Health blocks (`foeBlocksByLevel`);
// - where a level comes from (`pickLevel`): the line gave it (`level: N`), or gave a rank (a seeded level inside that rank's band), or neither (a seeded level
//   within ±2 of the party's average level, held to 1..99). The seed is the reply's own dice seed, so a swipe (a new seed) draws a new level and a
//   Re-read (the same seed) keeps it;
// - `bandOfRank`: a rank's band, found through the `rpg.rank` query (`{ level }` → `{ name } | null`) by asking for each level.
import { rng as seeded } from '../rng.js';
import { LV_VERSION } from './names.js';
import { classOfLevel, levelBonus, levelOfClass as mapClass } from './formula.js';
// (one copy each: the version mark is names.js's, the roll term and the class <-> level mapping, 10n - 5, are formula.js's)
export { LV_VERSION, classOfLevel, levelBonus };

/** The level a Soul Class (1-9) stands for (formula.js levelOfClass: class n -> 10n - 5), or null where no class is given. */
export const levelOfClass = soulClass => (Number.isInteger(soulClass) && soulClass >= 1 && soulClass <= 9 ? mapClass(soulClass) : null);

/** The levels a foe may have, how far from the party's average an unplanned one lands, the roll term's default divisor, and the Health block rule. */
export const FOE_LEVEL = Object.freeze({ min: 1, max: 99, spread: 2, divisor: 5, healthBase: 4, healthStep: 30, hardBase: 12, hardMax: 15, hardDivisor: 4, band: 20, oldBand: 10 });

const whole = value => (typeof value === 'number' && Number.isInteger(value) ? value : typeof value === 'string' && /^\s*-?\d+\s*$/u.test(value) ? Number(value) : null);

/** `value` as a level: a whole number held to 1..99, else null. */
export const levelOf = value => {
    const n = whole(value);
    return n === null ? null : Math.max(FOE_LEVEL.min, Math.min(FOE_LEVEL.max, n));
};


/** A Standard foe's Health blocks: 4 + floor(level / 30) (levels 1–29 give 4, 30–59 give 5, 60–89 give 6, 90–99 give 7). */
export const foeBlocksByLevel = level => FOE_LEVEL.healthBase + Math.floor(Math.max(FOE_LEVEL.min, Number(level) || 0) / FOE_LEVEL.healthStep);

/** The same under the harder-foes rule (a Foes block whose Health field holds up to `hardMax`, `isHardBar`): 12 + floor(level / 30), 12 to 15. */
export const hardBlocksByLevel = level => FOE_LEVEL.hardBase + Math.floor(Math.max(FOE_LEVEL.min, Number(level) || 0) / FOE_LEVEL.healthStep);

/** A foe Health field of the harder-foes rule: only a Foes block made from the new template holds that many blocks (an older block keeps its 8 and the old numbers). */
export const isHardBar = schema => Number.isFinite(schema?.max) && schema.max >= FOE_LEVEL.hardMax;

/**
 * The most a NEW foe's level may be: the party's highest level + 20 (`band`), at most 99 (the party with no one is level 1, so 21). `band` 10 (`oldBand`) is the
 * cap a reply captured before the +20 rule keeps on a Re-read (it has no `foeCap` mark; act.js). It is a ceiling only: nothing raises a level to it.
 */
export const foeLevelCap = (levels, band = FOE_LEVEL.band) => Math.min(FOE_LEVEL.max, Math.max(FOE_LEVEL.min, ...(levels ?? []).filter(value => Number.isInteger(value) && value >= 1)) + band);

/** The party's average level, rounded to the nearest whole level (1 with no one): `levels` is a list of numbers, anything else in it is passed over. */
export function averageLevel(levels) {
    const list = (levels ?? []).filter(value => Number.isFinite(value) && value >= 1);
    return list.length ? Math.max(FOE_LEVEL.min, Math.min(FOE_LEVEL.max, Math.round(list.reduce((sum, value) => sum + value, 0) / list.length))) : FOE_LEVEL.min;
}

/** The levels of a sheet's party (readSheet): each member's `level`, else, for a block of the earlier rules, the level their Soul Class stands for. Left or dead are not counted. */
export const partyLevels = sheet => (sheet?.characters ?? []).filter(entry => entry?.alive !== false)
    .map(entry => (Number.isInteger(entry.level) ? entry.level : levelOfClass(entry.soul))).filter(value => Number.isInteger(value));

/**
 * A foe's level. `ask`: `{ level }` (used as given, held to 1..99), or `{ from, to }` (a rank's band: a seeded level inside it), or `{}` (a seeded level within ±2 of
 * `around`, the party's average, held to 1..99). `random` is a function giving [0, 1) (the reply's seeded generator).
 */
export function pickLevel(ask, around, random) {
    const given = levelOf(ask?.level);
    if (given !== null) return given;
    const from = levelOf(ask?.from), to = levelOf(ask?.to);
    if (from !== null && to !== null && from <= to) return from + Math.floor(random() * (to - from + 1));
    const centre = levelOf(around) ?? FOE_LEVEL.min;
    const level = centre - FOE_LEVEL.spread + Math.floor(random() * (2 * FOE_LEVEL.spread + 1));
    return Math.max(FOE_LEVEL.min, Math.min(FOE_LEVEL.max, level));
}

const SALT = 0x4C56B0F3;

/** The generator of the foe with place `at` (0-based) among the ones a reply opens or sets, from the reply's seed number `base` (a uint32): one stream each, so none moves another. */
export const foeRandom = (base, at) => seeded(((base >>> 0) ^ Math.imul(at + 1, 0x9E3779B1) ^ SALT) >>> 0);

/**
 * A rank's band `{ from, to }`, found with `rankAt(level)` → `{ name } | null` (the `rpg.rank` query): the levels 1..99 whose rank has this name
 * (compared without case); null when none has. A query that throws or answers nothing means no band.
 */
export function bandOfRank(name, rankAt) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted || typeof rankAt !== 'function') return null;
    let from = null, to = null;
    for (let level = FOE_LEVEL.min; level <= FOE_LEVEL.max; level += 1) {
        let found = null;
        try { found = rankAt(level); } catch { return null; }
        const hit = typeof found?.name === 'string' && found.name.trim().toLowerCase() === wanted;
        if (hit) { if (from === null) from = level; to = level; } else if (from !== null) break;
    }
    return from === null ? null : { from, to };
}

/** How a foe's level reads in a line: "Rank E · Lv 14" when `rankAt` names one, else "Lv 14". */
export function foeLabel(level, rankAt = null) {
    let name = null;
    try { name = typeof rankAt === 'function' ? rankAt(level)?.name ?? null : null; } catch { name = null; }
    return name ? `Rank ${name} · Lv ${level}` : `Lv ${level}`;
}

/**
 * The foes of a plan's `open` list with their levels settled, from the reply's seed number `base`: an entry that has a `level` keeps it, one with a band
 * (`from`, `to`) draws inside it, one with neither draws near `around`. → [{ name, count, level }] (the same places).
 */
export const settleOpen = (open, around, base) => (open ?? []).map((entry, at) => ({
    name: entry.name, count: entry.count, level: pickLevel(entry, around, foeRandom(base, at)),
}));
