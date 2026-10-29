// Reviewed, state-only projections of SD's public contracts. In particular, never call
// director.time's settings-dependent formatter or read roll policy/bonuses from checks.policy.
import { copy, atPath, refuse } from './interpreter.js';
import { dmOwn } from './schema.js';

export const actorsOf = state => Object.fromEntries(Object.entries(state?.domains?.checks?.policy?.actors ?? {})
    .filter(([id, actor]) => /^ca_[a-z0-9]{8}$/.test(id) && actor.id === id && typeof actor.name === 'string')
    .sort(([a], [b]) => a.localeCompare(b)).map(([id, actor]) => [id, { id, name: actor.name }]));

export function activeDefinition(state, module) {
    const domain = state?.domains?.dataModules, active = domain?.active?.[module];
    const pin = active && domain.pins?.[active.hash];
    return pin?.interpreter === 1 && pin.definition?.schema === 1 ? pin.definition : null;
}
export const instanceOf = (state, module, who = 'chat') => who === 'chat'
    ? state?.domains?.dataModules?.instances?.[module]?.chat
    : state?.domains?.dataModules?.instances?.[module]?.characters?.[who];

export function publicView(state, { module, export: name, who } = {}) {
    const definition = activeDefinition(state, module), fields = definition?.exports?.[name]?.fields;
    const active = state?.domains?.dataModules?.active?.[module];
    if (!fields || (definition.scope === 'character' && !active.subjects.includes(who))) return null;
    const instance = instanceOf(state, module, definition.scope === 'chat' ? 'chat' : who);
    if (!instance) return null;
    return Object.fromEntries(fields.map(key => [key, copy(instance.fields[key])]));
}

export function projectImport(state, entry) {
    let value;
    if (entry.query === 'director.time') value = { minutes: state?.domains?.director?.time?.minutes ?? null };
    else if (entry.query === 'checks.policy') value = { actors: actorsOf(state) };
    else if (entry.query === 'dataModules.public') value = publicView(state, entry.args);
    else refuse('DM_SCHEMA', entry.query, 'Unsupported public adapter.');
    if (value === null) return null;
    // Actor selectors denote projection over the public actor map, not numeric array paths.
    if (entry.query === 'checks.policy') return { actors: Object.fromEntries(Object.entries(value.actors)
        .map(([id, actor]) => [id, Object.fromEntries(entry.projection.map(key => key.split('.')[1]).map(key => [key, actor[key]]))])) };
    return Object.fromEntries(entry.projection.map(path => [path, copy(atPath(value, path.split('.')))]));
}

export function resolveActor(state, value, attached = null) {
    const actors = actorsOf(state), ids = attached ?? Object.keys(actors);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('ac_')) refuse('DM_LABEL', 'who', 'who must name a Story Director actor (a name or a ca_ ID), not a party character ID');
    const wanted = value.normalize('NFKC').trim().toLowerCase();
    const matches = ids.filter(id => dmOwn(actors, id) && (id === value.trim() || actors[id].name.normalize('NFKC').toLowerCase() === wanted));
    if (matches.length > 1) refuse('DM_LABEL', 'who', `who is ambiguous: ${matches.map(id => `${actors[id].name} (${id})`).join(' and ')} both fit; use the ca_ ID`);
    if (matches.length !== 1) {
        const here = ids.filter(id => dmOwn(actors, id)).map(id => actors[id].name);
        refuse('DM_LABEL', 'who', `who must be ${attached ? 'an attached character' : 'an actor of Story Director'}${here.length ? ` (${here.join(', ')})` : ''}`);
    }
    return matches[0];
}

export function inputsOf(state, definition) {
    return Object.fromEntries(Object.entries(definition.imports).map(([alias, entry]) => [alias, projectImport(state, entry)]));
}
