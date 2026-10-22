// Widget props (SPEC §13.5): each widget declares `props: { name: { type, required, default } }`.
//
// Props reach a widget from a template's `data-props` (§13.2), where `{{ }}` interpolation turns every
// value into a string, so a number or boolean prop also accepts its plain string form ("77", "true").
// A missing or wrong-typed prop falls back to its default; widgets never throw on bad data.

const PRIMITIVES = ['number', 'string', 'boolean', 'array', 'object', 'any'];

function coerce(type, value) {
    if (value === undefined || value === null) return undefined;
    switch (type) {
        case 'number': {
            if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
            if (typeof value === 'string' && /^\s*-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(value)) return Number(value);
            return undefined;
        }
        case 'string':
            if (typeof value === 'string') return value;
            return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
        case 'boolean':
            if (typeof value === 'boolean') return value;
            if (value === 'true') return true;
            if (value === 'false') return false;
            return undefined;
        case 'array':
            return Array.isArray(value) ? value : undefined;
        case 'object':
            return typeof value === 'object' && !Array.isArray(value) ? value : undefined;
        default:
            return value;
    }
}

const typesOf = spec => (Array.isArray(spec.type) ? spec.type : [spec.type ?? 'any']).filter(type => PRIMITIVES.includes(type));

/** The props a widget sees: every declared prop, coerced to its type or set to its default (or null). */
export function resolveProps(schema, input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};
    for (const [name, spec] of Object.entries(schema ?? {})) {
        let value;
        for (const type of typesOf(spec)) {
            value = coerce(type, source[name]);
            if (value !== undefined) break;
        }
        out[name] = value !== undefined ? value : (spec.default ?? null);
    }
    return out;
}

/**
 * Plain-words problems with a props object (wrong types; with `required`, missing required props too);
 * [] when fine.
 */
export function propProblems(schema, input, { required = true } = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const problems = [];
    for (const [name, spec] of Object.entries(schema ?? {})) {
        const value = source[name];
        if (value === undefined || value === null) {
            if (required && spec.required) problems.push(`The "${name}" setting is missing.`);
            continue;
        }
        const types = typesOf(spec);
        if (!types.some(type => coerce(type, value) !== undefined)) {
            problems.push(`The "${name}" setting should be ${types.map(type => ({ array: 'a list', object: 'an object' })[type] ?? `a ${type}`).join(' or ')}.`);
        }
    }
    return problems;
}

const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Unfolds a bound `value` (the layout renderer passes a node's `bind` as `props.value`, LAYOUTS.md) into
 * the widget's props: an object's fields become props (the props given beside it win), and a list or a
 * plain value fills the widget's main prop (`primary`, e.g. a map's `nodes`) when that is not given.
 * A widget whose main prop is `value` itself keeps a plain value as it is.
 */
export function unfoldValue(input, schema, primary) {
    if (!isPlain(input) || !('value' in input)) return input;
    const { value, ...rest } = input;
    const own = schema?.value;
    if (isPlain(value) && !(own && typesOf(own).includes('object'))) return { ...value, ...rest };
    if (primary && primary !== 'value' && rest[primary] === undefined && value !== undefined && value !== null && !isPlain(value)) {
        return { ...rest, [primary]: value };
    }
    return input;
}

/**
 * A widget definition: `{ props, primary, render, validate }`. `render` sees props with a bound `value`
 * unfolded (unfoldValue); `validate(props) → string[]` reports wrong types only, since required data
 * often arrives through a binding the validator cannot see (a widget shows an empty state without it).
 */
export function defineWidget({ props, primary = null, render }) {
    const prepare = input => unfoldValue(input, props, primary);
    return Object.freeze({
        props,
        primary,
        render(el, input, api) {
            const handle = render(el, prepare(input), api);
            return {
                update: next => handle.update(prepare(next)),
                destroy: () => handle.destroy(),
            };
        },
        validate: input => propProblems(props, prepare(input), { required: false }),
    });
}
