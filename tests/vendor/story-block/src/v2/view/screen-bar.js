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
        out.push({ id, label, icon: typeof raw.icon === 'string' ? raw.icon : '' });
    }
    return out;
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
    const slots = new Map();   // id → the slot button (kept across draws, so a focused slot keeps its focus)
    const tiles = new Map();   // id → the sheet's tile

    // The slot's content: the icon, the label, the dot (the dot is what marks the current one, besides the colour).
    function paint(node, item, isCurrent) {
        node.replaceChildren(glyph(doc, item.icon, 'ss-screenbar-icon', isCurrent), labelNode(doc, item.label), dotNode(doc));
        node.setAttribute('data-id', item.id);
        node.setAttribute('title', item.label);
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
    // row More's held screen (else the current one, else the first) takes the focus; a tile that is gone gives the first tile.
    function restoreFocus(before) {
        if (!before) return;
        const firstSlot = [...slots.values()][0] ?? null;
        const firstTile = [...tiles.values()][0] ?? null;
        let target = null;
        if (before.more) {
            const held = row ? moreHolds(items, current, pinnedCount) : null;
            target = row ? (slots.get(held?.id ?? current) ?? firstSlot) : more;
        } else if (before.slot) {
            target = slots.get(before.slot) ?? more;
        } else if (before.tile) {
            target = row ? (slots.get(before.tile) ?? more) : (open ? (tiles.get(before.tile) ?? firstTile ?? sheet) : more);
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
        more.replaceChildren(
            glyph(doc, held ? held.icon : MORE_ICON, 'ss-screenbar-icon', Boolean(held)),
            labelNode(doc, held ? held.label : S.more),
            dotNode(doc),
        );
        more.classList.toggle('ss-screenbar-current', Boolean(held));
        if (held) {
            more.setAttribute('aria-current', 'page');
            more.setAttribute('aria-label', fill(S.moreWith, { title: held.label }));
            more.setAttribute('title', held.label);
        } else {
            more.removeAttribute('aria-current');
            more.removeAttribute('aria-label');
            more.setAttribute('title', S.more);
        }

        // The sheet's tiles: the rest, in order; the current one marked.
        const tileKeep = new Set(rest.map(item => item.id));
        for (const [key, node] of tiles) if (!tileKeep.has(key)) { node.remove(); tiles.delete(key); }
        rest.forEach((item, at) => {
            const node = tileFor(item);
            const isCurrent = item.id === current;
            node.replaceChildren(glyph(doc, item.icon, 'ss-screenbar-tile-icon', isCurrent), labelNode(doc, item.label));
            node.setAttribute('data-id', item.id);
            node.setAttribute('title', item.label);
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

    function onKey(event) {
        if (!open) return;
        if (event.key === 'Escape') {
            event.preventDefault?.();
            event.stopPropagation?.();
            closeMore({ focus: true });
            return;
        }
        if (event.key !== 'Tab') return;
        const nodes = tileNodes();
        if (!nodes.length) {
            event.preventDefault?.();
            focusNode(sheet);
            return;
        }
        // Tab stays inside the sheet: it wraps from the last tile to the first and back.
        const at = nodes.indexOf(doc.activeElement);
        let next = null;
        if (event.shiftKey) next = at <= 0 ? nodes.at(-1) : null;
        else next = at === -1 || at === nodes.length - 1 ? nodes[0] : null;
        if (next) {
            event.preventDefault?.();
            focusNode(next);
            revealIn(sheet, next, 'nearest');
        }
    }

    function openMore() {
        if (open || row) return false;
        open = true;
        more.setAttribute('aria-expanded', 'true');
        scrim.hidden = false;
        sheet.hidden = false;
        doc.addEventListener?.('keydown', onKey, true);
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
        doc.removeEventListener?.('keydown', onKey, true);
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
