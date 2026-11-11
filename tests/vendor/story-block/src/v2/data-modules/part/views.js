// The read-only data-module views (moved out of data-modules/part.js unchanged): domain checks,
// module lookup and values, pinned screens, grammar, replay witnesses and the guard check.
import { DM_LIMITS as L, DM_OLD_ROOM, dmObject } from '../schema.js';
import { validateDataMigration } from '../check.js';
import { copy, refuse, atPath, scalarHolds, conditionHolds } from '../interpreter.js';
import { activeDefinition, actorsOf, instanceOf, publicView, projectImport } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { moduleGrammar, referenceOf } from '../grammar.js';
import { oneLine } from '../../../text.js';
import { editableLayout } from '../editable-layout.js';
import { blockTabScreen } from '../block-screen.js';
import { boardGrammar, boardXpGuide } from '../board-static.js';
import { isMarkedCharacter, restLine } from '../recovery.js';
import { rpgLib } from '../../rpg-lazy.js';
import { PARTY_ACTIVE, PARTY_MAX } from '../../lean-rpg/names.js';
import { hashOf, sizeOf, subjectsOf, activeCount, blockCount, checkedTarget, partyRoomOf } from './shared.js';

export function validateDomain(domain) {
    if (!dmObject(domain) || Object.keys(domain).some(key => !['pins', 'active', 'instances', 'perReply', 'boardFlags'].includes(key))
        || ['pins', 'active', 'instances', 'perReply'].some(key => !dmObject(domain[key])) || (domain.boardFlags !== undefined && !dmObject(domain.boardFlags))) return ['Invalid dataModules domain.'];
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
export function grammarFor(state, quiet = null, { rolled = false, board = false } = {}) {
    // `rolled` (the RPG on, Rolls automatic): skill practice comes only from rolled uses, so the narrator is not offered `practice-N` and the texts
    // that told it to practise a skill say nothing of it (the Combat rules' XP guide line, the Skills block's description).
    const noPractice = text => String(text ?? '').replace(/\s*Practice a skill 5 to 20 per use\./u, '').replace(/\s+and adds practice/u, '');
    const active = Object.keys(state?.domains?.dataModules?.active ?? {});
    const marked = active.some(id => isMarkedCharacter(activeDefinition(state, id)));
    const seen = new Map();
    const lines = active.map(id => {
        let definition = activeDefinition(state, id);
        if (marked && definition?.role === 'rules' && typeof definition.prompt === 'string') definition = { ...definition, prompt: definition.prompt.replace(/\s*XP guide:.*$/gmu, '').trim() };
        // (The board's pieces come from a static file, so a preview before the lazy RPG library has loaded words them the same.)
        const only = (board && boardGrammar(definition?.role)) || (quiet && definition?.role ? quiet[definition.role] : null);
        if (definition && only?.skip) {
            // (A skipped block may keep one line of its text: the XP guide stays on a quiet reply, whatever words the pinned block holds it in.)
            const kept = only.keep ? new RegExp(only.keep.source, 'u').exec(String(definition.prompt ?? ''))?.[0] : '';
            const value = rolled ? noPractice(kept) : kept;
            return kept ? oneLine(board ? boardXpGuide(value) : value) : '';
        }
        const shown = definition && rolled && (definition.role === 'rules' || definition.role === 'skills') ? { ...definition, prompt: noPractice(definition.prompt) } : definition;
        const own = shown ? moduleGrammar(shown, referenceOf(active, id), { seen, ...(only ?? {}), ...(rolled && definition.role === 'skills' ? { without: /^practice-\d+$/u } : {}) }) : '';
        // A marked Character also gets one separate line on what each recovery kind restores: its own room (outside the prompt and grammar caps), so nothing old is dropped.
        const recovery = own && isMarkedCharacter(definition) ? restLine(definition) : '';
        return recovery ? `${own}\n${recovery}` : own;
    }).filter(Boolean);
    return lines.length ? `Data modules in this story (write these lines exactly; a refused line changes nothing):\n${lines.join('\n')}` : '';
}

// Witnesses contain only relevant local paths. A guard never interprets effects or asks live
// services: it verifies the recorded decision against the prefix and allows the host's saved ops.
export function replayInputs(state, { module, subject = 'chat', reads = [], imports = [], actor = false, adapters = null, subjects = [], available = [], clock = false, party = false, bench = '' } = {}) {
    const domain = state?.domains?.dataModules, active = domain?.active?.[module];
    const definition = activeDefinition(state, module), instance = instanceOf(state, module, subject);
    return { active: active ? { hash: active.hash, generation: active.generation, attached: active.subjects.includes(subject) } : null,
        ...(clock ? { clock: state?.domains?.director?.time?.minutes ?? null } : {}),
        // (a marked join, creation or return: only whether the party had room, fewer than 8 active; unmarked replies record none)
        // (the limit is the one the selector recorded: 4 under the `partyFour` mark, else 8)
        ...(party ? { party: { room: partyRoomOf(state, party === PARTY_ACTIVE ? PARTY_ACTIVE : PARTY_MAX) } } : {}),
        // (a bench choice: the member who steps out is still in the party and has not left yet)
        ...(bench ? { bench: { active: Boolean(domain?.active?.[bench]), left: instanceOf(state, bench)?.fields?.left === true } } : {}),
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
            // (a join recorded without the party witness was made under the old room, 8 own blocks and 16 pins: the guard keeps that, as Re-read does)
            const room = join && !recorded.selector?.party ? DM_OLD_ROOM : L;
            if (activeCount(domain) + more.length >= room.pins) return { ok: false, reason: 'Data module limit changed.' };
            // A Skills block made with its Character (the wizard) goes with it: with the Character gone from this prefix, it is skipped too.
            const after = recorded.decision?.after;
            if (predicate.kind === 'dm.define' && after !== undefined && (typeof after !== 'string' || !domain?.active?.[after])) return { ok: false, reason: 'The Character this Skills block was made with is not in the story now.' };
            const chatBlock = (pin, module) => pin?.packId === 'chat' && pin.packVersion === '0' && pin.packHash === null && pin.definition?.pack === 'chat'
                && module === `pack.chat/${pin.definition.slug}` && pin.definition.scope === 'chat';
            if ((predicate.kind !== 'dm.pin' && (!chatBlock(recorded.pin, predicate.module) || blockCount(domain) + more.length >= room.definitions))) return { ok: false, reason: 'Block selection or chat limit changed.' };
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
