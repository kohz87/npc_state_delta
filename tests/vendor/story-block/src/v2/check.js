// Small schema checks for domain validators (SPEC §2.5, exposed as `sdk.check`). Each returns '' when
// the value is fine, else a short phrase the caller puts after the field's name ("qty must be a whole
// number"). `arrayOf` and `record` build a check for a list or an ID-keyed record from a check for one
// value. Pure.

/** `<prefix>_<8 base36>` as `sdk.id(prefix)` makes them: `it_k3f9a2qz`. */
export const RECORD_ID = /^[a-z][a-z0-9]*_[0-9a-z]{8}$/;
/** Definition IDs are namespaced slugs: `story/moonveil-trout`, `pack.fantasy/iron-sword`. */
export const DEF_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/** True for a record ID (of `prefix`, when given) or, without a prefix, a definition ID too. */
export function isId(value, prefix) {
    if (typeof value !== 'string') return false;
    if (prefix) return RECORD_ID.test(value) && value.startsWith(`${prefix}_`);
    return RECORD_ID.test(value) || DEF_ID.test(value);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function int(value, { min, max } = {}) {
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
    if (min !== undefined && value < min) return `must be ${min} or more`;
    if (max !== undefined && value > max) return `must be ${max} or less`;
    return '';
}

export function str(value, { min, max } = {}) {
    if (typeof value !== 'string') return 'must be text';
    if (min !== undefined && value.length < min) return min === 1 ? 'must not be empty' : `must be at least ${min} characters`;
    if (max !== undefined && value.length > max) return `must be at most ${max} characters`;
    return '';
}

export function oneOf(value, list) {
    return Array.isArray(list) && list.includes(value) ? '' : `must be one of: ${(list ?? []).join(', ')}`;
}

/** id(v, 'it') wants `it_xxxxxxxx`; id(v) takes any record ID or a definition ID. */
export function id(value, prefix) {
    if (isId(value, prefix)) return '';
    return prefix
        ? `must be an ID like ${prefix}_k3f9a2qz`
        : 'must be an ID like it_k3f9a2qz or story/moonveil-trout';
}

export function bool(value) {
    return typeof value === 'boolean' ? '' : 'must be true or false';
}

/** arrayOf(check) → a check for a list whose every item passes `check`. */
export function arrayOf(check) {
    return value => {
        if (!Array.isArray(value)) return 'must be a list';
        for (let i = 0; i < value.length; i++) {
            const error = check(value[i]);
            if (error) return `item ${i + 1} ${error}`;
        }
        return '';
    };
}

/** record(check, keyCheck?) → a check for `{ [key]: value }` whose every value (and key) passes. */
export function record(check, keyCheck = null) {
    return value => {
        if (!isRecord(value)) return 'must be a record (an object keyed by ID)';
        for (const key of Object.keys(value).sort()) {
            const keyError = keyCheck ? keyCheck(key) : '';
            if (keyError) return `key ${key} ${keyError}`;
            const error = check(value[key]);
            if (error) return `${key} ${error}`;
        }
        return '';
    };
}
