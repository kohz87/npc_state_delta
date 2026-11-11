// What the RPG screens read from the story state: the Character, Skills and Foes blocks (custom blocks whose
// definition has a `role`, see ROLES in ../index.js), as plain records the Party tab, the Spend points sheet, the
// battle log and the "Changed this reply" lines draw from. Pure: no DOM. Field keys are the ones COMMON.md fixes
// (`who`, `health`, `mana`, `stamina`, the seven stats, `points`, `soul`, `xp`, `alive`; `skillN` / `rankN` /
// `practiceN`; `foeN` / `countN` / `classN` / `hurtN`). Stored values are numbers; the words come from the field's
// `names` when it has them, else from the defaults below. A bar field with `blocks` (the Standard formula, ../blocks.js) stores the blocks left;
// its size comes from the stats (the foe's class) and its stage word is spread over that size; every other bar reads as it always did.

import { STATS, STAGES } from '../index.js';
import { STANDARD_NUMBERS, levelOfClass } from '../formula.js';
import { barOf, characterBars, growthOf, scaleOf, sizeOf, spreadWord, statsOfFields, wordsOf } from '../blocks.js';
import { activeDefinition, actorsOf, instanceOf } from '../../data-modules/adapters.js';
import { LEVEL } from '../names.js';
import { soakGrowth } from '../soak.js';
import { skillFieldSlots, isTypedSkills, signatureAt, skillTypeOf } from '../../skill-slots.js';
import { levelLabel, playerRankValue } from '../levels.js';
import { soulLabelOf } from '../soul.js';
import { RPG_STRINGS, fill } from '../strings.js';

export const FOE_SLOTS = 6;
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

/** A level from a stored value: a whole number 1 to 99 (`fallback` when it is not one). */
export const levelOf = (value, fallback = 1) => (Number.isSafeInteger(value) ? Math.min(LEVEL.max, Math.max(1, value)) : fallback);

/** "Lv 14 · Guild F" for a party member (the pack's player rank), "Rank F · Lv 7" for a foe or a member of a story with no player-rank source, else "Lv 14". */
export function levelText(level, { ranks = [], playerRank = null, state = null, subject = null, foe = false } = {}) {
    if (foe || !playerRank) return levelLabel(level, ranks);
    return levelLabel(level, ranks, { playerRank, value: playerRankValue(state, playerRank) });
}

/** "24 / 100 to Lv 15", or "100 / 100 · level cap" at the cap (the XP holds at 100 there). */
export const xpLine = character => (character.level >= character.cap ? fill(RPG_STRINGS.party.xpCap, { xp: character.xp }) : fill(RPG_STRINGS.party.xpText, { xp: character.xp, next: character.level + 1 }));

/** "II" for Soul Class 2 (a chat made before Levels still reads its stored class). */
export const soulName = (schema, value) => nameOf(schema, value, ROMAN[value] ?? String(value));

/** "Expert" for rank 2. */
export const rankName = (schema, value) => nameOf(schema, value, RANKS[value] ?? String(value));

/** The stage word of a health, mana or stamina value ("Hurt"); the field's own names win. */
export function stageWord(key, schema, value) {
    const words = STAGES[key] ?? [];
    return nameOf(schema, value, words[value] ?? String(value));
}

/** The bar's own reading when its field is a Standard block bar: `{ value, max, word, text, tone, blocks: true }` (`text`: "Hurt · 4/6"), else null. */
export function blockBar(key, schema, fields, fieldKey = key) {
    const bar = barOf(schema);
    if (!bar) return null;
    const size = sizeOf(schema, fields, fieldKey), value = Math.min(size, Math.max(0, whole(fields?.[fieldKey], size)));
    const word = spreadWord(wordsOf(bar), value, size);
    return { value, max: size, word, text: fill(RPG_STRINGS.blocks.of, { word, n: value, max: size }), tone: stageTone(value, size), blocks: true };
}

// "Soak +3 (next at VIT 16)": what VIT soaks of a foe's hit in a marked fight (soak.js), from the VIT a roll uses (gear included).
const soakLine = vit => { const { s, next } = soakGrowth(vit); return fill(next === null ? RPG_STRINGS.blocks.soakTop : RPG_STRINGS.blocks.soak, { n: s, next: next ?? '' }); };

/**
 * The line under a Standard character's skills (mockup step 1): "Health 6 blocks (VIT 10, next at 15) · Stamina 5 (AGI 10, next at 15) · Mana 4 (INT 5, next at 10) ·
 * Edge 0..+3 (next at LUK 11) · Soak +3 (next at VIT 16)" (Soak only for a character with the doubled bars, from `soakVit`, the VIT a roll uses). `growth` is `growthOf` (blocks.js); a stat at its maximum has no next block, and the edge window steps at LUK 5, 7, 11, 13, 15, 17 and 19.
 */
export function growthText(growth, soakVit = null) {
    const B = RPG_STRINGS.blocks;
    const bar = (word, group) => fill(group.next === null ? B[`${word}Top`] : B[word], { n: group.blocks, stat: group.value, next: group.next ?? '' });
    const sign = n => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
    return [bar('growthHealth', growth.health), bar('growthStamina', growth.stamina), bar('growthMana', growth.mana),
        fill(growth.luck.next === null ? B.luckTop : B.luck, { min: sign(growth.luck.min), max: sign(growth.luck.max), next: growth.luck.next ?? '' }),
        ...(Number.isFinite(soakVit) ? [soakLine(soakVit)] : [])].join(' · ');
}

/** The choices of a bar's edit (the pencil): every count from empty to full, "Hurt · 4/6" for a block bar, the stage word for a stage bar. */
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
 * The skills a Skills block holds: `[{ slot, name, about, stat, uses, rank, rankName, practice, signature? }]`, empty slots left out (`signature`: the pack gave it, the `sig` mark). `stat` is
 * one of the seven stat keys and `uses` 'stamina' | 'mana' (null for a block made before they were fields).
 */
export function skillsOf(block) {
    const out = [];
    for (let slot = 1; slot <= skillFieldSlots(block.fields); slot += 1) {
        const name = textOf(block.fields[`skill${slot}`]);
        if (!name) continue;
        const rank = whole(block.fields[`rank${slot}`]);
        const stat = textOf(block.fields[`stat${slot}`]).toLowerCase(), uses = textOf(block.fields[`uses${slot}`]).toLowerCase();
        out.push({ slot, name, about: textOf(block.fields[`about${slot}`]), stat: STATS.includes(stat) ? stat : null, uses: uses === 'mana' || uses === 'stamina' ? uses : null,
            rank, rankName: rankName(block.definition.state?.[`rank${slot}`], rank), practice: whole(block.fields[`practice${slot}`]),
            ...(signatureAt(block.fields.sig, slot) ? { signature: true } : {}), ...(isTypedSkills(block.fields) ? { type: skillTypeOf(block.fields, slot) } : {}) });
    }
    return out;
}

/** The foes a Foes block holds: `[{ slot, name, count, level, levelText ("Rank F · Lv 7"), hurt, word, max?, text?, blocks? }]` (a Standard group has its size `max`, the `text` "Hurt · 4 of 6"), empty slots left out (a slot is filled with a name and a count above 0, as the fight board reads it). */
export function foesOf(block, { ranks = [] } = {}) {
    const out = [];
    for (let slot = 1; slot <= FOE_SLOTS; slot += 1) {
        const name = textOf(block.fields[`foe${slot}`]);
        const count = whole(block.fields[`count${slot}`], 0);
        if (!name || count <= 0) continue;
        const schema = block.definition.state?.[`hurt${slot}`], blocks = blockBar('health', schema, block.fields, `hurt${slot}`);
        const hurt = blocks ? blocks.value : whole(block.fields[`hurt${slot}`], stageMax('health', schema));
        // `level{n}` (Levels); a chat made before them keeps its `class{n}`, whose level is the one the older rules stood for (formula.js levelOfClass).
        const level = Object.hasOwn(block.fields, `level${slot}`) ? levelOf(block.fields[`level${slot}`]) : levelOfClass(whole(block.fields[`class${slot}`], 1));
        out.push({ slot, name, count, level, levelled: Object.hasOwn(block.fields, `level${slot}`), levelText: levelText(level, { ranks, foe: true }), hurt,
            word: blocks ? blocks.word : stageWord('health', schema ?? block.definition.state?.health, hurt), ...(blocks ? { max: blocks.max, text: blocks.text, blocks: true } : {}) });
    }
    return out;
}

/**
 * The party: one record per Character block (per attached character for a character-scope block), the reader's own
 * character first (`own` is their name), then block order. Each: `{ module, subject, name, own, alive, left (a companion who left the party), points, level, cap, levelText ("Lv 14 · Guild F"),
 * soul / soulName / soulLabel (the level standing in for the old Soul Class), xp, bars: { health, mana, stamina: { value, max, word, tone, text?, blocks? } } (a
 * Standard block's bars: `max` is its size from the stats, `text` "Hurt · 4 of 6"), growth (the Standard "next block / next luck" numbers, blocks.js `growthOf`, or null), stats: [{ key, label, value, min, max }],
 * skills, skillsBlock, definition, fields }`.
 */
export function readParty(state, { own = '', roleOf, ranks = [], playerRank = null } = {}) {
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
        // `level`, `xp` and `cap` (Levels). A block made before them has the Soul Class: its level is the one the class stood for (formula.js levelOfClass).
        const soul = whole(fields.soul, 1);
        const levelled = Boolean(definition.state?.level) && typeof definition.state.level === 'object';
        const level = levelled ? levelOf(fields.level) : levelOfClass(soul), cap = levelOf(fields.cap, LEVEL.max);
        const mine = skillBlocks.find(item => textOf(item.fields.who) && fold(item.fields.who) === fold(name))
            ?? (skillBlocks.length === 1 && !textOf(skillBlocks[0].fields.who) ? skillBlocks[0] : null);
        return { module: block.module, subject: block.subject, name, own: false, alive: fields.alive !== false, left: fields.left === true, points: Math.max(0, whole(fields.points)),
            soul, level, cap, ...(levelled ? { levelled: true } : {}), levelText: levelText(level, { ranks, playerRank, state, subject: block.subject }),
            soulName: levelled ? String(level) : soulName(definition.state?.soul, soul), soulLabel: soulLabelOf(levelled ? definition.state.level : definition.state?.soul), xp: Math.min(LEVEL.xpPerLevel, Math.max(0, whole(fields.xp))), bars, stats,
            skills: mine ? skillsOf(mine) : [], skillsBlock: mine ? { module: mine.module, definition: mine.definition } : null, definition, fields, order: block.order,
            growth: characterBars(definition, fields) ? growthOf(statsOfFields(fields), { statMax: whole(definition.state?.vit?.max, STANDARD_NUMBERS.statMax), scale: scaleOf(definition.state?.health) }) : null, scale: scaleOf(definition.state?.health) };
    });
    const mineAt = own ? characters.findIndex(character => fold(character.name) === fold(own)) : -1;
    if (mineAt >= 0) characters[mineAt].own = true;
    return mineAt > 0 ? [characters[mineAt], ...characters.filter((_, at) => at !== mineAt)] : characters;
}

/** The foes in the state, across Foes blocks: `[{ name, count, level, levelText, hurt, word, slot }]`. */
export function readFoes(state, { roleOf, ranks = [] } = {}) {
    return rpgBlocks(state, { roleOf }).filter(block => block.role === 'foes').flatMap(block => foesOf(block, { ranks }));
}

/** Whether the state has a Character block (the Party tab shows only then). */
export const hasCharacters = (state, options) => rpgBlocks(state, options).some(block => block.role === 'character');
