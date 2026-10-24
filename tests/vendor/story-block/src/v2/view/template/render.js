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
// members it uses past any such control (`dom()` / `call()` below), so even a name that slips through
// cannot stop a form drawing or leave it busy. Classes SillyTavern acts on (sanitize.js RESERVED_CLASSES)
// are never set, bound or toggled.

import { escapeKey } from '../../ops.js';
import {
    evalExpr, interpolate, isLoopName, isScope, makeScope, pathKeys, pointerOf, resolvePath, setIn, toText, valueAtKeys,
    withDraft, withItem,
} from '../bind.js';
import { cssVarValue, templateIdPrefix } from '../css.js';

// A DOM member as the element's own interface has it, never a <form>'s control of that name or id: the
// prototype chain first (the browser's members live there), then the element's own property (the test
// DOM keeps some on the instance).
function descriptorOf(el, name) {
    for (let proto = Object.getPrototypeOf(el); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        const found = Object.getOwnPropertyDescriptor(proto, name);
        if (found) return found;
    }
    return Object.getOwnPropertyDescriptor(el, name) ?? null;
}
function dom(el, name) {
    const found = descriptorOf(el, name);
    if (!found) return undefined;
    return found.get ? found.get.call(el) : found.value;
}
function setDom(el, name, value) {
    const found = descriptorOf(el, name);
    if (found?.set) found.set.call(el, value);
    else el[name] = value;
}
const call = (el, name, ...args) => dom(el, name).apply(el, args);

// A control the reader cannot use (`:disabled`, so a disabled fieldset counts); a <form> never is.
function isDisabled(el) {
    try {
        const matches = dom(el, 'matches');
        if (typeof matches === 'function') return Boolean(matches.call(el, ':disabled'));
    } catch { /* a DOM without :disabled (the tests'): the property below */ }
    return dom(el, 'disabled') === true;
}

// The elements a control `name` is prefixed on (the form-associated ones a <form> exposes by name).
const CONTROLS = new Set(['input', 'select', 'textarea', 'button', 'fieldset', 'output', 'object']);

/** Set a value in a draft the host holds, creating records on the way (frozen ones are copied). */
function writeInPlace(target, keys, value) {
    if (keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) throw new Error(`"${keys.join('.')}" cannot be written.`);
    let node = target;
    for (const key of keys.slice(0, -1)) {
        const child = Object.hasOwn(node, key) ? node[key] : undefined;
        if (child && typeof child === 'object' && !Object.isFrozen(child)) node = child;
        else {
            node[key] = child && typeof child === 'object' ? (Array.isArray(child) ? [...child] : { ...child }) : {};
            node = node[key];
        }
    }
    node[keys[keys.length - 1]] = value;
}

function withItems(scope, names) {
    let next = scope;
    for (const [name, value] of Object.entries(names)) next = withItem(next, name, value);
    return next;
}
import { fillJson } from './json.js';
import { RESERVED_NAMES, classAllowed, cleanClasses, isUrlAttr, urlAllowed } from './sanitize.js';

// Attributes whose value is one id, or a space-separated list of ids, in the same template.
const ID_LISTS = new Set(['for', 'headers', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);
const PAINT_REFS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'filter']);

/** The id prefix for the screen a scope belongs to (`ss-t-` alone when no screen is named). */
const idPrefixOf = screenId => (typeof screenId === 'string' && screenId ? templateIdPrefix(screenId) : 'ss-t-');

// A screen is often drawn more than once at a time (a card under every reply, a tab and a hud), and
// ids and control names must not be shared between the copies (B-b5b-robust-r2-1: a label would check
// another copy's box, radios would be one group). The first copy of a screen on the page keeps the
// screen's ids (`ss-t-<screen>-<id>`); each other copy drawn at the same time adds `--c<n>`. A screen's
// CSS reaches every copy (css.js: `#id` is scoped to the screen's ids with or without the copy mark).
const COPIES = new Map();   // id prefix → the copy numbers drawn now

function takeCopy(prefix) {
    const taken = COPIES.get(prefix) ?? new Set();
    COPIES.set(prefix, taken);
    let n = 1;
    while (taken.has(n)) n += 1;
    taken.add(n);
    return n;
}

function freeCopy(prefix, n) {
    const taken = COPIES.get(prefix);
    taken?.delete(n);
    if (taken && !taken.size) COPIES.delete(prefix);
}

// `id` as drawn in this view: the screen's prefix, and the copy's mark after the first copy.
const pageId = (view, id) => `${view.idPrefix}${id}${view.copy > 1 ? `--c${view.copy}` : ''}`;

/**
 * The value an attribute is set to in the page: ids and references to them get the screen's prefix, class
 * lists lose reserved classes, reserved control names go. `null` leaves the attribute out.
 */
function pageValue(view, tag, name, value) {
    const lower = name.toLowerCase();
    if (lower === 'id') return value.trim() ? pageId(view, value.trim()) : null;
    if (ID_LISTS.has(lower)) return value.split(/\s+/).filter(Boolean).map(id => pageId(view, id)).join(' ');
    if ((lower === 'href' || lower === 'xlink:href') && /^\s*#./.test(value)) return `#${pageId(view, value.replace(/^\s*#/, ''))}`;
    if (PAINT_REFS.has(lower)) return value.replace(/url\(\s*(['"]?)\s*#([^)'"\s]*)/gi, (_, quote, id) => `url(${quote}#${pageId(view, id)}`);
    if (lower === 'class') {
        const classes = cleanClasses(value);
        if (classes.dropped.length) view.warn(`The class ${classes.dropped.join(', ')} was left off <${tag}>: SillyTavern acts on it.`);
        return classes.value;
    }
    if (lower === 'name' && tag !== 'ss-widget') {
        if (RESERVED_NAMES.has(value.trim())) {
            view.warn(`name="${value.trim()}" was left off <${tag}>: SillyTavern reads controls by that name.`);
            return null;
        }
        if (tag === 'form' || CONTROLS.has(tag)) return value.trim() ? pageId(view, value.trim()) : null;
    }
    return value;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// The most elements one render draws through its loops (View.spend).
export const MAX_ELEMENTS = 5000;
const COSTS = new WeakMap();

// The elements one item of a loop over `node` holds, not counting what inner loops draw.
function elementCost(node) {
    if (COSTS.has(node)) return COSTS.get(node);
    let cost = 0;
    const stack = [node];
    while (stack.length) {
        const next = stack.pop();
        if (next.kind !== 'element') continue;
        cost += 1;
        for (const child of next.children ?? []) if (!child.each) stack.push(child);
    }
    COSTS.set(node, cost);
    return cost;
}
const VIEWS = new WeakMap();
const SKIP = Symbol('skip');

/**
 * Render (or re-render) a compiled template into `el`. Options:
 * * `command(type, payload, { cause: 'ui' })` → promise of the command result (data-command, data-submit);
 * * `widgets` — `{ [name]: { render(el, props, api) } }`, a Map, or `name => def`;
 * * `evaluate(expr, scope)` — the condition language, for bindings that are not plain paths or helper calls;
 * * `onDraft(path, value, draft)` — told after an input changed the draft (the view re-renders itself);
 * * `onResult(result, { type, payload })` — told when a command finishes; `onWarn(message)`;
 * * `onSubmit(type, draft)` — when given, data-submit hands the draft here instead of running the command
 *   (a dialog that runs its own submit, e.g. "Next" on a wizard's earlier steps);
 * * `api` — extra widget api (`query`, `preview`, `commit`, `on`), `formatters` — for a scope built here;
 * * `screenId` — the screen whose id prefix the template's ids get (default: the scope's `screenId`).
 * `scope` is a scope from bind.js `makeScope`, or the fields makeScope takes (`{ state, q, draft, … }`);
 * a mount's scope `api` (`{ command, preview, commit, query, on }`) is used when `api` / `command` are not given.
 * Returns the view: `{ el, warnings, draft(), update(scope), destroy() }`.
 */
export function renderTemplate(el, compiled, scope, options = {}) {
    if (!el || typeof el !== 'object') throw new Error('renderTemplate needs an element to render into.');
    if (!compiled?.nodes) throw new Error('renderTemplate needs a template from compileTemplate.');
    let view = VIEWS.get(el);
    if (!view || view.compiled !== compiled) {
        view?.destroy();
        view = new View(el, compiled);
        VIEWS.set(el, view);
    }
    // The mounts hand their api in the scope (`scope.api`); explicit options win.
    const api = scope?.api && typeof scope.api === 'object' ? scope.api : null;
    const fromScope = api ? { api, command: typeof api.command === 'function' ? api.command.bind(api) : undefined } : {};
    view.options = { ...fromScope, ...Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined)) };
    view.update(scope);
    return view;
}

/** Take a rendered template out of `el` (widgets are told to clean up). */
export function destroyTemplate(el) {
    VIEWS.get(el)?.destroy();
}

class View {
    constructor(el, compiled) {
        this.el = el;
        this.compiled = compiled;
        this.options = {};
        this.doc = el.ownerDocument ?? globalThis.document;
        this.warnings = [...compiled.warnings];
        this.seen = new Set(this.warnings);
        this.seed = undefined;
        this.draftValue = {};
        this.stale = [];
        this.settling = false;
        this.base = null;
        this.blocks = null;
        this.idPrefix = null;
        this.copy = 0;
        this.spent = 0;
    }

    // Loop items a render may still draw (B-b5b-robust-r2-2): each costs the elements it holds outside
    // its own inner loops (whose items pay for themselves), so loops nested in loops cannot multiply past
    // MAX_ELEMENTS. False (and a warning) once the budget is spent.
    spend(node) {
        const cost = elementCost(node);
        if (this.spent + cost > MAX_ELEMENTS) {
            this.warn(`This screen would draw more than ${MAX_ELEMENTS} elements; the rest of a list was left out.`);
            return false;
        }
        this.spent += cost;
        return true;
    }

    warn(message) {
        if (this.seen.has(message)) return;
        this.seen.add(message);
        this.warnings.push(message);
        try {
            this.options.onWarn?.(message);
        } catch { /* a host callback never breaks rendering */ }
    }

    draft() {
        return this.draftValue;
    }

    /** The scope a render uses: the host's, with the view's own draft. */
    scopeFor(scope) {
        const base = isScope(scope) ? scope : this.rawScope(scope);
        if (scope?.draft !== this.seed) {
            // A draft the host holds (the dialog's) is filled in place, so the host always has the
            // reader's input; a frozen or missing one is copied on write and kept by the view.
            this.seed = scope?.draft;
            const given = scope?.draft && typeof scope.draft === 'object' && !Array.isArray(scope.draft) ? scope.draft : null;
            this.inPlace = Boolean(given) && !Object.isFrozen(given);
            this.draftValue = given ?? {};
        }
        return base.draft === this.draftValue ? base : withDraft(base, this.draftValue);
    }

    /**
     * A scope from plain fields: `{ state, q, draft, settings, query, changed | changes | ops, formatters,
     * …names }` (the mounts pass `changes`, the carrier's JSON Pointers, and `mount`, `index`, `screenId`, `api`).
     */
    rawScope(fields) {
        const { state, q, draft, settings, query, changed, changes, ops, formatters, ...names } = fields ?? {};
        const scope = makeScope({ state, q, draft, settings, query, changed: changed ?? changes, ops, formatters: formatters ?? this.options.formatters });
        const extra = Object.fromEntries(Object.entries(names).filter(([name]) => isLoopName(name)));
        return Object.keys(extra).length ? withItems(scope, extra) : scope;
    }

    update(scope) {
        if (this.destroyed) return;
        this.base = scope;
        this.spent = 0;
        const current = this.scopeFor(scope);
        const prefix = idPrefixOf(this.options.screenId ?? scope?.screenId);
        if (this.blocks && prefix !== this.idPrefix) {
            // Drawn for another screen: its ids are another screen's, so build again.
            for (const block of this.blocks) block.destroy();
            this.blocks = null;
        }
        if (prefix !== this.idPrefix) {
            if (this.copy) freeCopy(this.idPrefix, this.copy);
            this.copy = takeCopy(prefix);
        }
        this.idPrefix = prefix;
        if (!this.blocks) {
            this.el.replaceChildren();
            this.blocks = this.compiled.nodes.map(node => makeBlock(node, this));
            for (const block of this.blocks) for (const node of block.nodes()) this.el.appendChild(node);
        }
        this.stale = [];
        for (const block of this.blocks) block.update(current);
        // A select whose draft value is no longer one of its options (the option left with the data it came from) goes back to "no
        // choice": drawn once more with the draft cleared. One extra pass at most: a cleared value is never stale.
        if (this.stale.length && !this.settling) {
            const stale = this.stale;
            this.stale = [];
            this.settling = true;
            try {
                for (const keys of stale) this.writeDraft(keys, '');
                this.update(this.base);
            } finally {
                this.settling = false;
            }
        }
    }

    writeDraft(keys, value) {
        if (this.inPlace) writeInPlace(this.draftValue, keys, value);
        else this.draftValue = setIn(this.draftValue, keys, value);
        try {
            this.options.onDraft?.(keys.join('.'), value, this.draftValue);
        } catch (error) {
            this.warn(`onDraft failed: ${error?.message ?? error}`);
        }
    }

    setDraft(keys, value) {
        this.writeDraft(keys, value);
        this.update(this.base);
    }

    async run(type, payload, block) {
        const command = this.options.command;
        if (typeof command !== 'function') {
            this.warn(`No command runner is connected, so "${type}" cannot run here.`);
            return null;
        }
        let result;
        try {
            result = await command(type, payload, { cause: 'ui' });
        } catch (error) {
            result = { ok: false, code: 'FAILED', message: String(error?.message ?? error) };
        }
        try {
            this.options.onResult?.(result, { type, payload, element: block?.el ?? null });
        } catch { /* a host callback never breaks rendering */ }
        return result;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const block of this.blocks ?? []) block.destroy();
        this.blocks = null;
        if (this.copy) freeCopy(this.idPrefix, this.copy);
        this.copy = 0;
        if (VIEWS.get(this.el) === this) VIEWS.delete(this.el);
    }
}

function makeBlock(node, view) {
    if (node.kind === 'text') return new TextBlock(node, view);
    if (node.each) return new EachBlock(node, view);
    if (node.cond) return new IfBlock(node, view);
    return node.widget ? new WidgetBlock(node, view) : new ElementBlock(node, view);
}

/** The block for one item of a loop (or the element under an if). */
function itemBlock(node, view) {
    if (node.cond) return new IfBlock(node, view);
    return node.widget ? new WidgetBlock(node, view) : new ElementBlock(node, view);
}

// ---------------------------------------------------------------------------------------------------

class TextBlock {
    constructor(node, view) {
        this.node = node;
        this.view = view;
        this.text = node.parts ? '' : node.text;
        this.dom = view.doc.createTextNode(this.text);
    }
    nodes() { return [this.dom]; }
    update(scope) {
        if (!this.node.parts) return;
        const text = interpolate(this.node.parts, scope, this.view.options.evaluate, message => this.view.warn(message));
        if (text !== this.text) {
            this.text = text;
            this.dom.textContent = text;
        }
    }
    destroy() { this.dom.remove?.(); }
}

class IfBlock {
    constructor(node, view) {
        this.node = node;
        this.view = view;
        this.anchor = view.doc.createTextNode('');
        this.inner = null;
    }
    nodes() { return [...(this.inner ? this.inner.nodes() : []), this.anchor]; }
    update(scope) {
        const show = Boolean(evalExpr(this.node.cond, scope, this.view.options.evaluate, message => this.view.warn(message)));
        if (show && !this.inner) {
            this.inner = this.node.widget ? new WidgetBlock(this.node, this.view) : new ElementBlock(this.node, this.view);
            const parent = this.anchor.parentNode;
            for (const node of this.inner.nodes()) if (parent) call(parent, 'insertBefore', node, this.anchor);
        } else if (!show && this.inner) {
            this.inner.destroy();
            this.inner = null;
        }
        this.inner?.update(scope);
    }
    destroy() {
        this.inner?.destroy();
        this.inner = null;
        this.anchor.remove?.();
    }
}

class EachBlock {
    constructor(node, view) {
        this.node = node;
        this.view = view;
        this.anchor = view.doc.createTextNode('');
        this.items = new Map();
        this.order = [];
    }
    nodes() { return [...this.order.flatMap(key => this.items.get(key).nodes()), this.anchor]; }
    update(scope) {
        const { each } = this.node;
        const warn = message => this.view.warn(message);
        const list = evalExpr(each.list, scope, this.view.options.evaluate, warn);
        const entries = Array.isArray(list)
            ? list.map((item, index) => [index, item])
            : list && typeof list === 'object' ? Object.entries(list) : [];
        const listPointer = each.path ? pointerOf(scope, each.path) : null;
        const next = new Map();
        const order = [];
        for (const [entryKey, item] of entries) {
            if (!this.view.spend(this.node)) break;
            const id = item && typeof item === 'object' && (typeof item.id === 'string' || Number.isFinite(item.id)) ? `id:${item.id}` : `k:${entryKey}`;
            let key = id;
            for (let n = 2; next.has(key); n += 1) key = `${id}#${n}`;
            const pointer = listPointer === null ? null : `${listPointer}/${escapeKey(entryKey)}`;
            const itemScope = withItem(scope, each.name, item, pointer, each.index, entryKey);
            let block = this.items.get(key);
            if (!block) {
                block = itemBlock(this.node, this.view);
                block.fresh = true;
            }
            next.set(key, block);
            order.push(key);
            block.scope = itemScope;
        }
        for (const [key, block] of this.items) if (!next.has(key)) block.destroy();
        const parent = this.anchor.parentNode;
        const moved = order.length !== this.order.length || order.some((key, index) => key !== this.order[index]);
        if (moved && parent) {
            for (const key of order) for (const node of next.get(key).nodes()) call(parent, 'insertBefore', node, this.anchor);
        }
        this.items = next;
        this.order = order;
        for (const key of order) {
            const block = next.get(key);
            block.fresh = false;
            block.update(block.scope);
        }
    }
    destroy() {
        for (const block of this.items.values()) block.destroy();
        this.items.clear();
        this.order = [];
        this.anchor.remove?.();
    }
}

// ---------------------------------------------------------------------------------------------------

function createElement(doc, node) {
    if (node.svg && typeof doc.createElementNS === 'function') return doc.createElementNS(SVG_NS, node.tag);
    return doc.createElement(node.tag);
}

const attrName = name => (name === 'xlink:href' ? 'href' : name);

class ElementBlock {
    constructor(node, view) {
        this.node = node;
        this.view = view;
        this.values = new Map();
        this.scope = null;
        const el = createElement(view.doc, node);
        this.el = el;
        for (const [name, value] of node.attrs) {
            const shown = pageValue(view, node.tag, name, value);
            if (shown !== null) call(el, 'setAttribute', attrName(name), shown);
        }
        this.children = node.children.map(child => makeBlock(child, view));
        for (const child of this.children) for (const node of child.nodes()) call(el, 'appendChild', node);
        const listen = (type, fn) => call(el, 'addEventListener', type, fn);
        if (node.command) listen('click', event => this.onCommand(event));
        const form = node.tag === 'form' && !node.svg;
        if (node.submit) listen(form ? 'submit' : 'click', event => this.onSubmit(event));
        // A form without data-submit still never submits: the browser would load the page again.
        else if (form) listen('submit', event => event?.preventDefault?.());
        if (node.draft?.type === 'button') listen('click', event => this.onPick(event));
        else if (node.draft) {
            const handler = () => this.onInput();
            listen('input', handler);
            listen('change', handler);
        }
        if (node.draftClose) {
            listen('keydown', event => this.onCloseKey(event));
            listen('click', event => this.onCloseClick(event));
        }
    }
    nodes() { return [this.el]; }

    /** Set something only when its value changed since the last render. */
    changed(key, value) {
        if (this.values.has(key) && this.values.get(key) === value) return false;
        this.values.set(key, value);
        return true;
    }

    setAttr(name, value) {
        const { el, node } = this;
        if (value !== null && isUrlAttr(name) && !urlAllowed(node.tag, name, value)) {
            this.view.warn(PAINT_REFS.has(name.toLowerCase())
                ? `A bound ${name} on <${node.tag}> was not a colour or url(#id) and was left out.`
                : `A bound ${name} on <${node.tag}> was not https: (or a data: image) and was left out.`);
            value = null;
        }
        if (value !== null) value = pageValue(this.view, node.tag, name, value);
        if (!this.changed(`attr:${name}`, value)) return;
        if (value === null) call(el, 'removeAttribute', attrName(name));
        else call(el, 'setAttribute', attrName(name), value);
    }

    update(scope) {
        this.scope = scope;
        const { node, view, el } = this;
        const { evaluate } = view.options;
        const warn = message => view.warn(message);
        const read = expr => evalExpr(expr, scope, evaluate, warn);

        for (const { name, parts } of node.dynamicAttrs) this.setAttr(name, interpolate(parts, scope, evaluate, warn));
        for (const { name, expr, boolean } of node.bindAttrs) {
            const value = read(expr);
            if (boolean) {
                const on = Boolean(value);
                this.setAttr(name, on ? '' : null);
                if (name === 'checked' || name === 'selected' || name === 'disabled') setDom(el, name, on);
            } else this.setAttr(name, value === null || value === undefined || value === false ? null : toText(value));
        }
        for (const { name, expr } of node.vars) {
            const value = cssVarValue(read(expr));
            if (this.changed(`var:${name}`, value)) dom(el, 'style').setProperty(name, value);
        }
        for (const { name, expr } of node.classes) {
            if (!classAllowed(name)) {
                warn(`data-class cannot toggle ${name}: SillyTavern acts on it.`);
                continue;
            }
            const on = Boolean(read(expr));
            if (this.changed(`class:${name}`, on)) dom(el, 'classList').toggle(name, on);
        }
        if (node.bindText) {
            const text = toText(read(node.bindText));
            if (this.changed('text', text)) setDom(el, 'textContent', text);
        }
        for (const child of this.children) child.update(scope);
        if (node.draft) this.showDraft(scope);
    }

    // --- forms -------------------------------------------------------------------------------------

    draftKeys(scope = this.scope) {
        const keys = pathKeys(scope, this.node.draft.path);
        if (!keys) this.view.warn(`data-draft="${this.node.draft.path.source}" names a key that is not there.`);
        return keys;
    }

    showDraft(scope) {
        const { el, node } = this;
        const keys = this.draftKeys(scope);
        if (!keys) return;
        const value = valueAtKeys(this.view.draftValue, keys);
        const { type } = node.draft;
        if (type === 'button') return;
        const list = this.isList();
        if (type === 'checkbox') {
            el.checked = list ? Array.isArray(value) && value.map(String).includes(this.inputValue()) : Boolean(value);
            return;
        }
        if (type === 'radio') {
            el.checked = value !== undefined && value !== null && String(value) === this.inputValue();
            return;
        }
        // Leave a field alone while the reader is typing in it.
        if (this.view.doc?.activeElement === el) return;
        const text = value === null || value === undefined ? '' : toText(value);
        if (type === 'select' && text !== '' && !this.hasOption(text)) {
            this.view.stale.push(keys);
            return;
        }
        if (el.value !== text) el.value = text;
    }

    /** Whether this select has an option with that value (a select with no options yet is left alone: true). */
    hasOption(text) {
        const options = this.el.querySelectorAll?.('option') ?? [];
        if (!options.length) return true;
        return options.some(option => String(option.getAttribute('value') ?? option.textContent ?? '') === text);
    }

    /** A checkbox with a value (static or bound) collects a list; without one it is true/false. */
    isList() {
        const value = this.el.getAttribute('value');
        return this.node.draft.type === 'checkbox' && value !== null && value !== 'on';
    }

    inputValue() {
        const attr = this.el.getAttribute('value');
        return attr === null ? String(this.el.value ?? '') : attr;
    }

    readInput() {
        const { el, node } = this;
        const { type } = node.draft;
        const list = this.isList();
        if (type === 'checkbox') {
            if (!list) return Boolean(el.checked);
            const keys = this.draftKeys();
            const current = keys ? valueAtKeys(this.view.draftValue, keys) : undefined;
            const values = Array.isArray(current) ? current.filter(item => String(item) !== this.inputValue()) : [];
            return el.checked ? [...values, this.inputValue()] : values;
        }
        if (type === 'radio') return el.checked ? this.inputValue() : SKIP;
        if (type === 'number' || type === 'range') {
            const text = String(el.value ?? '').trim();
            if (text === '') return null;
            const number = Number(text);
            return Number.isFinite(number) ? number : SKIP;
        }
        return String(el.value ?? '');
    }

    onInput() {
        if (!this.scope) return;
        const keys = this.draftKeys();
        const value = this.readInput();
        if (!keys || value === SKIP) return;
        const before = valueAtKeys(this.view.draftValue, keys);
        if (before === value) return;
        this.view.setDraft(keys, value);
    }

    /** A button with data-draft and a value: a press picks that value, and a press on the picked one clears it (a disclosure's toggle). */
    onPick(event) {
        event?.preventDefault?.();
        if (!this.scope || isDisabled(this.el)) return;
        const keys = this.draftKeys();
        if (!keys) return;
        const value = this.el.getAttribute('value') ?? '';
        const before = valueAtKeys(this.view.draftValue, keys);
        this.view.setDraft(keys, before !== undefined && before !== null && String(before) === value ? '' : value);
    }

    /**
     * data-draft-close="path" on a container: Escape inside it, or a press on an inner [data-draft-cancel], clears that draft value (closes
     * the disclosure it holds). The focus goes first to the container's open toggle (aria-expanded="true"), so closing never drops it to
     * the page. Escape with nothing open is left alone (the window around may close).
     */
    closeDraft() {
        if (!this.scope || !this.node.draftClose) return false;
        const keys = pathKeys(this.scope, this.node.draftClose.path);
        const open = keys ? valueAtKeys(this.view.draftValue, keys) : undefined;
        if (open === undefined || open === null || open === '') return false;
        const opener = this.el.querySelectorAll('button[aria-expanded="true"]').find(node => !isDisabled(node));
        opener?.focus?.();
        this.view.setDraft(keys, '');
        return true;
    }

    onCloseKey(event) {
        if (event?.key !== 'Escape' || event.defaultPrevented) return;
        if (this.closeDraft()) {
            event.preventDefault?.();
            event.stopPropagation?.();
        }
    }

    onCloseClick(event) {
        const cancel = event?.target?.closest?.('[data-draft-cancel]');
        if (!cancel || !this.el.contains?.(cancel)) return;
        event.preventDefault?.();
        this.closeDraft();
    }

    // --- commands ----------------------------------------------------------------------------------

    // Marking the element busy is inside the try, so a mark that fails can never leave it busy for good.
    async busy(fn) {
        if (this.running) return;
        const { el } = this;
        try {
            this.running = true;
            dom(el, 'classList').add('ss-busy');
            call(el, 'setAttribute', 'aria-busy', 'true');
            await fn();
        } finally {
            this.running = false;
            try {
                dom(el, 'classList').remove('ss-busy');
                call(el, 'removeAttribute', 'aria-busy');
            } catch { /* the element is gone */ }
        }
    }

    onCommand(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!this.scope || isDisabled(this.el)) return undefined;
        const { node, view } = this;
        let payload = {};
        if (node.payload) {
            const filled = fillJson(node.payload, this.scope, view.options.evaluate, message => view.warn(message));
            if (!filled.ok) {
                view.warn(`The payload for ${node.command} could not be read: ${filled.error}`);
                return undefined;
            }
            payload = filled.value;
        }
        return this.busy(() => view.run(node.command, payload, this));
    }

    onSubmit(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!this.scope || isDisabled(this.el)) return undefined;
        const draft = structuredClone(this.view.draftValue);
        const onSubmit = this.view.options.onSubmit;
        if (typeof onSubmit === 'function') {
            try {
                onSubmit(this.node.submit, draft);
            } catch (error) {
                this.view.warn(`onSubmit failed: ${error?.message ?? error}`);
            }
            return undefined;
        }
        return this.busy(() => this.view.run(this.node.submit, draft, this));
    }

    destroy() {
        for (const child of this.children) child.destroy();
        const remove = dom(this.el, 'remove');
        if (typeof remove === 'function') remove.call(this.el);
    }
}

// ---------------------------------------------------------------------------------------------------

function findWidget(widgets, name) {
    if (!widgets || !name) return null;
    if (typeof widgets === 'function') return widgets(name) ?? null;
    if (widgets instanceof Map) return widgets.get(name) ?? null;
    return Object.hasOwn(widgets, name) ? widgets[name] : null;
}

let unstable = 0;
function stable(value) {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        unstable += 1;
        return `unstable:${unstable}`;   // props that cannot be compared always count as new
    }
}

/** `<ss-widget name="…" data-props='…'>`: the element is the widget's; the props come from the template. */
class WidgetBlock extends ElementBlock {
    constructor(node, view) {
        super({ ...node, children: [], draft: null, command: null, submit: null }, view);
        this.widgetNode = node;
        this.instance = null;
        this.key = null;
        this.def = undefined;
    }

    api() {
        const view = this.view;
        const block = this;
        return {
            ...(view.options.api ?? {}),
            command: (type, payload) => view.run(type, payload, block),
            /** Read a path in the scope the widget sits in. */
            resolve: path => resolvePath(block.scope, path),
            /** The dialog's draft: widgets inside a form (ss.stepper) read and write it here. */
            draft: {
                get: path => {
                    const keys = pathKeys(block.scope, String(path).replace(/^draft\./, ''));
                    return keys ? valueAtKeys(view.draftValue, keys) : undefined;
                },
                set: (path, value) => {
                    const keys = pathKeys(block.scope, String(path).replace(/^draft\./, ''));
                    if (keys) view.setDraft(keys, value);
                },
                value: () => view.draftValue,
            },
            /** ss.stepper's way to fill a draft field: `onDraft(name, value)`. */
            onDraft: (path, value) => {
                const keys = pathKeys(block.scope, String(path).replace(/^draft\./, ''));
                if (keys) view.setDraft(keys, value);
            },
        };
    }

    // Anything that goes wrong drawing the widget (props too odd to copy or compare, say) shows as the
    // widget's own "failed" note, never as an error out of renderTemplate (B-b5b-robust-r2-3).
    update(scope) {
        try {
            return this.draw(scope);
        } catch (error) {
            return this.fail(`The widget "${this.widgetNode.widget.name}" failed: ${error?.message ?? error}`);
        }
    }

    draw(scope) {
        super.update(scope);
        const { view, el } = this;
        const { name, props: compiledProps } = this.widgetNode.widget;
        const def = findWidget(view.options.widgets, name);
        let props = {};
        if (compiledProps) {
            const filled = fillJson(compiledProps, scope, view.options.evaluate, message => view.warn(message));
            if (!filled.ok) return this.fail(`The props for ${name} could not be read: ${filled.error}`);
            props = filled.value;
        }
        if (typeof props.bind === 'string') props.value = evalExpr(props.bind, scope, view.options.evaluate, message => view.warn(message));
        if (!def || typeof def.render !== 'function') return this.fail(`There is no widget called "${name}".`);
        const key = stable(props);
        if (def === this.def && key === this.key) return undefined;
        const first = def !== this.def;
        this.def = def;
        this.key = key;
        el.classList.remove('ss-widget-missing');
        this.failed = null;
        try {
            if (!first && typeof this.instance?.update === 'function') this.instance.update(props);
            else {
                this.cleanup();
                el.replaceChildren();
                this.instance = def.render(el, props, this.api()) ?? null;
            }
        } catch (error) {
            this.fail(`The widget "${name}" failed: ${error?.message ?? error}`);
        }
        return undefined;
    }

    fail(message) {
        this.view.warn(message);
        this.cleanup();
        this.def = null;
        this.key = null;
        if (this.failed === message) return;
        this.failed = message;
        this.el.classList.add('ss-widget-missing');
        this.el.textContent = message;
    }

    cleanup() {
        try {
            this.instance?.destroy?.();
        } catch { /* a widget's cleanup never breaks rendering */ }
        this.instance = null;
    }

    destroy() {
        this.cleanup();
        super.destroy();
    }
}
