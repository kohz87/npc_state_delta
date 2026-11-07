// Rendering a compiled template (index.js) into an element. The first render builds the page from the
// compiled tree; later renders patch it: text, attributes, variables and classes are set only when their
// value changed, loop items are kept by key (the item's `id`, else its record key or index) and moved only
// when the order changed, `data-if` adds or removes its element, widgets are given new props only when
// they changed. So rendering again with the same scope changes nothing, and inputs keep their focus.
//
// Text is only ever set with textContent; attributes with setAttribute after the allow-list; URLs (and SVG
// paint references) are checked again after binding. Event handlers are added by the renderer itself
// (click, input, change, submit), never from the template; every <form> gets a submit listener that stops
// the browser's own submission (which would reload SillyTavern's page), and runs data-submit's command.
//
// SillyTavern's page is shared, so a template keeps to its own names: every `id` is drawn as
// `ss-t-<screen>-<id>` (css.js templateIdPrefix; the screen's CSS `#id` selectors get the same prefix), and
// the attributes that point at ids follow (`for`, `headers`, `aria-labelledby` and the other id lists,
// `href="#id"`, `url(#id)` in SVG paint); a form's `name` is prefixed too (document.<name> would clobber
// the page's own), and so is every control's (a <form> is [LegacyOverrideBuiltIns]: `form.classList`,
// `form.setAttribute`, `form.disabled` … would be its control named so). The renderer also reads the DOM
// members it uses past any such control (`dom()` / `call()` in render/dom.js), so even a name that slips through
// cannot stop a form drawing or leave it busy. Classes SillyTavern acts on (sanitize.js RESERVED_CLASSES)
// are never set, bound or toggled.

export { MAX_ELEMENTS, renderTemplate, destroyTemplate } from './render/view.js';
