// An inline reader edit. The value is displayed as text; saving sends one ordinary UI command.
import { oneLine } from '../../../text.js';
import { formatAmount, parseMixedAmount } from '../../domains/money.js';
import { STRINGS, fill, refusalText } from '../../strings.js';
import { h, iconNode, shell } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { meterRatio } from './meter.js';

const E = STRINGS.editable;
const props = {
    value: { type: 'any', default: '' },
    kind: { type: 'string', default: 'text' },
    min: { type: 'number', default: null },
    max: { type: 'number', default: null },
    maxLength: { type: 'number', default: 240 },
    options: { type: 'array', default: Object.freeze([]) },
    label: { type: 'string', default: '' },
    command: { type: 'string', default: '' },
    payload: { type: 'object', default: Object.freeze({}) },
    valueKey: { type: 'string', default: 'value' },
    displayValue: { type: 'boolean', default: true },
    displayChips: { type: 'boolean', default: false },
    displayMeter: { type: 'boolean', default: false },
    displayPill: { type: 'boolean', default: false },
    money: { type: 'boolean', default: false },
    currency: { type: 'object', default: Object.freeze({}) },
    itemCount: { type: 'number', default: 1 },
    itemNote: { type: 'string', default: '' },
};
const cut = (value, max) => [...oneLine(value)].slice(0, Math.max(0, Math.floor(max))).join('');

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
        form.append(chips, fieldSlot, add, save, cancel, error);
        root.append(shown, pencil);
        let p = resolveProps(props, input);
        let field = null;
        let itemCount = null;
        let itemNote = null;
        let entries = [];
        let editing = false;
        let busy = false;
        let alive = true;

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
            pencil.hidden = editing || !p.command || typeof api?.command !== 'function';
            pencil.setAttribute('aria-label', fill(E.edit, { label: p.label || E.value }));
            pencil.setAttribute('title', fill(E.edit, { label: p.label || E.value }));
            shown.hidden = editing || !p.displayValue;
            if (editing && form.parentNode !== root) root.appendChild(form);
            else if (!editing && form.parentNode === root) form.remove();
        }

        function open() {
            if (!p.command || typeof api?.command !== 'function') return;
            editing = true;
            error.textContent = '';
            entries = Array.isArray(p.value) ? p.value.map(String) : [];
            if (p.kind === 'item') {
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
                fieldSlot.replaceChildren(label(STRINGS.inventory.itemName, field), label(STRINGS.inventory.itemCount, itemCount), label(STRINGS.inventory.itemNote, itemNote));
                chips.hidden = true;
                add.hidden = true;
                form.classList.add('ss-w-editable-item-form');
                draw();
                field.focus?.();
                return;
            }
            fieldSlot.classList.remove('ss-w-editable-item-fields');
            form.classList.remove('ss-w-editable-item-form');
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
                suggestions.id = id;
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
            field.focus?.();
        }

        function close() {
            editing = false;
            draw();
            pencil.focus?.();
        }
        function addEntry() {
            const value = cut(field?.value, p.maxLength);
            if (value) entries.push(value);
            if (field) field.value = '';
            drawChips();
        }
        async function submit() {
            if (busy || !field) return;
            let value;
            let payload;
            if (p.kind === 'item') {
                const raw = String(itemCount.value).trim(), qty = Number(raw);
                if (!/^\d+$/.test(raw) || !Number.isSafeInteger(qty) || qty < 1) { error.textContent = STRINGS.inventory.countError; return; }
                payload = { ...p.payload };
                const name = cut(field.value, 60), note = cut(itemNote.value, 300);
                if (name !== p.value) payload.name = name;
                if (qty !== p.itemCount) payload.qty = qty;
                if (note !== p.itemNote) payload.note = note;
                if (!('name' in payload) && !('qty' in payload) && !('note' in payload)) { close(); return; }
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
        listen(cancel, 'click', close);
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
        function update(next) { p = resolveProps(props, next); draw(); }
        update(input);
        return { update, destroy() { alive = false; } };
    });
}

export const editable = defineWidget({ props, primary: 'value', render });
