// An inline reader edit. The value is displayed as text; saving sends one ordinary UI command.
import { oneLine } from '../../../text.js';
import { formatAmount, parseMixedAmount } from '../../domains/money.js';
import { STRINGS, fill, refusalText } from '../../strings.js';
import { h, iconNode, shell } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { meterRatio } from './meter.js';
import { focusNode } from '../scroll.js';
import { editFields, editPlan } from '../gear-form.js';

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
    // kind 'item' while Gear in fights is on, for a piece of equipment: `{ kind: 'equipment', stack, owner, by, place, slot, owners: [{ value, label }] }` adds the two choices
    // Slot (the eight places, or none) and Equipped by (a member, or none); a changed choice goes through inventory.transfer / item.equip / inventory.unequip.
    gear: { type: 'object', default: Object.freeze({}) },
    // kind 'fields': one input per entry, `{ key, label, type: 'text' | 'number' | 'choice' | 'time', value, min?, max?, maxLength?, options?, soft?, group?, row? }`;
    // only the changed ones go in the payload. `choice` is a select over `options` (strings or `{ value, label }`); `time` is a time of day ("13:30", '' for none);
    // a `text` field with `options` suggests them. A field may also carry `disabled` (read-only, dimmed; `title` says why) and `showWhen: { key, in: [values] }` (drawn only while
    // that box holds one of them; a hidden box is not read). Two more kinds of entry have no box: `note` (`text`, a muted line) and `points` (a live line: `rarity` the box that
    // names the rarity, `lines` the [stat box, points box] pairs, `budget` the points a rarity allows, `words`, `text` with {n} {max} {a} {rarity}, `none` for a budget of 0).
    // `soft` keeps `min`/`max` as hints on the box and clamps nothing. A `group` is a heading the fields under it sit
    // beneath (one fieldset per group, in order of first use); fields with the same `row` sit side by side. A blank number that was blank stays unchanged.
    fields: { type: 'array', default: Object.freeze([]) },
    // A form with groups: `help` is the line under the fields; `plan(changed, all)` (instead of `command`) answers `{ error }` or `{ steps: [{ command, payload, keys }] }`,
    // and the steps run in order through the widget api, the first refusal stopping the rest with its sentence under the fields; `bare` leaves out the pencil
    // and the shown value (the caller opens the form with `open` and hears of its closing in `onClose`).
    help: { type: 'string', default: '' },
    plan: { type: 'any', default: null },
    bare: { type: 'boolean', default: false },
    // A line above the fields of a grouped form (muted), and `always`: run the plan on Save even when no box changed (a form that adds something new).
    intro: { type: 'string', default: '' },
    always: { type: 'boolean', default: false },
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
        const introLine = h(doc, 'span', 'ss-w-editable-help ss-w-editable-intro');
        const actions = h(doc, 'span', 'ss-w-editable-actions');
        const plain = () => form.replaceChildren(chips, fieldSlot, add, save, cancel, error);
        plain();
        root.append(shown, pencil);
        let p = resolveProps(props, input);
        let field = null;
        let itemCount = null;
        let itemNote = null;
        let slotSelect = null;
        let bySelect = null;
        let inputs = [];
        let groupList = [];
        let entries = [];
        let editing = false;
        let busy = false;
        let alive = true;
        // The grouped form being edited: its fields and plan (the props' own, or, for a piece the reader added by hand with Gear in fights on, the gear form's).
        let formFields = null;
        let formPlan = null;

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
            if (spec.type === 'note' || spec.type === 'points') {
                const line = h(doc, 'p', spec.type === 'note' ? 'ss-w-editable-item-hint ss-w-editable-note' : 'ss-w-editable-points');
                if (spec.type === 'note') line.textContent = String(spec.text ?? '');
                else line.setAttribute('role', 'status');
                return { spec, input: null, node: line, type: spec.type, label: '', options: [] };
            }
            const type = ['number', 'choice', 'time'].includes(spec.type) ? spec.type : 'text';
            const label = String(spec.label ?? spec.key);
            const options = optionList(spec.options);
            const input = h(doc, type === 'choice' ? 'select' : 'input', type === 'choice' ? 'ss-select' : 'ss-input');
            input.setAttribute('aria-label', label);
            const node = h(doc, 'label', 'ss-w-editable-item-label');
            const caption = h(doc, 'span', spec.hideLabel === true ? 'ss-w-editable-sr' : '', label);
            node.append(caption, input);
            // `tone`: the chosen option's word follows the label in its colour (the rarity word), kept current by refresh().
            const tone = spec.tone === true ? caption : null;
            if (tone) tone.classList.add('ss-w-editable-tone');
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
            if (spec.disabled === true) {
                input.disabled = true;
                if (spec.title) input.setAttribute('title', String(spec.title));
            }
            return { spec, input, node, type, label, options, tone };
        }
        // Without groups the boxes are the record grid; with them, a fieldset each (a legend and the boxes, side by side where they share a row).
        function layFields(list) {
            if (!list.some(entry => typeof entry.spec.group === 'string' && entry.spec.group)) {
                fieldSlot.classList.add('ss-w-editable-record-fields');
                fieldSlot.replaceChildren(...list.map(entry => entry.node));
                return false;
            }
            const groups = new Map();
            groupList = [];
            for (const entry of list) {
                const name = typeof entry.spec.group === 'string' ? entry.spec.group : '';
                let group = groups.get(name);
                if (!group) {
                    group = { node: h(doc, 'fieldset', 'ss-w-editable-group'), row: null, rowName: '' };
                    if (name) group.node.appendChild(h(doc, 'legend', 'ss-w-editable-legend', name));
                    group.entries = [];
                    groups.set(name, group);
                    groupList.push(group);
                }
                group.entries.push(entry);
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

        // The live parts of a grouped form: a box with `showWhen` is drawn only while the box it names holds one of its values (a group with nothing drawn goes too),
        // and a `points` line counts the points of the Bonus boxes against what the rarity allows.
        const valueOf = key => inputs.find(entry => entry.input && String(entry.spec.key) === key)?.input?.value ?? '';
        function refresh() {
            for (const entry of inputs) {
                const when = entry.spec.showWhen;
                entry.hidden = Boolean(when && typeof when === 'object' && !(Array.isArray(when.in) ? when.in : []).includes(valueOf(String(when.key))));
                entry.node.hidden = entry.hidden;
            }
            for (const group of groupList) group.node.hidden = group.entries.every(entry => entry.hidden);
            for (const entry of inputs) {
                if (!entry.tone || !entry.input) continue;
                const value = String(entry.input.value);
                entry.tone.setAttribute('data-word', entry.options.find(item => String(item.value) === value)?.label ?? '');
                entry.tone.setAttribute('data-tone', value);
            }
            for (const entry of inputs) {
                if (entry.type !== 'points' || entry.hidden) continue;
                const spec = entry.spec;
                const rarity = valueOf(String(spec.rarity));
                const max = Number(spec.budget?.[rarity] ?? 0);
                let total = 0;
                for (const [stat, points] of Array.isArray(spec.lines) ? spec.lines : []) {
                    const n = Number(valueOf(String(points)));
                    if (valueOf(String(stat)) && Number.isFinite(n) && n > 0) total += n;
                }
                const word = String(spec.words?.[rarity] ?? rarity).toLowerCase();
                const text = total === 0 && max === 0 ? String(spec.none ?? '') : fill(String(spec.text ?? ''), { n: total, max, a: /^[aeiou]/i.test(word) ? 'an' : 'a', rarity: word });
                entry.node.textContent = text;
                entry.node.classList.toggle('ss-w-editable-over', total > max);
            }
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
                    bySelect = choice(G.editBy, (Array.isArray(p.gear.owners) ? p.gear.owners : []).map(entry => [String(entry?.value ?? ''), String(entry?.label ?? '')]), String(p.gear.by ?? ''));
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
                inputs = formFields.filter(spec => spec && typeof spec === 'object' && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(spec.key))).map(fieldEntry);
                field = inputs.find(entry => entry.input && !entry.input.disabled)?.input ?? null;
                if (layFields(inputs)) {
                    helpLine.textContent = p.help;
                    helpLine.hidden = !p.help;
                    introLine.hidden = !introLine.textContent;
                    actions.replaceChildren(save, cancel);
                    form.replaceChildren(...(introLine.textContent ? [introLine] : []), fieldSlot, helpLine, error, actions);
                    form.classList.add('ss-w-editable-grouped');
                    form.classList.toggle('ss-w-editable-gear', inputs.some(entry => entry.spec.showWhen));
                    form.setAttribute('role', 'group');
                    if (p.label) form.setAttribute('aria-label', p.label);
                }
                chips.hidden = true;
                add.hidden = true;
                form.classList.add('ss-w-editable-item-form');
                refresh();
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
                if (!input || entry.hidden) continue;
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
            if (!Object.keys(changed).length && !p.always) { close(); return; }
            let outcome;
            try { outcome = formPlan(changed, all); } catch (failure) { outcome = { error: String(failure?.message ?? failure) }; }
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

        // The steps an item's Slot and Equipped by choices need: taken off, or handed to the wearer and put on. [] when nothing changed.
        function wearSteps() {
            if (!slotSelect || !bySelect || slotSelect.disabled) return []; // (a bound piece: the choices are locked)
            const stack = p.payload?.stack;
            const by = bySelect.value, slot = slotSelect.value;
            const placed = String(p.gear.place ?? ''), wearer = String(p.gear.by ?? '');
            if (by === '' || slot === '') return placed ? [{ command: 'inventory.unequip', payload: { stack } }] : [];
            if (placed === slot && wearer === by) return [];
            // (one command, so a refusal of the slot leaves the item with its owner: all or nothing)
            return [{ command: 'item.equip', payload: { stack, owner: by, slot, ...(by !== p.gear.owner ? { transfer: true } : {}) } }];
        }

        // Commands one after the other: a refusal stops the rest and leaves the form open with its sentence.
        async function runSteps(steps) {
            busy = true;
            save.disabled = true;
            for (const step of steps) {
                let result;
                try { result = await api.command(step.command, step.payload); }
                catch (failure) { result = { ok: false, message: String(failure?.message ?? failure) }; }
                if (!alive) return;
                if (!result?.ok) {
                    busy = false;
                    save.disabled = false;
                    error.textContent = refusalText(result, E.failed);
                    return;
                }
            }
            busy = false;
            save.disabled = false;
            close();
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
                if (!edited && !worn.length) { close(); return; }
                if (worn.length) { await runSteps([...(edited ? [{ command: p.command, payload }] : []), ...worn]); return; }
            } else if (formFields) {
                const read = readFields();
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
        listen(form, 'input', () => { if (formFields) refresh(); });
        listen(form, 'change', () => { if (formFields) refresh(); });
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
