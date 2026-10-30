// renderLayout(el, layout, { query, command, evaluate, widgets, preview?, commit?, on?, onDraft? }) draws a validated layout
// into any element: a sidebar tab, an overlay page, a card under a reply. What it shows
// comes only from `query` (so a card for an older reply passes a query over that reply's
// state); buttons go only through `command` (leave it out for a read-only view).
//
// Everything a layout or a query supplies is set with textContent or a checked
// attribute; nothing is parsed as markup. Class names start with `ss-l-`.

import { el, stop } from '../../ui/dom.js';
import { LIMITS, NODE_TYPES, TONES, isBinding, itemRef, getPath, imageUrlError } from './schema.js';
import { validateLayout, widgetRegistry } from './validate.js';
import { editable } from '../view/widgets/editable.js';

// Which page each tabs node shows, per mount element, so a redraw keeps the reader's choice.
const pageMemory = new WeakMap();

function memoryFor(host, layoutId) {
    let entry = pageMemory.get(host);
    if (!entry || entry.id !== (layoutId ?? null)) {
        entry = { id: layoutId ?? null, pages: new Map() };
        pageMemory.set(host, entry);
    }
    return entry.pages;
}

const isObject = value => value !== null && typeof value === 'object';

function problem(ctx, where, message) {
    const line = `${where}: ${message}`;
    if (!ctx.problems.includes(line) && ctx.problems.length < 100) ctx.problems.push(line);
}

// `$item` strings replaced by the row's values, everything else copied.
function resolveDeep(value, scope) {
    const ref = itemRef(value);
    if (ref) return copy(ref.index ? scope.index : getPath(scope.item, ref.path));
    if (Array.isArray(value)) return value.map(child => resolveDeep(child, scope));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveDeep(child, scope)]));
    return value;
}

function copy(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

function runBinding(binding, ctx, scope, where) {
    if (typeof ctx.query !== 'function') {
        problem(ctx, where, 'there is no data to show here');
        return undefined;
    }
    const args = binding.args === undefined ? {} : resolveDeep(binding.args, scope);
    const key = `${binding.query}\u0000${JSON.stringify(args)}`;
    if (!ctx.cache.has(key)) {
        let result;
        try {
            result = ctx.query(binding.query, args);
            if (result && typeof result.then === 'function') {
                problem(ctx, where, `query ${binding.query} answered later; layouts need an answer straight away`);
                result = undefined;
            }
        } catch (error) {
            problem(ctx, where, `query ${binding.query} failed: ${error?.message ?? error}`);
            result = undefined;
        }
        ctx.cache.set(key, result);
    }
    return getPath(ctx.cache.get(key), binding.path ?? '');
}

function resolve(value, ctx, scope, where) {
    const ref = itemRef(value);
    if (ref) return ref.index ? scope.index : getPath(scope.item, ref.path);
    if (isBinding(value)) return runBinding(value, ctx, scope, where);
    return value;
}

function toText(value, ctx, where) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value) && value.every(item => !isObject(item))) return value.map(item => toText(item, ctx, where)).filter(Boolean).join(', ');
    problem(ctx, where, 'a list or record can\'t be shown as text (add a path to one field)');
    return '';
}

const make = (ctx, tag, className, text) => el(tag, className, text, ctx.doc);

function toneClass(tone) {
    return typeof tone === 'string' && TONES.includes(tone) ? ` ss-l-tone-${tone}` : '';
}

function labelled(ctx, node, className, label, text) {
    const out = make(ctx, node, className);
    if (label) {
        out.appendChild(make(ctx, 'span', 'ss-l-label', label));
        out.appendChild(make(ctx, 'span', 'ss-l-value', text));
    } else if (text) out.textContent = text;
    return out;
}

function appendChildren(parent, children, ctx, scope, where) {
    (children ?? []).forEach((child, index) => {
        const node = renderNode(child, ctx, scope, `${where}.children[${index}]`);
        if (node) parent.appendChild(node);
    });
    return parent;
}

const RENDER = {
    box(node, ctx, scope, where) {
        const out = make(ctx, 'div', 'ss-l-box');
        if (node.title !== undefined) {
            const title = toText(resolve(node.title, ctx, scope, `${where}.title`), ctx, `${where}.title`);
            if (title) out.appendChild(make(ctx, 'div', 'ss-l-box-title', title));
        }
        return appendChildren(out, node.children, ctx, scope, where);
    },
    row: (node, ctx, scope, where) => appendChildren(make(ctx, 'div', 'ss-l-row'), node.children, ctx, scope, where),
    col: (node, ctx, scope, where) => appendChildren(make(ctx, 'div', 'ss-l-col'), node.children, ctx, scope, where),
    grid(node, ctx, scope, where) {
        const out = make(ctx, 'div', 'ss-l-grid');
        out.style.setProperty('--ss-l-cols', String(node.cols));
        return appendChildren(out, node.children, ctx, scope, where);
    },

    text(node, ctx, scope, where) {
        const value = resolve(node.bind ?? node.value, ctx, scope, where);
        const label = node.label === undefined ? '' : toText(resolve(node.label, ctx, scope, `${where}.label`), ctx, `${where}.label`);
        return labelled(ctx, 'div', `ss-l-text ss-l-text-${node.variant ?? 'body'}`, label, toText(value, ctx, where));
    },

    badge(node, ctx, scope, where) {
        const value = resolve(node.bind ?? node.value, ctx, scope, where);
        const tone = node.tone === undefined ? 'neutral' : resolve(node.tone, ctx, scope, `${where}.tone`);
        const label = node.label === undefined ? '' : toText(resolve(node.label, ctx, scope, `${where}.label`), ctx, `${where}.label`);
        const text = toText(value, ctx, where);
        if (!text && !label) return null;
        return labelled(ctx, 'span', `ss-l-badge${toneClass(tone) || ' ss-l-tone-neutral'}`, label, text);
    },

    meter(node, ctx, scope, where) {
        let value = resolve(node.bind ?? node.value, ctx, scope, where);
        let max = node.max === undefined ? undefined : resolve(node.max, ctx, scope, `${where}.max`);
        // A bound pool like hp: { cur, max } fills both.
        if (isObject(value) && !Array.isArray(value)) {
            if (max === undefined) max = value.max;
            value = value.cur ?? value.value;
        }
        const numbers = typeof value === 'number' && Number.isFinite(value) && typeof max === 'number' && Number.isFinite(max);
        if (!numbers && (value !== undefined || max !== undefined)) problem(ctx, where, 'a meter needs a number and a maximum');
        const label = node.label === undefined ? '' : toText(resolve(node.label, ctx, scope, `${where}.label`), ctx, `${where}.label`);
        const tone = node.tone === undefined ? '' : resolve(node.tone, ctx, scope, `${where}.tone`);
        const percent = numbers && max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

        const out = make(ctx, 'div', `ss-l-meter${toneClass(tone)}`);
        out.setAttribute('role', 'meter');
        out.setAttribute('aria-valuemin', '0');
        if (numbers) {
            out.setAttribute('aria-valuemax', String(max));
            out.setAttribute('aria-valuenow', String(value));
        }
        if (label) out.setAttribute('aria-label', label);
        const head = make(ctx, 'div', 'ss-l-meter-head');
        if (label) head.appendChild(make(ctx, 'span', 'ss-l-label', label));
        head.appendChild(make(ctx, 'span', 'ss-l-meter-num', numbers ? `${value} / ${max}` : '—'));
        const bar = make(ctx, 'div', 'ss-l-meter-bar');
        const fill = make(ctx, 'div', 'ss-l-meter-fill');
        fill.style.width = `${Math.round(percent * 10) / 10}%`;
        bar.appendChild(fill);
        out.appendChild(head);
        out.appendChild(bar);
        return out;
    },

    image(node, ctx, scope, where) {
        const src = resolve(node.bind ?? node.src, ctx, scope, where);
        if (src === undefined || src === null || src === '') return null;
        const error = imageUrlError(src);
        if (error) {
            problem(ctx, where, error);
            return null;
        }
        const out = make(ctx, 'img', `ss-l-image ss-l-image-${node.size ?? 'medium'}`);
        out.setAttribute('src', src);
        out.setAttribute('alt', node.alt === undefined ? '' : toText(resolve(node.alt, ctx, scope, `${where}.alt`), ctx, `${where}.alt`));
        out.setAttribute('loading', 'lazy');
        out.setAttribute('decoding', 'async');
        out.setAttribute('referrerpolicy', 'no-referrer');
        return out;
    },

    list(node, ctx, scope, where) {
        let items = resolve(node.bind, ctx, scope, where);
        if (items === undefined || items === null) items = [];
        else if (!Array.isArray(items)) {
            if (isObject(items)) items = Object.values(items);  // records keyed by ID, in stored order
            else {
                problem(ctx, where, 'a list needs a list or a record to show');
                items = [];
            }
        }
        const limit = node.limit ?? LIMITS.listItems;
        const out = make(ctx, 'ul', 'ss-l-list');
        items.slice(0, limit).forEach((item, index) => {
            const row = make(ctx, 'li', 'ss-l-item');
            const child = renderNode(node.item, ctx, { item, index }, `${where}.item[${index}]`);
            if (child) row.appendChild(child);
            out.appendChild(row);
        });
        if (!items.length && node.empty !== undefined) {
            const empty = toText(resolve(node.empty, ctx, scope, `${where}.empty`), ctx, `${where}.empty`);
            if (empty) out.appendChild(make(ctx, 'li', 'ss-l-empty', empty));
        }
        if (items.length > limit) out.appendChild(make(ctx, 'li', 'ss-l-more', `and ${items.length - limit} more`));
        return out;
    },

    button(node, ctx, scope, where) {
        const label = toText(resolve(node.label, ctx, scope, `${where}.label`), ctx, `${where}.label`);
        const tone = node.tone === undefined ? '' : resolve(node.tone, ctx, scope, `${where}.tone`);
        const out = make(ctx, 'span', 'ss-l-action');
        const button = make(ctx, 'button', `ss-l-button${toneClass(tone)}`);
        button.type = 'button';
        if (node.icon) {
            const glyph = make(ctx, 'i', `fa-solid ${node.icon}`);
            glyph.setAttribute('aria-hidden', 'true');
            button.appendChild(glyph);
        }
        button.appendChild(make(ctx, 'span', 'ss-l-button-label', label));
        const status = make(ctx, 'span', 'ss-l-status');
        status.setAttribute('role', 'status');
        out.appendChild(button);
        out.appendChild(status);

        // The payload is fixed when the row is drawn: a click acts on what the reader saw.
        const payload = node.payload === undefined ? {} : resolveDeep(node.payload, scope);
        const command = ctx.command;
        if (typeof command !== 'function') {
            button.disabled = true;
            button.title = 'Not available here';
            return out;
        }
        button.addEventListener('click', stop(async () => {
            if (button.disabled) return;
            button.disabled = true;
            status.textContent = '';
            try {
                const result = await command(node.command, copy(payload) ?? {});
                if (result && result.ok === false) status.textContent = String(result.message || 'That did not work.');
            } catch (error) {
                status.textContent = String(error?.message || 'That did not work.');
            } finally {
                button.disabled = false;
            }
        }));
        return out;
    },

    tabs(node, ctx, scope, where) {
        const out = make(ctx, 'div', 'ss-l-tabs');
        const bar = make(ctx, 'div', 'ss-l-tabbar');
        bar.setAttribute('role', 'tablist');
        const panel = make(ctx, 'div', 'ss-l-tabpanel');
        panel.setAttribute('role', 'tabpanel');
        const pages = node.pages;
        const buttons = pages.map((page, index) => {
            const title = toText(resolve(page.title, ctx, scope, `${where}.pages[${index}].title`), ctx, where);
            const button = make(ctx, 'button', 'ss-l-tab', title || `Page ${index + 1}`);
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.addEventListener('click', stop(() => {
                ctx.pages.set(where, index);
                // A page drawn later reads the data as it is then.
                ctx.cache = new Map();
                ctx.count = 0;
                show(index);
            }));
            bar.appendChild(button);
            return button;
        });
        const show = index => {
            buttons.forEach((button, at) => {
                button.classList.toggle('ss-l-tab-active', at === index);
                button.setAttribute('aria-selected', at === index ? 'true' : 'false');
            });
            const child = renderNode(pages[index].node, ctx, scope, `${where}.pages[${index}].node`);
            panel.replaceChildren(...(child ? [child] : []));
        };
        const saved = ctx.pages.get(where);
        show(Number.isInteger(saved) && saved >= 0 && saved < pages.length ? saved : 0);
        out.appendChild(bar);
        out.appendChild(panel);
        return out;
    },

    when(node, ctx, scope, where) {
        if (typeof ctx.evaluate !== 'function') {
            problem(ctx, where, 'conditions can\'t be checked here, so this part is hidden');
            return null;
        }
        let met = false;
        try {
            const result = ctx.evaluate(node.cond, { item: scope.item, index: scope.index, query: ctx.query });
            if (result && typeof result.then === 'function') problem(ctx, where, 'a condition must answer straight away');
            else met = Boolean(result);
        } catch (error) {
            problem(ctx, where, `the condition failed: ${error?.message ?? error}`);
        }
        if (!met) return null;
        return appendChildren(make(ctx, 'div', 'ss-l-when'), node.children, ctx, scope, where);
    },
};

function renderWidget(widget, node, ctx, scope, where) {
    const out = make(ctx, 'div', 'ss-l-widget');
    out.dataset.widget = node.type;
    const props = node.props === undefined ? {} : resolveDeep(node.props, scope);
    if (node.bind !== undefined) props.value = copy(resolve(node.bind, ctx, scope, `${where}.bind`));
    const api = { query: ctx.query, command: ctx.command, evaluate: ctx.evaluate, ...ctx.extra, item: copy(scope.item), index: scope.index };
    try {
        const handle = widget.render(out, props, api);
        // Kept, so the layout can take the widget down (its observers, its modal layer) when it is drawn again or disposed.
        if (handle && (typeof handle === 'function' || typeof handle.destroy === 'function')) ctx.handles?.push(handle);
    } catch (error) {
        problem(ctx, where, `widget ${node.type} failed: ${error?.message ?? error}`);
        out.replaceChildren();
    }
    return out;
}

function renderNode(node, ctx, scope, where) {
    ctx.count += 1;
    if (ctx.count > LIMITS.rendered) {
        problem(ctx, 'layout', `there are more than ${LIMITS.rendered} parts to draw; the rest is left out`);
        return null;
    }
    if (Object.hasOwn(NODE_TYPES, node.type)) return RENDER[node.type](node, ctx, scope, where);
    return renderWidget(ctx.widgets[node.type], node, ctx, scope, where);
}

/** Replace `host`'s content with the reasons a layout can't be shown. → { ok: false, errors, problems: [] } */
export function showErrors(host, errors) {
    host.replaceChildren(invalid(host.ownerDocument ?? globalThis.document, errors));
    return { ok: false, errors, problems: [] };
}

function invalid(doc, errors) {
    const out = el('div', 'ss-l-root ss-l-invalid', '', doc);
    out.appendChild(el('p', 'ss-l-invalid-title', 'This screen can\'t be shown:', doc));
    const list = el('ul', 'ss-l-invalid-list', '', doc);
    for (const error of errors.slice(0, 10)) list.appendChild(el('li', '', error, doc));
    if (errors.length > 10) list.appendChild(el('li', '', `and ${errors.length - 10} more`, doc));
    out.appendChild(list);
    return out;
}

/**
 * Draw `layout` into `host` (its old content is replaced).
 * → { ok, errors, problems }: `errors` from validateLayout (nothing drawn but the list
 * of them); `problems` are what went wrong while drawing (a failed query, a bad image
 * from a query, a condition that could not be checked), each with its place.
 */
// The widgets each host's layout drew (their handles: destroy(), or the function they returned). A layout drawn again into the host
// takes the last drawing's down first; the owner of the host calls the `dispose` renderLayout returns when it takes the layout away.
const DRAWN = new WeakMap();
function takeDown(handles) {
    for (const handle of handles) {
        try {
            if (typeof handle === 'function') handle();
            else handle?.destroy?.();
        } catch { /* a widget's cleanup failing must not block the next draw */ }
    }
}

export function renderLayout(host, layout, { query, command, evaluate, widgets, preview, commit, on, onDraft } = {}) {
    const doc = host?.ownerDocument ?? globalThis.document;
    takeDown(DRAWN.get(host) ?? []);
    DRAWN.delete(host);
    const registry = widgetRegistry({ 'ss.editable': editable, ...widgets });
    const errors = validateLayout(layout, { widgets: registry, meta: false });
    if (errors.length) return showErrors(host, errors);
    const ctx = {
        doc, query, command, evaluate, widgets: registry,
        // Passed on to widgets only (SPEC §13.5); built-in nodes use query, command, evaluate.
        extra: Object.fromEntries(Object.entries({ preview, commit, on, onDraft }).filter(([, fn]) => typeof fn === 'function')),
        problems: [], cache: new Map(), count: 0, pages: memoryFor(host, layout.id), handles: [],
    };
    const root = el('div', 'ss-l-root', '', doc);
    if (layout.id !== undefined) root.dataset.layout = layout.id;
    // Theme tokens live on this root only, so two layouts on one page never mix.
    for (const [name, value] of Object.entries(layout.theme?.tokens ?? {})) root.style.setProperty(`--ss-l-${name}`, String(value));
    const child = renderNode(layout.root, ctx, { item: undefined, index: undefined }, 'root');
    if (child) root.appendChild(child);
    host.replaceChildren(root);
    DRAWN.set(host, ctx.handles);
    return {
        ok: true,
        errors: [],
        problems: ctx.problems,
        /** Takes the widgets this drawing made down (their listeners, observers and any layer they opened). */
        dispose() {
            takeDown(ctx.handles);
            if (DRAWN.get(host) === ctx.handles) DRAWN.delete(host);
        },
    };
}
