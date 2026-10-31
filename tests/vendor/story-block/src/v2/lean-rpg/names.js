// The RPG's shared names (re-exported by index.js, which is where the other pieces import them from).
// They live in a file of their own so the pieces that index.js imports can use them without an import cycle.

/** The feature that switches all of it. */
export const LEAN_RPG_FEATURE = 'story-block.rpg';

/** The prelude command a planned reply's rolls are committed through (turn.js prelude list). */
export const RESOLVE = 'rpg.resolve';

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

/** The formula (SPEC_RPG §0): PC d20 + stat/2 + 2×class + skill rank vs foe d20 + 5 + 2×class. */
export const FORMULA = Object.freeze({ die: 20, statDivisor: 2, classWeight: 2, foeBase: 5, edgeMax: 3, costMargin: 2 });

/** Pacing: exchanges per reply. */
export const PACE = Object.freeze({ careful: 1, normal: 5, all: 8 });

/** How many skill slots a Skills block has (`skill1`…`skill5`, `rank1`…, `practice1`…) and foe slots a Foes block (`foe1`…`foe4`). */
export const SKILL_SLOTS = 5;
export const FOE_SLOTS = 4;

/**
 * What bounds a reply's rolls (SPEC_RPG_v1 §4.5.3): at most `roundCap` rounds whatever the pace says, a round that
 * holds a natural 1 or 20 or a margin of `decisiveMargin` either way is the last, and the cue stays within
 * `cueTokens` (about four characters each). `dc` is the number a check's difficulty word stands for.
 */
export const LIMITS = Object.freeze({
    roundCap: 5,
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

/** The line the narrator writes where the fight is told (the battle log is drawn there). */
export const BATTLE_MARKER = '[battle]';

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
    start: 10, budget: 6, min: 8, max: 15, skills: SKILL_SLOTS, adept: 1,
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
