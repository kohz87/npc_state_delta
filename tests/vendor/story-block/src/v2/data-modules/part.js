// Trusted host glue for checked data, merged into story-block. Library discovery is read-only;
// every game-state write is a bus transaction, using detached pins and prefix witnesses.
import { DM_LIMITS as L, dmOwn, dmObject, dmHidden, dmKindWritesHidden, dmNameOf, dmDefaultTone } from './schema.js';
import { validateDataModules, validateDataMigration, dataModuleDefaults, dataModuleHash, dataModulesPackHash } from './check.js';
import { copy, bytes, refuse, DataModuleError, createEvaluation, parseLabels, atPath, scalarHolds, cleanList, orList, conditionHolds, titlePart, carryEntries } from './interpreter.js';
import { activeDefinition, actorsOf, inputsOf, instanceOf, publicView, projectImport, resolveActor } from './adapters.js';
import { hashJson } from '../replay.js';
import { diff } from '../ops.js';
import { moduleGrammar, referenceOf } from './grammar.js';
import { cutAt, oneLine } from '../../text.js';
import { editableLayout } from './editable-layout.js';
import { STRINGS, fill } from '../strings.js';
import { blockTabScreen } from './block-screen.js';
import { roleTail } from '../lean-rpg/tail.js';
import { LEAN_RPG_FEATURE, practiceFromRollsOnly } from '../lean-rpg/names.js';
import { barOf, sizeOf as barSizeOf, spreadWord, wordsOf } from '../lean-rpg/blocks.js';
import { fold, readSheet } from '../lean-rpg/read.js';
// (foes.js and levels.js are small and need nothing of the RPG's library: they stay static, like read.js)
import { averageLevel, bandOfRank, foeRandom, foeLevelCap, levelOf, partyLevels, pickLevel } from '../lean-rpg/foes.js';
import { XP_RATE, packLevelsOf, scaleXp, xpRateFrom } from '../lean-rpg/levels.js';
import { CLASS_NAMES } from '../lean-rpg/names.js';
import { SKILL_SLOTS_BASE, SKILL_SLOTS_EVERY, SKILL_SLOTS_MAX, signatureAt, skillSlots } from '../skill-slots.js';
// The companions who join, the rules they are made with and their words are the RPG's library, loaded only when it is needed (rpg-lazy.js).
import { rpgLib } from '../rpg-lazy.js';
import { castGearOf, gearLine } from '../packs/cast-gear.js';
import { castSkillsOf } from '../packs/cast-skills.js';
import { gearOn } from '../domains/inventory.js';
import { actorIdOf } from '../lean-rpg/roster.js';
import { placeOf } from '../domains/gear.js';
const PRACTICE_KIND = new RegExp(`^practice-[1-${SKILL_SLOTS_MAX}]$`, 'u');

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

/**
 * The static lines for the pinned modules (empty without a pin); they change only when a pin does, and (the RPG on) with a quiet reply
 * (`quiet`, the RPG's QUIET_GRAMMAR table, lean-rpg/quiet.js: no combat text and only the opening Foes line). A long list of values (the health words) is told once.
 */
export function grammarFor(state, quiet = null, { rolled = false } = {}) {
    // `rolled` (the RPG on, Rolls automatic): skill practice comes only from rolled uses, so the narrator is not offered `practice-N` and the texts
    // that told it to practise a skill say nothing of it (the Combat rules' XP guide line, the Skills block's description).
    const noPractice = text => String(text ?? '').replace(/\s*Practice a skill 5 to 20 per use\./u, '').replace(/\s+and adds practice/u, '');
    const active = Object.keys(state?.domains?.dataModules?.active ?? {});
    const seen = new Map();
    const lines = active.map(id => {
        const definition = activeDefinition(state, id);
        const only = quiet && definition?.role ? quiet[definition.role] : null;
        if (definition && only?.skip) {
            // (A skipped block may keep one line of its text: the XP guide stays on a quiet reply, whatever words the pinned block holds it in.)
            const kept = only.keep ? new RegExp(only.keep.source, 'u').exec(String(definition.prompt ?? ''))?.[0] : '';
            return kept ? oneLine(rolled ? noPractice(kept) : kept) : '';
        }
        const shown = definition && rolled && (definition.role === 'rules' || definition.role === 'skills') ? { ...definition, prompt: noPractice(definition.prompt) } : definition;
        return shown ? moduleGrammar(shown, referenceOf(active, id), { seen, ...(only ?? {}), ...(rolled && definition.role === 'skills' ? { without: /^practice-\d+$/u } : {}) }) : '';
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
            if (join && (!Array.isArray(more) || more.length < 1 || more.length > 1 + (rpgLib()?.RPG_EXTRAS.length ?? Infinity) || !more.every(dmObject))) return { ok: false, reason: 'Malformed data module guard.' };
            if (domain?.active?.[predicate.module] || recorded.pin.interpreter !== 1 || recorded.pin.definition.id !== predicate.module
                || hashOf(recorded.pin.definition) !== predicate.hash) return { ok: false, reason: 'Pin selection or checked definition changed.' };
            if (activeCount(domain) + more.length >= L.pins) return { ok: false, reason: 'Data module limit changed.' };
            const chatBlock = (pin, module) => pin?.packId === 'chat' && pin.packVersion === '0' && pin.packHash === null && pin.definition?.pack === 'chat'
                && module === `pack.chat/${pin.definition.slug}` && pin.definition.scope === 'chat';
            if ((predicate.kind !== 'dm.pin' && (!chatBlock(recorded.pin, predicate.module) || blockCount(domain) + more.length >= L.definitions))) return { ok: false, reason: 'Block selection or chat limit changed.' };
            // A companion joined a story that had blocks: if every one of them is gone (a delete or swipe of the reply that made them), the join is skipped
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

const valueText = value => (typeof value === 'string' ? JSON.stringify(oneLine(value)) : Array.isArray(value) ? `${value.length} ${value.length === 1 ? 'entry' : 'entries'}` : String(value));
// A List of entries in the tail, short: each entry by its number and title and then its choices and numbers ("1 \"Find the key\" active; 2 \"Meet Wren\" done"),
// never its longer texts. The story needs the numbers and titles to name an entry, and what is still open. When the list does not fit `room` (characters), the
// open entries (by the status role's tone: not done or failed) come first, then the finished ones, each newest first; an entry is never cut in the middle, and
// the line ends "+N more". The entries shown keep their numbers and their order.
const entriesText = (definition, key, list, room = L.listTailTokens * 4) => {
    const schema = definition.state[key], parts = Object.entries(schema.of), title = titlePart(definition, key);
    const status = definition.roles?.field === key ? definition.roles.status : null;
    const pieces = list.map((entry, at) => [`${at + 1}`, title ? valueText(entry[title]) : null, ...parts.filter(([part, sub]) => part !== title && sub.type !== 'text').map(([part]) => String(entry[part]))].filter(Boolean).join(' '));
    const open = at => !status || ['active', 'neutral'].includes(definition.tones?.[list[at][status]] ?? dmDefaultTone(list[at][status]));
    // (newest first within each: when entries must go behind "+N more" the oldest are the ones hidden)
    const order = [...list.keys()].filter(open).reverse().concat([...list.keys()].filter(at => !open(at)).reverse());
    const budget = room - `${key}: `.length;
    const shown = [];
    let used = 0;
    for (const at of order) {
        const more = order.length - shown.length - 1 > 0 ? `; +${order.length - shown.length - 1} more`.length : 0;
        if (shown.length && used + pieces[at].length + 2 + more > budget) break;
        shown.push(at);
        used += pieces[at].length + 2;
    }
    const hidden = list.length - shown.length;
    return `${key}: ${shown.length ? `${shown.sort((a, b) => a - b).map(at => pieces[at]).join('; ')}${hidden ? `; +${hidden} more` : ''}` : 'none'}`;
};
// A number whose field has display names is shown (to a person and to the story) by its name; stored, it stays the number.
// The Standard formula's bars (a field with `blocks`) have no fixed names: their stage word depends on the bar's size, which `at` ({ fields, key }, the
// block's fields as they were then) gives; without it the number shows, as for any number.
const barText = (schema, value, at) => {
    const size = barSizeOf(schema, at.fields, at.key);
    return Number.isSafeInteger(value) ? spreadWord(wordsOf(barOf(schema)), Math.min(size, Math.max(0, value)), size) : valueText(value);
};
const shownText = (schema, value, at = null) => dmNameOf(schema, value) ?? (at && barOf(schema) ? barText(schema, value, at) : valueText(value));
// A hidden field (`prompt: false`) is left out: the story is never told it.
const fieldText = (definition, key, value, room) => (Array.isArray(value) ? entriesText(definition, key, value, room) : value !== null && typeof value === 'object'
    ? `${key}: ${Object.entries(value).map(([name, item]) => `${name} ${valueText(item)}`).join(', ')}` : `${key} ${shownText(definition.state[key], value)}`);
// (`room`: the characters the line may take; a List of entries takes what the other fields leave)
const fieldsText = (definition, fields, room = Infinity) => {
    const shown = Object.entries(fields).filter(([key]) => !dmHidden(definition.state[key]));
    const lists = shown.filter(([, value]) => Array.isArray(value)).length;
    const left = lists ? (room - shown.filter(([, value]) => !Array.isArray(value)).reduce((sum, [key, value]) => sum + fieldText(definition, key, value).length + 2, 0)) / lists : 0;
    return shown.map(([key, value]) => fieldText(definition, key, value, lists ? Math.max(0, Math.floor(left)) : undefined)).join('; ');
};
// The named fields a root changed, for its summary: "Soul Class II → III". Empty for a block with no display names.
const namedChanges = (definition, before, after) => Object.entries(definition.state).filter(([key, schema]) => (schema.names || barOf(schema)) && before[key] !== after[key])
    .map(([key, schema]) => `${schema.label ?? key} ${shownText(schema, before[key], { fields: before, key })} → ${shownText(schema, after[key], { fields: after, key })}`);

// What a module may take of the prompt's tail: 100 tokens, 300 for a block with a `role` (the RPG's sheets carry text the story reads).
// `rpg` is whether the RPG feature is on: a block with a role is the RPG's to write only then; with it off the block is told like any other.
// A Skills block may say 47 tokens more for each skill it holds past five (the longest line one skill makes: a 40-character name and 120 of text, measured at 188
// characters); a slot that holds no skill reserves nothing. `fields` is the block's fields (none: nothing is held).
export const tailRoom = (definition, rpg = true, fields = null) => {
    if (!(rpg && definition?.role)) return Object.values(definition?.state ?? {}).some(schema => schema?.type === 'entries') ? L.listTailTokens : L.tailTokens;
    const held = definition.role === 'skills' && fields ? Array.from({ length: SKILL_SLOTS_MAX }, (_, i) => fields[`skill${i + 1}`]).filter(name => typeof name === 'string' && name.trim()).length : 0;
    return L.roleTailTokens + L.skillTailTokens * Math.max(0, held - SKILL_SLOTS_BASE);
};

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
        return line && cutAt(`${line}${waiting}`, tailRoom(definition, rpg, view.chat) * 4);
    }
    const limit = tailRoom(definition, rpg) * 4;
    const room = limit - definition.name.length - 4 - waiting.length;
    const body = definition.scope === 'chat' ? fieldsText(definition, view.chat, room)
        : view.characters.map(({ id, name, ...fields }) => `${name}: ${fieldsText(definition, fields, Math.floor(room / view.characters.length) - name.length - 2)}`).join(' | ') || 'no one attached';
    // The host estimates tokens from UTF-16 length; cut on a character boundary within that budget.
    return cutAt(`${definition.name} — ${body}.${waiting}`, limit);
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
    function finish(ctx, prefix, draft, data, { pin = false, visits = 0, summary, notes = [], replan = false, result = null, xpFrom = null, practiceFrom = null, listsFrom = null } = {}) {
        const key = pairKey(ctx.source), standing = ctx.standing?.domains?.dataModules?.perReply?.[key];
        const actions = { ...(draft.perReply[key]?.actions ?? {}) };
        // `xpFrom` (the RPG's fight XP, lean-rpg/fight.js): what a character's xp, soul and points were before the first story line of this reply that wrote
        // XP, by block. The first line's is kept; later actions of the reply carry it on.
        const rises = { ...(xpFrom ?? {}), ...(draft.perReply[key]?.xpFrom ?? {}) };
        // `practiceFrom`: the practice and rank of a skill slot before the first story line of this reply that practised it, by block and slot (the RPG's practice by
        // code puts them back, lean-rpg/practice.js). The first line's is kept.
        const slots = {};
        for (const module of new Set([...Object.keys(practiceFrom ?? {}), ...Object.keys(draft.perReply[key]?.practiceFrom ?? {})])) slots[module] = { ...(practiceFrom?.[module] ?? {}), ...(draft.perReply[key]?.practiceFrom?.[module] ?? {}) };
        for (const [id, action] of Object.entries(standing?.actions ?? {})) if (action.click) actions[id] ??= action;
        actions[ctx.cursor().block] = { visits, click: ctx.cause === 'ui' && !pin };
        // `listsFrom`: where each entry of a List of entries stood when this reply began, by block, subject and field ({ size, at: [original index or null] }), so that
        // a number in `at` always means the entry as the story saw it, whatever the reply's earlier lines dropped.
        const lists = listsFrom ?? draft.perReply[key]?.lists;
        const next = { roots: Object.keys(actions).length, visits: Object.values(actions).reduce((n, action) => n + action.visits, 0), actions, ...(Object.keys(rises).length ? { xpFrom: rises } : {}), ...(Object.keys(slots).length ? { practiceFrom: slots } : {}),
            ...(lists && Object.keys(lists).length ? { lists } : {}) };
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
            // A Character who is gone leaves nothing filed under their actor (a block made later under the same name would inherit it): their pieces go to the
            // party's bag, plain, and what was set aside for them with them (inventory.release). Nothing runs when they held nothing.
            if (previous.role === 'character') {
                const owner = actorIdOf(module);
                let inventory = null;
                try { inventory = ctx.read('inventory'); } catch { inventory = null; }
                if (Object.values(inventory?.stacks ?? {}).some(stack => stack.owner === owner) || (inventory?.kept && Array.isArray(inventory.kept[owner]))) {
                    const out = ctx.call('inventory.release', { owner });
                    if (out?.data?.items?.length) { answer.summary = `${answer.summary} ${out.summary}`; answer.data.gear = { owner, released: out.data.items }; }
                }
            }
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
            for (const [field, schema] of Object.entries(definition.state)) {
                // A List of entries is carried part by part, so that adding, removing or renaming a part never empties it; a Most entries below the count is refused.
                if (schema.type === 'entries' && previous.state[field]?.type === 'entries') {
                    const carried = carryEntries(schema, fields[field]);
                    if (!carried) refuse('DM_BOUNDS', 'fields', fill(B.listShrinks, { name: schema.label ?? field, n: fields[field].length }));
                    instance.fields[field] = carried;
                } else if (previous.state[field]?.type === schema.type && scalarHolds(schema, fields[field])) instance.fields[field] = copy(fields[field]);
            }
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
        // "Edit first" on an Ask card makes the Skills block with the pack's signature skills marked in it (wizard-data.js): the receipt tells it as a join, tiles included.
        const signed = action === 'define' && definition.role === 'skills' ? defaultSeeds(definition.state) : [];
        if (signed.length && typeof definition.state.who?.default === 'string' && definition.state.who.default) {
            answer.data.join = { op: 'added', name: definition.state.who.default };
            answer.data.sigSkills = seededData(signed);
            answer.summary = `${answer.summary} ${fill(J.skillsSeeded, { n: signed.length })}`;
        }
        return answer;
    }
    // ---- companions who join (lean-rpg/join.js): `+ party` makes a Character and an empty Skills block as ONE guarded action ('dm.join'), `- party` sets `left` ----
    function makeParty(ctx, request, soul, call, { added = false } = {}) {
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), domain = prefix.domains.dataModules;
        // (the formula and numbers in force: the reader's settings, else what the story's pack asks for, as the roll planner reads them)
        let pack = null;
        const rpgRecords = (packs?.packs?.() ?? []).flatMap(entry => entry?.content?.rpg ?? []);
        try { pack = rpg().packRulesOf(rpgRecords); } catch { pack = null; }
        const rules = rpg().rulesFromSettings(settings(), pack);
        // (a companion starts under the story's level cap: the pack's ranks record names one, else the reader's setting, else 99)
        // (a Re-read of a join made before the signature skills: the block that reply made had five slots and no mark, so it is built that way and seeds nothing)
        const earlier = standingBlock(ctx, request.name), legacy = Boolean(earlier) && !Object.hasOwn(earlier.definition.state ?? {}, 'sig');
        const seeds = legacy ? [] : castSeeds(ctx, request.name, 'join');
        const made = rpg().joinDefinitions({ ...request, skills: seeds }, { used: Object.keys(domain?.active ?? {}), soul, rules, cap: rpg().levelCapFor(settings(), packLevelsOf(rpgRecords)?.levelCap), legacy });
        // The story's first character also brings the Combat rules and Foes blocks it lacks, as far as they fit (nothing is refused for them).
        const first = rpg().partyOf(prefix).length === 0, plan = first ? rpg().extrasPlan(prefix) : { add: [], skipped: [] };
        const extras = rpg().extraDefinitions(plan.add, { used: [...Object.keys(domain?.active ?? {}), made.character.slug, made.skills.slug], formula: rpg().isStandard(rules) ? 'standard' : 'classic' });
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
        const left = plan.skipped.length ? ` ${fill(J.noExtras, { list: plan.skipped.map(item => rpg().extraName(item.role)).join(', ') })}` : '';
        const answer = finish(ctx, prefix, draft, recorded, { pin: true, result: { module: head.definition.id, skills: rest[0].definition.id },
            summary: `${fill(J.joined, { name: request.name })}${left}` });
        answer.data.join = { op: 'added', name: request.name };
        if (seeds.length) {
            answer.data.sigSkills = seededData(seeds);
            answer.summary = `${answer.summary} ${fill(J.skillsSeeded, { n: seeds.length })}`;
        }
        return giveGear(ctx, answer, request.name, head.definition.id);
    }
    // ---- a cast member's signature skills (cast.js `skills`, RPG.md "Signature skills") ----
    // Seeded only when the member JOINS (or comes back): the skills fill free slots, marked in the Skills block's `sig`, and what was seeded is written in the join's
    // receipt (`data.sigSkills`). Members who joined before the pack had skills keep what they have; nothing is added later by an update of the pack. A Re-read of
    // the join reply plans it again from what the reply itself seeded (`ctx.standing`, the reply as it stood), never from the pack as it is now.
    // The Skills block of the person called `who` in a state: { module, definition, fields } or null.
    function skillsBlockOf(state, who) {
        const domain = state?.domains?.dataModules;
        for (const module of Object.keys(domain?.active ?? {})) {
            const definition = activeDefinition(state, module), fields = instanceOf(state, module)?.fields;
            if (definition?.role === 'skills' && fields && typeof fields.who === 'string' && fold(fields.who) === fold(who)) return { module, definition, fields };
        }
        return null;
    }
    const skillCapacity = definition => Math.min(SKILL_SLOTS_MAX, Object.keys(definition?.state ?? {}).filter(key => /^skill\d+$/u.test(key)).length);
    const skillRow = (fields, n) => ({ name: fields[`skill${n}`], about: typeof fields[`about${n}`] === 'string' ? fields[`about${n}`] : '', stat: fields[`stat${n}`], uses: fields[`uses${n}`] ?? 'stamina', rank: Number.isSafeInteger(fields[`rank${n}`]) ? fields[`rank${n}`] : 0 });
    // The Skills block of `name` in the state a Re-read's reply stands in (ctx.standing), or null.
    const standingBlock = (ctx, name) => (ctx.standing ? skillsBlockOf({ domains: { dataModules: ctx.standing.domains?.dataModules } }, name) : null);
    // The signature skills a Skills block's definition was made with: the slots marked in `sig.default`, as the defaults of their fields have them.
    function defaultSeeds(state) {
        const bits = Number.isSafeInteger(state?.sig?.default) ? state.sig.default : 0, rows = [];
        for (let n = 1; n <= SKILL_SLOTS_MAX; n += 1) {
            const name = state?.[`skill${n}`]?.default;
            if (signatureAt(bits, n) && typeof name === 'string' && name) rows.push(skillRow(Object.fromEntries(['skill', 'about', 'stat', 'uses', 'rank'].map(key => [`${key}${n}`, state[`${key}${n}`]?.default])), n));
        }
        return rows;
    }
    // The skills the pack gives `name` now, the ones the person does not hold by name already (what a first read of a join, a return or an offer plans).
    function packSeeds(ctx, name) {
        const held = skillsBlockOf(stateOf(ctx), name);
        const have = new Set(Array.from({ length: SKILL_SLOTS_MAX }, (_, i) => fold(held?.fields?.[`skill${i + 1}`] ?? '')).filter(Boolean));
        let found = null;
        try { found = castSkillsOf(packs?.packs?.() ?? [], name); } catch { found = null; }
        return (found?.skills ?? []).filter(skill => !have.has(fold(skill.name)));
    }
    // The skills to seed for `name` on this join (`mode` 'join') or return ('back'): [{ name, about, stat, uses, rank }], the ones the person does not hold by name already.
    // A Re-read plans what its reply seeded, never what the pack says now: a join reads it from the definition defaults of the Skills block the reply pinned (the bits
    // of `sig.default`, which the reader's pencil never touches); a return, which wrote the skills into the fields, reads the marked slots of the reply as it stood. A block
    // without the mark was made before the signature skills (2.22) and seeded nothing.
    function castSeeds(ctx, name, mode = 'join') {
        if (!ctx.standing) return packSeeds(ctx, name);
        const held = skillsBlockOf(stateOf(ctx), name);
        const have = new Set(Array.from({ length: SKILL_SLOTS_MAX }, (_, i) => fold(held?.fields?.[`skill${i + 1}`] ?? '')).filter(Boolean));
        const after = standingBlock(ctx, name);
        if (!after || !Object.hasOwn(after.definition.state ?? {}, 'sig')) return [];
        if (mode === 'join') return defaultSeeds(after.definition.state).filter(skill => !have.has(fold(skill.name)));
        // A return plans the rows its own receipt recorded (`data.sigSkills`: what was seeded, before the reader's pencil changed a name or a description in the
        // slot); only a reply that recorded none is planned from the marked slots as they stand.
        const recorded = (ctx.standingReceipts ?? []).filter(receipt => receipt?.data?.join?.op === 'back' && fold(receipt.data.join.name ?? '') === fold(name)).flatMap(receipt => (Array.isArray(receipt.data.sigSkills) ? receipt.data.sigSkills : []))
            .filter(row => dmObject(row) && typeof row.name === 'string' && row.name);
        if (recorded.length) return recorded.filter(row => !have.has(fold(row.name))).map(row => ({ name: row.name, about: typeof row.about === 'string' ? row.about : '', stat: row.stat, uses: row.uses ?? 'stamina', rank: Number.isSafeInteger(row.rank) ? row.rank : 0 }));
        const rows = [];
        for (let n = 1; n <= SKILL_SLOTS_MAX; n += 1) if (typeof after.fields[`skill${n}`] === 'string' && after.fields[`skill${n}`] && signatureAt(after.fields.sig, n) && !have.has(fold(after.fields[`skill${n}`]))) rows.push(skillRow(after.fields, n));
        return rows;
    }
    // The tiles of the join's receipt and its summary words.
    const seededData = seeds => seeds.map(skill => ({ name: skill.name, about: skill.about, stat: skill.stat, uses: skill.uses, rank: skill.rank }));
    // Coming back: the seeds go into the free slots of the Skills block the person already has.
    function reseed(ctx, answer, name) {
        const prefix = stateOf(ctx), block = skillsBlockOf(prefix, name);
        if (!block) return answer;
        const seeds = castSeeds(ctx, name, 'back');
        if (!seeds.length) return answer;
        // A block made before the signature mark (or the extra slots) is extended first, so the skills can be marked (growSkills).
        let definition = block.definition;
        if (!Object.hasOwn(definition.state ?? {}, 'sig') || skillCapacity(definition) < SKILL_SLOTS_MAX) definition = growSkills(ctx, prefix, draftOf(ctx), block.module) ?? definition;
        const fields = atPath(draftOf(ctx), instancePath(block.module, 'chat')).fields, capacity = skillCapacity(definition), marks = Object.hasOwn(definition.state ?? {}, 'sig');
        const placed = [];
        for (const skill of seeds) {
            const slot = Array.from({ length: capacity }, (_, i) => i + 1).find(n => !fields[`skill${n}`]);
            if (!slot) { answer.problem = [answer.problem, `${name}'s ${skill.name} has no free skill slot.`].filter(Boolean).join(' '); continue; }
            Object.assign(fields, { [`skill${slot}`]: skill.name, [`about${slot}`]: skill.about, [`stat${slot}`]: skill.stat, [`uses${slot}`]: skill.uses, [`rank${slot}`]: skill.rank, [`practice${slot}`]: 0 });
            if (marks) fields.sig = (Number.isSafeInteger(fields.sig) ? fields.sig : 0) + 2 ** (slot - 1);
            placed.push(skill);
        }
        if (placed.length) {
            answer.data.sigSkills = seededData(placed);
            answer.summary = `${answer.summary} ${fill(J.skillsSeeded, { n: placed.length })}`;
        }
        return answer;
    }
    // The party actor of the Character block `module` (`party.actors`: the one whose ID is the block's, which a rename never changes), else, when a module of
    // another make answers the roster, the one of that name; 'party' when nothing answers or no one is so. The joiner's own block is in the roster at once
    // (the draft is what the query reads), so a join finds their actor in the same receipt.
    function gearOwnerOf(ctx, name, module = null) {
        try {
            const actors = (v => (Array.isArray(v) ? v : []))(ctx.query('party.actors'));
            const own = module ? actors.find(entry => typeof entry?.id === 'string' && entry.id === actorIdOf(module)) : null;
            const actor = own ?? actors.find(entry => typeof entry?.id === 'string' && fold(entry.name) === fold(name));
            if (actor) return actor.id;
        } catch { /* no roster */ }
        return 'party';
    }
    // A cast member's signature gear (cast.js `gear`, GEAR.md): with `story-block.gear` on, the joining person's pack items are added to the
    // inventory owned by them (the party's actor of that name; with none, nothing is given) and put on, through the inventory's own commands, so
    // the items are part of the join's one receipt. A command that fails inside another fails the whole receipt (the join with it), so everything that
    // could be refused is checked first here, never tried: each piece is looked up by its definition ID (a story item of the same name never gets in
    // the way), what they already own is not added again, a slot that is taken is left as it is (the piece is carried, not worn), and a piece that
    // cannot be found goes to the Problems list. The pieces are BOUND to the member (`bound: true`: GEAR.md "Signature gear"). Coming back, what left with them
    // (inventory.stow, in `leave`) was restored before this (restoreKept), once, and counts as owned. Gear off, or no gear: nothing here runs and the answer is untouched.
    // What a member left with (inventory.kept) comes back whenever they return, whatever the gear switch or the pack say now: found by their actor,
    // else by the block it was set aside for (a member renamed while away). → { owner, pieces } or null.
    function restoreKept(ctx, person) {
        let kept = null;
        try { kept = ctx.read('inventory')?.kept; } catch { kept = null; }
        if (!kept || typeof kept !== 'object') return null;
        const named = gearOwnerOf(ctx, person.name, person.module);
        const owner = Array.isArray(kept[named]) ? named : Object.keys(kept).find(id => Array.isArray(kept[id]) && kept[id].some(entry => entry?.by === person.module));
        if (!owner) return null;
        const back = ctx.call('inventory.restore', { owner });
        const pieces = Array.isArray(back?.data?.pieces) ? back.data.pieces : [];
        return pieces.length ? { owner, pieces } : null;
    }
    function giveGear(ctx, answer, name, module = null, back = null) {
        if (!gearOn(ctx)) return answer;
        let found = null;
        try { found = castGearOf(packs?.packs?.() ?? [], name); } catch { found = null; }
        if (!found?.items.length) return answer;
        const owner = back?.owner ?? gearOwnerOf(ctx, name, module);
        // No actor of their own (nothing answers `party.actors`): the shared bag's worn gear is the reader's Character's, so nothing is given at all; it stays with them.
        if (owner === 'party') {
            answer.problem = [answer.problem, `${found.name}'s gear stays with ${found.name} (no party roster).`].filter(Boolean).join(' ');
            return answer;
        }
        const inventory = ctx.read('inventory');
        const stacks = Object.values(inventory?.stacks ?? {}).filter(stack => stack.owner === owner);
        const taken = new Set(stacks.map(stack => stack.equipped).filter(Boolean));
        const held = new Set(stacks.map(stack => stack.def));
        // Their bound pieces that left with them come back first (once, in the condition they left in, worn where they were when the slot is free),
        // so they are what they "still own" below; the read above is the state before this action, so what came back is added by hand.
        const added = [], notes = [];
        for (const piece of back?.pieces ?? []) {
            held.add(piece.def);
            if (piece.equipped) taken.add(piece.equipped);
            added.push(piece.name);
        }
        let packed = [];
        try { packed = ctx.query('packs.itemDefs', { ids: found.items.map(item => item.id) }); } catch { packed = []; }
        for (const item of found.items) {
            if (held.has(item.id)) continue;
            // (the def by its ID: the chat's own when it already has it, else the pack's, which the grant defines)
            const def = inventory?.defs?.[item.id] ? item.id : (Array.isArray(packed) ? packed : []).find(entry => entry?.id === item.id);
            if (!def) { notes.push(`${found.name}'s ${item.name} could not be found in the pack, so it was not given.`); continue; }
            const places = item.slot === 'accessory' ? ['accessory-1', 'accessory-2'] : [placeOf(item.slot)];
            const place = places.find(key => !taken.has(key));
            const given = ctx.call('inventory.grant', { def, qty: 1, owner, bound: true });
            const stack = given?.data?.stacks?.[0];
            if (!stack) { added.push(item.name); continue; }
            if (place) {
                const worn = ctx.call('item.equip', { stack, owner, slot: place });
                taken.add(worn?.data?.place ?? place);
            } else notes.push(`${found.name}'s ${item.name} is carried, not worn: the ${item.slot} slot is taken.`);
            added.push(item.name);
        }
        if (notes.length) answer.problem = [answer.problem, ...notes].filter(Boolean).join(' ');
        if (!added.length) return answer;
        answer.summary = `${answer.summary} ${gearLine(found.items.filter(item => added.includes(item.name)))}.`;
        answer.data.gear = { owner, items: added };
        return answer;
    }
    function party(ctx, line, call = {}) {
        if (ctx.cause !== 'story' || ctx.caller !== null) refuse('REFUSED', '', J.storyOnly);
        const prefix = stateOf(ctx);
        const read = rpg().readJoin(line, rpg().soulNaming(prefix));
        call.label = 'Party';
        if (read.error) refuse('DM_LABEL', '', read.error);
        if (read.op === '-') {
            const person = rpg().partyOf(prefix).find(entry => fold(entry.name) === fold(read.name));
            if (!person || person.left) refuse('DM_SCHEMA', '', fill(J.nothing, { name: read.name }));
            // The player's own character (the one named like the persona) never leaves: companions only.
            if (isReader(person.name)) refuse('REFUSED', '', fill(J.isYou, { name: person.name }));
            return leave(ctx, person, true, call);
        }
        const check = rpg().checkJoin(prefix, read);
        if (!check.ok) refuse('REFUSED', '', check.why);
        if (check.returning) return leave(ctx, check.returning, false, call);
        if (rpg().joinMode(settings()) === 'ask') {
            // Ask: nothing is made. The line is kept in this reply's own receipt, and the card under the reply (rpg.joins) is read from it.
            // (the pack as it is when the line is read, also on a Re-read: an offer changes nothing in the story's state, so there is no block to read it from)
            const seeds = packSeeds(ctx, read.name);
            const offer = { op: 'offer', name: read.name, about: read.about, soul: read.soul, best: read.best, ...(seeds.length ? { skills: seeds } : {}) };
            return { summary: fill(J.offerNote, { name: read.name }), narrate: false, data: { join: offer } };
        }
        return makeParty(ctx, read, check.soul, call);
    }
    // Left (or back): the Character block's `left` field, one guarded `dm.set`. A sheet made before the field existed cannot be marked.
    function leave(ctx, person, left, call) {
        const definition = activeDefinition(stateOf(ctx), person.module);
        if (!person.canLeave || !definition) refuse('DM_SCHEMA', '', fill(J.noLeave, { name: person.name }));
        // (their actor is found before the field changes: a member who left is no longer on the roster)
        const owner = left && gearOn(ctx) ? gearOwnerOf(ctx, person.name, person.module) : 'party';
        const answer = setField(ctx, { module: person.module, field: 'left', value: left }, call, { story: true });
        answer.summary = fill(left ? J.left : J.returned, { name: person.name });
        answer.data.join = { op: left ? 'left' : 'back', name: person.name };
        // With gear on, the pieces bound to them leave with them, in this receipt (they come back once when they return: giveGear).
        if (owner !== 'party') {
            const away = ctx.call('inventory.stow', { owner, module: person.module });
            const items = Array.isArray(away?.data?.items) ? away.data.items : [];
            if (items.length) {
                answer.summary = `${answer.summary} ${fill(J.gearLeaves, { items: items.join(', ') })}`;
                answer.data.gear = { owner, away: items };
            }
        }
        if (left) return answer;
        reseed(ctx, answer, person.name);
        const back = restoreKept(ctx, person);
        const out = giveGear(ctx, answer, person.name, person.module, back);
        // (giveGear stops early when gear is off or the cast no longer knows them: what came back is still said)
        if (back && !out.data.gear) {
            const names = back.pieces.map(piece => piece.name);
            out.summary = `${out.summary} ${gearLine(names.map(name => ({ name })))}.`;
            out.data.gear = { owner: back.owner, items: names };
        }
        return out;
    }
    // "Add to party" on the Ask card: the reader's own go-ahead, so it is made like the automatic one, for the head reply.
    function addParty(ctx, payload, call = {}) {
        if (ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', J.cardOnly);
        const soul = payload?.soul === undefined ? 1 : payload.soul;
        const request = rpg().readJoin({ op: '+', name: payload?.name, labels: { about: payload?.about, class: Number.isSafeInteger(soul) ? CLASS_NAMES[soul - 1] ?? 'X' : 'X', best: payload?.best ?? '' } }, rpg().soulNaming(stateOf(ctx)));
        call.label = 'Party';
        if (request.error) refuse('DM_LABEL', '', request.error);
        const check = rpg().checkJoin(stateOf(ctx), request);
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
    // A story line with no `kind:` (a model often leaves it out, or puts a label like `letter: F` where `kind: promote` belongs): when exactly
    // one kind of this module, written with the line's op, accepts the line's labels as they are, that is its kind; with none or several
    // the line is refused as before (kind must be …), never guessed. → the line's labels, with `kind` added when it was found.
    function withKind(definition, line) {
        const labels = line.labels ?? {};
        if (dmOwn(labels, 'kind')) return labels;
        const fits = Object.keys(definition.kinds).filter(name => {
            if (definition.kinds[name].op !== line.op) return false;
            try { parseLabels(definition, definition.kinds[name], { ...labels, kind: name }, { text: true }); return true; } catch (error) {
                if (error instanceof DataModuleError) return false;
                throw error;
            }
        });
        return fits.length === 1 ? { ...labels, kind: fits[0] } : labels;
    }
    // A skill name or a reason as the matcher compares it: NFKC, lower case, runs of spaces and dashes as one space.
    const words = value => ` ${String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—_]+/gu, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/gu, ' ').trim()} `;
    // The one skill a reason names (whole words; of two names inside it, the longer one if the shorter is part of it), else null.
    function skillNamed(slots, reason) {
        const text = words(reason);
        const found = slots.filter(slot => slot.name && words(slot.name).trim() && text.includes(words(slot.name)));
        const top = found.filter(slot => !found.some(other => other !== slot && words(other.name).includes(words(slot.name)) && words(other.name) !== words(slot.name)));
        const keys = new Set(top.map(slot => words(slot.name)));
        return keys.size === 1 && top.length === 1 ? top[0] : null;
    }
    // The Skills block's story lines never overwrite a slot (USER, 3 Nov). `learn-N` of a name some slot already holds updates that slot (a signature skill, one a
    // pack's cast member brought, is never updated: it keeps its name and slot); a new name goes to slot N if it is empty and open, else the first open one, else the
    // line is refused. A slot is open when the block has it and the character's level has opened it (names.js skillSlots: 5, a sixth at Lv 20, a seventh at 40, an
    // eighth at 60; a level drop only closes the empty ones). `practice-N` whose reason names one of the skills credits that skill's slot.
    // → { kind, slot, name, update? } | { refuse } | null (not one of these lines: as written).
    function skillRoute(fields, kindName, args, reason, room = SKILL_SLOTS_BASE) {
        const learn = /^learn-([1-8])$/u.exec(kindName), practice = /^practice-([1-8])$/u.exec(kindName);
        if (!learn && !practice) return null;
        const slots = Array.from({ length: SKILL_SLOTS_MAX }, (_, i) => ({ n: i + 1, name: typeof fields[`skill${i + 1}`] === 'string' ? fields[`skill${i + 1}`] : '', signature: signatureAt(fields.sig, i + 1) }));
        if (learn) {
            const wanted = fold(args.name);
            const same = wanted ? slots.find(slot => slot.name && fold(slot.name) === wanted) : undefined;
            if (same?.signature) return { refuse: fill(J.signature, { who: typeof fields.who === 'string' ? fields.who : '', skill: same.name }) };
            if (same) return { kind: `learn-${same.n}`, slot: same.n, name: same.name, update: true };
            const at = Number(learn[1]);
            const free = at <= room && !slots[at - 1].name ? at : slots.find(slot => slot.n <= room && !slot.name)?.n;
            if (free) return { kind: `learn-${free}`, slot: free, name: args.name };
            // (`full`: no open slot is free, the only reason a block is extended; the words say when the next slot opens, or that all eight hold a skill)
            const held = slots.filter(slot => slot.name).length;
            return { refuse: `No free skill slot for ${args.name}. ${held >= SKILL_SLOTS_MAX ? J.slotsFull : fill(J.slotLater, { level: Math.max(0, held + 1 - SKILL_SLOTS_BASE) * SKILL_SLOTS_EVERY })}`, full: true };
        }
        const named = skillNamed(slots, reason);
        const slot = named ? named.n : Number(practice[1]);
        return { kind: `practice-${slot}`, slot, name: slots[slot - 1].name };
    }
    // How many skill slots a Skills block has open: the slots it has, as far as its character's level opens them (names.js skillSlots); a Skills block no Character names is read at level 1.
    function skillRoom(state, definition, fields) {
        const capacity = Math.min(SKILL_SLOTS_MAX, Object.keys(definition.state ?? {}).filter(key => /^skill\d+$/u.test(key)).length);
        let level = 1;
        try { level = readSheet(state).characters.find(person => fold(person.who) === fold(fields.who))?.level ?? 1; } catch { level = 1; }
        return Math.min(capacity, skillSlots(level));
    }
    // The slots the character's level opens (names.js skillSlots), whatever the block has.
    function skillWant(state, fields) {
        let level = 1;
        try { level = readSheet(state).characters.find(person => fold(person.who) === fold(fields.who))?.level ?? 1; } catch { level = 1; }
        return skillSlots(level);
    }
    // The additive upgrade of a Skills block made before the extra slots (five slots, no `sig`; templates.js grownSkills): when it is first needed (a learn line once the level
    // has opened a slot the block lacks, or a cast member's skills to mark), the block's pin is replaced by the same definition with the missing slots and the mark added.
    // Nothing is removed or renamed; the fields it adds start at their defaults and every existing skill keeps its rank and practice. It is part of the action that needed it:
    // its ops carry the new pin and a Re-read plans it again from the same prefix, so rebuild, Re-read and reload all give the same block (the pack is not asked).
    // → the new definition (the draft holds it), or null when nothing was missing.
    function growSkills(ctx, prefix, draft, module) {
        const domain = prefix.domains.dataModules, old = domain?.active?.[module], current = activeDefinition(prefix, module);
        if (!old || !current || current.role !== 'skills' || current.pack !== 'chat' || domain.pins[old.hash]?.packId !== 'chat') return null;
        const grown = rpg().grownSkills(rawDefinition(current));
        if (!grown) return null;
        const catalog = Object.keys(domain.active).map(id => activeDefinition(prefix, id)).filter(Boolean);
        const checked = validateDataModules([grown], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
        if (!checked.ok) return null;
        const definition = checked.definitions[0], hash = dataModuleHash(definition);
        if (Object.keys(draft.pins).length >= L.pins + 1) return null;
        draft.pins[hash] = copy({ definition, packId: 'chat', packVersion: '0', packHash: null, interpreter: 1 });
        draft.active[module] = { ...copy(old), hash, generation: Math.max(ctx.rev, old.generation + 1) };
        const fields = atPath(draft, instancePath(module, 'chat')).fields;
        for (const [key, value] of Object.entries(dataModuleDefaults(definition.state))) if (!Object.hasOwn(fields, key)) fields[key] = value;
        if (old.hash !== hash && !Object.values(draft.active).some(entry => entry.hash === old.hash)) delete draft.pins[old.hash];
        return definition;
    }
    // A Foes block of the Levels rules (its set-slot kind has a `level` label): a line that gives a level keeps it; one that gives a rank gets a level drawn inside that
    // rank's band (the `rpg.rank` query names the ranks); one that gives neither gets a level within ±2 of the party's average. The draw is from the reply's seed, so a
    // swipe draws anew and a Re-read keeps it. `rank` is not a label of the kind: it is taken out of the line here.
    function foeLevelLabels(labels, kind, prefix, ctx, module) {
        if (!kind.labels?.level || !/^set-slot-\d$/u.test(labels.kind)) return labels;
        const { rank, ...rest } = labels;
        // A group already on the block, named again with no level and no rank, keeps the level it has: it is not drawn anew (a swipe would otherwise move a fight's foes).
        const have = prefix.domains?.dataModules?.instances?.[module]?.chat?.fields;
        const known = !dmOwn(rest, 'level') && !(typeof rank === 'string' && rank.trim()) && typeof rest.name === 'string' && have
            ? [1, 2, 3, 4].find(n => typeof have[`foe${n}`] === 'string' && have[`count${n}`] > 0 && fold(have[`foe${n}`]) === fold(rest.name) && Number.isSafeInteger(have[`level${n}`])) : undefined;
        if (known !== undefined) return { ...rest, level: String(have[`level${known}`]) };
        // A level or rank above one band (10 levels) over the party's highest level is held down to it.
        const levels = partyLevels(readSheet({ domains: { dataModules: prefix.domains?.dataModules } })), cap = foeLevelCap(levels);
        if (dmOwn(rest, 'level')) { const given = levelOf(rest.level); return given === null ? rest : { ...rest, level: String(Math.min(given, cap)) }; }
        const band = typeof rank === 'string' && rank.trim() ? bandOfRank(rank, level => ctx.query('rpg.rank', { level })) : null;
        const ask = band ? { from: Math.min(band.from, cap), to: Math.min(band.to, cap) } : {};
        return { ...rest, level: String(Math.min(cap, pickLevel(ask, averageLevel(levels), foeRandom(Math.floor(ctx.rng() * 4294967296) >>> 0, 0)))) };
    }
    function act(ctx, payload, line = null, call = {}) {
        if (ctx.caller !== null) refuse('REFUSED', '', 'A data action cannot be called by another module.');
        const prefix = stateOf(ctx), module = resolveModule(prefix, line?.name ?? payload.module);
        let definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', '', 'Unsupported or damaged pin.');
        dependency(definition, prefix);
        // A learn line for a Skills block made before the extra slots that would be refused for lack of a slot (every slot it has is full) while the character's level has
        // opened one it lacks: the block is extended first (growSkills). Any other line leaves the block as it is. A Re-read grows it only when the reply, as it stands, holds
        // the grown pin (the live reply did). A learn line that names a slot the block lacks, with a free one below, goes to the free one.
        const shown = definition;
        let grown = null, redirect = null;
        if (line && definition.role === 'skills') {
            const named = withKind(definition, line), fields = instanceOf(prefix, module)?.fields;
            if (fields && /^learn-[1-8]$/u.test(String(named.kind ?? ''))) {
                const probe = skillRoute(fields, named.kind, { name: String(named.name ?? '') }, line.text, skillRoom(prefix, definition, fields));
                const standing = ctx.standing ? activeDefinition({ domains: { dataModules: ctx.standing.domains?.dataModules } }, module) : null;
                // (the guard re-asks the conditions an action answered on the block as it was before; the new slots are empty by construction, so a grown action records none)
                if (probe?.full && skillCapacity(definition) < Math.min(SKILL_SLOTS_MAX, skillWant(prefix, fields)) && (!ctx.standing || (standing && skillCapacity(standing) > skillCapacity(definition)))) {
                    grown = growSkills(ctx, prefix, draftOf(ctx), module);
                    if (grown) definition = grown;
                } else if (probe?.slot && !dmOwn(definition.kinds, named.kind)
                    // (a Re-read redirects only to a slot the reply, as it stands, holds that skill in: a line that was refused then stays refused)
                    && (!ctx.standing || fold(standingBlock(ctx, String(fields.who ?? ''))?.fields?.[`skill${probe.slot}`] ?? '') === fold(String(named.name ?? '')))) redirect = probe.kind;
            }
        }
        let given = line ? withKind(definition, line) : { ...payload.labels, kind: payload.kind, ...(payload.who !== undefined ? { who: payload.who } : {}) };
        if (redirect) given = { ...given, kind: redirect };
        const kind = dmOwn(definition.kinds, given.kind) && definition.kinds[given.kind];
        // A foe group the narrator sets may give `level: N` or `rank: <name>`, or neither: then its level is drawn from the reply's seed (see foeLevelLabels).
        const labels = kind && line && definition.role === 'foes' ? foeLevelLabels(given, kind, prefix, ctx, module) : given;
        if (!kind) refuse('DM_LABEL', 'kind', `kind must be ${orList(Object.keys(shown.kinds))}`);
        if (line ? line.op !== kind.op : ctx.cause !== 'ui' || !kind.ui) refuse('REFUSED', '', line ? `${labels.kind} is written with ${kind.op}, not ${line.op}` : `${labels.kind} is a story line; a screen may only use kinds that allow it`);
        if (line && dmKindWritesHidden(definition, kind)) refuse('REFUSED', '', B.hiddenLine);
        // Practice comes only from rolled skill uses: on a reply captured under that rule (turn.js marks it, `ctx.carrier.practiceRule`; an older reply has no mark
        // and keeps its practice lines on a Re-read, an edit, a rebuild and a reload) the narrator's practice line changes nothing.
        if (ctx.cause === 'story' && definition.role === 'skills' && PRACTICE_KIND.test(labels.kind) && ctx.carrier?.practiceRule === 'rolls') refuse('REFUSED', '', 'Practice comes from rolled skill uses.');
        const args = parseLabels(definition, kind, labels, { text: Boolean(line) });
        // The XP rate (lean-rpg/levels.js): the narrator's XP line for a character is multiplied by the rate in force (the RPG on), which the line's record keeps
        // (`xpRate`, only when it is not 100) so a later change of the setting never moves it; a line recorded without it is 100.
        let xpRate = XP_RATE.default;
        if (ctx.cause === 'story' && definition.role === 'character' && ctx.feature?.(LEAN_RPG_FEATURE) === true) {
            try { xpRate = xpRateFrom(settings()); } catch { xpRate = XP_RATE.default; }
            if (xpRate !== XP_RATE.default) for (const effect of kind.effects ?? []) {
                if (effect?.op === 'add' && Array.isArray(effect.path) && effect.path[0] === 'xp' && Array.isArray(effect.value) && effect.value[0] === 'arg' && Number.isSafeInteger(args[effect.value[1]])) args[effect.value[1]] = scaleXp(args[effect.value[1]], xpRate);
            }
        }
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, labels.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject)), inputs = inputsOf(prefix, definition);
        // (a line that works a List of entries is told apart by everything it says: two quests in one reply are two lines, the same line twice is one)
        const entryLine = kind.effects?.some(effect => ['entryAdd', 'entrySet', 'entryDrop'].includes(effect?.op));
        const claim = `dm:${pairKey(ctx.source)}:${module}:${labels.kind}:${subject}:${hashJson(entryLine ? args : kind.oncePerReply.map(key => args[key]))}`;
        if (!ctx.claim(claim)) refuse('CLAIMED', '', `${labels.kind} was already applied for this in this reply`);
        const listKey = `${module}:${subject}`, listsKept = draft.perReply[pairKey(ctx.source)]?.lists ?? {};
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject, lists: copy(listsKept[listKey] ?? {}) });
        const fieldsBefore = copy(instance.fields);
        evaluation.timers();
        // A foe group the narrator sets by a name already on a slot of the same Foes block (the pre-call may have opened this very fight, lean-rpg/open.js)
        // is that group: the slot is updated (count and class), never a second slot with the same name; its health stays as it is.
        const route = definition.role === 'skills' && line ? skillRoute(instance.fields, labels.kind, args, line.text, skillRoom(prefix, definition, instance.fields)) : null;
        if (route?.refuse) refuse('DM_CONDITION', '', route.refuse);
        const same = definition.role === 'foes' && /^set-slot-\d$/u.test(labels.kind) && typeof args.name === 'string'
            ? [1, 2, 3, 4].find(n => typeof instance.fields[`foe${n}`] === 'string' && instance.fields[`count${n}`] > 0 && fold(instance.fields[`foe${n}`]) === fold(args.name)) : undefined;
        if (same !== undefined) evaluation.effects([{ op: 'set', path: [`foe${same}`], value: ['arg', 'name'] }, { op: 'set', path: [`count${same}`], value: ['arg', 'count'] }, { op: 'set', path: [kind.labels.level ? `level${same}` : `class${same}`], value: ['arg', kind.labels.level ? 'level' : 'class'] }], { arg: args });
        else if (route?.update) evaluation.effects(['about', 'stat', 'uses'].map(key => ({ op: 'set', path: [`${key}${route.slot}`], value: ['arg', key] })), { arg: args });
        else {
            const run = route ? definition.kinds[route.kind] : kind;
            if (!evaluation.condition(['kind', route?.kind ?? labels.kind], run.when, { arg: args })) refuse('DM_CONDITION', '', run.refusal ?? 'Kind condition is not met.');
            evaluation.effects(run.effects, { arg: args });
        }
        evaluation.rules();
        const result = evaluation.finish();
        const changes = namedChanges(definition, fieldsBefore, instance.fields);
        const recorded = guard(ctx, prefix, { kind: 'dm.act', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { args, inputs, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), conds: grown ? [] : result.conds, ...(xpRate !== XP_RATE.default ? { xpRate } : {}), ...(grown ? { grown: dataModuleHash(grown) } : {}) } });
        // The concrete outcome kept beside the inputs (and past the receipts' display data): which line, for whom, what was frozen, what was limited.
        const outcome = { kind: labels.kind, ...(route ? { skill: { slot: route.slot, name: route.update ? route.name : instance.fields[`skill${route.slot}`] } } : {}), subject, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) };
        // A story line that writes a character's XP: what the character had before it is kept for the reply (see finish), so that a won fight, whose XP is
        // given by code, can put back what the narrator added in that reply.
        const xpFrom = ctx.cause === 'story' && definition.role === 'character' && kind.effects.some(effect => Array.isArray(effect?.path) && effect.path[0] === 'xp')
            ? { [module]: Object.fromEntries(['xp', 'level', 'soul', 'points'].filter(key => Number.isSafeInteger(fieldsBefore[key])).map(key => [key, fieldsBefore[key]])) } : null;
        // A story line that practises a skill (`practice-N`, after skillRoute): what the slot held before it is kept for the reply, so that the practice the
        // reply's rolls give by code can put back what the narrator added for the same skill.
        const practiceFrom = ctx.cause === 'story' && route && route.kind.startsWith('practice-')
            ? { [module]: { [route.slot]: Object.fromEntries(['practice', 'rank'].filter(key => Number.isSafeInteger(fieldsBefore[`${key}${route.slot}`])).map(key => [key, fieldsBefore[`${key}${route.slot}`]])) } } : null;
        const answer = finish(ctx, prefix, draft, recorded, { pin: Boolean(grown), visits: result.visits, notes: result.notes, result: outcome, xpFrom, practiceFrom, listsFrom: Object.keys(result.lists).length ? { ...listsKept, [listKey]: result.lists } : null, summary: `${definition.name}: ${route ? `${route.kind} (${route.update ? route.name : instance.fields[`skill${route.slot}`]})` : kind.title ?? labels.kind}${changes.length ? ` (${changes.join(', ')})` : ''}.` });
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
        const fieldsBefore = copy(instance.fields);
        evaluation.effects(entries.map(entry => ({ op: 'set', path: entry.path, value: entry.value })));
        evaluation.rules();
        const result = evaluation.finish();
        const recorded = guard(ctx, prefix, { kind: 'dm.set', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition), actor: subject !== 'chat',
            decision: { inputs, conds: result.conds } });
        const labelOf = entry => (entry.map ? `${entry.schema.label ?? entry.name} (${entry.key})` : entry.schema.label ?? entry.name);
        const was = entry => (entry.map ? null : { fields: fieldsBefore, key: entry.name }), now = entry => (entry.map ? null : { fields: instance.fields, key: entry.name });
        const change = entry => `${labelOf(entry)} ${shownText(entry.field, entry.before, was(entry))} → ${shownText(entry.field, entry.value, now(entry))}`;
        const [only] = entries;
        const summary = multi ? fill(E.fieldsSet, { module: definition.name, changes: entries.map(change).join(', ') })
            : fill(E.fieldSet, { module: definition.name, field: labelOf(only), from: shownText(only.field, only.before, was(only)), to: shownText(only.field, only.value, now(only)) });
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
        kinds: { dm: kind, party: { grammar: () => rpgLib()?.joinGrammar() ?? '', feature: LEAN_RPG_FEATURE, get enabled() { const lib = rpgLib(); return lib !== null && lib.joinMode(settings()) !== 'off' && lib.partyOf(state()).length > 0; }, apply: wrap(party) } },
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
            static: hint => grammarFor(state(), rpgLib()?.isQuiet(hint, state(), settings()) ? rpgLib().QUIET_GRAMMAR : null, { rolled: practiceFromRollsOnly(hint?.view?.feature?.(LEAN_RPG_FEATURE), settings()) }),
            tail: view => ({ lines: tailLines(view.state, typeof view.feature === 'function' ? view.feature(LEAN_RPG_FEATURE) === true : true), optional: [] }),
            // Tail room for the lines above: 100 tokens for each pinned module (300 for one with a role), on top of the core's own; none without a pin.
            extra: () => Object.keys(state()?.domains?.dataModules?.active ?? {}).slice(0, L.pins).reduce((sum, id) => sum + tailRoom(activeDefinition(state(), id), true, instanceOf(state(), id)?.fields), 0),
        },
    };
}
