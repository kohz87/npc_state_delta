// The combination rows and the case columns of the matrix (docs/v2/contract/RB_CONTRACT.md §2).
// `modules`: the module keys on top of Story Block's core, `dormant`: the modules the row expects to
// be refused (RB without SD), `known`: the sentence a negative row reports while the host cannot yet
// make that module dormant (the lifecycle is another package; `strict` turns the gap into a failure).

export const ROWS = Object.freeze([
    { name: 'SB', modules: [] },
    { name: 'SB+SD', modules: ['sd'] },
    { name: 'SB+NSD', modules: ['nsd'] },
    { name: 'SB+SD+NSD', modules: ['sd', 'nsd'] },
    { name: 'SB+SD+RB', modules: ['rb', 'sd'] },
    { name: 'SB+SD+RB+NSD', modules: ['rb', 'sd', 'nsd'] },
    { name: 'SB+RB', modules: ['rb'], dormant: ['rb'] },
    { name: 'SB+RB+NSD', modules: ['rb', 'nsd'], dormant: ['rb'] },
].map(row => Object.freeze({ dormant: [], ...row })));

/** The columns, in report order: the basic run first, then the §2 extra cases. */
export const CASES = Object.freeze([
    ['register', 'registers once'],
    ['reply', 'scripted reply'],
    ['action', 'action'],
    ['replay', 'replay'],
    ['prompt', 'static prompt'],
    ['dormant', 'RB dormant'],
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
