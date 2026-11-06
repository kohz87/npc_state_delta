// The block editor's shared labels, field types, layout and tone names and comparisons (moved out of
// screens/blocks-editor.js unchanged; editor.js, draw.js and layout.js import them from here).

import { hasIcon } from '../../view/icons/index.js';
import { STRINGS } from '../../strings.js';

export const S = STRINGS.blocks;
export const TYPES = [{ value: 'text', label: S.text }, { value: 'number', label: S.number }, { value: 'choice', label: S.choice }, { value: 'list', label: S.list }, { value: 'entries', label: S.entries }];
// (a part of an entry is a text, a number or a choice; never a list or another list of entries)
export const PART_TYPES = TYPES.slice(0, 3);
export const LAYOUT_NAMES = { cards: S.layoutCards, bars: S.layoutBars, fields: S.layoutFields };
export const TONE_NAMES = { active: S.toneActive, done: S.toneDone, failed: S.toneFailed, neutral: S.toneNeutral };
export const PART_NAMES = ['Detail', 'Note', 'Extra', 'More', 'Other', 'Piece'];
export const COMPARISONS = [{ value: 'eq', label: S.is }, { value: 'ne', label: S.isNot }, { value: 'lt', label: S.below },
    { value: 'gt', label: S.above }, { value: 'le', label: S.atMost }, { value: 'ge', label: S.atLeast }];
export const ICONS = ['ph-bookmark-simple', 'ph-scroll', 'ph-heart', 'ph-lightning', 'ph-star', 'ph-sparkle', 'ph-sword', 'ph-skull'].filter(hasIcon);
