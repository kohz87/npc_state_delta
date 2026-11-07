// The `scene` domain's limits and feature names in one place, so every part of the scene reads the same numbers: the name and
// presence caps, the weather and {{user}}'s look (`~ you`) character caps, and the parts a look has. Pure. scene.js re-exports
// the public ones.

import { CORE_FEATURE } from '../../features.js';

export const MAX_NAME = 80;
export const MAX_PRESENT = 40;
/** A weather text is at most this many code points (cut, an ellipsis in the last place). */
export const WEATHER_CHARS = 60;
/** The weather in the tail's Place line is cut to this many code points (about 8 tokens with its separator). */
export const WEATHER_TAIL_CHARS = 26;
/** The mark a module's rule leaves on the weather it set (`scene.weather` command `key`), at most this many code points. */
export const WEATHER_KEY_CHARS = 80;
export const WEATHER_FEATURE = CORE_FEATURE.weather;
/** What {{user}} wears and their condition (`~ you`): each at most this many code points (cut, an ellipsis in the last place). */
export const YOU_CHARS = 120;
export const YOU_FEATURE = CORE_FEATURE.you;
export const YOU_PARTS = Object.freeze(['rank', 'wearing', 'condition']);
