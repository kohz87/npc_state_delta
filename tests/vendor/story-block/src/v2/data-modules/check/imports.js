// Data-modules checker, imports part: the imports a definition declares and the offers it collects from them.
// Pure: no state is read. check.js keeps the public path of each export.

import { array, distinct, named, names, shape } from './shape.js';
import { DM_DESCRIPTORS as D, DM_LIMITS as L, dmId, dmObject, dmOwn, dmSlug } from '../schema.js';

export function imports(definition, path, add) {
    const inputs = {};
    for (const [alias, entry] of named(definition.imports, L.imports, `${path}.imports`, add)) {
        const at = `${path}.imports.${alias}`;
        inputs[alias] = {};
        if (!shape(entry, D.import, at, add)) continue;
        const adapter = dmOwn(D.adapters, entry.query) && D.adapters[entry.query];
        if (!adapter) { add('DM_SCHEMA', `${at}.query`, 'This public query has no reviewed data-modules v1 adapter.'); continue; }
        if (!adapter.modes.includes(entry.mode)) add('DM_SCHEMA', `${at}.mode`, 'Import mode must be prefix or recorded.');
        if (entry.args !== undefined && !dmObject(entry.args)) add('DM_SCHEMA', `${at}.args`, 'Adapter args must be a literal object.');
        for (const key of Object.keys(entry.args ?? {})) if (!adapter.args.includes(key)) add('DM_SCHEMA', `${at}.args.${key}`, 'Unsupported adapter argument.');
        if (!Array.isArray(entry.projection) || !entry.projection.length || new Set(entry.projection).size !== entry.projection.length || entry.projection.some(field => typeof field !== 'string')) add('DM_SCHEMA', `${at}.projection`, 'Projection must contain distinct advertised public field names.');
        if (adapter.projection) for (const field of array(entry.projection)) if (!adapter.projection.includes(field)) add('DM_SCHEMA', `${at}.projection`, `Only ${adapter.projection.join(', ')} may be projected from ${entry.query}.`);
        if (entry.query === 'director.time' && array(entry.projection).includes('minutes')) inputs[alias].minutes = { type: 'int', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
        if (entry.query === 'dataModules.public') {
            if (!dmId(entry.args?.module) || !dmSlug(entry.args?.export)) add('DM_SCHEMA', `${at}.args`, 'A data import requires a full module ID and a named export.');
            if (entry.args?.who !== undefined && (typeof entry.args.who !== 'string' || !/^ca_[A-Za-z0-9_-]+$/.test(entry.args.who))) add('DM_SCHEMA', `${at}.args.who`, 'A character import requires an explicit canonical SD ca_ actor ID.');
        }
    }
    return inputs;
}

export function collectOffers(value, keys = new Set()) {
    if (!value || typeof value !== 'object') return keys;
    if (value.op === 'offer' && dmSlug(value.key)) keys.add(value.key);
    for (const child of Object.values(value)) collectOffers(child, keys);
    return keys;
}
