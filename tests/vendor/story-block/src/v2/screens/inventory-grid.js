// Inventory grid: the pure DOM helpers of the Grid view on the Inventory screen (inventory.js keeps the screen, the List view and the template).
// Every helper takes the document first and returns an element; none reads the store or runs a command. The screen passes the rows
// (`q.gx.rows` while Gear in fights is on, else null), the same action commands and payloads the list rows use, and the fold state it keeps
// (foldStore). A tile is a button, so the keyboard and screen readers reach every item.
import { SCREEN_STRINGS } from '../strings/screens.js';
import { fill } from '../strings.js';
import { h, s as svg } from '../view/widgets/dom.js';
import { stackOf } from '../view/modal-stack.js';

const S = SCREEN_STRINGS.inventory;
const G = S.gear;
const COMMON = 'common';
const NOT_GOOD = Object.freeze(['worn', 'torn', 'broken']);

/** Open or closed, remembered per key. `prefix` names the chat (the caller adds it), so each chat keeps its own folds on this device. A storage that
 *  throws or is missing gives the fallback, and the choice then lasts only this page. */
export function foldStore({ prefix, storage = undefined }) {
    const area = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
    const kept = new Map();
    const key = id => `${prefix}${id}`;
    return Object.freeze({
        get(id, fallback) {
            if (kept.has(id)) return kept.get(id);
            try {
                const value = area()?.getItem?.(key(id));
                return value == null ? fallback : value === '1';
            } catch { return fallback; }
        },
        set(id, open) {
            kept.set(id, open);
            try { area()?.setItem?.(key(id), open ? '1' : '0'); } catch { /* the choice lasts this page only */ }
        },
    });
}

const slug = id => String(id).replace(/[^\w-]/g, '-');

function chevron(doc) {
    const box = h(doc, 'span', 'fold-chev');
    const drawn = svg(doc, 'svg', { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    drawn.appendChild(svg(doc, 'path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }));
    box.appendChild(drawn);
    return box;
}

/** A foldable section: a button with a chevron, the label (and an icon, a count when given) and the body under it. `onToggle(open)` gets the new state. */
export function foldSection(doc, { id, label, icon = '', count = null, open, onToggle, body, className = '', rule = false }) {
    const section = h(doc, 'section', `fold-sec ${className}`.trim());
    const bodyId = `fold-body-${slug(id)}`;
    const head = h(doc, 'button', `fold-head${open ? ' is-open' : ''}`);
    head.setAttribute('type', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-controls', bodyId);
    head.setAttribute('data-fold', String(id));
    if (rule) head.append(chevron(doc));   // the rule-style head: chevron, label, a hairline (CSS) and the count at the right
    if (icon) {
        const mark = h(doc, 'i', `fa-solid ${icon}`);
        mark.setAttribute('aria-hidden', 'true');
        head.append(mark);
    }
    head.append(h(doc, 'span', 'fold-label', label));
    if (count !== null) head.append(h(doc, 'span', 'fold-count', String(count)));
    if (!rule) head.append(chevron(doc));
    head.addEventListener('click', () => onToggle?.(!open));
    body.id = bodyId;
    body.hidden = !open;
    section.append(head, body);
    return section;
}

const slotLabel = (item, row) => {
    const place = row?.place || row?.slotKey || item.slot || '';
    return place ? (G.slots[place] ?? place) : '';
};

/** One item as a square tile (a button). Gear shows its slot and its bonus; a stack its count; a piece not in good condition an amber dot
 *  (its word is the title); a bound piece a lock. `row` is the item's `q.gx.rows[stack]` (null with Gear in fights off). */
export function itemTile(doc, item, row = null, { onOpen } = {}) {
    const rarity = item.rarity || COMMON;
    const bonus = row?.bonus || '';
    const word = row?.word || '';
    const bound = item.bound != null || row?.bound != null;
    const tile = h(doc, 'button', `tile r-${rarity}`);
    tile.setAttribute('type', 'button');
    tile.setAttribute('data-stack', String(item.stack));
    tile.setAttribute('aria-label', [item.name, S.rarities[rarity], bonus, item.qty != 1 ? `×${item.qty}` : ''].filter(Boolean).join(' · '));
    const slot = slotLabel(item, row);
    if (slot) tile.append(h(doc, 'span', 'sl', slot));
    if (item.qty != 1) tile.append(h(doc, 'span', 'q', `×${item.qty}`));
    if (NOT_GOOD.includes(word)) {
        const dot = h(doc, 'span', `dot cond-${word}`);
        dot.setAttribute('title', G.words[word]);
        tile.append(dot);
    }
    if (bound) {
        const lock = h(doc, 'i', 'fa-solid fa-lock lock');
        lock.setAttribute('aria-hidden', 'true');
        lock.setAttribute('title', G.bound);
        tile.append(lock);
    }
    tile.append(h(doc, 'span', 'nm', item.name));
    if (bonus) tile.append(h(doc, 'span', 'bn', bonus));
    if (onOpen) tile.addEventListener('click', () => onOpen(item, tile));
    return tile;
}

/** The tiles of a list of items, in the order given; the CSS fits four to a line on a narrow screen and more on a wide one. */
export function tileGrid(doc, items, { rows = null, onOpen } = {}) {
    const list = h(doc, 'ul', 'tile-grid');
    list.setAttribute('aria-label', S.tilesLabel);
    for (const item of items) {
        const cell = h(doc, 'li', 'tile-cell');
        cell.append(itemTile(doc, item, rows?.[item.stack] ?? null, { onOpen }));
        list.append(cell);
    }
    return list;
}

/** One kind's section in Grid view: a foldable heading ("Consumables", its count) over its tiles. Null when the kind has no items (nothing to show). */
export function categorySection(doc, { kind, title, items, rows = null, open, onToggle, onOpen }) {
    if (items.length === 0) return null;
    return foldSection(doc, {
        id: `cat-${kind}`, label: title, count: items.length, open, onToggle, rule: true,
        body: tileGrid(doc, items, { rows, onOpen }), className: `cat cat-${kind}`,
    });
}

/** The Worn view (Gear in fights on): one fold per wearer, "Astra · 5 pieces", with that wearer's pieces as tiles. A wearer with nothing on is left out.
 *  `open(value)` says whether a wearer's fold is open; `onToggle(value, open)` reports a press. Each wearer's fold is its own. */
export function wornSection(doc, { wearers = [], items, rows, open, onToggle, onOpen }) {
    const wrap = h(doc, 'div', 'worn-folds');
    for (const who of wearers) {
        const pieces = items.filter(item => rows?.[item.stack]?.byId === who.value && rows[item.stack].place);
        if (pieces.length === 0) continue;
        const count = pieces.length === 1 ? S.wornWhoOne : fill(S.wornWho, { n: pieces.length });   // the mockup's fold: chevron, the name, "5 pieces" at the right
        wrap.append(foldSection(doc, {
            id: `worn-${who.value}`, label: who.label, count, rule: true, open: open(who.value),
            onToggle: on => onToggle?.(who.value, on),
            body: tileGrid(doc, pieces, { rows, onOpen }), className: 'worn-wearer',
        }));
    }
    return wrap;
}

// One action button. A plain action runs at once; one with `choices` (Drop 1 / Drop all, the members who may wear it) opens a row of buttons under it.
function actionButton(doc, action, close) {
    const wrap = h(doc, 'div', 'sheet-act');
    const main = h(doc, 'button', `ss-button${action.danger ? ' ss-button-danger' : ''}`);
    main.setAttribute('type', 'button');
    if (action.title) main.setAttribute('title', action.title);
    if (action.icon) {
        const mark = h(doc, 'i', `fa-solid ${action.icon}`);
        mark.setAttribute('aria-hidden', 'true');
        main.append(mark, ' ');
    }
    main.append(action.label);
    wrap.append(main);
    if (!action.choices?.length) {
        main.addEventListener('click', () => { if (!action.keepOpen) close(); action.run?.(); });
        return wrap;
    }
    const choices = h(doc, 'div', 'sheet-choices');
    choices.hidden = true;
    main.setAttribute('aria-expanded', 'false');
    for (const choice of action.choices) {
        const button = h(doc, 'button', `ss-button${choice.danger ? ' ss-button-danger' : ''}`, choice.label);
        button.setAttribute('type', 'button');
        if (choice.title) button.setAttribute('title', choice.title);
        button.addEventListener('click', () => { close(); choice.run?.(); });
        choices.append(button);
    }
    main.addEventListener('click', () => {
        choices.hidden = !choices.hidden;
        main.setAttribute('aria-expanded', String(!choices.hidden));
    });
    wrap.append(choices);
    return wrap;
}

/**
 * The bottom sheet for one item. `item` is the tile's item; `row` its `q.gx.rows[stack]` (null with Gear in fights off); `wearer` the wearer's name ('' for none).
 * `actions` are `{ label, title?, icon?, danger?, keepOpen?, run, choices? }` (`keepOpen`: the sheet stays, `run` draws into `slot`): `run()` must be the same handler the row's button calls (the command and its payload),
 * and `choices` are `{ label, title?, danger?, run }` shown under the action. The sheet closes before an action runs, so the screen can redraw.
 * Returns `{ el, slot, show, close }`. `show()` mounts it as a layer of the host's modal stack (view/modal-stack.js) on the document body, the way the app's other
 * dialogs are, NOT inside the screen (a screen's CSS cannot be `position: fixed`, and a screen scrolls): fixed at the bottom of the visible screen over a dim backdrop,
 * the list under it never moves. The stack owns Escape (only the top layer takes it, so the game view stays open) and keeps Tab inside it.
 * A tap on the dim, the Close button or Escape closes it; `returnTo` (the tile, or a function giving it after the screen drew again) gets the focus back, and `onClose` runs.
 */
export function itemSheet(doc, { item, row = null, wearer = '', actions = [], returnTo = null, onClose } = {}) {
    let open = true;
    let entry = null;
    const layer = h(doc, 'div', 'ss-dialog-backdrop inv-sheet-layer');
    const sheet = h(doc, 'section', 'ss-dialog inv-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', S.sheetLabel);
    sheet.tabIndex = -1;
    const close = () => {
        if (!open) return;
        open = false;
        if (entry) stackOf(doc).pop(entry, { focus: false });
        entry = null;
        layer.remove();
        onClose?.();
        const back = typeof returnTo === 'function' ? returnTo() : returnTo;
        back?.focus?.({ preventScroll: true });   // (after onClose: the screen may have drawn again, and the tile is a new node)
    };

    const head = h(doc, 'div', 't');
    head.append(
        h(doc, 'b', 'sheet-name', item.name),
        h(doc, 'span', 'm', [S.rarities[item.rarity || COMMON], S.kinds[item.kind]].filter(Boolean).join(' · ')),
    );
    const facts = h(doc, 'dl', 'sheet-facts');
    const fact = (label, value) => {
        if (value === '' || value === null || value === undefined) return;
        facts.append(h(doc, 'dt', '', label), h(doc, 'dd', '', String(value)));
    };
    if (row) fact(G.editSlot, slotLabel(item, row));
    if (row) fact(G.form.bonus, row.bonus || G.noBonus);
    if (row) fact(S.condTitle, G.words[row.word] ?? '');
    if (item.qty != 1) fact(S.itemCount, item.qty);
    if (item.weight !== undefined) fact(S.weight, item.weight);
    sheet.append(head);
    if (wearer) sheet.append(h(doc, 'p', 'sheet-who', fill(S.wornBy, { name: wearer })));
    sheet.append(facts);
    if (item.note) sheet.append(h(doc, 'p', 'note muted', item.note));

    const bar = h(doc, 'div', 'sheet-actions');
    for (const action of actions) bar.append(actionButton(doc, action, close));
    const x = h(doc, 'button', 'ss-button sheet-close', S.sheetClose);
    x.setAttribute('type', 'button');
    x.addEventListener('click', close);
    const slot = h(doc, 'div', 'sheet-slot');   // where an action that keeps the sheet open (Edit) draws its form
    sheet.append(slot, bar, x);

    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    // An Escape inside the sheet (its buttons, the Edit form) stops here: it never reaches the document, so a game view under it stays open.
    layer.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); }
    });
    layer.append(sheet);
    return {
        el: layer,
        slot,
        show() {
            (doc.body ?? doc).append(layer);
            entry = stackOf(doc).push({ name: 'inventory-sheet', el: layer, root: sheet, onEscape: () => { close(); return true; } });
            (bar.querySelector?.('button') ?? x).focus?.({ preventScroll: true });
        },
        close,
    };
}

/** The Grid view's CSS, added after the screen's own CSS (BASE_CSS first). Tiles are square, four to a line on a phone. (The sheet's CSS is in view/mounts-*.css: it is outside the screen.) */
export const GRID_CSS = `
.tile-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; list-style: none; margin: 0; padding: 0; }
@container (min-width: 520px) { .tile-grid { grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); } }
.tile-cell { min-width: 0; }
.tile { position: relative; display: flex; flex-direction: column; justify-content: flex-end; width: 100%; aspect-ratio: 1 / 1; min-width: 0; min-height: 36px;
  overflow: hidden; padding: 6px; border: 1.5px solid var(--rarity, var(--sb-common)); border-radius: 12px; background: var(--sb-surface);
  color: var(--sb-fg); font: inherit; text-align: left; cursor: pointer; }
.tile.r-uncommon { --rarity: var(--sb-uncommon); }
.tile.r-rare { --rarity: var(--sb-rare); }
.tile.r-epic { --rarity: var(--sb-epic); }
.tile.r-legendary { --rarity: var(--sb-legendary); }
.tile:focus-visible, .fold-head:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 2px; }
.tile .nm { font-size: 11px; font-weight: 700; line-height: 1.15; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.tile .bn { margin-top: 2px; font-size: 10px; font-weight: 800; color: var(--ss-good, var(--sb-good)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .sl { position: absolute; top: 5px; left: 6px; font-size: 8.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; color: var(--sb-em); }
.tile .q { position: absolute; top: 4px; right: 6px; font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
.tile .dot { position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: var(--ss-warn, #e0b04a); }
.tile .dot.cond-broken { background: var(--ss-bad, var(--sb-bad)); }
.tile .lock { position: absolute; right: 5px; bottom: 5px; font-size: 9px; color: var(--sb-em); }
.fold-sec { display: grid; gap: 8px; }
.fold-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 6px 10px; border: 1px solid var(--sb-border); border-radius: 12px;
  background: transparent; color: var(--sb-fg); font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.fold-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.fold-count { margin-left: auto; color: var(--sb-em); font-variant-numeric: tabular-nums; }
.fold-chev { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; }
.fold-chev svg { width: 12px; height: 12px; display: block; transition: transform 0.15s; }
.fold-head.is-open .fold-chev svg { transform: rotate(90deg); }
.fold-sec.worn-wearer > .fold-head .fold-label { font-weight: 700; }
/* the category heads are the mockup's rule-style section heads (no box): chevron, UPPERCASE label, a hairline filling the row, the count at the right. The row is
   30px; the 44px tap area is the button's own padding taken back with a negative margin, so the rows keep the mockup's spacing. */
.fold-sec.cat > .fold-head { gap: 8px; min-height: 44px; margin-block: -7px; padding: 7px 0; border: 0; border-radius: 0; font-size: 11.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
.fold-sec.cat > .fold-head .fold-label { flex: 0 1 auto; font-weight: 800; }
.fold-sec.cat > .fold-head .fold-chev { color: var(--sb-em); }
.fold-sec.cat > .fold-head::after { content: ""; flex: 1 1 0; min-width: 12px; height: 1px; background: var(--sb-border); }
.fold-sec.cat > .fold-head .fold-count { order: 2; margin-left: 0; letter-spacing: 0; text-transform: none; font-weight: 700; }
.inv-view { display: inline-flex; border: 1px solid var(--sb-border); border-radius: 9px; }   /* the mockup's slim toggle; the buttons' 44px tap areas reach outside it */
.inv-view button { min-height: 0; padding: 4px 9px; border: 0; background: transparent; color: var(--sb-em); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.inv-view button:first-child { border-radius: 8px 0 0 8px; } .inv-view button:last-child { border-radius: 0 8px 8px 0; }
.inv-view button[aria-pressed="true"] { background: color-mix(in srgb, var(--sb-accent) 24%, transparent); color: var(--sb-fg); }
.inv-view button:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: -2px; }
.inv-grid-body { display: grid; gap: var(--sb-gap); }
.worn-folds { display: grid; gap: var(--sb-gap); }
`;
