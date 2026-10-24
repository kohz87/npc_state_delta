// A small DOM for the tests of markup that is built with DOM APIs (createElement, className, dataset, setAttribute,
// textContent, append). serialize() gives the markup a reader would see: classes first, then data-* and attributes in the
// order they were set, text escaped. Not a browser: no layout, no style, no events beyond what the tests need.
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kebab = key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

function makeElement(doc, tag) {
    const classes = new Set();
    const attrs = {};
    const el = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        ownerDocument: doc,
        children: [],
        parentNode: null,
        dataset: {},
        value: '',
        text: '',
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        setAttribute(key, value) { attrs[key] = String(value); },
        getAttribute(key) { return key in attrs ? attrs[key] : null; },
        get textContent() { return this.text + this.children.map(child => child.textContent ?? '').join(''); },
        set textContent(value) { this.text = String(value); this.children = []; },
        append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } },
        replaceChildren(...items) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items); },
        serialize() {
            const cls = classes.size ? ` class="${esc([...classes].join(' '))}"` : '';
            const data = Object.entries(this.dataset).map(([key, value]) => ` data-${kebab(key)}="${esc(value)}"`).join('');
            const extra = Object.entries(attrs).map(([key, value]) => ` ${key}="${esc(value)}"`).join('');
            const name = this.tagName.toLowerCase();
            const value = this.tagName === 'INPUT' ? ` value="${esc(this.value)}"` : '';
            return `<${name}${cls}${data}${extra}${value}>${esc(this.text)}${this.children.map(child => child.serialize()).join('')}</${name}>`;
        },
    };
    const matchesSelector = (node, selector) => {
        const classesWanted = selector.replace(/\[[^\]]*\]/g, '').split('.').map(part => part.trim()).filter(Boolean);
        return node.nodeType === 1 && classesWanted.every(name => node.classList.contains(name));
    };
    const collect = (root, selector, first) => {
        const out = [];
        const walk = list => { for (const child of list) { if (matchesSelector(child, selector)) { out.push(child); if (first) return true; } if (walk(child.children)) return true; } return false; };
        walk(root.children);
        return out;
    };
    el.querySelector = selector => collect(el, selector, true)[0] ?? null;
    el.querySelectorAll = selector => collect(el, selector, false);
    el.contains = other => other === el || el.children.some(child => child.contains?.(other));
    el.addEventListener = () => {};
    el.focus = () => { doc.activeElement = el; };
    el.setSelectionRange = () => {};
    return el;
}

/**
 * A root element for a render under test: its innerHTML is the markup it was given plus its children serialised, so a test
 * reads what a reader sees. `extra` is merged in (for a test's own properties).
 */
export function fakeRoot(doc = fakeDocument(), extra = {}) {
    let html = '';
    const root = makeElement(doc, 'div');
    Object.defineProperty(root, 'innerHTML', {
        configurable: true,
        get: () => html + root.children.map(child => child.serialize()).join(''),
        set: value => { html = String(value); root.children = []; },
    });
    root.isConnected = true;
    root.firstElementChild = null;
    // The root's replaceChildren (what Story Block's tab host does before a render) empties the markup as well as the children.
    root.replaceChildren = (...items) => { html = ''; for (const child of root.children) child.parentNode = null; root.children = []; root.append(...items); };
    return Object.assign(root, extra);
}

/** A document for DOM-built markup: createElement and createTextNode. */
export function fakeDocument() {
    const doc = {
        createElement: tag => makeElement(doc, tag),
        createTextNode: text => ({ nodeType: 3, text: String(text), get textContent() { return this.text; }, serialize() { return esc(this.text); } }),
    };
    return doc;
}
