// Reading the sheet (SPEC_RPG §2R, brief A4): the RPG blocks of the chat, from the head state.
//
// An RPG block is a pinned chat block whose definition has a `role` (names.js ROLES). Field keys are fixed
// (suite-notes/rpg-briefs/COMMON.md):
//   character: who, health, mana, stamina (stage indexes, 0 = empty), str vit agi dex int luk cha, points, level (1–99; a block made before levels has soul 1–9 instead), cap,
//              xp, down (the death latch, hidden), alive
//   skills:    who, then per slot 1…5: skillN (name), aboutN (what it does), statN (one of the seven stats), usesN (stamina |
//              mana), rankN (0–3), practiceN (0–100)
//   foes:      foe1…foe6 (text; an older block has 1…4), count1…count6, level1…level6 (1–99; a block of the earlier rules has class1…class6, 1–9), hurt1…hurt6 (0–5)
// Pure and read-only: it takes a state (or anything shaped `{ domains: { dataModules } }`) and answers plain data. It
// never validates the definitions (the data-module checker did when they were pinned); a block it cannot read is left
// out, with a plain `problems` line.
import { FOE_SLOTS, LEVEL, STAGES, STATS, USES } from './names.js';
import { skillFieldSlots, skillTypeOf } from '../skill-slots.js';
import { dmHidden } from '../data-modules/schema.js';
import { barOf, characterBars, scaleOf, sizeOf } from './blocks.js';
import { soulReading } from './soul.js';
import { classOfLevel, levelOfClass } from './formula.js';
import { isHardBar } from './foes.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = value => (Number.isSafeInteger(value) ? value : null);
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** A name as the matcher compares it: NFKC, lower case, spaces and hyphens gone ("Iron-Breath" = "iron breath"). */
export const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—]+/gu, '');

/**
 * Whether a party member called `name` (with `aliases`) is the Character `character` (readSheet's), among the Characters `characters` (the whole sheet):
 * the same name (case, spaces and hyphens do not count); else the first name against the whole one (Ren is Ren Ashby) or an alias of the member that is
 * either, but only when exactly one Character is meant that way and no Character is called that exactly ("Ren Ashby" and "Ren Holt" with a member "Ren"
 * are neither: it is not guessed). An exact name always wins over a first name.
 */
export function sameWho(character, name, aliases = [], characters = [character]) {
    const first = value => fold(String(value ?? '').trim().split(/\s+/u)[0]);
    const values = [name, ...(Array.isArray(aliases) ? aliases : [])].filter(value => typeof value === 'string' && value.trim());
    const exact = entry => values.some(value => fold(value) === entry?.key);
    const loose = entry => {
        const whole = String(entry?.who ?? entry?.key ?? '');
        return values.some(value => (!/\s/u.test(value.trim()) && fold(value) === first(whole)) || (!/\s/u.test(whole.trim()) && fold(whole) === first(value)));
    };
    if (exact(character)) return true;
    const all = Array.isArray(characters) && characters.includes(character) ? characters : [...(Array.isArray(characters) ? characters : []), character];
    if (all.some(exact)) return false;
    return loose(character) && all.filter(loose).length === 1;
}

/**
 * Which of `entries` a phrase names (SPEC_RPG_v1 §4.5.1): an entry whose folded name equals the folded phrase, else the
 * longest entry whose folded name occurs inside the phrase ("iron breath drill" → Iron Breath), and with `either` also
 * an entry whose name contains the phrase when it is the only one. Two different entries of the same longest length are
 * ambiguous and nothing matches. → the entry, or null.
 */
export function matchName(entries, phrase, name, { either = false } = {}) {
    const wanted = fold(phrase);
    if (!wanted) return null;
    const named = entries.map(entry => ({ entry, key: fold(name(entry)) })).filter(item => item.key);
    const exact = named.filter(item => item.key === wanted);
    if (exact.length) return exact.length === 1 ? exact[0].entry : null;
    const inside = named.filter(item => wanted.includes(item.key));
    if (inside.length) {
        const longest = Math.max(...inside.map(item => item.key.length));
        const top = inside.filter(item => item.key.length === longest);
        return top.length === 1 ? top[0].entry : null;
    }
    if (either) {
        const holds = named.filter(item => item.key.includes(wanted));
        if (holds.length === 1) return holds[0].entry;
    }
    return null;
}

const FOE_NUMBER = /^(?:foe|slot|#)?\s*(\d{1,2})$/i;

/** The character a phrase names (by `who`), or null. */
export const matchCharacter = (sheet, phrase) => matchName(sheet?.characters ?? [], phrase, entry => entry.who, { either: true });

/** The filled foe slot a phrase names (its name, or "foe2" / "slot 2" / "2"), or null. */
export function matchFoe(sheet, phrase) {
    const slots = (sheet?.foes ?? []).filter(foe => foe.filled);
    const number = FOE_NUMBER.exec(String(phrase ?? '').trim());
    if (number) return slots.find(foe => foe.slot === Number(number[1])) ?? null;
    return matchName(slots, phrase, foe => foe.name, { either: true });
}

/** The skill of `who`'s Skills block that a phrase names, or null. */
export const matchSkill = (character, phrase) => matchName(character?.skills ?? [], phrase, skill => skill.name);

const definitionOf = (domain, id) => {
    const pin = domain.pins?.[domain.active?.[id]?.hash];
    return isObject(pin?.definition) ? pin.definition : null;
};
const fieldsOf = (domain, id) => {
    const instance = domain.instances?.[id]?.chat;
    return isObject(instance?.fields) ? instance.fields : null;
};

// A field the pack hides (`prompt: false`) is hidden from the story, not from the rules (review 160). A hidden text (a name, Who, an
// About) is not read at all: it would reach the sheet text, the plan and the cue. A hidden number or choice (health, a stat, Soul Class,
// a rank, a foe's count, class or health, a skill's stat or resource) still counts for the dice; the entry lists it in `hidden`, and
// the sheet text leaves it out.
const TEXT_KEY = /^(who|about\d*|skill\d+|foe\d+)$/;
const hiddenOf = definition => new Set(Object.entries(isObject(definition?.state) ? definition.state : {}).filter(([key, schema]) => key !== 'alive' && dmHidden(schema)).map(([key]) => key));
const shownFields = (fields, hidden) => (hidden.size ? Object.fromEntries(Object.entries(fields).filter(([key]) => !(hidden.has(key) && TEXT_KEY.test(key)))) : fields);

// `own`: the block's name, which stands in for a hidden Who (as the tail does). `definition`: the block's own, which says whether its bars are
// the Standard formula's blocks (blocks.js): then the record also has `size` (how many blocks each bar has now), and health, mana and stamina
// are the blocks left. A block of an older definition (stage fields) is read exactly as it was.
function character(id, fields, own = '', hidden = new Set(), definition = null) {
    const levelled = isObject(definition?.state) && isObject(definition.state.level);
    const schema = isObject(definition?.state) ? (levelled ? definition.state.level : definition.state.soul) : null;
    const who = text(fields.who) || text(own);
    if (!who) return null;
    const stats = Object.fromEntries(STATS.map(stat => [stat, int(fields[stat])]));
    // What the pack calls the Soul Class field and its current value (soul.js), for the sheet lines and the odds.
    // (A block made before levels has the Soul Class and no level: its level reads as the class stands for, levelOfClass. `soul` stays what the field says,
    // which is what a roll recorded before levels used.)
    const soul = int(fields.soul) ?? 1, reading = soulReading(schema);
    const level = Math.max(1, Math.min(LEVEL.max, int(fields.level) ?? (Object.hasOwn(fields, 'soul') ? levelOfClass(soul) : 1)));
    const cap = Math.max(1, Math.min(LEVEL.max, int(fields.cap) ?? LEVEL.max));
    const bars = characterBars(definition, fields);
    return {
        module: id, who, key: fold(who),
        health: int(fields.health), mana: int(fields.mana), stamina: int(fields.stamina),
        ...(bars ? { size: { health: bars.health.size, stamina: bars.stamina.size, mana: bars.mana.size } } : {}),
        ...(bars && scaleOf(definition.state.health) === 2 ? { scale: 2 } : {}),
        stats, soul, level, cap, ...(levelled ? { levelled: true } : {}), soulLabel: reading.label, soulWord: levelled ? String(level) : reading.word(soul), xp: int(fields.xp), points: int(fields.points),
        alive: fields.alive !== false,
        skills: [],
        hidden: [...hidden].filter(key => !TEXT_KEY.test(key)),
    };
}

function skillsOf(fields, hidden = new Set()) {
    const out = [];
    for (let n = 1; n <= skillFieldSlots(fields); n += 1) {
        const name = text(fields[`skill${n}`]);
        if (!name) continue;
        // A Skills block made before the stat and the resource were fields has neither: null, and the plan's stat is used.
        const stat = text(fields[`stat${n}`]).toLowerCase(), uses = text(fields[`uses${n}`]).toLowerCase();
        out.push({
            slot: n, name, about: text(fields[`about${n}`]), rank: int(fields[`rank${n}`]) ?? 0, practice: int(fields[`practice${n}`]) ?? 0,
            stat: STATS.includes(stat) ? stat : null, uses: USES.includes(uses) ? uses : null,
            ...(skillTypeOf(fields, n) === 'utility' ? { type: 'utility' } : {}),
            hidden: ['rank', 'practice', 'stat', 'uses'].filter(part => hidden.has(`${part}${n}`)),
        });
    }
    return out;
}

// A block's slots (six; an older block has 1…4). `offset`: where its numbering starts (the first Foes block is 1…6, the next 7…12, and so on; an older four-slot block is 1…4), so every
// slot of every Foes block has a number of its own in the plan.
// A hidden foe name is the slot's ("Foe 2"); a hidden count, class or health still counts for the rules and is listed in `hidden`.
function foesOf(id, fields, offset = 0, hidden = new Set(), state = null) {
    const out = [];
    // A six-group block has `foe5`/`foe6` and marks each slot `local` (its field number); an older one reads as always (the fight's witness hashes this sheet).
    const six = Object.hasOwn(fields, 'foe5') || Object.hasOwn(fields, 'foe6');
    for (let n = 1; n <= FOE_SLOTS; n += 1) {
        if (n > 4 && !Object.hasOwn(fields, `foe${n}`)) continue;
        // A Standard group's Health is blocks left, out of foeHealthBlocks(class): `size` says how many (a stage-field slot has none).
        const size = barOf(state?.[`hurt${n}`]) ? sizeOf(state[`hurt${n}`], fields, `hurt${n}`) : null;
        const name = hidden.has(`foe${n}`) ? (text(fields[`foe${n}`]) ? `Foe ${offset + n}` : '') : text(fields[`foe${n}`]);
        const count = int(fields[`count${n}`]) ?? 0;
        // A block of the Levels rules has `level{n}`; one of the earlier rules has `class{n}` (kept as it was), whose level is worked out from it.
        const levelled = Object.hasOwn(fields, `level${n}`), soulClass = int(fields[`class${n}`]) ?? 1;
        const level = levelled ? Math.max(1, Math.min(99, int(fields[`level${n}`]) ?? 1)) : levelOfClass(soulClass) ?? 1;
        out.push({ slot: offset + n, ...(six ? { local: n } : {}), module: id, name, count, class: levelled ? classOfLevel(level) : soulClass, level, ...(levelled ? { levelled } : {}), hurt: int(fields[`hurt${n}`]) ?? 0, ...(size ? { size } : {}), ...(size && isHardBar(state[`hurt${n}`]) ? { hard: 1 } : {}), filled: Boolean(name) && count > 0,
            hidden: ['count', 'class', 'level', 'hurt'].filter(part => hidden.has(`${part}${n}`)) });
    }
    return out;
}

/**
 * The chat's RPG blocks: `{ characters, foes, problems }`.
 *   characters: [{ module, who, key, health, mana, stamina, size?, stats: { str…cha }, soul, xp, points, down, alive,
 *                  skills: [{ slot, name, about, rank, practice, stat, uses }] }]   (a Skills block joins the character its `who` names;
 *                  stat is one of STATS and uses 'stamina' | 'mana', or null for a block that has neither)
 *                  `size`: { health, stamina, mana } only for a Standard Character block, where those three are the blocks left)
 *   foes: the slots (six; an older block has four) of every Foes block in block order, [{ slot, module, name, count, level, class, hurt, size?, filled }] ([] without one; `level` 1–99, worked out from `class` for a block of the earlier rules, which has no `levelled`; `class` of a levelled group is the Soul Class its level stands for, which the fight XP table of the earlier rules still reads); `size`: the
 *         blocks a Standard group's Health has (`hurt` is the blocks left); `slot`
 *         counts on across blocks (1–4, then 5–8, …), `filled` = a name and a count above 0
 *   problems: plain sentences for blocks left out (no `who`, two characters of one name)
 */
export function readSheet(state, { withLeft = false } = {}) {
    const sheet = { characters: [], foes: [], problems: [] };
    const domain = state?.domains?.dataModules;
    if (!isObject(domain) || !isObject(domain.active)) return sheet;
    const ids = Object.keys(domain.active).sort();
    const skills = [];
    for (const id of ids) {
        const definition = definitionOf(domain, id);
        const role = definition?.role;
        const raw = fieldsOf(domain, id);
        if (!raw || typeof role !== 'string') continue;
        const hidden = hiddenOf(definition), fields = shownFields(raw, hidden);
        if (role === 'character') {
            // A companion who left the party (`left`) is kept on the Party tab but is not on the sheet the dice are rolled for.
            // (`withLeft`, for `party.levels`: read too, `left: true`; `sheetLevel` is the stated level or null.)
            const gone = fields.left === true;
            if (gone && !withLeft) continue;
            const found = character(id, fields, hidden.has('who') || withLeft ? definition.name : '', hidden, definition);   // (`withLeft`: a blank Name uses the block's name, as the Party card does)
            if (found && withLeft) Object.assign(found, { left: gone, sheetLevel: int(fields.level) !== null || Object.hasOwn(fields, 'soul') ? found.level : null });   // (the level the card shows: clamped 1–99)
            if (!found) sheet.problems.push(`The Character block "${id}" has no name in its Who field, so it is left out.`);
            else if (!withLeft && sheet.characters.some(other => other.key === found.key)) sheet.problems.push(`Two Character blocks are called ${found.who}; only the first is used.`);
            else sheet.characters.push(found);
        } else if (role === 'skills') {
            const who = text(fields.who) || (hidden.has('who') ? text(definition.name) : '');
            if (who) skills.push({ who, list: skillsOf(fields, hidden) });
            else sheet.problems.push(`The Skills block "${id}" has no name in its Who field, so it is left out.`);
        } else if (role === 'foes') {
            sheet.foes.push(...foesOf(id, raw, sheet.foes.length, hidden, isObject(definition.state) ? definition.state : null));
        }
    }
    for (const block of skills) {
        const owner = sheet.characters.find(entry => entry.key === fold(block.who));
        if (owner && !owner.skills.length) owner.skills = block.list;
    }
    return sheet;
}

/** The character `who` names (exact, folded), or null. */
export const characterOf = (sheet, who) => sheet?.characters?.find(entry => entry.key === fold(who)) ?? null;

/** The stat `character` is best at (the first on a tie), or null when the sheet holds none of the seven. */
export function strongestStat(character) {
    let best = null;
    for (const stat of STATS) {
        const value = character?.stats?.[stat];
        if (Number.isInteger(value) && (best === null || value > character.stats[best])) best = stat;
    }
    return best;
}
