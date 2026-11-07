/* Personality/Speech development readiness and per-scan preparation: spread rules, aggregate provenance,
   the matching durable row, and the planned ledger updates for each NPC. A pure part of
   core-profile-development.js (same owner, moved without change); the root file keeps the public
   facade and re-exports every public name it exported before. Never imports core-profile-development.js. */
import * as mechanics from './core-mechanics.js';
import { PROFILE_DEVELOPMENT_FIELDS, PROFILE_DEVELOPMENT_READY_COUNT, PROFILE_DEVELOPMENT_MIN_SPAN, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT, PERSONALITY_SPREAD_READY_COUNT, DEVELOPMENT_SPREAD_MIN_DAYS, PERSONALITY_SPREAD_MIN_MESSAGES, PERSONALITY_SPREAD_MIN_TURNS, profileDevelopmentText, profileDevelopmentEvidence, profileDevelopmentSourceMessageId, profileDevelopmentTurn, parseProfileDevelopmentEvidence, emptyProfileDevelopment, profileDevelopmentForNpc } from './core-profile-development-ledger.js';
import { developmentRecordMatches, observeProfileDevelopment } from './core-profile-development-observation.js';

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
