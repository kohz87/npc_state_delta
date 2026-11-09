// The data modules' Setup actions (extracted from data-modules/part.js): pinning,
// migrating and attaching a module, and creating, editing or removing a chat block.
import { DM_LIMITS as L } from '../schema.js';
import { validateDataModules, validateDataMigration, dataModuleDefaults, dataModuleHash } from '../check.js';
import { copy, refuse, atPath, scalarHolds, carryEntries } from '../interpreter.js';
import { activeDefinition, inputsOf, instanceOf, resolveActor } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { fill } from '../../strings.js';
import { actorIdOf } from '../../lean-rpg/roster.js';
import { isTypedSkills } from '../../skill-slots.js';
import { E, B, J, stateOf, draftOf, activeCount, blockCount, instancePath, checkedTarget, newInstance } from './shared.js';

export function createBlocks(deps) {
    const { reader, offers, dependency, guard, finish, defaultSeeds, seededData, restore } = deps;
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
        const module = action === 'define' ? `pack.chat/${payload.definition?.slug ?? ''}` : deps.resolveModule(prefix, payload.module);
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
        if (slots > (definition.role === 'skills' && isTypedSkills(definition.state) ? L.skillsKinds : L.kinds)) refuse('DM_BUDGET', 'fields', B.kindLimit);
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
    function attach(ctx, payload, call = {}) {
        reader(ctx);
        const prefix = stateOf(ctx), module = deps.resolveModule(prefix, payload.module), definition = activeDefinition(prefix, module);
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
    return { target, changeBlock, attach };
}
