// Story Suite v2: the `screen` mount (SPEC §13.4), a full-screen game view over the chat. It has its own
// navigation between the usable screens that allow 'screen' (a bottom bar on narrow widths, a side bar on
// wide ones; mounts.css does the switch), in navigation order (Home first, see screens.js screenOrder),
// with a fade on the edge where more items are scrolled out of sight (scroll-cue.js), a close button, and
// Escape closes it. It shows the head state and redraws when the head changes while it is open.
//
// deps (see common.js) plus:
//   container   () → element the view is added to (optional, default document.body)
//
// → { mount(el, screenId, opts) → handle, open(screenId?) → bool, close(), isOpen(), current(), update(), destroy() }

import { button, documentOf, icon, make, mountHead, onHead, screensFor } from './common.js';
import { scrollCue } from '../scroll-cue.js';

export function createScreenMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The screen mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    let view = null;          // { root, nav, cue, title, body, handle, screenId, before }

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

    function drawNav() {
        const entries = screensFor(deps, 'screen');
        view.nav.replaceChildren();
        view.root.classList.toggle('ss-gameview-single', entries.length < 2);
        for (const entry of entries) {
            const item = button(doc, 'ss-gameview-navitem');
            item.setAttribute('data-ss-target', entry.id);
            item.append(icon(doc, entry.screen.icon), make(doc, 'span', 'ss-gameview-navlabel', entry.screen.title ?? entry.id));
            if (entry.id === view.screenId) item.setAttribute('aria-current', 'page');
            item.addEventListener('click', () => show(entry.id));
            view.nav.appendChild(item);
        }
        view.cue?.update();
        return entries;
    }

    function show(screenId) {
        if (!view) return false;
        view.screenId = screenId;
        const entries = drawNav();
        const entry = entries.find(item => item.id === screenId);
        view.title.textContent = entry?.screen.title ?? screenId;
        view.handle?.unmount();
        view.handle = mount(view.body, screenId);
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
        const body = make(doc, 'div', 'ss-gameview-body');
        main.append(bar, body);
        root.append(main, nav);
        (deps.container?.() ?? doc.body).appendChild(root);

        view = { root, nav, cue: null, title, body, handle: null, screenId: target, before: doc.activeElement ?? null, off: onHead(deps, update) };
        view.cue = scrollCue(nav, { win: doc.defaultView ?? globalThis });
        doc.addEventListener?.('keydown', onKey, true);
        show(target);
        closer.focus?.();
        return true;
    }

    function close() {
        if (!view) return;
        const { root, handle, before, off, cue } = view;
        view = null;
        off();
        cue?.destroy();
        doc.removeEventListener?.('keydown', onKey, true);
        handle?.unmount();
        root.remove();
        before?.focus?.();
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
