// What the Soul Class field is called (Settings → Blocks → Edit, or a pack, may rename it: label "Level", names 1–9). Every place of
// the RPG that shows it reads the field's own `label` and `names` from the Character block, and falls back to the template's
// "Soul Class" and I–IX. Pure: it takes the field's schema (`definition.state.soul`, or nothing) and a value 1–9.
import { CLASS_NAMES } from './names.js';

/** What the stock Character template calls the field. */
export const SOUL_LABEL = 'Soul Class';
const LABEL_MAX = 40;

/** The field's label, else "Soul Class" (one line, at most 40 characters). */
export function soulLabelOf(schema) {
    const label = typeof schema?.label === 'string' ? schema.label.replace(/\s+/g, ' ').trim() : '';
    return label ? [...label].slice(0, LABEL_MAX).join('') : SOUL_LABEL;
}

/** The word for a value: the field's own name for it, else I–IX, else the number. */
export function soulWordOf(schema, value) {
    const named = schema?.names !== null && typeof schema?.names === 'object' && !Array.isArray(schema.names) ? schema.names[String(value)] : undefined;
    return typeof named === 'string' && named.trim() ? named : CLASS_NAMES[value - 1] ?? String(value);
}

/** Whether the field keeps the template's label (then a short place says "class" or "Class"; a renamed field says its own word). */
export const soulIsDefault = label => label === SOUL_LABEL;

/** The label for a place that says only "class": the short word while the label is the default, else the field's own label. */
export const soulShortOf = (label, short) => (soulIsDefault(label) ? short : label);

/** A reading of the field for the places that carry it around: { label, word(value) }. */
export const soulReading = schema => ({ label: soulLabelOf(schema), word: value => soulWordOf(schema, value) });
