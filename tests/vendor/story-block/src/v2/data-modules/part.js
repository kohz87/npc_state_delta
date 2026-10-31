// Trusted host glue for checked data, merged into story-block. Library discovery is read-only;
// every game-state write is a bus transaction, using detached pins and prefix witnesses.
import { DM_LIMITS as L, dmOwn, dmObject, dmHidden, dmKindWritesHidden, dmNameOf } from './schema.js';
import { validateDataModules, validateDataMigration, dataModuleDefaults, dataModuleHash, dataModulesPackHash } from './check.js';
import { copy, bytes, refuse, DataModuleError, createEvaluation, parseLabels, atPath, scalarHolds, cleanList, orList, conditionHolds } from './interpreter.js';
import { activeDefinition, actorsOf, inputsOf, instanceOf, publicView, projectImport, resolveActor } from './adapters.js';
import { hashJson } from '../replay.js';
import { diff } from '../ops.js';
import { moduleGrammar, referenceOf } from './grammar.js';
import { cutAt, oneLine } from '../../text.js';
import { editableLayout } from './editable-layout.js';
import { STRINGS, fill } from '../strings.js';
import { blockTabScreen } from './block-screen.js';
import { roleTail } from '../lean-rpg/tail.js';
import { LEAN_RPG_FEATURE } from '../lean-rpg/names.js';
import { checkJoin, joinDefinitions, joinGrammar, joinMode, partyOf, readJoin, soulNaming } from '../lean-rpg/join.js';
import { RPG_EXTRAS, extraDefinitions, extraName, extrasPlan } from '../lean-rpg/view/wizard-data.js';
import { fold } from '../lean-rpg/read.js';
import { CLASS_NAMES } from '../lean-rpg/names.js';
import { RPG_STRINGS } from '../lean-rpg/strings.js';

const E = STRINGS.editMessages;
const B = STRINGS.blocks;
const J = RPG_STRINGS.join;
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

export function validateDomain(domain) {
    if (!dmObject(domain) || Object.keys(domain).some(key => !['pins', 'active', 'instances', 'perReply'].includes(key))
        || ['pins', 'active', 'instances', 'perReply'].some(key => !dmObject(domain[key]))) return ['Invalid dataModules domain.'];
    const errors = [];
    if (Object.keys(domain.pins).length > L.pins || sizeOf(domain.pins) > L.pinsBytes) errors.push('Retained pins exceed budget.');
    for (const [module, active] of Object.entries(domain.active)) {
        const definition = domain.pins[active.hash]?.definition;
        if (!definition || definition.id !== module || hashOf(definition) !== active.hash || !Number.isSafeInteger(active.generation)
            || active.generation < 1 || !Array.isArray(active.subjects) || active.subjects.length > L.subjects || new Set(active.subjects).size !== active.subjects.length) {
            errors.push('Invalid active data module.'); continue;
        }
        const prefix = { domains: { dataModules: domain } };
        for (const subject of active.subjects) {
            const instance = instanceOf(prefix, module, subject);
            if (!instance || sizeOf(instance) > L.instanceBytes || Object.keys(instance.fields).length !== Object.keys(definition.state).length
                || Object.entries(definition.state).some(([key, schema]) => !scalarHolds(schema, instance.fields[key]))
                || Object.keys(instance.offers).length + Object.keys(instance.settled).length > L.offers) errors.push('Invalid data module instance.');
        }
    }
    return errors;
}

export function resolveModule(state, reference) {
    const ids = Object.keys(state?.domains?.dataModules?.active ?? {});
    if (ids.includes(reference)) return reference;
    // (slugs are lowercase; the narrator's capital letter is the only thing forgiven)
    reference = String(reference ?? '').trim().toLowerCase();
    if (ids.includes(reference)) return reference;
    const matches = ids.filter(id => id.split('/')[1] === reference);
    if (matches.length !== 1) refuse('DM_SCHEMA', 'module', matches.length ? `Ambiguous module ${reference}: ${matches.join(', ')}.` : `No active pin for ${reference}.`);
    return matches[0];
}

export function moduleView(state, { module } = {}) {
    const definition = activeDefinition(state, module);
    if (!definition) return null;
    if (definition.scope === 'chat') return { chat: copy(instanceOf(state, module)?.fields ?? {}) };
    const actors = actorsOf(state);
    return { characters: subjectsOf(state, module).map(id => ({ id, name: actors[id]?.name ?? id, ...copy(instanceOf(state, module, id)?.fields ?? {}) })) };
}

// `noTab`: block roles whose block gets no tab of its own (the RPG's Party tab draws them while its feature is on).
export function pinnedPresentation(state, kind = 'screens', noTab = []) {
    return Object.keys(state?.domains?.dataModules?.active ?? {}).flatMap(id => {
        const definition = activeDefinition(state, id);
        const screens = (definition?.[kind] ?? []).map(entry => {
            const screen = copy(entry);
            if (kind === 'screens' && screen.layout) screen.layout = editableLayout(screen.layout, definition);
            return { ...screen, pack: `dm:${id}` };
        });
        if (kind === 'screens') for (const { id: layoutId, title, icon, ...layout } of definition?.layouts ?? []) {
            if (!screens.some(screen => screen.id === layoutId)) screens.push({ id: layoutId, title, ...(icon ? { icon } : {}), mounts: ['tab'], layout: editableLayout(copy(layout), definition), pack: `dm:${id}` });
        }
        if (kind === 'screens') {
            const block = noTab.includes(definition?.role) ? null : blockTabScreen(definition);
            if (block) screens.push(block);
        }
        return screens;
    });
}

/** The static lines for the pinned modules (empty without a pin); they change only when a pin does. */
export function grammarFor(state) {
    const active = Object.keys(state?.domains?.dataModules?.active ?? {});
    const lines = active.map(id => {
        const definition = activeDefinition(state, id);
        return definition ? moduleGrammar(definition, referenceOf(active, id)) : '';
    }).filter(Boolean);
    return lines.length ? `Data modules in this story (write these lines exactly; a refused line changes nothing):\n${lines.join('\n')}` : '';
}

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

// Witnesses contain only relevant local paths. A guard never interprets effects or asks live
// services: it verifies the recorded decision against the prefix and allows the host's saved ops.
export function replayInputs(state, { module, subject = 'chat', reads = [], imports = [], actor = false, adapters = null, subjects = [], available = [] } = {}) {
    const domain = state?.domains?.dataModules, active = domain?.active?.[module];
    const definition = activeDefinition(state, module), instance = instanceOf(state, module, subject);
    return { active: active ? { hash: active.hash, generation: active.generation, attached: active.subjects.includes(subject) } : null,
        reads: reads.map(path => ({ path, value: copy(atPath(instance, path)) })),
        imports: Object.fromEntries(imports.map(alias => [alias, (adapters ?? definition?.imports)?.[alias] ? projectImport(state, (adapters ?? definition.imports)[alias]) : null])),
        actor: actor ? actorsOf(state)[subject] ?? null : null,
        ...(available.length ? { available: Object.fromEntries(available.map(alias => {
            const entry = (adapters ?? definition?.imports)?.[alias];
            return [alias, entry?.query === 'dataModules.public' ? {
                export: publicView(state, entry.args) !== null,
                actor: entry.args.who ? Boolean(actorsOf(state)[entry.args.who]) : null,
            } : null];
        })) } : {}),
        subjects: Object.fromEntries(subjects.filter(id => id !== 'chat').map(id => [id, actorsOf(state)[id] ?? null])) };
}

export function dataModuleGuard(view, info) {
    try {
        const { guard, recorded, source } = info, predicate = guard?.predicate;
        if (guard?.owner !== 'story-block' || guard.version !== 2 || !['dm.pin', 'dm.attach', 'dm.migrate', 'dm.act', 'dm.set', 'dm.tick', 'dm.settle', 'dm.define', 'dm.redefine', 'dm.remove', 'dm.join'].includes(predicate?.kind)
            || !dmObject(recorded) || hashJson(recorded.source) !== hashJson(source)) return { ok: false, reason: 'Malformed data module guard.' };
        const domain = view.state.domains?.dataModules;
        if (predicate.kind === 'dm.pin' || predicate.kind === 'dm.define' || predicate.kind === 'dm.join') {
            // A joining companion is two blocks made as one action (the Character, then the Skills block kept in `decision.more`, then the
            // Combat rules and Foes blocks a story's first character brings when it has none).
            const join = predicate.kind === 'dm.join', more = join ? recorded.decision?.more : [];
            if (join && (!Array.isArray(more) || more.length < 1 || more.length > 1 + RPG_EXTRAS.length || !more.every(dmObject))) return { ok: false, reason: 'Malformed data module guard.' };
            if (domain?.active?.[predicate.module] || recorded.pin.interpreter !== 1 || recorded.pin.definition.id !== predicate.module
                || hashOf(recorded.pin.definition) !== predicate.hash) return { ok: false, reason: 'Pin selection or checked definition changed.' };
            if (activeCount(domain) + more.length >= L.pins) return { ok: false, reason: 'Data module limit changed.' };
            const chatBlock = (pin, module) => pin?.packId === 'chat' && pin.packVersion === '0' && pin.packHash === null && pin.definition?.pack === 'chat'
                && module === `pack.chat/${pin.definition.slug}` && pin.definition.scope === 'chat';
            if ((predicate.kind !== 'dm.pin' && (!chatBlock(recorded.pin, predicate.module) || blockCount(domain) + more.length >= L.definitions))) return { ok: false, reason: 'Block selection or chat limit changed.' };
            // A companion joined a story that had blocks: if every one of them is gone (a Re-read of the reply that made them), the join is skipped
            // with its own reason instead of failing to find the place it was written in.
            if (join && recorded.decision?.base === true && !domain) return { ok: false, reason: 'The blocks this story had when the companion joined are gone; Re-read this action.' };
            checkedTarget(recorded.pin.definition, view.state);
            for (const second of more) {
                if (domain?.active?.[second.module] || second.module === predicate.module || second.pin?.interpreter !== 1 || second.pin.definition?.id !== second.module
                    || hashOf(second.pin.definition) !== second.hash || !chatBlock(second.pin, second.module)) return { ok: false, reason: 'Block selection or chat limit changed.' };
                checkedTarget(second.pin.definition, view.state);
            }
        } else {
            const active = domain?.active?.[predicate.module];
            if (!active || !activeDefinition(view.state, predicate.module) || hashOf(activeDefinition(view.state, predicate.module)) !== active.hash) return { ok: false, reason: 'The required frozen pin is missing or damaged.' };
            if (predicate.kind === 'dm.migrate') {
                if (active.hash !== recorded.decision.previous || predicate.generation !== active.generation + 1
                    || hashOf(recorded.pin.definition) !== predicate.hash
                    || !validateDataMigration(activeDefinition(view.state, predicate.module), recorded.pin.definition).ok) return { ok: false, reason: 'Migration prerequisite changed.' };
            } else if (predicate.kind === 'dm.redefine') {
                if (domain.pins[active.hash]?.packId !== 'chat' || activeDefinition(view.state, predicate.module).pack !== 'chat'
                    || recorded.pin?.packId !== 'chat' || recorded.pin.packVersion !== '0' || recorded.pin.packHash !== null
                    || active.hash !== recorded.decision.previous || predicate.generation <= active.generation
                    || recorded.pin.definition.id !== predicate.module || recorded.pin.definition.pack !== 'chat'
                    || predicate.module !== `pack.chat/${recorded.pin.definition.slug}` || recorded.pin.definition.scope !== 'chat'
                    || hashOf(recorded.pin.definition) !== predicate.hash) return { ok: false, reason: 'Block generation or checked definition changed.' };
                checkedTarget(recorded.pin.definition, view.state);
            } else if (active.hash !== predicate.hash || active.generation !== predicate.generation
                || (predicate.kind === 'dm.attach' ? active.subjects.includes(predicate.subject) : !active.subjects.includes(predicate.subject))) return { ok: false, reason: 'Pin generation or attached subject changed.' };
            if (predicate.kind === 'dm.remove' && (domain.pins[active.hash]?.packId !== 'chat' || activeDefinition(view.state, predicate.module).pack !== 'chat')) return { ok: false, reason: 'This is not a chat block.' };
        }
        const witness = view.query('dataModules.replayInputs', recorded.selector);
        if (hashJson({ source, witness, predicate, decision: recorded.decision }) !== guard.inputHash) return { ok: false, reason: 'Data module prefix prerequisite changed; Re-read this action.' };
        // The conditions this action answered (a kind's, a rule's) are asked again on the prefix: a change before that leaves every
        // answer as it was leaves the action as it was.
        const conds = recorded.decision?.conds ?? [];
        if (conds.length) {
            const definition = activeDefinition(view.state, predicate.module), instance = instanceOf(view.state, predicate.module, predicate.subject);
            const inputs = { ...(recorded.decision.inputs ?? {}), ...(witness.imports ?? {}) };
            for (const record of conds) if (!conditionHolds(definition, record, instance.fields, inputs)) return { ok: false, reason: 'A condition this action answered would now be answered differently; Re-read this action.' };
        }
        return { ok: true };
    } catch { return { ok: false, reason: 'Damaged or unsupported data module pin/guard.' }; }
}

const valueText = value => (typeof value === 'string' ? JSON.stringify(oneLine(value)) : String(value));
// A number whose field has display names is shown (to a person and to the story) by its name; stored, it stays the number.
const shownText = (schema, value) => dmNameOf(schema, value) ?? valueText(value);
// A hidden field (`prompt: false`) is left out: the story is never told it.
const fieldText = (definition, key, value) => (value !== null && typeof value === 'object'
    ? `${key}: ${Object.entries(value).map(([name, item]) => `${name} ${valueText(item)}`).join(', ')}` : `${key} ${shownText(definition.state[key], value)}`);
const fieldsText = (definition, fields) => Object.entries(fields).filter(([key]) => !dmHidden(definition.state[key])).map(([key, value]) => fieldText(definition, key, value)).join('; ');
// The named fields a root changed, for its summary: "Soul Class II → III". Empty for a block with no display names.
const namedChanges = (definition, before, after) => Object.entries(definition.state).filter(([key, schema]) => schema.names && before[key] !== after[key])
    .map(([key, schema]) => `${schema.label ?? key} ${shownText(schema, before[key])} → ${shownText(schema, after[key])}`);

// What a module may take of the prompt's tail: 100 tokens, 300 for a block with a `role` (the RPG's sheets carry text the story reads).
// `rpg` is whether the RPG feature is on: a block with a role is the RPG's to write only then; with it off the block is told like any other.
const tailRoom = (definition, rpg = true) => (rpg && definition?.role ? L.roleTailTokens : L.tailTokens);

/**
 * One module's state in plain words for the prompt's tail, at most 100 tokens (300 for a block with a role, written compact): "Survival — Wessel: hunger 12; fatigue 6."
 * `rpg` (default on) is the RPG feature: with it off a block with a role gets the ordinary line, which leaves out its hidden fields as well.
 */
export function summaryOf(state, module, { rpg = true } = {}) {
    const definition = activeDefinition(state, module);
    if (!definition) return `${module} — unavailable (damaged or unknown pin).`;
    const view = moduleView(state, { module });
    let waiting = '';
    try { const inputs = inputsOf(state, definition); if (definition.timers.some(timer => inputs[timer.clock]?.minutes == null)) waiting = ' Waiting for story time.'; } catch { waiting = ' Waiting.'; }
    // A block with a role is written compact (lean-rpg/tail.js): defaults and empty slots left out, one line per skill; nothing to say, no line.
    if (rpg && definition.role) {
        const people = definition.scope === 'chat' ? [{ name: definition.name, fields: view.chat }] : view.characters.map(({ id, name, ...fields }) => ({ name, fields }));
        const line = roleTail(definition, people, { hidden: key => dmHidden(definition.state[key]), text: (key, value) => fieldText(definition, key, value),
            named: (key, value) => shownText(definition.state[key], value) });
        return line && cutAt(`${line}${waiting}`, tailRoom(definition, rpg) * 4);
    }
    const body = definition.scope === 'chat' ? fieldsText(definition, view.chat)
        : view.characters.map(({ id, name, ...fields }) => `${name}: ${fieldsText(definition, fields)}`).join(' | ') || 'no one attached';
    // The host estimates tokens from UTF-16 length; cut on a character boundary within that budget.
    return cutAt(`${definition.name} — ${body}.${waiting}`, tailRoom(definition, rpg) * 4);
}
// A timer whose clock has moved past its cursor.
const timerDue = (timer, inputs, instance) => {
    const minute = inputs[timer.clock]?.minutes, last = instance?.timers?.[timer.id]?.lastMinute;
    return minute !== null && minute !== undefined && (last === null || last === undefined || minute > last);
};
// A reply's lines are settled by the reply-end functions on these generations only (not a Continue's, nor the extractor's late lines).
const SETTLED_TYPES = Object.freeze(['normal', 'swipe', 'regenerate', 'reread']);
// Every node an evaluation could visit in this piece of a definition (each list, each leaf): the most its visits can come to.
const nodesOf = value => Array.isArray(value) ? 1 + value.reduce((sum, item) => sum + nodesOf(item), 0)
    : value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + nodesOf(item), 0) : 1;
// What the settle steps of a reply can cost: one root for each subject of each pinned block that has reply-end functions, and for the
// visits, what that block's own reply-end functions, rules and reward templates can come to (counted, not a flat share), at most one
// root's worth for a subject.
export function settleReserve(state) {
    const total = { roots: 0, visits: 0 };
    for (const module of Object.keys(state?.domains?.dataModules?.active ?? {})) {
        const definition = activeDefinition(state, module);
        if (!definition?.replyEnd?.length) continue;
        const subjects = subjectsOf(state, module).length;
        total.roots += subjects;
        total.visits += subjects * Math.min(L.rootVisits, 1 + nodesOf(definition.replyEnd) + nodesOf(definition.rules ?? []) + nodesOf(definition.rewards ?? {}));
    }
    return total;
}
const tailLines = (state, rpg) => Object.keys(state?.domains?.dataModules?.active ?? {}).map(module => summaryOf(state, module, { rpg }));

// --- Cards under the head reply -------------------------------------------------------------------------------------------------
// A block's `cards` are derived from the head reply's state each time the cards are asked for, never stored. They reach the reply-cards
// socket (src/v2/reply-cards.js) through a few fixed slots, because that socket takes one named card per entry: slot n answers with the
// nth card of the active blocks, in pin order and, within a block, in the order written. A card with a button runs that Button of the
// same block as a reader command on the latest reply.
export const CARD_SLOTS = 8;
const CARD_LOOK = Object.freeze({ info: { tone: 'info', icon: 'ph-info' }, warn: { tone: 'accent', icon: 'ph-warning' }, end: { tone: 'bad', icon: 'ph-skull' } });
const cardLists = new WeakMap();

const CARD_RANK = Object.freeze({ end: 1, warn: 2, info: 3 });

/**
 * The cards the head state shows: [{ module, card }] with card in reply-cards.js's shape. A card whose condition cannot be asked is left out.
 * They are ordered the end cards of a role `character` block first (the death notice), then any other end card, then warn, then info (pin
 * order, then written order, within each) before the slots are filled, so a death notice always has a slot, however many other cards show.
 */
export function blockCards(state) {
    const active = state?.domains?.dataModules?.active;
    if (!active || !Object.keys(active).length) return [];
    return kept(cardLists, state, () => Object.keys(active).flatMap(module => {
        const definition = activeDefinition(state, module), instance = instanceOf(state, module);
        if (!definition?.cards?.length || !instance) return [];
        return definition.cards.flatMap((entry, at) => {
            try {
                if (!createEvaluation(definition, instance).condition(['card', at], entry.when, {})) return [];
            } catch { return []; }
            const look = CARD_LOOK[entry.tone] ?? CARD_LOOK.info, kind = entry.button ? definition.kinds[entry.button] : null;
            return [{ module, rank: entry.tone === 'end' && definition.role === 'character' ? 0 : CARD_RANK[entry.tone] ?? CARD_RANK.info, card: { ...look, title: entry.title, text: entry.text,
                actions: kind ? [{ id: entry.button, label: oneLine(kind.title ?? entry.button.replace(/^button-/, '')), primary: true,
                    command: 'dm.act', payload: { module, kind: entry.button } }] : [] } }];
        });
    }).sort((a, b) => a.rank - b.rank).map(({ module, card }) => ({ module, card })));
}
const blockCardSlots = Object.fromEntries(Array.from({ length: CARD_SLOTS }, (_, at) => [`block-card-${at + 1}`, { for: state => blockCards(state)[at]?.card ?? null }]));

export function createDataModulesPart({ packs, state: head = () => null, lifecycle = () => null, restore = () => ({ state: 'idle' }), settings = () => ({}), persona = () => '' } = {}) {
    // The runtime's late-bound readers may not exist yet while the definition registers: read as "no state" until they do.
    const state = () => { try { return head(); } catch { return null; } };
    // Whether a name is the reader's own (the persona's): the Party tab shows that character as You.
    const isReader = name => {
        let who = '';
        try { who = String(persona() ?? '').replace(/\s+/g, ' ').trim(); } catch { who = ''; }
        return Boolean(who) && fold(name) === fold(who);
    };
    function offers() {
        const where = new Map();
        try { for (const entry of packs?.list?.() ?? []) where.set(entry.id, entry.source === 'lorebook' ? 'a lorebook' : String(entry.origin ?? '')); } catch { /* no list: no origin */ }
        return (packs?.packs?.() ?? []).flatMap(pack => (pack.content.dataModules ?? []).map(definition => ({ module: definition.id,
            definition: copy(definition), hash: dataModuleHash(definition), packId: pack.id, packVersion: pack.version,
            packHash: dataModulesPackHash(pack), interpreter: 1, origin: where.get(pack.id) ?? '' })));
    }
    function dependency(definition, prefix) {
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', 'A restore is pending.');
        for (const entry of Object.values(definition.imports)) {
            if (['director.time', 'checks.policy'].includes(entry.query) || definition.scope === 'character') {
                const life = lifecycle('story-director');
                if (!life || life.status !== 'ready') refuse('DEPENDENCY_UNAVAILABLE', entry.query, life?.reason ?? 'Story Director is not available.');
            }
            if (entry.query === 'dataModules.public' && !publicView(prefix, entry.args)) refuse('DEPENDENCY_UNAVAILABLE', entry.query, 'The imported module/export/subject is not active.');
        }
        if (definition.scope === 'character' && lifecycle('story-director')?.status !== 'ready') refuse('DEPENDENCY_UNAVAILABLE', 'who', 'Story Director is not available.');
    }
    function reader(ctx) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', 'Only a direct reader action in Setup may pin, attach or migrate.');
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', 'A restore is pending.');
    }
    function guard(ctx, prefix, { kind, module, hash, generation, subject = 'chat', reads = [], imports = [], actor = false, decision = {}, pin = null, bound = false, localOnly = false }) {
        const predicate = { kind, module, hash, generation, subject };
        const adapters = pin?.definition.imports ?? activeDefinition(prefix, module)?.imports ?? {};
        const available = localOnly ? [] : Object.keys(adapters).filter(alias => adapters[alias].query === 'dataModules.public');
        const selector = { module, subject, reads, imports, actor, ...(available.length ? { available } : {}),
            ...(pin ? { adapters, subjects: decision.subjects ?? [] } : {}) };
        const source = copy(ctx.source);
        if (!source) refuse('DM_SCHEMA', '', 'A reply must hold this data module action.');
        const witness = replayInputs(prefix, selector);
        const recorded = { source, selector, decision, ...(pin ? { pin } : {}) };
        ctx.replayGuard({ owner: 'story-block', version: 2, epoch: ctx.epoch, rulesHash: localOnly ? null : prefix.domains.rules?.rulesHash ?? null,
            predicate, inputHash: hashJson({ source, witness, predicate, decision }), ...(bound ? { replyBound: true } : {}) }, recorded);
        return recorded;
    }
    function finish(ctx, prefix, draft, data, { pin = false, visits = 0, summary, notes = [], replan = false, result = null } = {}) {
        const key = pairKey(ctx.source), standing = ctx.standing?.domains?.dataModules?.perReply?.[key];
        const actions = { ...(draft.perReply[key]?.actions ?? {}) };
        for (const [id, action] of Object.entries(standing?.actions ?? {})) if (action.click) actions[id] ??= action;
        actions[ctx.cursor().block] = { visits, click: ctx.cause === 'ui' && !pin };
        const next = { roots: Object.keys(actions).length, visits: Object.values(actions).reduce((n, action) => n + action.visits, 0), actions };
        if (next.roots > L.replyRoots || next.visits > L.replyVisits) refuse('DM_BUDGET', '', 'Data module reply budget exhausted.');
        // The story's lines leave room for the steps that settle the reply (what each block with reply-end functions can really cost): without it a full
        // reply would take its last action and the settling that decides a death would be refused.
        if (ctx.cause === 'story') {
            const kept = settleReserve(prefix);
            if (next.roots > L.replyRoots - kept.roots || next.visits > L.replyVisits - kept.visits) refuse('DM_BUDGET', '', B.replyFull);
        }
        // Scratch from earlier replies is pruned only by a successful data root.
        draft.perReply = { [key]: next };
        // (The bus counts the patch's ops and the span's bytes for every data root; this is the data's own share, and the pins.)
        if (pin && (Object.keys(draft.pins).length > L.pins || bytes(draft.pins) > L.pinsBytes)) refuse('DM_BUDGET', '', 'Retained pin budget exhausted.');
        if (bytes(data) + bytes(result) > (pin ? L.pinBytes : L.actionBytes)) refuse('DM_BUDGET', '', 'Data module action storage budget exhausted.');
        return { summary, narrate: false, data: { v2: { result: result ?? {} } }, ...(notes.length ? { problem: notes.join(' ') } : {}), ...(replan ? { replan: true } : {}) };
    }
    function target(ctx, payload, migrate = false, call = {}) {
        reader(ctx);
        const offer = offers().find(entry => entry.module === payload.module);
        if (!offer || offer.hash !== payload.hash || offer.packHash !== payload.packHash) refuse('STALE', '', 'The installed module offer changed; inspect it again.');
        call.label = offer.definition.name;
        const prefix = stateOf(ctx);
        dependency(offer.definition, prefix);
        const definition = checkedTarget(offer.definition, prefix);
        const draft = draftOf(ctx);
        const old = draft.active[definition.id];
        if (migrate ? !old : Boolean(old)) refuse('DM_SCHEMA', '', migrate ? 'No pin to migrate.' : 'This module is already pinned.');
        if (!migrate && activeCount(prefix.domains.dataModules) >= L.pins) refuse('DM_BUDGET', '', B.limit);
        const generation = (old?.generation ?? 0) + 1;
        const inputs = inputsOf(prefix, definition);
        if (payload.subjects !== undefined && !Array.isArray(payload.subjects)) refuse('DM_SCHEMA', 'subjects', 'Subjects must be a list of SD actor IDs.');
        const subjects = migrate ? old.subjects : definition.scope === 'chat' ? ['chat'] : (payload.subjects ?? []).map(who => resolveActor(prefix, who));
        if (!Array.isArray(subjects) || new Set(subjects).size !== subjects.length || subjects.length > L.subjects) refuse('DM_BUDGET', 'subjects', 'Subjects must be distinct and fit the subject budget.');
        let addition = null;
        if (migrate) {
            const result = validateDataMigration(activeDefinition(prefix, definition.id), definition);
            if (!result.ok) refuse('DM_SCHEMA', result.errors[0].path, result.errors[0].message);
            addition = dataModuleDefaults(result.add);
        }
        const pin = { definition, packId: offer.packId, packVersion: offer.packVersion, packHash: offer.packHash, interpreter: 1 };
        draft.pins[offer.hash] = copy(pin);
        draft.active[definition.id] = { hash: offer.hash, generation, subjects };
        if (!migrate) draft.instances[definition.id] = definition.scope === 'chat' ? { chat: newInstance(definition, inputs) }
            : { characters: Object.fromEntries(subjects.map(id => [id, newInstance(definition, inputs)])) };
        else for (const subject of subjects) Object.assign(atPath(draft, instancePath(definition.id, subject)).fields, addition);
        const decision = { subjects, inputs, addition, previous: old?.hash ?? null };
        const recorded = guard(ctx, prefix, { kind: migrate ? 'dm.migrate' : 'dm.pin', module: definition.id, hash: offer.hash, generation,
            imports: Object.keys(definition.imports), decision, pin, bound: true });
        return finish(ctx, prefix, draft, recorded, { pin: true, result: { subjects, generation }, summary: `${definition.name}: ${migrate ? 'migrated' : 'pinned'} for this chat.` });
    }
    function changeBlock(ctx, payload, action, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', B.reader);
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), domain = prefix.domains.dataModules;
        const module = action === 'define' ? `pack.chat/${payload.definition?.slug ?? ''}` : resolveModule(prefix, payload.module);
        const old = domain?.active?.[module], previous = activeDefinition(prefix, module);
        if (action === 'define') {
            if (old) refuse('DM_SCHEMA', 'slug', B.exists);
            if (blockCount(domain) >= L.definitions) refuse('DM_BUDGET', '', B.blockLimit);
            if (activeCount(domain) >= L.pins) refuse('DM_BUDGET', '', B.limit);
        } else if (!previous || previous.pack !== 'chat' || domain.pins[old.hash]?.packId !== 'chat') refuse('REFUSED', 'module', B.chatOnly);
        call.label = previous?.name ?? payload.definition?.name ?? module;
        if (action === 'remove') {
            const draft = draftOf(ctx);
            const recorded = guard(ctx, prefix, { kind: 'dm.remove', module, hash: old.hash, generation: old.generation,
                reads: [['fields'], ['timers'], ['offers'], ['settled']], decision: { previous: old.hash }, bound: true });
            delete draft.active[module];
            delete draft.instances[module];
            const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module }, summary: fill(B.removed, { name: previous.name }) });
            answer.data.edit = true;
            return answer;
        }
        const catalog = Object.keys(domain?.active ?? {}).map(id => activeDefinition(prefix, id)).filter(Boolean);
        const checked = validateDataModules([payload.definition], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
        if (!checked.ok) refuse(checked.errors[0].code, checked.errors[0].path, checked.errors[0].message);
        const definition = checked.definitions[0];
        if (definition.scope !== 'chat') refuse('DM_SCHEMA', 'scope', B.chatScope);
        if (action === 'redefine' && definition.id !== module) refuse('DM_SCHEMA', 'slug', B.sameSlug);
        // Each field and each button is a slot the form uses. A block with a role is a template written by hand, whose stats and latches are
        // fields no kind sets: only its kinds count.
        const slots = definition.role ? Object.keys(definition.kinds).length : Object.keys(definition.state).length + Object.values(definition.kinds).filter(kind => kind.ui).length;
        if (slots > L.kinds) refuse('DM_BUDGET', 'fields', B.kindLimit);
        dependency(definition, prefix);
        const inputs = inputsOf(prefix, definition), hash = dataModuleHash(definition);
        const generation = Math.max(ctx.rev, (old?.generation ?? 0) + 1);
        const pin = { definition, packId: 'chat', packVersion: '0', packHash: null, interpreter: 1 };
        const instance = newInstance(definition, inputs);
        if (previous) {
            const oldInstance = instanceOf(prefix, module), fields = oldInstance?.fields ?? {};
            for (const [field, schema] of Object.entries(definition.state)) if (previous.state[field]?.type === schema.type && scalarHolds(schema, fields[field])) instance.fields[field] = copy(fields[field]);
            instance.offers = copy(oldInstance?.offers ?? {});
            instance.settled = copy(oldInstance?.settled ?? {});
            for (const timer of definition.timers) {
                const before = previous.timers.find(item => item.id === timer.id);
                if (before && hashJson(before) === hashJson(timer) && hashJson(previous.imports[before.clock]) === hashJson(definition.imports[timer.clock])
                    && oldInstance?.timers?.[timer.id]) instance.timers[timer.id] = copy(oldInstance.timers[timer.id]);
            }
        }
        const draft = draftOf(ctx);
        draft.pins[hash] = copy(pin);
        draft.active[module] = { hash, generation, subjects: ['chat'] };
        draft.instances[module] = { chat: instance };
        // The definition this one replaces is not kept (every block that used it carries its own recorded pin, and a swipe or delete of this
        // reply brings the old pin back with the state before it): the pins would otherwise fill up, one for each edit, until 16 refused all blocks.
        if (old && old.hash !== hash && !Object.values(draft.active).some(entry => entry.hash === old.hash)) delete draft.pins[old.hash];
        const recorded = guard(ctx, prefix, { kind: `dm.${action}`, module, hash, generation,
            reads: previous ? [['fields'], ['timers'], ['offers'], ['settled']] : [], imports: Object.keys(definition.imports),
            decision: { subjects: ['chat'], inputs, previous: old?.hash ?? null }, pin, bound: true });
        const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module, generation },
            summary: fill(action === 'define' ? B.defined : B.redefined, { name: definition.name }) });
        answer.data.edit = true;
        return answer;
    }
    // ---- companions who join (lean-rpg/join.js): `+ party` makes a Character and an empty Skills block as ONE guarded action ('dm.join'), `- party` sets `left` ----
    function makeParty(ctx, request, soul, call, { added = false } = {}) {
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), domain = prefix.domains.dataModules;
        const made = joinDefinitions(request, { used: Object.keys(domain?.active ?? {}), soul });
        // The story's first character also brings the Combat rules and Foes blocks it lacks, as far as they fit (nothing is refused for them).
        const first = partyOf(prefix).length === 0, plan = first ? extrasPlan(prefix) : { add: [], skipped: [] };
        const extras = extraDefinitions(plan.add, { used: [...Object.keys(domain?.active ?? {}), made.character.slug, made.skills.slug] });
        const catalog = Object.keys(domain?.active ?? {}).map(id => activeDefinition(prefix, id)).filter(Boolean);
        const checked = validateDataModules([made.character, made.skills, ...extras], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
        if (!checked.ok) refuse(checked.errors[0].code, checked.errors[0].path, checked.errors[0].message);
        if (blockCount(domain) + 2 > L.definitions) refuse('DM_BUDGET', '', B.blockLimit);
        if (activeCount(domain) + 2 > L.pins) refuse('DM_BUDGET', '', B.limit);
        const generation = Math.max(ctx.rev, 1), draft = draftOf(ctx);
        const pins = checked.definitions.map(definition => ({ definition, hash: hashOf(definition), pin: { definition, packId: 'chat', packVersion: '0', packHash: null, interpreter: 1 } }));
        for (const { definition, hash, pin } of pins) {
            draft.pins[hash] = copy(pin);
            draft.active[definition.id] = { hash, generation, subjects: ['chat'] };
            draft.instances[definition.id] = { chat: newInstance(definition, inputsOf(prefix, definition)) };
        }
        const [head, ...rest] = pins;
        const recorded = guard(ctx, prefix, { kind: 'dm.join', module: head.definition.id, hash: head.hash, generation, imports: [],
            decision: { subjects: ['chat'], inputs: {}, previous: null, base: Boolean(domain && Object.keys(domain.active ?? {}).length),
                more: rest.map(entry => ({ module: entry.definition.id, hash: entry.hash, generation, pin: entry.pin })) }, pin: head.pin, bound: true });
        const left = plan.skipped.length ? ` ${fill(J.noExtras, { list: plan.skipped.map(item => extraName(item.role)).join(', ') })}` : '';
        const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module: head.definition.id, skills: rest[0].definition.id },
            summary: `${fill(J.joined, { name: request.name })}${left}` });
        answer.data.join = { op: 'added', name: request.name };
        return answer;
    }
    function party(ctx, line, call = {}) {
        if (ctx.cause !== 'story' || ctx.caller !== null) refuse('REFUSED', '', J.storyOnly);
        const prefix = stateOf(ctx);
        const read = readJoin(line, soulNaming(prefix));
        call.label = 'Party';
        if (read.error) refuse('DM_LABEL', '', read.error);
        if (read.op === '-') {
            const person = partyOf(prefix).find(entry => fold(entry.name) === fold(read.name));
            if (!person || person.left) refuse('DM_SCHEMA', '', fill(J.nothing, { name: read.name }));
            // The player's own character (the one named like the persona) never leaves: companions only.
            if (isReader(person.name)) refuse('REFUSED', '', fill(J.isYou, { name: person.name }));
            return leave(ctx, person, true, call);
        }
        const check = checkJoin(prefix, read);
        if (!check.ok) refuse('REFUSED', '', check.why);
        if (check.returning) return leave(ctx, check.returning, false, call);
        if (joinMode(settings()) === 'ask') {
            // Ask: nothing is made. The line is kept in this reply's own receipt, and the card under the reply (rpg.joins) is read from it.
            const offer = { op: 'offer', name: read.name, about: read.about, soul: read.soul, best: read.best };
            return { summary: fill(J.offerNote, { name: read.name }), narrate: false, data: { join: offer } };
        }
        return makeParty(ctx, read, check.soul, call);
    }
    // Left (or back): the Character block's `left` field, one guarded `dm.set`. A sheet made before the field existed cannot be marked.
    function leave(ctx, person, left, call) {
        const definition = activeDefinition(stateOf(ctx), person.module);
        if (!person.canLeave || !definition) refuse('DM_SCHEMA', '', fill(J.noLeave, { name: person.name }));
        const answer = setField(ctx, { module: person.module, field: 'left', value: left }, call, { story: true });
        answer.summary = fill(left ? J.left : J.returned, { name: person.name });
        answer.data.join = { op: left ? 'left' : 'back', name: person.name };
        return answer;
    }
    // "Add to party" on the Ask card: the reader's own go-ahead, so it is made like the automatic one, for the head reply.
    function addParty(ctx, payload, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', J.cardOnly);
        const soul = payload?.soul === undefined ? 1 : payload.soul;
        const request = readJoin({ op: '+', name: payload?.name, labels: { about: payload?.about, class: Number.isSafeInteger(soul) ? CLASS_NAMES[soul - 1] ?? 'X' : 'X', best: payload?.best ?? '' } }, soulNaming(stateOf(ctx)));
        call.label = 'Party';
        if (request.error) refuse('DM_LABEL', '', request.error);
        const check = checkJoin(stateOf(ctx), request);
        if (!check.ok) refuse('REFUSED', '', check.why);
        if (check.returning) refuse('REFUSED', '', fill(J.taken, { name: request.name }));
        return makeParty(ctx, request, check.soul, call);
    }
    // A refusal reaches the reader as one plain sentence naming the module: "Reputation: faction must be guild, watch or compact;
    // nothing applied." (bounded; shown escaped by the card). `call.label` is the module's name once the pin is known.
    const wrap = fn => (ctx, payload = {}) => {
        const call = { label: null };
        try { return fn(ctx, payload, call); }
        catch (error) {
            if (!(error instanceof DataModuleError)) throw error;
            const label = String(call.label ?? payload.module ?? payload.name ?? 'Data module');
            const reason = String(error.message).replace(/[.\s]+$/, '');
            return ctx.fail(error.code, `${label}: ${reason}; nothing applied.`.slice(0, 280));
        }
    };
    function attach(ctx, payload, call = {}) {
        reader(ctx);
        const prefix = stateOf(ctx), module = resolveModule(prefix, payload.module), definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? call.label;
        if (!definition || definition.scope !== 'character') refuse('DM_SCHEMA', '', 'Attach needs a supported character module.');
        dependency(definition, prefix);
        const subject = resolveActor(prefix, payload.who), draft = draftOf(ctx), active = draft.active[module];
        if (active.subjects.includes(subject)) refuse('CLAIMED', 'who', 'Actor is already attached.');
        if (active.subjects.length >= L.subjects) refuse('DM_BUDGET', 'who', 'Subject budget exhausted.');
        active.subjects.push(subject);
        const inputs = inputsOf(prefix, definition);
        draft.instances[module].characters[subject] = newInstance(definition, inputs);
        const recorded = guard(ctx, prefix, { kind: 'dm.attach', module, hash: active.hash, generation: active.generation, subject,
            actor: true, imports: Object.keys(definition.imports), decision: { inputs }, bound: true });
        return finish(ctx, prefix, draft, recorded, { pin: true, result: { subject }, summary: `${definition.name}: attached ${subject}.` });
    }
    function act(ctx, payload, line = null, call = {}) {
        if (ctx.caller !== null) refuse('REFUSED', '', 'A data action cannot be called by another module.');
        const prefix = stateOf(ctx), module = resolveModule(prefix, line?.name ?? payload.module), definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', '', 'Unsupported or damaged pin.');
        dependency(definition, prefix);
        const labels = line?.labels ?? { ...payload.labels, kind: payload.kind, ...(payload.who !== undefined ? { who: payload.who } : {}) };
        const kind = dmOwn(definition.kinds, labels.kind) && definition.kinds[labels.kind];
        if (!kind) refuse('DM_LABEL', 'kind', `kind must be ${orList(Object.keys(definition.kinds))}`);
        if (line ? line.op !== kind.op : ctx.cause !== 'ui' || !kind.ui) refuse('REFUSED', '', line ? `${labels.kind} is written with ${kind.op}, not ${line.op}` : `${labels.kind} is a story line; a screen may only use kinds that allow it`);
        if (line && dmKindWritesHidden(definition, kind)) refuse('REFUSED', '', B.hiddenLine);
        const args = parseLabels(definition, kind, labels, { text: Boolean(line) });
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, labels.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject)), inputs = inputsOf(prefix, definition);
        const claim = `dm:${pairKey(ctx.source)}:${module}:${labels.kind}:${subject}:${hashJson(kind.oncePerReply.map(key => args[key]))}`;
        if (!ctx.claim(claim)) refuse('CLAIMED', '', `${labels.kind} was already applied for this in this reply`);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        const fieldsBefore = copy(instance.fields);
        evaluation.timers();
        if (!evaluation.condition(['kind', labels.kind], kind.when, { arg: args })) refuse('DM_CONDITION', '', kind.refusal ?? 'Kind condition is not met.');
        evaluation.effects(kind.effects, { arg: args }); evaluation.rules();
        const result = evaluation.finish();
        const changes = namedChanges(definition, fieldsBefore, instance.fields);
        const recorded = guard(ctx, prefix, { kind: 'dm.act', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { args, inputs, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), conds: result.conds } });
        // The concrete outcome kept beside the inputs (and past the receipts' display data): which line, for whom, what was frozen, what was limited.
        const outcome = { kind: labels.kind, subject, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) };
        const answer = finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes, result: outcome, summary: `${definition.name}: ${kind.title ?? labels.kind}${changes.length ? ` (${changes.join(', ')})` : ''}.` });
        if (ctx.cause === 'ui') answer.data.edit = true;
        return answer;
    }
    // `dm.set` writes one field (`field`, `key?`, `value`) or, as ONE action, several non-map fields of one block (`fields`: { name: value }).
    // Either way each value is checked the same, the rules run once after all the sets, and nothing applies unless every one holds.
    function setField(ctx, payload, call = {}, { story = false } = {}) {
        // `story`: the party line that marks a companion as left (`- party Name`, below) is the one story line that sets a field.
        if (story ? ctx.cause !== 'story' || ctx.caller !== null : ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', E.fieldReader);
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), module = resolveModule(prefix, payload.module), definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', '', E.pinDamaged);
        dependency(definition, prefix);
        const multi = payload.fields !== undefined;
        if (multi && ['field', 'key', 'value'].some(name => payload[name] !== undefined)) refuse('DM_SCHEMA', 'fields', E.fieldsAlone);
        if (multi && (!dmObject(payload.fields) || Object.keys(payload.fields).length < 1 || Object.keys(payload.fields).length > SET_FIELDS)) refuse('DM_SCHEMA', 'fields', E.fieldsCount);
        // One entry per field to set: its name, map key (the single form only) and value.
        const entries = multi ? Object.entries(payload.fields).map(([name, value]) => ({ name, key: undefined, value })) : [{ name: payload.field, key: payload.key, value: payload.value }];
        for (const entry of entries) {
            const schema = dmOwn(definition.state, entry.name) ? definition.state[entry.name] : null;
            if (!schema) refuse('DM_SCHEMA', multi ? entry.name : 'field', E.fieldDeclared);
            if (schema.edit === false) refuse('REFUSED', multi ? entry.name : 'field', E.fieldLocked);
            entry.map = schema.type === 'map';
            if (entry.map && multi) refuse('DM_SCHEMA', entry.name, E.fieldsNoMaps);
            if (entry.map && !schema.keys.includes(entry.key)) refuse('DM_SCHEMA', 'key', E.mapKeyDeclared);
            if (!entry.map && entry.key !== undefined) refuse('DM_SCHEMA', 'key', E.fieldNoKeys);
            entry.schema = schema;
        }
        if (definition.scope === 'chat' && payload.who !== undefined) refuse('DM_LABEL', 'who', E.fieldShared);
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, payload.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject));
        for (const entry of entries) {
            const { schema } = entry;
            entry.field = entry.map ? schema.values : schema;
            entry.path = entry.map ? [entry.name, entry.key] : [entry.name];
            let { value } = entry;
            if (entry.field.list === true) value = cleanList(value, entry.field.max);
            else if (entry.field.type === 'text' && typeof value === 'string') value = [...oneLine(value)].slice(0, entry.field.max).join('');
            if (!scalarHolds(entry.field, value)) refuse('DM_BOUNDS', multi ? entry.name : 'value', E.fieldRange);
            entry.value = value;
            entry.before = atPath(instance.fields, entry.path);
        }
        const inputs = inputsOf(prefix, definition);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        evaluation.effects(entries.map(entry => ({ op: 'set', path: entry.path, value: entry.value })));
        evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.set', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition), actor: subject !== 'chat',
            decision: { inputs, conds: result.conds } });
        const labelOf = entry => (entry.map ? `${entry.schema.label ?? entry.name} (${entry.key})` : entry.schema.label ?? entry.name);
        const change = entry => `${labelOf(entry)} ${shownText(entry.field, entry.before)} → ${shownText(entry.field, entry.value)}`;
        const [only] = entries;
        const summary = multi ? fill(E.fieldsSet, { module: definition.name, changes: entries.map(change).join(', ') })
            : fill(E.fieldSet, { module: definition.name, field: labelOf(only), from: shownText(only.field, only.before), to: shownText(only.field, only.value) });
        const rules = result.fired.length ? { rules: result.fired } : {};
        const answer = finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes, summary,
            result: multi ? { fields: Object.fromEntries(entries.map(entry => [entry.name, { from: entry.before, to: entry.value }])), subject, ...rules }
                : { field: only.name, ...(only.map ? { key: only.key } : {}), subject, from: only.before, to: only.value, ...rules } });
        if (!story) answer.data.edit = true;
        return answer;
    }
    // A step the host plans again (REPLAY.md "Re-read and reconciling") answers NO_LONGER_DONE when the story before it
    // leaves nothing to settle (the pin, the subject or the elapsed time is gone), and its block then goes. A dependency
    // that is only unavailable now (a peer is away, a restore is pending) is a plain refusal: the old block is kept as it was.
    function tick(ctx, payload, call = {}) {
        if (ctx.cause !== 'system' || ctx.caller !== null) refuse('REFUSED', '', 'Timers run only as host system steps.');
        const prefix = stateOf(ctx), module = payload.module, subject = payload.subject;
        if (!prefix.domains.dataModules?.active?.[module] || !subjectsOf(prefix, module).includes(subject)) refuse('NO_LONGER_DONE', 'who', 'This module or subject is no longer pinned and attached.');
        // A pin this build cannot read is kept as it is (a plain refusal), never taken back.
        const definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', module, 'Unsupported or damaged pin; inspect it in Setup.');
        dependency(definition, prefix);
        if (subject !== 'chat') resolveActor(prefix, subject, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx), instance = atPath(draft, instancePath(module, subject));
        const inputs = inputsOf(prefix, definition), before = hashJson(instance);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        evaluation.charge(); evaluation.timers();
        if (hashJson(instance) === before) refuse('NO_LONGER_DONE', '', 'Story time is already settled here.');
        evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.tick', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { inputs, conds: result.conds } });
        return finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes, replan: true, result: { subject, notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) }, summary: `${definition.name}: story time settled.` });
    }
    // The block's reply-end functions, settled once at the end of every reply that has accepted lines, as a system step (a timer's twin:
    // planned again by a swipe, a delete or an edit before it). It is recorded even when it changes nothing, so that a change before this
    // reply (a Re-read of an earlier one) has a step here to plan again; NO_LONGER_DONE only when the pin or the subject is gone.
    function settle(ctx, payload, call = {}) {
        if (ctx.cause !== 'system' || ctx.caller !== null) refuse('REFUSED', '', 'Reply-end functions run only as host system steps.');
        const prefix = stateOf(ctx), module = payload.module, subject = payload.subject;
        if (!prefix.domains.dataModules?.active?.[module] || !subjectsOf(prefix, module).includes(subject)) refuse('NO_LONGER_DONE', 'who', 'This module or subject is no longer pinned and attached.');
        const definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', module, 'Unsupported or damaged pin; inspect it in Setup.');
        if (!definition.replyEnd?.length) refuse('NO_LONGER_DONE', '', 'This block has nothing to settle at the end of a reply.');
        dependency(definition, prefix);
        if (subject !== 'chat') resolveActor(prefix, subject, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx), instance = atPath(draft, instancePath(module, subject));
        const inputs = inputsOf(prefix, definition);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        evaluation.charge(); evaluation.replyEnd();
        evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.settle', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { inputs, conds: result.conds } });
        return finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes, replan: true, result: { subject, notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) }, summary: `${definition.name}: settled at the end of the reply.` });
    }
    // The settle steps due once a reply's lines are in: one per block (and subject) that has reply-end functions, whether or not they would
    // change anything now (see `settle`). Not for a Continue or the extractor's late lines, which add to a reply already settled: a reply
    // is settled once, so a latch cannot fire twice in it.
    function settleDue(view, info) {
        const prefix = view?.state, commands = [];
        if (!prefix?.domains?.dataModules?.active || !SETTLED_TYPES.includes(info?.type ?? 'normal')) return commands;
        if (restore()?.state === 'pending') return commands;
        for (const module of Object.keys(prefix.domains.dataModules.active)) {
            const definition = activeDefinition(prefix, module);
            if (!definition?.replyEnd?.length) continue;
            try { dependency(definition, prefix); } catch { continue; }
            for (const subject of subjectsOf(prefix, module)) {
                if (subject !== 'chat') { try { resolveActor(prefix, subject, subjectsOf(prefix, module)); } catch { continue; } }
                const instance = instanceOf(prefix, module, subject);
                if (instance) commands.push({ type: 'dm.settle', payload: { module, subject } });
            }
        }
        return commands;
    }
    // The timers whose clock has moved past their cursor, as `dm.tick` steps (one per module and subject). Silent while a
    // peer is away or a restore is pending (Setup shows the reason; an explicit action is refused with it), and for a
    // subject whose actor is gone. Nothing due: nothing returned, nothing consumed.
    function due(view) {
        const prefix = view?.state, commands = [];
        // Nothing pinned (or no state yet, in a new chat): the hook answers nothing and reads nothing else.
        if (!prefix?.domains?.dataModules?.active || !Object.keys(prefix.domains.dataModules.active).length) return undefined;
        if (restore()?.state === 'pending') return undefined;
        for (const module of Object.keys(prefix.domains.dataModules.active)) {
            const definition = activeDefinition(prefix, module);
            if (!definition?.timers.length) continue;
            try { dependency(definition, prefix); } catch { continue; }
            const inputs = inputsOf(prefix, definition);
            for (const subject of subjectsOf(prefix, module)) {
                if (subject !== 'chat') { try { resolveActor(prefix, subject, subjectsOf(prefix, module)); } catch { continue; } }
                const instance = instanceOf(prefix, module, subject);
                if (definition.timers.some(timer => timerDue(timer, inputs, instance))) commands.push({ type: 'dm.tick', payload: { module, subject } });
            }
        }
        return commands.length ? { commands } : undefined;
    }
    // Timers first, then the reply-end functions of the blocks that would change (they see the state the ticks leave).
    function afterCapture(view, info) {
        const commands = [...(due(view)?.commands ?? []), ...settleDue(view, info)];
        return commands.length ? { commands } : undefined;
    }
    const kind = { get enabled() { return Boolean(Object.keys(state()?.domains?.dataModules?.active ?? {}).length); },
        grammar: '! dm Module — reason | kind: name | label: value (only the lines listed under Data modules; each has its own op)', apply: wrap((ctx, line, call) => act(ctx, {}, line, call)) };
    return {
        domains: { dataModules: { initial, deferred: true, snapshot: 'when-present', scratch: ['perReply'], validate: validateDomain } },
        commands: { 'dm.pin': wrap((ctx, payload, call) => target(ctx, payload, false, call)), 'dm.migrate': wrap((ctx, payload, call) => target(ctx, payload, true, call)),
            'dm.define': wrap((ctx, payload, call) => changeBlock(ctx, payload, 'define', call)),
            'dm.redefine': wrap((ctx, payload, call) => changeBlock(ctx, payload, 'redefine', call)),
            'dm.remove': wrap((ctx, payload, call) => changeBlock(ctx, payload, 'remove', call)),
            'dm.attach': wrap(attach), 'dm.set': wrap(setField), 'dm.act': wrap((ctx, payload, call) => act(ctx, payload, null, call)), 'dm.capture': { internal: true, handler: wrap((ctx, line, call) => act(ctx, {}, line, call)) },
            'dm.tick': { internal: true, handler: wrap(tick) }, 'dm.settle': { internal: true, handler: wrap(settle) },
            // The Ask card's "Add to party" (rpg only: the feature gate leaves it out while the RPG is off).
            'dm.join': Object.assign(wrap(addParty), { feature: LEAN_RPG_FEATURE }) },
        // `+ party Name | about: … | class: I | best: int` and `- party Name`: under the RPG feature, out of the grammar while Companions who join is Off, and
        // until the story has a Character block (a party line means something only once there is a party).
        kinds: { dm: kind, party: { grammar: joinGrammar(), feature: LEAN_RPG_FEATURE, get enabled() { return joinMode(settings()) !== 'off' && partyOf(state()).length > 0; }, apply: wrap(party) } },
        queries: { 'dataModules.offers': offers, 'dataModules.view': moduleView, 'dataModules.public': publicView,
            'dataModules.replayInputs': replayInputs, 'dataModules.actors': actorsOf,
            'dataModules.setup': prefix => {
                const installed = offers(), rows = [...installed];
                for (const [module, active] of Object.entries(prefix.domains?.dataModules?.active ?? {})) if (!rows.some(row => row.module === module)) {
                    const pin = prefix.domains.dataModules.pins[active.hash];
                    if (pin) rows.push({ ...copy(pin), hash: active.hash, module, ...(pin.packId === 'chat' ? { origin: B.origin } : {}) });
                }
                return rows.map(row => {
                    const active = prefix.domains?.dataModules?.active?.[row.module], pinned = activeDefinition(prefix, row.module);
                    let status = active ? 'Pinned' : 'Available', reason = '', additions = null, available = true;
                    if (active && !pinned) { status = 'Unsupported'; reason = 'Damaged or unknown interpreter pin; inspection only.'; }
                    else if (active && active.hash !== row.hash) {
                        const migration = validateDataMigration(pinned, row.definition);
                        status = migration.ok ? 'Migration available' : 'Unsupported';
                        reason = migration.ok ? '' : migration.errors[0].message;
                        additions = migration.ok ? dataModuleDefaults(migration.add) : null;
                    }
                    try { dependency(row.definition, prefix); } catch (error) { status = 'Waiting'; reason = error.message; available = false; }
                    const inputs = inputsOf(prefix, row.definition);
                    if (row.definition.timers.some(timer => inputs[timer.clock]?.minutes == null)) { status = 'Waiting'; reason ||= 'Story time has not been set.'; }
                    return { ...row, status, reason, additions, available, pinned: Boolean(active), pinnedDefinition: pinned ? copy(pinned) : null, subjects: active?.subjects ?? [],
                        actors: Object.values(actorsOf(prefix)), baseline: inputs, budgets: L };
                });
            },
            'dataModules.presentation': (prefix, { kind: name = 'screens', noTab = [] } = {}) => pinnedPresentation(prefix, name, Array.isArray(noTab) ? noTab : []) },
        hooks: { afterCapture: afterCapture, beforeGenerate: (view, info) => info?.commit === false ? undefined : due(view) },
        cards: blockCardSlots,
        context: {
            static: () => grammarFor(state()),
            tail: view => ({ lines: tailLines(view.state, typeof view.feature === 'function' ? view.feature(LEAN_RPG_FEATURE) === true : true), optional: [] }),
            // Tail room for the lines above: 100 tokens for each pinned module (300 for one with a role), on top of the core's own; none without a pin.
            extra: () => Object.keys(state()?.domains?.dataModules?.active ?? {}).slice(0, L.pins).reduce((sum, id) => sum + tailRoom(activeDefinition(state(), id)), 0),
        },
    };
}
