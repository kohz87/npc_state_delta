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
    featureOn, initialInventory, inventoryTail, validateInventory, LOOT_KINDS, lootTakeGuard, INVENTORY_EDIT_GUARD, inventoryEditGuard,
} from './inventory.js';
import { WEATHER_CHARS, YOU_CHARS, capturePlace, capturePresent, captureWeather, captureYou, initialScene, sceneCommands, sceneQueries, sceneTail, validateScene } from './scene.js';
import { MOUNTS_FEATURE, captureMount, createMountsQueries, mountsCommands, mountsTail } from './mounts.js';
import { DEFAULT_CURRENCY, MAX_COIN_VALUE, moneyLine, resolveCurrency } from './money.js';
import { renderInventoryTab } from '../ui/inventory-tab.js';
import { renderSceneTab } from '../ui/scene-tab.js';
import { FEATURE_TEXT, createAssistPart } from '../assist/index.js';
import { CORE_FEATURE } from '../features.js';
import { EXTRA_KINDS, answeredReply, chatterTail, headChatter, sceneChatter } from '../extras.js';
import { createEvidenceQuery } from '../evidence.js';
import { STRINGS } from '../strings.js';
import { createEventsPart } from '../events/index.js';
import { standardWidgets } from '../view/widgets/index.js';
import { screens as defaultScreens } from '../screens/index.js';
import { youRankOf } from '../packs/content.js';
import { createPacksPart, packs as liveInstalled, part as livePart, resolveItem as liveResolve, startState as liveStart } from '../packs/index.js';
import { createTimelinePart } from '../timeline/part.js';
import { createDataModulesPart, dataModuleGuard } from '../data-modules/part.js';
import { RESOLVE as RPG_RESOLVE, createLeanRpgPart, partyOf } from '../lean-rpg/index.js';
import { hookTimeout } from '../turn.js';

// The Rank's label for the tail: asked through the view's query (null while no pack gives one).
function youRankLabel(view) {
    try { return view.query('packs.youRank')?.label ?? ''; } catch { return ''; }
}

const TIMED_OUT = Symbol('timed out');
// `value`, or TIMED_OUT when it is a promise that has not settled within `ms`.
async function withinLimit(value, ms) {
    if (!value || typeof value.then !== 'function') return value;
    let timer;
    try {
        return await Promise.race([value, new Promise(resolve => { timer = setTimeout(resolve, ms, TIMED_OUT); })]);
    } finally {
        clearTimeout(timer);
    }
}

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

/** The `~ you` grammar line: wearing and condition, and a rank under the pack's own word for it (`label`) when a pack gives one. */
export function youGrammar(label = '') {
    return `~ you ${label ? `rank: ${label} | ` : ''}wearing: what {{user}} has on | condition: how {{user}} is (only when one changes; each at most ${YOU_CHARS} characters)`;
}

export const CORE_KINDS = Object.freeze({
    item: Object.freeze({ grammar: '+ item Name | qty: 1 | note: short detail (- item Name | qty: 1 when used up or lost; ~ item Name | note: … when it changes)' }),
    coin: Object.freeze({ grammar: '+ coin 30 | from: who (- coin 5 | to: who when paid; one number, in the wallet\'s currency)' }),
    place: Object.freeze({ grammar: '~ place Name | kind: settlement|wild|dungeon|… | region: wider area | with: who came along (the rest stay behind)' }),
    present: Object.freeze({ grammar: '+ present Name when someone arrives, - present Name when they leave; when someone already here is first named, - present the old word and + present the name (- present clerk, + present Nelje)' }),
    // MODULES §F120: the weather, descriptive only; its grammar line only while `story-block.weather` is on.
    weather: Object.freeze({ grammar: `~ weather cold drizzle, low fog (only when the weather changes, not every reply; a few words, at most ${WEATHER_CHARS} characters)`, feature: CORE_FEATURE.weather }),
    // MODULES §F126: {{user}}'s rank, what they wear and how they are, descriptive only; its grammar line only while `story-block.you` is on.
    // Without a pack that gives a Rank (`content.you.rank`) the line names wearing and condition only; with one, `youGrammar(label)`.
    you: Object.freeze({ grammar: youGrammar(''), feature: CORE_FEATURE.you }),
    // The party's mounts (src/v2/domains/mounts.js): their grammar line only while `story-block.mounts` is on.
    mount: Object.freeze({ grammar: '+ mount Name | kind: horse|mule|cart|… | count: 1 | pace: km/day | where: who rides or where it is (~ mount Name | condition: lame; - mount Name when lost or sold; at most 6)', feature: CORE_FEATURE.mounts }),
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
    // The weather (MODULES §F120): on; its grammar line is in the static part while it is on.
    Object.freeze({ id: CORE_FEATURE.weather, label: STRINGS.features.weather, describe: STRINGS.features.weatherDescribe, default: true }),
    // Your look (MODULES §F126): on; its grammar line is in the static part while it is on.
    Object.freeze({ id: CORE_FEATURE.you, label: STRINGS.features.you, describe: STRINGS.features.youDescribe, default: true }),
    // The mounts: on; the grammar line and the narrator's line are there only while it is on.
    Object.freeze({ id: CORE_FEATURE.mounts, label: STRINGS.features.mounts, describe: STRINGS.features.mountsDescribe, default: true }),
    Object.freeze({ id: CORE_FEATURE.leanRpg, label: STRINGS.features.leanRpg, describe: STRINGS.features.leanRpgDescribe, default: false }),
]);

// The chat's one currency (MODULES.md F1): its name (singular) and plural, renamable by the reader,
// never a second one.
export const CORE_SETTINGS = Object.freeze({
    section: 'Story Block',
    defaults: Object.freeze({ currency: DEFAULT_CURRENCY.name, currencyPlural: '', currencyShort: '', economyScale: '0', coins: Object.freeze([]), coinDisplay: 'mixed', chatterInPrompt: false }),
    schema: Object.freeze({
        currency: Object.freeze({ type: 'text', label: 'Currency (one coin: mark, crown, gold)', max: 24 }),
        currencyPlural: Object.freeze({ type: 'text', label: 'Currency, plural (blank: the name with an s)', max: 24 }),
        currencyShort: Object.freeze({ type: 'text', label: 'Currency, short form (blank: its first letter)', max: 6 }),
        // A number from 0.001 to 1000, kept as text so it can hold a fraction (MODULES §F104).
        economyScale: Object.freeze({
            type: 'text', max: 12, label: 'Money scale (0: the pack\'s)',
            help: 'How many of your coins one coin of the built-in defaults is worth, from 0.001 to 1000: 100 for a copper-coin world (a hundred copper to a built-in gold), 1 for gold. 0 or blank: the enabled pack\'s scale, else 1. Numbers a pack writes are never scaled.',
        }),
        // The world's coins (money.js coinsOf, MODULES §F108): "copper: 1", "silver: 10", smallest first.
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
export function createCorePart({ hooks = () => [], settings = () => ({}), hookEntries = null, problem = null, economy = () => null, youRank = () => null, query = null, rpgOn = () => false } = {}) {
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
        queries: { ...createInventoryQueries(env), ...sceneQueries, ...createMountsQueries({ riders: state => (rpgOn() ? Math.max(1, partyOf(state).filter(person => !person.left).length) : 1) }) },
        kinds: {
            item: kind(CORE_KINDS.item.grammar, (ctx, line) => captureItem(ctx, line, env)),
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
            static: () => [CORE_STATIC, moneyLine(currency())].join('\n'),
            // Half the budget for the lines that always go, half for the optional overflow.
            tail(view) {
                const chars = CORE_BUDGET * 4;
                const mounts = featureOn(view, MOUNTS_FEATURE) ? mountsTail(view?.state) : null;
                const scene = [...sceneTail(view?.state, { weather: featureOn(view, CORE_FEATURE.weather), you: featureOn(view, CORE_FEATURE.you), rankLabel: featureOn(view, CORE_FEATURE.you) ? youRankLabel(view) : '' }), ...(mounts ? [mounts] : [])];
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
    const out = { domains: {}, commands: {}, queries: {}, kinds: {}, cards: {}, hooks: {}, tabs: [], statics: [], tails: [], budget: 0, sections: [], folds: [], defaults: {}, schema: {} };
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
        for (const [name, value] of Object.entries(part.cards ?? {})) put('cards', name, value, 'card under replies');
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
            ? Object.assign(async (...args) => {
                const lines = [];
                const commands = [];
                const problems = [];
                // Each part has its own time limit (turn.js hookTimeout): a part that fails or is too slow is reported, and the
                // answers of the parts that did answer are kept.
                for (const fn of fns) {
                    const limit = hookTimeout(fn);
                    let answer;
                    try { answer = await withinLimit(fn(...args), limit); } catch (error) {
                        problems.push({ code: 'FAILED', message: `beforeGenerate failed: ${error?.message ?? error}` });
                        continue;
                    }
                    if (answer === TIMED_OUT) {
                        problems.push({ code: 'TIMEOUT', message: `beforeGenerate did not answer within ${limit / 1000} s; the reply went on without its notes.` });
                        continue;
                    }
                    if (Array.isArray(answer)) lines.push(...answer);
                    else {
                        lines.push(...(Array.isArray(answer?.lines) ? answer.lines : []));
                        commands.push(...(Array.isArray(answer?.commands) ? answer.commands : []));
                    }
                }
                return { lines, commands, ...(problems.length ? { problems } : {}) };
            }, { timeoutMs: fns.reduce((sum, fn) => sum + hookTimeout(fn), 500) })
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
 * is full). Off (the default), nothing: chatter never reaches a later prompt. `extras`: { promptChat() →
 * SillyTavern's chat without the messages a restore faded (the timeline's active-history reader), display(mes) → displayLines' answer };
 * without it, nothing.
 */
export function chatterBack(settings, extras) {
    let on = false;
    try { on = settings()?.chatterInPrompt === true; } catch { on = false; }
    if (!on || typeof extras?.promptChat !== 'function' || typeof extras.display !== 'function') return { lines: [], optional: [] };
    const chat = extras.promptChat();
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
export function createCoreModule({ hooks = () => [], settings = () => ({}), version = '2.0.0-alpha.1', packs = livePacks, command, query, assist = null, hookEntries = null, problem = null, extras = null, timeline = () => null, dataModules = {}, leanRpg = {} } = {}) {
    const core = createCorePart({ hooks, settings, hookEntries, problem, query, rpgOn: () => { try { return extras?.rpgOn?.() === true; } catch { return false; } }, economy: () => (typeof packs.economy === 'function' ? packs.economy() : null), youRank: () => youRankOf(typeof packs.packs?.packs === 'function' ? packs.packs.packs() : []) });
    const events = createEventsPart({
        ...(command ? { command } : {}),
        ...(query ? { query } : {}),
    });
    const dataPart = createDataModulesPart({ packs: packs.packs, settings: () => settings(), ...dataModules });
    // The RPG's pre-call and rolls (`leanRpg`: the runtime's queued model call, the chat and its metadata; src/v2/lean-rpg/).
    const rpg = createLeanRpgPart({ ...leanRpg, problem });
    const merged = mergeParts([core, packs.part, events, assist ?? createAssistPart({ settings: () => settings() }), createTimelinePart({ timeline }), dataPart, rpg]);
    const timelineGuard = merged.hooks.replayGuard;
    // One host-owned hook for the host's guarded blocks, by predicate: data modules (`dm.*`), the RPG's rolls
    // (`rpg.resolve`), a loot offer or take (`loot.offer`, `loot.take`, inventory.js), else the timeline's.
    merged.hooks.replayGuard = Object.assign((view, info) => {
        const kind = String(info?.guard?.predicate?.kind ?? '');
        if (kind.startsWith('dm.')) return dataModuleGuard(view, info);
        if (kind === RPG_RESOLVE) return rpg.guard(view, info);
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
            kinds: { ...CORE_KINDS, you: { ...CORE_KINDS.you, grammar: merged.kinds.you.grammar }, dm: merged.kinds.dm, party: merged.kinds.party },
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
