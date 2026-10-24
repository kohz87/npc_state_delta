/* NPC State Delta - standalone SillyTavern extension */
import { extension_settings, getContext } from '../../../extensions.js';
import { extension_prompt_types, extension_prompt_roles, getRequestHeaders, saveSettings as saveHostSettings } from '../../../../script.js';
import {
    isEmptyScannerAnswer,
    isScannerRoutingError,
    scannerRoutingError,
    scannerRoutingMetrics,
    scannerProfileOptions,
    scannerDiagnosticLines,
    normalizeScannerMaxOutputTokens,
} from './scanner-routing.js';
import { normalizeRelationshipMapSettings } from './relationship-map-core.js';
import {
    AUTOMATIC_BACKFILL_QUEUE_VERSION,
    AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
    automaticBackfillStillRelevant,
    backfillNeedsRequest,
    normalizeAutomaticBackfillRequest,
    npcParticipatesInExchange,
} from './scan-context.js';
import { createDiagnosticStore } from './diagnostics-core.js';
import { EDITOR_FIELDS, editorManualMemories, editorProfileLocks, settleEditorSave, untouchedEditorFields } from './src/dossier-edit.js';
import { REFRESH_CHANGED_FIELDS, snapshotNpc } from './src/fields/registry.js';
import {
    cleanMessage,
    recentTranscript,
    recentUserDevelopmentContext,
    currentExchangeUserDevelopmentContext,
    currentExchangeTranscript,
    currentExchangeProse,
    storyDayAt,
    storyDaysForTranscript,
    currentExclusions,
    useTranscriptSource,
    refreshMessageGate,
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
    DEFAULT_RELATIONSHIP_CAPS,
    DEFAULT_RELATIONSHIP_CRITERIA,
    DEFAULT_IMPACT_CRITERIA,
    DEFAULT_MEMORY_CRITERIA,
    DEFAULT_BEHAVIOR_CRITERIA,
    IMPORTANT_MEMORY_LIMIT,
    KEY_RELATIONSHIP_LIMIT,
    BEHAVIOR_PROFILE_LIMIT,
    inferNpcIdentityKind,
    normalizeRelationshipBaseline,
    normalizeRelationshipCaps,
    normalizeRelationshipProgress,
    inferManualRelationshipMilestones,
    normalizeRelationshipEvidence,
    relationshipEventMessage,
    prepareFullWindowRelationshipPayload,
    relationshipSummaryConsistent,
    calibrateRelationshipSummary,
    normalizeNpcAdmissionMode,
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
    manualLifeStateRecord,
    protectTerminalNpc,
    extractNarrationCapture,
    parseNarrationCapture,
    buildNarrationCapturePrompt,
    buildNarrationCaptureParts,
    tagScanEvidence,
    npcMatchesLabel,
    normalizeName,
    normalizeGender,
    normalizeNpcRecord,
    normalizeNpcCandidate,
    resolveInterimIdentityPromotions,
    setNpcArchived,
    hasCompactMeguminWorldState,
    extractExplicitKeyRelationshipEdges,
    applyStaleNpcLifecycle,
    DEFAULT_PORTRAIT_STYLE_POSITIVE,
    DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    DEFAULT_PORTRAIT_COMPOSITION,
    PORTRAIT_STYLE_PROMPT_LIMIT,
    PORTRAIT_COMPOSITION_PROMPT_LIMIT,
    PORTRAIT_NPC_PROMPT_LIMIT,
    normalizePortraitSeed,
    normalizePortraitPromptFormat,
    buildNpcPortraitPrompts,
    appearanceDraftRecord,
    appearanceFingerprint,
    formPortraitKey,
    formPortraitFor,
    normalizeFormPortraitAssets,
    normalizeCustomFieldNames,
    normalizeCustomFields,
    setExternalCalendarSource,
    setStoryClockSource,
    currentPresentationText,
} from './core.js';
import { applyNpcBirthdayUpdate, normalizeBirthDate } from './birthday.js';
import {
    encodeNpcStateBundle,
    mergeImportedDossierState,
} from './bundle.js';
import { decodeDeltaNativeBundle, nativeStateForTarget } from './native-transfer.js';
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
    addUserDismissedGroup,
    clearUserDismissedGroupsFor,
    ensureBranchParentAnchor,
    normalizeUserDismissedGroups,
    recordBranchCheckpoint,
    migrateLegacyLineage,
    reconcileBranchState,
    snapshotBranchState,
} from './branch.js';
import {
    normalizeSocialGraph,
    reconcileSocialState,
    applyManualKeyRelationshipEdit,
    removeNpcFromSocialGraph,
    purgeNpcStructuredReferences,
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
    undurableNpcStateSnapshot,
    writeNpcStateDataFile,
} from './storage.js';
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
import { storySuite } from './suite.js';
import {
    SUITE_AREAS,
    SUITE_SHOWS,
    NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS,
    announceNpcStateDelta,
    areaOwner,
    buildManageApi,
    buildNpcProfiles,
    defersArea,
    ensureSuiteStylesheet,
    replyTokenEstimate,
    resolveDossierTarget,
    storyBlockIsV2,
    externalCalendar,
    normalizeSourceOfTruth,
    openSuiteOverlay,
    statsOverlapWarning,
    suiteManageAvailable,
} from './suite-handshake.js';
import {
    chatterSlotsHtml,
    fillPresentSceneText,
    matchPresentCard,
    nowSlotHtml,
    othersSlotsHtml,
    presentSceneModel,
    rememberPresentScene,
    sceneAttr,
    speakerChatterHtml,
    speakerGroups,
    storyBlockTags,
    worldStatePeople,
} from './present-scene.js';
import { escapeHtml } from './src/util/html.js';

const EXTENSION_NAME = 'npc_state_delta';
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
let eventsRegistered = false;
let initialized = false;
let mountRetryTimer = null;
let inlineRenderTimer = null;
let inlineObserver = null;
let inlineObserverChat = null;
let inlineWatchdogTimer = null;
let uiCaptureBridgeInstalled = false;
let activeEditorPopup = null;
let activeEditorChatKey = '';
let activeEditorBaseRevision = null;
let activePortraitGeneratorOverlay = null;
let activePortraitGeneratorChatKey = '';
let activePortraitGeneratorNpcId = '';
let activePortraitGenerationUrl = '';
let portraitGenerationBusy = false;
let portraitSettingsDirty = false;
let portraitSettingsSaveBusy = false;
let lastPresentCardActivation = { npcId: '', at: 0 };
let lastEditorActivation = { npcId: '', at: 0 };
let lastScanMetrics = null;
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
let branchReconcileTimer = null;
let branchReconcilePending = null;
const branchReconciliationEvents = [];
const BRANCH_RECONCILIATION_EVENT_LIMIT = 16;
let swipeSettlementTimer = null;
let swipeSettlementPending = null;
let deferredSwipeMessageId = null;
let swipeSettlementSequence = 0;
const SWIPE_SETTLE_POLL_MS = 80;
const SWIPE_SETTLE_TIMEOUT_MS = 120000;
const INLINE_HISTORY_LIMIT = 80;
const STATE_WRITE_DELAY = 120;
const chatStateCache = new Map();
const hydratedChatKeys = new Set();
const hydratedStateMeta = new Map();
const workingCopyAdoptions = new Map();
const freshnessChecks = new Map();
// Chats whose deterministic sidecar this session looked for and did not find: "no sidecar yet" is
// an empty dossier. While a Story Block v2 host carries Delta, automatic boundaries (chat events,
// scan start and commit) trust that miss instead of asking the server again each time
// (sidecarMissTrusted). The reader's own actions, page resume and the first save still look, and
// that save never overwrites a file another session created. Without a v2 host nothing changes.
const missingSidecarChats = new Set();
const freshnessEvents = [];
const FRESHNESS_EVENT_LIMIT = 24;
const loadingChatStates = new Map();
const hydrationErrors = new Map();
const pendingAutoScans = new Map();
const assistantReceipts = new Map();
// One-pass narration capture: armed for each roleplay reply, stripped from the stored message on
// receipt and consumed once by that message's automatic scan in place of the scanner request.
// Kept in memory only; an edit, reload or broken block falls back to the ordinary scan.
const narrationCaptures = new Map();
const NARRATION_CAPTURE_LIMIT = 8;
const narrationCaptureStats = { requested: 0, used: 0, missing: 0, invalid: 0, unterminated: 0, outdated: 0 };
// The size of the last accepted one-pass capture block this session (0 until one arrives).
let lastCaptureBlockChars = 0;
// Swipe and regenerate rebuild the branch after the reply arrives, so their instruction would
// describe the replaced sibling; only fresh replies and continues are asked for a block.
const NARRATION_CAPTURE_TYPES = new Set(['', 'normal', 'continue']);
// (b6-soak-3) The capture's rules, which never change from reply to reply, stay in the system prompt
// on these roleplay generations too, swipes and regenerates included, so the prompt's cached head is
// the same on a swipe; only the reminder and context (the request for a block) follow the arming.
// Quiet and impersonate generations never carry them.
const CAPTURE_RULES_TYPES = new Set([...NARRATION_CAPTURE_TYPES, 'swipe', 'regenerate']);
let captureRulesWithheld = false;
// (b6-soak-5) Replies whose capture block was removed at MESSAGE_RECEIVED, re-rendered once the host
// has drawn them (CHARACTER_MESSAGE_RENDERED): at MESSAGE_RECEIVED the reply is not fully drawn.
const captureRerenderPending = new Set();
let narrationCaptureArmed = '';
let narrationCaptureVersion = null;
const stateWriteTimers = new Map();
const stateWritePromises = new Map();
const stateVersions = new Map();
const persistedVersions = new Map();
const ownershipEpochs = new Map();
const chatCacheTouches = new Map();
const CHAT_CACHE_LIMIT = 6;
const SCAN_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;
const LIFECYCLE_EVENT_WAIT_MS = 12_000;
const LIFECYCLE_RETRY_DELAY_MS = 30_000;
const lifecycleEventOperations = new Map();
const lifecycleRetryTimers = new Map();
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

const PORTRAIT_THEME_PRESETS = Object.freeze({
    fantasy_anime: {
        label: 'Fantasy Anime',
        positive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
        negative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    },
    anime_key_visual: {
        label: 'Anime Key Visual',
        positive: 'high-end fantasy anime key visual, crisp expressive linework, polished cel shading, luminous detailed eyes, elegant costume rendering, cinematic color design, studio-quality character illustration',
        negative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    },
    painterly_fantasy: {
        label: 'Painterly Fantasy',
        positive: 'painterly fantasy character portrait, refined brushwork, detailed face and eyes, rich textile rendering, atmospheric cinematic light, elegant high-fantasy illustration',
        negative: 'low quality, blurry, bad anatomy, malformed hands, extra limbs, duplicate character, text, watermark, logo, flat cel shading, cheap 3d render',
    },
    dark_medieval: {
        label: 'Dark Medieval',
        positive: 'grounded dark medieval fantasy character portrait, weathered materials, restrained dramatic lighting, detailed practical clothing and armor, serious illustrated realism',
        negative: 'low quality, blurry, bad anatomy, extra limbs, duplicate character, text, watermark, logo, neon cyberpunk, modern streetwear, glossy plastic armor',
    },
    semi_realistic: {
        label: 'Semi-Realistic',
        positive: 'semi-realistic fantasy character portrait, natural facial anatomy, detailed eyes and hair, realistic fabric and metal textures, soft cinematic lighting, polished digital illustration',
        negative: 'low quality, blurry, bad anatomy, malformed hands, extra limbs, duplicate character, text, watermark, logo, chibi, super-deformed proportions, cheap 3d render',
    },
    custom: { label: 'Custom Library', positive: '', negative: '' },
});

const PORTRAIT_CUSTOM_PRESET_LIMIT = 24;
const DEFAULT_CUSTOM_PORTRAIT_PRESET_ID = 'custom-default';

function portraitCustomPreset(raw = {}, index = 0) {
    const id = String(raw.id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 64)
        || (index === 0 ? DEFAULT_CUSTOM_PORTRAIT_PRESET_ID : `custom-${index + 1}`);
    const name = String(raw.name || '').trim().slice(0, 80) || `Custom ${index + 1}`;
    return {
        id,
        name,
        positive: String(raw.positive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        negative: String(raw.negative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        composition: String(raw.composition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
        promptFormat: normalizePortraitPromptFormat(raw.promptFormat ?? 'hybrid'),
        useMood: raw.useMood !== undefined ? Boolean(raw.useMood) : true,
        useLocation: raw.useLocation !== undefined ? Boolean(raw.useLocation) : false,
    };
}

function portraitCustomPresetLibrary(raw) {
    const source = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const result = [];
    for (let index = 0; index < source.length && result.length < PORTRAIT_CUSTOM_PRESET_LIMIT; index += 1) {
        const preset = portraitCustomPreset(source[index], index);
        let id = preset.id;
        let suffix = 2;
        while (seen.has(id)) id = `${preset.id.slice(0, 56)}-${suffix++}`;
        seen.add(id);
        result.push({ ...preset, id });
    }
    if (!result.length) {
        result.push(portraitCustomPreset({
            id: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID,
            name: 'Custom 1',
        }, 0));
    }
    return result;
}

function portraitCustomPresetFor(source = {}, id = '') {
    const presets = portraitCustomPresetLibrary(source.portraitCustomPresets);
    const selectedId = String(id || source.portraitCustomPresetId || '').trim();
    return presets.find(item => item.id === selectedId) || presets[0];
}

function nextPortraitCustomPresetId(presets = []) {
    const taken = new Set((presets || []).map(item => String(item?.id || '')));
    const base = `custom-${Date.now().toString(36)}`;
    let id = base;
    let suffix = 2;
    while (taken.has(id)) id = `${base}-${suffix++}`;
    return id;
}

function portraitCustomPresetNameKey(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function portraitCustomPresetNameTaken(presets, name, excludeId = '') {
    const key = portraitCustomPresetNameKey(name);
    if (!key) return false;
    return (presets || []).some(item => String(item?.id || '') !== String(excludeId || '')
        && portraitCustomPresetNameKey(item?.name) === key);
}

function uniquePortraitCustomPresetName(presets, base, excludeId = '') {
    const root = String(base || 'Custom').trim().slice(0, 72) || 'Custom';
    if (!portraitCustomPresetNameTaken(presets, root, excludeId)) return root;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${root} ${suffix}`.slice(0, 80);
        if (!portraitCustomPresetNameTaken(presets, candidate, excludeId)) return candidate;
    }
    return `${root.slice(0, 68)} ${Date.now().toString(36)}`.slice(0, 80);
}


const DEFAULTS = Object.freeze({
    schemaVersion: 30,
    enabled: true,
    autoScan: true,
    fullScanEveryTurn: false,
    narrationCapture: false,
    // (1.2.11) With one-pass capture: a quiet Refresh of the NPCs most in the last N captured
    // replies (0 = never), for the slow fields a block beside the story tends to leave thin.
    narrationCaptureCatchUp: 8,
    // (1.2.17) Opt-in: the one-pass rules in fewer words (about 500 tokens less per armed reply).
    narrationCaptureCompact: false,
    scannerConnectionProfile: '',
    portraitGenerationEnabled: true,
    portraitThemePreset: 'fantasy_anime',
    portraitCustomPresetId: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID,
    portraitCustomPresets: [portraitCustomPreset({ id: DEFAULT_CUSTOM_PORTRAIT_PRESET_ID, name: 'Custom 1' })],
    portraitStylePositive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
    portraitStyleNegative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
    portraitComposition: DEFAULT_PORTRAIT_COMPOSITION,
    portraitPromptFormat: 'hybrid',
    portraitUseMood: true,
    portraitUseLocation: false,
    portraitSaveToGallery: false,
    scanEvery: 1,
    scanDepth: 6,
    maxNpcs: 40,
    autoPruneStale: true,
    staleArchiveAfter: 30,
    staleDeleteAfter: 50,
    admissionMode: 'conservative',
    inject: true,
    // (1.2.16) 0: after the player's message, the cache-friendly tail. An install still on the old
    // default 1 is moved once (injectDepthTailUpgraded); any other depth the player set is kept.
    injectDepth: 0,
    // How many present NPCs the live dossier carries at most (the most relevant first).
    injectLimit: 3,
    injectBudgetTokens: 4000,
    customFieldNames: [],
    sourceOfTruth: normalizeSourceOfTruth(),
    branchRescan: true,
    midDeleteRewind: false,
    presentCastDisplay: 'full',
    presentCastDisplayChosen: false,
    // The floating npc state button while Story Block carries Delta's Present NPCs and Dossiers tabs.
    launcherWithStoryBlock: false,
    // The same button while a Story Block v2 host carries Delta (its Cast tab and overlay).
    launcherWithStoryBlockV2: false,
    relationshipBaseline: { ...DEFAULT_RELATIONSHIP },
    relationshipCaps: { ...DEFAULT_RELATIONSHIP_CAPS },
    relationshipCriteria: DEFAULT_RELATIONSHIP_CRITERIA,
    relationshipImpactCriteria: DEFAULT_IMPACT_CRITERIA,
    memoryCriteria: DEFAULT_MEMORY_CRITERIA,
    behaviorCriteria: DEFAULT_BEHAVIOR_CRITERIA,
    autoArchiveDeaths: true,
    autoReactivateArchived: true,
    dataFiles: {},
    sidecarTombstones: {},
    recoveryFiles: {},
    recoveryHistory: {},
    recoveryGarbage: {},
    // Settings whose controls live in their own modules (full-cast.js, scanner-output-ui.js,
    // relationship-map.js, calendar-settings.js); declared and normalized here, the one settings owner.
    fullCastScanEveryTurn: false,
    scannerMaxOutputTokens: 0,
    relationshipMap: normalizeRelationshipMapSettings(),
});


function persistSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

// The dossier's depth: 0 to 20, 0 kept (it is the default since 1.2.16).
function injectDepthOf(settings) {
    const depth = Math.round(Number(settings?.injectDepth));
    return Number.isFinite(depth) ? Math.max(0, Math.min(20, depth)) : 0;
}

function getSettings() {
    let settings = extension_settings[EXTENSION_NAME];
    let dirty = false;
    if (!settings || typeof settings !== 'object') {
        settings = structuredClone(DEFAULTS);
        extension_settings[EXTENSION_NAME] = settings;
        dirty = true;
    }

    const assign = (key, value, equal = Object.is) => {
        if (equal(settings[key], value)) return;
        settings[key] = structuredClone(value);
        dirty = true;
    };
    const sameJson = (a, b) => {
        try { return JSON.stringify(a) === JSON.stringify(b); }
        catch { return false; }
    };

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (settings[key] === undefined) assign(key, value);
    }
    if (!settings.dataFiles || typeof settings.dataFiles !== 'object') assign('dataFiles', {});
    if (!settings.sidecarTombstones || typeof settings.sidecarTombstones !== 'object') assign('sidecarTombstones', {});
    if (!settings.recoveryFiles || typeof settings.recoveryFiles !== 'object') assign('recoveryFiles', {});
    if (!settings.recoveryHistory || typeof settings.recoveryHistory !== 'object') assign('recoveryHistory', {});
    if (!settings.recoveryGarbage || typeof settings.recoveryGarbage !== 'object') assign('recoveryGarbage', {});

    // Current-format settings are canonicalized in place; older Delta schemas are unsupported.
    assign('relationshipBaseline', normalizeRelationshipBaseline(settings.relationshipBaseline), sameJson);
    assign('relationshipCaps', normalizeRelationshipCaps(settings.relationshipCaps), sameJson);
    assign('customFieldNames', normalizeCustomFieldNames(settings.customFieldNames), sameJson);
    assign('sourceOfTruth', normalizeSourceOfTruth(settings.sourceOfTruth), sameJson);
    assign('relationshipCriteria', typeof settings.relationshipCriteria === 'string' ? settings.relationshipCriteria : DEFAULT_RELATIONSHIP_CRITERIA);
    assign('relationshipImpactCriteria', typeof settings.relationshipImpactCriteria === 'string' ? settings.relationshipImpactCriteria : DEFAULT_IMPACT_CRITERIA);
    assign('memoryCriteria', typeof settings.memoryCriteria === 'string' ? settings.memoryCriteria : DEFAULT_MEMORY_CRITERIA);
    assign('behaviorCriteria', typeof settings.behaviorCriteria === 'string' ? settings.behaviorCriteria : DEFAULT_BEHAVIOR_CRITERIA);
    assign('admissionMode', normalizeNpcAdmissionMode(settings.admissionMode));
    assign('presentCastDisplay', normalizePresentCastDisplay(settings.presentCastDisplay));
    assign('presentCastDisplayChosen', settings.presentCastDisplayChosen === true);
    assign('launcherWithStoryBlock', settings.launcherWithStoryBlock === true);
    assign('launcherWithStoryBlockV2', settings.launcherWithStoryBlockV2 === true);
    // 1.0.70 raised the default budget from 1800 to 4000 tokens. An install still on the old default
    // is moved once; any value the player chose, including a later deliberate 1800, is kept.
    const legacyDefaultBudget = settings.injectBudgetDefaultUpgraded !== true && Number(settings.injectBudgetTokens) === 1800;
    assign('injectBudgetTokens', legacyDefaultBudget ? 4000 : Math.max(512, Math.min(6000, Math.round(Number(settings.injectBudgetTokens) || 4000))));
    assign('injectBudgetDefaultUpgraded', true);
    const legacyDefaultDepth = settings.injectDepthTailUpgraded !== true && Number(settings.injectDepth) === 1;
    assign('injectDepth', legacyDefaultDepth ? 0 : injectDepthOf(settings));
    assign('injectDepthTailUpgraded', true);
    assign('fullScanEveryTurn', settings.fullScanEveryTurn === true);
    assign('narrationCapture', settings.narrationCapture === true);
    assign('narrationCaptureCompact', settings.narrationCaptureCompact === true);
    assign('narrationCaptureCatchUp', Number.isFinite(Number(settings.narrationCaptureCatchUp)) ? Math.max(0, Math.min(50, Math.round(Number(settings.narrationCaptureCatchUp)))) : 8);
    assign('scannerConnectionProfile', typeof settings.scannerConnectionProfile === 'string' ? settings.scannerConnectionProfile.trim() : '');
    assign('portraitGenerationEnabled', settings.portraitGenerationEnabled !== false);
    assign('portraitThemePreset', PORTRAIT_THEME_PRESETS[settings.portraitThemePreset] ? settings.portraitThemePreset : 'custom');
    const portraitCustomPresets = portraitCustomPresetLibrary(settings.portraitCustomPresets);
    assign('portraitCustomPresets', portraitCustomPresets, sameJson);
    const portraitCustomPresetId = portraitCustomPresets.some(item => item.id === settings.portraitCustomPresetId)
        ? settings.portraitCustomPresetId
        : portraitCustomPresets[0].id;
    assign('portraitCustomPresetId', portraitCustomPresetId);
    const activeCustomPortraitPreset = portraitCustomPresets.find(item => item.id === portraitCustomPresetId) || portraitCustomPresets[0];
    if (settings.portraitThemePreset === 'custom') {
        assign('portraitStylePositive', activeCustomPortraitPreset.positive);
        assign('portraitStyleNegative', activeCustomPortraitPreset.negative);
        assign('portraitComposition', activeCustomPortraitPreset.composition);
        assign('portraitPromptFormat', activeCustomPortraitPreset.promptFormat);
        assign('portraitUseMood', activeCustomPortraitPreset.useMood);
        assign('portraitUseLocation', activeCustomPortraitPreset.useLocation);
    }
    assign('portraitStylePositive', String(settings.portraitStylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT));
    assign('portraitStyleNegative', String(settings.portraitStyleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT));
    assign('portraitComposition', String(settings.portraitComposition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT));
    assign('portraitPromptFormat', normalizePortraitPromptFormat(settings.portraitPromptFormat));
    assign('portraitUseMood', settings.portraitUseMood !== false);
    assign('portraitUseLocation', settings.portraitUseLocation === true);
    assign('portraitSaveToGallery', settings.portraitSaveToGallery === true);
    assign('autoPruneStale', settings.autoPruneStale !== false);
    const archiveAfter = Math.max(10, Math.min(999, Math.round(Number(settings.staleArchiveAfter) || 30)));
    assign('staleArchiveAfter', archiveAfter);
    assign('staleDeleteAfter', Math.max(archiveAfter + 1, Math.min(1000, Math.round(Number(settings.staleDeleteAfter) || 50))));
    assign('injectLimit', Math.max(1, Math.min(12, Math.round(Number(settings.injectLimit) || 3))));
    assign('fullCastScanEveryTurn', settings.fullCastScanEveryTurn === true);
    assign('scannerMaxOutputTokens', normalizeScannerMaxOutputTokens(settings.scannerMaxOutputTokens));
    assign('relationshipMap', normalizeRelationshipMapSettings(settings.relationshipMap), sameJson);
    // The fantasy calendar (calendar-settings.js) is optional: absent means none; only a stored
    // object is a calendar.
    if (settings.calendarConfig !== undefined && (!settings.calendarConfig || typeof settings.calendarConfig !== 'object' || Array.isArray(settings.calendarConfig))) {
        delete settings.calendarConfig;
        dirty = true;
    }
    assign('schemaVersion', DEFAULTS.schemaVersion);

    if (dirty) persistSettings();
    return settings;
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
let storySuiteV2 = null;
function storySuiteV2Meters() {
    return storyBlockV2Hosted() && storySuiteV2?.hosted?.() ? storySuiteV2 : null;
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

function normalizeChatState(raw = {}) {
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
        if (!npc?.portrait?.dataUrl && state.portraitAssets[npc.id]?.dataUrl) npc.portrait = structuredClone(state.portraitAssets[npc.id]);
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
    }
    stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
    return normalized;
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

// Chats whose canonical sidecar this session watched another session retire. The tombstone makes a
// later hydration start an empty dossier (intentional reuse of a retired name), but the same open
// chat must stay blocked: retrying Scan would otherwise revive the retired dossier from the stale
// host narration. Reopening the chat (CHAT_CHANGED) is the host lifecycle that releases it.
const retiredInSessionChats = new Map();
// The last pre-generation freshness read, which the one MESSAGE_SENT that follows it may reuse.
const GENERATION_FRESHNESS_REUSE_MS = 5000;
let generationFreshness = { key: '', at: 0 };

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

// (timeline participant, src/storysuite-participant/) Every durable write of a chat's state ends in markStateDirty (persist, persistCritical,
// persistCriticalDurable), whatever made it: a scan, a targeted pass, a branch reconcile, a manual add or delete or edit, an import, the
// canonical server state, a rename, the v2 meter sync. The participant is told, and publishes the change to the timeline as a native mutation.
// The participant's own writes (an install, its block) are not changes: they carry a count **per chat**, so one chat's install never hides another's change.
const nativeChangeListeners = new Set();
const participantWrites = new Map();
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

// Scan **intent**: work that is going to change the dossiers but is not yet (or no longer) in the scan registry. `isScanBusy` is the registry's active set,
// so it is false for the moment between one scan ending and a queued one beginning (scanNow awaits the server before it begins an operation), and
// for a reply whose scan is due but not started. A save point taken then would miss what the scan writes a moment later. Counted per chat from the
// reply arriving (handleAssistantMessageReceived) and from every scan, queued drain, backfill pass and targeted pass until it ends.
const scanIntents = new Map();
async function withScanIntent(key, task) {
    scanIntents.set(key, (scanIntents.get(key) || 0) + 1);
    try { return await task(); } finally {
        const left = (scanIntents.get(key) || 1) - 1;
        if (left > 0) scanIntents.set(key, left); else scanIntents.delete(key);
    }
}
/** Whether dossier work is running, due or queued for the chat: an active operation, an intent, a queued automatic scan. */
function scanWorkPending(key = getChatKey()) {
    return isScanBusy(key) || (scanIntents.get(key) || 0) > 0 || pendingAutoScans.has(key);
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
function scanNow(options) { return withScanIntent(getChatKey(), () => scanNowInner(options)); }
function drainPendingAutoScan(chatKey) { return withScanIntent(chatKey, () => drainPendingAutoScanInner(chatKey)); }
function processPendingBackfills(...args) { return withScanIntent(getChatKey(), () => processPendingBackfillsInner(...args)); }
function runTargetedDossierPass(job) { return withScanIntent(job?.chatKey || getChatKey(), () => runTargetedDossierPassInner(job)); }
function handleAssistantMessageReceived(...args) { return withScanIntent(getChatKey(), () => handleAssistantMessageReceivedInner(...args)); }

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
    if (branchReconcileTimer) {
        clearTimeout(branchReconcileTimer);
        branchReconcileTimer = null;
    }
    if (branchReconcilePending) {
        next = mergeBranchOptions(branchReconcilePending, next);
        branchReconcilePending = null;
    }
    if (swipeSettlementPending) next = mergeBranchOptions(swipeSettlementPending, next);
    swipeSettlementPending = next;

    const sequence = ++swipeSettlementSequence;
    if (swipeSettlementTimer) clearTimeout(swipeSettlementTimer);
    const startedAt = Date.now();

    const poll = async () => {
        if (sequence !== swipeSettlementSequence) return;
        if (getChatKey() !== originKey) {
            swipeSettlementTimer = null;
            swipeSettlementPending = null;
            deferredSwipeMessageId = null;
            return;
        }
        if (isHostSwipeActive()) {
            if (Date.now() - startedAt >= SWIPE_SETTLE_TIMEOUT_MS) {
                swipeSettlementTimer = null;
                swipeSettlementPending = null;
                deferredSwipeMessageId = null;
                console.warn('[NPC State Delta] swipe stayed active too long; branch rescan was skipped to avoid hijacking the host generation pipeline.');
                return;
            }
            swipeSettlementTimer = setTimeout(poll, SWIPE_SETTLE_POLL_MS);
            return;
        }

        swipeSettlementTimer = null;
        const pending = swipeSettlementPending || {};
        swipeSettlementPending = null;
        const receivedMessageId = Number.isInteger(deferredSwipeMessageId) ? deferredSwipeMessageId : null;
        deferredSwipeMessageId = null;

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
    swipeSettlementTimer = setTimeout(poll, 0);
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
        const isEmptyState = !current.npcs.length && !current.candidates.length && !current.dismissed.length && !current.checkpoints.length && !current.lineage.length;
        if (!isEmptyState) return false;

        const metadata = getContext().chatMetadata || getContext().chat_metadata || {};
        const mainChat = String(metadata?.main_chat || '').replace(/\.jsonl$/i, '').trim();
        const parsed = parseQualifiedChatKey(key);
        const explicitParentKey = mainChat && parsed ? buildQualifiedChatKey(parsed.kind, parsed.ownerId, mainChat) : '';
        const hasExplicitParent = Boolean(explicitParentKey && explicitParentKey !== key);
        if (!hasExplicitParent) return false;

        await ensureChatStateLoaded(explicitParentKey).catch(error => console.debug(`[NPC State Delta] explicit branch parent ${explicitParentKey} could not be hydrated.`, error));
        if (getChatKey() !== key || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;
        const parentState = chatStateCache.get(explicitParentKey);
        const inherited = bestAncestorState(parentState ? { [explicitParentKey]: parentState } : {}, key, chat);
        if (!inherited) return false;
        setChatState(key, { ...freshChatState(), ...inherited });
        queueStateFileWrite(key, 0);
        return true;
    } finally {
        evictDormantChatStates(key);
    }
}

// Chats whose local message history is an older prefix of the adopted dossier's history: another
// session wrote messages this browser has not loaded yet. The mark survives local saves (a metadata
// save proves nothing about the chat) and clears once the local chat catches up with or diverges
// from the dossier, or once the host reloads the chat.
const staleHostChats = new Set();
// SillyTavern emits CHAT_CHANGED after reading the chat from the server, so the history it opens is
// current. A dossier it only prefixes lost those messages to a deletion (for example one whose
// truncation was not saved before a reload), not to a session this browser is behind.
const openingHostChats = new Set();

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
    if (branchReconcilePending?.chatKey && branchReconcilePending.chatKey !== originKey) {
        if (branchReconcileTimer) clearTimeout(branchReconcileTimer);
        branchReconcileTimer = null;
        branchReconcilePending = null;
    }
    if (branchReconcilePending) next = mergeBranchOptions(branchReconcilePending, next);
    branchReconcilePending = next;
    if (branchReconcileTimer) clearTimeout(branchReconcileTimer);
    branchReconcileTimer = setTimeout(async () => {
        const pending = branchReconcilePending || {};
        branchReconcilePending = null;
        branchReconcileTimer = null;
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

// (beta) A scanner call that came back with no text at all (SillyTavern's "No message generated") is a
// quiet note, once per chat: nothing was changed and the next reply scans again, so it is not a red
// console error with a stack on every reply. Every other failure is logged as before.
const emptyAnswerChats = new Set();
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

// The text last handed to the host for roleplay generation, with the reason when it is empty, so
// Diagnostics can show what the roleplay model actually receives. Runtime-only; never persisted.
let lastInjection = { text: '', reason: 'Not built yet in this session.', at: 0, chatKey: '' };

// The player message the next generation will answer: the chat tail when it is a user turn, or
// the user turn before an assistant reply that is not yet reflected by a scan (swipe/regenerate).
function pendingPlayerMessage(state) {
    const chat = getContext().chat || [];
    let tail = chat.length - 1;
    while (tail >= 0 && chat[tail]?.is_system) tail -= 1;
    if (tail < 0) return '';
    if (chat[tail]?.is_user) return cleanMessage(chat[tail]);
    if (state?.lastScannedMessageId === tail) return '';
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

// The live dossier injection under the current settings and scene defer (sent by updateInjection;
// tokens() measures the same text).
function liveInjectionText(state, settings, { namedNpcIds = namedByPlayerNpcIds(state), transcript = recentTranscript(4) } = {}) {
    // v1's World State carries the live mood and outfit the cards then leave out; v2's scene keeps
    // only the place and who is present, so under a v2 host the cards keep them.
    const sceneDeferred = defersArea('scene', settings.sourceOfTruth) && !storyBlockIsV2();
    return buildInjection(scenePresenceView(hostedMeterView(state.npcs)), transcript, state.turn, settings.injectLimit, settings.behaviorCriteria, settings.injectBudgetTokens, state.socialGraph, { namedNpcIds, customFieldNames: settings.customFieldNames, sceneDeferred });
}

function updateInjection() {
    const settings = getSettings();
    const ctx = getContext();
    const injectionKey = getChatKey();
    const clear = reason => {
        lastInjection = { text: '', reason, at: Date.now(), chatKey: injectionKey };
        ctx.setExtensionPrompt?.(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        ctx.setExtensionPrompt?.(CAPTURE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
        ctx.setExtensionPrompt?.(CAPTURE_RULES_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        sentCaptureRules = '';
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
    const armed = narrationCaptureArmed === injectionKey && narrationCaptureEnabled(settings);
    const rulesSent = narrationCaptureEnabled(settings) && !captureRulesWithheld;
    if (!settings.inject && !armed && !rulesSent) return clear('"Inject present NPC state" is off.');
    const namedNpcIds = namedByPlayerNpcIds(state);
    const prompt = settings.inject ? liveInjectionText(state, settings, { namedNpcIds, transcript }) : '';
    // (1.2.17) The capture's context leaves out what this dossier already gives word for word.
    const builtParts = armed || rulesSent
        ? buildNarrationCaptureParts(scannerPromptOptions(state, settings, transcript, { dossierAbove: prompt }))
        : { rules: '', context: '' };
    const captureParts = { rules: armed || rulesSent ? builtParts.rules : '', context: armed ? builtParts.context : '' };
    const capture = captureParts.context;
    const present = (state.npcs || []).filter(npc => npc?.present && !npc?.archived);
    const depth = injectDepthOf(settings);
    lastInjection = {
        text: prompt,
        reason: prompt ? '' : (!settings.inject ? '"Inject present NPC state" is off.' : (present.length ? 'No present NPC was selected for injection.' : 'No NPC is marked present in the latest scanned scene.')),
        at: Date.now(),
        chatKey: injectionKey,
        depth,
        namedByPlayer: (state.npcs || []).filter(npc => namedNpcIds.includes(npc.id)).map(npc => npc.name),
        captureChars: captureParts.rules.length + capture.length,
        captureRules: captureParts.rules,
        captureContext: capture,
    };
    ctx.setExtensionPrompt?.(PROMPT_KEY, prompt, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);
    // Replaced on every build and emptied when not armed, so a spent reminder is never sent again;
    // the rules go and come with it (only armed replies carry them, byte-identical each time).
    ctx.setExtensionPrompt?.(CAPTURE_PROMPT_KEY, capture, extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
    ctx.setExtensionPrompt?.(CAPTURE_RULES_KEY, captureParts.rules, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    if (!captureParts.rules) sentCaptureRules = '';
}

// (1.2.16) A chat-completion preset whose prompt order has no Main Prompt drops in-prompt extension
// text, so the capture's rules would vanish while its context still asks for the block. At
// prompt-ready they go back in, once, after the leading system messages (still early, so still
// cacheable). Only for the reply's own generation: the rules are held from its arming until the
// reply arrives or is stopped (sentCaptureRules, '' otherwise), never on a dry run, never in a
// prompt without the chat's replies (another extension's call), never in Delta's own requests.
let sentCaptureRules = '';
const OWN_REQUEST = /NPC State Delta's (?:isolated|targeted)|isolated relationship evaluator|Private NPC dossier scanner/;
function holdCaptureRules() {
    const ctx = getContext();
    const rules = String(lastInjection.captureRules || '');
    sentCaptureRules = rules && typeof ctx.substituteParams === 'function' ? ctx.substituteParams(rules) : rules;
}
function keepCaptureRules(eventData) {
    const rules = String(sentCaptureRules || '').trim();
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
    const text = String(lastInjection.text || '');
    const lines = text.split('\n');
    const injectedNpcs = lines.map(line => line.match(/^- (.+?)(?: \(named by player\))?: IDENTITY/)?.[1]).filter(Boolean);
    const referencedNpcs = lines.map(line => line.match(/^- (.+?) \((?:mentioned, not present|deceased)/)?.[1]).filter(Boolean);
    return {
        sending: Boolean(text),
        reason: lastInjection.reason || '',
        placement: (lastInjection.depth ?? injectDepthOf(settings)) === 0
            ? 'In chat as a system message at the end, after your latest message (depth 0)'
            : `In chat as a system message, ${lastInjection.depth ?? injectDepthOf(settings)} message(s) from the end`,
        capturePlacement: 'One-pass capture: its rules in the system prompt (unchanged reply to reply), its context and reminder in their own system message at the very end (depth 0)',
        builtAt: lastInjection.at ? new Date(lastInjection.at).toISOString() : '',
        presentNpcs: (state.npcs || []).filter(npc => npc?.present && !npc?.archived).map(npc => npc.name),
        namedByPlayer: (lastInjection.namedByPlayer || []).filter(name => injectedNpcs.includes(name)),
        injectedNpcs,
        referencedNpcs,
        chars: text.length,
        estimatedTokens: Math.ceil(text.length / 4),
        budgetTokens: Number(settings.injectBudgetTokens) || 0,
        captureChars: Number(lastInjection.captureChars) || 0,
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

export function findMeguminDossierSources(npc, chat = getContext().chat || []) {
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

// Running targeted passes. An explicit edit or swipe of the reply a pass tolerates being rewritten in
// place ends that tolerance: from then on any change to the history makes the result stale.
const runningTargetedPasses = new Set();
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
        const latest = getChatState(chatKey);
        const liveBefore = latest.npcs.find(npc => npc.id === id) || null;
        const scoped = job.scope(parsed, { latest, liveBefore });
        if (!scoped.ok) {
            if (scoped.noChange) {
                const metrics = targetedPassMetrics(metricsLabel, { startedAt, prompt, raw, retried, parsed, localEdges: scoped.localEdges });
                if (job.reportsScanMetrics) lastScanMetrics = metrics;
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
        if (job.reportsScanMetrics) lastScanMetrics = metrics;
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
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === id);
    if (!existing) return false;
    const sources = findMeguminDossierSources(existing, ctx.chat || []);
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
    const prompt = buildProfileRefreshPrompt({
        transcript,
        targetNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
        turn: Number.isInteger(state.turn) ? state.turn : null,
        storyDay: storyDayAt(latestMessageId(true)),
        customFieldNames: settings.customFieldNames,
    });
    return runTargetedDossierPass({
        chatKey, ctx, id, prompt,
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
    const prompt = buildBackfillPrompt({
        transcript,
        targetName: request.label,
        existingNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
        customFieldNames: settings.customFieldNames,
    });
    return runTargetedDossierPass({
        chatKey, ctx, prompt, messageId,
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
const captureCatchUp = new Map();

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
    if (narrationCaptureArmed === key) narrationCaptureVersion = Number(stateVersions.get(key) || 0);
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
function captureNarrationBlock(chatKey, messageId, message, armed) {
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
    narrationCaptures.set(narrationCaptureKey(chatKey, messageId), { parsed, raw: extracted.raw });
    // Only its size is kept, for the tokens() output estimate; never the block itself.
    lastCaptureBlockChars = String(extracted.raw ?? '').length;
    while (narrationCaptures.size > NARRATION_CAPTURE_LIMIT) narrationCaptures.delete(narrationCaptures.keys().next().value);
}
function receiveNarrationBlock(messageId) {
    const chatKey = getChatKey();
    const armedHere = Boolean(narrationCaptureArmed) && narrationCaptureArmed === chatKey;
    const current = armedHere && Number(stateVersions.get(chatKey) || 0) === narrationCaptureVersion;
    disarmNarrationCapture();
    const message = Number.isInteger(messageId) ? getContext().chat?.[messageId] : null;
    if (!getSettings().enabled || chatKey === 'no-chat' || !message || message.is_user || message.is_system) return;
    if (armedHere) narrationCaptureStats[current ? 'requested' : 'outdated'] += 1;
    captureNarrationBlock(chatKey, messageId, message, current);
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
    narrationCaptureArmed = '';
    if (lastInjection.captureChars) updateInjection();
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
    const currentTranscript = currentExchangeTranscript(messageId);
    const currentProse = currentExchangeProse(messageId);
    const fullWindowScan = Boolean(!manual && settings.fullScanEveryTurn);
    const transcript = (manual || fullWindowScan) ? recentTranscript(settings.scanDepth) : currentTranscript;
    const userDevelopmentContext = (manual || fullWindowScan)
        ? recentUserDevelopmentContext(settings.scanDepth, { messageIds: true })
        : currentExchangeUserDevelopmentContext(messageId);
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
    const scanStateVersion = Number(stateVersions.get(scanChatKey) || 0);
    const capture = !manual && !fullWindowScan && Number.isInteger(messageId)
        ? takeNarrationCapture(scanChatKey, messageId)
        : null;
    const scanLabel = capture ? 'narration-capture' : (manual ? 'manual' : (fullWindowScan ? 'automatic-full' : 'automatic'));
    const prompt = capture ? '' : buildScannerPrompt(scannerPromptOptions(state, settings, transcript, { currentTranscript, fullScanMode: fullWindowScan, sceneNames: scanScenePresent(messageId) }));

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
            lastScanMetrics = {
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
        const resolvedParsed = resolveInterimIdentityPromotions(singleReply ? tagScanEvidence(parsed, messageId) : parsed, state.npcs, state.candidates);
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
        const fullWindowRelationship = (manual || fullWindowScan)
            ? prepareFullWindowRelationshipPayload(resolvedParsed, state.npcs)
            : { evaluation: resolvedParsed, mergeSafe: resolvedParsed };
        // (user decision 5) Hosted, a one-pass block's own rows are the reply's relationship decision.
        const relationshipPass = capture && hostedMeters() ? { decisions: new Map(), used: false, responseChars: 0, retried: false, targetCount: 0 } : await runFocusedRelationshipPass(
            ctx,
            fullWindowRelationship.evaluation,
            state.npcs,
            currentTranscript || transcript,
            settings,
            {
                currentExchangeOnly: manual || fullWindowScan,
                requestScope: operation.requestScope,
                prose: currentProse,
                // (1.2.12) Only a one-pass block speaks for its relationships this way.
                ...(capture ? { covered: parsed?.relationshipsCovered === true, review: Array.isArray(parsed?.relationshipReview) ? parsed.relationshipReview : [] } : {}),
            },
        );
        const scanFinishedAt = performance.now?.() ?? Date.now();
        lastScanMetrics = {
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
        });
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
                if (lastScanMetrics) {
                    lastScanMetrics.newNpcRelationshipTargets = combinedTargetCount;
                    lastScanMetrics.newNpcRelationshipResponseChars = combinedResponseChars;
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
        if (lastScanMetrics) {
            lastScanMetrics.profileApplied = Number(merged.report?.profileUpdateStats?.applied || 0);
            lastScanMetrics.profileEvidenceAdded = Number(merged.report?.profileUpdateStats?.evidenceAdded || 0);
            lastScanMetrics.profileDevelopment = Array.isArray(merged.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [];
            console.info('[NPC State Delta] dossier scan metrics', lastScanMetrics);
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
        if (lastScanMetrics) {
            lastScanMetrics.staleArchived = staleArchived.length;
            lastScanMetrics.stalePruned = stalePruned.length;
        }
        recordScanDiagnostics(scanChatKey, lastScanMetrics || {}, parsedForMerge, merged.report, {
            sourceMessageId: targetMessageId,
            targeted: false,
        });
        const chatKey = scanChatKey;
        const nextState = {
            ...merged.state,
            assistantSinceScan: 0,
            lastScanAt: Date.now(),
            lastScannedMessageId: Number.isInteger(messageId) ? messageId : ((ctx.chat || []).length - 1),
            scanCount: Number(state.scanCount || 0) + 1,
        };
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

function settingRow(id, label, control, hint = '') {
    return `<label class="npc-state-delta-setting-row story-suite-row" for="${id}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>${control}</label>`;
}

function numberControl(id, min, max, unit = '', { step = '', prefix = '' } = {}) {
    return `<span class="delta-setting-number story-suite-number">${prefix}<input id="${id}" type="number" min="${min}" max="${max}"${step ? ` step="${step}"` : ''} class="text_pole npc-state-delta-number">${unit ? `<small>${unit}</small>` : ''}</span>`;
}

function settingsGroup(key, title, hint, body) {
    return `<details class="delta-settings-group story-suite-fold" data-delta-settings-group="${key}"><summary><b>${title}</b>${hint ? `<small>${hint}</small>` : ''}</summary><div class="delta-settings-group-body story-suite-fold-body">${body}</div></details>`;
}

const SUITE_AREA_LABELS = Object.freeze({
    npc: 'NPCs',
    calendar: 'Calendar',
    scene: 'Scene (live mood, outfit)',
    stats: 'Game stats',
});

function settingsSlot(name) {
    return `<div class="delta-settings-slot" data-delta-settings-slot="${name}"></div>`;
}

// The Extensions-tab panel is built once here in its final grouped shape. Optional owners
// (full cast, scanner output, calendar) mount their own controls into the named slots.
function buildSettingsHtml() {
    const scanning = [
        settingRow('npc_state_delta_scanner_connection_profile', 'Scanner connection profile', '<select id="npc_state_delta_scanner_connection_profile" class="text_pole"></select>', 'Routes every NPC scan, Refresh, focused pass and retry. Default keeps the current roleplay route; an unavailable profile never falls back silently.<span id="npc_state_delta_scanner_profile_none" class="npc-state-delta-scanner-profile-none" hidden> There is no connection profile yet: make one in SillyTavern\'s Connection Manager and it is listed here.</span>'),
        settingRow('npc_state_delta_full_scan_every_turn', 'Full scan every turn', '<input id="npc_state_delta_full_scan_every_turn" type="checkbox">', 'With Auto scan, reconcile the whole scan context after every reply instead of only the latest exchange. Overrides Scan every; relationship deltas still come only from the newest exchange.'),
        settingRow('npc_state_delta_narration_capture', 'One-pass narration capture (experimental)', '<input id="npc_state_delta_narration_capture" type="checkbox">', 'With Auto scan, the roleplay model ends each reply with a hidden NPC update block that replaces the separate scan request. Adds about 2,000-3,000 tokens to every roleplay prompt plus the block to each reply; a missing or broken block falls back to the normal scan. Not used with Full scan every turn.'),
        settingRow('npc_state_delta_narration_capture_compact', 'Compact one-pass instruction', '<input id="npc_state_delta_narration_capture_compact" type="checkbox">', 'With one-pass capture, the same rules in fewer words: about 1,500 tokens instead of 2,000 on every asked-for reply. Every field, gate and cap is kept, but check the blocks your model writes before relying on it; off sends the full rules.'),
        settingRow('npc_state_delta_narration_capture_catch_up', 'One-pass catch-up', numberControl('npc_state_delta_narration_capture_catch_up', 0, 50, 'replies'), 'With one-pass capture, every this many captured replies the two NPCs most in them get a quiet Refresh (one scanner request each) for mannerisms, levers and memories. 0 turns it off.'),
        settingsSlot('full-cast'),
        settingRow('npc_state_delta_scan_every', 'Scan every', numberControl('npc_state_delta_scan_every', 1, 20, 'replies'), 'Quick-scan cadence when Full scan every turn is off.'),
        settingRow('npc_state_delta_admission_mode', 'NPC admission', '<select id="npc_state_delta_admission_mode" class="text_pole"><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="manual_only">Manual only</option></select>', 'Conservative: proper names immediately, role labels after recurrence. Balanced: also direct or persistent role NPCs. Manual only: every dossier needs Add NPC.'),
    ].join('');
    const roster = `
        <h4 class="delta-settings-subhead story-suite-subhead">In-chat display</h4>
        ${settingRow('npc_state_delta_present_cast_display', 'Present NPCs in chat', '<select id="npc_state_delta_present_cast_display" class="text_pole"><option value="full">Full cards</option><option value="compact">Compact strip</option><option value="storyblock">Only in Story Block</option><option value="off">Off</option></select>', 'Shown under the latest reply (or as a Megumin tab). With Story Block installed, Present NPCs and Dossiers tabs also appear in its sidebar, and until you pick a choice here the chat shows them only there; Only in Story Block keeps the chat clear (full cards without Story Block). Tapping an NPC opens its dossier. Off adds nothing to the chat; presence tracking and injection are unaffected.')}
        <div class="npc-state-delta-v2-hosted-hide">${settingRow('npc_state_delta_launcher_with_story_block', 'Floating button with Story Block', '<input id="npc_state_delta_launcher_with_story_block" type="checkbox">', 'Story Block\'s sidebar has the Present NPCs and Dossiers tabs, so the floating npc state button hides while it is there. Turn on to keep the button as well.')}</div>
        <div class="npc-state-delta-v2-hosted-only">${settingRow('npc_state_delta_launcher_with_story_block_v2', 'Show NSD\'s own launcher with Story Block v2', '<input id="npc_state_delta_launcher_with_story_block_v2" type="checkbox">', 'Story Block v2 has Delta\'s Cast tab and its overlay, so the floating npc state button hides while it is there. Turn on to keep the button as well.')}</div>
        <h4 class="delta-settings-subhead story-suite-subhead">Generation injection</h4>
        ${settingRow('npc_state_delta_inject', 'Inject present NPC state', '<input id="npc_state_delta_inject" type="checkbox">', 'Only active NPCs present in the latest scanned scene are injected into generation.')}
        ${settingsSlot('relationship-map')}
        <h4 class="delta-settings-subhead story-suite-subhead">Custom fields</h4>
        ${settingRow('npc_state_delta_custom_fields', 'Custom fields', '<input id="npc_state_delta_custom_fields" class="text_pole" maxlength="260" placeholder="Level, Class, Faction">', 'Up to 6 names, comma-separated, tracked on every dossier. The scanner fills a value only when the story states it, keeps it until it is explicitly changed, and it is sent with present NPCs. Leave empty to turn off.')}
        <small id="npc_state_delta_custom_fields_stats_warning" class="npc-state-delta-suite-warning story-suite-notice" role="status" hidden></small>
        <h4 class="delta-settings-subhead story-suite-subhead">Roster lifecycle</h4>
        ${settingRow('npc_state_delta_max', 'Maximum active NPCs', numberControl('npc_state_delta_max', 1, 100), 'Archived dossiers do not use an active slot.')}
        ${settingRow('npc_state_delta_archive_deaths', 'Archive confirmed deaths', '<input id="npc_state_delta_archive_deaths" type="checkbox">', 'Explicit current-timeline deaths archive instead of deleting. Ambiguous death language is ignored.')}
        ${settingRow('npc_state_delta_reactivate_archived', 'Reactivate on clear return', '<input id="npc_state_delta_reactivate_archived" type="checkbox">', 'Manual archives return when the NPC clearly reappears. Death archives need an explicit living return.')}
        <h4 class="delta-settings-subhead story-suite-subhead">Stale cleanup</h4>
        ${settingRow('npc_state_delta_auto_prune_stale', 'Auto-manage stale NPCs', '<input id="npc_state_delta_auto_prune_stale" type="checkbox">', 'Long-absent NPCs auto-archive, then stale auto-archives are deleted later. Manual, death and protected records are kept; deleted names can be rediscovered.')}
        ${settingRow('npc_state_delta_stale_archive_after', 'Auto-archive after', numberControl('npc_state_delta_stale_archive_after', 10, 999, 'replies'), 'Default 30. Replies since the NPC was last present or active off-screen.')}
        ${settingRow('npc_state_delta_stale_delete_after', 'Auto-delete after', numberControl('npc_state_delta_stale_delete_after', 11, 1000, 'replies'), 'Default 50. Applies only to stale auto-archives.')}`;
    // (1.2.15) Settings most readers never touch, folded together so the everyday ones stay short.
    // UI only: every key, default and control id is the same as before.
    const advanced = [
        settingRow('npc_state_delta_scan_depth', 'Scan context', numberControl('npc_state_delta_scan_depth', 2, 30, 'messages'), 'History window for full, manual and Refresh scans. Quick automatic scans read only the latest user + assistant exchange.'),
        settingsSlot('scanner-output'),
        settingRow('npc_state_delta_inject_limit', 'NPCs in the dossier', numberControl('npc_state_delta_inject_limit', 1, 12, 'NPCs'), 'At most this many present NPCs go into the live dossier each reply, the most relevant first (default 3).'),
        settingRow('npc_state_delta_inject_budget', 'Injection budget', numberControl('npc_state_delta_inject_budget', 512, 6000, 'tokens', { step: 100, prefix: '<small>~</small>' }), 'Upper limit; only what the present NPCs need is used. The default 4000 lets detailed dossiers reach the roleplay model in full. When it runs short, lower-priority fields, then lower-ranked NPCs, are trimmed first.'),
        settingRow('npc_state_delta_mid_delete_rewind', 'Rewind dossiers on middle deletion', '<input id="npc_state_delta_mid_delete_rewind" type="checkbox">', 'Off (default): deleting a message from the middle undoes only what that message changed and keeps later changes. On: every dossier rewinds to how it was just before the deleted message, discarding what later messages changed (no model requests).'),
        settingRow('npc_state_delta_branch_rescan', 'Rescan changed branches', '<input id="npc_state_delta_branch_rescan" type="checkbox">', 'Re-evaluate the surviving branch after a swipe, edit or middle-message deletion.'),
    ].join('');
    const suite = `
        <p class="npc-state-delta-muted">With Story Block, Story Director or RPG Battle installed, each area has one source of truth so the model is not told the same thing twice. Automatic lets the specialist lead (Story Block the scene, Story Director the calendar, RPG Battle game stats; Delta the NPCs). Alone, every choice behaves like Automatic.</p>
        ${SUITE_AREAS.map(area => settingRow(`npc_state_delta_source_${area}`, SUITE_AREA_LABELS[area], `<select id="npc_state_delta_source_${area}" class="text_pole" data-delta-source-area="${area}"><option value="auto">Automatic</option><option value="mine">This extension</option><option value="theirs">The other one</option></select>`, `<span data-delta-source-status="${area}"></span>`)).join('')}`;
    const portrait = `
        <p class="npc-state-delta-muted">Builds positive and negative prompts from the dossier for the native SillyTavern Image Generation handoff. The configured image backend (including ComfyUI) stays host-owned.</p>
        ${settingRow('npc_state_delta_portrait_generation_enabled', 'Enable Generate Portrait', '<input id="npc_state_delta_portrait_generation_enabled" type="checkbox">', 'Enables Generate Portrait in the dossier Portrait tool. Fails safely without changing the dossier if Image Generation is unavailable.')}
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_theme_preset"><b>Theme preset</b><small>Built-ins are fixed starting points. Custom Library uses one of your saved presets.</small></label>
        <select id="npc_state_delta_portrait_theme_preset" class="text_pole">${Object.entries(PORTRAIT_THEME_PRESETS).map(([key, item]) => `<option value="${key}">${escapeHtml(item.label)}</option>`).join('')}</select>
        <div class="npc-state-delta-custom-preset-library">
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_custom_preset"><b>Custom preset</b><small id="npc_state_delta_portrait_custom_preset_count"></small></label>
          <select id="npc_state_delta_portrait_custom_preset" class="text_pole"></select>
          <div class="npc-state-delta-custom-preset-actions">
            <div id="npc_state_delta_portrait_custom_add" class="menu_button"><i class="fa-solid fa-plus"></i> Add</div>
            <div id="npc_state_delta_portrait_custom_duplicate" class="menu_button"><i class="fa-solid fa-copy"></i> Duplicate</div>
            <div id="npc_state_delta_portrait_custom_rename" class="menu_button"><i class="fa-solid fa-pen"></i> Rename</div>
            <div id="npc_state_delta_portrait_custom_delete" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Delete</div>
          </div>
          <small class="npc-state-delta-muted">Each custom preset stores positive, negative, composition, prompt format, mood and location. Gallery saving stays global.</small>
        </div>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_positive"><b>Positive style / theme</b><small>House style keywords, e.g. anime key visual, painterly fantasy or model-specific tags.</small></label>
        <textarea id="npc_state_delta_portrait_style_positive" class="text_pole npc-state-delta-rubric-textarea" rows="3" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_negative"><b>Negative prompt</b><small>Quality, anatomy, composition or style exclusions for every portrait.</small></label>
        <textarea id="npc_state_delta_portrait_style_negative" class="text_pole npc-state-delta-rubric-textarea" rows="3" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
        <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_composition"><b>Portrait composition</b><small>Framing, kept separate from appearance so dossiers never need rewriting.</small></label>
        <textarea id="npc_state_delta_portrait_composition" class="text_pole npc-state-delta-rubric-textarea" rows="2" maxlength="${PORTRAIT_COMPOSITION_PROMPT_LIMIT}"></textarea>
        ${settingRow('npc_state_delta_portrait_prompt_format', 'Prompt format', '<select id="npc_state_delta_portrait_prompt_format" class="text_pole"><option value="hybrid">Structured hybrid</option><option value="tags">Comma tags</option><option value="natural">Natural language</option></select>', 'Hybrid groups dossier facts with theme tags; Tags suits SD/anime checkpoints; Natural suits instruction-following image models.')}
        ${settingRow('npc_state_delta_portrait_use_mood', 'Use current mood', '<input id="npc_state_delta_portrait_use_mood" type="checkbox">', 'Adds current mood as expression. Personality and Background never enter the image prompt.')}
        ${settingRow('npc_state_delta_portrait_use_location', 'Use current location', '<input id="npc_state_delta_portrait_use_location" type="checkbox">', 'Off by default so portraits stay character-focused.')}
        ${settingRow('npc_state_delta_portrait_save_gallery', 'Also save to ST character gallery', '<input id="npc_state_delta_portrait_save_gallery" type="checkbox">', 'Off by default. Only the result you choose becomes the dossier portrait either way.')}
        <div class="npc-state-delta-actions npc-state-delta-tuning-actions">
          <div id="npc_state_delta_reset_portrait_theme" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset Fantasy Anime style</div>
          <div id="npc_state_delta_save_portrait_settings" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Save prompt settings</div>
          <small id="npc_state_delta_portrait_settings_status" class="npc-state-delta-muted">Saved</small>
        </div>`;
    const rules = `
        <section class="delta-settings-subsection npc-state-delta-relationship-rules">
          <h4>Relationship scoring</h4>
          <p class="npc-state-delta-muted">The scanner proposes deltas; code applies them and clamps each stat to its impact-tier cap. Stats run from -100 to +100 around neutral 0. Starting values affect new NPCs only.</p>
          <div class="npc-state-delta-tuning-grid">
            <div class="npc-state-delta-tuning-group"><b>New NPC starting values</b>
              <label>Trust <input id="npc_state_delta_base_trust" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Affection <input id="npc_state_delta_base_affection" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Desire <input id="npc_state_delta_base_desire" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
              <label>Tension <input id="npc_state_delta_base_tension" type="number" min="-100" max="100" class="text_pole npc-state-delta-number"></label>
            </div>
            <div class="npc-state-delta-tuning-group"><b>Maximum ± change per scan</b>
              <label>Ordinary <input id="npc_state_delta_cap_ordinary" type="number" min="0" max="25" class="text_pole npc-state-delta-number"></label>
              <label>Meaningful <input id="npc_state_delta_cap_meaningful" type="number" min="0" max="35" class="text_pole npc-state-delta-number"></label>
              <label>Major <input id="npc_state_delta_cap_major" type="number" min="0" max="50" class="text_pole npc-state-delta-number"></label>
              <label>Extreme <input id="npc_state_delta_cap_extreme" type="number" min="0" max="100" class="text_pole npc-state-delta-number"></label>
            </div>
          </div>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_relationship_criteria"><b>Relationship stat criteria</b><small>Sent to the private dossier scanner. Adjust the definitions and evidence rules for your RP.</small></label>
          <textarea id="npc_state_delta_relationship_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="7"></textarea>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_impact_criteria"><b>Impact-tier criteria</b><small>What counts as ordinary, meaningful, major or extreme. Code caps apply even if the model proposes more.</small></label>
          <textarea id="npc_state_delta_impact_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="6"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_relationship_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset relationship rules</div></div>
        </section>
        <section class="delta-settings-subsection npc-state-delta-memory-rules">
          <h4>Important memories</h4>
          <p class="npc-state-delta-muted">Decides which established events become persistent Important memories during scans and backfills. Existing memories are shown to the scanner to avoid duplicates.</p>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_memory_criteria"><b>Important memory criteria</b><small>Keep routine dialogue, transient feelings and moment-to-moment Inner Chatter out unless you intend otherwise.</small></label>
          <textarea id="npc_state_delta_memory_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="7"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_memory_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset memory criteria</div></div>
        </section>
        <section class="delta-settings-subsection npc-state-delta-behavior-rules">
          <h4>Behavior expression</h4>
          <p class="npc-state-delta-muted">Injected only with present NPCs. Personality, Behavioral profile, Speech and Mannerisms stay authoritative; relationship stats only tint player-specific expression and never imply obedience or a romance archetype.</p>
          <label class="npc-state-delta-rubric-label" for="npc_state_delta_behavior_criteria"><b>Relationship-to-behavior rubric</b><small>Edit if your RP uses different behavioral assumptions.</small></label>
          <textarea id="npc_state_delta_behavior_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="8"></textarea>
          <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_behavior_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset behavior rubric</div></div>
        </section>`;
    const maintenance = `
        <div class="npc-state-delta-actions delta-settings-maintenance-actions">
          <button type="button" class="menu_button" data-delta-settings-backup><i class="fa-solid fa-file-export"></i> Backup / Export</button>
          <button type="button" class="menu_button" data-delta-settings-restore><i class="fa-solid fa-file-import"></i> Restore / Import</button>
          <button type="button" class="menu_button" data-delta-settings-diagnostics><i class="fa-solid fa-stethoscope"></i> Diagnostics</button>
        </div>
        <details class="delta-settings-current-roster">
          <summary><b>Current chat roster</b><small>Edit, scan, archive or remove individual records</small></summary>
          <div id="npc_state_delta_roster_summary" class="npc-state-delta-roster-summary"></div>
        </details>
        <div class="delta-settings-danger story-suite-danger">
          <span><b>Clear chat dossier</b><small>Removes every NPC record for this chat only.</small></span>
          <div id="npc_state_delta_clear_chat" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Clear</div>
        </div>`;
    return `
    <div id="${UI_ID}" class="extension_container npc-state-delta-extension">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>NPC State Delta <span class="npc-state-delta-version">v${NPC_STATE_VERSION}</span></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content npc-state-delta-drawer story-suite-panel">
          <div id="npc_state_delta_suite_manage" class="npc-state-delta-suite-manage story-suite-manage" data-story-suite-link hidden>
            <button type="button" class="menu_button" data-delta-open-suite><i class="fa-solid fa-layer-group"></i> Manage all in Story Suite</button>
          </div>
          <div class="delta-settings-quickbar story-suite-quickbar">
            <div class="delta-settings-quick-toggles">
              ${settingRow('npc_state_delta_enabled', 'Enable NPC State Delta', '<input id="npc_state_delta_enabled" type="checkbox">')}
              ${settingRow('npc_state_delta_auto', 'Auto scan', '<input id="npc_state_delta_auto" type="checkbox">', 'Runs after assistant replies.')}
            </div>
            <div class="npc-state-delta-actions delta-settings-quick-actions story-suite-actions">
              <button type="button" class="menu_button" data-delta-settings-open-dossiers><i class="fa-solid fa-address-book"></i> Open dossiers</button>
              <div id="npc_state_delta_scan_now" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now</div>
              ${settingsSlot('full-cast-action')}
              <div id="npc_state_delta_add_manual" class="menu_button"><i class="fa-solid fa-user-plus"></i> Add NPC</div>
            </div>
          </div>
          <div class="delta-settings-experience story-suite-folds">
            ${settingsGroup('scanning', 'Scanning', 'Connection, cadence and admission', scanning)}
            ${settingsGroup('roster', 'Roster & continuity', 'Injection, lifecycle and stale cleanup', roster)}
            ${settingsGroup('calendar', 'Calendar & birthdays', 'Fantasy months and optional campaign clock', settingsSlot('calendar'))}
            ${settingsGroup('suite', 'Source of truth', 'Sharing with other story extensions', suite)}
            ${settingsGroup('portrait', 'Portrait generation', 'Image Generation prompts and style', portrait)}
            ${settingsGroup('rules', 'Scanner rules', 'Advanced relationship, memory and behavior rubrics', rules)}
            ${settingsGroup('advanced', 'Advanced', 'Scan context, output and injection limits, branch handling', advanced)}
            ${settingsGroup('sent', "What's sent", 'The text your next reply gets, and its size', `<div class="delta-whats-sent" data-delta-whats-sent><small class="delta-whats-sent-empty">Open this to see it.</small></div><div class="npc-state-delta-actions"><div id="npc_state_delta_sent_refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> Refresh</div></div>`)}
            ${settingsGroup('maintenance', 'Data & maintenance', 'Backup, diagnostics and this chat', maintenance)}
          </div>
        </div>
      </div>
    </div>`;
}

const SETTINGS_OPEN_GROUPS_KEY = 'npc_state_delta_settings_open_groups';
const DEFAULT_OPEN_SETTINGS_GROUPS = ['scanning'];

function readOpenSettingsGroups() {
    try {
        const raw = globalThis.localStorage?.getItem?.(SETTINGS_OPEN_GROUPS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : DEFAULT_OPEN_SETTINGS_GROUPS;
    } catch {
        return DEFAULT_OPEN_SETTINGS_GROUPS;
    }
}

// (1.2.14) A long setting hint reads as its first sentence; "more" shows the rest in place. The
// rows come from several modules (some fill their slots later), so hints are compacted when a
// group opens. Presentation only: every setting, its key and its text stay as they are.
const HINT_COMPACT_CHARS = 110;
function compactSettingHints(root) {
    for (const small of root?.querySelectorAll?.('.npc-state-delta-setting-row > span:first-child > small:not([data-delta-hint])') || []) {
        small.dataset.deltaHint = '1';
        if (small.children?.length) continue;
        const text = String(small.textContent || '').trim();
        const split = text.length > HINT_COMPACT_CHARS ? text.match(/^(.{20,160}?[.!?])\s+(\S[\s\S]*)$/) : null;
        if (!split) continue;
        const rest = document.createElement('span');
        rest.className = 'delta-hint-rest';
        rest.textContent = ` ${split[2]}`;
        const more = document.createElement('span');
        more.className = 'delta-hint-more';
        more.setAttribute('role', 'button');
        more.setAttribute('tabindex', '0');
        more.textContent = 'more';
        small.title = text;
        small.replaceChildren(document.createTextNode(split[1]), rest, document.createTextNode(' '), more);
    }
}

function toggleSettingHint(event) {
    const more = event.target?.closest?.('.delta-hint-more');
    if (!more) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    // Inside the row's label: keep the click from toggling the setting.
    event.preventDefault();
    event.stopPropagation();
    const small = more.parentElement;
    const open = !small.classList.contains('is-open');
    small.classList.toggle('is-open', open);
    more.textContent = open ? 'less' : 'more';
}

// Remember which settings groups the player keeps open; presentation only, never canonical state.
function bindSettingsGroupMemory(root) {
    const groups = [...(root?.querySelectorAll?.('[data-delta-settings-group]') || [])];
    const open = new Set(readOpenSettingsGroups());
    for (const group of groups) group.open = open.has(group.dataset.deltaSettingsGroup);
    for (const group of groups) if (group.open) setTimeout(() => compactSettingHints(group), 0);
    root?.addEventListener?.('click', toggleSettingHint, true);
    root?.addEventListener?.('keydown', toggleSettingHint, true);
    root?.addEventListener?.('toggle', event => {
        if (!event.target?.matches?.('[data-delta-settings-group]')) return;
        if (event.target.open) compactSettingHints(event.target);
        const next = groups.filter(group => group.open).map(group => group.dataset.deltaSettingsGroup);
        try { globalThis.localStorage?.setItem?.(SETTINGS_OPEN_GROUPS_KEY, JSON.stringify(next)); } catch { /* optional */ }
    }, true);
}

function syncScannerProfileControl() {
    const control = $('#npc_state_delta_scanner_connection_profile');
    if (!control.length) return;
    const selected = getSettings().scannerConnectionProfile;
    const html = scannerProfileOptions(getContext(), selected)
        .map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
    if (control.html() !== html) control.html(html);
    control.val(selected);
    // No profile to pick (only the current connection, or a missing one): say so under the list.
    const usable = scannerProfileOptions(getContext(), '').length > 1;
    $('#npc_state_delta_scanner_profile_none').prop('hidden', usable);
}

function syncSettingsControls() {
    const s = getSettings();
    $('#npc_state_delta_enabled').prop('checked', !!s.enabled);
    $('#npc_state_delta_auto').prop('checked', !!s.autoScan);
    syncScannerProfileControl();
    $('#npc_state_delta_full_scan_every_turn').prop('checked', !!s.fullScanEveryTurn);
    $('#npc_state_delta_narration_capture').prop('checked', !!s.narrationCapture);
    $('#npc_state_delta_narration_capture_compact').prop('checked', !!s.narrationCaptureCompact);
    $('#npc_state_delta_scan_every').val(s.scanEvery);
    $('#npc_state_delta_scan_depth').val(s.scanDepth);
    $('#npc_state_delta_narration_capture_catch_up').val(s.narrationCaptureCatchUp);
    $('#npc_state_delta_admission_mode').val(s.admissionMode);
    $('#npc_state_delta_max').val(s.maxNpcs);
    $('#npc_state_delta_auto_prune_stale').prop('checked', s.autoPruneStale !== false);
    $('#npc_state_delta_stale_archive_after').val(s.staleArchiveAfter);
    $('#npc_state_delta_stale_delete_after').val(s.staleDeleteAfter);
    $('#npc_state_delta_inject').prop('checked', !!s.inject);
    $('#npc_state_delta_inject_budget').val(s.injectBudgetTokens);
    $('#npc_state_delta_inject_limit').val(s.injectLimit);
    $('#npc_state_delta_custom_fields').val((s.customFieldNames || []).join(', '));
    syncSuiteControls();
    $('#npc_state_delta_archive_deaths').prop('checked', s.autoArchiveDeaths !== false);
    $('#npc_state_delta_reactivate_archived').prop('checked', s.autoReactivateArchived !== false);
    $('#npc_state_delta_branch_rescan').prop('checked', s.branchRescan !== false);
    $('#npc_state_delta_mid_delete_rewind').prop('checked', s.midDeleteRewind === true);
    $('#npc_state_delta_present_cast_display').val(effectivePresentCastChoice());
    $('#npc_state_delta_launcher_with_story_block').prop('checked', s.launcherWithStoryBlock === true);
    $('#npc_state_delta_launcher_with_story_block_v2').prop('checked', s.launcherWithStoryBlockV2 === true);
    applyLauncherFlag();
    if (!portraitSettingsDirty) writePortraitSettingsDraftToUi(portraitSettingsSnapshot(s));
    updatePortraitSettingsSaveUi();
    $('#npc_state_delta_base_trust').val(s.relationshipBaseline.trust);
    $('#npc_state_delta_base_affection').val(s.relationshipBaseline.affection);
    $('#npc_state_delta_base_desire').val(s.relationshipBaseline.desire);
    $('#npc_state_delta_base_tension').val(s.relationshipBaseline.tension);
    $('#npc_state_delta_cap_ordinary').val(s.relationshipCaps.ordinary);
    $('#npc_state_delta_cap_meaningful').val(s.relationshipCaps.meaningful);
    $('#npc_state_delta_cap_major').val(s.relationshipCaps.major);
    $('#npc_state_delta_cap_extreme').val(s.relationshipCaps.extreme);
    $('#npc_state_delta_relationship_criteria').val(s.relationshipCriteria);
    $('#npc_state_delta_impact_criteria').val(s.relationshipImpactCriteria);
    $('#npc_state_delta_memory_criteria').val(s.memoryCriteria);
    $('#npc_state_delta_behavior_criteria').val(s.behaviorCriteria);
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

function recordInlineCardsInState(state, messageId, npcIds, reason = 'scan') {
    if (!Number.isInteger(messageId) || messageId < 0) return state;
    if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
    const ids = [...new Set((npcIds || []).filter(Boolean))];
    const cards = ids.map(id => state.npcs.find(npc => npc.id === id)).filter(Boolean).map(snapshotNpc);
    if (!cards.length) return state;
    const messageFingerprint = fingerprintMessage((getContext().chat || [])[messageId] || {});
    const lineageKey = currentLineageKeyForMessage(messageId);
    let entry = state.inlineCards.find(item => lineageKey && item.lineageKey === lineageKey);
    if (!entry) {
        entry = { messageId, fingerprint: messageFingerprint, lineageKey, reason, createdAt: Date.now(), cards: [] };
        state.inlineCards.push(entry);
    }
    entry.messageId = messageId;
    entry.fingerprint = messageFingerprint;
    entry.lineageKey = lineageKey;
    entry.reason = reason || entry.reason;
    entry.createdAt = Date.now();
    for (const card of cards) {
        const index = entry.cards.findIndex(existing => existing.id === card.id);
        if (index >= 0) entry.cards[index] = card;
        else entry.cards.push(card);
    }
    state.inlineCards.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    if (state.inlineCards.length > INLINE_HISTORY_LIMIT) state.inlineCards.splice(0, state.inlineCards.length - INLINE_HISTORY_LIMIT);
    return state;
}

function clearInlineCardsAtMessage(state, messageId) {
    if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
    const lineageKey = currentLineageKeyForMessage(messageId);
    state.inlineCards = state.inlineCards.filter(entry => {
        if (lineageKey && entry?.lineageKey) return entry.lineageKey !== lineageKey;
        return !(Number(entry?.messageId) === Number(messageId) && entry?.fingerprint === fingerprintMessage((getContext().chat || [])[messageId] || {}));
    });
    return state;
}

function removeNpcInlineCardAtMessage(state, messageId, npcId) {
    if (!Array.isArray(state.inlineCards) || !Number.isInteger(messageId) || messageId < 0 || !npcId) return state;
    const lineageKey = currentLineageKeyForMessage(messageId);
    state.inlineCards = state.inlineCards.map(entry => {
        const matches = lineageKey && entry?.lineageKey
            ? entry.lineageKey === lineageKey
            : Number(entry?.messageId) === Number(messageId);
        if (!matches) return entry;
        return { ...entry, cards: (entry.cards || []).filter(card => card.id !== npcId) };
    }).filter(entry => (entry.cards || []).length);
    return state;
}

function purgeInlineCardsInState(state, npcId = null, name = '') {
    if (!Array.isArray(state.inlineCards)) state.inlineCards = [];
    state.inlineCards = state.inlineCards.map(entry => ({
        ...entry,
        cards: (entry.cards || []).filter(card => {
            if (npcId && card.id === npcId) return false;
            if (name && npcMatchesLabel(card, name)) return false;
            return true;
        }),
    })).filter(entry => entry.cards.length);
    return state;
}

function scanInlineNpcIds(_parsed, merged) {
    // mergeScanResult clears stale presence on ordinary scans and then reapplies the
    // latest scanner result. The merged state is therefore the authoritative source
    // for which NPCs belong under the current assistant message. Do not require a
    // second "touched" match here: that could leave the roster showing ● present
    // while no inline snapshot was recorded.
    return merged.state.npcs
        .filter(npc => !npc.archived && npc.present && !npc.minor)
        .map(npc => npc.id);
}

function currentNpcById(id) {
    if (chatHydrationStatus(getChatKey()) !== 'ready') return null;
    return getChatState().npcs.find(npc => npc.id === id) || null;
}

function findNpcByIdOrName(value) {
    const query = String(value || '').trim();
    if (!query || chatHydrationStatus(getChatKey()) !== 'ready') return null;
    const normalized = normalizeName(query);
    return getChatState().npcs.find(npc => npc.id === query || normalizeName(npc.name) === normalized) || null;
}

// Like the dossier, the present cast shows the current form's own portrait when that form has one,
// and the main portrait otherwise.
function portraitMarkup(npc, displayName, placeholderClass = 'npc-state-delta-inline-avatar-placeholder') {
    const formImage = npc?.currentForm ? formPortraitFor(getChatState().formPortraitAssets, npc.id, npc.currentForm) : null;
    const portraitUrl = formImage?.dataUrl || npc?.portrait?.dataUrl || '';
    if (portraitUrl) return `<img src="${escapeHtml(portraitUrl)}" alt="${escapeHtml(displayName)} portrait">`;
    const initial = String(displayName || '?').trim().charAt(0).toUpperCase() || '?';
    return `<div class="${placeholderClass}" aria-hidden="true"><span>${escapeHtml(initial)}</span></div>`;
}

function inlineCardHtml(npc, messageId, scene = null) {
    if (!npc || npc.archived || !npc.present || npc.minor) return '';
    const displayName = npc.name || 'NPC';
    // With now lines (Mood, Condition, Outfit) the identity line keeps only the role. The text sits
    // under the portrait so the name and the now lines can wrap instead of being cut to one line.
    const now = nowSlotHtml(scene, npc.id);
    const identityLine = (now ? npc.role : [npc.role, npc.mood].filter(Boolean).join(' · ')) || 'Present NPC';
    const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder');
    const card = `
      <button type="button" class="npc-state-delta-present-card" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier">
        <span class="npc-state-delta-present-card-portrait">${portrait}</span>
        <span class="npc-state-delta-present-card-text">
          <span class="npc-state-delta-present-card-head"><b class="npc-state-delta-present-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</b><span class="npc-state-delta-present-card-stage"></span></span>
          <small class="npc-state-delta-present-card-role" title="${escapeHtml(identityLine)}">${escapeHtml(identityLine)}</small>${now}
        </span>
      </button>`;
    // One cell per NPC: the card, then what narrow panes show in the row's right half (1.2.4, see
    // style.css): the NPC's chatter if any, else the now lines (the same slots as on the card; the
    // wide grid shows them on the card and hides this copy, narrow panes the reverse), else the role
    // and "No changes this turn". Wide grids show the chatter under the card. Tapping anywhere in
    // the cell, the right half included, opens the dossier.
    const chatter = chatterSlotsHtml(scene, npc.id);
    const side = chatter ? chatter
        : (now ? `<div class="npc-state-delta-present-side npc-state-delta-present-side-now">${now}</div>`
            : `<div class="npc-state-delta-present-side npc-state-delta-present-side-idle"><small class="npc-state-delta-present-side-role">${escapeHtml(identityLine)}</small><small class="npc-state-delta-present-side-muted">No changes this turn</small></div>`);
    const kind = chatter ? 'chatter' : (now ? 'now' : 'idle');
    return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-${kind}" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}">${card}${side}</div>`;
}

// A card for someone who speaks in the chatter but has no present card (1.2.7), in the same
// card-and-bubble cell as a present NPC: a tracked NPC not marked present (or minor) gets their
// portrait and opens their dossier; a name the dossiers do not know gets its initial, and the
// name arrives through a text slot like the chatter itself.
function speakerCellHtml(group, scene, messageId) {
    const chatter = speakerChatterHtml(scene, group);
    if (!chatter) return '';
    const roster = (getChatState().npcs || []).filter(npc => !npc.archived);
    const id = matchPresentCard(group.name, roster.map(npc => ({ id: npc.id, name: npc.name, aliases: npc.aliases || [] })), roster);
    const npc = id ? roster.find(item => item.id === id) : null;
    if (npc) {
        const displayName = npc.name || 'NPC';
        const role = npc.role || 'Not marked present';
        const card = `
      <button type="button" class="npc-state-delta-present-card" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier">
        <span class="npc-state-delta-present-card-portrait">${portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder')}</span>
        <span class="npc-state-delta-present-card-text">
          <b class="npc-state-delta-present-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</b>
          <small class="npc-state-delta-present-card-role" title="${escapeHtml(role)}">${escapeHtml(role)}</small>
        </span>
      </button>`;
        return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-chatter npc-state-delta-present-cell-speaker" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}">${card}${chatter}</div>`;
    }
    const initial = String(group.name || '?').trim().charAt(0).toUpperCase() || '?';
    const card = `
      <div class="npc-state-delta-present-card npc-state-delta-present-card-untracked">
        <span class="npc-state-delta-present-card-portrait"><div class="npc-state-delta-present-card-placeholder" aria-hidden="true"><span>${escapeHtml(initial)}</span></div></span>
        <span class="npc-state-delta-present-card-text">
          <b class="npc-state-delta-present-card-name" data-delta-text="${Number(group.speaker)}"></b>
          <small class="npc-state-delta-present-card-role">Not in the dossiers yet</small>
        </span>
      </div>`;
    return `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-chatter npc-state-delta-present-cell-speaker npc-state-delta-present-cell-untracked" data-message-id="${messageId}">${card}${chatter}</div>`;
}

function presentCastChipHtml(npc, messageId) {
    const displayName = npc.name || 'NPC';
    const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder');
    return `<button type="button" class="npc-state-delta-present-chip" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier"><span class="npc-state-delta-present-chip-portrait">${portrait}</span><span>${escapeHtml(displayName)}</span></button>`;
}

// Story Block's block text for the latest assistant reply (that reply only, never an older copy),
// or ''. Read through its public api: blockInText on that one message, else getBlock.
function storyBlockTextForLatestReply(tags, messageId) {
    const storyBlock = globalThis.StoryBlock;
    const message = Number.isInteger(messageId) && messageId >= 0 ? getContext().chat?.[messageId] : null;
    if (!storyBlock || !message || message.is_user || message.is_system) return '';
    const texts = [];
    for (const tag of tags) {
        try {
            const found = typeof storyBlock.blockInText === 'function'
                ? storyBlock.blockInText(String(message.mes ?? ''), tag)
                : storyBlock.getBlock?.(tag, { beforeIndex: messageId + 1 });
            const text = found && (found.messageIndex === undefined || found.messageIndex === null || found.messageIndex === messageId) ? String(found.text ?? '').trim() : '';
            if (text) texts.push(text);
        } catch (error) {
            console.warn('[NPC State Delta] Story Block block could not be read', error);
        }
    }
    return texts.join('\n');
}

// (1.2.10) Who the reply's World State puts in the scene and off-screen at its end, or null
// when the reply has none (or there is no Story Block to read it with): the scan then keeps the
// model's own word.
function scenePresentAt(messageId) {
    try {
        const blocks = typeof globalThis.StoryBlock?.listBlocks === 'function' ? globalThis.StoryBlock.listBlocks() : [];
        const text = storyBlockTextForLatestReply(storyBlockTags(blocks, 'scene'), messageId);
        const people = text ? worldStatePeople(text) : null;
        return people && (people.present || people.offscreen) ? people : null;
    } catch {
        return null;
    }
}

// Display only: the now line on each present card and Story Block's NPC Inner Chatter beside
// them. World State is used for the now line only while Story Block keeps the scene.
function presentSceneFor(visible, messageId) {
    try {
        const settings = getSettings();
        const blocks = typeof globalThis.StoryBlock?.listBlocks === 'function' ? globalThis.StoryBlock.listBlocks() : [];
        const sceneOwned = areaOwner('scene', settings.sourceOfTruth)?.id === 'story-block';
        const sceneText = sceneOwned ? storyBlockTextForLatestReply(storyBlockTags(blocks, 'scene'), messageId) : '';
        // Only enabled chatter blocks (Story Block's default one is tagged NPC_Inner_Chatter).
        const chatterText = storyBlockTextForLatestReply(storyBlockTags(blocks, 'chatter'), messageId);
        const cards = visible.map(npc => ({
            id: npc.id,
            name: npc.name,
            aliases: npc.aliases || [],
            mood: npc.mood,
            condition: npc.status,
            outfit: currentPresentationText(npc) || npc.currentForm || '',
        }));
        const roster = (getChatState().npcs || []).filter(npc => !npc.archived);
        return rememberPresentScene(presentSceneModel({ cards, roster, sceneText, sceneOwned, chatterText }));
    } catch (error) {
        console.warn('[NPC State Delta] present scene skipped', error);
        return null;
    }
}

function inlineRosterHtml(cards, messageId, mode = inChatCastMode(), { othersWithoutCast = false } = {}) {
    const currentById = new Map(getChatState().npcs.map(npc => [npc.id, npc]));
    const visible = (cards || []).map(card => currentById.get(card.id)).filter(npc => npc?.present && !npc.archived && !npc.minor);
    if (!visible.length && !othersWithoutCast) return '';
    if (mode === 'compact') {
        return `
      <section class="npc-state-delta-present-roster npc-state-delta-present-strip" data-message-id="${messageId}">
        <span class="npc-state-delta-kicker">PRESENT NPCS</span>
        <div class="npc-state-delta-present-chips">${visible.map(npc => presentCastChipHtml(npc, messageId)).join('')}</div>
      </section>`;
    }
    const scene = presentSceneFor(visible, messageId);
    // Named speakers without a present card get cards of their own after the present ones; only
    // lines with no speaker are left for the Others line.
    const speakerCells = speakerGroups(scene).map(group => speakerCellHtml(group, scene, messageId)).filter(Boolean);
    const speakers = speakerCells.join('');
    const others = othersSlotsHtml(scene, { speakerless: true });
    if (!visible.length && !speakers && !others) return '';
    const grid = visible.length || speakers ? `
        <div class="npc-state-delta-present-grid">${visible.map(npc => inlineCardHtml(npc, messageId, scene)).join('')}${speakers}</div>` : '';
    return `
      <section class="npc-state-delta-present-roster" data-message-id="${messageId}"${sceneAttr(scene)}>
        <div class="npc-state-delta-present-roster-head"><span class="npc-state-delta-kicker">PRESENT NPCS</span><small>${visible.length + speakerCells.length} shown</small></div>${grid}${others}
      </section>`;
}

function messageElement(messageId) {
    if (!Number.isInteger(messageId) || messageId < 0) return null;
    const selectors = [
        `#chat .mes[mesid="${messageId}"]`,
        `.mes[mesid="${messageId}"]`,
        `#chat .mes[data-mesid="${messageId}"]`,
        `.mes[data-mesid="${messageId}"]`,
        `#chat .mes[data-message-id="${messageId}"]`,
        `.mes[data-message-id="${messageId}"]`,
    ];
    for (const selector of selectors) {
        const found = document.querySelector?.(selector);
        if (found) return found;
    }

    // Defensive fallback for themes/plugins that clone message markup without SillyTavern's
    // mesid attribute. Only use DOM order when it lines up exactly with non-system chat rows.
    const domMessages = [...(document.querySelectorAll?.('#chat .mes') || [])];
    const visibleMessageIds = (getContext().chat || [])
        .map((message, index) => (!message?.is_system ? index : null))
        .filter(index => index !== null);
    if (domMessages.length && domMessages.length === visibleMessageIds.length) {
        const domIndex = visibleMessageIds.indexOf(messageId);
        if (domIndex >= 0) return domMessages[domIndex] || null;
    }
    return null;
}

const PRESENT_CAST_DISPLAY_MODES = Object.freeze(['full', 'compact', 'storyblock', 'off']);

function normalizePresentCastDisplay(value) {
    return PRESENT_CAST_DISPLAY_MODES.includes(value) ? value : 'full';
}

function presentCastDisplayMode() {
    return normalizePresentCastDisplay(getSettings().presentCastDisplay);
}

// The floating launcher hides while Story Block carries Delta's tabs, or a Story Block v2 host
// carries Delta (CSS in launcher-ui.js keys on these flags), unless the player keeps it.
function applyLauncherFlag() {
    const data = document?.documentElement?.dataset;
    if (!data) return;
    data.npcStateDeltaLauncher = getSettings().launcherWithStoryBlock === true ? 'keep' : 'auto';
    data.npcStateDeltaLauncherV2 = getSettings().launcherWithStoryBlockV2 === true ? 'keep' : 'auto';
}

// Set by story-block-tabs.js once its Present NPCs and Dossiers tabs are registered with Story Block.
function storyBlockTabsActive() {
    return document?.documentElement?.dataset?.npcStateDeltaStoryBlock === '1';
}

// Story Block shows Delta's present cast: v1's Present NPCs tab, or a v2 host's Cast tab.
function storyBlockCarriesCast() {
    return storyBlockTabsActive() || storyBlockV2Hosted();
}

// The choice in effect. Until the player picks one, Full cards becomes "Only in Story Block" while
// Story Block carries the cast, so it is not shown twice. Compact and Off are always deliberate.
function effectivePresentCastChoice() {
    const mode = presentCastDisplayMode();
    const chosen = getSettings().presentCastDisplayChosen === true || mode !== 'full';
    return !chosen && storyBlockCarriesCast() ? 'storyblock' : mode;
}

// What the chat itself shows. "Only in Story Block" hides the in-chat cast while a Story Block tab
// carries it, and falls back to full cards when Story Block is not installed.
function inChatCastMode() {
    const mode = effectivePresentCastChoice();
    if (mode !== 'storyblock') return mode;
    return storyBlockCarriesCast() ? 'off' : 'full';
}

// The Story Block tab's cast: the live present NPCs as full cards, whatever the in-chat choice.
function storyBlockCastHtml() {
    const key = getChatKey();
    if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return '';
    const present = scenePresenceView(getChatState(key).npcs).filter(npc => !npc.archived && npc.present && !npc.minor);
    // With nobody present the tab still shows chatter (as Others), so none is lost.
    return inlineRosterHtml(present, latestMessageId(true), 'full', { othersWithoutCast: true });
}

function inlineEntriesForRender(state) {
    // Presentation only: Off renders nothing, while inlineCards history is still recorded below.
    if (inChatCastMode() === 'off') return [];
    // Visible NPC State Delta is a live present-cast view, not a historical dossier timeline.
    // Keep inlineCards internally for branch/rollback safety, but render only the latest
    // assistant message and only NPCs physically present in the current merged state.
    const latestAssistantId = latestMessageId(true);
    if (latestAssistantId < 0) return [];
    const presentCards = (state.npcs || [])
        .filter(npc => !npc.archived && npc.present && !npc.minor)
        .map(snapshotNpc);
    if (!presentCards.length) return [];
    return [{
        messageId: latestAssistantId,
        reason: 'live-present-grid',
        createdAt: Date.now(),
        cards: presentCards,
    }];
}

function meguminIntegrationMessageId(node) {
    const value = Number(node?.dataset?.npcStateDeltaMessageId);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function meguminBlockCardForMessage(message) {
    const card = message?.querySelector?.('.meg-blocks') || null;
    // Story Block's compatible card already carries Delta's own registered tab.
    return card && storyBlockTabsActive() && card.classList?.contains?.('story-block-card') ? null : card;
}

function setClassActive(node, active) {
    if (!node) return;
    if (node.classList?.toggle) node.classList.toggle('active', Boolean(active));
    else {
        const names = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
        if (active) names.add('active'); else names.delete(active);
        node.className = [...names].join(' ');
    }
}

function meguminSnapshotSignature(html) {
    const text = String(html || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function closeMeguminNpcStatePane(card) {
    if (!card?.querySelectorAll) return;
    for (const pane of [...(card.querySelectorAll('.npc-state-delta-megumin-pane') || [])]) {
        if (pane?.style) pane.style.display = 'none';
    }
    for (const tab of [...(card.querySelectorAll('.npc-state-delta-megumin-tab') || [])]) {
        setClassActive(tab, false);
        tab.setAttribute?.('aria-expanded', 'false');
    }
}

function mountNpcStateInsideMeguminBlock(message, messageId, html) {
    const card = meguminBlockCardForMessage(message);
    if (!card?.querySelector) return false;
    const tabs = card.querySelector('.meg-blocks-tabs');
    const panel = card.querySelector('.meg-blocks-panel');
    if (!tabs || !panel) return false;

    let button = card.querySelector('.npc-state-delta-megumin-tab');
    let pane = card.querySelector('.npc-state-delta-megumin-pane');
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'meg-blocks-tab npc-state-delta-megumin-tab';
        button.dataset.npcStateDeltaMessageId = String(messageId);
        button.dataset.key = `npc-state-delta:${messageId}`;
        button.title = 'Present NPCs';
        button.setAttribute?.('aria-expanded', 'false');
        button.innerHTML = '<span class="meg-blocks-tab-emoji">👥</span><span class="meg-blocks-tab-label">Present NPCs</span>';
        button.addEventListener?.('click', event => {
            // Inventory Ledger may deliberately restore this foreign tab from its own bridge.
            // In that case it prevents the click after restoring our pane; do not immediately
            // interpret the same click as a second toggle and close it again.
            if (event?.defaultPrevented) return;
            event?.stopPropagation?.();

            const isOpen = button.classList?.contains?.('active')
                && pane?.style?.display !== 'none'
                && !card.classList?.contains?.('meg-blocks-shut');
            if (isOpen) {
                closeMeguminNpcStatePane(card);
                card.classList?.add?.('meg-blocks-shut');
                return;
            }

            // Megumin keeps its selected-tab key in a private closure. Merely changing the DOM
            // leaves that hidden state pointing at the previously selected native tab, which makes
            // the next click on that tab CLOSE it instead of opening it. Drive Megumin's own
            // collapse button until its native state reaches the shut/null state first. With a
            // resting CYOA tab the first click can open that resting tab, so a second click is the
            // deterministic fallback that returns the closure to null.
            const collapse = tabs.querySelector?.('.meg-blocks-collapse');
            if (typeof collapse?.click === 'function') {
                collapse.click();
                if (!card.classList?.contains?.('meg-blocks-shut')) collapse.click();
            }

            for (const nativePane of [...(card.querySelectorAll?.('.meg-block-body') || [])]) {
                if (nativePane?.style) nativePane.style.display = nativePane === pane ? '' : 'none';
            }
            for (const tab of [...(card.querySelectorAll?.('.meg-blocks-tab') || [])]) setClassActive(tab, tab === button);
            if (panel?.style) panel.style.display = '';
            card.classList?.remove?.('meg-blocks-shut');
            button.setAttribute?.('aria-expanded', 'true');
        });
        const collapse = tabs.querySelector?.('.meg-blocks-collapse');
        if (collapse?.before) collapse.before(button);
        else tabs.appendChild?.(button);
    }

    if (!pane) {
        pane = document.createElement('div');
        pane.className = 'meg-block-body npc-state-delta-megumin-pane';
        pane.dataset.npcStateDeltaMessageId = String(messageId);
        if (pane.style) pane.style.display = 'none';
        panel.appendChild?.(pane);
    }
    // Keep the foreign tab/pane key pair compatible with other Megumin card integrations
    // (notably Inventory Ledger) so they can restore NPC State Delta as the prior active pane.
    pane.dataset.key = button.dataset.key;
    const snapshotSignature = meguminSnapshotSignature(html);
    // Do not compare pane.innerHTML with the source string. Browsers serialize an opened
    // <details> with an `open` attribute, so the old comparison treated normal expansion as
    // stale content and replaced the pane on the next repair render, instantly collapsing it.
    if (pane.dataset.npcStateDeltaSnapshotSignature !== snapshotSignature || !String(pane.innerHTML || '').trim()) {
        pane.innerHTML = html;
        pane.dataset.npcStateDeltaSnapshotSignature = snapshotSignature;
    }

    // Megumin owns its native tab state through private closure variables. Bind a small bridge
    // after those native listeners: choosing any native tab/collapse simply hides our foreign pane,
    // while choosing NPC State Delta hides Megumin's panes. No message.mes rewrite or Megumin import needed.
    for (const control of [...(card.querySelectorAll?.('.meg-blocks-tab, .meg-blocks-collapse') || [])]) {
        if (control === button || control?.dataset?.npcStateDeltaDismissBound === '1') continue;
        if (control?.dataset) control.dataset.npcStateDeltaDismissBound = '1';
        control?.addEventListener?.('click', () => closeMeguminNpcStatePane(card));
    }
    return true;
}

function cleanupStaleMeguminIntegrations(desiredIds, root = chatElementForInlineObserver() || document) {
    for (const node of [...(root.querySelectorAll?.('.npc-state-delta-megumin-pane, .npc-state-delta-megumin-tab') || [])]) {
        const messageId = meguminIntegrationMessageId(node);
        if (messageId === null || !desiredIds.has(messageId)) node.remove?.();
    }
}

function inlineAnchorMessageId(anchor) {
    const value = Number(anchor?.dataset?.npcStateDeltaMessageId);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function chatElementForInlineObserver() {
    return document.querySelector?.('#chat') || null;
}

function ensureInlineObserver() {
    if (typeof globalThis.MutationObserver !== 'function') return false;
    const chat = chatElementForInlineObserver();
    if (!chat) return false;
    if (inlineObserver && inlineObserverChat === chat) return true;
    try { inlineObserver?.disconnect?.(); } catch {}
    inlineObserverChat = chat;
    inlineObserver = new globalThis.MutationObserver(mutations => {
        // Ignore text-only mutations inside our own card. Host message redraws, removed
        // anchors, pagination and markdown replacements all arrive as child-list changes.
        const relevant = (mutations || []).some(mutation => {
            if (mutation?.type && mutation.type !== 'childList') return false;
            const target = mutation?.target;
            if (typeof target?.closest === 'function' && target.closest('.npc-state-delta-inline-anchor, .npc-state-delta-megumin-pane')) return false;
            return true;
        });
        if (relevant) queueInlineRender(45);
    });
    try {
        inlineObserver.observe(chat, { childList: true, subtree: true });
        return true;
    } catch (error) {
        console.debug('[NPC State Delta] inline MutationObserver could not attach', error);
        inlineObserver = null;
        inlineObserverChat = null;
        return false;
    }
}

function inlineMountNeedsRepair() {
    let chatKey;
    try { chatKey = getChatKey(); } catch { return false; }
    if (chatKey === 'no-chat' || chatHydrationStatus(chatKey) !== 'ready') return false;
    const desired = inlineEntriesForRender(getChatState(chatKey)).filter(entry => (entry.cards || []).length);
    if (!desired.length) return false;
    const root = chatElementForInlineObserver() || document;
    const standaloneMounted = new Set(
        [...(root.querySelectorAll?.('.npc-state-delta-inline-anchor') || [])].map(inlineAnchorMessageId).filter(id => id !== null),
    );
    const meguminMounted = new Set(
        [...(root.querySelectorAll?.('.npc-state-delta-megumin-pane') || [])].map(meguminIntegrationMessageId).filter(id => id !== null),
    );
    return desired.some(entry => {
        const messageId = Number(entry.messageId);
        const message = messageElement(messageId);
        if (!message) return false;
        const block = meguminBlockCardForMessage(message);
        const canIntegrate = Boolean(block?.querySelector?.('.meg-blocks-tabs') && block?.querySelector?.('.meg-blocks-panel'));
        return canIntegrate ? !meguminMounted.has(messageId) : !standaloneMounted.has(messageId);
    });
}

function stopInlineWatchdog() {
    if (inlineWatchdogTimer) clearInterval(inlineWatchdogTimer);
    inlineWatchdogTimer = null;
    try { inlineObserver?.disconnect?.(); } catch {}
    inlineObserver = null;
    inlineObserverChat = null;
}

function startInlineWatchdog() {
    // Off adds nothing to the chat, so nothing needs to watch host message redraws.
    if (inChatCastMode() === 'off') return stopInlineWatchdog();
    ensureInlineObserver();
    if (inlineWatchdogTimer || typeof setInterval !== 'function') return;
    inlineWatchdogTimer = setInterval(() => {
        try {
            ensureInlineObserver();
            if (inlineMountNeedsRepair()) queueInlineRender(0);
        } catch (error) {
            console.debug('[NPC State Delta] inline watchdog check failed', error);
        }
    }, 2200);
    inlineWatchdogTimer?.unref?.();
}

function renderInlineCards() {
    let chatKey;
    try { chatKey = getChatKey(); } catch { return { rendered: 0, missing: 0 }; }
    if (chatKey === 'no-chat' || chatHydrationStatus(chatKey) !== 'ready') return { rendered: 0, missing: 0 };
    if (inChatCastMode() !== 'off') ensureInlineObserver();

    const state = getChatState(chatKey);
    const desiredEntries = inlineEntriesForRender(state).filter(entry => (entry.cards || []).length);
    const desiredIds = new Set(desiredEntries.map(entry => Number(entry.messageId)));
    const existingById = new Map();
    const root = chatElementForInlineObserver() || document;
    cleanupStaleMeguminIntegrations(desiredIds, root);

    for (const anchor of [...(root.querySelectorAll?.('.npc-state-delta-inline-anchor') || [])]) {
        const messageId = inlineAnchorMessageId(anchor);
        if (messageId === null || !desiredIds.has(messageId)) {
            anchor.remove?.();
            continue;
        }
        if (existingById.has(messageId)) {
            anchor.remove?.();
            continue;
        }
        existingById.set(messageId, anchor);
    }

    let rendered = 0;
    let missing = 0;
    for (const entry of desiredEntries) {
        const messageId = Number(entry.messageId);
        const message = messageElement(messageId);
        if (!message) {
            missing += 1;
            continue;
        }

        const html = inlineRosterHtml(entry.cards || [], messageId);
        let anchor = existingById.get(messageId);
        if (mountNpcStateInsideMeguminBlock(message, messageId, html)) {
            anchor?.remove?.();
            existingById.delete(messageId);
            fillPresentSceneText(message.querySelector?.('.npc-state-delta-megumin-pane'));
            rendered += 1;
            continue;
        }
        if (!anchor) {
            anchor = document.createElement('div');
            anchor.className = 'npc-state-delta-inline-anchor';
            anchor.dataset.npcStateDeltaMessageId = String(messageId);
            anchor.innerHTML = html;
            anchor.__npcStateDeltaHtml = html;
            const text = message.querySelector?.('.mes_text');
            if (text?.insertAdjacentElement) text.insertAdjacentElement('afterend', anchor);
            else (message.querySelector?.('.mes_block') || message).appendChild?.(anchor);
            existingById.set(messageId, anchor);
        } else if (anchor.innerHTML !== html && (anchor.__npcStateDeltaHtml !== html || !String(anchor.innerHTML || '').trim())) {
            // Filled now/chatter slots make innerHTML differ from the source markup by design.
            anchor.innerHTML = html;
            anchor.__npcStateDeltaHtml = html;
        }
        fillPresentSceneText(anchor);
        rendered += 1;
    }
    document.dispatchEvent?.(new CustomEvent('npc-state-delta:cast-rendered'));
    return { rendered, missing };
}

const INLINE_RENDER_RETRY_DELAYS = [80, 180, 350, 700, 1400];
function queueInlineRender(delay = 0, retryIndex = 0) {
    if (inlineRenderTimer) clearTimeout(inlineRenderTimer);
    inlineRenderTimer = setTimeout(() => {
        inlineRenderTimer = null;
        try {
            const result = renderInlineCards();
            if (result?.missing > 0 && retryIndex < INLINE_RENDER_RETRY_DELAYS.length) {
                queueInlineRender(INLINE_RENDER_RETRY_DELAYS[retryIndex], retryIndex + 1);
            }
        } catch (error) {
            console.warn('[NPC State Delta] inline render failed', error);
        }
    }, Math.max(0, Number(delay) || 0));
}

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

function handlePortraitGeneratorEscape(event) {
    if (event?.key !== 'Escape' || event.defaultPrevented
        || document.getElementById?.('npc_state_delta_tools_overlay')) return false;
    if (!activePortraitGeneratorOverlay) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    closePortraitGenerator();
    return true;
}

function editorIsMounted() {
    if (activeEditorPopup?.dlg) {
        return Boolean(activeEditorPopup.dlg.open || activeEditorPopup.dlg.isConnected || document.body?.contains?.(activeEditorPopup.dlg));
    }
    return Boolean(document.querySelector?.('.popup.npc-state-delta-editor-popup'));
}

async function openNpcEditorSafely(npcId) {
    const id = String(npcId || '').trim();
    if (!id) return false;
    const chatKey = getChatKey();
    if (!await ensureFreshMutationBoundary('open a dossier editor', chatKey)) return false;
    try {
        const npc = currentNpcById(id);
        if (!npc) throw new Error(`NPC id ${id} is not in the active chat state.`);
        const editor = openNpcEditor(id);
        if (!editor) throw new Error('SillyTavern editor popup could not be created.');
        return true;
    } catch (error) {
        console.error('[NPC State Delta] dossier editor failed to open', error);
        globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
        return false;
    }
}

function activateNpcEditorFromEvent(event) {
    const editButton = eventTargetClosest(event, '.npc-state-delta-roster-edit');
    if (!editButton) return false;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false;
    const npcId = String(editButton.dataset?.npcId || '').trim();
    if (!npcId) return false;
    const now = Date.now();
    if (lastEditorActivation.npcId === npcId && now - lastEditorActivation.at < 650) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        return true;
    }
    lastEditorActivation = { npcId, at: now };
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    void openNpcEditorSafely(npcId);
    return true;
}

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

function wireSettingsRosterEditor() {
    const holder = document.querySelector?.('#npc_state_delta_roster_summary');
    if (!holder?.querySelectorAll) return;
    holder.querySelectorAll('.npc-state-delta-roster-edit').forEach(control => {
        if (control.dataset?.npcStateDeltaEditorBound === '1') return;
        if (control.dataset) control.dataset.npcStateDeltaEditorBound = '1';
        control.addEventListener?.('pointerup', activateNpcEditorFromEvent);
        control.addEventListener?.('click', activateNpcEditorFromEvent);
        control.addEventListener?.('keydown', activateNpcEditorFromEvent);
    });
}

function renderSettingsRoster() {
    const holder = $('#npc_state_delta_roster_summary');
    if (!holder.length) return;
    const key = getChatKey();
    const hydration = chatHydrationStatus(key);
    if (key === 'no-chat') {
        holder.html('<span class="npc-state-delta-muted">Open a chat to load its NPC State Delta dossier.</span>');
        return;
    }
    if (hydration !== 'ready') {
        const error = hydrationErrors.get(key);
        const message = hydration === 'error'
            ? `NPC State Delta could not load this chat dossier. Existing sidecar data is preserved and all dossier writes are locked.${error?.message ? ` ${escapeHtml(error.message)}` : ''}`
            : (hydration === 'pending' ? 'NPC State Delta is waiting for SillyTavern to assign a stable chat identity. No dossier writes will occur yet.' : 'NPC State Delta is loading this chat dossier. Dossier writes remain locked until loading succeeds.');
        const retry = hydration === 'error' ? '<div class="menu_button npc-state-delta-retry-hydration"><i class="fa-solid fa-rotate"></i> Retry Load</div>' : '';
        const detach = hydration === 'error' && getSettings().dataFiles?.[key]?.path ? '<div class="menu_button npc-state-delta-detach-sidecar"><i class="fa-solid fa-link-slash"></i> Detach Broken Sidecar</div>' : '';
        holder.html(`<div class="npc-state-delta-hydration-warning"><b>${hydration === 'error' ? 'Dossier load failed' : (hydration === 'pending' ? 'Waiting for chat identity...' : 'Loading dossier...')}</b><span>${message}</span>${retry}${detach}</div>`);
        return;
    }
    const state = getChatState(key);

    if (!state.npcs.length) {
        holder.html('<span class="npc-state-delta-muted">No tracked NPCs yet. Named NPCs are stored persistently; inline cards appear only when the latest scene marks them present.</span>');
        return;
    }
    const pointer = getSettings().dataFiles?.[getChatKey()] || null;
    const active = state.npcs.filter(npc => !npc.archived);
    const archived = state.npcs.filter(npc => npc.archived);
    const activeRows = active.length ? active.map(npc => `
      <div class="npc-state-delta-roster-entry" data-npc-id="${escapeHtml(npc.id)}">
        <div class="menu_button npc-state-delta-roster-edit" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Edit ${escapeHtml(npc.name)} dossier">${npc.present ? '● ' : (npc.worldActive ? '◌ ' : '')}${npc.retentionProtected ? '📌 ' : ''}${npc.minor ? '·minor ' : ''}${escapeHtml(npc.name)} <i class="fa-solid fa-pen"></i></div>
        <div class="menu_button npc-state-delta-roster-scan npc-state-delta-scan-dossier" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Scan matching Megumin dossier for ${escapeHtml(npc.name)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <div class="menu_button npc-state-delta-roster-archive npc-state-delta-archive-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Archive ${escapeHtml(npc.name)}"><i class="fa-solid fa-box-archive"></i></div>
        <div class="menu_button npc-state-delta-roster-delete npc-state-delta-delete-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Delete ${escapeHtml(npc.name)} dossier"><i class="fa-solid fa-trash-can"></i></div>
      </div>`).join('') : '<span class="npc-state-delta-muted">No active NPCs.</span>';
    const archivedRows = archived.length ? archived.map(npc => `
      <div class="npc-state-delta-roster-entry npc-state-delta-roster-entry-archived" data-npc-id="${escapeHtml(npc.id)}">
        <div class="menu_button npc-state-delta-roster-edit" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Edit archived ${escapeHtml(npc.name)} dossier">${npc.retentionProtected ? '📌 ' : ''}${npc.minor ? '·minor ' : ''}${escapeHtml(npc.name)}${npc.archiveReason === 'deceased' ? ' ☠' : (npc.archiveReason === 'stale' ? ' ⏳' : '')} <i class="fa-solid fa-pen"></i></div>
        <div class="menu_button npc-state-delta-roster-scan npc-state-delta-scan-dossier" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Scan matching Megumin dossier for ${escapeHtml(npc.name)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <div class="menu_button npc-state-delta-roster-restore npc-state-delta-restore-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Restore ${escapeHtml(npc.name)} to active roster"><i class="fa-solid fa-box-open"></i></div>
        <div class="menu_button npc-state-delta-roster-delete npc-state-delta-delete-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Delete ${escapeHtml(npc.name)} dossier"><i class="fa-solid fa-trash-can"></i></div>
      </div>`).join('') : '<span class="npc-state-delta-muted">No archived NPCs.</span>';
    holder.html(`
      <span class="npc-state-delta-muted">Persistent NPC database:</span>
      <div class="npc-state-delta-roster-block"><b>Active (${active.length})</b><div class="npc-state-delta-roster-chips">${activeRows}</div></div>
      <details class="npc-state-delta-archived-roster" ${archived.length ? '' : ''}><summary><b>Archived (${archived.length})</b></summary><div class="npc-state-delta-roster-chips">${archivedRows}</div><small class="npc-state-delta-muted">Archived dossiers remain in the JSON database, branch history, exports, and portraits, but are excluded from portrait cards and generation injection. Stale auto-archives may be deleted at the configured delete threshold; manual/death archives are preserved.</small></details>
      <small class="npc-state-delta-muted">● present in the latest scanned scene · ◌ current off-screen activity from World State · 📌 protected from stale lifecycle · ·minor hidden from the portrait gallery. Present Minor NPCs still update and remain eligible for generation injection. Auto-archive is reversible; timed stale deletion does not suppress rediscovery, while manual trash does.</small>
      <small class="npc-state-delta-muted npc-state-delta-data-file">Data file: ${escapeHtml(pointer?.path || 'created on first save')}</small>`);
    wireSettingsRosterEditor();
}

function renderDossier() {
    renderSettingsRoster();
    startInlineWatchdog();
    queueInlineRender();
}

// Each list entry is one line in the editor. Entries themselves may contain semicolons (a bond's
// "…; deceased", a memory's two clauses), so only line breaks separate them.
function cleanEditorList(value, max = 12) {
    return [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean))].slice(0, max);
}

// Configured custom fields, plus any value stored under a name no longer configured so it can be cleared.
function customFieldEditorNames(npc) {
    const names = [...normalizeCustomFieldNames(getSettings().customFieldNames)];
    for (const key of Object.keys(normalizeCustomFields(npc?.customFields))) {
        if (!names.some(name => name.toLowerCase() === key.toLowerCase())) names.push(key);
    }
    return names;
}

function customFieldEditorHtml(npc) {
    const stored = normalizeCustomFields(npc?.customFields);
    return customFieldEditorNames(npc).map(name => {
        const key = Object.keys(stored).find(other => other.toLowerCase() === name.toLowerCase());
        return `<label>${editorValue(name)} <small>Custom field</small><input class="text_pole" maxlength="60" data-delta-custom-field="${editorValue(name)}" value="${editorValue(key ? stored[key] : '')}"></label>`;
    }).join('');
}

function customFieldEditorValues(current) {
    const inputs = [...document.querySelectorAll('#npc_state_delta_editor_content [data-delta-custom-field]')];
    if (!inputs.length) return normalizeCustomFields(current?.customFields);
    return normalizeCustomFields(Object.fromEntries(inputs.map(input => [input.dataset.deltaCustomField, String(input.value || '').trim()])));
}

function editorValue(value) {
    return escapeHtml(String(value ?? ''));
}

// (v2 meters, F90, TRS 1-4) Hidden notes, the meter preset and limits, milestones and custom meters:
// shown in the editor only while hosted (src/storysuite-v2.js editorHtml / readEditor).
function hostedSecretsEditorHtml(npc) {
    const adapter = storySuiteV2Meters();
    if (!adapter) return '';
    try { return String(adapter.editorHtml(npc) || ''); } catch { return ''; }
}

function openNpcEditor(npcId) {
    const originChatKey = getChatKey();
    if (!requireReadyChatMutation('edit a dossier', originChatKey)) return null;
    const npc = currentNpcById(npcId);
    if (!npc) return null;
    closeNpcEditor();
    activeEditorChatKey = originChatKey;
    activeEditorBaseRevision = workingCopyAdoption(originChatKey);
    const ctx = getContext();
    const Popup = ctx.Popup;
    const POPUP_TYPE = ctx.POPUP_TYPE;
    const POPUP_RESULT = ctx.POPUP_RESULT;
    if (typeof Popup !== 'function' || !POPUP_TYPE?.TEXT || !POPUP_RESULT) {
        throw new Error('SillyTavern Popup API is unavailable. NPC State Delta requires SillyTavern 1.18+ for dossier editing.');
    }
    // While hosted the numbers shown (and edited) are the v2 slice's; without a host, the dossier's.
    const rel = hostedMeterView([npc])[0].relationship || DEFAULT_RELATIONSHIP;
    const locked = new Set(npc.manualProfileFields || []);
    const content = document.createElement('div');
    content.id = 'npc_state_delta_editor_content';
    content.className = 'npc-state-delta-editor-native';
    // Editor add-ons (appearance forms, life state, sections) identify their NPC from this.
    content.dataset.npcId = npc.id;
    content.innerHTML = `
      <div class="npc-state-delta-editor-head"><div><span class="npc-state-delta-kicker">LIVE DOSSIER</span><h3 id="npc_state_delta_editor_title">Edit ${editorValue(npc.name)}</h3></div></div>
      <p class="npc-state-delta-muted">Edits save to NPC State Delta's extension-owned JSON data. Relationship numbers are authoritative current values on a -100 to +100 scale where 0 is neutral; future story deltas continue from them.</p>
      <div class="npc-state-delta-editor-lifecycle"><b>Lifecycle</b><span>${isTerminalNpcDeath(npc) ? 'Confirmed deceased' : (npc.archived ? 'Archived' : (npc.present ? 'Active · Present' : (npc.worldActive ? 'Active · Off-screen' : 'Active')))}${npc.archiveReason === 'deceased' ? ' · Deceased' : (npc.archiveReason === 'stale' ? ' · Stale auto-archive' : '')}</span>${npc.lifeStateReason ? `<small>${editorValue(npc.lifeStateReason)}</small>` : ''}</div>
      <div class="npc-state-delta-editor-grid npc-state-delta-editor-profile">
        <label>Name<input id="npc_state_delta_edit_name" class="text_pole" maxlength="${EDITOR_FIELDS.name.max}" value="${editorValue(npc.name)}"></label>
        <label>Species / Race<input id="npc_state_delta_edit_species" class="text_pole" maxlength="${EDITOR_FIELDS.species.max}" placeholder="Half-elf, dwarf, dwelf, human, custom species..." value="${editorValue(npc.species)}"></label>
        <label>Gender<select id="npc_state_delta_edit_gender" class="text_pole"><option value="" ${!npc.gender ? 'selected' : ''}>Unknown / not established</option><option value="male" ${npc.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${npc.gender === 'female' ? 'selected' : ''}>Female</option></select></label>
        <label>Role<input id="npc_state_delta_edit_role" class="text_pole" maxlength="${EDITOR_FIELDS.role.max}" value="${editorValue(npc.role)}"></label>
        <label>Aliases / nicknames <small>One per line, max 8. Distinctive nicknames ("Red", "the Butcher of Vell") recall this NPC when mentioned; role descriptions ("the innkeeper") are kept for reference only.</small><textarea id="npc_state_delta_edit_aliases" class="text_pole" rows="2">${editorValue((npc.aliases || []).join('\n'))}</textarea></label>
        <label>Home Base / Usual Location<input id="npc_state_delta_edit_home_base" class="text_pole" maxlength="${EDITOR_FIELDS.homeBase.max}" placeholder="Home, workplace, headquarters, or regular haunt" value="${editorValue(npc.homeBase)}"></label>
        ${customFieldEditorHtml(npc)}
        <label>Chronological age<input id="npc_state_delta_edit_age" class="text_pole" maxlength="${EDITOR_FIELDS.age.max}" placeholder="Actual stated age; leave blank if unknown" value="${editorValue(npc.age)}"></label>
        <label>Birthday <small>${npc.birthDateSource === 'generated' ? 'Generated fallback; editing establishes a manual correction' : (npc.birthDateSource === 'established' ? 'Established date; editing records a manual correction' : 'Uses the active calendar')}</small><input id="npc_state_delta_edit_birthday" class="text_pole" maxlength="180" placeholder="MM-DD / YYYY-MM-DD or configured calendar date" value="${editorValue(npc.birthDateDisplay)}"></label>
        <label>Apparent age<input id="npc_state_delta_edit_apparent_age" class="text_pole" maxlength="${EDITOR_FIELDS.apparentAge.max}" placeholder="~25, young, middle-aged..." value="${editorValue(npc.apparentAge)}"></label>
        <label>Personality<textarea id="npc_state_delta_edit_personality" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.personality.max}">${editorValue(npc.personality)}</textarea></label>
        <label class="npc-state-delta-editor-wide">Behavioral Levers <small>Max ${BEHAVIOR_PROFILE_LIMIT} compact target-general response/decision rules, one per line</small><textarea id="npc_state_delta_edit_behavior_profile" class="text_pole" rows="6" placeholder="Disposition: kind - broadly considerate; avoids needless harm&#10;Expressiveness: low - strong feelings show subtly&#10;Independence: high - keeps own goals and boundaries&#10;Care: practical - helps through actions before reassurance&#10;Conflict: controlled - concise, firm, not gratuitously cruel">${editorValue((npc.behaviorProfile || []).join('\n'))}</textarea></label>
        <label>Speech<textarea id="npc_state_delta_edit_speech" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.speech.max}">${editorValue(npc.speech)}</textarea></label>
        <label>Background<textarea id="npc_state_delta_edit_background" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.background.max}">${editorValue(npc.background)}</textarea></label>
        <label class="npc-state-delta-editor-wide">Established mannerisms <small>One per line</small><textarea id="npc_state_delta_edit_mannerisms" class="text_pole" rows="4">${editorValue((npc.mannerisms || []).join('\n'))}</textarea></label>
        <label class="npc-state-delta-editor-wide">Key relationships <small>Max ${KEY_RELATIONSHIP_LIMIT} · family, friends, rivals, mentors, partners · one per line</small><textarea id="npc_state_delta_edit_key_relationships" class="text_pole" rows="5" placeholder="Yunyun — friend / rival | competitive but loyal">${editorValue((npc.keyRelationships || []).join('\n'))}</textarea></label>
      </div>
      <details class="npc-state-delta-editor-portrait-overrides">
        <summary><b>Portrait prompt overrides</b> <small>Optional per-NPC additions</small></summary>
        <div class="npc-state-delta-editor-portrait-overrides-body">
          <p class="npc-state-delta-muted">These are appended only when building image prompts. They are never injected into roleplay generation and never rewritten by the NPC scanner.</p>
          <label>Additional positive prompt<textarea id="npc_state_delta_edit_portrait_positive" class="text_pole" rows="4" maxlength="${PORTRAIT_NPC_PROMPT_LIMIT}" placeholder="black ceremonial ribbon, winter uniform, gold ear cuff...">${editorValue(npc.portraitPromptPositive)}</textarea></label>
          <label>Additional negative prompt<textarea id="npc_state_delta_edit_portrait_negative" class="text_pole" rows="4" maxlength="${PORTRAIT_NPC_PROMPT_LIMIT}" placeholder="helmet, hood, short hair...">${editorValue(npc.portraitPromptNegative)}</textarea></label>
          <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_portrait_replace" type="checkbox" ${npc.portraitPromptReplace ? 'checked' : ''}> Replace the automatic positive prompt entirely <small>Use only when this NPC needs a hand-authored model-specific prompt. The global negative prompt still applies.</small></label>
        </div>
      </details>
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_lock_profile" type="checkbox" ${locked.size ? 'checked' : ''}> Protect edited stable profile fields from future scanner rewrites <small>Leave off to use manual edits as an organic baseline. Existing locks stay protected until you uncheck and save. Also covers Player Dynamic, Mood, Location, Goal, Condition and Important memories. Memories you type are never pushed out by later scans, protected or not.</small></label>
      ${locked.size ? `<p class="npc-state-delta-muted">Currently protected: ${editorValue([...locked].join(', '))}</p>` : ''}
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_retention_protected" type="checkbox" ${npc.retentionProtected ? 'checked' : ''}> Keep this NPC from automatic stale cleanup <small>Use for recurring or major NPCs who may disappear for long arcs. This does not lock their profile fields.</small></label>
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_minor" type="checkbox" ${npc.minor ? 'checked' : ''}> Hide present-NPC card <small>The dossier still scans, updates, stores memories/relationships, and injects when present; only the present cast card is hidden.</small></label>
      <div class="npc-state-delta-editor-grid">
        <label>Player Dynamic<textarea id="npc_state_delta_edit_relationship_summary" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.relationshipSummary.max}">${editorValue(npc.relationshipSummary)}</textarea></label>
        <label>Mood<input id="npc_state_delta_edit_mood" class="text_pole" maxlength="${EDITOR_FIELDS.mood.max}" value="${editorValue(npc.mood)}"></label>
        <label>Location<input id="npc_state_delta_edit_location" class="text_pole" maxlength="${EDITOR_FIELDS.location.max}" value="${editorValue(npc.location)}"></label>
        <label>Goal<input id="npc_state_delta_edit_goal" class="text_pole" maxlength="${EDITOR_FIELDS.goal.max}" value="${editorValue(npc.goal)}"></label>
        <label>Condition / Activity<input id="npc_state_delta_edit_status" class="text_pole" maxlength="${EDITOR_FIELDS.status.max}" value="${editorValue(npc.status)}"></label>
        <label class="npc-state-delta-editor-wide">Important memories <small>Max 5 · one per line</small><textarea id="npc_state_delta_edit_memories" class="text_pole" rows="5">${editorValue((npc.memories || []).join('\n'))}</textarea></label>
      </div>
      <div class="npc-state-delta-editor-stats">
        <label>Trust<input id="npc_state_delta_edit_trust" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.trust)}"></label>
        <label>Affection<input id="npc_state_delta_edit_affection" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.affection)}"></label>
        <label>Desire<input id="npc_state_delta_edit_desire" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.desire)}"></label>
        <label>Tension<input id="npc_state_delta_edit_tension" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.tension)}"></label>
      </div>${hostedSecretsEditorHtml(npc)}`;

    let popup;
    popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: 'Save dossier',
        cancelButton: 'Cancel',
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        animation: 'fast',
        onClosing: async currentPopup => {
            if (currentPopup.result === POPUP_RESULT.AFFIRMATIVE) {
                return saveNpcEditor(npc.id, { close: false, popup: currentPopup });
            }
            return true;
        },
        onClose: () => {
            if (activeEditorPopup === popup) activeEditorPopup = null;
        },
    });
    popup.dlg?.classList?.add?.('npc-state-delta-editor-popup');
    activeEditorPopup = popup;
    Promise.resolve(popup.show()).catch(error => {
        if (activeEditorPopup === popup) activeEditorPopup = null;
        console.error('[NPC State Delta] native dossier popup failed', error);
        globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
    });
    return popup;
}

function portraitPromptOptions() {
    const settings = portraitSettingsSnapshot(getSettings());
    return {
        stylePositive: settings.portraitStylePositive,
        styleNegative: settings.portraitStyleNegative,
        composition: settings.portraitComposition,
        format: settings.portraitPromptFormat,
        useMood: settings.portraitUseMood,
        useLocation: settings.portraitUseLocation,
    };
}

function npcImagePromptPair(npc) {
    return buildNpcPortraitPrompts(npc || {}, portraitPromptOptions());
}

function slashQuoted(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function executeNativePortraitGeneration(positive, negative, seed = null) {
    const prompt = String(positive || '').trim();
    if (!prompt) throw new Error('Positive portrait prompt is empty.');
    const ctx = getContext();
    const execute = ctx.executeSlashCommandsWithOptions;
    if (typeof execute !== 'function') {
        throw new Error('This SillyTavern build does not expose executeSlashCommandsWithOptions().');
    }
    const settings = getSettings();
    const command = [
        '/imagine',
        'quiet=true',
        // Delta already supplies the complete portrait prompt. Prevent SillyTavern's
        // optional free-mode LLM extension/refine layers from rewriting grounded traits
        // (for example hair color) before the configured image backend receives them.
        'extend=false',
        'edit=false',
        `gallery=${settings.portraitSaveToGallery ? 'true' : 'false'}`,
        normalizePortraitSeed(seed) !== null ? `seed=${normalizePortraitSeed(seed)}` : '',
        negative ? `negative=${slashQuoted(negative)}` : '',
        slashQuoted(prompt),
    ].filter(Boolean).join(' ');
    let result;
    try {
        result = await execute(command, {
            handleParserErrors: false,
            handleExecutionErrors: false,
            source: 'npc_state_delta_portrait',
        });
    } catch (error) {
        const message = String(error?.message || error || 'Unknown image generation error');
        if (/unknown command|imagine|image generation|not configured|not available/i.test(message)) {
            throw new Error(`SillyTavern Image Generation is unavailable or not configured. ${message}`);
        }
        throw error;
    }
    const url = String(result?.pipe ?? '').trim();
    if (!url) throw new Error('SillyTavern Image Generation returned no image URL. Check Image Generation settings and try /imagine manually once.');
    return url;
}

function portraitGeneratorHtml(npc, prompts) {
    const theme = portraitThemeLabel(getSettings());
    return `
      <div class="npc-state-delta-portrait-generator-dialog" role="dialog" aria-modal="true" aria-labelledby="npc_state_delta_portrait_generator_title">
        <header class="npc-state-delta-portrait-generator-header">
          <div><span class="npc-state-delta-kicker">PORTRAIT GENERATOR</span><h2 id="npc_state_delta_portrait_generator_title">${escapeHtml(npc.name)}</h2><small>${escapeHtml(theme)} · SillyTavern Image Generation</small></div>
          <button type="button" class="npc-state-delta-portrait-generator-close" aria-label="Close portrait generator"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="npc-state-delta-portrait-generator-body">
          <section class="npc-state-delta-portrait-generator-preview" aria-live="polite">
            <div class="npc-state-delta-portrait-generator-placeholder"><i class="fa-solid fa-image"></i><b>Generated portrait preview</b><small>The result stays out of chat. Nothing replaces the current portrait until you choose Use as Portrait.</small></div>
            <img class="npc-state-delta-portrait-generator-image" alt="Generated portrait preview" hidden>
            <div class="npc-state-delta-portrait-generator-status" hidden></div>
          </section>
          <section class="npc-state-delta-portrait-generator-prompts">
            <label><b>Positive prompt</b><small>Built from the current dossier + selected portrait theme/preset. Edit freely for this generation.</small><textarea id="npc_state_delta_portrait_positive" class="text_pole" rows="9">${escapeHtml(prompts.positive)}</textarea></label>
            <label><b>Negative prompt</b><small>Selected preset exclusions + this NPC's optional negative override.</small><textarea id="npc_state_delta_portrait_negative" class="text_pole" rows="7">${escapeHtml(prompts.negative)}</textarea></label>
          </section>
        </div>
        <footer class="npc-state-delta-portrait-generator-actions">
          <button type="button" class="menu_button npc-state-delta-portrait-reset"><i class="fa-solid fa-rotate-left"></i> Reset from dossier</button>
          <button type="button" class="menu_button npc-state-delta-portrait-run"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
          <button type="button" class="menu_button npc-state-delta-portrait-use" disabled><i class="fa-solid fa-check"></i> Use as Portrait</button>
        </footer>
      </div>`;
}

function closePortraitGenerator() {
    const overlay = activePortraitGeneratorOverlay;
    activePortraitGeneratorOverlay = null;
    activePortraitGeneratorChatKey = '';
    activePortraitGeneratorNpcId = '';
    activePortraitGenerationUrl = '';
    portraitGenerationBusy = false;
    overlay?.remove?.();
    document.body?.classList?.remove?.('npc-state-delta-portrait-generator-open');
    document.documentElement?.classList?.remove?.('npc-state-delta-portrait-generator-open');
}

function openPortraitGenerator(npcId) {
    const originChatKey = getChatKey();
    if (!requireReadyChatMutation('generate a portrait', originChatKey)) return false;
    const id = String(npcId || '').trim();
    const npc = currentNpcById(id);
    if (!npc) return false;
    if (getSettings().portraitGenerationEnabled === false) {
        globalThis.toastr?.info?.('NPC State Delta: Generate Portrait is disabled in settings.');
        return false;
    }
    const prompts = npcImagePromptPair(npc);
    if (!prompts.positive) {
        globalThis.toastr?.warning?.(`NPC State Delta: ${npc.name} needs an Appearance description or a per-NPC positive prompt before image generation.`);
        return false;
    }
    closePortraitGenerator();
    const overlay = document.createElement('div');
    overlay.id = 'npc_state_delta_portrait_generator_overlay';
    overlay.className = 'npc-state-delta-portrait-generator-overlay';
    // Keep the generator above the already-open full-screen dossier on tablet/mobile.
    overlay.style.zIndex = '2147483600';
    overlay.dataset.npcId = id;
    overlay.innerHTML = portraitGeneratorHtml(npc, prompts);
    overlay.addEventListener?.('click', event => {
        const closeButton = eventTargetClosest(event, '.npc-state-delta-portrait-generator-close');
        if (event.target === overlay || closeButton) {
            event.preventDefault?.();
            event.stopPropagation?.();
            closePortraitGenerator();
        }
    });
    document.body?.appendChild?.(overlay);
    document.body?.classList?.add?.('npc-state-delta-portrait-generator-open');
    document.documentElement?.classList?.add?.('npc-state-delta-portrait-generator-open');
    activePortraitGeneratorOverlay = overlay;
    activePortraitGeneratorChatKey = originChatKey;
    activePortraitGeneratorNpcId = id;
    activePortraitGenerationUrl = '';
    globalThis.requestAnimationFrame?.(() => overlay.querySelector?.('#npc_state_delta_portrait_positive')?.focus?.());
    return true;
}

function setPortraitGeneratorBusy(busy, text = '') {
    portraitGenerationBusy = Boolean(busy);
    const overlay = activePortraitGeneratorOverlay;
    if (!overlay) return;
    const run = overlay.querySelector?.('.npc-state-delta-portrait-run');
    const reset = overlay.querySelector?.('.npc-state-delta-portrait-reset');
    const use = overlay.querySelector?.('.npc-state-delta-portrait-use');
    const close = overlay.querySelector?.('.npc-state-delta-portrait-generator-close');
    const status = overlay.querySelector?.('.npc-state-delta-portrait-generator-status');
    if (run) { run.disabled = portraitGenerationBusy; run.innerHTML = portraitGenerationBusy ? '<i class="fa-solid fa-spinner fa-spin"></i> Generating...' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate again'; }
    if (reset) reset.disabled = portraitGenerationBusy;
    // Closing invalidates this dialog; late generation/decoding cannot apply a result.
    if (close) close.disabled = false;
    if (use) use.disabled = portraitGenerationBusy || !activePortraitGenerationUrl;
    if (status) {
        status.hidden = !text;
        status.textContent = text;
    }
}

function resetPortraitGeneratorFromDossier() {
    if (!activePortraitGeneratorOverlay || !activePortraitGeneratorNpcId || portraitGenerationBusy) return false;
    if (getChatKey() !== activePortraitGeneratorChatKey || !requireReadyChatMutation('reset portrait prompts', activePortraitGeneratorChatKey)) return false;
    const npc = currentNpcById(activePortraitGeneratorNpcId);
    if (!npc) return false;
    const prompts = npcImagePromptPair(npc);
    const positive = activePortraitGeneratorOverlay.querySelector?.('#npc_state_delta_portrait_positive');
    const negative = activePortraitGeneratorOverlay.querySelector?.('#npc_state_delta_portrait_negative');
    if (positive) positive.value = prompts.positive;
    if (negative) negative.value = prompts.negative;
    return true;
}

async function generatePortraitFromDialog() {
    const overlay = activePortraitGeneratorOverlay;
    const originChatKey = activePortraitGeneratorChatKey;
    if (!originChatKey || getChatKey() !== originChatKey || !requireReadyChatMutation('generate a portrait', originChatKey)) return false;
    const npc = currentNpcById(activePortraitGeneratorNpcId);
    if (!overlay || !npc || portraitGenerationBusy) return false;
    const positive = String(overlay.querySelector?.('#npc_state_delta_portrait_positive')?.value || '').trim();
    const negative = String(overlay.querySelector?.('#npc_state_delta_portrait_negative')?.value || '').trim();
    if (!positive) {
        globalThis.toastr?.warning?.('NPC State Delta: positive portrait prompt is empty.');
        return false;
    }
    const revision = Number(stateVersions.get(originChatKey) || 0);
    activePortraitGenerationUrl = '';
    setPortraitGeneratorBusy(true, 'Generating through SillyTavern Image Generation…');
    try {
        const url = await executeNativePortraitGeneration(positive, negative, npc.portraitSeed);
        if (activePortraitGeneratorOverlay !== overlay || activePortraitGeneratorNpcId !== npc.id || activePortraitGeneratorChatKey !== originChatKey || getChatKey() !== originChatKey || !currentNpcById(npc.id)) return false;
        if (Number(stateVersions.get(originChatKey) || 0) !== revision) {
            setPortraitGeneratorBusy(false, 'The dossier changed during generation; the stale preview was discarded.');
            return false;
        }
        activePortraitGenerationUrl = url;
        const image = activePortraitGeneratorOverlay.querySelector?.('.npc-state-delta-portrait-generator-image');
        const placeholder = activePortraitGeneratorOverlay.querySelector?.('.npc-state-delta-portrait-generator-placeholder');
        if (image) {
            image.src = url;
            image.hidden = false;
        }
        if (placeholder) placeholder.hidden = true;
        setPortraitGeneratorBusy(false, 'Generation complete. Review the result before applying it.');
        return true;
    } catch (error) {
        if (activePortraitGeneratorOverlay !== overlay || getChatKey() !== originChatKey) return false;
        console.error('[NPC State Delta] portrait generation failed', error);
        setPortraitGeneratorBusy(false, 'Generation failed.');
        globalThis.toastr?.error?.(`NPC State Delta portrait generation: ${error?.message || error}`);
        return false;
    }
}

async function portraitFileFromGeneratedUrl(url, npcName = 'npc') {
    const raw = String(url || '').trim();
    if (!raw) throw new Error('Generated image URL is empty.');
    const absolute = new URL(raw, globalThis.location?.href || 'http://localhost/').href;
    const response = await fetch(absolute, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not load generated image (${response.status}).`);
    const blob = await response.blob();
    if (!blob.type?.startsWith('image/') || blob.size > 16 * 1024 * 1024) throw new Error('Generated URL must return an image no larger than 16 MB.');
    const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const filename = `${safeFilenamePart(npcName)}-generated.${extension}`;
    return new File([blob], filename, { type: blob.type });
}

async function useGeneratedPortrait() {
    const overlay = activePortraitGeneratorOverlay;
    const npcId = activePortraitGeneratorNpcId;
    const url = activePortraitGenerationUrl;
    const originChatKey = activePortraitGeneratorChatKey;
    if (!overlay || !npcId || !url || portraitGenerationBusy || getChatKey() !== originChatKey) return false;
    if (!requireReadyChatMutation('apply a generated portrait', originChatKey)) return false;
    const npc = currentNpcById(npcId);
    if (!npc) return false;
    const revision = Number(stateVersions.get(originChatKey) || 0);
    const current = () => activePortraitGeneratorOverlay === overlay && getChatKey() === originChatKey
        && activePortraitGeneratorNpcId === npcId && activePortraitGenerationUrl === url;
    setPortraitGeneratorBusy(true, 'Importing generated image into the NPC dossier...');
    let applied = false;
    try {
        const file = await portraitFileFromGeneratedUrl(url, npc.name);
        if (!current() || Number(stateVersions.get(originChatKey) || 0) !== revision) return false;
        applied = await setNpcPortrait(npcId, file, { chatKey: originChatKey, isCurrent: current, generatedFrom: url });
        if (!applied) return false;
        await flushStateFile(originChatKey);
        if (!current()) return false;
        closePortraitGenerator();
        globalThis.toastr?.success?.(`NPC State Delta: generated portrait applied to ${npc.name} and saved.`);
        return true;
    } catch (error) {
        if (!current()) return false;
        setPortraitGeneratorBusy(false, applied ? 'Applied locally; durable save failed.' : 'Could not import the generated result.');
        globalThis.toastr?.[applied ? 'warning' : 'error']?.(`NPC State Delta portrait import: ${error?.message || error}`);
        return false;
    } finally {
        if (current()) setPortraitGeneratorBusy(false);
    }
}

function closeNpcEditor() {
    const popup = activeEditorPopup;
    activeEditorPopup = null;
    activeEditorChatKey = '';
    activeEditorBaseRevision = null;
    if (popup?.completeCancelled) {
        Promise.resolve(popup.completeCancelled()).catch(error => console.debug('[NPC State Delta] editor popup close failed', error));
    }
}

function editorField(id) {
    return document.getElementById(id)?.value ?? '';
}

function clampEditorRelationshipStat(id) {
    const value = Number(editorField(id));
    return Number.isFinite(value) ? Math.max(-100, Math.min(100, Math.round(value))) : 0;
}

async function saveNpcEditor(npcId, { close = true, silent = false, popup = null } = {}) {
    const originChatKey = activeEditorChatKey || getChatKey();
    const editorAtStart = activeEditorPopup;
    if (getChatKey() !== originChatKey || !await ensureFreshMutationBoundary('save dossier edits', originChatKey)) {
        globalThis.toastr?.warning?.('NPC State Delta: this editor belongs to a different or unloaded chat. Reopen the dossier in the active chat.');
        return false;
    }
    // Cancel/Escape during the freshness wait (or a replaced editor) invalidates this Save: the
    // closing popup still holds the draft inputs, but the user abandoned them.
    // An implicit save (Refresh saving the open editor first) has no popup argument: the editor
    // popup it started under must not have been cancelled meanwhile either. Host Popup sets the
    // result before its closing animation, while the draft inputs and activeEditorPopup still exist.
    const affirmative = getContext().POPUP_RESULT?.AFFIRMATIVE;
    if ((editorAtStart && activeEditorPopup !== editorAtStart)
        || (popup && popup.result !== affirmative)
        || (!popup && editorAtStart && editorAtStart.result !== undefined && editorAtStart.result !== affirmative)) return false;
    if (activeEditorBaseRevision !== null && Number(activeEditorBaseRevision) !== workingCopyAdoption(originChatKey)) {
        globalThis.toastr?.warning?.('NPC State Delta: this editor was opened on an older server revision. Your typed draft is still open, but it was not applied. Review the newly loaded dossier and reopen the editor before saving.');
        return false;
    }
    const state = getChatState(originChatKey);
    const index = state.npcs.findIndex(item => item.id === npcId);
    if (index < 0) { if (close) closeNpcEditor(); return false; }
    const current = state.npcs[index];
    const beforeKeyRelationships = [...(current.keyRelationships || [])];
    const next = structuredClone(current);
    const oldRelationship = { ...(current.relationship || DEFAULT_RELATIONSHIP) };
    // (v2 meters) While hosted the inputs showed the slice's numbers; edits to them go to the slice.
    const hostedMeters = storySuiteV2Meters();
    const shownRelationship = hostedMeters ? { ...hostedMeterView([current])[0].relationship } : null;
    // A field whose control still shows the stored value is kept as stored (never re-cut or compacted).
    const untouched = untouchedEditorFields(current, editorField);
    const editorControl = key => editorField(`npc_state_delta_edit_${EDITOR_FIELDS[key].id}`);
    const editorText = key => (untouched.has(key) ? String(current[key] ?? '') : String(editorControl(key)).trim().slice(0, EDITOR_FIELDS[key].max));
    const editorList = (key, max) => (untouched.has(key) ? structuredClone(current[key] || []) : cleanEditorList(editorControl(key), max));
    const stableInputs = {
        name: editorText('name') || current.name,
        role: editorText('role'),
        species: editorText('species'),
        gender: untouched.has('gender') ? current.gender : normalizeGender(editorControl('gender')),
        homeBase: editorText('homeBase'),
        age: editorText('age'),
        apparentAge: editorText('apparentAge'),
        personality: editorText('personality'),
        speech: editorText('speech'),
        behaviorProfile: editorList('behaviorProfile', BEHAVIOR_PROFILE_LIMIT),
        background: editorText('background'),
        mannerisms: editorList('mannerisms', 8),
        keyRelationships: editorList('keyRelationships', KEY_RELATIONSHIP_LIMIT),
        customFields: customFieldEditorValues(current),
        aliases: editorList('aliases', 8),
    };
    const nameCollision = state.npcs.some((item, i) => i !== index && npcMatchesLabel(item, stableInputs.name));
    if (nameCollision) {
        globalThis.toastr?.warning?.(`NPC State Delta: another dossier already matches ${stableInputs.name}.`);
        return false;
    }
    if (stableInputs.name !== current.name && current.name) {
        stableInputs.aliases = [...new Set([...stableInputs.aliases, current.name])].slice(0, 8);
    }
    stableInputs.aliases = stableInputs.aliases.filter(alias => normalizeName(alias) !== normalizeName(stableInputs.name));
    Object.assign(next, stableInputs);
    const birthdayInput = String(editorField('npc_state_delta_edit_birthday')).trim().slice(0, 180);
    const currentBirthdayDisplay = String(current.birthDateDisplay || '').trim();
    if (birthdayInput !== currentBirthdayDisplay) {
        if (!birthdayInput) {
            globalThis.toastr?.warning?.('NPC State Delta: birthday cannot be cleared here. Enter a valid date or cancel the edit.');
            return false;
        }
        const normalizedBirthday = normalizeBirthDate(birthdayInput);
        if (!normalizedBirthday) {
            globalThis.toastr?.warning?.('NPC State Delta: birthday is not valid for the active calendar.');
            return false;
        }
        const correctedBirthday = applyNpcBirthdayUpdate(next, {
            birthDate: normalizedBirthday,
            birthDateState: 'correct',
            birthDateReason: 'Manual dossier birthday correction.',
        });
        correctedBirthday.birthDateSourceMessageId = null;
        Object.assign(next, correctedBirthday);
    }
    next.portraitPromptPositive = String(editorField('npc_state_delta_edit_portrait_positive')).trim().slice(0, PORTRAIT_NPC_PROMPT_LIMIT);
    next.portraitPromptNegative = String(editorField('npc_state_delta_edit_portrait_negative')).trim().slice(0, PORTRAIT_NPC_PROMPT_LIMIT);
    next.portraitPromptReplace = Boolean(document.getElementById('npc_state_delta_edit_portrait_replace')?.checked);
    if (stableInputs.name !== current.name) next.identityKind = inferNpcIdentityKind(stableInputs.name);
    next.relationshipSummary = editorText('relationshipSummary');
    next.mood = editorText('mood');
    next.location = editorText('location');
    next.goal = editorText('goal');
    next.status = editorText('status');
    next.memories = editorList('memories', IMPORTANT_MEMORY_LIMIT);
    next.relationship = {
        trust: clampEditorRelationshipStat('npc_state_delta_edit_trust'),
        affection: clampEditorRelationshipStat('npc_state_delta_edit_affection'),
        desire: clampEditorRelationshipStat('npc_state_delta_edit_desire'),
        tension: clampEditorRelationshipStat('npc_state_delta_edit_tension'),
    };
    let meterEdits = null;
    if (shownRelationship) {
        const edited = Object.fromEntries(Object.keys(next.relationship).filter(key => next.relationship[key] !== Number(shownRelationship[key] || 0)).map(key => [key, next.relationship[key]]));
        meterEdits = Object.keys(edited).length ? edited : null;
        next.relationship = { ...oldRelationship };
    }
    const v2Edits = hostedMeters ? hostedMeters.readEditor(id => document.getElementById(id)?.value, current) : null;
    if (v2Edits?.secrets) next.secrets = v2Edits.secrets;
    if (v2Edits && v2Edits.meterSetup !== undefined) {
        if (v2Edits.meterSetup) next.meterSetup = v2Edits.meterSetup;
        else delete next.meterSetup;
    }
    if (v2Edits?.problems?.length && !silent) globalThis.toastr?.warning?.(`NPC State Delta: ${v2Edits.problems.join('; ').slice(0, 300)}`);
    const relationshipDelta = Object.fromEntries(['trust', 'affection', 'desire', 'tension'].map(key => [key, next.relationship[key] - Number(oldRelationship[key] || 0)]));
    if (Object.values(relationshipDelta).some(value => value !== 0)) {
        const progress = normalizeRelationshipProgress(current.relationshipProgress);
        for (const key of ['trust', 'affection', 'desire', 'tension']) if (relationshipDelta[key] !== 0) progress[key] = 0;
        next.relationshipProgress = progress;
        next.relationshipMilestones = inferManualRelationshipMilestones(
            current.relationshipMilestones,
            next.relationship,
            'Manual dossier adjustment established this relationship depth.',
            latestMessageId(false),
            Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
        );
        next.lastRelationshipChange = {
            impact: 'manual',
            delta: relationshipDelta,
            evidence: normalizeRelationshipEvidence(),
            reason: 'Manual dossier adjustment by player.',
            sourceMessageId: latestMessageId(false),
            turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
            ...relationshipEventMessage({ message: latestReplyIndex() }),
        };
    }
    Object.assign(next, editorProfileLocks(current, next, { protect: Boolean(document.getElementById('npc_state_delta_edit_lock_profile')?.checked) }));
    next.retentionProtected = Boolean(document.getElementById('npc_state_delta_edit_retention_protected')?.checked);
    next.minor = Boolean(document.getElementById('npc_state_delta_edit_minor')?.checked);
    next.updatedAt = Date.now();
    state.npcs[index] = normalizeNpcRecord(next);
    // A changed relationship recalibrates the Player Dynamic even when its text was not edited.
    const relationshipMoved = Object.values(relationshipDelta).some(value => value !== 0);
    const shortened = settleEditorSave(state.npcs[index], current, next, untouched, {
        keepVerbatim: key => key !== 'relationshipSummary' || !relationshipMoved,
    });
    const manualMemories = editorManualMemories(current, state.npcs[index], untouched);
    if (manualMemories.length) state.npcs[index].manualMemories = manualMemories;
    else delete state.npcs[index].manualMemories;
    stampManualEdit(state, state.npcs[index], current);
    if (next.lastRelationshipChange?.impact === 'manual') state.npcs[index].lastRelationshipChange = structuredClone(next.lastRelationshipChange);
    const targetMessageId = latestMessageId(false);
    applyManualKeyRelationshipEdit(state, npcId, beforeKeyRelationships, state.npcs[index].keyRelationships || [], {
        sourceMessageId: targetMessageId,
        turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
    });
    const reconciledSocial = reconcileSocialState(state, {
        provenance: 'manual', confidence: 'manual', sourceMessageId: targetMessageId,
        turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
    });
    state.socialGraph = reconciledSocial.socialGraph;
    state.npcs = reconciledSocial.state.npcs;
    if (targetMessageId >= 0) commitBranchCheckpoint(state, targetMessageId, 'manual-edit');
    renderDossier();
    updateInjection();
    // Report success only once the edit is on the server. A failed write keeps the editor open
    // with the draft; the edit stays applied in this browser and the pending write is retried.
    const savedName = state.npcs[index].name;
    if (!await persistCriticalDurable(originChatKey)) {
        if (!silent) globalThis.toastr?.warning?.(`NPC State Delta: the edits for ${savedName} are applied in this browser but could not be saved to the server yet. Save again to retry.`);
        return false;
    }
    if (hostedMeters && (meterEdits || v2Edits)) {
        if (meterEdits) await hostedMeters.setMeters({ name: current.name, meters: meterEdits });
        if (v2Edits) await hostedMeters.applyEditor(savedName, v2Edits);
        updateInjection();
    }
    if (close) closeNpcEditor();
    if (!silent) globalThis.toastr?.success?.(`NPC State Delta: saved manual dossier edits for ${savedName}.`);
    if (!silent && shortened.length) globalThis.toastr?.warning?.(`NPC State Delta: ${shortened.join(', ')} ${shortened.length === 1 ? 'was' : 'were'} shortened or adjusted to fit the dossier's limits for unprotected fields. Tick "Protect edited stable profile fields" to keep a longer Personality, Speech, Background or Mannerisms.`);
    return true;
}


function updateNpcAppearance(npcId, draft, { chatKey, lockAppearance = false } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('edit appearance forms', chatKey)) return false;
    // The appearance draft lives in the dossier editor; like its main Save, it must not overwrite a
    // newer server copy adopted after the editor opened.
    if (editorIsMounted() && activeEditorChatKey === chatKey && activeEditorBaseRevision !== null
        && Number(activeEditorBaseRevision) !== workingCopyAdoption(chatKey)) {
        globalThis.toastr?.warning?.('NPC State Delta: this editor was opened on an older server revision. The appearance draft was not applied; review the newly loaded dossier and reopen the editor.');
        return false;
    }
    const state = getChatState(chatKey);
    const index = state.npcs.findIndex(item => item.id === String(npcId || ''));
    if (index < 0) return false;
    const before = state.npcs[index];
    const next = appearanceDraftRecord(before, draft, { lockAppearance });
    // The appearance lock comes from the editor's protect checkbox: the reader's explicit choice.
    next.manualProfileLocksExplicit = true;
    next.updatedAt = Date.now();
    state.npcs[index] = stampManualEdit(state, normalizeNpcRecord(next), before);
    const messageId = latestMessageId(false);
    if (messageId >= 0) commitBranchCheckpoint(state, messageId, 'manual-edit');
    persistCritical(chatKey);
    renderDossier();
    updateInjection();
    return true;
}

function updateNpcLifeState(npcId, choice, { chatKey } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !['alive', 'unknown', 'deceased'].includes(choice)
        || !requireReadyChatMutation('edit life state', chatKey)) return false;
    const state = getChatState(chatKey);
    const index = state.npcs.findIndex(npc => npc.id === String(npcId || ''));
    if (index < 0) return false;
    const current = state.npcs[index];
    const correctingDeath = isTerminalNpcDeath(current) && choice !== 'deceased';
    const messageId = latestMessageId(false);
    const corrected = correctingDeath ? setNpcArchived(current, false, {
        allowDeathCorrection: true, sourceMessageId: messageId,
    }) : current;
    state.npcs[index] = stampManualEdit(state, normalizeNpcRecord(manualLifeStateRecord(corrected, choice)), current);
    if (messageId >= 0) commitBranchCheckpoint(state, messageId, correctingDeath ? 'manual-death-correction' : 'manual-life-state');
    persistCritical(chatKey);
    renderDossier();
    updateInjection();
    return true;
}

const portraitActions = new Map();
function portraitAction(chatKey, npcId) {
    const key = `${chatKey}::${npcId}`;
    const action = {};
    portraitActions.set(key, action);
    return { key, action };
}

function npcFormName(npc, form) {
    const key = formPortraitKey(form);
    if (!key) return '';
    return (Array.isArray(npc?.appearanceForms) ? npc.appearanceForms : []).find(item => formPortraitKey(item?.name) === key)?.name || '';
}

async function setNpcPortrait(npcId, file, { chatKey, isCurrent = () => true, generatedFrom = '', form = '' } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !isCurrent() || !await ensureFreshMutationBoundary('attach a portrait', chatKey)) return false;
    const originCanonicalRevision = hydratedRevision(chatKey);
    const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
    if (!npc || !file) return false;
    const targetForm = form ? npcFormName(npc, form) : '';
    if (form && !targetForm) throw new Error(`${npc.name} has no appearance form named "${form}".`);
    if (!/^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i.test(String(file.type || '')) || file.size > 16 * 1024 * 1024) {
        throw new Error('Choose a PNG, JPEG, WebP, GIF, AVIF or BMP image no larger than 16 MB.');
    }
    const originChatKey = chatKey;
    const originRevision = Number(stateVersions.get(originChatKey) || 0);
    const epoch = ownershipEpoch(chatKey);
    const { key, action } = portraitAction(chatKey, npc.id);
    try {
        const portrait = await compressPortrait(file);
        try { await ensureHydratedStateFresh(chatKey, { reason: 'portrait-commit' }); } catch { return false; }
        if (portraitActions.get(key) !== action || !isCurrent() || getChatKey() !== chatKey
            || !ownershipEpochCurrent(chatKey, epoch) || Number(stateVersions.get(chatKey) || 0) !== originRevision
            || hydratedRevision(chatKey) !== originCanonicalRevision
            || !requireReadyChatMutation('attach a portrait', chatKey)) {
            recordFreshnessEvent(chatKey, 'stale-operation-rejected', {
                reason: 'portrait-commit',
                hydratedRevision: originCanonicalRevision,
                serverRevision: hydratedStateMeta.get(chatKey)?.latestObservedServerRevision ?? hydratedRevision(chatKey),
                dirty: false,
            });
            return false;
        }
        const live = getChatState(chatKey).npcs.find(item => item.id === npc.id);
        if (!live) return false;
        if (generatedFrom) portrait.generatedFrom = String(generatedFrom);
        if (targetForm) {
            // A form portrait is an extra user-owned asset for that named form; the main portrait
            // and the canonical dossier record are left unchanged.
            const liveForm = npcFormName(live, targetForm);
            if (!liveForm) return false;
            const fingerprint = appearanceFingerprint(live, { form: liveForm });
            if (fingerprint) portrait.appearanceFingerprint = fingerprint;
            portrait.appearanceForm = liveForm;
            portrait.form = liveForm;
            const state = getChatState(chatKey);
            state.formPortraitAssets = normalizeFormPortraitAssets(state.formPortraitAssets);
            const forms = { ...(state.formPortraitAssets[live.id] || {}) };
            const key = formPortraitKey(liveForm);
            if (!forms[key] && Object.keys(forms).length >= 8) {
                // Images for forms that were renamed or removed from this dossier give way first.
                for (const existing of Object.keys(forms)) if (!npcFormName(live, forms[existing]?.form || existing)) delete forms[existing];
            }
            if (!forms[key] && Object.keys(forms).length >= 8) throw new Error('Each NPC can keep at most 8 form portraits.');
            forms[key] = portrait;
            state.formPortraitAssets[live.id] = forms;
            persistCritical(chatKey);
            renderDossier();
            return true;
        }
        const fingerprint = appearanceFingerprint(live);
        if (fingerprint) portrait.appearanceFingerprint = fingerprint;
        portrait.appearanceForm = String(live.currentForm || '').slice(0, 120);
        live.portrait = portrait;
        getChatState(chatKey).portraitAssets[live.id] = structuredClone(portrait);
        live.updatedAt = Date.now();
        persistCritical(chatKey);
        renderDossier();
        return true;
    } finally {
        if (portraitActions.get(key) === action) portraitActions.delete(key);
    }
}

function setNpcPortraitSeed(npcId, seed, { chatKey, isCurrent = () => true } = {}) {
    // Runs after the freshness wait: a workflow the user closed meanwhile must not still mutate.
    if (!isCurrent()) return false;
    if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('edit portrait seed', chatKey)) return false;
    const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
    if (!npc) return false;
    const raw = seed === null || seed === undefined ? '' : String(seed).trim();
    const normalized = normalizePortraitSeed(seed);
    if (raw && normalized === null) throw new Error('Portrait seed must be a whole number from 0 to 9007199254740991, or blank for SillyTavern default/random behavior.');
    npc.portraitSeed = normalized;
    npc.updatedAt = Date.now();
    persistCritical(chatKey);
    renderDossier();
    return true;
}

function removeNpcPortrait(npcId, { chatKey, form = '' } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('remove a portrait', chatKey)) return false;
    const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
    if (!npc) return false;
    // Invalidate a prior decode even when there was no portrait to remove yet.
    portraitActions.delete(`${chatKey}::${npc.id}`);
    if (form) {
        const state = getChatState(chatKey);
        const key = formPortraitKey(form);
        const forms = { ...(state.formPortraitAssets?.[npc.id] || {}) };
        if (!key || !forms[key]) return false;
        delete forms[key];
        if (Object.keys(forms).length) state.formPortraitAssets[npc.id] = forms;
        else delete state.formPortraitAssets[npc.id];
        persistCritical(chatKey);
        renderDossier();
        return true;
    }
    npc.portrait = null;
    delete getChatState(chatKey).portraitAssets[npc.id];
    npc.updatedAt = Date.now();
    persistCritical(chatKey);
    renderDossier();
    return true;
}

function deleteNpcById(npcId, { confirmAction = true } = {}) {
    const id = String(npcId || '').trim();
    if (!id || !requireReadyChatMutation('delete a dossier')) return false;
    const settings = getSettings();
    const state = getChatState();
    const current = state.npcs.find(item => item.id === id);
    if (!current) return false;
    if (confirmAction) {
        const message = `Delete ${current.name}? This permanently removes this dossier and prevents older branch snapshots from restoring this identity. A genuinely different future NPC with the same name remains trackable.`;
        if (!window.confirm(message)) return false;
    }

    const result = applyNpcStateCommand(state, { action: 'remove', name: current.name, npcId: id }, {
        maxNpcs: settings.maxNpcs,
        excludeNames: currentExclusions(),
        turn: state.turn,
        relationshipBaseline: settings.relationshipBaseline,
    });
    const working = result.state;
    if (result.report.status !== 'removed') return false;
    // The shared add/remove helper suppresses by label. Manual UI trash is
    // identity-specific instead: remove those labels from narrative dismissal and retain an
    // ID-backed tombstone so a future homonym is not blocked.
    const permanentLabels = new Set([current.name, ...(current.aliases || [])].map(normalizeName).filter(Boolean));
    working.dismissed = (Array.isArray(working.dismissed) ? working.dismissed : [])
        .filter(label => !permanentLabels.has(normalizeName(label)));
    working.userDismissedGroups = addUserDismissedGroup(state.userDismissedGroups, current);
    working.socialGraph = removeNpcFromSocialGraph(working.socialGraph, current.id);
    purgeNpcStructuredReferences(working.npcs, current);
    const socialAfterDelete = reconcileSocialState(working, { provenance: 'manual', confidence: 'manual' });
    working.socialGraph = socialAfterDelete.socialGraph;
    working.npcs = socialAfterDelete.state.npcs;
    purgeInlineCardsInState(working, result.report.npcId, result.report.name);
    const reportKey = normalizeName(result.report.name);
    working.pendingBackfills = (working.pendingBackfills || []).filter(item => item.npcId !== result.report.npcId && normalizeName(item.label) !== reportKey);
    if (working.portraitAssets && typeof working.portraitAssets === 'object') delete working.portraitAssets[current.id];
    if (working.formPortraitAssets && typeof working.formPortraitAssets === 'object') delete working.formPortraitAssets[current.id];
    const targetMessageId = latestMessageId(false);
    if (targetMessageId >= 0) commitBranchCheckpoint(working, targetMessageId, 'manual-delete');
    const deleteKey = getChatKey();
    setChatState(deleteKey, working);
    closeNpcEditor();
    renderDossier();
    updateInjection();
    // The deletion is applied now; completion is announced only once the server holds it.
    reportDurableOutcome(deleteKey,
        `NPC State Delta: deleted ${result.report.name}; older branch snapshots cannot restore that identity.`,
        `NPC State Delta: ${result.report.name} was removed in this browser, but the deletion could not be saved to the server yet. It will be retried; the server copy still contains the dossier until then.`);
    return true;
}

// Announce a manual lifecycle change only after its sidecar write completes, and say plainly when
// it is applied locally but not yet on the server (the pending write keeps retrying/recovering).
function reportDurableOutcome(key, successMessage, pendingMessage) {
    void persistCriticalDurable(key).then(saved => {
        if (saved) globalThis.toastr?.success?.(successMessage);
        else globalThis.toastr?.warning?.(pendingMessage);
    });
}

function setNpcArchiveStateById(npcId, archived, { reason = 'manual', confirmAction = true } = {}) {
    if (!requireReadyChatMutation(archived ? 'archive a dossier' : 'restore a dossier')) return false;
    const state = getChatState();
    const index = state.npcs.findIndex(item => item.id === npcId);
    if (index < 0) return false;
    const current = state.npcs[index];
    const correctingDeath = !archived && isTerminalNpcDeath(current);
    if (Boolean(current.archived) === Boolean(archived) && !correctingDeath) return false;
    if (confirmAction) {
        const message = archived
            ? `Archive ${current.name}? The dossier, portrait, history, and relationship state will be preserved, but it will stop receiving inline cards and prompt injection until restored or clearly returned in the story.`
            : (correctingDeath
                ? `Correct ${current.name}'s death record as erroneous? This is a manual correction, not narrative resurrection. The NPC will remain off-screen until new evidence establishes presence.`
                : `Restore ${current.name} to the active roster?`);
        if (!window.confirm(message)) return false;
    }
    state.npcs[index] = setNpcArchived(current, archived, {
        reason: archived ? reason : '',
        allowDeathCorrection: correctingDeath,
        sourceMessageId: latestMessageId(false),
    });
    const targetMessageId = latestMessageId(false);
    if (targetMessageId >= 0) commitBranchCheckpoint(state, targetMessageId, archived ? 'manual-archive' : (correctingDeath ? 'manual-death-correction' : 'manual-restore'));
    closeNpcEditor();
    renderDossier();
    updateInjection();
    reportDurableOutcome(getChatKey(),
        archived
            ? `NPC State Delta: archived ${current.name}. Their dossier and history are preserved.`
            : (correctingDeath ? `NPC State Delta: corrected ${current.name}'s erroneous death record; presence remains unconfirmed.` : `NPC State Delta: restored ${current.name} to the active roster.`),
        `NPC State Delta: the change to ${current.name} is applied in this browser but could not be saved to the server yet. It will be retried; the server copy is unchanged until then.`);
    return true;
}

async function compressPortrait(file) {
    if (!file || !file.type?.startsWith('image/')) throw new Error('Choose an image file.');
    const source = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read image.'));
        reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode image.'));
        img.src = source;
    });
    if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) throw new Error('Could not decode image dimensions.');
    // Keep enough source resolution for the full-screen dossier viewer and high-DPI mobile/tablet displays.
    // The old 512 px cap looked acceptable in roster thumbnails but became visibly pixelated when expanded.
    const maxSide = 1536;
    const maxDataUrlLength = 1_600_000;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Image processing is unavailable in this browser.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const encode = quality => {
        let value = canvas.toDataURL('image/webp', quality);
        if (!value.startsWith('data:image/webp')) value = canvas.toDataURL('image/jpeg', quality);
        return value;
    };

    let dataUrl = encode(0.88);
    // Prefer preserving pixels. Only lower quality if an unusually complex portrait exceeds the bounded state-file budget.
    for (const quality of [0.84, 0.80, 0.76, 0.72, 0.68]) {
        if (dataUrl.length <= maxDataUrlLength) break;
        dataUrl = encode(quality);
    }
    if (dataUrl.length > maxDataUrlLength) {
        throw new Error('Portrait is still too large after high-resolution compression. Try a smaller image.');
    }
    return {
        dataUrl,
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        sourceName: file.name,
        width: canvas.width,
        height: canvas.height,
        updatedAt: Date.now(),
    };
}

function safeFilenamePart(value) {
    return String(value || 'chat')
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'chat';
}

function exportBundleBytes() {
    if (!requireReadyChatMutation('export a dossier', getChatKey(), { notify: false })) throw new Error('NPC State Delta chat dossier is not loaded.');
    return encodeNpcStateBundle(getChatState(), {
        appVersion: NPC_STATE_VERSION,
        chatKey: getChatKey(),
    });
}

function importBundleBytes(bytes) {
    if (!requireReadyChatMutation('import a dossier')) throw new Error('NPC State Delta chat dossier is not loaded.');
    const settings = getSettings();
    const decoded = decodeDeltaNativeBundle(bytes);
    const targetChatKey = getChatKey();
    const foreignOwnership = decoded.metadata.sourceChatKey !== targetChatKey;
    decoded.state = nativeStateForTarget(decoded, targetChatKey);
    const before = getChatState();
    const importReport = {};
    const merged = mergeImportedDossierState(before, decoded.state, {
        maxNpcs: settings.maxNpcs,
        excludeNames: currentExclusions(),
        report: importReport,
        foreignOwnership,
    });
    // Only an actually accepted import can deliberately resurrect an ID-backed deleted
    // identity. Capacity/exclusion/duplicate skips must not weaken tombstones.
    for (const accepted of importReport.accepted || []) {
        clearUserDismissedSuppression(merged, { id: accepted.id, name: accepted.name });
    }
    if (!merged.portraitAssets || typeof merged.portraitAssets !== 'object') merged.portraitAssets = {};
    for (const npc of merged.npcs) if (npc.portrait?.dataUrl) merged.portraitAssets[npc.id] = structuredClone(npc.portrait);
    // (timeline participant) A chat with no story line yet takes the bundle's (its dossiers keep their np_ ids); one that has its own keeps it.
    // A bundle from another chat is a copy of the story, not the same line of it: it keeps its np_ ids and gets a lineage of its own (the participant makes it).
    if (!before.timeline?.lineage && decoded.state.timeline && typeof decoded.state.timeline === 'object') {
        merged.timeline = structuredClone(decoded.state.timeline);
        if (foreignOwnership) merged.timeline.lineage = null;
    }
    const socialImport = reconcileSocialState(merged, { provenance: 'migration', confidence: 'migration' });
    merged.socialGraph = socialImport.socialGraph;
    merged.npcs = socialImport.state.npcs;
    const targetMessageId = latestMessageId(false);
    if (targetMessageId >= 0) commitBranchCheckpoint(merged, targetMessageId, 'import');
    setChatState(getChatKey(), merged);
    persistCritical();
    renderDossier();
    updateInjection();
    return { decoded, merged, importReport };
}

function portraitThemeLabel(source = getSettings()) {
    const snapshot = portraitSettingsSnapshot(source);
    if (snapshot.portraitThemePreset === 'custom') {
        const preset = snapshot.portraitCustomPresets.find(item => item.id === snapshot.portraitCustomPresetId);
        return preset?.name ? `Custom · ${preset.name}` : 'Custom Library';
    }
    return PORTRAIT_THEME_PRESETS[snapshot.portraitThemePreset]?.label || 'Custom Library';
}

function portraitSettingsSnapshot(source = getSettings()) {
    const customPresets = portraitCustomPresetLibrary(source.portraitCustomPresets);
    const customPresetId = customPresets.some(item => item.id === source.portraitCustomPresetId)
        ? source.portraitCustomPresetId
        : customPresets[0].id;
    const customPreset = customPresets.find(item => item.id === customPresetId) || customPresets[0];
    const theme = PORTRAIT_THEME_PRESETS[source.portraitThemePreset] ? source.portraitThemePreset : 'custom';
    const builtIn = theme !== 'custom' ? PORTRAIT_THEME_PRESETS[theme] : null;
    return {
        portraitGenerationEnabled: source.portraitGenerationEnabled !== false,
        portraitThemePreset: theme,
        portraitCustomPresetId: customPresetId,
        portraitCustomPresets: structuredClone(customPresets),
        portraitStylePositive: theme === 'custom'
            ? customPreset.positive
            : String(builtIn?.positive ?? source.portraitStylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitStyleNegative: theme === 'custom'
            ? customPreset.negative
            : String(builtIn?.negative ?? source.portraitStyleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitComposition: theme === 'custom'
            ? customPreset.composition
            : String(source.portraitComposition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
        portraitPromptFormat: theme === 'custom'
            ? customPreset.promptFormat
            : normalizePortraitPromptFormat(source.portraitPromptFormat),
        portraitUseMood: theme === 'custom' ? customPreset.useMood : source.portraitUseMood !== false,
        portraitUseLocation: theme === 'custom' ? customPreset.useLocation : source.portraitUseLocation === true,
        portraitSaveToGallery: source.portraitSaveToGallery === true,
    };
}

function normalizePortraitSettingsDraft(raw = {}) {
    const settings = getSettings();
    const current = portraitSettingsSnapshot(settings);
    const key = PORTRAIT_THEME_PRESETS[raw.portraitThemePreset]
        ? raw.portraitThemePreset
        : (raw.portraitThemePreset === 'custom' ? 'custom' : current.portraitThemePreset);
    const presets = portraitCustomPresetLibrary(raw.portraitCustomPresets ?? current.portraitCustomPresets);
    const requestedId = String((raw.portraitCustomPresetId ?? current.portraitCustomPresetId) || '').trim();
    const customPresetId = presets.some(item => item.id === requestedId) ? requestedId : presets[0].id;
    const preset = PORTRAIT_THEME_PRESETS[key];
    const next = {
        portraitGenerationEnabled: raw.portraitGenerationEnabled !== undefined ? Boolean(raw.portraitGenerationEnabled) : current.portraitGenerationEnabled,
        portraitThemePreset: key,
        portraitCustomPresetId: customPresetId,
        portraitCustomPresets: structuredClone(presets),
        portraitStylePositive: String(raw.portraitStylePositive ?? current.portraitStylePositive).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitStyleNegative: String(raw.portraitStyleNegative ?? current.portraitStyleNegative).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitComposition: String(raw.portraitComposition ?? current.portraitComposition).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
        portraitPromptFormat: normalizePortraitPromptFormat(raw.portraitPromptFormat ?? current.portraitPromptFormat),
        portraitUseMood: raw.portraitUseMood !== undefined ? Boolean(raw.portraitUseMood) : current.portraitUseMood,
        portraitUseLocation: raw.portraitUseLocation !== undefined ? Boolean(raw.portraitUseLocation) : current.portraitUseLocation,
        portraitSaveToGallery: raw.portraitSaveToGallery !== undefined ? Boolean(raw.portraitSaveToGallery) : current.portraitSaveToGallery,
    };
    if (key !== 'custom' && preset) {
        next.portraitStylePositive = preset.positive;
        next.portraitStyleNegative = preset.negative;
    } else {
        const index = next.portraitCustomPresets.findIndex(item => item.id === customPresetId);
        if (index >= 0) {
            next.portraitCustomPresets[index] = portraitCustomPreset({
                ...next.portraitCustomPresets[index],
                positive: next.portraitStylePositive,
                negative: next.portraitStyleNegative,
                composition: next.portraitComposition,
                promptFormat: next.portraitPromptFormat,
                useMood: next.portraitUseMood,
                useLocation: next.portraitUseLocation,
            }, index);
        }
    }
    return next;
}

function portraitSettingsDraftFromUi() {
    const settings = getSettings();
    return normalizePortraitSettingsDraft({
        portraitGenerationEnabled: $('#npc_state_delta_portrait_generation_enabled').prop('checked'),
        portraitThemePreset: String($('#npc_state_delta_portrait_theme_preset').val() || 'custom'),
        portraitCustomPresetId: String($('#npc_state_delta_portrait_custom_preset').val() || settings.portraitCustomPresetId || ''),
        portraitCustomPresets: settings.portraitCustomPresets,
        portraitStylePositive: String($('#npc_state_delta_portrait_style_positive').val() || ''),
        portraitStyleNegative: String($('#npc_state_delta_portrait_style_negative').val() || ''),
        portraitComposition: String($('#npc_state_delta_portrait_composition').val() || ''),
        portraitPromptFormat: String($('#npc_state_delta_portrait_prompt_format').val() || 'hybrid'),
        portraitUseMood: $('#npc_state_delta_portrait_use_mood').prop('checked'),
        portraitUseLocation: $('#npc_state_delta_portrait_use_location').prop('checked'),
        portraitSaveToGallery: $('#npc_state_delta_portrait_save_gallery').prop('checked'),
    });
}

function writePortraitCustomPresetOptions(snapshot) {
    const control = $('#npc_state_delta_portrait_custom_preset');
    if (!control.length) return;
    const html = snapshot.portraitCustomPresets
        .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    if (control.html() !== html) control.html(html);
    control.val(snapshot.portraitCustomPresetId);
    $('#npc_state_delta_portrait_custom_preset_count').text(`${snapshot.portraitCustomPresets.length}/${PORTRAIT_CUSTOM_PRESET_LIMIT} saved`);
}

function writePortraitSettingsDraftToUi(draft) {
    const next = normalizePortraitSettingsDraft(draft);
    $('#npc_state_delta_portrait_generation_enabled').prop('checked', next.portraitGenerationEnabled);
    $('#npc_state_delta_portrait_theme_preset').val(next.portraitThemePreset);
    writePortraitCustomPresetOptions(next);
    $('#npc_state_delta_portrait_style_positive').val(next.portraitStylePositive);
    $('#npc_state_delta_portrait_style_negative').val(next.portraitStyleNegative);
    $('#npc_state_delta_portrait_composition').val(next.portraitComposition);
    $('#npc_state_delta_portrait_prompt_format').val(next.portraitPromptFormat);
    $('#npc_state_delta_portrait_use_mood').prop('checked', next.portraitUseMood);
    $('#npc_state_delta_portrait_use_location').prop('checked', next.portraitUseLocation);
    $('#npc_state_delta_portrait_save_gallery').prop('checked', next.portraitSaveToGallery);
    $('.npc-state-delta-custom-preset-library').toggleClass('delta-custom-active', next.portraitThemePreset === 'custom');
    return next;
}

function confirmDiscardPortraitDraft() {
    if (!portraitSettingsDirty) return true;
    return globalThis.window?.confirm?.('Discard unsaved portrait preset edits and switch?') !== false;
}

function updatePortraitSettingsSaveUi() {
    const button = $('#npc_state_delta_save_portrait_settings');
    const status = $('#npc_state_delta_portrait_settings_status');
    button.toggleClass?.('npc-state-delta-busy', portraitSettingsSaveBusy);
    button.prop?.('disabled', portraitSettingsSaveBusy);
    if (portraitSettingsSaveBusy) status.text?.('Saving…');
    else if (portraitSettingsDirty) status.text?.('Unsaved changes');
    else status.text?.('Saved');
}

function markPortraitSettingsDirty() {
    portraitSettingsDirty = true;
    updatePortraitSettingsSaveUi();
}

async function savePortraitSettingsDraft(explicitDraft = null) {
    if (portraitSettingsSaveBusy) return false;
    const settings = getSettings();
    const before = portraitSettingsSnapshot(settings);
    const next = normalizePortraitSettingsDraft(explicitDraft || portraitSettingsDraftFromUi());
    Object.assign(settings, next);
    portraitSettingsSaveBusy = true;
    updatePortraitSettingsSaveUi();
    try {
        await saveHostSettings();
        portraitSettingsDirty = false;
        portraitSettingsSaveBusy = false;
        syncSettingsControls();
        globalThis.toastr?.success?.(next.portraitThemePreset === 'custom'
            ? `NPC State Delta: saved custom portrait preset ${portraitCustomPresetFor(next).name}.`
            : 'NPC State Delta: portrait settings saved.');
        return true;
    } catch (error) {
        Object.assign(settings, before);
        portraitSettingsSaveBusy = false;
        portraitSettingsDirty = true;
        updatePortraitSettingsSaveUi();
        console.error('[NPC State Delta] portrait settings save failed', error);
        globalThis.toastr?.error?.(`NPC State Delta portrait settings were not saved: ${error?.message || error}`);
        return false;
    }
}

async function persistPortraitCustomPresetLibrary(settings, presets, selectedId, { theme = 'custom', operational = null } = {}) {
    if (portraitSettingsSaveBusy) return null;
    const before = {
        portraitGenerationEnabled: settings.portraitGenerationEnabled,
        portraitThemePreset: settings.portraitThemePreset,
        portraitCustomPresetId: settings.portraitCustomPresetId,
        portraitCustomPresets: structuredClone(settings.portraitCustomPresets),
        portraitStylePositive: settings.portraitStylePositive,
        portraitStyleNegative: settings.portraitStyleNegative,
        portraitComposition: settings.portraitComposition,
        portraitPromptFormat: settings.portraitPromptFormat,
        portraitUseMood: settings.portraitUseMood,
        portraitUseLocation: settings.portraitUseLocation,
        portraitSaveToGallery: settings.portraitSaveToGallery,
    };
    const normalized = portraitCustomPresetLibrary(presets, settings);
    const id = normalized.some(item => item.id === selectedId) ? selectedId : normalized[0].id;
    settings.portraitCustomPresets = normalized;
    settings.portraitCustomPresetId = id;
    settings.portraitThemePreset = theme;
    if (theme === 'custom') {
        const active = normalized.find(item => item.id === id) || normalized[0];
        settings.portraitStylePositive = active.positive;
        settings.portraitStyleNegative = active.negative;
        settings.portraitComposition = active.composition;
        settings.portraitPromptFormat = active.promptFormat;
        settings.portraitUseMood = active.useMood;
        settings.portraitUseLocation = active.useLocation;
    }
    if (operational) {
        settings.portraitGenerationEnabled = operational.portraitGenerationEnabled !== false;
        settings.portraitSaveToGallery = operational.portraitSaveToGallery === true;
    }
    portraitSettingsSaveBusy = true;
    updatePortraitSettingsSaveUi();
    try {
        await saveHostSettings();
        portraitSettingsDirty = false;
        portraitSettingsSaveBusy = false;
        syncSettingsControls();
        return portraitSettingsSnapshot(settings);
    } catch (error) {
        Object.assign(settings, before);
        portraitSettingsSaveBusy = false;
        portraitSettingsDirty = true;
        updatePortraitSettingsSaveUi();
        console.error('[NPC State Delta] custom portrait preset save failed', error);
        globalThis.toastr?.error?.(`NPC State Delta custom portrait preset was not saved: ${error?.message || error}`);
        return null;
    }
}

function bindSettingsCheckbox(selector, key, after = null) {
    $(document).on('change.npcStateDelta', selector, function () {
        getSettings()[key] = Boolean(this.checked);
        persistSettings();
        after?.();
    });
}

function bindCustomFieldSettings() {
    $(document).on('change.npcStateDelta', '#npc_state_delta_custom_fields', function () {
        const names = normalizeCustomFieldNames(this.value);
        getSettings().customFieldNames = names;
        this.value = names.join(', ');
        persistSettings();
        syncSuiteControls();
        updateInjection();
    });
}

// Story Suite (docs/STORY_SUITE.md): Delta announces itself (with `enabled: false` while switched
// off, so Story Suite's overlay can switch it back on) and asks who owns the scene, calendar and
// stats. Alone it owns all four areas, so nothing below changes Delta.
const SUITE_API = Object.freeze({
    /** The current chat's tracked NPCs (copies; empty until the chat's dossiers load). */
    npcs: () => {
        const key = getChatKey();
        if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return [];
        return scenePresenceView(getChatState(key).npcs || []).map(npc => ({
            id: String(npc?.id || ''),
            name: String(npc?.name || ''),
            aliases: [...(npc?.aliases || [])],
            present: Boolean(npc?.present && !npc?.archived),
            archived: Boolean(npc?.archived),
        }));
    },
    /** The tracked, non-archived, not-deceased NPCs' { id, name, aliases, present, role, summary } (frozen copies; empty until the chat's dossiers load). */
    npcProfiles: () => {
        try {
            const key = getChatKey();
            if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return Object.freeze([]);
            return buildNpcProfiles(getChatState(key).npcs, { customFieldNames: getSettings().customFieldNames });
        } catch (error) {
            console.warn('[NPC State Delta] Story Suite NPC profiles failed', error);
            return Object.freeze([]);
        }
    },
    /** Open Delta's dossier view on one NPC (id, or name/alias fallback), as the launcher and present cast do; false when archived, unknown or not opened. */
    openDossier: value => {
        try {
            const key = getChatKey();
            if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
            const id = resolveDossierTarget(getChatState(key).npcs, value);
            return id ? openLauncherDossier(id) === true : false;
        } catch (error) {
            console.warn('[NPC State Delta] Story Suite openDossier failed', error);
            return false;
        }
    },
    /** For Story Suite's overlay: the same actions as Delta's own Source of truth selects and Enable checkbox. */
    manage: buildManageApi({
        sources: () => getSettings().sourceOfTruth,
        setSource: (area, choice) => applySourceOfTruth(area, choice),
        enabled: () => getSettings().enabled !== false,
        setEnabled: on => applyEnabled(on),
        tokens: () => nextReplyTokens(),
        preview: () => nextReplyTexts(),
    }),
});
let suiteConnected = false;
let suiteRefreshQueued = false;

// What Delta adds to the next ordinary reply, estimated at about four characters a token: the
// live dossier injection and, with one-pass capture on, its instruction (input) and the block the
// model is asked to write back (output). Scans and other quiet requests are not counted.
// (1.2.13) The texts the next ordinary reply gets, for tokens() and preview(): { injection, capture }.
function nextReplyTexts() {
    const settings = getSettings();
    const key = getChatKey();
    if (settings.enabled === false || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return { injection: '', capture: '' };
    const state = getChatState(key);
    const transcript = recentTranscript(4);
    const injection = settings.inject ? liveInjectionText(state, settings, { transcript }) : '';
    const capture = narrationCaptureEnabled(settings)
        ? buildNarrationCapturePrompt(scannerPromptOptions(state, settings, transcript, { dossierAbove: injection }))
        : '';
    return { injection, capture };
}

function nextReplyTokens() {
    const { injection, capture } = nextReplyTexts();
    if (!injection && !capture) return replyTokenEstimate();
    return replyTokenEstimate({
        injection,
        captureChars: capture.length,
        captureOutputChars: capture ? (lastCaptureBlockChars || NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS) : 0,
    });
}

// The panel's Add NPC and (1.2.13) the Dossiers tab's: ask a name, add a dossier for it.
async function addNpcManually() {
    if (!await ensureFreshMutationBoundary('add an NPC')) return;
    const settings = getSettings();
    const state = getChatState();
    if (state.npcs.filter(npc => !npc?.archived).length >= settings.maxNpcs) return globalThis.toastr?.warning?.(`NPC State Delta: active roster cap is ${settings.maxNpcs}. Archived dossiers do not count.`);
    const name = window.prompt('NPC name to add to this chat dossier:')?.trim();
    if (!name) return;
    const result = applyNpcStateCommand(state, { action: 'add', name }, {
        maxNpcs: settings.maxNpcs,
        excludeNames: currentExclusions(),
        turn: state.turn,
        relationshipBaseline: settings.relationshipBaseline,
    });
    if (result.report.status === 'excluded') return globalThis.toastr?.warning?.('NPC State Delta: player/main character cannot be added as an NPC.');
    if (result.report.status === 'full') return globalThis.toastr?.warning?.(`NPC State Delta: active roster cap is ${settings.maxNpcs}. Archived dossiers do not count.`);
    if (['added', 'exists', 'restored'].includes(result.report.status)) clearUserDismissedSuppression(result.state, name);
    const targetMessageId = latestMessageId(false);
    if (targetMessageId >= 0) commitBranchCheckpoint(result.state, targetMessageId, 'manual-add');
    setChatState(getChatKey(), result.state);
    persistCritical(); renderDossier(); updateInjection();
    const addedNpc = result.report.npcId ? result.state.npcs.find(npc => npc.id === result.report.npcId) : null;
    if (addedNpc) globalThis.toastr?.success?.(`NPC State Delta: ${addedNpc.name} created. Use the wand beside the dossier to Scan dossier and populate it.`);
}

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
    if (latest >= 0 && state.lastScannedMessageId !== latest) {
        return { text: 'The latest reply has not been scanned yet, so who is present is not known.', scan: true };
    }
    return { text: 'The latest scan found no NPC in the scene.', scan: true };
}

// (1.2.13) The "What's sent" fold: each part the next ordinary reply gets, with its size, as text.
function renderWhatsSent() {
    const root = globalThis.document?.querySelector?.('[data-delta-whats-sent]');
    if (!root) return;
    const { parts } = SUITE_API.manage.preview();
    root.replaceChildren();
    if (!parts.length) {
        const empty = document.createElement('small');
        empty.className = 'delta-whats-sent-empty';
        empty.textContent = 'Nothing is sent with the next reply (no present NPC, or injection and one-pass capture are off).';
        root.append(empty);
        return;
    }
    for (const part of parts) {
        const head = document.createElement('div');
        head.className = 'delta-whats-sent-head';
        head.textContent = `${part.label} · about ${part.tokens} tokens`;
        const body = document.createElement('pre');
        body.className = 'delta-whats-sent-text';
        body.textContent = part.text;
        root.append(head, body);
    }
}

function announceToSuite() {
    announceNpcStateDelta({ enabled: getSettings().enabled !== false, version: NPC_STATE_VERSION, api: SUITE_API, settings: `#${UI_ID}`, shows: SUITE_SHOWS });
}

// What the Enable checkbox does after saving; Story Suite's setEnabled does the same.
function afterEnabledChange() {
    announceToSuite();
    updateInjection();
    renderDossier();
    // (1.2.15) Story Block's Present NPCs and Dossiers tabs leave with Delta and come back with it.
    if (typeof CustomEvent === 'function') globalThis.document?.dispatchEvent?.(new CustomEvent('npc-state-delta:enabled-changed', { detail: { enabled: getSettings().enabled !== false } }));
}

function applyEnabled(on) {
    const settings = getSettings();
    const next = Boolean(on);
    $('#npc_state_delta_enabled').prop('checked', next);
    if ((settings.enabled !== false) === next) return;
    settings.enabled = next;
    persistSettings();
    afterEnabledChange();
}

// What a Source of truth select does; Story Suite's setSource does the same.
function applySourceOfTruth(area, choice) {
    const settings = getSettings();
    settings.sourceOfTruth = normalizeSourceOfTruth({ ...settings.sourceOfTruth, [area]: choice });
    persistSettings();
    syncSuiteControls();
    updateInjection();
}

function syncSuiteControls() {
    const choices = normalizeSourceOfTruth(extension_settings[EXTENSION_NAME]?.sourceOfTruth);
    for (const area of SUITE_AREAS) {
        $(`#npc_state_delta_source_${area}`).val(choices[area]);
        const owner = areaOwner(area, choices);
        $(`[data-delta-source-status="${area}"]`).text(owner ? `Now: ${owner.name}` : 'Now: this extension');
    }
    const warning = statsOverlapWarning(extension_settings[EXTENSION_NAME]?.customFieldNames || [], choices);
    $('#npc_state_delta_custom_fields_stats_warning').text(warning).prop('hidden', !warning);
    $('#npc_state_delta_suite_manage').prop('hidden', !suiteManageAvailable());
}

function connectStorySuite() {
    if (suiteConnected) return;
    suiteConnected = true;
    ensureSuiteStylesheet();
    // Read straight from the settings object: the calendar is consulted per NPC projection.
    setExternalCalendarSource(() => externalCalendar(extension_settings[EXTENSION_NAME]?.sourceOfTruth));
    announceToSuite();
    try {
        storySuite().onChange(() => {
            if (suiteRefreshQueued) return;
            suiteRefreshQueued = true;
            queueMicrotask(() => {
                suiteRefreshQueued = false;
                syncSuiteControls();
                updateInjection();
            });
        });
    } catch (error) {
        console.warn('[NPC State Delta] Story Suite is unavailable', error);
    }
    // Story Suite v2: when Delta registers with a Story Block v2 host, or that host goes away, the v1
    // announcement and the "Open Story Suite" button follow (suite-handshake.js, storyBlockIsV2), and
    // so do the in-chat cast's "Only in Story Block" default and the settings shown for it.
    globalThis.document?.addEventListener?.('npc-state-delta:v2-host', () => {
        announceToSuite();
        syncSuiteControls();
        try { $('#npc_state_delta_present_cast_display').val(effectivePresentCastChoice()); } catch { /* settings not mounted */ }
        startInlineWatchdog();
        queueInlineRender(0);
    });
}

function bindSourceOfTruthSettings() {
    $(document).on('change.npcStateDelta', '[data-delta-source-area]', function () {
        applySourceOfTruth(this.dataset.deltaSourceArea, this.value);
    });
    $(document).on('click.npcStateDelta', '[data-delta-open-suite]', event => {
        event?.preventDefault?.();
        openSuiteOverlay();
    });
}

function bindSettingsNumber(selector, key, min, max, fallback, after = null) {
    $(document).on('change.npcStateDelta', selector, function () {
        const value = Math.max(min, Math.min(max, Math.round(Number(this.value) || fallback)));
        getSettings()[key] = value;
        this.value = value;
        persistSettings();
        after?.();
    });
}

function bindSettingsText(selector, key, after = null) {
    $(document).on('change.npcStateDelta', selector, function () {
        getSettings()[key] = String(this.value || '');
        persistSettings();
        after?.();
    });
}

function bindUi() {
    $(document).off('.npcStateDelta');
    bindSettingsCheckbox('#npc_state_delta_enabled', 'enabled', afterEnabledChange);
    bindSettingsCheckbox('#npc_state_delta_auto', 'autoScan');
    $(document).on('change.npcStateDelta', '#npc_state_delta_scanner_connection_profile', function () {
        getSettings().scannerConnectionProfile = String(this.value || '').trim();
        persistSettings();
    });
    bindSettingsCheckbox('#npc_state_delta_full_scan_every_turn', 'fullScanEveryTurn');
    bindSettingsCheckbox('#npc_state_delta_narration_capture', 'narrationCapture');
    bindSettingsCheckbox('#npc_state_delta_narration_capture_compact', 'narrationCaptureCompact');
    bindSettingsCheckbox('#npc_state_delta_inject', 'inject', updateInjection);
    bindSettingsNumber('#npc_state_delta_inject_budget', 'injectBudgetTokens', 512, 6000, 4000, updateInjection);
    bindSettingsNumber('#npc_state_delta_inject_limit', 'injectLimit', 1, 12, 3, updateInjection);
    bindSettingsCheckbox('#npc_state_delta_archive_deaths', 'autoArchiveDeaths');
    bindCustomFieldSettings();
    bindSourceOfTruthSettings();
    bindSettingsCheckbox('#npc_state_delta_reactivate_archived', 'autoReactivateArchived');
    bindSettingsCheckbox('#npc_state_delta_branch_rescan', 'branchRescan');
    bindSettingsCheckbox('#npc_state_delta_mid_delete_rewind', 'midDeleteRewind');
    $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_theme_preset', function () {
        const settings = getSettings();
        const saved = portraitSettingsSnapshot(settings);
        const key = PORTRAIT_THEME_PRESETS[this.value] ? this.value : 'custom';
        if (portraitSettingsDirty && key !== saved.portraitThemePreset && !confirmDiscardPortraitDraft()) {
            this.value = saved.portraitThemePreset;
            return;
        }
        portraitSettingsDirty = false;
        if (key === 'custom') {
            const custom = portraitCustomPresetFor(settings);
            writePortraitSettingsDraftToUi({
                ...saved,
                portraitThemePreset: 'custom',
                portraitCustomPresetId: custom.id,
                portraitStylePositive: custom.positive,
                portraitStyleNegative: custom.negative,
                portraitComposition: custom.composition,
                portraitPromptFormat: custom.promptFormat,
                portraitUseMood: custom.useMood,
                portraitUseLocation: custom.useLocation,
            });
        } else {
            const preset = PORTRAIT_THEME_PRESETS[key];
            writePortraitSettingsDraftToUi({
                ...saved,
                portraitThemePreset: key,
                portraitStylePositive: preset.positive,
                portraitStyleNegative: preset.negative,
            });
        }
        markPortraitSettingsDirty();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_custom_preset', function () {
        const settings = getSettings();
        const saved = portraitSettingsSnapshot(settings);
        const target = saved.portraitCustomPresets.find(item => item.id === String(this.value || ''));
        if (!target) return writePortraitCustomPresetOptions(saved);
        if (portraitSettingsDirty && target.id !== saved.portraitCustomPresetId && !confirmDiscardPortraitDraft()) {
            this.value = saved.portraitCustomPresetId;
            return;
        }
        portraitSettingsDirty = false;
        writePortraitSettingsDraftToUi({
            ...saved,
            portraitThemePreset: 'custom',
            portraitCustomPresetId: target.id,
            portraitStylePositive: target.positive,
            portraitStyleNegative: target.negative,
            portraitComposition: target.composition,
            portraitPromptFormat: target.promptFormat,
            portraitUseMood: target.useMood,
            portraitUseLocation: target.useLocation,
        });
        markPortraitSettingsDirty();
    });
    $(document).on('input.npcStateDelta', '#npc_state_delta_portrait_style_positive, #npc_state_delta_portrait_style_negative, #npc_state_delta_portrait_composition', function () {
        if (this.id === 'npc_state_delta_portrait_style_positive' || this.id === 'npc_state_delta_portrait_style_negative') {
            $('#npc_state_delta_portrait_theme_preset').val('custom');
            $('.npc-state-delta-custom-preset-library').addClass('delta-custom-active');
        }
        markPortraitSettingsDirty();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_generation_enabled, #npc_state_delta_portrait_prompt_format, #npc_state_delta_portrait_use_mood, #npc_state_delta_portrait_use_location, #npc_state_delta_portrait_save_gallery', () => {
        markPortraitSettingsDirty();
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_add, #npc_state_delta_portrait_custom_duplicate', async function () {
        if (portraitSettingsSaveBusy) return;
        const settings = getSettings();
        const snapshot = portraitSettingsDraftFromUi();
        const presets = portraitCustomPresetLibrary(settings.portraitCustomPresets);
        if (presets.length >= PORTRAIT_CUSTOM_PRESET_LIMIT) {
            globalThis.toastr?.warning?.(`NPC State Delta: custom portrait preset limit is ${PORTRAIT_CUSTOM_PRESET_LIMIT}.`);
            return;
        }
        const duplicate = this.id.endsWith('_duplicate');
        const selected = presets.find(item => item.id === String($('#npc_state_delta_portrait_custom_preset').val() || ''))
            || portraitCustomPresetFor(settings);
        const base = portraitCustomPreset({
            ...(duplicate ? selected : {}),
            positive: snapshot.portraitStylePositive,
            negative: snapshot.portraitStyleNegative,
            composition: snapshot.portraitComposition,
            promptFormat: snapshot.portraitPromptFormat,
            useMood: snapshot.portraitUseMood,
            useLocation: snapshot.portraitUseLocation,
        });
        const suggestedRoot = duplicate ? `${selected.name} Copy` : `Custom ${presets.length + 1}`;
        const suggested = uniquePortraitCustomPresetName(presets, suggestedRoot);
        const name = String(globalThis.window?.prompt?.('Custom portrait preset name:', suggested) || '').trim().slice(0, 80);
        if (!name) return;
        if (portraitCustomPresetNameTaken(presets, name)) {
            globalThis.toastr?.warning?.(`NPC State Delta: a custom portrait preset named "${name}" already exists.`);
            return;
        }
        const id = nextPortraitCustomPresetId(presets);
        const created = portraitCustomPreset({ ...base, id, name }, presets.length);
        const saved = await persistPortraitCustomPresetLibrary(settings, [...presets, created], id, {
            operational: snapshot,
        });
        if (saved) globalThis.toastr?.success?.(`NPC State Delta: saved custom portrait preset ${created.name}.`);
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_rename', async function () {
        if (portraitSettingsSaveBusy) return;
        let settings = getSettings();
        let snapshot = portraitSettingsSnapshot(settings);
        const id = String($('#npc_state_delta_portrait_custom_preset').val() || snapshot.portraitCustomPresetId);
        let index = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
        if (index < 0) return;
        let current = snapshot.portraitCustomPresets[index];
        const name = String(globalThis.window?.prompt?.('Rename custom portrait preset:', current.name) || '').trim().slice(0, 80);
        if (!name || name === current.name) return;
        if (portraitCustomPresetNameTaken(snapshot.portraitCustomPresets, name, id)) {
            globalThis.toastr?.warning?.(`NPC State Delta: a custom portrait preset named "${name}" already exists.`);
            return;
        }
        if (portraitSettingsDirty && !(await savePortraitSettingsDraft())) return;
        settings = getSettings();
        snapshot = portraitSettingsSnapshot(settings);
        index = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
        if (index < 0) return;
        current = snapshot.portraitCustomPresets[index];
        const presets = structuredClone(snapshot.portraitCustomPresets);
        presets[index] = { ...current, name };
        const saved = await persistPortraitCustomPresetLibrary(settings, presets, id, { theme: snapshot.portraitThemePreset });
        if (saved) globalThis.toastr?.success?.(`NPC State Delta: renamed portrait preset to ${name}.`);
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_delete', async function () {
        if (portraitSettingsSaveBusy) return;
        const settings = getSettings();
        let snapshot = portraitSettingsSnapshot(settings);
        if (snapshot.portraitCustomPresets.length <= 1) {
            globalThis.toastr?.warning?.('NPC State Delta: keep at least one custom portrait preset.');
            return;
        }
        let id = String($('#npc_state_delta_portrait_custom_preset').val() || snapshot.portraitCustomPresetId);
        let targetIndex = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
        let target = snapshot.portraitCustomPresets[targetIndex];
        if (!target) return;
        if (globalThis.window?.confirm?.(`Delete custom portrait preset "${target.name}"?`) === false) return;
        if (portraitSettingsDirty && !(await savePortraitSettingsDraft())) return;
        snapshot = portraitSettingsSnapshot(getSettings());
        id = String($('#npc_state_delta_portrait_custom_preset').val() || id);
        targetIndex = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
        target = snapshot.portraitCustomPresets[targetIndex];
        if (!target || snapshot.portraitCustomPresets.length <= 1) return;
        const presets = snapshot.portraitCustomPresets.filter(item => item.id !== id);
        const nextIndex = Math.min(Math.max(0, targetIndex), presets.length - 1);
        const nextId = presets[nextIndex].id;
        const saved = await persistPortraitCustomPresetLibrary(getSettings(), presets, nextId, {
            theme: snapshot.portraitThemePreset === 'custom' ? 'custom' : snapshot.portraitThemePreset,
        });
        if (saved) globalThis.toastr?.success?.(`NPC State Delta: deleted custom portrait preset ${target.name}.`);
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_reset_portrait_theme', () => {
        writePortraitSettingsDraftToUi({
            ...portraitSettingsSnapshot(getSettings()),
            portraitGenerationEnabled: true,
            portraitThemePreset: 'fantasy_anime',
            portraitStylePositive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
            portraitStyleNegative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
            portraitComposition: DEFAULT_PORTRAIT_COMPOSITION,
            portraitPromptFormat: 'hybrid',
            portraitUseMood: true,
            portraitUseLocation: false,
            portraitSaveToGallery: false,
        });
        markPortraitSettingsDirty();
        globalThis.toastr?.info?.('NPC State Delta: Fantasy Anime defaults loaded as an unsaved portrait-settings draft.');
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_save_portrait_settings', () => { void savePortraitSettingsDraft(); });
    bindSettingsCheckbox('#npc_state_delta_launcher_with_story_block', 'launcherWithStoryBlock', applyLauncherFlag);
    bindSettingsCheckbox('#npc_state_delta_launcher_with_story_block_v2', 'launcherWithStoryBlockV2', applyLauncherFlag);
    bindSettingsNumber('#npc_state_delta_scan_every', 'scanEvery', 1, 20, 2);
    bindSettingsNumber('#npc_state_delta_scan_depth', 'scanDepth', 2, 30, 6);
    bindSettingsNumber('#npc_state_delta_narration_capture_catch_up', 'narrationCaptureCatchUp', 0, 50, 8);
    $(document).on('change.npcStateDelta', '#npc_state_delta_present_cast_display', function () {
        getSettings().presentCastDisplay = normalizePresentCastDisplay(this.value); this.value = getSettings().presentCastDisplay;
        getSettings().presentCastDisplayChosen = true;
        persistSettings();
        startInlineWatchdog();
        queueInlineRender(0);
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_admission_mode', function () {
        getSettings().admissionMode = normalizeNpcAdmissionMode(this.value); this.value = getSettings().admissionMode; persistSettings();
    });
    bindSettingsNumber('#npc_state_delta_max', 'maxNpcs', 1, 100, 40);
    bindSettingsCheckbox('#npc_state_delta_auto_prune_stale', 'autoPruneStale');
    $(document).on('change.npcStateDelta', '#npc_state_delta_stale_archive_after', function () {
        const settings = getSettings();
        settings.staleArchiveAfter = Math.max(10, Math.min(999, Math.round(Number(this.value) || 30)));
        if (settings.staleDeleteAfter <= settings.staleArchiveAfter) settings.staleDeleteAfter = Math.min(1000, settings.staleArchiveAfter + 1);
        syncSettingsControls(); persistSettings();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_stale_delete_after', function () {
        const settings = getSettings();
        settings.staleDeleteAfter = Math.max(settings.staleArchiveAfter + 1, Math.min(1000, Math.round(Number(this.value) || 50)));
        syncSettingsControls(); persistSettings();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_base_trust, #npc_state_delta_base_affection, #npc_state_delta_base_desire, #npc_state_delta_base_tension', function () {
        const settings = getSettings();
        const key = this.id.replace('npc_state_delta_base_', '');
        settings.relationshipBaseline[key] = Math.max(-100, Math.min(100, Math.round(Number(this.value) || 0)));
        settings.relationshipBaseline = normalizeRelationshipBaseline(settings.relationshipBaseline);
        syncSettingsControls(); persistSettings();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_cap_ordinary, #npc_state_delta_cap_meaningful, #npc_state_delta_cap_major, #npc_state_delta_cap_extreme', function () {
        const settings = getSettings();
        const key = this.id.replace('npc_state_delta_cap_', '');
        settings.relationshipCaps[key] = Math.max(0, Math.round(Number(this.value) || 0));
        settings.relationshipCaps = normalizeRelationshipCaps(settings.relationshipCaps);
        syncSettingsControls(); persistSettings();
    });
    bindSettingsText('#npc_state_delta_relationship_criteria', 'relationshipCriteria');
    bindSettingsText('#npc_state_delta_impact_criteria', 'relationshipImpactCriteria');
    bindSettingsText('#npc_state_delta_memory_criteria', 'memoryCriteria');
    bindSettingsText('#npc_state_delta_behavior_criteria', 'behaviorCriteria', updateInjection);
    $(document).on('click.npcStateDelta', '#npc_state_delta_reset_relationship_rules', () => {
        const settings = getSettings();
        settings.relationshipBaseline = { ...DEFAULT_RELATIONSHIP };
        settings.relationshipCaps = { ...DEFAULT_RELATIONSHIP_CAPS };
        settings.relationshipCriteria = DEFAULT_RELATIONSHIP_CRITERIA;
        settings.relationshipImpactCriteria = DEFAULT_IMPACT_CRITERIA;
        syncSettingsControls(); persistSettings();
        globalThis.toastr?.success?.('NPC State Delta: relationship tuning reset to defaults.');
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_reset_memory_rules', () => {
        getSettings().memoryCriteria = DEFAULT_MEMORY_CRITERIA;
        syncSettingsControls(); persistSettings();
        globalThis.toastr?.success?.('NPC State Delta: important memory criteria reset to default.');
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_reset_behavior_rules', () => {
        getSettings().behaviorCriteria = DEFAULT_BEHAVIOR_CRITERIA;
        syncSettingsControls(); persistSettings(); updateInjection();
        globalThis.toastr?.success?.('NPC State Delta: behavior rubric reset to default.');
    });
    $(document).on('click.npcStateDelta', '.npc-state-delta-retry-hydration', () => { void retryCurrentChatHydration(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-detach-sidecar', () => { void detachBrokenSidecar(); });
    $(document).on('click.npcStateDelta', '#npc_state_delta_scan_now', async () => {
        const scanned = await scanNow({ manual: true, messageId: latestMessageId(true) });
        // (user decision 5) The reader's own Scan also runs the backfill queue hosted one-pass mode holds.
        if (scanned && hostedOnePass()) await processPendingBackfills(latestMessageId(true));
    });
    // (1.2.13) What's sent: filled when opened and on Refresh, never while closed.
    $(document).on('click.npcStateDelta', '#npc_state_delta_sent_refresh', () => renderWhatsSent());
    globalThis.document?.addEventListener?.('toggle', event => {
        if (event.target?.matches?.('[data-delta-settings-group="sent"]') && event.target.open) renderWhatsSent();
    }, true);
    $(document).on('click.npcStateDelta', '#npc_state_delta_add_manual', () => addNpcManually());
    $(document).on('click.npcStateDelta', '.npc-state-delta-roster-edit', function (event) { event.preventDefault?.(); event.stopPropagation?.(); openNpcEditorSafely(this.dataset.npcId); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-scan-dossier', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void scanNpcDossier(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-refresh-chat', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void refreshNpcFromChat(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-reset', function (event) { event.preventDefault?.(); resetPortraitGeneratorFromDossier(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-run', function (event) { event.preventDefault?.(); void generatePortraitFromDialog(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-use', function (event) { event.preventDefault?.(); void useGeneratedPortrait(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-archive-npc', async function () {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('archive a dossier', key)) return;
        setNpcArchiveStateById(this.dataset.npcId, true, { reason: 'manual' });
    });
    $(document).on('click.npcStateDelta', '.npc-state-delta-restore-npc', async function () {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('restore a dossier', key)) return;
        setNpcArchiveStateById(this.dataset.npcId, false);
    });
    $(document).on('click.npcStateDelta', '.npc-state-delta-delete-npc', async function () {
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('delete a dossier', key)) return;
        deleteNpcById(this.dataset.npcId);
    });
    $(document).on('keydown.npcStateDelta', '.npc-state-delta-delete-npc', async function (event) {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault?.();
        const key = getChatKey();
        if (!await ensureFreshMutationBoundary('delete a dossier', key)) return;
        deleteNpcById(this.dataset.npcId);
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_clear_chat', async () => {
        if (!await ensureFreshMutationBoundary('clear this chat dossier')) return;
        if (!window.confirm('Clear every NPC State Delta dossier for this chat? Portraits and inline dossier cards will also be removed.')) return;
        closePortraitGenerator();
        const cleared = freshChatState();
        cleared.lineage = chatLineage(getContext().chat || []);
        setChatState(getChatKey(), cleared);
        persistCritical(); renderDossier(); updateInjection();
    });
}

function attachSettingsPanel() {
    if ($(`#${UI_ID}`).length) return true;
    let host = $('#extensions_settings2');
    if (!host.length) host = $('#extensions_settings');
    if (!host.length) host = $('#extensionsMenu');
    if (!host.length) {
        console.warn('[NPC State Delta] Could not find SillyTavern extensions settings host yet.');
        return false;
    }
    host.append(buildSettingsHtml());
    const panel = document.getElementById?.(UI_ID);
    bindSettingsGroupMemory(panel);
    syncSettingsControls();
    renderDossier();
    panel?.dispatchEvent?.(new CustomEvent('npc-state-delta:settings-mounted', { bubbles: true }));
    return true;
}

function scheduleSettingsMountRetries() {
    if (attachSettingsPanel()) return;
    if (mountRetryTimer) clearInterval(mountRetryTimer);
    let attempts = 0;
    mountRetryTimer = setInterval(() => {
        attempts += 1;
        if (attachSettingsPanel() || attempts >= 40) {
            clearInterval(mountRetryTimer);
            mountRetryTimer = null;
            if (attempts >= 40 && !$(`#${UI_ID}`).length) {
                console.error('[NPC State Delta] Settings panel host never appeared; extension logic is loaded but UI could not mount.');
            }
        }
    }, 250);
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
        if (Number.isInteger(messageId)) deferredSwipeMessageId = messageId;
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
        || (state.lastScannedMessageId === messageId && eventSourceKey === lineageCheckpointKey(state.lineage, messageId)))) return;
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
    const autoScanDue = settings.autoScan && (settings.fullScanEveryTurn || state.assistantSinceScan >= settings.scanEvery);
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
    if (eventsRegistered) return;
    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const source = ctx.eventSource;
    if (!source?.on) return;
    eventsRegistered = true;
    for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (events[name]) source.on(events[name], syncScannerProfileControl);
    }

    if (events.MESSAGE_SENT) {
        source.on(events.MESSAGE_SENT, async (messageId) => {
            const key = getChatKey();
            if (key === 'no-chat') return;
            // SillyTavern waits for this listener before generating. The freshness read must stay: a
            // newer dossier from another session has to be adopted (and an older local history
            // recognised) before this turn is certified or its prompt is built. It is a revalidating
            // read, so an unchanged sidecar costs a 304 rather than a full download. The generation
            // that sends this message already revalidated moments ago (GENERATION_AFTER_COMMANDS
            // runs first), so one read per send is enough.
            const recentlyChecked = generationFreshness.key === key && Date.now() - generationFreshness.at < GENERATION_FRESHNESS_REUSE_MS
                && chatHydrationStatus(key) === 'ready';
            generationFreshness = { key: '', at: 0 };
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
            captureRulesWithheld = !CAPTURE_RULES_TYPES.has(String(type ?? ''));
            if (type === 'quiet') {
                sentCaptureRules = '';
                disarmNarrationCapture();
                // Another extension's background request never carries the capture rules. Nothing else
                // of the injection is rebuilt for it.
                if (lastInjection.captureRules || lastInjection.captureContext) {
                    getContext().setExtensionPrompt?.(CAPTURE_RULES_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
                    getContext().setExtensionPrompt?.(CAPTURE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
                    lastInjection = { ...lastInjection, captureChars: 0, captureRules: '', captureContext: '' };
                }
                return;
            }
            narrationCaptureArmed = '';
            // Every roleplay generation revalidates the canonical dossier (a 304 when unchanged)
            // before its prompt is built: regenerate/swipe/continue, an empty Send, impersonate and
            // group member turns have no MESSAGE_SENT, and an ordinary send reuses this read there.
            try {
                await ensureChatStateLoaded(key);
                generationFreshness = { key, at: Date.now() };
            } catch (error) { console.warn('[NPC State Delta] pre-generation freshness check failed; the injection keeps the last verified dossier.', error); }
            if (getChatKey() !== key) return;
            narrationCaptureArmed = captureType ? key : '';
            updateInjection();
            // Armed only when the instruction actually went out (hydration may have withheld it).
            if (!lastInjection.captureContext) narrationCaptureArmed = '';
            if (lastInjection.captureRules) holdCaptureRules();
            else sentCaptureRules = '';
            noteNarrationCaptureVersion(key);
        });
    }
    if (events.GENERATION_STOPPED) source.on(events.GENERATION_STOPPED, () => { sentCaptureRules = ''; disarmNarrationCapture(); });
    if (events.CHAT_COMPLETION_PROMPT_READY) source.on(events.CHAT_COMPLETION_PROMPT_READY, eventData => keepCaptureRules(eventData));

    if (events.MESSAGE_RECEIVED) {
        // The capture block leaves the reply before any other listener (TTS, full cast, other
        // extensions) or lineage key reads it.
        const stripCapture = messageId => { sentCaptureRules = ''; return receiveNarrationBlock(messageId); };
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
            narrationCaptureArmed = '';
            sentCaptureRules = '';
            for (const cachedKey of chatStateCache.keys()) cancelScanOperation(cachedKey, 'chat changed');
            if (branchReconcileTimer) clearTimeout(branchReconcileTimer);
            branchReconcileTimer = null;
            branchReconcilePending = null;
            if (swipeSettlementTimer) clearTimeout(swipeSettlementTimer);
            swipeSettlementTimer = null;
            swipeSettlementPending = null;
            deferredSwipeMessageId = null;
            swipeSettlementSequence += 1;
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

async function init() {
    if (initialized) {
        scheduleSettingsMountRetries();
        return;
    }
    initialized = true;
    getSettings();
    clearLegacyPromptKeys();
    connectStorySuite();
    // Story Suite v2 (Story Block 2): optional; without a v2 host the adapter does nothing.
    import('./src/storysuite-v2.js').then(v2 => { storySuiteV2 = v2.startStorySuiteV2({ suiteApi: SUITE_API, panelId: UI_ID, version: NPC_STATE_VERSION, headReply: latestReplyIndex, calendarOwn: () => normalizeSourceOfTruth(getSettings().sourceOfTruth).calendar === 'mine' }); }).catch(error => console.debug('[NPC State Delta] Story Suite v2 adapter is not available', error));
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
        initialized = false;
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
    portraitSettingsDirty: () => portraitSettingsDirty,
    savePortraitSettings: draft => savePortraitSettingsDraft(draft),
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
        narrationCapture: { ...narrationCaptureStats, enabled: narrationCaptureEnabled(), armed: Boolean(narrationCaptureArmed), pending: narrationCaptures.size },
        inlineEntries: chatHydrationStatus(getChatKey()) === 'ready' ? (getChatState().inlineCards?.length || 0) : 0,
        mountedInlineAnchors: document.querySelectorAll?.('.npc-state-delta-inline-anchor')?.length || 0,
        integratedMeguminBlocks: document.querySelectorAll?.('.npc-state-delta-megumin-pane')?.length || 0,
        settingsPanelMounted: Boolean(document.querySelector?.(`#${UI_ID}`)),
        rosterMounted: Boolean(document.querySelector?.('#npc_state_delta_roster_summary')),
        editorMounted: editorIsMounted(),
        editorMode: activeEditorPopup ? 'sillytavern-popup' : 'closed',
        presentCastDisplay: presentCastDisplayMode(),
        portraitGeneratorOpen: Boolean(activePortraitGeneratorOverlay),
        portraitGeneratorNpcId: activePortraitGeneratorNpcId || null,
        portraitGenerationBusy,
        inlineAnchors: document.querySelectorAll?.('.npc-state-delta-inline-anchor')?.length || 0,
        inlineObserver: Boolean(inlineObserver && inlineObserverChat),
        inlineNeedsRepair: inlineMountNeedsRepair(),
        lastScan: lastScanMetrics ? { ...lastScanMetrics } : null,
        branchHistory: chatHydrationStatus(getChatKey()) === 'ready' ? branchHistoryDiagnostic(getChatState()) : null,
        branchReconciliations: branchReconciliationEvents
            .filter(event => event.chatKey === getChatKey())
            .slice(-8)
            .map(event => structuredClone(event)),
        swipeState: hostSwipeState(),
        swipeSettlementPending: Boolean(swipeSettlementPending || swipeSettlementTimer),
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
    scanMetrics: () => lastScanMetrics ? { ...lastScanMetrics } : null,
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
    // Whether the open chat's dossier state is loaded (the participant hydrates its ids at chat open), and whether a scan or pass is in flight.
    stateReady: () => chatHydrationStatus() === 'ready',
    scanActive: () => scanWorkPending(),
    scanIdle: ms => scanIdle(ms),
    // Which messages the story stands on (the Story Suite adapter's gate): scans do not read what Story Block faded.
    useMessageGate: gate => useMessageGate(gate),
    // (v2 meters) Delta's base relationship values: where a new NPC's slice meters start.
    relationshipBaseline: () => normalizeRelationshipBaseline(getSettings().relationshipBaseline),
    presentCastHtml: () => storyBlockCastHtml(),
    // (1.2.13) Why the present cast is empty ({ text, scan }), and Add NPC, for the Story Block tabs.
    castEmptyReason: () => castEmptyReason(),
    addNpc: () => addNpcManually(),
    /** Fill the now/chatter text of present-cast markup inserted under `root` (textContent only). */
    fillPresentCast: root => fillPresentSceneText(root),
    dossierRevision: () => `${getChatKey()}|${Number(stateVersions.get(getChatKey()) || 0)}`,
    getNpc: npcId => {
        const npc = getChatState().npcs.find(item => item.id === String(npcId || ''));
        return npc ? structuredClone(npc) : null;
    },
    /** The configured custom field names (the dossier shows these; a stored value under another name stays in the editor only). */
    customFieldNames: () => [...getSettings().customFieldNames],
    getDossierState: () => {
        const state = getChatState();
        const formPortraits = {};
        for (const [npcId, forms] of Object.entries(state.formPortraitAssets || {})) {
            formPortraits[npcId] = Object.fromEntries(Object.values(forms || {}).filter(portrait => portrait?.dataUrl)
                .map(portrait => [portrait.form, { dataUrl: portrait.dataUrl, appearanceFingerprint: portrait.appearanceFingerprint || '' }]));
        }
        const meterViews = storySuiteV2Meters()?.dossierMeters?.(state.npcs) ?? {};
        return { turn: state.turn, reply: latestReplyIndex(), npcs: structuredClone(hostedMeterView(state.npcs)), portraitAssets: {}, formPortraits, customFieldNames: [...getSettings().customFieldNames], meterViews };
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
