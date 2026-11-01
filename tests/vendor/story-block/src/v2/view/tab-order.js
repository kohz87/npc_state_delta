// Story Suite v2: the reader's order for the tabs and screens (Settings → Tabs & Packs → Tabs). One list
// covers both places: the Story panel's tab strip (module tabs and tab screens) and the game view's
// navigation (screens), so moving Fight up moves it in both.
//
// * Kept in extension_settings.storySuite.tabs as { order: [id…], hidden: [id…] } (the reader's, every
//   chat). An id is a screen's ('example-module/fight'), or for a module's own tab "<module>/<tab id>"
//   ('npc-state-delta/cast', the same id as Cast's screen, so the two are one entry).
// * No saved order: the default (screens.js screenOrder). A saved order puts the ids it names first, in its
//   order; anything it does not name (a module installed since) follows at the end, in default order.
//   An id it names that is not there (a module removed) is passed over, and kept for when it comes back.
// * Home is always first and always shown: it cannot be moved or hidden.
// * Hidden ids leave the tab strip and the game view's navigation; Settings still lists them to show again.
// * Hidden by default (screens.js DEFAULT_HIDDEN): Scene while the screen that shows the same and more is registered. The
//   reader's choice wins: `shown` lists the ones the reader showed again, `hidden` the ones they hid. An
//   order saved before `shown` existed that names Scene counts as showing it (the reader had it in view).
// * The bar: the game view's navigation and the Story panel's tab strip hold the screens that say `bar: true` on their own
//   registration (Home, Inventory, and whatever other modules declare), and Party and Fight, which come with the RPG; every other
//   screen is under More. The reader's choice wins: `inBar`
//   lists the ones they put in the bar, `underMore` the ones they put under More. Home is always in the bar. Where the bar has
//   no room (a phone's five slots) the ones past the room go under More as well.
//
// Pure, apart from createTabOrderStore (which reads and writes the reader's settings through `ctx`).

import { DEFAULT_HIDDEN, HOME_ID, byNavOrder, inDefaultBar } from './screens.js';

export const TAB_SETTINGS_KEY = 'tabs';
// Bounds on what is kept (the settings file is the reader's, but it is read on every redraw).
export const TAB_LIST_MAX = 200;
export const TAB_ID_MAX = 160;

const cleanIds = list => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const id of list) {
        if (typeof id !== 'string' || !id || id.length > TAB_ID_MAX || id === HOME_ID || out.includes(id)) continue;
        out.push(id);
        if (out.length >= TAB_LIST_MAX) break;
    }
    return out;
};

/**
 * A saved choice made safe: { order, hidden, shown }, strings only, no repeats, no Home, bounded; with `inBar` and `underMore` (the ids the
 * reader put in the bar or under More) only when there are some.
 */
export function readTabChoice(raw) {
    const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const order = cleanIds(value.order);
    const hidden = cleanIds(value.hidden);
    // Before `shown`: a default-hidden id the saved order names was in the reader's view, so it stays.
    const shown = Array.isArray(value.shown) ? cleanIds(value.shown)
        : order.filter(id => Object.hasOwn(DEFAULT_HIDDEN, id) && !hidden.includes(id));
    const inBar = cleanIds(value.inBar);
    const underMore = cleanIds(value.underMore).filter(id => !inBar.includes(id));
    return { order, hidden, shown, ...(inBar.length ? { inBar } : {}), ...(underMore.length ? { underMore } : {}) };
}

/** True when the reader has changed nothing (the default order, nothing hidden or shown, nothing moved into or out of the bar). */
export const isDefaultChoice = choice => {
    const clean = readTabChoice(choice);
    return !clean.order.length && !clean.hidden.length && !clean.shown.length && !clean.inBar && !clean.underMore;
};

/**
 * Is `id` in the bar (the game view's navigation, the Story panel's tab strip), as against under More? Home always is; the
 * reader's choice wins; else the screens that declare `bar: true` are (`declared`: the caller reads it from the registration, see
 * screens.js inDefaultBar), and every other is not.
 */
export function isInBar(choice, id, declared = false) {
    const key = String(id);
    if (key === HOME_ID) return true;
    const clean = readTabChoice(choice);
    if (clean.inBar?.includes(key)) return true;
    if (clean.underMore?.includes(key)) return false;
    return inDefaultBar(key, declared);
}

/**
 * The choice with `id` placed in the bar (`inBar` true) or under More. Home stays in the bar (the choice comes back unchanged). A place
 * that is the default for that id (`declared`: its own `bar: true`) is not kept (the choice forgets it), so the default can change later.
 */
export function setNavInBar(choice, id, inBar, declared = false) {
    const clean = readTabChoice(choice);
    if (typeof id !== 'string' || !id || id === HOME_ID) return clean;
    const rest = { inBar: (clean.inBar ?? []).filter(item => item !== id), underMore: (clean.underMore ?? []).filter(item => item !== id) };
    if (inDefaultBar(id, declared) !== Boolean(inBar)) rest[inBar ? 'inBar' : 'underMore'].push(id);
    return readTabChoice({ ...clean, ...rest });
}

/**
 * The id one entry of the Story panel's tab list goes by: a tab screen's own id, a module tab's
 * "<module>/<id>" (an id that already has a "/" is kept).
 */
export function navKey(tab) {
    const id = String(tab?.id ?? '');
    if (!tab?.moduleId || tab.moduleId === 'screens' || id.includes('/')) return id;
    return `${tab.moduleId}/${id}`;
}

/**
 * `list` in the reader's order: Home first, then the ids the choice names in its order, then the rest in
 * default order (screenOrder). Every entry stays, hidden ones too (see visibleNav).
 */
export function orderNav(list, choice, keyOf = entry => entry.id, orderOf = entry => entry.order) {
    const defaults = byNavOrder([...(list ?? [])], keyOf, orderOf);
    const { order } = readTabChoice(choice);
    if (!order.length) return defaults;
    const place = new Map(order.map((id, at) => [id, at]));
    const home = defaults.filter(entry => keyOf(entry) === HOME_ID);
    const named = defaults.filter(entry => place.has(keyOf(entry)))
        .sort((a, b) => place.get(keyOf(a)) - place.get(keyOf(b)));
    const fresh = defaults.filter(entry => keyOf(entry) !== HOME_ID && !place.has(keyOf(entry)));
    return [...home, ...named, ...fresh];
}

/**
 * Is `id` hidden? Home never is; one the reader hid is; one hidden by default (DEFAULT_HIDDEN) is while
 * its partner is there (`present(id)` → true; without `present`, no default applies) and the reader has
 * not shown it again.
 */
export function isHiddenNav(choice, id, present = null) {
    const key = String(id);
    if (key === HOME_ID) return false;
    const clean = readTabChoice(choice);
    if (clean.hidden.includes(key)) return true;
    if (!Object.hasOwn(DEFAULT_HIDDEN, key) || clean.shown.includes(key) || typeof present !== 'function') return false;
    try { return present(DEFAULT_HIDDEN[key]) === true; } catch { return false; }
}

/**
 * orderNav without the hidden ones: what the tab strip and the game view's navigation show. `present`
 * (for DEFAULT_HIDDEN) defaults to "in `list`".
 */
export function visibleNav(list, choice, keyOf = entry => entry.id, orderOf = entry => entry.order, present = null) {
    const keys = new Set([...(list ?? [])].map(keyOf));
    const there = typeof present === 'function' ? present : id => keys.has(id);
    return orderNav(list, choice, keyOf, orderOf).filter(entry => !isHiddenNav(choice, keyOf(entry), there));
}

/**
 * The choice after moving `id` by `delta` (-1 up, +1 down) in `current` (the ids as Settings lists them,
 * in the order shown). Home and the edges stay put. Saved ids not in `current` (a module not installed
 * now) keep their slots among the rest, so the module comes back where the reader put it: the ids shown
 * fill the slots the saved order gave the shown ones, in their new order, and the ones never saved follow.
 * Returns the same choice when nothing moves.
 */
export function moveNav(choice, current, id, delta) {
    const clean = readTabChoice(choice);
    const ids = cleanIds(current);
    const at = ids.indexOf(id);
    const to = at + Math.sign(Number(delta) || 0);
    if (at < 0 || to < 0 || to >= ids.length || to === at) return clean;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    const queue = [...ids];
    const order = clean.order.map(item => (ids.includes(item) ? queue.shift() : item));
    return { ...clean, order: [...order, ...queue].slice(0, TAB_LIST_MAX) };
}

/**
 * The choice with `id` hidden or shown again. Home cannot be hidden (the choice comes back unchanged). Showing
 * one that is hidden by default (DEFAULT_HIDDEN) keeps it in `shown`, so the default no longer hides it.
 */
export function setNavHidden(choice, id, hidden) {
    const clean = readTabChoice(choice);
    if (typeof id !== 'string' || !id || id === HOME_ID) return clean;
    const rest = clean.hidden.filter(item => item !== id);
    const shown = clean.shown.filter(item => item !== id);
    if (hidden) return { ...clean, hidden: cleanIds([...rest, id]), shown };
    return { ...clean, hidden: rest, shown: Object.hasOwn(DEFAULT_HIDDEN, id) ? cleanIds([...shown, id]) : shown };
}

/**
 * The reader's choice in extension_settings.storySuite.tabs: { choice(), set(next), reset() }. `set`
 * keeps a clean copy and saves (debounced); `reset` forgets it (the default order, everything shown).
 */
export function createTabOrderStore(ctx) {
    const root = () => {
        const es = ctx?.extensionSettings ?? {};
        if (!es.storySuite || typeof es.storySuite !== 'object') es.storySuite = {};
        return es.storySuite;
    };
    return {
        choice: () => readTabChoice(root()[TAB_SETTINGS_KEY]),
        set(next) {
            const clean = readTabChoice(next);
            root()[TAB_SETTINGS_KEY] = clean;
            ctx?.saveSettingsDebounced?.();
            return clean;
        },
        reset() {
            delete root()[TAB_SETTINGS_KEY];
            ctx?.saveSettingsDebounced?.();
            return readTabChoice(null);
        },
    };
}
