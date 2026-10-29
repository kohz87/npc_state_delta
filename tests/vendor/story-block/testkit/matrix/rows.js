// The supported Story Suite combinations.

export const ROWS = Object.freeze([
    { name: 'SB', modules: [] },
    { name: 'SB+SD', modules: ['sd'] },
    { name: 'SB+NSD', modules: ['nsd'] },
    { name: 'SB+SD+NSD', modules: ['sd', 'nsd'] },
].map(row => Object.freeze({ dormant: [], ...row })));

/** The columns, in report order: the basic run first, then the §2 extra cases. */
export const CASES = Object.freeze([
    ['register', 'registers once'],
    ['reply', 'scripted reply'],
    ['action', 'action'],
    ['replay', 'replay'],
    ['prompt', 'static prompt'],
    ['missing-query', 'missing query'],
    ['malformed', 'malformed answer'],
    ['feature-off', 'feature off'],
    ['unset-clock', 'unset clock'],
    ['disabled-sd', 'SD disabled'],
    ['late', 'late registration'],
    ['duplicate', 'duplicate name'],
    ['swipe', 'swipe'],
    ['re-read', 're-read'],
    ['delete', 'delete'],
]);

/** Cases the host cannot express today, with why. All current columns are executable. */
export const NOT_EXPRESSIBLE = Object.freeze({});
