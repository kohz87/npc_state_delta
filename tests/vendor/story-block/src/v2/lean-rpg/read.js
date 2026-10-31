// Reading the sheet (SPEC_RPG §2R, brief A4): the RPG blocks of the chat, from the head state.
//
// An RPG block is a pinned chat block whose definition has a `role` (names.js ROLES). Field keys are fixed
// (suite-notes/rpg-briefs/COMMON.md):
//   character: who, health, mana, stamina (stage indexes, 0 = empty), str vit agi dex int luk cha, points, soul (1–9),
//              xp, down (the death latch, hidden), alive
//   skills:    who, then per slot 1…5: skillN (name), aboutN (what it does), statN (one of the seven stats), usesN (stamina |
//              mana), rankN (0–3), practiceN (0–100)
//   foes:      foe1…foe4 (text), count1…count4, class1…class4 (1–9), hurt1…hurt4 (0–5)
// Pure and read-only: it takes a state (or anything shaped `{ domains: { dataModules } }`) and answers plain data. It
// never validates the definitions (the data-module checker did when they were pinned); a block it cannot read is left
// out, with a plain `problems` line.
import { FOE_SLOTS, SKILL_SLOTS, STAGES, STATS, USES } from './names.js';
import { dmHidden } from '../data-modules/schema.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = value => (Number.isSafeInteger(value) ? value : null);
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** A name as the matcher compares it: NFKC, lower case, spaces and hyphens gone ("Iron-Breath" = "iron breath"). */
export const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—]+/gu, '');

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
// About) is not read at all: it would reach the planner, the plan and the cue. A hidden number or choice (health, a stat, Soul Class,
// a rank, a foe's count, class or health, a skill's stat or resource) still counts for the dice; the entry lists it in `hidden`, and
// the planner's sheet text leaves it out.
const TEXT_KEY = /^(who|about\d*|skill\d+|foe\d+)$/;
const hiddenOf = definition => new Set(Object.entries(isObject(definition?.state) ? definition.state : {}).filter(([key, schema]) => key !== 'alive' && dmHidden(schema)).map(([key]) => key));
const shownFields = (fields, hidden) => (hidden.size ? Object.fromEntries(Object.entries(fields).filter(([key]) => !(hidden.has(key) && TEXT_KEY.test(key)))) : fields);

// `own`: the block's name, which stands in for a hidden Who (as the tail does).
function character(id, fields, own = '', hidden = new Set()) {
    const who = text(fields.who) || text(own);
    if (!who) return null;
    const stats = Object.fromEntries(STATS.map(stat => [stat, int(fields[stat])]));
    return {
        module: id, who, key: fold(who),
        health: int(fields.health), mana: int(fields.mana), stamina: int(fields.stamina),
        stats, soul: int(fields.soul) ?? 1, xp: int(fields.xp), points: int(fields.points),
        alive: fields.alive !== false,
        skills: [],
        hidden: [...hidden].filter(key => !TEXT_KEY.test(key)),
    };
}

function skillsOf(fields, hidden = new Set()) {
    const out = [];
    for (let n = 1; n <= SKILL_SLOTS; n += 1) {
        const name = text(fields[`skill${n}`]);
        if (!name) continue;
        // A Skills block made before the stat and the resource were fields has neither: null, and the plan's stat is used.
        const stat = text(fields[`stat${n}`]).toLowerCase(), uses = text(fields[`uses${n}`]).toLowerCase();
        out.push({
            slot: n, name, about: text(fields[`about${n}`]), rank: int(fields[`rank${n}`]) ?? 0, practice: int(fields[`practice${n}`]) ?? 0,
            stat: STATS.includes(stat) ? stat : null, uses: USES.includes(uses) ? uses : null,
            hidden: ['rank', 'practice', 'stat', 'uses'].filter(part => hidden.has(`${part}${n}`)),
        });
    }
    return out;
}

// A block's four slots. `offset`: where its numbering starts (the first Foes block is 1…4, the next 5…8, and so on), so every
// slot of every Foes block has a number of its own in the plan.
// A hidden foe name is the slot's ("Foe 2"); a hidden count, class or health still counts for the rules and is listed in `hidden`.
function foesOf(id, fields, offset = 0, hidden = new Set()) {
    const out = [];
    for (let n = 1; n <= FOE_SLOTS; n += 1) {
        const name = hidden.has(`foe${n}`) ? (text(fields[`foe${n}`]) ? `Foe ${offset + n}` : '') : text(fields[`foe${n}`]);
        const count = int(fields[`count${n}`]) ?? 0;
        out.push({ slot: offset + n, module: id, name, count, class: int(fields[`class${n}`]) ?? 1, hurt: int(fields[`hurt${n}`]) ?? 0, filled: Boolean(name) && count > 0,
            hidden: ['count', 'class', 'hurt'].filter(part => hidden.has(`${part}${n}`)) });
    }
    return out;
}

/**
 * The chat's RPG blocks: `{ characters, foes, problems }`.
 *   characters: [{ module, who, key, health, mana, stamina, stats: { str…cha }, soul, xp, points, down, alive,
 *                  skills: [{ slot, name, about, rank, practice, stat, uses }] }]   (a Skills block joins the character its `who` names;
 *                  stat is one of STATS and uses 'stamina' | 'mana', or null for a block that has neither)
 *   foes: the four slots of every Foes block in block order, [{ slot, module, name, count, class, hurt, filled }] ([] without one); `slot`
 *         counts on across blocks (1–4, then 5–8, …), `filled` = a name and a count above 0
 *   problems: plain sentences for blocks left out (no `who`, two characters of one name)
 */
export function readSheet(state) {
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
            const found = character(id, fields, hidden.has('who') ? definition.name : '', hidden);
            if (!found) sheet.problems.push(`The Character block "${id}" has no name in its Who field, so it is left out.`);
            else if (sheet.characters.some(other => other.key === found.key)) sheet.problems.push(`Two Character blocks are called ${found.who}; only the first is used.`);
            else sheet.characters.push(found);
        } else if (role === 'skills') {
            const who = text(fields.who) || (hidden.has('who') ? text(definition.name) : '');
            if (who) skills.push({ who, list: skillsOf(fields, hidden) });
            else sheet.problems.push(`The Skills block "${id}" has no name in its Who field, so it is left out.`);
        } else if (role === 'foes') {
            sheet.foes.push(...foesOf(id, raw, sheet.foes.length, hidden));
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
