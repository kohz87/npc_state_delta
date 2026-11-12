// Memory facts (design MEMDESIGN2 §4, §8): the scan's three touch points, kept out of runtime-scan.js. (1) the conditional paragraph for the scanner
// prompt (pending facts whose reply is in the call's own window; never for a one-pass capture), (2) the merge option that turns fact derivation on
// only for a marked live reply, (3) the phrasing applied after a successful merge.
import { fingerprintMessage, lineageCheckpointKey } from '../branch.js';
import { isMarked, memoryFactsOn } from './memory-fact-marks.js';
import { applyPhrasing, memoryParagraph, selectHandles } from './memory-fact-phrase.js';

const fingerprintAt = chat => id => (Number.isInteger(id) && chat?.[id] ? fingerprintMessage(chat[id]) : null);

// { text, handles }: `windowIds` are the message ids placed in the transcript, captured with the same gating that built it, before dispatch.
export function scanMemoryParagraph(state, settings, windowIds, chat) {
    if (!memoryFactsOn(settings)) return { text: '', handles: [] };
    return memoryParagraph(selectHandles(state?.npcs, windowIds, fingerprintAt(chat)), state?.npcs);
}

// { source, player, hosted } for the merge, or null: the setting is on and this exact reply (lineage key) carries a live-eligibility mark.
// `hosted` (the host's meter slice owns the relationship movement) keeps the movement fact out; the first meeting is NSD's own, hosted or not.
export function scanMemoryFacts(state, settings, lineage, messageId, player, { hosted = false } = {}) {
    if (!memoryFactsOn(settings) || !Number.isInteger(messageId)) return null;
    const source = lineageCheckpointKey(lineage, messageId);
    return isMarked(state, source) ? { source, player: String(player ?? ''), ...(hosted ? { hosted: true } : {}) } : null;
}

export function phraseMerged(mergedState, handles, parsed, chat) {
    if (!handles?.length) return mergedState;
    return { ...mergedState, npcs: applyPhrasing(mergedState.npcs, handles, parsed?.mem, { ok: true, fingerprintAt: fingerprintAt(chat) }) };
}
