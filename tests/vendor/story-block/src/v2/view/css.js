// Screen stylesheets (SPEC §13.3). A screen's `css` is scoped to its root, `[data-ss-screen="<id>"]`, so a
// card's or a pack's styles can never reach SillyTavern's page or another screen:
// * every selector gets the scope in front, inside `@media`, `@supports`, `@container` and `@layer` too;
//   a bare `:root`, `html`, `body`, `:host` or `:scope` becomes the scope itself (`:root { … }`);
// * a selector may not reach beyond the screen's root (selectorEscape): a root alias followed by a combinator, a sibling
//   combinator (`+`, `~`) before the first compound, and a `:has()` with a leading `+` or `~` are dropped, so no rule
//   can style the page beside the screen;
// * `@keyframes` names get a per-screen prefix, and `animation` / `animation-name` use the prefixed names;
// * `@import`, `@charset`, `@namespace`, `@page` and unknown at-rules are dropped;
// * `position: fixed`, `behavior`, `-moz-binding`, `expression(…)`, `javascript:`/`vbscript:` and any
//   `url()` that is not `data:` or `https:` drop their declaration; `@font-face` stays with those URLs;
// * `#id` selectors get the screen's template id prefix (templateIdPrefix), as the drawn ids do;
// * a quoted URL that is not `data:`/`https:` drops its declaration wherever it stands, custom properties
//   included, and `image-set()`/`image()`/`cross-fade()`/`src()` may not take a value from `var()`;
// * more than 64 KB is refused whole;
// * `@media`/`@supports`/… nested more than MAX_AT_DEPTH deep are dropped with a warning (a deep sheet
//   would cost time at every level; packs refuse one, packs/validate.js unsafeCss).
// Returns `{ css, warnings }`; warnings are plain sentences for the overlay. Pure.

export { MAX_AT_DEPTH, MAX_CSS_BYTES, cssDepth } from './css/parse.js';
export { keyframePrefix, screenSelector, templateIdPrefix } from './css/names.js';
export { cssVarValue, filterDeclarations, isSafeCssUrl, themeVars, valueProblem } from './css/values.js';
export { selectorEscape, sheetEscape } from './css/selectors.js';
export { scopeCss } from './css/scoping.js';
