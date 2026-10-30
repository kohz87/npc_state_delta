// Trusted host glue for checked data, merged into story-block. Library discovery is read-only;
// every game-state write is a bus transaction, using detached pins and prefix witnesses.
import { DM_LIMITS as L, dmOwn, dmObject } from './schema.js';
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

const E = STRINGS.editMessages;
const B = STRINGS.blocks;

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

export function pinnedPresentation(state, kind = 'screens') {
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
            const block = blockTabScreen(definition);
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
        if (guard?.owner !== 'story-block' || guard.version !== 2 || !['dm.pin', 'dm.attach', 'dm.migrate', 'dm.act', 'dm.set', 'dm.tick', 'dm.define', 'dm.redefine', 'dm.remove'].includes(predicate?.kind)
            || !dmObject(recorded) || hashJson(recorded.source) !== hashJson(source)) return { ok: false, reason: 'Malformed data module guard.' };
        const domain = view.state.domains?.dataModules;
        if (predicate.kind === 'dm.pin' || predicate.kind === 'dm.define') {
            if (domain?.active?.[predicate.module] || recorded.pin.interpreter !== 1 || recorded.pin.definition.id !== predicate.module
                || hashOf(recorded.pin.definition) !== predicate.hash) return { ok: false, reason: 'Pin selection or checked definition changed.' };
            if (activeCount(domain) >= L.pins) return { ok: false, reason: 'Data module limit changed.' };
            if (predicate.kind === 'dm.define' && (recorded.pin.packId !== 'chat' || recorded.pin.packVersion !== '0' || recorded.pin.packHash !== null
                || recorded.pin.definition.pack !== 'chat' || predicate.module !== `pack.chat/${recorded.pin.definition.slug}` || recorded.pin.definition.scope !== 'chat'
                || blockCount(domain) >= L.definitions)) return { ok: false, reason: 'Block selection or chat limit changed.' };
            checkedTarget(recorded.pin.definition, view.state);
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
const fieldsText = fields => Object.entries(fields).map(([key, value]) => (value !== null && typeof value === 'object'
    ? `${key}: ${Object.entries(value).map(([name, item]) => `${name} ${valueText(item)}`).join(', ')}` : `${key} ${valueText(value)}`)).join('; ');

/** One module's state in plain words for the prompt's tail, at most 100 tokens: "Survival — Wessel: hunger 12; fatigue 6." */
export function summaryOf(state, module) {
    const definition = activeDefinition(state, module);
    if (!definition) return `${module} — unavailable (damaged or unknown pin).`;
    const view = moduleView(state, { module });
    let waiting = '';
    try { const inputs = inputsOf(state, definition); if (definition.timers.some(timer => inputs[timer.clock]?.minutes == null)) waiting = ' Waiting for story time.'; } catch { waiting = ' Waiting.'; }
    const body = definition.scope === 'chat' ? fieldsText(view.chat)
        : view.characters.map(({ id, name, ...fields }) => `${name}: ${fieldsText(fields)}`).join(' | ') || 'no one attached';
    // The host estimates tokens from UTF-16 length; cut on a character boundary within that budget.
    return cutAt(`${definition.name} — ${body}.${waiting}`, L.tailTokens * 4);
}
const tailLines = state => Object.keys(state?.domains?.dataModules?.active ?? {}).map(module => summaryOf(state, module));

export function createDataModulesPart({ packs, state: head = () => null, lifecycle = () => null, restore = () => ({ state: 'idle' }) } = {}) {
    // The runtime's late-bound readers may not exist yet while the definition registers: read as "no state" until they do.
    const state = () => { try { return head(); } catch { return null; } };
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
        const slots = Object.keys(definition.state).length + Object.values(definition.kinds).filter(kind => kind.ui).length;
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
        const recorded = guard(ctx, prefix, { kind: `dm.${action}`, module, hash, generation,
            reads: previous ? [['fields'], ['timers'], ['offers'], ['settled']] : [], imports: Object.keys(definition.imports),
            decision: { subjects: ['chat'], inputs, previous: old?.hash ?? null }, pin, bound: true });
        const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module, generation },
            summary: fill(action === 'define' ? B.defined : B.redefined, { name: definition.name }) });
        answer.data.edit = true;
        return answer;
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
        const args = parseLabels(definition, kind, labels, { text: Boolean(line) });
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, labels.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject)), inputs = inputsOf(prefix, definition);
        const claim = `dm:${pairKey(ctx.source)}:${module}:${labels.kind}:${subject}:${hashJson(kind.oncePerReply.map(key => args[key]))}`;
        if (!ctx.claim(claim)) refuse('CLAIMED', '', `${labels.kind} was already applied for this in this reply`);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        evaluation.timers();
        if (!evaluation.condition(['kind', labels.kind], kind.when, { arg: args })) refuse('DM_CONDITION', '', kind.refusal ?? 'Kind condition is not met.');
        evaluation.effects(kind.effects, { arg: args }); evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.act', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { args, inputs, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), conds: result.conds } });
        // The concrete outcome kept beside the inputs (and past the receipts' display data): which line, for whom, what was frozen, what was limited.
        const outcome = { kind: labels.kind, subject, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) };
        const answer = finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes, result: outcome, summary: `${definition.name}: ${kind.title ?? labels.kind}.` });
        if (ctx.cause === 'ui') answer.data.edit = true;
        return answer;
    }
    function setField(ctx, payload, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', E.fieldReader);
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), module = resolveModule(prefix, payload.module), definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', '', E.pinDamaged);
        dependency(definition, prefix);
        const schema = dmOwn(definition.state, payload.field) ? definition.state[payload.field] : null;
        if (!schema) refuse('DM_SCHEMA', 'field', E.fieldDeclared);
        if (schema.edit === false) refuse('REFUSED', 'field', E.fieldLocked);
        const map = schema.type === 'map';
        if (map && !schema.keys.includes(payload.key)) refuse('DM_SCHEMA', 'key', E.mapKeyDeclared);
        if (!map && payload.key !== undefined) refuse('DM_SCHEMA', 'key', E.fieldNoKeys);
        if (definition.scope === 'chat' && payload.who !== undefined) refuse('DM_LABEL', 'who', E.fieldShared);
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, payload.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject));
        const field = map ? schema.values : schema, path = map ? [payload.field, payload.key] : [payload.field];
        let value = payload.value;
        if (field.list === true) value = cleanList(value, field.max);
        else if (field.type === 'text' && typeof value === 'string') value = [...oneLine(value)].slice(0, field.max).join('');
        if (!scalarHolds(field, value)) refuse('DM_BOUNDS', 'value', E.fieldRange);
        const before = atPath(instance.fields, path);
        const inputs = inputsOf(prefix, definition);
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject });
        evaluation.effects([{ op: 'set', path, value }]);
        evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.set', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition), actor: subject !== 'chat',
            decision: { inputs, conds: result.conds } });
        const label = map ? `${schema.label ?? payload.field} (${payload.key})` : schema.label ?? payload.field;
        const summary = fill(E.fieldSet, { module: definition.name, field: label, from: valueText(before), to: valueText(value) });
        const answer = finish(ctx, prefix, draft, recorded, { visits: result.visits, notes: result.notes,
            result: { field: payload.field, ...(map ? { key: payload.key } : {}), subject, from: before, to: value, ...(result.fired.length ? { rules: result.fired } : {}) }, summary });
        answer.data.edit = true;
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
                if (definition.timers.some(timer => {
                    const minute = inputs[timer.clock]?.minutes, last = instance?.timers?.[timer.id]?.lastMinute;
                    return minute !== null && minute !== undefined && (last === null || last === undefined || minute > last);
                })) commands.push({ type: 'dm.tick', payload: { module, subject } });
            }
        }
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
            'dm.tick': { internal: true, handler: wrap(tick) } },
        kinds: { dm: kind },
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
            'dataModules.presentation': (prefix, { kind: name = 'screens' } = {}) => pinnedPresentation(prefix, name) },
        hooks: { afterCapture: due, beforeGenerate: (view, info) => info?.commit === false ? undefined : due(view) },
        context: {
            static: () => grammarFor(state()),
            tail: view => ({ lines: tailLines(view.state), optional: [] }),
            // Tail room for the lines above: 100 tokens for each pinned module, on top of the core's own; none without a pin.
            extra: () => Math.min(Object.keys(state()?.domains?.dataModules?.active ?? {}).length, L.pins) * L.tailTokens,
        },
    };
}
