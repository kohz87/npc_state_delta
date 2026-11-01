// What the RPG screens read from the story state: the Character, Skills and Foes blocks (custom blocks whose
// definition has a `role`, see ROLES in ../index.js), as plain records the Party tab, the Spend points sheet, the
// battle log and the "Changed this reply" lines draw from. Pure: no DOM. Field keys are the ones COMMON.md fixes
// (`who`, `health`, `mana`, `stamina`, the seven stats, `points`, `soul`, `xp`, `alive`; `skillN` / `rankN` /
// `practiceN`; `foeN` / `countN` / `classN` / `hurtN`). Stored values are numbers; the words come from the field's
// `names` when it has them, else from the defaults below. A bar field with `blocks` (the Standard formula, ../blocks.js) stores the blocks left;
// its size comes from the stats (the foe's class) and its stage word is spread over that size; every other bar reads as it always did.

import { STATS, STAGES } from '../index.js';
import { STANDARD_NUMBERS } from '../formula.js';
import { barOf, characterBars, growthOf, sizeOf, spreadWord, statsOfFields, wordsOf } from '../blocks.js';
import { activeDefinition, actorsOf, instanceOf } from '../../data-modules/adapters.js';
import { soulLabelOf } from '../soul.js';
import { RPG_STRINGS, fill } from '../strings.js';

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

/** The bar's own reading when its field is a Standard block bar: `{ value, max, word, text, tone, blocks: true }` (`text`: "Hurt · 4 of 6"), else null. */
export function blockBar(key, schema, fields, fieldKey = key) {
    const bar = barOf(schema);
    if (!bar) return null;
    const size = sizeOf(schema, fields, fieldKey), value = Math.min(size, Math.max(0, whole(fields?.[fieldKey], size)));
    const word = spreadWord(wordsOf(bar), value, size);
    return { value, max: size, word, text: fill(RPG_STRINGS.blocks.of, { word, n: value, max: size }), tone: stageTone(value, size), blocks: true };
}

/**
 * The line under a Standard character's skills (mockup step 1): "Health 6 blocks (VIT 10, next at 15) · Stamina 5 (AGI 10, next at 15) · Mana 4 (INT 5, next at 10) ·
 * Edge 0..+3 (next at LUK 11)". `growth` is `growthOf` (blocks.js); a stat at its maximum has no next block, and the edge window steps at LUK 5, 7, 11, 13, 15, 17 and 19.
 */
export function growthText(growth) {
    const B = RPG_STRINGS.blocks;
    const bar = (word, group) => fill(group.next === null ? B[`${word}Top`] : B[word], { n: group.blocks, stat: group.value, next: group.next ?? '' });
    const sign = n => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
    return [bar('growthHealth', growth.health), bar('growthStamina', growth.stamina), bar('growthMana', growth.mana),
        fill(growth.luck.next === null ? B.luckTop : B.luck, { min: sign(growth.luck.min), max: sign(growth.luck.max), next: growth.luck.next ?? '' })].join(' · ');
}

/** The choices of a bar's edit (the pencil): every count from empty to full, "Hurt · 4 of 6" for a block bar, the stage word for a stage bar. */
export function barOptions(key, schema, bar, fields, fieldKey = key) {
    if (bar?.blocks) return Array.from({ length: bar.max + 1 }, (_, value) => ({ value, label: fill(RPG_STRINGS.blocks.of, { word: spreadWord(wordsOf(barOf(schema)), value, bar.max), n: value, max: bar.max }) }));
    return Array.from({ length: bar.max + 1 }, (_, value) => ({ value, label: stageWord(key, schema, value) }));
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

/** The foes a Foes block holds: `[{ slot, name, count, class, hurt, word, max?, text?, blocks? }]` (a Standard group has its size `max`, the `text` "Hurt · 4 of 6"), empty slots left out (a slot is filled with a name and a count above 0, as the roll planner reads it). */
export function foesOf(block) {
    const out = [];
    for (let slot = 1; slot <= FOE_SLOTS; slot += 1) {
        const name = textOf(block.fields[`foe${slot}`]);
        const count = whole(block.fields[`count${slot}`], 0);
        if (!name || count <= 0) continue;
        const schema = block.definition.state?.[`hurt${slot}`], blocks = blockBar('health', schema, block.fields, `hurt${slot}`);
        const hurt = blocks ? blocks.value : whole(block.fields[`hurt${slot}`], stageMax('health', schema));
        out.push({ slot, name, count, class: whole(block.fields[`class${slot}`], 1), hurt,
            word: blocks ? blocks.word : stageWord('health', schema ?? block.definition.state?.health, hurt), ...(blocks ? { max: blocks.max, text: blocks.text, blocks: true } : {}) });
    }
    return out;
}

/**
 * The party: one record per Character block (per attached character for a character-scope block), the reader's own
 * character first (`own` is their name), then block order. Each: `{ module, subject, name, own, alive, left (a companion who left the party), points, soul,
 * soulName, soulLabel (what the Character block calls the field, "Soul Class" by default), xp, bars: { health, mana, stamina: { value, max, word, tone, text?, blocks? } } (a
 * Standard block's bars: `max` is its size from the stats, `text` "Hurt · 4 of 6"), growth (the Standard "next block / next luck" numbers, blocks.js `growthOf`, or null), stats: [{ key, label, value, min, max }],
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
            const schema = definition.state?.[key], blocks = blockBar(key, schema, fields);
            if (blocks) return [key, blocks];
            const max = stageMax(key, schema), value = Math.min(max, Math.max(0, whole(fields[key], max)));
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
            skills: mine ? skillsOf(mine) : [], skillsBlock: mine ? { module: mine.module, definition: mine.definition } : null, definition, fields, order: block.order,
            growth: characterBars(definition, fields) ? growthOf(statsOfFields(fields), { statMax: whole(definition.state?.vit?.max, STANDARD_NUMBERS.statMax) }) : null };
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
