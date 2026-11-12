// The Inventory header's inline form for the reader's own items, the folded "Worn (N)" row (gear on), and the Grid view's two widgets:
// the List | Grid switch and the grid itself (tiles, folding categories, Worn per wearer, the item sheet; helpers in inventory-grid.js).
import { KIND_ORDER } from '../domains/inventory.js';
import { STRINGS, fill } from '../strings.js';
import { categorySection, foldSection, foldStore, itemSheet, wornSection } from './inventory-grid.js';
import { h, s as svg, shell } from '../view/widgets/dom.js';
import { editable } from '../view/widgets/editable.js';
import { addFields, addPlan } from '../view/gear-form.js';

export const INVENTORY_ADD_WIDGET = 'story-block.inventory-add';
const S = STRINGS.inventory;

export function createInventoryAddWidget() {
    return Object.freeze({
        props: {}, primary: null, validate: () => [],
        render(el, _props, api) {
            return shell(el, 'span', 'inventory-add', ({ doc, root, listen, cleanup }) => {
                const open = h(doc, 'button', 'ss-button ss-button-primary', S.addItem);
                open.setAttribute('type', 'button');
                const form = h(doc, 'span', 'inv-add-form');
                const name = h(doc, 'input', 'ss-input');
                const qty = h(doc, 'input', 'ss-input');
                const note = h(doc, 'input', 'ss-input');
                name.setAttribute('aria-label', S.itemName);
                qty.setAttribute('aria-label', S.itemCount);
                note.setAttribute('aria-label', S.itemNote);
                qty.setAttribute('type', 'number'); qty.setAttribute('min', '1'); qty.setAttribute('step', '1');
                const save = h(doc, 'button', 'ss-button ss-button-primary', S.save);
                const cancel = h(doc, 'button', 'ss-button', S.cancel);
                for (const button of [save, cancel]) button.setAttribute('type', 'button');
                const error = h(doc, 'span', 'inv-add-error'); error.setAttribute('role', 'alert');
                form.append(name, qty, note, save, cancel, error);
                root.appendChild(open);
                // Made only when a gear-on chat needs it, so the gear-off screen stays byte-for-byte as it was.
                let notice = null;
                const say = text => {
                    if (!notice) { notice = h(doc, 'span', 'inv-add-error'); notice.setAttribute('role', 'alert'); root.appendChild(notice); }
                    notice.textContent = text;
                };
                let alive = true;
                const close = () => { form.remove(); open.hidden = false; open.focus?.(); };
                // Gear in fights on (`q.gx` answers): the same grouped form as Edit (view/gear-form.js), full width under the button, in place of the inline row.
                const gearView = () => { try { return api?.resolve?.('q.gx') ?? null; } catch { return null; } };
                let gearForm = null;
                const closeGear = () => {
                    gearForm?.handle.destroy();
                    gearForm?.slot.remove();
                    gearForm = null;
                    open.hidden = false;
                    open.focus?.();
                };
                const beginGear = view => {
                    const kit = view.kit?.open === true;
                    const slot = h(doc, 'span', 'inv-add-gear');
                    root.appendChild(slot);
                    const props = { kind: 'fields', bare: true, open: true, always: true, label: S.addItem, intro: kit ? `${STRINGS.inventory.gear.form.kitHint} ${STRINGS.inventory.gear.form.kitGreeting}` : '',
                        fields: addFields({ kit, owners: view.owners }), plan: addPlan({ kit }), onClose: closeGear };
                    open.hidden = true;
                    gearForm = { slot, handle: editable.render(slot, props, api) };
                };
                cleanup(() => gearForm?.handle.destroy());
                const begin = () => {
                    if (typeof api?.command !== 'function') return;
                    const view = gearView();
                    if (view?.kit?.empty === true) { say(STRINGS.inventory.gear.form.noGreeting); return; }
                    if (notice) say('');
                    if (view && !gearForm) { beginGear(view); return; }
                    name.value = ''; qty.value = '1'; note.value = ''; error.textContent = '';
                    open.hidden = true; root.appendChild(form); name.focus?.();
                };
                const submit = async () => {
                    const amount = Number(qty.value);
                    if (!/^\d+$/.test(qty.value) || !Number.isSafeInteger(amount) || amount < 1) { error.textContent = S.countError; return; }
                    save.disabled = true;
                    let result;
                    try { result = await api.command('inventory.add', { name: name.value, qty: amount, note: note.value }); }
                    catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
                    save.disabled = false;
                    if (!alive) return;
                    if (result?.ok) close(); else error.textContent = result?.message || S.addError;
                };
                listen(open, 'click', begin);
                listen(save, 'click', submit);
                listen(cancel, 'click', close);
                listen(form, 'keydown', event => {
                    if (event.key === 'Escape') { event.preventDefault?.(); close(); }
                    else if (event.key === 'Enter') { event.preventDefault?.(); submit(); }
                });
                // With Gear in fights on (the screen's `q.gx` answers) the button is the slim pill of the filter row on a phone too: the compact pill
                // (`ss-tap-pill`: about 30px drawn with a 44px tap area) in place of the 44px block every phone button is.
                const slim = () => { try { return api?.resolve?.('q.gx') != null; } catch { return false; } };
                const update = () => { open.hidden = typeof api?.command !== 'function' || gearForm !== null; if (slim()) open.classList.add('ss-tap-pill'); else open.classList.remove('ss-tap-pill'); };
                update();
                return { update, destroy() { alive = false; } };
            });
        },
    });
}

export const WORN_FOLD_WIDGET = 'story-block.worn-fold';
const G = S.gear;

/**
 * The "Worn (N)" row: a drawn chevron on the left (as the Party card's Left row), the count, and, folded, who wears how many ("Astra 5 · Sister Temiwa 1").
 * Props: `rows` (the screen's `q.gx.rows`) and `open` ('1' open, '0' closed, '' not chosen yet this view). Open or folded is the viewer's choice, per chat on this device
 * (localStorage, never game state; a storage that throws means folded); the screen's draft `wornOpen` carries it to the rows below (the template shows them while it is '1').
 */
export function createWornFoldWidget({ chatKey = () => '', storage = undefined } = {}) {
    const key = () => `story-block.inventoryWornOpen|${chatKey()}`;
    const area = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
    const kept = new Map();
    const stored = () => { if (kept.has(key())) return kept.get(key()); try { return area()?.getItem?.(key()) === '1'; } catch { return false; } };
    const keep = on => { kept.set(key(), on); try { if (on) area()?.setItem?.(key(), '1'); else area()?.removeItem?.(key()); } catch { /* the choice lasts this page only */ } };
    return Object.freeze({
        props: {}, primary: null, validate: () => [],
        render(el, first, api) {
            return shell(el, 'div', 'worn-fold', ({ doc, root, listen }) => {
                let props = first ?? {};
                const draw = () => {
                    const worn = Object.values(props.rows ?? {}).filter(row => row && typeof row.place === 'string' && row.place !== '');
                    root.hidden = worn.length === 0;
                    const hadFocus = Boolean(doc.activeElement && root.contains?.(doc.activeElement));   // (the redraw replaces the button: its replacement keeps the focus)
                    root.replaceChildren();
                    if (!worn.length) return;
                    const opened = props.open === '1';
                    const by = new Map();
                    for (const row of worn) by.set(row.by, (by.get(row.by) ?? 0) + 1);
                    const button = h(doc, 'button', `worn-fold-btn${opened ? ' worn-open' : ''}`);
                    button.setAttribute('type', 'button');
                    button.setAttribute('aria-expanded', String(opened));
                    button.setAttribute('title', G.wornFoldTitle);
                    const chevron = h(doc, 'span', 'worn-chev');
                    const drawn = svg(doc, 'svg', { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
                    drawn.appendChild(svg(doc, 'path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }));
                    chevron.appendChild(drawn);
                    button.append(chevron, h(doc, 'b', '', G.wornFold.replace('{n}', String(worn.length))));
                    if (!opened) button.appendChild(h(doc, 'span', 'worn-names', [...by].map(([name, n]) => `${name} ${n}`).join(' \u00b7 ')));
                    listen(button, 'click', () => { keep(!opened); api?.draft?.set?.('wornOpen', opened ? '0' : '1'); });
                    root.appendChild(button);
                    if (hadFocus) button.focus?.();
                };
                draw();
                // Folded for the first look, unless this chat was left open on this device: the draft is filled once the draw is done.
                if (props.open === '' && stored()) Promise.resolve().then(() => api?.draft?.set?.('wornOpen', '1'));
                return { update(next) { props = next ?? {}; draw(); } };
            });
        },
    });
}

export const INVENTORY_VIEW_WIDGET = 'story-block.inventory-view';
export const INVENTORY_GRID_WIDGET = 'story-block.inventory-grid';
const GEAR_ORDER = Object.freeze(['equipment', 'consumable', 'goods', 'quest', 'material', 'money']);
const VIEWS = Object.freeze(['grid', 'list']);
const CARRY_MS = 5000;   // how long a focus waits for the screen's next draw

/**
 * The List | Grid switch. Props: `view` ('grid', 'list', or '' not chosen yet this visit). The choice is kept per device (localStorage, never game state; a storage
 * that throws means `fallback`, Grid, and the choice then lasts this page). The screen's draft `view` carries it to the template, which shows the List rows only while it is 'list'.
 */
export function createInventoryViewWidget({ storage = undefined, fallback = 'grid' } = {}) {
    const KEY = 'story-block.inventoryView';
    const area = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
    let kept = null;
    const stored = () => {
        if (kept) return kept;
        try { const value = area()?.getItem?.(KEY); return VIEWS.includes(value) ? value : fallback; } catch { return fallback; }
    };
    const keep = value => { kept = value; try { area()?.setItem?.(KEY, value); } catch { /* the choice lasts this page only */ } };
    return Object.freeze({
        props: {}, primary: null, validate: () => [],
        render(el, first, api) {
            return shell(el, 'span', 'inventory-view', ({ doc, root, listen }) => {
                let props = first ?? {};
                const draw = () => {
                    const view = VIEWS.includes(props.view) ? props.view : stored();
                    root.replaceChildren();
                    const group = h(doc, 'span', 'inv-view');
                    group.setAttribute('role', 'group');
                    group.setAttribute('aria-label', S.viewLabel);
                    for (const value of ['list', 'grid']) {
                        const button = h(doc, 'button', 'ss-tap-pill', value === 'list' ? S.viewList : S.viewGrid);   // about 30px drawn, a 44px tap area (size.css)
                        button.setAttribute('type', 'button');
                        button.setAttribute('aria-pressed', String(view === value));
                        listen(button, 'click', () => { keep(value); api?.draft?.set?.('view', value); });
                        group.append(button);
                    }
                    root.append(group);
                };
                draw();
                if (!VIEWS.includes(props.view)) Promise.resolve().then(() => api?.draft?.set?.('view', stored()));
                return { update(next) { props = next ?? {}; draw(); } };
            });
        },
    });
}

const shown = (item, filter) => (!filter.rarity || filter.rarity === item.rarity)
    && (filter.equippedOnly !== 'true' || item.equipped != null)
    && (!filter.find || String(item.name ?? '').toLowerCase().includes(String(filter.find).toLowerCase()))
    && (!filter.kind || filter.kind === item.kind);

/**
 * The Grid view. Props (the screen's data, see the template): `items` (q.items), `counts`, `rows` (q.gx.rows, null with Gear in fights off), `wearers`, `owners`, `kit`,
 * `users` (q.gear.users), `filter` ({ kind, rarity, find, equippedOnly } as the header's boxes hold them). Folds are kept per chat on this device. A tile opens the item's sheet whose
 * buttons send the same commands as the list row's (Equip, Unequip, Use on…, Drop) and whose Edit draws the row's own Edit form; nothing here changes the state itself.
 */
export function createInventoryGridWidget({ chatKey = () => '', storage = undefined } = {}) {
    const stores = new Map();
    // The tab and game-view mounts build this widget again on every redraw (view/mounts/common.js, keep=false), so the focus cannot ride on the old instance: where it was
    // (a tile's stack and the stacks in order, or none; only for the same chat) waits here for the next instance's first draw, a few seconds at most.
    let carry = null;
    const foldsFor = () => {
        const prefix = `story-block.inventoryFold|${chatKey()}|`;
        if (!stores.has(prefix)) stores.set(prefix, foldStore({ prefix, storage }));
        return stores.get(prefix);
    };
    return Object.freeze({
        props: {}, primary: null, validate: () => [],
        render(el, first, api) {
            return shell(el, 'div', 'inv-grid', ({ doc, root, cleanup }) => {
                let props = first ?? {};
                const content = h(doc, 'div', 'inv-grid-body');
                root.append(content);
                let sheet = null;
                let editing = null;
                const run = (type, payload) => api?.command?.(type, payload);
                const actionsOf = (item, row) => {
                    const { stack, name } = item;
                    const out = [];
                    if (item.kind === 'equipment') {
                        if (row) {
                            if (row.place === '' && row.slotKey !== '' && row.bound == null) {
                                out.push({ label: G.equip, icon: 'fa-hand-fist', title: fill(S.equipTitle, { name }),
                                    choices: (props.owners ?? []).map(who => ({ label: who.label, title: fill(G.equipWhoTitle, { name, who: who.label }), run: () => run('item.equip', { stack, owner: who.value, transfer: true }) })) });
                            } else if (row.place !== '' && row.bound == null) out.push({ label: S.unequip, title: fill(G.unequipTitle, { name }), run: () => run('inventory.unequip', { stack }) });
                        } else if (item.equipped == null) out.push({ label: S.equip, icon: 'fa-hand-fist', title: fill(S.equipTitle, { name }), run: () => run('inventory.equip', { stack }) });
                        else out.push({ label: S.unequip, title: fill(S.unequipTitle, { name }), run: () => run('inventory.unequip', { stack }) });
                    }
                    const users = props.users?.[stack] ?? [];
                    if (item.kind === 'consumable' && users.length > 0) {
                        out.push({ label: S.useOn, icon: 'fa-flask', title: fill(S.useOnTitle, { name }),
                            choices: users.map(who => ({ label: who.name, title: fill(S.useOnWho, { name }), run: () => run('item.use', { stack, target: who.id }) })) });
                    }
                    if (!row || row.bound == null) {
                        const all = { label: item.qty != 1 ? fill(S.dropAll, { qty: item.qty }) : S.drop, danger: true, run: () => run('inventory.drop', { stack, qty: item.qty }) };
                        out.push({ label: S.drop, icon: 'fa-trash-can', title: fill(S.dropTitle, { name }),
                            choices: item.qty != 1 ? [{ label: S.dropOne, danger: true, run: () => run('inventory.drop', { stack, qty: 1 }) }, all] : [all] });
                    }
                    out.push({ label: S.editLabel, icon: 'fa-pencil', keepOpen: true, run: () => beginEdit(item, row) });
                    return out;
                };
                const beginEdit = (item, row) => {
                    if (!sheet) return;
                    const gear = row ? { kind: item.kind, stack: item.stack, owner: item.owner, by: row.byId, place: row.place, slot: row.slotKey, bound: row.bound?.who ?? '', def: item.def, rarity: item.rarity, row, kit: props.kit === true, owners: props.owners ?? [] } : undefined;
                    const form = { value: item.name, itemCount: props.counts?.[item.stack] ?? item.qty, itemNote: item.note ?? '', displayValue: false, kind: 'item', label: S.editItem, command: 'inventory.edit',
                        payload: { stack: item.stack, group: true }, open: true, bare: true, onClose: () => sheet?.close(), ...(gear ? { gear } : {}) };
                    editing = editable.render(sheet.slot, form, api);
                };
                const closeSheet = () => { sheet?.close(); };
                const noteFocus = stack => {
                    const order = Array.from(content.querySelectorAll?.('[data-stack]') ?? []).map(node => node.getAttribute('data-stack'));
                    carry = { stack, order, at: Date.now(), chat: chatKey() };
                };
                // First draw of a new instance: the tile of the carried stack, else the next one after it, else the one before, else the first tile. Only while nothing else has the focus.
                const takeCarry = () => {
                    const was = carry;
                    carry = null;
                    const active = doc.activeElement;
                    if (!was || was.chat !== chatKey() || Date.now() - was.at > CARRY_MS || (active && active !== doc.body)) return;
                    const from = was.order.indexOf(was.stack);
                    const later = from < 0 ? [] : was.order.slice(from + 1);
                    const earlier = from < 0 ? [] : was.order.slice(0, from).reverse();
                    const tile = [was.stack, ...later, ...earlier].map(stack => content.querySelector?.(`[data-stack="${stack}"]`)).find(Boolean) ?? content.querySelector?.('.tile');
                    tile?.focus?.({ preventScroll: true });
                };
                const open = (item, tile) => {
                    closeSheet();
                    const row = props.rows?.[item.stack] ?? null;
                    // The sheet is a layer of the host's modal stack on the body (itemSheet), not a child of this screen. On close the focus goes to this stack's tile as drawn then.
                    const back = () => content.querySelector?.(`[data-stack="${item.stack}"]`) ?? tile;
                    const made = itemSheet(doc, { item, row, wearer: row?.by ?? '', actions: actionsOf(item, row), returnTo: back, onClose: () => { noteFocus(item.stack); editing?.destroy?.(); editing = null; if (sheet === made) sheet = null; } });
                    sheet = made;
                    made.show();
                };
                const toggler = id => open => { foldsFor().set(id, open); draw(id); };
                function draw(focusId = '') {
                    const rows = props.rows && typeof props.rows === 'object' ? props.rows : null;
                    const filter = props.filter ?? {};
                    const items = (props.items ?? []).filter(item => shown(item, filter));
                    const folds = foldsFor();
                    const order = rows ? [...GEAR_ORDER, ...KIND_ORDER.filter(kind => !GEAR_ORDER.includes(kind))] : KIND_ORDER;
                    const parts = [];
                    // A redraw replaces every tile and fold: the focus goes to the same one (a tile by its stack, a fold by its id), else the first tile, rather than to the body.
                    const active = doc.activeElement;
                    const kept = active && content.contains?.(active) ? { stack: active.getAttribute?.('data-stack'), fold: active.getAttribute?.('data-fold') } : null;
                    for (const kind of order) {
                        const mine = items.filter(item => item.kind === kind && !(rows && rows[item.stack]?.place));
                        const section = categorySection(doc, { kind, title: rows && kind === 'equipment' ? G.bagTitle : S.kinds[kind], items: mine, rows, open: folds.get(`cat-${kind}`, true), onToggle: toggler(`cat-${kind}`), onOpen: open });
                        if (section) parts.push(section);
                        if (rows && kind === 'equipment') {
                            const worn = wornSection(doc, { wearers: props.wearers ?? [], items, rows, open: value => folds.get(`worn-${value}`, true), onToggle: (value, on) => toggler(`worn-${value}`)(on), onOpen: open });
                            if (worn.children.length) {   // under one rule-style head, "WORN 9", like the mockup's: the wearers' folds are its body
                                const count = items.filter(item => rows[item.stack]?.place && (props.wearers ?? []).some(who => who.value === rows[item.stack].byId)).length;
                                parts.push(foldSection(doc, { id: 'cat-worn', label: G.wornTitle, count, open: folds.get('cat-worn', true), onToggle: toggler('cat-worn'), body: worn, className: 'cat cat-worn', rule: true }));
                            }
                        }
                    }
                    if (!parts.length && (props.items ?? []).length) parts.push(h(doc, 'p', 'nomatch-grid muted', S.noMatch));
                    content.replaceChildren(...parts);
                    if (focusId) content.querySelector?.(`[data-fold="${focusId}"]`)?.focus?.();
                    else if (kept) (content.querySelector?.(kept.stack ? `[data-stack="${kept.stack}"]` : `[data-fold="${kept.fold}"]`) ?? content.querySelector?.('.tile') ?? content.querySelector?.('.fold-head'))?.focus?.({ preventScroll: true });
                }
                draw();
                takeCarry();
                const leave = () => {
                    closeSheet();
                    const active = doc.activeElement;
                    if (active && content.contains?.(active) && active.getAttribute?.('data-stack')) noteFocus(active.getAttribute('data-stack'));
                };
                cleanup(leave);
                return { update(next) { props = next ?? {}; draw(); }, destroy: leave };
            });
        },
    });
}
