// Story Suite v2: the `screen` mount (SPEC §13.4), a full-screen game view over the chat. Its navigation is the screen bar
// (view/screen-bar.js): on a phone a floating glass pill with four screens and More (the sheet of the rest), on a wide
// screen one row of every screen at the top (mounts.css does the switch). The navigation is in Home-first order
// (screens.js screenOrder). A close button, and Escape closes it (Escape first closes More, if it is open). It shows the
// head state and redraws when the head changes while it is open.
//
// The reader's order and hidden screens (Settings → Tabs & Packs → Tabs, view/tab-order.js) come in through
// `deps.screens.list` (the order) and `deps.inNav` (hidden ones leave the navigation, but a screen opened by
// name, a fight starting, still opens). A screen opened by name that is not on the bar (an `active` screen that is off now) stays open,
// titled from its definition, until the reader goes to another screen; only then is it dropped from view.
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

import { activeNow, button, documentOf, headState, headStateSafe, icon, isEnabled, make, mountHead, onHead, screensFor } from './common.js';
import { hero } from '../widgets/hero.js';
import { focusNode } from '../scroll.js';
import { stackOf } from '../modal-stack.js';
import { iconFor } from '../icons/index.js';
import { barItems, createScreenBar, pinAlerts } from '../screen-bar.js';
import { STRINGS } from '../../strings.js';

const PHONE_QUERY = '(max-width: 759.98px)';

export function createScreenMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The screen mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    let view = null;          // { root, bar, title, body, handle, screenId, byName, layer, heroSlot, hero, phone }

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

    // The bar: the listed screens, and whether the window is wide (every screen in one row, no More).
    function drawBar() {
        const entries = screensFor(deps, 'screen');
        const listed = typeof deps.inNav === 'function' ? entries.filter(entry => deps.inNav(entry.id)) : entries;
        view.root.classList.toggle('ss-gameview-single', listed.length < 2);
        const state = headStateSafe(deps);
        const row = view.phone?.matches === false;
        const items = listed.map(entry => {
            const now = activeNow(entry.screen, state, deps.query);
            return { id: entry.id, label: entry.screen.title ?? entry.id, icon: iconFor(entry.id, entry.screen.icon), alert: now.alert, alertText: now.badge ?? '',
                moreOnly: entry.id.startsWith('story-block/block/') };
        });
        // On a phone an active tab with an alert takes the last pinned slot (the one it displaces goes to More); the wide row keeps the order.
        view.bar.update({ items: row ? items : pinAlerts(items), current: view.screenId, row });
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

    // Whether `screenId` can be shown in the game view although it is not among the listed screens (opened by name).
    const openable = screenId => Boolean(screenId) && deps.screens.resolve(screenId)?.screen?.mounts?.includes('screen') === true && isEnabled(deps, 'screen', screenId);

    function show(screenId, { byName = false } = {}) {
        if (!view) return false;
        // Every navigation closes More's sheet first (its scrim and its keys with it); the focus goes back to More, as a tile's does.
        if (view.bar.isMoreOpen()) view.bar.closeMore({ focus: true });
        view.screenId = screenId;
        const entries = drawBar();
        const entry = entries.find(item => item.id === screenId);
        // Opened by name and not on the bar: kept until the reader goes to another screen (update() would otherwise send it Home).
        view.byName = byName && !entry ? screenId : null;
        view.title.textContent = entry?.screen.title ?? deps.screens.resolve(screenId)?.screen?.title ?? screenId;
        view.handle?.unmount();
        view.handle = mount(view.body, screenId);
        drawHero();
        return true;
    }

    /** Opens the game view on `screenId` (default: the first screen it offers). False when there is none. */
    function open(screenId = null) {
        const entries = screensFor(deps, 'screen');
        // A screen named by id opens even when it is not on the bar now (an active screen that is off, or one the reader hid).
        const named = screenId && deps.screens.resolve(screenId)?.screen?.mounts?.includes('screen') && isEnabled(deps, 'screen', screenId) ? screenId : null;
        const target = named ?? entries.find(entry => entry.id === screenId)?.id ?? entries[0]?.id ?? null;
        if (!target) return false;
        if (view) return show(target, { byName: named === target });

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
        const screenBar = createScreenBar(doc, main, {
            label: STRINGS.bar.screens,
            className: 'ss-gameview-nav',
            onSelect: id => show(id),
            // a slot or a tile names its screen, as the game view's buttons always did (the tests and the modules use it)
            decorate: (node, item) => node.setAttribute('data-ss-target', item.id),
        });
        (deps.container?.() ?? doc.body).appendChild(root);
        // On a wide screen the layer is the scrim: a click on it (a press that began there too) closes the window; the window is `main`.
        let pressedScrim = false;
        root.addEventListener('pointerdown', event => { pressedScrim = event.target === root; });
        root.addEventListener('click', event => { if (event.target === root && pressedScrim) close(); });
        doc.body?.classList?.add('ss-gameview-open');

        // A layer of the shared stack (modal-stack.js): Escape closes the view when no layer above it (the More sheet, a dialog) is open,
        // Tab stays in it, and closing it hands the focus back to what opened it.
        const layer = stackOf(doc).push({ name: 'game view', root, onEscape: () => { close(); return true; } });
        view = { root, bar: screenBar, title, body, handle: null, screenId: target, layer, off: onHead(deps, update), heroSlot, hero: null, phone, onWidth };
        show(target, { byName: named === target });
        // by pointer: the window takes the focus (no ring); by key: the close button (its ring is the keyboard's), one task later:
        // the key that opened the view is still being handled, and its own activation (Enter, Space) would click whatever has the
        // focus at that moment, which is the Game view button, not the close button (focusing it at once closed the view again)
        if (lastPointer) focusNode(root);
        else setTimeout(() => { if (view?.root === root) focusNode(closer); }, 0);
        return true;
    }

    function close() {
        if (!view) return;
        const { root, handle, layer, off, bar, hero: header, phone, onWidth } = view;
        view = null;
        off();
        doc.body?.classList?.remove('ss-gameview-open');
        phone?.removeEventListener?.('change', onWidth);
        bar.destroy();
        handle?.unmount();
        header?.destroy?.();
        root.remove();
        stackOf(doc).pop(layer);
    }

    /** Redraws the open screen (and its navigation, in case the screens changed). */
    function update() {
        if (!view) return;
        const entries = screensFor(deps, 'screen');
        if (!entries.some(entry => entry.id === view.screenId) && !(view.byName === view.screenId && openable(view.screenId))) {
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
        /** The bar's More sheet: opened, closed (focus back to More) and asked. */
        openMore: () => !!view && view.bar.openMore(),
        closeMore: () => { if (view) view.bar.closeMore({ focus: true }); },
        isMoreOpen: () => !!view && view.bar.isMoreOpen(),
        destroy() {
            close();
            doc.removeEventListener?.('pointerdown', onPointer, true);
            doc.removeEventListener?.('keydown', onInput, true);
        },
    };
}
