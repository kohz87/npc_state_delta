// The template renderer's widget block: it draws the widget for <ss-widget>, fills its props, hands each widget the
// view's api, and keeps the widget instance while its definition and props stay the same.

import { evalExpr, pathKeys, resolvePath, valueAtKeys } from '../../bind.js';
import { fillJson } from '../json.js';
import { ElementBlock } from './elements.js';

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
export class WidgetBlock extends ElementBlock {
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
            get command() { return typeof view.options.command === 'function' ? (type, payload) => view.run(type, payload, block) : undefined; },
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
        const key = `${stable(props)}:${typeof view.options.command === 'function'}`;
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
