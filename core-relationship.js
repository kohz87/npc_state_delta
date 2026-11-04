/* NPC State Delta relationship mechanics: the relationship defaults, milestone thresholds, delta/baseline/progress/milestone
   normalizers, applyRelationshipDelta, relationship evidence and event history, and summary calibration. It also holds the
   durable text-similarity helpers and DURABLE_PROFILE_LIMITS that these read (moved with it so that this file imports no
   other core file but core-text, core-identity and social.js). A pure part of core-mechanics.js (same owner, moved without
   change); core-mechanics.js re-exports every name it exported before. Never imports core-mechanics.js or core.js. */
import { SOCIAL_KEY_RELATIONSHIP_MAX_CHARS } from './social.js';
import { clamp } from './core-identity.js';
import { cleanText, normalizeName } from './core-text.js';

export const DURABLE_PROFILE_LIMITS = Object.freeze({
    personality: 320,
    speech: 280,
    appearance: 800,
    background: 420,
    relationshipSummary: 320,
    mannerism: 160,
    behaviorProfile: 180,
    keyRelationship: SOCIAL_KEY_RELATIONSHIP_MAX_CHARS,
    memory: 220,
    evidence: 160,
});

export const DEFAULT_RELATIONSHIP = Object.freeze({
    trust: 0,
    affection: 0,
    desire: 0,
    tension: 0,
});

export const RELATIONSHIP_KEYS = Object.freeze(['trust', 'affection', 'desire', 'tension']);
export const RELATIONSHIP_IMPACT_LEVELS = Object.freeze(['none', 'ordinary', 'meaningful', 'major', 'extreme']);
export const DEFAULT_RELATIONSHIP_CAPS = Object.freeze({
    ordinary: 1,
    meaningful: 2,
    major: 5,
    extreme: 10,
});
export const RELATIONSHIP_EVENT_HISTORY_LIMIT = 6;
export const DEFAULT_RELATIONSHIP_PROGRESS = Object.freeze({
    trust: 0,
    affection: 0,
    desire: 0,
    tension: 0,
});
export const RELATIONSHIP_MILESTONE_THRESHOLDS = Object.freeze([25, 50, 75, 90]);
export const RELATIONSHIP_MILESTONE_REQUIREMENTS = Object.freeze({
    25: 'meaningful',
    50: 'major',
    75: 'extreme',
    90: 'extreme',
});
export const RELATIONSHIP_MILESTONE_MIN_RAW = Object.freeze({
    25: 1,
    50: 3,
    75: 5,
    90: 8,
});
export const RELATIONSHIP_MILESTONE_LIMIT = RELATIONSHIP_KEYS.length * 2 * RELATIONSHIP_MILESTONE_THRESHOLDS.length;

export function normalizeRelationshipBaseline(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => {
        const number = Number(source[key]);
        const safe = Number.isFinite(number) ? number : DEFAULT_RELATIONSHIP[key];
        return [key, Math.round(clamp(safe, -100, 100))];
    }));
}

export function normalizeRelationshipCaps(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const finiteOr = (raw, fallback) => {
        if (raw === undefined || raw === null || raw === '') return fallback;
        const number = Number(raw);
        return Number.isFinite(number) ? number : fallback;
    };
    const ordinary = Math.round(clamp(finiteOr(source.ordinary, DEFAULT_RELATIONSHIP_CAPS.ordinary), 0, 25));
    const meaningful = Math.max(ordinary, Math.round(clamp(finiteOr(source.meaningful, DEFAULT_RELATIONSHIP_CAPS.meaningful), 0, 35)));
    const major = Math.max(meaningful, Math.round(clamp(finiteOr(source.major, DEFAULT_RELATIONSHIP_CAPS.major), 0, 50)));
    const extreme = Math.max(major, Math.round(clamp(finiteOr(source.extreme, DEFAULT_RELATIONSHIP_CAPS.extreme), 0, 100)));
    return { ordinary, meaningful, major, extreme };
}

export function normalizeRelationshipImpact(value, hasDelta = false) {
    const impact = String(value ?? '').trim().toLowerCase();
    if (RELATIONSHIP_IMPACT_LEVELS.includes(impact)) return impact;
    return hasDelta ? 'ordinary' : 'none';
}

export function normalizeScannerRelationshipImpact(value, hasDelta = false) {
    const impact = normalizeRelationshipImpact(value, hasDelta);
    // Scanner payloads that pair a concrete non-zero delta with `none` are contradictory.
    // Keep the low-level engine's `none` semantics intact, but recover scanner mistakes
    // to the smallest non-zero tier instead of silently swallowing the delta.
    return hasDelta && impact === 'none' ? 'ordinary' : impact;
}

export function normalizeRelationshipDelta(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => {
        const raw = Number(source[key]);
        return [key, Number.isFinite(raw) ? Math.round(clamp(raw, -100, 100)) : 0];
    }));
}

export function normalizeRelationshipAbsolutePatch(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const patch = {};
    for (const key of RELATIONSHIP_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const raw = Number(source[key]);
        if (!Number.isFinite(raw)) continue;
        patch[key] = Math.round(clamp(raw, -100, 100));
    }
    return patch;
}

export function normalizeRelationshipAuditDelta(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => {
        const raw = Number(source[key]);
        return [key, Number.isFinite(raw) ? Math.round(clamp(raw, -200, 200)) : 0];
    }));
}

export function normalizeRelationshipProgress(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => {
        const raw = Number(source[key]);
        if (!Number.isFinite(raw)) return [key, 0];
        const bounded = Math.max(-0.999999, Math.min(0.999999, raw));
        return [key, Math.abs(bounded) < 0.000001 ? 0 : Number(bounded.toFixed(6))];
    }));
}

function normalizeMilestonePolarity(value) {
    const number = Number(value);
    if (number > 0) return 1;
    if (number < 0) return -1;
    const text = String(value ?? '').trim().toLowerCase();
    if (['positive', 'pos', '+', 'plus'].includes(text)) return 1;
    if (['negative', 'neg', '-', 'minus'].includes(text)) return -1;
    return 0;
}

function relationshipImpactRank(value) {
    return { none: 0, ordinary: 1, meaningful: 2, major: 3, extreme: 4 }[normalizeRelationshipImpact(value, false)] || 0;
}

function relationshipMilestoneRequirement(threshold) {
    return RELATIONSHIP_MILESTONE_REQUIREMENTS[Number(threshold)] || 'extreme';
}

function relationshipMilestoneImpactQualifies(impact, threshold) {
    return relationshipImpactRank(impact) >= relationshipImpactRank(relationshipMilestoneRequirement(threshold));
}

function relationshipMilestoneRawRequirement(threshold, tierCap) {
    const configuredCap = Math.max(0, Number(tierCap) || 0);
    const stockMinimum = Math.max(1, Number(RELATIONSHIP_MILESTONE_MIN_RAW[Number(threshold)]) || 1);
    return configuredCap > 0 ? Math.min(configuredCap, stockMinimum) : stockMinimum;
}

function relationshipMilestoneEventQualifies(impact, threshold, rawWeight, tierCap) {
    return relationshipMilestoneImpactQualifies(impact, threshold)
        && Math.abs(Number(rawWeight) || 0) >= relationshipMilestoneRawRequirement(threshold, tierCap);
}

function milestoneIdentity(entry) {
    return `${entry.axis}:${entry.polarity}:${entry.threshold}`;
}

function inferredMilestoneEntries(relationship = DEFAULT_RELATIONSHIP, { includeBoundary = false, reason = 'Existing relationship depth predates milestone tracking.' } = {}) {
    const rel = normalizeRelationshipBaseline(relationship || DEFAULT_RELATIONSHIP);
    const out = [];
    for (const axis of RELATIONSHIP_KEYS) {
        const score = rel[axis];
        const polarity = Math.sign(score);
        if (!polarity) continue;
        const magnitude = Math.abs(score);
        for (const threshold of RELATIONSHIP_MILESTONE_THRESHOLDS) {
            const established = includeBoundary ? magnitude >= threshold : magnitude > threshold;
            if (!established) continue;
            out.push({
                axis,
                polarity,
                threshold,
                reason,
                sourceMessageId: null,
                turn: null,
                inferred: true,
            });
        }
    }
    return out;
}

export function normalizeRelationshipMilestones(value, relationship = DEFAULT_RELATIONSHIP, { inferFromRelationship = true } = {}) {
    const source = Array.isArray(value) ? value : [];
    const map = new Map();
    for (const raw of source) {
        if (!raw || typeof raw !== 'object') continue;
        const axis = RELATIONSHIP_KEYS.includes(String(raw.axis || '').trim().toLowerCase()) ? String(raw.axis).trim().toLowerCase() : '';
        const polarity = normalizeMilestonePolarity(raw.polarity);
        const threshold = Number(raw.threshold);
        if (!axis || !polarity || !RELATIONSHIP_MILESTONE_THRESHOLDS.includes(threshold)) continue;
        const entry = {
            axis,
            polarity,
            threshold,
            reason: cleanText(raw.reason, 300) || 'Relationship depth established.',
            sourceMessageId: Number.isInteger(raw.sourceMessageId) ? raw.sourceMessageId : null,
            turn: Number.isFinite(Number(raw.turn)) ? Number(raw.turn) : null,
            inferred: Boolean(raw.inferred),
        };
        map.set(milestoneIdentity(entry), entry);
    }
    if (inferFromRelationship) {
        for (const entry of inferredMilestoneEntries(relationship)) {
            const key = milestoneIdentity(entry);
            if (!map.has(key)) map.set(key, entry);
        }
    }
    return [...map.values()]
        .sort((a, b) => RELATIONSHIP_KEYS.indexOf(a.axis) - RELATIONSHIP_KEYS.indexOf(b.axis)
            || a.polarity - b.polarity
            || a.threshold - b.threshold)
        .slice(0, RELATIONSHIP_MILESTONE_LIMIT);
}

export function relationshipMilestoneUnlocked(milestones, axis, polarity, threshold) {
    const normalized = normalizeRelationshipMilestones(milestones, DEFAULT_RELATIONSHIP, { inferFromRelationship: false });
    const key = String(axis || '').trim().toLowerCase();
    const sign = normalizeMilestonePolarity(polarity);
    const point = Number(threshold);
    return normalized.some(entry => entry.axis === key && entry.polarity === sign && entry.threshold === point);
}

export function inferManualRelationshipMilestones(milestones, relationship, reason = 'Manual dossier adjustment established this relationship depth.', sourceMessageId = null, turn = null) {
    const map = new Map(normalizeRelationshipMilestones(milestones, relationship).map(entry => [milestoneIdentity(entry), entry]));
    for (const entry of inferredMilestoneEntries(relationship, { includeBoundary: true, reason })) {
        entry.inferred = false;
        entry.sourceMessageId = Number.isInteger(sourceMessageId) ? sourceMessageId : null;
        entry.turn = Number.isFinite(Number(turn)) ? Number(turn) : null;
        map.set(milestoneIdentity(entry), entry);
    }
    return normalizeRelationshipMilestones([...map.values()], relationship, { inferFromRelationship: false });
}

export function applyRelationshipMilestoneCrossings(milestones, crossings = [], { reason = '', sourceMessageId = null, turn = null } = {}) {
    const map = new Map(normalizeRelationshipMilestones(milestones, DEFAULT_RELATIONSHIP, { inferFromRelationship: false }).map(entry => [milestoneIdentity(entry), entry]));
    for (const raw of Array.isArray(crossings) ? crossings : []) {
        const axis = RELATIONSHIP_KEYS.includes(String(raw?.axis || '').trim().toLowerCase()) ? String(raw.axis).trim().toLowerCase() : '';
        const polarity = normalizeMilestonePolarity(raw?.polarity);
        const threshold = Number(raw?.threshold);
        if (!axis || !polarity || !RELATIONSHIP_MILESTONE_THRESHOLDS.includes(threshold)) continue;
        const entry = {
            axis,
            polarity,
            threshold,
            reason: cleanText(reason || raw.reason, 300) || `Relationship crossed the ${polarity > 0 ? '+' : '-'}${threshold} ${axis} milestone.`,
            sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
            turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
            inferred: false,
        };
        map.set(milestoneIdentity(entry), entry);
    }
    return normalizeRelationshipMilestones([...map.values()], DEFAULT_RELATIONSHIP, { inferFromRelationship: false });
}

function relationshipInertiaFactor(currentValue, proposedDelta, impact = 'ordinary') {
    const current = Number(currentValue) || 0;
    const delta = Number(proposedDelta) || 0;
    if (!delta) return 0;
    const magnitude = Math.abs(current);
    const deepening = current === 0 || Math.sign(current) === Math.sign(delta);
    if (deepening) {
        if (magnitude < 30) return 1;
        if (magnitude < 50) return 0.75;
        if (magnitude < 70) return 0.5;
        if (magnitude < 85) return 0.35;
        if (magnitude < 95) return 0.2;
        return 0.1;
    }
    // Established relationships have some resilience to small contrary beats. The more
    // decisive the event, the more of that resistance it can overcome. Extreme evidence
    // is allowed to hit at full raw tier strength, but never exceeds the tier cap.
    if (impact === 'extreme') return 1;
    if (impact === 'major') {
        if (magnitude < 30) return 1;
        if (magnitude < 50) return 1;
        if (magnitude < 70) return 0.9;
        if (magnitude < 85) return 0.8;
        if (magnitude < 95) return 0.7;
        return 0.6;
    }
    if (impact === 'meaningful') {
        if (magnitude < 30) return 1;
        if (magnitude < 50) return 0.9;
        if (magnitude < 70) return 0.8;
        if (magnitude < 85) return 0.65;
        if (magnitude < 95) return 0.5;
        return 0.4;
    }
    if (magnitude < 30) return 1;
    if (magnitude < 50) return 0.85;
    if (magnitude < 70) return 0.7;
    if (magnitude < 85) return 0.55;
    if (magnitude < 95) return 0.4;
    return 0.3;
}

function relationshipAxisLimit(impact) {
    if (impact === 'ordinary') return 1;
    if (impact === 'meaningful') return 2;
    if (impact === 'major') return 3;
    if (impact === 'extreme') return 4;
    return 0;
}

function selectRelationshipAxes(delta, axisLimit) {
    const ranked = RELATIONSHIP_KEYS
        .filter(key => delta[key] !== 0)
        .map(key => ({ key, magnitude: Math.abs(delta[key]) }))
        .sort((a, b) => b.magnitude - a.magnitude || RELATIONSHIP_KEYS.indexOf(a.key) - RELATIONSHIP_KEYS.indexOf(b.key));
    if (!axisLimit || !ranked.length) return new Set();
    if (ranked.length <= axisLimit) return new Set(ranked.map(item => item.key));
    const cutoff = ranked[axisLimit - 1]?.magnitude ?? Infinity;
    const above = ranked.filter(item => item.magnitude > cutoff);
    const tied = ranked.filter(item => item.magnitude === cutoff);
    const slots = Math.max(0, axisLimit - above.length);
    // If more axes tie for the remaining slots than can legally move, selecting by fixed key
    // order would bias Trust/Affection. Reject the ambiguous tied group instead.
    const acceptedTied = tied.length <= slots ? tied : [];
    return new Set([...above, ...acceptedTied].map(item => item.key));
}

export function applyRelationshipDelta(current, proposedDelta, impact, caps = DEFAULT_RELATIONSHIP_CAPS, progress = DEFAULT_RELATIONSHIP_PROGRESS, milestones = []) {
    const baseline = normalizeRelationshipBaseline(current || DEFAULT_RELATIONSHIP);
    const priorProgress = normalizeRelationshipProgress(progress);
    const establishedMilestones = normalizeRelationshipMilestones(milestones, baseline);
    const delta = normalizeRelationshipDelta(proposedDelta);
    const hasDelta = RELATIONSHIP_KEYS.some(key => delta[key] !== 0);
    const level = normalizeRelationshipImpact(impact, hasDelta);
    const limits = normalizeRelationshipCaps(caps);
    const cap = level === 'none' ? 0 : Number(limits[level] || 0);
    const axisLimit = relationshipAxisLimit(level);
    const allowedAxes = selectRelationshipAxes(delta, axisLimit);
    const appliedDelta = {};
    const evidenceDelta = {};
    const relationship = {};
    const relationshipProgress = {};
    const milestoneCrossings = [];
    const milestoneBlocks = [];

    for (const key of RELATIONSHIP_KEYS) {
        const capped = allowedAxes.has(key) ? Math.max(-cap, Math.min(cap, delta[key])) : 0;
        const factor = relationshipInertiaFactor(baseline[key], capped, level);
        const weighted = capped * factor;
        let accumulated = priorProgress[key] + weighted;
        const baselineValue = baseline[key];
        const proposedPolarity = Math.sign(capped);
        const baselinePolarity = Math.sign(baselineValue);
        const deepeningSamePolarity = Boolean(capped)
            && (baselinePolarity === 0 || baselinePolarity === proposedPolarity)
            && Math.abs(baselineValue + accumulated) >= Math.abs(baselineValue);

        // Sitting exactly on a locked checkpoint never banks outward fractional evidence.
        // A qualifying event may cross it immediately; otherwise the attempted outward
        // evidence is acknowledged but cannot accumulate behind the gate.
        if (deepeningSamePolarity && baselinePolarity === proposedPolarity) {
            const lockedBoundary = RELATIONSHIP_MILESTONE_THRESHOLDS.find(threshold =>
                Math.abs(baselineValue) === threshold
                && !relationshipMilestoneUnlocked(establishedMilestones, key, proposedPolarity, threshold));
            if (lockedBoundary) {
                if (!relationshipMilestoneEventQualifies(level, lockedBoundary, capped, cap)) {
                    accumulated = 0;
                    milestoneBlocks.push({
                        axis: key,
                        polarity: proposedPolarity,
                        threshold: lockedBoundary,
                        requiredImpact: relationshipMilestoneRequirement(lockedBoundary),
                        requiredRaw: relationshipMilestoneRawRequirement(lockedBoundary, cap),
                    });
                } else if (!milestoneCrossings.some(entry => entry.axis === key && entry.polarity === proposedPolarity && entry.threshold === lockedBoundary)) {
                    // The qualifying event itself opens a checkpoint even when inertia leaves
                    // less than one whole visible point on this turn.
                    milestoneCrossings.push({ axis: key, polarity: proposedPolarity, threshold: lockedBoundary, requiredImpact: relationshipMilestoneRequirement(lockedBoundary) });
                }
            }
        }

        let whole = Math.trunc(accumulated);
        let nextValue = Math.round(clamp(baselineValue + whole, -100, 100));
        let blockedAt = null;

        if (capped && Math.abs(nextValue) >= Math.abs(baselineValue)) {
            const movementPolarity = Math.sign(nextValue) || proposedPolarity;
            const baselineMagnitude = baselinePolarity === movementPolarity ? Math.abs(baselineValue) : 0;
            const reachedMagnitude = Math.abs(nextValue);
            for (const threshold of RELATIONSHIP_MILESTONE_THRESHOLDS) {
                if (!(baselineMagnitude < threshold && reachedMagnitude === threshold)) continue;
                if (relationshipMilestoneUnlocked(establishedMilestones, key, movementPolarity, threshold)) continue;
                if (!relationshipMilestoneEventQualifies(level, threshold, capped, cap)) continue;
                if (!milestoneCrossings.some(entry => entry.axis === key && entry.polarity === movementPolarity && entry.threshold === threshold)) {
                    milestoneCrossings.push({ axis: key, polarity: movementPolarity, threshold, requiredImpact: relationshipMilestoneRequirement(threshold) });
                }
            }
        }

        if (capped && Math.abs(nextValue) > Math.abs(baselineValue)) {
            const movementPolarity = Math.sign(nextValue) || proposedPolarity;
            const lowMagnitude = baselinePolarity === movementPolarity ? Math.abs(baselineValue) : 0;
            const highMagnitude = Math.abs(nextValue);
            for (const threshold of RELATIONSHIP_MILESTONE_THRESHOLDS) {
                if (!(lowMagnitude <= threshold && highMagnitude > threshold)) continue;
                if (relationshipMilestoneUnlocked(establishedMilestones, key, movementPolarity, threshold)) continue;
                if (relationshipMilestoneEventQualifies(level, threshold, capped, cap)) {
                    milestoneCrossings.push({ axis: key, polarity: movementPolarity, threshold, requiredImpact: relationshipMilestoneRequirement(threshold) });
                    continue;
                }
                blockedAt = threshold;
                milestoneBlocks.push({
                    axis: key,
                    polarity: movementPolarity,
                    threshold,
                    requiredImpact: relationshipMilestoneRequirement(threshold),
                    requiredRaw: relationshipMilestoneRawRequirement(threshold, cap),
                });
                nextValue = movementPolarity * threshold;
                break;
            }
        }

        whole = nextValue - baselineValue;
        let remainder = accumulated - whole;
        const finalPolarity = Math.sign(nextValue);
        const finalMagnitude = Math.abs(nextValue);
        const lockedFinalBoundary = finalPolarity && RELATIONSHIP_MILESTONE_THRESHOLDS.find(threshold =>
            finalMagnitude === threshold
            && !relationshipMilestoneUnlocked(establishedMilestones, key, finalPolarity, threshold)
            && !milestoneCrossings.some(entry => entry.axis === key && entry.polarity === finalPolarity && entry.threshold === threshold));
        if (blockedAt || (lockedFinalBoundary && Math.sign(remainder) === finalPolarity)) remainder = 0;
        if ((nextValue >= 100 && remainder > 0) || (nextValue <= -100 && remainder < 0)) remainder = 0;
        if (Math.abs(remainder) < 0.000001) remainder = 0;

        appliedDelta[key] = whole;
        evidenceDelta[key] = Number(weighted.toFixed(6));
        relationship[key] = nextValue;
        relationshipProgress[key] = Number(Math.max(-0.999999, Math.min(0.999999, remainder)).toFixed(6));
    }

    const evidenceAccepted = RELATIONSHIP_KEYS.some(key => evidenceDelta[key] !== 0);
    const progressChanged = RELATIONSHIP_KEYS.some(key => relationshipProgress[key] !== priorProgress[key]);
    return {
        relationship,
        relationshipProgress,
        appliedDelta,
        evidenceDelta,
        evidenceAccepted,
        progressChanged,
        milestoneCrossings,
        milestoneBlocks,
        impact: level,
        cap,
        axisLimit,
    };
}

function relationshipReasonSimilarity(a, b) {
    const left = cleanText(a, 500);
    const right = cleanText(b, 500);
    if (!left || !right) return 0;
    if (normalizeName(left) === normalizeName(right)) return 1;
    return durableSemanticSimilarity(left, right);
}

export function normalizeRelationshipEvidence(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, cleanText(source[key], 300)]));
}

const RELATIONSHIP_AXIS_CUES = Object.freeze({
    trust: /\b(trust(?:s|ed|ing)?|rely|relies|relied|relying|reliance|reliable|dependable|promise(?:s|d)?|confidence|confide(?:s|d)?|vulnerab|safe|safety|protect(?:s|ed|ing)?|rescu|betray|betrayed|deceiv|deception|lied|lying|honest|secret|abandon|unreliable|faith)\b/i,
    affection: /\b(affection|fond|fondness|care(?:s|d|ing)?|warmth|kindness|comfort|bond(?:s|ed|ing)?|companionship|companion|attached|attachment|love(?:s|d)?|like(?:s|d)?|resent|resentment|dislike|hate(?:s|d)?|hurt|reject(?:s|ed|ion)?|humiliat|neglect|cherish)\b/i,
    desire: /\b(desire|desires|desired|desiring|attract|attracts|attracted|attracting|attraction|attractive|romantic|romance|intimacy|intimate|kiss|kisses|kissed|kissing|sexual|sexually|lust|longing|yearn|yearns|yearned|yearning|flirt|flirts|flirted|flirting|date|dating|lover|physical closeness|physical contact|(?:want|wants|wanted|wanting) (?:him|her|them|the player)|drawn to)\b/i,
    tension: /\b(tension|tense|awkward|fear|afraid|suspicion|suspicious|argument|argued|threat|threaten|pressure|rival|rivalry|resent|conflict|hostil|unease|uneasy|reconcil|relief|relaxed|ease|eased|reassur|strain|friction)\b/i,
});

export function relationshipAxisEvidenceGrounded(key, evidence, context = '') {
    if (!RELATIONSHIP_KEYS.includes(key)) return false;
    const explanation = cleanText(evidence, 300);
    if (!explanation) return false;
    const source = String(context || '').trim();
    if (key === 'desire') {
        if (!RELATIONSHIP_AXIS_CUES.desire.test(explanation)) return false;
        if (!source) return true;
        return RELATIONSHIP_AXIS_CUES.desire.test(source) && relationshipChangeReasonGrounded(explanation, source);
    }
    if (!source) return true;
    return relationshipChangeReasonGrounded(explanation, source);
}

export function filterRelationshipDeltaByEvidence(delta, evidence, context = '') {
    const normalized = normalizeRelationshipDelta(delta);
    const proof = normalizeRelationshipEvidence(evidence);
    return Object.fromEntries(RELATIONSHIP_KEYS.map(key => [
        key,
        normalized[key] !== 0 && relationshipAxisEvidenceGrounded(key, proof[key], context) ? normalized[key] : 0,
    ]));
}

// Display-only (1.2.3): the chat message index of the reply a relationship change was recorded
// at, shown as "reply #N". `turn` stays Delta's own counter for duplicate/recency checks; events
// recorded before 1.2.3 have no `message`.
export function relationshipEventMessage(raw = {}) {
    const message = Number(raw?.message);
    return Number.isInteger(message) && message >= 0 ? { message } : {};
}

export function normalizeRelationshipEventHistory(value = []) {
    const source = Array.isArray(value) ? value : [];
    const out = [];
    for (const raw of source.slice(-RELATIONSHIP_EVENT_HISTORY_LIMIT * 2)) {
        if (!raw || typeof raw !== 'object') continue;
        const reason = cleanText(raw.reason, 500);
        const evidence = normalizeRelationshipEvidence(raw.evidence);
        if (!reason && !RELATIONSHIP_KEYS.some(key => evidence[key])) continue;
        out.push({
            impact: normalizeRelationshipImpact(raw.impact, true),
            reason,
            evidence,
            sourceMessageId: Number.isInteger(raw.sourceMessageId) ? raw.sourceMessageId : null,
            ...(Number.isFinite(Number(raw.turn)) ? { turn: Number(raw.turn) } : {}),
            ...relationshipEventMessage(raw),
        });
    }
    return out.slice(-RELATIONSHIP_EVENT_HISTORY_LIMIT);
}

function relationshipEventText(event) {
    const evidence = normalizeRelationshipEvidence(event?.evidence);
    return [cleanText(event?.reason, 500), ...RELATIONSHIP_KEYS.map(key => evidence[key])].filter(Boolean).join(' ');
}

export function relationshipChangeLooksDuplicate(previousChange, reason, { sourceMessageId = null, turn = null, evidence = null } = {}) {
    const previous = previousChange && typeof previousChange === 'object' ? previousChange : {};
    if (String(previous.impact || '').toLowerCase() === 'manual') return false;
    const currentText = [cleanText(reason, 500), ...RELATIONSHIP_KEYS.map(key => cleanText(evidence?.[key], 300))].filter(Boolean).join(' ');
    const priorText = relationshipEventText(previous) || cleanText(previous.reason, 500);
    if (!currentText || !priorText) return false;
    const priorTurn = Number(previous.turn);
    const currentTurn = Number(turn);
    const recentByTurn = Number.isFinite(priorTurn) && Number.isFinite(currentTurn) && Math.abs(currentTurn - priorTurn) <= 8;
    const recentByMessage = Number.isInteger(sourceMessageId) && Number.isInteger(previous.sourceMessageId)
        && Math.abs(sourceMessageId - previous.sourceMessageId) <= 10;
    if (!recentByTurn && !recentByMessage) return false;
    return relationshipReasonSimilarity(priorText, currentText) >= 0.68;
}

export function relationshipHistoryLooksDuplicate(history, reason, options = {}) {
    return normalizeRelationshipEventHistory(history).some(event => relationshipChangeLooksDuplicate(event, reason, options));
}

export function appendRelationshipEvent(history, event) {
    const normalized = normalizeRelationshipEventHistory([...(Array.isArray(history) ? history : []), event]);
    return normalized.slice(-RELATIONSHIP_EVENT_HISTORY_LIMIT);
}


export function relationshipChangeReasonGrounded(reason, context = '') {
    const explanation = cleanText(reason, 500);
    if (!explanation) return false;
    const source = String(context || '').trim();
    if (!source) return true;
    return durableSeedGrounded(explanation, source);
}

function relationshipSummaryHasUnsupportedClaims(value, relationship = DEFAULT_RELATIONSHIP, milestones = null) {
    const text = String(value || '').trim();
    if (!text) return false;
    const rel = normalizeRelationshipBaseline(relationship || DEFAULT_RELATIONSHIP);
    const positiveStrength = Math.max(0, rel.trust, rel.affection, rel.desire);
    const milestoneState = normalizeRelationshipMilestones(
        milestones,
        rel,
        { inferFromRelationship: milestones == null },
    );
    const unlocked = (axis, polarity, threshold) => relationshipMilestoneUnlocked(milestoneState, axis, polarity, threshold);
    const desireClaims = /\b(madly in love|in love|romantic|romance|sexually|sexual attraction|lust|desire[sd]?|intimate attraction|physically attracted|yearns? for|wants? (?:him|her|them|the player) physically)\b/i;
    const tropeClaims = /\b(possessive|jealous|obsessive|obsessed|would kill|kill anyone|belongs to (?:him|her|them|the player)|cannot bear (?:him|her|them|the player) with|unconditionally devoted|utterly devoted)\b/i;
    const absoluteClaims = /\b(indispensable|everything to (?:her|him|them)|cannot live without|can't live without|completely dependent|utterly dependent)\b/i;
    const deepTrustClaims = /\b(deep(?:est)? trust|deeply trusts?|profound trust|unwavering trust|unquestion(?:ing|ed) trust|complete trust|implicit trust|central to (?:her|his|their) (?:deepest )?trust)\b/i;
    const exceptionalTrustClaims = /\b(absolute trust|unbreakable trust|trusts? (?:him|her|them|the player) with (?:her|his|their) life|trusts? (?:him|her|them|the player) without reservation)\b/i;
    const deepAffectionClaims = /\b(deep affection|deeply attached|profound attachment|central to (?:her|his|their) life|one of (?:her|his|their) most important people)\b/i;
    const exceptionalAffectionClaims = /\b(inseparable|irreplaceable|life-defining bond|devoted to (?:him|her|them|the player))\b/i;
    const deepDistrustClaims = /\b(deep distrust|profound distrust|deeply distrusts?|cannot trust (?:him|her|them|the player) at all)\b/i;
    const deepDislikeClaims = /\b(deep hatred|profound hatred|deep resentment|utterly hates?)\b/i;
    // Obligation, fixation and role claims make the player uniquely important ("her chosen partner,
    // protector and provider", "must repay him", "only he can") and need established depth too.
    const obligationClaims = /\b(chosen (?:partner|one|mate|companion)|(?:her|his|their) (?:protector|provider|savio(?:u)?r|master|purpose|reason to live)|must (?:serve|obey|please|repay|stay with|follow|do (?:whatever|anything|everything))|only (?:he|she|they) can|owes? (?:him|her|them|the player) (?:everything|(?:her|his|their) life)|lives? (?:for|to serve) (?:him|her|them|the player)|belongs? (?:at|by|beside) (?:his|her|their) side|will follow (?:him|her|them|the player) anywhere|devotedly|worships?|obedien(?:t|ce) to)\b/i;
    if (rel.desire < 30 && desireClaims.test(text)) return true;
    if (tropeClaims.test(text)) return true;
    if (positiveStrength < 70 && absoluteClaims.test(text)) return true;
    if (deepTrustClaims.test(text) && !unlocked('trust', 1, 50)) return true;
    if (exceptionalTrustClaims.test(text) && !unlocked('trust', 1, 75)) return true;
    if (deepAffectionClaims.test(text) && !unlocked('affection', 1, 50)) return true;
    if (exceptionalAffectionClaims.test(text) && !unlocked('affection', 1, 75)) return true;
    if (deepDistrustClaims.test(text) && !unlocked('trust', -1, 50)) return true;
    if (deepDislikeClaims.test(text) && !unlocked('affection', -1, 50)) return true;
    // A refused or denied obligation ("does not feel she must repay him") is a boundary, not a claim.
    // The negation must govern the obligation itself: it counts only within the same clause (not
    // across "but/and/because ...") and within a few words of it, and "never doubts that ..." affirms.
    const affirmativeObligation = [...String(text).matchAll(new RegExp(obligationClaims.source, 'gi'))]
        .some(match => {
            const clause = String(text).slice(0, match.index).split(/[,;.]|\b(?:but|and|because|while|although|though|yet|so)\b/i).at(-1) || '';
            const negation = clause.match(/\b(?:not|never|no|nor|without|refuses?\s+to|[a-z]+n[’']t)\b((?:\s+\S+){0,4})\s*$/i);
            return !negation || /\b(?:doubts?|doubted|questions?|questioned|denies|denied|deny)\b/i.test(negation[1]);
        });
    if (affirmativeObligation && !unlocked('trust', 1, 50) && !unlocked('affection', 1, 50)) return true;
    return false;
}

export function relationshipSummaryConsistent(value, relationship = DEFAULT_RELATIONSHIP, context = '', milestones = null) {
    const summary = compactDurableText(value, DURABLE_PROFILE_LIMITS.relationshipSummary, 6);
    if (!summary || relationshipSummaryHasUnsupportedClaims(summary, relationship, milestones)) return false;
    const source = String(context || '').trim();
    if (!source) return true;
    return durableSeedGrounded(summary, source) || durableSemanticSimilarity(summary, source) >= 0.24;
}

export function calibrateRelationshipSummary(value, relationship = DEFAULT_RELATIONSHIP) {
    let summary = compactDurableText(value, DURABLE_PROFILE_LIMITS.relationshipSummary, 6);
    if (!summary) return '';
    const rel = normalizeRelationshipBaseline(relationship || DEFAULT_RELATIONSHIP);
    const positiveStrength = Math.max(0, rel.trust, rel.affection, rel.desire);
    if (positiveStrength < 70) {
        summary = summary
            .replace(/\bindispensable\b/gi, 'important')
            .replace(/\butterly\s+dependent\s+on\b/gi, 'increasingly reliant on')
            .replace(/\bcompletely\s+dependent\s+on\b/gi, 'strongly reliant on')
            .replace(/\b(?:cannot|can['’]?t)\s+live\s+without\b/gi, 'relies deeply on')
            .replace(/\bwould\s+do\s+anything\s+for\b/gi, 'cares deeply for')
            .replace(/\beverything\s+to\s+(her|him|them)\b/gi, 'deeply important to $1');
    }
    if (positiveStrength < 45) {
        summary = summary
            .replace(/\ban important source of physical comfort and survival\b/gi, 'a growing source of practical support and comfort')
            .replace(/\ban important source of survival and physical comfort\b/gi, 'a growing source of practical support and comfort')
            .replace(/\ban important source of (?:her|his|their) survival\b/gi, 'an important source of practical support')
            .replace(/\butterly\s+devoted\s+to\b/gi, 'attached to')
            .replace(/\bunconditionally\s+devoted\s+to\b/gi, 'attached to');
    }
    return compactDurableText(summary, DURABLE_PROFILE_LIMITS.relationshipSummary, 6);
}

const DURABLE_REFINEMENT_STOPWORDS = new Set([
    'and', 'the', 'with', 'that', 'this', 'their', 'they', 'them', 'when', 'while', 'from', 'into', 'over', 'under',
    'very', 'more', 'less', 'than', 'then', 'but', 'for', 'her', 'his', 'its', 'she', 'him', 'who', 'has', 'have', 'had',
    'uses', 'use', 'often', 'usually', 'still', 'also', 'only', 'toward', 'towards', 'around', 'becomes', 'become', 'being',
    'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'by', 'or', 'it', 'he',
]);

const DURABLE_CONCEPT_ALIASES = Object.freeze({
    telepathy: 'telepath', telepathic: 'telepath', telepathically: 'telepath',
    connection: 'link', connections: 'link', connected: 'link', channel: 'link', channels: 'link', linked: 'link',
    thoughts: 'mind', thought: 'mind', minds: 'mind', mental: 'mind',
    siblings: 'sibling', sisters: 'sister', brothers: 'brother',
    courteous: 'courtesy', courteously: 'courtesy', politeness: 'polite', politely: 'polite',
    humorous: 'humor', humorously: 'humor', dryly: 'dry',
    kindness: 'kind', kindhearted: 'kind', compassionate: 'compassion', compassion: 'compassion',
    reserved: 'reserve', restraint: 'restrain', restrained: 'restrain',
    gentleness: 'gentle', gently: 'gentle', motherly: 'maternal',
    speaks: 'speak', speaking: 'speak', spoken: 'speak', says: 'say', saying: 'say',
    gestures: 'gesture', gesturing: 'gesture', movements: 'movement',
    bonded: 'bond', bonding: 'bond', bonds: 'bond',
});

function durableConceptToken(token) {
    let word = String(token || '').toLowerCase();
    if (!word) return '';
    if (DURABLE_CONCEPT_ALIASES[word]) return DURABLE_CONCEPT_ALIASES[word];
    if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
    else if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
    return DURABLE_CONCEPT_ALIASES[word] || word;
}

export function durableRefinementTokens(value) {
    return normalizeName(value).split(/\s+/)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !DURABLE_REFINEMENT_STOPWORDS.has(token))
        .map(durableConceptToken)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !DURABLE_REFINEMENT_STOPWORDS.has(token));
}

export function durableTokenCoverage(existing, incoming) {
    const oldTokens = [...new Set(durableRefinementTokens(existing))];
    if (!oldTokens.length) return 0;
    const newTokens = new Set(durableRefinementTokens(incoming));
    return oldTokens.filter(token => newTokens.has(token)).length / oldTokens.length;
}

export function durableSeedGrounded(value, context = '') {
    const source = String(context || '').trim();
    if (!source) return true; // structured import/API compatibility when no source narration is available.
    const proposed = [...new Set(durableRefinementTokens(value))]
        .filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const sourceTokens = new Set(durableRefinementTokens(source));
    const overlap = proposed.filter(token => sourceTokens.has(token));
    // One distinctive directly stated concept is enough for a tiny field; larger summaries
    // need at least two grounded concepts so one observed act cannot mint a whole personality.
    const required = proposed.length <= 2 ? 1 : 2;
    return overlap.length >= required;
}

export function durableEvidenceGroundsValue(value, evidenceItems = []) {
    const proposed = [...new Set(durableRefinementTokens(value))]
        .filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const evidenceTokens = new Set(durableRefinementTokens((Array.isArray(evidenceItems) ? evidenceItems : []).join(' ')));
    const overlap = proposed.filter(token => evidenceTokens.has(token)).length;
    const required = proposed.length <= 2 ? proposed.length : Math.ceil(proposed.length * 0.6);
    return overlap >= required;
}

export function durableSemanticSimilarity(a, b) {
    const left = new Set(durableRefinementTokens(a));
    const right = new Set(durableRefinementTokens(b));
    if (!left.size || !right.size) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    if (Math.min(left.size, right.size) < 2) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    const containment = overlap / Math.min(left.size, right.size);
    const jaccard = overlap / (left.size + right.size - overlap);
    const conceptCluster = overlap >= 3 && containment >= 0.4 ? 0.62 : 0;
    return Math.max(jaccard, containment * 0.86, conceptCluster);
}

export function chooseCompactEquivalent(existing, incoming) {
    const oldText = cleanText(existing, 1200);
    const newText = cleanText(incoming, 1200);
    if (!oldText) return newText;
    if (!newText) return oldText;
    const oldCount = new Set(durableRefinementTokens(oldText)).size;
    const newCount = new Set(durableRefinementTokens(newText)).size;
    if (newCount >= oldCount + 2) return newText;
    if (oldCount >= newCount + 2) return oldText;
    return newText.length <= oldText.length * 1.15 ? newText : oldText;
}

function splitDurableClauses(value) {
    const source = String(value ?? '')
        .replace(/\r/g, '\n')
        .replace(/[•●▪◦]+/g, ';')
        .replace(/\s+[·]\s+/g, '; ');
    return source.split(/\n+|\s*;\s*|(?<=[.!?])\s+(?=[A-Z0-9])/)
        .map(part => cleanText(part, 520))
        .filter(Boolean);
}

export function splitDurableClaimUnits(value) {
    const out = [];
    for (const clause of splitDurableClauses(value)) {
        const units = clause
            .split(/\s*,\s*|\s+\b(?:and|but|while|yet)\b\s+/iu)
            .map(part => cleanText(part, 520))
            .filter(part => durableRefinementTokens(part).some(token => token.length >= 3 && !/^\d+$/.test(token)));
        if (units.length > 1) out.push(...units);
        else out.push(clause);
    }
    return out.filter(Boolean);
}

export function semanticDedupeItems(items, { maxItems = 8, maxChars = 320, similarity = 0.62 } = {}) {
    const out = [];
    for (const raw of Array.isArray(items) ? items : []) {
        const item = cleanText(raw, maxChars);
        if (!item) continue;
        const exact = normalizeName(item);
        let match = out.findIndex(existing => normalizeName(existing) === exact || durableSemanticSimilarity(existing, item) >= similarity);
        if (match >= 0) out[match] = chooseCompactEquivalent(out[match], item);
        else out.push(item);
        if (out.length > maxItems * 2) out.splice(0, out.length - maxItems * 2);
    }
    return out.slice(-maxItems);
}

export function compactDurableText(value, maxChars, maxClauses = 8) {
    let clauses = semanticDedupeItems(splitDurableClauses(value), {
        maxItems: 64, maxChars: Math.min(520, maxChars), similarity: 0.60,
    });
    if (clauses.length > maxClauses) {
        // Preserve both the established core and the newest distinct refinements when a
        // oversized append-only field has more concepts than the compact summary can carry.
        const headCount = Math.ceil(maxClauses / 2);
        clauses = [...clauses.slice(0, headCount), ...clauses.slice(-(maxClauses - headCount))];
    }
    if (!clauses.length) return '';
    const out = [];
    let used = 0;
    for (const clause of clauses) {
        const separator = out.length ? '; ' : '';
        const available = maxChars - used - separator.length;
        if (available <= 0) break;
        if (clause.length <= available) {
            out.push(clause);
            used += separator.length + clause.length;
            continue;
        }
        if (!out.length) out.push(cleanText(clause, maxChars));
        break;
    }
    return out.join('; ');
}
