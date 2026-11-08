import { spreadWord } from './blocks.js';

// The RPG's shared names (re-exported by index.js, which is where the other pieces import them from).
// They live in a file of their own so the pieces that index.js imports can use them without an import cycle.

/** The feature that switches all of it. */
export const LEAN_RPG_FEATURE = 'story-block.rpg';

/** The prelude command a planned reply's rolls are committed through (turn.js prelude list). */
export const RESOLVE = 'rpg.resolve';
/** The reader's saved target, area and defence choices for one skill (board/overrides.js). */
export const BOARD_SKILL = 'rpg.boardSkill';
export const BOARD_SKILL_CARRY = 'rpg.boardSkillCarry';
/** The prelude that records, with the reply, that a live fight's roll planner (gone; old records only) gave nothing usable (noroll.js): the note under the reply is drawn from it. */
export const NOROLL = 'rpg.noroll';

/** The step after a reply's lines that gives the party its XP for a won fight (fight.js); also the kind of its replay guard. */
export const FIGHT = 'rpg.fight';

/** The step after a reply's lines that gives practice for the skills its rolls used (practice.js); also the kind of its replay guard. */
export const PRACTICE_STEP = 'rpg.practice';

/**
 * Practice by code (practice.js): each use of a skill in a reply's rolls (an act's or a check's skill, a defender's skill) gives the reader's setting
 * (`perUse` unless set, 1 to 5), summed per skill and held to `max` a reply (the same 1..20 the Skills block's practice line takes). A roll made from stage 50 on
 * carries the value in its payload (`practice`); a roll made before has none and gives no practice by code.
 */
export const PRACTICE = Object.freeze({ perUse: 3, minPerUse: 1, maxPerUse: 5, max: 20 });
/** The setting (Story Block's own bucket, Settings → RPG): the practice one use gives, 1 to 5 (3 unset). A roll records the value it was made with (`practice` in its payload). */
export const PRACTICE_SETTING = 'rpgPracticePerUse';
/** `value` as a practice per use: a whole number from 1 to 5, else null. */
export const practiceOf = value => (Number.isInteger(value) && value >= PRACTICE.minPerUse && value <= PRACTICE.maxPerUse ? value : null);

/** `role` on a block definition: what the RPG reads it as. A Character, Skills or Foes block names its `who`. */
export const ROLES = Object.freeze(['character', 'skills', 'foes', 'rules']);

/** The roles whose blocks get no tab of their own while the feature is on (the Party tab draws them, the Fight tab the Foes block; they stay in Settings → Blocks). */
export const ROLES_WITHOUT_TAB = Object.freeze(['character', 'skills', 'foes', 'rules']);

/** The seven stats, 1–20 each (a pack may rename them through its Character template's field labels). */
export const STATS = Object.freeze(['str', 'vit', 'agi', 'dex', 'int', 'luk', 'cha']);

/** Stage words, full → empty. Field values are the stage index (0 = empty) so a meter can draw them. */
export const STAGES = Object.freeze({
    health: Object.freeze(['Down', 'Badly wounded', 'Wounded', 'Hurt', 'Scratched', 'Unhurt']),
    mana: Object.freeze(['Empty', 'Drained', 'Low', 'Steady', 'Fresh']),
    stamina: Object.freeze(['Empty', 'Spent', 'Tired', 'Winded', 'Fresh']),
});

/**
 * The stage word of a bar that holds `value` blocks of `size` (the Standard formula): the first word for none, the last for a full bar, every other
 * count the nearest word in between (blocks.js spreadWord, which the Party tab and the tail use too, so the sheet text, the cue and the story
 * all say the same word). `words` is one of STAGES.
 */
export const stageWord = (words, value, size) => spreadWord(words, Number.isFinite(value) ? Math.trunc(value) : 0, size);

/** The formula (SPEC_RPG §0): PC d20 + stat/2 + 2×class + skill rank vs foe d20 + 5 + 2×class. */
export const FORMULA = Object.freeze({ die: 20, statDivisor: 2, classWeight: 2, foeBase: 5, edgeMax: 3, costMargin: 2 });

/** Pacing: exchanges per reply. (From the second flow, FLOW_VERSION in resolve.js, only `careful` limits a reply: 1 exchange; the others run to the cap.) */
export const PACE = Object.freeze({ careful: 1, normal: 5, all: 8 });

/** Foe slots of a Foes block: `foe1`…`foe4` (skill slots: ../skill-slots.js). */
export const FOE_SLOTS = 4;

/**
 * What bounds a reply's rolls (SPEC_RPG_v1 §4.5.3): at most `roundCap` rounds whatever the pace says, a round that
 * holds a natural 1 or 20 or a margin of `decisiveMargin` either way is the last, and the cue stays within
 * `cueTokens` (about four characters each). `dc` is the number a check's difficulty word stands for.
 */
export const LIMITS = Object.freeze({
    // The cap of a roll made before the flow of stage 49 (`flow` absent in its payload): such a roll, and one recorded with no numbers at all, keeps it.
    roundCap: 5,
    // The most exchanges one reply holds by default (every preset; Custom may pick 1 to 8): a fight now runs until something happens (resolve.js).
    roundCapDefault: 8,
    decisiveMargin: 8,
    cueTokens: 600,
    dc: Object.freeze({ easy: 10, normal: 15, hard: 20, 'very hard': 25 }),
    acts: 6,
    foes: FOE_SLOTS,
    checks: 4,
});

/**
 * The setting that decides whether the pre-call runs: `rpgRolls`, 'automatic' (default) or 'off'. It lives in
 * Story Block's own settings; the RPG settings page draws it.
 */
export const ROLLS_SETTING = 'rpgRolls';
export const ROLLS = Object.freeze(['automatic', 'off']);
/**
 * The setting (Settings → RPG → Fight board): the most exchanges Auto plays before it stops, 1 to 8, or 9 for "Until the end"; 3 unset.
 * `autoCapFrom(values)` is that number held to 1..9; `autoExchanges` is how many exchanges it allows (Infinity for 9).
 */
export const AUTO_CAP_SETTING = 'rpgAutoCap';
export const AUTO_CAP = Object.freeze({ min: 1, max: 9, default: 3, end: 9 });
export const autoCapFrom = values => (Number.isInteger(values?.[AUTO_CAP_SETTING]) && values[AUTO_CAP_SETTING] >= AUTO_CAP.min && values[AUTO_CAP_SETTING] <= AUTO_CAP.max
    ? values[AUTO_CAP_SETTING] : AUTO_CAP.default);
/** The pre-check (board/precheck-run.js): Settings → RPG → Fight board "Set up a fight from my attack" (on unless set to false), and its time limit in ms. */
export const PRECHECK_SETTING = 'rpgPrecheck';
export const PRECHECK_LIMIT_MS = 20_000;
export const precheckOn = values => values?.[PRECHECK_SETTING] !== false;
export const autoExchanges = cap => (cap >= AUTO_CAP.end ? Infinity : cap);
/** The most seconds an old `rpg.noroll` record may name as the limit its planner was given (replay only: the planner and its setting are gone). */
export const NOROLL_LIMIT_MAX = 120;
/** Skill practice comes only from rolled uses while the RPG is on and Rolls is automatic (the narrator's `practice-N` line is not offered and is refused). */
export const practiceFromRollsOnly = (rpgOn, values) => rpgOn === true && values?.[ROLLS_SETTING] !== 'off';

/**
 * XP for a won fight (fight.js), worked out for each party member who has not Left, group by group from the member's level against the group's:
 * base = count × max(1, ceil(foeLevel / `perLevels`)) × `perBand`, times clamp(100 + `gapPercent` × (foeLevel − memberLevel), 0, `maxPercent`) per cent. The groups
 * are added (whole per cents, so no rounding error) and rounded down; a total above 0 is held to `min` .. `max`, a total of 0 gives nothing.
 * Level 5 against six level 5 crawlers: 6 × 1 × 2 = 12.
 */
export const FIGHT_XP = Object.freeze({ markedFirst: 15, markedMore: 2, perBand: 2, perLevels: 10, gapPercent: 10, maxPercent: 200, min: 1, max: 60 });

/** The line the narrator writes where the fight is told (the battle log is drawn there). */
export const BATTLE_MARKER = '[battle]';

/**
 * Levels (2.17.0, replaces the Soul Class I–IX): a character has a level 1..`max`, `xpPerLevel` XP raise it by one (up to the character's own `cap`: the
 * pack's `rpg.levelCap` first, else the setting `rpgLevelCap`, else 99), every `pointEvery`-th level gives a point to spend. A roll adds `levelBonus(level, divisor)`
 * = floor(level / divisor) in place of the old weight × Soul Class (formula.js; `divisor` 5 by default, Custom `minDivisor`..`maxDivisor`). A roll made
 * with it carries `lv: 1` (LV_VERSION) and the divisor in its rules (`levelDivisor`); a roll without them replays with the Soul Class exactly as before.
 */
export const LEVEL = Object.freeze({ min: 1, max: 99, xpPerLevel: 100, xpMax: 9999, pointEvery: 3, divisor: 5, minDivisor: 3, maxDivisor: 8 });
/** The version of the roll term a payload asks for (`lv` in the payload of `rpg.resolve`): 1 = level bonus. */
export const LV_VERSION = 1;
/** The setting (Story Block's own bucket, Settings → RPG): the highest level a character can reach, 1 to 99 (99 unset). A pack's own cap comes first (levelCapFor: pack, then this setting, then 99). */
export const LEVEL_CAP_SETTING = 'rpgLevelCap';
/** `value` as a level cap: a whole number from 1 to 99, else null. */
export const levelCapOf = value => (Number.isInteger(value) && value >= LEVEL.min && value <= LEVEL.max ? value : null);

/** What a skill's rank (0–3) and a Soul Class (1–9) are called. */
export const RANK_NAMES = Object.freeze(['Novice', 'Adept', 'Expert', 'Master']);
export const CLASS_NAMES = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']);

/** What a skill spends: its `uses` (a skill whose resource is Empty is rolled without it). */
export const USES = Object.freeze(['stamina', 'mana']);

/**
 * The New character wizard's budget (SPEC_RPG, mockup section 4): every stat starts at `start`, the reader has `budget`
 * points to spend, a stat may go down to `min` to free a point and up to `max` at creation. A character starts with up to
 * `skills` skills, at most `adept` of them at Adept and the rest Novice. Text limits are the Character and Skills fields'.
 */
export const CREATION = Object.freeze({
    start: 10, budget: 6, min: 8, max: 15, skills: 5, adept: 1,
    name: 40, about: 240, skillName: 40, skillAbout: 120,
});

/**
 * Companions who join (mockup section 8): the setting `rpgJoin` says what the story's `+ party Name | …` line does. 'ask' (the default)
 * puts a card under the reply and makes nothing until the reader says so; 'auto' makes the companion at once; 'off' leaves the line out
 * of the narrator's grammar. A party holds at most PARTY_MAX characters (the ones who left count: their sheets are kept).
 */
export const JOIN_SETTING = 'rpgJoin';
export const JOINS = Object.freeze(['ask', 'auto', 'off']);
export const PARTY_MAX = 8;

/** A roll's rules mark (`fix` in `rpg.resolve`; 2: stage 65, 3: `then:`); none replays as before. */
export const FIX_VERSION = 3;
