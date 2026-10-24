// The screen bar (UI stage 7): the navigation between screens, one component for two places: the phone game view and the
// Story panel (desktop and tablet too). On a phone it is a floating glass pill at the foot of the window with five slots:
// the first four screens in the reader's order (Settings → Tabs), then More. More opens a glass sheet over the bar with the
// remaining screens in a four-column grid; a tap on the scrim, Escape or a tile closes it, and the focus goes back to More.
// The wide game view draws every screen in one row instead (`row: true`, no More).
//
// The current item: the icon and label in the accent colour and a 4px dot under it, no pill or background. While a screen
// under More is current, More shows that screen's icon and label (More's accessible name says so) and is current itself.
//
// createScreenBar(doc, host, { label, onSelect(id), pinned? })
//   host: the positioned box the bar, its scrim and its sheet are added to (the game view or the Story panel).
//   className: the host's own class for the bar (its placement: mounts.css, host.css), e.g. `ss-gameview-nav`.
//   onSelect(id): a slot or a tile was chosen (the caller shows that screen, then calls update).
//   decorate(node, item): optional; called for each slot and each tile on every draw (the Story panel adds its own names).
//   → { el, update({ items, current, row }), isMoreOpen(), openMore(), closeMore(), destroy() }
// items: [{ id, label, icon }] in the reader's order; current: the id on screen; row: every item in one row, no More.
//
// Icons: the item's icon is a `ph-*` id from the Phosphor set (view/icons: iconFor gives it, the screen's own icon or the
// default for the id); the current one draws the solid weight (`ph-x:fill`), the others the line weight. A Font Awesome class
// (a module's own icon) still draws as it did. More is `ph-dots-three-outline`.
//
// Keys: each slot is a button in the page's Tab order. While the sheet is open Tab stays inside it, Escape closes it.
// Built with createElement and textContent only, like every standard widget (dom.js). Focus moves with focusNode (scroll.js).

import { h, iconNode, str } from './widgets/dom.js';
import { focusNode, revealIn } from './scroll.js';
import { stackOf } from './modal-stack.js';
import { hasIcon } from './icons/index.js';
import { STRINGS, fill } from '../strings.js';

const S = STRINGS.bar;
export const PINNED = 4;
export const MORE_ICON = 'ph-dots-three-outline';
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
        // `alert`: the tab is active with something to show (a red dot, no number); `alertText` is the badge's words for its name; see pinAlerts.
        const alert = raw.alert === true;
        out.push({ id, label, icon: typeof raw.icon === 'string' ? raw.icon : '', alert, alertText: alert ? str(raw.alertText).replace(/\s+/g, ' ').trim().slice(0, 40) : '' });
    }
    return out;
}

/**
 * An active tab with an alert takes the last pinned slot while it has something to show, and the item that held that slot goes to
 * More (the rest keep their order). The first alert only. Items without one are returned as they are.
 */
export function pinAlerts(items, pinned = PINNED) {
    const list = Array.isArray(items) ? items : [];
    const at = list.findIndex(item => item.alert === true);
    if (at < 0 || at < pinned - 1) return list;
    const alert = list[at];
    const rest = list.filter((_, i) => i !== at);
    return [...rest.slice(0, pinned - 1), alert, ...rest.slice(pinned - 1)];
}

/** The reader's order split into the slots (the first `pinned`) and what More holds (the rest). */
export function splitItems(items, pinned = PINNED) {
    const list = Array.isArray(items) ? items : [];
    return { pinned: list.slice(0, pinned), more: list.slice(pinned) };
}

/** The item under More that is current (More then shows its icon and label), or null. */
export function moreHolds(items, current, pinned = PINNED) {
    return splitItems(items, pinned).more.find(item => item.id === current) ?? null;
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
    const pinnedCount = Number.isInteger(options.pinned) && options.pinned > 0 ? options.pinned : PINNED;
    const id = `ss-screenbar-${(serial += 1)}`;

    const nav = h(doc, 'nav', ['ss-screenbar', str(options.className).trim()].filter(Boolean).join(' '));
    nav.setAttribute('aria-label', str(options.label) || S.screens);
    const more = h(doc, 'button', 'ss-screenbar-item ss-screenbar-more');
    more.setAttribute('type', 'button');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', `${id}-sheet`);
    nav.appendChild(more);

    // The scrim and the sheet: over the host, under the bar (which stays tappable: More closes the sheet).
    const scrim = h(doc, 'div', 'ss-screenbar-scrim');
    scrim.hidden = true;
    scrim.setAttribute('aria-hidden', 'true');
    const sheet = h(doc, 'div', 'ss-screenbar-sheet');
    sheet.setAttribute('id', `${id}-sheet`);
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', S.moreSheet);
    sheet.setAttribute('tabindex', '-1');
    const head = h(doc, 'div', 'ss-screenbar-sheet-head');
    head.append(h(doc, 'span', 'ss-screenbar-sheet-title', S.more), h(doc, 'span', 'ss-screenbar-sheet-rule'));
    const hint = h(doc, 'span', 'ss-screenbar-sheet-hint', fill(S.moreHint, { count: pinnedCount }));
    head.appendChild(hint);
    const grid = h(doc, 'div', 'ss-screenbar-grid');
    const empty = h(doc, 'p', 'ss-screenbar-empty', S.moreEmpty);
    empty.hidden = true;
    sheet.append(head, grid, empty);
    host.append(nav, scrim, sheet);

    let items = [];
    let current = null;
    let row = false;
    let open = false;
    let layer = null;         // the sheet's entry in the shared stack (modal-stack.js) while it is open
    const slots = new Map();   // id → the slot button (kept across draws, so a focused slot keeps its focus)
    const tiles = new Map();   // id → the sheet's tile

    // The slot's content: the icon, the label, the dot (the dot is what marks the current one, besides the colour).
    function paint(node, item, isCurrent) {
        node.replaceChildren(glyph(doc, item.icon, 'ss-screenbar-icon', isCurrent), labelNode(doc, item.label), dotNode(doc));
        // The alert: a small red dot at the icon's top-right (Cards.dc.html); the slot's name and tooltip say it ("Fight, your move").
        if (item.alert) node.appendChild(alertNode(doc));
        node.setAttribute('data-id', item.id);
        name(node, item);
        if (isCurrent) {
            node.setAttribute('aria-current', 'page');
            node.classList.add('ss-screenbar-current');
        } else {
            node.removeAttribute('aria-current');
            node.classList.remove('ss-screenbar-current');
        }
    }

    // The accessible name and the tooltip: the label alone, or with the alert's words.
    function name(node, item) {
        node.setAttribute('title', nameOf(item));
        if (item.alert) node.setAttribute('aria-label', nameOf(item));
        else node.removeAttribute('aria-label');
    }

    function slotFor(item) {
        let node = slots.get(item.id);
        if (!node) {
            node = h(doc, 'button', 'ss-screenbar-item');
            node.setAttribute('type', 'button');
            node.addEventListener('click', () => choose(item.id, false));
            slots.set(item.id, node);
        }
        return node;
    }

    function tileFor(item) {
        let node = tiles.get(item.id);
        if (!node) {
            node = h(doc, 'button', 'ss-screenbar-tile');
            node.setAttribute('type', 'button');
            node.addEventListener('click', () => choose(item.id, true));
            tiles.set(item.id, node);
        }
        return node;
    }

    function choose(itemId, fromSheet) {
        // A tile closes the sheet and gives the focus back to More; a slot closes it and leaves the focus where the reader put it.
        if (open) closeMore({ focus: fromSheet });
        onSelect(itemId);
    }

    // Where the focus is in the bar, as a key the redraw can find again: More, a slot (by id), a tile (by id), the sheet.
    function focusedKey() {
        const a = doc.activeElement;
        if (!a) return null;
        if (a === more) return { more: true };
        const id = a.getAttribute?.('data-id');
        if (nav.contains?.(a)) return id ? { slot: id } : null;
        if (sheet.contains?.(a)) return id ? { tile: id } : { sheet: true };
        return null;
    }

    // After a redraw: the focus goes where it was, or to its nearest equivalent: a slot that moved under More gives More; in the
    // row (where More is hidden and takes no focus) More's held screen, else the current slot, else the first one takes it; a tile
    // that is gone gives the first tile.
    function restoreFocus(before) {
        if (!before) return;
        // the first slot as drawn (the map holds them in the order they were made, which is not the bar's)
        const firstSlot = [...nav.children].find(node => node !== more && node.getAttribute?.('data-id')) ?? null;
        const firstTile = [...tiles.values()][0] ?? null;
        let target = null;
        // Where a slot that is gone sends the focus: More on the phone's bar; in the row, which hides More, the current slot or the first.
        const fallback = row ? (slots.get(current) ?? firstSlot) : more;
        if (before.more) {
            const held = row ? moreHolds(items, current, pinnedCount) : null;
            target = row ? (slots.get(held?.id ?? current) ?? firstSlot) : more;
        } else if (before.slot) {
            target = slots.get(before.slot) ?? fallback;
        } else if (before.tile) {
            target = row ? (slots.get(before.tile) ?? fallback) : (open ? (tiles.get(before.tile) ?? firstTile ?? sheet) : more);
        } else if (before.sheet) {
            target = open ? sheet : more;
        }
        if (!target || doc.activeElement === target) return;
        focusNode(target);
        if (target !== more && target !== sheet) revealIn(sheet, target, 'nearest');
    }

    function draw() {
        const focusBefore = focusedKey();
        const { pinned, more: rest } = row ? { pinned: items, more: [] } : splitItems(items, pinnedCount);
        nav.classList.toggle('ss-screenbar-row', row);
        more.hidden = row;
        if (row && open) closeMore({ focus: false });

        // The slots, in order, before More.
        const keep = new Set(pinned.map(item => item.id));
        for (const [key, node] of slots) if (!keep.has(key)) { node.remove(); slots.delete(key); }
        let next = more;
        for (let at = pinned.length - 1; at >= 0; at--) {
            const item = pinned[at];
            const node = slotFor(item);
            paint(node, item, item.id === current);
            decorate(node, item);
            if (node.parentNode !== nav || node.nextSibling !== next) nav.insertBefore(node, next);
            next = node;
        }

        // More: its own icon and label, unless a screen under it is current.
        const held = row ? null : moreHolds(items, current, pinnedCount);
        // An alerting tab under More (the second one: only the first is pinned) gives More the dot.
        const hidden = rest.find(item => item.alert);
        more.replaceChildren(
            glyph(doc, held ? held.icon : MORE_ICON, 'ss-screenbar-icon', Boolean(held)),
            labelNode(doc, held ? held.label : S.more),
            dotNode(doc),
            ...(hidden ? [alertNode(doc)] : []),
        );
        more.classList.toggle('ss-screenbar-current', Boolean(held));
        const moreName = held ? fill(S.moreWith, { title: held.label }) : S.more;
        const shown = hidden ? fill(S.moreAlert, { more: moreName, title: hidden.label, alert: hidden.alertText || S.alertWord }) : moreName;
        if (held) {
            more.setAttribute('aria-current', 'page');
            more.setAttribute('title', shown);
        } else {
            more.removeAttribute('aria-current');
            more.setAttribute('title', hidden ? shown : S.more);
        }
        if (held || hidden) more.setAttribute('aria-label', shown);
        else more.removeAttribute('aria-label');

        // The sheet's tiles: the rest, in order; the current one marked.
        const tileKeep = new Set(rest.map(item => item.id));
        for (const [key, node] of tiles) if (!tileKeep.has(key)) { node.remove(); tiles.delete(key); }
        rest.forEach((item, at) => {
            const node = tileFor(item);
            const isCurrent = item.id === current;
            node.replaceChildren(glyph(doc, item.icon, 'ss-screenbar-tile-icon', isCurrent), labelNode(doc, item.label), ...(item.alert ? [alertNode(doc)] : []));
            node.setAttribute('data-id', item.id);
            name(node, item);
            if (isCurrent) node.setAttribute('aria-current', 'page');
            else node.removeAttribute('aria-current');
            decorate(node, item);
            if (grid.children[at] !== node) grid.insertBefore(node, grid.children[at] ?? null);
        });
        empty.hidden = rest.length > 0;
        restoreFocus(focusBefore);
    }

    function tileNodes() {
        return [...grid.children].filter(node => node.getAttribute?.('data-id') && !node.hidden);
    }

    function openMore() {
        if (open || row) return false;
        open = true;
        more.setAttribute('aria-expanded', 'true');
        scrim.hidden = false;
        sheet.hidden = false;
        // A layer of the shared stack: Escape closes the sheet first, Tab stays in it (modal-stack.js).
        layer = stackOf(doc).push({ name: 'more', root: sheet, onEscape: () => { closeMore({ focus: true }); return true; }, reveal: node => revealIn(sheet, node, 'nearest') });
        const target = tileNodes().find(node => node.getAttribute('aria-current') === 'page') ?? tileNodes()[0] ?? sheet;
        focusNode(target);
        if (target !== sheet) revealIn(sheet, target, 'nearest');
        return true;
    }

    function closeMore({ focus = true } = {}) {
        if (!open) return false;
        open = false;
        more.setAttribute('aria-expanded', 'false');
        scrim.hidden = true;
        sheet.hidden = true;
        stackOf(doc).pop(layer, { focus: false });
        layer = null;
        if (focus) focusNode(more);
        return true;
    }

    more.addEventListener('click', () => {
        if (open) closeMore({ focus: true });
        else openMore();
    });
    scrim.addEventListener('click', () => closeMore({ focus: true }));

    return {
        el: nav,
        update(next = {}) {
            items = barItems(next.items);
            current = typeof next.current === 'string' && next.current ? next.current : null;
            row = next.row === true;
            draw();
        },
        isMoreOpen: () => open,
        openMore,
        closeMore: (options = {}) => closeMore({ focus: options.focus !== false }),
        destroy() {
            closeMore({ focus: false });
            nav.remove();
            scrim.remove();
            sheet.remove();
            slots.clear();
            tiles.clear();
        },
    };
}
