// What the New character wizard works out, without a DOM: the draft's shape, the stat budget, the skill rules (up to five, at most
// one starting at Adept), the skill sets on offer (built in and from packs), the problems that stop Create, and the two block
// definitions Create makes. The draft lives in the dialog (`api.draft`), so this reads it as plain data and never trusts it:
// `readDraft` clamps whatever it finds. Field names are the ones the Character and Skills templates use (templates.js).
//
//   draft = { name, kind: 'you' | 'companion', about, stats: { str…cha }, skills: [{ name, about, stat, uses, start: 0 | 1, rank? }], set, soul?, from? }
//   `creation` (Standard only): { start, budget, min, max, statMax, standard: true }, the numbers creation runs on (stats start at `start`, `budget`
//   points to spend, a stat from `min` to `max`); a draft without it runs on the Standard preset's numbers.
//   (start is the rank a skill begins at: 0 Novice, 1 Adept; `set` is the id of the skill set last put in, '' for none; `soul` is the
//   level (the starting level of a new character, a companion who joins or an imported one, 2 to 99; left out it is 1). `from` and a skill's
//   `rank` are there only after an import (a saved character file, ../charfile.js): `from` = { stats, points } is what the file had, which
//   the stats are spent from, and `rank` (0 to 3) is the rank the file gave a skill, which is not typed and not counted as the Adept one.)

import { DM_LIMITS } from '../../data-modules/schema.js';
import { activeDefinition } from '../../data-modules/adapters.js';
import { uniqueBlockSlug } from '../../data-modules/block-builder.js';
import { fold } from '../read.js';
import { LEVEL, CREATION, RANK_NAMES, STATS, USES } from '../names.js';
import { SKILL_FIELDS_MAX, SKILL_SLOTS_MAX, UTILITY_SLOTS, skillSlots } from '../../skill-slots.js';
import { STANDARD_FORMULA, isStandard } from '../rules.js';
import { classOfLevel, levelOfClass } from '../formula.js';
import { SKILL_SETS, STANDARD_TEMPLATES, characterV1For, skillsV1For, skillsV2For } from '../templates.js';
import { barFields } from '../blocks.js';
import { soulReading } from '../soul.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { FILE_LIMITS } from '../charfile.js';

const W = RPG_STRINGS.wizard;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value, max) => [...(typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')].slice(0, max).join('');
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export const WIZARD_STEPS = Object.freeze(['who', 'stats', 'skills', 'review']);
export const KINDS = Object.freeze(['you', 'companion']);
/** The ranks a skill may start at: Novice, and Adept for at most one skill. */
export const START_RANKS = Object.freeze([0, 1]);

/**
 * The numbers creation runs on under `rules`: `{ ...CREATION, start, budget, min, max, statMax, perSoul, standard: true }` from the rules' startStat,
 * createPoints, createMin, createMax, statMax and pointsPerSoul (the Standard preset's when `rules` are not Standard).
 */
export function creationOf(rules) {
    if (!isStandard(rules)) rules = STANDARD_FORMULA;
    return { ...CREATION, start: rules.startStat, budget: rules.createPoints, min: rules.createMin, max: rules.createMax, statMax: rules.statMax, perSoul: rules.pointsPerSoul, standard: true };
}

/** The numbers a draft runs on: its own `creation`, else the Standard preset's. */
export const draftCreation = draft => (draft?.creation?.standard === true ? draft.creation : creationOf(STANDARD_FORMULA));

// A draft's `creation` as the dialog may hand it back: whole numbers in range, else dropped (the draft then runs on the Standard preset's).
function readCreation(raw) {
    if (!isRecord(raw) || raw.standard !== true) return null;
    const whole = (value, low, high) => (Number.isSafeInteger(value) && value >= low && value <= high ? value : null);
    const start = whole(raw.start, 1, 10), budget = whole(raw.budget, 0, 400), min = whole(raw.min, 1, 10), max = whole(raw.max, 3, 20), statMax = whole(raw.statMax, 10, 20), perSoul = whole(raw.perSoul, 0, 10);
    if ([start, budget, min, max, statMax, perSoul].includes(null) || !(min <= start && start <= max && max <= statMax)) return null;
    return { ...CREATION, start, budget, min, max, statMax, perSoul, standard: true };
}

/** The level a draft starts at (a new character 1; a companion who joins or an imported one, the level their class or file stands for). */
export const draftLevel = draft => (Number.isSafeInteger(draft?.level) && draft.level > 1 ? clamp(draft.level, 1, LEVEL.max)
    : Number.isSafeInteger(draft?.soul) && draft.soul >= 1 ? clamp(levelOfClass(clamp(draft.soul, 1, 9)), 1, LEVEL.max) : 1);
/**
 * How many skills a draft may hold: 5, and one more at Lv 20, 40 and 60 for a draft that starts that high (names.js skillSlots). Creation still starts at 5.
 * Skills already ranked (a character file's, however many it holds after a level drop) and signature skills (a pack's cast member brought them) are kept
 * whatever the level says: the slots they fill are not taken away, there are just no new ones.
 */
export const draftSlots = draft => combatSlots(draft) + UTILITY_SLOTS;
/** The combat slots a draft may fill (the level's; kept skills never lose theirs) and the utility ones it has (three, whatever the level). */
export const combatSlots = draft => Math.max(skillSlots(draftLevel(draft)), keptSkills(draft?.skills, draft?.from));
export const utilityCount = (draft, except = -1) => (draft?.skills ?? []).filter((skill, at) => skill.type === 'utility' && at !== except).length;
const keptSkills = (skills, from) => Math.min(SKILL_SLOTS_MAX, (Array.isArray(skills) ? skills : []).filter(entry => isRecord(entry) && ((entry.sig === true && entry.type !== 'utility') || (from && entry.type !== 'utility' && Number.isSafeInteger(entry.rank)))).length);

const blankSkill = type => ({ name: '', about: '', stat: STATS[0], uses: USES[0], start: 0, ...(type === 'utility' ? { type } : {}) });

/** The draft a wizard opens with: the persona's name and You, every stat at its start. When the story already has a You it starts as a companion with no name (the persona's is taken). */
export function newDraft({ persona = '', hasYou = false, rules = null } = {}) {
    const creation = creationOf(rules);
    return { name: hasYou ? '' : oneLine(persona, CREATION.name), kind: hasYou ? 'companion' : 'you', about: '', stats: startStats(creation ? { creation } : null), skills: [], set: '', ...(creation ? { creation } : {}) };
}

/** What an import brought: the file's stats and unspent points, or null (anything else is not an import). */
function readFrom(raw) {
    if (!isRecord(raw) || !isRecord(raw.stats) || !Number.isSafeInteger(raw.points)) return null;
    const stats = {};
    for (const stat of STATS) {
        if (!Number.isSafeInteger(raw.stats[stat])) return null;
        stats[stat] = clamp(raw.stats[stat], ...FILE_LIMITS.stat);
    }
    return { stats, points: clamp(raw.points, 0, FILE_LIMITS.points) };
}

/** How low and how high a stat may be set: 8 to 15 (Standard: 3 to 10), and never off the value an imported character came with. */
export function statBounds(draft, stat) {
    const base = draft?.from?.stats?.[stat], creation = draftCreation(draft);
    return Number.isSafeInteger(base) ? [Math.min(creation.min, base), Math.max(creation.max, base)] : [creation.min, creation.max];
}

/** A draft as the dialog holds it, made whole: every field in range, at most one Adept, at most five skills. */
export function readDraft(raw) {
    const given = isRecord(raw) ? raw : {};
    const from = readFrom(given.from);
    const creation = readCreation(given.creation);
    const stats = Object.fromEntries(STATS.map(stat => {
        const value = Number.isSafeInteger(given.stats?.[stat]) ? given.stats[stat] : (from?.stats[stat] ?? draftCreation({ creation }).start);
        return [stat, clamp(value, ...statBounds({ from, creation }, stat))];
    }));
    // (`level` is the starting level; a draft from a companion's `+ party` line or an older file says `soul`, the class, which stands for the level 10n - 5.)
    const startLevel = Number.isSafeInteger(given.level) && given.level > 1 ? clamp(given.level, 1, LEVEL.max) : Number.isSafeInteger(given.soul) && given.soul >= 1 ? clamp(levelOfClass(clamp(given.soul, 1, 9)), 1, LEVEL.max) : 1;
    let adept = 0;
    // (a signature skill, which a pack's cast member brought, and the skills of a file are kept whatever the level says: draftSlots)
    const wanted = Array.isArray(given.skills) ? given.skills : [];
    const room = Math.max(skillSlots(startLevel), keptSkills(wanted, from));
    let utility = 0, combat = 0;
    const skills = wanted.filter(entry => {
        const isUtility = isRecord(entry) && entry.type === 'utility';
        return isUtility ? ++utility <= UTILITY_SLOTS : ++combat <= room;
    }).map(entry => {
        const skill = isRecord(entry) ? entry : {};
        // A rank the file gave: kept as it is, and it is not the one Adept a new skill may start at.
        const ranked = (from || skill.sig === true) && Number.isSafeInteger(skill.rank);
        const wantsAdept = !ranked && skill.start === 1 && adept < CREATION.adept;
        if (wantsAdept) adept += 1;
        return {
            name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
            // An imported skill may have no stat (''): the reader picks one, and Create waits for it.
            stat: STATS.includes(skill.stat) ? skill.stat : (ranked ? '' : STATS[0]), uses: USES.includes(skill.uses) ? skill.uses : USES[0], start: wantsAdept ? 1 : 0,
            ...(ranked ? { rank: clamp(skill.rank, 0, FILE_LIMITS.rank) } : {}), ...(skill.sig === true ? { sig: true } : {}),
            // (a utility skill is for the story only: three of them, a signature one too; a fourth is left out, as a ninth combat skill is)
            ...(skill.type === 'utility' ? { type: 'utility' } : {}),
        };
    });
    return { name: oneLine(given.name, CREATION.name), kind: given.kind === 'companion' ? 'companion' : 'you',
        about: oneLine(given.about, CREATION.about), stats, skills, set: typeof given.set === 'string' ? given.set : '',
        ...(startLevel > 1 ? { level: startLevel } : {}), ...(from ? { from } : {}), ...(creation ? { creation } : {}) };
}

/** Points left: the budget (an imported character's own points) minus what the stats cost (a stat above where it starts costs a point a step; below it gives one back). */
export const pointsLeft = draft => (draft.from ? draft.from.points : draftCreation(draft).budget)
    - STATS.reduce((sum, stat) => sum + draft.stats[stat] - (draft.from ? draft.from.stats[stat] : draftCreation(draft).start), 0);

/** The stats every Reset goes back to: the file's after an import, else all at the start. */
export const startStats = draft => Object.fromEntries(STATS.map(stat => [stat, draft?.from ? draft.from.stats[stat] : draftCreation(draft).start]));

/** "STR 14 · VIT 12 · …" for the summary row. */
export const statsLine = draft => STATS.map(stat => `${stat.toUpperCase()} ${draft.stats[stat]}`).join(' · ');

/** How many skills start at Adept. */
export const adeptCount = draft => draft.skills.filter(skill => skill.start === 1).length;

/** Whether the skill at `index` may offer Adept: only when it is the Adept one, or nobody is yet. */
export const mayStartAdept = (draft, index) => draft.skills[index]?.start === 1 || adeptCount(draft) < CREATION.adept;

/** A skill set put into the draft: its skills (up to the draft's slots), every one at Novice. */
export function withSet(draft, set) {
    // (signature skills stay in front; the set fills the slots after them)
    const signed = draft.skills.filter(skill => skill.sig === true);
    const skills = (set?.skills ?? []).slice(0, Math.max(0, combatSlots(draft) - signed.filter(skill => skill.type !== 'utility').length)).map(skill => ({
        name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
        stat: STATS.includes(skill.stat) ? skill.stat : STATS[0], uses: USES.includes(skill.uses) ? skill.uses : USES[0], start: 0,
    }));
    return { ...draft, skills: [...signed, ...draft.skills.filter(skill => skill.type === 'utility' && skill.sig !== true && skill.name), ...skills], set: String(set?.id ?? '') };
}

/** A new blank skill added to the draft, when there is room. */
export const withSkill = draft => (draft.skills.length >= draftSlots(draft) ? draft
    : { ...draft, skills: [...draft.skills, blankSkill(draft.skills.length - utilityCount(draft) >= combatSlots(draft) ? 'utility' : 'combat')] });

/**
 * One skill changed (`patch`: any of name, about, stat, uses, start); a second Adept is refused. A signature skill (a pack's cast member brought it) takes the
 * pencil's changes only, its name and what it does; its stat, resource and rank stay as the pack wrote them.
 */
export function withSkillPatch(draft, index, patch) {
    if (!draft.skills[index]) return draft;
    const only = draft.skills[index].sig === true ? { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.about !== undefined ? { about: patch.about } : {}) } : patch;
    const next = { ...draft.skills[index], ...only };
    // (`type`: combat or utility; a pool that is full refuses it)
    if (patch.type !== undefined && draft.skills[index].sig !== true) {
        const { type: _type, ...rest } = next, others = utilityCount(draft, index);
        const fits = patch.type === 'utility' ? others < UTILITY_SLOTS : draft.skills.length - others - 1 < combatSlots(draft);
        if (!fits) return draft;
        return { ...draft, skills: draft.skills.map((skill, at) => (at === index ? { ...rest, ...(patch.type === 'utility' ? { type: 'utility' } : {}) } : skill)) };
    }
    if (next.start === 1 && !mayStartAdept(draft, index)) next.start = 0;
    return { ...draft, skills: draft.skills.map((skill, at) => (at === index ? next : skill)) };
}

/** The skill at `index` taken out (a signature skill stays). */
export const withoutSkill = (draft, index) => ({ ...draft, skills: draft.skills.filter((skill, at) => at !== index || skill.sig === true) });

/**
 * A saved character put into the draft (a good file, ../charfile.js parseCharacterFile): its stats, unspent points (the pool the stats are spent
 * from), Soul Class and skills with their ranks. The name, You or a companion, who they are and the skill set choice are left alone (a set is
 * cleared: the skills now come from the file). → { draft, before }, `before` being what `withoutImport` puts back.
 */
export function withImport(draft, file) {
    const before = structuredClone({ stats: draft.stats, skills: draft.skills, set: draft.set, ...(draft.level > 1 ? { level: draft.level } : {}), ...(draft.from ? { from: draft.from } : {}) });
    const { level: _level, from: _from, ...rest } = draft;
    const next = {
        ...rest, stats: { ...file.stats }, set: '', from: { stats: { ...file.stats }, points: file.points },
        // (every skill the file holds is kept, whatever the file's level says: a level drop never takes a skill away; a signature skill already in the draft stays in front)
        skills: [...draft.skills.filter(skill => skill.sig === true), ...file.skills.filter(skill => !draft.skills.some(other => other.sig === true && fold(other.name) === fold(skill.name)))]
            .slice(0, SKILL_FIELDS_MAX).map(skill => (skill.sig === true ? skill : { name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout), stat: skill.stat ?? '', uses: skill.uses, start: 0, rank: skill.rank, ...(skill.type === 'utility' ? { type: 'utility' } : {}) })),
        ...(file.level > 1 ? { level: file.level } : {}),
    };
    return { draft: next, before };
}

/** The draft as it was before `withImport` (`before` is what that handed back): the stats, skills, Soul Class and skill set; nothing typed since is touched. */
export function withoutImport(draft, before) {
    const { level: _level, from: _from, ...rest } = draft;
    const back = structuredClone(before ?? {});
    return { ...rest, stats: back.stats ?? startStats(null), skills: back.skills ?? [], set: back.set ?? '', ...(back.level > 1 ? { level: back.level } : {}), ...(back.from ? { from: back.from } : {}) };
}

/**
 * The skill sets on offer: the built-in ones, then each pack's (`packSets` = the `packs.content` records of kind rpg, each with
 * its pack id; `packNames` maps a pack id to its name). → [{ id, name, about, skills, source: 'Built in' | 'From the X pack', builtIn }]
 */
export function skillSetsOf({ packSets = [], packNames = {} } = {}) {
    const built = SKILL_SETS.map(set => ({ ...set, builtIn: true, source: W.builtIn }));
    const fromPacks = (Array.isArray(packSets) ? packSets : []).filter(set => isRecord(set) && Array.isArray(set.skills) && typeof set.name === 'string')
        .map(set => ({ id: String(set.id ?? `${set.pack}/${set.slug}`), name: set.name, about: typeof set.about === 'string' ? set.about : '', skills: set.skills, builtIn: false,
            source: fill(W.fromPack, { pack: packNames[set.pack] || set.pack || '' }) }));
    return [...built, ...fromPacks];
}

/** "Short blade (AGI) · Iron Breath (VIT) · Spark (INT, mana)" for a set's card. */
export const setLine = set => set.skills.map(skill => `${skill.name} (${skill.stat.toUpperCase()}${skill.uses === 'mana' ? ', mana' : ''})`).join(' · ');

/** The block actions Create may need on one reply: the Character's define, the Skills' define, and taking the Character back if the second fails. */
export const CREATE_ACTIONS = 3;

/** How many block actions the reply keeps for (`key` is the head reply's, `${sid}/${swipeKey}`); all of them when the key is not known. */
export function actionsFree(state, key) {
    const used = key ? state?.domains?.dataModules?.perReply?.[key]?.roots : 0;
    return DM_LIMITS.replyRoots - (Number.isSafeInteger(used) ? used : 0);
}

/** What Create is held up by, as plain sentences ([] when it may go). `world`: { persona, names (the characters' names now), room (whether two more blocks fit), hasYou, free (block actions the reply has left) }. */
export function problemsOf(draft, { persona = '', names = [], room = true, hasYou = false, free = DM_LIMITS.replyRoots } = {}) {
    const out = [];
    const name = draft.name;
    if (!name) out.push(W.needName);
    else if (names.some(other => fold(other) === fold(name))) out.push(fill(W.nameTaken, { name }));
    const mine = persona && name && fold(name) === fold(persona);
    if (name && persona) {
        if (draft.kind === 'you' && !mine) out.push(fill(W.youName, { persona }));
        if (draft.kind === 'companion' && mine) out.push(fill(W.companionName, { persona }));
    }
    if (draft.kind === 'you' && hasYou) out.push(W.youTaken);
    const seen = new Set();
    for (const skill of draft.skills) {
        if (!skill.name) { out.push(W.needSkillName); continue; }
        if (seen.has(fold(skill.name))) out.push(fill(W.sameSkill, { name: skill.name }));
        seen.add(fold(skill.name));
        if (!skill.about) out.push(fill(W.needAbout, { name: skill.name }));
        if (!skill.stat) out.push(fill(W.needStat, { name: skill.name }));
    }
    if (!room) out.push(fill(W.noRoom, { max: DM_LIMITS.definitions }));
    else if (free < CREATE_ACTIONS) out.push(fill(W.noActions, { used: DM_LIMITS.replyRoots - free, max: DM_LIMITS.replyRoots, need: CREATE_ACTIONS }));
    return [...new Set(out)];
}

// How many blocks the story has: its own (chat) blocks, which the story limit counts, and every active block, which the pin limit counts.
function blockCounts(state) {
    const domain = state?.domains?.dataModules;
    const active = isRecord(domain?.active) ? Object.values(domain.active) : [];
    return { own: active.filter(entry => domain.pins?.[entry.hash]?.packId === 'chat').length, all: active.length };
}

/** Whether two more blocks fit in the story (the chat holds at most `DM_LIMITS.definitions` of its own blocks). */
export function hasRoom(state) {
    const { own, all } = blockCounts(state);
    return own + 2 <= DM_LIMITS.definitions && all + 2 <= DM_LIMITS.pins;
}

/** The chat blocks the RPG's fights need besides the characters, in the order Create adds them. */
export const RPG_EXTRAS = Object.freeze(['rules', 'foes']);

/** Which of the Combat rules (role rules) and Foes (role foes) blocks the story does not have yet, in `RPG_EXTRAS` order. `roleOf(definition)` is what a block is read as. */
export function missingBlocks(state, { roleOf = definition => definition?.role } = {}) {
    const domain = state?.domains?.dataModules;
    const roles = new Set(Object.keys(isRecord(domain?.active) ? domain.active : {}).map(id => {
        const definition = activeDefinition(state, id);
        return definition ? roleOf(definition) : null;
    }));
    return RPG_EXTRAS.filter(role => !roles.has(role));
}

/**
 * Which missing blocks fit beside the two a character is made of: `{ add: [roles that fit], skipped: [{ role, why: 'room' | 'actions' }] }`.
 * They go in the order of `RPG_EXTRAS`, so when only one fits it is the Combat rules. `free` is the block actions the reply has left; the
 * character and its skills take two of them.
 */
export function extrasPlan(state, { roleOf, free = Infinity } = {}) {
    const { own, all } = blockCounts(state);
    const space = Math.min(DM_LIMITS.definitions - own, DM_LIMITS.pins - all) - 2;
    const actions = free - 2;
    const add = [], skipped = [];
    for (const role of missingBlocks(state, { roleOf })) {
        if (add.length < space && add.length < actions) add.push(role);
        else skipped.push({ role, why: add.length >= space ? 'room' : 'actions' });
    }
    return { add, skipped };
}

// (Blocks are made from the Standard templates: templates.js STANDARD_TEMPLATES.)
const template = role => structuredClone(STANDARD_TEMPLATES.find(entry => entry.definition.role === role).definition);


/** What a character the wizard makes calls its Soul Class (soul.js): the Character template's own label and names. Kept for join.js, which still reads it; the wizard itself says "Lv". */
export const newSoul = () => soulReading(template('character').state.soul);

/** The block each extra role is made from, by its name: "Combat rules" and "Foes" (the stock templates, as Settings → Blocks offers them). */
export const extraName = role => STANDARD_TEMPLATES.find(entry => entry.definition.role === role)?.name ?? role;

/** The stock definitions for some of the extras (`roles`), their slugs free among `used` (the ids of the story's blocks and of the ones made with them). */
export function extraDefinitions(roles, { used = [] } = {}) {
    const taken = [...used];
    return roles.map(role => {
        const definition = template(role);
        definition.slug = uniqueBlockSlug(definition.name, taken);
        taken.push(definition.slug);
        return definition;
    });
}

/** The block names Create gives: "Wessel" and "Wessel's skills". */
export const blockNames = name => ({ character: name, skills: `${name}'s skills` });

/**
 * The two definitions Create makes, from the templates with the wizard's values written as the fields' defaults (so one `dm.define`
 * each makes the whole block, and the Skills block's `rankN` stays a field only play can move). `used` is the ids of the blocks
 * the chat has, so the slugs are free; `points` sets the Character's unspent points (a companion who joins starts with none, the
 * wizard's the budget left); `legacy` builds the Skills block of 2.21 (five slots, no signature mark); `cap` is the story's level cap (rules.js levelCapFor, 99 unset); `scale` the bar sizes (2, or 1 for the earlier ones). → { character, skills } (definitions, the Character first)
 */
export function buildDefinitions(draft, { used = [], points = null, cap = null, legacy = false, scale = 2, typed = true } = {}) {
    const names = blockNames(draft.name);
    // (`scale`: 2 for the doubled bars, the template's; 1 builds the Character as it was before them, for a companion joining a chat that has only such characters)
    const character = scale === 2 ? template('character') : characterV1For();
    character.slug = uniqueBlockSlug(names.character, used);
    character.name = names.character;
    const state = character.state;
    state.who.default = draft.name;
    state.about.default = draft.about;
    for (const stat of STATS) state[stat].default = draft.stats[stat];
    state.points.default = Number.isSafeInteger(points) ? Math.max(0, points) : Math.max(0, pointsLeft(draft));
    // The Standard formula's bars are rows of blocks that grow with VIT, AGI and INT: a new character starts with them full, and the hidden fields
    // that remember each bar's size start there too (blocks.js barFields), so the block's size rules find nothing to change.
    for (const [key, value] of Object.entries(barFields(draft.stats, scale))) if (state[key]) state[key].default = Math.min(value, Number.isSafeInteger(state[key].max) ? state[key].max : value);
    // The starting level (the draft's `level`, 1 to 99; a companion or a file that came with a Soul Class has the level it stands for): into the block's `level` field,
    // held to the story's cap (levelCapFor, 99 unset), with the cap as the block's `cap`; a block of the earlier rules gets the class the level stands for.
    const top = Number.isSafeInteger(cap) ? Math.max(1, Math.min(99, cap)) : 99;
    const wanted = draft.level > 1 ? draft.level : draft.soul >= 1 ? levelOfClass(draft.soul) : 1;   // (a draft read by readDraft has `level`; a raw one may still say the class)
    const start = Math.min(top, wanted);
    if (state.level) { state.level.default = start; state.cap.default = top; }
    else if (start > 1) state.soul.default = classOfLevel(start);
    // (`legacy`: the Skills block as 2.21 made it, for a Re-read of a join made before the extra slots; such a draft carries no skills)
    const skills = legacy ? skillsV1For() : typed ? template('skills') : skillsV2For();
    skills.slug = uniqueBlockSlug(`${draft.name} skills`, [...used, character.slug]);
    skills.name = names.skills;
    skills.state.who.default = draft.name;
    draft.skills.forEach((skill, at) => {
        const n = at + 1;
        skills.state[`skill${n}`].default = skill.name;
        skills.state[`about${n}`].default = skill.about;
        skills.state[`stat${n}`].default = skill.stat;
        skills.state[`uses${n}`].default = skill.uses;
        skills.state[`rank${n}`].default = Number.isSafeInteger(skill.rank) ? skill.rank : skill.start;
        if (skills.state[`type${n}`] && skill.type === 'utility') skills.state[`type${n}`].default = 'utility';
        // (a skill a pack's cast member brought: marked in the Skills block's `sig`, so the story never renames or replaces it)
        if (skill.sig === true && skills.state.sig) skills.state.sig.default += 2 ** (n - 1);
    });
    return { character, skills };
}

/** The rank a start value means ("Adept"). */
export const startName = start => RANK_NAMES[start] ?? RANK_NAMES[0];

/** The rank a draft's skill begins at: the file's rank after an import, else what was picked. */
export const rankOf = skill => (Number.isSafeInteger(skill?.rank) ? skill.rank : skill?.start ?? 0);
