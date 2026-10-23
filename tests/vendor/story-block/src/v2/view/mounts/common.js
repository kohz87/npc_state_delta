// Story Suite v2: what every mount shares (SPEC §13.4). A mount picks the state to show (the head, or a
// reply's own state for inline cards), resolves the screen and its data bindings against that state, and
// hands the screen to the injected renderer. The template and layout renderers are never imported here:
// whoever wires the mounts passes `render(el, screen, scope)`.
//
// Shared dependencies (`deps`) every controller takes:
//   screens        the registry from ../screens.js (resolve, list, cardsOn, version)
//   render         (el, screen, scope) → void | dispose function | { destroy() }
//   stateAt        (index) → frozen State after carrier `index`
//   headIndex      () → index of the last carrier          (or `head: () => State` instead)
//   query          (name, args, state) → plain value, run against the given state
//   changesAt      (index) → JSON Pointer paths the carrier's ops touched   (optional, default none)
//   settings       () → settings object for `settings.…` paths                (optional)
//   api            { command, preview, commit, query, on } handed to the renderer and widgets
//   enabled        (mount, screenId) → bool  (optional; default: cards only when the reader turned them on)
//   on             (event, fn) → unsubscribe; 'head' and 'committed' redraw head mounts (optional)
//   document       the document to build in (optional, default globalThis.document)
//
// The scope given to the renderer: { state, q, draft, settings, changes, mount, index, screenId, api, query },
// and for cards also { before, replyOps } (the state before the reply, the reply's own ops).

import { themeVars } from '../css.js';
import { hasIcon, svgIcon } from '../icons/index.js';
import { resolveData } from '../screens.js';

const DEFAULT_FA_ICON = 'fa-table-columns';
const disposers = new WeakMap();
const themed = new WeakMap();      // el → the theme properties last set on it

export const documentOf = deps => deps.document ?? globalThis.document;

// A chat with no reply that keeps the story (at boot, before the chat opens, or only a greeting) has
// head index -1: an empty state (null) and no index, never a store.at(-1) RangeError.
export function headState(deps) {
    if (typeof deps.head === 'function') return deps.head();
    if (typeof deps.stateAt === 'function' && typeof deps.headIndex === 'function') {
        const index = deps.headIndex();
        return Number.isInteger(index) && index >= 0 ? deps.stateAt(index) : null;
    }
    throw new TypeError('A mount needs head() or stateAt(index) with headIndex().');
}

export const headIndexOf = deps => {
    const index = typeof deps.headIndex === 'function' ? deps.headIndex() : null;
    return Number.isInteger(index) && index < 0 ? null : index;
};

export function isEnabled(deps, mount, screenId) {
    if (typeof deps.enabled === 'function') return !!deps.enabled(mount, screenId);
    if (mount === 'card') return typeof deps.screens?.cardsOn === 'function' && deps.screens.cardsOn(screenId);
    return true;
}

/** Usable screens for `mount` the reader has not turned off. */
export const screensFor = (deps, mount) => deps.screens.list(mount).filter(entry => isEnabled(deps, mount, entry.id));

/** Plain JSON copy (drafts, payloads): drops functions and undefined. */
export const plainCopy = value => (value === undefined ? {} : JSON.parse(JSON.stringify(value)));

export function make(doc, tag, className = '', text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
}

export function button(doc, className, text, title = null) {
    const node = make(doc, 'button', className, text);
    node.type = 'button';
    node.setAttribute('type', 'button');
    if (title) {
        node.setAttribute('title', title);
        node.setAttribute('aria-label', title);
    }
    return node;
}

export function icon(doc, name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (hasIcon(trimmed)) return svgIcon(doc, trimmed);
    const fa = !trimmed || trimmed.startsWith('ph-') ? DEFAULT_FA_ICON : name;
    const node = make(doc, 'i', `fa-solid ${fa}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

/** Runs whatever the renderer left behind for `el` (a dispose function or { destroy }). */
export function dispose(el) {
    const done = disposers.get(el);
    disposers.delete(el);
    if (done) {
        try { done(); } catch { /* a renderer's cleanup failing must not block the next draw */ }
    }
}

function problem(el, doc, message) {
    dispose(el);
    const line = make(doc, 'p', 'ss-mount-problem', message);
    line.setAttribute('role', 'note');
    el.replaceChildren(line);
    return { ok: false, message };
}

/**
 * Draws screen `screenId` into `el` for `mount`.
 * ctx: { deps, state, changes = [], draft = null, index = null, screen = <override, e.g. a wizard step> }
 * → { ok: true, screen, scope, problems } | { ok: false, message }
 */
export function drawScreen(el, screenId, mount, { deps, state, changes = [], draft = null, index = null, screen: override = null, extra = null }) {
    const doc = documentOf(deps);
    const resolved = deps.screens.resolve(screenId);
    if (!resolved?.screen) {
        const why = resolved?.fallbacks?.length ? ` ${resolved.fallbacks[resolved.fallbacks.length - 1].reason}` : '';
        return problem(el, doc, `The screen "${screenId}" cannot be shown.${why}`);
    }
    const screen = resolved.screen;
    if (!screen.mounts.includes(mount)) return problem(el, doc, `The screen "${screenId}" is not made to be shown as a ${mount}.`);

    const data = resolveData(screen.data, (name, args) => deps.query(name, args, state));
    if (!data.ok) return problem(el, doc, `The screen "${screenId}" cannot be shown: ${data.message}`);

    el.setAttribute('data-ss-screen', screenId);
    el.setAttribute('data-ss-mount', mount);
    // The same element may show another screen later (the game view's body): drop the last one's theme.
    for (const key of themed.get(el) ?? []) el.style.removeProperty?.(key);
    // Only values that pass css.js's checks are set (screens.js already refused a screen with others).
    const theme = themeVars(screen.theme ?? {}).vars;
    for (const [key, value] of theme) el.style.setProperty(key, value);
    themed.set(el, theme.map(([key]) => key));

    const scope = {
        state,
        q: data.q,
        draft,
        // The settings of the module the screen belongs to (its id's namespace, `rpg-battle/party`).
        settings: typeof deps.settings === 'function' ? deps.settings(screenId) : (deps.settings ?? {}),
        changes: [...changes],
        mount,
        index,
        screenId,
        api: deps.api ?? {},
        // Templates call query(name, args) themselves (e.g. a portrait per person), at this state.
        query: (name, args) => deps.query(name, args, state),
        ...(extra ?? {}),
    };
    dispose(el);
    try {
        const out = deps.render(el, override ?? screen, scope);
        if (typeof out === 'function') disposers.set(el, out);
        else if (out && typeof out.destroy === 'function') disposers.set(el, () => out.destroy());
    } catch (error) {
        return problem(el, doc, `The screen "${screenId}" could not be drawn: ${error?.message ?? String(error)}`);
    }
    return { ok: true, screen, scope, problems: data.problems };
}

/** Subscribes `fn` to the head-changing events when the wiring gave an `on`; returns one unsubscribe. */
export function onHead(deps, fn) {
    if (typeof deps.on !== 'function') return () => {};
    const offs = ['head', 'committed'].map(event => deps.on(event, fn)).filter(off => typeof off === 'function');
    return () => offs.forEach(off => off());
}

/** A head-state mount of one screen into `el` (tab, hud item, the game view's body). */
export function mountHead(deps, mount, el, screenId, opts = {}) {
    const merged = { ...deps, ...opts };
    const draw = state => drawScreen(el, screenId, mount, {
        deps: merged,
        state: state ?? headState(merged),
        changes: [],
        index: headIndexOf(merged),
    });
    let result = draw(opts.state);
    return {
        el,
        screenId,
        get result() { return result; },
        /** Redraws with `state`, or the current head. */
        update(state = null) { result = draw(state); return result; },
        unmount() { dispose(el); el.replaceChildren(); },
    };
}
