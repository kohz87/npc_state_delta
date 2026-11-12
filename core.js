export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
export * from './calendar.js';
import * as continuity from './continuity-core.js';
import * as mechanics from './core-mechanics.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { lockAwayNpcs } from './src/key-people.js';
import { removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';
import {
    calendarDayNumber,
    calendarPromptContext,
    extractStructuredWorldDate,
    getActiveCalendarConfig,
    normalizeCalendarDate,
    withStoryDateMemo,
} from './calendar.js';
import {
    applyNpcBirthdayUpdate,
    birthdayCaptureRule,
    birthdayEvidenceInText,
    birthdayPromptRule,
    mergeNpcBirthdayKnowledge,
    normalizeNpcBirthday,
    normalizeScanBirthday,
    reanchorDerivedBirthYearFromAge,
} from './birthday.js';

export {
    BIRTHDAY_PROMPT_RULE,
    birthDatePrecision,
    deriveBirthDateFromAge,
    deterministicBirthday,
    formatBirthDate,
    normalizeBirthDate,
    normalizeBirthDateState,
} from './birthday.js';
import { birthdayUpdateGrounded, withAppearanceDerivedApparentAge, birthdayUpdateRow, normalizeFieldChanges, normalizeFieldChangeDays, normalizeFieldChangeMessages, stampFieldChanges, birthdayPromptSource, calendarReference, applyDeterministicBirthdayRollover, calendarNpcProjection } from './core-birthday.js';
import { PROFILE_DEVELOPMENT_FIELDS, profileDevelopmentForNpc, durableUpdateForNpc, appearanceUpdateForNpc, prepareProfileDevelopmentState, recordAppearanceDiagnostic, recordSecondaryProfileDiagnostics, recordBirthdayDiagnostic } from './core-profile-development.js';
import { finalizeProfileDevelopment } from './core-profile-finalize.js';
export { npcOwnedSentences, npcCurrentlyAbsentInText, normalizeFieldChanges, normalizeFieldChangeDays, normalizeFieldChangeMessages, stampChangedFields } from './core-birthday.js';

// Story day of a dated World State block in the text, or null when none is dated.
export function storyDayFromText(text, calendar = getActiveCalendarConfig()) {
    const extracted = extractStructuredWorldDate(text, calendar);
    return extracted ? calendarDayNumber(extracted.date, calendar) : null;
}

function calendarPromptOptions(options = {}) {
    const next = { ...options };
    // (b5b r2-8) Names on one short line: a line break in a persona name cannot start a line of
    // the prompt (the one-pass rules go in-prompt). Ordinary names are unchanged.
    if (typeof options.userName === 'string') next.userName = mechanics.flatPromptName(options.userName, 'User');
    if (typeof options.charName === 'string') next.charName = mechanics.flatPromptName(options.charName, 'Character');
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    if (Array.isArray(options.existingNpcs)) next.existingNpcs = options.existingNpcs.map(npc => calendarNpcProjection(npc, referenceDate, reference.fallback));
    if (options.existingNpc) next.existingNpc = calendarNpcProjection(options.existingNpc, referenceDate, reference.fallback);
    if (options.targetNpc) next.targetNpc = calendarNpcProjection(options.targetNpc, referenceDate, reference.fallback);
    return next;
}

function appendBirthdayRule(prompt, options = {}) {
    if (!birthdayEvidenceInText(birthdayPromptSource(options))) return String(prompt);
    const calendar = getActiveCalendarConfig();
    const referenceDate = calendarReference(options, calendar).date;
    return `${String(prompt)}${birthdayPromptRule(calendar, referenceDate)}`;
}

// (cleanup step 12, I-10) The one-pass rules always carry a short birthday rule (the reply can bring
// a birthday the text before it does not show), in the rules part, which holds nothing that changes
// from reply to reply; the current world date, which does, goes at the end with the context.
function withCaptureBirthdayRule(prompt, options = {}) {
    const calendar = getActiveCalendarConfig();
    const source = String(prompt);
    const marker = 'Identity index (matching only):';
    const at = source.indexOf(marker);
    const rule = birthdayCaptureRule(calendar);
    const ruled = at > 0 ? `${source.slice(0, at).replace(/\n$/, '')}${rule}\n${source.slice(at)}` : `${source}${rule}`;
    const date = calendarPromptContext(calendar, calendarReference(options, calendar).date);
    return date ? `${ruled}\n${date}` : ruled;
}

function insertRefreshBirthdayRule(prompt, options = {}) {
    if (!birthdayEvidenceInText(birthdayPromptSource(options))) return String(prompt);
    const calendar = getActiveCalendarConfig();
    const referenceDate = calendarReference(options, calendar).date;
    const rule = birthdayPromptRule(calendar, referenceDate);
    const source = String(prompt);
    const anchor = 'Recent story window (EVIDENCE ONLY;';
    const index = source.indexOf(anchor);
    return index >= 0 ? `${source.slice(0, index)}${rule}\n${source.slice(index)}` : `${source}${rule}`;
}

export function applyStaleNpcLifecycle(state = {}, options = {}) {
    const beforeNpcs = new Map((Array.isArray(state?.npcs) ? state.npcs : [])
        .filter(npc => npc?.id)
        .map(npc => [String(npc.id), structuredClone(npc)]));
    const result = mechanics.applyStaleNpcLifecycle(state, options);
    const removed = Array.isArray(result?.removed) ? result.removed : [];
    if (!removed.length) return result;

    // Complete stale-removal cleanup at the public mechanics facade while preserving
    // portrait bytes until branch/history pruning proves the NPC is no longer rollback-reachable.
    const next = result.state;
    for (const item of removed) {
        const id = String(item?.id || '');
        if (!id) continue;
        next.socialGraph = removeNpcFromSocialGraph(next.socialGraph, id);
        const removedNpc = beforeNpcs.get(id);
        if (removedNpc) purgeNpcStructuredReferences(next.npcs, removedNpc);
    }
    if (state?.portraitAssets && typeof state.portraitAssets === 'object') {
        next.portraitAssets = { ...structuredClone(state.portraitAssets), ...(next.portraitAssets || {}) };
    }
    return result;
}

export function normalizeNpcRecord(raw = {}) {
    const npc = withAppearanceDerivedApparentAge(normalizeNpcBirthday(continuity.normalizeNpcRecord(raw)), raw.appearance);
    npc.fieldChanges = normalizeFieldChanges(raw.fieldChanges);
    const fieldChangeDays = normalizeFieldChangeDays(raw.fieldChangeDays);
    if (Object.keys(fieldChangeDays).length) npc.fieldChangeDays = fieldChangeDays;
    else delete npc.fieldChangeDays;
    const fieldChangeMessages = normalizeFieldChangeMessages(raw.fieldChangeMessages);
    if (Object.keys(fieldChangeMessages).length) npc.fieldChangeMessages = fieldChangeMessages;
    else delete npc.fieldChangeMessages;
    for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
        const config = PROFILE_DEVELOPMENT_FIELDS[field];
        const development = profileDevelopmentForNpc(field, npc);
        if (development) npc[config.ledgerKey] = development;
    }
    return npc;
}

// The stored calendarAge is derived and fixed at scan time (null when the hosted clock gave no date then). A live read calls this so it
// matches what a reload derives with the clock as it is now: only calendarAge changes, in place, and only when it differs.
export function refreshCalendarAges(npcs) {
    if (!Array.isArray(npcs) || !npcs.length) return npcs;
    withStoryDateMemo(() => {
        for (const npc of npcs) {
            if (!npc || typeof npc !== 'object') continue;
            const age = normalizeNpcBirthday(npc).calendarAge;
            if (age !== npc.calendarAge && (age !== undefined || npc.calendarAge !== undefined)) npc.calendarAge = age;
        }
    });
    return npcs;
}

export function normalizeScanNpc(raw = {}, options = {}) {
    return withAppearanceDerivedApparentAge({ ...continuity.normalizeScanNpc(raw, options), ...normalizeScanBirthday(raw) }, raw.appearance);
}

export function setNpcArchived(npc, archived, options = {}) {
    return normalizeNpcBirthday(continuity.setNpcArchived(npc, archived, options));
}

export function applyNpcStateCommand(state, command, options = {}) {
    const result = continuity.applyNpcStateCommand(state, command, options);
    result.state.npcs = withStoryDateMemo(() => (result.state.npcs || []).map(npc => normalizeNpcBirthday(npc)));
    return result;
}

// A scan's merge. `awayNpcIds` (the dossiers of key people who are away, from Story Director): their stable
// profile fields and custom fields are held as if locked for this merge only (src/key-people.js); nothing of
// the hold is stored, and without it the merge is exactly as before.
export function mergeScanResult(state, scanResult, rawOptions = {}) {
    return withStoryDateMemo(() => mergeScanResultInPass(state, scanResult, rawOptions));
}

function mergeScanResultInPass(state, scanResult, rawOptions = {}) {
    const hold = lockAwayNpcs(state, rawOptions.awayNpcIds);
    if (!hold) return mergeScanResultHeld(state, scanResult, rawOptions);
    const result = mergeScanResultHeld(hold.state, scanResult, rawOptions);
    result.state.npcs = hold.restore(result.state.npcs);
    return result;
}

function mergeScanResultHeld(state, scanResult, rawOptions = {}) {
    // Story day of the scanned message (its dated World State), unless the caller already resolved
    // it (carrying the last dated message forward). Undated chats leave it null and use turns.
    const supplied = rawOptions.storyDay;
    const suppliedDay = supplied === null || supplied === undefined || supplied === '' ? NaN : Number(supplied);
    const options = { ...rawOptions, storyDay: Number.isInteger(suppliedDay) ? suppliedDay : storyDayFromText(rawOptions.calendarSource) };
    const profilePrepared = prepareProfileDevelopmentState(state, scanResult, options);
    const sourceState = profilePrepared.state;
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    const previousRaw = Array.isArray(sourceState?.npcs) ? sourceState.npcs : [];
    const previous = previousRaw.map(raw => normalizeNpcBirthday(continuity.normalizeNpcRecord(raw), calendar, referenceDate));
    const profileUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const continuityOptions = { ...options, developmentSingleTarget: profileUpdates.length === 1 };
    const result = continuity.mergeScanResult(sourceState, scanResult, continuityOptions);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const diagnosticNpcRegistry = (result.state.npcs || []).map(npc => structuredClone(npc));

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = mechanics.matchingNpcRecords(rawNpc, previous);
        const rawSources = mechanics.matchingNpcRecords(rawNpc, previousRaw);
        const ordinaryUpdate = birthdayUpdateRow(
            ordinary.find(raw => mechanics.scanRowMatchesNpc(raw, rawNpc)),
            profileUpdates.find(raw => mechanics.scanRowMatchesNpc(raw, rawNpc)),
        );
        let npc = normalizeNpcBirthday(rawNpc, calendar, referenceDate);
        if (ordinaryUpdate && birthdayUpdateGrounded(npc, ordinaryUpdate, options.developmentContext, calendar, referenceDate)) {
            npc = applyNpcBirthdayUpdate(npc, ordinaryUpdate, { ...options, calendarConfig: calendar, referenceDate });
        }
        const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
        if ((ageState === 'advance' || ageState === 'correct') && npc.birthDateYearSource === 'derived'
            && sources.some(source => String(source.age) !== String(npc.age))) {
            npc = reanchorDerivedBirthYearFromAge(npc, calendar, referenceDate);
        }
        if (sources.length) npc = mergeNpcBirthdayKnowledge(sources, npc, calendar, referenceDate);

        // A grounded full current date turns a full birth date into deterministic chronology.
        // Chronological age is local arithmetic; the birthday rollover below may carry an already-numeric
        // apparent-age estimate by the same proven delta without using it to derive chronology.
        if (!(npc.manualProfileFields || []).includes('age') && !isTerminalNpcDeath(npc)
            && referenceDate && Number.isInteger(npc.calendarAge) && normalizeCalendarDate(npc.birthDate, calendar)?.year !== null
            && !(reference.fallback && /^\d+$/.test(String(npc.age)) && npc.calendarAge < Number(npc.age))) {
            npc.age = String(npc.calendarAge);
        }
        const beforeDiagnosticNpc = rawSources[0] ? normalizeNpcBirthday(continuity.normalizeNpcRecord(rawSources[0]), calendar, referenceDate) : null;
        npc = applyDeterministicBirthdayRollover(
            npc,
            rawSources[0] || null,
            ordinaryUpdate,
            options,
            calendar,
            referenceDate,
        );
        const appearanceUpdate = appearanceUpdateForNpc(scanResult, npc);
        if (beforeDiagnosticNpc) {
            // Appearance is resolved by continuity before Personality/Speech finalization. Record
            // it first so adding observability does not change legacy development-row ordering.
            recordAppearanceDiagnostic(result.report, beforeDiagnosticNpc, npc, appearanceUpdate, continuityOptions, diagnosticNpcRegistry);
        }
        npc = finalizeProfileDevelopment(npc, profilePrepared.plans.get(String(npc.id || '')), continuityOptions, result.report);
        const durableUpdate = durableUpdateForNpc(scanResult, npc);
        if (beforeDiagnosticNpc) {
            recordSecondaryProfileDiagnostics(result.report, beforeDiagnosticNpc, npc, durableUpdate, continuityOptions, diagnosticNpcRegistry);
            recordBirthdayDiagnostic(result.report, beforeDiagnosticNpc, npc, ordinaryUpdate, options, calendar, referenceDate);
        }
        const finalNpc = withAppearanceDerivedApparentAge(npc, ordinaryUpdate?.appearance || rawNpc.appearance);
        const changeBase = rawSources[0] ? normalizeNpcRecord(rawSources[0]) : null;
        return stampFieldChanges(changeBase, finalNpc, Math.trunc(Number(result.state?.turn ?? sourceState?.turn)), options.storyDay,
            Number.isInteger(options.sourceMessageId) ? options.sourceMessageId : null);
    });
    if (reference.extracted) {
        result.report = {
            ...(result.report || {}),
            calendarReference: {
                source: 'world-state',
                raw: reference.extracted.raw,
                date: structuredClone(reference.extracted.date),
            },
        };
    }
    return result;
}

export function buildNpcPortraitPrompts(rawNpc = {}, options = {}) {
    return continuity.buildNpcPortraitPrompts(calendarNpcProjection(rawNpc), options);
}

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = mechanics.DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = mechanics.DEFAULT_INJECTION_BUDGET_TOKENS, socialGraph = null, options = {}) {
    const projected = (Array.isArray(npcs) ? npcs : []).map(npc => calendarNpcProjection(npc));
    return continuity.buildInjection(projected, text, turn, limit, behaviorCriteria, budgetTokens, socialGraph, options);
}

// User-defined custom fields (settings) add one rule and the current values of the NPCs in play.
// With no fields configured the prompt is unchanged.
// Owner-approved exception (core contract C10): only when the configured names include Level, one
// sentence lets that field be filled from a named rank or a direct comparison of strength. Other
// fields and prompts without Level are byte-identical. The cited line is prompt-only; the merge
// (core-record-custom-fields.js) asks only that an estimate not found in the text carries a reason.
export const LEVEL_FIELD_RULE = ' Level is the one exception: fill it when a line names that person\'s level or rank (a hedged "probably rank C or D" is written "C-D"), or directly compares their strength with the player character\'s ("far beyond anything I can sense"); then estimate from the story\'s rank scale if the prompt has one, else a number. Never from dramatic description without a comparison (an aura, a fearsome name, size, weapons), from a role alone, or from a character\'s own guess or boast in dialogue; narration and the player\'s declarative notes count, not quotes, questions or wishes. In customFieldsReason write Level: then the exact words of the line relied on, in quotes.';
function appendCustomFieldRule(prompt, options = {}) {
    const names = mechanics.normalizeCustomFieldNames(options.customFieldNames);
    if (!names.length) return prompt;
    const roster = Array.isArray(options.existingNpcs) ? options.existingNpcs : [];
    const targets = options.targetNpc ? [options.targetNpc]
        : (options.existingNpc ? [options.existingNpc]
            : roster.filter(npc => npc?.present || mechanics.npcNamedInText(npc, options.transcript || '', roster)));
    const known = Object.fromEntries(targets.slice(0, 12)
        .map(npc => [npc?.id, mechanics.customFieldValues(npc, names)])
        .filter(([id, values]) => id && Object.keys(values).length));
    const example = Object.fromEntries(names.slice(0, 2).map(name => [name, 'value']));
    return `${prompt}

CUSTOM FIELDS (${names.join(', ')}): in an NPC row, "customFields":${JSON.stringify(example)} only when ${options.customFieldSource || 'the story or World State'} states that NPC's value explicitly. Keep-by-default: omit unchanged or unknown values; a changed established value needs "customFieldsReason". Never guess.${names.some(name => name.toLowerCase() === 'level') ? LEVEL_FIELD_RULE : ''}${Object.keys(known).length ? `\nEstablished custom fields: ${JSON.stringify(known)}` : ''}`;
}

export function buildScannerPrompt(options = {}) {
    const prompt = continuity.buildScannerPrompt(calendarPromptOptions(options));
    if (options.narrationCapture) return appendCustomFieldRule(withCaptureBirthdayRule(prompt, options), options);
    return appendCustomFieldRule(appendBirthdayRule(prompt, options), options);
}
// The one-pass capture instruction rides in the roleplay injection: the same scanner rules and
// dossier context without a transcript (the roleplay model already sees the chat), plus a reminder.
export function buildNarrationCapturePrompt(options = {}) {
    return `${buildScannerPrompt({ ...options, fullScanMode: false, narrationCapture: true })}\n\n${mechanics.NARRATION_CAPTURE_REMINDER}`;
}
// (1.2.16) The same instruction in two parts for a cache-friendly prompt: the rules, which do not
// change from reply to reply, go early (byte-identical every armed reply, so providers can cache
// them with the rest of the prompt's head); the dossier context and the reminder, which change,
// go last. Split where the dossier context starts; nothing is added to or dropped from the text.
export const NARRATION_CAPTURE_CONTEXT_MARKER = 'Identity index (matching only):';
export const NARRATION_CAPTURE_TAIL_LEAD = 'NPC STATE DELTA ONE-PASS CAPTURE — context for the hidden block described in the system instructions:';
export function buildNarrationCaptureParts(options = {}) {
    const full = buildNarrationCapturePrompt(options);
    const at = full.indexOf(NARRATION_CAPTURE_CONTEXT_MARKER);
    if (at < 0) return { rules: '', context: full };
    return { rules: full.slice(0, at).trimEnd(), context: `${NARRATION_CAPTURE_TAIL_LEAD}\n${full.slice(at)}` };
}
export function buildBackfillPrompt(options = {}) {
    return mechanics.appendHiddenNotePrompt(appendCustomFieldRule(appendBirthdayRule(continuity.buildBackfillPrompt(calendarPromptOptions(options)), options), options), options);
}
export function buildDossierImportPrompt(options = {}) {
    return appendCustomFieldRule(appendBirthdayRule(continuity.buildDossierImportPrompt(calendarPromptOptions(options)), options), { ...options, customFieldSource: 'the dossier text' });
}
export function buildProfileRefreshPrompt(options = {}) {
    return mechanics.appendHiddenNotePrompt(appendCustomFieldRule(insertRefreshBirthdayRule(continuity.buildProfileRefreshPrompt(calendarPromptOptions(options)), options), options), options);
}

// NPC State Delta application version. Persisted bundle, branch, and data schemas are versioned independently.
export const NPC_STATE_VERSION = '1.16.1';
