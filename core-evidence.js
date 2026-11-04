/* NPC State Delta profile-development evidence: evidence normalizing/merging/retention, claim negation and polarity, representation
   checks, trend opposites, evidence tagging and gradualProfileEvolutionReady, with PROFILE_EVIDENCE_LIMIT. A pure part of
   core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it exported before.
   Imports only core-text.js, core-relationship.js, core-durable.js, core-behavior.js and the field registry. */
import { compactDurableText, DURABLE_PROFILE_LIMITS, durableRefinementTokens, durableSeedGrounded, durableSemanticSimilarity, semanticDedupeItems, splitDurableClaimUnits } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { behaviorProfileBody, behaviorProfileFamily, durableProfileCollectionCandidateGrounded, moralityPolarity, normalizeBehaviorProfile, strippedDevelopmentEvidence } from './core-behavior.js';
import { PROFILE_EVIDENCE_FIELDS } from './src/fields/registry.js';
import { containsEvolutionLanguage, identityMoralityConflict, normalizeMannerisms } from './core-durable.js';

export const PROFILE_EVIDENCE_LIMIT = 4;

export function emptyProfileEvidence() {
    return { personality: [], speech: [], appearance: [], mannerisms: [], behaviorProfile: [] };
}

// Behavioral Lever evidence keeps up to two recent observations per lever category (four
// uncategorised), so a second sighting of one tendency is not rotated out by unrelated behaviour
// before it arrives. Scanner prompts still carry only the newest PROFILE_EVIDENCE_LIMIT items.
const BEHAVIOR_EVIDENCE_LIMIT = 12;
const BEHAVIOR_EVIDENCE_PER_FAMILY = 2;

function retainBehaviorEvidence(items) {
    const deduped = semanticDedupeItems(cleanList(items, BEHAVIOR_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence), {
        maxItems: BEHAVIOR_EVIDENCE_LIMIT * 2,
        maxChars: DURABLE_PROFILE_LIMITS.evidence,
        similarity: 0.56,
    });
    const counts = new Map();
    const kept = [];
    for (let i = deduped.length - 1; i >= 0 && kept.length < BEHAVIOR_EVIDENCE_LIMIT; i -= 1) {
        const family = behaviorProfileFamily(String(deduped[i]).replace(/^\[m\d+\]\s*/i, ''));
        const used = counts.get(family) || 0;
        if (used >= (family ? BEHAVIOR_EVIDENCE_PER_FAMILY : PROFILE_EVIDENCE_LIMIT)) continue;
        counts.set(family, used + 1);
        kept.unshift(deduped[i]);
    }
    return kept;
}

export function normalizeProfileEvidence(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalize = list => semanticDedupeItems(cleanList(list, PROFILE_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence), {
        maxItems: PROFILE_EVIDENCE_LIMIT,
        maxChars: DURABLE_PROFILE_LIMITS.evidence,
        similarity: 0.56,
    });
    return {
        personality: normalize(source.personality),
        speech: normalize(source.speech),
        appearance: normalize(source.appearance),
        mannerisms: normalize(source.mannerisms),
        behaviorProfile: retainBehaviorEvidence(source.behaviorProfile ?? source.behavior_profile),
    };
}

// The evidence a scanner prompt carries: every field at its ordinary size.
export function promptProfileEvidence(value = {}) {
    const evidence = normalizeProfileEvidence(value);
    return { ...evidence, behaviorProfile: evidence.behaviorProfile.slice(-PROFILE_EVIDENCE_LIMIT) };
}

export function mergeRecentProfileEvidence(existing = [], incoming = [], field = '') {
    if (field === 'behaviorProfile') return retainBehaviorEvidence([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
    return semanticDedupeItems([
        ...cleanList(existing, PROFILE_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence),
        ...cleanList(incoming, PROFILE_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence),
    ], {
        maxItems: PROFILE_EVIDENCE_LIMIT,
        maxChars: DURABLE_PROFILE_LIMITS.evidence,
        similarity: 0.56,
    });
}

export function mergeProfileEvidence(existing = {}, incoming = {}) {
    const before = normalizeProfileEvidence(existing);
    const added = normalizeProfileEvidence(incoming);
    return Object.fromEntries(PROFILE_EVIDENCE_FIELDS.map(field => [
        field, mergeRecentProfileEvidence(before[field], added[field], field),
    ]));
}

export function profileEvidenceCount(value = {}) {
    const normalized = normalizeProfileEvidence(value);
    return PROFILE_EVIDENCE_FIELDS.reduce((sum, field) => sum + normalized[field].length, 0);
}

function profileEvidenceConcept(value) {
    // A [mN] source tag is provenance, not part of the label, so tagged evidence still matches by category.
    const text = cleanText(String(value || '').replace(/^\[m\d+\]\s*/i, ''), DURABLE_PROFILE_LIMITS.evidence);
    const match = text.match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]{1,48})\s*:\s*(.+)$/u);
    return match ? normalizeName(match[1]) : '';
}

function profileEvidenceRelated(a, b) {
    const aTag = profileEvidenceConcept(a);
    const bTag = profileEvidenceConcept(b);
    if (aTag && bTag) return aTag === bTag || durableSemanticSimilarity(aTag, bTag) >= 0.72;
    return durableSemanticSimilarity(a, b) >= 0.48;
}

export function durableProfileEvidenceRelated(a, b) {
    return profileEvidenceRelated(a, b);
}

export function durableProfileEvolutionCandidateGrounded(field, existing, incoming, evidenceItems = []) {
    const key = field === 'personality' ? 'personality' : field === 'speech' ? 'speech' : '';
    if (!key) return false;
    const maxChars = DURABLE_PROFILE_LIMITS[key];
    const oldText = compactDurableText(existing, maxChars, key === 'speech' ? 5 : 6);
    const newText = compactDurableText(incoming, maxChars, key === 'speech' ? 5 : 6);
    if (!oldText || !newText || normalizeName(oldText) === normalizeName(newText)) return false;
    if (containsEvolutionLanguage(newText)) return false;
    if (key === 'personality' && identityMoralityConflict(oldText, newText)) return false;
    const oldTokens = new Set(durableRefinementTokens(oldText));
    const changedTokens = [...new Set(durableRefinementTokens(newText))].filter(token => !oldTokens.has(token));
    if (!changedTokens.length) return false;
    const evidenceTokens = new Set(durableRefinementTokens((Array.isArray(evidenceItems) ? evidenceItems : []).join(' ')));
    const supported = changedTokens.filter(token => evidenceTokens.has(token)).length;
    const required = changedTokens.length <= 2 ? 1 : Math.max(2, Math.ceil(changedTokens.length * 0.4));
    return supported >= required;
}

// Gradual candidate support deliberately does not merge concept buckets. The proposed full
// candidate is the semantic bridge: independent evidence groups must each support newly proposed
// characterization, while their union must ground enough of the changed candidate to pass the
// ordinary candidate-grounding threshold. Field/change class decides whether two or three are needed.
function durableProfileClaimsEquivalent(left, right) {
    if (!left || !right || durableClaimPolarityConflict(left, right)) return false;
    return durableDevelopmentClaimRepresented(left, right)
        || durableDevelopmentClaimRepresented(right, left)
        || durableSemanticSimilarity(left, right) >= 0.42;
}

function durableEvidenceSupportsProfileClaim(claim, evidence) {
    const sample = strippedDevelopmentEvidence(evidence);
    if (!claim || !sample || durableClaimPolarityConflict(claim, sample)) return false;
    return durableDevelopmentClaimRepresented(claim, sample)
        || durableSeedGrounded(claim, sample)
        || durableSemanticSimilarity(claim, sample) >= 0.28;
}

export function durableProfileCandidateSupport(field, existing, incoming, evidenceGroups = [], requiredObservations = null) {
    const key = field === 'personality' ? 'personality' : field === 'speech' ? 'speech' : '';
    const empty = {
        ready: false,
        grounded: false,
        changeClass: 'none',
        requiredObservations: Math.max(1, Number(requiredObservations) || 3),
        supportingGroups: 0,
        introducedClaims: [],
        retiredClaims: [],
        supportCounts: [],
    };
    if (!key) return empty;

    const maxChars = DURABLE_PROFILE_LIMITS[key];
    const oldText = compactDurableText(existing, maxChars, key === 'speech' ? 5 : 6);
    const newText = compactDurableText(incoming, maxChars, key === 'speech' ? 5 : 6);
    if (!oldText || !newText || normalizeName(oldText) === normalizeName(newText)) return empty;
    if (containsEvolutionLanguage(newText)) return empty;
    if (key === 'personality' && identityMoralityConflict(oldText, newText)) return empty;

    const oldClaims = splitDurableClaimUnits(oldText);
    const newClaims = splitDurableClaimUnits(newText);
    const introducedClaims = newClaims.filter(claim =>
        !oldClaims.some(previous => durableProfileClaimsEquivalent(previous, claim)));
    const retiredClaims = oldClaims.filter(claim =>
        !newClaims.some(next => durableProfileClaimsEquivalent(claim, next)));
    const polarityReversal = oldClaims.some(previous =>
        newClaims.some(next => durableClaimPolarityConflict(previous, next)));
    const changeClass = retiredClaims.length || polarityReversal ? 'reversal' : 'additive';
    const required = Math.max(1, Number(requiredObservations)
        || (key === 'speech' && changeClass === 'additive' ? 2 : 3));
    const groups = (Array.isArray(evidenceGroups) ? evidenceGroups : [])
        .map(strippedDevelopmentEvidence)
        .filter(Boolean);
    if (!introducedClaims.length || !groups.length) {
        return { ...empty, changeClass, requiredObservations: required, introducedClaims, retiredClaims };
    }

    const supportCounts = introducedClaims.map(claim =>
        groups.filter(group => durableEvidenceSupportsProfileClaim(claim, group)).length);
    const supportingGroups = groups.filter(group =>
        introducedClaims.some(claim => durableEvidenceSupportsProfileClaim(claim, group))).length;
    const grounded = supportCounts.every(count => count >= 1)
        && durableProfileEvolutionCandidateGrounded(key, oldText, newText, groups);
    return {
        ready: grounded && supportCounts.every(count => count >= required),
        grounded,
        changeClass,
        requiredObservations: required,
        supportingGroups,
        introducedClaims,
        retiredClaims,
        supportCounts,
    };
}

export function durableProfileAggregateCandidateGrounded(field, existing, incoming, evidenceGroups = [], requiredGroups = 3) {
    const required = Math.max(2, Number(requiredGroups) || 3);
    const key = field === 'personality' ? 'personality' : field === 'speech' ? 'speech' : '';
    if (!key) return false;
    const maxChars = DURABLE_PROFILE_LIMITS[key];
    const oldText = compactDurableText(existing, maxChars, key === 'speech' ? 5 : 6);
    const newText = compactDurableText(incoming, maxChars, key === 'speech' ? 5 : 6);
    if (!oldText || !newText || normalizeName(oldText) === normalizeName(newText)) return false;
    if (containsEvolutionLanguage(newText)) return false;
    if (key === 'personality' && identityMoralityConflict(oldText, newText)) return false;

    const oldTokens = new Set(durableRefinementTokens(oldText));
    const changedTokens = [...new Set(durableRefinementTokens(newText))].filter(token => !oldTokens.has(token));
    if (!changedTokens.length) return false;
    const groups = (Array.isArray(evidenceGroups) ? evidenceGroups : [])
        .map(value => cleanText(value, DURABLE_PROFILE_LIMITS.evidence))
        .filter(Boolean);
    if (groups.length < required) return false;

    const changedSet = new Set(changedTokens);
    const supportingGroups = groups.filter(value => durableRefinementTokens(value).some(token => changedSet.has(token))).length;
    if (supportingGroups < required) return false;
    return durableProfileEvolutionCandidateGrounded(key, oldText, newText, groups);
}

function developmentEvidenceClaim(value) {
    let text = cleanText(String(value || '').replace(/^\[m\d+\]\s*/i, ''), DURABLE_PROFILE_LIMITS.evidence);
    if (!text) return null;
    const labeled = text.match(/^([^:]{1,52}):\s*(.+)$/);
    const concept = cleanText(labeled?.[1], 80);
    const body = cleanText(labeled ? labeled[2] : text, DURABLE_PROFILE_LIMITS.evidence);
    return body ? { concept, body } : null;
}

function durableClaimHasNegation(value) {
    const text = normalizeName(value);
    return /\b(?:not|never|no longer|without|lacks?|lacking|ceased|stopped|avoids?|rejects?|unable|cannot|cant)\b/.test(text);
}

function durableClaimWithoutNegation(value) {
    return normalizeName(value)
        .replace(/\b(?:not|never|no longer|without|lacks?|lacking|ceased|stopped|avoids?|rejects?|unable|cannot|cant)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function singleClausePolarityConflict(claim, targetClause) {
    if (identityMoralityConflict(claim, targetClause) || identityMoralityConflict(targetClause, claim)) return true;
    const claimCore = durableClaimWithoutNegation(claim);
    const targetCore = durableClaimWithoutNegation(targetClause);
    if (!claimCore || !targetCore) return false;
    const coreSimilarity = durableSemanticSimilarity(claimCore, targetCore);
    const coreTokensClaim = new Set(durableRefinementTokens(claimCore));
    const coreTokensTarget = new Set(durableRefinementTokens(targetCore));
    let overlap = 0;
    for (const t of coreTokensClaim) if (coreTokensTarget.has(t)) overlap += 1;
    const relevant = coreSimilarity >= 0.48 || (overlap >= 2 && overlap / Math.min(coreTokensClaim.size, coreTokensTarget.size) >= 0.6);
    if (!relevant) return false;

    const claimNegated = durableClaimHasNegation(claim);
    const targetNegated = durableClaimHasNegation(targetClause);
    if (claimNegated !== targetNegated) return true;
    if (claimNegated && targetNegated) {
        const claimPol = moralityPolarity(claim);
        const targetPol = moralityPolarity(targetClause);
        if (claimPol && targetPol && claimPol !== targetPol) return true;
        if (identityMoralityConflict(claim, targetClause)) return true;
    }
    return false;
}

function durableClaimPolarityConflict(claim, target) {
    const claimClauses = splitDurableClaimUnits(claim);
    const targetClauses = splitDurableClaimUnits(target);
    for (const cClause of claimClauses) {
        for (const tClause of targetClauses) {
            if (singleClausePolarityConflict(cClause, tClause)) return true;
        }
    }
    return false;
}

// Opposite tendencies that break a pending development trend: a later sighting of the other side
// means the trend did not hold. Each pair is a pair of word stems.
const DEVELOPMENT_TREND_OPPOSITES = [
    ['confiden', 'timid'], ['confiden', 'hesitan'], ['confiden', 'insecur'], ['bold', 'meek'], ['bold', 'shy'],
    ['assertiv', 'submissiv'], ['assertiv', 'docile'], ['assertiv', 'deferen'], ['independen', 'dependen'],
    ['independen', 'relian'], ['calm', 'anxious'], ['calm', 'panick'], ['warm', 'cold'], ['trusting', 'distrust'],
    ['trusting', 'suspicio'], ['cheerful', 'gloom'], ['open', 'guarded'], ['outspoken', 'silent'], ['proud', 'asham'],
    ['hopeful', 'despair'], ['decisive', 'indecisi'], ['patient', 'impatien'],
];

// True when a new observation contradicts a pending one: an opposite tendency, or the same claim
// negated. Used to break a development trend before it can accumulate further.
export function durableEvidenceContradicts(pending, incoming) {
    const left = strippedDevelopmentEvidence(pending);
    const right = strippedDevelopmentEvidence(incoming);
    if (!left || !right) return false;
    if (durableClaimPolarityConflict(left, right)) return true;
    if (durableClaimHasNegation(left) || durableClaimHasNegation(right)) return false;
    const words = text => normalizeName(text).split(/\s+/).filter(Boolean);
    const has = (list, stem) => list.some(word => word.startsWith(stem));
    const a = words(left);
    const b = words(right);
    return DEVELOPMENT_TREND_OPPOSITES.some(([x, y]) => (has(a, x) && has(b, y) && !has(a, y) && !has(b, x))
        || (has(a, y) && has(b, x) && !has(a, x) && !has(b, y)));
}

function durableDevelopmentClaimRepresented(claim, target) {
    const source = cleanText(claim, DURABLE_PROFILE_LIMITS.evidence);
    const accepted = cleanText(target, DURABLE_PROFILE_LIMITS.behaviorProfile * 6);
    if (!source || !accepted) return false;
    if (durableClaimPolarityConflict(source, accepted)) return false;

    const claimClauses = splitDurableClaimUnits(source);
    const acceptedClauses = splitDurableClaimUnits(accepted);
    const acceptedTokens = new Set(durableRefinementTokens(accepted));

    return claimClauses.every(cClause => {
        const cText = cleanText(cClause, DURABLE_PROFILE_LIMITS.evidence);
        const cTokens = [...new Set(durableRefinementTokens(cText))].filter(t => t.length >= 3 && !/^\d+$/.test(t));
        if (!cTokens.length) return true;
        if (acceptedClauses.some(tClause => singleClausePolarityConflict(cClause, tClause))) return false;

        const overlap = cTokens.filter(t => acceptedTokens.has(t)).length;
        const required = cTokens.length <= 2
            ? cTokens.length
            : (cTokens.length === 3 ? 2 : Math.max(2, Math.ceil(cTokens.length * 0.5)));
        return overlap >= required;
    });
}

export function durableProfileEvidenceAlreadyRepresented(field, current, evidenceItems = []) {
    const claims = (Array.isArray(evidenceItems) ? evidenceItems : [])
        .map(developmentEvidenceClaim).filter(Boolean);
    if (!claims.length) return false;
    let targets = [];
    if (field === 'personality' || field === 'speech') {
        const currentText = cleanText(current, DURABLE_PROFILE_LIMITS[field]);
        if (currentText) targets = [currentText];
    } else if (field === 'mannerisms') {
        targets = normalizeMannerisms(current);
    } else if (field === 'behaviorProfile') {
        targets = normalizeBehaviorProfile(current);
    } else {
        return false;
    }
    if (!targets.length) return false;
    return claims.every(claim => targets.some(target =>
        durableDevelopmentClaimRepresented(claim.body, target)
        || (field === 'behaviorProfile' && durableDevelopmentClaimRepresented(claim.body, behaviorProfileBody(target)))));
}

export function unresolvedProfileEvidence(field, accepted, prior = [], incoming = []) {
    return mergeRecentProfileEvidence(prior, incoming, field).filter(item =>
        !durableProfileEvidenceAlreadyRepresented(field, accepted, [item]));
}
export const unresolvedCollectionEvidence = unresolvedProfileEvidence;

export function durableProfileEvidenceReason(field, existing, incoming, evidenceItems = []) {
    const evidence = (Array.isArray(evidenceItems) ? evidenceItems : [])
        .map(strippedDevelopmentEvidence).filter(Boolean);
    if (!evidence.length) return '';
    const grounded = field === 'personality' || field === 'speech'
        ? durableProfileEvolutionCandidateGrounded(field, existing, incoming, evidence)
        : durableProfileCollectionCandidateGrounded(field, existing, incoming, evidence);
    return grounded ? cleanText(evidence.join(' '), 500) : '';
}

/**
 * (1.2.11) A scan of one reply (an automatic quick scan, or a one-pass block) writes its profile
 * evidence without a message tag: tagged with that reply ("[m12] …"), a habit seen again in a later
 * reply counts as a second sighting however alike the words. Tagged items are left as they are.
 * Returns a copy; the input is not touched.
 */
export function tagScanEvidence(parsed, messageId) {
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(messageId) || messageId < 0) return parsed;
    const rows = Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed.profile_updates) ? parsed.profile_updates : null);
    if (!rows) return parsed;
    const tag = item => (typeof item === 'string' && item.trim() && !/^\s*\[m\d+\]/i.test(item) ? `[m${messageId}] ${item.trim()}` : item);
    const tagged = rows.map(row => {
        const evidence = row?.evidence;
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return row;
        return { ...row, evidence: Object.fromEntries(Object.entries(evidence).map(([field, list]) => [field, Array.isArray(list) ? list.map(tag) : list])) };
    });
    return Array.isArray(parsed.profileUpdates) ? { ...parsed, profileUpdates: tagged } : { ...parsed, profile_updates: tagged };
}

// (1.2.11) The message an evidence item was seen in ("[m12] …"), or '' when it carries no tag.
const evidenceSource = item => (String(item ?? '').match(/^\s*\[m(\d+)\]/i) ?? [])[1] ?? '';

function newProfileEvidence(prior = [], incoming = [], duplicateSimilarity = 0.56) {
    const before = cleanList(prior, BEHAVIOR_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence);
    return cleanList(incoming, PROFILE_EVIDENCE_LIMIT * 2, DURABLE_PROFILE_LIMITS.evidence).filter(item =>
        !before.some(old => {
            if (normalizeName(old) === normalizeName(item)) return true;
            // (1.2.11) Seen in another message is another sighting, however alike the words: only a
            // re-read of the same message (or untagged near-copies) is a duplicate.
            const was = evidenceSource(old);
            const now = evidenceSource(item);
            if (was && now && was !== now) return false;
            return durableSemanticSimilarity(old, item) >= duplicateSimilarity;
        }));
}

// A lever swing needs the behaviour seen again in a later scene. Two scenes of the same behaviour
// are often narrated in similar words, so for Behavioral Levers only a near-copy (a replayed or
// re-scanned observation) is a duplicate; related but distinct wording counts as a second sighting.
// (1.2.11) So for Mannerisms: a habit is the same act again, in much the same words.
const BEHAVIOR_EVIDENCE_DUPLICATE_SIMILARITY = 0.85;
const REPEAT_EVIDENCE_FIELDS = new Set(['behaviorProfile', 'mannerisms']);

export function gradualProfileEvolutionReady(field, beforeEvidence, incomingEvidence) {
    const prior = beforeEvidence[field] || [];
    const fresh = newProfileEvidence(prior, incomingEvidence[field] || [],
        REPEAT_EVIDENCE_FIELDS.has(field) ? BEHAVIOR_EVIDENCE_DUPLICATE_SIMILARITY : 0.56);
    if (!prior.length || !fresh.length) return false;
    return fresh.some(now => prior.some(old => profileEvidenceRelated(old, now)));
}
