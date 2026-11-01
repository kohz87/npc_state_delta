// The RPG block templates (Character, Skills, Foes, Combat rules): data-module definitions that the block
// chooser offers while the RPG feature is on (Settings → Blocks → From a template). Each carries a `role`
// (see ROLES in index.js) and keeps the field keys the RPG reads. Stage fields are indexes (0 = empty) with
// `names` from STAGES; Soul Class and ranks are numbers with names. The block engine adds three things these
// use: `names` and `prompt: false` on fields, and the `replyEnd` and `cards` lists. The Skills block's rank and practice
// are `edit: false` (they only move through play); SKILL_SETS are the New character wizard's built-in skill sets.
import { CREATION, STATS, STAGES, USES } from './names.js';
import { STANDARD_NUMBERS } from './formula.js';

const names = (words, first = 0) => Object.fromEntries(words.map((word, index) => [String(index + first), word]));
const HEALTH = names(STAGES.health);
const MANA = names(STAGES.mana);
const STAMINA = names(STAGES.stamina);
const SOUL = names(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'], 1);
const RANK = names(['Novice', 'Adept', 'Expert', 'Master']);
const SKILLS = [1, 2, 3, 4, 5];
const SLOTS = [1, 2, 3, 4];

const text = (label, max = CREATION.skillName) => ({ type: 'text', max, default: '', label });
const int = (label, min, max, value, extra = {}) => ({ type: 'int', min, max, default: value, label, ...extra });
const range = (min, max) => ({ type: 'int', min, max });
const get = field => ['get', [field]];

export const COMBAT_PROMPT = [
    '[COMBAT SYSTEM]',
    'No Plot Armor: combat follows physical reality and the lore. Size, skill, numbers, reach, armor, terrain, preparation and Soul Class all matter. Against a stronger foe, {{user}} loses unless a believable edge exists: ambush, terrain, numbers, poison, preparation.',
    'Exchanges: a fight is told exchange by exchange, each with clear cause, cost and consequence, in the order things happen. Most fights are short; one exchange may be the whole fight. Never skip the moment that decides it.',
    'Weight & Risk: every strike, miss, wound and hesitation carries impact. Injury, fatigue, fear and pain carry into the next exchange and the next scene.',
    'Believable Outcomes: fights end when logic demands it: death, surrender, retreat, capture or collapse. NPCs take those exits when the fight turns against them. Victory must be earned; survival must be justified.',
    'XP guide: a small fight 5 to 15, a hard fight 20 to 40, a boss 50 or more. Practice a skill 5 to 20 for each use.',
].join('\n');

const character = {
    slug: 'character', name: 'Character', role: 'character', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: 'One character: who they are, health, mana and stamina (words, shown as bars), seven stats from 1 to 20, unspent points, Soul Class I to IX and XP to 100. The narrator sets health, mana, stamina and XP; the story cannot kill a character outright: they die only when they were already Down before a reply and are still Down at its end. The reader sets stats and points. XP at 100 raises the Soul Class by one, up to IX, and gives 3 points to spend on stats.',
    show: { tab: true, card: false, tabName: 'Character', icon: 'ph-user' },
    state: {
        who: text('Name'),
        about: text('Who they are', CREATION.about),
        health: int('Health', 0, 5, 5, { names: HEALTH }),
        mana: int('Mana', 0, 4, 4, { names: MANA }),
        stamina: int('Stamina', 0, 4, 4, { names: STAMINA }),
        ...Object.fromEntries(STATS.map(stat => [stat, int(stat.toUpperCase(), 1, 20, 10)])),
        points: int('Points', 0, 60, 0),
        soul: int('Soul Class', 1, 9, 1, { names: SOUL }),
        xp: int('XP', 0, 100, 0),
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
    rules: [{ id: 'class-up', when: ['and', ['ge', get('xp'), 100], ['lt', get('soul'), 9]],
        then: [{ op: 'add', path: ['soul'], value: 1, bounds: 'clamp' }, { op: 'set', path: ['xp'], value: 0 }, { op: 'add', path: ['points'], value: 3, bounds: 'clamp' }] }],
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
    prompt: 'Up to five skills for one character. Each has a description, the stat it rolls with, what it uses (stamina or mana), a rank (Novice, Adept, Expert, Master) and practice from 0 to 100. The narrator names a skill with a learn line (name, what it does, stat, uses) and adds practice. At 100 practice the rank rises by one and practice starts again at 0; a Master stays at 100.',
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

const foes = {
    slug: 'foes', name: 'Foes', role: 'foes', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: 'Up to four foe groups in the current fight. A group is one slot: its name, how many it has (count 0 means the slot is empty), its Soul Class from I to IX and its health. The narrator sets a slot when a group arrives, hurts it as the fight goes and clears it when the group is down, gone, fled, captured or has yielded.',
    show: { tab: true, card: false, tabName: 'Foes', icon: 'ph-skull' },
    state: Object.fromEntries(SLOTS.flatMap(n => [
        [`foe${n}`, text(`Foe ${n}`)],
        [`count${n}`, int(`Count ${n}`, 0, 99, 0)],
        [`class${n}`, int(`Class ${n}`, 1, 9, 1, { names: SOUL })],
        [`hurt${n}`, int(`Health ${n}`, 0, 5, 5, { names: HEALTH })],
    ])),
    kinds: Object.fromEntries(SLOTS.flatMap(n => [
        [`set-slot-${n}`, { op: '+', labels: { name: { type: 'text', max: 40 }, count: range(1, 99), class: range(1, 9) },
            when: ['eq', get(`count${n}`), 0], refusal: 'That slot is taken; clear it first.',
            effects: [{ op: 'set', path: [`foe${n}`], value: ['arg', 'name'] }, { op: 'set', path: [`count${n}`], value: ['arg', 'count'] },
                { op: 'set', path: [`class${n}`], value: ['arg', 'class'] }, { op: 'set', path: [`hurt${n}`], value: 5 }] }],
        [`hurt-${n}`, { op: '~', labels: { to: range(0, 5) }, when: ['gt', get(`count${n}`), 0], refusal: 'That slot is empty.',
            effects: [{ op: 'set', path: [`hurt${n}`], value: ['arg', 'to'] }] }],
        [`clear-${n}`, { op: '-', labels: { why: { type: 'enum', values: ['down', 'fled', 'yielded', 'captured', 'gone'] } },
            effects: [{ op: 'set', path: [`count${n}`], value: 0 }, { op: 'set', path: [`foe${n}`], value: '' }, { op: 'set', path: [`hurt${n}`], value: 5 }] }],
    ])),
};

const combat = {
    slug: 'combat-rules', name: 'Combat rules', role: 'rules', schema: 1, stateVersion: 1, scope: 'chat',
    prompt: COMBAT_PROMPT,
    state: {},
    kinds: {},
};

/** Classic's four templates (the formula as it was). Their definitions, and so their hashes, never change: see STANDARD_TEMPLATES for the Standard formula's. */
export const LEAN_RPG_TEMPLATES = Object.freeze([
    { name: 'Character', definition: character },
    { name: 'Skills', definition: skills },
    { name: 'Foes', definition: foes },
    { name: 'Combat rules', definition: combat },
]);

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
const FOE_SIZE = n => ['add', 4, ['floorDiv', get(`class${n}`), 3]];
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

const standardCharacter = {
    slug: 'character', name: 'Character', role: 'character', schema: 1, stateVersion: 2, scope: 'chat',
    prompt: 'One character: who they are, health, stamina and mana (words, shown as bars of blocks that grow with VIT, AGI and INT), seven stats from 1 to 20, unspent points, Soul Class I to IX and XP to 100. The narrator sets health, mana, stamina and XP by words; the story cannot kill a character outright: they die only when they were already Down before a reply and are still Down at its end. The reader sets stats and points. XP at 100 raises the Soul Class by one, up to IX, and gives 4 points to spend on stats.',
    show: character.show,
    state: {
        who: text('Name'),
        about: text('Who they are', CREATION.about),
        health: bar('Health', 8, 'health', 5),
        mana: bar('Mana', 7, 'mana', 4),
        stamina: bar('Stamina', 7, 'stamina', 4),
        ...Object.fromEntries(STATS.map(stat => [stat, int(stat.toUpperCase(), 1, STANDARD_NUMBERS.statMax, STANDARD_STAT)])),
        points: int('Points', 0, 60, 0),
        soul: int('Soul Class', 1, 9, 1, { names: SOUL }),
        xp: int('XP', 0, 100, 0),
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
    // The bars first (they read the stats as they stand), then the class rise (4 points to spend with each).
    rules: [sizeRule('health-bar', 'health', 'health-blocks', SIZE.health), sizeRule('stamina-bar', 'stamina', 'stamina-blocks', SIZE.stamina),
        sizeRule('mana-bar', 'mana', 'mana-blocks', SIZE.mana),
        { id: 'class-up', when: ['and', ['ge', get('xp'), 100], ['lt', get('soul'), 9]],
            then: [{ op: 'add', path: ['soul'], value: 1, bounds: 'clamp' }, { op: 'set', path: ['xp'], value: 0 },
                { op: 'add', path: ['points'], value: STANDARD_NUMBERS.pointsPerSoul, bounds: 'clamp' }] }],
    replyEnd: character.replyEnd,
    cards: character.cards,
};

const standardFoes = {
    slug: 'foes', name: 'Foes', role: 'foes', schema: 1, stateVersion: 2, scope: 'chat',
    prompt: 'Up to four foe groups in the current fight. A group is one slot: its name, how many it has (count 0 means the slot is empty), its Soul Class from I to IX and its health (words: a group of a higher class has more blocks of health). The narrator sets a slot when a group arrives, hurts it as the fight goes and clears it when the group is down, gone, fled, captured or has yielded.',
    show: foes.show,
    state: Object.fromEntries(SLOTS.flatMap(n => [
        [`foe${n}`, text(`Foe ${n}`)],
        [`count${n}`, int(`Count ${n}`, 0, 99, 0)],
        [`class${n}`, int(`Class ${n}`, 1, 9, 1, { names: SOUL })],
        [`hurt${n}`, bar(`Health ${n}`, 8, 'foe', 4)],
    ])),
    kinds: Object.fromEntries(SLOTS.flatMap(n => [
        [`set-slot-${n}`, { op: '+', labels: { name: { type: 'text', max: 40 }, count: range(1, 99), class: range(1, 9) },
            when: ['eq', get(`count${n}`), 0], refusal: 'That slot is taken; clear it first.',
            effects: [{ op: 'set', path: [`foe${n}`], value: ['arg', 'name'] }, { op: 'set', path: [`count${n}`], value: ['arg', 'count'] },
                { op: 'set', path: [`class${n}`], value: ['arg', 'class'] }, { op: 'set', path: [`hurt${n}`], value: ['add', 4, ['floorDiv', ['arg', 'class'], 3]] }] }],
        [`hurt-${n}`, { op: '~', labels: { to: stageLabel(STAGES.health) }, when: ['gt', get(`count${n}`), 0], refusal: 'That slot is empty.',
            effects: [{ op: 'set', path: [`hurt${n}`], value: blocksOf(['arg', 'to'], FOE_SIZE(n), STAGES.health.length) }] }],
        [`clear-${n}`, { op: '-', labels: { why: { type: 'enum', values: ['down', 'fled', 'yielded', 'captured', 'gone'] } },
            effects: [{ op: 'set', path: [`count${n}`], value: 0 }, { op: 'set', path: [`foe${n}`], value: '' }, { op: 'set', path: [`hurt${n}`], value: 4 }] }],
    ])),
};

/**
 * Standard's Combat rules text: Classic's, a little shorter (the block's prompt holds at most 1200 characters), with the roll types and the
 * blocks in words. No numbers: the roll table, the odds and the foe's numbers are the rules' (Settings → RPG); the narrator follows the told result.
 */
export const COMBAT_PROMPT_STANDARD = [
    '[COMBAT SYSTEM]',
    'No Plot Armor: combat follows physical reality and the lore. Size, skill, numbers, reach, armor, terrain, preparation and Soul Class all matter. Against a stronger foe, {{user}} loses unless a believable edge exists: ambush, terrain, numbers, poison, preparation.',
    'Exchanges: a fight is told exchange by exchange, each with clear cause, cost and consequence, in the order things happen. Most fights are short; never skip the moment that decides it.',
    'Weight & Risk: every strike, miss, wound and hesitation carries impact. Injury, fatigue, fear and pain carry into the next exchange and the next scene.',
    'Believable Outcomes: fights end when logic demands it: death, surrender, retreat, capture or collapse. Victory must be earned; survival must be justified.',
    'Rolls: attacks, spells, defence, talk and checks each pair a main stat with half of a second one. Health, stamina and mana are rows of blocks: a hit takes one, a Decisive hit two, and a foe of a higher Soul Class has more. Tell the rolled result; code moves the bars for hits, heals, skill costs: never set those.',
    'XP guide: a small fight 5 to 15, a hard fight 20 to 40, a boss 50 or more. Practice a skill 5 to 20 for each use.',
].join('\n');

const standardCombat = { ...combat, stateVersion: 2, prompt: COMBAT_PROMPT_STANDARD };

/** The Standard formula's four templates, in the chooser's order. Skills are the same block as Classic's. */
export const STANDARD_TEMPLATES = Object.freeze([
    { name: 'Character', definition: standardCharacter },
    { name: 'Skills', definition: skills },
    { name: 'Foes', definition: standardFoes },
    { name: 'Combat rules', definition: standardCombat },
]);

/** The templates a chat's formula makes blocks from: 'classic' the originals, anything else Standard's. */
export const templatesFor = formula => (formula === 'classic' ? LEAN_RPG_TEMPLATES : STANDARD_TEMPLATES);

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
