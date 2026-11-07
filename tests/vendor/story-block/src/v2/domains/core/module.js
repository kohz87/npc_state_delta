// Story Block's module definition: merges the core part with packs, events, assist, timeline, data
// modules and the optional Lean RPG, then adds the host's guards, capture dispatcher and queries.

import { createAssistPart } from '../../assist/index.js';
import { INVENTORY_FEATURES, INVENTORY_EDIT_GUARD, LOOT_KINDS, inventoryEditGuard, lootTakeGuard } from '../inventory.js';
import { CORE_FEATURE } from '../../features.js';
import { chatterCap, chatterGrammar, headChatter, sceneChatter } from '../../extras.js';
import { createEvidenceQuery } from '../../evidence.js';
import { createEventsPart } from '../../events/index.js';
import { standardWidgets } from '../../view/widgets/index.js';
import { screens as defaultScreens } from '../../screens/index.js';
import { youRankOf } from '../../packs/content.js';
import { createPacksPart, packs as liveInstalled, part as livePart, resolveItem as liveResolve, startState as liveStart } from '../../packs/index.js';
import { createTimelinePart } from '../../timeline/part.js';
import { createDataModulesPart, dataModuleGuard } from '../../data-modules/part.js';
import { FIGHT as RPG_FIGHT, PRACTICE_STEP as RPG_PRACTICE, RESOLVE as RPG_RESOLVE } from '../../lean-rpg/names.js';
// The RPG's code is loaded only when it is needed (rpg-lazy.js): this part answers for it until it is there.
import { createLazyRpgPart } from '../../rpg-lazy.js';
import { CORE_BUDGET, CORE_FEATURES, CORE_MODULE_ID } from './constants.js';
import { CORE_KINDS } from './kinds.js';
import { createCorePart } from './part.js';
import { mergeParts } from './merge.js';
import { chatterBack, headMoved } from './extra.js';

// The packs part bound to SillyTavern (src/v2/packs/index.js), in createPacksPart()'s shape.
const livePacks = Object.freeze({ part: livePart, packs: liveInstalled, resolveItem: liveResolve, startState: liveStart });
export { createPacksPart };

// The core part's code tabs that the default screens replace in the module definition.
const SCREEN_TABS = Object.freeze(['inventory', 'scene']);

/**
 * The core module definition for `sdk.registerModule` (§6): the core part (scene, inventory), the
 * packs part (item.resolve before story defs, the start state, pack queries and its settings
 * section) and the events part (beforeGenerate, events.fire, events.status, its debug section, in
 * Settings → Diagnostics).
 * `packs`: a createPacksPart() result (default: the one bound to SillyTavern); `command` / `query`:
 * what the events part commits and asks through (default: the public sdk, looked up lazily);
 * `assist`: the assist part (pre-roll classifier, after-reply extractor; both off by default).
 */
export function createCoreModule({ hooks = () => [], settings = () => ({}), version = '2.0.0-alpha.1', packs = livePacks, command, query, assist = null, hookEntries = null, problem = null, extras = null, timeline = () => null, dataModules = {}, leanRpg = {} } = {}) {
    const core = createCorePart({ hooks, settings, hookEntries, problem, query, rpgOn: () => { try { return extras?.rpgOn?.() === true; } catch { return false; } }, gearOn: () => { try { return extras?.gearOn?.() === true; } catch { return false; } }, persona: () => extras?.persona?.() ?? '', readers: () => extras?.readers?.() ?? null, greetingOnly: () => extras?.greetingOnly?.() ?? null, chatEmpty: () => extras?.chatEmpty?.() === true, economy: () => (typeof packs.economy === 'function' ? packs.economy() : null), youRank: () => youRankOf(typeof packs.packs?.packs === 'function' ? packs.packs.packs() : []) });
    // The reader's cap on Inner chatter lines a reply (1 to 10; 3 unless set).
    const chatterCapNow = () => { try { return chatterCap(settings()?.chatterMax); } catch { return chatterCap(); } };
    const events = createEventsPart({
        ...(command ? { command } : {}),
        ...(query ? { query } : {}),
    });
    const dataPart = createDataModulesPart({ packs: packs.packs, settings: () => settings(), ...dataModules });
    // The RPG's pre-call and rolls (`leanRpg`: the runtime's queued model call, the chat and its metadata; src/v2/lean-rpg/).
    const rpg = createLazyRpgPart({ ...leanRpg, problem, plannerValues: () => settings(), persona: () => extras?.persona?.() ?? '', rosterOn: () => { try { return extras?.rpgOn?.() === true && extras?.gearOn?.() === true; } catch { return false; } } });
    const merged = mergeParts([core, packs.part, events, assist ?? createAssistPart({ settings: () => settings() }), createTimelinePart({ timeline }), dataPart, rpg]);
    const timelineGuard = merged.hooks.replayGuard;
    // One host-owned hook for the host's guarded blocks, by predicate: data modules (`dm.*`), the RPG's rolls
    // (`rpg.resolve`), a loot offer or take (`loot.offer`, `loot.take`, inventory.js), else the timeline's.
    merged.hooks.replayGuard = Object.assign((view, info) => {
        const kind = String(info?.guard?.predicate?.kind ?? '');
        if (kind.startsWith('dm.')) return dataModuleGuard(view, info);
        if (kind === RPG_RESOLVE || kind === RPG_FIGHT || kind === RPG_PRACTICE) return rpg.guard(view, info);
        if (kind === INVENTORY_EDIT_GUARD) return inventoryEditGuard(view, info);
        return LOOT_KINDS.includes(kind) ? lootTakeGuard(view, info) : timelineGuard(view, info);
    }, { hostOwned: true });
    return {
        id: CORE_MODULE_ID,
        name: 'Story Block',
        version,
        features: [...CORE_FEATURES, ...INVENTORY_FEATURES].map(feature => ({ ...feature })),
        domains: merged.domains,
        commands: merged.commands,
        replayQueries: ['dataModules.replayInputs'],
        // The cards under the head reply that blocks declare (data-modules/part.js blockCards).
        cards: merged.cards,
        // The newest reply's Inner chatter, [{ name, text }] (MODULES §F115; null while the feature is off), the
        // same under each present person for the Scene screen while Story Director's World is not there, and
        // whether the head reply moved the scene to another place (Story Director's World → Here, §F119).
        queries: {
            ...merged.queries,
            'chatter.head': Object.assign(() => headChatter(extras?.headChat?.(), extras?.display), { feature: CORE_FEATURE.chatter }),
            'scene.chatter': Object.assign(state => {
                let world = false;
                try { world = extras?.worldShown?.() === true; } catch { world = false; }
                return world ? [] : sceneChatter(state?.domains?.scene?.present, headChatter(extras?.sceneChat?.(), extras?.display));
            }, { feature: CORE_FEATURE.chatter }),
            'scene.moved': (_state, _args, tools) => headMoved(tools, extras?.headIndex),
            // The active, visible, code-validated proof (contract §6, docs/v2/EVIDENCE.md); the stored proof comes from the store.
            'story.evidence': createEvidenceQuery({ stored: () => extras?.proofs?.() ?? [] }),
        },
        capture: {
            // `you`'s grammar line is the part's function: it names a Rank only while an enabled pack gives one (youGrammar).
            kinds: { ...CORE_KINDS, chatter: { ...CORE_KINDS.chatter, grammar: () => chatterGrammar(chatterCapNow()), display: Object.freeze({ noun: CORE_KINDS.chatter.display.noun, read: CORE_KINDS.chatter.display.read, get perReply() { return chatterCapNow(); } }) }, item: { ...CORE_KINDS.item, grammar: merged.kinds.item.grammar }, you: { ...CORE_KINDS.you, grammar: merged.kinds.you.grammar }, dm: merged.kinds.dm, party: merged.kinds.party },
            apply(ctx, line) {
                const kind = merged.kinds[line?.kind];
                if (!kind) return ctx.fail('INVALID', `Story Block does not handle "${line?.kind}" lines.`);
                return kind.apply(ctx, line);
            },
        },
        context: {
            static: hint => merged.statics.map(fn => fn(hint)).filter(text => typeof text === 'string' && text.trim()).join('\n'),
            tail(view) {
                const lines = [];
                const optional = [];
                for (const fn of merged.tails) {
                    const out = fn(view) ?? {};
                    lines.push(...(out.lines ?? []));
                    optional.push(...(out.optional ?? []));
                }
                return { lines, optional };
            },
            // The core's own room, plus 100 tokens for each pinned data module (none without a pin: part.js context.extra).
            get budget() { return (merged.budget || CORE_BUDGET) + dataPart.context.extra(); },
            // Inner chatter back to the story, only while the reader's setting asks for it (MODULES §F115).
            parts: [Object.freeze({ feature: CORE_FEATURE.chatter, tail: () => chatterBack(settings, extras) })],
        },
        hooks: merged.hooks,
        settings: {
            defaults: merged.defaults,
            schema: merged.schema,
            // The Packs: a fold of its own, second after Story Suite's, so it is found; the Events: a fold
            // in Settings → Diagnostics (`place`), since it lists what is coming (host-ui.js).
            folds: merged.folds.map(item => ({ ...item, render: (el, api) => item.render(el, { ...api, query: (name, args) => api?.sdk?.query?.(name, args), notify: text => globalThis.toastr?.info?.(text, 'Story Suite') }) })),
            // Each other part's own panel (Assist) under its title, below the schema rows.
            render(el, api) {
                const doc = el.ownerDocument ?? globalThis.document;
                const extra = { query: (name, args) => api?.sdk?.query?.(name, args), notify: text => globalThis.toastr?.info?.(text, 'Story Suite') };
                for (const section of merged.sections) {
                    const block = doc.createElement('div');
                    block.className = 'story-suite-subsection';
                    if (section.title) {
                        const head = doc.createElement('h4');
                        head.textContent = section.title;
                        block.appendChild(head);
                    }
                    const body = doc.createElement('div');
                    block.appendChild(body);
                    el.appendChild(block);
                    try { section.render(body, { ...api, ...extra }); } catch (error) {
                        body.textContent = `This part could not be shown: ${error?.message ?? error}`;
                    }
                }
            },
        },
        // The Inventory and Scene tabs are screens now (src/v2/screens/: inventory, scene, the changes
        // card, the game view's home), so packs, cards and the reader can restyle them (SPEC §13.7).
        tabs: merged.tabs.filter(tab => !SCREEN_TABS.includes(tab.id)),
        screens: defaultScreens.map(screen => ({ ...screen })),
        // The standard widgets (SPEC §13.5, MODULES §F9) for layouts, templates and mounts.
        widgets: { ...standardWidgets },
    };
}
