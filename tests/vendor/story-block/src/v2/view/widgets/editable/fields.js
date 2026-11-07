// The editable widget's `fields` form: builds each box, lays grouped fields into rows, keeps live show/points state,
// and reads the boxes back as changed/all values. The returned object keeps the input list mutable so editable.js's
// open, plan and submit paths share the same entries the user sees.
import { h } from '../dom.js';
import { STRINGS, fill } from '../../../strings.js';
import { cut } from './props.js';

const E = STRINGS.editable;

export function createFields(doc, fieldSlot, nextId) {
    let groupList = [];

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
                const id = `ss-editable-options-${nextId()}`;
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

    const fields = { inputs: [] };

    // The live parts of a grouped form: a box with `showWhen` is drawn only while the box it names holds one of its values (a group with nothing drawn goes too),
    // and a `points` line counts the points of the Bonus boxes against what the rarity allows.
    const valueOf = key => fields.inputs.find(entry => entry.input && String(entry.spec.key) === key)?.input?.value ?? '';
    function refresh() {
        for (const entry of fields.inputs) {
            const when = entry.spec.showWhen;
            entry.hidden = Boolean(when && typeof when === 'object' && !(Array.isArray(when.in) ? when.in : []).includes(valueOf(String(when.key))));
            entry.node.hidden = entry.hidden;
        }
        for (const group of groupList) group.node.hidden = group.entries.every(entry => entry.hidden);
        for (const entry of fields.inputs) {
            if (!entry.tone || !entry.input) continue;
            const value = String(entry.input.value);
            entry.tone.setAttribute('data-word', entry.options.find(item => String(item.value) === value)?.label ?? '');
            entry.tone.setAttribute('data-tone', value);
        }
        for (const entry of fields.inputs) {
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

    // What the boxes of a `fields` form say: `changed` (the keys that differ from what the form opened with, as their values) and `all`
    // (every key); or `{ error, input }` naming the box that cannot be read, with nothing saved.
    function readFields(p) {
        const changed = {};
        const all = {};
        const named = fields.inputs.some(entry => typeof entry.spec.group === 'string' && entry.spec.group);
        for (const entry of fields.inputs) {
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

    return Object.assign(fields, { fieldEntry, layFields, refresh, readFields });
}
