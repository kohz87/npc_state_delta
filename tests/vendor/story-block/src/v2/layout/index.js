// Layouts (SPEC §9, MODULES §E): declarative screens bound to queries. A pack's layouts
// (and later every module's screens) are JSON trees of a few node types, checked by
// validateLayout and drawn by renderLayout into any element. tabFromLayout wraps one for
// the tab host. See docs/v2/LAYOUTS.md for the reference creators read.

import { renderLayout, showErrors } from './render.js';
import { ensureLayoutStyles } from './styles.js';
import { validateLayout } from './validate.js';

export { renderLayout, showErrors } from './render.js';
export { validateLayout } from './validate.js';
export { LAYOUT_CSS, LAYOUT_STYLE_ID, ensureLayoutStyles } from './styles.js';
export { LIMITS, NODE_TYPES, TOKENS, TONES, imageUrlError } from './schema.js';

/**
 * A tab for the tab host (SPEC §6): `{ id, title, icon, render(el, view, api) }`.
 * Data comes from `view.query`; buttons use `api.command`, conditions `api.evaluate`,
 * code widgets `api.widgets` (merged over `widgets` given here). Without a command
 * function the buttons are drawn disabled.
 */
export function tabFromLayout(layout, { widgets } = {}) {
    return {
        id: String(layout?.id ?? ''),
        title: String(layout?.title ?? ''),
        icon: String(layout?.icon ?? ''),
        render(el, view = {}, api = {}) {
            ensureLayoutStyles(el?.ownerDocument);
            const fn = value => (typeof value === 'function' ? value : undefined);
            const options = {
                query: fn(view?.query),
                command: fn(api?.command),
                evaluate: fn(api?.evaluate),
                preview: fn(api?.preview),
                commit: fn(api?.commit),
                on: fn(api?.on),
                widgets: { ...(widgets ?? {}), ...(api?.widgets ?? {}) },
            };
            // A tab needs its id, title and icon; renderLayout alone does not.
            const errors = validateLayout(layout, { widgets: options.widgets });
            if (errors.length) return showErrors(el, errors);
            return renderLayout(el, layout, options);
        },
    };
}

// Layouts register nothing in the state: no domain, command, query or prompt text.
// The part is here so the module merge (MODULES §A) can treat every folder alike.
export const part = {
    domains: {},
    commands: {},
    queries: {},
    kinds: {},
    context: { static: () => '', tail: () => ({ lines: [], optional: [] }), budget: 0 },
    hooks: {},
    settings: { defaults: {}, schema: {} },
    tabs: [],
};
