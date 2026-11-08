/* NPC State Delta relationship model: defaults, milestone thresholds and the baseline, caps, impact,
   delta, progress and milestone normalizers. Pure relationship data helpers moved unchanged out of
   core-relationship.js; that file re-exports every public name it exported before. Never imports
   core-relationship.js, core-mechanics.js or core.js. */
import { SOCIAL_KEY_RELATIONSHIP_MAX_CHARS } from './social.js';
import { clamp } from './core-identity.js';
import { cleanText } from './core-text.js';

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
    major: 3,
    extreme: 6,
});
// The defaults before pacing (1.14): a saved set equal to this one is moved to the new defaults once (runtime-settings.js).
export const LEGACY_RELATIONSHIP_CAPS = Object.freeze({ ordinary: 1, meaningful: 2, major: 5, extreme: 10 });
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
