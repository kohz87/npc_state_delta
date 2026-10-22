// Story Suite v2: the screen registry (SPEC §13.1, §13.7). Every screen is data; this module keeps the
// definitions from every source, checks them, and answers "which definition does screen X use now?".
//
// * Sources, strongest first: the reader's choice (settings), the card's, a pack's, the module default.
//   Packs are kept in the order they were first set; the one set last wins among packs.
// * The reader's choice is either a whole screen definition (the reader's own version) or a pin
//   `{ use: 'module' | 'card' | 'pack' | 'pack:<id>' }`. `reset(id)` pins the module default; `clearChoice`
//   drops the reader's entry so the normal order applies again.
// * A definition that fails `validateScreen` is skipped: the next source is used and the reason is kept
//   (`resolve(id).fallbacks`, `problems()`) for the settings overlay.
// * Data bindings (`data: { alias: { query, args } }`) run in dependency order: an argument written as
//   `$alias.path` takes the value of an earlier binding. An unknown alias or a cycle is an error.
//
// * Navigation order (the game view, the Story panel's tabs), before the reader's own (view/tab-order.js):
//   the suite's own screens in DEFAULT_ORDER (Home, Party, Inventory, Quests, World, Map, Fight,
//   Crafting, Trade, Scene, Chronicle, then any other screen, the Director, the game master's view, and
//   NPC State Delta's Dossiers, the dossier browser, last); another screen may say `order` (a number, lower first) or takes DEFAULT_ORDER's place for
//   the last part of its id, else REST_ORDER. Home is always first: no order a module gives can move it down.
//
// * A theme's values pass the same checks the page applies (css.js themeVars: one CSS value each, nothing
//   that loads or runs anything but data:/https:); a screen with one unsafe value is skipped as a whole.
//
// Pure: no DOM, no SillyTavern. Reader settings come in and go out through injected functions.

import { themeVars } from './css.js';

export const MOUNTS = Object.freeze(['tab', 'screen', 'card', 'hud', 'dialog']);
export const SOURCES = Object.freeze(['reader', 'card', 'pack', 'module']);
export const CSS_LIMIT = 64 * 1024;

const SCREEN_ID = /^[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF = /^\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[\w-]+)*)$/;
const PROPERTY = /^--[A-Za-z0-9_-]+$/;
const BINDING_KEYS = new Set(['query', 'args']);
const STEP_KEYS = new Set(['id', 'title', 'template', 'layout']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The game view's landing page: always the first screen and the first tab. */
export const HOME_ID = 'story-block/home';
// The default places, by the last part of an id ('rpg-battle/party' → party): the party and what it
// carries, what it is doing and where, the activities, the scene, the record, the Director (the game
// master's view, with what the reader has not been told) and, last, NPC State Delta's Dossiers (its old
// Cast id, `npc-state-delta/cast`: the people present are on the World screen now, so the dossier
// browser goes to the end; a reader's saved order keeps its own place for it, tab-order.js).
export const DEFAULT_ORDER = Object.freeze({
    party: 10, inventory: 20, quests: 30, world: 40, map: 50, fight: 60, crafting: 70, trade: 80,
    scene: 100, chronicle: 110, director: 200, cast: 210,
});
// Screens hidden by default while another screen is registered, the one that shows the same and more
// (MODULES §F119): Story Block's Scene (place, kind, region, story time, the people with portraits) while
// Story Director's World is there, whose Now → Here has all of it. The reader shows it again in Settings →
// Story Suite → Tabs; their saved choice wins (view/tab-order.js). Home's scene panel is not a screen here.
export const DEFAULT_HIDDEN = Object.freeze({ 'story-block/scene': 'story-director/world' });
// A screen with no `order` and no default place: after the suite's own, before the Director.
export const REST_ORDER = 150;
// The suite's own screens and tabs: always in DEFAULT_ORDER, whatever `order` an older module still gives
// (Cast, now Dossiers, once said 35); the reader moves them in Settings → Story Suite → Tabs.
export const SUITE_NAV = Object.freeze([
    'rpg-battle/party', 'story-block/inventory', 'story-director/quests', 'story-director/world', 'story-director/map',
    'rpg-battle/fight', 'rpg-battle/crafting', 'rpg-battle/trade', 'story-block/scene',
    'story-director/chronicle', 'story-director/director', 'npc-state-delta/cast',
]);

/**
 * A screen's (or a tab's) place in the navigation, lower first: 0 for Home; one of the suite's own
 * (SUITE_NAV) its DEFAULT_ORDER place; else its own `order` (at least 1, so nothing goes before Home),
 * else DEFAULT_ORDER by the id's last part, else REST_ORDER.
 */
export function screenOrder(id, order = null) {
    const text = String(id ?? '');
    if (text === HOME_ID) return 0;
    const name = text.split('/').pop().toLowerCase();
    if (SUITE_NAV.includes(text)) return DEFAULT_ORDER[name];
    if (typeof order === 'number' && Number.isFinite(order)) return Math.max(1, order);
    return Object.hasOwn(DEFAULT_ORDER, name) ? DEFAULT_ORDER[name] : REST_ORDER;
}

/** `list` sorted for navigation: by screenOrder, ties kept in the order given. `idOf` / `orderOf` read an entry. */
export function byNavOrder(list, idOf = entry => entry.id, orderOf = entry => entry.order) {
    return list
        .map((entry, at) => ({ entry, at, rank: screenOrder(idOf(entry), orderOf(entry)) }))
        .sort((a, b) => a.rank - b.rank || a.at - b.at)
        .map(item => item.entry);
}
const utf8 = new TextEncoder();
const label = def => (typeof def?.id === 'string' && def.id ? `Screen "${def.id}"` : 'The screen');

/** One error string per problem with a screen definition; empty when it is fine. */
export function validateScreen(def, { id = null } = {}) {
    if (!isRecord(def)) return ['A screen definition must be an object.'];
    const errors = [];
    const name = label(def);
    if (typeof def.id !== 'string' || !SCREEN_ID.test(def.id)) {
        errors.push('The screen needs an id made of letters, digits, ".", "_", "-" and "/" (for example "rpg-battle/party").');
    } else if (id !== null && def.id !== id) {
        errors.push(`${name} was given for screen "${id}".`);
    }
    if (def.title !== undefined && typeof def.title !== 'string') errors.push(`${name}: the title must be text.`);
    if (def.defaultOn !== undefined && typeof def.defaultOn !== 'boolean') errors.push(`${name}: defaultOn must be true or false.`);
    if (def.icon !== undefined && typeof def.icon !== 'string') errors.push(`${name}: the icon must be text.`);
    if (def.order !== undefined && !(typeof def.order === 'number' && Number.isFinite(def.order))) errors.push(`${name}: order must be a number (lower comes first).`);

    const mounts = Array.isArray(def.mounts) ? def.mounts : null;
    if (!mounts || !mounts.length) errors.push(`${name} must list where it may appear (mounts: ${MOUNTS.join(', ')}).`);
    else {
        for (const mount of mounts) if (!MOUNTS.includes(mount)) errors.push(`${name}: "${mount}" is not a mount (use ${MOUNTS.join(', ')}).`);
        if (new Set(mounts).size !== mounts.length) errors.push(`${name} lists a mount twice.`);
    }

    errors.push(...bodyErrors(def, name));
    if (def.css !== undefined) {
        if (typeof def.css !== 'string') errors.push(`${name}: css must be text.`);
        else if (utf8.encode(def.css).length > CSS_LIMIT) errors.push(`${name}: css is larger than 64 KB.`);
    }
    if (def.theme !== undefined) {
        if (!isRecord(def.theme)) errors.push(`${name}: theme must be an object of CSS custom properties.`);
        else {
            for (const [key, value] of Object.entries(def.theme)) {
                if (!PROPERTY.test(key)) errors.push(`${name}: theme key "${key}" is not a CSS custom property (--name).`);
                else if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
                    errors.push(`${name}: theme value for ${key} must be text or a number.`);
                } else {
                    for (const warning of themeVars({ [key]: value }).warnings) errors.push(`${name}: ${warning}`);
                }
            }
        }
    }
    if (def.data !== undefined) errors.push(...dataErrors(def.data, name));
    if (def.steps !== undefined) errors.push(...stepErrors(def, name, mounts));
    return errors;
}

// Exactly one of `template` (HTML text) and `layout` ({ root: Node }).
function bodyErrors(def, name, what = '') {
    const hasTemplate = def.template !== undefined;
    const hasLayout = def.layout !== undefined;
    if (hasTemplate === hasLayout) return [`${name}${what} needs exactly one of template or layout.`];
    if (hasTemplate && typeof def.template !== 'string') return [`${name}${what}: the template must be text.`];
    if (hasLayout && !(isRecord(def.layout) && isRecord(def.layout.root))) return [`${name}${what}: layout must be { root: { … } }.`];
    return [];
}

function dataErrors(data, name) {
    if (!isRecord(data)) return [`${name}: data must be an object of { query, args } bindings.`];
    const errors = [];
    for (const [alias, binding] of Object.entries(data)) {
        if (!ALIAS.test(alias)) errors.push(`${name}: "${alias}" is not a usable data name (letters, digits and _).`);
        if (!isRecord(binding)) {
            errors.push(`${name}: data "${alias}" must be { query, args }.`);
            continue;
        }
        if (typeof binding.query !== 'string' || !binding.query) errors.push(`${name}: data "${alias}" needs a query name.`);
        if (binding.args !== undefined && !isRecord(binding.args)) errors.push(`${name}: data "${alias}" args must be an object.`);
        for (const key of Object.keys(binding)) if (!BINDING_KEYS.has(key)) errors.push(`${name}: data "${alias}" has an unknown field "${key}".`);
    }
    if (!errors.length) {
        const order = dataOrder(data);
        if (!order.ok) errors.push(`${name}: ${order.message}`);
    }
    return errors;
}

function stepErrors(def, name, mounts) {
    const errors = [];
    if (!mounts || mounts.some(mount => mount !== 'dialog')) errors.push(`${name}: steps are only for screens shown as a dialog (mounts: ['dialog']).`);
    if (!Array.isArray(def.steps) || !def.steps.length) return [...errors, `${name}: steps must be a list of { id, title, template }.`];
    const seen = new Set();
    def.steps.forEach((step, index) => {
        const where = ` step ${index + 1}`;
        if (!isRecord(step)) {
            errors.push(`${name}${where} must be { id, title, template }.`);
            return;
        }
        if (typeof step.id !== 'string' || !step.id) errors.push(`${name}${where} needs an id.`);
        else if (seen.has(step.id)) errors.push(`${name}: two steps are called "${step.id}".`);
        else seen.add(step.id);
        if (step.title !== undefined && typeof step.title !== 'string') errors.push(`${name}${where}: the title must be text.`);
        errors.push(...bodyErrors(step, name, where));
        for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) errors.push(`${name}${where} has an unknown field "${key}".`);
    });
    return errors;
}

// ---------------------------------------------------------------------------------------------------
// Data bindings

function refsOf(value, out) {
    if (typeof value === 'string') {
        const match = REF.exec(value);
        if (match) out.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(item => refsOf(item, out));
    else if (isRecord(value)) Object.values(value).forEach(item => refsOf(item, out));
    return out;
}

/**
 * The order the bindings run in: each after the bindings its `$alias` arguments name, otherwise in the
 * order written. → { ok: true, order } | { ok: false, code: 'UNKNOWN_ALIAS' | 'CYCLE', message }
 */
export function dataOrder(data) {
    const aliases = isRecord(data) ? Object.keys(data) : [];
    const needs = new Map();
    for (const alias of aliases) {
        const refs = refsOf(data[alias]?.args, new Set());
        for (const ref of refs) {
            if (!Object.hasOwn(data, ref)) {
                return { ok: false, code: 'UNKNOWN_ALIAS', message: `data "${alias}" uses $${ref}, which is not one of this screen's data names.` };
            }
        }
        needs.set(alias, refs);
    }
    const order = [];
    const placed = new Set();
    while (order.length < aliases.length) {
        const next = aliases.find(alias => !placed.has(alias) && [...needs.get(alias)].every(ref => placed.has(ref)));
        if (next === undefined) {
            const stuck = aliases.filter(alias => !placed.has(alias));
            return { ok: false, code: 'CYCLE', message: `data ${stuck.map(alias => `"${alias}"`).join(', ')} depend on each other in a circle.` };
        }
        order.push(next);
        placed.add(next);
    }
    return { ok: true, order };
}

function pathValue(value, path) {
    let current = value;
    for (const key of path) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return null;
        current = current[key];
    }
    return current === undefined ? null : current;
}

function substitute(value, q) {
    if (typeof value === 'string') {
        const match = REF.exec(value);
        if (!match) return value;
        return pathValue(q[match[1]], match[2] ? match[2].slice(1).split('.') : []);
    }
    if (Array.isArray(value)) return value.map(item => substitute(item, q));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, q)]));
    return value;
}

/**
 * Runs a screen's `data` bindings through `query(name, args)` in dependency order.
 * → { ok: true, q: { alias: value }, order, problems } | { ok: false, code, message }
 * A query that throws gives `null` for its alias and one plain line in `problems`; the screen still draws.
 */
export function resolveData(data, query) {
    if (data === undefined || data === null) return { ok: true, q: {}, order: [], problems: [] };
    if (!isRecord(data)) return { ok: false, code: 'INVALID', message: 'data must be an object of { query, args } bindings.' };
    const sorted = dataOrder(data);
    if (!sorted.ok) return sorted;
    const q = {};
    const problems = [];
    for (const alias of sorted.order) {
        const binding = data[alias];
        const args = substitute(binding.args ?? {}, q);
        try {
            const value = query(binding.query, args);
            q[alias] = value === undefined ? null : value;
        } catch (error) {
            q[alias] = null;
            problems.push(`${alias}: ${error?.message ?? String(error)}`);
        }
    }
    return { ok: true, q, order: sorted.order, problems };
}

// ---------------------------------------------------------------------------------------------------
// The registry

const PIN = /^(module|card|pack)(?::(.+))?$/;

/**
 * @param {object} [options]
 * @param {() => object} [options.reader]          the reader's screen settings: { screens: { [id]: choice }, cards: { [id]: true } }
 * @param {(next: object) => void} [options.saveReader]  stores a changed copy of those settings
 */
export function createScreens({ reader = () => ({}), saveReader = () => {} } = {}) {
    const modules = new Map();     // moduleId → Map(id → def)
    const packs = new Map();       // packId → Map(id → def), in the order first set
    let card = new Map();          // id → def
    let version = 0;

    const readerSettings = () => {
        const value = reader();
        return isRecord(value) ? value : {};
    };
    const choices = () => (isRecord(readerSettings().screens) ? readerSettings().screens : {});
    const writeReader = change => {
        const current = readerSettings();
        const next = { ...current, screens: { ...(isRecord(current.screens) ? current.screens : {}) }, cards: { ...(isRecord(current.cards) ? current.cards : {}) } };
        change(next);
        saveReader(next);
        version++;
    };

    const byId = (list, what) => {
        if (!Array.isArray(list)) throw new TypeError(`${what} screens must be a list.`);
        const map = new Map();
        for (const def of list) {
            const id = isRecord(def) && typeof def.id === 'string' ? def.id : null;
            if (!id) throw new TypeError(`${what} has a screen without an id.`);
            if (map.has(id)) throw new Error(`${what} defines screen "${id}" twice.`);
            map.set(id, def);
        }
        return map;
    };

    function moduleDefault(id) {
        for (const [moduleId, map] of modules) if (map.has(id)) return { source: 'module', origin: moduleId, def: map.get(id) };
        return null;
    }
    function packCandidates(id, only = null) {
        const found = [];
        for (const [packId, map] of packs) if (map.has(id) && (only === null || only === packId)) found.push({ source: 'pack', origin: packId, def: map.get(id) });
        return found.reverse();   // the pack set last first
    }
    const cardCandidate = id => (card.has(id) ? { source: 'card', origin: 'card', def: card.get(id) } : null);

    // Every candidate for `id`, strongest first, with the reader's pin (if any) in front.
    function candidates(id) {
        const normal = [cardCandidate(id), ...packCandidates(id), moduleDefault(id)].filter(Boolean);
        const choice = choices()[id];
        if (choice === undefined || choice === null) return { list: normal, pinned: null };
        if (isRecord(choice) && typeof choice.use === 'string') {
            const match = PIN.exec(choice.use);
            const pick = !match ? [] : match[1] === 'module' ? [moduleDefault(id)].filter(Boolean)
                : match[1] === 'card' ? [cardCandidate(id)].filter(Boolean) : packCandidates(id, match[2] ?? null).slice(0, 1);
            const missing = pick.length ? null : { source: 'reader', origin: choice.use, reason: `The reader chose "${choice.use}" for this screen, but there is no such version.` };
            return { list: [...pick, ...normal.filter(item => !pick.includes(item) && !pick.some(p => p.def === item.def))], pinned: missing };
        }
        return { list: [{ source: 'reader', origin: 'reader', def: choice }, ...normal], pinned: null };
    }

    function resolve(id) {
        const { list, pinned } = candidates(id);
        if (!list.length && !pinned) return null;
        const fallbacks = pinned ? [pinned] : [];
        for (const candidate of list) {
            const errors = validateScreen(candidate.def, { id });
            if (!errors.length) return { id, screen: candidate.def, source: candidate.source, origin: candidate.origin, fallbacks };
            fallbacks.push({ source: candidate.source, origin: candidate.origin, reason: errors.join(' ') });
        }
        return { id, screen: null, source: null, origin: null, fallbacks };
    }

    function ids() {
        const all = new Set([...card.keys()]);
        for (const map of modules.values()) for (const id of map.keys()) all.add(id);
        for (const map of packs.values()) for (const id of map.keys()) all.add(id);
        for (const [id, choice] of Object.entries(choices())) if (isRecord(choice) && choice.use === undefined) all.add(id);
        return [...all].sort();
    }

    return {
        /** Module defaults (registerModule({ screens })). A screen id another module already defines throws. */
        addModule(moduleId, screens) {
            const map = byId(screens, `Module "${moduleId}"`);
            for (const [otherId, other] of modules) {
                if (otherId === moduleId) continue;
                for (const id of map.keys()) if (other.has(id)) throw new Error(`Screen "${id}" is already defined by module "${otherId}".`);
            }
            modules.set(moduleId, map);
            version++;
        },
        removeModule(moduleId) { if (modules.delete(moduleId)) version++; },
        /** A pack's screens (add or override by id); setting the same pack again replaces its list. */
        setPack(packId, screens) { packs.set(packId, byId(screens, `Pack "${packId}"`)); version++; },
        removePack(packId) { if (packs.delete(packId)) version++; },
        /** The current character card's screens. */
        setCard(screens) { card = byId(screens ?? [], 'The card'); version++; },
        clearCard() { card = new Map(); version++; },

        resolve,
        ids,
        /**
         * Usable screens that may appear in `mount`, in navigation order (screenOrder, then id):
         * [{ id, screen, source, origin, fallbacks }].
         */
        list(mount = null) {
            const usable = ids().map(resolve).filter(entry => entry?.screen && (mount === null || entry.screen.mounts.includes(mount)));
            return byNavOrder(usable, entry => entry.id, entry => entry.screen.order);
        },
        /** Every skipped definition and why, for the overlay: [{ id, source, origin, reason }]. */
        problems() {
            return ids().flatMap(id => (resolve(id)?.fallbacks ?? []).map(item => ({ id, ...item })));
        },
        /** Bumped on every change, so mounts can tell a cached render is out of date. */
        version: () => version,

        choice: id => choices()[id] ?? null,
        /** The reader's own definition, or a pin { use: 'module' | 'card' | 'pack' | 'pack:<id>' }. */
        choose(id, choice) { writeReader(next => { next.screens[id] = choice; }); },
        /** Back to the module default, whatever the card or packs say. */
        reset(id) { writeReader(next => { next.screens[id] = { use: 'module' }; }); },
        /** Forget the reader's choice: the normal order (card, pack, module) applies again. */
        clearChoice(id) { writeReader(next => { delete next.screens[id]; }); },

        /** Inline cards are off until the reader turns them on, per screen. */
        // The reader's own on/off wins; without one a card screen is on when it says `defaultOn: true`.
        cardsOn(id) {
            const choice = readerSettings().cards?.[id];
            if (choice === true || choice === false) return choice;
            return resolve(id)?.screen?.defaultOn === true;
        },
        setCards(id, on) { writeReader(next => { next.cards[id] = Boolean(on); }); },
    };
}
