// Story Block's core module (§6, §7): the `scene` and `inventory` domains as one plain module
// definition for `sdk.registerModule`. Pure: no SillyTavern, no DOM outside the tab renderers.
//
// The module merges three parts (MODULES §A, §E): the core part below, packs and events.
// The handler ctx (§3.2) has no hooks accessor, so the `item.define` hooks (rules for items the
// story introduces) come in through the factory, and so do this module's settings for the places
// that have no ctx (queries, the tail, the tabs; handlers use ctx.settings()):
//   registry.register(createCoreModule({ hooks: name => registry.hooks(name), settings: () => sdk.settings('story-block') }))
// createCorePart gives the same thing as a MODULES.md part, for a host that merges parts.

import {
    FEATURE, INVENTORY_FEATURES, createInventoryCommands, createInventoryQueries, captureCoin, captureItem, captureLoot, encumbranceTail,
    featureOn, initialInventory, inventoryTail, validateInventory,
} from './inventory.js';
import { capturePlace, capturePresent, initialScene, sceneCommands, sceneQueries, sceneTail, validateScene } from './scene.js';
import { DEFAULT_CURRENCY, MAX_COIN_VALUE, coinLine, currencyOf } from './money.js';
import { renderInventoryTab } from '../ui/inventory-tab.js';
import { renderSceneTab } from '../ui/scene-tab.js';
import { FEATURE_TEXT, createAssistPart } from '../assist/index.js';
import { CORE_FEATURE } from '../features.js';
import { EXTRA_KINDS, answeredReply, chatterTail, headChatter } from '../extras.js';
import { STRINGS } from '../strings.js';
import { createEventsPart } from '../events/index.js';
import { standardWidgets } from '../view/widgets/index.js';
import { screens as defaultScreens } from '../screens/index.js';
import { createPacksPart, packs as liveInstalled, part as livePart, resolveItem as liveResolve, startState as liveStart } from '../packs/index.js';
import { firstPackRanks, readerRanks } from '../packs/ranks.js';

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
    // MODULES §F100: off, the kind and its grammar line are left out (a host without Features keeps it).
    loot: Object.freeze({ grammar: '? loot Thing, Other Thing x2 — where it lies (things the party could pick up; the reader chooses what to take)', feature: FEATURE.loot }),
    // MODULES §F115: display kinds, read for the reader alone (src/v2/extras.js); each under its feature.
    ...EXTRA_KINDS,
});

// Story Block's own optional pieces as features (MODULES §F100): the status strip and the cards under
// replies (on), the two assist helpers (off; each makes an extra model call), the state inspector (off)
// and save points (on). None of them changes the
// static prompt part. The host reads them where the piece is drawn or run (ui-host.js, runtime.js).
export const CORE_FEATURES = Object.freeze([
    Object.freeze({ id: CORE_FEATURE.hud, label: STRINGS.features.hud, describe: STRINGS.features.hudDescribe, default: true }),
    Object.freeze({ id: CORE_FEATURE.cards, label: STRINGS.features.cards, describe: STRINGS.features.cardsDescribe, default: true }),
    // The pre-roll only works with a module that keeps `? check` lines.
    Object.freeze({ id: CORE_FEATURE.preroll, label: FEATURE_TEXT.classifier.label, describe: FEATURE_TEXT.classifier.describe, default: false, needs: Object.freeze({ kinds: Object.freeze(['check']), why: FEATURE_TEXT.classifier.needs }) }),
    Object.freeze({ id: CORE_FEATURE.extractor, label: FEATURE_TEXT.extractor.label, describe: FEATURE_TEXT.extractor.describe, default: false }),
    // The state inspector is for testers and pack authors (off); save points are for every reader (on).
    Object.freeze({ id: CORE_FEATURE.inspector, label: STRINGS.features.inspector, describe: STRINGS.features.inspectorDescribe, default: false }),
    Object.freeze({ id: CORE_FEATURE.savepoints, label: STRINGS.features.savepoints, describe: STRINGS.features.savepointsDescribe, default: true }),
    // Choices and Inner chatter (MODULES §F115): off; on, each adds its grammar line to the static part.
    Object.freeze({ id: CORE_FEATURE.choices, label: STRINGS.features.choices, describe: STRINGS.features.choicesDescribe, default: false }),
    Object.freeze({ id: CORE_FEATURE.chatter, label: STRINGS.features.chatter, describe: STRINGS.features.chatterDescribe, default: false }),
]);

// The chat's one currency (MODULES.md F1): its name (singular) and plural, renamable by the reader,
// never a second one.
export const CORE_SETTINGS = Object.freeze({
    section: 'Story Block',
    defaults: Object.freeze({ currency: DEFAULT_CURRENCY.name, currencyPlural: '', currencyShort: '', storyCoinPerReply: 0, economyScale: '0', coins: Object.freeze([]), coinDisplay: 'mixed', chatterInPrompt: false }),
    schema: Object.freeze({
        currency: Object.freeze({ type: 'text', label: 'Currency (one coin: mark, crown, gold)', max: 24 }),
        currencyPlural: Object.freeze({ type: 'text', label: 'Currency, plural (blank: the name with an s)', max: 24 }),
        currencyShort: Object.freeze({ type: 'text', label: 'Currency, short form (blank: its first letter)', max: 6 }),
        storyCoinPerReply: Object.freeze({
            type: 'int', min: 0, max: 1000000000, label: 'Money one reply may give',
            help: 'The most + coin lines of one reply may pay, in whole coins. 0: worked out from your installed modules (a quest rank\'s top reward, or 1000 per character level, times the money scale; 1000 times the scale when neither is installed).',
        }),
        // A number from 0.001 to 1000, kept as text so it can hold a fraction (MODULES §F104).
        economyScale: Object.freeze({
            type: 'text', max: 12, label: 'Money scale (0: the pack\'s)',
            help: 'How many of your coins one coin of the built-in defaults is worth, from 0.001 to 1000: 100 for a copper-coin world (a hundred copper to a built-in gold), 1 for gold. 0 or blank: the enabled pack\'s scale, else 1. Numbers a pack writes are never scaled.',
        }),
        // The world's coins (money.js coinsOf, MODULES §F108): "copper: 1", "silver: 10", smallest first.
        // The rank ladder moved to RPG Battle's Terms (MODULES §F105, `ranks.reader` hook below).
        coins: Object.freeze({
            type: 'list', label: 'Coins (smallest first)', form: 'lines',
            of: Object.freeze({ name: Object.freeze({ type: 'text', label: 'Coin', max: 49 }), value: Object.freeze({ type: 'int', label: 'Worth', min: 1, max: MAX_COIN_VALUE }) }),
            help: 'The coins of this world and what each is worth in the smallest one, one per line: "copper: 1", "silver: 10", "gold: 100" (a plural after a slash: "penny/pennies: 1"). The wallet counts the smallest coin; "+ coin 3 silver" is 30 copper. Empty: the enabled pack\'s coins, else the one currency above.',
        }),
        coinDisplay: Object.freeze({
            type: 'choice', label: 'Coin display', options: Object.freeze([
                Object.freeze({ value: 'mixed', label: 'Mixed coins (3 silver 5 copper)' }),
                Object.freeze({ value: 'base', label: 'Smallest coin only (35 copper)' }),
            ]),
            help: 'How amounts are shown when the world has coins.',
        }),
        // MODULES §F115: chatter stays out of later prompts unless the reader asks (it would steer the story).
        chatterInPrompt: Object.freeze({ type: 'bool', group: 'Inner chatter', label: STRINGS.extras.inPrompt, help: STRINGS.extras.inPromptHelp, feature: CORE_FEATURE.chatter }),
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
            inventory: { initial: initialInventory, validate: slice => validateInventory(slice), counters: ['wallets/*/coin', 'stacks/*/qty'], scratch: ['perReply', 'storyClicks', 'loot', 'condLog'] },
        },
        commands: { ...createInventoryCommands(env), ...sceneCommands },
        queries: { ...createInventoryQueries(env), ...sceneQueries },
        kinds: {
            item: kind(CORE_KINDS.item.grammar, (ctx, line) => captureItem(ctx, line, env)),
            coin: kind(CORE_KINDS.coin.grammar, (ctx, line) => captureCoin(ctx, line, env)),
            place: kind(CORE_KINDS.place.grammar, (ctx, line) => capturePlace(ctx, line)),
            present: kind(CORE_KINDS.present.grammar, (ctx, line) => capturePresent(ctx, line)),
            loot: { ...kind(CORE_KINDS.loot.grammar, (ctx, line) => captureLoot(ctx, line, env)), feature: FEATURE.loot },
        },
        context: {
            // The coins' line (money.js coinLine) only when the world has coins: it changes with them only.
            static: () => [CORE_STATIC, coinLine(currency())].filter(Boolean).join('\n'),
            // Half the budget for the lines that always go, half for the optional overflow.
            tail(view) {
                const chars = CORE_BUDGET * 4;
                const scene = sceneTail(view?.state);
                // The encumbered condition, when the carry module reports it (one short line).
                // Asked through the query, which a host with Features answers with null while it is off.
                let found = null;
                try { found = featureOn(view, FEATURE.encumbrance) ? view.query('inventory.encumbrance') : null; } catch { found = null; }
                const heavy = encumbranceTail(found);
                const used = [...scene, ...heavy].reduce((sum, line) => sum + line.length + 1, 0);
                const inventory = inventoryTail(view?.state, { currency: currency(), chars: chars / 2 - used, optionalChars: chars / 2 });
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

/**
 * The parts merged into one module definition (MODULES §A): domains, commands and queries side by
 * side (a name in two parts throws), capture by `line.kind`, statics joined in part order, tails
 * concatenated, budgets summed, a hook name shared by parts called in part order (beforeGenerate
 * lines and commands added up; for any other hook the first answer that is not null/undefined),
 * and each part's settings section drawn as its own block in the module's settings panel (or, with
 * `settings.fold`, as a fold of its own at the top of the settings: `folds`; with `settings.place:
 * 'diagnostics'`, a fold of its own in Settings → Diagnostics, its id `settings.fold.id` else its title
 * in lowercase: the Events).
 */
export function mergeParts(parts) {
    const out = { domains: {}, commands: {}, queries: {}, kinds: {}, hooks: {}, tabs: [], statics: [], tails: [], budget: 0, sections: [], folds: [], defaults: {}, schema: {} };
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
        const title = typeof settings.section === 'string' ? settings.section : '';
        // A part whose panel is a fold of its own (`settings.fold: { id, hint? }`, the Packs) goes to the top
        // of the settings instead of the module's section.
        // A part whose panel is debug information (`settings.place: 'diagnostics'`, the Events) is a fold of
        // its own in Settings → Diagnostics.
        if (render && settings.place === 'diagnostics') {
            const id = typeof settings.fold?.id === 'string' ? settings.fold.id : title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            out.folds.push({ id, title: title || id, hint: settings.fold?.hint ?? '', render, place: 'diagnostics' });
        } else if (render && settings.fold && typeof settings.fold.id === 'string') out.folds.push({ id: settings.fold.id, title: title || settings.fold.id, hint: settings.fold.hint ?? '', render });
        else if (render) out.sections.push({ title, render });
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
 * The tail part of Inner chatter (MODULES §F115): with the reader's `chatterInPrompt` on, the thoughts
 * of the reply the reader's latest message answered, as one optional line (dropped first when the tail
 * is full). Off (the default), nothing: chatter never reaches a later prompt. `extras`: { chat() →
 * SillyTavern's chat, display(mes) → displayLines' answer }; without it, nothing.
 */
export function chatterBack(settings, extras) {
    let on = false;
    try { on = settings()?.chatterInPrompt === true; } catch { on = false; }
    if (!on || typeof extras?.chat !== 'function' || typeof extras.display !== 'function') return { lines: [], optional: [] };
    const chat = extras.chat();
    const at = answeredReply(chat);
    if (at < 0) return { lines: [], optional: [] };
    const line = chatterTail(extras.display(String(chat[at]?.mes ?? '')).chatter);
    return { lines: [], optional: line ? [line] : [] };
}

/**
 * `scene.moved` → true when the head reply (the last carrier) moved the scene to another place: one of
 * its receipts is a `scene.place` (a `~ place` line: `capture.place`) that says `moved`. From the line's receipts (tools.receipts), so a
 * swipe, a delete or a Re-read answers as a rebuild does. False without a head or receipts.
 */
const PLACE_RECEIPTS = new Set(['scene.place', 'capture.place']);
export function headMoved(tools, headIndex) {
    let head = -1;
    try { head = typeof headIndex === 'function' ? headIndex() : -1; } catch { head = -1; }
    if (!Number.isInteger(head) || head < 0) return false;
    let list = [];
    try { list = typeof tools?.receipts === 'function' ? tools.receipts() ?? [] : []; } catch { list = []; }
    return list.some(entry => entry?.index === head && PLACE_RECEIPTS.has(entry.receipt?.type) && entry.receipt?.data?.moved === true);
}

/**
 * The core module definition for `sdk.registerModule` (§6): the core part (scene, inventory), the
 * packs part (item.resolve before story defs, the start state, pack queries and its settings
 * section) and the events part (beforeGenerate, events.fire, events.status, its debug section, in
 * Settings → Diagnostics).
 * `packs`: a createPacksPart() result (default: the one bound to SillyTavern); `command` / `query`:
 * what the events part commits and asks through (default: the public sdk, looked up lazily);
 * `assist`: the assist part (pre-roll classifier, after-reply extractor; both off by default).
 */
/** The first `ranks.reader` hook's ladder that has lines: { lines, perRank }, or null (a failing hook is skipped). */
export function readerLadder(hooks) {
    let fns = [];
    try { fns = typeof hooks === 'function' ? hooks('ranks.reader') : []; } catch { fns = []; }
    for (const fn of Array.isArray(fns) ? fns : []) {
        let got = null;
        try { got = typeof fn === 'function' ? fn() : null; } catch { got = null; }
        if (got && Array.isArray(got.lines) && got.lines.length) return { lines: got.lines, perRank: Number.isInteger(got.perRank) && got.perRank > 0 ? got.perRank : 0 };
    }
    return null;
}

export function createCoreModule({ hooks = () => [], settings = () => ({}), version = '2.0.0-alpha.1', packs = livePacks, command, query, assist = null, hookEntries = null, problem = null, extras = null } = {}) {
    const core = createCorePart({ hooks, settings, hookEntries, problem, economy: () => (typeof packs.economy === 'function' ? packs.economy() : null) });
    const events = createEventsPart({
        ...(command ? { command } : {}),
        ...(query ? { query } : {}),
    });
    const merged = mergeParts([core, packs.part, events, assist ?? createAssistPart({ settings: () => settings() })]);
    // The reader's rank ladder answers packs.content's ranks in place of the packs', with the first pack's
    // numbers at each place (packs/ranks.js); a call for one pack's own ranks (`pack`) is the pack's as
    // before. The ladder is a module's setting (RPG Battle's Terms: Rank ladder and Levels per rank),
    // given by its `ranks.reader()` hook → { lines, perRank } (the first that gives lines); without such
    // a module there is no reader's ladder, and every module keeps its own or the pack's (MODULES §F105).
    const content = merged.queries['packs.content'];
    if (typeof content === 'function') {
        merged.queries['packs.content'] = (state, args = {}, tools) => {
            const answer = content(state, args, tools);
            if (args?.kind !== 'ranks' || args?.pack) return answer;
            const given = readerLadder(hooks);
            const own = given ? readerRanks(given.lines, firstPackRanks(answer), { perRank: given.perRank }) : [];
            return own.length ? own : answer;
        };
    }
    return {
        id: CORE_MODULE_ID,
        name: 'Story Block',
        version,
        features: [...CORE_FEATURES, ...INVENTORY_FEATURES].map(feature => ({ ...feature })),
        domains: merged.domains,
        commands: merged.commands,
        // The newest reply's Inner chatter, [{ name, text }] (MODULES §F115; null while the feature is off), and
        // whether the head reply moved the scene to another place (Story Director's World → Here, §F119).
        queries: {
            ...merged.queries,
            'chatter.head': Object.assign(() => headChatter(extras?.chat?.(), extras?.display), { feature: CORE_FEATURE.chatter }),
            'scene.moved': (_state, _args, tools) => headMoved(tools, extras?.headIndex),
        },
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
