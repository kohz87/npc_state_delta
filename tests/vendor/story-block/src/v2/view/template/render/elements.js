// The template renderer's element block: it draws one element and patches its attributes, variables, classes, text and
// draft value only when they changed, and runs its commands and form submits. The widget block builds on it.

import { evalExpr, interpolate, pathKeys, toText, valueAtKeys } from '../../bind.js';
import { cssVarValue } from '../../css.js';
import { fillJson } from '../json.js';
import { classAllowed, isUrlAttr, urlAllowed } from '../sanitize.js';
import { call, dom, isDisabled, setDom } from './dom.js';
import { makeBlock } from './blocks.js';
import { PAINT_REFS, pageValue } from './page-ids.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SKIP = Symbol('skip');

function createElement(doc, node) {
    if (node.svg && typeof doc.createElementNS === 'function') return doc.createElementNS(SVG_NS, node.tag);
    return doc.createElement(node.tag);
}

const attrName = name => (name === 'xlink:href' ? 'href' : name);

export class ElementBlock {
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
