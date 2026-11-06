// The data modules' field and host-step actions (extracted from data-modules/part.js):
// `dm.set`, timers, reply-end settling, and the afterCapture/beforeGenerate steps they plan.
import { DM_LIMITS as L, dmOwn, dmObject } from '../schema.js';
import { copy, refuse, createEvaluation, cleanList, atPath, scalarHolds } from '../interpreter.js';
import { oneLine } from '../../../text.js';
import { activeDefinition, inputsOf, instanceOf, resolveActor } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { fill } from '../../strings.js';
import { E, SET_FIELDS, draftOf, stateOf, subjectsOf, instancePath, prefixImports } from './shared.js';
import { shownText } from './prompt.js';
import { timerDue, SETTLED_TYPES } from './timing.js';

export function createFields(deps) {
    const { dependency, guard, finish, restore } = deps;
    // `dm.set` writes one field (`field`, `key?`, `value`) or, as ONE action, several non-map fields of one block (`fields`: { name: value }).
    // Either way each value is checked the same, the rules run once after all the sets, and nothing applies unless every one holds.
    function setField(ctx, payload, call = {}, { story = false } = {}) {
        // `story`: the party line that marks a companion as left (`- party Name`, below) is the one story line that sets a field.
        if (story ? ctx.cause !== 'story' || ctx.caller !== null : ctx.cause !== 'ui' || ctx.caller !== null) refuse('REFUSED', '', E.fieldReader);
        if (restore()?.state === 'pending') refuse('RESTORE_PENDING', '', E.restorePending);
        const prefix = stateOf(ctx), module = deps.resolveModule(prefix, payload.module), definition = activeDefinition(prefix, module);
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
    return { setField, tick, settle, settleDue, due, afterCapture };
}
