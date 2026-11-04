/* NPC State Delta profile development: the Personality/Speech development ledgers (concepts, observations, readiness and
   spread rules), the per-scan preparation, and the diagnostics the merge records for profile, appearance and birthday updates.
   A pure part of core.js (same owner, moved without change); core.js re-exports every name it exported before. Never imports core.js. */
import * as mechanics from './core-mechanics.js';
import { migrateLegacyStoryDay, normalizeCalendarDate, STORY_DAY_SCHEME } from './calendar.js';
import * as continuity from './continuity-core.js';
import { birthdayPromptSource, exactStoredAge, sameCalendarBirthday } from './core-birthday.js';
import { birthdayEvidenceInText } from './birthday.js';

const PROFILE_DEVELOPMENT_VERSION = 2;
const PROFILE_DEVELOPMENT_CONCEPT_LIMIT = 4;
const PROFILE_DEVELOPMENT_OBSERVATION_LIMIT = 4;
export const PROFILE_DEVELOPMENT_READY_COUNT = 3;
const PROFILE_DEVELOPMENT_MIN_SPAN = 2;
// A slow Personality/Speech change seen in two scenes far apart is development, not one scene's
// mood: a trend started by one grounded sighting needs only one confirmation once enough story time
// has passed. Dated World State measures story days; without dates, messages/turns stand in.
// Close together it still needs three.
const PERSONALITY_SPREAD_READY_COUNT = 2;
const DEVELOPMENT_SPREAD_MIN_DAYS = 7;
const PERSONALITY_SPREAD_MIN_MESSAGES = 20;
const PERSONALITY_SPREAD_MIN_TURNS = 10;

export const PROFILE_DEVELOPMENT_FIELDS = Object.freeze({
    personality: Object.freeze({ ledgerKey: 'personalityDevelopment', baselineKey: 'baselinePersonality' }),
    speech: Object.freeze({ ledgerKey: 'speechDevelopment', baselineKey: 'baselineSpeech' }),
});

export function profileDevelopmentText(field, value, maxChars = null) {
    const limit = Math.max(1, Number(maxChars) || mechanics.DURABLE_PROFILE_LIMITS[field] || mechanics.DURABLE_PROFILE_LIMITS.evidence);
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function profileDevelopmentTurn(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function profileDevelopmentSourceMessageId(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

export function profileDevelopmentEvidence(field, raw = {}) {
    const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? raw?.observations ?? {};
    const values = Array.isArray(evidence?.[field]) ? evidence[field] : [];
    return values.map(item => profileDevelopmentText(field, item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean).slice(0, 8);
}

function parseProfileDevelopmentEvidence(field, value) {
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

function normalizeProfileDevelopmentConcept(raw = {}) {
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

function developmentRecordMatches(record, parsed) {
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

function observeProfileDevelopment(field, ledger, rawUpdate = {}, options = {}) {
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

function developmentReadyCount(field, sourceIds = [], turns = [], days = []) {
    if (field !== 'personality' && field !== 'speech') return PROFILE_DEVELOPMENT_READY_COUNT;
    const span = values => (values.length >= 2 ? values[values.length - 1] - values[0] : 0);
    // Story time decides when it is known; message/turn distance is only the fallback.
    if (days.length >= 2) return span(days) >= DEVELOPMENT_SPREAD_MIN_DAYS ? PERSONALITY_SPREAD_READY_COUNT : PROFILE_DEVELOPMENT_READY_COUNT;
    if (field !== 'personality') return PROFILE_DEVELOPMENT_READY_COUNT;
    return span(sourceIds) >= PERSONALITY_SPREAD_MIN_MESSAGES || span(turns) >= PERSONALITY_SPREAD_MIN_TURNS
        ? PERSONALITY_SPREAD_READY_COUNT
        : PROFILE_DEVELOPMENT_READY_COUNT;
}

function sortedDays(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function profileDevelopmentConceptReady(record = {}, field = '') {
    const sourceIds = [...new Set((record.sourceMessageIds || []).map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const turns = [...new Set((record.turns || []).map(profileDevelopmentTurn).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const days = sortedDays(record.days);
    const required = developmentReadyCount(field, sourceIds, turns, days);
    if (Number(record.observationCount || 0) < required) return false;
    if (required === PERSONALITY_SPREAD_READY_COUNT && days.length >= 2) return true;
    const firstTurn = profileDevelopmentTurn(record.firstTurn);
    const lastTurn = profileDevelopmentTurn(record.lastTurn);
    const turnReady = firstTurn !== null && lastTurn !== null && lastTurn - firstTurn >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const sourceReady = sourceIds.length >= required
        && sourceIds[sourceIds.length - 1] - sourceIds[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    return turnReady || sourceReady;
}

function aggregateProfileDevelopmentEvidence(ledger = {}, field = '') {
    const groups = new Map();
    const sourceIds = new Set();
    const turns = new Set();
    for (const record of Array.isArray(ledger?.concepts) ? ledger.concepts : []) {
        const samples = Array.isArray(record?.evidenceSamples) && record.evidenceSamples.length
            ? record.evidenceSamples
            : (record?.latestEvidence ? [record.latestEvidence] : []);
        const recordSources = Array.isArray(record?.sourceMessageIds) ? record.sourceMessageIds : [];
        const recordTurns = Array.isArray(record?.turns) ? record.turns : [];
        for (let i = 0; i < samples.length; i += 1) {
            const sample = profileDevelopmentText('speech', samples[i], mechanics.DURABLE_PROFILE_LIMITS.evidence);
            if (!sample) continue;
            const sourceId = profileDevelopmentSourceMessageId(recordSources[i]);
            const turn = profileDevelopmentTurn(recordTurns[i]);
            const key = sourceId !== null ? `m:${sourceId}` : (turn !== null ? `t:${turn}` : '');
            if (!key) continue;
            if (sourceId !== null) sourceIds.add(sourceId);
            if (turn !== null) turns.add(turn);
            const current = groups.get(key) || [];
            if (!current.some(value => mechanics.normalizeName(value) === mechanics.normalizeName(sample))) current.push(sample);
            groups.set(key, current.slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT));
        }
    }
    const orderedSources = [...sourceIds].sort((a, b) => a - b);
    const orderedTurns = [...turns].sort((a, b) => a - b);
    const orderedDays = sortedDays((Array.isArray(ledger?.concepts) ? ledger.concepts : []).flatMap(record => record?.days || []));
    const required = developmentReadyCount(field, orderedSources, orderedTurns, orderedDays);
    const sourceReady = orderedSources.length >= required
        && orderedSources.at(-1) - orderedSources[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const turnReady = orderedTurns.length >= required
        && orderedTurns.at(-1) - orderedTurns[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const dayReady = required === PERSONALITY_SPREAD_READY_COUNT && orderedDays.length >= 2;
    return {
        ready: groups.size >= required && (sourceReady || turnReady || dayReady),
        required,
        count: groups.size,
        groups: [...groups.values()].map(values => values.join(' ')).filter(Boolean),
        sourceMessageIds: orderedSources,
        turns: orderedTurns,
    };
}

export function profileDevelopmentProvenanceReady(aggregate = {}, required = 2) {
    const threshold = Math.max(1, Number(required) || 1);
    const sources = [...new Set((aggregate?.sourceMessageIds || []).map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const turns = [...new Set((aggregate?.turns || []).map(profileDevelopmentTurn).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const sourceReady = sources.length >= threshold
        && sources.at(-1) - sources[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const turnReady = turns.length >= threshold
        && turns.at(-1) - turns[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    return sourceReady || turnReady;
}

function readyProfileDevelopmentRecords(field, ledger, rawUpdate = {}) {
    const current = profileDevelopmentEvidence(field, rawUpdate)
        .map(item => parseProfileDevelopmentEvidence(field, item)).filter(Boolean);
    if (!current.length) return [];
    return (ledger?.concepts || []).filter(record => profileDevelopmentConceptReady(record, field)
        && current.some(parsed => developmentRecordMatches(record, parsed)));
}

// The row that supplies one durable field for this NPC. Profile rows still come before ordinary
// rows, but a matching row that does not carry the field (an unchanged Speech-only profile row)
// must not hide another field's candidate and evidence in a later matching row.
export function durableUpdateForNpc(scanResult, npc, field = '') {
    const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const matches = [...profile, ...ordinary].filter(raw => raw && typeof raw === 'object' && (
        (raw.id && String(raw.id) === String(npc?.id))
        || (raw.name && mechanics.npcMatchesLabel(npc, raw.name))
    ));
    if (!field) return matches[0] || null;
    const has = (raw, key) => Object.prototype.hasOwnProperty.call(raw, key);
    const snake = field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const carries = raw => has(raw, field) || has(raw, snake)
        || has(raw, `${field}State`) || has(raw, `${snake}_state`)
        || has(raw, `${field}Reason`) || has(raw, `${snake}_reason`)
        || profileDevelopmentEvidence(field, raw).length > 0;
    return matches.find(carries) || matches[0] || null;
}

export function appearanceUpdateForNpc(scanResult, npc) {
    const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const matches = [...profile, ...ordinary].filter(raw => raw && typeof raw === 'object' && (
        (raw.id && String(raw.id) === String(npc?.id))
        || (raw.name && mechanics.npcMatchesLabel(npc, raw.name))
    ));
    const carriesAppearance = raw => {
        const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? {};
        return Object.prototype.hasOwnProperty.call(raw, 'appearance')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceState')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_state')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceReason')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_reason')
            || Object.prototype.hasOwnProperty.call(raw, 'overallAppearance')
            || Object.prototype.hasOwnProperty.call(raw, 'overall_appearance')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceForms')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_forms')
            || Object.prototype.hasOwnProperty.call(raw, 'currentForm')
            || Object.prototype.hasOwnProperty.call(raw, 'current_form')
            || Object.prototype.hasOwnProperty.call(raw, 'currentFormState')
            || Object.prototype.hasOwnProperty.call(raw, 'current_form_state')
            || (Array.isArray(evidence?.appearance) && evidence.appearance.length > 0);
    };
    return matches.find(carriesAppearance) || matches[0] || null;
}

export function prepareProfileDevelopmentState(state, scanResult, options = {}) {
    const plans = new Map();
    const profileUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const singleTargetUpdate = profileUpdates.length === 1;
    const npcs = (Array.isArray(state?.npcs) ? state.npcs : []).map(rawNpc => {
        const fieldPlans = {};
        let nextNpc = rawNpc;
        for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
            const config = PROFILE_DEVELOPMENT_FIELDS[field];
            const update = durableUpdateForNpc(scanResult, rawNpc, field);
            const locked = Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes(field);
            const evidence = profileDevelopmentEvidence(field, update || {});
            const candidate = profileDevelopmentText(field, update?.[field]);
            const active = Boolean(evidence.length || candidate);
            let ledger = profileDevelopmentForNpc(field, rawNpc, { seedLegacy: true });
            if (!ledger && evidence.length && !locked) ledger = emptyProfileDevelopment(field, rawNpc);
            if (ledger && update && !locked && evidence.length) ledger = observeProfileDevelopment(field, ledger, update, options);
            if (ledger) {
                if (nextNpc === rawNpc) nextNpc = { ...rawNpc };
                nextNpc[config.ledgerKey] = ledger;
            }
            if (ledger || active) {
                fieldPlans[field] = {
                    update,
                    ledger,
                    locked,
                    active,
                    evidence: evidence.map(item => parseProfileDevelopmentEvidence(field, item)).filter(Boolean),
                    beforeValue: profileDevelopmentText(field, rawNpc?.[field]),
                    readyRecords: ledger && !locked ? readyProfileDevelopmentRecords(field, ledger, update || {}) : [],
                    aggregateEvidence: ledger && !locked ? aggregateProfileDevelopmentEvidence(ledger, field) : { ready: false, count: 0, groups: [], sourceMessageIds: [], turns: [] },
                    singleTargetUpdate,
                    otherLabels: (Array.isArray(state?.npcs) ? state.npcs : [])
                        .filter(other => String(other?.id || '') !== String(rawNpc?.id || ''))
                        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
                        .filter(Boolean).slice(0, 64),
                };
            }
        }
        if (Object.keys(fieldPlans).length) plans.set(String(rawNpc.id || ''), fieldPlans);
        return nextNpc;
    });
    return { state: { ...(state || {}), npcs }, plans };
}

export function clearProfileEvidence(npc, field) {
    const profileEvidence = npc?.profileEvidence && typeof npc.profileEvidence === 'object' && !Array.isArray(npc.profileEvidence)
        ? npc.profileEvidence
        : {};
    npc.profileEvidence = { ...profileEvidence, [field]: [] };
}

export function markProfileApplied(report, npcId) {
    if (!report || !npcId) return;
    report.updated = Array.isArray(report.updated) ? report.updated : [];
    report.profileUpdated = Array.isArray(report.profileUpdated) ? report.profileUpdated : [];
    if (!report.updated.includes(npcId)) report.updated.push(npcId);
    const alreadyApplied = report.profileUpdated.includes(npcId);
    if (!alreadyApplied) report.profileUpdated.push(npcId);
    report.profileUpdateStats = report.profileUpdateStats && typeof report.profileUpdateStats === 'object'
        ? report.profileUpdateStats
        : { provided: 0, applied: 0, evidenceAdded: 0 };
    if (!alreadyApplied) report.profileUpdateStats.applied = Number(report.profileUpdateStats.applied || 0) + 1;
}

export function recordProfileDevelopmentDiagnostic(report, npcId, field, outcome, plan = null, details = {}) {
    if (!report || !npcId || !field || !outcome) return;
    report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
    const observations = Math.max(0, ...(plan?.ledger?.concepts || []).map(record => Number(record?.observationCount || 0)));
    const evidence = (Array.isArray(plan?.evidence) ? plan.evidence : []).slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => ({
        sourceMessageId: profileDevelopmentSourceMessageId(item?.sourceMessageId),
        concept: profileDevelopmentText(field, item?.explicitConcept || item?.concept, 60),
        sample: profileDevelopmentText(field, item?.body, mechanics.DURABLE_PROFILE_LIMITS.evidence),
    }));
    report.profileDevelopment.push({
        npcId: String(npcId),
        field,
        outcome,
        ready: Boolean(plan?.readyRecords?.length),
        aggregateReady: Boolean(plan?.aggregateEvidence?.ready),
        aggregateObservations: Number(plan?.aggregateEvidence?.count || 0),
        locked: Boolean(plan?.locked),
        observations,
        previous: profileDevelopmentText(field, plan?.beforeValue),
        candidate: profileDevelopmentText(field, plan?.update?.[field]),
        evidence,
        ...details,
    });
    if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
}

export function recordAppearanceDiagnostic(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
    if (!report || !beforeNpc || !afterNpc) return;
    const raw = rawUpdate && typeof rawUpdate === 'object' ? rawUpdate : {};
    const normalized = continuity.normalizeScanNpc(raw);
    const evidenceSource = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? {};
    const rawEvidence = Array.isArray(evidenceSource?.appearance) ? evidenceSource.appearance : [];
    const providerFieldPresent = [
        'appearance', 'appearanceState', 'appearance_state', 'appearanceReason', 'appearance_reason',
        'overallAppearance', 'overall_appearance', 'appearanceForms', 'appearance_forms',
        'currentForm', 'current_form', 'currentFormState', 'current_form_state',
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
    const providerEvidencePresent = rawEvidence.length > 0;
    const structuredAppearancePresent = [
        'overallAppearance', 'overall_appearance', 'appearanceForms', 'appearance_forms',
        'currentForm', 'current_form', 'currentFormState', 'current_form_state',
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
    const previousValue = profileDevelopmentText('appearance', beforeNpc.appearance, 720);
    const candidateValue = profileDevelopmentText('appearance', normalized.appearance, 720);
    const currentValue = profileDevelopmentText('appearance', afterNpc.appearance, 720);
    const locked = Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes('appearance');
    const flatCandidateChanged = Boolean(candidateValue)
        && mechanics.normalizeName(candidateValue) !== mechanics.normalizeName(previousValue);
    const changed = mechanics.normalizeName(currentValue) !== mechanics.normalizeName(previousValue);
    const diagnosticCandidate = candidateValue || (structuredAppearancePresent && changed ? currentValue : '');
    const candidateChanged = Boolean(diagnosticCandidate)
        && mechanics.normalizeName(diagnosticCandidate) !== mechanics.normalizeName(previousValue);
    const candidateAlreadyRepresented = Boolean(diagnosticCandidate) && !candidateChanged;
    const otherLabels = (Array.isArray(allNpcs) ? allNpcs : [])
        .filter(other => String(other?.id || '') !== String(afterNpc?.id || ''))
        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
        .filter(Boolean).slice(0, 64);
    const binding = {
        npc: afterNpc,
        evidence: rawEvidence,
        targeted: options.allowTargetedDurableSeed === true || options.developmentSingleTarget === true,
        otherLabels,
    };
    const candidateGrounded = flatCandidateChanged && normalized.appearanceState !== 'change'
        ? mechanics.durableRefinementCandidateGrounded(
            'appearance',
            previousValue,
            candidateValue,
            options.developmentContext || '',
            rawEvidence,
            binding,
        )
        : null;
    const fieldReason = profileDevelopmentText('appearance', normalized.appearanceReason, 500);
    const outcome = !providerFieldPresent && !providerEvidencePresent ? 'not-provided'
        : (locked ? 'locked'
            : (changed ? (structuredAppearancePresent && !candidateValue ? 'applied-form-update' : `applied-${normalized.appearanceState || 'update'}`)
                : (!candidateValue
                    ? (structuredAppearancePresent ? 'form-update-unchanged-or-gated' : 'candidate-missing')
                    : (candidateAlreadyRepresented ? 'unchanged' : 'unchanged-or-gated'))));
    const evidence = rawEvidence.slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => {
        const parsed = parseProfileDevelopmentEvidence('appearance', item);
        return {
            sourceMessageId: parsed?.sourceMessageId ?? null,
            concept: parsed?.explicitConcept || parsed?.concept || '',
            sample: parsed?.body || profileDevelopmentText('appearance', item, mechanics.DURABLE_PROFILE_LIMITS.evidence),
        };
    });
    report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
    report.profileDevelopment.push({
        npcId: String(afterNpc.id || ''),
        field: 'appearance',
        outcome,
        modelState: normalized.appearanceState || 'keep',
        scale: '',
        effectiveScale: '',
        locked,
        previous: previousValue,
        candidate: diagnosticCandidate,
        fieldReason,
        providerReasonPresent: Boolean(fieldReason),
        effectiveReason: fieldReason,
        effectiveReasonSource: fieldReason ? 'field' : 'none',
        candidateChanged,
        candidateAlreadyRepresented,
        evidenceAlreadyRepresented: null,
        evidenceResolved: false,
        candidateGrounded,
        reasonGrounded: null,
        providerFieldPresent,
        structuredAppearancePresent,
        providerEvidencePresent,
        evidence,
    });
    if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
}

export function recordSecondaryProfileDiagnostics(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
    if (!report || !afterNpc || !rawUpdate) return;
    const normalized = continuity.normalizeScanNpc(rawUpdate);
    const evidenceSource = rawUpdate?.evidence ?? rawUpdate?.profileEvidence ?? rawUpdate?.profile_evidence ?? {};
    const otherLabels = (Array.isArray(allNpcs) ? allNpcs : [])
        .filter(other => String(other?.id || '') !== String(afterNpc?.id || ''))
        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
        .filter(Boolean).slice(0, 64);
    for (const field of ['mannerisms', 'behaviorProfile']) {
        const stateField = field === 'mannerisms' ? 'mannerismState' : 'behaviorProfileState';
        const reasonField = field === 'mannerisms' ? 'mannerismReason' : 'behaviorProfileReason';
        const provided = field === 'mannerisms' ? normalized.mannerismsProvided : normalized.behaviorProfileProvided;
        if (!provided) {
            // Explain why stored non-lever entries survived: the provider omitted the field or
            // proposed only non-lever entries, which intake drops.
            if (field !== 'behaviorProfile') continue;
            const rawBehavior = rawUpdate.behaviorProfile ?? rawUpdate.behavior_profile;
            const nonLeverOnly = Array.isArray(normalized.nonLeverBehavior) && normalized.nonLeverBehavior.length > 0;
            const stored = Array.isArray(beforeNpc?.behaviorProfile) ? beforeNpc.behaviorProfile : [];
            if (!nonLeverOnly && !stored.some(entry => !mechanics.isBehaviorLever(entry))) continue;
            report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
            report.profileDevelopment.push({
                npcId: String(afterNpc.id || ''),
                field,
                outcome: nonLeverOnly ? 'non-lever-only' : 'not-provided',
                modelState: normalized[stateField] || 'keep',
                locked: Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes(field),
                providerFieldPresent: rawBehavior !== undefined,
                previous: profileDevelopmentText(field, stored.join(' | '), 720),
                candidate: profileDevelopmentText(field, (normalized.nonLeverBehavior || []).join(' | '), 720),
                evidence: [],
            });
            if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
            continue;
        }
        const previousValue = Array.isArray(beforeNpc?.[field]) ? beforeNpc[field].join(' | ') : '';
        const candidateValue = Array.isArray(normalized?.[field]) ? normalized[field].join(' | ') : '';
        const currentValue = Array.isArray(afterNpc?.[field]) ? afterNpc[field].join(' | ') : '';
        const locked = Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes(field);
        const rawEvidence = Array.isArray(evidenceSource?.[field]) ? evidenceSource[field] : [];
        const binding = {
            npc: afterNpc,
            evidence: rawEvidence,
            targeted: options.allowTargetedDurableSeed === true || options.developmentSingleTarget === true,
            otherLabels,
        };
        const developmentReason = profileDevelopmentText(field, normalized.developmentReason, 500);
        const fieldReason = profileDevelopmentText(field, normalized[reasonField], 500);
        const evidenceReason = mechanics.durableProfileEvidenceReason(field, beforeNpc?.[field] || [], normalized?.[field] || [], rawEvidence);
        const effectiveReason = developmentReason || fieldReason || evidenceReason;
        const effectiveReasonSource = developmentReason ? 'provider' : (fieldReason ? 'field' : (evidenceReason ? 'evidence' : 'none'));
        const candidateChanged = !mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], normalized?.[field] || []);
        const candidateSpecificGrounding = candidateChanged
            && mechanics.durableProfileCollectionCandidateGrounded(field, beforeNpc?.[field] || [], normalized?.[field] || [], rawEvidence);
        const episode = mechanics.developmentEpisodeDiagnostic(effectiveReason, options.developmentContext, binding);
        const inferredBatch = normalized.developmentScale === 'gradual'
            && candidateChanged
            && candidateSpecificGrounding
            && Boolean(effectiveReason)
            && Boolean(String(options.developmentContext || '').trim())
            && mechanics.developmentScaleReady('batch', effectiveReason, options.developmentContext, binding);
        const changed = !mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], afterNpc?.[field] || []);
        const candidateAlreadyRepresented = Boolean(candidateValue)
            && mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], normalized?.[field] || []);
        const evidenceAlreadyRepresented = mechanics.durableProfileEvidenceAlreadyRepresented(
            field,
            afterNpc?.[field] || [],
            rawEvidence,
        );
        const recoveredKeepRefinement = field === 'behaviorProfile'
            && changed
            && (normalized[stateField] || 'keep') === 'keep';
        const outcome = locked ? 'locked'
            : (changed && inferredBatch ? 'applied-inferred-batch'
                : (recoveredKeepRefinement ? 'applied-recovered-refine'
                    : (changed ? `applied-${normalized[stateField] || 'update'}`
                    : (candidateAlreadyRepresented
                        ? (evidenceAlreadyRepresented ? 'evidence-already-reflected' : 'waiting-for-revised-candidate')
                        : 'unchanged-or-gated'))));
        const evidence = rawEvidence.slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => {
            const parsed = parseProfileDevelopmentEvidence(field, item);
            return {
                sourceMessageId: parsed?.sourceMessageId ?? null,
                concept: parsed?.explicitConcept || parsed?.concept || '',
                sample: parsed?.body || profileDevelopmentText(field, item, mechanics.DURABLE_PROFILE_LIMITS.evidence),
            };
        });
        report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
        report.profileDevelopment.push({
            npcId: String(afterNpc.id || ''),
            field,
            outcome,
            modelState: normalized[stateField] || 'keep',
            scale: normalized.developmentScale || 'gradual',
            effectiveScale: inferredBatch ? 'batch' : (normalized.developmentScale || 'gradual'),
            inferredScale: inferredBatch,
            locked,
            previous: profileDevelopmentText(field, previousValue, 720),
            candidate: profileDevelopmentText(field, candidateValue, 720),
            developmentReason,
            fieldReason,
            providerReasonPresent: Boolean(developmentReason),
            effectiveReason,
            effectiveReasonSource,
            candidateChanged,
            candidateAlreadyRepresented,
            evidenceAlreadyRepresented,
            evidenceResolved: rawEvidence.length ? evidenceAlreadyRepresented : false,
            candidateGrounded: candidateChanged ? candidateSpecificGrounding : null,
            reasonGrounded: effectiveReason ? episode.grounded : null,
            episode,
            evidence,
        });
        if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
    }
}

export function recordBirthdayDiagnostic(report, beforeNpc, afterNpc, ordinaryUpdate, options, calendar, referenceDate) {
    if (!report || !beforeNpc || !afterNpc || !referenceDate) return;
    const birthdayMatched = sameCalendarBirthday(afterNpc.birthDate, referenceDate, calendar);
    const incomingBirthday = ordinaryUpdate?.birthDate ?? ordinaryUpdate?.birth_date ?? ordinaryUpdate?.birthday;
    const birthDateState = String(ordinaryUpdate?.birthDateState ?? ordinaryUpdate?.birth_date_state ?? '').trim().toLowerCase();
    const establishedNow = Boolean(incomingBirthday)
        && ['establish', 'set', 'update', 'refine', 'correct', 'correction'].includes(birthDateState);
    const narratedBirthday = birthdayEvidenceInText(birthdayPromptSource(options));
    const manualFields = Array.isArray(afterNpc.manualProfileFields) ? afterNpc.manualProfileFields : [];
    const previousAge = String(beforeNpc.age ?? '').trim();
    const age = String(afterNpc.age ?? '').trim();
    const previousApparentAge = String(beforeNpc.apparentAge ?? '').trim();
    const apparentAge = String(afterNpc.apparentAge ?? '').trim();
    const oldExact = exactStoredAge(previousAge);
    const newExact = exactStoredAge(age);
    const delta = oldExact !== null && newExact !== null ? newExact - oldExact : 0;
    const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
    const birthdaySupplied = Boolean(incomingBirthday);
    if (!birthdayMatched && !birthdaySupplied && !['advance', 'correct', 'correction'].includes(ageState) && delta === 0) return;

    let reason = 'no-rollover';
    if (manualFields.includes('age')) reason = 'manual-age-lock';
    else if (delta > 0) reason = 'calendar-rollover';
    else if (establishedNow && birthdayMatched) reason = 'first-establishment-guard';
    else if (birthdayMatched && narratedBirthday) reason = 'birthday-held';
    else if (ageState === 'correct' || ageState === 'correction') reason = 'age-correction-held';
    else if (ageState === 'advance') reason = 'age-advance-held';

    report.birthdayDiagnostics = Array.isArray(report.birthdayDiagnostics) ? report.birthdayDiagnostics : [];
    report.birthdayDiagnostics.push({
        npcId: String(afterNpc.id || ''),
        outcome: delta > 0 ? 'advance' : 'hold',
        reason,
        birthdayMatched,
        establishedNow,
        birthdaySupplied,
        birthDateState,
        narratedBirthday,
        ageState,
        ageLocked: manualFields.includes('age'),
        apparentAgeLocked: manualFields.includes('apparentAge'),
        previousAge,
        age,
        previousApparentAge,
        apparentAge,
        delta,
        previousBirthDate: normalizeCalendarDate(beforeNpc.birthDate, calendar),
        birthDate: normalizeCalendarDate(afterNpc.birthDate, calendar),
        birthDateYearSource: String(afterNpc.birthDateYearSource || ''),
        calendarAge: Number.isInteger(afterNpc.calendarAge) ? afterNpc.calendarAge : null,
        referenceDate: normalizeCalendarDate(referenceDate, calendar),
    });
    if (report.birthdayDiagnostics.length > 32) report.birthdayDiagnostics.splice(0, report.birthdayDiagnostics.length - 32);
}
