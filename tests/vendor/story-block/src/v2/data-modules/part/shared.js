// Shared state access, caches and checked-definition helpers for data modules (moved out of
// data-modules/part.js unchanged): pin/instance paths, budgets, and the checked target.
import { validateDataModules, dataModuleDefaults, dataModuleHash } from '../check.js';
import { bytes, refuse } from '../interpreter.js';
import { activeDefinition, instanceOf } from '../adapters.js';
import { oneLine } from '../../../text.js';
import { hashJson } from '../../replay.js';
import { STRINGS, fill } from '../../strings.js';
import { rpgLib } from '../../rpg-lazy.js';
import { DM_OLD_ROOM, dmRoom } from '../schema.js';
import { PARTY_ACTIVE, PARTY_MAX } from '../../lean-rpg/names.js';

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
// Every way a Character joins or comes back (a story `+ party` / `- party` line, the reader's Add to party, the wizard's and the template's Character) records the
// party it relied on and keeps the active limit (4, or 8 on a reply with only the `partyRoom` mark): `partyWitness` says a guard records it (a story reply from before the `partyRoom` mark does not), `partyFull` refuses live.
// The value is what the guard records as `selector.party`: PARTY_ACTIVE (a story reply with the `partyFour` mark) when the 4-active limit is in force,
// `true` for a reply with only the `partyRoom` mark (8 active), PARTY_ACTIVE for the reader's own actions (they follow the current rule), false for an older reply.
const partyWitness = ctx => (ctx.cause === 'ui' ? PARTY_ACTIVE : ctx.carrier?.rules?.includes('partyFour') ? PARTY_ACTIVE : ctx.cause === 'story' && dmRoom(ctx) !== DM_OLD_ROOM);
// The active limit that witness stands for (a story reply from before `partyRoom` has none: the old count in checkJoin).
const partyLimit = witness => (witness === PARTY_ACTIVE ? PARTY_ACTIVE : PARTY_MAX);
// (the party is read from this domain's own blocks, never from the lazy RPG library: a chat with the RPG off must replay the same witness; it is lean-rpg/join.js partyOf's
// [module, left] pairs, a chat-scope Character with a name)
const partyPairs = state => {
    const out = [], active = state?.domains?.dataModules?.active;
    for (const module of Object.keys(active !== null && typeof active === 'object' ? active : {})) {
        const definition = activeDefinition(state, module);
        if (definition?.role !== 'character' || definition.scope !== 'chat') continue;
        const fields = instanceOf(state, module)?.fields;
        if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) continue;
        if (oneLine(fields.who) || oneLine(definition.name)) out.push([module, fields.left === true]);
    }
    return out;
};
// The only thing a join, creation or return relied on from the party: was there room (fewer than the limit in force active) before it. Replay witnesses just this boolean,
// so removing an unrelated earlier member below the cap leaves later members as they were.
const partyRoomOf = (state, limit = PARTY_MAX) => partyPairs(state).filter(pair => !pair[1]).length < limit;
const partyFull = (ctx, prefix) => {
    if (ctx.cause === 'ui' && !partyRoomOf(prefix, PARTY_ACTIVE)) refuse('REFUSED', '', fill(B.partyFull, { max: PARTY_ACTIVE }));
};
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
    activeCount, blockCount, partyWitness, partyLimit, partyPairs, partyRoomOf, partyFull, instancePath, rawDefinition, prefixImports, checkedTarget, newInstance };
