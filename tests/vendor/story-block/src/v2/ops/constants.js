// Shared op vocabulary: the three operations Story Block writes, and the JSON Pointer list index.
// Kept in one place so apply, rebase and the checks agree on what an op is.

export const OPS = new Set(['add', 'replace', 'remove']);
export const INDEX = /^(?:0|[1-9]\d*)$/;
