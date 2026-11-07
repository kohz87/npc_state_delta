// The template renderer's text, if and each blocks: each keeps its DOM nodes and updates only what changed.
// makeBlock/itemBlock choose the block for a compiled node; elements.js uses makeBlock for element children.

import { escapeKey } from '../../../ops.js';
import { evalExpr, interpolate, pointerOf, withItem } from '../../bind.js';
import { call } from './dom.js';
import { ElementBlock } from './elements.js';
import { WidgetBlock } from './widgets.js';

export function makeBlock(node, view) {
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
