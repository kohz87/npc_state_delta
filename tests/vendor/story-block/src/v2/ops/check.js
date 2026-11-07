// checkOps (SPEC §2.5): the generic rules every op must keep before it is saved, as plain sentences.
// Values are plain JSON, IDs and whole numbers stay valid, and forbidden keys never reach the state. Pure.

import { isId } from '../check.js';
import { OPS } from './constants.js';
import { escapeKey, parsePath, valueAt } from './paths.js';
import { isPlainObject, jsonProblem } from './json.js';

// Keys whose values must be IDs: `id`, and names ending in `Id` or `_id` (`stackId`, `owner_id`).
const ID_KEY = /^(?:id|.+Id|.+_id)$/;
// Keys no value in the state may hold: copied with Object.assign or a for-in loop they would change
// an object's prototype, and code reading them would get the language's own (QA #70).
export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * checkOps(ops, before?) → string[]: the generic rules of SPEC §2.5, as plain sentences (empty when
 * fine). Every op: a known op, a well-formed path below the root, a plain-JSON value (no NaN, no
 * Infinity, no undefined, no key named __proto__, constructor or prototype inside a value). Anywhere
 * in a value or at the end of a path:
 * * `qty` is a whole number, 0 or more;
 * * `/meta/rev` is a whole number, 0 or more;
 * * a key named `id` holds a well-formed ID (`it_k3f9a2qz` or `story/moonveil-trout`); a key ending
 *   in `Id` or `_id` holds one too, or null.
 * With `before` (the state the ops apply to), a number that replaces a whole number must be whole too,
 * at that path and anywhere inside the replaced value ("integers stay integers").
 */
export function checkOps(ops, before = undefined) {
    if (!Array.isArray(ops)) return ['The changes are not a list.'];
    const errors = [];
    ops.forEach((op, n) => {
        if (!op || typeof op !== 'object' || !OPS.has(op.op)) {
            errors.push(`Change ${n + 1} is not an add, replace or remove.`);
            return;
        }
        let keys;
        try {
            keys = parsePath(op.path);
        } catch (error) {
            errors.push(error.message);
            return;
        }
        if (!keys.length) {
            errors.push(`Change ${n + 1} would ${op.op} the whole state.`);
            return;
        }
        if (op.op === 'remove') return;
        if (!Object.hasOwn(op, 'value')) {
            errors.push(`The ${op.op} at ${op.path} has no value.`);
            return;
        }
        const problem = jsonProblem(op.value, op.path);
        if (problem) {
            errors.push(problem);
            return;
        }
        checkValue(op.value, keys[keys.length - 1], op.path, errors);
        if (op.path === '/meta/rev' && (!Number.isInteger(op.value) || op.value < 0)) errors.push(`/meta/rev must be a whole number, 0 or more (got ${JSON.stringify(op.value)}).`);
        if (before !== undefined) stayWhole(valueAt(before, op.path), op.value, op.path, errors);
    });
    return errors;
}

function checkValue(value, key, path, errors) {
    // Data modules' closed checker owns field names/types, including literal authoring IDs
    // and user fields named id/qty. Keep the JSON/prototype/integer safety checks below.
    const dataDefined = path === '/domains/dataModules' || path.startsWith('/domains/dataModules/');
    if (!dataDefined && key === 'qty' && !(Number.isInteger(value) && value >= 0)) {
        errors.push(`${path}: qty must be a whole number, 0 or more (got ${JSON.stringify(value)}).`);
    }
    if (!dataDefined && ID_KEY.test(key)) {
        const ok = key === 'id' ? isId(value) : value === null || isId(value);
        if (!ok) errors.push(`${path}: ${key} must be an ID like it_k3f9a2qz or story/moonveil-trout (got ${JSON.stringify(value)}).`);
    }
    if (Array.isArray(value)) value.forEach((item, i) => checkValue(item, String(i), `${path}/${i}`, errors));
    else if (value !== null && typeof value === 'object') {
        for (const child of Object.keys(value)) {
            if (FORBIDDEN_KEYS.includes(child)) {
                errors.push(`${path} holds a key named "${child}", which the state may not use.`);
                continue;
            }
            checkValue(value[child], child, `${path}/${escapeKey(child)}`, errors);
        }
    }
}

function stayWhole(old, value, path, errors) {
    if (typeof old === 'number' && Number.isInteger(old)) {
        if (typeof value === 'number' && !Number.isInteger(value)) errors.push(`${path} was a whole number and must stay one (got ${value}).`);
        return;
    }
    if (Array.isArray(old) && Array.isArray(value)) {
        for (let i = 0; i < Math.min(old.length, value.length); i++) stayWhole(old[i], value[i], `${path}/${i}`, errors);
    } else if (isPlainObject(old) && isPlainObject(value)) {
        for (const key of Object.keys(value)) if (Object.hasOwn(old, key)) stayWhole(old[key], value[key], `${path}/${escapeKey(key)}`, errors);
    }
}
