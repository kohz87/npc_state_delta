// The form engine's list field: an editable list of records drawn as rows or as one line per item, with Add,
// Remove, the text/rows switch, its notes and its row controls built from the other field renderers.

import {
    FORM_TEXT, SETTINGS_TEXT, SETTING_LIST_ROWS, changeNote, emptyValue, fieldKind, fill, linesToList, listTextFields, listToLines, normalizeField,
} from '../schema.js';
import { cutAt } from '../../../../text.js';
import { button, h, named } from './shared.js';
import { RENDERERS } from './renderers.js';

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
