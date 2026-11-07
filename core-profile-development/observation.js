/* Personality/Speech development observation: matching a bounded evidence claim to a ledger concept
   and recording non-duplicate sightings with their message/turn/story-day provenance. A pure part of
   core-profile-development.js (same owner, moved without change); the root file keeps the public
   facade and re-exports every public name it exported before. Never imports core-profile-development.js. */
import * as mechanics from '../core-mechanics.js';
import { STORY_DAY_SCHEME } from '../calendar.js';
import { PROFILE_DEVELOPMENT_CONCEPT_LIMIT, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT, profileDevelopmentEvidence, profileDevelopmentSourceMessageId, profileDevelopmentTurn, parseProfileDevelopmentEvidence, normalizeProfileDevelopmentConcept } from './ledger.js';

export function developmentRecordMatches(record, parsed) {
    if (!record || !parsed) return false;
    if (parsed.explicitConcept && record.concept === parsed.explicitConcept) return true;
    const samples = [...(Array.isArray(record.evidenceSamples) ? record.evidenceSamples : []), record.latestEvidence]
        .filter(Boolean);
    if (samples.some(sample => mechanics.durableProfileEvidenceRelated(sample, parsed.body))) return true;
    if (!parsed.explicitConcept || !record.concept) return false;
    return samples.some(sample => mechanics.durableProfileEvidenceRelated(
        `${record.concept}: ${sample}`,
        `${parsed.explicitConcept}: ${parsed.body}`,
    ));
}

function findDevelopmentRecordIndex(concepts, parsed) {
    const exact = parsed?.explicitConcept
        ? concepts.findIndex(record => record?.concept === parsed.explicitConcept)
        : -1;
    if (exact >= 0) return exact;
    return concepts.findIndex(record => developmentRecordMatches(record, parsed));
}

export function observeProfileDevelopment(field, ledger, rawUpdate = {}, options = {}) {
    const evidence = profileDevelopmentEvidence(field, rawUpdate);
    if (!ledger || !evidence.length) return ledger;
    const fallbackTurn = profileDevelopmentTurn(options.turn);
    const fallbackSourceMessageId = profileDevelopmentSourceMessageId(options.sourceMessageId);
    const allowedSourceMessageIds = Array.isArray(options.developmentSourceMessageIds)
        ? new Set(options.developmentSourceMessageIds.map(profileDevelopmentSourceMessageId).filter(value => value !== null))
        : null;
    const next = structuredClone(ledger);
    for (const item of evidence) {
        const parsed = parseProfileDevelopmentEvidence(field, item);
        if (!parsed) continue;
        const taggedSourceMessageId = parsed.sourceMessageId !== null && allowedSourceMessageIds?.has(parsed.sourceMessageId)
            ? parsed.sourceMessageId
            : null;
        const sourceMessageId = taggedSourceMessageId ?? fallbackSourceMessageId;
        const turn = taggedSourceMessageId !== null ? null : fallbackTurn;
        const storyDays = options.storyDays && typeof options.storyDays === 'object' ? options.storyDays : {};
        const taggedDay = taggedSourceMessageId !== null ? Number(storyDays[taggedSourceMessageId]) : NaN;
        const day = Number.isInteger(taggedDay) ? taggedDay
            : (taggedSourceMessageId === null && Number.isInteger(options.storyDay) ? options.storyDay : null);
        // A later sighting of the opposite tendency breaks a pending trend: it has to start again.
        next.concepts = next.concepts.filter(record => developmentRecordMatches(record, parsed)
            || !mechanics.durableEvidenceContradicts(record.latestEvidence, parsed.body));
        let index = findDevelopmentRecordIndex(next.concepts, parsed);
        if (index < 0) {
            if (next.concepts.length >= PROFILE_DEVELOPMENT_CONCEPT_LIMIT) next.concepts.shift();
            const fresh = normalizeProfileDevelopmentConcept({ concept: parsed.concept });
            if (!fresh) continue;
            next.concepts.push(fresh);
            index = next.concepts.length - 1;
        }
        const record = next.concepts[index];
        if (parsed.explicitConcept && record.concept !== parsed.explicitConcept
            && mechanics.durableProfileEvidenceRelated(record.latestEvidence, parsed.body)) {
            record.concept = parsed.explicitConcept;
        }
        const duplicate = sourceMessageId !== null
            ? record.sourceMessageIds.includes(sourceMessageId)
            : (turn !== null ? record.turns.includes(turn) : record.observationCount > 0);
        record.latestEvidence = parsed.body;
        if (duplicate) continue;
        record.evidenceSamples = [...(Array.isArray(record.evidenceSamples) ? record.evidenceSamples : [])
            .filter(item => mechanics.normalizeName(item) !== mechanics.normalizeName(parsed.body)), parsed.body]
            .slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
        record.observationCount = Math.min(9, Number(record.observationCount || 0) + 1);
        if (sourceMessageId !== null) {
            record.sourceMessageIds = [...new Set([...record.sourceMessageIds, sourceMessageId])]
                .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
        }
        if (day !== null) {
            record.days = [...new Set([...(Array.isArray(record.days) ? record.days : []), day])]
                .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
            record.dayScheme = STORY_DAY_SCHEME;
        }
        if (turn !== null) {
            record.turns = [...new Set([...record.turns, turn])]
                .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
            record.firstTurn = record.firstTurn === null ? turn : Math.min(record.firstTurn, turn);
            record.lastTurn = record.lastTurn === null ? turn : Math.max(record.lastTurn, turn);
        }
    }
    return next;
}
