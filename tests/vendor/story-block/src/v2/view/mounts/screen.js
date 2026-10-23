// Story Suite v2: the `screen` mount (SPEC §13.4), a full-screen game view over the chat. Its navigation is the screen bar
// (view/screen-bar.js): on a phone a floating glass pill with four screens and More (the sheet of the rest), on a wide
// screen one row of every screen at the top (mounts.css does the switch). The navigation is in Home-first order
// (screens.js screenOrder). A close button, and Escape closes it (Escape first closes More, if it is open). It shows the
// head state and redraws when the head changes while it is open.
//
// The reader's order and hidden screens (Settings → Tabs & Packs → Tabs, view/tab-order.js) come in through
// `deps.screens.list` (the order) and `deps.inNav` (hidden ones leave the navigation, but a screen opened by
// name, a fight starting, still opens).
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
import { hero } from '../widgets/hero.js';
import { focusNode } from '../scroll.js';
import { iconFor } from '../icons/index.js';
import { barItems, createScreenBar } from '../screen-bar.js';
import { STRINGS } from '../../strings.js';

const PHONE_QUERY = '(max-width: 759.98px)';

export function createScreenMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The screen mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    let view = null;          // { root, bar, title, body, handle, screenId, before, heroSlot, hero, phone }

    function mount(el, screenId, opts = {}) {
        return mountHead(deps, 'screen', el, screenId, opts);
    }

    // The last input: a pointer or a touch opens the view with its focus on the window, not on the close button (a ring that a tap
    // should not show); a key opens it on the close button, where the ring is wanted. Tracked on the document, from the mount's start.
    let lastPointer = false;
    const onPointer = () => { lastPointer = true; };
    const onInput = () => { lastPointer = false; };
    doc.addEventListener?.('pointerdown', onPointer, true);
    doc.addEventListener?.('keydown', onInput, true);

    // Escape closes the view, unless the bar's More sheet is open: that one takes the key (its own listener, after this one).
    const onKey = event => {
        if (view && event.key === 'Escape' && !view.bar.isMoreOpen()) {
            event.preventDefault?.();
            event.stopPropagation?.();
            close();
        }
    };

    // The bar: the listed screens, and whether the window is wide (every screen in one row, no More).
    function drawBar() {
        const entries = screensFor(deps, 'screen');
        const listed = typeof deps.inNav === 'function' ? entries.filter(entry => deps.inNav(entry.id)) : entries;
        view.root.classList.toggle('ss-gameview-single', listed.length < 2);
        view.bar.update({
            items: barItems(listed.map(entry => ({ id: entry.id, label: entry.screen.title ?? entry.id, icon: iconFor(entry.id, entry.screen.icon) }))),
            current: view.screenId,
            row: view.phone?.matches === false,
        });
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
        // Every navigation closes More's sheet first (its scrim and its keys with it); the focus goes back to More, as a tile's does.
        if (view.bar.isMoreOpen()) view.bar.closeMore({ focus: true });
        view.screenId = screenId;
        const entries = drawBar();
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
        root.setAttribute('tabindex', '-1');
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
        const onWidth = () => {
            drawBar();
            drawHero();
        };
        phone?.addEventListener?.('change', onWidth);
        const body = make(doc, 'div', 'ss-gameview-body');
        main.append(bar, heroSlot, body);
        root.append(main);
        // The bar comes last in the window (after the body): created here, it appends its own bar, scrim and sheet to the window.
        const screenBar = createScreenBar(doc, root, {
            label: STRINGS.bar.screens,
            className: 'ss-gameview-nav',
            onSelect: id => show(id),
            // a slot or a tile names its screen, as the game view's buttons always did (the tests and the modules use it)
            decorate: (node, item) => node.setAttribute('data-ss-target', item.id),
        });
        (deps.container?.() ?? doc.body).appendChild(root);

        view = { root, bar: screenBar, title, body, handle: null, screenId: target, before: doc.activeElement ?? null, off: onHead(deps, update), heroSlot, hero: null, phone, onWidth };
        doc.addEventListener?.('keydown', onKey, true);
        show(target);
        // by pointer: the window takes the focus (no ring); by key: the close button (its ring is the keyboard's), one task later:
        // the key that opened the view is still being handled, and its own activation (Enter, Space) would click whatever has the
        // focus at that moment, which is the Game view button, not the close button (focusing it at once closed the view again)
        if (lastPointer) focusNode(root);
        else setTimeout(() => { if (view?.root === root) focusNode(closer); }, 0);
        return true;
    }

    function close() {
        if (!view) return;
        const { root, handle, before, off, bar, hero: header, phone, onWidth } = view;
        view = null;
        off();
        phone?.removeEventListener?.('change', onWidth);
        doc.removeEventListener?.('keydown', onKey, true);
        bar.destroy();
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
        drawBar();
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
        destroy() {
            close();
            doc.removeEventListener?.('pointerdown', onPointer, true);
            doc.removeEventListener?.('keydown', onInput, true);
        },
    };
}
