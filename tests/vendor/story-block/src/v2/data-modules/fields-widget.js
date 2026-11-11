// The layout node a data module's screen uses to show its own fields the way a block shows them (screens/block-layouts.js draws it):
// `{ type: "story-block.fields", props: { module, field | fields, as?, title?, names?, labels?, units?, tones? } }`.
//   as "map" (the default for a map field): a map of numbers, a header, a row with a value and a bar for each key, the unset ones folded away;
//   as "record": a small card of label/value lines. `field` is a map field; `fields` lists whole-number fields (a map) or any fields (a record).
//   names: { key: "Shown name" } for a map's keys; labels: { field: "Label" } for a record's lines; units: { field: "copper" } after a value;
//   tones: { field: { value: "good" | "warn" | "bad" | "accent" | "neutral" } } for a choice drawn as a chip.
//   tiles: true (a record only): the lines as small tiles in one row, no pencils; a choice is a plain word (amber for a "warn" tone), a short code a round badge.
// The stub below lets the checker and editableLayout accept the node; the real widget is registered by the host.
import { dmObject, dmOwn } from './schema.js';

export const FIELDS_WIDGET = 'story-block.fields';
export const HEADING_WIDGET = 'story-block.heading';
export const FIELDS_PROPS = Object.freeze(['module', 'field', 'fields', 'as', 'title', 'names', 'labels', 'units', 'tones', 'tiles']);
export const BLOCK_NODE_WIDGETS = Object.freeze({
    [FIELDS_WIDGET]: Object.freeze({ props: {}, primary: null, validate: () => [], render: () => ({ destroy() {} }) }),
    [HEADING_WIDGET]: Object.freeze({ props: {}, primary: null, validate: () => [], render: () => ({ destroy() {} }) }),
});

/** What a fields node says that cannot hold for this module: [{ at, message }] (none when it is fine). */
export function fieldsNodeProblems(definition, props) {
    const out = [], bad = (at, message) => out.push({ at, message });
    if (!dmObject(props)) { bad('', 'story-block.fields needs props.'); return out; }
    for (const key of Object.keys(props)) if (!FIELDS_PROPS.includes(key)) bad(`.${key}`, `story-block.fields has no prop "${key}" (expected ${FIELDS_PROPS.join(', ')}).`);
    if (props.module !== definition.id) bad('.module', 'story-block.fields may show only its own module.');
    const names = Array.isArray(props.fields) ? props.fields : props.field !== undefined ? [props.field] : [];
    if (!names.length || names.length > 32 || names.some(name => typeof name !== 'string' || !dmOwn(definition.state, name))) bad('.field', 'Name a field of this module (field) or a list of them (fields).');
    else {
        const first = definition.state[names[0]];
        if (props.field !== undefined && props.fields !== undefined) bad('.fields', 'Give field or fields, not both.');
        if (props.as !== undefined && !['map', 'record'].includes(props.as)) bad('.as', 'as is "map" or "record".');
        const map = props.as === 'map' || (props.as === undefined && (first.type === 'map' || false));
        if (map && (first.type === 'map' ? first.values.type !== 'int' || names.length !== 1 : names.some(name => definition.state[name].type !== 'int'))) bad('.field', 'A map of numbers is a map field of whole numbers, or a list of whole-number fields.');
    }
    for (const key of ['names', 'labels', 'units', 'tones']) if (props[key] !== undefined && !dmObject(props[key])) bad(`.${key}`, `${key} must be an object.`);
    if (props.tiles !== undefined && (typeof props.tiles !== 'boolean' || props.as !== 'record')) bad('.tiles', 'tiles is true or false and goes with as "record".');
    if (props.title !== undefined && (typeof props.title !== 'string' || [...props.title].length > 60)) bad('.title', 'title must be text of at most 60 characters.');
    return out;
}
