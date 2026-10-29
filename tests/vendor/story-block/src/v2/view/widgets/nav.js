// ss.tabs and ss.navbar (view/glass.css): the two ways Story Suite's screens move between sections.
//
// * ss.tabs: a row of text tabs (an icon when the item has one), for a panel or a screen's own sections.
// * ss.navbar: the bottom bar of the game view: an icon over a label, in a dense glass pill.
//
// Both are navigation, not ARIA tabs: a `<nav>` of buttons, the current one `aria-current="page"`, a
// roving tabindex (one Tab stop; the arrow keys, Home and End move the focus along the row, Enter or Space
// chooses, as any button). With `onSelect` a choice runs that command with `{ tabs: <id> }` / `{ navbar: <id> }`
// (a screen change, never a story action, F95/F96); the choice also shows at once (a screen that redraws with
// another `current` wins). A row wider than its box scrolls sideways, and the current item is brought into view
// (on a phone, five or more sections do not fit).
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { h, iconNode, runCommand, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { cutAt } from '../../../text.js';
import { zoomOf } from '../scroll.js';

export const NAV_MAX_ITEMS = 24;
const LABEL_MAX = 40;
const ID_MAX = 64;
const COUNT_MAX = 4;

const navProps = {
    items: { type: 'array', required: true, default: Object.freeze([]) },   // [{ id, label, icon, count, disabled }]
    current: { type: 'string', default: '' },                              // an item's id
    onSelect: { type: 'string', default: '' },
    label: { type: 'string', default: 'Sections' },                        // the accessible name
};

const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);

/**
 * The items as drawn: at most `max` (NAV_MAX_ITEMS), each { id, label, icon, count, disabled }, the first of each id;
 * a label is cut at `labelMax` (LABEL_MAX). A host with its own longer list (the story panel's tabs) passes its limits.
 */
export function navItems(list, max = NAV_MAX_ITEMS, labelMax = LABEL_MAX, idMax = ID_MAX) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const label = short(raw.label, labelMax);
        const id = short(raw.id, idMax) || label;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: label || id, icon: typeof raw.icon === 'string' ? raw.icon : '', count: short(raw.count, COUNT_MAX), disabled: raw.disabled === true || raw.disabled === 'true' });
        if (out.length >= max) break;
    }
    return out;
}

/** Brings `item` into view inside the sideways-scrolling `list`, if it is not already (no page scrolling). */
export function revealItem(list, item, smooth = false) {
    const box = list?.getBoundingClientRect?.();
    const rect = item?.getBoundingClientRect?.();
    if (!box || !rect || !(box.width > 0) || !(rect.width > 0)) return false;
    if (rect.left >= box.left && rect.right <= box.right) return false;
    // measured in drawn pixels; the list scrolls in its own (a zoomed root, size.css)
    const delta = ((rect.left - box.left) - (box.width - rect.width) / 2) / zoomOf(list);
    const reduced = list.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    if (typeof list.scrollBy === 'function') list.scrollBy({ left: delta, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    else list.scrollLeft = (list.scrollLeft ?? 0) + delta;
    return true;
}

// One implementation, two blocks: `kind` is the block's name (its classes and its command's payload key).
// `options` (`max`, `labelMax`) are a host's own limits, for a strip that is longer than the block's default (see renderTabStrip).
function renderNav(kind, { max = NAV_MAX_ITEMS, labelMax = LABEL_MAX, idMax = ID_MAX } = {}) {
    return function render(el, input, api) {
        let p = resolveProps(navProps, input);
        let items = navItems(p.items, max, labelMax, idMax);
        let shown = p.current;       // what is marked current: the prop, or the reader's choice since
        let lastProp = p.current;
        return shell(el, 'nav', kind, ({ doc, root, listen, cleanup }) => {
            root.classList.add(`ss-${kind}`);
            const list = h(doc, 'div', `ss-${kind}-list`);
            root.appendChild(list);
            let buttons = [];
            let alive = true;
            cleanup(() => { alive = false; });
            const win = doc.defaultView;
            const later = fn => (typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame(() => alive && fn()) : fn());

            const enabled = () => buttons.filter(button => !button.disabled);
            const currentId = () => buttons.find(button => button.getAttribute('aria-current') === 'page')?.getAttribute('data-id') ?? null;
            const focusedIndex = () => buttons.findIndex(button => button === doc.activeElement || button.contains?.(doc.activeElement));
            // The one Tab stop: the current item, else the first that can be chosen.
            function setStop(target) {
                for (const button of buttons) button.setAttribute('tabindex', button === target ? '0' : '-1');
            }
            function markCurrent() {
                for (const button of buttons) {
                    if (button.getAttribute('data-id') === shown) button.setAttribute('aria-current', 'page');
                    else button.removeAttribute('aria-current');
                }
                const now = buttons.find(button => button.getAttribute('aria-current') === 'page' && !button.disabled);
                setStop(now ?? enabled()[0] ?? null);
            }
            function choose(item, button) {
                if (item.disabled) return;
                shown = item.id;
                markCurrent();
                setStop(button);
                revealItem(list, button, true);
                runCommand(api, p.onSelect, { [kind]: item.id });
            }
            function build() {
                const hadFocus = focusedIndex();
                const focusId = hadFocus >= 0 ? buttons[hadFocus].getAttribute('data-id') : null;
                list.replaceChildren();
                buttons = items.map(item => {
                    const button = h(doc, 'button', `ss-${kind}-item`);
                    button.setAttribute('type', 'button');
                    button.setAttribute('data-id', item.id);
                    const glyph = iconNode(doc, item.icon, `ss-${kind}-icon`);
                    if (glyph) button.appendChild(glyph);
                    button.appendChild(h(doc, 'span', `ss-${kind}-label`, item.label));
                    if (item.count) {
                        const count = h(doc, 'span', `ss-${kind}-count`, item.count);
                        count.setAttribute('aria-hidden', 'true');
                        button.appendChild(count);
                        button.setAttribute('aria-label', `${item.label}, ${item.count}`);
                    }
                    if (item.disabled) {
                        button.disabled = true;
                        button.setAttribute('aria-disabled', 'true');
                    }
                    list.appendChild(button);
                    return button;
                });
                markCurrent();
                const back = focusId === null ? null : buttons.find(button => button.getAttribute('data-id') === focusId);
                if (back) {
                    setStop(back);
                    back.focus?.({ preventScroll: true });
                }
            }
            listen(list, 'click', event => {
                const at = buttons.findIndex(button => button === event.target || button.contains?.(event.target));
                if (at >= 0) choose(items[at], buttons[at]);
            });
            // Arrow keys, Home and End move the focus (not the choice: Enter or Space chooses).
            listen(list, 'keydown', event => {
                const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
                if (!keys.includes(event?.key)) return;
                const can = enabled();
                if (!can.length) return;
                const at = can.findIndex(button => button === event.target || button.contains?.(event.target) || button === doc.activeElement);
                let next;
                if (event.key === 'Home') next = can[0];
                else if (event.key === 'End') next = can.at(-1);
                else {
                    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
                    next = can[at < 0 ? 0 : (at + (forward ? 1 : -1) + can.length) % can.length];
                }
                event.preventDefault?.();
                setStop(next);
                next.focus?.({ preventScroll: true });
                revealItem(list, next, true);
            });
            // A focus that lands on an item by Tab or a click makes it the stop.
            listen(list, 'focusin', event => {
                const button = buttons.find(node => node === event.target || node.contains?.(event.target));
                if (button) setStop(button);
            });
            function redraw() {
                root.setAttribute('aria-label', short(p.label, LABEL_MAX) || 'Sections');
                build();
            }
            redraw();
            // The first look: once laid out, the current item is in view.
            later(() => revealItem(list, buttons.find(button => button.getAttribute('aria-current') === 'page'), false));
            return {
                update(next) {
                    // The item that was current before the redraw: the strip scrolls to the current item only when it moved.
                    const before = currentId();
                    p = resolveProps(navProps, next);
                    items = navItems(p.items, max, labelMax, idMax);
                    // A new `current` from the screen wins over the reader's last choice.
                    if (p.current !== lastProp) shown = p.current;
                    lastProp = p.current;
                    redraw();
                    if (currentId() !== before) later(() => revealItem(list, buttons.find(button => button.getAttribute('aria-current') === 'page'), true));
                },
            };
        });
    };
}

function make(kind) {
    const render = renderNav(kind);
    return defineWidget({ props: navProps, primary: 'items', render });
}

export const tabs = make('tabs');
export const navbar = make('navbar');

/**
 * The `ss.tabs` render for a host's own tab strip (the story panel's tab bar, host-ui.js createTabHost): the same
 * block (roving tabindex, arrows, Home and End, aria-current, a choice runs `onSelect` with `{ tabs: id }`), with
 * the host's own limits. Returns the widget's shell: `update(props)` redraws it and keeps the focus on the item it was on.
 */
export function renderTabStrip(options = {}) {
    return renderNav('tabs', options);
}
