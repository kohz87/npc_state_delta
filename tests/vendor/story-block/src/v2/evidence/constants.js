// Story Suite v2 evidence, constants part: the owner of each proof kind, the stat names, the structural caps, the stored
// proof's key list, and the small readers every part shares (isObject, utf8, whole, occurrenceOf). Pure: no state is read.
// evidence.js keeps the public path of each export.

export const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const utf8 = new TextEncoder();

/** Who may give each kind of proof (contract §6): the module id that owns it. */
export const OWNERS = Object.freeze({
    visit: 'story-director', acceptance: 'story-director', event: 'story-director',
});
export const KINDS = Object.freeze(Object.keys(OWNERS));
export const STATS = Object.freeze(['STR', 'VIT', 'AGI', 'DEX', 'INT', 'LUK', 'CHA']);

/** The structural caps; the contract names none, so these are the host's (EVIDENCE.md "Caps"). */
export const LIMITS = Object.freeze({
    opaqueBytes: 4096,     // a payload the contract leaves to B3/B6 (normalized JSON, UTF-8 bytes)
    selection: 120,        // code points of an acceptance's `selection`
    words: 240,            // code points of an acceptance's `words`
    parents: 8,            // parents of one proof
    perRoot: 32,           // proofs one command (its root transaction) may give
    ids: 500,              // ids one story.evidence call may ask for
});

export const PROOF_KEYS = ['id', 'source', 'owner', 'kind', 'payload', 'payloadHash', 'parents'];
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const whole = value => (Number.isInteger(value) && value >= 0 ? value : null);

/** The occurrence a block was stamped with, or null (a block from before there was one). */
export const occurrenceOf = span => whole(span?.occurrence);
