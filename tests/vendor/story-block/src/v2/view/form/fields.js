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

export { newId } from './fields/shared.js';
export { numberField, sliderField, switchField, textField } from './fields/basic.js';
export { chipsField, chipsetField, profileField, segmentedField, selectField } from './fields/choice.js';
export { linesField } from './fields/lines.js';
export { searchField, sectionBlock } from './fields/page.js';
export { RENDERERS } from './fields/renderers.js';
export { FIELD_KINDS } from './schema.js';
