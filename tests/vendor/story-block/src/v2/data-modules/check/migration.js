// Data-modules checker, migration part: the migrations a definition declares, and validateDataMigration, which compares
// two checked definitions. Pure: no state is read. check.js keeps the public path of each export.

import { array, copy, entries, named, same, scalar, shape, sized } from './shape.js';
import { DM_DESCRIPTORS as D, DM_LIMITS as L, dmInt, dmObject, dmOwn } from '../schema.js';

export function migrations(definition, path, add) {
    if (!sized(definition.migrations, L.migrations, `${path}.migrations`, add, { list: true })) return;
    const seen = new Set();
    const fields = new Set();
    definition.migrations.forEach((step, i) => {
        const at = `${path}.migrations[${i}]`;
        if (!shape(step, D.migration, at, add)) return;
        if (!dmInt(step.from, 1, Number.MAX_SAFE_INTEGER - 1) || step.to !== step.from + 1 || step.to > definition.stateVersion) add('DM_SCHEMA', at, 'Migrations must move forward one adjacent stateVersion, up to this definition version.');
        if (seen.has(step.from) || (i && definition.migrations[i - 1]?.to !== step.from)) add('DM_SCHEMA', at, 'Migrations must form one ordered chain without cycles or branches.');
        seen.add(step.from);
        for (const [field, schema] of named(step.add, L.fields, `${at}.add`, add, { min: 0 })) {
            scalar(schema, `${at}.add.${field}`, add);
            if (fields.has(field) || !dmOwn(definition.state, field) || !same(definition.state[field], schema)) add('DM_SCHEMA', `${at}.add.${field}`, 'A migration adds a field once, with exactly its current schema and default.');
            fields.add(field);
        }
    });
    if (definition.migrations.length && definition.migrations.at(-1)?.to !== definition.stateVersion) add('DM_SCHEMA', `${path}.migrations`, 'The migration chain must end at this stateVersion.');
}

/** Compare two CHECKED definitions. New fields/defaults are the only mechanical changes. */
export function validateDataMigration(oldDefinition, target) {
    const errors = [];
    const add = (path, message) => { if (errors.length < L.errors) errors.push({ code: 'DM_SCHEMA', path, message }); };
    if (!dmObject(oldDefinition) || !dmObject(target)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: '', message: 'Migration requires two checked definitions.' }] };
    if (oldDefinition.id !== target.id || !dmInt(oldDefinition.stateVersion, 1) || !dmInt(target.stateVersion, oldDefinition.stateVersion + 1)) add('stateVersion', 'Migration must advance the same module to a higher stateVersion; downgrade refuses.');
    const mutable = new Set(['state', 'stateVersion', 'migrations', 'name', 'screens', 'layouts']);
    for (const key of new Set([...Object.keys(oldDefinition), ...Object.keys(target)])) if (!mutable.has(key) && !same(oldDefinition[key], target[key])) add(key, 'Existing mechanics must retain identical semantics; this change needs a new timeline.');
    for (const [field, schema] of entries(oldDefinition.state)) if (!dmOwn(target.state, field) || !same(schema, target.state[field])) add(`state.${field}`, 'Old fields cannot be removed, retyped, reset or have changed bounds/defaults.');
    let version = oldDefinition.stateVersion;
    const additions = {};
    for (const step of array(target.migrations)) {
        if (step.from !== version) continue;
        version = step.to;
        for (const [field, schema] of entries(step.add)) {
            if (dmOwn(oldDefinition.state, field) || dmOwn(additions, field)) add(`migrations.${field}`, 'A migration may add only new fields once.');
            additions[field] = schema;
        }
    }
    const expected = Object.fromEntries(entries(target.state).filter(([key]) => !dmOwn(oldDefinition.state, key)));
    if (version !== target.stateVersion || !same(expected, additions)) add('migrations', 'An adjacent additive migration chain must account for every new field and default.');
    return errors.length ? { ok: false, errors } : { ok: true, add: copy(additions) };
}
