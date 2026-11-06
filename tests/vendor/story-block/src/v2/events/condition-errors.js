// The condition language's size limits and error values: a pack's condition may not throw at its caller.

/** Size limits: a condition is a line, not a program. */
export const LIMITS = Object.freeze({
    source: 1000,  // characters of one condition
    tokens: 200,   // tokens of one condition
    depth: 24,     // nesting: each ( … ), call argument, [ … ], record value and ! or - is one level
    string: 200,   // characters of one quoted word
    name: 64,      // characters of one name
    keys: 8,       // entries of one { … } record
    calls: 32,     // calls made while evaluating one condition
});

/** Keys a read may never name, even when the data happens to hold them. */
export const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

const CODES = Object.freeze(['SYNTAX', 'LIMIT', 'NOT_ALLOWED', 'TYPE', 'CALL']);

class ConditionError extends Error {
    constructor(code, message, at = 0) {
        super(message);
        this.code = code;
        this.at = at;
    }
}

export const fail = (code, message, at) => { throw new ConditionError(code, message, at); };

/** Error values carry a known code; anything unexpected becomes a CALL error, never a throw. */
export function errorValue(error) {
    if (error instanceof ConditionError && CODES.includes(error.code)) return { code: error.code, message: error.message, at: error.at };
    if (error instanceof RangeError) return { code: 'LIMIT', message: 'The condition is nested too deeply to check.', at: 0 };
    return { code: 'CALL', message: `The condition could not be checked: ${error?.message ?? String(error)}`, at: 0 };
}
