/* NPC State Delta - standalone SillyTavern extension */
import { getContext } from '../../../extensions.js';
import { extension_prompt_types, extension_prompt_roles, getRequestHeaders, saveSettings as saveHostSettings } from '../../../../script.js';
import {
    isEmptyScannerAnswer,
    isScannerRoutingError,
    scannerRoutingError,
    scannerRoutingMetrics,
    scannerDiagnosticLines,
} from './scanner-routing.js';
import {
    AUTOMATIC_BACKFILL_QUEUE_VERSION,
    AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
    autoScanDue as autoScanDueAfterReply,
    automaticBackfillStillRelevant,
    backfillNeedsRequest,
    normalizeAutomaticBackfillRequest,
    npcParticipatesInExchange,
    readAheadOf,
    replyMayChangeDossiers,
    replyScanned,
    settleScan,
} from './scan-context.js';
import { createDiagnosticStore } from './diagnostics-core.js';
import { REFRESH_CHANGED_FIELDS } from './src/fields/registry.js';
import {
    cleanMessage,
    recentTranscript,
    recentUserDevelopmentContext,
    currentExchangeUserDevelopmentContext,
    currentExchangeTranscript,
    skippedExchangesWindow,
    recentReplyIds,
    activeReplyIds,
    currentExchangeProse,
    currentExchangeBodies,
    storyDayAt,
    storyDaysForTranscript,
    currentExclusions,
    useTranscriptSource,
    refreshMessageGate,
    messageGateSettled,
    activeChat,
    useMessageGate,
} from './src/transcript.js';
import {
    BACKFILL_RESPONSE_LENGTH,
    FULL_SCAN_RESPONSE_LENGTH,
    SCAN_RESPONSE_LENGTH,
    generateParsedNpcJson,
} from './src/scanner-request.js';
import {
    applyFocusedRelationshipDecisions,
    rawScanMatchesExisting,
    runFocusedRelationshipPass,
    stampNpcChanges,
    suppressPrimaryRelationshipForFocusedDecisions,
} from './src/relationship-pass.js';
import {
    NPC_STATE_VERSION,
    DEFAULT_RELATIONSHIP,
    IMPORTANT_MEMORY_LIMIT,
    inferNpcIdentityKind,
    normalizeRelationshipBaseline,
    normalizeRelationshipCaps,
    prepareFullWindowRelationshipPayload,
    relationshipSummaryConsistent,
    calibrateRelationshipSummary,
    buildInjection,
    npcCurrentlyAbsentInText,
    npcNamedInText,
    buildScannerPrompt,
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildProfileRefreshPrompt,
    applyNpcStateCommand,
    mergeScanResult,
    isTerminalNpcDeath,
    protectTerminalNpc,
    extractNarrationCapture,
    parseNarrationCapture,
    buildNarrationCaptureParts,
    tagScanEvidence,
    npcMatchesLabel,
    normalizeName,
    normalizeNpcRecord,
    normalizeNpcCandidate,
    resolveInterimIdentityPromotions,
    hasCompactMeguminWorldState,
    extractExplicitKeyRelationshipEdges,
    applyStaleNpcLifecycle,
    appearanceFingerprint,
    normalizeFormPortraitAssets,
    normalizeCustomFields,
    setStoryClockSource,
    storyMinuteText,
    withStoryDateMemo,
} from './core.js';
import {
    BRANCH_LINEAGE_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    BRANCH_SNAPSHOT_MAX_BYTES,
    ROLLBACK_JOURNAL_BUDGET_BYTES,
    ROLLBACK_JOURNAL_VERSION,
    createScanOperationRegistry,
    bestAncestorState,
    chatLineage,
    fingerprintMessage,
    firstLineageDivergence,
    lineageCheckpointKey,
    clearUserDismissedGroupsFor,
    ensureBranchParentAnchor,
    normalizeUserDismissedGroups,
    recordBranchCheckpoint,
    migrateLegacyLineage,
    reconcileBranchState,
    snapshotBranchState,
    setBranchProvenanceHint,
} from './branch.js';
import {
    normalizeSocialGraph,
    reconcileSocialState,
    resolveNpcReference,
} from './social.js';
import {
    adoptNpcStateDataFileMetadata,
    cancelPendingNpcStateWrite,
    deleteNpcStateDataFile,
    inspectNpcStateDataFile,
    makeNpcStateDataFileName,
    makeNpcStateRecoveryFileName,
    currentWriterId,
    probeNpcStateDataFilePointer,
    preserveUndurableNpcStateSnapshot,
    readNpcStateDataFile,
    retireNpcStateDataFile,
    quarantineUnreadableNpcStateDataFile,
    savePortraitFile,
    undurableNpcStateSnapshot,
    verifyPortraitFiles,
    writeNpcStateDataFile,
} from './storage.js';
import { isPortraitFileRecord, markPortraitFileMissing, portraitFilesVersion, portraitHasImage, PORTRAIT_FILE_DIR, PORTRAIT_FILE_PREFIX } from './src/portrait-file.js';
import {
    buildQualifiedChatKey,
    getCharacterOwnerId,
    getChatIdentityFromContext,
    isQualifiedChatKey,
    parseQualifiedChatKey,
} from './identity.js';
import {
    lifecycleRenameStateIsEmpty,
    liveLifecycleCandidateKeys,
    resolveDeletedLifecycleKeyFromPresence,
    resolveOwnedLifecycleKey,
} from './hardening-core.js';
import {
    defersArea,
    resolveDossierTarget,
    storyBlockIsV2,
    normalizeSourceOfTruth,
} from './suite-handshake.js';
import {
    fillPresentSceneText,
} from './present-scene.js';
import { createCardSettingsDefinition, SCAN_EVERY_RANGE } from './src/card-settings.js';
import { awayNpcIds, findKeyEntry, isKey, keyView, normalizeKeyPeople, returnNote } from './src/key-people.js';
import { applyCastEntry, applyCastPortrait, castPortraitWanted, castView, dossierFor, findCastPerson, metWithEntry, normalizeCast } from './src/cast-dossier.js';
import { createRuntimeState } from './runtime-state.js';
import { createEditorPart } from './runtime-editor.js';
import { createMutationsPart } from './runtime-mutations.js';
import { createPortraitPart } from './runtime-portrait.js';
import { createPortraitSettingsPart } from './runtime-portrait-settings.js';
import { createInlineCardsPart } from './runtime-inline-cards.js';
import { createSettingsHtmlPart } from './runtime-settings-html.js';
import { createSettingsBindPart } from './runtime-settings-bind.js';
import { persistSettings, injectDepthOf, getSettings } from './runtime-settings.js';
import { createSuitePart } from './runtime-suite.js';

// The chat text helpers (src/transcript.js) read the host's chat and the Scan context setting.
useTranscriptSource({ context: () => getContext(), scanDepth: () => getSettings().scanDepth });
// (1.2.16) Cache-friendly layout (the Story Suite convention): text that never changes from reply
// to reply goes early and byte-identical, text that changes goes last, so providers that cache the
// prompt's head can reuse it. The live dossier and the one-pass capture's context and reminder are
// the tail (depth 0, after the player's message, in this key order); the capture's rules are the
// head, in the system prompt. Keys sort so the suite's tail reads Story Block, Director, Battle, NSD.
const PROMPT_KEY = 'story_suite_tail_4_npc_state_delta';
const CAPTURE_PROMPT_KEY = 'story_suite_tail_5_npc_state_delta_capture';
const CAPTURE_PROMPT_DEPTH = 0;
const CAPTURE_RULES_KEY = 'story_suite_static_npc_state_delta';
// Keys of earlier versions, emptied on load so a stale copy never lingers in the prompt.
const LEGACY_PROMPT_KEYS = ['npc_state_delta_live_dossier', 'npc_state_delta_capture'];
const UI_ID = 'npc_state_delta_settings';
// Runtime state: closure variables and session collections the controller shares, held on one object created here so each import of this module gets its own (runtime-state.js).
const rt = createRuntimeState();
const {
    branchReconciliationEvents,
    chatStateCache,
    hydratedChatKeys,
    hydratedStateMeta,
    workingCopyAdoptions,
    freshnessChecks,
    missingSidecarChats,
    branchInheritanceChecked,
    freshnessEvents,
    loadingChatStates,
    hydrationErrors,
    pendingAutoScans,
    assistantReceipts,
    narrationCaptures,
    catchUpChats,
    captureRerenderPending,
    stateWriteTimers,
    stateWritePromises,
    stateVersions,
    persistedVersions,
    ownershipEpochs,
    chatCacheTouches,
    lifecycleEventOperations,
    lifecycleRetryTimers,
    castPortraitMisses,
    retiredInSessionChats,
    nativeChangeListeners,
    participantWrites,
    scanIntents,
    deferredWork,
    staleHostChats,
    openingHostChats,
    emptyAnswerChats,
    runningTargetedPasses,
    captureCatchUp,
    portraitActions,
} = rt;
let uiCaptureBridgeInstalled = false;
let lastPresentCardActivation = { npcId: '', at: 0 };
const diagnosticStore = createDiagnosticStore({ limit: 40 });
function diagnosticNpcIds(scanResult = {}, report = null) {
    const values = [];
    for (const row of Array.isArray(scanResult?.npcs) ? scanResult.npcs : []) if (row?.id) values.push(String(row.id));
    const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    for (const row of profile) if (row?.id) values.push(String(row.id));
    for (const row of Array.isArray(report?.profileDevelopment) ? report.profileDevelopment : []) if (row?.npcId) values.push(String(row.npcId));
    for (const row of Array.isArray(report?.birthdayDiagnostics) ? report.birthdayDiagnostics : []) if (row?.npcId) values.push(String(row.npcId));
    return [...new Set(values)].slice(0, 64);
}
function recordScanDiagnostics(chatKey, metrics = {}, scanResult = {}, report = null, extra = {}) {
    return diagnosticStore.record(chatKey, {
        type: metrics?.label || extra?.type || 'scan',
        at: metrics?.at || Date.now(),
        durationMs: metrics?.durationMs || 0,
        sourceMessageId: extra?.sourceMessageId,
        retried: metrics?.retried,
        targeted: extra?.targeted,
        npcIds: extra?.npcIds?.length ? extra.npcIds : diagnosticNpcIds(scanResult, report),
        profileUpdates: metrics?.profileUpdates || 0,
        profileApplied: metrics?.profileApplied || 0,
        profileEvidenceAdded: metrics?.profileEvidenceAdded || 0,
        relationshipApplied: Number(report?.relationshipEvents?.length || 0),
        promptEstimateTokens: Math.ceil(Number(metrics?.promptChars || 0) / 4),
        responseEstimateTokens: Math.ceil(Number(metrics?.responseChars || 0) / 4),
        profileDevelopment: report?.profileDevelopment || metrics?.profileDevelopment || [],
        birthdayDiagnostics: report?.birthdayDiagnostics || [],
    });
}
const BRANCH_RECONCILIATION_EVENT_LIMIT = 16;
const SWIPE_SETTLE_POLL_MS = 80;
const SWIPE_SETTLE_TIMEOUT_MS = 120000;
const INLINE_HISTORY_LIMIT = 80;
const STATE_WRITE_DELAY = 120;
const FRESHNESS_EVENT_LIMIT = 24;
const NARRATION_CAPTURE_LIMIT = 8;
const narrationCaptureStats = { requested: 0, used: 0, missing: 0, invalid: 0, unterminated: 0, outdated: 0 };
// Swipe and regenerate rebuild the branch after the reply arrives, so their instruction would
// describe the replaced sibling; only fresh replies and continues are asked for a block.
const NARRATION_CAPTURE_TYPES = new Set(['', 'normal', 'continue']);
// (b6-soak-3) The capture's rules, which never change from reply to reply, stay in the system prompt
// on these roleplay generations too, swipes and regenerates included, so the prompt's cached head is
// the same on a swipe; only the reminder and context (the request for a block) follow the arming.
// Quiet and impersonate generations never carry them.
const CAPTURE_RULES_TYPES = new Set([...NARRATION_CAPTURE_TYPES, 'swipe', 'regenerate']);
let narrationCaptureVersion = null;
const CHAT_CACHE_LIMIT = 6;
const SCAN_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;
const LIFECYCLE_EVENT_WAIT_MS = 12_000;
const LIFECYCLE_RETRY_DELAY_MS = 30_000;
let lifecycleEventSequence = 0;
const scanOperations = createScanOperationRegistry({
    timeoutMs: SCAN_OPERATION_TIMEOUT_MS,
    onExpire: operation => {
        operation.requestController?.abort(scannerRoutingError('The owning scan expired.', 'NPC_SCANNER_ROUTE_TIMEOUT'));
        console.warn(`[NPC State Delta] ${operation.label} exceeded the scan timeout for ${operation.key}; the lock was released and any late result will be discarded.`);
        try {
            if (getChatKey() !== operation.key) return;
            setScanIndicator(false);
            const npcId = String(operation.metadata?.npcId || '');
            if (npcId && operation.metadata?.indicator === 'dossier') setNpcDossierScanIndicator(npcId, false);
            if (npcId && operation.metadata?.indicator === 'refresh') setNpcChatRefreshIndicator(npcId, false);
            updateInjection();
            if (pendingAutoScans.has(operation.key)) {
                setTimeout(() => {
                    if (getChatKey() === operation.key && !isHostSwipeActive()) void drainPendingAutoScan(operation.key);
                }, 0);
            }
        } catch (error) {
            console.debug('[NPC State Delta] scan-timeout indicator cleanup skipped', error);
        }
    },
});
function isScanBusy(key = getChatKey()) { return scanOperations.isBusy(key); }
function beginScanOperation(key, label, metadata = {}) {
    const operation = scanOperations.begin(key, label, metadata);
    if (!operation) return null;
    const lineage = chatLineage(getContext().chat || []);
    const localRevision = Number(stateVersions.get(key) || 0);
    const canonicalRevision = hydratedRevision(key);
    operation.canonicalRevision = canonicalRevision;
    // The chat's head when the scan began (forwardRelationshipChangesToHost).
    operation.chatHead = chatHeadMark();
    operation.requestController = new AbortController();
    operation.requestScope = {
        route: { profileId: getSettings().scannerConnectionProfile },
        chatKey: key,
        operationId: operation.id,
        signal: operation.requestController.signal,
        deadline: operation.startedAt + SCAN_OPERATION_TIMEOUT_MS,
        isCurrent: () => scanOperations.isCurrent(key, operation)
            && getChatKey() === key
            && Number(stateVersions.get(key) || 0) === localRevision
            && hydratedRevision(key) === canonicalRevision
            && !lineageMoved(lineage, chatLineage(getContext().chat || []), operation.sourceMessageId),
    };
    return operation;
}
function scanOperationCurrent(key, operation) { return scanOperations.isCurrent(key, operation); }
async function scanCanonicalBaseCurrent(key, operation, label = 'scan') {
    const baseRevision = Math.max(0, Math.trunc(Number(operation?.canonicalRevision) || 0));
    try {
        await ensureHydratedStateFresh(key, { reason: `${label}-commit` });
    } catch (error) {
        recordFreshnessEvent(key, 'stale-operation-rejected', {
            reason: label,
            hydratedRevision: baseRevision,
            serverRevision: hydratedStateMeta.get(key)?.latestObservedServerRevision ?? hydratedRevision(key),
            dirty: localWorkingStateDirty(key),
        });
        return false;
    }
    const currentRevision = hydratedRevision(key);
    // The awaited read is a window in which the source can be edited or deleted; the result must
    // still belong to the exact history it was extracted from before it is merged or checkpointed.
    const sourceIntact = getChatKey() === key && (!Array.isArray(operation?.sourceLineage)
        || !lineageMoved(operation.sourceLineage, chatLineage(getContext().chat || []), operation?.sourceMessageId));
    const current = sourceIntact && scanOperationCurrent(key, operation) && currentRevision === baseRevision;
    if (!current) {
        recordFreshnessEvent(key, 'stale-operation-rejected', {
            reason: label,
            hydratedRevision: baseRevision,
            serverRevision: hydratedStateMeta.get(key)?.latestObservedServerRevision ?? currentRevision,
            dirty: false,
        });
        console.info(`[NPC State Delta] rejected stale ${label} result because the canonical sidecar advanced from revision ${baseRevision} to ${currentRevision}.`);
    }
    return current;
}
function endScanOperation(key, operation) {
    const ended = scanOperations.end(key, operation);
    operation?.requestController?.abort();
    if (ended && getChatKey() === key && pendingAutoScans.has(key)) void drainPendingAutoScan(key);
    return ended;
}
function cancelScanOperation(key, reason = 'cancelled') {
    const operation = scanOperations.cancel(key, reason);
    if (!operation) return false;
    operation.requestController?.abort();
    if (getChatKey() === key) {
        setScanIndicator(false);
        const npcId = String(operation.metadata?.npcId || '');
        if (npcId && operation.metadata?.indicator === 'dossier') setNpcDossierScanIndicator(npcId, false);
        if (npcId && operation.metadata?.indicator === 'refresh') setNpcChatRefreshIndicator(npcId, false);
    }
    return true;
}

function getChatIdentity(ctx = getContext()) {
    return getChatIdentityFromContext(ctx);
}

function getChatKey() {
    return getChatIdentity().key;
}

function isCanonicalChatKey(key = getChatKey()) {
    return isQualifiedChatKey(key);
}

function resolveOwnedChatKey(rawId, kind = 'chat', ownerId = undefined) {
    const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!id) return '';
    const ownerWasProvided = ownerId !== undefined;
    const resolvedOwner = String(ownerWasProvided ? (ownerId || '') : (kind === 'group' ? getContext().groupId || '' : getCharacterOwnerId(getContext()))).trim();
    const settings = getSettings();
    const candidates = liveLifecycleCandidateKeys(settings, chatStateCache.keys(), kind, id);
    const resolved = resolveOwnedLifecycleKey(candidates, kind, id, resolvedOwner, ownerWasProvided);
    if (!resolved && candidates.length > 1) {
        console.warn(`[NPC State Delta] refused ambiguous ${kind} lifecycle lookup for ${id}; ${candidates.length} live owner-qualified states share that chat id.`);
    }
    return resolved;
}

function lifecycleCandidateKeys(rawId, kind = 'chat') {
    const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
    return liveLifecycleCandidateKeys(getSettings(), chatStateCache.keys(), kind, id);
}

async function hostCharacterChatPresence(ownerId, rawId) {
    const owner = String(ownerId || '').trim();
    const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!owner || !id) return null;
    try {
        const response = await globalThis.fetch?.('/api/characters/chats', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ avatar_url: owner, simple: true }),
        });
        if (!response?.ok) return null;
        const data = typeof response.json === 'function' ? await response.json() : null;
        if (!data || typeof data !== 'object') return null;
        const chats = Array.isArray(data) ? data : Object.values(data);
        return chats.some(item => String(item?.file_name ?? item?.fileName ?? item?.name ?? '').replace(/\.jsonl$/i, '').trim() === id);
    } catch (error) {
        console.debug(`[NPC State Delta] host ownership probe failed for ${owner}/${id}.`, error);
        return null;
    }
}

function hostGroupChatPresence(ownerId, rawId) {
    const owner = String(ownerId || '').trim();
    const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
    const groups = getContext()?.groups;
    if (!owner || !id || !Array.isArray(groups)) return null;
    const group = groups.find(item => String(item?.id ?? '').trim() === owner);
    if (!group) return false;
    const chats = [
        ...(Array.isArray(group?.chats) ? group.chats : []),
        group?.chat_id,
    ].map(value => String(value ?? '').replace(/\.jsonl$/i, '').trim()).filter(Boolean);
    return chats.includes(id);
}

async function resolveDeletedChatKey(rawId, kind = 'chat', ownerId = '') {
    const id = String(rawId ?? '').replace(/\.jsonl$/i, '').trim();
    if (!id) return '';
    const hint = String(ownerId || '').trim();
    if (hint) return resolveOwnedChatKey(id, kind, hint);
    const candidates = lifecycleCandidateKeys(id, kind);
    if (!candidates.length) return '';

    const presence = [];
    for (const key of candidates) {
        const parsed = parseQualifiedChatKey(key);
        if (!parsed) continue;
        const value = kind === 'group'
            ? hostGroupChatPresence(parsed.ownerId, id)
            : await hostCharacterChatPresence(parsed.ownerId, id);
        presence.push({ key, value });
    }
    if (presence.some(item => item.value === null)) {
        const error = new Error(`NPC State Delta could not prove deleted ${kind} ${id} ownership because the SillyTavern ownership probe was unavailable.`);
        error.code = 'NPC_STATE_DELETE_OWNERSHIP_UNAVAILABLE';
        throw error;
    }
    const resolved = resolveDeletedLifecycleKeyFromPresence(candidates, presence);
    if (resolved) {
        console.info(`[NPC State Delta] resolved deleted ${kind} ${id} from authoritative host ownership: ${resolved}.`);
        return resolved;
    }
    console.warn(`[NPC State Delta] preserved deleted ${kind} ${id}; host ownership did not prove one unique removed owner.`);
    return '';
}

function touchChatCache(key) {
    if (!isCanonicalChatKey(key)) return;
    chatCacheTouches.set(key, Date.now());
}

function forgetCachedChat(key) {
    if (!key || key === getChatKey()) return false;
    if (stateWriteTimers.has(key) || stateWritePromises.has(key) || loadingChatStates.has(key) || isScanBusy(key)) return false;
    chatStateCache.delete(key);
    hydratedChatKeys.delete(key);
    hydratedStateMeta.delete(key);
    freshnessChecks.delete(key);
    missingSidecarChats.delete(key);
    hydrationErrors.delete(key);
    pendingAutoScans.delete(key);
    assistantReceipts.delete(key);
    stateVersions.delete(key);
    persistedVersions.delete(key);
    chatCacheTouches.delete(key);
    return true;
}

function evictDormantChatStates(activeKey = getChatKey(), limit = CHAT_CACHE_LIMIT) {
    const cap = Math.max(2, Number(limit) || CHAT_CACHE_LIMIT);
    const loaded = [...chatStateCache.keys()].filter(isCanonicalChatKey);
    if (loaded.length <= cap) return 0;
    const candidates = loaded
        .filter(key => key !== activeKey)
        .sort((a, b) => Number(chatCacheTouches.get(a) || 0) - Number(chatCacheTouches.get(b) || 0));
    let removed = 0;
    for (const key of candidates) {
        if (chatStateCache.size <= cap) break;
        if (forgetCachedChat(key)) removed += 1;
    }
    return removed;
}

function ownershipEpoch(key) {
    return Number(ownershipEpochs.get(String(key || '')) || 0);
}

function bumpOwnershipEpoch(key) {
    const normalized = String(key || '');
    if (!normalized || normalized === 'no-chat') return 0;
    const next = ownershipEpoch(normalized) + 1;
    ownershipEpochs.set(normalized, next);
    loadingChatStates.delete(normalized);
    missingSidecarChats.delete(normalized);
    return next;
}

// Set by src/storysuite-v2.js while Delta is registered with a Story Block v2 host.
function storyBlockV2Hosted() {
    return globalThis.document?.documentElement?.dataset?.npcStateDeltaStoryBlockV2 === '1';
}

// (v2 meters, F81/F90) While hosted, Story Block's per-reply `npc` slice holds the meter values. Every
// helper here is a no-op without a host: the records pass through untouched and nothing is sent.
function storySuiteV2Meters() {
    return storyBlockV2Hosted() && rt.storySuiteV2?.hosted?.() ? rt.storySuiteV2 : null;
}
// (v2) Story Suite's "Scan after every reply" switch (feature npc-state-delta.scan-every-reply, on by default).
// Off, the automatic scan waits for three replies (or "Scan every" when larger), as in 1.7.4, and then reads every reply since the last scan. True without a host, or when
// the host cannot answer: Delta alone scans as it always did. Manual scans never ask.
function scanAfterEveryReply() {
    const adapter = storySuiteV2Meters();
    if (!adapter) return true;
    try { return adapter.scanEveryReply?.() !== false; } catch { return true; }
}
// (v2) Story Director's clock while hosted ({ minutes, calendar }), for calendar.js; null otherwise (and
// while the reader keeps the calendar here: the adapter's calendarOwn).
function hostedStoryClock() {
    const adapter = storySuiteV2Meters();
    if (!adapter) return null;
    try { return adapter.storyClock?.() ?? null; } catch { return null; }
}
// Delta's records with their relationship numbers read from the slice (views and the injection).
function hostedMeterView(npcs) {
    const adapter = storySuiteV2Meters();
    if (!adapter) return npcs;
    try { return adapter.sliceView(npcs) || npcs; } catch { return npcs; }
}
// (v2, key people) Story Director's key people (`director.keyPeople`, read only), or null: no host, no Story Director,
// or one without the query. Null means Delta alone: no badge, no section, no hold, nothing sent. src/key-people.js.
function keyPeopleList() {
    const adapter = storySuiteV2Meters();
    if (!adapter) return null;
    try {
        const answer = adapter.keyPeopleAnswer?.();
        if (!Array.isArray(answer)) return null;
        const calendar = adapter.directorCalendar?.() ?? null;
        return normalizeKeyPeople(answer, minutes => storyMinuteText(minutes, calendar));
    } catch {
        return null;
    }
}
// Whether this dossier (or snapshot of one) is a current key person.
function isKeyNpc(npc, list = keyPeopleList()) {
    return Boolean(list?.length) && isKey(findKeyEntry(list, npc));
}
// The index of the reply the story stands on for the next generation: the latest reply, or the one before it while the
// latest is being replaced.
function keyHeadIndex() {
    const latest = latestReplyIndex();
    const chat = getContext().chat || [];
    if (!rt.replacingReply || rt.replacingReply.key !== getChatKey() || latest < 0 || chat[latest] !== rt.replacingReply.message) return latest;
    for (let at = latest - 1; at >= 0; at -= 1) if (chat[at] && !chat[at].is_system && !chat[at].is_user) return at;
    return -1;
}
// What the narrator is told once about key people who just came back: { dossier id: "WHILE AWAY, NOW BACK …" }.
// It stands while the latest reply is the one the return was noticed at, so a swipe of the next reply repeats it and
// the next reply that stays drops it.
function keyReturnNotes(state) {
    const list = keyPeopleList();
    if (!list?.length) return null;
    const head = keyHeadIndex();
    const memory = storySuiteV2Meters()?.keyAwayMemory?.() ?? {};
    const notes = {};
    for (const npc of state?.npcs || []) {
        const view = npc?.id ? keyView(list, memory, npc, head) : null;
        if (view?.recent?.justReturned) notes[npc.id] = returnNote(view.recent.away);
    }
    return Object.keys(notes).length ? notes : null;
}
// (v2, the living cast) Delta reads Story Director's `director.cast` and Story Block's `packs.portrait` (never writes to them). At
// the first meeting it makes the person's dossier at once from the pack entry: no scan, no model call. The step (npc.tick,
// src/npc-meters.js observeCast) records the meeting in the saved slice at that reply; this makes the dossier and commits a
// branch checkpoint at the reply, so a swipe or a delete takes it back with the reply (as a manual add does). Nothing here
// without a host or without a Story Director that answers `director.cast`. Rules: src/cast-dossier.js.
// The same sync gives a cast dossier made while its picture was missing the picture once `packs.portrait` answers for it (see
// castPortraitTargets): when the step ends, the host's head moves, the host accepts Delta, the Dossiers tab is drawn or a chat opens.
let castSyncRunning = false;
// The picture's size in pixels ({ width, height }) when the browser can say, else null.
function portraitImageSize(dataUrl) {
    return new Promise(resolve => {
        if (typeof Image !== 'function') { resolve(null); return; }
        const image = new Image();
        const timer = setTimeout(() => resolve(null), 3000);
        image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null); };
        image.onerror = () => { clearTimeout(timer); resolve(null); };
        image.src = dataUrl;
    });
}
// A pack portrait as the dossier's portrait record from its safe image URL, or null. Story Block keeps a cast portrait up to 150 KB and
// 1200 px, so there is no re-compression: a data: URL is kept as it is, anything else is fetched once. The picture is saved ONCE as its own
// user file named by its content (storage.js savePortraitFile: written only when absent) and the record is { path, type, hash, width?, height?,
// sourceName, updatedAt }: the chat's state never holds the picture, and the file outlives the pack. When the file cannot be written the record
// keeps the picture itself ({ dataUrl, … }) exactly as before.
async function castPortraitRecord(url, fileName) {
    try {
        let dataUrl = String(url || '');
        if (!/^data:/i.test(dataUrl)) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
            try {
                const response = await fetch(dataUrl, controller ? { signal: controller.signal } : undefined);
                if (!response?.ok) return null;
                const blob = await response.blob();
                if (!/^image\/(?:png|jpeg|webp)$/i.test(String(blob?.type || '')) || blob.size > 256 * 1024) return null;
                dataUrl = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                });
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl) || dataUrl.length > 400_000) return null;
        const own = { sourceName: String(fileName || '').slice(0, 120), updatedAt: Date.now() };
        const filed = await savePortraitFile(dataUrl, { headers: requestHeaders() });
        if (filed) return { ...filed, ...(await portraitImageSize(dataUrl) ?? {}), ...own };
        return { dataUrl, mime: dataUrl.slice(5, dataUrl.indexOf(';')), ...own };
    } catch {
        return null;
    }
}
// Whether the reader removed this person's dossier before (their name is in the dismissed groups).
function castPersonDismissed(state, person) {
    const labels = new Set([person.name, person.entry?.name, ...(person.aliases || [])].map(normalizeName).filter(Boolean));
    return (state?.userDismissedGroups || []).some(group => (group?.labels || []).some(label => labels.has(label)));
}
// The people the step has recorded as made (the slice's `cast`), met now with their entry, with no dossier standing for them
// and not removed by the reader.
function castList() {
    const adapter = storySuiteV2Meters();
    if (!adapter) return null;
    try {
        const answer = adapter.castAnswer?.();
        if (!Array.isArray(answer)) return null;
        const calendar = adapter.directorCalendar?.() ?? null;
        return normalizeCast(answer, minutes => storyMinuteText(minutes, calendar));
    } catch {
        return null;
    }
}
function castDue(state, adapter) {
    const people = castList();
    if (!Array.isArray(people) || !people.length) return [];
    const made = adapter.castMade?.() ?? {};
    return metWithEntry(people).filter(person => Object.hasOwn(made, person.key)
        && !dossierFor(state.npcs, person) && !castPersonDismissed(state, person));
}
// The cast dossiers that may be given the pack's picture now (src/cast-dossier.js castPortraitWanted: made from the cast, no portrait of
// their own, none removed on purpose) and for whom Story Block's `packs.portrait` now answers for their entry's `portrait`:
// [{ npc, person, url, file }]. A picture that could not be read is not asked for again in this session (castPortraitMisses).
function castPortraitTargets(state, adapter, key = getChatKey()) {
    const wanting = (state?.npcs || []).filter(castPortraitWanted);
    if (!wanting.length) return [];
    const people = metWithEntry(castList());
    const targets = [];
    for (const npc of wanting) {
        const person = findCastPerson(people, npc.castFrom.key);
        const file = person?.entry?.portrait;
        const url = file ? adapter.packPortraitUrl?.(person.pack, file) : null;
        if (url && !castPortraitMisses.has(`${key}|${npc.id}|${url}`)) targets.push({ npc, person, url, file });
    }
    return targets;
}
// Whether the sync has a picture to give a cast dossier (a cheap look, no wait): the adapter asks before it runs the sync for this alone.
function castPortraitDue() {
    try {
        const adapter = storySuiteV2Meters();
        const key = getChatKey();
        if (!adapter || getSettings().enabled === false || !key || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
        return castPortraitTargets(getChatState(key), adapter, key).length > 0;
    } catch {
        return false;
    }
}
// One run at a time. A call that comes while one is running (the step ends while a picture is being read) is not lost: the run goes round once more.
let castSyncAgain = false;
async function castSync() {
    if (castSyncRunning) { castSyncAgain = true; return false; }
    castSyncRunning = true;
    let any = false;
    try {
        do {
            castSyncAgain = false;
            if (await castSyncOnce()) any = true;
        } while (castSyncAgain);
    } finally {
        castSyncRunning = false;
    }
    return any;
}
async function castSyncOnce() {
    const adapter = storySuiteV2Meters();
    if (!adapter || getSettings().enabled === false) return false;
    const key = getChatKey();
    if (!key || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
    if (!castDue(getChatState(key), adapter).length && !castPortraitTargets(getChatState(key), adapter, key).length) return false;
    const mark = chatHeadMark();
    const names = adapter.packNames?.() ?? {};
    const portraits = new Map();
    for (const person of castDue(getChatState(key), adapter)) {
        const url = person.entry.portrait ? adapter.packPortraitUrl?.(person.pack, person.entry.portrait) : null;
        if (url) portraits.set(person.key, await castPortraitRecord(url, person.entry.portrait));
    }
    // A cast dossier made while its picture was missing (the pack imported without pictures) gets it once the pack answers for it.
    const pictures = new Map();
    for (const target of castPortraitTargets(getChatState(key), adapter, key)) {
        const record = await castPortraitRecord(target.url, target.file);
        if (record) pictures.set(target.npc.id, { url: target.url, record });
        else castPortraitMisses.add(`${key}|${target.npc.id}|${target.url}`);
    }
    // The same checks as any other change to the dossiers, after the waits: the chat and its head are still the ones asked about.
    if (!await ensureFreshMutationBoundary('make dossiers from the cast', key, { notify: false })) return false;
    if (getChatKey() !== key || !chatHeadUnchanged(mark)) return false;
    const settings = getSettings();
    const messageId = latestMessageId(true);
    let working = getChatState(key);
    const made = [];
    for (const person of castDue(working, adapter)) {
        const added = applyNpcStateCommand(working, { action: 'add', name: person.entry.name || person.name }, {
            maxNpcs: settings.maxNpcs, excludeNames: currentExclusions(), turn: working.turn, relationshipBaseline: settings.relationshipBaseline,
        });
        if (added.report.status !== 'added') continue;
        const base = added.state.npcs.find(npc => npc.id === added.report.npcId);
        const portrait = portraits.get(person.key) ?? null;
        const filled = base ? applyCastEntry(base, person, { packName: names[person.pack] ?? '', portrait }) : null;
        if (!filled) continue;
        const record = normalizeNpcRecord(filled);
        if (portraitHasImage(record.portrait)) {
            const fingerprint = appearanceFingerprint(record);
            if (fingerprint) record.portrait = { ...record.portrait, appearanceFingerprint: fingerprint };
            // A file-form portrait is kept once, in the dossier; only a picture held in the record gets its portraitAssets copy.
            if (record.portrait.dataUrl) added.state.portraitAssets = { ...(added.state.portraitAssets || {}), [record.id]: structuredClone(record.portrait) };
        }
        added.state.npcs = added.state.npcs.map(npc => (npc.id === record.id ? record : npc));
        working = added.state;
        made.push(record);
    }
    // The pictures: only a dossier that still has none, still of the cast, whose picture was read for the address the pack gives now.
    const given = [];
    for (const target of castPortraitTargets(working, adapter, key)) {
        const got = pictures.get(target.npc.id);
        if (!got || got.url !== target.url) continue;
        const fingerprint = appearanceFingerprint(target.npc);
        const portrait = fingerprint ? { ...got.record, appearanceFingerprint: fingerprint } : got.record;
        const next = applyCastPortrait(target.npc, portrait);
        if (next === target.npc) continue;
        if (next.portrait.dataUrl) working.portraitAssets = { ...(working.portraitAssets || {}), [next.id]: structuredClone(next.portrait) };
        working.npcs = working.npcs.map(npc => (npc.id === next.id ? next : npc));
        given.push(next.id);
    }
    if (!made.length && !given.length) return false;
    if (messageId >= 0 && made.length) commitBranchCheckpoint(working, messageId, 'cast-dossier');
    else if (messageId >= 0) commitBranchCheckpoint(working, messageId, 'cast-portrait');
    setChatState(key, working);
    persistCritical(key);
    renderDossier();
    if (made.length) updateInjection();
    return true;
}
// The dossier view's cast data by dossier id ({ badge, packName, firstMet, goal, routine, lastHeard, where, doing }) for the
// dossiers made from the cast; null with none. Story Director's answer adds the live path and "last heard" when it is there.
function dossierCastViews(state) {
    const made = (state?.npcs || []).filter(npc => npc?.id && npc.castFrom?.key);
    if (!made.length) return null;
    const people = castList();
    // The pin button: Story Director offers it (hosted) and the person is not a key person yet.
    let offered = false;
    try { offered = storySuiteV2Meters()?.keyPinOffered?.() === true; } catch { offered = false; }
    const keyList = offered ? keyPeopleList() : null;
    const views = {};
    for (const npc of made) {
        const view = castView(npc, findCastPerson(people, npc.castFrom.key), { pin: offered && !isKeyNpc(npc, keyList ?? []) });
        if (view) views[npc.id] = view;
    }
    return Object.keys(views).length ? views : null;
}

// (v2) While hosted, Story Block's scene says who is here unless the reader keeps the scene in Delta
// ("scene: mine"): the dossier injection, the Cast tab and the module's queries all follow its
// `scene.present`, so the prompt never carries two different casts. Delta's stored presence is not
// changed. Without a host, or when the scene cannot answer, Delta's own presence stands.
function scenePresenceView(npcs) {
    const adapter = storySuiteV2Meters();
    if (!adapter || !Array.isArray(npcs) || !defersArea('scene', getSettings().sourceOfTruth)) return npcs;
    let names = null;
    try { names = adapter.scenePresent?.(); } catch { names = null; }
    if (!Array.isArray(names)) return npcs;
    const here = new Set(names.map(name => resolveDossierTarget(npcs, name)).filter(Boolean));
    let changed = false;
    const out = npcs.map(npc => {
        // (C-1) The scene cannot bring a confirmed-dead NPC back on stage.
        const present = Boolean(npc?.id) && here.has(String(npc.id)) && !npc.archived && !isTerminalNpcDeath(npc);
        if (Boolean(npc?.present) === present) return npc;
        changed = true;
        return { ...npc, present, worldActive: present ? false : Boolean(npc.worldActive) };
    });
    return changed ? out : npcs;
}
// (v2 World view) Who the story's scene lists as present now, for the scanner's dynamic context: only
// while hosted with Story Block keeping the scene (as scenePresenceView) and only for a scan of the
// head reply (the scene is the head's). Story Director's World view first, else Story Block's scene;
// null otherwise, and the scanner prompt is then exactly as before.
function scanScenePresent(messageId) {
    const adapter = storySuiteV2Meters();
    if (!adapter || !defersArea('scene', getSettings().sourceOfTruth)) return null;
    if (Number.isInteger(messageId) && messageId !== latestMessageId(true)) return null;
    try {
        const names = adapter.presentNow?.();
        return Array.isArray(names) && names.length ? names : null;
    } catch {
        return null;
    }
}
// The merge option that holds away key people's stable fields (as if locked) for one scan: { awayNpcIds } or nothing.
// The dossier view's key-person data by dossier id ({ name, here, away, recent }), or null with no key people.
function dossierKeyViews(state) {
    const list = keyPeopleList();
    if (!list?.length) return null;
    const head = keyHeadIndex();
    const memory = storySuiteV2Meters()?.keyAwayMemory?.() ?? {};
    const views = {};
    for (const npc of state?.npcs || []) {
        const view = npc?.id ? keyView(list, memory, npc, head) : null;
        if (view) views[npc.id] = view;
    }
    return Object.keys(views).length ? views : null;
}
// What the dossier view reads from the host beside the dossiers: v2 meters, key-person and living-cast views.
function dossierHostViews(state) {
    const meterViews = storySuiteV2Meters()?.dossierMeters?.(state.npcs) ?? {};
    const keyViews = dossierKeyViews(state);
    const castViews = dossierCastViews(state);
    return { meterViews, ...(keyViews ? { keyViews } : {}), ...(castViews ? { castViews } : {}) };
}
// (perf) The dossiers as the views read them: a copy, except that a portrait's picture (its data URL, an immutable string of up to
// a few hundred KB) is shared rather than copied; the portrait record itself is still a copy.
function viewNpcCopies(npcs) {
    return (Array.isArray(npcs) ? npcs : []).map(npc => {
        const portrait = npc?.portrait;
        if (!portrait || typeof portrait !== 'object' || typeof portrait.dataUrl !== 'string') return structuredClone(npc);
        const copy = structuredClone({ ...npc, portrait: null });
        const { dataUrl, ...record } = portrait;
        copy.portrait = { ...structuredClone(record), dataUrl };
        return copy;
    });
}
function keyAwayScanOptions(state) {
    const list = keyPeopleList();
    if (!list?.length) return {};
    const ids = awayNpcIds(list, state?.npcs);
    return ids.size ? { awayNpcIds: [...ids] } : {};
}
// The chat state a scan works from: with the slice's relationship numbers while hosted (a copy;
// the stored state is never changed here), the state itself otherwise.
function hostedScanState(state) {
    const npcs = hostedMeterView(state?.npcs);
    return npcs === state?.npcs ? state : { ...state, npcs };
}
// Which message is the head of the chat, and which of its swipes is shown. Story Block writes a
// module's command onto its head reply, so a scan's changes may go there only while it is the head
// the scan started from: the same message object at the same place with the same swipe.
function chatHeadMark() {
    const chat = getContext().chat || [];
    const message = chat[chat.length - 1] ?? null;
    return { length: chat.length, message, swipe: Number.isInteger(message?.swipe_id) ? message.swipe_id : null };
}
function chatHeadUnchanged(mark) {
    if (!mark) return true;
    const now = chatHeadMark();
    return now.length === mark.length && now.message === mark.message && now.swipe === mark.swipe;
}
// A committed scan's relationship changes go to the slice as npc.adjust (same clamps as a story
// line), in dossier order; the sidecar keeps its own numbers by v1's rules. `head` (chatHeadMark,
// taken when the scan started): when the reader swiped, or a reply was added or deleted, since
// then, nothing is sent; the changes belonged to a reply that is no longer the one Story Block
// would write them on, and the reply now shown gets its own scan.
function forwardRelationshipChangesToHost(before, after, messageId, head = null) {
    const adapter = storySuiteV2Meters();
    if (!adapter) return;
    const dropped = () => {
        console.info('[NPC State Delta] the chat moved on during the scan (a swipe or a new or deleted reply); its relationship changes were not sent to Story Suite.');
    };
    if (!chatHeadUnchanged(head)) return dropped();
    const prior = new Map((before || []).map(npc => [npc?.id, npc]));
    const baseline = normalizeRelationshipBaseline(getSettings().relationshipBaseline);
    const changes = [];
    for (const npc of after || []) {
        if (!npc?.id || npc.archived) continue;
        const from = prior.has(npc.id) ? normalizeRelationshipBaseline(prior.get(npc.id).relationship) : baseline;
        const to = normalizeRelationshipBaseline(npc.relationship);
        const meters = Object.fromEntries(Object.keys(to).filter(key => to[key] !== from[key]).map(key => [key, to[key] - from[key]]));
        if (Object.keys(meters).length) changes.push({ name: npc.name, meters, start: from, reply: messageId });
    }
    if (!changes.length) return;
    void (async () => {
        for (const change of changes) {
            if (!chatHeadUnchanged(head)) return dropped();
            await adapter.adjust(change);
        }
    })();
}

// (v2 hidden notes) The story events of present people's locked notes this scan should look for ([] when none): only for
// a scan of the head reply (an opened note is recorded on the head), and only for the people in the scene now.
function hostedEventWatch(state, messageId) {
    const adapter = storySuiteV2Meters();
    if (!adapter || (Number.isInteger(messageId) && messageId !== latestMessageId(true))) return [];
    try { return adapter.eventWatch?.(scenePresenceView(state?.npcs || [])) || []; } catch { return []; }
}

// (v2 hidden notes) What a scanner or one-pass prompt is asked about hidden notes while hosted: the layered notes for a new
// dossier (setting) and the story events of present people's locked notes; {} when neither (the prompt is then as before).
function hostedNotePromptOptions(state, settings, messageId = null) {
    if (!storySuiteV2Meters()) return {};
    const eventWatch = hostedEventWatch(state, Number.isInteger(messageId) ? messageId : undefined);
    return {
        ...(settings.layeredSecrets !== false ? { layeredSecrets: true } : {}),
        ...(eventWatch.length ? { eventWatch } : {}),
    };
}

// (v2 hidden notes) What a targeted pass (backfill, Refresh) is asked about hidden notes: { layered, watch } or null when
// nothing is asked (not hosted, or no setting and no event note to look for). `layered`: this dossier is new (a backfill
// queued at admission) and has no notes yet. `watch`: this one person's locked event notes, when they are present.
function hostedTargetNotes(npc, { newDossier = false, messageId = null } = {}) {
    const adapter = storySuiteV2Meters();
    if (!adapter || !npc) return null;
    const layered = newDossier && getSettings().layeredSecrets !== false && !(Array.isArray(npc.secrets) && npc.secrets.length);
    const watch = hostedEventWatch({ npcs: [npc] }, messageId);
    return layered || watch.length ? { layered, watch } : null;
}
const targetNoteOptions = notes => ({
    ...(notes?.layered ? { layeredSecrets: true } : {}),
    ...(notes?.watch?.length ? { eventWatch: notes.watch } : {}),
});

// A committed scan's `secretEvents` (the keys of the watched story events the current exchange showed) open those notes
// as npc.open (cause ui, recorded on the head reply, so a swipe takes them back). Nothing is sent when the chat moved
// on during the scan (as forwardRelationshipChangesToHost).
function forwardSecretEventsToHost(watched, answered, head = null) {
    const adapter = storySuiteV2Meters();
    if (!adapter || !Array.isArray(watched) || !watched.length || !Array.isArray(answered) || !answered.length) return;
    if (!chatHeadUnchanged(head)) {
        console.info('[NPC State Delta] the chat moved on during the scan; its story events were not sent to Story Suite.');
        return;
    }
    const keys = new Set(answered.map(item => String(item ?? '')));
    const byName = new Map();
    for (const item of watched) {
        if (!keys.has(item.key)) continue;
        byName.set(item.name, [...(byName.get(item.name) || []), item.note]);
    }
    if (!byName.size) return;
    void (async () => {
        for (const [name, ids] of byName) {
            if (!chatHeadUnchanged(head)) return;
            await adapter.openByEvent({ name, ids });
        }
    })();
}

// (v2 hidden notes) The layered notes a scan wrote for the dossiers it just built (`ids`), read from the rows the model
// returned: 2 to 5 per person, cleaned, set once and never rewritten by a later scan. A dossier that already has notes
// (the pack's, the reader's) keeps them. Returns how many dossiers got notes.
function attachGeneratedSecrets(state, ids, ...sources) {
    const adapter = storySuiteV2Meters();
    if (!adapter || !Array.isArray(state?.npcs)) return 0;
    const rows = sources.flatMap(source => (Array.isArray(source?.npcs) ? source.npcs : []));
    let count = 0;
    for (const id of ids || []) {
        const npc = state.npcs.find(item => item?.id === id && !item.archived);
        if (!npc || (Array.isArray(npc.secrets) && npc.secrets.length)) continue;
        const row = rows.find(item => Array.isArray(item?.secrets) && item.secrets.length
            && (String(item.id || '') === npc.id || npcMatchesLabel(npc, String(item.name || ''))));
        let made = [];
        try { made = row ? adapter.generatedSecrets(row.secrets) : []; } catch { made = []; }
        if (!made.length) continue;
        npc.secrets = made;
        count += 1;
    }
    return count;
}

// A v2-hosted automatic boundary may skip the deterministic-path probe: this session already found
// no sidecar for the chat, has no pointer for it and nothing has found or written one since.
function sidecarMissTrusted(key) {
    if (!missingSidecarChats.has(key) || !storyBlockV2Hosted()) return false;
    const settings = getSettings();
    return !settings.dataFiles?.[key]?.path && !settings.sidecarTombstones?.[key];
}

function ownershipEpochCurrent(key, epoch) {
    return ownershipEpoch(key) === Number(epoch || 0);
}

function staleOwnershipError(key) {
    const error = new Error(`NPC State Delta ownership changed while loading ${key}; stale completion was discarded.`);
    error.code = 'NPC_STATE_STALE_OWNERSHIP';
    return error;
}

function assertOwnershipEpoch(key, epoch) {
    if (!ownershipEpochCurrent(key, epoch)) throw staleOwnershipError(key);
}

function freshChatState() {
    return {
        npcs: [],
        candidates: [],
        pendingBackfills: [],
        socialGraph: normalizeSocialGraph(),
        turn: 0,
        assistantSinceScan: 0,
        lastScanAt: 0,
        lastScannedMessageId: null,
        readAhead: [],
        scanCount: 0,
        dismissed: [],
        inlineCards: [],
        portraitAssets: {},
        checkpoints: [],
        lineage: [],
        branchLineageVersion: BRANCH_LINEAGE_VERSION,
        branchParent: null,
        branchForkMessageId: null,
        branchRootSnapshot: null,
        userDismissedGroups: [],
    };
}

// (1.10.1) The whole pass reads the story's date once (calendar.js withStoryDateMemo), not once or twice per dossier.
function normalizeChatState(raw = {}) {
    return withStoryDateMemo(() => normalizeChatStateOnce(raw));
}

function normalizeChatStateOnce(raw = {}) {
    const state = { ...freshChatState(), ...(raw && typeof raw === 'object' ? structuredClone(raw) : {}) };
    const currentBranchFormat = Number(raw?.branchLineageVersion || 0) === BRANCH_LINEAGE_VERSION;
    state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    if (!currentBranchFormat) {
        state.checkpoints = [];
        state.lineage = [];
        state.inlineCards = [];
        state.branchParent = null;
        state.branchForkMessageId = null;
        state.branchRootSnapshot = null;
    }
    if (!currentBranchFormat || Number(raw?.rollbackJournalVersion || 0) !== ROLLBACK_JOURNAL_VERSION) {
        delete state.rollbackJournalVersion;
        delete state.rollbackJournal;
        delete state.rollbackJournalSequence;
        delete state.rollbackHead;
        delete state.rollbackJournalFloorMessageId;
        delete state.rollbackJournalBytes;
        delete state.rollbackJournalBudgetExceeded;
        delete state.rollbackJournalCoverageMessages;
    }
    state.npcs = Array.isArray(state.npcs) ? state.npcs.map(normalizeNpcRecord) : [];
    state.candidates = Array.isArray(state.candidates) ? state.candidates.map(normalizeNpcCandidate).filter(Boolean) : [];
    state.socialGraph = normalizeSocialGraph(state.socialGraph);
    state.pendingBackfills = Array.isArray(state.pendingBackfills)
        ? state.pendingBackfills
            .map(normalizeAutomaticBackfillRequest)
            .filter(Boolean)
            .map(item => ({
                ...item,
                requestedAt: item.requestedAt || Date.now(),
                attempts: Math.max(0, Math.min(BACKFILL_MAX_ATTEMPTS, item.attempts)),
            }))
        : [];
    state.dismissed = Array.isArray(state.dismissed) ? [...state.dismissed] : [];
    state.userDismissedGroups = normalizeUserDismissedGroups(state.userDismissedGroups);
    state.inlineCards = Array.isArray(state.inlineCards) ? state.inlineCards.map(entry => ({
        ...entry,
        cards: Array.isArray(entry?.cards) ? entry.cards.map(card => normalizeNpcRecord(card)) : [],
    })) : [];
    state.portraitAssets = state.portraitAssets && typeof state.portraitAssets === 'object' ? state.portraitAssets : {};
    state.formPortraitAssets = normalizeFormPortraitAssets(state.formPortraitAssets);
    state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints.map(checkpoint => {
        if (!checkpoint || typeof checkpoint !== 'object' || !checkpoint.snapshot || typeof checkpoint.snapshot !== 'object') return checkpoint;
        const snapshot = { ...checkpoint.snapshot };
        snapshot.npcs = Array.isArray(snapshot.npcs) ? snapshot.npcs.map(normalizeNpcRecord) : [];
        snapshot.candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates.map(normalizeNpcCandidate).filter(Boolean) : [];
        snapshot.socialGraph = normalizeSocialGraph(snapshot.socialGraph);
        return { ...checkpoint, snapshot };
    }).filter(Boolean) : [];
    if (state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object') {
        const root = { ...state.branchRootSnapshot };
        root.npcs = Array.isArray(root.npcs) ? root.npcs.map(normalizeNpcRecord) : [];
        root.candidates = Array.isArray(root.candidates) ? root.candidates.map(normalizeNpcCandidate).filter(Boolean) : [];
        root.socialGraph = normalizeSocialGraph(root.socialGraph);
        state.branchRootSnapshot = root;
    } else {
        state.branchRootSnapshot = null;
    }
    state.lineage = Array.isArray(state.lineage) ? state.lineage : [];
    const socialMigration = reconcileSocialState(state, { provenance: 'migration', confidence: 'migration' });
    state.socialGraph = socialMigration.socialGraph;
    state.npcs = socialMigration.state.npcs;
    for (const npc of state.npcs) {
        if (npc?.portrait?.dataUrl && !state.portraitAssets[npc.id]) state.portraitAssets[npc.id] = structuredClone(npc.portrait);
        if (!portraitHasImage(npc?.portrait) && state.portraitAssets[npc.id]?.dataUrl) npc.portrait = structuredClone(state.portraitAssets[npc.id]);
    }
    return state;
}

function getChatState(key = getChatKey()) {
    if (key === 'no-chat') return freshChatState();
    if (!chatStateCache.has(key)) chatStateCache.set(key, freshChatState());
    touchChatCache(key);
    return chatStateCache.get(key);
}

function setChatState(key, state, { markLoaded = false } = {}) {
    if (!key || key === 'no-chat') return state;
    const normalized = normalizeChatState(state);
    chatStateCache.set(key, normalized);
    touchChatCache(key);
    if (markLoaded) {
        hydratedChatKeys.add(key);
        hydrationErrors.delete(key);
        workingCopyAdoptions.set(key, workingCopyAdoption(key) + 1);
        checkPortraitFilesSoon(normalized);
    }
    stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
    return normalized;
}

// (cast portraits) A loaded chat's file-form portraits are asked about once, in one request (/api/files/verify: no 404); one the server says is
// gone (deleted by hand) is remembered, so the person shows the normal no-portrait look instead of a broken picture.
function checkPortraitFilesSoon(state) {
    const portraits = (state?.npcs || []).map(npc => npc?.portrait).filter(isPortraitFileRecord);
    if (!portraits.length) return;
    verifyPortraitFiles(portraits, { headers: requestHeaders() })
        .then(gone => { if (gone) renderDossier(); })
        .catch(() => {});
}
// An image of a portrait file that fails to load (deleted after the check) is remembered as gone and the views draw again without it.
function portraitFileFailed(event) {
    const image = event?.target;
    if (image?.tagName !== 'IMG') return;
    let path = '';
    try { path = new URL(image.currentSrc || image.src, globalThis.location?.href || 'http://localhost/').pathname; } catch { return; }
    if (!path.startsWith(`${PORTRAIT_FILE_DIR}${PORTRAIT_FILE_PREFIX}`)) return;
    markPortraitFileMissing(path);
    renderDossier();
}

// Counts how often a loaded/server copy replaced this session's working copy. Unlike the durable
// revision it does not advance for this session's own saves, so an open editor stays valid across
// its own Appearance/Life-state/portrait commits but not across another session's installed state.
function workingCopyAdoption(key = getChatKey()) {
    return Number(workingCopyAdoptions.get(String(key || '')) || 0);
}

function hydratedRevision(key = getChatKey()) {
    const meta = hydratedStateMeta.get(String(key || ''));
    if (Number.isFinite(Number(meta?.revision))) return Math.max(0, Math.trunc(Number(meta.revision)));
    const pointer = getSettings().dataFiles?.[key];
    return Number.isFinite(Number(pointer?.revision)) ? Math.max(0, Math.trunc(Number(pointer.revision))) : 0;
}

function updateHydratedStateMeta(key, revision, extra = {}) {
    const normalized = String(key || '');
    if (!normalized || normalized === 'no-chat') return null;
    const previous = hydratedStateMeta.get(normalized) || {};
    const next = {
        revision: Math.max(0, Math.trunc(Number(revision) || 0)),
        writerId: String(extra.writerId ?? previous.writerId ?? ''),
        hydratedAt: Number(extra.hydratedAt || previous.hydratedAt || Date.now()),
        lastCheckedAt: Number(extra.lastCheckedAt || previous.lastCheckedAt || 0),
        latestObservedServerRevision: Math.max(0, Math.trunc(Number(extra.latestObservedServerRevision ?? previous.latestObservedServerRevision ?? revision) || 0)),
        latestObservedServerWriterId: String(extra.latestObservedServerWriterId ?? previous.latestObservedServerWriterId ?? extra.writerId ?? previous.writerId ?? ''),
    };
    hydratedStateMeta.set(normalized, next);
    return next;
}

function recordFreshnessEvent(key, type, details = {}) {
    freshnessEvents.push({
        at: Date.now(),
        chatKey: String(key || ''),
        type: String(type || 'check'),
        reason: String(details.reason || '').slice(0, 80),
        hydratedRevision: Math.max(0, Math.trunc(Number(details.hydratedRevision) || 0)),
        serverRevision: Math.max(0, Math.trunc(Number(details.serverRevision) || 0)),
        dirty: details.dirty === true,
    });
    if (freshnessEvents.length > FRESHNESS_EVENT_LIMIT) freshnessEvents.splice(0, freshnessEvents.length - FRESHNESS_EVENT_LIMIT);
}

function localWorkingStateDirty(key = getChatKey()) {
    const normalized = String(key || '');
    const recovery = undurableNpcStateSnapshot(normalized);
    return stateWriteTimers.has(normalized)
        || stateWritePromises.has(normalized)
        || Number(stateVersions.get(normalized) || 0) > Number(persistedVersions.get(normalized) ?? -1)
        || Boolean(recovery && recovery.recoveryOnly !== true);
}

function makeRevisionConflict(key, expectedRevision, actualRevision, message = '') {
    const error = new Error(message || `NPC State Delta sidecar changed in another session (expected revision ${expectedRevision}, found ${actualRevision}).`);
    error.code = 'NPC_STATE_WRITE_CONFLICT';
    error.expectedRevision = Number.isFinite(Number(expectedRevision)) ? Math.max(0, Math.trunc(Number(expectedRevision))) : null;
    error.actualRevision = Number.isFinite(Number(actualRevision)) ? Math.max(0, Math.trunc(Number(actualRevision))) : null;
    error.chatKey = String(key || '');
    return error;
}

function installCanonicalServerState(key, pointer, inspected, { reason = 'freshness-check', dirtyConflict = false } = {}) {
    const settings = getSettings();
    if (!inspected?.exists || !inspected?.payload) throw new Error(`NPC State Delta canonical sidecar for ${key} is unavailable.`);
    if (inspected.retired) {
        const error = new Error(`NPC State Delta sidecar for ${key} was retired by another session. Reload or switch chats before making dossier changes.`);
        error.code = 'NPC_STATE_SIDECAR_RETIRED';
        retiredInSessionChats.set(key, error);
        holdRetiredLocalWork(key);
        settings.sidecarTombstones[key] = { reason: inspected.payload.retireReason || 'retired-file', at: Date.now() };
        delete settings.dataFiles[key];
        hydratedChatKeys.delete(key);
        hydratedStateMeta.delete(key);
        freshnessChecks.delete(key);
        hydrationErrors.set(key, error);
        persistSettings();
        throw error;
    }
    adoptNpcStateDataFileMetadata(pointer, inspected);
    settings.dataFiles[key] = pointer;
    delete settings.sidecarTombstones[key];
    cancelScanOperation(key, dirtyConflict ? 'cross-session conflict' : 'server revision advanced');
    pendingAutoScans.delete(key);
    assistantReceipts.delete(key);
    const installed = setChatState(key, inspected.payload.state, { markLoaded: true });
    noteAdoptedDossier(key, installed, inspected.writerId);
    persistedVersions.set(key, Number(stateVersions.get(key) || 0));
    updateHydratedStateMeta(key, inspected.revision, {
        hydratedAt: Date.now(),
        lastCheckedAt: Date.now(),
        latestObservedServerRevision: inspected.revision,
        writerId: inspected.writerId,
        latestObservedServerWriterId: inspected.writerId,
    });
    persistSettings();
    // (timeline participant) The server's newer copy is now the working state: a native change that no persist call announces.
    announceNativeChange(key);
    if (getChatKey() === key) {
        renderDossier();
        updateInjection();
        queueInlineRender(0);
    }
    recordFreshnessEvent(key, dirtyConflict ? 'cross-session-conflict' : 'stale-cache-refresh', {
        reason,
        hydratedRevision: inspected.revision,
        serverRevision: inspected.revision,
        dirty: dirtyConflict,
    });
    return installed;
}

async function reconcileCrossSessionWriteConflict(key, error, snapshot, knownPointer) {
    const normalized = String(key || '');
    const pointer = probeNpcStateDataFilePointer(normalized, knownPointer);
    const inspected = await inspectNpcStateDataFile(pointer, { expectedChatKey: normalized });
    cancelPendingNpcStateWrite(normalized);
    preserveUndurableNpcStateSnapshot({
        chatKey: normalized,
        state: structuredClone(chatStateCache.get(normalized) || snapshot),
        appVersion: NPC_STATE_VERSION,
        pointer,
        error,
        reason: 'guarded-write-conflict',
    });
    recordFreshnessEvent(normalized, 'cross-session-write-conflict', {
        reason: 'guarded-write',
        hydratedRevision: error?.expectedRevision ?? hydratedRevision(normalized),
        serverRevision: inspected.revision,
        dirty: true,
    });
    if (inspected.exists) {
        installCanonicalServerState(normalized, pointer, inspected, { reason: 'guarded-write-conflict', dirtyConflict: true });
        if (getChatKey() === normalized) globalThis.toastr?.warning?.('NPC State Delta: another session saved a newer dossier first. This local change was preserved for recovery and was not allowed to overwrite the server copy.');
    }
    return inspected;
}

async function ensureHydratedStateFresh(key = getChatKey(), { reason = 'boundary', notify = false, probeMissing = false } = {}) {
    const normalized = String(key || '');
    if (!normalized || normalized === 'no-chat' || !isCanonicalChatKey(normalized)) return getChatState(normalized);
    if (!hydratedChatKeys.has(normalized)) return getChatState(normalized);
    if (!probeMissing && sidecarMissTrusted(normalized)) return getChatState(normalized);
    if (freshnessChecks.has(normalized)) return freshnessChecks.get(normalized);

    let task;
    const epoch = ownershipEpoch(normalized);
    task = (async () => {
        const inFlight = stateWritePromises.get(normalized);
        if (inFlight) {
            recordFreshnessEvent(normalized, 'local-write-in-flight', {
                reason,
                hydratedRevision: hydratedRevision(normalized),
                serverRevision: hydratedStateMeta.get(normalized)?.latestObservedServerRevision ?? hydratedRevision(normalized),
                dirty: true,
            });
            return getChatState(normalized);
        }
        if (!hydratedChatKeys.has(normalized)) return getChatState(normalized);
        const settings = getSettings();
        const knownPointer = settings.dataFiles?.[normalized] || null;
        const unpointered = !knownPointer?.path;
        if (unpointered && settings.sidecarTombstones?.[normalized]) {
            updateHydratedStateMeta(normalized, 0, { lastCheckedAt: Date.now(), latestObservedServerRevision: 0 });
            return getChatState(normalized);
        }
        // A session that hydrated before another session created this chat's sidecar has no pointer.
        // Probe the deterministic path so that session adopts the canonical file instead of later
        // treating its empty working copy as authoritative.
        const pointer = unpointered ? probeNpcStateDataFilePointer(normalized, knownPointer) : knownPointer;

        const localRevision = hydratedRevision(normalized);
        const localWriterId = String(hydratedStateMeta.get(normalized)?.writerId || pointer?.writerId || '');
        // (beta) Unpointered, a missing file is the usual answer: asked first, so no 404 is fetched.
        const inspected = await inspectNpcStateDataFile(pointer, { expectedChatKey: normalized, probeHeaders: unpointered ? requestHeaders() : null });
        // A deletion, rename or retirement that completed while this read was in flight owns the
        // chat now; the late result must not restore its pointer, tombstone or cached dossier.
        if (!ownershipEpochCurrent(normalized, epoch) || getSettings().sidecarTombstones?.[normalized]) throw staleOwnershipError(normalized);
        if (unpointered && !inspected.exists) {
            missingSidecarChats.add(normalized);
            updateHydratedStateMeta(normalized, 0, { lastCheckedAt: Date.now(), latestObservedServerRevision: 0 });
            return getChatState(normalized);
        }
        if (inspected.exists) missingSidecarChats.delete(normalized);
        const writerFork = Boolean(inspected.exists && inspected.revision === localRevision
            && localWriterId && inspected.writerId && inspected.writerId !== localWriterId);
        updateHydratedStateMeta(normalized, localRevision, {
            lastCheckedAt: Date.now(),
            latestObservedServerRevision: inspected.revision,
            latestObservedServerWriterId: inspected.writerId,
        });

        if (!inspected.exists) {
            const error = makeRevisionConflict(normalized, localRevision, null, `NPC State Delta canonical sidecar for ${normalized} disappeared from the SillyTavern server. Refusing to recreate it from a cached browser copy.`);
            recordFreshnessEvent(normalized, 'sidecar-missing', { reason, hydratedRevision: localRevision, serverRevision: 0, dirty: localWorkingStateDirty(normalized) });
            throw error;
        }
        if (!inspected.retired && inspected.revision === localRevision && !writerFork) {
            recordFreshnessEvent(normalized, 'current', { reason, hydratedRevision: localRevision, serverRevision: inspected.revision, dirty: localWorkingStateDirty(normalized) });
            return getChatState(normalized);
        }

        const dirty = localWorkingStateDirty(normalized);
        const preserveLocal = dirty || writerFork;
        const localSnapshot = preserveLocal ? structuredClone(getChatState(normalized)) : null;
        const conflict = preserveLocal
            ? makeRevisionConflict(
                normalized,
                localRevision,
                inspected.revision,
                writerFork
                    ? `NPC State Delta detected a same-revision writer conflict at revision ${localRevision}. Another session replaced that revision with a different writer; this session's working copy was preserved for recovery and was not republished.`
                    : `NPC State Delta detected newer canonical server revision ${inspected.revision} while this session still had unsaved work based on revision ${localRevision}. The local work was preserved for recovery and was not published.`,
            )
            : null;

        if (preserveLocal) {
            if (stateWriteTimers.has(normalized)) {
                clearTimeout(stateWriteTimers.get(normalized));
                stateWriteTimers.delete(normalized);
            }
            cancelPendingNpcStateWrite(normalized);
            preserveUndurableNpcStateSnapshot({
                chatKey: normalized,
                state: localSnapshot,
                appVersion: NPC_STATE_VERSION,
                pointer,
                error: conflict,
                reason: writerFork ? `same-revision-writer:${reason}` : `freshness:${reason}`,
            });
        }

        try {
            const state = installCanonicalServerState(normalized, pointer, inspected, { reason, dirtyConflict: preserveLocal });
            // A same-revision fork means a save this session already reported was overwritten by
            // another session, so it is always reported, even from a background freshness check.
            if (preserveLocal && (notify || writerFork)) globalThis.toastr?.warning?.(
                writerFork
                    ? 'NPC State Delta: another session replaced the same server revision. This session copy was preserved for recovery; the server copy is now active.'
                    : 'NPC State Delta: another session advanced this chat. Unsaved local dossier work was preserved for recovery; the server copy is now active.',
            );
            if (writerFork) recordFreshnessEvent(normalized, 'same-revision-writer-conflict', { reason, hydratedRevision: localRevision, serverRevision: inspected.revision, dirty: true });
            return state;
        } catch (error) {
            if (preserveLocal) recordFreshnessEvent(normalized, writerFork ? 'same-revision-writer-conflict' : 'cross-session-conflict', { reason, hydratedRevision: localRevision, serverRevision: inspected.revision, dirty: true });
            throw error;
        }
    })().finally(() => {
        if (freshnessChecks.get(normalized) === task) freshnessChecks.delete(normalized);
    });
    freshnessChecks.set(normalized, task);
    return task;
}

async function ensureFreshMutationBoundary(action, key = getChatKey(), { notify = true } = {}) {
    const normalized = String(key || '');
    if (!normalized || normalized === 'no-chat' || !isCanonicalChatKey(normalized)) {
        if (notify) globalThis.toastr?.warning?.(`NPC State Delta: open a chat before attempting to ${action}.`);
        return false;
    }
    try {
        await ensureChatStateLoaded(normalized, { probeMissing: true });
    } catch (error) {
        if (notify) globalThis.toastr?.warning?.(`NPC State Delta: cannot ${action} because the canonical server dossier could not be verified. ${error?.message || error}`);
        return false;
    }
    if (getChatKey() !== normalized || !requireReadyChatMutation(action, normalized, { notify })) return false;
    return true;
}

async function runFreshMutation(action, key, mutation, options = {}) {
    if (!await ensureFreshMutationBoundary(action, key, options)) return false;
    return mutation();
}

function chatHydrationStatus(key = getChatKey()) {
    if (!key || key === 'no-chat') return 'none';
    if (!isCanonicalChatKey(key)) return 'pending';
    if (hydratedChatKeys.has(key)) return 'ready';
    if (loadingChatStates.has(key)) return 'loading';
    if (hydrationErrors.has(key)) return 'error';
    return 'idle';
}
function assertChatHydratedForWrite(key = getChatKey()) {
    if (!key || key === 'no-chat') return;
    const pointer = getSettings().dataFiles?.[key];
    if (pointer?.path && !hydratedChatKeys.has(key)) throw new Error('Refusing to overwrite unhydrated NPC State Delta sidecar for ' + key + '.');
}

function requireReadyChatMutation(action = 'modify NPC State Delta', key = getChatKey(), { notify = true } = {}) {
    if (!key || key === 'no-chat' || !isCanonicalChatKey(key)) {
        if (notify) globalThis.toastr?.warning?.(`NPC State Delta: open a chat before attempting to ${action}.`);
        return false;
    }
    if (chatHydrationStatus(key) === 'ready') return true;
    const error = hydrationErrors.get(key);
    if (notify) globalThis.toastr?.warning?.(`NPC State Delta: cannot ${action} until this chat dossier loads successfully.${error?.message ? ` ${error.message}` : ''}`);
    return false;
}

async function retryCurrentChatHydration() {
    const key = getChatKey();
    if (!key || key === 'no-chat') return false;
    try {
        await ensureChatStateLoaded(key, { probeMissing: true });
        if (getChatKey() !== key) return false;
        renderDossier();
        updateInjection();
        globalThis.toastr?.success?.('NPC State Delta: chat dossier loaded successfully.');
        return true;
    } catch (error) {
        if (getChatKey() === key) { renderDossier(); updateInjection(); }
        globalThis.toastr?.error?.(`NPC State Delta still cannot load this chat dossier: ${error?.message || error}`);
        return false;
    }
}

async function detachBrokenSidecar() {
    const key = getChatKey();
    const settings = getSettings();
    const pointer = settings.dataFiles?.[key] || null;
    if (!isCanonicalChatKey(key) || !pointer?.path || chatHydrationStatus(key) !== 'error') return false;
    if (!window.confirm('Detach the broken NPC State Delta sidecar for this chat and start a fresh empty dossier? The old pointer is retained under recovery metadata and is not deleted automatically.')) return false;
    let preserved = null;
    let registered = false;
    const registerBackup = copy => {
        settings.recoveryFiles[key] = { ...copy, reason: 'manual-detach', retiredAt: Date.now() };
        registered = true;
        persistSettings();
    };
    try {
        preserved = await quarantineUnreadableNpcStateDataFile({ chatKey: key, pointer, appVersion: NPC_STATE_VERSION, headers: requestHeaders(), onPreserved: registerBackup });
    } catch (error) {
        console.error('[NPC State Delta] broken sidecar detach did not complete.', error);
        globalThis.toastr?.error?.(registered
            ? `NPC State Delta: the broken sidecar was preserved and its backup registered, but detaching did not complete. Retry Detach. ${error?.message || error}`
            : `NPC State Delta: the broken sidecar could not be preserved, so it was not detached. ${error?.message || error}`);
        return false;
    }
    if (getChatKey() !== key) return false;
    bumpOwnershipEpoch(key);
    // A retry that finds this detach already committed keeps the registered original backup; a
    // marker another session wrote names its backup. The empty marker itself is never registered
    // as the preserved sidecar.
    const ownRegistration = settings.recoveryFiles[key]?.reason === 'manual-detach' && settings.recoveryFiles[key]?.preservedFrom === pointer.path;
    if (preserved?.path && !(preserved.alreadyDetached && ownRegistration)) {
        const { alreadyDetached, ...copy } = preserved;
        settings.recoveryFiles[key] = { ...copy, reason: 'manual-detach', retiredAt: Date.now() };
    } else if (!preserved) {
        settings.recoveryFiles[key] = { ...pointer, reason: 'manual-detach', retiredAt: Date.now() };
    }
    settings.sidecarTombstones[key] = { reason: 'manual-detach', at: Date.now() };
    delete settings.dataFiles[key];
    chatStateCache.delete(key);
    hydratedChatKeys.delete(key);
    hydratedStateMeta.delete(key);
    freshnessChecks.delete(key);
    hydrationErrors.delete(key);
    stateVersions.delete(key);
    persistedVersions.delete(key);
    stateWritePromises.delete(key);
    const state = setChatState(key, freshChatState(), { markLoaded: true });
    state.lineage = chatLineage(getContext().chat || []);
    persistSettings();
    renderDossier();
    updateInjection();
    globalThis.toastr?.warning?.('NPC State Delta: broken sidecar detached. The chat now has a fresh dossier; the previous pointer remains in recovery metadata.');
    return true;
}

function requestHeaders() {
    try {
        return typeof getRequestHeaders === 'function' ? getRequestHeaders() : { 'Content-Type': 'application/json' };
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}

// The last pre-generation freshness read, which the one MESSAGE_SENT that follows it may reuse.
const GENERATION_FRESHNESS_REUSE_MS = 5000;

// Observed retirement is authoritative at the durability boundary too: dirty local work for that
// chat must never be published over the retired marker (an unpointered writer may otherwise reuse
// the deterministic path). Keep it only as a recovery-only snapshot and stop its queued writes.
function holdRetiredLocalWork(key) {
    const error = retiredInSessionChats.get(key);
    if (!error) return null;
    if (stateWriteTimers.has(key)) {
        clearTimeout(stateWriteTimers.get(key));
        stateWriteTimers.delete(key);
    }
    const existing = undurableNpcStateSnapshot(key);
    const dirty = Number(stateVersions.get(key) || 0) > Number(persistedVersions.get(key) ?? -1);
    if ((dirty && chatStateCache.has(key)) || (existing && existing.recoveryOnly !== true)) {
        const state = dirty && chatStateCache.has(key) ? structuredClone(chatStateCache.get(key)) : existing.state;
        cancelPendingNpcStateWrite(key);
        preserveUndurableNpcStateSnapshot({ chatKey: key, state, appVersion: NPC_STATE_VERSION, pointer: null, error, reason: 'retired-in-session' });
    }
    return error;
}

// probeMissing: an explicit look (the reader's own action, page resume) that asks the server even
// when this session already found no sidecar for the chat (sidecarMissTrusted).
async function ensureChatStateLoaded(key = getChatKey(), { probeMissing = false } = {}) {
    if (!key || key === 'no-chat' || !isCanonicalChatKey(key)) return freshChatState();
    if (retiredInSessionChats.has(key)) {
        hydrationErrors.set(key, retiredInSessionChats.get(key));
        throw retiredInSessionChats.get(key);
    }
    if (hydratedChatKeys.has(key)) return ensureHydratedStateFresh(key, { reason: 'hydrate-boundary', probeMissing });
    if (loadingChatStates.has(key)) return loadingChatStates.get(key);
    const epoch = ownershipEpoch(key);
    let task;
    task = (async () => {
        const settings = getSettings();
        let pointer = settings.dataFiles?.[key] || null;
        let recoveredState = null;
        let loadedUndurable = false;
        const tombstone = settings.sidecarTombstones?.[key] || null;
        const tombstoned = Boolean(tombstone);
        if (tombstoned && pointer?.path) {
            if (!settings.recoveryFiles[key]) settings.recoveryFiles[key] = { ...pointer, reason: `tombstoned:${tombstone?.reason || 'retired'}`, retiredAt: Number(tombstone?.at || Date.now()) };
            delete settings.dataFiles[key];
            pointer = null;
            persistSettings();
            console.warn(`[NPC State Delta] ignored live sidecar pointer for tombstoned ${key}; destructive tombstone remains authoritative.`);
        }
        if (!pointer?.path && !tombstoned) {
            const recoveryName = makeNpcStateDataFileName(key);
            const recoveryPointer = { name: recoveryName, path: `/user/files/${recoveryName}` };
            // A missing file reads as null. Any thrown error (server error, auth, malformed JSON)
            // means the sidecar may exist but could not be read, so it must not become a new empty
            // dossier: retry, then block hydration like an unreadable known pointer.
            let discoveryError = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    discoveryError = null;
                    // (beta) A new chat has no file: asked first, so no 404 is fetched for it.
                    const recovered = await readNpcStateDataFile(recoveryPointer, { expectedChatKey: key, probeHeaders: requestHeaders() });
                    assertOwnershipEpoch(key, epoch);
                    if (recovered?.retired) {
                        settings.sidecarTombstones[key] = { reason: recovered.retireReason || 'retired-file', at: Date.now() };
                        persistSettings();
                    } else if (recovered?.state) {
                        recoveredState = recovered.state;
                        loadedUndurable = recovered.undurable === true;
                        pointer = recoveryPointer;
                        settings.dataFiles[key] = recoveryPointer;
                        persistSettings();
                        console.info(`[NPC State Delta] recovered deterministic sidecar pointer for ${key}.`);
                    }
                    break;
                } catch (error) {
                    if (error?.code === 'NPC_STATE_STALE_OWNERSHIP') throw error;
                    discoveryError = error;
                    if (attempt < 2) {
                        await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
                        assertOwnershipEpoch(key, epoch);
                    }
                }
            }
            if (discoveryError) {
                hydrationErrors.set(key, discoveryError);
                console.error(`[NPC State Delta] Could not read the existing data file for ${key}; blocking writes instead of starting an empty dossier.`, discoveryError);
                throw discoveryError;
            }
            if (!recoveredState && !settings.sidecarTombstones?.[key]) missingSidecarChats.add(key);
            else missingSidecarChats.delete(key);
        }
        let loaded = recoveredState;
        if (pointer?.path && !loaded) {
            let lastError = null;
            for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
                try {
                    const payload = await readNpcStateDataFile(pointer, { expectedChatKey: key });
                    assertOwnershipEpoch(key, epoch);
                    if (payload?.retired) {
                        settings.sidecarTombstones[key] = { reason: payload.retireReason || 'retired-file', at: Date.now() };
                        delete settings.dataFiles[key];
                        pointer = null;
                        persistSettings();
                        break;
                    }
                    if (payload?.state) {
                        loaded = payload.state;
                        loadedUndurable = payload.undurable === true;
                    } else throw new Error('NPC State Delta sidecar returned no state payload.');
                } catch (error) {
                    if (error?.code === 'NPC_STATE_STALE_OWNERSHIP') throw error;
                    lastError = error;
                    if (attempt < 2) {
                        await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
                        assertOwnershipEpoch(key, epoch);
                    }
                }
            }
            if (pointer?.path && !loaded) {
                hydrationErrors.set(key, lastError || new Error('NPC State Delta sidecar could not be loaded.'));
                console.error(`[NPC State Delta] Could not hydrate data file for ${key}; preserving the sidecar and blocking writes.`, lastError);
                throw lastError || new Error('NPC State Delta could not hydrate ' + key + '.');
            }
        }
        assertOwnershipEpoch(key, epoch);
        const sourceState = loaded || freshChatState();
        const state = setChatState(key, sourceState, { markLoaded: true });
        const durableRevision = Number.isFinite(Number(pointer?.revision)) ? Math.max(0, Math.trunc(Number(pointer.revision))) : 0;
        updateHydratedStateMeta(key, durableRevision, {
            hydratedAt: Date.now(),
            lastCheckedAt: loaded ? Date.now() : 0,
            latestObservedServerRevision: durableRevision,
            writerId: String(pointer?.writerId || ''),
            latestObservedServerWriterId: String(pointer?.writerId || ''),
        });
        if (loaded && !loadedUndurable) persistedVersions.set(key, Number(stateVersions.get(key) || 0));
        return state;
    })().catch(error => {
        if (error?.code !== 'NPC_STATE_STALE_OWNERSHIP') hydrationErrors.set(key, error);
        throw error;
    }).finally(() => {
        if (loadingChatStates.get(key) === task) loadingChatStates.delete(key);
    });
    loadingChatStates.set(key, task);
    return task;
}

function markStateDirty(key = getChatKey()) {
    if (!key || key === 'no-chat') return;
    stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
    announceNativeChange(key);
}

function announceNativeChange(key) {
    if ((participantWrites.get(key) || 0) > 0 || key !== getChatKey()) return;
    for (const listener of nativeChangeListeners) {
        try { listener({ key }); } catch (error) { console.debug('[NPC State Delta] a native-change listener failed', error); }
    }
}
async function quietly(key, task) {
    participantWrites.set(key, (participantWrites.get(key) || 0) + 1);
    try { return await task(); } finally {
        const left = (participantWrites.get(key) || 1) - 1;
        if (left > 0) participantWrites.set(key, left); else participantWrites.delete(key);
    }
}

async function withScanIntent(key, task, skipped = false, defer = null) {
    scanIntents.set(key, (scanIntents.get(key) || 0) + 1);
    const check = defer?.guard?.() ?? null;   // what the work stood on when it was asked for, kept for a retry
    try {
        // (timeline) No dossier work starts, and nothing is read for it, until the host's head-selection barrier is down and Delta stands on the
        // checkpoint of the selected head (a delete, a swipe or a retraction moved the head; the host asks Delta to follow it first). Work that
        // cannot start in time is not dropped: it waits in the queue below and starts when the barrier is down.
        if (!await messageGateSettled()) return deferUntilSettled(key, defer, check, skipped);
        return await task();
    } finally {
        const left = (scanIntents.get(key) || 1) - 1;
        if (left > 0) scanIntents.set(key, left); else scanIntents.delete(key);
    }
}
// (timeline) Work that found the host's barrier still up after the wait is kept here, by chat and kind, and retried when the barrier is down: a
// reply's scan (its receipt), a queued drain, backfills, a reconcile, a targeted pass, an injection. It counts as dossier work meanwhile (a save point
// waits for it). If the host does not settle within HEAD_SETTLE_PROBLEM_MS a Problem tells the reader the work is pending; it is still not dropped. It
// is given up only when its chat is no longer the open one, or the reply it was for is no longer there (the new one has its own event).
const HEAD_SETTLE_PROBLEM_MS = 10 * 60 * 1000;
function deferredWorkPending(key) {
    for (const entry of deferredWork.values()) if (entry.key === key) return true;
    return false;
}
function deferUntilSettled(key, defer, check, answer) {
    if (!defer?.label || typeof defer.retry !== 'function') return headNotSettled(answer);
    const id = `${key}|${defer.label}`;
    const kept = deferredWork.get(id);
    if (kept) {
        // The same kind of work asked for again: one retry, with the newest request (a reconcile merges the options).
        kept.defer = { ...defer, options: defer.merge && kept.defer.options ? defer.merge(kept.defer.options, defer.options) : defer.options };
        kept.check = check;
        return answer;
    }
    const entry = { key, defer, check, since: Date.now(), told: false };
    deferredWork.set(id, entry);
    void (async () => {
        try {
            for (;;) {
                if (getChatKey() !== key) return;
                if (await messageGateSettled()) break;
                if (!entry.told && Date.now() - entry.since >= HEAD_SETTLE_PROBLEM_MS) {
                    entry.told = true;
                    const text = `NPC State Delta: Story Block has not finished bringing the story to the selected point for ${Math.round(HEAD_SETTLE_PROBLEM_MS / 60000)} minutes, so ${defer.what || 'a scan'} is still pending. It runs as soon as Story Block is ready.`;
                    console.warn(`[NPC State Delta] ${text}`);
                    globalThis.toastr?.warning?.(text);
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (getChatKey() !== key) return;
            deferredWork.delete(id);
            if (typeof entry.check === 'function' && !entry.check()) return;   // the reply it was for is gone: its replacement has its own event
            await entry.defer.retry(entry.defer.options);
        } catch (error) {
            console.warn('[NPC State Delta] deferred dossier work failed', error);
        } finally {
            if (deferredWork.get(id) === entry) deferredWork.delete(id);
        }
    })();
    return answer;
}
/** The state of reply `messageId` as it is now, as a test for a retry: the same text on the same line of the story. null for no reply. */
function replyGuard(messageId) {
    if (!Number.isInteger(messageId) || messageId < 0) return null;
    const chat = getContext().chat || [];
    const message = chat[messageId];
    const fingerprint = message ? fingerprintMessage(message) : '';
    const lineageKey = lineageCheckpointKey(chatLineage(chat), messageId);
    return () => {
        const now = getContext().chat || [];
        const current = now[messageId];
        return Boolean(current) && fingerprintMessage(current) === fingerprint && lineageCheckpointKey(chatLineage(now), messageId) === lineageKey;
    };
}
/** Whether dossier work is running, due or queued for the chat: an active operation, an intent, a queued automatic scan. */
function scanWorkPending(key = getChatKey()) {
    return isScanBusy(key) || (scanIntents.get(key) || 0) > 0 || pendingAutoScans.has(key) || deferredWorkPending(key);
}
/** Resolves true when no scan or dossier pass is in flight, due or queued for the open chat, false after `ms`. */
async function scanIdle(ms = 20000) {
    const key = getChatKey();
    const until = Date.now() + Math.max(0, Number(ms) || 0);
    while (scanWorkPending(key)) {
        if (Date.now() >= until) return false;
        await new Promise(resolve => setTimeout(resolve, 25));
        if (getChatKey() !== key) return true;
    }
    return true;
}


// (timeline participant) The entry points that start dossier work hold a scan intent for their whole run (see scanWorkPending).
// (timeline) Before a generation's prompt is built from the dossiers and the chat: the host's barrier is down and the gate has been asked. If it is
// not down in time the injection is built when it is (the host holds the generation meanwhile).
async function generationReady(key) {
    if (!await messageGateSettled()) {
        deferUntilSettled(key, { label: 'injection', what: 'the dossier injection', retry: async () => { await refreshMessageGate(); if (getChatKey() === key) updateInjection(); } }, null, false);
        return false;
    }
    await refreshMessageGate();
    return getChatKey() === key;
}
function headNotSettled(answer) {
    console.info('[NPC State Delta] the host has not settled the selected head (its barrier is still up), so no dossier work was started.');
    return answer;
}
function scanNow(options) {
    return withScanIntent(getChatKey(), () => scanNowInner(options), false, { label: `scan:${options?.messageId ?? 'latest'}:${options?.manual ? 'manual' : 'auto'}`, what: 'a dossier scan', retry: () => scanNow(options), guard: () => replyGuard(options?.messageId) });
}
function drainPendingAutoScan(chatKey) {
    return withScanIntent(chatKey, () => drainPendingAutoScanInner(chatKey), false, { label: 'drain', what: 'a queued dossier scan', retry: () => drainPendingAutoScan(chatKey) });
}
function processPendingBackfills(...args) {
    return withScanIntent(getChatKey(), () => processPendingBackfillsInner(...args), 0, { label: 'backfills', what: 'a dossier backfill', retry: () => processPendingBackfills(...args) });
}
function runTargetedDossierPass(job) {
    const key = job?.chatKey || getChatKey();
    return withScanIntent(key, () => runTargetedDossierPassInner(job), false, { label: `pass:${job?.id ?? job?.label ?? 'targeted'}`, what: 'a dossier pass', retry: () => runTargetedDossierPass(job) });
}
function handleAssistantMessageReceived(...args) {
    return withScanIntent(getChatKey(), () => handleAssistantMessageReceivedInner(...args), undefined, { label: `reply:${args[0]}`, what: 'the scan of a new reply', retry: () => handleAssistantMessageReceived(...args), guard: () => replyGuard(args[0]) });
}

function queueStateFileWrite(key = getChatKey(), delay = STATE_WRITE_DELAY) {
    if (!key || key === 'no-chat' || !isCanonicalChatKey(key) || !chatStateCache.has(key)) return;
    if (chatHydrationStatus(key) !== 'ready') {
        console.warn(`[NPC State Delta] refused to queue an unhydrated state write for ${key}.`);
        return;
    }
    markStateDirty(key);
    if (stateWriteTimers.has(key)) clearTimeout(stateWriteTimers.get(key));
    stateWriteTimers.set(key, setTimeout(() => {
        stateWriteTimers.delete(key);
        flushStateFile(key).catch(error => {
            console.error('[NPC State Delta] data-file persistence failed', error);
            globalThis.toastr?.error?.('NPC State Delta could not save its chat data file. Check the browser/server console.');
        });
    }, Math.max(0, Number(delay) || 0)));
}

async function flushStateFile(key = getChatKey()) {
    if (!key || key === 'no-chat' || !isCanonicalChatKey(key) || !chatStateCache.has(key)) return null;
    const retired = holdRetiredLocalWork(key);
    if (retired) throw retired;
    assertChatHydratedForWrite(key);
    if (stateWriteTimers.has(key)) {
        clearTimeout(stateWriteTimers.get(key));
        stateWriteTimers.delete(key);
    }
    const active = stateWritePromises.get(key);
    if (active) return active;

    const epoch = ownershipEpoch(key);
    let task;
    task = (async () => {
        let pointer = getSettings().dataFiles?.[key] || null;
        while (chatStateCache.has(key) && ownershipEpochCurrent(key, epoch)) {
            const writeVersion = Number(stateVersions.get(key) || 0);
            if (Number(persistedVersions.get(key) || -1) >= writeVersion) break;
            const snapshot = structuredClone(getChatState(key));
            const settings = getSettings();
            let written;
            try {
                written = await writeNpcStateDataFile({
                    chatKey: key,
                    state: snapshot,
                    recoveryState: () => chatStateCache.get(key) || snapshot,
                    isCurrent: () => ownershipEpochCurrent(key, epoch),
                    appVersion: NPC_STATE_VERSION,
                    pointer: settings.dataFiles?.[key] || pointer,
                    headers: requestHeaders(),
                });
            } catch (error) {
                if (error?.code === 'NPC_STATE_WRITE_CONFLICT' && ownershipEpochCurrent(key, epoch)) {
                    try { await reconcileCrossSessionWriteConflict(key, error, snapshot, settings.dataFiles?.[key] || pointer); }
                    catch (reconcileError) { console.warn('[NPC State Delta] write conflict recovery could not hydrate the newer canonical sidecar yet.', reconcileError); }
                }
                throw error;
            }
            if (!ownershipEpochCurrent(key, epoch)) return written;
            pointer = written;
            settings.dataFiles[key] = pointer;
            delete settings.sidecarTombstones[key];
            missingSidecarChats.delete(key);
            persistedVersions.set(key, writeVersion);
            updateHydratedStateMeta(key, written.revision, {
                lastCheckedAt: Date.now(),
                latestObservedServerRevision: written.revision,
                writerId: String(written.writerId || ''),
                latestObservedServerWriterId: String(written.writerId || ''),
            });
            persistSettings();
            if (Number(stateVersions.get(key) || 0) <= writeVersion) break;
        }
        return pointer;
    })().finally(() => {
        if (stateWritePromises.get(key) === task) stateWritePromises.delete(key);
    });
    stateWritePromises.set(key, task);
    return task;
}

async function settleStateFileWrite(key, { flush = false } = {}) {
    if (!key || key === 'no-chat') return null;
    if (stateWriteTimers.has(key)) {
        clearTimeout(stateWriteTimers.get(key));
        stateWriteTimers.delete(key);
    }
    if (flush && chatStateCache.has(key)) return flushStateFile(key);
    const active = stateWritePromises.get(key);
    if (active) return active;
    return getSettings().dataFiles?.[key] || null;
}

function persist(key = getChatKey()) {
    if (!requireReadyChatMutation('save chat dossier changes', key, { notify: false })) {
        console.warn(`[NPC State Delta] refused to persist unhydrated chat state for ${key}.`);
        return false;
    }
    persistSettings();
    queueStateFileWrite(key);
    return true;
}

function persistCritical(key = getChatKey()) {
    if (!requireReadyChatMutation('save chat dossier changes', key, { notify: false })) return false;
    persistSettings();
    markStateDirty(key);
    void flushStateFile(key).catch(error => {
        console.error('[NPC State Delta] critical data-file persistence failed', error);
        globalThis.toastr?.error?.('NPC State Delta could not immediately save a critical dossier change.');
    });
    return true;
}

// Like persistCritical, but resolves only once the sidecar write has finished, so a caller can
// report durable success (true) or a write that is still pending/failed (false).
async function persistCriticalDurable(key = getChatKey()) {
    if (!requireReadyChatMutation('save chat dossier changes', key, { notify: false })) return false;
    persistSettings();
    markStateDirty(key);
    try {
        await flushStateFile(key);
        return true;
    } catch (error) {
        console.error('[NPC State Delta] critical data-file persistence failed', error);
        return false;
    }
}

function commitBranchCheckpoint(state, messageId, reason = 'state') {
    // A checkpoint records the local chat as the lineage; on a stale chat that would truncate the
    // adopted dossier's newer history.
    if (staleHostActive()) return state;
    recordBranchCheckpoint(state, getContext().chat || [], messageId, reason);
    return state;
}

function seedBranchTracking(state = getChatState()) {
    const lineage = chatLineage(getContext().chat || []);
    if (!Array.isArray(state.lineage) || state.lineage.length === 0) state.lineage = lineage;
    if (!Array.isArray(state.checkpoints)) state.checkpoints = [];
    state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    return state;
}

function findLatestAssistantAtOrAfter(messageId) {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= Math.max(0, Number(messageId) || 0); i -= 1) {
        if (chat[i] && !chat[i].is_system && !chat[i].is_user && String(chat[i].mes || '').trim()) return i;
    }
    return -1;
}

function hostSwipeState() {
    try {
        const state = getContext().swipe?.state?.();
        return typeof state === 'string' && state ? state : 'none';
    } catch {
        return 'none';
    }
}

function isHostSwipeActive() {
    return hostSwipeState() !== 'none';
}

function branchOperationPriority(value) {
    return ({ auto: 0, edit: 1, delete: 2, swipe: 3 })[String(value || 'auto').toLowerCase()] ?? 0;
}

function mergeBranchOptions(base = {}, incoming = {}) {
    const next = { ...base, ...incoming };
    const a = base.explicitDivergence;
    const b = incoming.explicitDivergence;
    if (Number.isInteger(a) && Number.isInteger(b)) next.explicitDivergence = Math.min(a, b);
    else if (Number.isInteger(a)) next.explicitDivergence = a;
    else if (Number.isInteger(b)) next.explicitDivergence = b;
    const baseOperation = String(base.operation || 'auto').toLowerCase();
    const incomingOperation = String(incoming.operation || 'auto').toLowerCase();
    next.operation = branchOperationPriority(incomingOperation) >= branchOperationPriority(baseOperation)
        ? incomingOperation
        : baseOperation;
    next.rescan = Boolean(base.rescan || incoming.rescan);
    return next;
}

function queueSettledSwipeReconcile(options = {}) {
    const originKey = options.chatKey || getChatKey();
    if (originKey === 'no-chat') return;
    let next = { reason: 'message-swiped', rescan: true, ...options, operation: 'swipe', chatKey: originKey };

    // A normal branch timer must never be allowed to fire inside SillyTavern's swipe window.
    // Fold it into the swipe settlement instead.
    if (rt.branchReconcileTimer) {
        clearTimeout(rt.branchReconcileTimer);
        rt.branchReconcileTimer = null;
    }
    if (rt.branchReconcilePending) {
        next = mergeBranchOptions(rt.branchReconcilePending, next);
        rt.branchReconcilePending = null;
    }
    if (rt.swipeSettlementPending) next = mergeBranchOptions(rt.swipeSettlementPending, next);
    rt.swipeSettlementPending = next;

    const sequence = ++rt.swipeSettlementSequence;
    if (rt.swipeSettlementTimer) clearTimeout(rt.swipeSettlementTimer);
    const startedAt = Date.now();

    const poll = async () => {
        if (sequence !== rt.swipeSettlementSequence) return;
        if (getChatKey() !== originKey) {
            rt.swipeSettlementTimer = null;
            rt.swipeSettlementPending = null;
            rt.deferredSwipeMessageId = null;
            return;
        }
        if (isHostSwipeActive()) {
            if (Date.now() - startedAt >= SWIPE_SETTLE_TIMEOUT_MS) {
                rt.swipeSettlementTimer = null;
                rt.swipeSettlementPending = null;
                rt.deferredSwipeMessageId = null;
                console.warn('[NPC State Delta] swipe stayed active too long; branch rescan was skipped to avoid hijacking the host generation pipeline.');
                return;
            }
            rt.swipeSettlementTimer = setTimeout(poll, SWIPE_SETTLE_POLL_MS);
            return;
        }

        rt.swipeSettlementTimer = null;
        const pending = rt.swipeSettlementPending || {};
        rt.swipeSettlementPending = null;
        const receivedMessageId = Number.isInteger(rt.deferredSwipeMessageId) ? rt.deferredSwipeMessageId : null;
        rt.deferredSwipeMessageId = null;

        try {
            const reconciliation = await reconcileCurrentBranch({ ...pending, rescan: false, reason: `${pending.reason || 'message-swiped'}-settled` });
            if (reconciliation?.requiresRescan === false) return;
            const chat = getContext().chat || [];
            const received = Number.isInteger(receivedMessageId) ? chat[receivedMessageId] : null;
            if (received && !received.is_user && !received.is_system && String(received.mes || '').trim()) {
                await handleAssistantMessageReceived(receivedMessageId, {
                    bypassSwipeGuard: true,
                    forceBranchRescan: Boolean(pending.rescan),
                });
                return;
            }

            if (pending.rescan && getSettings().branchRescan !== false) {
                const targetAssistant = findLatestAssistantAtOrAfter(pending.explicitDivergence);
                if (targetAssistant >= 0) await scanNow({ manual: false, messageId: targetAssistant, allowDuringSwipe: true });
            }
        } catch (error) {
            console.warn('[NPC State Delta] settled swipe reconciliation failed', error);
        }
    };

    // The host emits MESSAGE_SWIPED before Generate('swipe'). Polling the host's own
    // swipe state keeps NPC State Delta completely out of that pre-generation gap.
    rt.swipeSettlementTimer = setTimeout(poll, 0);
}

function diagnosticSerializedBytes(value) {
    try {
        const text = JSON.stringify(value ?? null);
        return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
    } catch {
        return 0;
    }
}

function branchHistoryDiagnostic(state) {
    if (!state || typeof state !== 'object') return null;
    const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    const rollbackJournal = Array.isArray(state.rollbackJournal) ? state.rollbackJournal : [];
    const checkpointSizes = checkpoints.map(item => diagnosticSerializedBytes(item?.snapshot || {}) + 256);
    return {
        lineageVersion: Number(state.branchLineageVersion || 0),
        lineageMessages: Array.isArray(state.lineage) ? state.lineage.length : 0,
        currentNarrativeSnapshotBytes: diagnosticSerializedBytes(snapshotBranchState(state)),
        checkpointCount: checkpoints.length,
        checkpointBytes: checkpointSizes.reduce((sum, size) => sum + size, 0),
        largestCheckpointBytes: checkpointSizes.length ? Math.max(...checkpointSizes) : 0,
        checkpointBudgetBytes: BRANCH_SNAPSHOT_BUDGET_BYTES,
        checkpointMaxBytes: BRANCH_SNAPSHOT_MAX_BYTES,
        rollbackJournalEntries: rollbackJournal.length,
        rollbackJournalBytes: Number(state.rollbackJournalBytes || 0) || diagnosticSerializedBytes(rollbackJournal),
        rollbackJournalBudgetBytes: ROLLBACK_JOURNAL_BUDGET_BYTES,
        rollbackJournalCoverageMessages: Number(state.rollbackJournalCoverageMessages || 0),
        rollbackJournalBudgetExceeded: state.rollbackJournalBudgetExceeded === true,
    };
}

function recordBranchReconciliationEvent({ key, reason, operation, result, beforeNpcCount, previousLength, currentLength }) {
    if (!result) return;
    const state = result.state || null;
    branchReconciliationEvents.push({
        at: Date.now(),
        chatKey: key,
        reason: String(reason || 'branch'),
        operation: String(result.recoveryOperation || operation || 'auto'),
        relation: String(result.lineageRelation || 'unknown'),
        divergence: Number.isInteger(result.divergence) ? result.divergence : null,
        action: String(result.recoveryAction || (result.invalidated ? 'reconciled' : 'none')),
        invalidated: Boolean(result.invalidated),
        exactRestored: Boolean(result.exactRestored),
        requestedRecoveryMessageId: Number.isInteger(result.requestedRecoveryMessageId) ? result.requestedRecoveryMessageId : null,
        affectedAssistantMessages: Math.max(0, Number(result.affectedAssistantMessages || 0)),
        linearSuffixReplaySafe: result.linearSuffixReplaySafe !== false,
        recoveryBlockedByRetainedDescendants: Boolean(result.recoveryBlockedByRetainedDescendants),
        journalTargetReachable: Boolean(result.journalTargetReachable),
        exactCheckpointAvailable: Boolean(result.exactCheckpointAvailable),
        nearestOlderCheckpointMessageId: Number.isInteger(result.nearestOlderCheckpointMessageId) ? result.nearestOlderCheckpointMessageId : null,
        olderCheckpointRejected: Boolean(result.olderCheckpointRejected),
        recoveryDistance: Number.isInteger(result.recoveryDistance) ? result.recoveryDistance : null,
        requiresRescan: Boolean(result.requiresRescan),
        restoredFromMessageId: Number.isInteger(result.restoredFromMessageId) ? result.restoredFromMessageId : null,
        restoredFromJournal: Boolean(result.restoredFromJournal),
        restoredFromRoot: Boolean(result.restoredFromRoot),
        failClosed: Boolean(result.failClosed),
        revertedNpcCount: Array.isArray(result.deletedEffects?.reverted) ? result.deletedEffects.reverted.length : 0,
        removedNpcCount: Array.isArray(result.deletedEffects?.removed) ? result.deletedEffects.removed.length : 0,
        rewoundToBoundary: Boolean(result.rewoundToBoundary),
        linearHistoryPruned: Boolean(result.linearHistoryPruned),
        previousLength: Math.max(0, Number(previousLength || 0)),
        currentLength: Math.max(0, Number(currentLength || 0)),
        npcCountBefore: Math.max(0, Number(beforeNpcCount || 0)),
        npcCountAfter: Array.isArray(state?.npcs) ? state.npcs.length : 0,
        history: branchHistoryDiagnostic(state),
    });
    if (branchReconciliationEvents.length > BRANCH_RECONCILIATION_EVENT_LIMIT) {
        branchReconciliationEvents.splice(0, branchReconciliationEvents.length - BRANCH_RECONCILIATION_EVENT_LIMIT);
    }
}

async function maybeInheritKnownBranch() {
    const key = getChatKey();
    if (key === 'no-chat' || !isCanonicalChatKey(key)) return false;
    try {
        await ensureChatStateLoaded(key);
        if (getChatKey() !== key) return false;
        const current = getChatState(key);
        const chat = getContext().chat || [];
        const lineageAtStart = chatLineage(chat);
        // (Message tracking alone, never saved to a file of the chat's own, does not make a branch a chat of its own: Story Block's save point
        // opens the branch for a moment and goes back, which can leave it seeded in memory, and "Return here" must still carry the dossiers.)
        const unsaved = !getSettings().dataFiles?.[key]?.path;
        const isEmptyState = !current.npcs.length && !current.candidates.length && !current.dismissed.length && !current.checkpoints.length && (!current.lineage.length || unsaved);
        if (!isEmptyState) { branchInheritanceChecked.add(key); return false; }

        const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
        const mainChat = String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim();
        const parsed = parseQualifiedChatKey(key);
        const explicitParentKey = mainChat && parsed ? buildQualifiedChatKey(parsed.kind, parsed.ownerId, mainChat) : '';
        const hasExplicitParent = Boolean(explicitParentKey && explicitParentKey !== key);
        if (!hasExplicitParent) branchInheritanceChecked.add(key);
        if (!hasExplicitParent) return false;

        await ensureChatStateLoaded(explicitParentKey).catch(error => console.debug(`[NPC State Delta] explicit branch parent ${explicitParentKey} could not be hydrated.`, error));
        if (getChatKey() !== key || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;
        const parentState = chatStateCache.get(explicitParentKey);
        // The branch's own provenance: the hint was installed for the chat open at startup only, so a branch opened later (a save point's
        // "Return here") was matched against the wrong main chat and inherited nothing.
        setBranchProvenanceHint({ mainChat, currentKey: key });
        const inherited = bestAncestorState(parentState ? { [explicitParentKey]: parentState } : {}, key, chat);
        // (decided: inherited or nothing to inherit; a return because another chat was opened meanwhile decides nothing)
        branchInheritanceChecked.add(key);
        if (!inherited) return false;
        setChatState(key, { ...freshChatState(), ...inherited });
        queueStateFileWrite(key, 0);
        return true;
    } finally {
        evictDormantChatStates(key);
    }
}

/**
 * (timeline participant) Whether the open chat is a branch still waiting for its parent's dossiers: no dossier file of its own, its metadata
 * names a main chat, and branch inheritance has not run for it in this session. The participant mints no story line for such a chat.
 */
function branchInheritancePending(key = getChatKey()) {
    if (!isCanonicalChatKey(key) || branchInheritanceChecked.has(key)) return false;
    if (!missingSidecarChats.has(key) || getSettings().dataFiles?.[key]?.path) return false;
    const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
    return Boolean(String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim());
}


// After adopting another session's newer dossier, the local chat is stale when it does not contain
// that dossier's whole history: an older prefix, or older history plus a turn typed locally since.
function noteAdoptedDossier(key, state, writerId = '') {
    if (key !== getChatKey() || openingHostChats.has(key)) return;
    if (writerId && String(writerId) === currentWriterId()) return;
    const stored = Array.isArray(state?.lineage) ? state.lineage : [];
    const divergence = firstLineageDivergence(stored, chatLineage(getContext().chat || []));
    if (stored.length && divergence !== -1 && divergence < stored.length) staleHostChats.add(key);
}

// Messages this browser adds locally (a new turn, a reply) do not load the missing remote history,
// so only a host reload or a local chat that contains the whole adopted lineage clears the mark.
function staleHostActive(key = getChatKey()) {
    if (!staleHostChats.has(key) || key !== getChatKey()) return false;
    const stored = Array.isArray(getChatState(key)?.lineage) ? getChatState(key).lineage : [];
    const live = chatLineage(getContext().chat || []);
    if (live.length >= stored.length && [-1, stored.length].includes(firstLineageDivergence(stored, live))) {
        staleHostChats.delete(key);
        return false;
    }
    return true;
}

function staleHostPrefix(key, operation, explicitDivergence) {
    if (String(operation || 'auto') !== 'auto' || Number.isInteger(explicitDivergence)) return false;
    return staleHostActive(key);
}

async function reconcileCurrentBranch({ explicitDivergence = null, rescan = true, reason = 'branch', chatKey = null, operation = 'auto' } = {}) {
    const key = chatKey || getChatKey();
    if (key === 'no-chat' || getChatKey() !== key) return null;
    // (timeline) A head that moved is followed by the host first (Delta installs the checkpoint of the selected head); this reads Delta's state after.
    if (!await messageGateSettled()) {
        // Not dropped: it runs, with every request made meanwhile merged, when the barrier is down.
        return deferUntilSettled(key, { label: 'reconcile', what: 'a rollback after a deleted or swiped message', options: { explicitDivergence, rescan, reason, chatKey, operation }, merge: mergeBranchOptions, retry: options => reconcileCurrentBranch(options) }, null, null);
    }
    if (getChatKey() !== key) return null;
    const ctx = getContext();
    await ensureChatStateLoaded(key);
    if (getChatKey() !== key) return null;
    const before = getChatState(key);
    seedBranchTracking(before);
    const beforeNpcCount = Array.isArray(before.npcs) ? before.npcs.length : 0;
    const previousLength = Array.isArray(before.lineage) ? before.lineage.length : 0;
    const lineageBefore = chatLineage(ctx.chat || []);
    // The dossier can be newer than this browser's chat: another session wrote it after messages
    // this chat has not loaded yet. Until the host reloads the chat, a local chat that is only a
    // shorter prefix of that dossier is stale, not a deletion, so it must not roll the dossier back.
    if (staleHostPrefix(key, operation, explicitDivergence)) {
        recordBranchReconciliationEvent({
            key, reason, operation,
            result: { recoveryOperation: operation, lineageRelation: 'tail-truncation', recoveryAction: 'deferred-stale-chat', invalidated: false, divergence: lineageBefore.length },
            beforeNpcCount, previousLength, currentLength: lineageBefore.length,
        });
        return null;
    }
    const result = reconcileBranchState(before, ctx.chat || [], { explicitDivergence, operation, rewindMidDelete: getSettings().midDeleteRewind === true });
    if (getChatKey() !== key || firstLineageDivergence(lineageBefore, chatLineage(getContext().chat || [])) !== -1) return null;
    recordBranchReconciliationEvent({
        key, reason, operation, result, beforeNpcCount,
        previousLength, currentLength: lineageBefore.length,
    });
    if (!result.invalidated) {
        before.lineage = result.state.lineage;
        return result;
    }

    cancelScanOperation(key, reason);
    assistantReceipts.delete(key);
    setChatState(key, result.state);
    persist(key);
    renderDossier();
    updateInjection();
    // A message deleted from the middle keeps the dossiers (later messages depend on them), except
    // what the deleted message itself changed and nothing later touched, which is undone exactly.
    if (result.rewoundToBoundary) {
        globalThis.toastr?.info?.('NPC State Delta: a message was deleted from the middle of the chat, so every dossier was rewound to how it was just before it. Changes made by the messages after it were discarded.');
    } else if (result.failClosed && result.recoveryBlockedByRetainedDescendants && result.recoveryOperation === 'delete') {
        const names = list => {
            const values = (Array.isArray(list) ? list : []).map(item => item.name).filter(Boolean);
            return `${values.slice(0, 4).join(', ')}${values.length > 4 ? ` +${values.length - 4} more` : ''}`;
        };
        const reverted = result.deletedEffects?.reverted || [];
        const removed = result.deletedEffects?.removed || [];
        const parts = [];
        if (reverted.length) parts.push(`reverted what the deleted message changed for ${names(reverted)}`);
        if (removed.length) parts.push(`removed ${names(removed)}, who only appeared in it`);
        globalThis.toastr?.info?.(parts.length
            ? `NPC State Delta: a message was deleted from the middle of the chat. Later messages depend on the dossiers, so they were kept, but Delta ${parts.join(' and ')}. Anything a later message also changed was left as it is.`
            : 'NPC State Delta: a message was deleted from the middle of the chat. Later messages depend on the dossiers, so they were kept as they are; edit them manually if the deleted message had changed anything.');
    }

    const targetAssistant = findLatestAssistantAtOrAfter(result.divergence);
    const shouldRescan = result.requiresRescan !== undefined ? Boolean(result.requiresRescan) : !result.exactRestored;
    if (rescan && shouldRescan && getSettings().branchRescan !== false && targetAssistant >= 0) {
        if (getChatKey() !== key) return result;
        if (isScanBusy(key)) queueBranchRescan(targetAssistant, 0, key);
        else await scanNow({ manual: false, messageId: targetAssistant });
    }
    return result;
}

function queuePendingAutoScan(chatKey, messageId, reason = 'automatic') {
    if (!chatKey || chatKey === 'no-chat' || getChatKey() !== chatKey || !Number.isInteger(messageId) || messageId < 0) return false;
    const chat = getContext().chat || [];
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return false;
    const lineage = chatLineage(chat);
    const queued = {
        chatKey,
        messageId,
        reason,
        queuedAt: Date.now(),
        fingerprint: fingerprintMessage(message),
        lineageKey: lineageCheckpointKey(lineage, messageId),
    };
    const previous = pendingAutoScans.get(chatKey);
    if (!previous || messageId >= previous.messageId) pendingAutoScans.set(chatKey, queued);
    return true;
}

async function drainPendingAutoScanInner(chatKey) {
    if (!chatKey || getChatKey() !== chatKey || isScanBusy(chatKey) || isHostSwipeActive()) return false;
    const pending = pendingAutoScans.get(chatKey);
    if (!pending) return false;
    const chat = getContext().chat || [];
    const message = chat[pending.messageId];
    const lineage = chatLineage(chat);
    const currentFingerprint = message ? fingerprintMessage(message) : '';
    const currentLineageKey = lineageCheckpointKey(lineage, pending.messageId);
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()
        || pending.fingerprint !== currentFingerprint
        || pending.lineageKey !== currentLineageKey) {
        pendingAutoScans.delete(chatKey);
        return false;
    }
    pendingAutoScans.delete(chatKey);
    const succeeded = await scanNow({ manual: false, messageId: pending.messageId });
    if (succeeded && getChatKey() === chatKey && latestMessageId(true) === pending.messageId) {
        scheduleReplyBackfills(chatKey, pending.messageId);
    }
    return succeeded;
}

function queueBranchRescan(messageId, _attempt = 0, originKey = getChatKey()) {
    if (!queuePendingAutoScan(originKey, messageId, 'branch-rescan')) return;
    if (getChatKey() === originKey && !isScanBusy(originKey) && !isHostSwipeActive()) void drainPendingAutoScan(originKey);
}

function queueBranchReconcile(options = {}, delay = 90) {
    const originKey = options.chatKey || getChatKey();
    if (originKey === 'no-chat') return;
    options = { ...options, chatKey: originKey };
    if (isHostSwipeActive()) {
        queueSettledSwipeReconcile(options);
        return;
    }
    let next = { ...options };
    if (rt.branchReconcilePending?.chatKey && rt.branchReconcilePending.chatKey !== originKey) {
        if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
        rt.branchReconcileTimer = null;
        rt.branchReconcilePending = null;
    }
    if (rt.branchReconcilePending) next = mergeBranchOptions(rt.branchReconcilePending, next);
    rt.branchReconcilePending = next;
    if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
    rt.branchReconcileTimer = setTimeout(async () => {
        const pending = rt.branchReconcilePending || {};
        rt.branchReconcilePending = null;
        rt.branchReconcileTimer = null;
        try {
            if (pending.chatKey && getChatKey() !== pending.chatKey) return;
            await reconcileCurrentBranch(pending);
        } catch (error) {
            console.warn('[NPC State Delta] branch reconciliation failed', error);
        }
    }, delay);
}

function queueRecoveryGarbagePointer(pointer, reason = 'temporary-recovery-cleanup') {
    if (!pointer?.path) return false;
    const settings = getSettings();
    const key = `${String(reason || 'recovery')}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    settings.recoveryGarbage[key] = { ...structuredClone(pointer), queuedAt: Date.now(), reason: String(reason || 'recovery') };
    persistSettings();
    return true;
}

function stateLooksEmptyForLifecycleRename(state) {
    return lifecycleRenameStateIsEmpty(state);
}

function clearLifecycleCacheKey(key, reason = 'external-lifecycle') {
    if (!key || key === 'no-chat') return false;
    bumpOwnershipEpoch(key);
    cancelScanOperation(key, reason);
    if (stateWriteTimers.has(key)) {
        clearTimeout(stateWriteTimers.get(key));
        stateWriteTimers.delete(key);
    }
    chatStateCache.delete(key);
    hydratedChatKeys.delete(key);
    hydratedStateMeta.delete(key);
    freshnessChecks.delete(key);
    loadingChatStates.delete(key);
    hydrationErrors.delete(key);
    stateVersions.delete(key);
    persistedVersions.delete(key);
    stateWritePromises.delete(key);
    pendingAutoScans.delete(key);
    assistantReceipts.delete(key);
    chatCacheTouches.delete(key);
    return true;
}

async function loadLatestLifecycleState(key, pointer = null, inlineState = null, { fallbackOnMissing = false } = {}) {
    if (pointer?.path) {
        try {
            const payload = await readNpcStateDataFile(pointer, { expectedChatKey: key });
            if (payload && !payload.retired && payload.state) return structuredClone(payload.state);
            if (!fallbackOnMissing) return null;
        } catch (error) {
            if (!fallbackOnMissing) throw error;
            console.warn(`[NPC State Delta] lifecycle recovery could not read ${pointer.path}; falling back to the settled cache/inline state.`, error);
        }
    }
    if (hydratedChatKeys.has(key) && chatStateCache.has(key)) return structuredClone(getChatState(key));
    return inlineState && typeof inlineState === 'object' ? structuredClone(inlineState) : null;
}

async function removeDeletedChatState(rawId, kind = 'chat', ownerId = '') {
    const key = await resolveDeletedChatKey(rawId, kind, ownerId);
    if (!key) return false;
    const settings = getSettings();
    const canonical = { name: makeNpcStateDataFileName(key), path: `/user/files/${makeNpcStateDataFileName(key)}` };
    let pointer = settings.dataFiles?.[key] || canonical;
    let recoveryPointer = null;
    let retired = false;

    try {
        try { await settleStateFileWrite(key, { flush: true }); }
        catch (error) {
            if (error?.code !== 'NPC_STATE_WRITE_CONFLICT') throw error;
            console.info(`[NPC State Delta] delete observed a newer writer for ${key}; refreshing before retirement.`);
        }
        pointer = settings.dataFiles?.[key] || pointer;

        for (let attempt = 0; attempt < 4; attempt += 1) {
            const state = await loadLatestLifecycleState(key, pointer, { fallbackOnMissing: true });
            if (recoveryPointer?.path) {
                try { await deleteNpcStateDataFile(recoveryPointer, { headers: requestHeaders() }); } catch { queueRecoveryGarbagePointer(recoveryPointer, 'chat-lifecycle-temp'); }
                recoveryPointer = null;
            }
            if (state) {
                recoveryPointer = await writeNpcStateDataFile({
                    chatKey: key,
                    state,
                    appVersion: NPC_STATE_VERSION,
                    pointer: { name: makeNpcStateRecoveryFileName(key) },
                    operationKey: `delete-recovery:${key}:${Date.now()}:${attempt}`,
                    continuousRetry: false,
                    headers: requestHeaders(),
                });
            }
            if (!pointer?.path) { retired = true; break; }
            try {
                await retireNpcStateDataFile({ chatKey: key, pointer, reason: 'chat-deleted', appVersion: NPC_STATE_VERSION, headers: requestHeaders() });
                retired = true;
                break;
            } catch (error) {
                if (error?.retirementUncertain || error?.code !== 'NPC_STATE_WRITE_CONFLICT' || attempt >= 3) throw error;
                console.info(`[NPC State Delta] delete retirement raced another writer for ${key}; retrying from the newest revision.`);
            }
        }
        if (!retired) return false;
    } catch (error) {
        if (error?.retirementUncertain) {
            // The source may already be retired: keep and register the verified recovery copy so the
            // dossier stays restorable, like the character rename/delete transactions.
            if (recoveryPointer?.path) {
                settings.recoveryFiles[key] = { ...recoveryPointer, reason: 'chat-delete-retirement-uncertain', retiredAt: Date.now() };
                persistSettings();
                try { await saveHostSettings(); } catch (saveError) { console.warn(`[NPC State Delta] recovery registration for ${key} could not be persisted immediately.`, saveError); }
            }
            console.warn(`[NPC State Delta] chat deletion could not confirm retirement of ${key}; kept the recovery copy.`, error);
            throw error;
        }
        if (recoveryPointer?.path) {
            try { await deleteNpcStateDataFile(recoveryPointer, { headers: requestHeaders() }); } catch { queueRecoveryGarbagePointer(recoveryPointer, 'chat-lifecycle-temp'); }
        }
        console.warn(`[NPC State Delta] refused destructive retirement for ${key}; live ownership remains intact.`, error);
        throw error;
    }

    clearLifecycleCacheKey(key, 'chat-deleted');
    if (recoveryPointer) settings.recoveryFiles[key] = { ...recoveryPointer, reason: 'chat-deleted', retiredAt: Date.now() };
    settings.sidecarTombstones[key] = { reason: 'chat-deleted', at: Date.now() };
    delete settings.dataFiles[key];
    persistSettings();
    let tombstoneDurable = false;
    try {
        await saveHostSettings();
        tombstoneDurable = true;
    } catch (error) {
        console.warn(`[NPC State Delta] chat deletion tombstone for ${key} could not be synchronously persisted; the retired sidecar is being retained as the crash-safe marker.`, error);
    }
    if (tombstoneDurable && pointer?.path) {
        try { await deleteNpcStateDataFile(pointer, { headers: requestHeaders() }); }
        catch (error) { console.warn(`[NPC State Delta] retired sidecar for ${key} could not be physically deleted; the durable tombstone still prevents recovery.`, error); }
    }
    return true;
}

async function moveRenamedChatState(eventData = {}) {
    const oldId = String(eventData.oldFileName || '').replace(/\.jsonl$/i, '');
    const newId = String(eventData.newFileName || '').replace(/\.jsonl$/i, '');
    if (!oldId || !newId || oldId === newId) return false;
    const isGroup = eventData.groupId !== undefined && eventData.groupId !== null && String(eventData.groupId) !== '';
    const kind = isGroup ? 'group' : 'chat';
    const eventOwner = isGroup ? String(eventData.groupId || '') : String(eventData.avatarId || getCharacterOwnerId(getContext()) || '');
    const oldKey = resolveOwnedChatKey(oldId, kind, eventOwner);
    const parsedOld = parseQualifiedChatKey(oldKey);
    const newKey = buildQualifiedChatKey(kind, parsedOld?.ownerId || eventOwner, newId);
    if (!oldKey || !newKey) return false;

    const settings = getSettings();
    const oldPointerInitial = settings.dataFiles?.[oldKey] || null;
    if (!oldPointerInitial?.path && !chatStateCache.has(oldKey)) return false;

    let destinationPointer = settings.dataFiles?.[newKey] || null;
    let destinationState = null;
    if (destinationPointer?.path) {
        try { destinationState = await loadLatestLifecycleState(newKey, destinationPointer); }
        catch (error) { console.warn(`[NPC State Delta] rename could not verify destination ${newKey}.`, error); return false; }
    }
    const destinationCache = chatStateCache.get(newKey) || null;
    const destinationRepresentations = [destinationState, destinationCache].filter(value => value && typeof value === 'object');
    const destinationEphemeral = destinationRepresentations.every(stateLooksEmptyForLifecycleRename);
    if ((destinationPointer?.path || chatStateCache.has(newKey)) && !destinationEphemeral) {
        console.warn(`[NPC State Delta] refused to rename ${oldKey} onto existing non-empty state ${newKey}.`);
        return false;
    }

    try {
        try { await settleStateFileWrite(oldKey, { flush: true }); }
        catch (error) {
            if (error?.code !== 'NPC_STATE_WRITE_CONFLICT') throw error;
            console.info(`[NPC State Delta] rename observed a newer writer for ${oldKey}; the newest durable state will be moved.`);
        }

        let oldPointer = settings.dataFiles?.[oldKey] || oldPointerInitial;
        let state = null;
        let newPointer = destinationPointer;
        let recoveryPointer = null;
        let retired = false;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            state = await loadLatestLifecycleState(oldKey, oldPointer);
            if (!state) throw new Error(`NPC State Delta rename source ${oldKey} has no live state.`);

            newPointer = await writeNpcStateDataFile({
                chatKey: newKey,
                state,
                appVersion: NPC_STATE_VERSION,
                pointer: newPointer?.path ? newPointer : { name: makeNpcStateDataFileName(newKey) },
                continuousRetry: false,
                headers: requestHeaders(),
            });
            const verified = await readNpcStateDataFile(newPointer, { expectedChatKey: newKey });
            if (!verified?.state || verified.retired) throw new Error('NPC State Delta renamed sidecar verification failed.');

            if (recoveryPointer?.path) {
                try { await deleteNpcStateDataFile(recoveryPointer, { headers: requestHeaders() }); } catch { queueRecoveryGarbagePointer(recoveryPointer, 'chat-lifecycle-temp'); }
            }
            recoveryPointer = await writeNpcStateDataFile({
                chatKey: oldKey,
                state,
                appVersion: NPC_STATE_VERSION,
                pointer: { name: makeNpcStateRecoveryFileName(oldKey) },
                operationKey: `rename-recovery:${oldKey}:${Date.now()}:${attempt}`,
                continuousRetry: false,
                headers: requestHeaders(),
            });

            if (!oldPointer?.path) { retired = true; break; }
            try {
                await retireNpcStateDataFile({ chatKey: oldKey, pointer: oldPointer, reason: `renamed-to:${newKey}`, appVersion: NPC_STATE_VERSION, headers: requestHeaders() });
                retired = true;
                break;
            } catch (error) {
                if (error?.code !== 'NPC_STATE_WRITE_CONFLICT' || attempt >= 3) throw error;
                console.info(`[NPC State Delta] rename retirement raced another writer for ${oldKey}; refreshing and retrying.`);
            }
        }
        if (!retired) return false;

        clearLifecycleCacheKey(oldKey, 'chat-renamed');
        clearLifecycleCacheKey(newKey, 'chat-renamed-target');
        settings.recoveryFiles[oldKey] = { ...recoveryPointer, reason: `renamed-to:${newKey}`, retiredAt: Date.now() };
        settings.sidecarTombstones[oldKey] = { reason: `renamed-to:${newKey}`, at: Date.now() };
        settings.dataFiles[newKey] = newPointer;
        delete settings.sidecarTombstones[newKey];
        delete settings.dataFiles[oldKey];
        const installed = setChatState(newKey, state, { markLoaded: true });
        updateHydratedStateMeta(newKey, newPointer?.revision || 0, {
            hydratedAt: Date.now(),
            lastCheckedAt: Date.now(),
            latestObservedServerRevision: newPointer?.revision || 0,
            writerId: String(newPointer?.writerId || ''),
            latestObservedServerWriterId: String(newPointer?.writerId || ''),
        });
        persistedVersions.set(newKey, Number(stateVersions.get(newKey) || 0));
        persistSettings();
        let renameOwnershipDurable = false;
        try {
            await saveHostSettings();
            renameOwnershipDurable = true;
        } catch (error) {
            console.warn(`[NPC State Delta] renamed ownership for ${newKey} could not be synchronously persisted; the retired predecessor is being retained as a crash-safe marker.`, error);
        }
        if (renameOwnershipDurable && oldPointer?.path) {
            try { await deleteNpcStateDataFile(oldPointer, { headers: requestHeaders() }); }
            catch (error) { console.warn(`[NPC State Delta] retired rename predecessor for ${oldKey} could not be physically deleted.`, error); }
        }
        renderDossier();
        updateInjection();
        return true;
    } catch (error) {
        console.warn(`[NPC State Delta] transactional rename failed for ${oldKey}; original durable ownership remains recoverable and no tombstone was published.`, error);
        throw error;
    }
}


async function flushLifecycleOwner(kind = 'chat', ownerId = '') {
    const owner = String(ownerId || '').trim();
    if (!owner) return [];
    const keys = [...chatStateCache.keys()].filter(key => {
        const parsed = parseQualifiedChatKey(key);
        return parsed?.kind === kind && parsed.ownerId === owner;
    });
    const failures = [];
    for (const key of keys) {
        // A chat retired in this session has no live owner state to move; its dirty work stays
        // recovery-only instead of being flushed back over the retired marker.
        if (holdRetiredLocalWork(key)) continue;
        try { await settleStateFileWrite(key, { flush: true }); }
        catch (error) {
            failures.push({ key, error });
            console.warn(`[NPC State Delta] lifecycle flush could not settle ${key}; owner lifecycle will fail closed and retry later.`, error);
        }
    }
    if (failures.length) {
        const error = new AggregateError(failures.map(item => item.error), `NPC State Delta could not settle ${failures.length} owner chat(s) before lifecycle mutation.`);
        error.code = 'NPC_STATE_OWNER_FLUSH_INCOMPLETE';
        error.failures = failures.map(item => item.key);
        throw error;
    }
    return keys;
}

function invalidateLifecycleOwner(kind = 'chat', ownerId = '') {
    const owner = String(ownerId || '').trim();
    if (!owner) return 0;
    const keys = new Set([...chatStateCache.keys(), ...hydratedChatKeys, ...loadingChatStates.keys()]);
    let count = 0;
    for (const key of keys) {
        const parsed = parseQualifiedChatKey(key);
        if (parsed?.kind === kind && parsed.ownerId === owner && clearLifecycleCacheKey(key, 'owner-lifecycle')) count += 1;
    }
    return count;
}

function flushCurrentChatOnPageHide() {
    const key = getChatKey();
    if (key === 'no-chat' || !hydratedChatKeys.has(key) || !chatStateCache.has(key)) return;
    void settleStateFileWrite(key, { flush: true }).catch(error => console.debug('[NPC State Delta] page-hide flush deferred', error));
}

function noteScanFailure(label, error, chatKey = '') {
    if (!isEmptyScannerAnswer(error)) {
        console.error(`[NPC State Delta] ${label} failed`, error);
        return;
    }
    const key = String(chatKey || '');
    if (emptyAnswerChats.has(key)) return;
    emptyAnswerChats.add(key);
    console.warn(`[NPC State Delta] ${label}: the model answered nothing, so nothing changed; the next reply scans again. (Said once per chat.)`);
}


// The player message the next generation will answer: the chat tail when it is a user turn, or
// the user turn before an assistant reply that is not yet reflected by a scan (swipe/regenerate).
function pendingPlayerMessage(state) {
    const chat = getContext().chat || [];
    let tail = chat.length - 1;
    while (tail >= 0 && chat[tail]?.is_system) tail -= 1;
    if (tail < 0) return '';
    if (chat[tail]?.is_user) return cleanMessage(chat[tail]);
    if (replyScanned(state, tail)) return '';
    for (let i = tail - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        return chat[i]?.is_user ? cleanMessage(chat[i]) : '';
    }
    return '';
}

// Off-screen dossiers the player's pending message names. They join the next generation's
// injection so an NPC entering at the player's call keeps her dossier; presence is still
// decided by the scan of the reply.
function namedByPlayerNpcIds(state) {
    const message = pendingPlayerMessage(state);
    if (!message) return [];
    return (state?.npcs || [])
        .filter(npc => npc && !npc.present && !npc.archived && !isTerminalNpcDeath(npc) && npcNamedInText(npc, message, state.npcs))
        .map(npc => npc.id);
}

// (Story Block 2.18.0) The signature gear line of each pack cast dossier: { [npcId]: "Gear: A, B" }, only for those the host answers
// for. Empty without a host, on an older Story Block without `packs.castGear`, and while gear is off or the person is in the party.
function castGearLines(state) {
    const adapter = storySuiteV2Meters();
    if (!adapter?.castGearLine) return null;
    const lines = {};
    for (const npc of state?.npcs || []) {
        if (!npc?.id || !npc.castFrom?.key || !npc.name) continue;
        let line = '';
        try { line = adapter.castGearLine(npc.name); } catch { line = ''; }
        if (line) lines[npc.id] = line;
    }
    return Object.keys(lines).length ? lines : null;
}

// The live dossier injection under the current settings and scene defer (sent by updateInjection;
// tokens() measures the same text).
function liveInjectionText(state, settings, { namedNpcIds = namedByPlayerNpcIds(state), transcript = recentTranscript(4) } = {}) {
    // v1's World State carries the live mood and outfit the cards then leave out; v2's scene keeps
    // only the place and who is present, so under a v2 host the cards keep them.
    const sceneDeferred = defersArea('scene', settings.sourceOfTruth) && !storyBlockIsV2();
    const awayNotes = keyReturnNotes(state);
    const gearLines = castGearLines(state);
    return buildInjection(scenePresenceView(hostedMeterView(state.npcs)), transcript, state.turn, settings.injectLimit, settings.behaviorCriteria, settings.injectBudgetTokens, state.socialGraph, { namedNpcIds, customFieldNames: settings.customFieldNames, sceneDeferred, ...(awayNotes ? { awayNotes } : {}), ...(gearLines ? { gearLines } : {}) });
}

function updateInjection() {
    const settings = getSettings();
    const ctx = getContext();
    const injectionKey = getChatKey();
    const clear = reason => {
        rt.lastInjection = { text: '', reason, at: Date.now(), chatKey: injectionKey };
        ctx.setExtensionPrompt?.(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        ctx.setExtensionPrompt?.(CAPTURE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
        ctx.setExtensionPrompt?.(CAPTURE_RULES_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        rt.sentCaptureRules = '';
    };
    if (injectionKey !== 'no-chat' && chatHydrationStatus(injectionKey) !== 'ready') {
        clear(`This chat's dossiers are not loaded (status: ${chatHydrationStatus(injectionKey)}); nothing is sent until they are.`);
        return;
    }
    if (injectionKey === 'no-chat') return clear('No chat is open.');
    if (!settings.enabled) return clear('NPC State Delta is disabled.');
    const state = getChatState();
    // The recent story and who the player's message names: worked out once for both parts.
    const transcript = recentTranscript(4);
    const armed = rt.narrationCaptureArmed === injectionKey && narrationCaptureEnabled(settings);
    const rulesSent = narrationCaptureEnabled(settings) && !rt.captureRulesWithheld;
    if (!settings.inject && !armed && !rulesSent) return clear('"Inject present NPC state" is off.');
    const namedNpcIds = namedByPlayerNpcIds(state);
    const prompt = settings.inject ? liveInjectionText(state, settings, { namedNpcIds, transcript }) : '';
    // (1.2.17) The capture's context leaves out what this dossier already gives word for word.
    // (v2 hidden notes) The one-pass block is asked for layered notes (with the rules, byte-identical each reply) and for
    // the story events of present people's locked notes (with the context); the list is kept for the reply that carries it.
    const noteOptions = armed || rulesSent ? hostedNotePromptOptions(state, settings) : {};
    const builtParts = armed || rulesSent
        ? buildNarrationCaptureParts(scannerPromptOptions(state, settings, transcript, { dossierAbove: prompt, ...noteOptions }))
        : { rules: '', context: '' };
    const captureParts = { rules: armed || rulesSent ? builtParts.rules : '', context: armed ? builtParts.context : '' };
    const capture = captureParts.context;
    const present = (state.npcs || []).filter(npc => npc?.present && !npc?.archived);
    const depth = injectDepthOf(settings);
    rt.lastInjection = {
        text: prompt,
        reason: prompt ? '' : (!settings.inject ? '"Inject present NPC state" is off.' : (present.length ? 'No present NPC was selected for injection.' : 'No NPC is marked present in the latest scanned scene.')),
        at: Date.now(),
        chatKey: injectionKey,
        depth,
        namedByPlayer: (state.npcs || []).filter(npc => namedNpcIds.includes(npc.id)).map(npc => npc.name),
        captureChars: captureParts.rules.length + capture.length,
        captureRules: captureParts.rules,
        captureContext: capture,
        captureEventWatch: armed ? (noteOptions.eventWatch || []) : [],
    };
    ctx.setExtensionPrompt?.(PROMPT_KEY, prompt, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);
    // Replaced on every build and emptied when not armed, so a spent reminder is never sent again;
    // the rules go and come with it (only armed replies carry them, byte-identical each time).
    ctx.setExtensionPrompt?.(CAPTURE_PROMPT_KEY, capture, extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
    ctx.setExtensionPrompt?.(CAPTURE_RULES_KEY, captureParts.rules, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    if (!captureParts.rules) rt.sentCaptureRules = '';
}

const OWN_REQUEST = /NPC State Delta's (?:isolated|targeted)|isolated relationship evaluator|Private NPC dossier scanner/;
function holdCaptureRules() {
    const ctx = getContext();
    const rules = String(rt.lastInjection.captureRules || '');
    rt.sentCaptureRules = rules && typeof ctx.substituteParams === 'function' ? ctx.substituteParams(rules) : rules;
}
function keepCaptureRules(eventData) {
    const rules = String(rt.sentCaptureRules || '').trim();
    if (!rules || eventData?.dryRun === true || !Array.isArray(eventData?.chat)) return;
    const chat = eventData.chat;
    if (chat.some(message => typeof message?.content === 'string' && message.content.includes(rules))) return;
    if (chat.some(message => typeof message?.content === 'string' && OWN_REQUEST.test(message.content))) return;
    if ((getContext().chat || []).some(message => message && !message.is_user && !message.is_system) && !chat.some(message => message?.role === 'assistant')) return;
    let at = 0;
    while (at < chat.length && chat[at]?.role === 'system') at += 1;
    chat.splice(at, 0, { role: 'system', content: rules });
}

// (1.2.16) Earlier versions' prompt keys, emptied once on load.
function clearLegacyPromptKeys() {
    const ctx = getContext();
    for (const key of LEGACY_PROMPT_KEYS) ctx.setExtensionPrompt?.(key, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

function injectionPreview() {
    const settings = getSettings();
    const state = getChatKey() === 'no-chat' ? { npcs: [] } : getChatState();
    const text = String(rt.lastInjection.text || '');
    const lines = text.split('\n');
    const injectedNpcs = lines.map(line => line.match(/^- (.+?)(?: \(named by player\))?: IDENTITY/)?.[1]).filter(Boolean);
    const referencedNpcs = lines.map(line => line.match(/^- (.+?) \((?:mentioned, not present|deceased)/)?.[1]).filter(Boolean);
    return {
        sending: Boolean(text),
        reason: rt.lastInjection.reason || '',
        placement: (rt.lastInjection.depth ?? injectDepthOf(settings)) === 0
            ? 'In chat as a system message at the end, after your latest message (depth 0)'
            : `In chat as a system message, ${rt.lastInjection.depth ?? injectDepthOf(settings)} message(s) from the end`,
        capturePlacement: 'One-pass capture: its rules in the system prompt (unchanged reply to reply), its context and reminder in their own system message at the very end (depth 0)',
        builtAt: rt.lastInjection.at ? new Date(rt.lastInjection.at).toISOString() : '',
        presentNpcs: (state.npcs || []).filter(npc => npc?.present && !npc?.archived).map(npc => npc.name),
        namedByPlayer: (rt.lastInjection.namedByPlayer || []).filter(name => injectedNpcs.includes(name)),
        injectedNpcs,
        referencedNpcs,
        chars: text.length,
        estimatedTokens: Math.ceil(text.length / 4),
        budgetTokens: Number(settings.injectBudgetTokens) || 0,
        captureChars: Number(rt.lastInjection.captureChars) || 0,
        text,
    };
}

function queueNpcBackfillInState(state, npcId, label, requestedMessageId = null, options = {}) {
    const reason = String(options?.reason || '').trim();
    if (!state || !npcId || !String(label || '').trim() || !['missed-participant', 'new-admission'].includes(reason)) return state;
    if (!Array.isArray(state.pendingBackfills)) state.pendingBackfills = [];
    const cleanLabel = String(label || '').trim().slice(0, 120);
    state.pendingBackfills = state.pendingBackfills.filter(item => item?.npcId !== npcId);
    state.pendingBackfills.push({
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason,
        npcId: String(npcId).slice(0, 100),
        label: cleanLabel,
        requestedMessageId: Number.isInteger(requestedMessageId) ? requestedMessageId : null,
        preserveLiveState: options?.preserveLiveState === true,
        silent: options?.silent === true,
        requestedAt: Date.now(),
        attempts: 0,
        lastAttemptAt: 0,
    });
    if (state.pendingBackfills.length > 100) state.pendingBackfills.splice(0, state.pendingBackfills.length - 100);
    return state;
}

function backfillScanMatchesTarget(npc, request) {
    if (!npc || !request) return false;
    if (npc.id && request.npcId && String(npc.id) === String(request.npcId)) return true;
    if (npcMatchesLabel(npc, request.label)) return true;
    const target = normalizeName(request.label);
    if (!target) return false;
    const labels = [npc.name, ...(npc.aliases || [])].map(normalizeName).filter(Boolean);
    if (labels.some(label => label === target || label.startsWith(`${target} `) || target.startsWith(`${label} `))) return true;
    // A role names its owner only for a role-labelled target ("clerk" for "Gate Clerk"); a role that
    // merely mentions the target ("Assistant to Mira Deep") belongs to someone else.
    const role = normalizeName(npc.role);
    return Boolean(role && role !== target && target.includes(role));
}

// A returned row is admissible for a single-target request only if no explicit identity field
// contradicts the target: another roster member's id or name, or (for a proper-named target) a name
// that is neither the target's label nor an expansion of it. Interim (role-labelled) targets may be
// renamed by a revealed proper name.
function rowContradictsTarget(row, target, roster = []) {
    if (!row || !target) return true;
    const others = (Array.isArray(roster) ? roster : []).filter(npc => npc && npc.id !== target.id);
    const rowId = String(row.id || '').trim();
    if (rowId && rowId !== String(target.id) && others.some(npc => String(npc.id) === rowId)) return true;
    const rowName = String(row.name || '').trim();
    if (!rowName) return false;
    if (npcMatchesLabel(target, rowName)) return false;
    if (others.some(npc => npcMatchesLabel(npc, rowName))) return true;
    const key = normalizeName(rowName);
    const expansion = [target.name, ...(target.aliases || [])].map(normalizeName).filter(Boolean)
        .some(label => key.startsWith(`${label} `) || label.startsWith(`${key} `));
    if (expansion) return false;
    return String(target.identityKind || 'proper_name') === 'proper_name';
}

// Single-target channel scope must agree with what the merge will mutate. A profile row binds to the
// target only when no explicit identity field contradicts it (an exact id with another NPC's name is
// a contradiction); it is rewritten to the target's id and name so later name-based matching cannot
// reach the other NPC. An edge endpoint resolves like social.parseScanEdges (explicit id first, then
// label); an endpoint whose id and label name different people rejects the edge.
function profileRowBindsToTarget(row, target, roster = []) {
    if (!row || typeof row !== 'object' || !target) return false;
    const rowId = String(row.id || '').trim();
    if (rowId && rowId !== String(target.id)) return false;
    if (!rowId && !String(row.name || '').trim()) return false;
    return !rowContradictsTarget(row, target, roster);
}

function edgeTouchesResolvedTarget(edge, target, roster = []) {
    if (!edge || typeof edge !== 'object' || !target) return false;
    const npcs = (Array.isArray(roster) ? roster : []).some(npc => String(npc?.id || '') === String(target.id)) ? roster : [...(roster || []), target];
    const endpoint = (idValue, labelValue) => {
        const id = String(idValue || '').trim();
        const label = String(labelValue || '').trim();
        const resolved = resolveNpcReference(npcs, id || label);
        if (resolved && id && label && String(resolved.id) === id && rowContradictsTarget({ name: label }, resolved, npcs)) return { contradiction: true };
        return { npc: resolved };
    };
    const a = endpoint(edge.aId ?? edge.a_id, edge.a ?? edge.from ?? edge.source);
    const b = endpoint(edge.bId ?? edge.b_id, edge.b ?? edge.to ?? edge.target);
    if (a.contradiction || b.contradiction) return false;
    return String(a.npc?.id || '') === String(target.id) || String(b.npc?.id || '') === String(target.id);
}

function scopeProfileUpdatesToTarget(parsed, target, roster = []) {
    const rawProfiles = Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed?.profile_updates) ? parsed.profile_updates : []);
    parsed.profileUpdates = rawProfiles.filter(row => profileRowBindsToTarget(row, target, roster)).map(row => ({ ...row, id: target.id, name: target.name }));
    delete parsed.profile_updates;
    return parsed.profileUpdates;
}

// A single-target request may accept its only returned row even when the model changed the label
// (e.g. expanded a short name), but never a row that explicitly identifies someone else: that
// would write another NPC's lifecycle and profile into the requested dossier.
function soleRowMayBeTarget(row, { npcId = '', labels = [] } = {}, roster = []) {
    if (!row || typeof row !== 'object') return false;
    const rowName = String(row.name || '').trim();
    const targetLabels = labels.map(label => String(label || '').trim()).filter(Boolean);
    if (rowName) {
        const rowRecord = { name: rowName, aliases: Array.isArray(row.aliases) ? row.aliases : [] };
        return targetLabels.some(label => backfillScanMatchesTarget(rowRecord, { npcId: '', label }));
    }
    const rowId = String(row.id || '').trim();
    return !(rowId && rowId !== String(npcId) && roster.some(npc => String(npc?.id || '') === rowId));
}

function transcriptMentionsBackfillTarget(transcript, label) {
    const target = normalizeName(label);
    const haystack = normalizeName(transcript);
    if (!target || !haystack) return false;
    return (` ${haystack} `).includes(` ${target} `);
}


function dossierLabelsMatch(npc, candidateName) {
    const candidate = normalizeName(candidateName);
    if (!candidate) return false;
    const labels = [npc?.name, ...(npc?.aliases || [])].map(normalizeName).filter(Boolean);
    return labels.some(label => label === candidate || label.startsWith(`${candidate} `) || candidate.startsWith(`${label} `));
}

function meguminDossierBlocksInMessage(npc, raw, messageId) {
    const found = [];
    const tagged = /<(New_NPC|NPC_Update)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let match;
    while ((match = tagged.exec(raw)) !== null) {
        const attr = String(match[2] || '');
        const nameMatch = attr.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? '').replace(/\*\*/g, '').trim();
        if (!dossierLabelsMatch(npc, name)) continue;
        found.push({ messageId, at: match.index, kind: match[1].toLowerCase() === 'new_npc' ? 'new' : 'update', text: match[0].trim() });
    }

    const details = /<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi;
    while ((match = details.exec(raw)) !== null) {
        const whole = match[0];
        const summary = whole.match(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i)?.[1] || '';
        const plain = summary.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const nameMatch = plain.match(/(?:New NPC|Updated NPC)\s*:\s*(.+)$/i);
        if (!nameMatch || !dossierLabelsMatch(npc, nameMatch[1].trim())) continue;
        found.push({ messageId, at: match.index, kind: /updated npc/i.test(plain) ? 'update' : 'new', text: whole.trim() });
    }
    return found.sort((a, b) => a.at - b.at);
}

export function findMeguminDossierSources(npc, chat = activeChat(getContext().chat || [])) {
    if (!npc) return [];
    const newerUpdates = [];
    let base = null;

    // Search newest-first and stop at the latest matching base dossier. Older chat
    // cannot affect the import once that base is found, so large roleplays stay cheap.
    for (let messageId = chat.length - 1; messageId >= 0; messageId -= 1) {
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system) continue;
        const matches = meguminDossierBlocksInMessage(npc, String(message.mes || ''), messageId);
        if (!matches.length) continue;
        const latestBase = [...matches].reverse().find(item => item.kind === 'new') || null;
        if (latestBase) {
            base = latestBase;
            newerUpdates.push(...matches.filter(item => item.kind === 'update' && item.at >= latestBase.at));
            break;
        }
        newerUpdates.push(...matches.filter(item => item.kind === 'update'));
    }

    const chronological = newerUpdates
        .sort((a, b) => a.messageId - b.messageId || a.at - b.at)
        .filter((item, index, list) => list.findIndex(other => other.messageId === item.messageId && other.text === item.text) === index)
        .map(({ at, ...item }) => item);
    if (!base) return chronological.slice(-6);
    const cleanBase = { messageId: base.messageId, kind: base.kind, text: base.text };
    return [cleanBase, ...chronological.slice(-5)];
}

function setNpcDossierScanIndicator(npcId, busy) {
    const id = String(npcId || '');
    document.querySelectorAll?.(`.npc-state-delta-scan-dossier[data-npc-id="${globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/"/g, '\\"')}"]`)?.forEach?.(button => {
        button.classList?.toggle?.('npc-state-delta-busy', Boolean(busy));
        if (button.setAttribute) button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
}

async function prepareCanonicalScanBase(key, label = 'scan') {
    try {
        await settleStateFileWrite(key, { flush: true });
        await ensureHydratedStateFresh(key, { reason: `${label}-start` });
        if (staleHostActive(key)) {
            globalThis.toastr?.warning?.('NPC State Delta: this chat has not loaded the newest messages another session added, so scanning it would roll the dossier back. Reload the chat first.');
            return false;
        }
        return getChatKey() === key && chatHydrationStatus(key) === 'ready';
    } catch (error) {
        console.info(`[NPC State Delta] ${label} did not start because its canonical server base could not be established.`, error);
        return false;
    }
}

// ---- The targeted dossier pass (cleanup step 8) ----
// The Megumin dossier import (scanNpcDossier), Refresh (refreshNpcFromChat) and backfill
// (backfillNpcFromHistory) each read one source for one NPC and may change only that NPC. They share
// one runner: the scan's stale rule (a reply another extension rewrote in place is still the source),
// the same isolation (every other dossier is put back verbatim after the merge), terminal-death
// protection, a diagnostics receipt and, while hosted, the relationship forward to Story Block's slice.
// Each kind keeps its own source, prompt, row scoping, merge options and messages.
function targetedPassMetrics(label, { startedAt, prompt, raw, retried, parsed, merged = null, localEdges = [] }) {
    return {
        label,
        durationMs: Math.max(0, Math.round((performance.now?.() ?? Date.now()) - startedAt)),
        promptChars: prompt.length,
        responseChars: String(raw ?? '').length,
        retried: Boolean(retried),
        relationshipPass: false,
        relationshipTargets: 0,
        relationshipResponseChars: 0,
        relationshipRetried: false,
        relationshipEdges: merged ? (parsed.keyRelationshipEdges || []).length : 0,
        relationshipEdgeFallbacks: localEdges.length,
        profileUpdates: merged ? (parsed.profileUpdates || []).length : 0,
        profileApplied: Number(merged?.report?.profileUpdateStats?.applied || 0),
        profileEvidenceAdded: Number(merged?.report?.profileUpdateStats?.evidenceAdded || 0),
        profileDevelopment: Array.isArray(merged?.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [],
        at: Date.now(),
    };
}

// The single returned row a targeted pass may take for its target: one that names it, else the only
// row when it may be the target (`soleRowAllowed`), never one that explicitly identifies someone else.
function targetedRowFor(returned, target, roster, { npcId = target?.id, label = target?.name, labels = [], soleRowAllowed = true } = {}) {
    let match = returned.find(npc => backfillScanMatchesTarget(npc, { npcId, label }));
    if (!match && returned.length === 1 && soleRowAllowed && soleRowMayBeTarget(returned[0], { npcId, labels }, roster)) match = returned[0];
    return match && !rowContradictsTarget(match, target, roster) ? match : null;
}

function endTargetedRewriteTolerance(messageId) {
    for (const operation of runningTargetedPasses) {
        if (!Number.isInteger(messageId) || operation.sourceMessageId === messageId) operation.sourceMessageId = null;
    }
}

async function runTargetedDossierPassInner(job) {
    const { chatKey, ctx, id, label, prompt, systemPrompt, metricsLabel } = job;
    await refreshMessageGate();
    const lineage = chatLineage(ctx.chat || []);
    const boundMessageId = latestMessageId(true);
    const startedAt = performance.now?.() ?? Date.now();
    const scanStateVersion = Number(stateVersions.get(chatKey) || 0);
    const operation = beginScanOperation(chatKey, label, { npcId: id, indicator: job.indicator });
    if (!operation) {
        job.onBusy?.();
        return false;
    }
    operation.sourceLineage = lineage;
    // (1.2.9, as the scan) The latest reply rewritten in place by another extension is still the source.
    operation.sourceMessageId = boundMessageId >= 0 ? boundMessageId : null;
    runningTargetedPasses.add(operation);
    setScanIndicator(true);
    job.setIndicator?.(true);
    try {
        const { parsed, raw, retried } = await generateParsedNpcJson(ctx, {
            systemPrompt, prompt, responseLength: BACKFILL_RESPONSE_LENGTH, label, requestScope: operation.requestScope,
        });
        if (!scanOperationCurrent(chatKey, operation) || !await scanCanonicalBaseCurrent(chatKey, operation, job.staleLabel)) {
            console.info(`[NPC State Delta] discarded expired, superseded, or stale-canonical ${job.staleLabel}.`);
            return false;
        }
        if (getChatKey() !== chatKey || lineageMoved(lineage, chatLineage(getContext().chat || []), operation.sourceMessageId)
            || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
            job.onStale();
            return false;
        }
        // (v2 hidden notes) Story events the pass was told to look for: sent whatever else the answer holds.
        if (job.notes?.watch?.length) forwardSecretEventsToHost(job.notes.watch, parsed?.secretEvents, operation.chatHead);
        const latest = getChatState(chatKey);
        const liveBefore = latest.npcs.find(npc => npc.id === id) || null;
        const scoped = job.scope(parsed, { latest, liveBefore });
        if (!scoped.ok) {
            if (scoped.noChange) {
                const metrics = targetedPassMetrics(metricsLabel, { startedAt, prompt, raw, retried, parsed, localEdges: scoped.localEdges });
                if (job.reportsScanMetrics) rt.lastScanMetrics = metrics;
                recordScanDiagnostics(chatKey, metrics, parsed, null, { targeted: true, npcIds: [id], sourceMessageId: latestMessageId(true) });
            }
            return scoped.result;
        }
        const settings = getSettings();
        const targetMessageId = Number.isInteger(job.messageId) ? job.messageId : latestMessageId(true);
        const merged = mergeScanResult(latest, parsed, {
            maxNpcs: settings.maxNpcs,
            excludeNames: [...currentExclusions(), ...(latest.dismissed || [])],
            turn: latest.turn,
            sourceMessageId: targetMessageId,
            scenePresent: scenePresentAt(targetMessageId),
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
            storyDay: storyDayAt(targetMessageId),
            customFieldNames: settings.customFieldNames,
            relationshipBaseline: settings.relationshipBaseline,
            relationshipCaps: settings.relationshipCaps,
            autoArchiveDeaths: settings.autoArchiveDeaths !== false,
            autoReactivateArchived: settings.autoReactivateArchived !== false,
            admissionMode: settings.admissionMode,
            preservePresence: true,
            skipRelationshipUpdate: true,
            ...job.mergeOptions,
        });
        // (I-17) One NPC only: social-edge and alias machinery may run inside the merge, but every other
        // dossier is put back exactly as it was.
        const latestById = new Map((latest.npcs || []).map(npc => [npc.id, structuredClone(npc)]));
        merged.state.npcs = (merged.state.npcs || []).map(npc => (npc.id === id ? npc : (latestById.get(npc.id) || npc)));
        const result = merged.state.npcs.find(npc => npc.id === id);
        if (!result) return false;
        // (v2 hidden notes) A backfill of a dossier that is new: the layered notes the model wrote for it.
        if (job.notes?.layered) attachGeneratedSecrets(merged.state, [id], parsed);
        job.afterMerge?.(result, { liveBefore, scoped, merged });
        if (liveBefore) Object.assign(result, protectTerminalNpc(liveBefore, result));
        if (!await scanCanonicalBaseCurrent(chatKey, operation, `${job.staleLabel} final commit`)) {
            job.onLateStale?.();
            return false;
        }
        if (targetMessageId >= 0) {
            job.beforeCheckpoint?.(merged.state, result, targetMessageId);
            commitBranchCheckpoint(merged.state, targetMessageId, job.checkpoint);
        }
        setChatState(chatKey, merged.state);
        forwardRelationshipChangesToHost(latest.npcs, merged.state.npcs, targetMessageId, operation.chatHead);
        persist();
        renderDossier();
        updateInjection();
        // (I-19) Every kind leaves a diagnostics receipt; only Refresh reports as the last scan's metrics.
        const metrics = targetedPassMetrics(metricsLabel, { startedAt, prompt, raw, retried, parsed, merged, localEdges: scoped.localEdges });
        if (job.reportsScanMetrics) rt.lastScanMetrics = metrics;
        recordScanDiagnostics(chatKey, metrics, parsed, merged.report, { targeted: true, npcIds: [id], sourceMessageId: targetMessageId });
        console.info(`[NPC State Delta] ${metricsLabel} metrics`, metrics);
        return job.onDone(getChatState(chatKey).npcs.find(npc => npc.id === id));
    } catch (error) {
        return job.onError(error);
    } finally {
        runningTargetedPasses.delete(operation);
        const owned = scanOperationCurrent(chatKey, operation);
        endScanOperation(chatKey, operation);
        if (getChatKey() === chatKey) setScanIndicator(isScanBusy(chatKey));
        if (owned) job.setIndicator?.(false);
        updateInjection();
    }
}

// The single-target channels besides the NPC row: profile updates bound to the target, and social
// edges touching it.
function scopeTargetedChannels(parsed, target, roster) {
    scopeProfileUpdatesToTarget(parsed, target, roster);
    parsed.keyRelationshipEdges = (Array.isArray(parsed.keyRelationshipEdges) ? parsed.keyRelationshipEdges : (Array.isArray(parsed.key_relationship_edges) ? parsed.key_relationship_edges : []))
        .filter(edge => edgeTouchesResolvedTarget(edge, target, roster));
    delete parsed.key_relationship_edges;
}

async function scanNpcDossier(npcId) {
    const id = String(npcId || '').trim();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!id || chatKey === 'no-chat') return false;
    try { await ensureChatStateLoaded(chatKey); } catch (error) { globalThis.toastr?.warning?.(`NPC State Delta: cannot scan this dossier until the canonical server state is available. ${error?.message || error}`); return false; }
    if (getChatKey() !== chatKey || !requireReadyChatMutation('scan a dossier', chatKey)) return false;
    if (isScanBusy(chatKey)) {
        globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    if (!await prepareCanonicalScanBase(chatKey, 'dossier import')) return false;
    // (timeline) The import reads only the messages the story stands on: the gate is asked before the chat is read, and a faded one reads as hidden.
    await refreshMessageGate();
    if (getChatKey() !== chatKey) return false;
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === id);
    if (!existing) return false;
    const sources = findMeguminDossierSources(existing, activeChat(ctx.chat || []));
    if (!sources.length) {
        globalThis.toastr?.info?.(`NPC State Delta: no matching Megumin dossier block found for ${existing.name}; scanning recent story context instead.`);
        return backfillNpcFromHistory({ npcId: existing.id, label: existing.name, requestedAt: Date.now() }, latestMessageId(true));
    }
    const sourceText = sources.map(item => `[message ${item.messageId + 1} · ${item.kind}]\n${item.text}`).join('\n\n');
    const prompt = buildDossierImportPrompt({
        dossierText: sourceText,
        targetName: existing.name,
        existingNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        // (I-13) The configured custom fields, as the merge already accepts them from the import.
        customFieldNames: getSettings().customFieldNames,
    });
    return runTargetedDossierPass({
        chatKey, ctx, id, prompt,
        label: `dossier import for ${existing.name}`,
        systemPrompt: "You are NPC State Delta's isolated structured dossier importer. Use only the supplied dossier payload. Return only the requested JSON object.",
        indicator: 'dossier',
        staleLabel: 'dossier import',
        checkpoint: 'dossier-import',
        metricsLabel: 'dossier-import',
        setIndicator: busy => setNpcDossierScanIndicator(id, busy),
        onBusy: () => globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.'),
        onStale: () => globalThis.toastr?.info?.('NPC State Delta: chat changed during dossier import; stale result was discarded.'),
        scope: (parsed, { latest }) => {
            const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
            const match = targetedRowFor(returned, existing, latest.npcs, { labels: [existing.name, ...(existing.aliases || [])] });
            if (!match) {
                globalThis.toastr?.warning?.(`NPC State Delta: the dossier importer did not return ${existing.name}.`);
                return { ok: false, result: false };
            }
            parsed.npcs = [{
                ...match,
                id,
                present: Boolean(existing.present),
                worldActive: Boolean(existing.worldActive) && !Boolean(existing.present),
                relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                relationshipChangeReason: '',
            }];
            scopeTargetedChannels(parsed, existing, latest.npcs);
            return { ok: true };
        },
        mergeOptions: { developmentContext: sourceText, userDevelopmentContext: sourceText },
        onDone: saved => {
            globalThis.toastr?.success?.(`NPC State Delta: imported ${saved?.name || existing.name} from ${sources.length} Megumin dossier block${sources.length === 1 ? '' : 's'}.`);
            return true;
        },
        onError: error => {
            console.error('[NPC State Delta] structured dossier import failed', error);
            globalThis.toastr?.warning?.(`NPC State Delta dossier import failed for ${existing.name}: ${error?.message || error}`);
            return false;
        },
    });
}

function setNpcChatRefreshIndicator(npcId, busy) {
    const id = String(npcId || '');
    const selectorId = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/"/g, '\\"');
    document.querySelectorAll?.(`.npc-state-delta-refresh-chat[data-npc-id="${selectorId}"]`)?.forEach?.(button => {
        button.classList?.toggle?.('npc-state-delta-busy', Boolean(busy));
        if (button.setAttribute) button.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (button.innerHTML !== undefined) button.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing from chat...'
            : '<i class="fa-solid fa-arrows-rotate"></i> Refresh from Chat';
    });
}

function syncOpenNpcEditorFields(npc) {
    if (!npc || !editorIsMounted()) return;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
    set('npc_state_delta_edit_name', npc.name || '');
    set('npc_state_delta_edit_role', npc.role || '');
    set('npc_state_delta_edit_aliases', (npc.aliases || []).join('\n'));
    set('npc_state_delta_edit_species', npc.species || '');
    set('npc_state_delta_edit_gender', npc.gender || '');
    set('npc_state_delta_edit_home_base', npc.homeBase || '');
    const customFields = normalizeCustomFields(npc.customFields);
    for (const input of document.querySelectorAll?.('#npc_state_delta_editor_content [data-delta-custom-field]') || []) {
        const key = Object.keys(customFields).find(other => other.toLowerCase() === String(input.dataset.deltaCustomField || '').toLowerCase());
        input.value = key ? customFields[key] : '';
    }
    set('npc_state_delta_edit_age', npc.age || '');
    set('npc_state_delta_edit_birthday', npc.birthDateDisplay || '');
    set('npc_state_delta_edit_apparent_age', npc.apparentAge || '');
    set('npc_state_delta_edit_personality', npc.personality || '');
    set('npc_state_delta_edit_speech', npc.speech || '');
    set('npc_state_delta_edit_behavior_profile', (npc.behaviorProfile || []).join('\n'));
    set('npc_state_delta_edit_background', npc.background || '');
    set('npc_state_delta_edit_mannerisms', (npc.mannerisms || []).join('\n'));
    set('npc_state_delta_edit_key_relationships', (npc.keyRelationships || []).join('\n'));
    set('npc_state_delta_edit_relationship_summary', npc.relationshipSummary || '');
    set('npc_state_delta_edit_mood', npc.mood || '');
    set('npc_state_delta_edit_location', npc.location || '');
    set('npc_state_delta_edit_goal', npc.goal || '');
    set('npc_state_delta_edit_status', npc.status || '');
    set('npc_state_delta_edit_memories', (npc.memories || []).join('\n'));
    set('npc_state_delta_edit_trust', relationshipNumber(npc.relationship?.trust));
    set('npc_state_delta_edit_affection', relationshipNumber(npc.relationship?.affection));
    set('npc_state_delta_edit_desire', relationshipNumber(npc.relationship?.desire));
    set('npc_state_delta_edit_tension', relationshipNumber(npc.relationship?.tension));
    const lock = document.getElementById('npc_state_delta_edit_lock_profile');
    if (lock) lock.checked = Boolean((npc.manualProfileFields || []).length);
}

function refreshChangedFields(before, after) {
    return REFRESH_CHANGED_FIELDS.filter(field => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
}

// (1.2.11) `automatic`: a one-pass catch-up, not the reader's click. It stays quiet unless it
// changed something, and never touches a dossier open in the editor.
async function refreshNpcFromChat(npcId, { automatic = false } = {}) {
    const notify = automatic ? () => {} : (level, text) => globalThis.toastr?.[level]?.(text);
    const id = String(npcId || '').trim();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!id || chatKey === 'no-chat') return false;
    try { await ensureChatStateLoaded(chatKey); } catch (error) { notify('warning', `NPC State Delta: cannot refresh this dossier until the canonical server state is available. ${error?.message || error}`); return false; }
    if (getChatKey() !== chatKey || !requireReadyChatMutation('refresh a dossier', chatKey, automatic ? { notify: false } : undefined)) return false;
    if (isScanBusy(chatKey)) {
        notify('info', 'NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    // Preserve any edits currently visible in this dossier before reading history. Otherwise
    // the old popup values could overwrite a successful refresh when Save is clicked later.
    if (editorIsMounted()) {
        if (automatic) return false;
        const savedEditor = await saveNpcEditor(id, { close: false, silent: true });
        if (!savedEditor) return false;
        try { await flushStateFile(chatKey); } catch { return false; }
    }
    if (!await prepareCanonicalScanBase(chatKey, 'dossier refresh')) return false;
    // (timeline) The window and the story day are read from the messages the story stands on: the gate is asked first.
    await refreshMessageGate();
    if (getChatKey() !== chatKey) return false;
    const settings = getSettings();
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === id);
    if (!existing) return false;
    const transcript = recentTranscript(settings.scanDepth, { messageIds: true });
    const developmentSourceMessageIds = [...transcript.matchAll(/^\[m(\d+)\]/gm)]
        .map(match => Number(match[1])).filter(Number.isInteger);
    if (!transcript) {
        notify('info', `NPC State Delta: no recent story text is available to refresh ${existing.name}.`);
        return false;
    }
    const before = structuredClone(existing);
    // (v2 hidden notes) A Refresh looks for this person's story events (never writes layers: the dossier is not new).
    const notes = hostedTargetNotes(existing);
    const prompt = buildProfileRefreshPrompt({
        transcript,
        targetNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
        turn: Number.isInteger(state.turn) ? state.turn : null,
        storyDay: storyDayAt(latestMessageId(true)),
        customFieldNames: settings.customFieldNames,
        ...targetNoteOptions(notes),
    });
    return runTargetedDossierPass({
        chatKey, ctx, id, prompt, notes,
        label: `chat refresh for ${existing.name}`,
        systemPrompt: "You are NPC State Delta's targeted dossier reconciliation scanner. Re-read the supplied recent-story window for exactly one existing NPC. Return only the requested JSON object.",
        indicator: 'refresh',
        staleLabel: 'dossier refresh',
        checkpoint: 'chat-refresh',
        metricsLabel: 'targeted-refresh',
        reportsScanMetrics: true,
        setIndicator: busy => setNpcChatRefreshIndicator(id, busy),
        onBusy: () => notify('info', 'NPC State Delta: another dossier scan is already running in this chat.'),
        onStale: () => notify('info', 'NPC State Delta: chat or dossier state changed during dossier refresh; stale result was discarded.'),
        onLateStale: () => notify('info', 'NPC State Delta: another session updated this chat during the refresh; the stale result was discarded.'),
        scope: (parsed, { latest, liveBefore }) => {
            const roster = latest.npcs;
            const labels = [existing.name, ...(existing.aliases || [])];
            const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
            const match = targetedRowFor(returned, existing, roster, { labels });
            parsed.npcs = match ? [{
                ...match,
                id,
                name: match.name || existing.name,
                present: false,
                worldActive: false,
                relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                relationshipChangeReason: '',
            }] : [];
            const rawProfileUpdates = Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed.profile_updates) ? parsed.profile_updates : []);
            if (rawProfileUpdates.length) {
                const profile = rawProfileUpdates.find(item => (String(item?.id || '') === id || (item?.name && npcMatchesLabel(existing, item.name))) && profileRowBindsToTarget(item, existing, roster))
                    || (rawProfileUpdates.length === 1 && soleRowMayBeTarget(rawProfileUpdates[0], { npcId: id, labels }, roster) ? rawProfileUpdates[0] : null);
                parsed.profileUpdates = profile && !rowContradictsTarget(profile, existing, roster) ? [{ ...profile, id, name: existing.name }] : [];
            }
            const edgeTouchesTarget = edge => edgeTouchesResolvedTarget(edge, existing, roster);
            const localEdges = extractExplicitKeyRelationshipEdges(transcript, roster, currentExclusions()).filter(edgeTouchesTarget);
            const modelEdges = (Array.isArray(parsed.keyRelationshipEdges) ? parsed.keyRelationshipEdges : []).filter(edgeTouchesTarget);
            parsed.keyRelationshipEdges = [...modelEdges, ...localEdges];
            if (!parsed.npcs.length && !(parsed.profileUpdates || []).length && !parsed.keyRelationshipEdges.length) {
                notify('info', `NPC State Delta: no grounded dossier changes found for ${existing.name} in the last ${settings.scanDepth} messages.`);
                return { ok: false, noChange: true, result: true, localEdges };
            }
            if (!liveBefore) return { ok: false, result: false };
            return { ok: true, match, localEdges };
        },
        mergeOptions: {
            autoReactivateArchived: false,
            // (I-14) The Refresh prompt asks for at most three new memories (rule 14); its merge takes three.
            memoryInputLimit: 3,
            allowTargetedDurableSeed: true,
            developmentSourceMessageIds,
            storyDays: storyDaysForTranscript(transcript),
            developmentContext: transcript,
            userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
        },
        afterMerge: (refreshed, { liveBefore, scoped }) => {
            // Manual history reconciliation must never pretend the NPC was just seen or change
            // current presence merely because an older message in the window mentioned them.
            refreshed.present = Boolean(liveBefore.present);
            refreshed.worldActive = Boolean(liveBefore.worldActive);
            refreshed.lastSeenTurn = liveBefore.lastSeenTurn;
            refreshed.lastWorldActiveTurn = liveBefore.lastWorldActiveTurn;
            refreshed.seenCount = liveBefore.seenCount;
            refreshed.relationship = structuredClone(liveBefore.relationship || DEFAULT_RELATIONSHIP);
            refreshed.lastRelationshipChange = structuredClone(liveBefore.lastRelationshipChange || refreshed.lastRelationshipChange);
            const proposedSummary = String(scoped.match?.relationshipSummary ?? scoped.match?.relationship_summary ?? '').trim().slice(0, 900);
            // The reconciled summary must pass the same canonical consistency gate as every other path;
            // a proposal the merge rejected (for example an unsupported obligation) is not restored here.
            if (proposedSummary && !(liveBefore.manualProfileFields || []).includes('relationshipSummary')
                && relationshipSummaryConsistent(proposedSummary, refreshed.relationship, transcript, refreshed.relationshipMilestones)) {
                refreshed.relationshipSummary = calibrateRelationshipSummary(proposedSummary, refreshed.relationship);
            }
        },
        onDone: saved => {
            syncOpenNpcEditorFields(saved);
            const changed = refreshChangedFields(before, saved);
            if (automatic) {
                if (changed.length) globalThis.toastr?.info?.(`NPC State Delta: caught up ${saved?.name || existing.name} from the last ${settings.scanDepth} messages (${changed.join(', ')}).`);
            } else {
                globalThis.toastr?.success?.(changed.length
                    ? `NPC State Delta: refreshed ${saved?.name || existing.name} from the last ${settings.scanDepth} messages (${changed.join(', ')}).`
                    : `NPC State Delta: ${saved?.name || existing.name} is already consistent with the last ${settings.scanDepth} messages.`);
            }
            return true;
        },
        onError: error => {
            console.error('[NPC State Delta] targeted chat refresh failed', error);
            notify('warning', `NPC State Delta refresh failed for ${existing.name}: ${error?.message || error}`);
            return false;
        },
    });
}

const BACKFILL_MAX_ATTEMPTS = 3;
const BACKFILL_RETRY_COOLDOWN_MS = 60 * 1000;

// The live state a backfill that preserves it keeps: the record's own, whatever the model returned.
function backfillLiveState(liveBefore, keptPresent) {
    return {
        present: keptPresent,
        worldActive: Boolean(liveBefore.worldActive) && !keptPresent,
        mood: liveBefore.mood || '',
        location: liveBefore.location || '',
        goal: liveBefore.goal || '',
        status: liveBefore.status || '',
    };
}

async function backfillNpcFromHistory(request, messageId = null, { automatic = false } = {}) {
    const settings = getSettings();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!request?.npcId || !request?.label || chatKey === 'no-chat') return false;
    try { await ensureChatStateLoaded(chatKey); } catch { return false; }
    if (getChatKey() !== chatKey || !requireReadyChatMutation('backfill a dossier', chatKey, { notify: false })) return false;
    if (isScanBusy(chatKey)) return false;
    if (!await prepareCanonicalScanBase(chatKey, 'dossier backfill')) return false;
    // (timeline) The window is read from the messages the story stands on: the gate is asked first.
    await refreshMessageGate();
    if (getChatKey() !== chatKey) return false;
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === request.npcId);
    if (!existing) return false;
    const transcript = recentTranscript(settings.scanDepth);
    if (!transcript) return false;
    if (automatic) {
        if (!automaticBackfillStillRelevant(request, existing, state.npcs, currentExchangeTranscript(request.requestedMessageId))) return true;
    } else if (!backfillNeedsRequest(existing, state.npcs)) {
        return true;
    }
    const notes = hostedTargetNotes(existing, { newDossier: request.reason === 'new-admission', messageId });
    const prompt = buildBackfillPrompt({
        transcript,
        targetName: request.label,
        existingNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
        customFieldNames: settings.customFieldNames,
        ...targetNoteOptions(notes),
    });
    return runTargetedDossierPass({
        chatKey, ctx, prompt, messageId, notes,
        id: request.npcId,
        label: `backfill for ${request.label}`,
        systemPrompt: "You are NPC State Delta's isolated dossier backfill scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
        indicator: 'backfill',
        staleLabel: 'dossier backfill',
        checkpoint: 'dossier-backfill',
        metricsLabel: 'dossier-backfill',
        onStale: () => console.info('[NPC State Delta] discarded stale dossier backfill after chat or dossier state changed.'),
        scope: (parsed, { latest, liveBefore }) => {
            const roster = latest.npcs;
            const target = liveBefore || { id: request.npcId, name: request.label, aliases: [], identityKind: inferNpcIdentityKind(request.label) };
            const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
            // The backfill prompt is single-target by construction. If the model expands a short
            // label (e.g. Toris -> Toris Vale) without repeating the alias, accept the sole result
            // when the requested target is actually present in the supplied history.
            const labels = [request.label, ...(liveBefore ? [liveBefore.name, ...(liveBefore.aliases || [])] : [])];
            let matches = returned.filter(npc => backfillScanMatchesTarget(npc, request));
            if (!matches.length && returned.length === 1 && transcriptMentionsBackfillTarget(transcript, request.label)
                && soleRowMayBeTarget(returned[0], { npcId: request.npcId, labels }, roster)) matches = returned;
            matches = matches.filter(row => !rowContradictsTarget(row, target, roster));
            const preserved = request.preserveLiveState === true ? liveBefore : null;
            // A missed-participant repair exists because the NPC takes part in the current exchange;
            // the broad scan's omission is not evidence of absence, so a grounded present=true stands.
            // Other repairs keep the live presence (older history must not make an NPC present).
            const repairedPresence = request.reason === 'missed-participant' && matches[0]?.present === true
                && !npcCurrentlyAbsentInText(existing, currentExchangeTranscript(request.requestedMessageId));
            const keptPresent = preserved ? (repairedPresence || Boolean(preserved.present)) : false;
            parsed.npcs = matches.slice(0, 1).map(npc => ({
                ...npc,
                id: request.npcId,
                // (C-3) The same live state the merge result keeps below, so the merge sees no change.
                ...(preserved ? backfillLiveState(preserved, keptPresent) : {}),
                relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                relationshipChangeReason: '',
            }));
            if (!parsed.npcs.length) {
                const literalMention = transcriptMentionsBackfillTarget(transcript, request.label);
                console.warn('[NPC State Delta] targeted backfill returned no accepted NPC', { target: request.label, literalMention, returnedCount: returned.length });
                if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: ${request.label} was added, but the backfill model returned no matching dossier details from the last ${settings.scanDepth} messages.`);
                return { ok: false, result: false };
            }
            // A single-target backfill may change only its target, in every result channel: profile
            // updates and social edges for other dossiers are dropped like their npc rows.
            scopeTargetedChannels(parsed, target, roster);
            return { ok: true, preserved, keptPresent, repairedPresence };
        },
        mergeOptions: {
            // The backfill prompt asks for up to five memories (a first, whole dossier).
            memoryInputLimit: IMPORTANT_MEMORY_LIMIT,
            allowTargetedDurableSeed: true,
            developmentContext: transcript,
            userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
        },
        afterMerge: (finalNpc, { scoped }) => {
            const { preserved, keptPresent, repairedPresence } = scoped;
            if (!preserved) return;
            Object.assign(finalNpc, backfillLiveState(preserved, keptPresent));
            finalNpc.seenCount = Number(preserved.seenCount || 0);
            finalNpc.lastSeenTurn = repairedPresence
                ? Math.max(Number(preserved.lastSeenTurn || 0), Number(state.turn || 0))
                : Number(preserved.lastSeenTurn || 0);
            finalNpc.lastWorldActiveTurn = Number(preserved.lastWorldActiveTurn || 0);
        },
        beforeCheckpoint: (nextState, finalNpc, targetMessageId) => {
            if (!finalNpc.archived && finalNpc.present) recordInlineCardsInState(nextState, targetMessageId, [finalNpc.id], 'dossier-backfill');
            else removeNpcInlineCardAtMessage(nextState, targetMessageId, finalNpc.id);
        },
        onDone: savedNpc => {
            if (!request.silent) globalThis.toastr?.success?.(`NPC State Delta: backfilled ${savedNpc?.name || request.label} from recent story context.`);
            return true;
        },
        onError: error => {
            noteScanFailure('dossier backfill', error, getChatKey());
            if (error?.code === 'NPC_SCANNER_ROUTE_CANCELLED' || error?.code === 'NPC_SCANNER_ROUTE_TIMEOUT') return null;
            if (!request.silent || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.warning?.(`NPC State Delta backfill failed for ${request.label}: ${error?.message || error}`);
            return false;
        },
    });
}

// (b6-soak-2) One capture block admits at most this many new people. A crowd scene (a block naming
// forty dockhands) otherwise makes forty dossiers, each with its own backfill request later; the
// people left out are admitted from a later reply that names them again.
const CAPTURE_NEW_NPCS_PER_BLOCK = 4;
function capCaptureAdmissions(parsed, npcs = []) {
    const rows = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
    let fresh = 0;
    const kept = rows.filter(raw => {
        if (npcs.some(npc => rawScanMatchesExisting(raw, npc))) return true;
        fresh += 1;
        return fresh <= CAPTURE_NEW_NPCS_PER_BLOCK;
    });
    if (kept.length === rows.length) return;
    console.info(`[NPC State Delta] a one-pass block named ${fresh} new people; ${CAPTURE_NEW_NPCS_PER_BLOCK} were admitted from it, the others wait for a later reply.`);
    parsed.npcs = kept;
}

async function processPendingBackfillsInner(messageId = null, { limit = Infinity } = {}) {
    const chatKey = getChatKey();
    if (chatKey === 'no-chat' || !requireReadyChatMutation('process queued dossier backfills', chatKey, { notify: false }) || isScanBusy(chatKey) || isHostSwipeActive()) return 0;
    let processed = 0;
    // Model calls made (each backfill is one request, plus a compact retry at most).
    let calls = 0;
    const attemptedNpcIds = new Set();
    while (getChatKey() === chatKey && !isScanBusy(chatKey) && calls < limit) {
        const state = getChatState(chatKey);
        if (!Array.isArray(state.pendingBackfills) || !state.pendingBackfills.length) break;
        const request = state.pendingBackfills.find(item => item?.npcId && !attemptedNpcIds.has(item.npcId));
        if (!request) break;
        attemptedNpcIds.add(request.npcId);
        const target = state.npcs.find(npc => npc.id === request.npcId);
        const owningExchange = Number.isInteger(request.requestedMessageId) ? currentExchangeTranscript(request.requestedMessageId) : '';
        if (!automaticBackfillStillRelevant(request, target, state.npcs, owningExchange)) {
            state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
            persist();
            continue;
        }
        const attempts = Math.max(0, Math.round(Number(request.attempts) || 0));
        if (attempts >= BACKFILL_MAX_ATTEMPTS) {
            state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
            persist();
            if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: stopped automatic backfill retries for ${request.label} after ${BACKFILL_MAX_ATTEMPTS} failed attempts. The bare dossier is preserved; use Scan dossier to retry manually.`);
            continue;
        }
        const lastAttemptAt = Math.max(0, Number(request.lastAttemptAt || 0) || 0);
        if (attempts > 0 && lastAttemptAt && Date.now() - lastAttemptAt < BACKFILL_RETRY_COOLDOWN_MS) continue;

        calls += 1;
        const succeeded = await backfillNpcFromHistory(request, messageId, { automatic: true });
        if (succeeded === null) break;
        if (getChatKey() !== chatKey || !requireReadyChatMutation('settle queued dossier backfill', chatKey, { notify: false })) break;
        // (1.10.1) A scan that began while this backfill was getting ready holds the chat: the backfill made no request (it found the chat
        // busy). Writing the queue now would change the dossier state under that scan, which then discards its result; the request stays
        // queued, uncounted, for the next run.
        if (isScanBusy(chatKey)) break;
        const latest = getChatState(chatKey);
        const currentRequest = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
        if (!currentRequest || currentRequest.requestedAt !== request.requestedAt || currentRequest.requestedMessageId !== request.requestedMessageId) continue;
        if (!succeeded) {
            const queued = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
            if (queued) {
                queued.attempts = attempts + 1;
                queued.lastAttemptAt = Date.now();
                if (queued.attempts >= BACKFILL_MAX_ATTEMPTS) {
                    latest.pendingBackfills = latest.pendingBackfills.filter(item => item.npcId !== request.npcId);
                    if (!queued.silent) globalThis.toastr?.warning?.(`NPC State Delta: automatic backfill for ${queued.label} failed ${BACKFILL_MAX_ATTEMPTS} times and was removed from the retry queue. The dossier itself was not deleted.`);
                }
            }
            persist();
            // One failed dossier must not starve other queued targeted repairs.
            continue;
        }
        latest.pendingBackfills = (latest.pendingBackfills || []).filter(item => item.npcId !== request.npcId);
        persist();
        processed += 1;
    }
    return processed;
}

// The stamps for one of the reader's own edits: Delta's turn and the latest reply.
function stampManualEdit(state, npc, before) {
    const reply = latestReplyIndex();
    return stampNpcChanges(npc, before, { turn: state.turn, message: reply >= 0 ? reply : null, storyDay: storyDayAt(reply >= 0 ? reply : undefined) });
}

function collectStaleCleanupProtectedIds(state, scanResult, transcript = '') {
    const ids = new Set();
    const npcs = Array.isArray(state?.npcs) ? state.npcs : [];
    const addReference = (id, label) => {
        const directId = String(id || '').trim();
        if (directId && npcs.some(npc => npc.id === directId)) ids.add(directId);
        const name = String(label || '').trim();
        if (!name) return;
        const matched = npcs.find(npc => npcMatchesLabel(npc, name));
        if (matched) ids.add(matched.id);
    };

    for (const raw of Array.isArray(scanResult?.npcs) ? scanResult.npcs : []) addReference(raw?.id, raw?.name);
    for (const raw of Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates : []) addReference(raw?.id, raw?.name);
    for (const edge of Array.isArray(scanResult?.keyRelationshipEdges) ? scanResult.keyRelationshipEdges : []) {
        addReference(edge?.aId, edge?.a);
        addReference(edge?.bId, edge?.b);
    }

    // Conservative local guard: if the current scan text explicitly names a stale NPC,
    // never prune that dossier even if the model omitted its delta object.
    const haystack = ` ${normalizeName(transcript)} `;
    if (haystack.trim()) {
        for (const npc of npcs) {
            const labels = [npc.name, ...(npc.aliases || [])]
                .map(normalizeName)
                .filter(label => label.length >= 3);
            if (labels.some(label => haystack.includes(` ${label} `))) ids.add(npc.id);
        }
    }
    return ids;
}

function applyStaleLifecycleAfterScan(state, scanResult, transcript, settings, { onlyWhenAtCap = false } = {}) {
    if (settings.autoPruneStale === false) return { state, archived: [], removed: [] };
    const activeCount = (state.npcs || []).filter(npc => !npc?.archived).length;
    if (onlyWhenAtCap && activeCount < Number(settings.maxNpcs || 40)) return { state, archived: [], removed: [] };
    return applyStaleNpcLifecycle(state, {
        turn: state.turn,
        archiveAfter: settings.staleArchiveAfter,
        deleteAfter: settings.staleDeleteAfter,
        protectedIds: [...collectStaleCleanupProtectedIds(state, scanResult, transcript)],
    });
}

function scannerPromptOptions(state, settings, transcript, extra = {}) {
    const ctx = getContext();
    return {
        transcript,
        customFieldNames: settings.customFieldNames,
        existingNpcs: state.npcs,
        candidates: state.candidates,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        maxNpcs: settings.maxNpcs,
        relationshipBaseline: settings.relationshipBaseline,
        relationshipCaps: settings.relationshipCaps,
        relationshipCriteria: settings.relationshipCriteria,
        impactCriteria: settings.relationshipImpactCriteria,
        memoryCriteria: settings.memoryCriteria,
        admissionMode: settings.admissionMode,
        compactCapture: settings.narrationCaptureCompact === true,
        ...extra,
    };
}

// (1.2.11) One-pass catch-up. Mannerisms, levers and memories fill from evidence gathered over
// scenes, and a block written beside the story tends to leave them thin, while a Refresh (which
// reads a window of scenes) fills them. So every `narrationCaptureCatchUp` captured replies, the
// NPCs most in them get a quiet Refresh. Counted per chat in this session only; nothing is saved.
const CATCH_UP_TARGETS = 2;
const CATCH_UP_RETRY_MS = 3000;
const CATCH_UP_RETRIES = 20;

/** Counts one captured reply and the NPCs in it; the NPC ids due a catch-up now, or []. */
function noteCaptureCatchUp(chatKey, npcIds = []) {
    const every = Math.max(0, Math.round(Number(getSettings().narrationCaptureCatchUp) || 0));
    if (!every) return [];
    const entry = captureCatchUp.get(chatKey) ?? { count: 0, seen: new Map() };
    entry.count += 1;
    for (const id of new Set(npcIds)) if (id) entry.seen.set(id, (entry.seen.get(id) || 0) + 1);
    captureCatchUp.set(chatKey, entry);
    if (entry.count < every) return [];
    captureCatchUp.delete(chatKey);
    return [...entry.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, CATCH_UP_TARGETS).map(([id]) => id);
}

async function runCaptureCatchUp(chatKey, ids, tries = 0) {
    if (!ids.length || getChatKey() !== chatKey) return;
    if (isScanBusy(chatKey) || isHostSwipeActive()) {
        if (tries < CATCH_UP_RETRIES) setTimeout(() => void runCaptureCatchUp(chatKey, ids, tries + 1), CATCH_UP_RETRY_MS);
        return;
    }
    for (const id of ids) {
        if (getChatKey() !== chatKey) return;
        if (!getChatState(chatKey).npcs.some(npc => npc.id === id && !npc.archived)) continue;
        await refreshNpcFromChat(id, { automatic: true });
    }
    // (user decision 5) Hosted one-pass mode runs the backfill queue here, on the catch-up schedule.
    if (getChatKey() === chatKey && hostedOnePass()) await processPendingBackfills(latestMessageId(true), { limit: BACKFILLS_PER_REPLY });
}

function narrationCaptureEnabled(settings = getSettings()) {
    return Boolean(settings.enabled && settings.narrationCapture && settings.autoScan && !settings.fullScanEveryTurn);
}
// (user decision 5) Hosted by Story Block v2 with the npc meters slice, the story's `~ npc` lines move
// the meters, and code clamps and caps them. So Delta adds no model call of its own to a reply there:
// no focused relationship pass after a one-pass block, no new-NPC relationship pass (a new NPC starts
// at the base meter values), and, in one-pass mode, the backfill queue runs only with the one-pass
// catch-up or when the reader asks. Without a host none of this applies.
function hostedMeters() {
    return Boolean(storySuiteV2Meters());
}
function hostedOnePass(settings = getSettings()) {
    return hostedMeters() && narrationCaptureEnabled(settings);
}
// (b6-soak-2) Queued backfills never hold a reply: SillyTavern waits for every MESSAGE_RECEIVED
// listener before it draws the reply and gives back the Send button. The queue is started, not
// awaited, so the handler returns at once; at most BACKFILLS_PER_REPLY model calls per reply, the
// rest stay queued for the next one.
const BACKFILLS_PER_REPLY = 2;
function scheduleReplyBackfills(chatKey, messageId) {
    if (hostedOnePass()) return;
    queueMicrotask(() => {
        if (getChatKey() !== chatKey || latestMessageId(true) !== messageId) return;
        processPendingBackfills(messageId, { limit: BACKFILLS_PER_REPLY })
            .catch(error => console.warn('[NPC State Delta] queued dossier backfills stopped.', error));
    });
}
// Bound to the reply's position and the lineage before it, not to the reply's own text: other
// extensions may rewrite a reply on arrival (wrapping their blocks, for example). Editing an earlier
// message changes the key; editing, deleting or swiping a message drops every held capture.
function narrationCaptureKey(chatKey, messageId) {
    const parent = messageId > 0 ? lineageCheckpointKey(chatLineage(getContext().chat || []), messageId - 1) : 'root';
    return `${chatKey}|${messageId}|${parent}`;
}
function dropNarrationCaptures() {
    narrationCaptures.clear();
}
// The instruction describes the dossier as it was when the prompt was built; any dossier write
// before the reply arrives (a finishing scan, a reconcile) makes the block outdated.
function noteNarrationCaptureVersion(key) {
    if (rt.narrationCaptureArmed === key) narrationCaptureVersion = Number(stateVersions.get(key) || 0);
}
// Runs before any lineage key reads the reply, so every checkpoint binds the stripped text. Any
// block is removed even with the mode off; only a complete, parseable one is kept for the scan.
function stripNarrationSwipes(message, lenient) {
    if (!Array.isArray(message?.swipes)) return;
    for (let index = 0; index < message.swipes.length; index += 1) {
        if (typeof message.swipes[index] === 'string') message.swipes[index] = extractNarrationCapture(message.swipes[index], { lenient }).text;
    }
}
// On MESSAGE_RECEIVED the reply is not drawn yet (the host draws it next, from the stripped text);
// re-render only a message already in the chat. (b6-soak-5) A reply's own receipt re-renders it only
// once the host says it is drawn (CHARACTER_MESSAGE_RENDERED, renderCapturedReply below).
function renderCapturedReply(messageId) {
    const id = Number(messageId);
    if (!captureRerenderPending.delete(id)) return;
    const message = getContext().chat?.[id];
    if (message && !message.is_user && !message.is_system) rerenderNarrationMessage(id, message);
}
function rerenderNarrationMessage(messageId, message) {
    if (!globalThis.document?.querySelector?.(`#chat .mes[mesid="${Number(messageId)}"]`)) return;
    try { getContext().updateMessageBlock?.(messageId, message); }
    catch (error) { console.warn('[NPC State Delta] could not re-render a reply after removing its capture block.', error); }
}
function captureNarrationBlock(chatKey, messageId, message, armed, watch = []) {
    const extracted = extractNarrationCapture(message.mes, { lenient: armed });
    stripNarrationSwipes(message, armed);
    if (extracted.status === 'none') {
        if (armed) narrationCaptureStats.missing += 1;
        return;
    }
    message.mes = extracted.text;
    captureRerenderPending.add(Number(messageId));
    // Only a reply written under the instruction may stand in for a scan; a block in any other
    // message (sendas, card text, another extension) is removed and ignored.
    if (!armed || !narrationCaptureEnabled() || !extracted.text.trim()) return;
    const parsed = extracted.status === 'found' ? parseNarrationCapture(extracted.raw) : null;
    if (!parsed) {
        narrationCaptureStats[extracted.status === 'found' ? 'invalid' : 'unterminated'] += 1;
        return;
    }
    narrationCaptures.set(narrationCaptureKey(chatKey, messageId), { parsed, raw: extracted.raw, watch });
    // Only its size is kept, for the tokens() output estimate; never the block itself.
    rt.lastCaptureBlockChars = String(extracted.raw ?? '').length;
    while (narrationCaptures.size > NARRATION_CAPTURE_LIMIT) narrationCaptures.delete(narrationCaptures.keys().next().value);
}
function receiveNarrationBlock(messageId) {
    const chatKey = getChatKey();
    const armedHere = Boolean(rt.narrationCaptureArmed) && rt.narrationCaptureArmed === chatKey;
    const current = armedHere && Number(stateVersions.get(chatKey) || 0) === narrationCaptureVersion;
    const watched = armedHere ? rt.narrationCaptureWatch : [];
    disarmNarrationCapture();
    const message = Number.isInteger(messageId) ? getContext().chat?.[messageId] : null;
    if (!getSettings().enabled || chatKey === 'no-chat' || !message || message.is_user || message.is_system) return;
    if (armedHere) narrationCaptureStats[current ? 'requested' : 'outdated'] += 1;
    captureNarrationBlock(chatKey, messageId, message, current, watched);
}
// Swiping to a stored sibling must not bring back a block another reply path left in it.
function stripSwipedNarrationBlock(messageId) {
    dropNarrationCaptures();
    const message = Number.isInteger(messageId) ? getContext().chat?.[messageId] : null;
    if (!getSettings().enabled || !message || message.is_user || message.is_system) return;
    const extracted = extractNarrationCapture(message.mes);
    stripNarrationSwipes(message, false);
    if (extracted.status === 'none') return;
    message.mes = extracted.text;
    rerenderNarrationMessage(messageId, message);
}
// Later receipt paths may return before refreshing the injection, and a quiet generation from
// another extension must never carry the instruction.
function disarmNarrationCapture() {
    rt.narrationCaptureArmed = '';
    rt.narrationCaptureWatch = [];
    if (rt.lastInjection.captureChars) updateInjection();
}
function takeNarrationCapture(chatKey, messageId) {
    const key = narrationCaptureKey(chatKey, messageId);
    const capture = narrationCaptures.get(key) || null;
    narrationCaptures.delete(key);
    return capture && narrationCaptureEnabled() ? capture : null;
}

// (1.2.9) Other extensions write into a reply just after it arrives: Story Block tidying its
// blocks, RPG Battle its Party sheet, Story Director a closing line. That is the same reply
// rewritten in place, not a new branch: its position and every message before it are unchanged.
// Treating it as a different reply left the one-pass capture block waiting, never merged.
function replyParentKey(messageId) {
    return messageId > 0 ? lineageCheckpointKey(chatLineage(getContext().chat || []), messageId - 1) : 'root';
}
function sameReplyRewritten(chatKey, messageId, parentKey) {
    if (getChatKey() !== chatKey || !Number.isInteger(messageId)) return false;
    const message = getContext().chat?.[messageId];
    return Boolean(message && !message.is_user && !message.is_system) && replyParentKey(messageId) === parentKey;
}
// A change between two lineages other than the reply at `messageId` rewritten in place.
function lineageMoved(previous, current, messageId) {
    const at = firstLineageDivergence(previous, current);
    if (at === -1) return false;
    if (!Number.isInteger(messageId) || at !== messageId || previous.length !== current.length) return true;
    return previous.slice(messageId + 1).some((entry, index) => entry !== current[messageId + 1 + index]);
}

// Current presence, mood and location belong to the latest scene: an earlier-only window never sets them.
function stripLiveSceneFields(parsed) {
    const rows = [...(Array.isArray(parsed?.npcs) ? parsed.npcs : []), ...(Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : [])];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        for (const key of ['present', 'worldActive', 'world_active', 'activeOffscreen', 'active_offscreen', 'mood', 'moodState', 'mood_state', 'clearMood', 'clear_mood', 'location', 'locationState', 'location_state', 'clearLocation', 'clear_location']) delete row[key];
    }
}

// A chat counts as new (its first scan reads from the start) only when nothing was ever applied to it: no scan, no dossier
// or candidate, and a history short enough for one window. An imported or cleared chat, or a long chat with no sidecar,
// reads the latest reply only.
const NEW_CHAT_MAX_REPLIES = 15;
function chatNeverScanned(state, messageId) {
    if (Number(state?.scanCount || 0) > 0 || (state?.npcs || []).length || (state?.candidates || []).length) return false;
    const chat = getContext().chat || [];
    let replies = 0;
    for (let i = 0; i <= Math.min(messageId, chat.length - 1); i += 1) if (chat[i] && !chat[i].is_system && !chat[i].is_user) replies += 1;
    return replies <= NEW_CHAT_MAX_REPLIES;
}

async function scanNowInner({ manual = false, messageId = null, allowDuringSwipe = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return false;
    if (!allowDuringSwipe && isHostSwipeActive()) {
        if (manual) globalThis.toastr?.info?.('NPC State Delta: wait for the current swipe to finish before scanning.');
        return false;
    }
    const ctx = getContext();
    const scanChatKey = getChatKey();
    if (scanChatKey === 'no-chat') return false;
    const sourceFingerprint = Number.isInteger(messageId) ? fingerprintMessage(ctx.chat?.[messageId] || {}) : null;
    const sourceParent = Number.isInteger(messageId) ? replyParentKey(messageId) : null;
    // The chat changed under the scan, unless only this reply was rewritten in place.
    const sourceMoved = () => getChatKey() !== scanChatKey || (sourceFingerprint !== null
        && sourceFingerprint !== fingerprintMessage(getContext().chat?.[messageId] || {})
        && !sameReplyRewritten(scanChatKey, messageId, sourceParent));
    await ensureChatStateLoaded(scanChatKey);
    await refreshMessageGate();
    if (sourceMoved()) return false;
    if (isScanBusy(scanChatKey)) {
        if (manual) globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        else if (Number.isInteger(messageId)) queuePendingAutoScan(scanChatKey, messageId, 'busy-auto-scan');
        return false;
    }
    if (!await prepareCanonicalScanBase(scanChatKey, manual ? 'manual dossier scan' : 'automatic dossier scan')) return false;
    if (sourceMoved()) return false;
    const scanLineage = chatLineage(ctx.chat || []);
    let currentTranscript = currentExchangeTranscript(messageId);
    const currentProse = currentExchangeProse(messageId);
    const fullWindowScan = Boolean(!manual && settings.fullScanEveryTurn);
    // (lean) A scan reads every exchange since the last scan, not only this reply: the replies the local check skipped
    // are in it, up to 30 messages. More waiting than that: the oldest are read first and the next reply scans at once
    // (catch-up). Nothing skipped: the current exchange alone.
    const skippedWindow = !manual && !fullWindowScan && Number.isInteger(messageId) && !narrationCaptures.has(narrationCaptureKey(scanChatKey, messageId))
        ? skippedExchangesWindow(messageId, {
            afterId: getChatState(scanChatKey)?.lastScannedMessageId,
            fresh: chatNeverScanned(getChatState(scanChatKey), messageId),
            replies: getChatState(scanChatKey)?.assistantSinceScan,
            limit: settings.scanDepth,
            skip: readAheadOf(getChatState(scanChatKey)),
        })
        : null;
    // A catch-up window that stops before the chat's latest reply is earlier context only: no current presence, mood or meter deltas.
    const earlierOnly = Boolean(skippedWindow && !skippedWindow.latest);
    if (earlierOnly) currentTranscript = skippedWindow.lastExchange || currentTranscript;
    const transcript = (manual || fullWindowScan) ? recentTranscript(settings.scanDepth) : (skippedWindow?.transcript || currentTranscript);
    const userDevelopmentContext = (manual || fullWindowScan)
        ? recentUserDevelopmentContext(settings.scanDepth, { messageIds: true })
        : (skippedWindow?.userDevelopmentContext ?? currentExchangeUserDevelopmentContext(messageId));
    if (!transcript) {
        if (manual) globalThis.toastr?.warning?.('NPC State Delta: no story text to scan yet.');
        return false;
    }

    const operation = beginScanOperation(scanChatKey, manual ? 'manual dossier scan' : 'automatic dossier scan');
    if (operation) {
        operation.sourceLineage = scanLineage;
        // (1.2.9) The reply it reads: rewritten in place by another extension, it is still the source.
        operation.sourceMessageId = Number.isInteger(messageId) ? messageId : null;
    }
    if (!operation) return false;
    setScanIndicator(true);
    // (v2 meters) While hosted the slice is the truth: the scan shows, scores and forwards relationship
    // changes from the slice's numbers (the sidecar then follows them). Without a host it is the record.
    const state = hostedScanState(getChatState(scanChatKey));
    const newChatAtStart = chatNeverScanned(state, Number.isInteger(messageId) ? messageId : (ctx.chat || []).length - 1);
    const scanStateVersion = Number(stateVersions.get(scanChatKey) || 0);
    const capture = !manual && !fullWindowScan && Number.isInteger(messageId)
        ? takeNarrationCapture(scanChatKey, messageId)
        : null;
    const scanLabel = capture ? 'narration-capture' : (manual ? 'manual' : (fullWindowScan ? 'automatic-full' : 'automatic'));
    // (v2 hidden notes) Hosted: a new dossier's layered notes are asked for (setting) and the story events of present people's
    // locked notes are looked for in the current exchange. A scan sends both in its prompt; a one-pass block was asked
    // when its reply was generated, so its events are the ones that went out then (`capture.watch`). Neither is in a
    // prompt otherwise.
    const hostedNotes = hostedMeters();
    const noteOptions = hostedNotes && !capture ? hostedNotePromptOptions(state, settings, messageId) : {};
    const eventWatch = capture ? (Array.isArray(capture.watch) ? capture.watch : []) : (noteOptions.eventWatch || []);
    const prompt = capture ? '' : buildScannerPrompt(scannerPromptOptions(state, settings, transcript, {
        currentTranscript, earlierOnly, fullScanMode: fullWindowScan, sceneNames: scanScenePresent(messageId), ...noteOptions,
    }));

    let relationshipEdgeCount = 0;
    let relationshipEdgeFallbacks = 0;
    let profileUpdateCount = 0;
    let catchUpIds = [];
    try {
        const scanStartedAt = performance.now?.() ?? Date.now();
        const { parsed, raw, retried } = capture ? { ...capture, retried: false } : await generateParsedNpcJson(ctx, {
            systemPrompt: "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
            prompt,
            responseLength: fullWindowScan ? FULL_SCAN_RESPONSE_LENGTH : SCAN_RESPONSE_LENGTH,
            label: manual ? 'manual dossier scan' : (fullWindowScan ? 'automatic full dossier scan' : 'automatic dossier scan'),
            requestScope: operation.requestScope,
        });
        let currentLineage = chatLineage(getContext().chat || []);
        if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan')
            || !scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey
            || lineageMoved(scanLineage, currentLineage, messageId) || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
            const scanFinishedAt = performance.now?.() ?? Date.now();
            rt.lastScanMetrics = {
                label: scanLabel,
                durationMs: Math.max(0, Math.round(scanFinishedAt - scanStartedAt)),
                promptChars: prompt.length,
                responseChars: String(raw ?? '').length,
                retried: Boolean(retried),
                relationshipPass: false,
                relationshipTargets: 0,
                relationshipResponseChars: 0,
                relationshipRetried: false,
                relationshipEdges: relationshipEdgeCount,
                relationshipEdgeFallbacks,
                profileUpdates: profileUpdateCount,
                profileApplied: 0,
                profileEvidenceAdded: 0,
                stale: true,
                at: Date.now(),
            };
            console.info('[NPC State Delta] discarded stale dossier scan after chat or dossier state changed.');
            if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
            return false;
        }

        if (capture) narrationCaptureStats.used += 1;
        // (1.2.11) A scan of one reply tags its evidence with that reply, so a habit seen again in a
        // later reply counts as a second sighting (a manual or full-window scan reads many replies).
        const singleReply = !manual && !fullWindowScan && Number.isInteger(messageId);
        const resolvedParsed = resolveInterimIdentityPromotions(singleReply ? tagScanEvidence(parsed, skippedWindow?.readThrough ?? messageId) : parsed, state.npcs, state.candidates);
        if (capture) capCaptureAdmissions(resolvedParsed, state.npcs);
        profileUpdateCount = Array.isArray(resolvedParsed.profileUpdates) ? resolvedParsed.profileUpdates.length : (Array.isArray(resolvedParsed.profile_updates) ? resolvedParsed.profile_updates.length : 0);
        // Relationship-edge extraction is a separate channel from ordinary NPC delta admission.
        // Add a deterministic fallback for explicit binary statements so a missed lifecycle field
        // cannot silently discard facts such as "Elena is Marris's older sister".
        const explicitRelationshipEdges = extractExplicitKeyRelationshipEdges(transcript, state.npcs, currentExclusions());
        const modelEdges = Array.isArray(resolvedParsed.keyRelationshipEdges) ? resolvedParsed.keyRelationshipEdges : [];
        relationshipEdgeFallbacks = explicitRelationshipEdges.length;
        relationshipEdgeCount = modelEdges.length + explicitRelationshipEdges.length;
        if (explicitRelationshipEdges.length) resolvedParsed.keyRelationshipEdges = [...modelEdges, ...explicitRelationshipEdges];
        // Any scan that reads rolling history must scrub numeric relationship output from the
        // broad dossier scanner. Relationship movement is evaluated separately against the
        // current exchange only, so manual/full scans cannot replay older relationship events.
        // A catch-up window reads each reply once, so its relationship changes apply once (evidence is checked against the
        // window's own text); only current presence, mood and location are not taken from earlier replies.
        if (earlierOnly) stripLiveSceneFields(resolvedParsed);
        const fullWindowRelationship = (manual || fullWindowScan)
            ? prepareFullWindowRelationshipPayload(resolvedParsed, state.npcs)
            : { evaluation: resolvedParsed, mergeSafe: resolvedParsed };
        // (user decision 5) Hosted, a one-pass block's own rows are the reply's relationship decision.
        const relationshipPass = capture && hostedMeters() ? { decisions: new Map(), used: false, responseChars: 0, retried: false, targetCount: 0 } : await runFocusedRelationshipPass(
            ctx,
            fullWindowRelationship.evaluation,
            state.npcs,
            skippedWindow ? transcript : (currentTranscript || transcript),
            settings,
            {
                currentExchangeOnly: manual || fullWindowScan,
                requestScope: operation.requestScope,
                prose: skippedWindow ? skippedWindow.prose : currentProse,
                window: Boolean(skippedWindow),
                // (1.2.12) Only a one-pass block speaks for its relationships this way.
                ...(capture ? { covered: parsed?.relationshipsCovered === true, review: Array.isArray(parsed?.relationshipReview) ? parsed.relationshipReview : [] } : {}),
            },
        );
        const scanFinishedAt = performance.now?.() ?? Date.now();
        rt.lastScanMetrics = {
            label: scanLabel,
            durationMs: Math.max(0, Math.round(scanFinishedAt - scanStartedAt)),
            promptChars: prompt.length,
            responseChars: String(raw ?? '').length,
            retried: Boolean(retried),
            relationshipPass: relationshipPass.used,
            relationshipTargets: relationshipPass.targetCount,
            relationshipResponseChars: relationshipPass.responseChars,
            relationshipRetried: relationshipPass.retried,
            newNpcRelationshipTargets: 0,
            newNpcRelationshipResponseChars: 0,
            relationshipEdges: relationshipEdgeCount,
            relationshipEdgeFallbacks,
            profileUpdates: profileUpdateCount,
            profileApplied: 0,
            profileEvidenceAdded: 0,
            at: Date.now(),
        };
        currentLineage = chatLineage(getContext().chat || []);
        if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan relationship evaluation')
            || !scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey
            || lineageMoved(scanLineage, currentLineage, messageId) || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
            console.info('[NPC State Delta] discarded stale dossier scan after chat, dossier, or canonical state changed during relationship evaluation.');
            if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
            return false;
        }
        const targetMessageId = Number.isInteger(messageId) ? messageId : latestMessageId(true);
        const compactWorldStateTurn = hasCompactMeguminWorldState(ctx.chat?.[targetMessageId]?.mes || '');
        const parsedForMerge = suppressPrimaryRelationshipForFocusedDecisions(fullWindowRelationship.mergeSafe, relationshipPass.decisions, () => getChatState().npcs);
        // If the registry is already full, free truly stale slots before admission so a new
        // current NPC is not rejected just because a long-gone dossier still occupies the cap.
        const preCleanup = applyStaleLifecycleAfterScan(state, parsedForMerge, currentTranscript || transcript, settings, { onlyWhenAtCap: true });
        const mergeBaseState = structuredClone(preCleanup.state);
        for (const npc of mergeBaseState.npcs || []) {
            npc.present = false;
            if (!compactWorldStateTurn) npc.worldActive = false;
        }
        const merged = mergeScanResult(mergeBaseState, parsedForMerge, {
            maxNpcs: settings.maxNpcs,
            excludeNames: [...currentExclusions(), ...(state.dismissed || [])],
            turn: state.turn,
            sourceMessageId: targetMessageId,
            scenePresent: scenePresentAt(targetMessageId),
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
            storyDay: storyDayAt(targetMessageId),
            customFieldNames: settings.customFieldNames,
            relationshipBaseline: settings.relationshipBaseline,
            relationshipCaps: settings.relationshipCaps,
            autoArchiveDeaths: settings.autoArchiveDeaths !== false,
            autoReactivateArchived: settings.autoReactivateArchived !== false,
            admissionMode: settings.admissionMode,
            preserveWorldActive: compactWorldStateTurn,
            developmentContext: transcript,
            userDevelopmentContext,
            // Key people who are away keep their stable profile and custom fields through the automatic scan (src/key-people.js);
            // the reader's own "Scan now" is deliberate and writes them.
            ...(manual ? {} : keyAwayScanOptions(mergeBaseState)),
        });
        if (earlierOnly) {
            // Presence is the latest scene's: an earlier-only window leaves each person as last confirmed.
            const before = new Map((state.npcs || []).map(npc => [npc.id, npc]));
            for (const npc of merged.state.npcs || []) {
                const prev = before.get(npc.id);
                npc.present = Boolean(prev?.present) && !npc.archived;
                npc.worldActive = Boolean(prev?.worldActive) && !npc.present && !npc.archived;
            }
        }
        const newlyAdmittedIds = [...new Set([...(merged.report?.created || []), ...(merged.report?.promoted || [])])];
        let newNpcRelationshipPass = { decisions: new Map(), used: false, targetCount: 0, responseChars: 0, retried: false };
        // (user decision 5) Hosted, a new NPC starts at the base meter values: no evaluator request.
        if (fullWindowScan && newlyAdmittedIds.length && !hostedMeters()) {
            const newTargets = merged.state.npcs.filter(npc => newlyAdmittedIds.includes(npc.id) && !npc.archived);
            if (newTargets.length) {
                const combinedDecisions = new Map();
                let combinedTargetCount = 0;
                let combinedResponseChars = 0;
                let combinedRetried = false;
                for (let offset = 0; offset < newTargets.length; offset += 4) {
                    const batch = newTargets.slice(offset, offset + 4);
                    const result = await runFocusedRelationshipPass(
                        ctx,
                        fullWindowRelationship.evaluation,
                        batch,
                        currentTranscript || transcript,
                        settings,
                        { currentExchangeOnly: true, requestScope: operation.requestScope, prose: currentProse },
                    );
                    for (const [id, decision] of result.decisions || []) combinedDecisions.set(id, decision);
                    combinedTargetCount += Number(result.targetCount || 0);
                    combinedResponseChars += Number(result.responseChars || 0);
                    combinedRetried ||= Boolean(result.retried);
                }
                newNpcRelationshipPass = {
                    decisions: combinedDecisions,
                    used: combinedTargetCount > 0,
                    targetCount: combinedTargetCount,
                    responseChars: combinedResponseChars,
                    retried: combinedRetried,
                };
                applyFocusedRelationshipDecisions(merged.state, combinedDecisions, settings.relationshipCaps, targetMessageId, merged.report);
                if (rt.lastScanMetrics) {
                    rt.lastScanMetrics.newNpcRelationshipTargets = combinedTargetCount;
                    rt.lastScanMetrics.newNpcRelationshipResponseChars = combinedResponseChars;
                }
            }
        }
        currentLineage = chatLineage(getContext().chat || []);
        if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan new-NPC relationship evaluation')
            || !scanOperationCurrent(scanChatKey, operation)
            || getChatKey() !== scanChatKey
            || lineageMoved(scanLineage, currentLineage, messageId)
            || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
            console.info('[NPC State Delta] discarded stale dossier scan after new-NPC relationship evaluation.');
            if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
            return false;
        }
        if (rt.lastScanMetrics) {
            rt.lastScanMetrics.profileApplied = Number(merged.report?.profileUpdateStats?.applied || 0);
            rt.lastScanMetrics.profileEvidenceAdded = Number(merged.report?.profileUpdateStats?.evidenceAdded || 0);
            rt.lastScanMetrics.profileDevelopment = Array.isArray(merged.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [];
            console.info('[NPC State Delta] dossier scan metrics', rt.lastScanMetrics);
        }
        applyFocusedRelationshipDecisions(merged.state, relationshipPass.decisions, settings.relationshipCaps, targetMessageId, merged.report);
        const postCleanup = applyStaleLifecycleAfterScan(merged.state, parsedForMerge, currentTranscript || transcript, settings);
        const staleArchived = [...preCleanup.archived, ...postCleanup.archived]
            .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
        const stalePruned = [...preCleanup.removed, ...postCleanup.removed]
            .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
        merged.state = postCleanup.state;
        merged.report.staleArchived = staleArchived;
        merged.report.stalePruned = stalePruned;
        if (rt.lastScanMetrics) {
            rt.lastScanMetrics.staleArchived = staleArchived.length;
            rt.lastScanMetrics.stalePruned = stalePruned.length;
        }
        recordScanDiagnostics(scanChatKey, rt.lastScanMetrics || {}, parsedForMerge, merged.report, {
            sourceMessageId: targetMessageId,
            targeted: false,
        });
        const chatKey = scanChatKey;
        // The newest reply this scan read: the chat's latest, or, in a catch-up, the newest of the oldest waiting ones.
        const scanTarget = Number.isInteger(skippedWindow?.readThrough) ? skippedWindow.readThrough : (Number.isInteger(messageId) ? messageId : ((ctx.chat || []).length - 1));
        // (1.10.0) The marker passes only replies that were all read: a manual scan, a Refresh or a narration capture that read the latest
        // reply while older ones still wait leaves the marker behind them and remembers what it read, so the next window reads the waiting
        // replies and skips exactly those (each reply read once).
        const currentReplyId = activeReplyIds().filter(id => id <= (Number.isInteger(messageId) ? messageId : (ctx.chat || []).length - 1)).at(-1);
        const readIds = skippedWindow
            ? skippedWindow.readIds
            : ((manual || fullWindowScan) ? recentReplyIds(settings.scanDepth) : (Number.isInteger(currentReplyId) ? [currentReplyId] : []));
        const settled = settleScan({
            marker: state.lastScannedMessageId, readAhead: state.readAhead, readIds, target: scanTarget, replyIds: activeReplyIds(), fresh: newChatAtStart,
        });
        const nextState = {
            ...merged.state,
            // The replies the marker was held back for count toward the next safety scan (Scan every); nothing is waiting otherwise.
            assistantSinceScan: settled.deferred ? settled.waiting : 0,
            lastScanAt: Date.now(),
            lastScannedMessageId: settled.marker,
            readAhead: settled.readAhead,
            scanCount: Number(state.scanCount || 0) + 1,
        };
        if (skippedWindow && !skippedWindow.latest) catchUpChats.add(scanChatKey); else catchUpChats.delete(scanChatKey);
        if (!manual) {
            // If the broad scanner omitted an NPC explicitly involved anywhere in the current
            // exchange, schedule a silent targeted continuity repair so memories/profile changes
            // get the same second chance as relationship scoring.
            const touchedIds = new Set(newlyAdmittedIds);
            const markBroadScanTarget = raw => {
                const id = String(raw?.id || '').trim();
                if (id && nextState.npcs.some(npc => npc.id === id)) {
                    touchedIds.add(id);
                    return;
                }
                const name = String(raw?.name || '').trim();
                if (!name) return;
                const matched = nextState.npcs.find(npc => npcMatchesLabel(npc, name));
                if (matched) touchedIds.add(matched.id);
            };
            for (const raw of Array.isArray(resolvedParsed?.npcs) ? resolvedParsed.npcs : []) markBroadScanTarget(raw);
            for (const raw of Array.isArray(resolvedParsed?.profileUpdates) ? resolvedParsed.profileUpdates : []) markBroadScanTarget(raw);
            const missedParticipants = [];
            for (const npc of nextState.npcs || []) {
                if (npc.archived || touchedIds.has(npc.id) || !npcParticipatesInExchange(npc, nextState.npcs || [], currentTranscript || '', { includeRole: false })) continue;
                missedParticipants.push(npc);
            }
            if (missedParticipants.length <= AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT) {
                for (const npc of missedParticipants) {
                    queueNpcBackfillInState(nextState, npc.id, npc.name, targetMessageId, {
                        reason: 'missed-participant',
                        preserveLiveState: true,
                        silent: true,
                    });
                }
            } else {
                console.warn('[NPC State Delta] suppressed automatic per-NPC continuity fan-out after broad scan omitted multiple apparent participants.', {
                    omittedParticipants: missedParticipants.length,
                    limit: AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
                });
            }

            // Newly admitted dossiers may need richer recent-history enrichment than the broad
            // first pass provides. Repair only those new/promoted dossiers; admitting one NPC must
            // never fan out into targeted model calls for unrelated established cast members.
            for (const id of newlyAdmittedIds) {
                const admitted = nextState.npcs.find(npc => npc.id === id && !npc.archived);
                if (!admitted) continue;
                queueNpcBackfillInState(nextState, admitted.id, admitted.name, targetMessageId, {
                    reason: 'new-admission',
                    preserveLiveState: true,
                    silent: true,
                });
            }
        }
        // (v2 hidden notes) The layered notes for the dossiers this scan built.
        if (hostedNotes && settings.layeredSecrets !== false) attachGeneratedSecrets(nextState, newlyAdmittedIds, parsedForMerge, resolvedParsed, parsed);
        const inlineIds = scanInlineNpcIds(resolvedParsed, merged);
        if (targetMessageId >= 0) {
            clearInlineCardsAtMessage(nextState, targetMessageId);
            if (inlineIds.length) recordInlineCardsInState(nextState, targetMessageId, inlineIds, 'scan');
        }
        if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan final commit')) {
            if (manual) globalThis.toastr?.info?.('NPC State Delta: another session updated this chat during the scan; the stale result was discarded.');
            return false;
        }
        if (targetMessageId >= 0) commitBranchCheckpoint(nextState, targetMessageId, 'scan');
        setChatState(chatKey, nextState);
        forwardRelationshipChangesToHost(state.npcs, nextState.npcs, targetMessageId, operation.chatHead);
        if (eventWatch.length) forwardSecretEventsToHost(eventWatch, resolvedParsed?.secretEvents ?? parsed?.secretEvents, operation.chatHead);
        persist();
        renderDossier();
        updateInjection();
        if (capture) catchUpIds = noteCaptureCatchUp(scanChatKey, inlineIds);
        if (manual) {
            const { created, updated, candidates, promoted, skipped, staleArchived = [], stalePruned = [] } = merged.report;
            globalThis.toastr?.success?.(`NPC State Delta scan complete: ${created.length} new, ${updated.length} updated${promoted.length ? `, ${promoted.length} promoted` : ''}${candidates.length ? `, ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} held` : ''}${staleArchived.length ? `, ${staleArchived.length} stale archived` : ''}${stalePruned.length ? `, ${stalePruned.length} stale deleted` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}.`);
        } else if ((merged.report.staleArchived || []).length || (merged.report.stalePruned || []).length) {
            const archivedCount = (merged.report.staleArchived || []).length;
            const removed = merged.report.stalePruned || [];
            const names = removed.slice(0, 3).map(item => item.name).join(', ');
            const extra = removed.length > 3 ? ` +${removed.length - 3} more` : '';
            const parts = [];
            if (archivedCount) parts.push(`${archivedCount} stale archived`);
            if (removed.length) parts.push(`${removed.length} stale deleted${names ? ` (${names}${extra})` : ''}`);
            globalThis.toastr?.info?.(`NPC State Delta: ${parts.join(', ')}. Deleted stale NPCs can be rediscovered if they return.`);
        }
        return true;
    } catch (error) {
        noteScanFailure('dossier scan', error, scanChatKey);
        if (manual || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.error?.(`NPC State Delta scan failed: ${error?.message || error}`);
        return false;
    } finally {
        endScanOperation(scanChatKey, operation);
        if (getChatKey() === scanChatKey) setScanIndicator(isScanBusy(scanChatKey));
        updateInjection();
        if (getChatKey() === scanChatKey) void drainPendingAutoScan(scanChatKey);
        if (catchUpIds.length) void runCaptureCatchUp(scanChatKey, catchUpIds);
    }
}

function setScanIndicator(busy) {
    const button = $('#npc_state_delta_scan_now');
    if (!button.length) return;
    button.toggleClass('npc-state-delta-busy', busy);
    button.html(busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Scanning dossier...' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now');
}

function relationshipNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.max(-100, Math.min(100, number))) : 0;
}

// The chat message index of the latest assistant reply (the greeting is 0), or -1: the number Story
// Block shows as "reply #N" and the dossiers show for changes recorded since 1.2.3.
function latestReplyIndex() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_system && !chat[i].is_user) return i;
    }
    return -1;
}

function latestMessageId(preferAssistant = false) {
    const chat = getContext().chat || [];
    if (preferAssistant) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            if (chat[i] && !chat[i].is_system && !chat[i].is_user) return i;
        }
    }
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_system) return i;
    }
    return -1;
}


function currentLineageKeyForMessage(messageId) {
    const lineage = chatLineage(getContext().chat || []);
    return lineageCheckpointKey(lineage, messageId);
}

function clearUserDismissedSuppression(state, target) {
    if (!state || typeof state !== 'object') return state;
    const cleared = clearUserDismissedGroupsFor(state.userDismissedGroups, target, { modernByIdOnly: true });
    state.userDismissedGroups = cleared.groups;
    if (cleared.removedLabels.length) {
        const removed = new Set(cleared.removedLabels.map(normalizeName).filter(Boolean));
        state.dismissed = (Array.isArray(state.dismissed) ? state.dismissed : [])
            .filter(label => !removed.has(normalizeName(label)));
    }
    return state;
}

const { recordInlineCardsInState, clearInlineCardsAtMessage, removeNpcInlineCardAtMessage, purgeInlineCardsInState, scanInlineNpcIds, currentNpcById, findNpcByIdOrName, scenePresentAt, presentCastDisplayMode, applyLauncherFlag, effectivePresentCastChoice, storyBlockCastHtml, ensureInlineObserver, inlineMountNeedsRepair, startInlineWatchdog, renderInlineCards, queueInlineRender } = createInlineCardsPart(rt, { chatHydrationStatus, currentLineageKeyForMessage, getChatKey, getChatState, INLINE_HISTORY_LIMIT, isKeyNpc, latestMessageId, scenePresenceView, storyBlockV2Hosted });

function eventTargetClosest(event, selector) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
        if (typeof node?.matches === 'function' && node.matches(selector)) return node;
    }
    return typeof event?.target?.closest === 'function' ? event.target.closest(selector) : null;
}

// Present-cast cards open the same launcher dossier page as the floating launcher.
function openLauncherDossier(npcId) {
    const id = String(npcId || '').trim();
    if (!id || !currentNpcById(id)) return false;
    const request = { npcId: id, handled: false };
    document.dispatchEvent?.(new CustomEvent('npc-state-delta:open-dossier', { detail: request }));
    if (!request.handled) globalThis.toastr?.warning?.('NPC State Delta dossier UI is still mounting.');
    return request.handled;
}

function activatePresentCardFromEvent(event) {
    const card = eventTargetClosest(event, '.npc-state-delta-present-card, .npc-state-delta-present-chip, .npc-state-delta-present-cell');
    if (!card) return false;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false;
    const npcId = String(card.dataset?.npcId || '').trim();
    if (!npcId) return false;
    const now = Date.now();
    if (lastPresentCardActivation.npcId === npcId && now - lastPresentCardActivation.at < 650) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        return true;
    }
    lastPresentCardActivation = { npcId, at: now };
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    openLauncherDossier(npcId);
    return true;
}

const { editorIsMounted, openNpcEditorSafely, activateNpcEditorFromEvent, renderDossier, closeNpcEditor, saveNpcEditor } = createEditorPart(rt, { chatHydrationStatus, commitBranchCheckpoint, currentNpcById, ensureFreshMutationBoundary, eventTargetClosest, getChatKey, getChatState, hostedMeterView, latestMessageId, latestReplyIndex, persistCriticalDurable, queueInlineRender, relationshipNumber, requireReadyChatMutation, stampManualEdit, startInlineWatchdog, storySuiteV2Meters, updateInjection, workingCopyAdoption });

function installUiCaptureBridge() {
    if (uiCaptureBridgeInstalled || typeof document?.addEventListener !== 'function') return;
    uiCaptureBridgeInstalled = true;
    document.addEventListener('pointerup', activatePresentCardFromEvent, true);
    document.addEventListener('click', activatePresentCardFromEvent, true);
    document.addEventListener('keydown', activatePresentCardFromEvent, true);
    document.addEventListener('keydown', handlePortraitGeneratorEscape, true);
    document.addEventListener('pointerup', activateNpcEditorFromEvent, true);
    document.addEventListener('click', activateNpcEditorFromEvent, true);
    document.addEventListener('keydown', activateNpcEditorFromEvent, true);
    try {
        document.addEventListener('touchend', activatePresentCardFromEvent, { capture: true, passive: false });
        document.addEventListener('touchend', activateNpcEditorFromEvent, { capture: true, passive: false });
    } catch {
        document.addEventListener('touchend', activatePresentCardFromEvent, true);
        document.addEventListener('touchend', activateNpcEditorFromEvent, true);
    }
}


const { updateNpcAppearance, updateNpcLifeState, npcFormName, setNpcPortrait, setNpcPortraitSeed, removeNpcPortrait, deleteNpcById, setNpcArchiveStateById, exportBundleBytes, importBundleBytes, addNpcManually } = createMutationsPart(rt, { clearUserDismissedSuppression, closeNpcEditor, commitBranchCheckpoint, editorIsMounted, ensureFreshMutationBoundary, ensureHydratedStateFresh, getChatKey, getChatState, hydratedRevision, latestMessageId, ownershipEpoch, ownershipEpochCurrent, persistCritical, persistCriticalDurable, purgeInlineCardsInState, recordFreshnessEvent, renderDossier, requestHeaders, requireReadyChatMutation, setChatState, stampManualEdit, updateInjection, workingCopyAdoption });


const { handlePortraitGeneratorEscape, npcImagePromptPair, executeNativePortraitGeneration, closePortraitGenerator, openPortraitGenerator, resetPortraitGeneratorFromDossier, generatePortraitFromDialog, useGeneratedPortrait, portraitSettingsSnapshot, normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi, confirmDiscardPortraitDraft, updatePortraitSettingsSaveUi, markPortraitSettingsDirty } = createPortraitPart(rt, { currentNpcById, eventTargetClosest, flushStateFile, getChatKey, requireReadyChatMutation, setNpcPortrait });

const { SUITE_API, renderWhatsSent, afterEnabledChange, applySourceOfTruth, syncSuiteControls, connectStorySuite } = createSuitePart(rt, { chatHydrationStatus, effectivePresentCastChoice, getChatKey, getChatState, hostedNotePromptOptions, liveInjectionText, narrationCaptureEnabled, openLauncherDossier, queueInlineRender, renderDossier, scannerPromptOptions, scenePresenceView, startInlineWatchdog, UI_ID, updateInjection });
const { buildSettingsHtml, bindSettingsGroupMemory, syncScannerProfileControl, syncSettingsControls } = createSettingsHtmlPart(rt, { applyLauncherFlag, effectivePresentCastChoice, portraitSettingsSnapshot, syncSuiteControls, UI_ID, updatePortraitSettingsSaveUi, writePortraitSettingsDraftToUi });
const { savePortraitSettingsDraft, persistPortraitCustomPresetLibrary } = createPortraitSettingsPart(rt, { normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, portraitSettingsSnapshot, syncSettingsControls, updatePortraitSettingsSaveUi });

const { bindUi, scheduleSettingsMountRetries } = createSettingsBindPart(rt, { addNpcManually, afterEnabledChange, applyLauncherFlag, applySourceOfTruth, bindSettingsGroupMemory, buildSettingsHtml, closePortraitGenerator, confirmDiscardPortraitDraft, deleteNpcById, detachBrokenSidecar, ensureFreshMutationBoundary, freshChatState, generatePortraitFromDialog, getChatKey, getChatState, hostedOnePass, latestMessageId, markPortraitSettingsDirty, openNpcEditorSafely, persistCritical, persistPortraitCustomPresetLibrary, portraitFileFailed, portraitSettingsDraftFromUi, portraitSettingsSnapshot, processPendingBackfills, queueInlineRender, refreshNpcFromChat, renderDossier, renderWhatsSent, resetPortraitGeneratorFromDossier, retryCurrentChatHydration, savePortraitSettingsDraft, scanNow, scanNpcDossier, setChatState, setNpcArchiveStateById, startInlineWatchdog, syncSettingsControls, syncSuiteControls, UI_ID, updateInjection, useGeneratedPortrait, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi });

// (1.2.13) Why no NPC shows as present, in words, and whether a scan could change that.
function castEmptyReason() {
    const key = getChatKey();
    if (key === 'no-chat') return { text: 'No chat is open.', scan: false };
    if (getSettings().enabled === false) return { text: 'NPC State Delta is off.', scan: false };
    const hydration = chatHydrationStatus(key);
    // (R2-5) A sidecar that could not be read is not "still loading": say so, and where to fix it
    // (the settings section's roster, the same notice the drawer shows).
    if (hydration === 'error') {
        const detach = getSettings().dataFiles?.[key]?.path ? ' or Detach Broken Sidecar' : '';
        return { text: `This chat's dossiers could not be loaded, so nothing is shown and nothing is changed. NPC State Delta's settings section has Retry Load${detach}.`, scan: false };
    }
    if (hydration !== 'ready') return { text: "This chat's dossiers are still loading.", scan: false };
    const state = getChatState(key);
    const latest = latestMessageId(true);
    if (!(state.npcs || []).some(npc => npc && !npc.archived)) {
        return { text: 'No NPC has a dossier in this chat yet, so nobody shows here even when the story or the World State names them. A scan of the latest reply makes dossiers for the NPCs in it.', scan: true };
    }
    if (latest >= 0 && !replyScanned(state, latest)) {
        return { text: 'The latest reply has not been scanned yet, so who is present is not known.', scan: true };
    }
    return { text: 'The latest scan found no NPC in the scene.', scan: true };
}

async function handleAssistantMessageReceivedInner(messageId, { bypassSwipeGuard = false, forceBranchRescan = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const eventChatKey = getChatKey();
    if (eventChatKey === 'no-chat' || !Number.isInteger(messageId) || messageId < 0) return;
    const eventMessage = getContext().chat?.[messageId];
    if (!eventMessage || eventMessage.is_user || eventMessage.is_system || !String(eventMessage.mes || '').trim()) return;
    let eventSourceKey = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
    const eventParent = replyParentKey(messageId);
    // (1.2.9) The same reply rewritten in place by another extension keeps its receipt.
    const sourceStillHere = () => {
        if (getChatKey() !== eventChatKey) return false;
        const now = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
        if (now === eventSourceKey) return true;
        if (!sameReplyRewritten(eventChatKey, messageId, eventParent)) return false;
        eventSourceKey = now;
        return true;
    };
    try { await ensureChatStateLoaded(eventChatKey); }
    catch (error) {
        console.error('[NPC State Delta] assistant event deferred because chat hydration failed.', error);
        globalThis.toastr?.error?.('NPC State Delta could not load this chat dossier. Existing sidecar data was preserved; retry after the server is available.');
        return;
    }
    if (!sourceStillHere()) return;

    // SillyTavern 1.18 emits MESSAGE_SWIPED before starting Generate('swipe'). Some
    // backends then emit MESSAGE_RECEIVED while swipeState is still SWIPING. Never run
    // dossier generation in that window; settlement will replay this message safely.
    if (!bypassSwipeGuard && isHostSwipeActive()) {
        if (Number.isInteger(messageId)) rt.deferredSwipeMessageId = messageId;
        queueSettledSwipeReconcile({
            explicitDivergence: Number.isInteger(messageId) ? messageId : null,
            rescan: true,
            reason: 'message-swiped-received',
        });
        return;
    }

    const state = getChatState();
    migrateLegacyLineage(state, getContext().chat || []);
    const receipts = assistantReceipts.get(eventChatKey) || new Set();
    if (!forceBranchRescan && (receipts.has(eventSourceKey)
        || (replyScanned(state, messageId) && eventSourceKey === lineageCheckpointKey(state.lineage, messageId)))) return;
    // Receipt deduplication is separate from successful scan completion and cadence.
    // Store bounded source keys, never copies of narrative text or dossier state.
    receipts.add(eventSourceKey);
    while (receipts.size > 64) receipts.delete(receipts.values().next().value);
    assistantReceipts.set(eventChatKey, receipts);
    if (Number.isInteger(messageId) && !staleHostActive(eventChatKey)) ensureBranchParentAnchor(state, getContext().chat || [], messageId, 'assistant-parent');
    state.turn = Number(state.turn || 0) + 1;
    // Presence remains last-confirmed until a successful scanner observation replaces it.
    // A skipped, busy, failed, or timed-out scan must not make every NPC disappear.
    state.assistantSinceScan = Number(state.assistantSinceScan || 0) + 1;
    const shouldForceBranchScan = forceBranchRescan && settings.branchRescan !== false;
    const autoScanDue = autoScanDueAfterReply({
        autoScan: settings.autoScan,
        full: settings.fullScanEveryTurn,
        sinceScan: state.assistantSinceScan,
        scanEvery: settings.scanEvery,
        everyReply: scanAfterEveryReply(),
        catchUp: settings.autoScan && catchUpChats.has(eventChatKey),
        replyChanges: settings.autoScan && !settings.fullScanEveryTurn && replyNamesSomeone(state, messageId),
    });
    // A complete capture block is a scan already paid for, so it merges whatever Scan every says.
    const captureDue = narrationCaptureEnabled(settings) && narrationCaptures.has(narrationCaptureKey(eventChatKey, messageId));
    const scanExpected = shouldForceBranchScan || autoScanDue || captureDue;
    // Receipt state belongs to this assistant even if scanning fails, skips or is busy.
    // A successful scan coalesces its changes into this same owned boundary.
    commitBranchCheckpoint(state, messageId, 'turn');
    persist();
    renderDossier();
    updateInjection();

    if (scanExpected) {
        if (await scanNow({ manual: false, messageId, allowDuringSwipe: bypassSwipeGuard }) === false) return;
    }
    if (getChatKey() !== eventChatKey || latestMessageId(true) !== messageId || !sourceStillHere()) return;
    scheduleReplyBackfills(eventChatKey, messageId);
}

// (lean) The cheap local check before an automatic scan: a quiet reply (no new name, no tracked NPC, no NPC State line) waits
// for the safety scan every "Scan every" replies. The same text and roster give the same answer when a reply is replayed.
function replyNamesSomeone(state, messageId) {
    try {
        const ctx = getContext();
        return replyMayChangeDossiers({
            texts: currentExchangeBodies(messageId),
            roster: [...(state?.npcs || []), ...(state?.candidates || [])],
            ignore: [ctx.name1, ctx.name2],
        });
    } catch { return true; }
}

async function refreshCurrentChatFromServer(reason = 'resume') {
    const key = getChatKey();
    if (key === 'no-chat' || !isCanonicalChatKey(key)) return false;
    try {
        await ensureChatStateLoaded(key, { probeMissing: true });
        if (getChatKey() !== key) return false;
        renderDossier();
        updateInjection();
        return true;
    } catch (error) {
        console.warn(`[NPC State Delta] ${reason} freshness check failed safely; cached state will not be used for mutation until the server can be verified.`, error);
        return false;
    }
}

function scheduleLifecycleRetry(operationKey, label, task) {
    if (lifecycleRetryTimers.has(operationKey)) return;
    const timer = setTimeout(() => {
        lifecycleRetryTimers.delete(operationKey);
        void runBoundedLifecycleEvent(operationKey, label, task);
    }, LIFECYCLE_RETRY_DELAY_MS);
    lifecycleRetryTimers.set(operationKey, timer);
}

async function runBoundedLifecycleEvent(operationKey, label, task) {
    const key = String(operationKey || label || 'lifecycle');
    let operation = lifecycleEventOperations.get(key);
    if (!operation) {
        operation = Promise.resolve().then(task);
        lifecycleEventOperations.set(key, operation);
        void operation.catch(error => {
            console.warn(`[NPC State Delta] ${label} background transaction failed; scheduling retry.`, error);
            scheduleLifecycleRetry(key, label, task);
        });
        operation.then(
            () => lifecycleEventOperations.get(key) === operation && lifecycleEventOperations.delete(key),
            () => lifecycleEventOperations.get(key) === operation && lifecycleEventOperations.delete(key),
        );
    }
    let timer = null;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), LIFECYCLE_EVENT_WAIT_MS);
    });
    const observed = operation.then(
        value => ({ timedOut: false, value }),
        error => ({ timedOut: false, error }),
    );
    const outcome = await Promise.race([observed, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.timedOut) {
        console.warn(`[NPC State Delta] ${label} exceeded ${LIFECYCLE_EVENT_WAIT_MS / 1000}s; SillyTavern may continue while the fail-closed transaction retries in the background.`);
        return false;
    }
    if (outcome.error) {
        console.error(`[NPC State Delta] ${label} failed safely; scheduling a background retry.`, outcome.error);
        scheduleLifecycleRetry(key, label, task);
        return false;
    }
    return true;
}

function registerEvents() {
    if (rt.eventsRegistered) return;
    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const source = ctx.eventSource;
    if (!source?.on) return;
    rt.eventsRegistered = true;
    for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (events[name]) source.on(events[name], syncScannerProfileControl);
    }

    if (events.MESSAGE_SENT) {
        source.on(events.MESSAGE_SENT, async (messageId) => {
            rt.replacingReply = null;
            const key = getChatKey();
            if (key === 'no-chat') return;
            // SillyTavern waits for this listener before generating. The freshness read must stay: a
            // newer dossier from another session has to be adopted (and an older local history
            // recognised) before this turn is certified or its prompt is built. It is a revalidating
            // read, so an unchanged sidecar costs a 304 rather than a full download. The generation
            // that sends this message already revalidated moments ago (GENERATION_AFTER_COMMANDS
            // runs first), so one read per send is enough.
            const recentlyChecked = rt.generationFreshness.key === key && Date.now() - rt.generationFreshness.at < GENERATION_FRESHNESS_REUSE_MS
                && chatHydrationStatus(key) === 'ready';
            rt.generationFreshness = { key: '', at: 0 };
            if (!recentlyChecked) {
                try { await ensureChatStateLoaded(key); } catch (error) { console.error('[NPC State Delta] user-turn lineage update skipped because chat hydration failed.', error); return; }
            }
            if (getChatKey() !== key) return;
            // This listener maintains branch lineage and refreshes the injection so an off-screen NPC
            // the player names reaches this generation; text never dispatches mutations.
            const sentState = getChatState();
            migrateLegacyLineage(sentState, getContext().chat || []);
            // A turn typed on a chat that is behind the adopted dossier must not replace its lineage.
            if (!staleHostActive(key)) sentState.lineage = chatLineage(getContext().chat || []);
            if (!await generationReady(key)) return;
            updateInjection();
            noteNarrationCaptureVersion(key);
        });
    }
    // Regenerate/swipe/continue answer an existing player turn without MESSAGE_SENT.
    if (events.GENERATION_AFTER_COMMANDS) {
        source.on(events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
            const key = getChatKey();
            if (dryRun || key === 'no-chat') return;
            // The capture block is asked for only in fresh replies and continues; quiet, impersonate,
            // swipe and regenerate generations never carry the instruction.
            const captureType = NARRATION_CAPTURE_TYPES.has(String(type ?? '')) && narrationCaptureEnabled();
            rt.captureRulesWithheld = !CAPTURE_RULES_TYPES.has(String(type ?? ''));
            if (type === 'quiet') {
                rt.sentCaptureRules = '';
                disarmNarrationCapture();
                // Another extension's background request never carries the capture rules. Nothing else
                // of the injection is rebuilt for it.
                if (rt.lastInjection.captureRules || rt.lastInjection.captureContext) {
                    getContext().setExtensionPrompt?.(CAPTURE_RULES_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
                    getContext().setExtensionPrompt?.(CAPTURE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
                    rt.lastInjection = { ...rt.lastInjection, captureChars: 0, captureRules: '', captureContext: '' };
                }
                return;
            }
            rt.narrationCaptureArmed = '';
            {
                const chat = getContext().chat || [];
                const last = chat[chat.length - 1];
                rt.replacingReply = (type === 'swipe' || type === 'regenerate') && last && !last.is_user && !last.is_system ? { key, message: last } : null;
            }
            // Every roleplay generation revalidates the canonical dossier (a 304 when unchanged)
            // before its prompt is built: regenerate/swipe/continue, an empty Send, impersonate and
            // group member turns have no MESSAGE_SENT, and an ordinary send reuses this read there.
            try {
                await ensureChatStateLoaded(key);
                rt.generationFreshness = { key, at: Date.now() };
            } catch (error) { console.warn('[NPC State Delta] pre-generation freshness check failed; the injection keeps the last verified dossier.', error); }
            if (getChatKey() !== key) return;
            // (timeline) The prompt is built from the selected head: the barrier is down and the gate has been asked.
            if (!await generationReady(key)) return;
            rt.narrationCaptureArmed = captureType ? key : '';
            updateInjection();
            // Armed only when the instruction actually went out (hydration may have withheld it).
            if (!rt.lastInjection.captureContext) rt.narrationCaptureArmed = '';
            if (rt.lastInjection.captureRules) holdCaptureRules();
            else rt.sentCaptureRules = '';
            noteNarrationCaptureVersion(key);
            rt.narrationCaptureWatch = rt.narrationCaptureArmed ? structuredClone(rt.lastInjection.captureEventWatch || []) : [];
        });
    }
    if (events.GENERATION_STOPPED) source.on(events.GENERATION_STOPPED, () => { rt.sentCaptureRules = ''; rt.replacingReply = null; disarmNarrationCapture(); });
    if (events.CHAT_COMPLETION_PROMPT_READY) source.on(events.CHAT_COMPLETION_PROMPT_READY, eventData => keepCaptureRules(eventData));

    if (events.MESSAGE_RECEIVED) {
        // The capture block leaves the reply before any other listener (TTS, full cast, other
        // extensions) or lineage key reads it.
        const stripCapture = messageId => { rt.sentCaptureRules = ''; rt.replacingReply = null; return receiveNarrationBlock(messageId); };
        if (typeof source.makeFirst === 'function') source.makeFirst(events.MESSAGE_RECEIVED, stripCapture);
        else source.on(events.MESSAGE_RECEIVED, stripCapture);
        source.on(events.MESSAGE_RECEIVED, async (messageId) => {
            await handleAssistantMessageReceived(messageId);
        });
    }
    if (events.CHARACTER_MESSAGE_RENDERED) source.on(events.CHARACTER_MESSAGE_RENDERED, messageId => { renderCapturedReply(messageId); queueInlineRender(0); });
    if (events.MESSAGE_UPDATED) source.on(events.MESSAGE_UPDATED, () => queueInlineRender(30));
    if (events.MORE_MESSAGES_LOADED) source.on(events.MORE_MESSAGES_LOADED, () => queueInlineRender(30));
    if (events.CHAT_LOADED) source.on(events.CHAT_LOADED, async () => {
        const key = getChatKey();
        if (key === 'no-chat') return;
        try {
            await ensureChatStateLoaded(key);
            if (getChatKey() !== key) return;
            renderDossier(); ensureInlineObserver(); queueInlineRender(0);
        } catch (error) {
            if (getChatKey() === key) { renderDossier(); updateInjection(); }
            console.error('[NPC State Delta] post-load hydration/render failed; durable data was not overwritten.', error);
        }
    });

    if (events.MESSAGE_DELETED) {
        source.on(events.MESSAGE_DELETED, (messageId) => {
            dropNarrationCaptures();
            queueBranchReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                operation: 'delete',
                rescan: true,
                reason: 'message-deleted',
            }, 70);
        });
    }
    if (events.MESSAGE_SWIPED) {
        if (typeof source.makeFirst === 'function') source.makeFirst(events.MESSAGE_SWIPED, stripSwipedNarrationBlock);
        else source.on(events.MESSAGE_SWIPED, stripSwipedNarrationBlock);
        source.on(events.MESSAGE_SWIPED, (messageId) => {
            endTargetedRewriteTolerance(messageId);
            queueSettledSwipeReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                operation: 'swipe',
                rescan: true,
                reason: 'message-swiped',
            });
        });
    }
    if (events.MESSAGE_SWIPE_DELETED) {
        source.on(events.MESSAGE_SWIPE_DELETED, (messageId) => {
            dropNarrationCaptures();
            queueSettledSwipeReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                operation: 'swipe',
                rescan: true,
                reason: 'swipe-deleted',
            });
        });
    }
    if (events.MESSAGE_EDITED) {
        source.on(events.MESSAGE_EDITED, (messageId) => {
            endTargetedRewriteTolerance(messageId);
            dropNarrationCaptures();
            queueBranchReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                operation: 'edit',
                rescan: true,
                reason: 'message-edited',
            }, 110);
        });
    }

    if (events.CHAT_CHANGED) {
        source.on(events.CHAT_CHANGED, async () => {
            rt.replacingReply = null;
            castPortraitMisses.clear();
            rt.narrationCaptureArmed = '';
            rt.sentCaptureRules = '';
            for (const cachedKey of chatStateCache.keys()) cancelScanOperation(cachedKey, 'chat changed');
            if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
            rt.branchReconcileTimer = null;
            rt.branchReconcilePending = null;
            if (rt.swipeSettlementTimer) clearTimeout(rt.swipeSettlementTimer);
            rt.swipeSettlementTimer = null;
            rt.swipeSettlementPending = null;
            rt.deferredSwipeMessageId = null;
            rt.swipeSettlementSequence += 1;
            closePortraitGenerator();
            closeNpcEditor();
            let key = getChatKey();
            staleHostChats.delete(key);
            retiredInSessionChats.delete(key);
            openingHostChats.add(key);
            try {
                if (isCanonicalChatKey(key)) await ensureChatStateLoaded(key);
                if (getChatKey() !== key) return;
                const inherited = isCanonicalChatKey(key) ? await maybeInheritKnownBranch() : false;
                if (getChatKey() !== key) return;
                const state = key === 'no-chat' ? null : getChatState(key);
                if (state) seedBranchTracking(state);
                if (inherited) persist();
                setScanIndicator(key !== 'no-chat' && isScanBusy(key));
                renderDossier();
                ensureInlineObserver();
                queueInlineRender(30);
                updateInjection();
                if (!inherited && state?.lineage?.length) queueBranchReconcile({ chatKey: key, rescan: false, reason: 'chat-changed' }, 80);
                if (key !== 'no-chat') void drainPendingAutoScan(key);
                // A cast dossier made while its picture was missing gets it now if Story Block has it (no new chat needed).
                if (key !== 'no-chat' && castPortraitDue()) castSync().catch(error => console.debug('[NPC State Delta] cast portraits were not filled', error));
                evictDormantChatStates(key);
            } catch (error) {
                if (getChatKey() === key) { renderDossier(); updateInjection(); }
                console.error('[NPC State Delta] chat change hydration failed; durable state was preserved.', error);
            } finally {
                openingHostChats.delete(key);
            }
        });
    }

    // CHAT_DELETED carries only a filename in SillyTavern. Never borrow the currently active
    // owner as proof: bulk deletion can target a different character. Ambiguous equal filenames
    // fail closed and CHARACTER_DELETED later retires the exact owner-qualified states.
    if (events.CHAT_DELETED) source.on(events.CHAT_DELETED, (chatId) => {
        const eventId = ++lifecycleEventSequence;
        return runBoundedLifecycleEvent(
            `delete:chat:${String(chatId || '')}:${eventId}`,
            'chat deletion retirement',
            () => removeDeletedChatState(chatId, 'chat', ''),
        );
    });
    if (events.GROUP_CHAT_DELETED) source.on(events.GROUP_CHAT_DELETED, (chatId) => {
        const eventId = ++lifecycleEventSequence;
        return runBoundedLifecycleEvent(
            `delete:group:${String(chatId || '')}:${eventId}`,
            'group chat deletion retirement',
            () => removeDeletedChatState(chatId, 'group', ''),
        );
    });
    if (events.CHAT_RENAMED) source.on(events.CHAT_RENAMED, (eventData) => {
        const data = eventData || {};
        const owner = String(data.groupId || data.avatarId || '');
        const eventId = ++lifecycleEventSequence;
        return runBoundedLifecycleEvent(
            `rename:${owner}:${String(data.oldFileName || '')}->${String(data.newFileName || '')}:${eventId}`,
            'chat rename',
            () => moveRenamedChatState(data),
        );
    });
}

// What a character card may recommend (Story Block 2.21.0 card settings, src/card-settings.js). Each save is the one the
// settings panel itself makes: the prompt format through "Save prompt settings", Scan every as its box does.
function nsdCardSettings() {
    return createCardSettingsDefinition({
        readFormat: () => portraitSettingsSnapshot(getSettings()).portraitPromptFormat,
        // An unsaved draft in the Portrait panel is the reader's: only the format is saved, then the draft goes back into the
        // panel with the card's format in it, still marked unsaved.
        saveFormat: async format => {
            if (!rt.portraitSettingsDirty) return savePortraitSettingsDraft({ portraitPromptFormat: format });
            const draft = portraitSettingsDraftFromUi();
            const saved = await savePortraitSettingsDraft({ portraitPromptFormat: format });
            if (saved) {
                writePortraitSettingsDraftToUi({ ...draft, portraitPromptFormat: format });
                rt.portraitSettingsDirty = true;
                updatePortraitSettingsSaveUi();
            }
            return saved;
        },
        readScanEvery: () => getSettings().scanEvery,
        saveScanEvery: value => {
            const next = Math.max(SCAN_EVERY_RANGE.min, Math.min(SCAN_EVERY_RANGE.max, Math.round(Number(value)) || 2));
            getSettings().scanEvery = next;
            $('#npc_state_delta_scan_every').val(next);
            persistSettings();
            return true;
        },
    });
}

async function init() {
    if (rt.initialized) {
        scheduleSettingsMountRetries();
        return;
    }
    rt.initialized = true;
    getSettings();
    clearLegacyPromptKeys();
    connectStorySuite();
    // Story Suite v2 (Story Block 2): optional; without a v2 host the adapter does nothing.
    import('./src/storysuite-v2.js').then(v2 => { rt.storySuiteV2 = v2.startStorySuiteV2({ suiteApi: SUITE_API, panelId: UI_ID, version: NPC_STATE_VERSION, headReply: latestReplyIndex, castSync, castPortraitDue, calendarOwn: () => normalizeSourceOfTruth(getSettings().sourceOfTruth).calendar === 'mine', cardSettings: nsdCardSettings() }); }).catch(error => console.debug('[NPC State Delta] Story Suite v2 adapter is not available', error));
    // (v2) Hosted with Story Director, the story's date follows its clock (calendar.js hostedStoryDate)
    // unless the reader keeps the calendar here (Source of truth: calendar "mine"). No host: none.
    setStoryClockSource(hostedStoryClock);
    bindUi();
    installUiCaptureBridge();
    registerEvents();
    startInlineWatchdog();
    globalThis.addEventListener?.('pagehide', flushCurrentChatOnPageHide);
    globalThis.addEventListener?.('pageshow', () => { void refreshCurrentChatFromServer('pageshow'); });
    globalThis.document?.addEventListener?.('visibilitychange', () => {
        if (globalThis.document?.visibilityState === 'hidden') flushCurrentChatOnPageHide();
        else if (globalThis.document?.visibilityState === 'visible') void refreshCurrentChatFromServer('visibility-resume');
    });
    scheduleSettingsMountRetries();

    let key = getChatKey();
    try {
        if (isCanonicalChatKey(key)) {
            await ensureChatStateLoaded(key);
            if (getChatKey() !== key) return;
            await maybeInheritKnownBranch();
            if (getChatKey() !== key) return;
            seedBranchTracking(getChatState(key));
        }
    } catch (error) {
        console.error('[NPC State Delta] startup hydration failed; extension remains mounted in read-only recovery mode.', error);
        if (getChatKey() === key) renderDossier();
    }
    updateInjection();
    evictDormantChatStates(getChatKey());
    console.log(`[NPC State Delta] v${NPC_STATE_VERSION} loaded`);
}

async function safeInit() {
    try {
        await init();
    } catch (error) {
        rt.initialized = false;
        console.error('[NPC State Delta] initialization failed', error);
    }
}

$(safeInit);

// Some SillyTavern builds finish extension discovery after DOM ready. Re-running the
// idempotent bootstrap on lifecycle events makes the settings card appear reliably.
try {
    const bootContext = getContext();
    const bootEvents = bootContext.eventTypes || bootContext.event_types || {};
    if (bootContext.eventSource?.on) {
        if (bootEvents.APP_READY) bootContext.eventSource.on(bootEvents.APP_READY, safeInit);
        if (bootEvents.EXTENSION_SETTINGS_LOADED) bootContext.eventSource.on(bootEvents.EXTENSION_SETTINGS_LOADED, safeInit);
    }
} catch (error) {
    console.debug('[NPC State Delta] lifecycle bootstrap will rely on DOM ready.', error);
}

globalThis.__NPCStateDeltaLifecycle = Object.freeze({
    flushOwner: flushLifecycleOwner,
    invalidateOwner: invalidateLifecycleOwner,
    invalidateKey: key => clearLifecycleCacheKey(key, 'external-lifecycle'),
    resolveDeletedKey: resolveDeletedChatKey,
});

// Small debug surface for deployment tests.
window.NPCStateDelta = Object.freeze({
    version: NPC_STATE_VERSION,
    scan: () => scanNow({ manual: true }),
    cancelScan: () => { const key = getChatKey(); pendingAutoScans.delete(key); return cancelScanOperation(key, 'user cancelled'); },
    scannerRouting: scannerRoutingMetrics,
    // (v2 Diagnostics) The scanner's plain lines for Story Block's report: route, profile, calls, last outcome.
    scannerReport: () => scannerDiagnosticLines({ ctx: getContext(), settings: getSettings(), enabled: !!getSettings().enabled }),
    processBackfills: processPendingBackfills,
    scanDossier: async value => {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('scan a dossier', key)) return false;
        const npc = findNpcByIdOrName(value);
        return npc ? scanNpcDossier(npc.id) : false;
    },
    refreshFromChat: async value => {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('refresh a dossier', key)) return false;
        const npc = findNpcByIdOrName(value);
        return npc ? refreshNpcFromChat(npc.id) : false;
    },
    portraitPrompts: (value, { form = '' } = {}) => {
        const npc = findNpcByIdOrName(value);
        if (!npc) return null;
        const formName = form ? npcFormName(npc, form) : '';
        return npcImagePromptPair(formName ? { ...npc, currentForm: formName, currentFormUnknown: false } : npc);
    },
    formPortraits: value => {
        const npc = findNpcByIdOrName(value);
        const forms = npc ? getChatState().formPortraitAssets?.[npc.id] || {} : {};
        return Object.fromEntries(Object.values(forms).filter(portrait => portrait?.dataUrl).map(portrait => [portrait.form, structuredClone(portrait)]));
    },
    generatePortraitUrl: async (value, overrides = {}) => {
        const npc = findNpcByIdOrName(value);
        if (!npc) return null;
        const prompts = npcImagePromptPair(npc);
        return executeNativePortraitGeneration(
            String(overrides?.positive ?? prompts.positive).trim(),
            String(overrides?.negative ?? prompts.negative).trim(),
            overrides?.seed !== undefined ? overrides.seed : npc.portraitSeed,
        );
    },
    openPortraitGenerator: value => { const npc = findNpcByIdOrName(value); return npc ? openPortraitGenerator(npc.id) : false; },
    portraitSettings: () => portraitSettingsSnapshot(getSettings()),
    portraitSettingsDirty: () => rt.portraitSettingsDirty,
    savePortraitSettings: draft => savePortraitSettingsDraft(draft),
    /** What a character card may recommend (the definition Story Block 2.21.0 registers as card settings). */
    cardSettings: () => nsdCardSettings(),
    render: renderDossier,
    renderInline: renderInlineCards,
    openEditor: value => { const npc = findNpcByIdOrName(value); return npc ? openNpcEditorSafely(npc.id) : false; },
    openDossier: value => { const npc = findNpcByIdOrName(value); return npc ? openLauncherDossier(npc.id) : false; },
    injectionPreview: () => structuredClone(injectionPreview()),
    isEnabled: () => getSettings().enabled !== false,
    uiStatus: () => ({
        version: NPC_STATE_VERSION,
        chatKey: getChatKey(),
        hydrationStatus: chatHydrationStatus(getChatKey()),
        hydrationError: hydrationErrors.get(getChatKey())?.message || null,
        scanBusyForChat: isScanBusy(getChatKey()),
        scanOperation: scanOperations.status(getChatKey()),
        scannerRouting: scannerRoutingMetrics(),
        narrationCapture: { ...narrationCaptureStats, enabled: narrationCaptureEnabled(), armed: Boolean(rt.narrationCaptureArmed), pending: narrationCaptures.size },
        inlineEntries: chatHydrationStatus(getChatKey()) === 'ready' ? (getChatState().inlineCards?.length || 0) : 0,
        mountedInlineAnchors: document.querySelectorAll?.('.npc-state-delta-inline-anchor')?.length || 0,
        integratedMeguminBlocks: document.querySelectorAll?.('.npc-state-delta-megumin-pane')?.length || 0,
        settingsPanelMounted: Boolean(document.querySelector?.(`#${UI_ID}`)),
        rosterMounted: Boolean(document.querySelector?.('#npc_state_delta_roster_summary')),
        editorMounted: editorIsMounted(),
        editorMode: rt.activeEditorPopup ? 'sillytavern-popup' : 'closed',
        presentCastDisplay: presentCastDisplayMode(),
        portraitGeneratorOpen: Boolean(rt.activePortraitGeneratorOverlay),
        portraitGeneratorNpcId: rt.activePortraitGeneratorNpcId || null,
        portraitGenerationBusy: rt.portraitGenerationBusy,
        inlineAnchors: document.querySelectorAll?.('.npc-state-delta-inline-anchor')?.length || 0,
        inlineObserver: Boolean(rt.inlineObserver && rt.inlineObserverChat),
        inlineNeedsRepair: inlineMountNeedsRepair(),
        lastScan: rt.lastScanMetrics ? { ...rt.lastScanMetrics } : null,
        branchHistory: chatHydrationStatus(getChatKey()) === 'ready' ? branchHistoryDiagnostic(getChatState()) : null,
        branchReconciliations: branchReconciliationEvents
            .filter(event => event.chatKey === getChatKey())
            .slice(-8)
            .map(event => structuredClone(event)),
        swipeState: hostSwipeState(),
        swipeSettlementPending: Boolean(rt.swipeSettlementPending || rt.swipeSettlementTimer),
        hydratedRevision: hydratedRevision(getChatKey()),
        latestObservedServerRevision: hydratedStateMeta.get(getChatKey())?.latestObservedServerRevision ?? null,
        freshnessLastCheckedAt: hydratedStateMeta.get(getChatKey())?.lastCheckedAt || null,
        freshnessEvents: freshnessEvents
            .filter(event => event.chatKey === getChatKey())
            .slice(-8)
            .map(event => structuredClone(event)),
    }),
    ensureFresh: async (options = {}) => {
        const key = getChatKey();
        if (!key || key === 'no-chat') return false;
        if (!hydratedChatKeys.has(key)) await ensureChatStateLoaded(key, { probeMissing: true });
        else await ensureHydratedStateFresh(key, { reason: String(options?.reason || 'public-freshness-check'), notify: options?.notify === true, probeMissing: true });
        return getChatKey() === key;
    },
    exportBytes: async ({ chatKey = '' } = {}) => {
        const key = getChatKey();
        if (chatKey && chatKey !== key) throw new Error('The active chat changed before export; nothing was exported.');
        if (!await ensureFreshMutationBoundary('export a dossier', key, { notify: false })) throw new Error('NPC State Delta canonical server dossier is unavailable.');
        if (getChatKey() !== key) throw new Error('The active chat changed before export; nothing was exported.');
        return exportBundleBytes();
    },
    importBytes: async bytes => {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('import a dossier', key)) return false;
        return importBundleBytes(bytes);
    },
    reconcile: (options = {}) => reconcileCurrentBranch(options),
    scanMetrics: () => rt.lastScanMetrics ? { ...rt.lastScanMetrics } : null,
    diagnosticsSummary: () => diagnosticStore.summary(getChatKey()),
    diagnosticsRecords: options => diagnosticStore.records(getChatKey(), options || {}),
    diagnosticsForNpc: npcId => diagnosticStore.records(getChatKey(), { npcId: String(npcId || '') }),
    diagnosticBundle: () => {
        const key = getChatKey();
        const bundle = diagnosticStore.bundle(key, { applicationVersion: NPC_STATE_VERSION });
        // Rollback diagnostics carry counts, message numbers and outcomes only: no story text and no chat key.
        const chatMessages = getContext().chat || [];
        bundle.branch = {
            chat: key === 'no-chat' ? null : {
                messages: chatMessages.length,
                hiddenOrSystemMessages: chatMessages.filter(message => message?.is_system).length,
                storedLineageDivergence: firstLineageDivergence(getChatState(key)?.lineage || [], chatLineage(chatMessages)),
                turn: Number(getChatState(key)?.turn || 0),
            },
            history: key === 'no-chat' ? null : branchHistoryDiagnostic(getChatState(key)),
            reconciliations: branchReconciliationEvents.filter(event => event.chatKey === key).slice(-20)
                .map(({ chatKey, history, ...event }) => event),
        };
        // Session counters only; the instruction and blocks themselves are never exported.
        bundle.narrationCapture = { ...narrationCaptureStats, enabled: narrationCaptureEnabled(), pending: narrationCaptures.size };
        return bundle;
    },
    clearDiagnostics: () => diagnosticStore.clear(getChatKey()),
    getState: () => structuredClone(getChatState()),
    // (timeline participant) A state as installState keeps it: normalized like the chat's state, on a copy (nothing stored).
    normalizeState: state => structuredClone(normalizeChatState(state)),
    // (timeline participant, src/storysuite-participant/) The open chat's key; SillyTavern's request headers for its user files; and an
    // absolute, durable replacement of the chat's native state (a restore to a save point), refused unless it is the open chat's.
    chatKey: () => getChatKey(),
    requestHeaders: () => requestHeaders(),
    installState: async state => {
        const key = getChatKey();
        if (!key || key === 'no-chat') throw new Error('There is no open chat to put a native state into.');
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('A native state is an object.');
        if (!await ensureFreshMutationBoundary('restore a native checkpoint', key, { notify: false })) throw new Error('NPC State Delta canonical server dossier is unavailable.');
        if (getChatKey() !== key) throw new Error('The active chat changed before the native state was installed; nothing was installed.');
        return quietly(key, async () => {
            setChatState(key, state, { markLoaded: true });
            if (!await persistCriticalDurable(key)) throw new Error('The restored native state could not be saved yet.');
            renderDossier();
            updateInjection();
            return true;
        });
    },
    // The participant's block (`state.timeline`: lineage, np_ map, reserved ids, applied deaths) written into the chat's state and made durable.
    // Not a native change; the state object stays the one running scans hold.
    writeTimeline: async block => {
        const key = getChatKey();
        if (!key || key === 'no-chat') throw new Error('There is no open chat.');
        if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('A timeline block is an object.');
        if (!await ensureFreshMutationBoundary('record the story line', key, { notify: false })) throw new Error('NPC State Delta canonical server dossier is unavailable.');
        if (getChatKey() !== key) throw new Error('The active chat changed before the block was written.');
        return quietly(key, async () => {
            getChatState(key).timeline = structuredClone(block);
            if (!await persistCriticalDurable(key)) throw new Error('The story line could not be saved yet.');
            return true;
        });
    },
    // Told after every durable change of the open chat's state that is not the participant's own; returns the way to stop.
    onNativeChange: listener => {
        if (typeof listener !== 'function') return () => {};
        nativeChangeListeners.add(listener);
        return () => { nativeChangeListeners.delete(listener); };
    },
    // Whether the open chat uses the timeline (its state has a story line), read without cloning the state; whether the open chat's dossier state is
    // loaded; and whether a scan or pass is in flight.
    timelineStarted: () => Boolean(chatStateCache.get(getChatKey())?.timeline?.lineage),
    // A branch still waiting for its parent's dossiers, and the inheritance itself (run now; idempotent: an inherited state is not empty).
    branchPending: () => branchInheritancePending(),
    inheritBranch: () => maybeInheritKnownBranch(),
    stateReady: () => chatHydrationStatus() === 'ready',
    scanActive: () => scanWorkPending(),
    scanIdle: ms => scanIdle(ms),
    // Which messages the story stands on (the Story Suite adapter's gate): scans do not read what Story Block faded.
    useMessageGate: gate => useMessageGate(gate),
    // (v2 meters) Delta's base relationship values: where a new NPC's slice meters start.
    relationshipBaseline: () => normalizeRelationshipBaseline(getSettings().relationshipBaseline),
    // (v2 meters) Delta's impact-tier caps: the most a story line's `~ npc` move can be at each tier.
    relationshipCaps: () => normalizeRelationshipCaps(getSettings().relationshipCaps),
    presentCastHtml: () => storyBlockCastHtml(),
    // (1.2.13) Why the present cast is empty ({ text, scan }), and Add NPC, for the Story Block tabs.
    castEmptyReason: () => castEmptyReason(),
    addNpc: () => addNpcManually(),
    /** Fill the now/chatter text of present-cast markup inserted under `root` (textContent only). */
    fillPresentCast: root => fillPresentSceneText(root),
    dossierRevision: () => `${getChatKey()}|${Number(stateVersions.get(getChatKey()) || 0)}`,
    /** The current chat's dossiers are loaded (before that the list is empty and a render is not news). */
    dossiersReady: () => { const key = getChatKey(); return key !== 'no-chat' && chatHydrationStatus(key) === 'ready'; },
    getNpc: npcId => {
        const npc = getChatState().npcs.find(item => item.id === String(npcId || ''));
        return npc ? structuredClone(npc) : null;
    },
    /** What the public paths read of a dossier without copying it (no portraits, no notes): { mood, relationship } as plain values, or null. */
    publicFields: npcId => {
        const npc = getChatState().npcs.find(item => item.id === String(npcId || ''));
        if (!npc) return null;
        const relationship = npc.relationship && typeof npc.relationship === 'object' ? { ...npc.relationship } : {};
        return { mood: typeof npc.mood === 'string' ? npc.mood : null, relationship };
    },
    /** The configured custom field names (the dossier shows these; a stored value under another name stays in the editor only). */
    customFieldNames: () => [...getSettings().customFieldNames],
    /** (the living cast) The reader pins this dossier's person as a key person (Story Director's `keypeople.pin`) → { ok, message }. */
    pinKeyPerson: async npcId => {
        const adapter = storySuiteV2Meters();
        const npc = getChatState().npcs.find(item => item.id === String(npcId || ''));
        if (!adapter || !npc) return { ok: false, message: 'Story Director does not offer Key people here.' };
        return adapter.pinKeyPerson({ name: npc.name, aliases: npc.aliases });
    },
    getDossierState: () => {
        const state = getChatState();
        const formPortraits = {};
        for (const [npcId, forms] of Object.entries(state.formPortraitAssets || {})) {
            formPortraits[npcId] = Object.fromEntries(Object.values(forms || {}).filter(portrait => portrait?.dataUrl)
                .map(portrait => [portrait.form, { dataUrl: portrait.dataUrl, appearanceFingerprint: portrait.appearanceFingerprint || '' }]));
        }
        return { turn: state.turn, reply: latestReplyIndex(), npcs: viewNpcCopies(hostedMeterView(state.npcs)), portraitAssets: {}, formPortraits, customFieldNames: [...getSettings().customFieldNames], ...dossierHostViews(state) };
    },
    /** (perf) What the dossier panel needs before it draws: the chat and its load state (uiStatus also builds branch diagnostics). */
    dossierViewStatus: () => {
        const key = getChatKey();
        return { chatKey: key, hydrationStatus: chatHydrationStatus(key), hydrationError: hydrationErrors.get(key)?.message || null };
    },
    /**
     * (perf) A cheap token of everything getDossierState shows: the chat and its load state, the stored revision (every durable
     * write moves it), the latest reply, the configured fields, which portrait files are known gone, and the host's views and
     * meter numbers. The panel draws again only when it moves.
     */
    dossierViewToken: () => {
        const key = getChatKey();
        const hydration = chatHydrationStatus(key);
        if (key === 'no-chat' || hydration !== 'ready') return JSON.stringify([key, hydration, hydrationErrors.get(key)?.message || null]);
        const state = getChatState(key);
        const npcs = hostedMeterView(state.npcs);
        return JSON.stringify([key, hydration, Number(stateVersions.get(key) || 0), latestReplyIndex(), getSettings().customFieldNames, portraitFilesVersion(),
            npcs === state.npcs ? null : npcs.map(npc => npc?.relationship ?? null), dossierHostViews(state)]);
    },
    persistenceStatus: () => {
        const key = getChatKey();
        return {
            currentChatPending: Number(stateVersions.get(key) || 0) > Number(persistedVersions.get(key) || 0),
            writeInFlight: stateWritePromises.has(key),
            writeScheduled: stateWriteTimers.has(key),
            hydratedRevision: hydratedRevision(key),
            latestObservedServerRevision: hydratedStateMeta.get(key)?.latestObservedServerRevision ?? null,
            recoverySnapshot: Boolean(undurableNpcStateSnapshot(key)),
        };
    },
    updateAppearance: async (npcId, draft, options = {}) => {
        const key = options.chatKey || getChatKey();
        return runFreshMutation('edit appearance forms', key, () => updateNpcAppearance(npcId, draft, options));
    },
    updateLifeState: async (npcId, choice, options = {}) => {
        const key = options.chatKey || getChatKey();
        return runFreshMutation('edit life state', key, () => updateNpcLifeState(npcId, choice, options));
    },
    setPortrait: setNpcPortrait,
    setPortraitSeed: async (npcId, seed, options = {}) => {
        const key = options.chatKey || getChatKey();
        return runFreshMutation('edit portrait seed', key, () => setNpcPortraitSeed(npcId, seed, options));
    },
    removePortrait: async (npcId, options = {}) => {
        const key = options.chatKey || getChatKey();
        return runFreshMutation('remove a portrait', key, () => removeNpcPortrait(npcId, options));
    },
    flush: () => flushStateFile(),
    dataFile: () => structuredClone(getSettings().dataFiles?.[getChatKey()] || null),
    archive: npcId => runFreshMutation('archive a dossier', getChatKey(), () => setNpcArchiveStateById(npcId, true, { reason: 'manual', confirmAction: false })),
    restore: npcId => runFreshMutation('restore a dossier', getChatKey(), () => setNpcArchiveStateById(npcId, false, { confirmAction: false })),
    deleteNpc: npcId => runFreshMutation('delete a dossier', getChatKey(), () => deleteNpcById(npcId, { confirmAction: false })),
});
