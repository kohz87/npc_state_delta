// Bindings (SPEC §13.2): what a screen's template (and the JSON layout renderer, which shares this file)
// reads from. A binding is resolved against a **scope**:
//
//   { state, q, draft, settings, query?, <loop names>…, ratio, pct, changed, len, contains, sum, fmt: { money, time } }
//
// Every name is a top-level identifier, so the scope is what `evaluate(expr, scope)` gets as it is (the
// layout renderer's `{ item, index, query }` scope has the same shape).
//
// * `state.<domain>.…` is the State at the mount's carrier (read-only). The scope holds a flat view of the
//   document (`{ v, meta, ...domains }`), so `state.party.actors` reads `domains.party.actors` and
//   `state.meta.rev` reads `meta.rev`.
// * `q.<alias>` the screen's `data` queries, `draft.…` the dialog's draft, `settings.…` the module's
//   settings, and the names `data-each` gives its items.
//
// Two kinds of binding text:
// * A **path** (`pc.hp.cur`, `state.inventory.defs[s.def].name`, `list[0]`, `defs['story/trout']`) is read
//   here, own properties only (never `__proto__`, `constructor`, `prototype`).
// * Anything else is an **expression** in the events condition language (src/v2/events), evaluated by an
//   injected `evaluate(expr, scope)`. A path, a literal, `!x` and a helper call whose arguments are those
//   (`ratio(hp.cur, hp.max)`, `fmt.money(q.purse)`) are read here directly, so the common bindings work
//   and stay cheap without the condition engine.
//
// `changed(path)` is true when this carrier's ops touched the path: an op at it, under it, or above it
// (a whole record replaced). Its argument is a path, written bare (`changed(s.qty)`) or quoted
// (`changed('state.scene.place')`), or a JSON Pointer (`changed('/domains/scene/place')`). A bare path is
// passed to `evaluate` quoted, so the condition language only ever sees a string there.
// Pure: no DOM, no clock, no randomness.

import { escapeKey } from '../ops.js';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Names a loop may not take: they are the scope's own roots and helpers. */
export const RESERVED = new Set(['state', 'q', 'draft', 'settings', 'query', 'ratio', 'pct', 'changed', 'len', 'contains', 'sum', 'fmt', 'true', 'false', 'null']);
const HELPERS = new Set(['ratio', 'pct', 'changed', 'len', 'contains', 'sum', 'fmt.money', 'fmt.time']);
const POINTERS = Symbol('ss.pointers');
const EMPTY = Object.freeze({});

// ---------------------------------------------------------------------------------------------------
// Paths

/**
 * Parse a path: `name`, then `.key` or `[0]` / `['key']` / `["key"]` / `[other.path]` steps.
 * Returns `{ root, steps, source }` (a step is `{ key }` or `{ path }`) or null when the text is not a path.
 */
export function parsePath(source) {
    const text = String(source ?? '').trim();
    const reader = { text, at: 0 };
    const path = readPath(reader);
    return path && reader.at === text.length ? path : null;
}

function readPath(reader) {
    const { text } = reader;
    const head = /^[A-Za-z_$][\w$]*/.exec(text.slice(reader.at));
    if (!head) return null;
    const start = reader.at;
    reader.at += head[0].length;
    const steps = [];
    for (;;) {
        const char = text[reader.at];
        if (char === '.') {
            const key = /^\.(\w+)/.exec(text.slice(reader.at));
            if (!key) return null;
            steps.push({ key: key[1] });
            reader.at += key[0].length;
        } else if (char === '[') {
            reader.at += 1;
            skipSpace(reader);
            const rest = text.slice(reader.at);
            const number = /^\d+/.exec(rest);
            const quoted = /^(?:'([^'\\]*)'|"([^"\\]*)")/.exec(rest);
            if (number) {
                steps.push({ key: number[0] });
                reader.at += number[0].length;
            } else if (quoted) {
                steps.push({ key: quoted[1] ?? quoted[2] });
                reader.at += quoted[0].length;
            } else {
                const inner = readPath(reader);
                if (!inner) return null;
                steps.push({ path: inner });
            }
            skipSpace(reader);
            if (text[reader.at] !== ']') return null;
            reader.at += 1;
        } else break;
    }
    return { root: head[0], steps, source: text.slice(start, reader.at) };
}

function skipSpace(reader) {
    while (/\s/.test(reader.text[reader.at] ?? '')) reader.at += 1;
}

function step(value, key) {
    if (key === undefined || key === null || FORBIDDEN.has(String(key))) return undefined;
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object' && typeof value !== 'string') return undefined;
    return Object.hasOwn(value, key) ? value[key] : undefined;
}

function stepKey(scope, item) {
    if (item.key !== undefined) return item.key;
    const key = resolvePath(scope, item.path);
    return typeof key === 'string' || (typeof key === 'number' && Number.isInteger(key)) ? String(key) : undefined;
}

/** The value at a parsed path (or path text) in the scope; undefined when any step is missing. */
export function resolvePath(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return undefined;
    let value = step(scope, parsed.root);
    for (const item of parsed.steps) {
        value = step(value, stepKey(scope, item));
        if (value === undefined) return undefined;
    }
    return value;
}

/**
 * The JSON Pointer into the State that a path names, or null when it does not name state (a query
 * result, the draft, settings, a literal). Loop names carry their item's pointer (`withItem`).
 */
export function pointerOf(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return null;
    const keys = [];
    for (const item of parsed.steps) {
        const key = stepKey(scope, item);
        if (key === undefined) return null;
        keys.push(key);
    }
    let base;
    if (parsed.root === 'state') {
        if (!keys.length) return '';
        const first = keys.shift();
        base = first === 'meta' || first === 'v' ? `/${escapeKey(first)}` : `/domains/${escapeKey(first)}`;
    } else {
        base = scope?.[POINTERS]?.[parsed.root];
        if (typeof base !== 'string') return null;
    }
    return base + keys.map(key => `/${escapeKey(key)}`).join('');
}

/**
 * The keys a parsed path walks (`[root, ...steps]`), dynamic `[x.y]` steps read from the scope; null when
 * a dynamic step has no usable key.
 */
export function pathKeys(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return null;
    const keys = [parsed.root];
    for (const item of parsed.steps) {
        const key = stepKey(scope, item);
        if (key === undefined) return null;
        keys.push(key);
    }
    return keys;
}

/** The value under a list of keys (own properties only). */
export function valueAtKeys(target, keys) {
    let value = target;
    for (const key of keys) {
        value = step(value, key);
        if (value === undefined) return undefined;
    }
    return value;
}

/** Set a value under a list of keys inside a plain object, copying each object on the way. */
export function setIn(target, keys, value) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || FORBIDDEN.has(key))) {
        throw new Error(`"${Array.isArray(keys) ? keys.join('.') : keys}" cannot be written.`);
    }
    const write = (node, index) => {
        const copy = Array.isArray(node) ? [...node] : node && typeof node === 'object' ? { ...node } : {};
        const key = keys[index];
        copy[key] = index === keys.length - 1 ? value : write(Object.hasOwn(copy, key) ? copy[key] : undefined, index + 1);
        return copy;
    };
    return write(target, 0);
}

// ---------------------------------------------------------------------------------------------------
// What changed

/** The set of JSON Pointers a carrier's ops touched (`ops` from its storySuite record). */
export function changedPointers(ops) {
    const set = new Set();
    for (const op of Array.isArray(ops) ? ops : []) if (typeof op?.path === 'string') set.add(op.path);
    return set;
}

/** True when any pointer in the set is the pointer, below it or above it. */
export function touches(pointers, pointer) {
    if (typeof pointer !== 'string' || !pointers?.size) return false;
    for (const path of pointers) {
        if (path === pointer || path.startsWith(`${pointer}/`) || pointer.startsWith(`${path}/`) || pointer === '' || path === '') return true;
    }
    return false;
}

// ---------------------------------------------------------------------------------------------------
// Helpers and scopes

function finite(value) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

/** a / b clamped to 0…1 (4 decimals); 0 when b is not a positive number. */
export function ratio(a, b) {
    const top = finite(a);
    const bottom = finite(b);
    if (top === null || bottom === null || bottom <= 0) return 0;
    return Math.round(Math.min(1, Math.max(0, top / bottom)) * 10000) / 10000;
}

/** a / b as a whole percentage, 0…100. */
export const pct = (a, b) => Math.round(ratio(a, b) * 100);

/** Items in a list, keys in a record, characters in a string; 0 otherwise. */
export function len(value) {
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return 0;
}

/**
 * contains(a, b): does text `a` hold text `b`, ignoring case (a filter box: `contains(name, draft.find)`)?
 * An empty or missing `b` is held by everything; a list holds `b` when one of its items does.
 */
export function contains(a, b) {
    const needle = typeof b === 'string' || typeof b === 'number' ? String(b).trim().toLocaleLowerCase() : '';
    if (!needle) return true;
    if (Array.isArray(a)) return a.some(item => contains(item, needle));
    if (typeof a !== 'string' && typeof a !== 'number') return false;
    return String(a).toLocaleLowerCase().includes(needle);
}

/**
 * sum(list, field?): the numbers in a list or the values of a record added up (a points-buy total:
 * `sum(draft.points)`); with `field`, each item's field (`sum(q.rows, 'base')`, or a dotted path
 * `sum(state.party.actors, 'hp.cur')`). Anything that is not a finite number counts as 0. Own
 * properties only: a field naming `__proto__`, `constructor` or `prototype` reads nothing.
 */
export function sum(list, field) {
    const items = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    const keys = typeof field === 'string' && field !== '' ? field.split('.') : null;
    if (field !== undefined && field !== null && !keys) return 0;
    let total = 0;
    for (const item of items) {
        const value = keys ? valueAtKeys(item, keys) : item;
        if (typeof value === 'number' && Number.isFinite(value)) total += value;
    }
    // 0.1 + 0.2 reads as 0.3; whole numbers are already exact.
    return Number.isInteger(total) ? total : Math.round(total * 1e9) / 1e9;
}

/** Plain fallbacks; the host injects the real ones (the rules' coin names, the Director's calendar). */
export const defaultFormatters = {
    money: n => (Number.isInteger(n) ? String(n) : ''),
    time: minutes => {
        if (!Number.isInteger(minutes) || minutes < 0) return '';
        const day = Math.floor(minutes / 1440) + 1;
        const hour = Math.floor((minutes % 1440) / 60);
        const minute = minutes % 60;
        return `Day ${day}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    },
};

/** The flat view of a State document the scope's `state` root reads (`{ v, meta, ...domains }`). */
export function stateView(state) {
    if (!state || typeof state !== 'object') return Object.freeze({});
    return Object.freeze({ ...(state.domains ?? {}), v: state.v, meta: state.meta });
}

/**
 * Build a scope. `state` is the State document; `changed` is a Set (or array) of the JSON Pointers this
 * carrier's ops touched (the mounts' `changes`), or pass the carrier's `ops`; `formatters` overrides `fmt.money` / `fmt.time`; `query` (optional) is the host's
 * `query(name, args)`, for expressions such as `query('party.pc').level >= 3`. A missing draft is one
 * shared empty record, so building the scope again does not look like a new draft to the renderer.
 */
export function makeScope({ state = null, q = EMPTY, draft = EMPTY, settings = EMPTY, query = null, changed = null, ops = null, formatters = {} } = {}) {
    const pointers = changed instanceof Set ? changed : changedPointers(ops ?? (Array.isArray(changed) ? changed.map(path => ({ path })) : []));
    const format = { ...defaultFormatters, ...formatters };
    const fmt = Object.freeze({
        money: n => safeFormat(format.money, n),
        time: m => safeFormat(format.time, m),
    });
    const scope = { state: stateView(state), q: q ?? EMPTY, draft: draft ?? EMPTY, settings: settings ?? EMPTY, ratio, pct, len, contains, sum, fmt };
    if (typeof query === 'function') scope.query = query;
    Object.defineProperty(scope, POINTERS, { value: {}, enumerable: true });
    Object.defineProperty(scope, CHANGED, { value: pointers, enumerable: true });
    scope.changed = changedHelper(scope);
    return scope;
}

const CHANGED = Symbol('ss.changed');

/** True for a scope made by makeScope (or derived from one). */
export const isScope = scope => Boolean(scope && typeof scope === 'object' && scope[CHANGED] instanceof Set);

function safeFormat(fn, value) {
    try {
        const text = fn(value);
        return typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
    } catch {
        return '';
    }
}

function changedHelper(scope) {
    return path => {
        if (typeof path !== 'string') return false;
        const text = path.trim();
        const pointer = text === '' || text[0] === '/' ? text : pointerOf(scope, text);
        return touches(scope[CHANGED], pointer);
    };
}

/** The same scope with a new draft (helpers, pointers and loop names kept). */
export function withDraft(scope, draft) {
    const next = { ...scope, draft: draft ?? EMPTY };
    next.changed = changedHelper(next);
    return next;
}

/**
 * A child scope for one loop item: `name` is the item, `indexName` (optional) its index or record key.
 * `pointer` is the item's JSON Pointer into the State, or null.
 */
export function withItem(scope, name, value, pointer = null, indexName = null, index = undefined) {
    const next = { ...scope, [name]: value };
    const pointers = { ...scope[POINTERS] };
    if (typeof pointer === 'string') pointers[name] = pointer;
    else delete pointers[name];
    if (indexName) {
        next[indexName] = index;
        delete pointers[indexName];
    }
    Object.defineProperty(next, POINTERS, { value: pointers, enumerable: true });
    next.changed = changedHelper(next);
    return next;
}

// ---------------------------------------------------------------------------------------------------
// Expressions

/**
 * Compile binding text once. Returns `{ source, text, fast }`: `fast(scope)` when the text is a path,
 * a literal, `!x` or a helper call over those; otherwise `fast` is null and `text` (with bare `changed`
 * arguments quoted) goes to the injected `evaluate`.
 */
export function compileExpr(source) {
    const text = String(source ?? '').trim();
    return { source: text, text: quoteChanged(text), fast: fastExpr(text) };
}

/** Evaluate compiled binding text; undefined when it cannot be read (never throws). */
export function evalExpr(compiled, scope, evaluate = null, onWarn = null) {
    const expr = typeof compiled === 'string' ? compileExpr(compiled) : compiled;
    try {
        if (expr.fast) return expr.fast(scope);
        if (typeof evaluate !== 'function') {
            onWarn?.(`"${expr.source}" needs the condition language, which is not loaded.`);
            return undefined;
        }
        return evaluate(expr.text, scope);
    } catch (error) {
        onWarn?.(`"${expr.source}" could not be read: ${error?.message ?? error}`);
        return undefined;
    }
}

/** The helpers as extra calls of the events condition language (`parse(source, { names, calls })`). */
export const TEMPLATE_CALLS = Object.freeze({ ratio: [2, 2], pct: [2, 2], changed: [1, 1], len: [1, 1], contains: [2, 2], sum: [1, 2], 'fmt.money': [1, 1], 'fmt.time': [1, 1] });

/**
 * Wrap the events condition language (src/v2/events: `compile(source, options)` → `{ ok, ast }`,
 * `evaluate(ast, env)` → `{ ok, value }`) as the `evaluate(expr, scope)` a template takes: bare names
 * read the scope, the helpers are extra calls, `query(…)` and the language's own calls use
 * `scope.query`. An error comes back as a throw, which evalExpr turns into a warning and undefined.
 */
export function conditionEvaluator({ compile, evaluate }) {
    if (typeof compile !== 'function' || typeof evaluate !== 'function') throw new Error('conditionEvaluator needs the condition language\'s compile and evaluate.');
    return (expr, scope) => {
        const parsed = compile(expr, { names: true, calls: TEMPLATE_CALLS });
        if (!parsed?.ok) throw new Error(parsed?.error?.message ?? 'The expression could not be read.');
        const calls = {
            ratio: scope.ratio, pct: scope.pct, changed: scope.changed, len: scope.len, contains: scope.contains, sum: scope.sum,
            'fmt.money': scope.fmt?.money, 'fmt.time': scope.fmt?.time,
        };
        const result = evaluate(parsed.ast, { scope, calls, query: typeof scope.query === 'function' ? scope.query : () => null });
        if (!result?.ok) throw new Error(result?.error?.message ?? 'The expression could not be read.');
        return result.value;
    };
}

function quoteChanged(text) {
    return text.replace(/\bchanged\(\s*([A-Za-z_$][\w$]*(?:\.\w+|\[[^\]'"]*\]|\['[^'\]]*'\]|\["[^"\]]*"\])*)\s*\)/g, (_, path) => `changed(${JSON.stringify(path)})`);
}

function fastExpr(text) {
    const reader = { text, at: 0 };
    const node = readFast(reader);
    skipSpace(reader);
    return node && reader.at === text.length ? node : null;
}

function readFast(reader) {
    skipSpace(reader);
    const { text } = reader;
    const rest = text.slice(reader.at);
    if (rest[0] === '!') {
        reader.at += 1;
        const inner = readFast(reader);
        return inner && (scope => !inner(scope));
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?![\w.])|'([^'\\]*)'|"([^"\\]*)"|(true|false|null)\b)/.exec(rest);
    if (literal) {
        reader.at += literal[0].length;
        const value = literal[1] ?? literal[2] ?? (literal[3] ? JSON.parse(literal[3]) : Number(literal[0]));
        return () => value;
    }
    const start = reader.at;
    const path = readPath(reader);
    if (!path) return null;
    skipSpace(reader);
    if (text[reader.at] !== '(') return scope => resolvePath(scope, path);
    // A helper call.
    const name = text.slice(start, start + path.source.length);
    if (!HELPERS.has(name)) return null;
    reader.at += 1;
    const args = [];
    skipSpace(reader);
    if (text[reader.at] === ')') reader.at += 1;
    else {
        for (;;) {
            const argStart = reader.at;
            const arg = readFast(reader);
            if (!arg) return null;
            skipSpace(reader);
            const argText = text.slice(argStart, reader.at).trim();
            args.push(name === 'changed' && parsePath(argText) ? () => argText : arg);
            if (text[reader.at] === ',') reader.at += 1;
            else if (text[reader.at] === ')') {
                reader.at += 1;
                break;
            } else return null;
        }
    }
    return scope => {
        const fn = resolvePath(scope, path);
        return typeof fn === 'function' ? fn(...args.map(arg => arg(scope))) : undefined;
    };
}

// ---------------------------------------------------------------------------------------------------
// Text

/** How a bound value reads as text: strings as they are, numbers and booleans as written, else ''. */
export function toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.filter(item => ['string', 'number'].includes(typeof item)).map(toText).join(', ');
    return '';
}

/**
 * Split `{{ }}` interpolation into parts: strings and compiled expressions. Returns null when the text has
 * no complete `{{ … }}` (it is static).
 */
export function parseInterpolation(text) {
    const source = String(text ?? '');
    if (!source.includes('{{')) return null;
    const parts = [];
    let at = 0;
    for (;;) {
        const open = source.indexOf('{{', at);
        const close = open < 0 ? -1 : source.indexOf('}}', open + 2);
        if (open < 0 || close < 0) {
            if (at < source.length) parts.push(source.slice(at));
            break;
        }
        if (open > at) parts.push(source.slice(at, open));
        parts.push(compileExpr(source.slice(open + 2, close)));
        at = close + 2;
    }
    return parts.some(part => typeof part !== 'string') ? parts : null;
}

/** Interpolated text: every expression part read as text. */
export function interpolate(parts, scope, evaluate = null, onWarn = null) {
    return parts.map(part => (typeof part === 'string' ? part : toText(evalExpr(part, scope, evaluate, onWarn)))).join('');
}

/**
 * `name: expr; name: expr` lists (data-bind-attr, data-bind-var, data-class). Splits at `;` and the first
 * `:` outside quotes and brackets. Returns `[[name, exprText]]`.
 */
export function splitPairs(source) {
    const pairs = [];
    for (const part of splitTop(String(source ?? ''), ';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const name = part.slice(0, colon).trim();
        const expr = part.slice(colon + 1).trim();
        if (name && expr) pairs.push([name, expr]);
    }
    return pairs;
}

function splitTop(source, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (const char of source) {
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '(' || char === '[') depth += 1;
        else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
        else if (char === separator && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/** True for a name a loop may give its items. */
export const isLoopName = name => IDENT.test(name) && !RESERVED.has(name);
