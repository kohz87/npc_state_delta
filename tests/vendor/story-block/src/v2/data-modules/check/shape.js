// Data-modules checker, shape part: the message table `E`, the small validators every section uses (copy, stable,
// shape, sized, named, distinct, normalized keys, scalar, entries) and the display names of an int field. Pure: no state is read.

import { oneLine } from '../../../text.js';
import { DM_BLOCK_BARS, DM_DESCRIPTORS as D, DM_LIMITS as L, dmInt, dmObject, dmOwn, dmSlug } from '../schema.js';
import { STRINGS, fill } from '../../strings.js';

export const E = STRINGS.editMessages;

export const copy = value => JSON.parse(JSON.stringify(value));
export const entries = value => dmObject(value) ? Object.entries(value) : [];
export const array = value => Array.isArray(value) ? value : [];
export const stable = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(stable)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
export const defId = (packId, slug) => `pack.${packId}/${typeof slug === 'string' ? slug : 'invalid'}`;

export function shape(value, descriptor, path, add, code = 'DM_SCHEMA') {
    if (!dmObject(value)) { add(code, path, 'Expected an object with the declared fields.'); return false; }
    const required = Array.isArray(descriptor) ? descriptor : descriptor.required;
    const allowed = [...required, ...(descriptor.optional ?? [])];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(code, `${path}.${key}`, `Unknown field "${key}"; expected ${allowed.join(', ')}.`);
    for (const key of required) if (!Object.hasOwn(value, key)) add(code, `${path}.${key}`, `Missing required field "${key}".`);
    return true;
}
export function sized(value, max, path, add, { min = 0, list = false } = {}) {
    if (!(list ? Array.isArray(value) : dmObject(value))) {
        add('DM_SCHEMA', path, list ? 'Expected a list.' : 'Expected a named object.');
        return false;
    }
    const length = list ? value.length : Object.keys(value).length;
    if (length < min) add('DM_SCHEMA', path, `Expected at least ${min} entries.`);
    if (length > max) add('DM_BUDGET', path, `Version 1 permits at most ${max} entries here.`);
    return true;
}
export function named(value, max, path, add, { label = false, min = 0 } = {}) {
    if (!sized(value, max, path, add, { min })) return [];
    for (const key of Object.keys(value)) {
        if (!dmSlug(key) || (label && !/^[a-z]+$/.test(key))) add(label ? 'DM_LABEL' : 'DM_SCHEMA', `${path}.${key}`, label
            ? 'Labels are one lowercase word of at most 40 characters.' : 'Names are safe lowercase slugs of at most 40 characters.');
    }
    return Object.entries(value);
}
export function distinct(values, path, add, { max = L.enumValues, keys = false } = {}) {
    if (!Array.isArray(values) || !values.length || values.length > max || values.some(value => keys ? !dmSlug(value)
        : !(value === null || typeof value === 'string' || typeof value === 'boolean' || dmInt(value)))) {
        add('DM_SCHEMA', path, `Expected 1 to ${max} distinct ${keys ? 'safe key slugs' : 'JSON scalar literals'}.`);
        return false;
    }
    if (new Set(values.map(value => JSON.stringify(typeof value === 'string' ? value.normalize('NFKC') : value))).size !== values.length) add('DM_SCHEMA', path, 'Values must be distinct after Unicode normalization.');
    return true;
}
export function normalizedKeys(value, path, add) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
        const seen = new Set();
        for (const key of Object.keys(value)) {
            const folded = key.normalize('NFKC');
            if (seen.has(folded)) add('DM_SCHEMA', `${path}.${key}`, 'Object keys collide after Unicode normalization.');
            seen.add(folded);
        }
    }
    for (const [key, child] of Object.entries(value)) normalizedKeys(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, add);
}

export function scalar(schema, path, add, { label = false, map = true } = {}) {
    const schemas = label ? D.labels : D.fields;
    const descriptor = dmOwn(schemas, schema?.type) && schemas[schema.type];
    if (!descriptor || (!map && (schema.type === 'map' || schema.type === 'entries'))) { add(label ? 'DM_LABEL' : 'DM_SCHEMA', path, fill(E.declaredSchema, { schema: label ? E.labelSchema : E.fieldSchema })); return; }
    if (!shape(schema, descriptor, path, add, label ? 'DM_LABEL' : 'DM_SCHEMA')) return;
    if (schema.optional !== undefined && (!label || typeof schema.optional !== 'boolean')) add('DM_SCHEMA', `${path}.optional`, STRINGS.blocks.entryLabel);
    if (!label && schema.edit !== undefined && typeof schema.edit !== 'boolean') add('DM_SCHEMA', `${path}.edit`, E.editBoolean);
    if (!label && schema.label !== undefined) {
        if (typeof schema.label !== 'string' || !oneLine(schema.label) || [...schema.label].length > 60) add('DM_SCHEMA', `${path}.label`, STRINGS.blocks.labelLimit);
        else schema.label = oneLine(schema.label);
    }
    // `prompt: false` hides a field from the story's tail and grammar; `names` gives a number's values display names (a kind's int label may
    // carry its own, for a value its effect works out). Neither belongs on the value type of a map; `prompt` is not for a label.
    // `blocks` marks an int field as one of the Standard formula's bars: its value counts the blocks left, the bar's size comes from the stats.
    if (!label && schema.prompt !== undefined && (typeof schema.prompt !== 'boolean' || !map)) add('DM_SCHEMA', `${path}.prompt`, STRINGS.blocks.hiddenFlag);
    if (schema.names !== undefined && !map) add('DM_SCHEMA', `${path}.names`, STRINGS.blocks.namesKey);
    if (schema.blocks !== undefined && (label || !map || schema.type !== 'int' || !DM_BLOCK_BARS.includes(schema.blocks))) add('DM_SCHEMA', `${path}.blocks`, STRINGS.blocks.blocksKey);
    if (schema.type === 'int') {
        if (!dmInt(schema.min) || !dmInt(schema.max) || schema.min > schema.max) add('DM_BOUNDS', path, 'Integer bounds must be ordered safe integers.');
        if (!label && !dmInt(schema.default, schema.min, schema.max)) add('DM_BOUNDS', `${path}.default`, 'The integer default must be inside its inclusive bounds.');
        if (schema.names !== undefined && map) names(schema, path, add);
    }
    if (schema.type === 'bool' && !label && typeof schema.default !== 'boolean') add('DM_SCHEMA', `${path}.default`, 'A bool default must be a boolean.');
    if (schema.type === 'enum') {
        distinct(schema.values, `${path}.values`, add);
        if (!label && !array(schema.values).includes(schema.default)) add('DM_BOUNDS', `${path}.default`, 'The enum default must be one of its literal values.');
    }
    if (schema.type === 'text') {
        if (!dmInt(schema.max, 1, L.text)) add('DM_BOUNDS', `${path}.max`, `Text max must be 1 to ${L.text}.`);
        if (!label && schema.list !== undefined && typeof schema.list !== 'boolean') add('DM_SCHEMA', `${path}.list`, STRINGS.blocks.listOnlyText);
        if (!label && (typeof schema.default !== 'string' || !dmInt(schema.max, 1, L.text) || [...schema.default].length > schema.max
            || (schema.list === true && schema.default && schema.default.split(';').length > 12))) add('DM_BOUNDS', `${path}.default`, 'Text defaults must be literal text within max.');
    }
    if (schema.type === 'map') {
        distinct(schema.keys, `${path}.keys`, add, { max: L.mapKeys, keys: true });
        scalar(schema.values, `${path}.values`, add, { map: false });
    }
    if (schema.type === 'entries') entriesField(schema, path, add);
}

// A List of entries: at most `max` entries, each holding the small set of sub-fields in `of` (text, number or choice). A sub-field's name is one lowercase word,
// because it is also the label a story line writes it under ("| status: done"); `at`, `kind` and `who` belong to the line itself.
function entriesField(schema, path, add) {
    if (schema.max !== undefined && !dmInt(schema.max, 1, L.entriesMax)) add('DM_BOUNDS', `${path}.max`, fill(STRINGS.blocks.entriesMax, { max: L.entriesMax }));
    if (!sized(schema.of, L.entrySubs, `${path}.of`, add, { min: 1 })) return;
    for (const [key, sub] of Object.entries(schema.of)) {
        const at = `${path}.of.${key}`;
        if (!/^[a-z]{1,20}$/.test(key) || ['at', 'kind', 'who'].includes(key)) add('DM_SCHEMA', at, STRINGS.blocks.entrySubName);
        if (!dmObject(sub) || !['text', 'int', 'enum'].includes(sub.type)) { add('DM_SCHEMA', at, STRINGS.blocks.entrySubType); continue; }
        if (sub.edit !== undefined || sub.list !== undefined) add('DM_SCHEMA', at, STRINGS.blocks.entrySubType);
        scalar(sub, at, add, { map: false });
    }
}

const foldedName = text => String(text).normalize('NFKC').toLowerCase();
// Display names for an int field: { "<value>": "<name>" }, whole values inside min..max, short distinct names that are not numbers.
export function names(schema, path, add) {
    const given = schema.names;
    if (!dmObject(given) || !Object.keys(given).length || Object.keys(given).length > L.names) { add('DM_BOUNDS', `${path}.names`, STRINGS.blocks.namesLimit); return; }
    const seen = new Set();
    for (const [key, name] of Object.entries(given)) {
        const at = `${path}.names.${key}`;
        if (!/^-?\d+$/.test(key) || String(Number(key)) !== key || !dmInt(Number(key), schema.min, schema.max)) add('DM_BOUNDS', at, STRINGS.blocks.namesKey);
        const text = typeof name === 'string' ? oneLine(name) : '';
        if (!text || [...text].length > L.nameText || /^-?\d+$/.test(text)) { add('DM_SCHEMA', at, STRINGS.blocks.namesText); continue; }
        given[key] = text;
        if (seen.has(foldedName(text))) add('DM_SCHEMA', at, STRINGS.blocks.namesSame);
        seen.add(foldedName(text));
    }
}
