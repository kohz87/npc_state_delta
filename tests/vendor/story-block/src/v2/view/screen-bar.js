// The screen bar (UI stage 7): the navigation between screens for the game view and the Story panel; both draw the strip (below).
// The current item: the icon and label in the accent colour and a 4px dot under it, no pill or background.
// createScreenBar(doc, host, { label, onSelect(id) })
//   host: the positioned box the bar is added to (the game view or the Story panel).
//   className: the host's own class for the bar (its placement: mounts-*.css, host.css), e.g. `ss-gameview-nav`.
//   onSelect(id): a slot was chosen (the caller shows that screen, then calls update).
//   decorate(node, item): optional; called for each slot on every draw (the Story panel adds its own names).
//   → { el, update({ items, current }), destroy() }
// items: [{ id, label, icon, moreOnly? }] in the reader's order; current: the id on screen.
// Icons: the item's icon is a `ph-*` id from the Phosphor set (view/icons: iconFor gives it, the screen's own icon or the
// default for the id); the current one draws the solid weight (`ph-x:fill`), the others the line weight. A Font Awesome class
// (a module's own icon) still draws as it did.
// The strip: every item is a slot in ONE row that scrolls sideways (the CSS snaps it and hides the scrollbar), the ones the reader
// put in the bar first, the `moreOnly` ones (not in the bar: Settings → Tabs & Packs) after them in the same order. `data-fade` on the
// bar says which edge has more tabs (`start`, `end`, `both`; kept on scroll and on resize) and the CSS fades it;
// `data-alert` and a dot on that edge say an alerting tab is out of sight beyond it. The current slot is scrolled into view when the bar opens
// and when the current screen changes. Left and Right (Home, End) move the focus between slots. Slots are buttons in the page's Tab order.
// Built with createElement and textContent only (dom.js); focusNode (scroll.js).

import { h, iconNode, str } from './widgets/dom.js';
import { focusNode } from './scroll.js';
import { hasIcon } from './icons/index.js';
import { STRINGS, fill } from '../strings.js';

const S = STRINGS.bar;
export const DEFAULT_ICON = 'ph-list';
const LABEL_MAX = 200;
let serial = 0;

/** The items as drawn: { id, label, icon }, the first of each id, a label that is empty takes the id. */
export function barItems(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const id = str(raw.id).trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = str(raw.label).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) || id;
        // `alert`: the tab is active with something to show (a red dot, no number); `alertText` is the badge's words for its name;
        const alert = raw.alert === true;
        out.push({ id, label, icon: typeof raw.icon === 'string' ? raw.icon : '', alert, alertText: alert ? str(raw.alertText).replace(/\s+/g, ' ').trim().slice(0, 40) : '',
            ...(raw.moreOnly === true ? { moreOnly: true } : {}) });
    }
    return out;
}

/** The strip's order: the items that are in the bar first, then the `moreOnly` ones, each group in the reader's order. */
export function stripOrder(items) {
    const list = Array.isArray(items) ? items : [];
    return [...list.filter(item => !item.moreOnly), ...list.filter(item => item.moreOnly)];
}

// The one seam for the icon set (see the header): the icon's weight is the solid one when `solid` (the current item).
// Never empty: an icon that does not draw gives the default.
function glyph(doc, value, className, solid = false) {
    const id = typeof value === 'string' ? value.trim() : '';
    const base = id.split(':')[0];
    const named = hasIcon(base) ? `${base}${solid ? ':fill' : ''}` : id;
    return iconNode(doc, named, className) ?? iconNode(doc, DEFAULT_ICON, className);
}

function labelNode(doc, text) {
    return h(doc, 'span', 'ss-screenbar-label', text);
}

// The alert's red dot (an active tab with something to show): at the icon's top-right, decorative; the name says it.
function alertNode(doc) {
    const alert = h(doc, 'span', 'ss-screenbar-alert');
    alert.setAttribute('aria-hidden', 'true');
    return alert;
}

// The name of a slot or tile: its label, and the alert's words after it when it has one ("Fight, your move"; "Fight, alert" with none).
function nameOf(item) {
    return item.alert ? fill(S.alertSlot, { title: item.label, alert: item.alertText || S.alertWord }) : item.label;
}

// The dot under the current slot: decorative (the state is in aria-current).
function dotNode(doc) {
    const dot = h(doc, 'span', 'ss-screenbar-dot');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
}

export function createScreenBar(doc, host, options = {}) {
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
    const decorate = typeof options.decorate === 'function' ? options.decorate : () => {};

    const nav = h(doc, 'nav', ['ss-screenbar', 'ss-screenbar-strip', str(options.className).trim()].filter(Boolean).join(' '));
    nav.setAttribute('aria-label', str(options.label) || S.screens);
    // The strip's edge alert dots (sticky at each edge while an alerting tab is scrolled out past it; see edgeAlerts()).
    const edgeDot = edge => { const dot = h(doc, 'span', 'ss-screenbar-edge-alert'); dot.hidden = true; dot.setAttribute('aria-hidden', 'true'); dot.setAttribute('data-edge', edge); return dot; };
    const [startDot, endDot] = [edgeDot('start'), edgeDot('end')];
    nav.append(startDot, endDot);
    host.append(nav);

    let items = [];
    let current = null;
    let scrolledTo = null;    // the current id the strip was last scrolled to
    const slots = new Map();   // id → the slot button (kept across draws, so a focused slot keeps its focus)

    // The slot's content: the icon, the label, the dot (the dot is what marks the current one, besides the colour).
    function paint(node, item, isCurrent) {
        node.replaceChildren(glyph(doc, item.icon, 'ss-screenbar-icon', isCurrent), labelNode(doc, item.label), dotNode(doc));
        // The alert: a small red dot at the icon's top-right (Cards.dc.html); the slot's name and tooltip say it ("Fight, your move").
        if (item.alert) node.appendChild(alertNode(doc));
        node.setAttribute('data-id', item.id);
        node.setAttribute('title', nameOf(item));
        if (item.alert) node.setAttribute('aria-label', nameOf(item));
        else node.removeAttribute('aria-label');
        if (isCurrent) {
            node.setAttribute('aria-current', 'page');
            node.classList.add('ss-screenbar-current');
        } else {
            node.removeAttribute('aria-current');
            node.classList.remove('ss-screenbar-current');
        }
    }

    function slotFor(item) {
        let node = slots.get(item.id);
        if (!node) {
            node = h(doc, 'button', 'ss-screenbar-item');
            node.setAttribute('type', 'button');
            node.addEventListener('click', () => onSelect(item.id));
            slots.set(item.id, node);
        }
        return node;
    }

    // After a redraw the focus stays on its slot; a slot that is gone gives the focus to the current slot, else the first.
    function restoreFocus(slotId) {
        if (!slotId) return;
        const firstSlot = [...nav.children].find(node => node.getAttribute?.('data-id')) ?? null;
        const target = slots.get(slotId) ?? slots.get(current) ?? firstSlot;
        if (target && doc.activeElement !== target) focusNode(target);
    }

    function draw() {
        const a = doc.activeElement;
        const focusBefore = a && nav.contains?.(a) ? a.getAttribute?.('data-id') : null;
        const order = stripOrder(items);
        const keep = new Set(order.map(item => item.id));
        for (const [key, node] of slots) if (!keep.has(key)) { node.remove(); slots.delete(key); }
        // The slots, in order, before the end dot.
        let next = endDot;
        for (let at = order.length - 1; at >= 0; at--) {
            const item = order[at];
            const node = slotFor(item);
            paint(node, item, item.id === current);
            decorate(node, item);
            if (node.parentNode !== nav || node.nextSibling !== next) nav.insertBefore(node, next);
            next = node;
        }
        restoreFocus(focusBefore);
        showCurrent();
    }

    // The strip: the current slot into view (once for each current id), and the fade on the edge that has more tabs.
    function showCurrent() {
        if (current !== scrolledTo) {
            const node = slots.get(current);
            if (node) { scrolledTo = current; node.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }
        }
        fade();
    }
    function fade() {
        const left = Number(nav.scrollLeft) || 0;
        const room = (Number(nav.scrollWidth) || 0) - (Number(nav.clientWidth) || 0);
        const edge = room > 1 ? `${left > 1 ? 'start' : ''}${left < room - 1 ? 'end' : ''}` : '';
        if (edge) nav.setAttribute('data-fade', edge === 'startend' ? 'both' : edge);
        else nav.removeAttribute('data-fade');
        edgeAlerts(edge !== '');
    }
    // An alerting slot past an edge (its centre in the fade or beyond): a chevron shows on that edge; it clears when the slot is in view.
    function edgeAlerts(fading) {
        let before = false, after = false;
        const box = fading && nav.getBoundingClientRect?.();
        for (const item of box ? items : []) {
            const at = item.alert && slots.get(item.id)?.getBoundingClientRect?.();
            if (!at) continue;
            const mid = at.left + (at.width ?? at.right - at.left) / 2; // past an edge once its centre is inside the 28px fade
            if (mid <= box.left + 28) before = true;
            else if (mid >= box.right - 28) after = true;
        }
        startDot.hidden = !before;
        endDot.hidden = !after;
        nav.setAttribute('data-alert', `${before ? 'start' : ''} ${after ? 'end' : ''}`.trim());
    }
    // Arrow keys between the slots (the strip's own keys; Tab still walks them too).
    nav.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const at = [...nav.children].filter(node => node.getAttribute?.('data-id'));
        const here = at.indexOf(doc.activeElement);
        const to = { ArrowRight: here + 1, ArrowLeft: here - 1, Home: 0, End: at.length - 1 }[event.key];
        if (here < 0 || to === undefined || !at[to]) return;
        event.preventDefault?.();
        focusNode(at[to]);
        at[to].scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    });
    nav.addEventListener('scroll', fade);
    // The fade follows the bar's size (a resize or a rotation that changes what fits); no observer, no recompute.
    const resizes = typeof globalThis.ResizeObserver === 'function' ? new globalThis.ResizeObserver(fade) : null;
    resizes?.observe(nav);

    return {
        el: nav,
        update(next = {}) {
            items = barItems(next.items);
            current = typeof next.current === 'string' && next.current ? next.current : null;
            draw();
        },
        destroy() {
            resizes?.disconnect();
            nav.remove();
            slots.clear();
        },
    };
}
