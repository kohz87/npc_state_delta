/* NPC State Delta list/field merge helpers: label/place matching, list and Important Memory merging, and durable-text
   acceptance shared by scan and profile updates. Split from core-record.js without change; core-record.js re-exports
   every name it exported before. */
import { ageSpecificity, isInterimNpcLabel, isRoleDescriptionLabel, normalizeGender } from './core-identity.js';
import { DURABLE_PROFILE_LIMITS, durableRefinementTokens, durableSeedGrounded, durableSemanticSimilarity, semanticDedupeItems } from './core-relationship.js';
import { cleanList, normalizeName } from './core-text.js';
import { identityConflict, partialNamePair, placesOverlap } from './core-merge-names.js';

import { keyRelationshipSubject, mergeKeyRelationshipUpdates, tiesTracked } from './core-keyrel.js';
import { isSafeUnmarkedDurableReplacement } from './core-durable.js';
import { groundedTraitEvent } from './core-durable-grounding.js';

import { IMPORTANT_MEMORY_LIMIT } from './core-record-shared.js';
import { mergeCustomFieldValues } from './core-record-custom-fields.js';
// A shared role-description label ("Innkeeper", "the captain") fits many people, so on its own it
// links a scan row to a properly named record only with continuity evidence: sameIndividual, the
// record being present (before this scan reset presence), or an overlapping location/home base. A
// record still named by a role keeps plain label matching so interim-identity promotion and name
// reveals continue to work.
export function scanLabelsMatch(record, incoming, presentIds = new Set()) {
    const incomingLabels = [incoming.name, ...(incoming.aliases || [])].filter(label => normalizeName(label));
    const recordLabels = [record.name, ...(record.aliases || [])].filter(label => normalizeName(label));
    const sharedKeys = new Set(recordLabels.map(normalizeName).filter(key => incomingLabels.some(label => normalizeName(label) === key)));
    if (!sharedKeys.size) return false;
    // A surname or a title-less name alone never joins people with different genders or roles (see partialNamePair).
    if (partialNamePair(record.name, incoming.name) && identityConflict(record, incoming, incoming.sameIndividual === true)) return false;
    if (isInterimNpcLabel(record.name, record.identityKind) || isRoleDescriptionLabel(record.name)) return true;
    // A label counts as a name when either side spells it as one ("Red" beside "red").
    if ([...recordLabels, ...incomingLabels].some(label => sharedKeys.has(normalizeName(label)) && !isRoleDescriptionLabel(label))) return true;
    if (incoming.sameIndividual === true || record.present === true || presentIds.has(record.id)) return true;
    return [record.location, record.homeBase].some(place =>
        [incoming.location, incoming.homeBase].some(other => placesOverlap(place, other)));
}

export function candidateMatches(existing, incoming, presentIds) {
    if (incoming.id && incoming.id === existing.id) return true;
    return scanLabelsMatch(existing, incoming, presentIds);
}

export function mergeLists(oldList, newList, limit = 8) {
    const result = [];
    const seen = new Set();
    for (const item of [...(oldList || []), ...(newList || [])]) {
        const key = normalizeName(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= limit) break;
    }
    return result;
}

// A second pass over a reply already recorded (a new person's backfill or fill reads the reply the one-pass scan just stored) re-tells
// that reply's memory in other words, too far apart for the similarity rule ("Registered Astra ... bodice button snapped ... culling
// contracts" against "Took Astra's registration fee ... bodice burst open ... culling contracts", about 0.2 against 0.58). Narrow on purpose:
// only a new memory, against a stored memory stamped at the SAME reply (same message id), never a hand-written (pinned) one, sharing
// three or more distinctive words (4+ letters, proper names and places left out: they recur in every memory of a person) that are at
// least a quarter of the shorter memory's words, is that event again and is not stored. Another reply, or a near-similar but different event, is kept.
function distinctWords(text) {
    const names = new Set();
    for (const hit of String(text || '').matchAll(/[A-Z][a-z]+/g)) {
        if (hit.index > 0 && !/[.!?]\s*$/.test(String(text).slice(0, hit.index))) names.add(hit[0].toLowerCase());
    }
    return new Set(durableRefinementTokens(text).filter(token => token.length >= 4 && !/^\d+$/.test(token) && !names.has(token)));
}
export function sameReplyRetelling(item, oldList = [], stamps = {}, message = null, pinned = []) {
    if (!Number.isInteger(message)) return false;
    const keep = new Set((Array.isArray(pinned) ? pinned : []).map(normalizeName));
    if (keep.has(normalizeName(item))) return false;
    const words = distinctWords(item);
    return (Array.isArray(oldList) ? oldList : []).some(old => {
        if (stamps?.[normalizeName(old)]?.m !== message || keep.has(normalizeName(old))) return false;
        const oldWords = distinctWords(old);
        const shared = [...oldWords].filter(word => words.has(word)).length;
        return shared >= 3 && shared / Math.min(oldWords.size, words.size) >= 0.25;
    });
}

// (cleanup step 6) Memories the reader entered by hand (`pinned`, the record's manualMemories) are
// never evicted: new ones take only the slots the reader's own leave free. `sameReply` ({ stamps, message }) drops re-tellings (above).
export function mergeImportantMemories(oldList, newList, retentionList = [], incomingLimit = 3, pinned = [], sameReply = {}) {
    const fresh = (Array.isArray(newList) ? newList : []).filter(item => !sameReplyRetelling(item, oldList, sameReply.stamps, sameReply.message, pinned));
    const merged = mergeUnpinnedMemories(oldList, fresh, retentionList, incomingLimit);
    const keep = (Array.isArray(pinned) ? pinned : []).map(normalizeName).filter(Boolean);
    if (!keep.length) return merged;
    const isPinned = item => keep.includes(normalizeName(item));
    const existing = cleanList(oldList, 64, DURABLE_PROFILE_LIMITS.memory);
    const missing = existing.filter(item => isPinned(item) && !merged.some(other => normalizeName(other) === normalizeName(item)));
    if (!missing.length) return merged;
    const order = [...existing, ...merged.filter(item => !existing.some(other => normalizeName(other) === normalizeName(item)))];
    const chosen = new Set([...merged, ...missing].map(normalizeName));
    const out = order.filter(item => chosen.has(normalizeName(item)));
    // Too many: drop the oldest memories the reader did not write.
    while (out.length > IMPORTANT_MEMORY_LIMIT) {
        const at = out.findIndex(item => !isPinned(item));
        if (at < 0) break;
        out.splice(at, 1);
    }
    return out.slice(-IMPORTANT_MEMORY_LIMIT);
}

function mergeUnpinnedMemories(oldList, newList, retentionList = [], incomingLimit = 3) {
    const existing = semanticDedupeItems(cleanList(oldList, 64, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: 64, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const limit = Math.max(1, Math.min(IMPORTANT_MEMORY_LIMIT, Math.round(Number(incomingLimit) || 3)));
    const incoming = semanticDedupeItems(cleanList(newList, Math.max(6, limit * 2), DURABLE_PROFILE_LIMITS.memory), {
        maxItems: limit, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const pool = semanticDedupeItems([...existing, ...incoming], {
        maxItems: 64, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    if (pool.length <= IMPORTANT_MEMORY_LIMIT) return pool;

    const requested = semanticDedupeItems(cleanList(retentionList, IMPORTANT_MEMORY_LIMIT * 2, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: IMPORTANT_MEMORY_LIMIT, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const selected = [];
    const selectCanonical = request => {
        let best = null;
        let bestScore = 0;
        for (const candidate of pool) {
            const score = normalizeName(candidate) === normalizeName(request) ? 1 : durableSemanticSimilarity(candidate, request);
            if (score > bestScore) { best = candidate; bestScore = score; }
        }
        return bestScore >= 0.56 ? best : null;
    };
    for (const item of requested) {
        const canonical = selectCanonical(item);
        if (!canonical || selected.some(value => durableSemanticSimilarity(value, canonical) >= 0.58)) continue;
        selected.push(canonical);
    }

    if (selected.length) {
        // A partial/malformed model selection must not re-lock the list. Fill any
        // missing slots with newest semantically distinct memories first.
        for (const item of [...incoming, ...existing].reverse()) {
            if (selected.some(value => durableSemanticSimilarity(value, item) >= 0.58)) continue;
            selected.push(item);
            if (selected.length >= IMPORTANT_MEMORY_LIMIT) break;
        }
        return selected.slice(0, IMPORTANT_MEMORY_LIMIT);
    }

    // Scanner omitted semantic retention. Prefer the newest five distinct events.
    return pool.slice(-IMPORTANT_MEMORY_LIMIT);
}

// ---- Durable-field rules shared by a scan row (npcs[]) and a profile update (profileUpdates[]) ----
// (cleanup step 5) A model may send an existing NPC's durable facts in either channel; both apply
// them by these same rules.

// The plain durable texts a profile update applies with the npcs[] rules (the profile texts, Personality,
// Speech and Appearance, have their own evidence-gated rules there).
export const PROFILE_UPDATE_TEXT_FIELDS = Object.freeze(['role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'background']);

// Role, gender, home base, background and ages are keep-by-default once established.
export function durableTextAccepted(field, existing, incoming, value, options = {}) {
    if (field === 'gender') {
        const prior = normalizeGender(existing.gender);
        return !(prior && prior !== value && (incoming.genderState !== 'correct' || !String(incoming.genderReason || '').trim()));
    }
    if (field === 'role') {
        // (card traits win) The source event itself supplies the reason for a bare role; an
        // explicit reason, when supplied, must describe that same target-specific event.
        const prior = String(existing.role || '').trim();
        if (!prior || normalizeName(prior) === normalizeName(value)) return true;
        return groundedTraitEvent(existing, value, incoming.roleReason, options.developmentContext, 'role');
    }
    if (field === 'homeBase') {
        const prior = String(existing.homeBase || '').trim();
        const context = String(options.developmentContext || '').trim();
        if (prior) {
            if (incoming.homeBaseState !== 'update' || !String(incoming.homeBaseReason || '').trim()) return false;
            if (context && !durableSeedGrounded(value, context)) return false;
        } else if (context && !durableSeedGrounded(value, context)) {
            return false;
        }
        return true;
    }
    if (field === 'background') {
        // (cleanup step 6) Background is durable history and keep-by-default like the home base: an
        // established one changes with backgroundState:"update" + backgroundReason + grounding. No
        // prompt asks for that state yet, so a grounded restatement that keeps every stored concept
        // (the unmarked-refinement safety appearance uses) is accepted too; a shorter restatement that
        // drops a stored clause is not.
        const prior = String(existing.background || '').trim();
        const context = String(options.developmentContext || '').trim();
        if (prior && normalizeName(prior) === normalizeName(value)) return false;
        if (prior) {
            const marked = incoming.backgroundState === 'update' && String(incoming.backgroundReason || '').trim();
            if (!marked && !isSafeUnmarkedDurableReplacement(prior, value)) return false;
        }
        return !context || durableSeedGrounded(value, context);
    }
    if (field === 'age' && String(existing.age || '').trim()) {
        // Chronological age is keep-by-default once established. It may advance from
        // explicit elapsed chronology/birthdays or be corrected by stronger story evidence.
        // An advance may never move an exact numeric age backward or sideways.
        const state = String(incoming.ageState || 'keep');
        if ((state !== 'advance' && state !== 'correct') || !String(incoming.ageReason || '').trim()) return false;
        const oldExact = /^\d{1,3}$/.test(String(existing.age || '').trim()) ? Number(existing.age) : null;
        const newExact = /^\d{1,3}$/.test(String(value || '').trim()) ? Number(value) : null;
        if (state === 'advance' && oldExact !== null && newExact !== null && newExact <= oldExact) return false;
    }
    if (field === 'apparentAge' && String(existing.apparentAge || '').trim()) {
        // Apparent age is also keep-by-default. Visual aging, growth, rejuvenation,
        // transformation, or a grounded correction must be explicitly marked as evolution.
        if (incoming.apparentAgeState !== 'evolve' || !String(incoming.apparentAgeReason || '').trim()) return false;
    }
    if (field === 'age' || field === 'apparentAge') {
        // Even a lifecycle update cannot downgrade stronger age evidence to a weaker estimate.
        if (ageSpecificity(existing[field]) > ageSpecificity(value)) return false;
    }
    return true;
}

// Configured custom fields only, grounded in the source text; a change needs a reason. Null when
// nothing is accepted.
export function incomingCustomFields(existing, incoming, manualFields, options = {}) {
    if (!incoming.customFields || manualFields.has('customFields')) return null;
    return mergeCustomFieldValues(existing.customFields, incoming.customFields, {
        names: options.customFieldNames,
        reason: incoming.customFieldsReason,
        context: options.developmentContext,
    });
}

// The NPC's Key Relationships after an incoming row: merged by counterpart; unmarked rows add new
// counterparts only.
export function incomingKeyRelationships(existing, incoming, manualFields) {
    // A person who records ties' last mentions (tieSeen) lets a full list make room for a new tie (core-keyrel.js); others drop it as before.
    const tieState = tiesTracked(existing) ? { seen: existing.tieSeen, manual: manualFields.has('keyRelationships') } : null;
    if (manualFields.has('keyRelationships')) {
        return [...(existing.keyRelationships || [])];
    } else if ((existing.keyRelationships || []).length) {
        // Key Relationships are durable social continuity, not a running contact log.
        // Scanner omission is never evidence that another important bond vanished. Even
        // during an evolution, update named counterparts in place and preserve unrelated
        // bonds; estrangement/death should change that counterpart's entry rather than
        // silently deleting everyone the model did not mention this turn.
        if (incoming.keyRelationshipsState === 'evolve'
            && String(incoming.keyRelationshipsReason || '').trim()
            && incoming.keyRelationshipsProvided) {
            return mergeKeyRelationshipUpdates(existing.keyRelationships, incoming.keyRelationships || [], tieState);
        } else if (incoming.keyRelationshipsState === 'update'
            && incoming.keyRelationshipsProvided) {
            // Discovery/clarification is not social evolution. A model that correctly
            // marks an update may omit the audit reason, so the explicit lifecycle state
            // plus grounded entries is sufficient to merge by counterpart.
            return mergeKeyRelationshipUpdates(existing.keyRelationships, incoming.keyRelationships, tieState);
        } else if (incoming.keyRelationshipsProvided && (incoming.keyRelationships || []).length) {
            // Recovery for models that extract an explicit newly revealed tie but omit
            // the lifecycle marker entirely. Only NEW counterparts are admitted here;
            // an unmarked rewrite of an already-known person's dynamic is still rejected.
            const knownSubjects = new Set((existing.keyRelationships || []).map(keyRelationshipSubject).filter(Boolean));
            const newlyEstablished = (incoming.keyRelationships || []).filter(entry => {
                const subject = keyRelationshipSubject(entry);
                return subject && !knownSubjects.has(subject);
            });
            return newlyEstablished.length
                ? mergeKeyRelationshipUpdates(existing.keyRelationships, newlyEstablished, tieState)
                : [...(existing.keyRelationships || [])];
        } else {
            return [...(existing.keyRelationships || [])];
        }
    } else {
        return mergeKeyRelationshipUpdates([], incoming.keyRelationships || []);
    }
}
