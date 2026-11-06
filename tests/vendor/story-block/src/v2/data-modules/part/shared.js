// Shared state access, caches and checked-definition helpers for data modules (moved out of
// data-modules/part.js unchanged): pin/instance paths, budgets, and the checked target.
import { validateDataModules, dataModuleDefaults, dataModuleHash } from '../check.js';
import { bytes, refuse } from '../interpreter.js';
import { activeDefinition } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { STRINGS } from '../../strings.js';
import { rpgLib } from '../../rpg-lazy.js';

const E = STRINGS.editMessages;
const B = STRINGS.blocks;
// The RPG library's pieces, at the time they are used: a step that needs them while the library is not there is refused (the loader brings it in first).
const rpg = () => rpgLib() ?? refuse('FAILED', '', 'The RPG is still loading. Try again in a moment.');
const J = new Proxy({}, { get: (_target, key) => rpg().RPG_STRINGS.join[key] });
// The most fields one multi-field `dm.set` takes (a sheet's seven stats and its points fit with room to spare).
const SET_FIELDS = 16;

const initial = () => ({ pins: {}, active: {}, instances: {}, perReply: {} });
// A frozen value (a branch of the state) never changes, so what is worked out from it is kept with it. No game state is cached:
// the keys are the values themselves and the answers are functions of them alone (the interpreter caches nothing else).
const hashes = new WeakMap(), sizes = new WeakMap();
const kept = (cache, value, compute) => {
    if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return compute(value);
    if (!cache.has(value)) cache.set(value, compute(value));
    return cache.get(value);
};
const hashOf = definition => kept(hashes, definition, dataModuleHash);
const sizeOf = value => kept(sizes, value, bytes);
// The transaction's own copy of the domain (the bus made it), with the four tables a domain always has.
const draftOf = ctx => { const draft = ctx.draft('dataModules'); for (const [key, value] of Object.entries(initial())) draft[key] ??= value; return draft; };
const stateOf = ctx => ({ domains: { dataModules: ctx.read('dataModules'), director: ctx.read('director'), checks: ctx.read('checks'), rules: ctx.read('rules') } });
const pairKey = source => `${source.sid}/${source.swipeKey}`;
const subjectsOf = (state, id) => state.domains.dataModules?.active?.[id]?.subjects ?? [];
const activeCount = domain => Object.keys(domain?.active ?? {}).length;
const blockCount = domain => Object.values(domain?.active ?? {})
    .filter(active => domain?.pins?.[active.hash]?.packId === 'chat').length;
const instancePath = (id, subject) => ['instances', id, ...(subject === 'chat' ? ['chat'] : ['characters', subject])];
const rawDefinition = definition => Object.fromEntries(Object.entries(definition).filter(([key]) => !['id', 'pack'].includes(key)));
// Clock/actor identities and inputs used for eligibility are live prerequisites even when the
// author requested a recorded snapshot. Other recorded values can still be frozen effect inputs.
const prefixImports = definition => {
    // An imported value can reach a condition through writes or reward bindings. Conservatively
    // witness public values whenever the module has eligibility expressions, including that case.
    const eligibility = [...Object.values(definition.kinds), ...definition.rules, ...Object.values(definition.rewards)]
        .some(entry => entry.when !== undefined && typeof entry.when !== 'boolean');
    return Object.keys(definition.imports).filter(alias => {
        const entry = definition.imports[alias];
        return entry.mode === 'prefix' || ['director.time', 'checks.policy'].includes(entry.query) || eligibility;
    });
};

function checkedTarget(definition, state) {
    const catalog = Object.keys(state.domains.dataModules?.active ?? {}).map(id => activeDefinition(state, id)).filter(Boolean);
    const result = validateDataModules([rawDefinition(definition)], { packId: definition.pack,
        capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
    if (!result.ok) refuse(result.errors[0].code, result.errors[0].path, result.errors[0].message);
    if (hashJson(result.definitions[0]) !== hashJson(definition)) refuse('DM_SCHEMA', '', 'Definition is not checked normalized data.');
    return result.definitions[0];
}

function newInstance(definition, inputs) {
    return { fields: dataModuleDefaults(definition.state), timers: Object.fromEntries(definition.timers.map(timer => [timer.id,
        { lastMinute: inputs[timer.clock]?.minutes ?? null, remainder: 0 }])), offers: {}, settled: {} };
}

export { E, B, rpg, J, SET_FIELDS, initial, kept, hashOf, sizeOf, draftOf, stateOf, pairKey, subjectsOf,
    activeCount, blockCount, instancePath, rawDefinition, prefixImports, checkedTarget, newInstance };
