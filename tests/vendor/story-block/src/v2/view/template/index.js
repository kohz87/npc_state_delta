// Screen templates (SPEC §13.2): compile an HTML template once, then render it into an element from a
// scope as often as the state changes. Public interface:
//
//   compileTemplate(html, { sanitize? }) → { nodes, warnings }        // frozen; reuse it for every render
//   renderTemplate(el, compiled, scope, { command, widgets, evaluate, onDraft, onSubmit, onResult, onWarn, api, formatters })
//     → view { el, warnings, draft(), update(scope), destroy() }
//   destroyTemplate(el), strictSanitize(html), PURIFY_CONFIG
//
// `sanitize` is SillyTavern's DOMPurify (`DOMPurify.sanitize`, called as `sanitize(html, PURIFY_CONFIG)`);
// the strict allow-list (sanitize.js) runs after it either way, and is all there is without DOMPurify.
// Nothing from data ever reaches innerHTML: the page is built with createElement / setAttribute /
// textContent from the compiled tree, and every bound URL is checked again before it is set.
//
// Bindings (the template reference with examples is docs/v2/TEMPLATES.md):
//   {{ expr }}                     text, in text nodes and allowed attributes (not `style`)
//   data-bind="expr"               the element's text
//   data-bind-attr="a: expr; …"    attributes (URL attributes re-checked; false/null removes)
//   data-bind-var="--x: expr; …"   CSS custom properties
//   data-each="list as item[, i]"  repeat the element (records: values in key order, `i` is the key)
//   data-if="expr"                 keep the element only while truthy (applied per item inside data-each)
//   data-class="name: expr; …"     toggle classes
//   data-command="type" [data-payload='{"stack":"{{ s.id }}"}']   a click runs a command
//   data-draft="path"              an input fills the draft (text, number, range, select, radio, checkbox, textarea)
//   data-submit="type"             a form's submit (or an element's click) sends the draft as one command
//   <ss-widget name="ss.meter" data-props='{"bind":"q.pc.hp"}'></ss-widget>   a registered widget

import { compileExpr, isLoopName, parseInterpolation, parsePath, splitPairs } from '../bind.js';
import { PURIFY_CONFIG, attrAllowed, markControlTypes, sanitizeNodes, strictSanitize } from './sanitize.js';
import { MAX_JSON_DEPTH, compileJson, jsonDepth } from './json.js';
import { destroyTemplate, renderTemplate } from './render.js';

export { PURIFY_CONFIG, strictSanitize, renderTemplate, destroyTemplate };

const COMPILED = Symbol.for('storySuite.template.compiled');
const COMMAND_TYPE = /^[a-z0-9][\w-]*(?:\.[\w-]+)+$/i;
const DRAFT_TAGS = new Set(['input', 'select', 'textarea']);
const BINDING_ATTRS = new Set(['data-each', 'data-if', 'data-bind', 'data-bind-attr', 'data-bind-var', 'data-class', 'data-payload', 'data-props']);
const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'selected', 'hidden', 'open', 'readonly', 'required', 'multiple', 'reversed', 'novalidate']);

/** True for the result of compileTemplate. */
export const isCompiled = value => Boolean(value?.[COMPILED]);

/**
 * Compile a template once. `sanitize(html, config)` is DOMPurify's (optional); the strict allow-list always
 * runs after it. Returns a frozen `{ nodes, warnings }` (warnings are plain sentences).
 */
export function compileTemplate(html, { sanitize = null } = {}) {
    const warnings = [];
    let text = String(html ?? '');
    if (typeof sanitize === 'function') {
        try {
            // SillyTavern's DOMPurify drops controls' `type`: it travels as TYPE_MARK and comes back below.
            text = String(sanitize(markControlTypes(text), { ...PURIFY_CONFIG }) ?? '');
        } catch (error) {
            warnings.push(`The sanitiser failed (${error?.message ?? error}); the strict allow-list was used alone.`);
        }
    }
    const filtered = sanitizeNodes(text);
    warnings.push(...filtered.warnings);
    const nodes = compileChildren(filtered.nodes, warnings);
    return Object.freeze({ [COMPILED]: true, nodes, warnings: Object.freeze([...new Set(warnings)]) });
}

// How deep data-each loops may nest in a pack's template (B-b5b-robust-r2-2): each loop multiplies
// what the one around it draws.
export const MAX_LOOP_DEPTH = 3;

/**
 * What a pack check needs to know of a template: { loops: how deep data-each nests, deepJson: true when
 * a data-props or data-payload nests past MAX_JSON_DEPTH }.
 */
export function templateShape(html) {
    const compiled = compileTemplate(html);
    let loops = 0;
    let deepJson = false;
    const stack = compiled.nodes.map(node => [node, 0]);
    while (stack.length) {
        const [node, around] = stack.pop();
        if (node.kind !== 'element') continue;
        const depth = around + (node.each ? 1 : 0);
        loops = Math.max(loops, depth);
        if (node.deepJson) deepJson = true;
        for (const child of node.children ?? []) stack.push([child, depth]);
    }
    return { loops, deepJson };
}

function compileChildren(nodes, warnings) {
    return nodes.map(node => (node.type === 'text' ? compileText(node.text) : compileElement(node, warnings))).filter(Boolean);
}

function compileText(text) {
    const parts = parseInterpolation(text);
    return parts ? { kind: 'text', parts } : { kind: 'text', text };
}

function compileElement(node, warnings) {
    const { tag, svg } = node;
    const attrs = new Map(node.attrs);
    const take = name => {
        const value = attrs.get(name);
        attrs.delete(name);
        return value;
    };
    const out = {
        kind: 'element', tag, svg,
        attrs: [], dynamicAttrs: [], bindText: null, bindAttrs: [], vars: [], classes: [],
        each: null, cond: null, command: null, payload: null, draft: null, submit: null, widget: null, children: [],
    };

    const each = take('data-each');
    if (each !== undefined) {
        const match = /^\s*([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/.exec(each);
        if (!match || !isLoopName(match[2]) || (match[3] && (!isLoopName(match[3]) || match[3] === match[2]))) {
            warnings.push(`data-each="${each}" should read "list as name" or "list as name, index" (names other than state, q, draft, settings, fmt and the helpers); the element was left out.`);
            return null;
        }
        out.each = { list: compileExpr(match[1]), path: parsePath(match[1]), name: match[2], index: match[3] ?? null };
    }
    const cond = take('data-if');
    if (cond !== undefined) out.cond = compileExpr(cond);

    const bind = take('data-bind');
    if (bind !== undefined) out.bindText = compileExpr(bind);

    for (const [name, expr] of splitPairs(take('data-bind-attr'))) {
        const lower = name.toLowerCase();
        if (lower === 'style' || lower === 'class' || lower.startsWith('data-') || !attrAllowed(tag, svg, svg ? name : lower)) {
            warnings.push(`data-bind-attr cannot set ${name} on <${tag}>${lower === 'class' ? ' (use data-class)' : lower === 'style' ? ' (use data-bind-var)' : ''}.`);
            continue;
        }
        out.bindAttrs.push({ name: svg ? name : lower, expr: compileExpr(expr), boolean: BOOLEAN_ATTRS.has(lower) });
    }
    for (const [name, expr] of splitPairs(take('data-bind-var'))) {
        if (!/^--[A-Za-z0-9_-]+$/.test(name)) {
            warnings.push(`data-bind-var sets CSS custom properties only (--name); "${name}" was skipped.`);
            continue;
        }
        out.vars.push({ name, expr: compileExpr(expr) });
    }
    for (const [name, expr] of splitPairs(take('data-class'))) {
        if (!/^-?[A-Za-z_][\w-]*$/.test(name)) {
            warnings.push(`data-class "${name}" is not a class name.`);
            continue;
        }
        out.classes.push({ name, expr: compileExpr(expr) });
    }

    const command = attrs.get('data-command');
    const payload = take('data-payload');
    if ([payload, attrs.get('data-props')].some(text => text !== undefined && jsonDepth(text) > MAX_JSON_DEPTH)) out.deepJson = true;
    if (command !== undefined) {
        if (COMMAND_TYPE.test(command.trim())) {
            out.payload = payload === undefined ? null : compileJson(payload, warnings, `data-payload of ${command}`);
            // A payload that does not read as JSON leaves the button without its command.
            if (payload === undefined || out.payload) out.command = command.trim();
            else attrs.delete('data-command');
        } else {
            warnings.push(`data-command="${command}" is not a command name (module.action).`);
            attrs.delete('data-command');
        }
    } else if (payload !== undefined) warnings.push('data-payload without data-command was ignored.');

    const draft = attrs.get('data-draft');
    if (draft !== undefined) {
        const path = parsePath(draft.trim().replace(/^draft\./, ''));
        if (!DRAFT_TAGS.has(tag)) warnings.push(`data-draft belongs on an input, select or textarea, not <${tag}>.`);
        else if (!path) warnings.push(`data-draft="${draft}" is not a path.`);
        else {
            out.draft = { path, type: tag === 'input' ? (attrs.get('type') ?? 'text') : tag };
        }
    }

    const submit = attrs.get('data-submit');
    if (submit !== undefined) {
        if (COMMAND_TYPE.test(submit.trim())) out.submit = submit.trim();
        else {
            warnings.push(`data-submit="${submit}" is not a command name (module.action).`);
            attrs.delete('data-submit');
        }
    }

    if (tag === 'ss-widget') {
        const props = take('data-props');
        const name = (attrs.get('name') ?? '').trim();
        if (!name) warnings.push('An <ss-widget> has no name.');
        out.widget = { name, props: props === undefined ? null : compileJson(props, warnings, `data-props of ${name || 'a widget'}`) };
    } else if (attrs.has('data-props')) {
        take('data-props');
        warnings.push(`data-props belongs on <ss-widget>, not <${tag}>.`);
    }

    for (const name of BINDING_ATTRS) attrs.delete(name);
    for (const [name, value] of attrs) {
        const parts = name === 'style' ? null : parseInterpolation(value);
        if (parts) out.dynamicAttrs.push({ name, parts });
        else out.attrs.push([name, value]);
    }
    if (out.command && tag === 'button' && !attrs.has('type')) out.attrs.push(['type', 'button']);
    if (!out.bindText && !out.widget) out.children = compileChildren(node.children, warnings);
    return out;
}
