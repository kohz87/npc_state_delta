// The RPG block templates (Character, Skills, Foes, Combat rules): data-module definitions that the block
// chooser offers while the RPG feature is on (Settings → Blocks → From a template). Each carries a `role`
// (see ROLES in index.js) and keeps the field keys the RPG reads. Stage fields are indexes (0 = empty) with
// `names` from STAGES; the level is a number 1–99 (stage 51; the Soul Class I–IX of earlier blocks is not in new templates) and ranks are numbers with names. The block engine adds three things these
// use: `names` and `prompt: false` on fields, and the `replyEnd` and `cards` lists. The Skills block's rank and practice
// are `edit: false` (they only move through play); SKILL_SETS are the New character wizard's built-in skill sets.
import { CREATION, LEVEL, STATS, STAGES, USES } from './names.js';
import { SIGNATURE_FIELD, SKILL_SLOTS_MAX } from '../skill-slots.js';
import { STANDARD_NUMBERS } from './formula.js';
import { scaledCharacter } from './templates-bars.js';
import { withRecovery } from './templates-recovery.js';
import { typedSkills } from './templates-skills.js';

const names = (words, first = 0) => Object.fromEntries(words.map((word, index) => [String(index + first), word]));
const HEALTH = names(STAGES.health);
const MANA = names(STAGES.mana);
const STAMINA = names(STAGES.stamina);
const SOUL = names(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'], 1);
const RANK = names(['Novice', 'Adept', 'Expert', 'Master']);
const SKILLS = Array.from({ length: SKILL_SLOTS_MAX }, (_, at) => at + 1);
const SLOTS = [1, 2, 3, 4];

const text = (label, max = CREATION.skillName) => ({ type: 'text', max, default: '', label });
const int = (label, min, max, value, extra = {}) => ({ type: 'int', min, max, default: value, label, ...extra });
const range = (min, max) => ({ type: 'int', min, max });
const get = field => ['get', [field]];

const COMBAT_PROMPT = [
    '[COMBAT SYSTEM]',
    'No Plot Armor: combat follows physical reality and the lore. Size, skill, numbers, reach, armor, terrain, preparation and Level all matter. Against a stronger foe, {{user}} loses unless a believable edge exists: ambush, terrain, numbers, poison, preparation.',
    'Exchanges: a fight is told exchange by exchange, each with clear cause, cost and consequence, in the order things happen. Most fights are short; one exchange may be the whole fight. Never skip the moment that decides it.',
    'Weight & Risk: every strike, miss, wound and hesitation carries impact. Injury, fatigue, fear and pain carry into the next exchange and the next scene.',
    'Believable Outcomes: fights end when logic demands it: death, surrender, retreat, capture or collapse. NPCs take those exits when the fight turns against them. Victory must be earned; survival must be justified.',
    'XP guide: code gives XP for a won fight; write none for it. Other deeds 5 to 40. Practice a skill 5 to 20 per use.',
].join('\n');

// The level rise. The XP field holds up to LEVEL.xpMax, so XP above 100 is kept: a reply that gives 95 + 40 leaves 35 over. The rise is worked out once from the
// XP and the room under the cap, `rise` = min(floor(xp / 100), cap − level) levels, and carries the remainder: it gives one point to spend for every multiple of
// LEVEL.pointEvery (3) the new levels cross (floor((level + rise) / 3) − floor(level / 3)), raises the level by `rise` and takes 100 XP for each. `rise` is the
// rule's own working number (hidden, not in the prompt). A second rule holds the XP at 100 at the cap, so the XP past the cap is not kept.
const levelUp = () => ({ id: 'level-up', when: ['and', ['ge', get('xp'), LEVEL.xpPerLevel], ['lt', get('level'), get('cap')]],
    then: [{ op: 'set', path: ['rise'], value: ['min', ['floorDiv', get('xp'), LEVEL.xpPerLevel], ['sub', get('cap'), get('level')]] },
        { op: 'add', path: ['points'], value: ['sub', ['floorDiv', ['add', get('level'), get('rise')], LEVEL.pointEvery], ['floorDiv', get('level'), LEVEL.pointEvery]], bounds: 'clamp' },
        { op: 'add', path: ['level'], value: get('rise'), bounds: 'clamp' }, { op: 'add', path: ['xp'], value: ['mul', get('rise'), -LEVEL.xpPerLevel], bounds: 'clamp' },
        { op: 'set', path: ['rise'], value: 0 }] });
const xpCap = () => ({ id: 'xp-cap', when: ['and', ['ge', get('level'), get('cap')], ['gt', get('xp'), LEVEL.xpPerLevel]], then: [{ op: 'set', path: ['xp'], value: LEVEL.xpPerLevel }] });

const character = {
    slug: 'character', name: 'Character', role: 'character', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: 'One character: who they are, health, mana and stamina (words, shown as bars), seven stats from 1 to 20, unspent points, Level 1 to 99 and XP to 100. The narrator sets health, mana, stamina and XP; the story cannot kill a character outright: they die only when they were already Down before a reply and are still Down at its end. The reader sets stats and points. XP at 100 raises the Level by one, up to the Level cap, and every third Level gives a point to spend on stats.',
    show: { tab: true, card: false, tabName: 'Character', icon: 'ph-user' },
    state: {
        who: text('Name'),
        about: text('Who they are', CREATION.about),
        health: int('Health', 0, 5, 5, { names: HEALTH }),
        mana: int('Mana', 0, 4, 4, { names: MANA }),
        stamina: int('Stamina', 0, 4, 4, { names: STAMINA }),
        ...Object.fromEntries(STATS.map(stat => [stat, int(stat.toUpperCase(), 1, 20, 10)])),
        points: int('Points', 0, 60, 0),
        level: int('Level', LEVEL.min, LEVEL.max, 1),
        xp: int('XP', 0, LEVEL.xpMax, 0),
        rise: int('Rise', 0, LEVEL.max, 0, { prompt: false, edit: false }),
        cap: int('Level cap', LEVEL.min, LEVEL.max, LEVEL.max, { prompt: false }),
        down: { type: 'bool', default: false, label: 'Down', prompt: false },
        alive: { type: 'bool', default: true, label: 'Alive' },
        // A companion who left the party (a `- party Name` line, join.js): kept on the Party tab, greyed, and no longer rolled for.
        left: { type: 'bool', default: false, label: 'Left' },
    },
    kinds: {
        'set-health': { op: '~', labels: { to: range(0, 5) }, effects: [{ op: 'set', path: ['health'], value: ['arg', 'to'] }] },
        'set-mana': { op: '~', labels: { to: range(0, 4) }, effects: [{ op: 'set', path: ['mana'], value: ['arg', 'to'] }] },
        'set-stamina': { op: '~', labels: { to: range(0, 4) }, effects: [{ op: 'set', path: ['stamina'], value: ['arg', 'to'] }] },
        'add-xp': { op: '+', labels: { amount: range(0, 100) }, effects: [{ op: 'add', path: ['xp'], value: ['arg', 'amount'], bounds: 'clamp' }] },
        'button-rest': { op: '!', ui: true, title: 'Rest', labels: {}, effects: [{ op: 'set', path: ['stamina'], value: 4 }, { op: 'set', path: ['mana'], value: 4 }] },
    },
    rules: [levelUp(), xpCap()],
    // The story has no kind that sets `alive`: death comes only through this latch. (The reader may still fix `alive` with the pencil.)
    // Death is a latch over two reply-end functions, run in this order: the first ends the story only when the
    // character was already Down when the reply started; the second then records whether they are Down now.
    replyEnd: [
        { type: 'reply-end', when: ['and', ['eq', get('health'), 0], get('down')], effects: [{ op: 'set', path: ['alive'], value: false }] },
        { type: 'reply-end', when: true, effects: [{ op: 'set', path: ['down'], value: ['eq', get('health'), 0] }] },
    ],
    cards: [
        { type: 'card', when: ['not', get('alive')], tone: 'end', title: 'The story ends here',
            text: 'This character has died. Swipe or delete the reply that ended it to take that back.' },
    ],
};

const skills = {
    slug: 'skills', name: 'Skills', role: 'skills', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: 'Five skills for one character, a sixth at Lv 20, a seventh at 40 and an eighth at 60. Each has a description, the stat it rolls with, what it uses (stamina or mana), a rank (Novice, Adept, Expert, Master) and practice from 0 to 100. The narrator names a skill with a learn line (name, what it does, stat, uses) and adds practice. At 100 practice the rank rises by one and practice starts again at 0; a Master stays at 100.',
    show: { tab: true, card: false, tabName: 'Skills', icon: 'ph-book-open' },
    state: {
        who: text('Name'),
        ...Object.fromEntries(SKILLS.flatMap(n => [
            [`skill${n}`, text(`Skill ${n}`)],
            [`about${n}`, text(`About ${n}`, CREATION.skillAbout)],
            [`stat${n}`, { type: 'enum', values: [...STATS], default: STATS[0], label: `Stat ${n}` }],
            [`uses${n}`, { type: 'enum', values: [...USES], default: USES[0], label: `Uses ${n}` }],
            [`rank${n}`, int(`Rank ${n}`, 0, 3, 0, { names: RANK, edit: false })],
            [`practice${n}`, int(`Practice ${n}`, 0, 100, 0, { edit: false })],
        ])),
        // (a bit for each slot a pack's cast member brought, names.js signatureAt: the story never renames or replaces those; the reader cannot type it and the narrator is not told it)
        [SIGNATURE_FIELD]: int('Signature skills', 0, 2 ** SKILL_SLOTS_MAX - 1, 0, { edit: false, prompt: false }),
    },
    kinds: Object.fromEntries(SKILLS.flatMap(n => [
        [`learn-${n}`, { op: '~', labels: { name: { type: 'text', max: CREATION.skillName }, about: { type: 'text', max: CREATION.skillAbout }, stat: { type: 'enum', values: [...STATS] }, uses: { type: 'enum', values: [...USES] } },
            effects: [{ op: 'set', path: [`skill${n}`], value: ['arg', 'name'] }, { op: 'set', path: [`about${n}`], value: ['arg', 'about'] },
                { op: 'set', path: [`stat${n}`], value: ['arg', 'stat'] }, { op: 'set', path: [`uses${n}`], value: ['arg', 'uses'] }] }],
        [`practice-${n}`, { op: '+', labels: { amount: range(1, 20) },
            when: ['ne', get(`skill${n}`), ''], refusal: 'Name the skill before it can be practised.',
            effects: [{ op: 'add', path: [`practice${n}`], value: ['arg', 'amount'], bounds: 'clamp' }] }],
    ])),
    rules: SKILLS.map(n => ({ id: `rank-up-${n}`, when: ['and', ['ge', get(`practice${n}`), 100], ['lt', get(`rank${n}`), 3]],
        then: [{ op: 'add', path: [`rank${n}`], value: 1, bounds: 'clamp' }, { op: 'set', path: [`practice${n}`], value: 0 }] })),
};

// The Skills block with one more guard (the base definition below, and so its hash, never changes). A filled slot is never
// overwritten: the host sends a `learn-N` line to the slot already holding that name (updating it) or to a free one (data-modules/part.js
// skillRoute), so what reaches this condition is a free slot.
const standardSkills = {
    ...skills,
    // (Shorter text than the base block's, whose definition and hash stay as they were; a chat that already pinned the Standard Skills block keeps the text it was made with.)
    prompt: 'Five skills for one character (a sixth at Lv 20, a seventh at 40, an eighth at 60): what it does, its stat, what it uses (stamina or mana), a rank (Novice, Adept, Expert, Master) and practice 0 to 100. The narrator names a skill with a learn line and adds practice; 100 practice raises the rank.',
    kinds: Object.fromEntries(Object.entries(skills.kinds).map(([name, kind]) => [name, /^learn-/u.test(name)
        ? { ...kind, when: ['eq', get(`skill${name.slice(6)}`), ''], refusal: 'That slot holds a skill; use a free slot.' } : kind])),
};

// The Skills templates as 2.21 made them (five slots, no `sig`, the earlier text): frozen, derived from today's by taking the later slots and the signature mark out, so
// a Re-read of a join made before the extra slots builds the block that reply made (same fields, same pin) and not today's. Used only with `legacy` (join.js).
const FIVE = [1, 2, 3, 4, 5];
const upTo5 = key => !/^(skill|about|stat|uses|rank|practice)[6-9]$/u.test(key) && key !== SIGNATURE_FIELD;
const frozenSkills = (from, prompt) => ({
    ...from, prompt,
    state: Object.fromEntries(Object.entries(from.state).filter(([key]) => upTo5(key))),
    kinds: Object.fromEntries(Object.entries(from.kinds).filter(([name]) => FIVE.includes(Number(name.slice(name.lastIndexOf('-') + 1))))),
    rules: from.rules.filter(rule => FIVE.includes(Number(rule.id.slice(rule.id.lastIndexOf('-') + 1)))),
});
const standardSkillsV1 = frozenSkills(standardSkills, 'Up to five skills for one character: what it does, its stat, what it uses (stamina or mana), a rank (Novice, Adept, Expert, Master) and practice 0 to 100. The narrator names a skill with a learn line and adds practice; 100 practice raises the rank.');
/** The Skills template as 2.21 had it (a join made before the extra slots, read again). */
export const skillsV1For = () => structuredClone(standardSkillsV1);

const combat = {
    slug: 'combat-rules', name: 'Combat rules', role: 'rules', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: COMBAT_PROMPT,
    state: {},
    kinds: {},
};

// ---- The Standard formula's blocks (stat formula, 1 Nov) ---------------------------------------------------------------------------------
// A bar is a row of blocks. The stored value counts the blocks left (Health 0..8, Stamina 0..7, Mana 0..7; a foe group's Health 0..8); the
// bar's size comes from the stats (blocks.js, formula.js `blocksFor`) and is told in each field's `blocks` mark. There are no `names` on those
// fields: the stage words are spread over the bar's size by the reader (blocks.js). The story still writes a word: each kind's `to` label has the
// six (or five) words and its effect turns the word into blocks for the bar's size (the same rounding as blocks.js `wordToBlocks`).
// Three hidden fields (`health-blocks`, `stamina-blocks`, `mana-blocks`) hold the size each bar had when last settled; a rule per bar compares it
// with the size the stats give now: a bar that grew gains the new blocks FULL (the blocks already there are left as they were), unless the
// character is Down (they stay Down), and a bar that shrank holds at most its new size (a character is never knocked Down by it).
const STANDARD_STAT = STANDARD_NUMBERS.startStat;
const SIZE = {
    health: ['add', 4, ['floorDiv', get('vit'), 5]],
    stamina: ['add', 3, ['floorDiv', get('agi'), 5]],
    mana: ['add', 3, ['floorDiv', get('int'), 5]],
};
const FOE_SIZE = n => ['add', 4, ['floorDiv', get(`level${n}`), 30]];
// Blocks for a stage word, in a bar of `size` blocks: round(word index × size / (words − 1)), half up; the first word is 0 and the last the full bar.
const blocksOf = (word, size, count) => ['floorDiv', ['add', ['mul', word, size], Math.floor((count - 1) / 2)], count - 1];
const stageLabel = words => ({ type: 'int', min: 0, max: words.length - 1, names: names(words) });
const bar = (label, max, blocks, value) => int(label, 0, max, value, { blocks });
const hiddenSize = (label, max, value) => int(label, 0, max, value, { prompt: false, edit: false });
const sizeRule = (id, key, sizeKey, size) => ({ id, when: ['ne', get(sizeKey), size],
    then: [
        // New blocks arrive full: the rise in size is added to what is there, except while Down (0 stays 0).
        { op: 'add', path: [key], value: ['mul', ['min', get(key), 1], ['max', 0, ['sub', size, get(sizeKey)]]], bounds: 'clamp' },
        { op: 'set', path: [sizeKey], value: size },
        // A bar that shrank holds at most its new size (its new size is never below 3, so a character who is up stays up).
        { op: 'set', path: [key], value: ['min', get(key), size] }] });

const standardCharacterV1 = {
    slug: 'character', name: 'Character', role: 'character', schema: 1, stateVersion: 2, scope: 'chat',
    prompt: 'One character: who they are, health, stamina and mana (words, shown as bars), seven stats 1 to 20, points, Level 1 to 99 and XP to 100. The narrator sets health, mana, stamina and XP by words. The story cannot kill them outright: they die only when Down before a reply and still Down at its end. The reader sets stats and points; XP at 100 raises the Level, and every third Level gives a point.',
    show: character.show,
    state: {
        who: text('Name'),
        about: text('Who they are', CREATION.about),
        health: bar('Health', 8, 'health', 5),
        mana: bar('Mana', 7, 'mana', 4),
        stamina: bar('Stamina', 7, 'stamina', 4),
        ...Object.fromEntries(STATS.map(stat => [stat, int(stat.toUpperCase(), 1, STANDARD_NUMBERS.statMax, STANDARD_STAT)])),
        points: int('Points', 0, 60, 0),
        level: int('Level', LEVEL.min, LEVEL.max, 1),
        xp: int('XP', 0, LEVEL.xpMax, 0),
        rise: int('Rise', 0, LEVEL.max, 0, { prompt: false, edit: false }),
        cap: int('Level cap', LEVEL.min, LEVEL.max, LEVEL.max, { prompt: false }),
        down: { type: 'bool', default: false, label: 'Down', prompt: false },
        alive: { type: 'bool', default: true, label: 'Alive' },
        left: { type: 'bool', default: false, label: 'Left' },
        'health-blocks': hiddenSize('Health blocks', 8, 5),
        'stamina-blocks': hiddenSize('Stamina blocks', 7, 4),
        'mana-blocks': hiddenSize('Mana blocks', 7, 4),
    },
    kinds: {
        'set-health': { op: '~', labels: { to: stageLabel(STAGES.health) }, effects: [{ op: 'set', path: ['health'], value: blocksOf(['arg', 'to'], SIZE.health, STAGES.health.length) }] },
        'set-mana': { op: '~', labels: { to: stageLabel(STAGES.mana) }, effects: [{ op: 'set', path: ['mana'], value: blocksOf(['arg', 'to'], SIZE.mana, STAGES.mana.length) }] },
        'set-stamina': { op: '~', labels: { to: stageLabel(STAGES.stamina) }, effects: [{ op: 'set', path: ['stamina'], value: blocksOf(['arg', 'to'], SIZE.stamina, STAGES.stamina.length) }] },
        'add-xp': character.kinds['add-xp'],
        'button-rest': { op: '!', ui: true, title: 'Rest', labels: {}, effects: [{ op: 'set', path: ['stamina'], value: SIZE.stamina }, { op: 'set', path: ['mana'], value: SIZE.mana }] },
    },
    // The bars first (they read the stats as they stand), then the level rise (a point to spend with every third level).
    rules: [sizeRule('health-bar', 'health', 'health-blocks', SIZE.health), sizeRule('stamina-bar', 'stamina', 'stamina-blocks', SIZE.stamina),
        sizeRule('mana-bar', 'mana', 'mana-blocks', SIZE.mana),
        levelUp(), xpCap()],
    replyEnd: character.replyEnd,
    cards: character.cards,
};

/** The Character template as it was before the doubled bars (no `scale` mark: Health 4 + VIT/5, Stamina 3 + AGI/5, Mana 3 + INT/5): a chat's earlier characters, and a companion joining a chat that has only those. */
export const characterV1For = () => structuredClone(standardCharacterV1);
// The template the chooser, the wizard and an import make blocks from: the same Character with the doubled bars (templates-bars.js).
const standardCharacter = withRecovery(scaledCharacter(standardCharacterV1, SIZE));

const standardFoes = {
    slug: 'foes', name: 'Foes', role: 'foes', schema: 1, stateVersion: 2, scope: 'chat',
    prompt: 'Up to four foe groups in the fight, one slot each: name, count (0 = empty slot), its level from 1 to 99 and health (words). The narrator sets a slot when a group arrives, hurts it as the fight goes and clears it when the group is down, gone, fled, captured or yielded.',
    show: { tab: true, card: false, tabName: 'Foes', icon: 'ph-skull' },
    state: Object.fromEntries(SLOTS.flatMap(n => [
        [`foe${n}`, text(`Foe ${n}`)],
        [`count${n}`, int(`Count ${n}`, 0, 99, 0)],
        [`level${n}`, int(`Level ${n}`, 1, 99, 1)],
        [`hurt${n}`, bar(`Health ${n}`, 8, 'foe', 4)],
    ])),
    kinds: Object.fromEntries(SLOTS.flatMap(n => [
        [`set-slot-${n}`, { op: '+', labels: { name: { type: 'text', max: 40 }, count: range(1, 99), level: range(1, 99) },
            when: ['eq', get(`count${n}`), 0], refusal: 'That slot is taken; clear it first.',
            effects: [{ op: 'set', path: [`foe${n}`], value: ['arg', 'name'] }, { op: 'set', path: [`count${n}`], value: ['arg', 'count'] },
                { op: 'set', path: [`level${n}`], value: ['arg', 'level'] }, { op: 'set', path: [`hurt${n}`], value: ['add', 4, ['floorDiv', ['arg', 'level'], 30]] }] }],
        [`hurt-${n}`, { op: '~', labels: { to: stageLabel(STAGES.health) }, when: ['gt', get(`count${n}`), 0], refusal: 'That slot is empty.',
            effects: [{ op: 'set', path: [`hurt${n}`], value: blocksOf(['arg', 'to'], FOE_SIZE(n), STAGES.health.length) }] }],
        [`clear-${n}`, { op: '-', labels: { why: { type: 'enum', values: ['down', 'fled', 'yielded', 'captured', 'gone'] } },
            effects: [{ op: 'set', path: [`count${n}`], value: 0 }, { op: 'set', path: [`foe${n}`], value: '' }, { op: 'set', path: [`hurt${n}`], value: 4 }] }],
    ])),
};

/**
 * The Combat rules text: the base one, a little shorter (the block's prompt holds at most 1200 characters), with the roll types and the
 * blocks in words. No numbers: the roll table, the odds and the foe's numbers are the rules' (Settings → RPG); the narrator follows the told result.
 */
/** The most one Foes group may count: read from the stock Foes definition, so the pre-check never exceeds its own block. */
export const FOE_COUNT_MAX = standardFoes.state.count1.max;

export const COMBAT_PROMPT_STANDARD = [
    '[COMBAT SYSTEM]',
    'No Plot Armor: combat follows physical reality and the lore. Size, skill, numbers, reach, armor, terrain, preparation and Level all matter. Against a stronger foe, {{user}} loses unless a believable edge exists: ambush, terrain, numbers, poison, preparation.',
    'Exchanges: tell a fight exchange by exchange, each with clear cause, cost and consequence, in order. Most fights are short; never skip the moment that decides it.',
    'Weight & Risk: every strike, miss, wound and hesitation carries impact. Injury, fatigue, fear and pain carry into the next exchange and the next scene.',
    'Believable Outcomes: fights end when logic demands it: death, surrender, retreat, capture or collapse. Victory must be earned; survival must be justified.',
    'Rolls: tell the rolled result as given; code moves the bars for hits, heals, skill costs: never set those.',
].join('\n');

const standardCombat = { ...combat, stateVersion: 2, prompt: COMBAT_PROMPT_STANDARD };

/** The Standard formula's four templates, in the chooser's order. Skills are the base block with the learn guard. */
/** The Skills template as the eight-slot release had it (no types): a Re-read of a join made before them, and a block in a chat that has only such blocks. */
export const skillsV2For = () => structuredClone(standardSkills);
// The Skills template new blocks are made from: the eight slots plus three utility ones, a type on every slot (templates-skills.js).
const typedStandardSkills = typedSkills(standardSkills, 'Five combat skills (more with levels) and three utility ones, for the story only. Each has a description, a stat, what it uses, a rank and practice 0 to 100. A learn line names a skill (type combat or utility, combat if left out); 100 practice raises the rank.');
export const STANDARD_TEMPLATES = Object.freeze([
    { name: 'Character', definition: standardCharacter },
    { name: 'Skills', definition: typedStandardSkills },
    { name: 'Foes', definition: standardFoes },
    { name: 'Combat rules', definition: standardCombat },
]);

/**
 * The additive upgrade of a Skills block made before the extra skill slots (five slots, no `sig`): the same definition with the fields, kinds and rules of the slots
 * and the signature mark it lacks added from today's template (Standard's learn guard when the block has it). Nothing is removed, renamed or changed, and the text
 * (`prompt`) stays as it was. → the extended definition, or null when it lacks nothing (or is not a Skills block). Pure.
 */
export function grownSkills(definition) {
    if (definition?.role !== 'skills' || typeof definition.state !== 'object' || typeof definition.kinds !== 'object') return null;
    const base = definition.kinds['learn-1']?.when ? standardSkills : skills;
    const state = { ...definition.state }, kinds = { ...definition.kinds }, rules = [...(definition.rules ?? [])];
    let changed = false;
    for (const [key, schema] of Object.entries(base.state)) if (!Object.hasOwn(state, key)) { state[key] = structuredClone(schema); changed = true; }
    for (const [name, kind] of Object.entries(base.kinds)) if (!Object.hasOwn(kinds, name)) { kinds[name] = structuredClone(kind); changed = true; }
    for (const rule of base.rules) if (!rules.some(other => other.id === rule.id)) { rules.push(structuredClone(rule)); changed = true; }
    return changed ? { ...definition, state, kinds, rules } : null;
}

const skill = (name, stat, about, uses = 'stamina') => ({ name, about, stat, uses });

/**
 * The New character wizard's built-in skill sets (mockup section 4): three skills each, with what the skill does, the stat it
 * rolls with and what it uses. A pack adds more through `content.rpg.skillSets` (same shape, plus its pack id).
 * Ranks are not part of a set: the wizard starts every skill at Novice, one of them at Adept if the reader says so.
 */
export const SKILL_SETS = Object.freeze([
    { id: 'guild-fighter', name: 'Guild fighter', about: 'Drill-yard basics: a blade, the breathing drill that keeps you standing, a shield.', skills: [
        skill('Short blade', 'agi', 'Quick cuts and guards with a long knife or short sword.'),
        skill('Iron Breath', 'vit', 'The drill-yard breathing that keeps you on your feet when you are spent.'),
        skill('Shield work', 'str', 'Holding a line behind a shield: blocking, bracing and shoving back.')] },
    { id: 'river-scout', name: 'River scout', about: 'At home on barges and banks: ropes, cold water, reading tracks in mud.', skills: [
        skill('Rope work', 'dex', 'Knots, climbing, hauling, and throwing a line true.'),
        skill('Swimming', 'vit', 'Cold water, currents, and getting a crewmate out alive.'),
        skill('Tracking', 'int', 'Reading prints, broken reeds and old fires to know who passed and when.')] },
    { id: 'hedge-mage', name: 'Hedge mage', about: 'Self-taught small magic: a spark, a ward, and what the old books say.', skills: [
        skill('Spark', 'int', 'A small bright burst of magic that startles, lights and singes.', 'mana'),
        skill('Ward', 'int', 'A shimmer of force that turns a blow aside for a moment.', 'mana'),
        skill('Lore', 'int', 'What the old books say about creatures, places and odd magic.')] },
    { id: 'field-medic', name: 'Field medic', about: 'Keeps the party alive: bandages, herbs, a steady voice.', skills: [
        skill('Mending', 'dex', 'Bandaging, splinting and stitching a wound fast and clean.'),
        skill('Herbs', 'int', 'Knowing which plants heal, which poison and where they grow.'),
        skill('Calm', 'cha', 'A steady voice that settles the frightened and the hurt.')] },
    { id: 'silver-tongue', name: 'Silver tongue', about: 'Talks the party in and out of things, and pays less for it.', skills: [
        skill('Persuade', 'cha', 'Winning someone round with a good argument and a warm manner.'),
        skill('Read people', 'int', 'Spotting a lie, a worry or a hidden rank from small signs.'),
        skill('Haggle', 'cha', 'Bargaining a price down, or a favour up.')] },
]);

/** The Standard templates with the Skills block as the eight-slot release had it (no types): what a chat made before the types still holds; the tests of such chats read it. */
export const STANDARD_TEMPLATES_EIGHT = Object.freeze(STANDARD_TEMPLATES.map(entry => (entry.name === 'Skills' ? { name: entry.name, definition: skillsV2For() } : entry)));
