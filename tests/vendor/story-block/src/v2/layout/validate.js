// validateLayout(layout, { widgets, meta }) → string[]: every reason a layout can't be shown,
// each a plain sentence that starts with where the problem is (`root.children[2]: …`).
// An empty list means the layout is safe to render.

import {
    LIMITS, NODE_TYPES, TONES, TEXT_VARIANTS, IMAGE_SIZES, TOKENS,
    QUERY_NAME, COMMAND_NAME, WIDGET_NAME, LAYOUT_ID, ICON, TOKEN_NAME,
    isPlainObject, isBinding, itemRef, pathError, imageUrlError, tokenValueError,
} from './schema.js';

const MAX_ERRORS = 50;
const LAYOUT_KEYS = new Set(['id', 'title', 'icon', 'theme', 'root']);
const BINDING_KEYS = new Set(['query', 'args', 'path']);
const WIDGET_KEYS = new Set(['type', 'props', 'bind']);

// Plain JSON only: no functions, no class instances, no loops, no NaN.
function jsonError(value, stack = []) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? '' : 'holds a number that is not finite';
    if (typeof value !== 'object') return `holds a ${typeof value}, which is not JSON`;
    if (stack.includes(value)) return 'refers to itself (a loop)';
    if (stack.length > 64) return 'is nested too deeply';
    if (!Array.isArray(value) && !isPlainObject(value)) return 'holds an object that is not plain JSON';
    stack.push(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const error = jsonError(child, stack);
        if (error) {
            stack.pop();
            return error;
        }
    }
    stack.pop();
    return '';
}

// `$item` strings anywhere inside a payload or args.
function itemRefErrors(value, where, inList, report) {
    if (typeof value === 'string') {
        const ref = itemRef(value);
        if (!ref) return;
        if (!inList) report(where, `"${value}" refers to a list row but is not inside a list's item`);
        else if (ref.path) {
            const error = pathError(ref.path);
            if (error) report(where, error);
        }
        return;
    }
    if (Array.isArray(value)) value.forEach((child, index) => itemRefErrors(child, `${where}[${index}]`, inList, report));
    else if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) itemRefErrors(child, `${where}.${key}`, inList, report);
}

function checkBinding(binding, where, inList, report) {
    for (const key of Object.keys(binding)) if (!BINDING_KEYS.has(key)) report(where, `a binding has no field "${key}" (only query, args, path)`);
    if (!QUERY_NAME.test(binding.query)) report(where, `"${binding.query}" is not a query name`);
    if (binding.args !== undefined) {
        if (!isPlainObject(binding.args)) report(`${where}.args`, 'args must be an object');
        else itemRefErrors(binding.args, `${where}.args`, inList, report);
    }
    if (binding.path !== undefined) {
        const error = pathError(binding.path);
        if (error) report(`${where}.path`, error);
    }
}

// A value field: a literal, an `$item` reference, or a binding.
function checkValue(value, where, inList, report, { literal = 'any' } = {}) {
    const ref = itemRef(value);
    if (ref) return itemRefErrors(value, where, inList, report);
    if (isPlainObject(value)) {
        if (!('query' in value)) return report(where, 'an object here must be a binding with a "query"');
        return isBinding(value) ? checkBinding(value, where, inList, report) : report(where, 'a binding\'s "query" must be a string');
    }
    if (literal === 'bindingOnly') return report(where, 'must be a binding ({ query, args, path }) or an $item reference');
    if (literal === 'image' && typeof value !== 'string') return report(where, imageUrlError(value));
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') return Number.isFinite(value) ? undefined : report(where, 'must be a finite number');
    if (typeof value !== 'string') return report(where, 'must be text, a number, an $item reference or a binding');
    if (value.length > LIMITS.text) report(where, `text is longer than ${LIMITS.text} characters`);
    if (literal === 'tone' && !TONES.includes(value)) report(where, `"${value}" is not a tone (${TONES.join(', ')})`);
    if (literal === 'image') {
        const error = imageUrlError(value);
        if (error) report(where, error);
    }
}

// Widgets come from installed code; a name that clashes with a built-in node type, or
// an entry without a render function, is left out (the built-in always wins).
export function widgetRegistry(widgets) {
    const out = {};
    if (!widgets || typeof widgets !== 'object') return out;
    for (const [name, widget] of Object.entries(widgets)) {
        if (!WIDGET_NAME.test(name) || Object.hasOwn(NODE_TYPES, name)) continue;
        if (typeof widget?.render === 'function') out[name] = widget;
    }
    return out;
}

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function validateLayout(layout, options = {}) {
    const widgets = widgetRegistry(options?.widgets);
    const errors = [];
    const report = (where, message) => {
        if (errors.length < MAX_ERRORS) errors.push(`${where}: ${message}`);
    };

    if (!isPlainObject(layout)) return ['layout: must be an object'];
    const json = jsonError(layout);
    if (json) return [`layout: ${json}`];
    const bytes = JSON.stringify(layout).length;
    if (bytes > LIMITS.bytes) return [`layout: is ${Math.ceil(bytes / 1024)} KB, more than the ${LIMITS.bytes / 1024} KB a layout may be`];

    // id, title and icon name a tab; a screen's `layout: { root }` (SPEC §13.1) has them on the
    // screen instead, so `meta: false` checks them only when they are there.
    const meta = options?.meta !== false;
    for (const key of Object.keys(layout)) if (!LAYOUT_KEYS.has(key)) report('layout', `has no field "${key}" (only id, title, icon, theme, root)`);
    if ((meta || layout.id !== undefined) && (typeof layout.id !== 'string' || !LAYOUT_ID.test(layout.id))) report('layout.id', 'must be a short lowercase id (letters, digits, . _ / -)');
    if ((meta || layout.title !== undefined) && (typeof layout.title !== 'string' || !layout.title.trim() || layout.title.length > 60)) report('layout.title', 'must be text of 1 to 60 characters');
    if ((meta || layout.icon !== undefined) && (typeof layout.icon !== 'string' || !ICON.test(layout.icon))) report('layout.icon', 'must be a Font Awesome icon name like fa-box');

    if (layout.theme !== undefined) {
        if (!isPlainObject(layout.theme)) report('layout.theme', 'must be an object');
        else {
            for (const key of Object.keys(layout.theme)) if (key !== 'tokens') report('layout.theme', `has no field "${key}" (only tokens)`);
            const tokens = layout.theme.tokens;
            if (tokens !== undefined && !isPlainObject(tokens)) report('layout.theme.tokens', 'must be an object');
            else for (const [name, value] of Object.entries(tokens ?? {})) {
                const where = `layout.theme.tokens.${name}`;
                if (!TOKEN_NAME.test(name) || !TOKENS.includes(name)) report(where, `"${name}" is not a theme token (${TOKENS.join(', ')})`);
                const error = tokenValueError(value);
                if (error) report(where, error);
            }
        }
    }

    let count = 0;
    const visit = (node, where, depth, inList) => {
        if (errors.length >= MAX_ERRORS) return;
        count += 1;
        if (count === LIMITS.nodes + 1) report(where, `the layout has more than ${LIMITS.nodes} nodes`);
        if (count > LIMITS.nodes) return;
        if (depth > LIMITS.depth) return report(where, `nodes are nested more than ${LIMITS.depth} deep`);
        if (!isPlainObject(node)) return report(where, 'must be a node object with a "type"');
        if (typeof node.type !== 'string') return report(where, 'a node needs a "type"');

        const spec = Object.hasOwn(NODE_TYPES, node.type) ? NODE_TYPES[node.type] : null;
        if (!spec) {
            const widget = WIDGET_NAME.test(node.type) && Object.hasOwn(widgets, node.type) ? widgets[node.type] : null;
            if (!widget) return report(where, `"${node.type}" is not a node type`);
            for (const key of Object.keys(node)) if (!WIDGET_KEYS.has(key)) report(where, `widget "${node.type}" has no field "${key}" (only props, bind)`);
            if (node.props !== undefined && !isPlainObject(node.props)) report(`${where}.props`, 'must be an object');
            else if (node.props) itemRefErrors(node.props, `${where}.props`, inList, report);
            if (node.bind !== undefined) checkValue(node.bind, `${where}.bind`, inList, report, { literal: 'bindingOnly' });
            if (typeof widget.validate === 'function') {
                let found = [];
                try {
                    found = widget.validate(node.props ?? {}) ?? [];
                } catch (error) {
                    found = [`its check failed (${error?.message ?? error})`];
                }
                for (const message of found) report(where, String(message));
            }
            return;
        }

        const allowed = new Set(['type', ...Object.keys(spec.fields), ...(spec.main ? ['bind'] : [])]);
        for (const key of Object.keys(node)) if (!allowed.has(key)) report(where, `a ${node.type} has no field "${key}"`);
        for (const key of spec.required ?? []) if (node[key] === undefined) report(where, `a ${node.type} needs "${key}"`);
        if (spec.main && spec.main !== 'items') {
            const hasMain = node[spec.main] !== undefined;
            const hasBind = node.bind !== undefined;
            if (hasMain && hasBind) report(where, `a ${node.type} takes "${spec.main}" or "bind", not both`);
            if (!hasMain && !hasBind) report(where, `a ${node.type} needs "${spec.main}" or "bind"`);
        }
        if (node.type === 'meter' && node.value !== undefined && node.max === undefined) report(where, 'a meter with a "value" needs a "max"');
        if (node.bind !== undefined) checkValue(node.bind, `${where}.bind`, inList, report, { literal: 'bindingOnly' });

        for (const [key, kind] of Object.entries(spec.fields)) {
            const value = node[key];
            if (value === undefined) continue;
            const at = `${where}.${key}`;
            if (kind === 'value') {
                const literal = key === 'tone' ? 'tone' : key === 'src' ? 'image' : 'any';
                checkValue(value, at, inList, report, { literal });
            } else if (kind === 'variant') {
                if (!TEXT_VARIANTS.includes(value)) report(at, `"${value}" is not a text variant (${TEXT_VARIANTS.join(', ')})`);
            } else if (kind === 'size') {
                if (!IMAGE_SIZES.includes(value)) report(at, `"${value}" is not an image size (${IMAGE_SIZES.join(', ')})`);
            } else if (kind === 'cols') {
                if (!isInt(value, 1, 12)) report(at, 'must be a whole number from 1 to 12');
            } else if (kind === 'limit') {
                if (!isInt(value, 1, LIMITS.listItems)) report(at, `must be a whole number from 1 to ${LIMITS.listItems}`);
            } else if (kind === 'cond') {
                if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.cond) report(at, `must be a condition of 1 to ${LIMITS.cond} characters`);
            } else if (kind === 'command') {
                if (typeof value !== 'string' || !COMMAND_NAME.test(value)) report(at, `"${value}" is not a command name (like item.use)`);
            } else if (kind === 'icon') {
                if (typeof value !== 'string' || !ICON.test(value)) report(at, 'must be a Font Awesome icon name like fa-box');
            } else if (kind === 'payload') {
                itemRefErrors(value, at, inList, report);
            } else if (kind === 'children') {
                if (!Array.isArray(value)) report(at, 'must be a list of nodes');
                else {
                    if (value.length > LIMITS.children) report(at, `has more than ${LIMITS.children} children`);
                    value.slice(0, LIMITS.children).forEach((child, index) => visit(child, `${at}[${index}]`, depth + 1, inList));
                }
            } else if (kind === 'node') {
                // A list's item template is where `$item` starts to mean something.
                visit(value, at, depth + 1, inList || node.type === 'list');
            } else if (kind === 'pages') {
                if (!Array.isArray(value) || !value.length || value.length > LIMITS.pages) report(at, `must be a list of 1 to ${LIMITS.pages} pages`);
                else value.forEach((page, index) => {
                    const pageAt = `${at}[${index}]`;
                    if (!isPlainObject(page)) return report(pageAt, 'a page must be { title, node }');
                    for (const pageKey of Object.keys(page)) if (pageKey !== 'title' && pageKey !== 'node') report(pageAt, `a page has no field "${pageKey}" (only title, node)`);
                    if (page.title === undefined) report(pageAt, 'a page needs a "title"');
                    else checkValue(page.title, `${pageAt}.title`, inList, report);
                    if (page.node === undefined) report(pageAt, 'a page needs a "node"');
                    else visit(page.node, `${pageAt}.node`, depth + 1, inList);
                });
            }
        }
    };

    if (layout.root === undefined) report('layout.root', 'a layout needs a root node');
    else visit(layout.root, 'root', 1, false);
    return errors;
}
