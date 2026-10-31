// What the RPG screens read from the story state: the Character, Skills and Foes blocks (custom blocks whose
// definition has a `role`, see ROLES in ../index.js), as plain records the Party tab, the Spend points sheet, the
// battle log and the "Changed this reply" lines draw from. Pure: no DOM. Field keys are the ones COMMON.md fixes
// (`who`, `health`, `mana`, `stamina`, the seven stats, `points`, `soul`, `xp`, `alive`; `skillN` / `rankN` /
// `practiceN`; `foeN` / `countN` / `classN` / `hurtN`). Stored values are numbers; the words come from the field's
// `names` when it has them, else from the defaults below.

import { STATS, STAGES } from '../index.js';
import { activeDefinition, actorsOf, instanceOf } from '../../data-modules/adapters.js';
import { soulLabelOf } from '../soul.js';

export const SKILL_SLOTS = 5;
export const FOE_SLOTS = 4;
export const BARS = Object.freeze(['health', 'mana', 'stamina']);
const ROMAN = Object.freeze(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']);
const RANKS = Object.freeze(['Novice', 'Adept', 'Expert', 'Master']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value, fallback = 0) => (Number.isSafeInteger(value) ? value : fallback);
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** A number field's display name for `value` (`names` on the field), else `fallback`. */
export function nameOf(schema, value, fallback = '') {
    const named = isRecord(schema?.names) ? schema.names[String(value)] : undefined;
    return typeof named === 'string' && named ? named : fallback;
}

/** "II" for Soul Class 2. */
export const soulName = (schema, value) => nameOf(schema, value, ROMAN[value] ?? String(value));

/** "Expert" for rank 2. */
export const rankName = (schema, value) => nameOf(schema, value, RANKS[value] ?? String(value));

/** The stage word of a health, mana or stamina value ("Hurt"); the field's own names win. */
export function stageWord(key, schema, value) {
    const words = STAGES[key] ?? [];
    return nameOf(schema, value, words[value] ?? String(value));
}

/** The most stages a bar is drawn with (the checker holds a role block to it; a block that got past it is drawn clamped). */
export const MAX_STAGE = 10;

/** The highest stage index of a bar: the field's max, else the last stage word; never more than MAX_STAGE. */
export const stageMax = (key, schema) => Math.min(MAX_STAGE, Number.isSafeInteger(schema?.max) ? Math.max(0, schema.max) : Math.max(1, (STAGES[key]?.length ?? 2) - 1));

/** Good near full, warn in the middle, bad near empty (the mockup: Hurt amber, Fresh green, Spent red). */
export function stageTone(value, max) {
    if (!(max > 0)) return 'neutral';
    const ratio = value / max;
    return ratio >= 0.7 ? 'good' : ratio >= 0.4 ? 'warn' : 'bad';
}

/**
 * Every RPG block in the head state, in pin order: `{ module, role, subject, definition, fields }` per attached
 * subject (a chat block has one; a character block one per attached character). `roleOf(definition)` says what a
 * block is read as (default: its `role`).
 */
export function rpgBlocks(state, { roleOf = definition => definition?.role } = {}) {
    const domain = state?.domains?.dataModules;
    const out = [];
    for (const module of Object.keys(domain?.active ?? {})) {
        const definition = activeDefinition(state, module);
        const role = definition ? roleOf(definition) : null;
        if (!role) continue;
        const subjects = definition.scope === 'chat' ? ['chat'] : (domain.active[module].subjects ?? []);
        for (const subject of subjects) {
            const instance = instanceOf(state, module, subject);
            if (isRecord(instance?.fields)) out.push({ module, role, subject: subject === 'chat' ? null : subject, definition, fields: instance.fields, order: out.length });
        }
    }
    return out;
}

const textOf = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The skills a Skills block holds: `[{ slot, name, about, stat, uses, rank, rankName, practice }]`, empty slots left out. `stat` is
 * one of the seven stat keys and `uses` 'stamina' | 'mana' (null for a block made before they were fields).
 */
export function skillsOf(block) {
    const out = [];
    for (let slot = 1; slot <= SKILL_SLOTS; slot += 1) {
        const name = textOf(block.fields[`skill${slot}`]);
        if (!name) continue;
        const rank = whole(block.fields[`rank${slot}`]);
        const stat = textOf(block.fields[`stat${slot}`]).toLowerCase(), uses = textOf(block.fields[`uses${slot}`]).toLowerCase();
        out.push({ slot, name, about: textOf(block.fields[`about${slot}`]), stat: STATS.includes(stat) ? stat : null, uses: uses === 'mana' || uses === 'stamina' ? uses : null,
            rank, rankName: rankName(block.definition.state?.[`rank${slot}`], rank), practice: whole(block.fields[`practice${slot}`]) });
    }
    return out;
}

/** The foes a Foes block holds: `[{ slot, name, count, class, hurt, word }]`, empty slots left out (a slot is filled with a name and a count above 0, as the roll planner reads it). */
export function foesOf(block) {
    const out = [];
    for (let slot = 1; slot <= FOE_SLOTS; slot += 1) {
        const name = textOf(block.fields[`foe${slot}`]);
        const count = whole(block.fields[`count${slot}`], 0);
        if (!name || count <= 0) continue;
        const hurt = whole(block.fields[`hurt${slot}`], stageMax('health', block.definition.state?.[`hurt${slot}`]));
        out.push({ slot, name, count, class: whole(block.fields[`class${slot}`], 1), hurt,
            word: stageWord('health', block.definition.state?.[`hurt${slot}`] ?? block.definition.state?.health, hurt) });
    }
    return out;
}

/**
 * The party: one record per Character block (per attached character for a character-scope block), the reader's own
 * character first (`own` is their name), then block order. Each: `{ module, subject, name, own, alive, left (a companion who left the party), points, soul,
 * soulName, soulLabel (what the Character block calls the field, "Soul Class" by default), xp, bars: { health, mana, stamina: { value, max, word, tone } }, stats: [{ key, label, value, min, max }],
 * skills, skillsBlock, definition, fields }`.
 */
export function readParty(state, { own = '', roleOf } = {}) {
    const blocks = rpgBlocks(state, { roleOf });
    const actors = actorsOf(state);
    const skillBlocks = blocks.filter(block => block.role === 'skills');
    const characters = blocks.filter(block => block.role === 'character').map(block => {
        const { fields, definition } = block;
        const name = textOf(fields.who) || actors[block.subject]?.name || definition.name;
        const bars = Object.fromEntries(BARS.map(key => {
            const schema = definition.state?.[key], max = stageMax(key, schema), value = Math.min(max, Math.max(0, whole(fields[key], max)));
            return [key, { value, max, word: stageWord(key, schema, value), tone: stageTone(value, max) }];
        }));
        const stats = STATS.map(key => {
            const schema = definition.state?.[key] ?? {};
            const label = typeof schema.label === 'string' && schema.label && [...schema.label].length <= 4 ? schema.label : key.toUpperCase();
            return { key, label, value: whole(fields[key], schema.min ?? 1), min: whole(schema.min, 1), max: whole(schema.max, 20) };
        });
        const soul = whole(fields.soul, 1);
        const mine = skillBlocks.find(item => textOf(item.fields.who) && fold(item.fields.who) === fold(name))
            ?? (skillBlocks.length === 1 && !textOf(skillBlocks[0].fields.who) ? skillBlocks[0] : null);
        return { module: block.module, subject: block.subject, name, own: false, alive: fields.alive !== false, left: fields.left === true, points: Math.max(0, whole(fields.points)),
            soul, soulName: soulName(definition.state?.soul, soul), soulLabel: soulLabelOf(definition.state?.soul), xp: Math.min(100, Math.max(0, whole(fields.xp))), bars, stats,
            skills: mine ? skillsOf(mine) : [], skillsBlock: mine ? { module: mine.module, definition: mine.definition } : null, definition, fields, order: block.order };
    });
    const mineAt = own ? characters.findIndex(character => fold(character.name) === fold(own)) : -1;
    if (mineAt >= 0) characters[mineAt].own = true;
    return mineAt > 0 ? [characters[mineAt], ...characters.filter((_, at) => at !== mineAt)] : characters;
}

/** The foes in the state, across Foes blocks: `[{ name, count, class, hurt, word, slot }]`. */
export function readFoes(state, { roleOf } = {}) {
    return rpgBlocks(state, { roleOf }).filter(block => block.role === 'foes').flatMap(foesOf);
}

/** Whether the state has a Character block (the Party tab shows only then). */
export const hasCharacters = (state, options) => rpgBlocks(state, options).some(block => block.role === 'character');
