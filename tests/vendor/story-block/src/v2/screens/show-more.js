// "Show all" / "Show less" for a long card (UI stage 5b). A card's list is capped at about two normal cards (`--sb-cap`,
// the list's `data-capped="true"`): it has no scrollbar, it is cut and the rest waits behind the button. The button is a
// text button (`ss-button`, `aria-expanded`, keyboard reachable) and is there only while the list is taller than its cap.
//
// `capToggle(doc, target, labels)` is the one piece of DOM; the host widget `story-block.show-more` (below) uses it inside a
// template's card (the section that holds it). Its state is in the closure: a redraw of the screen starts folded again.

import { STRINGS } from '../strings.js';

export const SHOW_MORE_WIDGET = 'story-block.show-more';
export const CAP_CLASS = 'sb-cap';

// Which cards are open, by key (`story-block/home:quests`): kept for the page, so a redraw (a new head, a commit) does not fold a
// card the reader opened. A key is given by the card that draws the toggle; without one the state is the toggle's own.
const OPEN = new Map();

/** A list that is capped, and the button that opens and shuts it (`key`: the card's name, kept across redraws). → { button, refresh(), destroy() }. */
export function capToggle(doc, target, { key = '', more = STRINGS.showMore.more, less = STRINGS.showMore.less } = {}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ss-button sb-show-more';
    button.setAttribute('aria-expanded', 'false');
    button.hidden = true;
    target.classList.add(CAP_CLASS);
    let expanded = key ? OPEN.get(key) === true : false;
    const paint = () => {
        target.setAttribute('data-capped', expanded ? 'false' : 'true');
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        button.textContent = expanded ? less : more;
    };
    // Taller than the cap now? (A layout with no size, as in a test, is never taller.)
    const refresh = () => {
        const over = Number(target.scrollHeight) > Number(target.clientHeight) + 1;
        button.hidden = !over && !expanded;
    };
    button.addEventListener('click', () => {
        expanded = !expanded;
        if (key) OPEN.set(key, expanded);
        paint();
        refresh();
    });
    paint();
    // A resize of the card (a window, the story panel, a phone turned) can make the list taller or shorter than the cap: check again.
    // Guarded: a host without ResizeObserver keeps the check at each draw and each resize of the window (the widget's listener).
    const RO = doc.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    let observer = null;
    if (typeof RO === 'function') {
        try { observer = new RO(() => refresh()); observer.observe(target); } catch { observer = null; }
    }
    return {
        button,
        refresh,
        destroy: () => { observer?.disconnect?.(); observer = null; button.remove(); },
    };
}

/** `story-block.show-more`: { target } (a selector inside the card that holds the widget; default `.sb-cap`), { key }, { more, less }. */
export function createShowMoreWidget() {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, props = {}, _api = {}) {
            const doc = host.ownerDocument ?? globalThis.document;
            const card = typeof host.closest === 'function' ? host.closest('section') : null;
            const selector = typeof props.target === 'string' && props.target ? props.target : `.${CAP_CLASS}`;
            const target = card?.querySelector?.(selector) ?? null;
            if (!target) return { update() {}, destroy() { host.replaceChildren(); } };
            const toggle = capToggle(doc, target, {
                key: typeof props.key === 'string' ? props.key : '',
                more: typeof props.more === 'string' && props.more ? props.more : STRINGS.showMore.more,
                less: typeof props.less === 'string' && props.less ? props.less : STRINGS.showMore.less,
            });
            host.replaceChildren(toggle.button);
            const view = doc.defaultView;
            const onResize = () => toggle.refresh();
            view?.addEventListener?.('resize', onResize);
            toggle.refresh();
            view?.requestAnimationFrame?.(() => toggle.refresh());
            return {
                update() { toggle.refresh(); },
                destroy() {
                    view?.removeEventListener?.('resize', onResize);
                    toggle.destroy();
                },
            };
        },
    });
}
