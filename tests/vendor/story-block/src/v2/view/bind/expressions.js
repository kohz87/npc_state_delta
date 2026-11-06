// Binding expressions: compile text once, fast-read paths/literals/simple helper calls, otherwise pass it to
// the events condition language. Evaluation can report expression errors as warnings and undefined.

import { parsePath, readPath, resolvePath, skipSpace } from './paths.js';

const HELPERS = new Set(['ratio', 'pct', 'changed', 'len', 'contains', 'sum', 'fmt.money', 'fmt.time']);

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
