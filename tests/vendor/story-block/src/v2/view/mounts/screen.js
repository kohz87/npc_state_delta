// Story Suite v2: the `screen` mount (SPEC §13.4), a full-screen game view over the chat. It has its own
// navigation between the usable screens that allow 'screen' (a bottom bar on narrow widths, a side bar on
// wide ones; mounts.css does the switch), in navigation order (Home first, see screens.js screenOrder),
// with a fade on the edge where more items are scrolled out of sight (scroll-cue.js), a close button, and
// Escape closes it. It shows the head state and redraws when the head changes while it is open.
//
// The reader's order and hidden screens (Settings → Tabs & Packs → Tabs, view/tab-order.js) come in through
// `deps.screens.list` (the order) and `deps.inNav` (hidden ones leave the navigation, but a screen opened by
// name, a fight starting, still opens). The current item is scrolled into view when the bar overflows.
//
// The header (UI stage 5a): above the screen, the character and the scene as the `ss.hero` block, from `heroOf(state)`
// (view/game-header.js); null draws no header. It is drawn on open, on a screen change and on every redraw.
//
// deps (see common.js) plus:
//   container   () → element the view is added to (optional, default document.body)
//   inNav       (screenId) → bool: listed in the navigation (optional, default every screen)
//   heroOf      (state) → the props of the header's ss.hero, or null (optional: no header)
//
// → { mount(el, screenId, opts) → handle, open(screenId?) → bool, close(), isOpen(), current(), update(), destroy() }

import { button, documentOf, headState, icon, make, mountHead, onHead, screensFor } from './common.js';
import { bringIntoView, scrollCue } from '../scroll-cue.js';
import { hero } from '../widgets/hero.js';
import { focusNode } from '../scroll.js';

const PHONE_QUERY = '(max-width: 759.98px)';

export function createScreenMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The screen mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    let view = null;          // { root, nav, cue, title, body, handle, screenId, before, heroSlot, hero }

    function mount(el, screenId, opts = {}) {
        return mountHead(deps, 'screen', el, screenId, opts);
    }

    const onKey = event => {
        if (view && event.key === 'Escape') {
            event.preventDefault?.();
            event.stopPropagation?.();
            close();
        }
    };

    // `reveal`: scroll the current item into view (on a screen change; a redraw on a new reply leaves the bar be).
    function drawNav(reveal = false) {
        const entries = screensFor(deps, 'screen');
        const listed = typeof deps.inNav === 'function' ? entries.filter(entry => deps.inNav(entry.id)) : entries;
        view.nav.replaceChildren();
        view.root.classList.toggle('ss-gameview-single', listed.length < 2);
        let current = null;
        for (const entry of listed) {
            const item = button(doc, 'ss-gameview-navitem');
            item.setAttribute('data-ss-target', entry.id);
            item.append(icon(doc, entry.screen.icon), make(doc, 'span', 'ss-gameview-navlabel', entry.screen.title ?? entry.id));
            if (entry.id === view.screenId) {
                item.setAttribute('aria-current', 'page');
                current = item;
            }
            item.addEventListener('click', () => show(entry.id));
            view.nav.appendChild(item);
        }
        view.cue?.update();
        if (current && reveal) bringIntoView(view.nav, current);
        return entries;
    }

    // The header: the widget is made once and updated; no state (no chat) or no `heroOf` takes the header away.
    function drawHero() {
        if (!view?.heroSlot) return;
        let props = null;
        if (typeof deps.heroOf === 'function') {
            try { props = deps.heroOf(headState(deps)) ?? null; } catch { props = null; }
        }
        view.heroSlot.hidden = !props;
        view.root.classList.toggle('ss-gameview-has-hero', Boolean(props));
        if (!props) {
            view.hero?.destroy?.();
            view.hero = null;
            view.heroSlot.replaceChildren();
            return;
        }
        // The one-row variant on a phone (the bars under the name), the wide one from 760px (the hero's own container query).
        props = { ...props, compact: view.phone?.matches === true };
        if (view.hero) view.hero.update(props);
        else view.hero = hero.render(view.heroSlot, props, deps.api ?? {});
    }

    function show(screenId) {
        if (!view) return false;
        view.screenId = screenId;
        const entries = drawNav(true);
        const entry = entries.find(item => item.id === screenId);
        view.title.textContent = entry?.screen.title ?? screenId;
        view.handle?.unmount();
        view.handle = mount(view.body, screenId);
        drawHero();
        return true;
    }

    /** Opens the game view on `screenId` (default: the first screen it offers). False when there is none. */
    function open(screenId = null) {
        const entries = screensFor(deps, 'screen');
        const target = entries.find(entry => entry.id === screenId)?.id ?? entries[0]?.id ?? null;
        if (!target) return false;
        if (view) return show(target);

        const root = make(doc, 'div', 'ss-gameview');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Game view');
        const nav = make(doc, 'nav', 'ss-gameview-nav');
        nav.setAttribute('aria-label', 'Screens');
        const main = make(doc, 'div', 'ss-gameview-main');
        const bar = make(doc, 'header', 'ss-gameview-bar');
        const title = make(doc, 'h2', 'ss-gameview-title');
        const closer = button(doc, 'ss-gameview-close', '', 'Close');
        closer.appendChild(icon(doc, 'fa-xmark'));
        closer.addEventListener('click', () => close());
        bar.append(title, closer);
        const heroSlot = make(doc, 'div', 'ss-gameview-hero');
        heroSlot.hidden = true;
        const phone = doc.defaultView?.matchMedia?.(PHONE_QUERY) ?? null;
        const onWidth = () => drawHero();
        phone?.addEventListener?.('change', onWidth);
        const body = make(doc, 'div', 'ss-gameview-body');
        main.append(bar, heroSlot, body);
        root.append(main, nav);
        (deps.container?.() ?? doc.body).appendChild(root);

        view = { root, nav, cue: null, title, body, handle: null, screenId: target, before: doc.activeElement ?? null, off: onHead(deps, update), heroSlot, hero: null, phone, onWidth };
        view.cue = scrollCue(nav, { win: doc.defaultView ?? globalThis });
        doc.addEventListener?.('keydown', onKey, true);
        show(target);
        focusNode(closer);
        return true;
    }

    function close() {
        if (!view) return;
        const { root, handle, before, off, cue, hero: header, phone, onWidth } = view;
        view = null;
        off();
        phone?.removeEventListener?.('change', onWidth);
        cue?.destroy();
        doc.removeEventListener?.('keydown', onKey, true);
        handle?.unmount();
        header?.destroy?.();
        root.remove();
        focusNode(before);
    }

    /** Redraws the open screen (and its navigation, in case the screens changed). */
    function update() {
        if (!view) return;
        const entries = screensFor(deps, 'screen');
        if (!entries.some(entry => entry.id === view.screenId)) {
            if (entries.length) show(entries[0].id);
            else close();
            return;
        }
        drawNav();
        view.handle?.update();
        drawHero();
    }

    return {
        mount,
        open,
        close,
        update,
        isOpen: () => !!view,
        current: () => view?.screenId ?? null,
        destroy: close,
    };
}
