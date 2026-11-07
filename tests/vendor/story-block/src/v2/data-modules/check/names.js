// Data-modules checker, names part: dataModuleDefaults, the defaults a checked definition starts from.
// Pure: no state is read. check.js keeps the public path of each export.

import { entries } from './shape.js';

export function dataModuleDefaults(state) {
    return Object.fromEntries(entries(state).map(([key, schema]) => [key, schema.type === 'map'
        ? Object.fromEntries(schema.keys.map(key => [key, schema.values.default])) : schema.type === 'entries' ? [] : schema.default]));
}
