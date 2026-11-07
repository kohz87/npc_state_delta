// The editable widget's prop schema and its one-line cut helper. editable.js keeps the widget and re-exports the same
// `editable` definition; this part only declares what callers may pass and how much text a box keeps.
import { oneLine } from '../../../../text.js';

export const props = {
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

export const cut = (value, max) => [...oneLine(value)].slice(0, Math.max(0, Math.floor(max))).join('');
