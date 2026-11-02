// An inline reader edit. The value is displayed as text; saving sends one ordinary UI command.
import { oneLine } from '../../../text.js';
import { formatAmount, parseMixedAmount } from '../../domains/money.js';
import { STRINGS, fill, refusalText } from '../../strings.js';
import { h, iconNode, shell } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { meterRatio } from './meter.js';
import { focusNode } from '../scroll.js';

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
    // kind 'fields': one input per entry, `{ key, label, type: 'text' | 'number' | 'choice' | 'time', value, min?, max?, maxLength?, options?, soft?, group?, row? }`;
    // only the changed ones go in the payload. `choice` is a select over `options` (strings or `{ value, label }`); `time` is a time of day ("13:30", '' for none);
    // a `text` field with `options` suggests them. `soft` keeps `min`/`max` as hints on the box and clamps nothing. A `group` is a heading the fields under it sit
    // beneath (one fieldset per group, in order of first use); fields with the same `row` sit side by side. A blank number that was blank stays unchanged.
    fields: { type: 'array', default: Object.freeze([]) },
    // A form with groups: `help` is the line under the fields; `plan(changed, all)` (instead of `command`) answers `{ error }` or `{ steps: [{ command, payload, keys }] }`,
    // and the steps run in order through the widget api, the first refusal stopping the rest with its sentence under the fields; `bare` leaves out the pencil
    // and the shown value (the caller opens the form with `open` and hears of its closing in `onClose`).
    help: { type: 'string', default: '' },
    plan: { type: 'any', default: null },
    bare: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    onClose: { type: 'any', default: null },
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
        const helpLine = h(doc, 'span', 'ss-w-editable-help');
        const actions = h(doc, 'span', 'ss-w-editable-actions');
        const plain = () => form.replaceChildren(chips, fieldSlot, add, save, cancel, error);
        plain();
        root.append(shown, pencil);
        let p = resolveProps(props, input);
        let field = null;
        let itemCount = null;
        let itemNote = null;
        let inputs = [];
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

        // The fields of a form with `fields`: one box per spec (a select for a choice), under the heading of its group and in the row it names.
        const optionList = list => (Array.isArray(list) ? list : []).map(item => {
            const value = typeof item === 'object' && item !== null ? item.value ?? item.name ?? '' : item;
            const label = typeof item === 'object' && item !== null ? (item.label ?? item.name ?? value) : item;
            return { value, label: String(label ?? '') };
        });
        function fieldEntry(spec) {
            const type = ['number', 'choice', 'time'].includes(spec.type) ? spec.type : 'text';
            const label = String(spec.label ?? spec.key);
            const options = optionList(spec.options);
            const input = h(doc, type === 'choice' ? 'select' : 'input', type === 'choice' ? 'ss-select' : 'ss-input');
            input.setAttribute('aria-label', label);
            const node = h(doc, 'label', 'ss-w-editable-item-label');
            node.append(h(doc, 'span', '', label), input);
            if (type === 'choice') {
                for (const item of options) {
                    const option = h(doc, 'option', '', item.label);
                    option.value = String(item.value ?? '');
                    input.appendChild(option);
                }
            } else {
                input.setAttribute('type', type);
                if (type === 'number') {
                    input.setAttribute('step', '1');
                    if (Number.isFinite(Number(spec.min))) input.setAttribute('min', String(spec.min));
                    if (Number.isFinite(Number(spec.max))) input.setAttribute('max', String(spec.max));
                } else if (type === 'text' && options.length) {
                    const suggestions = h(doc, 'datalist', 'ss-w-editable-options');
                    const id = `ss-editable-options-${++nextOptions}`;
                    suggestions.setAttribute('id', id);
                    input.setAttribute('list', id);
                    for (const item of options) suggestions.appendChild(Object.assign(h(doc, 'option'), { value: String(item.value ?? '') }));
                    node.appendChild(suggestions);
                }
            }
            input.value = String(spec.value ?? '');
            return { spec, input, node, type, label, options };
        }
        // Without groups the boxes are the record grid; with them, a fieldset each (a legend and the boxes, side by side where they share a row).
        function layFields(list) {
            if (!list.some(entry => typeof entry.spec.group === 'string' && entry.spec.group)) {
                fieldSlot.classList.add('ss-w-editable-record-fields');
                fieldSlot.replaceChildren(...list.map(entry => entry.node));
                return false;
            }
            const groups = new Map();
            for (const entry of list) {
                const name = typeof entry.spec.group === 'string' ? entry.spec.group : '';
                let group = groups.get(name);
                if (!group) {
                    group = { node: h(doc, 'fieldset', 'ss-w-editable-group'), row: null, rowName: '' };
                    if (name) group.node.appendChild(h(doc, 'legend', 'ss-w-editable-legend', name));
                    groups.set(name, group);
                }
                const rowName = typeof entry.spec.row === 'string' ? entry.spec.row : '';
                if (!rowName) { group.row = null; group.rowName = ''; group.node.appendChild(entry.node); continue; }
                if (!group.row || group.rowName !== rowName) {
                    group.row = h(doc, 'span', 'ss-w-editable-row');
                    group.rowName = rowName;
                    group.node.appendChild(group.row);
                }
                group.row.appendChild(entry.node);
            }
            fieldSlot.classList.add('ss-w-editable-groups');
            fieldSlot.replaceChildren(...[...groups.values()].map(group => group.node));
            return true;
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
                focusNode(field);
                return;
            }
            fieldSlot.classList.remove('ss-w-editable-item-fields', 'ss-w-editable-record-fields');
            form.classList.remove('ss-w-editable-item-form');
            if (p.kind === 'fields') {
                inputs = p.fields.filter(spec => spec && typeof spec === 'object' && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(spec.key))).map(fieldEntry);
                field = inputs[0]?.input ?? null;
                if (layFields(inputs)) {
                    helpLine.textContent = p.help;
                    helpLine.hidden = !p.help;
                    actions.replaceChildren(save, cancel);
                    form.replaceChildren(fieldSlot, helpLine, error, actions);
                    form.classList.add('ss-w-editable-grouped');
                    form.setAttribute('role', 'group');
                    if (p.label) form.setAttribute('aria-label', p.label);
                }
                chips.hidden = true;
                add.hidden = true;
                form.classList.add('ss-w-editable-item-form');
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
        // What the boxes of a `fields` form say: `changed` (the keys that differ from what the form opened with, as their values) and `all`
        // (every key); or `{ error, input }` naming the box that cannot be read, with nothing saved.
        function readFields() {
            const changed = {};
            const all = {};
            const named = inputs.some(entry => typeof entry.spec.group === 'string' && entry.spec.group);
            for (const entry of inputs) {
                const { spec, input, type, label } = entry;
                const raw = String(input.value).trim();
                const key = String(spec.key);
                let next;
                let was;
                if (type === 'number') {
                    const blankWas = spec.value === '' || spec.value === null || spec.value === undefined;
                    const wholeNumber = named ? fill(E.fieldWholeNumber, { label }) : E.wholeNumber;
                    if (raw === '') {
                        if (!blankWas) return { error: wholeNumber, input };
                        next = null;
                        was = null;
                    } else {
                        if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return { error: wholeNumber, input };
                        next = Number(raw);
                        if (!spec.soft) {
                            if (Number.isFinite(Number(spec.min))) next = Math.max(Number(spec.min), next);
                            if (Number.isFinite(Number(spec.max))) next = Math.min(Number(spec.max), next);
                        }
                        was = blankWas ? null : Number(spec.value);
                    }
                } else if (type === 'choice') {
                    const chosen = entry.options.find(item => String(item.value ?? '') === input.value);
                    next = chosen ? chosen.value : input.value;
                    was = spec.value ?? '';
                    if (String(next ?? '') === String(was ?? '')) was = next;
                } else if (type === 'time') {
                    next = raw;
                    was = String(spec.value ?? '').trim();
                } else {
                    next = cut(raw, Number.isFinite(Number(spec.maxLength)) ? Number(spec.maxLength) : p.maxLength);
                    was = cut(spec.value, 1e6);
                }
                all[key] = next;
                if (next !== was) changed[key] = next;
            }
            return { changed, all };
        }

        // The form's `plan`: the steps run one after the other; a refusal stops the rest and leaves the form open with its sentence. A step that
        // went through is not sent again by the next Save: its boxes now count as what the form opened with.
        async function runPlan({ changed, all }) {
            if (!Object.keys(changed).length) { close(); return; }
            let outcome;
            try { outcome = p.plan(changed, all); } catch (failure) { outcome = { error: String(failure?.message ?? failure) }; }
            if (outcome?.error) { error.textContent = String(outcome.error); return; }
            const steps = Array.isArray(outcome?.steps) ? outcome.steps : [];
            if (!steps.length) { close(); return; }
            busy = true;
            save.disabled = true;
            for (const step of steps) {
                let result;
                try { result = await api.command(String(step.command), step.payload && typeof step.payload === 'object' ? step.payload : {}); }
                catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
                if (!alive) return;
                if (!result?.ok) {
                    busy = false;
                    save.disabled = false;
                    error.textContent = refusalText(result, E.failed);
                    return;
                }
                for (const entry of inputs) if (Array.isArray(step.keys) && step.keys.includes(String(entry.spec.key))) entry.spec = { ...entry.spec, value: all[String(entry.spec.key)] ?? '' };
            }
            busy = false;
            save.disabled = false;
            close();
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
            } else if (p.kind === 'fields') {
                const read = readFields();
                if (read.error) { error.textContent = read.error; focusNode(read.input); return; }
                if (typeof p.plan === 'function') { await runPlan(read); return; }
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
        return { update, destroy() { alive = false; } };
    });
}

export const editable = defineWidget({ props, primary: 'value', render });
