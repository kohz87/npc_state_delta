/* NPC State Delta bounded diagnostic telemetry.
 * Records deterministic application decisions only. It never owns story/canonical state and
 * deliberately allowlists fields so prompts, full narration, credentials and provider payloads
 * cannot leak into the diagnostic bundle by accident.
 */
export const DIAGNOSTIC_BUNDLE_VERSION = 2;
export const DEFAULT_DIAGNOSTIC_OPERATION_LIMIT = 40;

function clean(value, max = 320) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function finiteInt(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}
function fnv1a(value) {
    let hash = 2166136261;
    for (const ch of String(value ?? '')) {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
function uniqueStrings(values = [], limit = 32, max = 120) {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const text = clean(value, max);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= limit) break;
    }
    return out;
}
function sanitizeEpisode(raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        detected: Boolean(raw.detected),
        grounded: Boolean(raw.grounded),
        npcBound: raw.npcBound === null || raw.npcBound === undefined ? null : Boolean(raw.npcBound),
        anchorIndex: finiteInt(raw.anchorIndex),
        segmentCount: Math.max(0, finiteInt(raw.segmentCount, 0)),
    };
}
function sanitizeCalendarDate(raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    const year = raw.year === null || raw.year === undefined || raw.year === '' ? null : finiteInt(raw.year);
    return {
        era: clean(raw.era, 24),
        year,
        month: clean(raw.month, 40),
        day: finiteInt(raw.day),
    };
}
function sanitizeEvidence(raw = []) {
    return (Array.isArray(raw) ? raw : []).slice(0, 8).map(item => ({
        sourceMessageId: finiteInt(item?.sourceMessageId),
        concept: clean(item?.concept, 80),
        sample: clean(item?.sample, 320),
    })).filter(item => item.sourceMessageId !== null || item.concept || item.sample);
}
export function sanitizeProfileDiagnostic(raw = {}) {
    return {
        npcId: clean(raw.npcId, 160),
        field: clean(raw.field, 48),
        outcome: clean(raw.outcome, 80),
        modelState: clean(raw.modelState, 32),
        providerScale: clean(raw.scale ?? raw.providerScale, 32),
        effectiveScale: clean(raw.effectiveScale, 32),
        inferredScale: Boolean(raw.inferredScale),
        inferredEffectiveScale: clean(raw.inferredEffectiveScale, 32),
        ready: Boolean(raw.ready),
        aggregateReady: Boolean(raw.aggregateReady),
        aggregateFallback: Boolean(raw.aggregateFallback),
        observations: Math.max(0, finiteInt(raw.observations, 0)),
        aggregateObservations: Math.max(0, finiteInt(raw.aggregateObservations, 0)),
        locked: Boolean(raw.locked),
        candidateChanged: raw.candidateChanged === undefined ? null : Boolean(raw.candidateChanged),
        candidateAlreadyRepresented: Boolean(raw.candidateAlreadyRepresented),
        evidenceResolved: Boolean(raw.evidenceResolved),
        candidateGrounded: raw.candidateGrounded === undefined ? null : Boolean(raw.candidateGrounded),
        reasonGrounded: raw.reasonGrounded === undefined ? null : Boolean(raw.reasonGrounded),
        providerReasonPresent: Boolean(raw.providerReasonPresent),
        effectiveReasonSource: clean(raw.effectiveReasonSource, 24),
        effectiveReason: clean(raw.effectiveReason, 500),
        previous: clean(raw.previous, 720),
        candidate: clean(raw.candidate, 720),
        developmentReason: clean(raw.developmentReason, 500),
        fieldReason: clean(raw.fieldReason, 500),
        episode: sanitizeEpisode(raw.episode),
        evidence: sanitizeEvidence(raw.evidence),
    };
}
export function sanitizeBirthdayDiagnostic(raw = {}) {
    return {
        npcId: clean(raw.npcId, 160),
        outcome: clean(raw.outcome, 40),
        reason: clean(raw.reason, 120),
        birthdayMatched: Boolean(raw.birthdayMatched),
        establishedNow: Boolean(raw.establishedNow),
        birthdaySupplied: Boolean(raw.birthdaySupplied),
        birthDateState: clean(raw.birthDateState, 24),
        narratedBirthday: Boolean(raw.narratedBirthday),
        ageState: clean(raw.ageState, 24),
        ageLocked: Boolean(raw.ageLocked),
        apparentAgeLocked: Boolean(raw.apparentAgeLocked),
        previousAge: clean(raw.previousAge, 12),
        age: clean(raw.age, 12),
        previousApparentAge: clean(raw.previousApparentAge, 16),
        apparentAge: clean(raw.apparentAge, 16),
        delta: finiteInt(raw.delta, 0),
        previousBirthDate: sanitizeCalendarDate(raw.previousBirthDate),
        birthDate: sanitizeCalendarDate(raw.birthDate),
        birthDateYearSource: clean(raw.birthDateYearSource, 32),
        calendarAge: finiteInt(raw.calendarAge),
        referenceDate: sanitizeCalendarDate(raw.referenceDate),
    };
}
export function sanitizeDiagnosticOperation(raw = {}) {
    const profile = (Array.isArray(raw.profile) ? raw.profile : Array.isArray(raw.profileDevelopment) ? raw.profileDevelopment : [])
        .map(sanitizeProfileDiagnostic).filter(row => row.npcId && row.field).slice(-64);
    const birthdays = (Array.isArray(raw.birthdays) ? raw.birthdays : Array.isArray(raw.birthdayDiagnostics) ? raw.birthdayDiagnostics : [])
        .map(sanitizeBirthdayDiagnostic).filter(row => row.npcId).slice(-32);
    const npcIds = uniqueStrings([
        ...(Array.isArray(raw.npcIds) ? raw.npcIds : []),
        ...profile.map(row => row.npcId),
        ...birthdays.map(row => row.npcId),
    ], 64, 160);
    return {
        id: clean(raw.id, 120),
        type: clean(raw.type ?? raw.label, 80) || 'scan',
        at: Math.max(0, finiteInt(raw.at, Date.now())),
        durationMs: Math.max(0, finiteInt(raw.durationMs, 0)),
        sourceMessageId: finiteInt(raw.sourceMessageId),
        retried: Boolean(raw.retried),
        targeted: Boolean(raw.targeted),
        npcIds,
        accounting: {
            profileUpdates: Math.max(0, finiteInt(raw.profileUpdates, 0)),
            profileApplied: Math.max(0, finiteInt(raw.profileApplied, 0)),
            profileEvidenceAdded: Math.max(0, finiteInt(raw.profileEvidenceAdded, 0)),
            relationshipApplied: Math.max(0, finiteInt(raw.relationshipApplied, 0)),
            promptEstimateTokens: Math.max(0, finiteInt(raw.promptEstimateTokens, 0)),
            responseEstimateTokens: Math.max(0, finiteInt(raw.responseEstimateTokens, 0)),
        },
        profile,
        birthdays,
    };
}

export function createDiagnosticStore({ limit = DEFAULT_DIAGNOSTIC_OPERATION_LIMIT, now = () => Date.now() } = {}) {
    const max = Math.max(8, Math.min(128, finiteInt(limit, DEFAULT_DIAGNOSTIC_OPERATION_LIMIT)));
    const byChat = new Map();
    let sequence = 0;
    function list(chatKey) {
        const key = clean(chatKey, 500);
        if (!byChat.has(key)) byChat.set(key, []);
        return byChat.get(key);
    }
    function record(chatKey, raw = {}) {
        const key = clean(chatKey, 500);
        if (!key || key === 'no-chat') return null;
        const normalized = sanitizeDiagnosticOperation({ ...raw, at: raw.at ?? now() });
        sequence += 1;
        normalized.id = normalized.id || `${normalized.at.toString(36)}-${sequence.toString(36)}`;
        const rows = list(key);
        rows.push(normalized);
        if (rows.length > max) rows.splice(0, rows.length - max);
        return structuredClone(normalized);
    }
    function records(chatKey, { npcId = '', limit: requested = max } = {}) {
        const id = clean(npcId, 160);
        const count = Math.max(1, Math.min(max, finiteInt(requested, max)));
        const rows = list(chatKey).filter(row => !id || row.npcIds.includes(id));
        return structuredClone(rows.slice(-count));
    }
    function clear(chatKey) {
        const key = clean(chatKey, 500);
        const count = byChat.get(key)?.length || 0;
        byChat.delete(key);
        return count;
    }
    function summary(chatKey) {
        const rows = list(chatKey);
        const profileRows = rows.reduce((sum, row) => sum + row.profile.length, 0);
        const birthdayRows = rows.reduce((sum, row) => sum + row.birthdays.length, 0);
        const npcIds = uniqueStrings(rows.flatMap(row => row.npcIds), 128, 160);
        return { operationCount: rows.length, profileRows, birthdayRows, npcCount: npcIds.length, limit: max, latest: rows.at(-1)?.id || null };
    }
    function bundle(chatKey, { applicationVersion = '' } = {}) {
        const key = clean(chatKey, 500);
        return {
            diagnosticVersion: DIAGNOSTIC_BUNDLE_VERSION,
            deltaApplicationVersion: clean(applicationVersion, 32),
            exportedAt: now(),
            chatIdentityHash: fnv1a(key),
            retentionLimit: max,
            privacy: 'Compact allowlisted deterministic diagnostics only; no full story, prompts, credentials, or provider payloads.',
            operations: records(key),
        };
    }
    return Object.freeze({ record, records, clear, summary, bundle });
}
