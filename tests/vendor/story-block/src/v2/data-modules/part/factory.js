// The Story Block data-module part (extracted from data-modules/part.js): it wires the
// domain, `dm.*` commands, party kind, queries, cards, hooks and prompt context from the part files.
import { DM_LIMITS as L } from '../schema.js';
import { validateDataMigration, dataModuleDefaults } from '../check.js';
import { copy } from '../interpreter.js';
import { activeDefinition, actorsOf, inputsOf, instanceOf, publicView } from '../adapters.js';
import { rpgLib } from '../../rpg-lazy.js';
import { LEAN_RPG_FEATURE, ROLLS_SETTING, practiceFromRollsOnly } from '../../lean-rpg/names.js';
import { readSheet } from '../../lean-rpg/read.js';
import { createCore } from './core.js';
import { createSkills } from './skills.js';
import { createParty } from './party.js';
import { createAct } from './act.js';
import { createBlocks } from './blocks.js';
import { createFields } from './fields.js';
import { validateDomain, resolveModule, moduleView, pinnedPresentation, grammarFor, replayInputs } from './views.js';
import { blockCardSlots, tailLines, tailRoom } from './prompt.js';
import { B, initial } from './shared.js';

export function createDataModulesPart(opts = {}) {
    const d = createCore(opts);
    d.resolveModule = resolveModule;
    Object.assign(d, createSkills(d));
    Object.assign(d, createParty(d));
    Object.assign(d, createAct(d));
    Object.assign(d, createBlocks(d));
    Object.assign(d, createFields(d));
    const { state, settings, boardOn, wrap, offers, guard, finish, setField, tick, settle, afterCapture, act } = d;
    const kind = { get enabled() { return Boolean(Object.keys(state()?.domains?.dataModules?.active ?? {}).length); },
        grammar: '! dm Module — reason | kind: name | label: value (only the lines listed under Data modules; each has its own op)', apply: wrap((ctx, line, call) => act(ctx, {}, line, call)) };
    return {
        domains: { dataModules: { initial, deferred: true, snapshot: 'when-present', scratch: ['perReply', 'boardFlags'], validate: validateDomain } },
        commands: { 'dm.pin': wrap((ctx, payload, call) => d.target(ctx, payload, false, call)), 'dm.migrate': wrap((ctx, payload, call) => d.target(ctx, payload, true, call)),
            'dm.define': wrap((ctx, payload, call) => d.changeBlock(ctx, payload, 'define', call)),
            'dm.redefine': wrap((ctx, payload, call) => d.changeBlock(ctx, payload, 'redefine', call)),
            'dm.remove': wrap((ctx, payload, call) => d.changeBlock(ctx, payload, 'remove', call)),
            'dm.attach': wrap(d.attach), 'dm.set': wrap(setField), 'dm.act': wrap((ctx, payload, call) => act(ctx, payload, null, call)), 'dm.capture': { internal: true, handler: wrap((ctx, line, call) => act(ctx, {}, line, call)) },
            'dm.tick': { internal: true, handler: wrap(tick) }, 'dm.settle': { internal: true, handler: wrap(settle) },
            // The Ask card's "Add to party" (rpg only: the feature gate leaves it out while the RPG is off).
            'dm.join': Object.assign(wrap(d.addParty), { feature: LEAN_RPG_FEATURE }) },
        // `+ party Name | about: … | class: I | best: int` and `- party Name`: under the RPG feature, out of the grammar while Companions who join is Off, and
        // until the story has a Character block (a party line means something only once there is a party).
        kinds: { dm: kind, party: { grammar: () => rpgLib()?.joinGrammar() ?? '', feature: LEAN_RPG_FEATURE, get enabled() { const lib = rpgLib(); return lib !== null && lib.joinMode(settings()) !== 'off' && lib.partyOf(state()).length > 0; }, apply: wrap(d.party) } },
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
                    try { d.dependency(row.definition, prefix); } catch (error) { status = 'Waiting'; reason = error.message; available = false; }
                    const inputs = inputsOf(prefix, row.definition);
                    if (row.definition.timers.some(timer => inputs[timer.clock]?.minutes == null)) { status = 'Waiting'; reason ||= 'Story time has not been set.'; }
                    return { ...row, status, reason, additions, available, pinned: Boolean(active), pinnedDefinition: pinned ? copy(pinned) : null, subjects: active?.subjects ?? [],
                        actors: Object.values(actorsOf(prefix)), baseline: inputs, budgets: L };
                });
            },
            'dataModules.presentation': (prefix, { kind: name = 'screens', noTab = [] } = {}) => pinnedPresentation(prefix, name, Array.isArray(noTab) ? noTab : []) },
        hooks: { afterCapture, beforeGenerate: (view, info) => info?.commit === false ? undefined : d.due(view) },
        cards: blockCardSlots,
        context: {
            static: hint => {
                const board = boardOn() === true;
                return grammarFor(state(), !board && rpgLib()?.isQuiet(hint, state(), settings()) ? rpgLib().QUIET_GRAMMAR : null,
                    { rolled: board || practiceFromRollsOnly(hint?.view?.feature?.(LEAN_RPG_FEATURE), settings()), board });
            },
            tail: view => {
                const lines = tailLines(view.state, typeof view.feature === 'function' ? view.feature(LEAN_RPG_FEATURE) === true : true);
                if (boardOn()) {
                    const lib = rpgLib();
                    let pack = null;
                    try { pack = lib?.packRulesOf(view.query?.('packs.content', { kind: 'rpg' })); } catch { /* no pack rules */ }
                    const manual = settings()?.[ROLLS_SETTING] === 'off' || (lib && !lib.isStandard(lib.rulesFromSettings(settings(), pack)));
                    const fight = readSheet(view.state).foes.some(foe => foe.filled);
                    lines.push(...(lib?.boardReplyGrammar?.(view.state, { fight, manual, practice: settings()?.[ROLLS_SETTING] === 'off' }) ?? []));
                }
                return { lines, optional: [] };
            },
            // Tail room for the lines above: 100 tokens for each pinned module (300 for one with a role), on top of the core's own; none without a pin.
            extra: () => Object.keys(state()?.domains?.dataModules?.active ?? {}).slice(0, L.pins).reduce((sum, id) => sum + tailRoom(activeDefinition(state(), id), true, instanceOf(state(), id)?.fields), 0),
        },
    };
}
