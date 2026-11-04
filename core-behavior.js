/* NPC State Delta behavior profile: behavior-lever keys/families/bodies, normalization, grounding, ordering, morality and agency
   direction masks, refinement safety and merging. It also holds the three collection-grounding helpers the merge reads, and
   BEHAVIOR_PROFILE_LIMIT. A pure part of core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports
   every name it exported before. Imports only core-text.js, core-relationship.js, core-durable.js. */
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { compactDurableText, DURABLE_PROFILE_LIMITS, durableEvidenceGroundsValue, durableSeedGrounded, durableSemanticSimilarity } from './core-relationship.js';
import { containsBehaviorEvolutionLanguage, durableRefinementCandidateGrounded, durableRefinementSupportText, identityMoralityMarkers, isSafeUnmarkedDurableRefinement, mannerismSimilarity, normalizeMannerisms } from './core-durable.js';

export const BEHAVIOR_PROFILE_LIMIT = 6;

function behaviorProfileKey(value) {
    const text = cleanText(value, DURABLE_PROFILE_LIMITS.behaviorProfile);
    if (!text) return '';
    const match = text.match(/^([\p{L}][\p{L}\p{N} _\-/]{1,36})\s*:/u);
    return normalizeName(match ? match[1] : text);
}

// One category map serves the lever check, refine matching, ordering and the identity/morality
// safety gates. Labels may combine categories ("Care/Warmth"); each part is matched on its own.
const BEHAVIOR_LEVER_CATEGORY_SYNONYMS = Object.freeze([
    ['disposition', /^(?:disposition|temperament|kindness|empathy|morality|moral compass|social baseline|outlook)$/],
    ['cruelty', /^(?:cruelty|mercy|harm|ruthlessness|brutality)$/],
    ['independence', /^(?:independence|agency|autonomy|self reliance|boundaries|obedience|compliance|deference)$/],
    ['care', /^(?:care|caring|care style|affection|warmth|warm|compassion|protectiveness|support style|nurturing|nurturing style)$/],
    ['expressiveness', /^(?:expressiveness|expression|emotional display|emotional expression|emotionality)$/],
    ['conflict', /^(?:conflict|conflict style|assertiveness|anger|temper|composure|restraint|confrontation|aggression|self control)$/],
    ['threat', /^(?:threat|threat sensitivity|threat response|anxiety|risk sensitivity|risk tolerance|risk taking|uncertainty sensitivity|caution|wariness|vigilance|suspicion|trust)$/],
    ['analytical', /^(?:analytical|analytical style|analysis|reasoning|reasoning style|decision style|decision making|thinking style|evidence style|problem solving|judgment|judgement|planning|curiosity)$/],
    ['presentation', /^(?:social presentation|presentation|formality|etiquette|public bearing|social restraint|social style|sociability|demeanor|demeanour|manners)$/],
    ['loyalty', /^(?:loyalty|allegiance|faithfulness|fidelity)$/],
    ['drive', /^(?:drive|ambition|motivation|determination|perseverance)$/],
    ['honesty', /^(?:honesty|candor|candour|truthfulness|sincerity|integrity|deception|deceit|secrecy)$/],
]);

function behaviorLeverLabel(value) {
    const text = cleanText(value, DURABLE_PROFILE_LIMITS.behaviorProfile);
    const colon = text.indexOf(':');
    return colon > 0 && colon <= 40 ? text.slice(0, colon).trim() : '';
}

export function behaviorProfileFamily(value) {
    const key = behaviorProfileKey(value);
    if (!key) return '';
    if (/^(?:disposition|kindness|empathy|morality|social baseline)$/.test(key)) return 'disposition';
    if (/cruelty|mercy|harm/.test(key)) return 'cruelty';
    if (/independence|agency|boundar|autonom|obedien|compliance|compliant|submission|submissive|deference/.test(key)) return 'independence';
    if (/^(?:care|affection|care style|warmth|warm|support style|nurturing style)$/.test(key)) return 'care';
    if (/express|emotional display/.test(key)) return 'expressiveness';
    if (/conflict|anger|composure|restraint|assertiv/.test(key)) return 'conflict';
    if (/^(?:anxiety|threat sensitivity|threat response|risk sensitivity|uncertainty sensitivity)$/.test(key)) return 'threat';
    if (/^(?:analytical style|analysis|reasoning|reasoning style|decision style|thinking style|evidence style|problem solving)$/.test(key)) return 'analytical';
    if (/^(?:social presentation|presentation|formality|etiquette|public bearing|social restraint)$/.test(key)) return 'presentation';
    const label = behaviorLeverLabel(value);
    if (!label) return '';
    for (const part of label.split(/[/&,+]|\band\b/i).map(normalizeName).filter(Boolean)) {
        const match = BEHAVIOR_LEVER_CATEGORY_SYNONYMS.find(([, pattern]) => pattern.test(part));
        if (match) return match[0];
    }
    return '';
}

export function behaviorProfileBody(value) {
    const text = cleanText(value, DURABLE_PROFILE_LIMITS.behaviorProfile);
    const index = text.indexOf(':');
    return index >= 0 ? cleanText(text.slice(index + 1), DURABLE_PROFILE_LIMITS.behaviorProfile) : text;
}

function behaviorProfileTargetSpecific(value) {
    const raw = cleanText(value, DURABLE_PROFILE_LIMITS.behaviorProfile);
    if (!raw) return true;
    const lower = raw.toLowerCase();
    if (/\b(?:with|toward|towards|around)\s+(?:the\s+)?(?:player|pc|\{\{user\}\})\b/.test(lower)) return true;
    if (/\b(?:when|while)\s+(?:alone|intimate)\s+(?:with|around)\b/.test(lower)) return true;
    if (/\b(?:during|after)\s+(?:private\s+)?intimacy\b/.test(lower)) return true;
    if (/\bprivate\s+intimacy\b/.test(lower)) return true;
    if (/\b(?:toward|towards|with|around|jealous of|possessive of)\s+[A-Z][\p{L}\p{M}'’.-]+(?:\s+[A-Z][\p{L}\p{M}'’.-]+)?\b/u.test(raw)) return true;
    if (/\b(?:this|that)\s+(?:incident|scene|night|argument|kiss|encounter)\b/.test(lower)) return true;
    return false;
}

const BEHAVIOR_FAMILY_LABEL = Object.freeze({
    disposition: 'Disposition',
    cruelty: 'Cruelty',
    independence: 'Independence',
    care: 'Care',
    expressiveness: 'Expressiveness',
    conflict: 'Conflict',
    threat: 'Threat Sensitivity',
    analytical: 'Analytical Style',
    presentation: 'Social Presentation',
});

function mergeBehaviorFamilyEntries(existing, incoming, family) {
    const label = BEHAVIOR_FAMILY_LABEL[family] || cleanText(existing, 40).split(':')[0] || 'Behavior';
    const cleanBody = value => behaviorProfileBody(value).replace(/[.;:,]+\s*$/g, '').trim();
    const body = compactDurableText(`${cleanBody(existing)}; ${cleanBody(incoming)}`, Math.max(80, DURABLE_PROFILE_LIMITS.behaviorProfile - label.length - 2), 3)
        .replace(/\.\s*;/g, ';');
    return cleanText(`${label}: ${body}`, DURABLE_PROFILE_LIMITS.behaviorProfile);
}

export function normalizeBehaviorProfile(value) {
    const items = cleanList(value, BEHAVIOR_PROFILE_LIMIT * 3, DURABLE_PROFILE_LIMITS.behaviorProfile)
        .filter(item => !behaviorProfileTargetSpecific(item));
    const out = [];
    for (const item of items) {
        const key = behaviorProfileKey(item);
        if (!key) continue;
        let index = out.findIndex(existing => behaviorProfileKey(existing) === key);
        if (index >= 0) {
            // Same labeled category is a current-summary replacement. Exact semantic
            // equivalents keep the established wording to avoid churn; real refinements use the newer rule.
            out[index] = normalizeName(out[index]) === normalizeName(item) ? out[index] : item;
            continue;
        }
        const family = behaviorProfileFamily(item);
        if (family) index = out.findIndex(existing => behaviorProfileFamily(existing) === family);
        if (index >= 0) out[index] = mergeBehaviorFamilyEntries(out[index], item, family);
        else out.push(item);
    }
    return out.slice(0, BEHAVIOR_PROFILE_LIMIT);
}

// Behavioral Levers describe how an NPC generally responds or decides, as "Category: level - effect"
// with a recognised category ("Threat Sensitivity: high - vets strangers before trusting them").
// Concrete routines, duties, house rules and habits ("keeps a quiet household", "Household: enforces
// curfews") are evidence for a lever, or belong in Mannerisms/Role/Background, so a scan cannot add
// them as levers. Manual edits are not filtered.
const BEHAVIOR_LEVER_NON_LABELS = /^(?:habits?|routines?|duties|duty|rules?|house rules?|chores?|jobs?|work|schedule|practices?|customs?|actions?)$/i;
export function isBehaviorLever(value) {
    const text = cleanText(value, DURABLE_PROFILE_LIMITS.behaviorProfile);
    const label = behaviorLeverLabel(text);
    if (!label || BEHAVIOR_LEVER_NON_LABELS.test(label)) return false;
    if (behaviorProfileBody(text).replace(/[^\p{L}]/gu, '').length < 3) return false;
    return Boolean(behaviorProfileFamily(text));
}

export function groundedBehaviorProfile(value, personality = '', context = '', evidenceItems = [], binding = null) {
    const raw = String(context || '').trim();
    // With a binding, only story text about this NPC counts; narration that never mentions it
    // leaves Personality and attributed evidence as the only support.
    const source = raw && binding ? durableRefinementSupportText(raw, [], binding) : raw;
    const evidence = Array.isArray(evidenceItems) ? evidenceItems : [];
    return normalizeBehaviorProfile(value).filter(entry => {
        if (behaviorProfileTargetSpecific(entry)) return false;
        if (!raw) return true; // structured import/manual compatibility
        const body = behaviorProfileBody(entry);
        const identity = cleanText(personality, DURABLE_PROFILE_LIMITS.personality);
        const personalityGrounded = identity && (
            durableSemanticSimilarity(body, identity) >= 0.34
            || durableSemanticSimilarity(entry, identity) >= 0.34
        );
        return Boolean(personalityGrounded || (source && durableSeedGrounded(body, source)) || durableEvidenceGroundsValue(body, evidence));
    });
}

function behaviorProfilePriority(value) {
    const family = behaviorProfileFamily(value);
    const priority = {
        disposition: 0,
        cruelty: 1,
        independence: 2,
        care: 3,
        expressiveness: 4,
        conflict: 5,
        threat: 6,
        analytical: 7,
        presentation: 8,
        loyalty: 9,
        drive: 10,
        honesty: 11,
    };
    return Object.prototype.hasOwnProperty.call(priority, family) ? priority[family] : 12;
}

export function orderedBehaviorProfile(value) {
    return normalizeBehaviorProfile(value)
        .map((item, index) => ({ item, index, priority: behaviorProfilePriority(item) }))
        .sort((a, b) => a.priority - b.priority || a.index - b.index)
        .map(entry => entry.item);
}

function behaviorProfileMoralityRelevant(value) {
    return ['disposition', 'cruelty', 'care'].includes(behaviorProfileFamily(value));
}

export function reconcileBehaviorProfileWithPersonality(profile, personality) {
    const markers = identityMoralityMarkers(personality);
    const personalityPolarity = markers.kind && !markers.cruel ? 1 : markers.cruel && !markers.kind ? -1 : 0;
    if (!personalityPolarity) return normalizeBehaviorProfile(profile);
    return normalizeBehaviorProfile(profile).filter(entry => {
        if (!behaviorProfileMoralityRelevant(entry)) return true;
        const polarity = moralityPolarity(entry);
        return !polarity || polarity === personalityPolarity;
    });
}

const BEHAVIOR_DIRECTION_POSITIVE = 1;
const BEHAVIOR_DIRECTION_NEGATIVE = 2;

function moralityDirectionMask(value) {
    const { kind, cruel } = identityMoralityMarkers(behaviorProfileBody(value));
    return (kind ? BEHAVIOR_DIRECTION_POSITIVE : 0) | (cruel ? BEHAVIOR_DIRECTION_NEGATIVE : 0);
}

export function moralityPolarity(value) {
    const mask = moralityDirectionMask(value);
    return mask === BEHAVIOR_DIRECTION_POSITIVE ? 1 : mask === BEHAVIOR_DIRECTION_NEGATIVE ? -1 : 0;
}

function behaviorAgencyDirectionMask(value) {
    const text = normalizeName(`${behaviorProfileKey(value)} ${behaviorProfileBody(value)}`);
    if (!text) return 0;
    // Bounded negation handling for the protected agency axis. "Not independent" is itself
    // negative-agency evidence, while "not obedient" must not be misread as compliance merely
    // because the word obedient is present.
    const negatedIndependence = /\b(?:not|never)\s+(?:fully\s+|truly\s+)?(?:independent|autonomous|self directed)\b/.test(text);
    const positiveText = text.replace(/\b(?:not|never)\s+(?:fully\s+|truly\s+)?(?:independent|autonomous|self directed)\b/g, ' ');
    const complianceText = text.replace(/\b(?:not|never)\s+(?:blindly\s+|fully\s+)?(?:obedient|compliant|submissive)\b/g, ' ');
    const independent = /\b(independence|independent|autonomy|autonomous|self directed|self direction|own judgment|own judgement|own decisions|personal judgment|personal judgement)\b/.test(positiveText);
    const compliant = negatedIndependence
        || /\b(obedience|obedient|compliance|compliant|submission|submissive)\b/.test(complianceText)
        || /\bdefer(?:s|red|ring)?\b.{0,24}\b(?:authority|orders?|instructions?|others?)\b/.test(complianceText)
        || /\bfollows?\b.{0,16}\b(?:orders?|instructions?)\b/.test(complianceText);
    return (independent ? BEHAVIOR_DIRECTION_POSITIVE : 0) | (compliant ? BEHAVIOR_DIRECTION_NEGATIVE : 0);
}

function aggregateBehaviorDirections(entries, classifier) {
    return (Array.isArray(entries) ? entries : []).reduce((mask, entry) => mask | classifier(entry), 0);
}

function behaviorDirectionConflict(existingMask, incomingMask) {
    const establishedPositive = Boolean(existingMask & BEHAVIOR_DIRECTION_POSITIVE);
    const establishedNegative = Boolean(existingMask & BEHAVIOR_DIRECTION_NEGATIVE);
    // Protect an established one-way direction from a proposal that introduces its opposite.
    // If the accepted profile is already contextually mixed, do not freeze it merely because
    // both old and new summaries retain mixed evidence; matching-category safety still applies.
    if (establishedPositive && !establishedNegative) return Boolean(incomingMask & BEHAVIOR_DIRECTION_NEGATIVE);
    if (establishedNegative && !establishedPositive) return Boolean(incomingMask & BEHAVIOR_DIRECTION_POSITIVE);
    return false;
}

function behaviorProfileRefinementConflict(current, updates) {
    if ((updates || []).some(entry => containsBehaviorEvolutionLanguage(behaviorProfileBody(entry)))) return true;
    const oldMorality = aggregateBehaviorDirections(current, moralityDirectionMask);
    const newMorality = aggregateBehaviorDirections(updates, moralityDirectionMask);
    if (behaviorDirectionConflict(oldMorality, newMorality)) return true;
    const oldAgency = aggregateBehaviorDirections(current, behaviorAgencyDirectionMask);
    const newAgency = aggregateBehaviorDirections(updates, behaviorAgencyDirectionMask);
    return behaviorDirectionConflict(oldAgency, newAgency);
}

function isSafeBehaviorProfileRefinement(existing, incoming) {
    const oldText = cleanText(existing, DURABLE_PROFILE_LIMITS.behaviorProfile);
    const newText = cleanText(incoming, DURABLE_PROFILE_LIMITS.behaviorProfile);
    if (!oldText || !newText || behaviorProfileTargetSpecific(newText)) return false;
    const sameKey = behaviorProfileKey(oldText) === behaviorProfileKey(newText);
    const sameFamily = behaviorProfileFamily(oldText) && behaviorProfileFamily(oldText) === behaviorProfileFamily(newText);
    if (!sameKey && !sameFamily) return false;
    if (containsBehaviorEvolutionLanguage(behaviorProfileBody(newText))) return false;
    if (behaviorProfileMoralityRelevant(oldText)) {
        const oldPolarity = moralityPolarity(oldText);
        const newPolarity = moralityPolarity(newText);
        if (oldPolarity && newPolarity && oldPolarity !== newPolarity) return false;
    }
    if (normalizeName(oldText) === normalizeName(newText)) return true;
    return isSafeUnmarkedDurableRefinement(oldText, newText)
        || durableSemanticSimilarity(behaviorProfileBody(oldText), behaviorProfileBody(newText)) >= 0.55;
}

export function mergeBehaviorProfileRefinements(existing, incoming, { context = '', evidenceItems = [], binding = null, personality = '', rejected = [] } = {}) {
    const current = normalizeBehaviorProfile(existing);
    const updates = normalizeBehaviorProfile(incoming);
    if (!updates.length) return current;
    // Refine is a full current summary, but it is not an evolution channel. Evaluate
    // protected identity/morality direction across the whole proposal before category-by-
    // category replacement so relabeling cannot bypass the existing atomic safety gate.
    // Entries dropped at intake for not being levers still count here, so an unrecognised
    // label cannot hide a reversal from the gate.
    const rejectedEntries = cleanList(rejected, BEHAVIOR_PROFILE_LIMIT * 3, DURABLE_PROFILE_LIMITS.behaviorProfile);
    if (behaviorProfileRefinementConflict(current, [...updates, ...rejectedEntries])) return current;
    // A lever that restates a stored non-lever entry adds no new meaning: that accepted entry
    // grounds it, even when the scene that established it is outside the current window.
    evidenceItems = [...(Array.isArray(evidenceItems) ? evidenceItems : []), ...current.filter(entry => !isBehaviorLever(entry))];
    const identity = cleanText(personality, DURABLE_PROFILE_LIMITS.personality);
    const scopedSupport = String(context || '').trim() ? durableRefinementSupportText(context, [], binding) : '';
    const next = [];
    let droppedNew = rejectedEntries.length > 0;
    for (const entry of updates) {
        const key = behaviorProfileKey(entry);
        const family = behaviorProfileFamily(entry);
        let index = current.findIndex(item => behaviorProfileKey(item) === key);
        if (index < 0 && family) index = current.findIndex(item => behaviorProfileFamily(item) === family);
        if (index >= 0) {
            // A full-summary refine is atomic for safety. If any replacement fails its existing
            // identity/morality gate, reject the proposed summary rather than partially clearing it.
            if (!isSafeBehaviorProfileRefinement(current[index], entry)) return current;
            // Ground the claim, not the lever label: labels are schema vocabulary that story text
            // does not contain. First-seed grounding (groundedBehaviorProfile) uses the body too.
            if (!durableRefinementCandidateGrounded('behaviorProfile', behaviorProfileBody(current[index]), behaviorProfileBody(entry), context, evidenceItems, binding)) return current;
            next.push(entry);
            continue;
        }
        const incomingPolarity = behaviorProfileMoralityRelevant(entry) ? moralityPolarity(entry) : 0;
        const conflicts = incomingPolarity && current.some(item => {
            if (!behaviorProfileMoralityRelevant(item)) return false;
            const existingPolarity = moralityPolarity(item);
            return existingPolarity && existingPolarity !== incomingPolarity;
        });
        if (conflicts) return current;
        // A new lever category uses first-profile grounding (story, evidence or accepted
        // Personality) and is judged on its own: one unsupported addition is dropped instead of
        // discarding every grounded lever in the proposal.
        const body = behaviorProfileBody(entry);
        const grounded = durableRefinementCandidateGrounded('behaviorProfile', '', body, context, evidenceItems, binding)
            || (!behaviorProfileTargetSpecific(entry) && (
                Boolean(identity && (durableSemanticSimilarity(body, identity) >= 0.34 || durableSemanticSimilarity(entry, identity) >= 0.34))
                || Boolean(scopedSupport && durableSeedGrounded(body, scopedSupport))
                || durableEvidenceGroundsValue(body, evidenceItems)));
        if (!grounded) {
            droppedNew = true;
            continue;
        }
        next.push(entry);
    }
    // Omitted old rules are retired because the scanner contract says refine is a FULL field.
    // Longitudinal support remains in profileEvidence rather than being copied back into the list.
    // When an unsupported addition (or an intake-rejected entry) was dropped the proposal is
    // partial, so established levers it omitted stay; stored non-lever entries still retire.
    if (droppedNew) {
        if (!next.length) return current;
        // A stored entry the provider copied back is kept even when intake rejected the copy
        // (for example a pre-category label); only deliberate omission retires it.
        const copiedBack = new Set(rejectedEntries.map(normalizeName));
        for (const old of current) {
            if ((!isBehaviorLever(old) && !copiedBack.has(normalizeName(old))) || next.length >= BEHAVIOR_PROFILE_LIMIT) continue;
            const oldKey = behaviorProfileKey(old);
            const oldFamily = behaviorProfileFamily(old);
            if (next.some(entry => behaviorProfileKey(entry) === oldKey || (oldFamily && behaviorProfileFamily(entry) === oldFamily))) continue;
            next.push(old);
        }
    }
    return normalizeBehaviorProfile(next);
}

export function recoverBehaviorProfileKeepAdditions(existing, incoming, { evidenceItems = [], rejected = [] } = {}) {
    const current = normalizeBehaviorProfile(existing);
    const updates = normalizeBehaviorProfile(incoming);
    if (!current.length || updates.length <= current.length) return current;
    const rejectedEntries = cleanList(rejected, BEHAVIOR_PROFILE_LIMIT * 3, DURABLE_PROFILE_LIMITS.behaviorProfile);
    if (behaviorProfileRefinementConflict(current, [...updates, ...rejectedEntries])) return current;
    if (!durableProfileCollectionCandidateGrounded('behaviorProfile', current, updates, evidenceItems)) return current;

    // A missing/keep lifecycle marker may recover only an additive refinement. The provider must
    // still carry every established rule forward; keep never gains authority to retire or rewrite it.
    const represented = new Set();
    for (let i = 0; i < current.length; i += 1) {
        const old = current[i];
        const match = updates.findIndex((entry, index) => !represented.has(index)
            && normalizeName(entry) === normalizeName(old));
        if (match < 0) return current;
        represented.add(match);
    }

    const additions = updates.filter((_, index) => !represented.has(index));
    if (!additions.length) return current;
    const next = [...current];
    for (const entry of additions) {
        const key = behaviorProfileKey(entry);
        const family = behaviorProfileFamily(entry);
        const overlapsEstablished = current.some(item => behaviorProfileKey(item) === key
            || (family && behaviorProfileFamily(item) === family));
        if (overlapsEstablished) return current;
        if (next.length < BEHAVIOR_PROFILE_LIMIT) next.push(entry);
    }
    return normalizeBehaviorProfile(next);
}

export function strippedDevelopmentEvidence(value) {
    const text = String(value || '').replace(/^\[m\d+\]\s*/i, '');
    const labeled = text.match(/^([^:"“(]{1,52}):\s*(.*)$/s);
    // A label followed only by a quoted line is the claim itself (a Speech style); keep it.
    if (labeled && /^["“‘'].*["”’']\W*$/su.test(labeled[2].trim())) return cleanText(`${labeled[1].trim()} (${labeled[2].trim()})`, DURABLE_PROFILE_LIMITS.evidence);
    return cleanText(labeled ? labeled[2] : text, DURABLE_PROFILE_LIMITS.evidence);
}

export function durableProfileCollectionEquivalent(field, left, right) {
    const normalize = field === 'mannerisms' ? normalizeMannerisms
        : (field === 'behaviorProfile' ? normalizeBehaviorProfile : null);
    if (!normalize) return normalizeName(left) === normalizeName(right);
    const canonical = value => normalize(value).map(item => normalizeName(item)).filter(Boolean).sort();
    const a = canonical(left);
    const b = canonical(right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function durableProfileCollectionCandidateGrounded(field, existing, incoming, evidenceItems = []) {
    const isMannerisms = field === 'mannerisms';
    const isBehavior = field === 'behaviorProfile';
    if (!isMannerisms && !isBehavior) return false;
    const current = isMannerisms ? normalizeMannerisms(existing) : normalizeBehaviorProfile(existing);
    const proposed = isMannerisms ? normalizeMannerisms(incoming) : normalizeBehaviorProfile(incoming);
    if (!proposed.length || durableProfileCollectionEquivalent(field, current, proposed)) return false;
    const changed = proposed.filter(entry => {
        if (isMannerisms) return !current.some(old => mannerismSimilarity(old, entry) >= 0.55);
        const key = behaviorProfileKey(entry);
        const family = behaviorProfileFamily(entry);
        const matched = current.find(old => behaviorProfileKey(old) === key
            || (family && behaviorProfileFamily(old) === family));
        return !matched || normalizeName(matched) !== normalizeName(entry);
    });
    if (!changed.length) return false;
    const evidence = (Array.isArray(evidenceItems) ? evidenceItems : [])
        .map(strippedDevelopmentEvidence).filter(Boolean);
    if (!evidence.length) return false;
    return changed.every(entry => evidence.some(sample =>
        durableSeedGrounded(entry, sample)
        || durableSemanticSimilarity(entry, sample) >= 0.34
        || (isBehavior && durableSemanticSimilarity(behaviorProfileBody(entry), sample) >= 0.34)));
}
