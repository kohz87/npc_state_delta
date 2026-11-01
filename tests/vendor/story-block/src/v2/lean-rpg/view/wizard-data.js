// What the New character wizard works out, without a DOM: the draft's shape, the stat budget, the skill rules (up to five, at most
// one starting at Adept), the skill sets on offer (built in and from packs), the problems that stop Create, and the two block
// definitions Create makes. The draft lives in the dialog (`api.draft`), so this reads it as plain data and never trusts it:
// `readDraft` clamps whatever it finds. Field names are the ones the Character and Skills templates use (templates.js).
//
//   draft = { name, kind: 'you' | 'companion', about, stats: { str…cha }, skills: [{ name, about, stat, uses, start: 0 | 1, rank? }], set, soul?, from? }
//   `creation` (Standard only): { start, budget, min, max, statMax, standard: true }, the numbers creation runs on (stats start at `start`, `budget`
//   points to spend, a stat from `min` to `max`); a draft without it runs on names.js CREATION (Classic).
//   (start is the rank a skill begins at: 0 Novice, 1 Adept; `set` is the id of the skill set last put in, '' for none; `soul` is the
//   Soul Class a companion who joins the story arrives with, or an imported character has, 2 to 9: left out it is I. `from` and a skill's
//   `rank` are there only after an import (a saved character file, ../charfile.js): `from` = { stats, points } is what the file had, which
//   the stats are spent from, and `rank` (0 to 3) is the rank the file gave a skill, which is not typed and not counted as the Adept one.)

import { DM_LIMITS } from '../../data-modules/schema.js';
import { activeDefinition } from '../../data-modules/adapters.js';
import { uniqueBlockSlug } from '../../data-modules/block-builder.js';
import { fold } from '../read.js';
import { CREATION, RANK_NAMES, SKILL_SLOTS, STATS, USES } from '../names.js';
import { isStandard } from '../rules.js';
import { LEAN_RPG_TEMPLATES, SKILL_SETS, templatesFor } from '../templates.js';
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
 * The numbers creation runs on under `rules`: Classic's (names.js CREATION) or, for the Standard formula, `{ ...CREATION, start, budget, min, max,
 * statMax, perSoul, standard: true }` from the rules' startStat, createPoints, createMin, createMax, statMax and pointsPerSoul.
 */
export function creationOf(rules) {
    if (!isStandard(rules)) return CREATION;
    return { ...CREATION, start: rules.startStat, budget: rules.createPoints, min: rules.createMin, max: rules.createMax, statMax: rules.statMax, perSoul: rules.pointsPerSoul, standard: true };
}

/** The numbers a draft runs on: its own `creation` (Standard), else Classic's. */
export const draftCreation = draft => (draft?.creation?.standard === true ? draft.creation : CREATION);

// A draft's `creation` as the dialog may hand it back: whole numbers in range, else dropped (the draft then runs on Classic's).
function readCreation(raw) {
    if (!isRecord(raw) || raw.standard !== true) return null;
    const whole = (value, low, high) => (Number.isSafeInteger(value) && value >= low && value <= high ? value : null);
    const start = whole(raw.start, 1, 10), budget = whole(raw.budget, 0, 400), min = whole(raw.min, 1, 10), max = whole(raw.max, 3, 20), statMax = whole(raw.statMax, 10, 20), perSoul = whole(raw.perSoul, 0, 10);
    if ([start, budget, min, max, statMax, perSoul].includes(null) || !(min <= start && start <= max && max <= statMax)) return null;
    return { ...CREATION, start, budget, min, max, statMax, perSoul, standard: true };
}

const blankSkill = () => ({ name: '', about: '', stat: STATS[0], uses: USES[0], start: 0 });

/** The draft a wizard opens with: the persona's name and You, every stat at its start. When the story already has a You it starts as a companion with no name (the persona's is taken). */
export function newDraft({ persona = '', hasYou = false, rules = null } = {}) {
    const creation = isStandard(rules) ? creationOf(rules) : null;
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
    let adept = 0;
    const skills = (Array.isArray(given.skills) ? given.skills : []).slice(0, CREATION.skills).map(entry => {
        const skill = isRecord(entry) ? entry : {};
        // A rank the file gave: kept as it is, and it is not the one Adept a new skill may start at.
        const ranked = from && Number.isSafeInteger(skill.rank);
        const wantsAdept = !ranked && skill.start === 1 && adept < CREATION.adept;
        if (wantsAdept) adept += 1;
        return {
            name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
            // An imported skill may have no stat (''): the reader picks one, and Create waits for it.
            stat: STATS.includes(skill.stat) ? skill.stat : (ranked ? '' : STATS[0]), uses: USES.includes(skill.uses) ? skill.uses : USES[0], start: wantsAdept ? 1 : 0,
            ...(ranked ? { rank: clamp(skill.rank, 0, FILE_LIMITS.rank) } : {}),
        };
    });
    return { name: oneLine(given.name, CREATION.name), kind: given.kind === 'companion' ? 'companion' : 'you',
        about: oneLine(given.about, CREATION.about), stats, skills, set: typeof given.set === 'string' ? given.set : '',
        ...(Number.isSafeInteger(given.soul) && given.soul > 1 ? { soul: clamp(given.soul, 1, 9) } : {}), ...(from ? { from } : {}), ...(creation ? { creation } : {}) };
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

/** A skill set put into the draft: its skills (up to five), every one at Novice. */
export function withSet(draft, set) {
    const skills = (set?.skills ?? []).slice(0, CREATION.skills).map(skill => ({
        name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
        stat: STATS.includes(skill.stat) ? skill.stat : STATS[0], uses: USES.includes(skill.uses) ? skill.uses : USES[0], start: 0,
    }));
    return { ...draft, skills, set: String(set?.id ?? '') };
}

/** A new blank skill added to the draft, when there is room. */
export const withSkill = draft => (draft.skills.length >= SKILL_SLOTS ? draft : { ...draft, skills: [...draft.skills, blankSkill()] });

/** One skill changed (`patch`: any of name, about, stat, uses, start); a second Adept is refused. */
export function withSkillPatch(draft, index, patch) {
    if (!draft.skills[index]) return draft;
    const next = { ...draft.skills[index], ...patch };
    if (next.start === 1 && !mayStartAdept(draft, index)) next.start = 0;
    return { ...draft, skills: draft.skills.map((skill, at) => (at === index ? next : skill)) };
}

/** The skill at `index` taken out. */
export const withoutSkill = (draft, index) => ({ ...draft, skills: draft.skills.filter((_, at) => at !== index) });

/**
 * A saved character put into the draft (a good file, ../charfile.js parseCharacterFile): its stats, unspent points (the pool the stats are spent
 * from), Soul Class and skills with their ranks. The name, You or a companion, who they are and the skill set choice are left alone (a set is
 * cleared: the skills now come from the file). → { draft, before }, `before` being what `withoutImport` puts back.
 */
export function withImport(draft, file) {
    const before = structuredClone({ stats: draft.stats, skills: draft.skills, set: draft.set, ...(draft.soul > 1 ? { soul: draft.soul } : {}), ...(draft.from ? { from: draft.from } : {}) });
    const { soul: _soul, from: _from, ...rest } = draft;
    const next = {
        ...rest, stats: { ...file.stats }, set: '', from: { stats: { ...file.stats }, points: file.points },
        skills: file.skills.slice(0, CREATION.skills).map(skill => ({ name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout), stat: skill.stat ?? '', uses: skill.uses, start: 0, rank: skill.rank })),
        ...(file.soul > 1 ? { soul: file.soul } : {}),
    };
    return { draft: next, before };
}

/** The draft as it was before `withImport` (`before` is what that handed back): the stats, skills, Soul Class and skill set; nothing typed since is touched. */
export function withoutImport(draft, before) {
    const { soul: _soul, from: _from, ...rest } = draft;
    const back = structuredClone(before ?? {});
    return { ...rest, stats: back.stats ?? startStats(null), skills: back.skills ?? [], set: back.set ?? '', ...(back.soul > 1 ? { soul: back.soul } : {}), ...(back.from ? { from: back.from } : {}) };
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

// (A Standard chat's blocks are made from the Standard templates, a Classic chat's from the originals: templates.js templatesFor.)
const template = (role, formula = 'classic') => structuredClone(templatesFor(formula).find(entry => entry.definition.role === role).definition);

/** What a character the wizard makes calls its Soul Class (soul.js): the Character template's own label and names. */
export const newSoul = () => soulReading(template('character').state.soul);

/** The block each extra role is made from, by its name: "Combat rules" and "Foes" (the stock templates, as Settings → Blocks offers them). */
export const extraName = role => LEAN_RPG_TEMPLATES.find(entry => entry.definition.role === role)?.name ?? role;

/** The stock definitions for some of the extras (`roles`), their slugs free among `used` (the ids of the story's blocks and of the ones made with them). */
export function extraDefinitions(roles, { used = [], formula = 'classic' } = {}) {
    const taken = [...used];
    return roles.map(role => {
        const definition = template(role, formula);
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
 * wizard's the budget left). → { character, skills } (definitions, the Character first)
 */
export function buildDefinitions(draft, { used = [], points = null } = {}) {
    const names = blockNames(draft.name);
    const formula = draftCreation(draft).standard ? 'standard' : 'classic';
    const character = template('character', formula);
    character.slug = uniqueBlockSlug(names.character, used);
    character.name = names.character;
    const state = character.state;
    state.who.default = draft.name;
    state.about.default = draft.about;
    for (const stat of STATS) state[stat].default = draft.stats[stat];
    state.points.default = Number.isSafeInteger(points) ? Math.max(0, points) : Math.max(0, pointsLeft(draft));
    // The Standard formula's bars are rows of blocks that grow with VIT, AGI and INT: a new character starts with them full, and the hidden fields
    // that remember each bar's size start there too (blocks.js barFields), so the block's size rules find nothing to change.
    if (formula === 'standard') for (const [key, value] of Object.entries(barFields(draft.stats))) if (state[key]) state[key].default = Math.min(value, Number.isSafeInteger(state[key].max) ? state[key].max : value);
    if (draft.soul > 1) state.soul.default = draft.soul;
    const skills = template('skills', formula);
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
    });
    return { character, skills };
}

/** The rank a start value means ("Adept"). */
export const startName = start => RANK_NAMES[start] ?? RANK_NAMES[0];

/** The rank a draft's skill begins at: the file's rank after an import, else what was picked. */
export const rankOf = skill => (Number.isSafeInteger(skill?.rank) ? skill.rank : skill?.start ?? 0);
