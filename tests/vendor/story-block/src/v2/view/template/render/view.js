// The template renderer's view: it keeps the rendered blocks, drafts and screen ids for one element, and
// renderTemplate/destroyTemplate own the one view each element has. The blocks and widgets it draws live in
// blocks.js, elements.js and widgets.js.

import { isLoopName, isScope, makeScope, setIn, withDraft, withItem } from '../../bind.js';
import { freeCopy, idPrefixOf, takeCopy } from './page-ids.js';
import { makeBlock } from './blocks.js';

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
