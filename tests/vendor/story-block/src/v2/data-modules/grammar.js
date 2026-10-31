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

/** One line of grammar for a kind: "+ dm reputation — reason | kind: gain | faction: guild|watch|compact". */
export function kindGrammar(definition, name, reference) {
    const kind = definition.kinds[name];
    return `${kind.op} dm ${reference} — reason | kind: ${name}${definition.scope === 'character' ? ' | who: attached actor' : ''}`
        + Object.entries(kind.labels).map(([label, schema]) => ` | ${label}: ${valuesOf(schema, schema.type === 'int' ? dmLabelNames(definition, kind, label) : null)}`).join('');
}

/** A concrete example line for a kind, using each label's first legal value (Setup shows these). */
export function kindExample(definition, name, reference) {
    const kind = definition.kinds[name];
    const first = schema => schema.type === 'enum' ? schema.values[0] : schema.type === 'int' ? schema.min : schema.type === 'text' ? 'text' : true;
    return `${kind.op} dm ${reference} — why it happens | kind: ${name}${definition.scope === 'character' ? ' | who: Name' : ''}`
        + Object.entries(kind.labels).map(([label, schema]) => ` | ${label}: ${first(schema)}`).join('');
}

/** The complete text used to measure the static budget before accepting a definition. */
export function fullModuleGrammar(definition, reference) {
    const prompt = definition.prompt ? [...oneLine(definition.prompt)].slice(0, L.prompt).join('') : '';
    // A kind that writes a hidden field (`prompt: false`) is the reader's: the narrator is not offered it.
    const offered = Object.keys(definition.kinds).filter(name => !dmKindWritesHidden(definition, definition.kinds[name]));
    return [prompt, ...offered.map(name => kindGrammar(definition, name, reference))].filter(Boolean).join('\n');
}

/** The lines a module adds to the static part, within its character budget (whole lines only). */
export function moduleGrammar(definition, reference) {
    const lines = [];
    let used = 0;
    for (const line of fullModuleGrammar(definition, reference).split('\n').filter(Boolean)) {
        const next = used + (lines.length ? 1 : 0) + [...line].length;
        if (next > L.staticCharacters) break;
        lines.push(line);
        used = next;
    }
    return lines.join('\n');
}
