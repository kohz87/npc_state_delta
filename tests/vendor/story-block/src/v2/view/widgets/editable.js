// An inline reader edit. The value is displayed as text; saving sends one ordinary UI command.
import { formatAmount, parseMixedAmount } from '../../domains/money.js';
import { STRINGS, fill, refusalText } from '../../strings.js';
import { h, iconNode, shell } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { props, cut } from './editable/props.js';
import { createFields } from './editable/fields.js';
import { meterRatio } from './meter.js';
import { focusNode } from '../scroll.js';
import { editFields, editPlan } from '../gear-form.js';

const E = STRINGS.editable;

let nextOptions = 0;

function render(el, input, api) {
    return shell(el, 'span', 'editable', ({ doc, root, listen }) => {
        const shown = h(doc, 'span', 'ss-w-editable-value');
        const pencil = h(doc, 'button', 'ss-iconbutton ss-w-editable-pencil');
        pencil.setAttribute('type', 'button');
        const glyph = iconNode(doc, 'ph-pencil-simple');
        if (glyph) pencil.appendChild(glyph);
        const form = h(doc, 'span', 'ss-w-editable-form');
        const chips = h(doc, 'span', 'ss-w-editable-chips');
        const fieldSlot = h(doc, 'span', 'ss-w-editable-field');
        const add = h(doc, 'button', 'ss-button ss-w-editable-add', E.add);
        const save = h(doc, 'button', 'ss-button ss-button-primary ss-w-editable-save', E.save);
        const cancel = h(doc, 'button', 'ss-button ss-w-editable-cancel', E.cancel);
        for (const button of [add, save, cancel]) button.setAttribute('type', 'button');
        const error = h(doc, 'span', 'ss-w-editable-error');
        error.setAttribute('role', 'alert');
        const helpLine = h(doc, 'span', 'ss-w-editable-help');
        const introLine = h(doc, 'span', 'ss-w-editable-help ss-w-editable-intro');
        const actions = h(doc, 'span', 'ss-w-editable-actions');
        const plain = () => form.replaceChildren(chips, fieldSlot, add, save, cancel, error);
        plain();
        root.append(shown, pencil);
        let p = resolveProps(props, input);
        let field = null;
        let itemCount = null;
        let itemCarry = null;
        let itemNote = null;
        let slotSelect = null;
        let bySelect = null;
        let entries = [];
        let editing = false;
        let busy = false;
        let alive = true;
        // The redraw hold of the plan running now: released when the plan ends (success or refusal) or the form goes, never kept longer.
        let releasePlan = null;
        // The grouped form being edited: its fields and plan (the props' own, or, for a piece the reader added by hand with Gear in fights on, the gear form's).
        let formFields = null;
        let formPlan = null;
        const fields = createFields(doc, fieldSlot, () => ++nextOptions);

        function drawChips() {
            chips.replaceChildren(...entries.map((value, index) => {
                const chip = h(doc, 'span', 'ss-chip');
                const name = h(doc, 'span', '', value);
                const remove = h(doc, 'button', 'ss-w-editable-remove', '×');
                remove.setAttribute('type', 'button');
                remove.setAttribute('aria-label', fill(E.remove, { value }));
                remove.setAttribute('data-index', String(index));
                chip.append(name, remove);
                return chip;
            }));
        }

        function draw() {
            const list = p.kind === 'list';
            const value = list && Array.isArray(p.value) ? p.value.join(', ') : String(p.value ?? '');
            shown.classList.toggle('ss-w-editable-value-list', list && p.displayChips);
            const meter = p.kind === 'number' && p.displayMeter && p.min !== null && p.max !== null;
            shown.classList.toggle('ss-w-editable-meter', meter);
            if (meter) {
                shown.setAttribute('role', 'meter');
                shown.setAttribute('aria-label', p.label || E.value);
                shown.setAttribute('aria-valuemin', String(p.min));
                shown.setAttribute('aria-valuemax', String(p.max));
                shown.setAttribute('aria-valuenow', String(p.value));
            } else for (const attr of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']) shown.removeAttribute(attr);
            if (p.displayValue && list && p.displayChips && Array.isArray(p.value)) {
                shown.replaceChildren(...p.value.map(entry => h(doc, 'span', 'ss-chip', String(entry))));
            } else if (p.displayValue && meter) {
                const track = h(doc, 'span', 'ss-w-editable-meter-track');
                const fill = h(doc, 'span', 'ss-w-editable-meter-fill');
                track.setAttribute('aria-hidden', 'true');
                track.style.setProperty('--ss-w-ratio', String(meterRatio(Number(p.value), p.min, p.max)));
                track.appendChild(fill);
                shown.replaceChildren(h(doc, 'span', '', `${value}/${p.max}`), track);
            } else if (p.displayValue && p.kind === 'choice' && p.displayPill) {
                shown.replaceChildren(h(doc, 'span', 'ss-pill', value));
            } else shown.textContent = p.displayValue ? value : '';
            pencil.hidden = editing || p.bare || !canEdit();
            pencil.setAttribute('aria-label', fill(E.edit, { label: p.label || E.value }));
            pencil.setAttribute('title', fill(E.edit, { label: p.label || E.value }));
            shown.hidden = editing || p.bare || !p.displayValue;
            if (editing && form.parentNode !== root) root.appendChild(form);
            else if (!editing && form.parentNode === root) form.remove();
        }

        function canEdit() {
            return typeof api?.command === 'function' && (Boolean(p.command) || typeof p.plan === 'function');
        }

        function open() {
            if (!canEdit()) return;
            editing = true;
            error.textContent = '';
            plain();
            form.classList.remove('ss-w-editable-grouped');
            form.removeAttribute('role');
            form.removeAttribute('aria-label');
            fieldSlot.classList.remove('ss-w-editable-groups');
            entries = Array.isArray(p.value) ? p.value.map(String) : [];
            // (a piece the reader added by hand, Gear in fights on: the grouped gear form in place of the three boxes)
            const handForm = p.kind === 'item' && p.gear?.row?.hand === true && !(typeof p.gear.bound === 'string' && p.gear.bound);
            formFields = handForm ? editFields(p) : p.kind === 'fields' ? p.fields : null;
            formPlan = handForm ? editPlan(p) : p.plan;
            introLine.textContent = handForm ? (p.gear.kit === true ? `${STRINGS.inventory.gear.form.kitHint} ${STRINGS.inventory.gear.form.kitGreeting}` : '') : p.intro;
            if (p.kind === 'item' && !handForm) {
                field = h(doc, 'input', 'ss-input');
                itemCount = h(doc, 'input', 'ss-input');
                itemNote = h(doc, 'input', 'ss-input');
                field.setAttribute('aria-label', STRINGS.inventory.itemName);
                itemCount.setAttribute('aria-label', STRINGS.inventory.itemCount);
                itemNote.setAttribute('aria-label', STRINGS.inventory.itemNote);
                itemCount.setAttribute('type', 'number');
                itemCount.setAttribute('min', '1');
                itemCount.setAttribute('step', '1');
                field.value = String(p.value ?? '');
                itemCount.value = String(p.itemCount);
                itemNote.value = p.itemNote;
                const label = (text, input) => {
                    const node = h(doc, 'label', 'ss-w-editable-item-label');
                    node.append(h(doc, 'span', '', text), input);
                    return node;
                };
                fieldSlot.classList.add('ss-w-editable-item-fields');
                const rows = [label(STRINGS.inventory.itemName, field), label(STRINGS.inventory.itemCount, itemCount), label(STRINGS.inventory.itemNote, itemNote)];
                slotSelect = null;
                bySelect = null;
                if (p.gear?.kind === 'equipment') {
                    const G = STRINGS.inventory.gear;
                    const choice = (text, options, value) => {
                        const select = h(doc, 'select', 'ss-select');
                        select.setAttribute('aria-label', text);
                        for (const [optionValue, optionLabel] of [['', G.none], ...options]) {
                            const option = h(doc, 'option', '', optionLabel);
                            option.value = optionValue;
                            select.appendChild(option);
                        }
                        select.value = value;
                        pair.appendChild(label(text, select));
                        return select;
                    };
                    const pair = h(doc, 'span', 'ss-w-editable-item-pair');
                    rows[2].classList.add('ss-w-editable-item-wide');
                    rows.push(pair);
                    slotSelect = choice(G.editSlot, Object.entries(G.slots), String(p.gear.slot ?? ''));
                    const owners = (Array.isArray(p.gear.owners) ? p.gear.owners : []).map(entry => [String(entry?.value ?? ''), String(entry?.label ?? '')]), by = String(p.gear.by ?? '');
                    // A wearer who left the party is still listed (chosen), so None is a choice the reader can make and Save leaves the piece with them otherwise.
                    bySelect = choice(G.editBy, by && !owners.some(entry => entry[0] === by) ? [...owners, [by, G.left]] : owners, by);
                    // A cast member's signature piece (`gear.bound`: their name): everything but the note is read-only, with one line saying why.
                    if (typeof p.gear.bound === 'string' && p.gear.bound) {
                        for (const control of [field, itemCount, slotSelect, bySelect]) { control.disabled = true; control.setAttribute('title', fill(G.boundTitle, { name: p.gear.bound })); }
                        const hint = h(doc, 'p', 'ss-w-editable-item-hint', fill(G.boundHint, { name: p.gear.bound }));
                        rows.push(hint);
                    }
                }
                // A pack's item keeps its kind, slot and rarity (the choice of where it is worn stays): one line says so.
                if (p.gear && typeof p.gear.def === 'string' && p.gear.def.startsWith('pack.') && !(typeof p.gear.bound === 'string' && p.gear.bound)) {
                    rows.push(h(doc, 'p', 'ss-w-editable-item-hint ss-w-editable-pack-hint', STRINGS.inventory.gear.form.packHint));
                }
                // The reader's Carry (not money, not a pack's item, not a hand-made piece: that form has its own): set by the reader only.
                itemCarry = null;
                if (p.gear?.row?.carryEdit === true) {
                    const GF = STRINGS.inventory.gear.form;
                    itemCarry = h(doc, 'input', 'ss-input');
                    itemCarry.setAttribute('aria-label', GF.carry);
                    for (const [name, value] of [['type', 'number'], ['min', '0'], ['max', '500'], ['step', '1']]) itemCarry.setAttribute(name, value);
                    itemCarry.value = String(Number.isSafeInteger(p.gear.row.carry) ? p.gear.row.carry : 0);
                    rows.push(label(GF.carry, itemCarry), h(doc, 'p', 'ss-w-editable-item-hint', GF.carryHelp));
                }
                fieldSlot.replaceChildren(...rows);
                chips.hidden = true;
                add.hidden = true;
                form.classList.add('ss-w-editable-item-form');
                draw();
                focusNode(field.disabled ? itemNote : field);
                return;
            }
            fieldSlot.classList.remove('ss-w-editable-item-fields', 'ss-w-editable-record-fields');
            form.classList.remove('ss-w-editable-item-form');
            if (formFields) {
                fields.inputs = formFields.filter(spec => spec && typeof spec === 'object' && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(spec.key))).map(fields.fieldEntry);
                field = fields.inputs.find(entry => entry.input && !entry.input.disabled)?.input ?? null;
                if (fields.layFields(fields.inputs)) {
                    helpLine.textContent = p.help;
                    helpLine.hidden = !p.help;
                    introLine.hidden = !introLine.textContent;
                    actions.replaceChildren(save, cancel);
                    form.replaceChildren(...(introLine.textContent ? [introLine] : []), fieldSlot, helpLine, error, actions);
                    form.classList.add('ss-w-editable-grouped');
                    form.classList.toggle('ss-w-editable-gear', fields.inputs.some(entry => entry.spec.showWhen));
                    form.setAttribute('role', 'group');
                    if (p.label) form.setAttribute('aria-label', p.label);
                }
                chips.hidden = true;
                add.hidden = true;
                form.classList.add('ss-w-editable-item-form');
                fields.refresh();
                draw();
                focusNode(field);
                return;
            }
            const choice = p.kind === 'choice';
            field = h(doc, choice ? 'select' : 'input', choice ? 'ss-select' : 'ss-input');
            field.setAttribute('aria-label', p.label || E.value);
            if (!choice) {
                field.setAttribute('type', p.kind === 'number' ? 'number' : 'text');
                if (p.kind === 'number') {
                    field.setAttribute('step', '1');
                    if (p.min !== null) field.setAttribute('min', String(p.min));
                    if (p.max !== null) field.setAttribute('max', String(p.max));
                }
            }
            if (choice) for (const item of p.options) {
                const value = typeof item === 'object' && item !== null ? item.value : item;
                const label = typeof item === 'object' && item !== null ? (item.label ?? value) : item;
                const option = h(doc, 'option', '', label);
                option.value = String(value ?? '');
                field.appendChild(option);
            }
            if (!choice && p.options.length) {
                const suggestions = h(doc, 'datalist', 'ss-w-editable-options');
                const id = `ss-editable-options-${++nextOptions}`;
                suggestions.setAttribute('id', id);
                field.setAttribute('list', id);
                for (const item of p.options) {
                    const option = h(doc, 'option');
                    option.value = String(typeof item === 'object' && item !== null ? item.value ?? item.name ?? '' : item);
                    suggestions.appendChild(option);
                }
                fieldSlot.replaceChildren(field, suggestions);
            } else fieldSlot.replaceChildren(field);
            field.value = p.kind === 'list' ? '' : p.money ? formatAmount(p.value ?? 0, p.currency) : String(p.value ?? '');
            chips.hidden = p.kind !== 'list';
            add.hidden = p.kind !== 'list';
            drawChips();
            draw();
            focusNode(field);
        }

        // `quiet`: closed by the caller (the `open` prop turned off), who needs no word of it.
        function close(quiet = false) {
            editing = false;
            draw();
            if (!pencil.hidden) focusNode(pencil);
            if (quiet !== true && typeof p.onClose === 'function') p.onClose();
        }
        function addEntry() {
            const value = cut(field?.value, p.maxLength);
            if (value) entries.push(value);
            if (field) field.value = '';
            drawChips();
        }
        // The form's `plan`: the steps run one after the other; a refusal stops the rest and leaves the form open with its sentence. A step that
        // went through is not sent again by the next Save: its boxes now count as what the form opened with.
        // The screen holds its redraw while the steps run (`api.hold()`, always released at the end, then one redraw); if navigation destroys the form meanwhile, the next step does not run.
        async function runPlan({ changed, all }) {
            if (!Object.keys(changed).length && !p.always) {
                if (p.kind === 'item' && p.gear?.kind === 'equipment') { error.textContent = p.gear.place ? STRINGS.editMessages.nothingChanged : STRINGS.editMessages.nothingWorn; return; }
                close(); return;
            }
            let outcome;
            try { outcome = formPlan(changed, all); } catch (failure) { outcome = { error: String(failure?.message ?? failure) }; }
            if (outcome?.error) { error.textContent = String(outcome.error); return; }
            const steps = Array.isArray(outcome?.steps) ? outcome.steps : [];
            if (!steps.length) { close(); return; }
            busy = true;
            save.disabled = true;
            const release = api.hold?.();
            releasePlan = release;
            let committed = 0;
            try {
                for (const step of steps) {
                    let result;
                    try { result = await api.command(String(step.command), step.payload && typeof step.payload === 'object' ? step.payload : {}); }
                    catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
                    if (!alive) return;
                    if (!result?.ok) {
                        busy = false;
                        save.disabled = false;
                        error.textContent = refusalText(result, E.failed);
                        // After a committed step the screen redraws when the hold goes, so the sentence also shows as a page notice.
                        if (committed) api.notify?.(error.textContent);
                        return;
                    }
                    committed += 1;
                    for (const entry of fields.inputs) if (Array.isArray(step.keys) && step.keys.includes(String(entry.spec.key))) entry.spec = { ...entry.spec, value: all[String(entry.spec.key)] ?? '' };
                }
                busy = false;
                save.disabled = false;
                close();
            } finally { releasePlan = null; release?.(); }
        }

        // The steps an item's Slot and Equipped by choices need: taken off, or handed to the wearer and put on. [] when nothing changed.
        function wearSteps() {
            if (!slotSelect || !bySelect || slotSelect.disabled) return []; // (a bound piece: the choices are locked)
            const stack = p.payload?.stack;
            const placed = String(p.gear.place ?? ''), wearer = String(p.gear.by ?? '');
            const by = bySelect.value, slot = slotSelect.value;
            if (by === '' || slot === '') return placed ? [{ command: 'inventory.unequip', payload: { stack } }] : [];
            if (placed === slot && wearer === by) return [];
            // (one command, so a refusal of the slot leaves the item with its owner: all or nothing)
            return [{ command: 'item.equip', payload: { stack, owner: by, slot, ...(by !== p.gear.owner ? { transfer: true } : {}) } }];
        }

        // Commands one after the other: a refusal stops the rest and leaves the form open with its sentence.
        async function runSteps(steps) {
            busy = true;
            save.disabled = true;
            const release = api.hold?.();
            releasePlan = release;
            let committed = 0;
            try {
                for (const step of steps) {
                    let result;
                    try { result = await api.command(step.command, step.payload); }
                    catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
                    if (!alive) return;
                    if (!result?.ok) {
                        busy = false;
                        save.disabled = false;
                        error.textContent = refusalText(result, E.failed);
                        // After a committed step the screen redraws when the hold goes, so the sentence also shows as a page notice.
                        if (committed) api.notify?.(error.textContent);
                        return;
                    }
                    committed += 1;
                }
                busy = false;
                save.disabled = false;
                close();
            } finally { releasePlan = null; release?.(); }
        }

        async function submit() {
            if (busy || !field) return;
            let value;
            let payload;
            if (p.kind === 'item' && !formFields) {
                const raw = String(itemCount.value).trim(), qty = Number(raw);
                if (!/^\d+$/.test(raw) || !Number.isSafeInteger(qty) || qty < 1) { error.textContent = STRINGS.inventory.countError; return; }
                payload = { ...p.payload };
                // The name is sent only when the reader changed it (a long name shown in full and left alone is no rename), held to the inventory's 120.
                const name = field.value === p.value ? p.value : cut(field.value, 120), note = cut(itemNote.value, 300);
                if (name !== p.value) payload.name = name;
                if (qty !== p.itemCount) payload.qty = qty;
                if (note !== p.itemNote) payload.note = note;
                const edited = 'name' in payload || 'qty' in payload || 'note' in payload;
                const worn = wearSteps();
                const steps = [];
                if (itemCarry) {
                    const was = Number.isSafeInteger(p.gear.row.carry) ? p.gear.row.carry : 0, raw = String(itemCarry.value).trim(), carry = Number(raw);
                    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(carry) || carry > 500) { error.textContent = E.carryRange.replace('{max}', '500'); return; }
                    if (carry !== was) steps.push({ command: 'inventory.carry', payload: { stack: p.payload?.stack, carry } });
                }
                if (!edited && !worn.length && !steps.length) {
                    // (an equipment piece's Save that changes nothing says so, in the form's own line, instead of closing as if it had done something)
                    if (p.gear?.kind === 'equipment') { error.textContent = p.gear.place ? STRINGS.editMessages.nothingChanged : STRINGS.editMessages.nothingWorn; return; }
                    close(); return;
                }
                if (worn.length || steps.length) { await runSteps([...(edited ? [{ command: p.command, payload }] : []), ...worn, ...steps]); return; }
            } else if (formFields) {
                const read = fields.readFields(p);
                if (read.error) { error.textContent = read.error; focusNode(read.input); return; }
                if (typeof formPlan === 'function') { await runPlan(read); return; }
                if (!Object.keys(read.changed).length) { close(); return; }
                payload = { ...p.payload, ...read.changed };
            } else if (p.kind === 'number') {
                const raw = String(field.value).trim();
                if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) { error.textContent = E.wholeNumber; return; }
                value = Number(raw);
                if (p.min !== null) value = Math.max(p.min, value);
                if (p.max !== null) value = Math.min(p.max, value);
                field.value = String(value);
            } else if (p.money) {
                const parsed = parseMixedAmount(field.value, p.currency);
                if (parsed.error) { error.textContent = parsed.error; return; }
                value = parsed.amount;
            } else if (p.kind === 'list') {
                addEntry();
                value = [...entries];
            } else if (p.kind === 'choice') {
                const selected = p.options.find(item => String(typeof item === 'object' && item !== null ? item.value : item) === field.value);
                value = typeof selected === 'object' && selected !== null ? selected.value : selected;
            } else value = cut(field.value, p.maxLength);
            if (!payload) {
                if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(p.valueKey) || ['constructor', 'prototype', '__proto__'].includes(p.valueKey)) return;
                payload = { ...p.payload, [p.valueKey]: value };
            }
            busy = true;
            save.disabled = true;
            let result;
            try { result = await api.command(p.command, payload); }
            catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
            busy = false;
            save.disabled = false;
            if (!alive) return;
            if (result?.ok) close();
            else error.textContent = refusalText(result, E.failed);
        }
        listen(chips, 'click', event => {
            const index = Number(event.target?.getAttribute?.('data-index'));
            if (event.target?.getAttribute?.('data-index') !== null && Number.isInteger(index)) { entries.splice(index, 1); drawChips(); }
        });
        listen(pencil, 'click', open);
        listen(add, 'click', addEntry);
        listen(save, 'click', submit);
        listen(cancel, 'click', () => close());
        listen(form, 'input', () => { if (formFields) fields.refresh(); });
        listen(form, 'change', () => { if (formFields) fields.refresh(); });
        listen(form, 'input', event => {
            if (event.target !== field || p.kind !== 'number' || !/^-?\d+$/.test(field.value)) return;
            let value = Number(field.value);
            if (!Number.isSafeInteger(value)) return;
            if (p.min !== null) value = Math.max(p.min, value);
            if (p.max !== null) value = Math.min(p.max, value);
            field.value = String(value);
        });
        listen(form, 'keydown', event => {
            if (event.key === 'Escape') { event.preventDefault?.(); close(); }
            else if (event.key === 'Enter') { event.preventDefault?.(); submit(); }
        });
        function update(next) {
            p = resolveProps(props, next);
            draw();
            if (p.open && !editing) open();
            else if (!p.open && editing && p.bare) close(true);
        }
        update(input);
        return { update, destroy() { alive = false; releasePlan?.(); } };
    });
}

export const editable = defineWidget({ props, primary: 'value', render });
