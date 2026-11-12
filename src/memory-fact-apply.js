// Memory facts (design MEMDESIGN2 §4, §6): the callers' entry points. A dossier with no sidecar and no new candidates runs the ORIGINAL
// mergeImportantMemories untouched (old chats and the no-fact path stay byte-identical); anything else goes through the identity-aware store.
import { mergeImportantMemories } from '../core-record-merge.js';
import { mergeFactMemories } from './memory-fact-store.js';
import { metFact, moveFact } from './memory-fact-events.js';

// Sets target.memories (and, on the fact path, manualMemories and memoryFacts) from `existing` plus the model's ordinary memories and code-derived candidates.
export function applyNpcMemories(target, existing, incoming, { limit = 3, sameReply = {}, locked = false, candidates = [] } = {}) {
    if (!existing?.memoryFacts && !candidates.length) {
        target.memories = locked ? [...(existing.memories || [])]
            : mergeImportantMemories(existing.memories, incoming?.memories, incoming?.memoryRetention, limit, existing.manualMemories, sameReply);
        return target;
    }
    const result = mergeFactMemories({
        memories: existing.memories, manual: existing.manualMemories, facts: existing.memoryFacts,
        incoming: locked ? [] : incoming?.memories, retention: incoming?.memoryRetention, incomingLimit: limit,
        candidates, locked, message: sameReply.message, stamps: sameReply.stamps,
    });
    target.memories = result.memories;
    if (result.manual.length) target.manualMemories = result.manual; else delete target.manualMemories;
    if (result.facts) target.memoryFacts = result.facts; else delete target.memoryFacts;
    return target;
}

// A standalone scan's own accepted relationship movement (the appliedDelta of this very merge, never an ask) as candidates for the reply R.
export function scanFactCandidates(existing, relationshipUpdate, { facts, R, player } = {}) {
    if (!facts?.source || !Number.isInteger(R) || facts.hosted) return [];   // hosted, the slice owns the movement (its allowance, tier cut and gates)
    const move = moveFact({ applied: relationshipUpdate?.appliedDelta, tier: relationshipUpdate?.impact, R, ns: 'scan', source: facts.source, opId: `${existing?.id ?? ''}:${facts.source}`, player });
    return move ? [move] : [];
}

// The first meeting of a person with the player: the merged record is present (not archived) on this marked live reply and was never present
// before (`seenCount` moves only on presence, a manual add or a cast dossier made earlier has 0). Created, promoted, seeded and cast alike; a
// person only mentioned is never present, and an older dossier that was present before carries a count, so it never gets "first met".
export function firstMeetingCandidates(existing, merged, { facts, R, player } = {}) {
    if (!facts?.source || !merged?.present || merged.archived || Number(existing?.seenCount) > 0) return [];
    const fact = metFact({ npcId: merged.id, R, source: facts.source, player, place: merged.location });
    return fact ? [fact] : [];
}
