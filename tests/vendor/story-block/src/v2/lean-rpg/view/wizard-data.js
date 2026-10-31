// What the New character wizard works out, without a DOM: the draft's shape, the stat budget, the skill rules (up to five, at most
// one starting at Adept), the skill sets on offer (built in and from packs), the problems that stop Create, and the two block
// definitions Create makes. The draft lives in the dialog (`api.draft`), so this reads it as plain data and never trusts it:
// `readDraft` clamps whatever it finds. Field names are the ones the Character and Skills templates use (templates.js).
//
//   draft = { name, kind: 'you' | 'companion', about, stats: { str…cha }, skills: [{ name, about, stat, uses, start: 0 | 1 }], set, soul? }
//   (start is the rank a skill begins at: 0 Novice, 1 Adept; `set` is the id of the skill set last put in, '' for none; `soul` is the
//   Soul Class a companion who joins the story arrives with, 2 to 9: left out it is I, which is every character the reader makes)

import { DM_LIMITS } from '../../data-modules/schema.js';
import { activeDefinition } from '../../data-modules/adapters.js';
import { uniqueBlockSlug } from '../../data-modules/block-builder.js';
import { fold } from '../read.js';
import { CREATION, RANK_NAMES, SKILL_SLOTS, STATS, USES } from '../names.js';
import { LEAN_RPG_TEMPLATES, SKILL_SETS } from '../templates.js';
import { soulReading } from '../soul.js';
import { RPG_STRINGS, fill } from '../strings.js';

const W = RPG_STRINGS.wizard;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value, max) => [...(typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')].slice(0, max).join('');
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export const WIZARD_STEPS = Object.freeze(['who', 'stats', 'skills', 'review']);
export const KINDS = Object.freeze(['you', 'companion']);
/** The ranks a skill may start at: Novice, and Adept for at most one skill. */
export const START_RANKS = Object.freeze([0, 1]);

const startStats = () => Object.fromEntries(STATS.map(stat => [stat, CREATION.start]));
const blankSkill = () => ({ name: '', about: '', stat: STATS[0], uses: USES[0], start: 0 });

/** The draft a wizard opens with: the persona's name and You, every stat at its start. When the story already has a You it starts as a companion with no name (the persona's is taken). */
export function newDraft({ persona = '', hasYou = false } = {}) {
    return { name: hasYou ? '' : oneLine(persona, CREATION.name), kind: hasYou ? 'companion' : 'you', about: '', stats: startStats(), skills: [], set: '' };
}

/** A draft as the dialog holds it, made whole: every field in range, at most one Adept, at most five skills. */
export function readDraft(raw) {
    const given = isRecord(raw) ? raw : {};
    const stats = Object.fromEntries(STATS.map(stat => {
        const value = Number.isSafeInteger(given.stats?.[stat]) ? given.stats[stat] : CREATION.start;
        return [stat, clamp(value, CREATION.min, CREATION.max)];
    }));
    let adept = 0;
    const skills = (Array.isArray(given.skills) ? given.skills : []).slice(0, CREATION.skills).map(entry => {
        const skill = isRecord(entry) ? entry : {};
        const wantsAdept = skill.start === 1 && adept < CREATION.adept;
        if (wantsAdept) adept += 1;
        return {
            name: oneLine(skill.name, CREATION.skillName), about: oneLine(skill.about, CREATION.skillAbout),
            stat: STATS.includes(skill.stat) ? skill.stat : STATS[0], uses: USES.includes(skill.uses) ? skill.uses : USES[0], start: wantsAdept ? 1 : 0,
        };
    });
    return { name: oneLine(given.name, CREATION.name), kind: given.kind === 'companion' ? 'companion' : 'you',
        about: oneLine(given.about, CREATION.about), stats, skills, set: typeof given.set === 'string' ? given.set : '',
        ...(Number.isSafeInteger(given.soul) && given.soul > 1 ? { soul: clamp(given.soul, 1, 9) } : {}) };
}

/** Points left: the budget minus what the stats cost (a stat above its start costs a point a step; below it gives one back). */
export const pointsLeft = draft => CREATION.budget - STATS.reduce((sum, stat) => sum + draft.stats[stat] - CREATION.start, 0);

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

const template = role => structuredClone(LEAN_RPG_TEMPLATES.find(entry => entry.definition.role === role).definition);

/** What a character the wizard makes calls its Soul Class (soul.js): the Character template's own label and names. */
export const newSoul = () => soulReading(template('character').state.soul);

/** The block each extra role is made from, by its name: "Combat rules" and "Foes" (the stock templates, as Settings → Blocks offers them). */
export const extraName = role => LEAN_RPG_TEMPLATES.find(entry => entry.definition.role === role)?.name ?? role;

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
 * wizard's the budget left). → { character, skills } (definitions, the Character first)
 */
export function buildDefinitions(draft, { used = [], points = null } = {}) {
    const names = blockNames(draft.name);
    const character = template('character');
    character.slug = uniqueBlockSlug(names.character, used);
    character.name = names.character;
    const state = character.state;
    state.who.default = draft.name;
    state.about.default = draft.about;
    for (const stat of STATS) state[stat].default = draft.stats[stat];
    state.points.default = Number.isSafeInteger(points) ? Math.max(0, points) : Math.max(0, pointsLeft(draft));
    if (draft.soul > 1) state.soul.default = draft.soul;
    const skills = template('skills');
    skills.slug = uniqueBlockSlug(`${draft.name} skills`, [...used, character.slug]);
    skills.name = names.skills;
    skills.state.who.default = draft.name;
    draft.skills.forEach((skill, at) => {
        const n = at + 1;
        skills.state[`skill${n}`].default = skill.name;
        skills.state[`about${n}`].default = skill.about;
        skills.state[`stat${n}`].default = skill.stat;
        skills.state[`uses${n}`].default = skill.uses;
        skills.state[`rank${n}`].default = skill.start;
    });
    return { character, skills };
}

/** The rank a start value means ("Adept"). */
export const startName = start => RANK_NAMES[start] ?? RANK_NAMES[0];
