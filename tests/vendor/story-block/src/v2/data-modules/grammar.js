// The narrator's grammar for pinned data modules, generated from the frozen declarations (never an author
// regex, never a second `<Changes>` parser): decision 6's short slug reference when it is unique among the
// chat's active pins, the full `pack.<id>/<slug>` otherwise. Shared by the prompt's static part and Setup.
import { DM_LIMITS as L, dmKindWritesHidden, dmLabelNames } from './schema.js';
import { oneLine } from '../../text.js';

/** The name a `dm` line uses for module `id` among the active ids: the bare slug when unique, else the full ID. */
export function referenceOf(ids, id) {
    const slug = String(id).split('/')[1];
    return ids.filter(other => String(other).split('/')[1] === slug).length === 1 ? slug : id;
}

// A number with display names: when every whole value has one, the names in order and then the range ("Down|Hurt|Unhurt (0..2)");
// else the range and the names it has ("1..9 (1=I, 2=II)"). The narrator may write either the name or the number.
function namedRange(schema, names) {
    const range = `${schema.min}..${schema.max}`, count = schema.max - schema.min + 1;
    const all = count <= L.names && Array.from({ length: count }, (_, at) => names[String(schema.min + at)]);
    if (all && all.every(name => typeof name === 'string')) return `${all.map(name => oneLine(name)).join('|')} (${range})`;
    return `${range} (${Object.entries(names).map(([value, name]) => `${value}=${oneLine(name)}`).join(', ')})`;
}
const valuesOf = (schema, names = null) => schema.type === 'enum' ? schema.values.map(value => oneLine(value)).join('|')
    : schema.type === 'int' ? (names ? namedRange(schema, names) : `${schema.min}..${schema.max}`) : schema.type === 'text' ? 'text' : 'true|false';

const onEntries = kind => (kind.effects ?? []).some(effect => effect?.op === 'entrySet' || effect?.op === 'entryDrop');

/**
 * One line of grammar for a kind: "+ dm reputation — reason | kind: gain | faction: guild|watch|compact".
 * `seen` (a Map, optional): a long list of values (the health words) already written on an earlier line is not written again: "to: same words as
 * character set-health" (the narrator may write the same words; only the text is shorter).
 */
export function kindGrammar(definition, name, reference, seen = null) {
    const kind = definition.kinds[name];
    // A line that changes an entry may give any part the line that adds one gives: it says so instead of writing them all again.
    const add = kind.effects?.length === 1 && kind.effects[0].op === 'entrySet' ? `add-${kind.effects[0].path?.[0]}` : null;
    const same = add && definition.kinds[add] && Object.keys(kind.labels).every(label => label === 'at' || definition.kinds[add].labels[label]);
    return `${kind.op} dm ${reference} — reason | kind: ${name}${definition.scope === 'character' ? ' | who: attached actor' : ''}`
        + (same ? ` | at: number or title | [any part of ${add}]` : Object.entries(kind.labels).map(([label, schema]) => {
            // (a line that works a List of entries names the entry it changes by number or title; a part the line may leave out is in brackets)
            if (label === 'at' && onEntries(kind)) return ' | at: number or title';
            const values = valuesOf(schema, schema.type === 'int' ? dmLabelNames(definition, kind, label) : null);
            if (schema.optional === true) return ` | [${label}: ${values}]`;
            const before = seen && values.length >= SAME_WORDS_AT ? seen.get(values) : undefined;
            if (seen && values.length >= SAME_WORDS_AT && before === undefined) seen.set(values, `${reference.split('/').at(-1)} ${name}`);
            return ` | ${label}: ${before === undefined ? values : `same words as ${before}`}`;
        }).join(''));
}
// A list of values at least this long is written once per prompt (the stage words of a health bar are 55 characters, a stat list 29).
const SAME_WORDS_AT = 40;

/** A concrete example line for a kind, using each label's first legal value (Setup shows these). */
export function kindExample(definition, name, reference) {
    const kind = definition.kinds[name];
    const first = schema => schema.type === 'enum' ? schema.values[0] : schema.type === 'int' ? schema.min : schema.type === 'text' ? 'text' : true;
    return `${kind.op} dm ${reference} — why it happens | kind: ${name}${definition.scope === 'character' ? ' | who: Name' : ''}`
        + Object.entries(kind.labels).map(([label, schema]) => ` | ${label}: ${label === 'at' && onEntries(kind) ? 1 : first(schema)}`).join('');
}

// Kinds that come in a numbered family (learn-1 … learn-5, set-slot-1 … set-slot-4) share one template line: the same line, "kind: learn-N", and one
// closing line that says what N is. A family needs three or more kinds numbered 1..k with the same op and labels; anything else is written kind by kind.
// This is the text the narrator reads and nothing else: every kind of the family is still accepted under its own name (data-modules/part.js reads the
// definition, never this text).
const FAMILY = /^(.+)-(\d+)$/u;
function familyLines(definition, names, reference, seen) {
    const rows = names.map(name => {
        const line = kindGrammar(definition, name, reference, null), match = FAMILY.exec(name);
        return { name, line, base: match?.[1] ?? null, n: match ? Number(match[2]) : null };
    });
    // (the template is the line with N for the number, so two kinds join a family only when everything else about them reads the same)
    const templated = row => row.base === null ? null : row.line.replace(`kind: ${row.name}`, `kind: ${row.base}-N`);
    const groups = new Map();
    for (const row of rows) {
        const key = templated(row);
        if (key !== null) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const family = new Map();
    for (const [key, members] of groups) {
        const numbers = members.map(member => member.n).sort((a, b) => a - b);
        if (members.length >= 3 && numbers.every((n, at) => n === at + 1)) family.set(key, members);
    }
    const lines = [], notes = [], done = new Set();
    for (const row of rows) {
        const key = templated(row), members = family.get(key);
        if (!members) { lines.push(seen ? kindGrammar(definition, row.name, reference, seen) : row.line); continue; }
        if (done.has(key)) continue;
        done.add(key);
        // (the first member's line, with its number made N, so the list of values is the one `seen` knows)
        const first = members.find(member => member.n === 1);
        lines.push((seen ? kindGrammar(definition, first.name, reference, seen) : first.line).replace(`kind: ${first.name}`, `kind: ${first.base}-N`));
        notes.push({ base: first.base, last: members.length });
    }
    // One closing line per size: "N = 1..5 for learn-N and practice-N."
    for (const size of [...new Set(notes.map(note => note.last))]) {
        const bases = notes.filter(note => note.last === size).map(note => `${note.base}-N`);
        lines.push(`N = 1..${size} for ${bases.length > 1 ? `${bases.slice(0, -1).join(', ')} and ${bases.at(-1)}` : bases[0]}.`);
    }
    return lines;
}

// A kind that writes a hidden field (`prompt: false`) is the reader's: the narrator is not offered it.
const offeredKinds = definition => Object.keys(definition.kinds).filter(name => !dmKindWritesHidden(definition, definition.kinds[name]));

/**
 * The complete text used to measure the static budget before accepting a definition.
 * `options`: { prompt: false } leaves the module's description out; { only: /re/ } offers only the kinds whose name matches, { without: /re/ } leaves out the kinds whose name matches (the RPG's quiet prompt, lean-rpg/names.js
 * QUIET_GRAMMAR); { seen } is a Map shared by the modules of one prompt (see kindGrammar).
 */
export function fullModuleGrammar(definition, reference, { prompt: withPrompt = true, only = null, without = null, seen = null } = {}) {
    const prompt = withPrompt && definition.prompt ? [...oneLine(definition.prompt)].slice(0, L.prompt).join('') : '';
    const names = offeredKinds(definition).filter(name => (!only || only.test(name)) && !(without && without.test(name)));
    return [prompt, ...familyLines(definition, names, reference, seen)].filter(Boolean).join('\n');
}

/**
 * The lines a module adds to the static part, within its character budget (whole lines only). A list of values written on a line that the budget cuts
 * is not remembered in `seen`: a later module writes the words itself, never "same words as" a line that is not in the prompt.
 */
export function moduleGrammar(definition, reference, options = {}) {
    const lines = [];
    let used = 0;
    const local = options.seen ? new Map(options.seen) : null;
    for (const line of fullModuleGrammar(definition, reference, { ...options, ...(local ? { seen: local } : {}) }).split('\n').filter(Boolean)) {
        const next = used + (lines.length ? 1 : 0) + [...line].length;
        if (next > L.staticCharacters) break;
        lines.push(line);
        used = next;
    }
    if (local) for (const [values, where] of local) if (!options.seen.has(values) && lines.some(line => line.includes(values))) options.seen.set(values, where);
    return lines.join('\n');
}
