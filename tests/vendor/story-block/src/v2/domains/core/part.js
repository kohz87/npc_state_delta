// Story Block's core part: the scene and inventory domains, capture handlers, prompt tail, settings and
// code tabs in the MODULES.md A part shape. Pure apart from the tab renderers.

import {
    FEATURE, createInventoryCommands, createInventoryQueries, captureCoin, captureItem, captureLoot, encumbranceTail,
    featureOn, gearOn, initialInventory, inventoryTail, validateInventory,
} from '../inventory.js';
import { capturePlace, capturePresent, captureWeather, captureYou, initialScene, sceneCommands, sceneQueries, sceneTail, validateScene } from '../scene.js';
import { MOUNTS_FEATURE, captureMount, createMountsQueries, mountsCommands, mountsTail } from '../mounts.js';
import { moneyLine, resolveCurrency } from '../money.js';
import { renderInventoryTab } from '../../ui/inventory-tab.js';
import { renderSceneTab } from '../../ui/scene-tab.js';
import { CORE_FEATURE } from '../../features.js';
import { rpgLib } from '../../rpg-lazy.js';
import { CORE_BUDGET, CORE_SETTINGS, CORE_STATIC, GEAR_ITEM_GRAMMAR } from './constants.js';
import { CORE_KINDS, youGrammar } from './kinds.js';

// The Rank's label for the tail: asked through the view's query (null while no pack gives one).
function youRankLabel(view) {
    try { return view.query('packs.youRank')?.label ?? ''; } catch { return ''; }
}

// Whether this reply answers the reader's first message of the chat (the greeting is the narrator's): the one reply that asks for the look.
// Read from the chat itself, so a swipe, a regenerate or a rebuilt state gives the same answer.
const firstReader = view => (Number.isInteger(view?.chat?.readers) ? view.chat.readers <= 1 : true);

/**
 * The core part in MODULES.md A's shape ({ domains, commands, queries, kinds, context, settings,
 * tabs }), for a host that merges parts. `hooks(name) → fn[]` in module-id order (the registry's
 * `hooks`); `settings()` → this module's settings. Without them no hooks run and the currency is gold.
 */
export function createCorePart({ hooks = () => [], settings = () => ({}), hookEntries = null, problem = null, economy = () => null, youRank = () => null, query = null, rpgOn = () => false, gearOn = () => false, persona = () => '', readers = () => null, greetingOnly = () => null, chatEmpty = () => false } = {}) {
    const hookList = name => {
        const fns = hooks(name);
        return Array.isArray(fns) ? fns.filter(fn => typeof fn === 'function') : [];
    };
    // `hookEntries(name)` → [{ moduleId, fn }] (the registry's) names the module a failing hook comes
    // from; `problem(entry)` adds to the Problems list (turn.js report).
    const entries = name => {
        const list = typeof hookEntries === 'function' ? hookEntries(name) : null;
        return Array.isArray(list) ? list.filter(entry => typeof entry?.fn === 'function') : hookList(name).map(fn => ({ moduleId: null, fn }));
    };
    const env = {
        hooks: hookList,
        hookEntries: entries,
        settings: () => settings() ?? {},
        // Whether `story-block.gear` is on (off without a host that says so): the gear queries answer null while it is off.
        gearOn: () => { try { return gearOn() === true; } catch { return false; } },
        // How many messages the reader has sent on the line of history (null: not known): the starting kit is open while it is 0.
        readers: () => { try { const n = readers(); return Number.isInteger(n) ? n : null; } catch { return null; } },
        // Whether the line of history is still only the opening greeting (null: not known): with `readers` 0, the starting kit is open only then.
        greetingOnly: () => { try { const v = greetingOnly(); return typeof v === 'boolean' ? v : null; } catch { return null; } },
        // Whether the chat has no message at all (no greeting): the kit reads closed and "+ Add item" says why.
        chatEmpty: () => { try { return chatEmpty() === true; } catch { return false; } },
        // The reader's persona name: what the gear screens call the party's own wearer when no party module names one.
        persona: () => { try { return String(persona() ?? ''); } catch { return ''; } },
        // The enabled pack's money scale ({ scale } or null) for inventory.economy.
        economy,
        // The Rank an enabled pack gives {{user}}'s look, `{ label }`, or null (no Rank in this story).
        youRank: () => { try { return youRank() ?? null; } catch { return null; } },
        problem: entry => { try { problem?.(entry); } catch { /* the Problems list is not essential */ } },
    };
    // The chat's currency comes from the reader's settings or the pack.
    const currency = () => resolveCurrency(env.settings());
    const kind = (grammar, apply) => ({ grammar, apply });
    return {
        domains: {
            // `weather`, `you` and `mounts` are scratch: a later reply's `~ weather` (or the part of `~ you` it writes) replays after the first one's reply is deleted;
            // a mount row added after the reply that first wrote the field was deleted still finds its place (mounts.js).
            scene: { initial: initialScene, validate: slice => validateScene(slice), scratch: ['weather', 'you', 'mounts'] },
            // Coin and stack sizes are counts: a replay after a deleted reply adds each change to them.
            inventory: { initial: initialInventory, validate: slice => validateInventory(slice), counters: ['wallets/*/coin', 'stacks/*/qty'], scratch: ['perReply', 'storyClicks', 'loot', 'condLog'] },
        },
        commands: { ...createInventoryCommands(env), ...sceneCommands, ...mountsCommands },
        // The party's riders for `mounts.pace`: the RPG's characters who have not left, else the one reader.
        queries: { ...createInventoryQueries(env), ...sceneQueries, ...createMountsQueries({ riders: state => (rpgOn() ? Math.max(1, (rpgLib()?.partyOf(state) ?? []).filter(person => !person.left).length) : 1) }) },
        kinds: {
            item: kind(() => CORE_KINDS.item.grammar + (env.gearOn() ? GEAR_ITEM_GRAMMAR : ''), (ctx, line) => captureItem(ctx, line, env)),
            coin: kind(CORE_KINDS.coin.grammar, (ctx, line) => captureCoin(ctx, line, env)),
            place: kind(CORE_KINDS.place.grammar, (ctx, line) => capturePlace(ctx, line)),
            present: kind(CORE_KINDS.present.grammar, (ctx, line) => capturePresent(ctx, line)),
            weather: { ...kind(CORE_KINDS.weather.grammar, (ctx, line) => captureWeather(ctx, line)), feature: CORE_FEATURE.weather },
            you: { ...kind(() => youGrammar(env.youRank()?.label ?? ''), (ctx, line) => captureYou(ctx, line)), feature: CORE_FEATURE.you },
            mount: { ...kind(CORE_KINDS.mount.grammar, (ctx, line) => captureMount(ctx, line)), feature: MOUNTS_FEATURE },
            loot: { ...kind(CORE_KINDS.loot.grammar, (ctx, line) => captureLoot(ctx, line, env)), feature: FEATURE.loot },
        },
        context: {
            // The money line (money.js moneyLine) always names the chat's currency (and its coins): it changes with the currency setting only.
            static: hint => [CORE_STATIC, moneyLine(currency(), hint?.view?.rule?.('oneCoin') ?? true)].join('\n'),
            // Half the budget for the lines that always go, half for the optional overflow.
            tail(view) {
                const chars = CORE_BUDGET * 4;
                const mounts = featureOn(view, MOUNTS_FEATURE) ? mountsTail(view?.state) : null;
                const scene = [...sceneTail(view?.state, { weather: featureOn(view, CORE_FEATURE.weather), you: featureOn(view, CORE_FEATURE.you), rankLabel: featureOn(view, CORE_FEATURE.you) ? youRankLabel(view) : '', askLook: firstReader(view) }), ...(mounts ? [mounts] : [])];
                // The encumbered condition, when the carry module reports it (one short line).
                // Asked through the query, which a host with Features answers with null while it is off.
                let found = null;
                try { found = featureOn(view, FEATURE.encumbrance) ? view.query('inventory.encumbrance') : null; } catch { found = null; }
                const heavy = encumbranceTail(found);
                const used = [...scene, ...heavy].reduce((sum, line) => sum + line.length + 1, 0);
                const inventory = inventoryTail(view?.state, { currency: currency(), chars: chars / 2 - used, optionalChars: chars / 2, gear: gearOn(view) });
                return { lines: [...scene, ...inventory.lines, ...heavy], optional: inventory.optional };
            },
            budget: CORE_BUDGET,
        },
        settings: CORE_SETTINGS,
        tabs: [
            { id: 'inventory', title: 'Inventory', icon: 'fa-box-open', render: (el, view, api) => renderInventoryTab(el, view, api, { currency: currency() }) },
            { id: 'scene', title: 'Scene', icon: 'fa-map-location-dot', render: (el, view, api) => renderSceneTab(el, view, api) },
        ],
    };
}
