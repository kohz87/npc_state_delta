// Memory facts (design MEMDESIGN2 §5, amendment 3): the live-eligibility marks. The setting `memoryFacts` (default on; off means no fact is derived,
// no prompt text is added and no mark is written) names the rule. A mark is the exact lineage checkpoint key of an assistant reply that arrived as a
// genuinely NEW live reply with the setting on (never a Re-read, load, Refresh, manual scan, replay or old/cast/manual admission). Facts are derived only
// for a reply whose current key is marked. Old chats carry no marks, so they stay byte-identical until a new live reply.
//
// Restore rule (the narrow exception to exact-boundary restore): marks live at chat-state level, outside branch snapshots, so a rewind or
// pre-upgrade restore keeps them untouched (`restoreSnapshotIntoState` spreads the current state). They can only ever authorise the exact key
// they were written for: a key binds the reply's content and its parents, so a rewind below the upgrade point, a reply regenerated at a lower index
// and a content-identical sibling on another branch all have other keys (or none) and are never marked by the union. Payloads, ledgers and cursors are
// never carried here. Bounded: the newest MARK_LIMIT keys, oldest dropped (a dropped mark means no fact, never a guess).
export const MARK_LIMIT = 128;
export const memoryFactsOn = settings => settings?.memoryFacts !== false;

export function markedKeys(state) {
    const keys = state?.memoryFactMarks?.keys;
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key) : [];
}

export function isMarked(state, key) {
    return typeof key === 'string' && key.length > 0 && markedKeys(state).includes(key);
}

// Writes the mark (and the monotonic epoch on the first one) into the chat state; returns true when it wrote.
export function markLiveReply(state, key, { enabled = true } = {}) {
    if (!enabled || !state || typeof key !== 'string' || !key) return false;
    const have = markedKeys(state);
    if (have.includes(key)) return false;
    const epoch = Number.isInteger(state.memoryFactMarks?.epoch) ? state.memoryFactMarks.epoch : 1;
    state.memoryFactMarks = { epoch, keys: [...have, key].slice(-MARK_LIMIT) };
    return true;
}

// The restore exception (amendment 3): a restored/replayed state keeps the live marks. Only well-formed key strings are taken, the saved ones first and
// the live ones after (so the newest survive the bound); the epoch only ever grows. Nothing else (no payload, ledger, cursor) is carried.
export function unionMarks(saved, live) {
    const keys = [...new Set([...markedKeys({ memoryFactMarks: saved }), ...markedKeys({ memoryFactMarks: live })])].slice(-MARK_LIMIT);
    if (!keys.length) return undefined;
    const epochs = [saved?.epoch, live?.epoch].filter(Number.isInteger);
    return { epoch: Math.max(1, ...epochs), keys };
}
