// Static type and interval analysis; no evaluation, queries, state or code execution.
import { DM_DESCRIPTORS as D, DM_LIMITS as L, dmObject, dmOwn, dmInt } from './schema.js';

const BAD = Object.freeze({ type: 'invalid' });
const bool = () => ({ type: 'bool' });
const str = values => ({ type: 'enum', values });
const int = (min, max) => ({ type: 'int', min, max });
export function fieldType(schema) {
    if (!dmObject(schema)) return BAD;
    if (schema.type === 'int' && dmInt(schema.min) && dmInt(schema.max)) return int(schema.min, schema.max);
    if (schema.type === 'enum' && Array.isArray(schema.values)) {
        const values = schema.values;
        const type = values.every(v => typeof v === 'number') ? int(Math.min(...values), Math.max(...values))
            : values.every(v => typeof v === 'boolean') ? bool()
                : values.every(v => v === null) ? { type: 'null' } : str(values);
        return { ...type, enumValues: values };
    }
    if (schema.type === 'bool') return bool();
    if (schema.type === 'text') return { type: 'text', max: schema.max };
    return BAD;
}

export function compatible(target, source, { overlap = false } = {}) {
    if (target.type === 'invalid' || source.type === 'invalid') return true; // one diagnostic per bad reference
    if (target.enumValues) {
        let values = source.enumValues ?? source.values;
        if (!values && source.type === 'bool') values = [false, true];
        if (!values && source.type === 'null') values = [null];
        if (!values && source.type === 'int' && source.max - source.min < 32) values = Array.from({ length: source.max - source.min + 1 }, (_, i) => source.min + i);
        return Boolean(values && values.every(value => target.enumValues.includes(value)));
    }
    if (target.type !== source.type) return false;
    if (target.type === 'int') return overlap ? source.max >= target.min && source.min <= target.max
        : source.min >= target.min && source.max <= target.max;
    if (target.type === 'enum') return source.values.every(value => target.values.includes(value));
    return target.type !== 'text'; // text is display-only, never an expression
}

// A path's entire enum range must name fixed keys. This is shared by reads and effects.
export function pathType(path, env, at, add, visit) {
    if (!Array.isArray(path) || path.length < 1 || path.length > 2) {
        add('DM_SCHEMA', at, 'A field path is one or two declared key segments.');
        return BAD;
    }
    const segment = (value, allowed, where) => {
        const type = typeof value === 'string' ? str([value]) : visit(value, where);
        if (type.type === 'invalid') return [];
        if (type.type !== 'enum' || !type.values.length || type.values.some(key => !allowed.includes(key))) {
            add('DM_SCHEMA', where, 'Every possible path segment must resolve to a declared field or fixed map key.');
            return [];
        }
        return type.values;
    };
    const roots = segment(path[0], Object.keys(env.state ?? {}), `${at}[0]`);
    const types = [];
    for (const root of roots) {
        const field = env.state[root];
        if (field?.type === 'map') {
            if (path.length !== 2) { add('DM_SCHEMA', at, 'A map path must select a fixed scalar key.'); continue; }
            if (segment(path[1], field.keys ?? [], `${at}[1]`).length) types.push(fieldType(field.values));
        } else if (path.length !== 1) add('DM_SCHEMA', at, 'A scalar field has no child keys.');
        else types.push(fieldType(field));
    }
    if (!types.length || types.some(type => type.type === 'invalid')) return BAD;
    const type = types[0].type;
    if (types.some(t => t.type !== type)) {
        add('DM_SCHEMA', at, 'A dynamic field path must select one scalar type.');
        return BAD;
    }
    if (types.length === 1) return types[0];
    // Writes must fit every possible target; reads include every possible value.
    if (type === 'int') {
        const result = int((env.writing ? Math.max : Math.min)(...types.map(t => t.min)),
            (env.writing ? Math.min : Math.max)(...types.map(t => t.max)));
        const finite = types.find(t => t.enumValues);
        if (env.writing && finite) result.enumValues = finite.enumValues.filter(value => types.every(t => value >= t.min && value <= t.max && (!t.enumValues || t.enumValues.includes(value))));
        return result;
    }
    if (type === 'enum') return str(env.writing ? types[0].values.filter(v => types.every(t => t.values.includes(v)))
        : [...new Set(types.flatMap(t => t.values))]);
    if (type === 'text') return { type: 'text', max: (env.writing ? Math.min : Math.max)(...types.map(t => t.max)) };
    if (env.writing && type === 'bool' && types.some(t => t.enumValues)) return { type: 'bool', enumValues: [false, true].filter(v => types.every(t => !t.enumValues || t.enumValues.includes(v))) };
    return types[0];
}

/** Infer one expression, charging AST operator/literal visits including dynamic path expressions. */
export function expressionType(expression, env, at, add) {
    let nodes = 0;
    const visit = (value, path, depth = 1) => {
        nodes += 1;
        if (nodes > L.expressionNodes || depth > L.expressionDepth) {
            add('DM_BUDGET', path, `An expression permits depth ${L.expressionDepth} and ${L.expressionNodes} AST nodes.`);
            return BAD;
        }
        if (typeof value === 'boolean') return { ...bool(), values: [value] };
        if (value === null) return { type: 'null' };
        if (typeof value === 'number') {
            if (!dmInt(value)) { add('DM_BOUNDS', path, 'Integer literals must be safe integers.'); return BAD; }
            return int(value, value);
        }
        if (typeof value === 'string') return str([value]);
        if (!Array.isArray(value) || !value.length || !dmOwn(D.arities, value[0]) || value.length !== D.arities[value[0]] + 1) {
            add('DM_SCHEMA', path, 'Expected a JSON scalar or a declared fixed-arity AST operator.');
            return BAD;
        }
        const [op, a, b, c] = value;
        const child = (v, i) => visit(v, `${path}[${i}]`, depth + 1);
        if (op === 'get') {
            const result = pathType(a, { ...env, writing: false }, `${path}[1]`, add, (v, p) => visit(v, p, depth + 1));
            if (result.type === 'text') { add('DM_SCHEMA', path, 'Text fields are display-only and cannot be read by an expression.'); return BAD; }
            return result;
        }
        if (op === 'arg' || op === 'bind' || op === 'reward') {
            const source = op === 'arg' ? env.args : op === 'bind' ? env.bindings : env.rewards;
            if (typeof a !== 'string' || !dmOwn(source, a)) { add('DM_SCHEMA', path, `Unknown ${op} reference in this expression context.`); return BAD; }
            return op === 'reward' ? source[a] : fieldType(source[a]);
        }
        if (op === 'check') { add('DM_SCHEMA', path, 'SD checks inside a dm root need data-modules v1.1; this definition needs data-modules v1.1.'); return BAD; }
        if (op === 'timer') {
            if (a !== 'periods' || !env.timer) { add('DM_SCHEMA', path, 'timer.periods is available only inside timer effects.'); return BAD; }
            return int(0, Math.ceil(L.elapsedMinutes / env.timer.every));
        }
        if (op === 'input') {
            const imported = dmOwn(env.inputs, a) && env.inputs[a];
            if (!imported || typeof b !== 'string' || !dmOwn(imported, b)) { add('DM_SCHEMA', path, 'input must name a declared scalar import projection.'); return BAD; }
            const result = imported[b];
            if (result.type === 'text' || result.type === 'map') { add('DM_SCHEMA', path, 'Only scalar non-text public projections may be used in expressions.'); return BAD; }
            return result;
        }
        const x = child(a, 1);
        if (op === 'not') {
            if (x.type !== 'bool' && x.type !== 'invalid') add('DM_SCHEMA', path, 'not requires a boolean operand.');
            return bool();
        }
        const y = child(b, 2);
        if (x.type === 'invalid' || y.type === 'invalid') return BAD;
        if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(op)) {
            if (x.type !== y.type || (['lt', 'le', 'gt', 'ge'].includes(op) && x.type !== 'int')) add('DM_SCHEMA', path, 'Comparison operands must have the same type; ordered comparisons require integers.');
            return bool();
        }
        if (op === 'and' || op === 'or') {
            if (x.type !== 'bool' || y.type !== 'bool') add('DM_SCHEMA', path, `${op} requires boolean operands.`);
            return bool();
        }
        if (x.type !== 'int' || y.type !== 'int') { add('DM_SCHEMA', path, 'Arithmetic requires integer operands without coercion.'); return BAD; }
        let lo, hi;
        if (op === 'add') { lo = x.min + y.min; hi = x.max + y.max; }
        if (op === 'sub') { lo = x.min - y.max; hi = x.max - y.min; }
        if (op === 'mul') {
            const endpoints = [x.min * y.min, x.min * y.max, x.max * y.min, x.max * y.max];
            lo = Math.min(...endpoints); hi = Math.max(...endpoints);
        }
        if (op === 'min') { lo = Math.min(x.min, y.min); hi = Math.min(x.max, y.max); }
        if (op === 'max') { lo = Math.max(x.min, y.min); hi = Math.max(x.max, y.max); }
        if (op === 'floorDiv') {
            if (!dmInt(b, 1)) { add('DM_BOUNDS', `${path}[2]`, 'floorDiv requires a positive integer literal divisor.'); return BAD; }
            lo = Math.floor(x.min / b); hi = Math.floor(x.max / b);
        }
        if (op === 'clamp') {
            const z = child(c, 3);
            if (z.type === 'invalid') return BAD;
            if (!dmInt(b) || !dmInt(c) || b > c) { add('DM_BOUNDS', path, 'clamp bounds must be ordered integer literals.'); return BAD; }
            lo = Math.max(b, Math.min(c, x.min)); hi = Math.max(b, Math.min(c, x.max));
        }
        // Ranges that sometimes overflow are guarded dynamically. A range with no safe
        // result is statically impossible. Children are checked before an outer clamp.
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > L.integer || hi < -L.integer) {
            add('DM_BOUNDS', path, 'Every possible arithmetic result overflows the host integer interval.');
            return BAD;
        }
        // Timer multiplication must be proved safe over the entire elapsed-time budget.
        if (env.timer && (lo < -L.integer || hi > L.integer)) add('DM_BOUNDS', path, 'Timer arithmetic must fit the host interval for every permitted elapsed interval.');
        return int(Math.max(-L.integer, lo), Math.min(L.integer, hi));
    };
    return visit(expression, at);
}

export function conditionType(expression, env, at, add) {
    const type = expressionType(expression, env, at, add);
    if (!['bool', 'invalid'].includes(type.type)) add('DM_CONDITION', at, 'A condition must produce a boolean, without coercion.');
}
