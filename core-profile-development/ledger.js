/* Personality/Speech development ledger model: field config, bounded evidence parsing, concept and
   ledger normalization, reset/rebase and the per-NPC ledger accessor. A pure part of
   core-profile-development.js (same owner, moved without change); the root file keeps the public
   facade and re-exports every public name it exported before. Never imports core-profile-development.js. */
import * as mechanics from '../core-mechanics.js';
import { migrateLegacyStoryDay, STORY_DAY_SCHEME } from '../calendar.js';

const PROFILE_DEVELOPMENT_VERSION = 2;
export const PROFILE_DEVELOPMENT_CONCEPT_LIMIT = 4;
export const PROFILE_DEVELOPMENT_OBSERVATION_LIMIT = 4;
export const PROFILE_DEVELOPMENT_READY_COUNT = 3;
export const PROFILE_DEVELOPMENT_MIN_SPAN = 2;
// A slow Personality/Speech change seen in two scenes far apart is development, not one scene's
// mood: a trend started by one grounded sighting needs only one confirmation once enough story time
// has passed. Dated World State measures story days; without dates, messages/turns stand in.
// Close together it still needs three.
export const PERSONALITY_SPREAD_READY_COUNT = 2;
export const DEVELOPMENT_SPREAD_MIN_DAYS = 7;
export const PERSONALITY_SPREAD_MIN_MESSAGES = 20;
export const PERSONALITY_SPREAD_MIN_TURNS = 10;

export const PROFILE_DEVELOPMENT_FIELDS = Object.freeze({
    personality: Object.freeze({ ledgerKey: 'personalityDevelopment', baselineKey: 'baselinePersonality' }),
    speech: Object.freeze({ ledgerKey: 'speechDevelopment', baselineKey: 'baselineSpeech' }),
});

export function profileDevelopmentText(field, value, maxChars = null) {
    const limit = Math.max(1, Number(maxChars) || mechanics.DURABLE_PROFILE_LIMITS[field] || mechanics.DURABLE_PROFILE_LIMITS.evidence);
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function profileDevelopmentTurn(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

export function profileDevelopmentSourceMessageId(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

export function profileDevelopmentEvidence(field, raw = {}) {
    const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? raw?.observations ?? {};
    const values = Array.isArray(evidence?.[field]) ? evidence[field] : [];
    return values.map(item => profileDevelopmentText(field, item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean).slice(0, 8);
}

export function parseProfileDevelopmentEvidence(field, value) {
    let text = profileDevelopmentText(field, value, mechanics.DURABLE_PROFILE_LIMITS.evidence);
    if (!text) return null;
    const marker = text.match(/^\[m(\d+)\]\s*/i);
    const sourceMessageId = marker ? profileDevelopmentSourceMessageId(marker[1]) : null;
    if (marker) text = text.slice(marker[0].length).trim();
    if (!text) return null;
    const labeled = text.match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]{1,48})\s*:\s*(.+)$/u);
    const explicitConcept = labeled ? mechanics.normalizeName(labeled[1]).slice(0, 60) : '';
    // A Speech label is the style claim and a quoted line only illustrates it, so the label stays
    // in the body; a bare quote could never ground a description of how the NPC speaks.
    const quotedSpeech = field === 'speech' && labeled && /^["“‘'].*["”’']\W*$/u.test(labeled[2].trim());
    const body = profileDevelopmentText(field, quotedSpeech ? `${labeled[1].trim()} (${labeled[2].trim()})` : (labeled ? labeled[2] : text), mechanics.DURABLE_PROFILE_LIMITS.evidence);
    const concept = explicitConcept || mechanics.normalizeName(body).slice(0, 60);
    return body && concept ? { concept, explicitConcept, body, sourceMessageId } : null;
}

export function normalizeProfileDevelopmentConcept(raw = {}) {
    const concept = mechanics.normalizeName(raw?.concept).slice(0, 60);
    if (!concept) return null;
    const sourceMessageIds = [...new Set((Array.isArray(raw?.sourceMessageIds) ? raw.sourceMessageIds : [])
        .map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const turns = [...new Set((Array.isArray(raw?.turns) ? raw.turns : [])
        .map(profileDevelopmentTurn).filter(value => value !== null))]
        .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const currentDays = Number(raw?.dayScheme) === STORY_DAY_SCHEME;
    const days = [...new Set((Array.isArray(raw?.days) ? raw.days : [])
        .map(value => (currentDays ? Number(value) : migrateLegacyStoryDay(value))).filter(Number.isInteger))]
        .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const firstTurn = profileDevelopmentTurn(raw?.firstTurn);
    const lastTurn = profileDevelopmentTurn(raw?.lastTurn);
    const observationCount = Math.max(
        0,
        Math.min(9, Math.round(Number(raw?.observationCount) || 0)),
        sourceMessageIds.length,
        turns.length,
    );
    const evidenceSamples = [...new Set((Array.isArray(raw?.evidenceSamples) ? raw.evidenceSamples : [])
        .map(item => profileDevelopmentText('speech', item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean))]
        .slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const latestEvidence = profileDevelopmentText('speech', raw?.latestEvidence, mechanics.DURABLE_PROFILE_LIMITS.evidence)
        || evidenceSamples.at(-1) || '';
    // v1 records had only latestEvidence. Seed one bounded sample during normalization, but once
    // v2 samples exist do not let a replayed source manufacture another historical observation.
    if (!evidenceSamples.length && latestEvidence) evidenceSamples.push(latestEvidence);
    return {
        concept,
        firstTurn: firstTurn ?? (turns.length ? Math.min(...turns) : null),
        lastTurn: lastTurn ?? (turns.length ? Math.max(...turns) : null),
        observationCount,
        sourceMessageIds,
        turns,
        ...(days.length ? { days, dayScheme: STORY_DAY_SCHEME } : {}),
        evidenceSamples,
        latestEvidence,
    };
}

function legacyProfileDevelopmentConcepts(field, npc = {}) {
    const concepts = [];
    for (const evidence of profileDevelopmentEvidence(field, { evidence: npc?.profileEvidence || {} })) {
        const parsed = parseProfileDevelopmentEvidence(field, evidence);
        if (!parsed) continue;
        const duplicate = concepts.some(record => mechanics.durableProfileEvidenceRelated(record.latestEvidence, parsed.body));
        if (duplicate) continue;
        concepts.push({
            concept: parsed.concept,
            firstTurn: null,
            lastTurn: null,
            observationCount: 1,
            sourceMessageIds: [],
            turns: [],
            evidenceSamples: [parsed.body],
            latestEvidence: parsed.body,
        });
        if (concepts.length >= PROFILE_DEVELOPMENT_CONCEPT_LIMIT) break;
    }
    return concepts;
}

export function emptyProfileDevelopment(field, npc = {}, concepts = []) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: 0,
        [config.baselineKey]: profileDevelopmentText(field, npc?.[field]),
        baselineTurn: null,
        baselineSourceMessageId: null,
        concepts: concepts.map(normalizeProfileDevelopmentConcept).filter(Boolean).slice(-PROFILE_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

function normalizeProfileDevelopment(field, raw, npc = {}, { seedLegacy = false } = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!source) {
        const seeded = seedLegacy ? legacyProfileDevelopmentConcepts(field, npc) : [];
        return seeded.length ? emptyProfileDevelopment(field, npc, seeded) : null;
    }
    const concepts = [];
    const byConcept = new Map();
    for (const item of Array.isArray(source.concepts) ? source.concepts : []) {
        const normalized = normalizeProfileDevelopmentConcept(item);
        if (!normalized) continue;
        if (byConcept.has(normalized.concept)) concepts[byConcept.get(normalized.concept)] = normalized;
        else {
            byConcept.set(normalized.concept, concepts.length);
            concepts.push(normalized);
        }
    }
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(source.epoch) || 0)),
        [config.baselineKey]: profileDevelopmentText(field, source[config.baselineKey] ?? npc?.[field]),
        baselineTurn: profileDevelopmentTurn(source.baselineTurn),
        baselineSourceMessageId: profileDevelopmentSourceMessageId(source.baselineSourceMessageId),
        concepts: concepts.slice(-PROFILE_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

export function resetProfileDevelopment(field, ledger, value, options = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(ledger?.epoch) || 0)) + 1,
        [config.baselineKey]: profileDevelopmentText(field, value),
        baselineTurn: profileDevelopmentTurn(options.turn),
        baselineSourceMessageId: profileDevelopmentSourceMessageId(options.sourceMessageId),
        concepts: [],
    };
}

export function rebaseProfileDevelopment(field, ledger, value) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    return { ...ledger, [config.baselineKey]: profileDevelopmentText(field, value) };
}

export function profileDevelopmentForNpc(field, npc = {}, { seedLegacy = false } = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    let ledger = normalizeProfileDevelopment(field, npc?.[config.ledgerKey], npc, { seedLegacy });
    if (!ledger) return null;
    const current = profileDevelopmentText(field, npc?.[field]);
    if (mechanics.normalizeName(ledger[config.baselineKey]) !== mechanics.normalizeName(current)) {
        ledger = resetProfileDevelopment(field, ledger, current);
    }
    return ledger;
}
