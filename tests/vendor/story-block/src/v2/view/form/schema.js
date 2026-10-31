// The settings schema as the form engine reads it (view/form/): what kind of control each field gets, the plain-
// words messages, and the pure helpers shared with the settings overlay (host-ui.js), which stays the one place
// that knows how a list reads as lines, which groups a schema falls into and when a row is read-only. The engine
// takes them from there instead of copying them, so the two cannot disagree while the overlay still ships.
//
// The schema is the one the registry holds (`registry.settingsDefs()`, SPEC §6): `{ key: field }` with a field
// `{ type: bool | int | choice | text | list | profile, label, help, min, max, options, of, multiline, form, group,
// readOnly, shows, feature }` (a string is shorthand for its type, an array for a choice's options).

import { normalizeField, FIELD_TYPES } from '../../registry.js';
import { SETTING_LIST_ROWS } from '../../sdk.js';
import { SETTINGS_TEXT, emptyValue, fieldReadOnly, groupFields, linesToList, listTextFields, listToLines, readInt, rowValue } from '../../host-ui.js';
import { fill } from '../../strings.js';

export { FIELD_TYPES, SETTING_LIST_ROWS, SETTINGS_TEXT, emptyValue, fieldReadOnly, fill, groupFields, linesToList, listTextFields, listToLines, normalizeField, readInt, rowValue };

/** The kinds of control the engine draws (a field's `kind`, `fieldKind`). */
export const FIELD_KINDS = Object.freeze(['switch', 'text', 'number', 'slider', 'select', 'chips', 'chipset', 'segmented', 'profile', 'lines']);

/** What the form says to the reader (plain words). */
export const FORM_TEXT = Object.freeze({
    readOnly: 'Read only',
    notWhole: 'Enter a whole number. The setting stays {value}.',
    least: 'Set to {value}, the least this allows.',
    most: 'Set to {value}, the most this allows.',
    cut: 'Cut to {max} characters, the most this allows.',
    refused: 'That could not be saved. The setting stays {value}.',
    count: '{n} of {max} characters',
    clear: 'Clear the search',
    searchLabel: 'Search settings',
    searchPlaceholder: 'Search settings…',
    shown: '{n} settings shown',
    shownOne: '1 setting shown',
    none: 'No settings match "{text}".',
    noRows: 'Nothing here yet.',
    sliderValue: '{value}',
    rowNote: 'Row {n}, {field}: {note}',
    rowsCut: 'Only {kept} of the {typed} rows could be kept.',
});

/**
 * The kind of control a field gets, or null for a type the engine does not know (a newer module's: it is not
 * drawn and its value is kept). bool: a switch. int: a number box, or a slider with `form: 'slider'` and whole-
 * number min and max. choice: a select, chips (one of them) with `form: 'chips'`, or one joined row of buttons with `form: 'segmented'` (a few short options, such as Normal / 110% / 120%). text: a text box (a text area
 * with `multiline`; with `form: 'chips'` and `options`, chips that fill the text, several at once). profile: the Connection Manager profile select. list: rows with Add and Remove, or one line per
 * item (`form: 'lines'` starts there).
 */
export function fieldKind(field) {
    const f = normalizeField(field);
    switch (f?.type) {
        case 'bool': return 'switch';
        case 'int': return f.form === 'slider' && Number.isInteger(f.min) && Number.isInteger(f.max) && f.max > f.min ? 'slider' : 'number';
        case 'choice': return f.form === 'chips' ? 'chips' : f.form === 'segmented' ? 'segmented' : 'select';
        // Text that holds a list of words the reader picks from ("~ time, ~ place"): chips, several at once (`chipsetField`).
        case 'text': return f.form === 'chips' && optionsOf(f).length ? 'chipset' : 'text';
        case 'profile': return 'profile';
        case 'list': return 'lines';
        default: return null;
    }
}

/** A choice's options as [{ value, label }] (strings). */
export const optionsOf = field => (normalizeField(field)?.options ?? []).map(option => (option && typeof option === 'object' ? { value: String(option.value), label: String(option.label ?? option.value) } : { value: String(option), label: String(option) }));

/** "partyMembers" → "Party members": a label for a key with none. */
export const humanize = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());

/** A field's label: its own, else its key made readable. */
export const labelOf = (key, field) => String(normalizeField(field)?.label ?? humanize(key));

/**
 * The words for a value the store did not keep as typed: a whole number moved into its range, a text cut at its
 * maximum. '' when `typed` and `stored` agree (or the field is neither).
 */
export function changeNote(field, typed, stored) {
    const f = normalizeField(field);
    if (f?.type === 'int' && typeof typed === 'number' && typeof stored === 'number' && typed !== stored) {
        return fill(typed < stored ? FORM_TEXT.least : FORM_TEXT.most, { value: stored });
    }
    if (f?.type === 'text' && typeof typed === 'string' && typeof stored === 'string' && typed !== stored && Number.isInteger(f.max)) {
        return fill(FORM_TEXT.cut, { max: f.max });
    }
    // A list: rows the store left out, else the first field of a row it moved (a number into its range, a text cut), by row.
    if (f?.type === 'list' && Array.isArray(typed) && Array.isArray(stored)) {
        if (stored.length < typed.length) return fill(FORM_TEXT.rowsCut, { kept: stored.length, typed: typed.length });
        for (let at = 0; at < stored.length; at += 1) {
            for (const [key, sub] of Object.entries(f.of ?? {})) {
                const note = changeNote(sub, typed[at]?.[key], stored[at]?.[key]);
                if (note) return fill(FORM_TEXT.rowNote, { n: at + 1, field: normalizeField(sub)?.label ?? humanize(key), note });
            }
        }
    }
    return '';
}

/**
 * Whether a field matches a search text: every word of it is in the label, the help, the group's name or the key
 * (case does not matter). An empty search matches everything.
 */
export function matchesSearch(key, field, group, text) {
    const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const f = normalizeField(field) ?? {};
    const hay = [key, f.label, f.help, group].map(part => String(part ?? '').toLowerCase()).join(' ');
    return words.every(word => hay.includes(word));
}
