export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
import * as continuity from './continuity-core.js';
import * as mechanics from './core-mechanics.js';
import {
    applyNpcBirthdayUpdate,
    birthdayEvidenceInText,
    BIRTHDAY_PROMPT_RULE,
    mergeNpcBirthdayKnowledge,
    normalizeNpcBirthday,
    normalizeScanBirthday,
} from './birthday.js';
export {
    birthDatePrecision,
    deriveBirthDateFromAge,
    deterministicBirthday,
    normalizeBirthDate,
    normalizeBirthDateState,
} from './birthday.js';

function sameNpc(raw = {}, npc = {}) {
    if (raw?.id && String(raw.id) === String(npc?.id)) return true;
    if (raw?.name && mechanics.npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw?.aliases) && raw.aliases.some(alias => mechanics.npcMatchesLabel(npc, alias));
}

function matchingPrevious(npc, source = []) {
    return (Array.isArray(source) ? source : []).filter(item => item && (
        String(item.id || '') === String(npc?.id || '')
        || (npc?.name && mechanics.npcMatchesLabel(item, npc.name))
        || (item?.name && mechanics.npcMatchesLabel(npc, item.name))
        || (item?.aliases || []).some(alias => mechanics.npcMatchesLabel(npc, alias))
    ));
}

function birthdayPromptSource(options = {}) {
    return String(options?.transcript || options?.dossierText || '');
}

function appendBirthdayRule(prompt, options = {}) {
    return birthdayEvidenceInText(birthdayPromptSource(options))
        ? `${String(prompt)}${BIRTHDAY_PROMPT_RULE}`
        : String(prompt);
}

export function normalizeNpcRecord(raw = {}) {
    return normalizeNpcBirthday(continuity.normalizeNpcRecord(raw));
}

export function normalizeScanNpc(raw = {}, options = {}) {
    return { ...continuity.normalizeScanNpc(raw, options), ...normalizeScanBirthday(raw) };
}

export function setNpcArchived(npc, archived, options = {}) {
    return normalizeNpcBirthday(continuity.setNpcArchived(npc, archived, options));
}

export function applyNpcStateCommand(state, command, options = {}) {
    const result = continuity.applyNpcStateCommand(state, command, options);
    result.state.npcs = (result.state.npcs || []).map(normalizeNpcBirthday);
    return result;
}

export function mergeScanResult(state, scanResult, options = {}) {
    const previous = (state?.npcs || []).map(normalizeNpcRecord);
    const result = continuity.mergeScanResult(state, scanResult, options);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = matchingPrevious(rawNpc, previous);
        const ordinaryUpdate = ordinary.find(raw => sameNpc(raw, rawNpc));
        let npc = normalizeNpcBirthday(rawNpc);
        if (ordinaryUpdate) npc = applyNpcBirthdayUpdate(npc, ordinaryUpdate, options);
        if (sources.length) npc = mergeNpcBirthdayKnowledge(sources, npc);
        return npc;
    });
    return result;
}

export function buildNpcPortraitPrompts(rawNpc = {}, options = {}) {
    return continuity.buildNpcPortraitPrompts(rawNpc, options);
}

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = mechanics.DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = 1800, socialGraph = null) {
    return continuity.buildInjection(npcs, text, turn, limit, behaviorCriteria, budgetTokens, socialGraph);
}

export function buildScannerPrompt(options = {}) { return appendBirthdayRule(continuity.buildScannerPrompt(options), options); }
export function buildBackfillPrompt(options = {}) { return appendBirthdayRule(continuity.buildBackfillPrompt(options), options); }
export function buildDossierImportPrompt(options = {}) { return appendBirthdayRule(continuity.buildDossierImportPrompt(options), options); }
export function buildProfileRefreshPrompt(options = {}) { return appendBirthdayRule(continuity.buildProfileRefreshPrompt(options), options); }

// NPC State Delta application version. Persisted bundle, branch, and data schemas are versioned independently.
export const NPC_STATE_VERSION = '0.1.0';
