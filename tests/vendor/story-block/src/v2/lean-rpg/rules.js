// The numbers a roll is made with, and the odds they give (Settings → RPG, mockup section 6).
//
// A roll uses the Standard formula's numbers (formula.js): the foe's base and class weight, what a Soul Class (or level) adds, how far short a total may
// fall and still be "success at a cost", the margin that makes a round decisive, the most exchanges one reply may hold, and the creation numbers. Gentle and
// Harsh move the foe's base; Custom is what the reader typed (each number held to its range). Classic rules are gone: a payload with no `formula` replays as Standard.
//
// REPLAY RULE: the numbers in force are chosen here, once, when the roll is planned (precall.js), and travel inside the
// `rpg.resolve` payload (`rules`). The payload is what a Re-read, a rebuild and a reload run again, so a roll is always
// made again with the numbers it was first made with, never with today's settings. Changing a setting changes new rolls only.
//
// The Standard stat formula's numbers (`formula: 'standard'` plus the rest) travel in the same payload.
import { FORMULA, LEVEL, LEVEL_CAP_SETTING, LIMITS, levelCapOf } from './names.js';
import { FOE_LEVEL } from './foes.js';
import { STANDARD_NUMBERS, foeBonus, levelBonus, levelOfClass, statPart } from './formula.js';

// LEVELS (2.17.0, names.js LEVEL): a set of numbers may carry `levelDivisor` (3..8): then the roll's term for a party member is levelBonus(level, divisor) in place
// of classWeight × Soul Class, and a foe's is its base + levelBonus(foe level, divisor). A set without it (every roll made before) is read exactly as before.
// It is not one of RULE_KEYS / STANDARD_RULE_KEYS (the Custom rows of the settings window keep their count); normalize keeps it, last, when it is valid.

/** Whether numbers are the level-based ones (a roll made from 2.17.0 on). */
export const hasLevels = rules => Number.isInteger(rules?.levelDivisor);

/** A level divisor: a whole number from LEVEL.minDivisor to LEVEL.maxDivisor, else null. */
export const divisorOf = value => (Number.isInteger(value) && value >= LEVEL.minDivisor && value <= LEVEL.maxDivisor ? value : null);

/**
 * What a party member adds to a roll under `rules` besides the stat and the rank: `{ classValue, classBonus }`. Levelled numbers: the character's level and
 * levelBonus(level, divisor). Earlier numbers: the Soul Class and classWeight × it.
 */
export const classTerm = (rules, character) => (hasLevels(rules)
    ? { classValue: character.level, classBonus: levelBonus(character.level, rules.levelDivisor) }
    : { classValue: character.soul, classBonus: rules.classWeight * character.soul });

/** The choices the reader sees, in order. */
export const DIFFICULTIES = Object.freeze(['gentle', 'standard', 'harsh', 'custom']);

/** The settings (Story Block's own bucket): the difficulty word. */
export const DIFFICULTY_SETTING = 'rpgDifficulty';

// ---- the level cap -----------------------------------------------------------------------------------------------------

/**
 * The highest level a new character may reach: the story's pack asks for one (`packCap`, a whole number 1..99), else the reader's setting `rpgLevelCap`, else 99.
 * It is the default of the Character block's `cap` field (a made character keeps its own).
 */
export const levelCapFor = (values, packCap = null) => levelCapOf(packCap) ?? levelCapOf(values?.[LEVEL_CAP_SETTING]) ?? LEVEL.max;

// ---- the Standard formula's numbers ------------------------------------------------------------------------------------

/** The Custom numbers of the Standard formula (an object of STANDARD_RULE_KEYS). */
export const STANDARD_SETTING = 'rpgStandard';

/**
 * What a pack asks for, from its `content.rpg` records (packs/validate.js keeps `formula` and `numbers` as one record with the slug `formula`):
 * `{ formula?, numbers? }`, or null. The reader's own choices win over it: it is the default of a story whose reader has not chosen.
 */
export function packRulesOf(records) {
    const found = (Array.isArray(records) ? records : []).find(record => record && typeof record === 'object' && record.slug === 'formula' && (record.formula || record.numbers || levelCapOf(record.levelCap)));
    if (!found) return null;
    return { ...(typeof found.pack === 'string' ? { pack: found.pack } : {}), ...(levelCapOf(found.levelCap) ? { levelCap: found.levelCap } : {}), ...(found.formula === 'standard' ? { formula: found.formula } : {}),
        ...(found.numbers && typeof found.numbers === 'object' && !Array.isArray(found.numbers) ? { numbers: { ...found.numbers } } : {}) };
}

/** Standard's numbers in the order they are stored and shown (the first is the formula itself). */
export const STANDARD_RULE_KEYS = Object.freeze(['formula', 'foeBase', 'foeClassWeight', 'classWeight', 'costMargin', 'decisiveMargin', 'roundCap',
    'startStat', 'createPoints', 'createMin', 'createMax', 'pointsPerSoul', 'statMax', 'quickStartMargin']);

/** What each of Standard's numbers may be (whole numbers, `min` to `max`). */
export const STANDARD_RANGES = Object.freeze({
    foeBase: Object.freeze({ min: 0, max: 15 }),
    foeClassWeight: Object.freeze({ min: 1, max: 5 }),
    classWeight: Object.freeze({ min: 1, max: 3 }),
    costMargin: Object.freeze({ min: 0, max: 5 }),
    decisiveMargin: Object.freeze({ min: 4, max: 15 }),
    roundCap: Object.freeze({ min: 1, max: 8 }),
    startStat: Object.freeze({ min: 1, max: 10 }),
    createPoints: Object.freeze({ min: 0, max: 30 }),
    createMin: Object.freeze({ min: 1, max: 10 }),
    createMax: Object.freeze({ min: 3, max: 20 }),
    pointsPerSoul: Object.freeze({ min: 0, max: 10 }),
    statMax: Object.freeze({ min: 10, max: 20 }),
    quickStartMargin: Object.freeze({ min: 1, max: 30 }),
});

const standardPreset = foeBase => {
    const all = { formula: 'standard', ...STANDARD_NUMBERS, foeBase, classWeight: FORMULA.classWeight, costMargin: FORMULA.costMargin, decisiveMargin: LIMITS.decisiveMargin, roundCap: LIMITS.roundCapDefault };
    return Object.freeze(Object.fromEntries(STANDARD_RULE_KEYS.map(key => [key, all[key]])));
};

/**
 * Standard's three presets: only the foe's base moves (simulation, scripts/sim-standard.mjs: a focused build against a foe of its own
 * Soul Class succeeds about 65 to 80 times in a hundred across Soul Classes I to IX at Standard, a spread build 45 to 60).
 */
export const STANDARD_PRESETS = Object.freeze({
    gentle: standardPreset(2),
    standard: standardPreset(4),
    harsh: standardPreset(6),
});
export const STANDARD_FORMULA = STANDARD_PRESETS.standard;
/** The default numbers of a roll (the Standard preset). */
export const STANDARD = STANDARD_FORMULA;

/**
 * The numbers of a roll recorded before the numbers were kept (a payload with no `rules`): the Standard difficulty with the cap of 5 exchanges it had. Replay reads those with this, never with today's presets.
 */
export const EARLIER_RULES = Object.freeze({ ...STANDARD_FORMULA, roundCap: LIMITS.roundCap });

/** Whether numbers are the Standard formula's. */
export const isStandard = rules => rules?.formula === 'standard';

const whole = (value, range, fallback) => (Number.isSafeInteger(value) && value >= range.min && value <= range.max ? value : fallback);

/**
 * Any value as a full set of numbers: Standard's, each one a whole number inside its range (a value with no `formula`, which only an old record
 * can be, is read as Standard too). Always the same keys in the same order (so the same numbers always hash the same), whatever was given, including nothing.
 */
export const normalizeRules = value => normalizeStandard(value);

/**
 * Any value as Standard's full set of numbers: each one a whole number inside its range, else the Standard preset's; the creation numbers
 * must also agree (lowest ≤ start ≤ highest at creation ≤ the stat maximum), else all four are the preset's. Always the same keys in the same order.
 */
export function normalizeStandard(value) {
    const given = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = Object.fromEntries(STANDARD_RULE_KEYS.map(key => [key, key === 'formula' ? 'standard' : whole(given[key], STANDARD_RANGES[key], STANDARD_FORMULA[key])]));
    if (!(out.createMin <= out.startStat && out.startStat <= out.createMax && out.createMax <= out.statMax)) {
        for (const key of ['startStat', 'createMin', 'createMax', 'statMax']) out[key] = STANDARD_FORMULA[key];
    }
    if (divisorOf(given.levelDivisor)) out.levelDivisor = given.levelDivisor;
    return out;
}

/** The difficulty the settings say: a known word, else Standard. */
export const difficultyOf = values => (DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) ? values[DIFFICULTY_SETTING] : 'standard');

/** The numbers the settings give now: the preset, or the Custom numbers (held to their ranges); `pack` (packRulesOf) fills in what the reader has not chosen. */
export function rulesFromSettings(values, pack = null) {
    // Every roll planned from now on is a levelled one: the divisor is the Custom row's (3..8), else 5.
    const base = plainRulesFromSettings(values, pack), custom = difficultyOf(values) === 'custom';
    const typed = custom ? divisorOf(values?.[STANDARD_SETTING]?.levelDivisor) : null;
    return { ...base, levelDivisor: typed ?? LEVEL.divisor };
}

function plainRulesFromSettings(values, pack) {
    const difficulty = difficultyOf(values);
    if (difficulty === 'custom') return normalizeStandard({ ...values?.[STANDARD_SETTING], formula: 'standard' });
    const preset = { ...STANDARD_PRESETS[difficulty] };
    // A pack's numbers are the defaults of a reader who never picked a difficulty; a picked difficulty is the reader's.
    const asked = pack?.numbers && !DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) ? pack.numbers : null;
    return asked ? normalizeStandard({ ...preset, ...asked, formula: 'standard' }) : preset;
}

/**
 * What of a pack's ask is in force now: `{ formula, numbers }` booleans. Standard is the only formula, so `formula` is never an ask in force; the numbers are
 * the pack's when the reader has not picked a difficulty (the rules of rulesFromSettings).
 */
export function packInForce(values, pack) {
    if (!pack) return { formula: false, numbers: false };
    return { formula: false,
        numbers: Boolean(pack.numbers) && !DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) && difficultyOf(values) !== 'custom' };
}

/** Whether two sets of numbers are the same numbers. */
export const sameRules = (a, b) => {
    const [x, y] = [normalizeRules(a), normalizeRules(b)];
    return Object.keys(x).every(key => x[key] === y[key]) && (x.levelDivisor ?? LEVEL.divisor) === (y.levelDivisor ?? LEVEL.divisor);
};

/** The preset these numbers are exactly, else 'custom'. */
export const presetOf = rules => DIFFICULTIES.slice(0, 3).find(name => sameRules(STANDARD_PRESETS[name], rules)) ?? 'custom';

// What a foe of `foeClass` (its level, under levelled numbers) adds to its die.
const foeSide = (r, foeClass, hard = false) => (hasLevels(r) ? r.foeBase + levelBonus(foeClass, hard ? FOE_LEVEL.hardDivisor : r.levelDivisor) : foeBonus(foeClass, r));

/**
 * The exact chances of one roll under `rules`: the party member's d20 + `bonus` against a foe's d20 + the foe's base + the
 * Soul Class weight × `foeClass`, the outcome rule of resolve.js (a natural 20 succeeds, a natural 1 fails, a total that
 * reaches the foe's succeeds, one within `costMargin` short is a success at a cost). Counts all 400 pairs of dice.
 * `hard`: the harder-foes rule, where the foe adds level / 4 (board/flags.js hardFightFor); only levelled numbers read it.
 * → { success, cost, fail }, whole percentages each rounded on its own (they may add up to 99 or 101).
 */
export function oddsFor(rules, { bonus, foeClass, hard = false }) {
    const r = normalizeRules(rules), die = FORMULA.die;
    let success = 0, cost = 0, fail = 0;
    for (let mine = 1; mine <= die; mine += 1) {
        for (let theirs = 1; theirs <= die; theirs += 1) {
            const total = mine + bonus, against = theirs + foeSide(r, foeClass, hard);
            if (mine === die || (mine !== 1 && total >= against)) success += 1;
            else if (mine !== 1 && total >= against - r.costMargin) cost += 1;
            else fail += 1;
        }
    }
    const percent = count => Math.round((count * 100) / (die * die));
    return { success: percent(success), cost: percent(cost), fail: percent(fail) };
}

/**
 * Who the odds are shown for: the reader's own character (by name, else the first Character block), the skill they are best
 * at (highest rank, the first on a tie; none: their best stat untrained), against a foe of their own Soul Class.
 * `sheet` is readSheet's answer, `own` the reader's name, `names` = { rank: [...], soul: [...] } the words for ranks and classes; `standard`
 * adds the character's stats and the skill's resource, which the Standard formula needs.
 * → null (no character), else { who, label, stat, statValue, soul, rank, rankName, soulName (the Character block's own word for it), skill, bonus (under `rules`), foeClass }.
 */
export function oddsSubject(sheet, own, { rankNames, soulNames, fold, standard = false }) {
    const characters = sheet?.characters ?? [];
    const mine = own ? characters.find(entry => fold(entry.who) === fold(own)) : null;
    const who = mine ?? characters[0];
    if (!who) return null;
    const best = who.skills.reduce((top, skill) => (!top || skill.rank > top.rank ? skill : top), null);
    const strongest = Object.entries(who.stats).filter(([, value]) => Number.isInteger(value)).reduce((top, entry) => (!top || entry[1] > top[1] ? entry : top), null);
    // (Standard: a skill with no stat of its own, or no skill, rolls the type's own: INT for a mana skill, else STR.)
    const fallback = standard ? (best?.uses === 'mana' ? 'int' : 'str') : strongest?.[0] ?? null;
    const stat = best?.stat && Number.isInteger(who.stats[best.stat]) ? best.stat : fallback;
    if (!stat || !Number.isInteger(who.stats[stat])) return null;
    const rank = best?.rank ?? 0;
    return {
        who: who.who, stat, statValue: who.stats[stat], soul: who.soul, level: who.level ?? levelOfClass(who.soul), rank, skill: best?.name ?? null, foeClass: who.soul, foeLevel: who.level ?? levelOfClass(who.soul),
        ...(standard ? { stats: who.stats, uses: best?.uses ?? null } : {}),
        rankName: best ? rankNames[rank] ?? String(rank) : '', soulName: who.soulWord ?? soulNames[who.soul - 1] ?? String(who.soul),
    };
}

/** The bonus the subject rolls with under `rules` (the stat's share, the Soul Class and the skill rank), and the odds against a foe of their class. */
export function subjectOdds(rules, subject) {
    const r = normalizeRules(rules);
    // Standard: the skill's stat in the main slot with half of DEX (a stamina skill is physical, a mana skill magic), halved.
    const stat = statPart(subject.uses === 'mana' ? 'magic' : 'physical', subject.stats ?? { [subject.stat]: subject.statValue }, { skillStat: subject.stat }).value;
    const levels = hasLevels(r);
    const bonus = stat + (levels ? levelBonus(subject.level, r.levelDivisor) : r.classWeight * subject.soul) + subject.rank;
    return { bonus, ...oddsFor(r, { bonus, foeClass: levels ? subject.foeLevel : subject.foeClass, hard: subject.hard === true }) };
}
