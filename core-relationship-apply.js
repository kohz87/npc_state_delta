/* NPC State Delta relationship scoring: inertia, axis selection and applyRelationshipDelta, including
   the milestone gate helpers that scoring reads. Moved unchanged out of core-relationship.js; that file
   re-exports every public name it exported before. Never imports core-relationship.js, core-mechanics.js
   or core.js. */
import { clamp } from './core-identity.js';
import {
    DEFAULT_RELATIONSHIP,
    DEFAULT_RELATIONSHIP_CAPS,
    DEFAULT_RELATIONSHIP_PROGRESS,
    normalizeRelationshipBaseline,
    normalizeRelationshipCaps,
    normalizeRelationshipDelta,
    normalizeRelationshipImpact,
    normalizeRelationshipMilestones,
    normalizeRelationshipProgress,
    RELATIONSHIP_KEYS,
    RELATIONSHIP_MILESTONE_MIN_RAW,
    RELATIONSHIP_MILESTONE_REQUIREMENTS,
    RELATIONSHIP_MILESTONE_THRESHOLDS,
    relationshipMilestoneUnlocked,
} from './core-relationship-model.js';

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
