// Story Block's core module (§6, §7): the `scene` and `inventory` domains as one plain module
// definition for `sdk.registerModule`. Pure: no SillyTavern, no DOM outside the tab renderers.
//
// The module merges three parts (MODULES §A, §E): the core part below, packs and events.
// The handler ctx (§3.2) has no hooks accessor, so the `item.define` hooks (rules for items the
// story introduces) come in through the factory, and so do this module's settings for the places
// that have no ctx (queries, the tail, the tabs; handlers use ctx.settings()):
//   registry.register(createCoreModule({ hooks: name => registry.hooks(name), settings: () => sdk.settings('story-block') }))
// createCorePart gives the same thing as a MODULES.md part, for a host that merges parts.

import { createInventoryCommands, createInventoryQueries, captureCoin, captureItem, initialInventory, inventoryTail, validateInventory } from './inventory.js';
import { capturePlace, capturePresent, initialScene, sceneCommands, sceneQueries, sceneTail, validateScene } from './scene.js';
import { DEFAULT_CURRENCY, currencyOf } from './money.js';
import { renderInventoryTab } from '../ui/inventory-tab.js';
import { renderSceneTab } from '../ui/scene-tab.js';
import { FEATURE_TEXT, createAssistPart } from '../assist/index.js';
import { CORE_FEATURE } from '../features.js';
import { STRINGS } from '../strings.js';
import { createEventsPart } from '../events/index.js';
import { standardWidgets } from '../view/widgets/index.js';
import { screens as defaultScreens } from '../screens/index.js';
import { createPacksPart, packs as liveInstalled, part as livePart, resolveItem as liveResolve, startState as liveStart } from '../packs/index.js';

// The packs part bound to SillyTavern (src/v2/packs/index.js), in createPacksPart()'s shape.
const livePacks = Object.freeze({ part: livePart, packs: liveInstalled, resolveItem: liveResolve, startState: liveStart });
export { createPacksPart };

export const CORE_MODULE_ID = 'story-block';
// The core part's code tabs that the default screens replace in the module definition.
const SCREEN_TABS = Object.freeze(['inventory', 'scene']);
export const CORE_BUDGET = 400;

// One line for the static prompt part: no names, counts or coins, so it is byte-identical every reply.
export const CORE_STATIC = 'Code keeps the inventory, the wallet, the place and who is present: use or pay only what the '
    + 'lists below hold, and write a change line for every item or coin gained, used or lost and every arrival, departure or move.';

export const CORE_KINDS = Object.freeze({
    item: Object.freeze({ grammar: '+ item Name | qty: 1 | note: short detail (- item Name | qty: 1 when used up or lost; ~ item Name | note: … when it changes)' }),
    coin: Object.freeze({ grammar: '+ coin 30 | from: who (- coin 5 | to: who when paid; one number, in the wallet\'s currency)' }),
    place: Object.freeze({ grammar: '~ place Name | kind: settlement|wild|dungeon|… | region: wider area | with: who came along (the rest stay behind)' }),
    present: Object.freeze({ grammar: '+ present Name when someone arrives, - present Name when they leave' }),
});

// Story Block's own optional pieces as features (MODULES §F100): the status strip and the cards under
// replies (on), the two assist helpers (off; each makes an extra model call). None of them changes the
// static prompt part. The host reads them where the piece is drawn or run (ui-host.js, runtime.js).
export const CORE_FEATURES = Object.freeze([
    Object.freeze({ id: CORE_FEATURE.hud, label: STRINGS.features.hud, describe: STRINGS.features.hudDescribe, default: true }),
    Object.freeze({ id: CORE_FEATURE.cards, label: STRINGS.features.cards, describe: STRINGS.features.cardsDescribe, default: true }),
    Object.freeze({ id: CORE_FEATURE.preroll, label: FEATURE_TEXT.classifier.label, describe: FEATURE_TEXT.classifier.describe, default: false }),
    Object.freeze({ id: CORE_FEATURE.extractor, label: FEATURE_TEXT.extractor.label, describe: FEATURE_TEXT.extractor.describe, default: false }),
]);

// The chat's one currency (MODULES.md F1): its name (singular) and plural, renamable by the reader,
// never a second one.
export const CORE_SETTINGS = Object.freeze({
    section: 'Story Block',
    defaults: Object.freeze({ currency: DEFAULT_CURRENCY.name, currencyPlural: '', currencyShort: '', storyCoinPerReply: 0, economyScale: '0' }),
    schema: Object.freeze({
        currency: Object.freeze({ type: 'text', label: 'Currency (one coin: mark, crown, gold)', max: 24 }),
        currencyPlural: Object.freeze({ type: 'text', label: 'Currency, plural (blank: the name with an s)', max: 24 }),
        currencyShort: Object.freeze({ type: 'text', label: 'Currency, short form (blank: its first letter)', max: 6 }),
        storyCoinPerReply: Object.freeze({
            type: 'int', min: 0, max: 1000000000, label: 'Money one reply may give',
            help: 'The most + coin lines of one reply may pay, in whole coins. 0: the top quest reward for the player character\'s rank (or 1000 per level, times the money scale).',
        }),
        // A number from 0.001 to 1000, kept as text so it can hold a fraction (MODULES §F104).
        economyScale: Object.freeze({
            type: 'text', max: 12, label: 'Money scale (0: the pack\'s)',
            help: 'How many of your coins one coin of the built-in defaults is worth, from 0.001 to 1000: 0.01 for a copper-coin world, 1 for gold. 0 or blank: the enabled pack\'s scale, else 1. Numbers a pack writes are never scaled.',
        }),
    }),
});

/**
 * The core part in MODULES.md A's shape ({ domains, commands, queries, kinds, context, settings,
 * tabs }), for a host that merges parts. `hooks(name) → fn[]` in module-id order (the registry's
 * `hooks`); `settings()` → this module's settings. Without them no hooks run and the currency is gold.
 */
export function createCorePart({ hooks = () => [], settings = () => ({}), hookEntries = null, problem = null, economy = () => null } = {}) {
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
        // The enabled pack's money scale ({ scale } or null) for inventory.economy.
        economy,
        problem: entry => { try { problem?.(entry); } catch { /* the Problems list is not essential */ } },
    };
    const currency = () => currencyOf(env.settings());
    const kind = (grammar, apply) => ({ grammar, apply });
    return {
        domains: {
            scene: { initial: initialScene, validate: slice => validateScene(slice) },
            // Coin and stack sizes are counts: a replay after a deleted reply adds each change to them.
            inventory: { initial: initialInventory, validate: slice => validateInventory(slice), counters: ['wallets/*/coin', 'stacks/*/qty'], scratch: ['perReply'] },
        },
        commands: { ...createInventoryCommands(env), ...sceneCommands },
        queries: { ...createInventoryQueries(env), ...sceneQueries },
        kinds: {
            item: kind(CORE_KINDS.item.grammar, (ctx, line) => captureItem(ctx, line, env)),
            coin: kind(CORE_KINDS.coin.grammar, (ctx, line) => captureCoin(ctx, line, env)),
            place: kind(CORE_KINDS.place.grammar, (ctx, line) => capturePlace(ctx, line)),
            present: kind(CORE_KINDS.present.grammar, (ctx, line) => capturePresent(ctx, line)),
        },
        context: {
            static: () => CORE_STATIC,
            // Half the budget for the lines that always go, half for the optional overflow.
            tail(view) {
                const chars = CORE_BUDGET * 4;
                const scene = sceneTail(view?.state);
                const used = scene.reduce((sum, line) => sum + line.length + 1, 0);
                const inventory = inventoryTail(view?.state, { currency: currency(), chars: chars / 2 - used, optionalChars: chars / 2 });
                return { lines: [...scene, ...inventory.lines], optional: inventory.optional };
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

/**
 * The parts merged into one module definition (MODULES §A): domains, commands and queries side by
 * side (a name in two parts throws), capture by `line.kind`, statics joined in part order, tails
 * concatenated, budgets summed, a hook name shared by parts called in part order (beforeGenerate
 * lines and commands added up; for any other hook the first answer that is not null/undefined),
 * and each part's settings section drawn as its own block in the module's settings panel.
 */
export function mergeParts(parts) {
    const out = { domains: {}, commands: {}, queries: {}, kinds: {}, hooks: {}, tabs: [], statics: [], tails: [], budget: 0, sections: [], defaults: {}, schema: {} };
    const put = (table, name, value, what) => {
        if (Object.hasOwn(out[table], name)) throw new Error(`Story Block: two parts both define the ${what} "${name}".`);
        out[table][name] = value;
    };
    const hookLists = {};
    for (const part of parts) {
        for (const [name, value] of Object.entries(part.domains ?? {})) put('domains', name, value, 'domain');
        for (const [name, value] of Object.entries(part.commands ?? {})) put('commands', name, value, 'command');
        for (const [name, value] of Object.entries(part.queries ?? {})) put('queries', name, value, 'query');
        for (const [name, value] of Object.entries(part.kinds ?? {})) put('kinds', name, value, 'change-line kind');
        for (const [name, fn] of Object.entries(part.hooks ?? {})) if (typeof fn === 'function') (hookLists[name] ??= []).push(fn);
        if (typeof part.context?.static === 'function') out.statics.push(part.context.static);
        if (typeof part.context?.tail === 'function') out.tails.push(part.context.tail);
        if (Number.isInteger(part.context?.budget)) out.budget += part.context.budget;
        out.tabs.push(...(part.tabs ?? []));
        const settings = part.settings ?? {};
        for (const [key, value] of Object.entries(settings.defaults ?? {})) put('defaults', key, value, 'setting');
        Object.assign(out.schema, settings.schema ?? {});
        const render = typeof settings.render === 'function' ? settings.render : typeof settings.section === 'function' ? settings.section : null;
        if (render) out.sections.push({ title: typeof settings.section === 'string' ? settings.section : '', render });
    }
    for (const [name, fns] of Object.entries(hookLists)) {
        out.hooks[name] = fns.length === 1 ? fns[0] : name === 'beforeGenerate'
            ? async (...args) => {
                const lines = [];
                const commands = [];
                for (const fn of fns) {
                    const answer = await fn(...args);
                    if (Array.isArray(answer)) lines.push(...answer);
                    else {
                        lines.push(...(Array.isArray(answer?.lines) ? answer.lines : []));
                        commands.push(...(Array.isArray(answer?.commands) ? answer.commands : []));
                    }
                }
                return { lines, commands };
            }
            : (...args) => {
                for (const fn of fns) {
                    const answer = fn(...args);
                    if (answer !== undefined && answer !== null) return answer;
                }
                return undefined;
            };
    }
    return out;
}

/**
 * The core module definition for `sdk.registerModule` (§6): the core part (scene, inventory), the
 * packs part (item.resolve before story defs, the start state, pack queries and its settings
 * section) and the events part (beforeGenerate, events.fire, events.status, its debug section).
 * `packs`: a createPacksPart() result (default: the one bound to SillyTavern); `command` / `query`:
 * what the events part commits and asks through (default: the public sdk, looked up lazily);
 * `assist`: the assist part (pre-roll classifier, after-reply extractor; both off by default).
 */
export function createCoreModule({ hooks = () => [], settings = () => ({}), version = '2.0.0-alpha.1', packs = livePacks, command, query, assist = null, hookEntries = null, problem = null } = {}) {
    const core = createCorePart({ hooks, settings, hookEntries, problem, economy: () => (typeof packs.economy === 'function' ? packs.economy() : null) });
    const events = createEventsPart({
        ...(command ? { command } : {}),
        ...(query ? { query } : {}),
    });
    const merged = mergeParts([core, packs.part, events, assist ?? createAssistPart({ settings: () => settings() })]);
    return {
        id: CORE_MODULE_ID,
        name: 'Story Block',
        version,
        features: CORE_FEATURES.map(feature => ({ ...feature })),
        domains: merged.domains,
        commands: merged.commands,
        queries: merged.queries,
        capture: {
            kinds: CORE_KINDS,
            apply(ctx, line) {
                const kind = merged.kinds[line?.kind];
                if (!kind) return ctx.fail('INVALID', `Story Block does not handle "${line?.kind}" lines.`);
                return kind.apply(ctx, line);
            },
        },
        context: {
            static: () => merged.statics.map(fn => fn()).filter(text => typeof text === 'string' && text.trim()).join('\n'),
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
            budget: merged.budget || CORE_BUDGET,
        },
        hooks: merged.hooks,
        settings: {
            defaults: merged.defaults,
            schema: merged.schema,
            // Each part's own panel (Packs, Events) under its title, below the schema rows.
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
