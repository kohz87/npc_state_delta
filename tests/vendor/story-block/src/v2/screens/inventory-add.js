// The Inventory header's inline form for the reader's own items.
import { STRINGS } from '../strings.js';
import { h, shell } from '../view/widgets/dom.js';

export const INVENTORY_ADD_WIDGET = 'story-block.inventory-add';
const S = STRINGS.inventory;

export function createInventoryAddWidget() {
    return Object.freeze({
        props: {}, primary: null, validate: () => [],
        render(el, _props, api) {
            return shell(el, 'span', 'inventory-add', ({ doc, root, listen }) => {
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
                let alive = true;
                const close = () => { form.remove(); open.hidden = false; open.focus?.(); };
                const begin = () => {
                    if (typeof api?.command !== 'function') return;
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
                const update = () => { open.hidden = typeof api?.command !== 'function'; };
                update();
                return { update, destroy() { alive = false; } };
            });
        },
    });
}
