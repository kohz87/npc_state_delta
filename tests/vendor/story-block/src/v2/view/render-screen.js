// Story Suite v2: the one `render(el, screen, scope)` the mounts are given (src/v2/view/mounts/common.js).
// A screen is drawn by the layout renderer (src/v2/layout/) when it has a `layout`, and by the template
// renderer (SPEC §13.2, src/v2/view/template/) when it has a `template`, with its css scoped to the
// screen (src/v2/view/css.js). `setTemplates(null)` turns templates off (a plain line instead).
//
// What a screen gets:
// * queries against the state the mount shows (`scope.state`: the head, or a card's own reply), through
//   `queryAt(name, args, state)` (sdk.js mountQuery);
// * commands only where the state shown is the head: a card under an older reply is read-only;
// * conditions (`when` nodes) in the events condition language, with bare names from the row
//   (`item.points > 0`), `state`, `q` and `draft`;
// * every registered widget (the `ss.*` set and the modules' own) by its namespaced name;
// * the mount's api (`command`, `preview`, `commit`, `query`, `on`, and in dialogs `onDraft`).

import { compile, evaluate as evaluateAst } from '../events/condition.js';
import { renderLayout } from '../layout/index.js';
import { ensureLayoutStyles } from '../layout/styles.js';
import { conditionEvaluator } from './bind.js';
import { scopeCss } from './css.js';
import { compileTemplate, renderTemplate } from './template/index.js';

/** The template renderer (SPEC §13.2) as this file uses it; setTemplates() can swap it (tests). */
export const TEMPLATES = Object.freeze({ compileTemplate, renderTemplate, scopeCss });
const templateEvaluate = conditionEvaluator({ compile, evaluate: evaluateAst });

// The screen css each stylesheet in the head was scoped from (style element → the source css).
const SHEET_SOURCE = new WeakMap();

/**
 * A screen's stylesheet in the head, `#ss-css-<id>`: put there scoped (`scopeFn(css, id)`), replacing the one there when the
 * screen's css changed, and removed when the screen has none now (`css` '' or missing). A pack that is replaced or disabled
 * takes its screens' sheets away this way before the new ones are added. Returns true when a sheet is in the head.
 */
export function applyScreenCss(doc, screen, scopeFn = TEMPLATES.scopeCss) {
    const id = `ss-css-${String(screen?.id ?? '').replace(/[^\w-]/g, '_')}`;
    const source = typeof screen?.css === 'string' && screen.css.trim() ? screen.css : '';
    const current = doc?.querySelector?.(`#${id}`) ?? doc?.head?.querySelector?.(`#${id}`) ?? null;
    if (current && SHEET_SOURCE.get(current) === source) return Boolean(source);
    current?.remove?.();
    if (!source || typeof scopeFn !== 'function' || !doc?.createElement) return false;
    let text = '';
    try {
        const out = scopeFn(source, screen.id);
        text = typeof out === 'string' ? out : String(out?.css ?? '');
    } catch { text = ''; }
    if (!text) return false;
    const style = doc.createElement('style');
    style.id = id;
    style.textContent = text;
    SHEET_SOURCE.set(style, source);
    doc.head?.appendChild(style);
    return true;
}

/** A condition evaluator for layouts: (cond, { item, index, query }) → true only when it holds. */
export function layoutEvaluator(scope) {
    return (cond, row = {}) => {
        const parsed = compile(cond, { names: true });
        if (!parsed.ok) throw new Error(parsed.error?.message ?? 'the condition cannot be read');
        const names = { item: row.item ?? null, index: row.index ?? null, state: scope.state ?? null, q: scope.q ?? {}, draft: scope.draft ?? null, settings: scope.settings ?? {} };
        const result = evaluateAst(parsed.ast, { state: scope.state, query: row.query ?? (() => null), scope: names });
        if (!result.ok) throw new Error(result.error?.message ?? 'the condition failed');
        return result.value === true;
    };
}

/**
 * createScreenRenderer({ queryAt, widgets, headIndex, templates?, sanitize?, formatters? }) →
 * { render(el, screen, scope), setTemplates(mod), hasTemplates() }.
 * `widgets()` → { [name]: widget }; `templates` = { compileTemplate, renderTemplate, scopeCss? }
 * (default TEMPLATES); `formatters()` → { money(n), time(m) } for templates' fmt helpers.
 */
export function createScreenRenderer({ queryAt, widgets = () => ({}), headIndex = () => null, templates = TEMPLATES, sanitize = null, formatters = () => ({}) } = {}) {
    let tpl = templates;
    const compiled = new Map();      // template text → compiled template

    function readOnly(scope) {
        if (scope.mount !== 'card') return false;
        const head = headIndex();
        return !(Number.isInteger(head) && scope.index === head);
    }

    function css(el, screen) {
        if (typeof tpl?.scopeCss !== 'function') return;
        applyScreenCss(el.ownerDocument ?? globalThis.document, screen, tpl.scopeCss);
    }

    function render(el, screen, scope) {
        const api = scope.api ?? {};
        const query = (name, args) => queryAt(name, args, scope.state);
        const command = readOnly(scope) ? undefined : typeof api.command === 'function' ? api.command : undefined;
        const evaluate = layoutEvaluator(scope);
        if (screen.layout) {
            ensureLayoutStyles(el.ownerDocument);
            const result = renderLayout(el, { id: screen.id, root: screen.layout.root, ...(screen.layout.theme ? { theme: screen.layout.theme } : {}) }, {
                query, command, evaluate, widgets: widgets(),
                preview: api.preview, commit: api.commit, on: api.on, onDraft: api.onDraft,
            });
            if (result?.problems?.length) console.warn(`[Story Suite] ${screen.id}:`, result.problems.join(' '));
            // The mount takes the layout's widgets down when it draws the element again or closes it.
            return result?.dispose ? () => result.dispose() : undefined;
        }
        if (typeof screen.template === 'string') {
            if (!tpl?.renderTemplate || !tpl?.compileTemplate) {
                const line = (el.ownerDocument ?? globalThis.document).createElement('p');
                line.className = 'ss-mount-problem';
                line.textContent = `The screen "${screen.id}" is an HTML template, and template screens are not available in this Story Block yet.`;
                el.replaceChildren(line);
                return undefined;
            }
            css(el, screen);
            if (!compiled.has(screen.template)) compiled.set(screen.template, tpl.compileTemplate(screen.template, { sanitize }));
            const view = tpl.renderTemplate(el, compiled.get(screen.template), { ...scope, query, formatters: formatters() ?? {} }, {
                command, evaluate: templateEvaluate, widgets: widgets(), onDraft: api.onDraft,
                api: { query, preview: api.preview, commit: api.commit, on: api.on },
            });
            return view && typeof view.destroy === 'function' ? () => view.destroy() : undefined;
        }
        throw new Error('it has neither a layout nor a template');
    }

    return {
        render,
        setTemplates(mod) { tpl = mod; compiled.clear(); },
        hasTemplates: () => Boolean(tpl?.renderTemplate),
    };
}
