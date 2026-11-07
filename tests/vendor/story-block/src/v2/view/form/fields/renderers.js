// The form engine's renderers by kind, kept in the same order the form engine has always used.

import { numberField, sliderField, switchField, textField } from './basic.js';
import { chipsField, chipsetField, profileField, segmentedField, selectField } from './choice.js';
import { linesField } from './lines.js';

/** The renderers by kind. */
export const RENDERERS = Object.freeze({
    switch: switchField, text: textField, number: numberField, slider: sliderField, select: selectField, chips: chipsField, chipset: chipsetField, segmented: segmentedField, profile: profileField, lines: linesField,
});
