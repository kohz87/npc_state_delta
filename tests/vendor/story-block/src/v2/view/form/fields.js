// The form engine's field renderers (UI stage 1b, PR B): one control per kind, in Story Suite's look (glass.css,
// the `ss-switch`, `ss-input`, `ss-select`, `ss-slider`, `ss-chips`, `ss-lines`, `ss-search` classes).
//
//   switch (bool), text, number (int), slider (int with form: 'slider'), select (choice), chips (choice with
//   form: 'chips', or several at once with `multiple`), segmented (choice with form: 'segmented': one joined row of buttons), profile (a Connection Manager profile), lines (a list of
//   records: rows with Add and Remove, or one line per item), plus the search box and a grouped section.
//
// Every renderer is `(ctx) → handle` with
//   ctx     { doc, id, key, field, value, onChange(value, meta), invalid(text), note(text), labelledBy, ariaLabel,
//             disabled, readOnly, memo, profiles }
//   handle  { el, input, get(), set(value), setDisabled(on), setReadOnly(on), destroy() }
// `el` is what goes into the row; `input` is the element that takes the label and the description (aria-
// labelledby / aria-describedby / aria-invalid). `onChange` is called with the new value when the reader has made
// a choice (a click, a change on blur or Enter, the end of a slider drag), never while typing. `meta.typed` is what
// the reader asked for when the control moved it (a number moved into its range). The renderer never stores
// anything: the form (form.js) writes through the settings store and answers with `set(stored)`.
//
// Keyboard and screen readers: a switch is a button with role=switch and aria-checked (Space or Enter); one-of chips
// are a radio group with arrow keys; several-of chips are toggle buttons (aria-pressed); a slider is a native
// range with aria-valuetext; every control is named by its label, described by its help, and says aria-invalid
// with its message (role=alert) when it refuses a value. Built with createElement and textContent only: labels,
// help and option names come from module settings, never from markup.

import {
    FIELD_KINDS, FORM_TEXT, SETTINGS_TEXT, SETTING_LIST_ROWS, changeNote, emptyValue, fieldKind, fill, linesToList, listTextFields, listToLines, normalizeField, optionsOf, readInt,
} from './schema.js';
import { profileChoices } from '../../profile-field.js';
import { cutAt } from '../../../text.js';

function h(doc, tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}
const button = (doc, className, label) => {
    const node = h(doc, 'button', className);
    node.setAttribute('type', 'button');
    if (label) node.setAttribute('aria-label', label);
    return node;
};
let serial = 0;
/** A fresh id for a control or a message ("ss-f3-budget"): ids are unique per page, not per form. */
export const newId = hint => `ss-f${(serial += 1)}-${String(hint ?? 'x').replace(/[^\w-]/g, '_')}`;

// What every control takes from its ctx: the name, the disabled and read-only states.
function named(node, ctx) {
    if (ctx.labelledBy) node.setAttribute('aria-labelledby', ctx.labelledBy);
    else if (ctx.ariaLabel) node.setAttribute('aria-label', ctx.ariaLabel);
}
function setDisabled(node, on) {
    node.disabled = Boolean(on);
    if (on) node.setAttribute('aria-disabled', 'true');
    else node.removeAttribute('aria-disabled');
}

// ---- switch ----------------------------------------------------------------------------------------

export function switchField(ctx) {
    const { doc } = ctx;
    const root = button(doc, 'ss-switch');
    root.setAttribute('role', 'switch');
    root.appendChild(h(doc, 'span', 'ss-switch-knob'));
    named(root, ctx);
    let on = Boolean(ctx.value);
    let locked = false;
    let off = false;
    const paint = () => {
        root.setAttribute('aria-checked', String(on));
        root.classList.toggle('ss-switch-on', on);
    };
    paint();
    root.addEventListener('click', () => {
        if (root.disabled || locked) return;
        on = !on;
        paint();
        ctx.onChange(on);
    });
    const handle = {
        el: root, input: root,
        get: () => on,
        set(value) { on = Boolean(value); paint(); },
        setDisabled(value) { off = Boolean(value); setDisabled(root, off || locked); },
        setReadOnly(value) { locked = Boolean(value); setDisabled(root, locked || off); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- text and number -------------------------------------------------------------------------------

export function textField(ctx) {
    const { doc, field } = ctx;
    const multiline = field.multiline === true;
    const input = h(doc, multiline ? 'textarea' : 'input', 'ss-input ss-text');
    if (!multiline) input.type = 'text';
    else input.rows = Math.max(3, Math.min(8, Number(field.rows) || 4));
    const max = Number.isInteger(field.max) && field.max >= 0 ? field.max : null;
    if (max !== null && field.codepoints !== true) input.maxLength = max;
    named(input, ctx);
    input.value = String(ctx.value ?? '');
    const root = h(doc, 'div', 'ss-control');
    root.appendChild(input);
    let counter = null;
    if (multiline && max !== null) {
        counter = h(doc, 'small', 'ss-field-count');
        counter.setAttribute('aria-live', 'off');
        root.appendChild(counter);
    }
    const count = () => { if (counter) counter.textContent = fill(FORM_TEXT.count, { n: Array.from(input.value).length, max }); };
    count();
    input.addEventListener('input', () => {
        if (max !== null && field.codepoints === true) input.value = [...input.value].slice(0, max).join('');
        count();
    });
    input.addEventListener('change', () => {
        // A paste past the maximum is cut (the store cuts there too).
        const asked = input.value;
        let value = asked;
        if (max !== null && (field.codepoints === true ? [...value].length : value.length) > max) {
            value = field.codepoints === true ? [...value].slice(0, max).join('') : cutAt(value, max);
            input.value = value;
        }
        count();
        ctx.onChange(value, { typed: asked });
    });
    const handle = {
        el: root, input,
        get: () => input.value,
        set(value) { input.value = String(value ?? ''); count(); },
        setDisabled(value) { setDisabled(input, value); },
        setReadOnly(value) {
            input.readOnly = Boolean(value);
            if (value) input.setAttribute('aria-readonly', 'true');
            else input.removeAttribute('aria-readonly');
        },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

export function numberField(ctx) {
    const { doc, field } = ctx;
    const input = h(doc, 'input', 'ss-input ss-number');
    input.type = 'number';
    if (Number.isInteger(field.min)) input.min = String(field.min);
    if (Number.isInteger(field.max)) input.max = String(field.max);
    input.step = '1';
    input.inputMode = 'numeric';
    named(input, ctx);
    let shown = ctx.value;
    input.value = shown === null || shown === undefined ? '' : String(shown);
    input.addEventListener('change', () => {
        const typed = Number(String(input.value).trim());
        const next = readInt(input.value, field);
        if (next === null) {
            // Not a number: the value stays, is shown again, and the reader is told.
            input.value = shown === null || shown === undefined ? '' : String(shown);
            ctx.invalid(fill(FORM_TEXT.notWhole, { value: shown ?? '' }));
            return;
        }
        input.value = String(next);
        shown = next;
        ctx.onChange(next, { typed: Math.round(typed) });
    });
    const handle = {
        el: input, input,
        get: () => (String(input.value).trim() === '' ? null : Number(input.value)),
        set(value) {
            shown = value;
            input.value = value === null || value === undefined ? '' : String(value);
        },
        setDisabled(value) { setDisabled(input, value); },
        setReadOnly(value) {
            input.readOnly = Boolean(value);
            if (value) input.setAttribute('aria-readonly', 'true');
            else input.removeAttribute('aria-readonly');
        },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- slider ----------------------------------------------------------------------------------------

export function sliderField(ctx) {
    const { doc, field } = ctx;
    const root = h(doc, 'div', 'ss-slider');
    const input = h(doc, 'input', 'ss-slider-input');
    input.type = 'range';
    // The range is the field's min and max; `sliderMax` (below `max`) is the range the slider offers while the value is
    // within it, for a field whose store allows far more than a slider can place (the range grows to a larger value).
    const top = value => (Number.isInteger(field.sliderMax) && field.sliderMax > field.min ? Math.min(field.max, Math.max(field.sliderMax, Number.isInteger(value) ? value : 0)) : field.max);
    input.min = String(field.min);
    input.max = String(top(ctx.value));
    // `step` (a whole number, default 1): a budget in steps of 50 is easier to place than one in steps of 1.
    input.step = String(Number.isInteger(field.step) && field.step >= 1 ? field.step : 1);
    named(input, ctx);
    const out = h(doc, 'output', 'ss-slider-value');
    out.setAttribute('aria-hidden', 'true');
    const clampNow = value => (Number.isInteger(value) ? Math.min(field.max, Math.max(field.min, value)) : field.min);
    // What the value is called: `format(n)` (a function: "60 pennies", "Automatic"), else the number and a short `unit` text.
    const say = n => {
        if (typeof field.format === 'function') {
            try {
                const text = field.format(n);
                if (typeof text === 'string' && text) return cutAt(text, 40);
            } catch { /* the number alone */ }
        }
        return `${n}${typeof field.unit === 'string' ? cutAt(field.unit, 8) : ''}`;
    };
    // The fill (0…1) is a custom property the track paints from; the value is shown beside it and spoken.
    const show = () => {
        const n = Number(input.value);
        const text = say(n);
        out.textContent = text;
        input.setAttribute('aria-valuetext', text);
        const max = Number(input.max);
        input.style.setProperty('--ss-fill', String(Math.round(((n - field.min) / (max - field.min)) * 10000) / 10000));
    };
    let off = false;
    let locked = false;
    input.value = String(clampNow(ctx.value));
    show();
    input.addEventListener('input', show);
    input.addEventListener('change', () => {
        show();
        ctx.onChange(Number(input.value), { typed: Number(input.value) });
    });
    root.append(input, out);
    const handle = {
        el: root, input,
        get: () => Number(input.value),
        set(value) {
            input.max = String(top(value));
            input.value = String(clampNow(value));
            show();
        },
        setDisabled(value) { off = Boolean(value); setDisabled(input, off || locked); },
        setReadOnly(value) { locked = Boolean(value); setDisabled(input, locked || off); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- select and profile ----------------------------------------------------------------------------

function fillSelect(doc, select, options) {
    select.replaceChildren();
    for (const option of options) {
        const node = h(doc, 'option', '', option.label);
        node.value = option.value;
        select.appendChild(node);
    }
}

export function selectField(ctx) {
    const { doc, field } = ctx;
    const select = h(doc, 'select', 'ss-input ss-select');
    named(select, ctx);
    fillSelect(doc, select, optionsOf(field));
    select.value = String(ctx.value ?? '');
    let off = false;
    let locked = false;
    select.addEventListener('change', () => ctx.onChange(select.value, { typed: select.value }));
    const handle = {
        el: select, input: select,
        get: () => select.value,
        set(value) { select.value = String(value ?? ''); },
        setDisabled(value) { off = Boolean(value); setDisabled(select, off || locked); },
        setReadOnly(value) { locked = Boolean(value); setDisabled(select, locked || off); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

/**
 * The Connection Manager profile select (profile-field.js's choices: "Same as chat", then the profiles by name; a
 * stored name that is gone stays as "… (not found)"), with its note ("There are no connection profiles yet…")
 * handed to `ctx.note`. `ctx.profiles()` answers listProfiles()'s shape (the page's by default).
 */
export function profileField(ctx) {
    const { doc } = ctx;
    const select = h(doc, 'select', 'ss-input ss-select ss-profile');
    named(select, ctx);
    let off = false;
    let locked = false;
    // With nothing to pick but "Same as chat" (no Connection Manager, or no profiles in it) the select is disabled, and the
    // note under the label says why; a stored profile that is gone still shows (as "not found") and can be changed.
    let nothing = false;
    const lock = () => setDisabled(select, off || locked || nothing);
    const draw = value => {
        const list = typeof ctx.profiles === 'function' ? ctx.profiles() : undefined;
        const { options, selected, note } = list === undefined ? profileChoices(value) : profileChoices(value, list);
        fillSelect(doc, select, options);
        select.value = selected;
        nothing = options.length <= 1;
        lock();
        ctx.note?.(note);
    };
    draw(ctx.value);
    select.addEventListener('change', () => ctx.onChange(select.value, { typed: select.value }));
    const handle = {
        el: select, input: select,
        get: () => select.value,
        set(value) { draw(value); },
        setDisabled(value) { off = Boolean(value); lock(); },
        setReadOnly(value) { locked = Boolean(value); lock(); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- chips -----------------------------------------------------------------------------------------

/**
 * The chip picker. One of the options (a radio group: the arrow keys move and choose, one Tab stop) or, with
 * `field.multiple`, several (toggle buttons with aria-pressed; the value is a list of option values in the
 * options' order).
 */
export function chipsField(ctx) {
    const { doc, field } = ctx;
    const many = field.multiple === true;
    const options = optionsOf(field);
    const root = h(doc, 'div', 'ss-chips');
    root.setAttribute('role', many ? 'group' : 'radiogroup');
    named(root, ctx);
    let value = many ? (Array.isArray(ctx.value) ? ctx.value.map(String) : []) : String(ctx.value ?? options[0]?.value ?? '');
    let locked = false;
    let off = false;
    const chips = options.map(option => {
        const chip = button(doc, 'ss-chip');
        chip.setAttribute('data-value', option.value);
        chip.textContent = option.label;
        if (!many) chip.setAttribute('role', 'radio');
        root.appendChild(chip);
        return chip;
    });
    const selectedAt = () => (many ? -1 : Math.max(0, options.findIndex(option => option.value === value)));
    function paint() {
        chips.forEach((chip, at) => {
            const on = many ? value.includes(options[at].value) : options[at].value === value;
            chip.classList.toggle('ss-chip-on', on);
            if (many) chip.setAttribute('aria-pressed', String(on));
            else {
                chip.setAttribute('aria-checked', String(on));
                chip.setAttribute('tabindex', at === selectedAt() ? '0' : '-1');
            }
        });
    }
    paint();
    function choose(at, { fromKey = false } = {}) {
        if (locked || chips[at].disabled) return;
        const option = options[at];
        if (many) value = options.map(o => o.value).filter(v => (v === option.value ? !value.includes(v) : value.includes(v)));
        else if (option.value === value) {
            if (fromKey) chips[at].focus?.({ preventScroll: true });
            return;
        } else value = option.value;
        paint();
        if (fromKey) chips[at].focus?.({ preventScroll: true });
        ctx.onChange(many ? [...value] : value, { typed: many ? [...value] : value });
    }
    chips.forEach((chip, at) => chip.addEventListener('click', () => choose(at)));
    if (!many) {
        // A radio group: the arrow keys move the choice (wrapping); Home and End go to the ends.
        root.addEventListener('keydown', event => {
            const at = chips.findIndex(chip => chip === event.target || chip.contains?.(event.target));
            let next = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % chips.length;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + chips.length) % chips.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = chips.length - 1;
            if (next === null || at < 0) return;
            event.preventDefault?.();
            choose(next, { fromKey: true });
        });
    }
    const handle = {
        el: root, input: root,
        get: () => (many ? [...value] : value),
        set(next) {
            value = many ? (Array.isArray(next) ? next.map(String) : []) : String(next ?? '');
            paint();
        },
        setDisabled(on) {
            off = Boolean(on);
            chips.forEach(chip => setDisabled(chip, off || locked));
        },
        setReadOnly(on) {
            locked = Boolean(on);
            chips.forEach(chip => setDisabled(chip, locked || off));
        },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- segmented: one choice as a joined row of buttons ----------------------------------------------

/**
 * A choice with `form: 'segmented'`: the one-of chips (a radio group with arrow keys) drawn as one joined row, for a few short
 * options (Text size: Normal, 110%, 120%). Same value, events and keys as `chipsField`; only the class differs (`ss-segmented`).
 */
export function segmentedField(ctx) {
    const handle = chipsField({ ...ctx, field: { ...ctx.field, multiple: false } });
    handle.el.classList.add('ss-segmented');
    return handle;
}

// ---- lines: an editable list of records ------------------------------------------------------------

const subLabel = (key, sub) => String(sub.label ?? String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()));
// "Frostmoon: 30": how one line of a list's text form is written.
const lineForm = subs => subs.map(([key, sub]) => subLabel(key, sub)).join(': ');
const itemName = (item, subs, index) => {
    for (const [key, sub] of subs) {
        const value = item?.[key];
        if (sub.type === 'text' && typeof value === 'string' && value.trim()) return cutAt(value.trim().replace(/\s+/g, ' '), 40);
    }
    return fill(SETTINGS_TEXT.listItem, { n: index + 1 });
};

/**
 * A list of records ("Name: Worth" coins, months with days). Rows: one line per item with its fields side by
 * side, each named for a screen reader by its field and item ("Worth, item 2"), a Remove button per item
 * ("Remove Frostmoon") and Add at the end; the focus goes to the next item's Remove (or Add) after a removal and
 * to the new row's first field after an Add. Lines: for a list of text and whole-number fields, one item per
 * line ("Frostmoon: 30"), read when it changes (`linesToList`: the host overlay's reader); a line that does not
 * read is named under the text and the list is kept as it was. `form: 'lines'` starts in lines; "Edit as text" /
 * "Edit as rows" switch (the choice is kept in `ctx.memo`). At most SETTING_LIST_ROWS items.
 */
export function linesField(ctx) {
    const { doc, field, id } = ctx;
    const root = h(doc, 'div', 'ss-lines');
    root.setAttribute('role', 'group');
    named(root, ctx);
    let list = structuredClone(Array.isArray(ctx.value) ? ctx.value : []);
    const subs = Object.entries(field.of ?? {}).map(([key, sub]) => [key, normalizeField(sub)]).filter(([, sub]) => fieldKind(sub) && sub.type !== 'list');
    const textFields = listTextFields(field);
    const formKey = `list-form:${id}`;
    let asText = textFields !== null && (ctx.memo?.has(formKey) ? ctx.memo.get(formKey) === true : field.form === 'lines');
    let locked = Boolean(ctx.readOnly);
    let off = Boolean(ctx.disabled);
    let cells = [];            // [{ key, handle }] per row, for set()
    const fieldName = ctx.label ?? field.label ?? SETTINGS_TEXT.add;
    // `note`: what a row's own box moved or refused (a number moved into its range), said under the whole list.
    const emit = note => ctx.onChange(structuredClone(list), { typed: structuredClone(list), note: note ?? '' });

    function toggleButton() {
        const toggle = button(doc, 'ss-lines-toggle', fill(asText ? SETTINGS_TEXT.asRowsTitle : SETTINGS_TEXT.asTextTitle, { field: fieldName }));
        toggle.textContent = asText ? SETTINGS_TEXT.asRows : SETTINGS_TEXT.asText;
        toggle.setAttribute('aria-pressed', String(asText));
        return toggle;
    }
    function switchForm(next) {
        asText = next;
        ctx.memo?.set(formKey, asText);
        draw();
        root.querySelector('.ss-lines-toggle')?.focus?.({ preventScroll: true });
    }
    function drawText() {
        const area = h(doc, 'textarea', 'ss-input ss-lines-text');
        area.id = `${id}-text`;
        area.rows = Math.max(4, Math.min(list.length + 1, 16));
        area.spellcheck = false;
        area.value = listToLines(field, list);
        area.setAttribute('aria-label', fill(SETTINGS_TEXT.asTextTitle, { field: fieldName }));
        const help = h(doc, 'small', 'ss-field-help ss-lines-help', fill(SETTINGS_TEXT.linesHelp, { form: lineForm(textFields), max: SETTING_LIST_ROWS }));
        help.id = `${id}-text-help`;
        const error = h(doc, 'p', 'ss-field-error ss-lines-error');
        error.id = `${id}-text-error`;
        error.setAttribute('role', 'alert');
        error.hidden = true;
        area.setAttribute('aria-describedby', help.id);
        area.disabled = off;
        area.readOnly = locked;
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
            emit();
            return true;
        };
        area.addEventListener('change', read);
        const foot = h(doc, 'div', 'ss-lines-foot');
        const toggle = toggleButton();
        toggle.disabled = off;
        // Back to rows only when the text reads (else the error says which line, and the text stays).
        toggle.addEventListener('click', () => { if (locked || read()) switchForm(false); else area.focus?.({ preventScroll: true }); });
        foot.appendChild(toggle);
        root.append(area, help, error, foot);
        cells = [];
    }
    function drawRows(focusAt = null) {
        cells = [];
        if (!list.length) root.appendChild(h(doc, 'p', 'ss-lines-empty', FORM_TEXT.noRows));
        const removes = [];
        list.forEach((item, index) => {
            const row = h(doc, 'div', 'ss-lines-row');
            row.setAttribute('data-index', String(index));
            const own = [];
            for (const [key, sub] of subs) {
                const kind = fieldKind(sub);
                const cell = h(doc, 'div', 'ss-lines-cell');
                cell.setAttribute('data-field', key);
                cell.setAttribute('data-type', sub.type);
                const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
                const sctx = {
                    doc, id: `${id}-${index}-${key}`, key, field: sub, value, label: subLabel(key, sub),
                    ariaLabel: `${subLabel(key, sub)}, ${fill(SETTINGS_TEXT.listItem, { n: index + 1 })}`, disabled: off, readOnly: locked, memo: ctx.memo, profiles: ctx.profiles,
                    invalid: message => ctx.invalid?.(fill(FORM_TEXT.rowNote, { n: index + 1, field: subLabel(key, sub), note: message })), note: () => {},
                    onChange: (next, meta) => {
                        list[index] = { ...list[index], [key]: next };
                        const moved = typeof meta?.typed === 'number' ? changeNote(sub, meta.typed, next) : '';
                        emit(moved ? fill(FORM_TEXT.rowNote, { n: index + 1, field: subLabel(key, sub), note: moved }) : '');
                    },
                };
                const made = RENDERERS[kind === 'slider' ? 'number' : kind](sctx);
                if (sub.type === 'text' || sub.type === 'int') made.input.placeholder = subLabel(key, sub);
                cell.appendChild(made.el);
                row.appendChild(cell);
                own.push({ key, handle: made });
            }
            cells.push(own);
            const name = fill(SETTINGS_TEXT.remove, { name: itemName(item, subs, index) });
            const remove = button(doc, 'ss-lines-remove', name);
            const sign = h(doc, 'span', '', '−');
            sign.setAttribute('aria-hidden', 'true');
            remove.appendChild(sign);
            remove.disabled = off || locked;
            remove.addEventListener('click', () => {
                list = list.filter((_, at) => at !== index);
                emit();
                // The focus goes to the next item's Remove, else to Add: never to the page behind.
                draw(Math.min(index, list.length - 1));
            });
            removes.push(remove);
            row.appendChild(remove);
            root.appendChild(row);
        });
        const add = button(doc, 'ss-lines-add', field.label ? fill(SETTINGS_TEXT.addTitle, { field: field.label }) : SETTINGS_TEXT.add);
        add.textContent = `+ ${SETTINGS_TEXT.add}`;
        add.disabled = off || locked || list.length >= SETTING_LIST_ROWS;
        add.addEventListener('click', () => {
            list = [...list, Object.fromEntries(subs.map(([key, sub]) => [key, emptyValue(sub)]))];
            emit();
            draw();
            [...root.querySelectorAll('.ss-lines-row')].at(-1)?.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
        });
        const foot = h(doc, 'div', 'ss-lines-foot');
        foot.appendChild(add);
        if (textFields) {
            const toggle = toggleButton();
            toggle.disabled = off;
            toggle.addEventListener('click', () => switchForm(true));
            foot.appendChild(toggle);
        }
        root.appendChild(foot);
        if (focusAt !== null) (removes[focusAt] ?? add).focus?.({ preventScroll: true });
    }
    function draw(focusAt = null) {
        root.replaceChildren();
        root.setAttribute('data-form', asText ? 'lines' : 'rows');
        if (asText) drawText();
        else drawRows(focusAt);
    }
    draw();
    return {
        el: root, input: root,
        get: () => structuredClone(list),
        set(items) {
            const next = structuredClone(Array.isArray(items) ? items : []);
            const same = next.length === list.length;
            list = next;
            // The same number of rows: the fields are set in place (a focus in one stays); else drawn again.
            if (same && !asText) cells.forEach((own, index) => own.forEach(({ key, handle }) => handle.set(list[index]?.[key])));
            else draw();
        },
        setDisabled(on) { off = Boolean(on); draw(); },
        setReadOnly(on) { locked = Boolean(on); draw(); },
        destroy() {},
    };
}

// ---- search ----------------------------------------------------------------------------------------

/**
 * The search box: a `type=search` input named "Search settings" (a hidden label), a clear button while it holds
 * text, Escape clears it. `onInput(text)` is called as the reader types. → { el, input, get(), set(text), clear() }.
 */
export function searchField(doc, { label = FORM_TEXT.searchLabel, placeholder = FORM_TEXT.searchPlaceholder, onInput = () => {}, id = newId('search') } = {}) {
    const root = h(doc, 'div', 'ss-search');
    root.setAttribute('role', 'search');
    const name = h(doc, 'label', 'ss-visually-hidden', label);
    name.setAttribute('for', id);
    const input = h(doc, 'input', 'ss-input ss-search-input');
    input.type = 'search';
    input.id = id;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const clear = button(doc, 'ss-search-clear', FORM_TEXT.clear);
    const x = h(doc, 'span', '', '×');
    x.setAttribute('aria-hidden', 'true');
    clear.appendChild(x);
    clear.hidden = true;
    root.append(name, input, clear);
    const sync = () => { clear.hidden = input.value === ''; };
    const handle = {
        el: root, input,
        get: () => input.value,
        set(text) { input.value = String(text ?? ''); sync(); },
        clear() {
            input.value = '';
            sync();
            onInput('');
        },
    };
    input.addEventListener('input', () => { sync(); onInput(input.value); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape' && input.value !== '') {
            event.preventDefault?.();
            event.stopPropagation?.();
            handle.clear();
        }
    });
    clear.addEventListener('click', () => {
        handle.clear();
        input.focus?.({ preventScroll: true });
    });
    return handle;
}

// ---- a grouped section -----------------------------------------------------------------------------

/**
 * A grouped section: a glass card with a heading (a section label, an `h3`) and an optional quiet hint, its fields
 * in `body`. `collapsible` makes it a `details` that opens and closes (`open`); `level` is the heading's (3: `h3`).
 * → { el, body, title, setHidden(on) }.
 */
export function sectionBlock(doc, { title = '', hint = '', id = newId('section'), collapsible = false, open = true, level = 3 } = {}) {
    const root = h(doc, collapsible ? 'details' : 'section', 'ss-section ss-glass');
    root.id = id;
    if (collapsible) root.open = Boolean(open);
    const head = h(doc, collapsible ? 'summary' : 'div', 'ss-section-head');
    const name = h(doc, collapsible ? 'span' : `h${Math.min(6, Math.max(2, Number(level) || 3))}`, 'ss-label ss-section-title', title);
    if (!collapsible) name.id = `${id}-title`;
    head.appendChild(name);
    if (hint) head.appendChild(h(doc, 'small', 'ss-section-hint', hint));
    const body = h(doc, 'div', 'ss-section-body');
    root.append(head, body);
    if (!collapsible && title) root.setAttribute('aria-labelledby', name.id);
    head.hidden = !title;
    return { el: root, body, title: name, setHidden(on) { root.hidden = Boolean(on); } };
}

// ---- chips that fill a text -------------------------------------------------------------------------

/**
 * Several chips over a text setting: the stored text is a comma-separated list ("~ time, ~ place") and each option is one entry
 * (`options`: the entries the reader may choose). Entries the options do not list are kept as they are, never drawn and never
 * dropped by a change here. The value reported is the text, the chosen entries in the options' order, then the kept ones.
 * `field.read(text)` → the entries (default: split on commas, semicolons and newlines, each trimmed, lower-cased).
 */
export function chipsetField(ctx) {
    const { field } = ctx;
    const options = optionsOf(field);
    const read = typeof field.read === 'function' ? field.read : text => String(text ?? '').split(/[,;\n]+/).map(part => part.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
    const known = new Set(options.map(option => option.value));
    let extras = [];
    const split = text => {
        const entries = read(text);
        extras = entries.filter(entry => !known.has(entry));
        return options.map(option => option.value).filter(value => entries.includes(value));
    };
    const inner = chipsField({ ...ctx, field: { ...field, multiple: true }, value: split(ctx.value), onChange: chosen => {
        const text = [...chosen, ...extras].join(', ');
        ctx.onChange(text, { typed: text });
    } });
    return { ...inner, get: () => [...inner.get(), ...extras].join(', '), set(text) { inner.set(split(text)); } };
}

/** The renderers by kind. */
export const RENDERERS = Object.freeze({
    switch: switchField, text: textField, number: numberField, slider: sliderField, select: selectField, chips: chipsField, chipset: chipsetField, segmented: segmentedField, profile: profileField, lines: linesField,
});

export { FIELD_KINDS };
