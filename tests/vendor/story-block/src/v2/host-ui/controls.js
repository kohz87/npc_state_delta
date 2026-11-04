// Story Suite v2: the settings host's field controls (moved out of host-ui.js unchanged; host-ui.js re-exports the public ones).
// Builds the DOM for one settings field (bool, int, choice, text, a list of {…} as lines or as items), reads a value back,
// and groups a module's fields. Every node is built with textContent; `doc` is the document to build in.

import { normalizeField, FIELD_TYPES } from '../registry.js';
import { SETTING_LIST_ROWS } from '../sdk.js';
import { fill } from '../strings.js';
import { cutAt } from '../../text.js';
import { profileSelect, profileNote } from '../profile-field.js';
import { SETTINGS_TEXT } from './text.js';

export function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

export function button(doc, className, text, title = '') {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    return node;
}

export const humanize = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
const optionsOf = field => (field.options ?? []).map(option => (option && typeof option === 'object' ? { value: String(option.value), label: String(option.label ?? option.value) } : { value: String(option), label: String(option) }));

/** The value a field starts from when it has no default. */
export function emptyValue(field) {
    const f = normalizeField(field);
    if (f.type === 'bool') return false;
    if (f.type === 'int') return Number.isInteger(f.min) ? f.min : 0;
    if (f.type === 'choice') return optionsOf(f)[0]?.value ?? '';
    if (f.type === 'list') return [];
    return '';
}

/** A whole number from what was typed, kept inside min/max; null when it is not one. */
export function readInt(text, field) {
    const value = Number(String(text).trim());
    if (!String(text).trim() || !Number.isFinite(value)) return null;
    let out = Math.round(value);
    if (Number.isInteger(field.min)) out = Math.max(field.min, out);
    if (Number.isInteger(field.max)) out = Math.min(field.max, out);
    return out;
}

// One control for one field; `onChange(value)` gets the new value.
function control(doc, field, value, onChange, id, memo = null) {
    const f = normalizeField(field);
    if (f.type === 'bool') {
        const input = el(doc, 'input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
        input.addEventListener('change', () => onChange(Boolean(input.checked)));
        return input;
    }
    if (f.type === 'choice') {
        const select = el(doc, 'select', 'text_pole');
        for (const option of optionsOf(f)) {
            const node = el(doc, 'option', '', option.label);
            node.value = option.value;
            select.appendChild(node);
        }
        select.value = String(value ?? '');
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }
    // A Connection Manager profile's name, or '' for the chat's connection (profile-field.js).
    if (f.type === 'profile') return profileSelect(doc, value, onChange);
    if (f.type === 'int') {
        const input = el(doc, 'input', 'text_pole');
        input.type = 'number';
        if (Number.isInteger(f.min)) input.min = String(f.min);
        if (Number.isInteger(f.max)) input.max = String(f.max);
        input.step = '1';
        input.inputMode = 'numeric';
        input.value = String(value ?? '');
        input.addEventListener('change', () => {
            const next = readInt(input.value, f);
            // Not a number: the stored value stays, and is shown again.
            if (next === null) { input.value = String(value ?? ''); return; }
            input.value = String(next);
            value = next;
            onChange(next);
        });
        return input;
    }
    if (f.type === 'list') return listControl(doc, f, Array.isArray(value) ? value : [], onChange, id, memo);
    const input = el(doc, f.multiline ? 'textarea' : 'input', 'text_pole');
    if (!f.multiline) input.type = 'text';
    // A text field's `max` holds for typing and pasting alike (settings.set cuts it there too).
    const max = Number.isInteger(f.max) && f.max >= 0 ? f.max : null;
    if (max !== null) input.maxLength = max;
    input.value = String(value ?? '');
    input.addEventListener('change', () => {
        if (max !== null && input.value.length > max) input.value = cutAt(input.value, max);
        onChange(input.value);
    });
    return input;
}

// What an item of a list is called on its Remove button: its first text field ("January"), else its place.
function itemName(item, subs, index) {
    for (const [key, sub] of subs) {
        const value = item?.[key];
        if (sub.type === 'text' && typeof value === 'string' && value.trim()) return cutAt(value.trim().replace(/\s+/g, ' '), 40);
    }
    return fill(SETTINGS_TEXT.listItem, { n: index + 1 });
}

const subLabel = (key, sub) => sub.label ?? humanize(key);

/**
 * A list field's sub-fields when it has a text form ([[key, field]], in order), else null: every field
 * of its `of` is text or a whole number (a list holding a switch or a choice has rows only).
 */
export function listTextFields(field) {
    const f = normalizeField(field);
    if (f?.type !== 'list' || !f.of || typeof f.of !== 'object') return null;
    const subs = Object.entries(f.of).map(([key, sub]) => [key, normalizeField(sub)]);
    return subs.length && subs.every(([, sub]) => sub?.type === 'text' || sub?.type === 'int') ? subs : null;
}

// "Name: Days": how one line of a list's text form is written.
const lineForm = subs => subs.map(([key, sub]) => subLabel(key, sub)).join(': ');

/** A list's items as its text form: one per line, the fields in order joined by ": " ("Frostmoon: 30"). */
export function listToLines(field, items) {
    const subs = listTextFields(field) ?? [];
    return (Array.isArray(items) ? items : []).map(item => subs.map(([key, sub]) => {
        const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
        return String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    }).join(': ')).join('\n');
}

/**
 * The text form read back: → { ok: true, items } or { ok: false, line (1-based), text, error } for the
 * first line that does not read. Blank lines are skipped. A line holds the fields in order split by ":";
 * when there are more parts than fields and the list has one text field, the extra colons are that
 * field's ("Day: of Ash: 30" → name "Day: of Ash"). A whole number must be one and inside its min/max
 * (refused, not moved: "Days must be at least 1"). At most SETTING_LIST_ROWS items; any number below.
 */
export function linesToList(field, text) {
    const subs = listTextFields(field);
    if (!subs) return { ok: false, line: 0, text: '', error: 'this list has no text form' };
    const form = lineForm(subs);
    const texts = subs.map(([, sub], at) => (sub.type === 'text' ? at : -1)).filter(at => at >= 0);
    const items = [];
    const lines = String(text ?? '').split(/\r\n|\r|\n/);
    for (let at = 0; at < lines.length; at += 1) {
        const line = lines[at].trim();
        if (!line) continue;
        const fail = error => ({ ok: false, line: at + 1, text: line, error });
        if (items.length >= SETTING_LIST_ROWS) return fail(fill(SETTINGS_TEXT.lineCount, { max: SETTING_LIST_ROWS }));
        let parts = line.split(':');
        if (parts.length < subs.length) return fail(fill(SETTINGS_TEXT.lineParts, { form }));
        if (parts.length > subs.length) {
            if (texts.length !== 1) return fail(fill(SETTINGS_TEXT.lineExtra, { n: subs.length }));
            const t = texts[0];
            const after = subs.length - t - 1;
            parts = [...parts.slice(0, t), parts.slice(t, parts.length - after).join(':'), ...parts.slice(parts.length - after)];
        }
        const item = {};
        for (let i = 0; i < subs.length; i += 1) {
            const [key, sub] = subs[i];
            const part = parts[i].trim();
            if (sub.type === 'int') {
                const name = subLabel(key, sub);
                if (!/^[+-]?\d+$/.test(part)) return fail(fill(SETTINGS_TEXT.lineWhole, { field: name }));
                const n = Number(part);
                if (Number.isInteger(sub.min) && n < sub.min) return fail(fill(SETTINGS_TEXT.lineMin, { field: name, min: sub.min }));
                if (Number.isInteger(sub.max) && n > sub.max) return fail(fill(SETTINGS_TEXT.lineMax, { field: name, max: sub.max }));
                item[key] = n;
            } else {
                const max = Number.isInteger(sub.max) && sub.max >= 0 ? sub.max : null;
                item[key] = max !== null && part.length > max ? cutAt(part, max) : part;
            }
        }
        items.push(item);
    }
    return { ok: true, items };
}

// A list of {…}, compact: one line per item with its fields side by side (`[January ] [31] ×`), each
// input named by its field for screen readers (the column heads above say it for the eye), a small
// × to remove the item, and Add at the end. A sub-field of a type this Story Block does not know is
// not drawn; its value stays in the item.
// A list of text and whole-number fields also has a text form: a textarea, one item per line
// ("Frostmoon: 30"), read when it changes (on blur); a line that does not read is named under it and
// the stored list stays as it was. `form: 'lines'` starts in it; "Edit as text" / "Edit as rows" switch,
// and the choice is kept in `memo` (the settings' open state) across redraws.
function listControl(doc, field, items, onChange, id, memo = null) {
    const root = el(doc, 'div', 'story-suite-list');
    root.setAttribute('role', 'group');
    let list = structuredClone(items);
    const subs = Object.entries(field.of ?? {})
        .map(([key, sub]) => [key, normalizeField(sub)])
        .filter(([, sub]) => FIELD_TYPES.includes(sub?.type) && sub.type !== 'list');
    const labelOf = subLabel;
    const textFields = listTextFields(field);
    const formKey = `list-form:${id}`;
    let asText = textFields !== null && (memo?.has(formKey) ? memo.get(formKey) === true : field.form === 'lines');
    const fieldName = field.label ?? SETTINGS_TEXT.add;
    function toggleButton() {
        const toggle = button(doc, 'menu_button story-suite-list-toggle', '', fill(asText ? SETTINGS_TEXT.asRowsTitle : SETTINGS_TEXT.asTextTitle, { field: fieldName }));
        toggle.appendChild(el(doc, 'span', '', asText ? SETTINGS_TEXT.asRows : SETTINGS_TEXT.asText));
        toggle.setAttribute('aria-pressed', String(asText));
        return toggle;
    }
    function switchForm(next) {
        asText = next;
        memo?.set(formKey, asText);
        draw();
        root.querySelector('.story-suite-list-toggle')?.focus?.();
    }
    function drawText() {
        const area = el(doc, 'textarea', 'text_pole story-suite-list-text');
        area.id = `${id}-text`;
        area.rows = Math.max(4, Math.min(list.length + 1, 16));
        area.spellcheck = false;
        area.value = listToLines(field, list);
        area.setAttribute('aria-labelledby', `${id}-label`);
        const help = el(doc, 'small', 'story-suite-muted story-suite-list-help', fill(SETTINGS_TEXT.linesHelp, { form: lineForm(textFields), max: SETTING_LIST_ROWS }));
        help.id = `${id}-help`;
        const error = el(doc, 'p', 'story-suite-list-error');
        error.id = `${id}-error`;
        error.setAttribute('role', 'alert');
        error.hidden = true;
        area.setAttribute('aria-describedby', help.id);
        // Reads the text; true when it read (stored, written back tidy), false with the bad line named.
        const read = () => {
            const result = linesToList(field, area.value);
            if (!result.ok) {
                error.textContent = fill(SETTINGS_TEXT.lineError, { n: result.line, line: cutAt(result.text, 40), why: result.error });
                error.hidden = false;
                area.setAttribute('aria-invalid', 'true');
                area.setAttribute('aria-describedby', `${help.id} ${error.id}`);
                return false;
            }
            error.textContent = '';
            error.hidden = true;
            area.removeAttribute('aria-invalid');
            area.setAttribute('aria-describedby', help.id);
            list = result.items;
            area.value = listToLines(field, list);
            onChange(structuredClone(list));
            return true;
        };
        area.addEventListener('change', read);
        const foot = el(doc, 'div', 'story-suite-list-foot');
        const toggle = toggleButton();
        // Back to rows only when the text reads (else the error says which line, and the text stays).
        toggle.addEventListener('click', () => { if (read()) switchForm(false); else area.focus?.(); });
        foot.appendChild(toggle);
        root.append(area, help, error, foot);
    }
    const draw = (focusAt = null) => {
        root.replaceChildren();
        root.dataset.form = asText ? 'lines' : 'rows';
        if (asText) { drawText(); return; }
        if (list.length && subs.length) {
            const head = el(doc, 'div', 'story-suite-list-head');
            head.setAttribute('aria-hidden', 'true');
            for (const [key, sub] of subs) {
                const cell = el(doc, 'span', 'story-suite-list-cell', labelOf(key, sub));
                cell.dataset.type = sub.type;
                head.appendChild(cell);
            }
            head.appendChild(el(doc, 'span', 'story-suite-list-spacer'));
            root.appendChild(head);
        }
        const removes = [];
        list.forEach((item, index) => {
            const row = el(doc, 'div', 'story-suite-list-item');
            row.dataset.index = String(index);
            for (const [key, sub] of subs) {
                const cell = el(doc, 'span', 'story-suite-list-cell');
                cell.dataset.field = key;
                cell.dataset.type = sub.type;
                const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
                const inputId = `${id}-${index}-${key}`.replace(/[^\w-]/g, '_');
                const input = control(doc, sub, value, next => {
                    list[index] = { ...list[index], [key]: next };
                    onChange(structuredClone(list));
                }, inputId);
                input.id = inputId;
                input.setAttribute('aria-label', `${labelOf(key, sub)}, ${fill(SETTINGS_TEXT.listItem, { n: index + 1 })}`);
                if (sub.type === 'text' || sub.type === 'int') input.placeholder = labelOf(key, sub);
                cell.appendChild(input);
                row.appendChild(cell);
            }
            const name = fill(SETTINGS_TEXT.remove, { name: itemName(item, subs, index) });
            const remove = button(doc, 'menu_button story-suite-list-remove', '', name);
            remove.appendChild(el(doc, 'span', '', '×')).setAttribute('aria-hidden', 'true');
            remove.addEventListener('click', () => {
                list = list.filter((_, at) => at !== index);
                onChange(structuredClone(list));
                // The focus goes to the next item's ×, else to Add, never to the page behind.
                draw(Math.min(index, list.length - 1));
            });
            removes.push(remove);
            row.appendChild(remove);
            root.appendChild(row);
        });
        const add = button(doc, 'menu_button story-suite-list-add', '', field.label ? fill(SETTINGS_TEXT.addTitle, { field: field.label }) : SETTINGS_TEXT.add);
        add.appendChild(el(doc, 'span', '', SETTINGS_TEXT.add));
        add.addEventListener('click', () => {
            list = [...list, Object.fromEntries(subs.map(([key, sub]) => [key, emptyValue(sub)]))];
            onChange(structuredClone(list));
            draw();
            [...root.querySelectorAll('.story-suite-list-item')].at(-1)?.querySelector('input, select, textarea')?.focus?.();
        });
        if (textFields) {
            const foot = el(doc, 'div', 'story-suite-list-foot');
            const toggle = toggleButton();
            toggle.addEventListener('click', () => switchForm(true));
            foot.append(add, toggle);
            root.appendChild(foot);
        } else root.appendChild(add);
        if (focusAt !== null) (removes[focusAt] ?? add).focus?.();
    };
    draw();
    return root;
}

/**
 * Whether a schema field is read-only now (SPEC §6): its `readOnly` is `true`, or a function of the
 * module's current values (`settings(id)`) that returns true. A function that throws counts as false.
 */
export function fieldReadOnly(field, values) {
    const flag = normalizeField(field)?.readOnly;
    if (typeof flag !== 'function') return flag === true;
    try { return Boolean(flag(values)); } catch { return false; }
}

/**
 * The value a settings row shows: the stored value (else the default, else the field's empty value); a
 * read-only field with `shows(values)` shows what that returns instead, for display only (the stored value
 * is kept, so it is back when the field is editable again). A `shows` that throws or returns undefined
 * shows the stored value.
 */
export function rowValue(key, field, values) {
    const stored = Object.hasOwn(values, key) ? values[key] : emptyValue(field);
    const shows = normalizeField(field)?.shows;
    if (typeof shows !== 'function' || !fieldReadOnly(field, values)) return stored;
    try {
        const value = shows(values);
        return value === undefined ? stored : value;
    } catch {
        return stored;
    }
}

// `label.story-suite-row`: the label and its help on the left, the control on the right (stacked on a
// phone, host.css). A list's row is a `div` whose list group is named by the label. A read-only row
// shows its value and help with every control in it disabled, and stores nothing.
export function fieldRow(doc, key, field, value, onChange, prefix, memo = null, readOnly = false) {
    const f = normalizeField(field);
    // A type this Story Block does not know (a newer module's): hidden, its value left alone.
    if (!FIELD_TYPES.includes(f?.type)) {
        const hidden = el(doc, 'div', 'story-suite-row');
        hidden.dataset.field = key;
        hidden.hidden = true;
        return hidden;
    }
    const id = `${prefix}-${key}`.replace(/[^\w-]/g, '_');
    const row = el(doc, f.type === 'list' ? 'div' : 'label', 'story-suite-row');
    row.dataset.field = key;
    row.dataset.type = f.type;
    if (f.type !== 'list') row.setAttribute('for', id);
    const text = el(doc, 'span', 'story-suite-row-label');
    const name = el(doc, 'b', '', f.label ?? humanize(key));
    name.id = `${id}-label`;
    text.appendChild(name);
    if (f.help) text.appendChild(el(doc, 'small', '', f.help));
    const note = f.type === 'profile' ? profileNote(doc, value) : null;
    if (note) text.appendChild(note);
    row.appendChild(text);
    const input = control(doc, f, value, readOnly ? () => {} : onChange, id, memo);
    (input.focusTarget ?? input).id = id;
    if (f.type === 'list') input.setAttribute('aria-labelledby', name.id);
    row.appendChild(input);
    if (readOnly) {
        row.classList.add('story-suite-row-readonly');
        row.dataset.readonly = 'true';
        for (const node of [input, ...input.querySelectorAll('input, select, textarea, button')]) {
            node.disabled = true;
            node.setAttribute('aria-disabled', 'true');
        }
    }
    return row;
}

// A fold: `details` with its summary (title, then a quiet hint). The chevron is CSS (host.css), so the
// summary's text is only the title and the hint. `className` tells the top folds from the sub-folds.
export function fold(doc, key, title, hint = '', className = 'story-suite-fold') {
    const details = el(doc, 'details', className);
    details.dataset.fold = key;
    const summary = el(doc, 'summary');
    summary.appendChild(el(doc, 'b', '', title));
    if (hint) summary.appendChild(el(doc, 'small', '', hint));
    details.appendChild(summary);
    const body = el(doc, 'div', `${className}-body`);
    details.appendChild(body);
    return { details, body };
}

// "Calendar: Era (written before the year)" → group "Calendar", label "Era (…)". The part before the
// first ": " is a group only when it is short and has no brackets ("Money scale (0: the pack's)" has none).
const LABEL_PREFIX = /^([^:()[\]{}]{1,48}?):\s+(\S[\s\S]*)$/;

/**
 * A schema's fields in settings groups, in the order they first appear: [{ name, fields: [{ key, field }] }].
 * A field's group is its `group` (text), else its label's prefix ("Calendar: Era" → "Calendar", the label
 * then "Era"), else General. A label that starts with its own `group` loses that prefix too.
 */
export function groupFields(schema) {
    const groups = new Map();
    for (const [key, raw] of Object.entries(schema ?? {})) {
        const field = normalizeField(raw);
        const label = typeof field?.label === 'string' ? field.label.trim() : null;
        const match = label ? LABEL_PREFIX.exec(label) : null;
        const given = typeof field?.group === 'string' ? field.group.trim() : '';
        let name = SETTINGS_TEXT.general;
        let shown = label;
        if (given) {
            name = given;
            if (match && match[1].trim().toLowerCase() === given.toLowerCase()) shown = match[2];
        } else if (match) {
            name = match[1].trim();
            shown = match[2];
        }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ key, field: shown === label ? raw : { ...field, label: shown } });
    }
    return [...groups].map(([name, fields]) => ({ name, fields }));
}
