// The Inventory header's inline form for the reader's own items.
import { STRINGS } from '../strings.js';
import { h, shell } from '../view/widgets/dom.js';
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
