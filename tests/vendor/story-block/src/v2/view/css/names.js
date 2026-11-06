// Names used to keep a screen's stylesheet inside its own root: its scope selector, keyframe prefix and
// template id prefix. The CSS scoper and template renderer use the same id prefix.

/** The attribute selector for a screen id. */
export function screenSelector(id) {
    return `[data-ss-screen="${String(id).replace(/["\\]/g, '\\$&')}"]`;
}

/** The prefix a screen's keyframes get (`ss-example-module-party-`). */
export function keyframePrefix(id) {
    return `ss-${String(id).replace(/[^A-Za-z0-9_-]+/g, '-')}-`;
}

/**
 * The prefix every `id` in a screen's template gets when it is drawn (`ss-t-example-module-party-`), so a
 * template can never reuse or clobber one of SillyTavern's ids (`#send_textarea`, `#chat`, …) or another
 * screen's. The screen's CSS `#id` selectors, `for`, `aria-*` id lists, `href="#id"` and `url(#id)` get it too.
 */
export function templateIdPrefix(id) {
    return `ss-t-${String(id ?? '').replace(/[^A-Za-z0-9_-]+/g, '-')}-`;
}
