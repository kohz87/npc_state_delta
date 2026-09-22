/* NPC State Delta - standalone SillyTavern extension */
import { extension_settings, getContext } from '../../../extensions.js';
import { extension_prompt_types, extension_prompt_roles, getRequestHeaders, saveSettings as saveHostSettings } from '../../../../script.js';
import {
    dispatchScannerRequest,
    isScannerRoutingError,
    scannerRoutingError,
    scannerRoutingMetrics,
    scannerProfileOptions,
} from './scanner-routing.js';
import {
    AUTOMATIC_BACKFILL_QUEUE_VERSION,
    AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
    automaticBackfillStillRelevant,
    backfillNeedsRequest,
    normalizeAutomaticBackfillRequest,
    npcParticipatesInExchange,
} from './scan-context.js';
import { createDiagnosticStore } from './diagnostics-core.js';
import {
    NPC_STATE_VERSION,
    DEFAULT_RELATIONSHIP,
    DEFAULT_RELATIONSHIP_CAPS,
    DEFAULT_RELATIONSHIP_CRITERIA,
    DEFAULT_IMPACT_CRITERIA,
    DEFAULT_MEMORY_CRITERIA,
    DEFAULT_BEHAVIOR_CRITERIA,
    isLegacyStockBehaviorCriteriaV024,
    isLegacyStockRelationshipCapsV028,
    isLegacyStockRelationshipCriteriaV028,
    isLegacyStockImpactCriteriaV028,
    isLegacyStockBehaviorCriteriaV028,
    isLegacyStockRelationshipCapsV029,
    isLegacyStockRelationshipCriteriaV029,
    isLegacyStockImpactCriteriaV029,
    isLegacyStockBehaviorCriteriaV029,
    isLegacyStockRelationshipCriteriaV0221,
    isLegacyStockImpactCriteriaV0221,
    relationshipHistoryLooksDuplicate,
    IMPORTANT_MEMORY_LIMIT,
    KEY_RELATIONSHIP_LIMIT,
    BEHAVIOR_PROFILE_LIMIT,
    inferNpcIdentityKind,
    normalizeRelationshipBaseline,
    normalizeRelationshipCaps,
    normalizeRelationshipProgress,
    normalizeRelationshipMilestones,
    inferManualRelationshipMilestones,
    applyRelationshipMilestoneCrossings,
    normalizeRelationshipEvidence,
    normalizeRelationshipEventHistory,
    appendRelationshipEvent,
    applyRelationshipDelta,
    relationshipChangeReasonGrounded,
    relationshipAxisEvidenceGrounded,
    filterRelationshipDeltaByEvidence,
    prepareFullWindowRelationshipPayload,
    relationshipSummaryConsistent,
    calibrateRelationshipSummary,
    normalizeNpcAdmissionMode,
    buildInjection,
    buildScannerPrompt,
    buildRelationshipPassPrompt,
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildProfileRefreshPrompt,
    applyNpcStateCommand,
    mergeScanResult,
    isTerminalNpcDeath,
    manualLifeStateRecord,
    protectTerminalNpc,
    parseScanJson,
    npcMatchesLabel,
    normalizeName,
    normalizeNpcRecord,
    normalizeNpcCandidate,
    normalizeScanNpc,
    resolveInterimIdentityPromotions,
    setNpcArchived,
    stripUiNoise,
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
} from './core.js';
import { applyNpcBirthdayUpdate, normalizeBirthDate } from './birthday.js';
import {
    encodeNpcStateBundle,
    mergeImportedDossierState,
} from './bundle.js';
import { decodeDeltaNativeBundle, nativeStateForTarget } from './native-transfer.js';
import {
    BRANCH_LINEAGE_VERSION,
    BRANCH_HISTORY_COMPACTION_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    BRANCH_SNAPSHOT_MAX_BYTES,
    ROLLBACK_JOURNAL_BUDGET_BYTES,
    createScanOperationRegistry,
    deletedChatStateKey,
    bestAncestorState,
    chatLineage,
    fingerprintMessage,
    firstLineageDivergence,
    lineageCheckpointKey,
    legacyChatLineageV0210,
    addUserDismissedGroup,
    clearUserDismissedGroupsFor,
    compactLegacyBranchHistory,
    ensureBranchParentAnchor,
    migrateLegacyBranchState,
    normalizeUserDismissedGroups,
    promoteLegacyUserDismissedGroups,
    recordBranchCheckpoint,
    reconcileBranchState,
    snapshotBranchState,
} from './branch.js';
import {
    normalizeSocialGraph,
    reconcileSocialState,
    applyManualKeyRelationshipEdit,
    removeNpcFromSocialGraph,
    purgeNpcStructuredReferences,
} from './social.js';
import {
    deleteNpcStateDataFile,
    makeNpcStateDataFileName,
    makeNpcStateRecoveryFileName,
    readNpcStateDataFile,
    retireNpcStateDataFile,
    writeNpcStateDataFile,
} from './storage.js';
import {
    buildQualifiedChatKey,
    chatOwnerScope,
    encodeChatKeyPart,
    getCharacterOwnerId,
    getChatIdentityFromContext,
    isQualifiedChatKey,
    legacyChatKey,
    parseQualifiedChatKey,
    sameChatOwnerScope,
} from './identity.js';
import {
    lifecycleRenameStateIsEmpty,
    liveLifecycleCandidateKeys,
    resolveDeletedLifecycleKeyFromPresence,
    resolveOwnedLifecycleKey,
} from './hardening-core.js';

const EXTENSION_NAME = 'npc_state_delta';
const PROMPT_KEY = 'npc_state_delta_live_dossier';
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
let activeNpcViewerOverlay = null;
let activeNpcViewerId = '';
let activeNpcViewerOpenedAt = 0;
let activePortraitGeneratorOverlay = null;
let activePortraitGeneratorChatKey = '';
let activePortraitGeneratorNpcId = '';
let activePortraitGenerationUrl = '';
let portraitGenerationBusy = false;
let portraitSettingsDirty = false;
let portraitSettingsSaveBusy = false;
let lastViewerActivation = { npcId: '', at: 0 };
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
const loadedChatKeys = new Set();
const loadingChatStates = new Map();
const hydrationErrors = new Map();
const pendingAutoScans = new Map();
const assistantReceipts = new Map();
const stateWriteTimers = new Map();
const stateWritePromises = new Map();
const stateVersions = new Map();
const persistedVersions = new Map();
const ownershipEpochs = new Map();
const chatCacheTouches = new Map();
const CHAT_CACHE_LIMIT = 6;
const BRANCH_INDEX_PREFIX_LIMIT = 12;
const BRANCH_INDEX_MAX_CANDIDATES = 16;
const LEGACY_BRANCH_DISCOVERY_LIMIT = 8;
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
    const revision = Number(stateVersions.get(key) || 0);
    operation.requestController = new AbortController();
    operation.requestScope = {
        route: { profileId: getSettings().scannerConnectionProfile },
        chatKey: key,
        operationId: operation.id,
        signal: operation.requestController.signal,
        deadline: operation.startedAt + SCAN_OPERATION_TIMEOUT_MS,
        isCurrent: () => scanOperations.isCurrent(key, operation)
            && getChatKey() === key
            && Number(stateVersions.get(key) || 0) === revision
            && firstLineageDivergence(lineage, chatLineage(getContext().chat || [])) === -1,
    };
    return operation;
}
function scanOperationCurrent(key, operation) { return scanOperations.isCurrent(key, operation); }
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
    custom: { label: 'Custom', positive: '', negative: '' },
});

const DURABLE_COMPACTION_VERSION = 1;

const DEFAULTS = Object.freeze({
    schemaVersion: 29,
    enabled: true,
    autoScan: true,
    fullScanEveryTurn: false,
    scannerConnectionProfile: '',
    portraitGenerationEnabled: true,
    portraitThemePreset: 'fantasy_anime',
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
    injectDepth: 1,
    injectLimit: 3,
    injectBudgetTokens: 1800,
    branchRescan: true,
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
    branchIndex: {},
    legacyOwnershipClaims: {},
    recoveryHistory: {},
    recoveryGarbage: {},
});

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\"', '&quot;')
        .replaceAll("'", '&#039;');
}

function persistSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function getSettings() {
    let settings = extension_settings[EXTENSION_NAME];
    let dirty = false;
    if (!settings || typeof settings !== 'object') {
        settings = structuredClone(DEFAULTS);
        extension_settings[EXTENSION_NAME] = settings;
        dirty = true;
    }

    const previousSchema = Number(settings.schemaVersion || 0);
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
    if (!settings.branchIndex || typeof settings.branchIndex !== 'object') assign('branchIndex', {});
    if (!settings.legacyOwnershipClaims || typeof settings.legacyOwnershipClaims !== 'object') assign('legacyOwnershipClaims', {});
    if (!settings.recoveryHistory || typeof settings.recoveryHistory !== 'object') assign('recoveryHistory', {});
    if (!settings.recoveryGarbage || typeof settings.recoveryGarbage !== 'object') assign('recoveryGarbage', {});

    // One-shot migrations. All changes are saved once at the end rather than once
    // per historical schema step, which matters on older installations.
    if (previousSchema < 2) {
        if (Number(settings.maxNpcs) <= 6) assign('maxNpcs', 40);
        if (Number(settings.scanEvery) >= 2) assign('scanEvery', 1);
    }
    if (previousSchema < 8) {
        const oldDefault = { trust: 50, affection: 20, desire: 0, tension: 10 };
        const current = normalizeRelationshipBaseline(settings.relationshipBaseline);
        if (Object.keys(oldDefault).every(key => current[key] === oldDefault[key])) assign('relationshipBaseline', DEFAULT_RELATIONSHIP, sameJson);
    }
    if (previousSchema < 12) assign('admissionMode', normalizeNpcAdmissionMode(settings.admissionMode || 'conservative'));
    if (previousSchema < 14) {
        const oldThreshold = Math.max(10, Math.min(1000, Math.round(Number(settings.staleNpcAfter) || 50)));
        assign('staleDeleteAfter', oldThreshold);
    }
    if (previousSchema < 15) {
        const legacyDelete = Math.max(11, Math.min(1000, Math.round(Number(settings.staleDeleteAfter ?? settings.staleNpcAfter) || 50)));
        assign('staleDeleteAfter', legacyDelete);
        assign('staleArchiveAfter', Math.max(10, Math.min(999, Math.round(Number(settings.staleArchiveAfter) || Math.min(30, legacyDelete - 1)))));
    }
    if (previousSchema < 19 && isLegacyStockBehaviorCriteriaV024(settings.behaviorCriteria)) {
        // Upgrade only the untouched v0.2.4 stock rubric. User-customized rubrics are preserved.
        assign('behaviorCriteria', DEFAULT_BEHAVIOR_CRITERIA);
    }
    if (previousSchema < 21) {
        // v0.2.9 deliberately slows relationship progression. Migrate only untouched v0.2.8
        // defaults; explicit user tuning remains authoritative.
        if (isLegacyStockRelationshipCapsV028(settings.relationshipCaps)) assign('relationshipCaps', DEFAULT_RELATIONSHIP_CAPS, sameJson);
        if (isLegacyStockRelationshipCriteriaV028(settings.relationshipCriteria)) assign('relationshipCriteria', DEFAULT_RELATIONSHIP_CRITERIA);
        if (isLegacyStockImpactCriteriaV028(settings.relationshipImpactCriteria)) assign('relationshipImpactCriteria', DEFAULT_IMPACT_CRITERIA);
        if (isLegacyStockBehaviorCriteriaV028(settings.behaviorCriteria)) assign('behaviorCriteria', DEFAULT_BEHAVIOR_CRITERIA);
    }
    if (previousSchema < 22) {
        // v0.2.10 adds fractional evidence accumulation and lowers the untouched v0.2.9 stock
        // tier weights to 1/2/5/10. User-customized caps/rubrics remain authoritative.
        if (isLegacyStockRelationshipCapsV029(settings.relationshipCaps)) assign('relationshipCaps', DEFAULT_RELATIONSHIP_CAPS, sameJson);
        if (isLegacyStockRelationshipCriteriaV029(settings.relationshipCriteria)) assign('relationshipCriteria', DEFAULT_RELATIONSHIP_CRITERIA);
        if (isLegacyStockImpactCriteriaV029(settings.relationshipImpactCriteria)) assign('relationshipImpactCriteria', DEFAULT_IMPACT_CRITERIA);
        if (isLegacyStockBehaviorCriteriaV029(settings.behaviorCriteria)) assign('behaviorCriteria', DEFAULT_BEHAVIOR_CRITERIA);
    }
    if (previousSchema < 23) {
        // v0.2.11 stores directional relationship milestone history and exact sibling-swipe
        // checkpoints in per-chat state. NPC/chat normalization performs the data migration;
        // no user-tuned relationship settings are rewritten here.
    }

    // Canonicalize every current setting. This also repairs malformed values from
    // hand-edited settings without requiring a future schema bump.
    if (previousSchema < 28) {
        // v0.2.22 restores low-band mundane progression only for untouched stock rubrics.
        if (isLegacyStockRelationshipCriteriaV0221(settings.relationshipCriteria)) assign('relationshipCriteria', DEFAULT_RELATIONSHIP_CRITERIA);
        if (isLegacyStockImpactCriteriaV0221(settings.relationshipImpactCriteria)) assign('relationshipImpactCriteria', DEFAULT_IMPACT_CRITERIA);
    }
    assign('relationshipBaseline', normalizeRelationshipBaseline(settings.relationshipBaseline), sameJson);
    assign('relationshipCaps', normalizeRelationshipCaps(settings.relationshipCaps), sameJson);
    assign('relationshipCriteria', typeof settings.relationshipCriteria === 'string' ? settings.relationshipCriteria : DEFAULT_RELATIONSHIP_CRITERIA);
    assign('relationshipImpactCriteria', typeof settings.relationshipImpactCriteria === 'string' ? settings.relationshipImpactCriteria : DEFAULT_IMPACT_CRITERIA);
    assign('memoryCriteria', typeof settings.memoryCriteria === 'string' ? settings.memoryCriteria : DEFAULT_MEMORY_CRITERIA);
    assign('behaviorCriteria', typeof settings.behaviorCriteria === 'string' ? settings.behaviorCriteria : DEFAULT_BEHAVIOR_CRITERIA);
    assign('admissionMode', normalizeNpcAdmissionMode(settings.admissionMode));
    assign('injectBudgetTokens', Math.max(512, Math.min(6000, Math.round(Number(settings.injectBudgetTokens) || 1800))));
    assign('fullScanEveryTurn', settings.fullScanEveryTurn === true);
    assign('scannerConnectionProfile', typeof settings.scannerConnectionProfile === 'string' ? settings.scannerConnectionProfile.trim() : '');
    assign('portraitGenerationEnabled', settings.portraitGenerationEnabled !== false);
    assign('portraitThemePreset', PORTRAIT_THEME_PRESETS[settings.portraitThemePreset] ? settings.portraitThemePreset : 'custom');
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
    loadedChatKeys.delete(key);
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
    return next;
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
        branchHistoryCompactionVersion: BRANCH_HISTORY_COMPACTION_VERSION,
        branchHistoryCompaction: null,
        branchParent: null,
        branchForkMessageId: null,
        branchRootSnapshot: null,
        userDismissedGroups: [],
        durableCompactionVersion: DURABLE_COMPACTION_VERSION,
    };
}

function normalizeChatState(raw = {}) {
    const state = { ...freshChatState(), ...(raw && typeof raw === 'object' ? structuredClone(raw) : {}) };
    const hasLegacyBranchData = raw && typeof raw === 'object'
        && !Object.prototype.hasOwnProperty.call(raw, 'branchLineageVersion')
        && ((Array.isArray(raw.lineage) && raw.lineage.length) || (Array.isArray(raw.checkpoints) && raw.checkpoints.length));
    state.branchLineageVersion = hasLegacyBranchData
        ? 0
        : Math.max(0, Number(state.branchLineageVersion || 0));
    state.branchHistoryCompactionVersion = raw && typeof raw === 'object'
        && Object.prototype.hasOwnProperty.call(raw, 'branchHistoryCompactionVersion')
        ? Math.max(0, Number(raw.branchHistoryCompactionVersion || 0))
        : 0;
    state.branchHistoryCompaction = raw?.branchHistoryCompaction && typeof raw.branchHistoryCompaction === 'object'
        ? structuredClone(raw.branchHistoryCompaction)
        : null;
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
    state.userDismissedGroups = promoteLegacyUserDismissedGroups(state.userDismissedGroups, [
        state.npcs,
        ...(state.checkpoints || []).map(checkpoint => checkpoint?.snapshot?.npcs || []),
        state.branchRootSnapshot?.npcs || [],
    ]);
    state.durableCompactionVersion = DURABLE_COMPACTION_VERSION;
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
    if (markLoaded) { loadedChatKeys.add(key); hydrationErrors.delete(key); }
    stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
    return normalized;
}
function chatHydrationStatus(key = getChatKey()) {
    if (!key || key === 'no-chat') return 'none';
    if (!isCanonicalChatKey(key)) return 'pending';
    if (loadedChatKeys.has(key)) return 'ready';
    if (loadingChatStates.has(key)) return 'loading';
    if (hydrationErrors.has(key)) return 'error';
    return 'idle';
}
function assertChatHydratedForWrite(key = getChatKey()) {
    if (!key || key === 'no-chat') return;
    const pointer = getSettings().dataFiles?.[key];
    if (pointer?.path && !loadedChatKeys.has(key)) throw new Error('Refusing to overwrite unhydrated NPC State Delta sidecar for ' + key + '.');
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
        await ensureChatStateLoaded(key);
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
    bumpOwnershipEpoch(key);
    settings.recoveryFiles[key] = { ...pointer, reason: 'manual-detach', retiredAt: Date.now() };
    settings.sidecarTombstones[key] = { reason: 'manual-detach', at: Date.now() };
    delete settings.dataFiles[key];
    chatStateCache.delete(key);
    loadedChatKeys.delete(key);
    hydrationErrors.delete(key);
    stateVersions.delete(key);
    persistedVersions.delete(key);
    stateWritePromises.delete(key);
    const state = setChatState(key, freshChatState(), { markLoaded: true });
    state.lineage = chatLineage(getContext().chat || []);
    recordBranchIndex(key, state);
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

async function ensureChatStateLoaded(key = getChatKey()) {
    if (!key || key === 'no-chat' || !isCanonicalChatKey(key)) return freshChatState();
    if (loadedChatKeys.has(key)) return getChatState(key);
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
            try {
                const recovered = await readNpcStateDataFile(recoveryPointer, { expectedChatKey: key });
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
            } catch (error) {
                if (error?.code === 'NPC_STATE_STALE_OWNERSHIP') throw error;
                if (!/404|not found/i.test(String(error?.message || error))) console.debug(`[NPC State Delta] deterministic sidecar recovery skipped for ${key}.`, error);
            }
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
        const legacy = settings.chats && typeof settings.chats === 'object' ? settings.chats[key] : null;
        const sourceState = loaded || legacy || freshChatState();
        const needsDurableCompactionWrite = Boolean(loaded)
            && Number(sourceState?.durableCompactionVersion || 0) < DURABLE_COMPACTION_VERSION;
        const state = setChatState(key, sourceState, { markLoaded: true });
        if (loaded && !loadedUndurable && !needsDurableCompactionWrite) persistedVersions.set(key, Number(stateVersions.get(key) || 0));
        if (recordBranchIndex(key, state)) persistSettings();
        if ((!loaded && legacy) || needsDurableCompactionWrite) {
            try {
                await flushStateFile(key);
                assertOwnershipEpoch(key, epoch);
                if (!loaded && legacy) {
                    delete settings.chats[key];
                    if (settings.chats && Object.keys(settings.chats).length === 0) delete settings.chats;
                    persistSettings();
                    console.info(`[NPC State Delta] migrated ${key} from extension settings into its own JSON data file.`);
                } else if (needsDurableCompactionWrite) {
                    console.info(`[NPC State Delta] compacted legacy durable dossier summaries for ${key}.`);
                }
            } catch (error) {
                if (error?.code === 'NPC_STATE_STALE_OWNERSHIP') throw error;
                const action = !loaded && legacy ? 'legacy state migration' : 'durable dossier compaction migration';
                console.warn(`[NPC State Delta] ${action} for ${key} could not be written yet.`, error);
            }
        }
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

function branchIndexEntry(key, state) {
    const lineage = Array.isArray(state?.lineage) ? state.lineage : [];
    return {
        ownerScope: chatOwnerScope(key),
        head: lineage.slice(0, BRANCH_INDEX_PREFIX_LIMIT),
        checkpointIds: (Array.isArray(state?.checkpoints) ? state.checkpoints : [])
            .map(item => Number(item?.messageId))
            .filter(Number.isInteger)
            .slice(-12),
        updatedAt: Date.now(),
    };
}

function recordBranchIndex(key, state) {
    if (!isCanonicalChatKey(key)) return false;
    const settings = getSettings();
    const next = branchIndexEntry(key, state);
    const previous = settings.branchIndex?.[key];
    const stablePrevious = previous ? { ...previous, updatedAt: 0 } : null;
    const stableNext = { ...next, updatedAt: 0 };
    if (JSON.stringify(stablePrevious) === JSON.stringify(stableNext)) return false;
    settings.branchIndex[key] = next;
    return true;
}

function likelyAncestorKeys(currentKey, currentChat = []) {
    const settings = getSettings();
    const lineage = chatLineage(currentChat);
    const ownerScope = chatOwnerScope(currentKey);
    if (!ownerScope || lineage.length < 4) return [];
    const matches = [];
    for (const [key, entry] of Object.entries(settings.branchIndex || {})) {
        if (key === currentKey || !isCanonicalChatKey(key) || !sameChatOwnerScope(key, currentKey) || entry?.ownerScope !== ownerScope || !Array.isArray(entry?.head)) continue;
        let prefix = 0;
        const max = Math.min(lineage.length, entry.head.length);
        while (prefix < max && lineage[prefix] === entry.head[prefix]) prefix += 1;
        if (prefix >= 4) matches.push({ key, prefix, updatedAt: Number(entry.updatedAt || 0) });
    }
    return matches.sort((a, b) => b.prefix - a.prefix || b.updatedAt - a.updatedAt).slice(0, BRANCH_INDEX_MAX_CANDIDATES).map(item => item.key);
}

async function ensureLikelyAncestorStatesLoaded(currentKey, currentChat = []) {
    const settings = getSettings();
    const indexed = likelyAncestorKeys(currentKey, currentChat);
    const legacy = Object.entries(settings.dataFiles || {})
        .filter(([key]) => key !== currentKey && isCanonicalChatKey(key) && sameChatOwnerScope(key, currentKey) && !settings.branchIndex?.[key])
        .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
        .slice(0, LEGACY_BRANCH_DISCOVERY_LIMIT)
        .map(([key]) => key);
    const candidates = [...new Set([...indexed, ...legacy])];
    await Promise.all(candidates.map(key => ensureChatStateLoaded(key).catch(() => null)));
    return candidates;
}

async function migrateLegacyChatStates() {
    // v0.2.17 no longer hydrates unqualified legacy keys globally. Ownership is claimed lazily
    // by migrateActiveLegacyNamespace() only when active-chat lineage proves the match.
    return false;
}

function markStateDirty(key = getChatKey()) {
    if (!key || key === 'no-chat') return;
    stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
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
            const written = await writeNpcStateDataFile({
                chatKey: key,
                state: snapshot,
                recoveryState: () => chatStateCache.get(key) || snapshot,
                isCurrent: () => ownershipEpochCurrent(key, epoch),
                appVersion: NPC_STATE_VERSION,
                pointer: settings.dataFiles?.[key] || pointer,
                headers: requestHeaders(),
            });
            if (!ownershipEpochCurrent(key, epoch)) return written;
            pointer = written;
            settings.dataFiles[key] = pointer;
            delete settings.sidecarTombstones[key];
            recordBranchIndex(key, snapshot);
            persistedVersions.set(key, writeVersion);
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

function commitBranchCheckpoint(state, messageId, reason = 'state') {
    recordBranchCheckpoint(state, getContext().chat || [], messageId, reason);
    return state;
}

function seedBranchTracking(state = getChatState()) {
    const chat = getContext().chat || [];
    if (Number(state?.branchLineageVersion || 0) < BRANCH_LINEAGE_VERSION) migrateLegacyBranchState(state, chat);
    const lineage = chatLineage(chat);
    if (!Array.isArray(state.lineage) || state.lineage.length === 0) state.lineage = lineage;
    if (!Array.isArray(state.checkpoints)) state.checkpoints = [];

    if (Number(state.branchHistoryCompactionVersion || 0) < BRANCH_HISTORY_COMPACTION_VERSION) {
        const compaction = compactLegacyBranchHistory(state, chat);
        const key = getChatKey();
        if (!compaction.deferred && key !== 'no-chat' && loadedChatKeys.has(key) && chatStateCache.get(key) === state) {
            // Persist the one-time marker even when there was nothing to remove. Otherwise every
            // reload would repeat the same legacy proof walk and branch-size accounting.
            queueStateFileWrite(key, 0);
        }
    }
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
        historyCompactionVersion: Number(state.branchHistoryCompactionVersion || 0),
        lastCompaction: state.branchHistoryCompaction && typeof state.branchHistoryCompaction === 'object'
            ? structuredClone(state.branchHistoryCompaction)
            : null,
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
        const userTurns = chat.filter(message => message?.is_user).length;
        if (!hasExplicitParent && (chat.length < 4 || userTurns < 2)) return false;

        if (hasExplicitParent) await ensureChatStateLoaded(explicitParentKey).catch(error => console.debug(`[NPC State Delta] explicit branch parent ${explicitParentKey} could not be hydrated.`, error));
        else await ensureLikelyAncestorStatesLoaded(key, chat);
        if (getChatKey() !== key || firstLineageDivergence(lineageAtStart, chatLineage(getContext().chat || [])) !== -1) return false;
        const scopedStates = Object.fromEntries([...chatStateCache.entries()].filter(([candidate]) => sameChatOwnerScope(candidate, key)));
        const inherited = bestAncestorState(scopedStates, key, chat);
        if (!inherited) return false;
        setChatState(key, { ...freshChatState(), ...inherited });
        queueStateFileWrite(key, 0);
        return true;
    } finally {
        evictDormantChatStates(key);
    }
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
    const result = reconcileBranchState(before, ctx.chat || [], { explicitDivergence, operation });
    if (getChatKey() !== key || firstLineageDivergence(lineageBefore, chatLineage(getContext().chat || [])) !== -1) return null;
    if (Number(result.state?.branchHistoryCompactionVersion || 0) < BRANCH_HISTORY_COMPACTION_VERSION) {
        compactLegacyBranchHistory(result.state, ctx.chat || []);
    }
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

async function drainPendingAutoScan(chatKey) {
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
        await processPendingBackfills(pending.messageId);
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
    loadedChatKeys.delete(key);
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
    if (loadedChatKeys.has(key) && chatStateCache.has(key)) return structuredClone(getChatState(key));
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
            const state = await loadLatestLifecycleState(key, pointer, settings.chats?.[key] || null, { fallbackOnMissing: true });
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
                if (error?.code !== 'NPC_STATE_WRITE_CONFLICT' || attempt >= 3) throw error;
                console.info(`[NPC State Delta] delete retirement raced another writer for ${key}; retrying from the newest revision.`);
            }
        }
        if (!retired) return false;
    } catch (error) {
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
    delete settings.branchIndex[key];
    if (settings.chats?.[key]) delete settings.chats[key];
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
    const oldInline = settings.chats?.[oldKey] || null;
    if (!oldPointerInitial?.path && !oldInline && !chatStateCache.has(oldKey)) return false;

    let destinationPointer = settings.dataFiles?.[newKey] || null;
    let destinationState = null;
    if (destinationPointer?.path) {
        try { destinationState = await loadLatestLifecycleState(newKey, destinationPointer, settings.chats?.[newKey] || null); }
        catch (error) { console.warn(`[NPC State Delta] rename could not verify destination ${newKey}.`, error); return false; }
    }
    const destinationCache = chatStateCache.get(newKey) || null;
    const destinationInline = settings.chats?.[newKey] || null;
    const destinationRepresentations = [destinationState, destinationCache, destinationInline].filter(value => value && typeof value === 'object');
    const destinationEphemeral = destinationRepresentations.every(stateLooksEmptyForLifecycleRename);
    if ((destinationPointer?.path || settings.chats?.[newKey] || chatStateCache.has(newKey)) && !destinationEphemeral) {
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
            state = await loadLatestLifecycleState(oldKey, oldPointer, oldInline);
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
        if (settings.branchIndex?.[oldKey]) {
            settings.branchIndex[newKey] = { ...structuredClone(settings.branchIndex[oldKey]), ownerScope: chatOwnerScope(newKey), updatedAt: Date.now() };
            delete settings.branchIndex[oldKey];
        }
        if (settings.chats?.[oldKey]) {
            settings.chats[newKey] = settings.chats[oldKey];
            delete settings.chats[oldKey];
        }
        if (settings.chats && Object.keys(settings.chats).length === 0) delete settings.chats;
        const installed = setChatState(newKey, state, { markLoaded: true });
        recordBranchIndex(newKey, installed);
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

function legacyMigrationMatchesActiveChat(state, chat = getContext().chat || []) {
    const stored = Array.isArray(state?.lineage) ? state.lineage : [];
    const messages = Array.isArray(chat) ? chat : [];
    if (!stored.length || !messages.length) return false;
    const candidates = [chatLineage(messages), legacyChatLineageV0210(messages)];
    for (const current of candidates) {
        const common = firstLineageDivergence(stored, current);
        const prefix = common < 0 ? Math.min(stored.length, current.length) : common;
        const required = Math.min(4, stored.length, current.length);
        const userTurns = messages.slice(0, required).filter(message => message?.is_user).length;
        if (required >= 4 && prefix >= required && userTurns >= 2) return true;
    }
    return false;
}

async function migrateActiveLegacyNamespace() {
    const identity = getChatIdentity();
    const oldKey = identity.legacyCandidateKey || identity.legacyKey || '';
    if (identity.pending || !isCanonicalChatKey(identity.key) || !oldKey) return false;
    const newKey = identity.key;
    const settings = getSettings();
    if (settings.dataFiles?.[newKey] || chatStateCache.has(newKey)) return false;
    const oldPointer = settings.dataFiles?.[oldKey] || null;
    const oldInline = settings.chats?.[oldKey] || null;
    if (!oldPointer?.path && !oldInline) return false;
    const existingClaim = settings.legacyOwnershipClaims?.[oldKey];
    if (existingClaim?.canonicalKey && existingClaim.canonicalKey !== newKey) {
        console.warn(`[NPC State Delta] refused legacy ownership claim for ${oldKey}; it is already claimed by ${existingClaim.canonicalKey}.`);
        return false;
    }

    const oldEpoch = bumpOwnershipEpoch(oldKey);
    const newEpoch = bumpOwnershipEpoch(newKey);
    try {
        let rawState = oldInline;
        if (oldPointer?.path) {
            const payload = await readNpcStateDataFile(oldPointer, { expectedChatKey: oldKey });
            assertOwnershipEpoch(oldKey, oldEpoch);
            if (payload?.retired || !payload?.state) return false;
            rawState = payload.state;
        }
        const state = normalizeChatState(rawState || {});
        if (!legacyMigrationMatchesActiveChat(state, getContext().chat || [])) {
            console.warn(`[NPC State Delta] preserved ambiguous legacy sidecar ${oldKey}; active conversation lineage did not prove ownership for ${newKey}.`);
            return false;
        }
        // Ownership proof uses the legacy lineage first. Only after that proof succeeds do we
        // migrate old swipe-index/checkpoint state against the active conversation, ensuring the
        // newly qualified sidecar is canonical branch-lineage v2 from its first durable write.
        seedBranchTracking(state);
        const newPointer = await writeNpcStateDataFile({ chatKey: newKey, state, appVersion: NPC_STATE_VERSION, pointer: { name: makeNpcStateDataFileName(newKey) }, continuousRetry: false, headers: requestHeaders() });
        assertOwnershipEpoch(newKey, newEpoch);
        const verified = await readNpcStateDataFile(newPointer, { expectedChatKey: newKey });
        assertOwnershipEpoch(newKey, newEpoch);
        if (!verified?.state || verified.retired) throw new Error('NPC State Delta qualified namespace migration verification failed.');

        const recoveryPointer = await writeNpcStateDataFile({ chatKey: oldKey, state, appVersion: NPC_STATE_VERSION, pointer: { name: makeNpcStateRecoveryFileName(oldKey) }, continuousRetry: false, headers: requestHeaders() });
        assertOwnershipEpoch(oldKey, oldEpoch);
        if (oldPointer?.path) await retireNpcStateDataFile({ chatKey: oldKey, pointer: oldPointer, reason: `qualified-namespace-migrated:${newKey}`, appVersion: NPC_STATE_VERSION, headers: requestHeaders() });

        settings.recoveryFiles[oldKey] = { ...recoveryPointer, reason: `qualified-namespace-migrated:${newKey}`, retiredAt: Date.now() };
        settings.sidecarTombstones[oldKey] = { reason: `qualified-namespace-migrated:${newKey}`, at: Date.now() };
        settings.legacyOwnershipClaims[oldKey] = { canonicalKey: newKey, ownerId: identity.ownerId, kind: identity.kind, at: Date.now() };
        settings.dataFiles[newKey] = newPointer;
        delete settings.dataFiles[oldKey];
        delete settings.branchIndex[oldKey];
        if (settings.chats?.[oldKey]) delete settings.chats[oldKey];
        if (settings.chats && Object.keys(settings.chats).length === 0) delete settings.chats;
        chatStateCache.delete(oldKey);
        loadedChatKeys.delete(oldKey);
        hydrationErrors.delete(oldKey);
        stateVersions.delete(oldKey);
        persistedVersions.delete(oldKey);
        stateWritePromises.delete(oldKey);
        pendingAutoScans.delete(oldKey);
        const installed = setChatState(newKey, state, { markLoaded: true });
        recordBranchIndex(newKey, installed);
        persistedVersions.set(newKey, Number(stateVersions.get(newKey) || 0));
        persistSettings();
        if (oldPointer?.path) {
            try { await deleteNpcStateDataFile(oldPointer, { headers: requestHeaders() }); } catch {}
        }
        console.info(`[NPC State Delta] migrated legacy ownership ${oldKey} -> ${newKey}.`);
        return true;
    } catch (error) {
        if (error?.code !== 'NPC_STATE_STALE_OWNERSHIP') console.warn(`[NPC State Delta] qualified namespace migration failed for ${oldKey}; legacy state remains recoverable.`, error);
        return false;
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
    const keys = new Set([...chatStateCache.keys(), ...loadedChatKeys, ...loadingChatStates.keys()]);
    let count = 0;
    for (const key of keys) {
        const parsed = parseQualifiedChatKey(key);
        if (parsed?.kind === kind && parsed.ownerId === owner && clearLifecycleCacheKey(key, 'owner-lifecycle')) count += 1;
    }
    return count;
}

function flushCurrentChatOnPageHide() {
    const key = getChatKey();
    if (key === 'no-chat' || !loadedChatKeys.has(key) || !chatStateCache.has(key)) return;
    void settleStateFileWrite(key, { flush: true }).catch(error => console.debug('[NPC State Delta] page-hide flush deferred', error));
}

function cleanMessage(message) {
    if (!message || message.is_system) return '';
    const speaker = message.name || (message.is_user ? getContext().name1 : getContext().name2) || '';
    const body = stripUiNoise(message.mes || '');
    return body ? `${speaker}: ${body}` : '';
}

function recentTranscript(limit = null, { messageIds = false } = {}) {
    const settings = getSettings();
    const chat = getContext().chat || [];
    const count = Math.max(2, Math.min(30, Number(limit ?? settings.scanDepth) || 6));
    const lines = [];
    // Walk backward and stop as soon as the requested meaningful window is full.
    // Long chats no longer pay to clean every historical message on each scan/injection.
    for (let i = chat.length - 1; i >= 0 && lines.length < count; i -= 1) {
        if (!chat[i] || chat[i].is_system) continue;
        const line = cleanMessage(chat[i]);
        if (line) lines.push(messageIds ? `[m${i}] ${line}` : line);
    }
    return lines.reverse().join('\n');
}

function recentUserDevelopmentContext(limit = null, { messageIds = true } = {}) {
    const settings = getSettings();
    const chat = getContext().chat || [];
    const count = Math.max(2, Math.min(30, Number(limit ?? settings.scanDepth) || 6));
    const selected = [];
    let meaningful = 0;
    for (let i = chat.length - 1; i >= 0 && meaningful < count; i -= 1) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const line = cleanMessage(message);
        if (!line) continue;
        meaningful += 1;
        if (message.is_user) selected.push(messageIds ? `[m${i}] ${line}` : line);
    }
    return selected.reverse().join('\n');
}

function currentExchangeUserDevelopmentContext(messageId = null) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let assistantId = Number.isInteger(messageId) ? messageId : chat.length - 1;
    while (assistantId >= 0 && (chat[assistantId]?.is_system || chat[assistantId]?.is_user)) assistantId -= 1;
    if (assistantId < 0) return '';
    for (let i = assistantId - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) {
            const line = cleanMessage(chat[i]);
            return line ? `[m${i}] ${line}` : '';
        }
        break;
    }
    return '';
}

function currentExchangeTranscript(messageId = null) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let assistantId = Number.isInteger(messageId) ? messageId : chat.length - 1;
    while (assistantId >= 0 && (chat[assistantId]?.is_system || chat[assistantId]?.is_user)) assistantId -= 1;
    if (assistantId < 0) return recentTranscript(2);
    let userId = -1;
    for (let i = assistantId - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_system) continue;
        if (chat[i]?.is_user) { userId = i; break; }
        // Do not walk across an older assistant turn looking for a distant user message.
        if (!chat[i]?.is_user) break;
    }
    return [userId >= 0 ? chat[userId] : null, chat[assistantId]]
        .filter(Boolean)
        .map(cleanMessage)
        .filter(Boolean)
        .join('\n');
}

function currentExclusions() {
    const ctx = getContext();
    return [ctx.name1, ctx.name2].filter(Boolean);
}

function updateInjection() {
    const settings = getSettings();
    const ctx = getContext();
    const injectionKey = getChatKey();
    if (injectionKey !== 'no-chat' && chatHydrationStatus(injectionKey) !== 'ready') {
        ctx.setExtensionPrompt?.(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }
    if (!settings.enabled || !settings.inject || getChatKey() === 'no-chat') {
        ctx.setExtensionPrompt?.(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }
    const state = getChatState();
    const prompt = buildInjection(state.npcs, recentTranscript(4), state.turn, settings.injectLimit, settings.behaviorCriteria, settings.injectBudgetTokens, state.socialGraph);
    ctx.setExtensionPrompt?.(
        PROMPT_KEY,
        prompt,
        extension_prompt_types.IN_CHAT,
        Math.max(0, Math.min(20, Number(settings.injectDepth) || 1)),
        false,
        extension_prompt_roles.SYSTEM,
    );
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
    const role = normalizeName(npc.role);
    return Boolean(role && (role.includes(target) || target.includes(role)));
}

function transcriptMentionsBackfillTarget(transcript, label) {
    const target = normalizeName(label);
    const haystack = normalizeName(transcript);
    if (!target || !haystack) return false;
    return (` ${haystack} `).includes(` ${target} `);
}

function transcriptMentionsNpcRecord(transcript, npc) {
    const haystack = ` ${normalizeName(transcript)} `;
    if (!haystack.trim() || !npc) return false;
    const labels = [npc.name, ...(npc.aliases || [])]
        .map(normalizeName)
        .filter(label => label.length >= 2);
    return labels.some(label => haystack.includes(` ${label} `));
}

function currentExchangeRelationshipRelevant(npc, transcript, raw = null, { currentExchangeOnly = false } = {}) {
    if (!npc || npc.archived) return false;
    // Full-window reconciliation must never turn historical presence or a previous live flag
    // into a fresh relationship event. Only an explicit name/alias participation cue in the
    // current exchange can make an omitted existing dossier a relationship target. Quick scans
    // already operate on the current exchange, so their returned row remains sufficient.
    if (transcriptMentionsNpcRecord(transcript, npc)) return true;
    if (currentExchangeOnly) return false;
    return Boolean(raw);
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

async function scanNpcDossier(npcId) {
    const id = String(npcId || '').trim();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!id || chatKey === 'no-chat' || !requireReadyChatMutation('scan a dossier', chatKey)) return false;
    if (isScanBusy(chatKey)) {
        globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === id);
    if (!existing) return false;
    const sources = findMeguminDossierSources(existing, ctx.chat || []);
    if (!sources.length) {
        globalThis.toastr?.info?.(`NPC State Delta: no matching Megumin dossier block found for ${existing.name}; scanning recent story context instead.`);
        return backfillNpcFromHistory({ npcId: existing.id, label: existing.name, requestedAt: Date.now() }, latestMessageId(true));
    }
    const sourceText = sources.map(item => `[message ${item.messageId + 1} · ${item.kind}]\n${item.text}`).join('\n\n');
    const lineage = chatLineage(ctx.chat || []);
    const prompt = buildDossierImportPrompt({
        dossierText: sourceText,
        targetName: existing.name,
        existingNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
    });
    const scanStateVersion = Number(stateVersions.get(chatKey) || 0);
    const operation = beginScanOperation(chatKey, `dossier import for ${existing.name}`, { npcId: id, indicator: 'dossier' });
    if (!operation) {
        globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    setScanIndicator(true);
    setNpcDossierScanIndicator(id, true);
    try {
        const { parsed } = await generateParsedNpcJson(ctx, {
            systemPrompt: "You are NPC State Delta's isolated structured dossier importer. Use only the supplied dossier payload. Return only the requested JSON object.",
            prompt,
            responseLength: BACKFILL_RESPONSE_LENGTH,
            label: `dossier import for ${existing.name}`,
            requestScope: operation.requestScope,
        });
        if (!scanOperationCurrent(chatKey, operation)) {
            console.info('[NPC State Delta] discarded expired or superseded dossier import.');
            return false;
        }
        const currentLineage = chatLineage(getContext().chat || []);
        if (getChatKey() !== chatKey || firstLineageDivergence(lineage, currentLineage) !== -1 || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
            globalThis.toastr?.info?.('NPC State Delta: chat changed during dossier import; stale result was discarded.');
            return false;
        }
        const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
        const match = returned.find(npc => backfillScanMatchesTarget(npc, { npcId: id, label: existing.name })) || (returned.length === 1 ? returned[0] : null);
        if (!match) {
            globalThis.toastr?.warning?.(`NPC State Delta: the dossier importer did not return ${existing.name}.`);
            return false;
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
        const latest = getChatState(chatKey);
        const targetMessageId = latestMessageId(true);
        const merged = mergeScanResult(latest, parsed, {
            maxNpcs: getSettings().maxNpcs,
            excludeNames: [...currentExclusions(), ...(latest.dismissed || [])],
            turn: latest.turn,
            sourceMessageId: targetMessageId,
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
            relationshipBaseline: getSettings().relationshipBaseline,
            relationshipCaps: getSettings().relationshipCaps,
            autoArchiveDeaths: getSettings().autoArchiveDeaths !== false,
            autoReactivateArchived: getSettings().autoReactivateArchived !== false,
            admissionMode: getSettings().admissionMode,
            preservePresence: true,
            skipRelationshipUpdate: true,
            developmentContext: sourceText,
            userDevelopmentContext: sourceText,
        });
        const nextState = merged.state;
        if (targetMessageId >= 0) commitBranchCheckpoint(nextState, targetMessageId, 'dossier-import');
        setChatState(chatKey, nextState);
        persist();
        renderDossier();
        updateInjection();
        const saved = nextState.npcs.find(npc => npc.id === id);
        globalThis.toastr?.success?.(`NPC State Delta: imported ${saved?.name || existing.name} from ${sources.length} Megumin dossier block${sources.length === 1 ? '' : 's'}.`);
        return true;
    } catch (error) {
        console.error('[NPC State Delta] structured dossier import failed', error);
        globalThis.toastr?.warning?.(`NPC State Delta dossier import failed for ${existing.name}: ${error?.message || error}`);
        return false;
    } finally {
        const owned = scanOperationCurrent(chatKey, operation);
        endScanOperation(chatKey, operation);
        if (getChatKey() === chatKey) setScanIndicator(isScanBusy(chatKey));
        if (owned) setNpcDossierScanIndicator(id, false);
        updateInjection();
    }
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
    set('npc_state_delta_edit_species', npc.species || '');
    set('npc_state_delta_edit_home_base', npc.homeBase || '');
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
    const fields = ['name','role','species','homeBase','age','apparentAge','appearance','personality','speech','behaviorProfile','background','keyRelationships','relationshipSummary','mood','location','goal','status','lifeState','mannerisms','memories'];
    return fields.filter(field => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
}

async function refreshNpcFromChat(npcId) {
    const id = String(npcId || '').trim();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!id || chatKey === 'no-chat' || !requireReadyChatMutation('refresh a dossier', chatKey)) return false;
    if (isScanBusy(chatKey)) {
        globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    // Preserve any edits currently visible in this dossier before reading history. Otherwise
    // the old popup values could overwrite a successful refresh when Save is clicked later.
    if (editorIsMounted()) saveNpcEditor(id, { close: false, silent: true });
    const settings = getSettings();
    const state = getChatState(chatKey);
    const existing = state.npcs.find(npc => npc.id === id);
    if (!existing) return false;
    const transcript = recentTranscript(settings.scanDepth, { messageIds: true });
    const developmentSourceMessageIds = [...transcript.matchAll(/^\[m(\d+)\]/gm)]
        .map(match => Number(match[1])).filter(Number.isInteger);
    if (!transcript) {
        globalThis.toastr?.info?.(`NPC State Delta: no recent story text is available to refresh ${existing.name}.`);
        return false;
    }
    const before = structuredClone(existing);
    const lineage = chatLineage(ctx.chat || []);
    const refreshStartedAt = performance.now?.() ?? Date.now();
    const prompt = buildProfileRefreshPrompt({
        transcript,
        targetNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
    });
    const scanStateVersion = Number(stateVersions.get(chatKey) || 0);
    const operation = beginScanOperation(chatKey, `chat refresh for ${existing.name}`, { npcId: id, indicator: 'refresh' });
    if (!operation) {
        globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        return false;
    }
    setScanIndicator(true);
    setNpcChatRefreshIndicator(id, true);
    try {
        const { parsed, raw, retried } = await generateParsedNpcJson(ctx, {
            systemPrompt: "You are NPC State Delta's targeted dossier reconciliation scanner. Re-read the supplied recent-story window for exactly one existing NPC. Return only the requested JSON object.",
            prompt,
            responseLength: BACKFILL_RESPONSE_LENGTH,
            label: `chat refresh for ${existing.name}`,
            requestScope: operation.requestScope,
        });
        if (!scanOperationCurrent(chatKey, operation)) {
            console.info('[NPC State Delta] discarded expired or superseded dossier refresh.');
            return false;
        }
        const currentLineage = chatLineage(getContext().chat || []);
        if (getChatKey() !== chatKey || firstLineageDivergence(lineage, currentLineage) !== -1 || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
            globalThis.toastr?.info?.('NPC State Delta: chat or dossier state changed during dossier refresh; stale result was discarded.');
            return false;
        }
        const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
        let match = returned.find(npc => backfillScanMatchesTarget(npc, { npcId: id, label: existing.name }));
        if (!match && returned.length === 1) match = returned[0];
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
            const profile = rawProfileUpdates.find(item => String(item?.id || '') === id || (item?.name && npcMatchesLabel(existing, item.name))) || (rawProfileUpdates.length === 1 ? rawProfileUpdates[0] : null);
            parsed.profileUpdates = profile ? [{ ...profile, id, name: existing.name }] : [];
        }
        const edgeTouchesTarget = edge => String(edge?.aId || edge?.a_id || '') === id
            || String(edge?.bId || edge?.b_id || '') === id
            || npcMatchesLabel(existing, edge?.a || edge?.from || edge?.source || '')
            || npcMatchesLabel(existing, edge?.b || edge?.to || edge?.target || '');
        const localEdges = extractExplicitKeyRelationshipEdges(transcript, state.npcs, currentExclusions()).filter(edgeTouchesTarget);
        const modelEdges = (Array.isArray(parsed.keyRelationshipEdges) ? parsed.keyRelationshipEdges : []).filter(edgeTouchesTarget);
        parsed.keyRelationshipEdges = [...modelEdges, ...localEdges];
        if (!parsed.npcs.length && !(parsed.profileUpdates || []).length && !parsed.keyRelationshipEdges.length) {
            lastScanMetrics = {
                label: 'targeted-refresh',
                durationMs: Math.max(0, Math.round((performance.now?.() ?? Date.now()) - refreshStartedAt)),
                promptChars: prompt.length,
                responseChars: String(raw ?? '').length,
                retried: Boolean(retried),
                relationshipPass: false,
                relationshipTargets: 0,
                relationshipResponseChars: 0,
                relationshipRetried: false,
                relationshipEdges: 0,
                relationshipEdgeFallbacks: localEdges.length,
                profileUpdates: 0,
                profileApplied: 0,
                profileEvidenceAdded: 0,
                profileDevelopment: [],
                at: Date.now(),
            };
            recordScanDiagnostics(chatKey, lastScanMetrics, parsed, null, {
                targeted: true,
                npcIds: [id],
                sourceMessageId: latestMessageId(true),
            });
            globalThis.toastr?.info?.(`NPC State Delta: no grounded dossier changes found for ${existing.name} in the last ${settings.scanDepth} messages.`);
            return true;
        }
        const latest = getChatState(chatKey);
        const liveBefore = latest.npcs.find(npc => npc.id === id);
        if (!liveBefore) return false;
        const targetMessageId = latestMessageId(true);
        const merged = mergeScanResult(latest, parsed, {
            maxNpcs: settings.maxNpcs,
            excludeNames: [...currentExclusions(), ...(latest.dismissed || [])],
            turn: latest.turn,
            sourceMessageId: targetMessageId,
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
            relationshipBaseline: settings.relationshipBaseline,
            relationshipCaps: settings.relationshipCaps,
            autoArchiveDeaths: settings.autoArchiveDeaths !== false,
            autoReactivateArchived: false,
            admissionMode: settings.admissionMode,
            preservePresence: true,
            skipRelationshipUpdate: true,
            memoryInputLimit: IMPORTANT_MEMORY_LIMIT,
            allowTargetedDurableSeed: true,
            developmentSourceMessageIds,
            developmentContext: transcript,
            userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
        });
        // A targeted refresh may use social-edge machinery internally, but it must never
        // mutate a second dossier as a side effect. Restore every non-target record verbatim.
        const latestById = new Map((latest.npcs || []).map(npc => [npc.id, structuredClone(npc)]));
        merged.state.npcs = (merged.state.npcs || []).map(npc => npc.id === id ? npc : (latestById.get(npc.id) || npc));
        const refreshed = merged.state.npcs.find(npc => npc.id === id);
        if (!refreshed) return false;
        // Manual history reconciliation must never pretend the NPC was just seen or change
        // current presence merely because an older message in the window mentioned them.
        refreshed.present = Boolean(liveBefore.present);
        refreshed.worldActive = Boolean(liveBefore.worldActive);
        refreshed.lastSeenTurn = liveBefore.lastSeenTurn;
        refreshed.lastWorldActiveTurn = liveBefore.lastWorldActiveTurn;
        refreshed.seenCount = liveBefore.seenCount;
        refreshed.relationship = structuredClone(liveBefore.relationship || DEFAULT_RELATIONSHIP);
        refreshed.lastRelationshipChange = structuredClone(liveBefore.lastRelationshipChange || refreshed.lastRelationshipChange);
        const proposedSummary = String(match?.relationshipSummary ?? match?.relationship_summary ?? '').trim().slice(0, 900);
        if (proposedSummary && !(liveBefore.manualProfileFields || []).includes('relationshipSummary')) refreshed.relationshipSummary = proposedSummary;
        Object.assign(refreshed, protectTerminalNpc(liveBefore, refreshed));
        if (targetMessageId >= 0) commitBranchCheckpoint(merged.state, targetMessageId, 'chat-refresh');
        setChatState(chatKey, merged.state);
        persist();
        renderDossier();
        updateInjection();
        const saved = getChatState(chatKey).npcs.find(npc => npc.id === id);
        syncOpenNpcEditorFields(saved);
        const changed = refreshChangedFields(before, saved);
        lastScanMetrics = {
            label: 'targeted-refresh',
            durationMs: Math.max(0, Math.round((performance.now?.() ?? Date.now()) - refreshStartedAt)),
            promptChars: prompt.length,
            responseChars: String(raw ?? '').length,
            retried: Boolean(retried),
            relationshipPass: false,
            relationshipTargets: 0,
            relationshipResponseChars: 0,
            relationshipRetried: false,
            relationshipEdges: parsed.keyRelationshipEdges.length,
            relationshipEdgeFallbacks: localEdges.length,
            profileUpdates: (parsed.profileUpdates || []).length,
            profileApplied: Number(merged.report?.profileUpdateStats?.applied || 0),
            profileEvidenceAdded: Number(merged.report?.profileUpdateStats?.evidenceAdded || 0),
            profileDevelopment: Array.isArray(merged.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [],
            at: Date.now(),
        };
        recordScanDiagnostics(chatKey, lastScanMetrics, parsed, merged.report, {
            targeted: true,
            npcIds: [id],
            sourceMessageId: targetMessageId,
        });
        console.info('[NPC State Delta] targeted refresh metrics', lastScanMetrics);
        globalThis.toastr?.success?.(changed.length
            ? `NPC State Delta: refreshed ${saved?.name || existing.name} from the last ${settings.scanDepth} messages (${changed.join(', ')}).`
            : `NPC State Delta: ${saved?.name || existing.name} is already consistent with the last ${settings.scanDepth} messages.`);
        return true;
    } catch (error) {
        console.error('[NPC State Delta] targeted chat refresh failed', error);
        globalThis.toastr?.warning?.(`NPC State Delta refresh failed for ${existing.name}: ${error?.message || error}`);
        return false;
    } finally {
        const owned = scanOperationCurrent(chatKey, operation);
        endScanOperation(chatKey, operation);
        if (getChatKey() === chatKey) setScanIndicator(isScanBusy(chatKey));
        if (owned) setNpcChatRefreshIndicator(id, false);
        updateInjection();
    }
}

const SCAN_RESPONSE_LENGTH = 1800;
const FULL_SCAN_RESPONSE_LENGTH = 3200;
const RELATIONSHIP_RESPONSE_LENGTH = 900;
const BACKFILL_RESPONSE_LENGTH = 3200;
const BACKFILL_MAX_ATTEMPTS = 3;
const BACKFILL_RETRY_COOLDOWN_MS = 60 * 1000;
const JSON_RETRY_RESPONSE_LENGTH = 5200;

function isTruncatedScannerJsonError(error) {
    const text = [error?.message, error?.cause?.message]
        .filter(Boolean)
        .join(' ');
    return /unterminated string|unexpected end of json input|unexpected end of data|end of json input/i.test(text);
}

function compactRetryPrompt(prompt, label = 'scanner', reason = 'malformed') {
    const cause = reason === 'truncated'
        ? 'Your previous response ended before the JSON was complete.'
        : 'Your previous response was not valid JSON. Rebuild it from the beginning with correct commas, colons, quotes, arrays, and objects.';
    const targetedMemoryLimit = /(?:backfill|chat refresh)/i.test(String(label || '')) ? IMPORTANT_MEMORY_LIMIT : 3;
    return `${prompt}

CRITICAL COMPACT JSON RETRY (${label}): ${cause} Return the full JSON object again from the beginning. Use MINIFIED JSON only. Keep every value concise; shorten prose instead of risking truncation. Omit unsupported optional facts rather than explaining them. Compact rather than append: appearance under 500 characters, personality 280, speech 240, behaviorProfile at most 6 short point-form rules, background/relationship summary 280-320, mannerisms at most 4 DISTINCT short items, key relationships one entry per counterpart, memories at most ${targetedMemoryLimit} distinct events, memoryRetention at most 5 distinct events. Close every quoted string, array, and object. No markdown, no commentary, no code fence.`;
}

async function generateParsedNpcJson(ctx, {
    systemPrompt,
    prompt,
    responseLength,
    label = 'scanner',
    requestScope,
}) {
    if (!requestScope) throw scannerRoutingError('A scanner request needs an owning operation.', 'NPC_SCANNER_ROUTE_CANCELLED');
    const invoke = async (retry = false, retryReason = 'malformed') => {
        const raw = await dispatchScannerRequest(ctx, {
            systemPrompt,
            prompt: retry ? compactRetryPrompt(prompt, label, retryReason) : prompt,
            quietToLoud: false,
            instructOverride: true,
            responseLength: retry ? Math.max(JSON_RETRY_RESPONSE_LENGTH, Number(responseLength) || 0) : responseLength,
            trimNames: false,
        }, { ...requestScope, label: retry ? `${label} (JSON retry)` : label });
        try {
            return { parsed: parseScanJson(raw), raw, retried: retry };
        } catch (error) {
            const truncated = isTruncatedScannerJsonError(error);
            if (!retry) {
                console.warn(`[NPC State Delta] ${label} returned invalid JSON; retrying once with a compact correction prompt.`, {
                    responseChars: String(raw ?? '').length,
                    truncated,
                    error: error?.message || String(error),
                });
                return invoke(true, truncated ? 'truncated' : 'malformed');
            }
            const wrapped = new Error(truncated
                ? `${label} JSON was truncated twice; the model did not finish its JSON response. ${error?.message || error}`
                : `${label} returned malformed JSON twice; the model did not produce a valid dossier object. ${error?.message || error}`);
            wrapped.cause = error;
            throw wrapped;
        }
    };
    return invoke(false);
}

async function backfillNpcFromHistory(request, messageId = null, { automatic = false } = {}) {
    const settings = getSettings();
    const ctx = getContext();
    const chatKey = getChatKey();
    if (!request?.npcId || !request?.label || chatKey === 'no-chat' || !requireReadyChatMutation('backfill a dossier', chatKey, { notify: false })) return false;
    if (isScanBusy(chatKey)) return false;
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
    const scanLineage = chatLineage(ctx.chat || []);
    const prompt = buildBackfillPrompt({
        transcript,
        targetName: request.label,
        existingNpc: existing,
        userName: ctx.name1 || 'User',
        charName: ctx.name2 || 'Character',
        memoryCriteria: settings.memoryCriteria,
    });

    const scanStateVersion = Number(stateVersions.get(chatKey) || 0);
    const operation = beginScanOperation(chatKey, `backfill for ${request.label}`, { npcId: request.npcId, indicator: 'backfill' });
    if (!operation) return false;
    setScanIndicator(true);
    try {
        const { parsed } = await generateParsedNpcJson(ctx, {
            systemPrompt: "You are NPC State Delta's isolated dossier backfill scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
            prompt,
            responseLength: BACKFILL_RESPONSE_LENGTH,
            label: `backfill for ${request.label}`,
            requestScope: operation.requestScope,
        });
        if (!scanOperationCurrent(chatKey, operation)) {
            console.info('[NPC State Delta] discarded expired or superseded dossier backfill.');
            return false;
        }
        const currentLineage = chatLineage(getContext().chat || []);
        if (getChatKey() !== chatKey || firstLineageDivergence(scanLineage, currentLineage) !== -1 || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
            console.info('[NPC State Delta] discarded stale dossier backfill after chat or dossier state changed.');
            return false;
        }
        const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
        let matches = returned.filter(npc => backfillScanMatchesTarget(npc, request));
        // The backfill prompt is single-target by construction. If the model expands a short
        // label (e.g. Toris -> Toris Vale) without repeating the alias, accept the sole result
        // when the requested target is actually present in the supplied history.
        if (!matches.length && returned.length === 1 && transcriptMentionsBackfillTarget(transcript, request.label)) matches = returned;
        const liveBeforeBackfill = request.preserveLiveState === true
            ? getChatState(chatKey).npcs.find(item => item.id === request.npcId)
            : null;
        parsed.npcs = matches
            .slice(0, 1)
            .map(npc => ({
                ...npc,
                id: request.npcId,
                ...(liveBeforeBackfill ? {
                    present: Boolean(liveBeforeBackfill.present),
                    worldActive: Boolean(liveBeforeBackfill.worldActive) && !Boolean(liveBeforeBackfill.present),
                    mood: liveBeforeBackfill.mood || npc.mood || '',
                    location: liveBeforeBackfill.location || npc.location || '',
                    goal: liveBeforeBackfill.goal || npc.goal || '',
                    status: liveBeforeBackfill.status || npc.status || '',
                } : {}),
                relationshipImpact: 'none',
                relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                relationshipChangeReason: '',
            }));
        if (!parsed.npcs.length) {
            const literalMention = transcriptMentionsBackfillTarget(transcript, request.label);
            console.warn('[NPC State Delta] targeted backfill returned no accepted NPC', { target: request.label, literalMention, returnedCount: returned.length });
            if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: ${request.label} was added, but the backfill model returned no matching dossier details from the last ${settings.scanDepth} messages.`);
            return false;
        }
        const latestState = getChatState(chatKey);
        const targetMessageId = Number.isInteger(messageId) ? messageId : latestMessageId(true);
        const merged = mergeScanResult(latestState, parsed, {
            maxNpcs: settings.maxNpcs,
            excludeNames: [...currentExclusions(), ...(latestState.dismissed || [])],
            turn: latestState.turn,
            sourceMessageId: targetMessageId,
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
            relationshipBaseline: settings.relationshipBaseline,
            relationshipCaps: settings.relationshipCaps,
            autoArchiveDeaths: settings.autoArchiveDeaths !== false,
            autoReactivateArchived: settings.autoReactivateArchived !== false,
            admissionMode: settings.admissionMode,
            preservePresence: true,
            skipRelationshipUpdate: true,
            memoryInputLimit: IMPORTANT_MEMORY_LIMIT,
            allowTargetedDurableSeed: true,
            developmentContext: transcript,
            userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
        });
        const nextState = merged.state;
        const finalNpc = nextState.npcs.find(npc => npc.id === request.npcId);
        if (request.preserveLiveState === true && liveBeforeBackfill && finalNpc) {
            finalNpc.present = Boolean(liveBeforeBackfill.present);
            finalNpc.worldActive = Boolean(liveBeforeBackfill.worldActive) && !finalNpc.present;
            finalNpc.mood = liveBeforeBackfill.mood || '';
            finalNpc.location = liveBeforeBackfill.location || '';
            finalNpc.goal = liveBeforeBackfill.goal || '';
            finalNpc.status = liveBeforeBackfill.status || '';
            finalNpc.seenCount = Number(liveBeforeBackfill.seenCount || 0);
            finalNpc.lastSeenTurn = Number(liveBeforeBackfill.lastSeenTurn || 0);
            finalNpc.lastWorldActiveTurn = Number(liveBeforeBackfill.lastWorldActiveTurn || 0);
        }
        if (finalNpc) Object.assign(finalNpc, protectTerminalNpc(existing, finalNpc));
        if (targetMessageId >= 0 && finalNpc) {
            if (!finalNpc.archived && finalNpc.present) recordInlineCardsInState(nextState, targetMessageId, [finalNpc.id], 'dossier-backfill');
            else removeNpcInlineCardAtMessage(nextState, targetMessageId, finalNpc.id);
            commitBranchCheckpoint(nextState, targetMessageId, 'dossier-backfill');
        }
        setChatState(chatKey, nextState);
        persist();
        renderDossier();
        updateInjection();
        const savedNpc = nextState.npcs.find(npc => npc.id === request.npcId);
        if (!request.silent) globalThis.toastr?.success?.(`NPC State Delta: backfilled ${savedNpc?.name || request.label} from recent story context.`);
        return true;
    } catch (error) {
        console.error('[NPC State Delta] dossier backfill failed', error);
        if (error?.code === 'NPC_SCANNER_ROUTE_CANCELLED' || error?.code === 'NPC_SCANNER_ROUTE_TIMEOUT') return null;
        if (!request.silent || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.warning?.(`NPC State Delta backfill failed for ${request.label}: ${error?.message || error}`);
        return false;
    } finally {
        endScanOperation(chatKey, operation);
        if (getChatKey() === chatKey) setScanIndicator(isScanBusy(chatKey));
        updateInjection();
    }
}

async function processPendingBackfills(messageId = null) {
    const chatKey = getChatKey();
    if (chatKey === 'no-chat' || !requireReadyChatMutation('process queued dossier backfills', chatKey, { notify: false }) || isScanBusy(chatKey) || isHostSwipeActive()) return 0;
    let processed = 0;
    const attemptedNpcIds = new Set();
    while (getChatKey() === chatKey && !isScanBusy(chatKey)) {
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

function rawScanMatchesExisting(raw, npc) {
    if (!raw || !npc) return false;
    if (raw.id && String(raw.id) === String(npc.id)) return true;
    if (raw.name && npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw.aliases) && raw.aliases.some(alias => npcMatchesLabel(npc, alias));
}

function hasCompletePrimaryRelationshipDecision(raw, transcript = '') {
    if (!raw || typeof raw !== 'object') return false;
    const delta = raw.relationshipDelta ?? raw.relationship_delta;
    const hasFullDelta = delta && typeof delta === 'object'
        && ['trust', 'affection', 'desire', 'tension'].every(key => Number.isFinite(Number(delta[key])));
    if (!hasFullDelta) return false;
    const rawImpact = String(raw.relationshipImpact ?? raw.impactLevel ?? raw.relationshipImpactLevel ?? '').trim().toLowerCase();
    if (!['none', 'ordinary', 'meaningful', 'major', 'extreme'].includes(rawImpact)) return false;
    const hasNonZero = ['trust', 'affection', 'desire', 'tension'].some(key => Number(delta[key]) !== 0);
    if (hasNonZero && rawImpact === 'none') return false;
    if (!hasNonZero && rawImpact !== 'none') return false;
    if (hasNonZero) {
        const reason = String(raw.relationshipChangeReason ?? raw.relationship_change_reason ?? raw.relationshipReason ?? '').trim();
        if (!reason) return false;
        const evidenceSource = raw.relationshipEvidence ?? raw.relationship_evidence;
        if (!evidenceSource || typeof evidenceSource !== 'object') return false;
        const evidence = normalizeRelationshipEvidence(evidenceSource);
        for (const key of ['trust', 'affection', 'desire', 'tension']) {
            if (Number(delta[key]) !== 0 && !relationshipAxisEvidenceGrounded(key, evidence[key], transcript)) return false;
        }
    }
    if (hasNonZero && ['major', 'extreme'].includes(rawImpact)) {
        const summary = raw.relationshipSummary ?? raw.relationship_summary;
        if (typeof summary !== 'string' || !summary.trim()) return false;
    }
    return true;
}

async function runFocusedRelationshipPass(ctx, parsed, existingNpcs, transcript, settings, options = {}) {
    const returned = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
    // Relationship reconciliation is keyed to the CURRENT exchange, not to whether the broad
    // dossier scanner happened to return a row. This prevents an NPC who acts early in a long
    // response from being skipped merely because the response ends with another cast/location.
    const targets = (Array.isArray(existingNpcs) ? existingNpcs : [])
        .filter(npc => !npc?.archived && !isTerminalNpcDeath(npc))
        .filter(npc => {
            const raw = returned.find(item => rawScanMatchesExisting(item, npc));
            if (!currentExchangeRelationshipRelevant(npc, transcript, raw, options)) return false;
            return !raw || !hasCompletePrimaryRelationshipDecision(raw, transcript);
        });
    if (!targets.length) return { decisions: new Map(), used: false, responseChars: 0, retried: false, targetCount: 0 };

    const decisions = new Map();
    let responseChars = 0;
    let retried = false;
    let failed = false;
    for (let offset = 0; offset < targets.length; offset += 4) {
        const batch = targets.slice(offset, offset + 4);
        try {
            const relationshipPrompt = buildRelationshipPassPrompt({
                transcript,
                targets: batch,
                userName: ctx.name1 || 'User',
                relationshipCriteria: settings.relationshipCriteria,
                impactCriteria: settings.relationshipImpactCriteria,
                relationshipCaps: settings.relationshipCaps,
            });
            const { parsed: relationshipParsed, raw, retried: batchRetried } = await generateParsedNpcJson(ctx, {
                systemPrompt: "You are NPC State Delta's isolated relationship evaluator. Use only the supplied targets and current exchange. Return only the requested JSON object.",
                prompt: relationshipPrompt,
                responseLength: RELATIONSHIP_RESPONSE_LENGTH,
                label: `relationship pass ${Math.floor(offset / 4) + 1}`,
                requestScope: options.requestScope,
            });
            responseChars += String(raw ?? '').length;
            retried ||= Boolean(batchRetried);
            for (const target of batch) {
                const rawDecision = (relationshipParsed.npcs || []).find(item => String(item?.id || '') === String(target.id) || (item?.name && npcMatchesLabel(target, item.name)));
                if (!rawDecision) continue;
                const deltaSource = rawDecision.relationshipDelta ?? rawDecision.relationship_delta;
                const hasFullDelta = deltaSource && typeof deltaSource === 'object'
                    && ['trust', 'affection', 'desire', 'tension'].every(key => Number.isFinite(Number(deltaSource[key])));
                if (!hasFullDelta) continue;
                const normalized = normalizeScanNpc(rawDecision);
                const requestedHasDelta = Object.values(normalized.relationshipDelta).some(value => value !== 0);
                const reasonPresent = Boolean(String(normalized.relationshipChangeReason || '').trim());
                const relationshipDelta = requestedHasDelta && reasonPresent
                    ? filterRelationshipDeltaByEvidence(normalized.relationshipDelta, normalized.relationshipEvidence, transcript)
                    : { trust: 0, affection: 0, desire: 0, tension: 0 };
                const hasNonZeroNormalizedDelta = Object.values(relationshipDelta).some(value => value !== 0);
                const relationshipImpact = hasNonZeroNormalizedDelta ? normalized.relationshipImpact : 'none';
                const rawSummary = rawDecision.relationshipSummary ?? rawDecision.relationship_summary;
                const explicitSummaryProvided = typeof rawSummary === 'string';
                const explicitSummary = explicitSummaryProvided ? String(rawSummary).trim().slice(0, 700) : '';
                const hasNonZeroDelta = Object.values(relationshipDelta).some(value => value !== 0);
                const needsTurningPointSummary = hasNonZeroDelta && ['major', 'extreme'].includes(relationshipImpact);
                const fallbackSummary = needsTurningPointSummary && !explicitSummary && normalized.relationshipChangeReason
                    ? `${target.name || 'This NPC'}'s relationship with the player changed ${normalized.relationshipImpact === 'extreme' ? 'fundamentally' : 'substantially'}: ${normalized.relationshipChangeReason}`.slice(0, 700)
                    : '';
                const relationshipSummary = explicitSummary || fallbackSummary;
                const relationshipSummaryDecisionProvided = explicitSummaryProvided || Boolean(fallbackSummary);
                decisions.set(target.id, {
                    relationshipDelta,
                    relationshipImpact,
                    relationshipEvidence: normalized.relationshipEvidence,
                    relationshipChangeReason: normalized.relationshipChangeReason,
                    relationshipSummary,
                    relationshipSummaryDecisionProvided,
                    context: transcript,
                });
            }
            const missing = batch.filter(target => !decisions.has(target.id));
            if (missing.length) {
                console.warn('[NPC State Delta] focused relationship pass omitted or malformed one or more target decisions.', {
                    targets: batch.map(npc => npc.id),
                    decided: batch.filter(npc => decisions.has(npc.id)).map(npc => npc.id),
                });
            }
        } catch (error) {
            if (isScannerRoutingError(error)) throw error;
            failed = true;
            console.warn('[NPC State Delta] focused relationship batch failed; retaining safe zero/primary output for that batch.', error);
        }
    }
    return { decisions, used: true, responseChars, retried, targetCount: targets.length, failed };
}

function prepareFullWindowRelationshipEvaluation(parsed, existingNpcs) {
    return prepareFullWindowRelationshipPayload(parsed, existingNpcs);
}

function suppressPrimaryRelationshipForFocusedDecisions(parsed, decisions) {
    if (!decisions?.size) return parsed;
    const clone = structuredClone(parsed || { npcs: [] });
    for (const raw of clone.npcs || []) {
        const matchedId = [...decisions.keys()].find(id => {
            if (String(raw?.id || '') === String(id)) return true;
            const stateNpc = getChatState().npcs.find(npc => npc.id === id);
            return Boolean(stateNpc && raw?.name && npcMatchesLabel(stateNpc, raw.name));
        });
        if (!matchedId) continue;
        delete raw.relationship;
        delete raw.relationship_delta;
        if (decisions.get(matchedId)?.relationshipSummaryDecisionProvided) {
            delete raw.relationshipSummary;
            delete raw.relationship_summary;
        }
        raw.relationshipImpact = 'none';
        raw.relationshipDelta = { trust: 0, affection: 0, desire: 0, tension: 0 };
        raw.relationshipEvidence = { trust: '', affection: '', desire: '', tension: '' };
        raw.relationshipChangeReason = '';
    }
    return clone;
}

function applyFocusedRelationshipDecisions(state, decisions, caps, sourceMessageId, report = null) {
    if (!decisions?.size) return state;
    for (const [id, decision] of decisions) {
        const npc = state.npcs.find(item => item.id === id);
        if (!npc || isTerminalNpcDeath(npc)) continue;
        const requestedHasDelta = Object.values(decision.relationshipDelta || {}).some(value => Number(value) !== 0);
        const evidence = normalizeRelationshipEvidence(decision.relationshipEvidence);
        const duplicateAward = requestedHasDelta && relationshipHistoryLooksDuplicate(npc.relationshipEventHistory, decision.relationshipChangeReason, {
            sourceMessageId,
            turn: state.turn,
            evidence,
        });
        const validReason = !requestedHasDelta || (relationshipChangeReasonGrounded(decision.relationshipChangeReason, '') && !duplicateAward);
        const update = applyRelationshipDelta(
            npc.relationship || DEFAULT_RELATIONSHIP,
            validReason ? decision.relationshipDelta : { trust: 0, affection: 0, desire: 0, tension: 0 },
            validReason ? decision.relationshipImpact : 'none',
            caps,
            npc.relationshipProgress,
            npc.relationshipMilestones,
        );
        npc.relationship = update.relationship;
        npc.relationshipProgress = update.relationshipProgress;
        npc.relationshipMilestones = applyRelationshipMilestoneCrossings(
            npc.relationshipMilestones,
            update.milestoneCrossings,
            {
                reason: decision.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
            },
        );
        const eventAccepted = Boolean(validReason && update.evidenceAccepted);
        const relationshipActuallyChanged = Object.values(update.appliedDelta || {}).some(value => Number(value) !== 0);
        const relationshipStateAdvanced = relationshipActuallyChanged
            || update.progressChanged
            || update.milestoneCrossings.length > 0;
        const narrativeAdvance = eventAccepted && (
            relationshipStateAdvanced
            || update.milestoneBlocks.length === 0
        );
        let summaryChanged = false;
        const mayInitializeSummary = !String(npc.relationshipSummary || '').trim() && !requestedHasDelta;
        if ((narrativeAdvance || mayInitializeSummary)
            && decision.relationshipSummaryDecisionProvided
            && !(Array.isArray(npc.manualProfileFields) && npc.manualProfileFields.includes('relationshipSummary'))) {
            const proposedSummary = String(decision.relationshipSummary || '').trim().slice(0, 700);
            if (relationshipSummaryConsistent(proposedSummary, npc.relationship, decision.context || '', npc.relationshipMilestones)) {
                const calibrated = calibrateRelationshipSummary(proposedSummary, npc.relationship);
                if (calibrated && calibrated !== String(npc.relationshipSummary || '').trim()) {
                    npc.relationshipSummary = calibrated;
                    summaryChanged = true;
                }
            }
        }
        if (eventAccepted) {
            const event = {
                impact: update.impact,
                delta: update.appliedDelta,
                evidence,
                reason: decision.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
            };
            npc.relationshipEventHistory = appendRelationshipEvent(npc.relationshipEventHistory, event);
            if (relationshipStateAdvanced) npc.lastRelationshipChange = event;
        } else {
            npc.relationshipEventHistory = normalizeRelationshipEventHistory(npc.relationshipEventHistory);
        }
        if (eventAccepted || update.progressChanged || summaryChanged) {
            npc.updatedAt = Date.now();
            if (report?.updated && !report.updated.includes(id)) report.updated.push(id);
        }
    }
    return state;
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

async function scanNow({ manual = false, messageId = null, allowDuringSwipe = false } = {}) {
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
    await ensureChatStateLoaded(scanChatKey);
    if (getChatKey() !== scanChatKey || (sourceFingerprint !== null && sourceFingerprint !== fingerprintMessage(getContext().chat?.[messageId] || {}))) return false;
    if (isScanBusy(scanChatKey)) {
        if (manual) globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
        else if (Number.isInteger(messageId)) queuePendingAutoScan(scanChatKey, messageId, 'busy-auto-scan');
        return false;
    }
    const scanLineage = chatLineage(ctx.chat || []);
    const currentTranscript = currentExchangeTranscript(messageId);
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
    if (!operation) return false;
    setScanIndicator(true);
    const state = getChatState(scanChatKey);
    const scanStateVersion = Number(stateVersions.get(scanChatKey) || 0);
    const prompt = buildScannerPrompt({
        transcript,
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
        currentTranscript,
        fullScanMode: fullWindowScan,
    });

    let relationshipEdgeCount = 0;
    let relationshipEdgeFallbacks = 0;
    let profileUpdateCount = 0;
    try {
        const scanStartedAt = performance.now?.() ?? Date.now();
        const { parsed, raw, retried } = await generateParsedNpcJson(ctx, {
            systemPrompt: "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
            prompt,
            responseLength: fullWindowScan ? FULL_SCAN_RESPONSE_LENGTH : SCAN_RESPONSE_LENGTH,
            label: manual ? 'manual dossier scan' : (fullWindowScan ? 'automatic full dossier scan' : 'automatic dossier scan'),
            requestScope: operation.requestScope,
        });
        let currentLineage = chatLineage(getContext().chat || []);
        if (!scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey || firstLineageDivergence(scanLineage, currentLineage) !== -1 || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
            const scanFinishedAt = performance.now?.() ?? Date.now();
            lastScanMetrics = {
                label: manual ? 'manual' : (fullWindowScan ? 'automatic-full' : 'automatic'),
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

        const resolvedParsed = resolveInterimIdentityPromotions(parsed, state.npcs, state.candidates);
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
            ? prepareFullWindowRelationshipEvaluation(resolvedParsed, state.npcs)
            : { evaluation: resolvedParsed, mergeSafe: resolvedParsed };
        const relationshipPass = await runFocusedRelationshipPass(
            ctx,
            fullWindowRelationship.evaluation,
            state.npcs,
            currentTranscript || transcript,
            settings,
            { currentExchangeOnly: manual || fullWindowScan, requestScope: operation.requestScope },
        );
        const scanFinishedAt = performance.now?.() ?? Date.now();
        lastScanMetrics = {
            label: manual ? 'manual' : (fullWindowScan ? 'automatic-full' : 'automatic'),
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
        if (!scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey || firstLineageDivergence(scanLineage, currentLineage) !== -1 || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
            console.info('[NPC State Delta] discarded stale dossier scan after chat or dossier state changed during relationship evaluation.');
            if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
            return false;
        }
        const targetMessageId = Number.isInteger(messageId) ? messageId : latestMessageId(true);
        const compactWorldStateTurn = hasCompactMeguminWorldState(ctx.chat?.[targetMessageId]?.mes || '');
        const parsedForMerge = suppressPrimaryRelationshipForFocusedDecisions(fullWindowRelationship.mergeSafe, relationshipPass.decisions);
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
            calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
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
        if (fullWindowScan && newlyAdmittedIds.length) {
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
                        { currentExchangeOnly: true, requestScope: operation.requestScope },
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
        if (!scanOperationCurrent(scanChatKey, operation)
            || getChatKey() !== scanChatKey
            || firstLineageDivergence(scanLineage, currentLineage) !== -1
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
        if (targetMessageId >= 0) commitBranchCheckpoint(nextState, targetMessageId, 'scan');
        setChatState(chatKey, nextState);
        persist();
        renderDossier();
        updateInjection();
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
        console.error('[NPC State Delta] dossier scan failed', error);
        if (manual || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.error?.(`NPC State Delta scan failed: ${error?.message || error}`);
        return false;
    } finally {
        endScanOperation(scanChatKey, operation);
        if (getChatKey() === scanChatKey) setScanIndicator(isScanBusy(scanChatKey));
        updateInjection();
        if (getChatKey() === scanChatKey) void drainPendingAutoScan(scanChatKey);
    }
}

function setScanIndicator(busy) {
    const button = $('#npc_state_delta_scan_now');
    if (!button.length) return;
    button.toggleClass('npc-state-delta-busy', busy);
    button.html(busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Scanning dossier...' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now');
}

function settingRow(id, label, control, hint = '') {
    return `<label class="npc-state-delta-setting-row" for="${id}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>${control}</label>`;
}

function buildSettingsHtml() {
    return `
    <div id="${UI_ID}" class="extension_container npc-state-delta-extension">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>NPC State Delta <span class="npc-state-delta-version">v${NPC_STATE_VERSION}</span></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content npc-state-delta-drawer">
          <div class="npc-state-delta-intro">Standalone narrated-NPC dossier tracker. Admission is configurable: Conservative avoids routine transactional extras, Balanced admits direct interactions more eagerly, and Manual only requires explicit promotion. Incidental role-only figures stay lightweight candidates; only NPCs detected as physically present in the latest scene receive a new inline card. Settings Add NPC creates a bare dossier with a per-NPC Scan dossier wand; Settings trash hard-deletes/suppresses it. Story text does not execute dossier commands.</div>
          <div class="npc-state-delta-settings-grid">
            ${settingRow('npc_state_delta_enabled', 'Enable NPC State Delta', '<input id="npc_state_delta_enabled" type="checkbox">')}
            ${settingRow('npc_state_delta_auto', 'Auto scan', '<input id="npc_state_delta_auto" type="checkbox">', 'Runs after assistant replies.')}
            ${settingRow('npc_state_delta_scanner_connection_profile', 'NPC scanner connection profile', '<select id="npc_state_delta_scanner_connection_profile" class="text_pole"></select>', 'Default preserves the current host route. A selected Connection Profile routes all NPC text scans, Refresh, focused passes, and retries without switching roleplay or portrait settings. Changes apply to the next scan; unavailable profiles never fall back silently.')}
            ${settingRow('npc_state_delta_full_scan_every_turn', 'Full scan every turn', '<input id="npc_state_delta_full_scan_every_turn" type="checkbox">', 'When Auto scan is enabled, reconcile the configured recent-story window after every assistant reply instead of scanning only the current exchange. Overrides Scan every. Uses more context/output tokens, but relationship-score deltas still come only from the newest exchange so old events are not replayed.')}
            ${settingRow('npc_state_delta_scan_every', 'Scan every', '<span><input id="npc_state_delta_scan_every" type="number" min="1" max="20" class="text_pole npc-state-delta-number"> replies</span>', 'Quick-scan cadence when Full scan every turn is off.')}
            ${settingRow('npc_state_delta_scan_depth', 'Full/manual scan context', '<span><input id="npc_state_delta_scan_depth" type="number" min="2" max="30" class="text_pole npc-state-delta-number"> messages</span>', 'History window used by Full scan every turn, global Scan dossier now, per-NPC dossier fallback, and Edit Dossier Refresh from Chat. Quick automatic scans still use only the current user + assistant exchange.')}
            ${settingRow('npc_state_delta_admission_mode', 'NPC admission', '<select id="npc_state_delta_admission_mode" class="text_pole"><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="manual_only">Manual only</option></select>', 'Conservative: proper names immediately; role labels require confirmed recurrence or manual Add. Balanced: meaningful/persistent or directly interactive role NPCs can also admit immediately. Manual only: all new dossiers require manual Add.')}
            ${settingRow('npc_state_delta_max', 'Maximum active NPCs', '<input id="npc_state_delta_max" type="number" min="1" max="100" class="text_pole npc-state-delta-number">', 'Cap for active dossiers only. Archived dossiers no longer consume an active roster slot.')}
            ${settingRow('npc_state_delta_auto_prune_stale', 'Auto-manage stale NPCs', '<input id="npc_state_delta_auto_prune_stale" type="checkbox">', 'Two-stage stale lifecycle after successful scans: long-absent active NPCs auto-archive first, then stale auto-archives are deleted later. Manual/death archives and protected NPCs are preserved; deleted stale names are not suppressed and can be rediscovered.')}
            ${settingRow('npc_state_delta_stale_archive_after', 'Auto-archive after', '<span><input id="npc_state_delta_stale_archive_after" type="number" min="10" max="999" class="text_pole npc-state-delta-number"> assistant replies</span>', 'Default 30. Counts NPC State Delta story turns since the NPC was last physically present or explicitly active off-screen. Auto-archive immediately frees an active roster slot.')}
            ${settingRow('npc_state_delta_stale_delete_after', 'Auto-delete after', '<span><input id="npc_state_delta_stale_delete_after" type="number" min="11" max="1000" class="text_pole npc-state-delta-number"> assistant replies</span>', 'Default 50. Only NPCs auto-archived for staleness are timed out. Manual archives and confirmed-death archives are never deleted by this timer.')}
            ${settingRow('npc_state_delta_inject', 'Inject present NPC state', '<input id="npc_state_delta_inject" type="checkbox">', 'Only active, non-archived NPCs marked present in the latest scanned scene are eligible for generation injection.')}
            ${settingRow('npc_state_delta_inject_budget', 'Injection budget', '<span>~<input id="npc_state_delta_inject_budget" type="number" min="512" max="6000" step="100" class="text_pole npc-state-delta-number"> tokens</span>', 'Approximate hard ceiling for the present-NPC dossier injected into main generation. If needed, lower-priority fields and then lower-ranked NPCs are trimmed first.')}
            ${settingRow('npc_state_delta_archive_deaths', 'Archive confirmed deaths', '<input id="npc_state_delta_archive_deaths" type="checkbox">', 'Explicitly confirmed current-timeline deaths are archived instead of deleted. Ambiguous death language is ignored.')}
            ${settingRow('npc_state_delta_reactivate_archived', 'Reactivate on clear return', '<input id="npc_state_delta_reactivate_archived" type="checkbox">', 'Manually archived NPCs reactivate when they physically return or are clearly active off-screen in current World State. Death-archived NPCs require an explicit living return, survival, or resurrection.')}
            ${settingRow('npc_state_delta_branch_rescan', 'Rescan changed branches', '<input id="npc_state_delta_branch_rescan" type="checkbox">', 'Re-evaluates the surviving branch after a swipe/edit or middle-message deletion.')}
          </div>
          <details class="npc-state-delta-portrait-generation-settings">
            <summary><b>Portrait generation</b> <small>SillyTavern Image Generation integration</small></summary>
            <div class="npc-state-delta-portrait-settings-body">
              <p class="npc-state-delta-muted">NPC State Delta builds a positive + negative prompt from the dossier, then calls SillyTavern's native <code>/imagine</code> command with <code>quiet=true</code>. SillyTavern keeps control of the configured image backend, model/checkpoint, sampler, steps, workflow, credentials, and resolution.</p>
              ${settingRow('npc_state_delta_portrait_generation_enabled', 'Enable Generate Portrait', '<input id="npc_state_delta_portrait_generation_enabled" type="checkbox">', 'Shows Generate Portrait in the dossier utility menu. If SillyTavern Image Generation is unavailable or unconfigured, generation fails safely without changing the dossier.')}
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_theme_preset"><b>Theme preset</b><small>Choosing a preset replaces the global positive/negative style fields below. Choose Custom before hand-editing them.</small></label>
              <select id="npc_state_delta_portrait_theme_preset" class="text_pole">${Object.entries(PORTRAIT_THEME_PRESETS).map(([key, item]) => `<option value="${key}">${escapeHtml(item.label)}</option>`).join('')}</select>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_positive"><b>Positive style / theme</b><small>Use this for a house style such as anime key visual, painterly fantasy, dark medieval, or your own model-specific style keywords.</small></label>
              <textarea id="npc_state_delta_portrait_style_positive" class="text_pole npc-state-delta-rubric-textarea" rows="4" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_style_negative"><b>Global negative prompt</b><small>Quality, anatomy, composition, or style exclusions applied to every generated NPC portrait.</small></label>
              <textarea id="npc_state_delta_portrait_style_negative" class="text_pole npc-state-delta-rubric-textarea" rows="4" maxlength="${PORTRAIT_STYLE_PROMPT_LIMIT}"></textarea>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_portrait_composition"><b>Portrait composition</b><small>Kept separate from appearance so you can change framing without rewriting dossiers.</small></label>
              <textarea id="npc_state_delta_portrait_composition" class="text_pole npc-state-delta-rubric-textarea" rows="3" maxlength="${PORTRAIT_COMPOSITION_PROMPT_LIMIT}"></textarea>
              <div class="npc-state-delta-portrait-settings-grid">
                ${settingRow('npc_state_delta_portrait_prompt_format', 'Prompt format', '<select id="npc_state_delta_portrait_prompt_format" class="text_pole"><option value="hybrid">Structured hybrid</option><option value="tags">Comma tags</option><option value="natural">Natural language</option></select>', 'Hybrid keeps theme tags while grouping dossier facts; Tags favors SD/anime checkpoints; Natural is useful for instruction-oriented image models.')}
                ${settingRow('npc_state_delta_portrait_use_mood', 'Use current mood', '<input id="npc_state_delta_portrait_use_mood" type="checkbox">', 'Adds current mood as expression/bearing. Stable Personality and Background are never dumped into the image prompt.')}
                ${settingRow('npc_state_delta_portrait_use_location', 'Use current location', '<input id="npc_state_delta_portrait_use_location" type="checkbox">', 'Off by default so portraits stay character-focused.')}
                ${settingRow('npc_state_delta_portrait_save_gallery', 'Also save to ST character gallery', '<input id="npc_state_delta_portrait_save_gallery" type="checkbox">', 'Off by default. NPC State Delta embeds only the result you choose as its portrait. Enable this if you also want each native generation placed in the current SillyTavern character gallery.')}
              </div>
              <div class="npc-state-delta-actions npc-state-delta-tuning-actions">
                <div id="npc_state_delta_reset_portrait_theme" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset Fantasy Anime theme</div>
                <div id="npc_state_delta_save_portrait_settings" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Save Portrait Settings</div>
                <small id="npc_state_delta_portrait_settings_status" class="npc-state-delta-muted">Saved</small>
              </div>
            </div>
          </details>
          <details class="npc-state-delta-relationship-tuning">
            <summary><b>Relationship tuning</b> <small>Delta rules and scanner rubric</small></summary>
            <div class="npc-state-delta-tuning-body">
              <p class="npc-state-delta-muted">The scanner proposes relationship deltas; NPC State Delta applies them in code and clamps every stat to the selected impact-tier cap. Stats are bipolar from -100 to +100 with 0 neutral. Starting values affect newly created NPCs only.</p>
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
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_relationship_criteria"><b>Relationship stat criteria</b><small>Injected into the private dossier scanner. Change these definitions/evidence rules to suit your RP.</small></label>
              <textarea id="npc_state_delta_relationship_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="9"></textarea>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_impact_criteria"><b>Impact-tier criteria</b><small>Defines what counts as ordinary, meaningful, major, or extreme. Code caps still apply even if the model proposes larger numbers.</small></label>
              <textarea id="npc_state_delta_impact_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="7"></textarea>
              <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_relationship_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset relationship rules</div></div>
            </div>
          </details>
          <details class="npc-state-delta-relationship-tuning npc-state-delta-memory-tuning">
            <summary><b>Important memory tuning</b> <small>What becomes a persistent NPC memory</small></summary>
            <div class="npc-state-delta-tuning-body">
              <p class="npc-state-delta-muted">This rubric is injected into automatic scans and targeted backfills. It decides which established events are durable enough to enter the NPC's persistent Important memories list. Existing memories are shown to the scanner for strongly relevant NPCs so it can avoid duplicates.</p>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_memory_criteria"><b>Important Memory Criteria</b><small>Define what should be remembered across later scenes. Keep routine dialogue, transient feelings, and moment-to-moment Inner Chatter out unless you intentionally change the rubric.</small></label>
              <textarea id="npc_state_delta_memory_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="8"></textarea>
              <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_memory_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset memory criteria</div></div>
            </div>
          </details>
          <details class="npc-state-delta-relationship-tuning npc-state-delta-behavior-tuning">
            <summary><b>Behavior expression</b> <small>How relationship stats affect present NPC behavior</small></summary>
            <div class="npc-state-delta-tuning-body">
              <p class="npc-state-delta-muted">This rubric is injected only with NPCs marked present. Identity is injected first: Personality, Behavioral profile, Speech, and Mannerisms remain authoritative while Trust, Affection, Desire, and Tension only modify player-specific expression. High relationship scores do not imply obedience, jealousy, clinginess, cruelty toward others, or a generic romance archetype.</p>
              <label class="npc-state-delta-rubric-label" for="npc_state_delta_behavior_criteria"><b>Relationship-to-behavior rubric</b><small>Edit this if your RP uses different behavioral assumptions.</small></label>
              <textarea id="npc_state_delta_behavior_criteria" class="text_pole npc-state-delta-rubric-textarea" rows="10"></textarea>
              <div class="npc-state-delta-actions npc-state-delta-tuning-actions"><div id="npc_state_delta_reset_behavior_rules" class="menu_button"><i class="fa-solid fa-rotate-left"></i> Reset behavior rubric</div></div>
            </div>
          </details>
          <div class="npc-state-delta-actions">
            <div id="npc_state_delta_scan_now" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier now</div>
            <div id="npc_state_delta_add_manual" class="menu_button"><i class="fa-solid fa-user-plus"></i> Add NPC</div>
            <div id="npc_state_delta_clear_chat" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Clear chat dossier</div>
          </div>
          <div id="npc_state_delta_roster_summary" class="npc-state-delta-roster-summary"></div>
        </div>
      </div>
    </div>`;
}

function syncScannerProfileControl() {
    const control = $('#npc_state_delta_scanner_connection_profile');
    if (!control.length) return;
    const selected = getSettings().scannerConnectionProfile;
    const html = scannerProfileOptions(getContext(), selected)
        .map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
    if (control.html() !== html) control.html(html);
    control.val(selected);
}

function syncSettingsControls() {
    const s = getSettings();
    $('#npc_state_delta_enabled').prop('checked', !!s.enabled);
    $('#npc_state_delta_auto').prop('checked', !!s.autoScan);
    syncScannerProfileControl();
    $('#npc_state_delta_full_scan_every_turn').prop('checked', !!s.fullScanEveryTurn);
    $('#npc_state_delta_scan_every').val(s.scanEvery);
    $('#npc_state_delta_scan_depth').val(s.scanDepth);
    $('#npc_state_delta_admission_mode').val(s.admissionMode);
    $('#npc_state_delta_max').val(s.maxNpcs);
    $('#npc_state_delta_auto_prune_stale').prop('checked', s.autoPruneStale !== false);
    $('#npc_state_delta_stale_archive_after').val(s.staleArchiveAfter);
    $('#npc_state_delta_stale_delete_after').val(s.staleDeleteAfter);
    $('#npc_state_delta_inject').prop('checked', !!s.inject);
    $('#npc_state_delta_inject_budget').val(s.injectBudgetTokens);
    $('#npc_state_delta_archive_deaths').prop('checked', s.autoArchiveDeaths !== false);
    $('#npc_state_delta_reactivate_archived').prop('checked', s.autoReactivateArchived !== false);
    $('#npc_state_delta_branch_rescan').prop('checked', s.branchRescan !== false);
    if (!portraitSettingsDirty) {
        $('#npc_state_delta_portrait_generation_enabled').prop('checked', s.portraitGenerationEnabled !== false);
        $('#npc_state_delta_portrait_theme_preset').val(s.portraitThemePreset);
        $('#npc_state_delta_portrait_style_positive').val(s.portraitStylePositive);
        $('#npc_state_delta_portrait_style_negative').val(s.portraitStyleNegative);
        $('#npc_state_delta_portrait_composition').val(s.portraitComposition);
        $('#npc_state_delta_portrait_prompt_format').val(s.portraitPromptFormat);
        $('#npc_state_delta_portrait_use_mood').prop('checked', s.portraitUseMood !== false);
        $('#npc_state_delta_portrait_use_location').prop('checked', s.portraitUseLocation === true);
        $('#npc_state_delta_portrait_save_gallery').prop('checked', s.portraitSaveToGallery === true);
    }
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

function signedRelationship(value) {
    const number = relationshipNumber(value);
    return number > 0 ? `+${number}` : String(number);
}

function barHtml(label, value, kind) {
    const number = relationshipNumber(value);
    const width = Math.abs(number) / 2;
    const left = number >= 0 ? 50 : 50 - width;
    const polarity = number < 0 ? 'negative' : (number > 0 ? 'positive' : 'neutral');
    return `<div class="npc-state-delta-bar-row"><div class="npc-state-delta-bar-label"><span>${escapeHtml(label)}</span><b>${signedRelationship(number)}</b></div><div class="npc-state-delta-bar"><i class="npc-state-delta-bar-zero"></i><i class="npc-state-delta-bar-fill npc-state-delta-${kind} npc-state-delta-bar-${polarity}" style="left:${left}%;width:${width}%"></i></div></div>`;
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

function snapshotNpc(npc) {
    return {
        id: npc.id,
        name: npc.name || '',
        aliases: [...(npc.aliases || [])],
        role: npc.role || '',
        species: npc.species || '',
        homeBase: npc.homeBase || '',
        age: npc.age || '',
        apparentAge: npc.apparentAge || '',
        appearance: npc.appearance || '',
        personality: npc.personality || '',
        speech: npc.speech || '',
        behaviorProfile: [...(npc.behaviorProfile || [])],
        background: npc.background || '',
        relationshipSummary: npc.relationshipSummary || '',
        mood: npc.mood || '',
        location: npc.location || '',
        goal: npc.goal || '',
        status: npc.status || '',
        memories: [...(npc.memories || [])],
        mannerisms: [...(npc.mannerisms || [])],
        keyRelationships: [...(npc.keyRelationships || [])],
        present: Boolean(npc.present),
        worldActive: Boolean(npc.worldActive),
        lifeState: npc.lifeState || 'unknown',
        lifeStateCertainty: npc.lifeStateCertainty || '',
        lifeStateReason: npc.lifeStateReason || '',
        archived: Boolean(npc.archived),
        archiveReason: npc.archiveReason || '',
        archivedAt: npc.archivedAt || null,
        archiveSourceMessageId: Number.isInteger(npc.archiveSourceMessageId) ? npc.archiveSourceMessageId : null,
        relationship: { ...(npc.relationship || {}) },
        lastRelationshipChange: structuredClone(npc.lastRelationshipChange || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, reason: '', sourceMessageId: null }),
        updatedAt: npc.updatedAt || Date.now(),
        seenCount: Number(npc.seenCount || 0),
        manualProfileFields: [...(npc.manualProfileFields || [])],
        retentionProtected: Boolean(npc.retentionProtected),
        minor: Boolean(npc.minor),
    };
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

function portraitMarkup(npc, displayName, placeholderClass = 'npc-state-delta-inline-avatar-placeholder') {
    const portraitUrl = npc?.portrait?.dataUrl || '';
    if (portraitUrl) return `<img src="${escapeHtml(portraitUrl)}" alt="${escapeHtml(displayName)} portrait">`;
    const initial = String(displayName || '?').trim().charAt(0).toUpperCase() || '?';
    return `<div class="${placeholderClass}" aria-hidden="true"><span>${escapeHtml(initial)}</span></div>`;
}

function inlineCardHtml(npc, messageId) {
    if (!npc || npc.archived || !npc.present || npc.minor) return '';
    const displayName = npc.name || 'NPC';
    const identityLine = [npc.role, npc.mood].filter(Boolean).join(' · ') || 'Present NPC';
    const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-present-card-placeholder');
    return `
      <button type="button" class="npc-state-delta-present-card" data-npc-id="${escapeHtml(npc.id)}" data-message-id="${messageId}" aria-label="Open ${escapeHtml(displayName)} dossier">
        <span class="npc-state-delta-present-card-portrait">${portrait}</span>
        <span class="npc-state-delta-present-card-overlay">
          <b>${escapeHtml(displayName)}</b>
          <small>${escapeHtml(identityLine)}</small>
        </span>
      </button>`;
}

function inlineRosterHtml(cards, messageId) {
    const currentById = new Map(getChatState().npcs.map(npc => [npc.id, npc]));
    const visible = (cards || []).map(card => currentById.get(card.id)).filter(npc => npc?.present && !npc.archived && !npc.minor);
    if (!visible.length) return '';
    return `
      <section class="npc-state-delta-present-roster" data-message-id="${messageId}">
        <div class="npc-state-delta-present-roster-head"><span class="npc-state-delta-kicker">PRESENT NPCS</span><small>${visible.length} shown</small></div>
        <div class="npc-state-delta-present-grid">${visible.map(npc => inlineCardHtml(npc, messageId)).join('')}</div>
      </section>`;
}

function relationshipChangeHtml(card) {
    const lastChange = normalizeNpcRecord(card).lastRelationshipChange || {};
    const delta = lastChange.delta || {};
    const changeParts = [['Trust', delta.trust], ['Affection', delta.affection], ['Desire', delta.desire], ['Tension', delta.tension]]
        .map(([label, value]) => [label, Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value !== 0)
        .map(([label, value]) => `<span class="npc-state-delta-delta-pill">${label} ${value > 0 ? '+' : ''}${Math.round(value)}</span>`);
    if (!changeParts.length) return '';
    const impactLabel = String(lastChange.impact || 'ordinary').replace(/[^a-z]/gi, '').toLowerCase();
    const safeImpact = ['none', 'ordinary', 'meaningful', 'major', 'extreme', 'manual'].includes(impactLabel) ? impactLabel : 'ordinary';
    return `
      <section class="npc-state-delta-viewer-section npc-state-delta-relationship-change"><b>Last relationship change</b>
        <p><span class="npc-state-delta-impact-badge">${escapeHtml(safeImpact)}</span>${changeParts.join('')}</p>
        ${lastChange.reason ? `<p>${escapeHtml(lastChange.reason)}</p>` : ''}
      </section>`;
}

function npcViewerDialogHtml(npc, messageId = -1) {
    const rel = npc.relationship || {};
    const displayName = npc.name || 'NPC';
    const portrait = portraitMarkup(npc, displayName, 'npc-state-delta-viewer-placeholder');
    const inputId = `npc_state_delta_viewer_portrait_${String(npc.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const portraitUrl = npc?.portrait?.dataUrl || '';
    const generatePortraitAction = getSettings().portraitGenerationEnabled !== false
        ? `<button type="button" class="menu_button npc-state-delta-generate-portrait" data-npc-id="${escapeHtml(npc.id)}"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate portrait</button>`
        : '';
    const memories = npc.memories?.length
        ? `<ul class="npc-state-delta-viewer-list">${npc.memories.map(memory => `<li>${escapeHtml(memory)}</li>`).join('')}</ul>`
        : `<span class="npc-state-delta-muted">No persistent memory recorded yet.</span>`;
    const keyRelationships = npc.keyRelationships?.length
        ? `<ul class="npc-state-delta-viewer-list">${npc.keyRelationships.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : `<span class="npc-state-delta-muted">No key relationships established yet.</span>`;
    const mannerisms = npc.mannerisms?.length
        ? `<ul class="npc-state-delta-viewer-list">${npc.mannerisms.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : `<span class="npc-state-delta-muted">None established yet.</span>`;
    const behaviorProfile = npc.behaviorProfile?.length
        ? `<ul class="npc-state-delta-viewer-list">${npc.behaviorProfile.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : `<span class="npc-state-delta-muted">No compact behavioral breakdown established yet.</span>`;
    const identityLine = [
        npc.species || 'Species unknown',
        npc.role || 'Role not established',
        npc.age ? `Age ${npc.age}` : 'Age unknown',
        npc.apparentAge ? `Looks ${npc.apparentAge}` : '',
    ].filter(Boolean).join(' · ');
    const sourceText = Number.isInteger(Number(messageId)) && Number(messageId) >= 0 ? `Current scene · message ${Number(messageId) + 1}` : 'Current live dossier';
    return `
      <div class="npc-state-delta-viewer-dialog" role="dialog" aria-modal="true" aria-labelledby="npc_state_delta_viewer_title" tabindex="-1">
        <header class="npc-state-delta-viewer-header">
          <span class="npc-state-delta-kicker">NPC DOSSIER</span>
          <button type="button" class="npc-state-delta-viewer-close" aria-label="Close NPC dossier"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="npc-state-delta-viewer-page">
          <aside class="npc-state-delta-viewer-portrait-rail">
            <div class="npc-state-delta-viewer-portrait">${portrait}</div>
            <div class="npc-state-delta-viewer-portrait-caption">
              <h2 id="npc_state_delta_viewer_title">${escapeHtml(displayName)}</h2>
              <p>${escapeHtml(identityLine)}</p>
            </div>
          </aside>

          <main class="npc-state-delta-viewer-document">
            <section class="npc-state-delta-viewer-glance npc-state-delta-viewer-glance-top">
              <div class="npc-state-delta-viewer-glance-title">Current</div>
              <div class="npc-state-delta-viewer-facts">
                <div><b>Mood</b><span>${escapeHtml(npc.mood || 'Unknown')}</span></div>
                <div><b>Location</b><span>${escapeHtml(npc.location || 'Unknown')}</span></div>
                <div><b>Goal</b><span>${escapeHtml(npc.goal || 'Unknown')}</span></div>
                <div><b>Status</b><span>${escapeHtml(npc.status || 'Stable / unknown')}</span></div>
              </div>
            </section>

            <section class="npc-state-delta-viewer-group">
              <div class="npc-state-delta-viewer-group-title">Profile</div>
              <section class="npc-state-delta-viewer-section npc-state-delta-viewer-section-first"><b>Personality</b><p>${escapeHtml(npc.personality || 'Unknown')}</p></section>
              <section class="npc-state-delta-viewer-section"><b>Behavioral profile</b>${behaviorProfile}</section>
              <section class="npc-state-delta-viewer-section"><b>Speech</b><p>${escapeHtml(npc.speech || 'Unknown')}</p></section>
              <section class="npc-state-delta-viewer-section"><b>Appearance</b><p>${escapeHtml(npc.appearance || 'Unknown')}</p></section>
              <section class="npc-state-delta-viewer-section"><b>Mannerisms</b>${mannerisms}</section>
            </section>

            <section class="npc-state-delta-viewer-group">
              <div class="npc-state-delta-viewer-group-title">Relationships</div>
              <section class="npc-state-delta-viewer-section npc-state-delta-viewer-section-first"><b>With player</b><p>${escapeHtml(npc.relationshipSummary || 'No established relationship summary yet.')}</p>
                <div class="npc-state-delta-bars npc-state-delta-viewer-bars">
                  ${barHtml('Trust', rel.trust, 'trust')}
                  ${barHtml('Affection', rel.affection, 'affection')}
                  ${barHtml('Desire', rel.desire, 'desire')}
                  ${barHtml('Tension', rel.tension, 'tension')}
                </div>
              </section>
              ${relationshipChangeHtml(npc)}
              <section class="npc-state-delta-viewer-section"><b>Key relationships</b>${keyRelationships}</section>
            </section>

            <section class="npc-state-delta-viewer-group">
              <div class="npc-state-delta-viewer-group-title">Background</div>
              <section class="npc-state-delta-viewer-section npc-state-delta-viewer-section-first"><p>${escapeHtml(npc.background || 'Unknown')}</p></section>
            </section>

            <section class="npc-state-delta-viewer-group">
              <div class="npc-state-delta-viewer-group-title">Important memories</div>
              <section class="npc-state-delta-viewer-section npc-state-delta-viewer-section-first">${memories}</section>
            </section>

            <div class="npc-state-delta-page-foot">${escapeHtml(sourceText)} · ${npc.updatedAt ? new Date(npc.updatedAt).toLocaleString() : 'unknown update time'}</div>
          </main>
        </div>
        <footer class="npc-state-delta-viewer-commandbar" aria-label="NPC dossier actions">
          <button type="button" class="menu_button npc-state-delta-inline-edit-npc" data-npc-id="${escapeHtml(npc.id)}"><i class="fa-solid fa-pen-to-square"></i> <span>Edit dossier</span></button>
          <button type="button" class="menu_button npc-state-delta-refresh-chat" data-npc-id="${escapeHtml(npc.id)}" title="Refresh from Chat"><i class="fa-solid fa-arrows-rotate"></i> <span>Refresh</span></button>
          <details class="npc-state-delta-viewer-more">
            <summary><i class="fa-solid fa-ellipsis"></i> <span>More</span></summary>
            <div class="npc-state-delta-viewer-more-menu">
              ${generatePortraitAction}
              <input id="${inputId}" class="npc-state-delta-inline-portrait-file" data-npc-id="${escapeHtml(npc.id)}" type="file" accept="image/*" hidden>
              <label for="${inputId}" class="menu_button npc-state-delta-inline-image-button"><i class="fa-solid fa-image"></i> ${portraitUrl ? 'Change portrait' : 'Attach portrait'}</label>
              ${portraitUrl ? `<button type="button" class="menu_button npc-state-delta-inline-remove-portrait" data-npc-id="${escapeHtml(npc.id)}"><i class="fa-solid fa-xmark"></i> Remove portrait</button>` : ''}
              <button type="button" class="menu_button npc-state-delta-copy-image-prompt" data-npc-id="${escapeHtml(npc.id)}"><i class="fa-solid fa-copy"></i> Copy portrait prompts</button>
            </div>
          </details>
        </footer>
      </div>`;
}

function closeNpcViewer() {
    const overlay = activeNpcViewerOverlay;
    activeNpcViewerOverlay = null;
    activeNpcViewerId = '';
    activeNpcViewerOpenedAt = 0;
    overlay?.remove?.();
    document.body?.classList?.remove?.('npc-state-delta-viewer-open');
    document.documentElement?.classList?.remove?.('npc-state-delta-viewer-open');
}

function refreshNpcViewer() {
    if (!activeNpcViewerOverlay || !activeNpcViewerId) return false;
    const npc = currentNpcById(activeNpcViewerId);
    if (!npc || npc.archived || !npc.present) {
        closeNpcViewer();
        return false;
    }
    const messageId = Number(activeNpcViewerOverlay.dataset?.messageId ?? -1);
    const oldPage = activeNpcViewerOverlay.querySelector?.('.npc-state-delta-viewer-page');
    const oldDocument = activeNpcViewerOverlay.querySelector?.('.npc-state-delta-viewer-document');
    const pageScrollTop = Number(oldPage?.scrollTop || 0);
    const documentScrollTop = Number(oldDocument?.scrollTop || 0);
    activeNpcViewerOverlay.innerHTML = npcViewerDialogHtml(npc, messageId);
    const nextPage = activeNpcViewerOverlay.querySelector?.('.npc-state-delta-viewer-page');
    const nextDocument = activeNpcViewerOverlay.querySelector?.('.npc-state-delta-viewer-document');
    if (nextPage) nextPage.scrollTop = pageScrollTop;
    if (nextDocument) nextDocument.scrollTop = documentScrollTop;
    return true;
}

function openNpcViewer(npcId, messageId = -1) {
    const id = String(npcId || '').trim();
    const npc = currentNpcById(id);
    if (!npc || npc.archived || !npc.present) return false;
    closeNpcViewer();
    const overlay = document.createElement('div');
    overlay.id = 'npc_state_delta_viewer_overlay';
    overlay.className = 'npc-state-delta-viewer-overlay';
    overlay.dataset.npcId = id;
    overlay.dataset.messageId = String(Number.isInteger(Number(messageId)) ? Number(messageId) : -1);
    overlay.innerHTML = npcViewerDialogHtml(npc, Number(overlay.dataset.messageId));
    overlay.addEventListener?.('click', event => {
        const closeButton = eventTargetClosest(event, '.npc-state-delta-viewer-close');
        const settledBackdropClick = event.target === overlay && Date.now() - activeNpcViewerOpenedAt > 350;
        if (closeButton || settledBackdropClick) {
            event.preventDefault?.();
            event.stopPropagation?.();
            closeNpcViewer();
        }
    });
    document.body?.appendChild?.(overlay);
    document.body?.classList?.add?.('npc-state-delta-viewer-open');
    document.documentElement?.classList?.add?.('npc-state-delta-viewer-open');
    activeNpcViewerOverlay = overlay;
    activeNpcViewerId = id;
    activeNpcViewerOpenedAt = Date.now();
    globalThis.requestAnimationFrame?.(() => overlay.querySelector?.('.npc-state-delta-viewer-close')?.focus?.());
    return true;
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

function inlineEntriesForRender(state) {
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
    return message?.querySelector?.('.meg-blocks') || null;
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
        button.title = 'NPC State Delta';
        button.setAttribute?.('aria-expanded', 'false');
        button.innerHTML = '<span class="meg-blocks-tab-emoji">👥</span><span class="meg-blocks-tab-label">NPC State Delta</span>';
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

function startInlineWatchdog() {
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
    ensureInlineObserver();

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
            rendered += 1;
            continue;
        }
        if (!anchor) {
            anchor = document.createElement('div');
            anchor.className = 'npc-state-delta-inline-anchor';
            anchor.dataset.npcStateDeltaMessageId = String(messageId);
            anchor.innerHTML = html;
            const text = message.querySelector?.('.mes_text');
            if (text?.insertAdjacentElement) text.insertAdjacentElement('afterend', anchor);
            else (message.querySelector?.('.mes_block') || message).appendChild?.(anchor);
            existingById.set(messageId, anchor);
        } else if (anchor.innerHTML !== html) {
            anchor.innerHTML = html;
        }
        rendered += 1;
    }
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

function activateNpcViewerFromEvent(event) {
    const card = eventTargetClosest(event, '.npc-state-delta-present-card');
    if (!card) return false;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false;
    const npcId = String(card.dataset?.npcId || '').trim();
    if (!npcId) return false;
    const now = Date.now();
    if (lastViewerActivation.npcId === npcId && now - lastViewerActivation.at < 650) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        return true;
    }
    lastViewerActivation = { npcId, at: now };
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    openNpcViewer(npcId, Number(card.dataset?.messageId ?? -1));
    return true;
}

function handleNpcViewerEscape(event) {
    if (event?.key !== 'Escape' || event.defaultPrevented
        || document.getElementById?.('npc_state_delta_tools_overlay')) return false;
    if (activePortraitGeneratorOverlay) {
        event.preventDefault?.();
        event.stopPropagation?.();
        closePortraitGenerator();
        return true;
    }
    if (!activeNpcViewerOverlay) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    closeNpcViewer();
    return true;
}

function editorIsMounted() {
    if (activeEditorPopup?.dlg) {
        return Boolean(activeEditorPopup.dlg.open || activeEditorPopup.dlg.isConnected || document.body?.contains?.(activeEditorPopup.dlg));
    }
    return Boolean(document.querySelector?.('.popup.npc-state-delta-editor-popup, #npc_state_delta_editor_overlay'));
}

function openNpcEditorSafely(npcId) {
    const id = String(npcId || '').trim();
    if (!id) return false;
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
    const editButton = eventTargetClosest(event, '.npc-state-delta-roster-edit, .npc-state-delta-inline-edit-npc');
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
    closeNpcViewer();
    openNpcEditorSafely(npcId);
    return true;
}

function installUiCaptureBridge() {
    if (uiCaptureBridgeInstalled || typeof document?.addEventListener !== 'function') return;
    uiCaptureBridgeInstalled = true;
    document.addEventListener('pointerup', activateNpcViewerFromEvent, true);
    document.addEventListener('click', activateNpcViewerFromEvent, true);
    document.addEventListener('keydown', activateNpcViewerFromEvent, true);
    document.addEventListener('keydown', handleNpcViewerEscape, true);
    document.addEventListener('pointerup', activateNpcEditorFromEvent, true);
    document.addEventListener('click', activateNpcEditorFromEvent, true);
    document.addEventListener('keydown', activateNpcEditorFromEvent, true);
    try {
        document.addEventListener('touchend', activateNpcViewerFromEvent, { capture: true, passive: false });
        document.addEventListener('touchend', activateNpcEditorFromEvent, { capture: true, passive: false });
    } catch {
        document.addEventListener('touchend', activateNpcViewerFromEvent, true);
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
    refreshNpcViewer();
}

function cleanEditorList(value, max = 12) {
    return [...new Set(String(value || '').split(/\r?\n|\s*;\s*/).map(item => item.trim()).filter(Boolean))].slice(0, max);
}

function editorValue(value) {
    return escapeHtml(String(value ?? ''));
}

function openNpcEditor(npcId) {
    const originChatKey = getChatKey();
    if (!requireReadyChatMutation('edit a dossier', originChatKey)) return null;
    const npc = currentNpcById(npcId);
    if (!npc) return null;
    closeNpcEditor();
    activeEditorChatKey = originChatKey;
    const ctx = getContext();
    const Popup = ctx.Popup;
    const POPUP_TYPE = ctx.POPUP_TYPE;
    const POPUP_RESULT = ctx.POPUP_RESULT;
    if (typeof Popup !== 'function' || !POPUP_TYPE?.TEXT || !POPUP_RESULT) {
        throw new Error('SillyTavern Popup API is unavailable. NPC State Delta requires SillyTavern 1.18+ for dossier editing.');
    }
    const rel = npc.relationship || DEFAULT_RELATIONSHIP;
    const locked = new Set(npc.manualProfileFields || []);
    const content = document.createElement('div');
    content.id = 'npc_state_delta_editor_content';
    content.className = 'npc-state-delta-editor-native';
    content.innerHTML = `
      <div class="npc-state-delta-editor-head"><div><span class="npc-state-delta-kicker">LIVE DOSSIER</span><h3 id="npc_state_delta_editor_title">Edit ${editorValue(npc.name)}</h3></div></div>
      <p class="npc-state-delta-muted">Edits save to NPC State Delta's extension-owned JSON data. Relationship numbers are authoritative current values on a -100 to +100 scale where 0 is neutral; future story deltas continue from them.</p>
      <div class="npc-state-delta-editor-lifecycle"><b>Lifecycle</b><span>${isTerminalNpcDeath(npc) ? 'Confirmed deceased' : (npc.archived ? 'Archived' : (npc.present ? 'Active · Present' : (npc.worldActive ? 'Active · Off-screen' : 'Active')))}${npc.archiveReason === 'deceased' ? ' · Deceased' : (npc.archiveReason === 'stale' ? ' · Stale auto-archive' : '')}</span>${npc.lifeStateReason ? `<small>${editorValue(npc.lifeStateReason)}</small>` : ''}</div>
      <div class="npc-state-delta-editor-tools"><div class="menu_button npc-state-delta-scan-dossier" role="button" tabindex="0" data-npc-id="${editorValue(npc.id)}" title="Import matching Megumin New NPC / NPC Update dossier blocks; falls back to recent story context"><i class="fa-solid fa-wand-magic-sparkles"></i> Scan dossier</div><div class="menu_button npc-state-delta-refresh-chat" role="button" tabindex="0" data-npc-id="${editorValue(npc.id)}" title="Re-read the configured recent-chat window for this NPC and reconcile every grounded unlocked dossier field without replaying relationship deltas"><i class="fa-solid fa-arrows-rotate"></i> Refresh from Chat</div><div class="menu_button npc-state-delta-copy-image-prompt" role="button" tabindex="0" data-npc-id="${editorValue(npc.id)}"><i class="fa-solid fa-copy"></i> Copy portrait prompts</div>${npc.archived || isTerminalNpcDeath(npc) ? `<div class="menu_button npc-state-delta-restore-npc npc-state-delta-editor-archive-toggle" role="button" tabindex="0" data-npc-id="${editorValue(npc.id)}"><i class="fa-solid fa-box-open"></i> ${isTerminalNpcDeath(npc) ? 'Correct death record' : 'Restore active'}</div>` : `<div class="menu_button npc-state-delta-archive-npc npc-state-delta-editor-archive-toggle" role="button" tabindex="0" data-npc-id="${editorValue(npc.id)}"><i class="fa-solid fa-box-archive"></i> Archive dossier</div>`}</div>
      <div class="npc-state-delta-editor-grid npc-state-delta-editor-profile">
        <label>Name<input id="npc_state_delta_edit_name" class="text_pole" value="${editorValue(npc.name)}"></label>
        <label>Species / Race<input id="npc_state_delta_edit_species" class="text_pole" maxlength="160" placeholder="Half-elf, dwarf, dwelf, human, custom species..." value="${editorValue(npc.species)}"></label>
        <label>Role<input id="npc_state_delta_edit_role" class="text_pole" value="${editorValue(npc.role)}"></label>
        <label>Home Base / Usual Location<input id="npc_state_delta_edit_home_base" class="text_pole" maxlength="300" placeholder="Home, workplace, headquarters, or regular haunt" value="${editorValue(npc.homeBase)}"></label>
        <label>Chronological age<input id="npc_state_delta_edit_age" class="text_pole" maxlength="80" placeholder="Actual stated age; leave blank if unknown" value="${editorValue(npc.age)}"></label>
        <label>Birthday <small>${npc.birthDateSource === 'generated' ? 'Generated fallback; editing establishes a manual correction' : (npc.birthDateSource === 'established' ? 'Established date; editing records a manual correction' : 'Uses the active calendar')}</small><input id="npc_state_delta_edit_birthday" class="text_pole" maxlength="180" placeholder="MM-DD / YYYY-MM-DD or configured calendar date" value="${editorValue(npc.birthDateDisplay)}"></label>
        <label>Apparent age<input id="npc_state_delta_edit_apparent_age" class="text_pole" maxlength="80" placeholder="~25, young, middle-aged..." value="${editorValue(npc.apparentAge)}"></label>
        <label>Personality<textarea id="npc_state_delta_edit_personality" class="text_pole" rows="3">${editorValue(npc.personality)}</textarea></label>
        <label class="npc-state-delta-editor-wide">Behavioral Levers <small>Max ${BEHAVIOR_PROFILE_LIMIT} compact target-general response/decision rules, one per line</small><textarea id="npc_state_delta_edit_behavior_profile" class="text_pole" rows="6" placeholder="Disposition: kind - broadly considerate; avoids needless harm&#10;Expressiveness: low - strong feelings show subtly&#10;Independence: high - keeps own goals and boundaries&#10;Care: practical - helps through actions before reassurance&#10;Conflict: controlled - concise, firm, not gratuitously cruel">${editorValue((npc.behaviorProfile || []).join('\n'))}</textarea></label>
        <label>Speech<textarea id="npc_state_delta_edit_speech" class="text_pole" rows="3">${editorValue(npc.speech)}</textarea></label>
        <label>Background<textarea id="npc_state_delta_edit_background" class="text_pole" rows="3">${editorValue(npc.background)}</textarea></label>
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
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_lock_profile" type="checkbox" ${locked.length ? 'checked' : ''}> Protect edited stable profile fields from future scanner rewrites <small>Leave off to use manual edits as an organic baseline. Existing locks stay protected until you uncheck and save.</small></label>
      ${locked.length ? `<p class="npc-state-delta-muted">Currently protected: ${editorValue([...locked].join(', '))}</p>` : ''}
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_retention_protected" type="checkbox" ${npc.retentionProtected ? 'checked' : ''}> Keep this NPC from automatic stale cleanup <small>Use for recurring or major NPCs who may disappear for long arcs. This does not lock their profile fields.</small></label>
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_minor" type="checkbox" ${npc.minor ? 'checked' : ''}> Hide present-NPC card <small>The dossier still scans, updates, stores memories/relationships, and injects when present; only the present cast card is hidden.</small></label>
      <div class="npc-state-delta-editor-grid">
        <label>Player Dynamic<textarea id="npc_state_delta_edit_relationship_summary" class="text_pole" rows="3">${editorValue(npc.relationshipSummary)}</textarea></label>
        <label>Mood<input id="npc_state_delta_edit_mood" class="text_pole" value="${editorValue(npc.mood)}"></label>
        <label>Location<input id="npc_state_delta_edit_location" class="text_pole" value="${editorValue(npc.location)}"></label>
        <label>Goal<input id="npc_state_delta_edit_goal" class="text_pole" value="${editorValue(npc.goal)}"></label>
        <label>Condition / Activity<input id="npc_state_delta_edit_status" class="text_pole" value="${editorValue(npc.status)}"></label>
        <label class="npc-state-delta-editor-wide">Important memories <small>Max 5 · one per line</small><textarea id="npc_state_delta_edit_memories" class="text_pole" rows="5">${editorValue((npc.memories || []).join('\n'))}</textarea></label>
      </div>
      <div class="npc-state-delta-editor-stats">
        <label>Trust<input id="npc_state_delta_edit_trust" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.trust)}"></label>
        <label>Affection<input id="npc_state_delta_edit_affection" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.affection)}"></label>
        <label>Desire<input id="npc_state_delta_edit_desire" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.desire)}"></label>
        <label>Tension<input id="npc_state_delta_edit_tension" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.tension)}"></label>
      </div>`;

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
                return saveNpcEditor(npc.id, { close: false });
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
    const settings = getSettings();
    return {
        stylePositive: settings.portraitStylePositive,
        styleNegative: settings.portraitStyleNegative,
        composition: settings.portraitComposition,
        format: settings.portraitPromptFormat,
        useMood: settings.portraitUseMood !== false,
        useLocation: settings.portraitUseLocation === true,
    };
}

function npcImagePromptPair(npc) {
    return buildNpcPortraitPrompts(npc || {}, portraitPromptOptions());
}

function npcImagePromptText(npc) {
    const prompts = npcImagePromptPair(npc);
    if (!prompts.positive) return '';
    return `POSITIVE\n${prompts.positive}\n\nNEGATIVE\n${prompts.negative || '(none)'}`;
}

async function copyNpcImagePrompt(npcId) {
    const npc = getChatState().npcs.find(item => item.id === npcId);
    const text = npcImagePromptText(npc);
    if (!text) {
        globalThis.toastr?.warning?.('NPC State Delta: no appearance description or portrait override is established for this NPC yet.');
        return false;
    }
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text);
        } else {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand?.('copy');
            area.remove();
        }
        globalThis.toastr?.success?.(`NPC State Delta: copied positive + negative portrait prompts for ${npc.name}.`);
        return true;
    } catch (error) {
        console.warn('[NPC State Delta] Could not copy portrait prompts', error);
        globalThis.toastr?.warning?.('NPC State Delta: could not access the clipboard.');
        return false;
    }
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
    const theme = PORTRAIT_THEME_PRESETS[getSettings().portraitThemePreset]?.label || 'Custom';
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
            <label><b>Positive prompt</b><small>Built from the current dossier + global portrait theme. Edit freely for this generation.</small><textarea id="npc_state_delta_portrait_positive" class="text_pole" rows="9">${escapeHtml(prompts.positive)}</textarea></label>
            <label><b>Negative prompt</b><small>Global exclusions + this NPC's optional negative override.</small><textarea id="npc_state_delta_portrait_negative" class="text_pole" rows="7">${escapeHtml(prompts.negative)}</textarea></label>
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
        refreshNpcViewer();
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
    if (popup?.completeCancelled) {
        Promise.resolve(popup.completeCancelled()).catch(error => console.debug('[NPC State Delta] editor popup close failed', error));
    }
    document.querySelector?.('#npc_state_delta_editor_overlay')?.remove();
}

function editorField(id) {
    return document.getElementById(id)?.value ?? '';
}

function clampEditorRelationshipStat(id) {
    const value = Number(editorField(id));
    return Number.isFinite(value) ? Math.max(-100, Math.min(100, Math.round(value))) : 0;
}

function saveNpcEditor(npcId, { close = true, silent = false } = {}) {
    const originChatKey = activeEditorChatKey || getChatKey();
    if (getChatKey() !== originChatKey || !requireReadyChatMutation('save dossier edits', originChatKey)) {
        globalThis.toastr?.warning?.('NPC State Delta: this editor belongs to a different or unloaded chat. Reopen the dossier in the active chat.');
        return false;
    }
    const state = getChatState(originChatKey);
    const index = state.npcs.findIndex(item => item.id === npcId);
    if (index < 0) { if (close) closeNpcEditor(); return false; }
    const current = state.npcs[index];
    const beforeKeyRelationships = [...(current.keyRelationships || [])];
    const next = structuredClone(current);
    const oldRelationship = { ...(current.relationship || DEFAULT_RELATIONSHIP) };
    const stableInputs = {
        name: String(editorField('npc_state_delta_edit_name')).trim().slice(0, 120) || current.name,
        role: String(editorField('npc_state_delta_edit_role')).trim().slice(0, 240),
        species: String(editorField('npc_state_delta_edit_species')).trim().slice(0, 160),
        homeBase: String(editorField('npc_state_delta_edit_home_base')).trim().slice(0, 300),
        age: String(editorField('npc_state_delta_edit_age')).trim().slice(0, 80),
        apparentAge: String(editorField('npc_state_delta_edit_apparent_age')).trim().slice(0, 80),
        personality: String(editorField('npc_state_delta_edit_personality')).trim().slice(0, 900),
        speech: String(editorField('npc_state_delta_edit_speech')).trim().slice(0, 600),
        behaviorProfile: cleanEditorList(editorField('npc_state_delta_edit_behavior_profile'), BEHAVIOR_PROFILE_LIMIT),
        background: String(editorField('npc_state_delta_edit_background')).trim().slice(0, 1200),
        mannerisms: cleanEditorList(editorField('npc_state_delta_edit_mannerisms'), 8),
        keyRelationships: cleanEditorList(editorField('npc_state_delta_edit_key_relationships'), KEY_RELATIONSHIP_LIMIT),
    };
    const nameCollision = state.npcs.some((item, i) => i !== index && npcMatchesLabel(item, stableInputs.name));
    if (nameCollision) {
        globalThis.toastr?.warning?.(`NPC State Delta: another dossier already matches ${stableInputs.name}.`);
        return false;
    }
    if (stableInputs.name !== current.name && current.name) {
        next.aliases = [...new Set([...(current.aliases || []), current.name])].slice(0, 8);
    }
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
    next.identityKind = inferNpcIdentityKind(stableInputs.name);
    next.relationshipSummary = String(editorField('npc_state_delta_edit_relationship_summary')).trim().slice(0, 900);
    next.mood = String(editorField('npc_state_delta_edit_mood')).trim().slice(0, 240);
    next.location = String(editorField('npc_state_delta_edit_location')).trim().slice(0, 300);
    next.goal = String(editorField('npc_state_delta_edit_goal')).trim().slice(0, 500);
    next.status = String(editorField('npc_state_delta_edit_status')).trim().slice(0, 300);
    next.memories = cleanEditorList(editorField('npc_state_delta_edit_memories'), IMPORTANT_MEMORY_LIMIT);
    next.relationship = {
        trust: clampEditorRelationshipStat('npc_state_delta_edit_trust'),
        affection: clampEditorRelationshipStat('npc_state_delta_edit_affection'),
        desire: clampEditorRelationshipStat('npc_state_delta_edit_desire'),
        tension: clampEditorRelationshipStat('npc_state_delta_edit_tension'),
    };
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
        };
    }
    const stableKeys = ['name', 'role', 'species', 'homeBase', 'age', 'apparentAge', 'personality', 'speech', 'behaviorProfile', 'background', 'mannerisms', 'keyRelationships'];
    if (document.getElementById('npc_state_delta_edit_lock_profile')?.checked) {
        const locks = new Set(current.manualProfileFields || []);
        for (const key of stableKeys) {
            const listField = key === 'mannerisms' || key === 'behaviorProfile' || key === 'keyRelationships';
            const before = listField ? JSON.stringify(current[key] || []) : String(current[key] || '');
            const after = listField ? JSON.stringify(next[key] || []) : String(next[key] || '');
            if (before !== after) locks.add(key);
        }
        next.manualProfileFields = [...locks];
    } else {
        next.manualProfileFields = [];
    }
    next.manualProfileLocksExplicit = true;
    next.retentionProtected = Boolean(document.getElementById('npc_state_delta_edit_retention_protected')?.checked);
    next.minor = Boolean(document.getElementById('npc_state_delta_edit_minor')?.checked);
    next.updatedAt = Date.now();
    state.npcs[index] = normalizeNpcRecord(next);
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
    persistCritical(originChatKey);
    if (close) closeNpcEditor();
    renderDossier();
    updateInjection();
    if (!silent) globalThis.toastr?.success?.(`NPC State Delta: saved manual dossier edits for ${state.npcs[index].name}.`);
    return true;
}


function updateNpcAppearance(npcId, draft, { chatKey, lockAppearance = false } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('edit appearance forms', chatKey)) return false;
    const state = getChatState(chatKey);
    const index = state.npcs.findIndex(item => item.id === String(npcId || ''));
    if (index < 0) return false;
    const next = appearanceDraftRecord(state.npcs[index], draft, { lockAppearance });
    next.updatedAt = Date.now();
    state.npcs[index] = normalizeNpcRecord(next);
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
    state.npcs[index] = normalizeNpcRecord(manualLifeStateRecord(corrected, choice));
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

async function setNpcPortrait(npcId, file, { chatKey, isCurrent = () => true, generatedFrom = '' } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !isCurrent() || !requireReadyChatMutation('attach a portrait', chatKey)) return false;
    const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
    if (!npc || !file) return false;
    if (!/^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i.test(String(file.type || '')) || file.size > 16 * 1024 * 1024) {
        throw new Error('Choose a PNG, JPEG, WebP, GIF, AVIF or BMP image no larger than 16 MB.');
    }
    const originChatKey = chatKey;
    const originRevision = Number(stateVersions.get(originChatKey) || 0);
    const epoch = ownershipEpoch(chatKey);
    const { key, action } = portraitAction(chatKey, npc.id);
    try {
        const portrait = await compressPortrait(file);
        if (portraitActions.get(key) !== action || !isCurrent() || getChatKey() !== chatKey
            || !ownershipEpochCurrent(chatKey, epoch) || Number(stateVersions.get(chatKey) || 0) !== originRevision
            || !requireReadyChatMutation('attach a portrait', chatKey)) return false;
        const live = getChatState(chatKey).npcs.find(item => item.id === npc.id);
        if (!live) return false;
        if (generatedFrom) portrait.generatedFrom = String(generatedFrom);
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

function setNpcPortraitSeed(npcId, seed, { chatKey } = {}) {
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

function removeNpcPortrait(npcId, { chatKey } = {}) {
    if (!chatKey || chatKey !== getChatKey() || !requireReadyChatMutation('remove a portrait', chatKey)) return false;
    const npc = getChatState(chatKey).npcs.find(item => item.id === String(npcId || ''));
    if (!npc) return false;
    // Invalidate a prior decode even when there was no portrait to remove yet.
    portraitActions.delete(`${chatKey}::${npc.id}`);
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
    const targetMessageId = latestMessageId(false);
    if (targetMessageId >= 0) commitBranchCheckpoint(working, targetMessageId, 'manual-delete');
    setChatState(getChatKey(), working);
    persistCritical();
    closeNpcEditor();
    renderDossier();
    updateInjection();
    globalThis.toastr?.success?.(`NPC State Delta: deleted ${result.report.name}; older branch snapshots cannot restore that identity.`);
    return true;
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
    persistCritical();
    closeNpcEditor();
    renderDossier();
    updateInjection();
    globalThis.toastr?.success?.(archived
        ? `NPC State Delta: archived ${current.name}. Their dossier and history are preserved.`
        : (correctingDeath ? `NPC State Delta: corrected ${current.name}'s erroneous death record; presence remains unconfirmed.` : `NPC State Delta: restored ${current.name} to the active roster.`));
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

function portraitSettingsSnapshot(source = getSettings()) {
    return {
        portraitGenerationEnabled: source.portraitGenerationEnabled !== false,
        portraitThemePreset: PORTRAIT_THEME_PRESETS[source.portraitThemePreset] ? source.portraitThemePreset : 'custom',
        portraitStylePositive: String(source.portraitStylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitStyleNegative: String(source.portraitStyleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE).slice(0, PORTRAIT_STYLE_PROMPT_LIMIT),
        portraitComposition: String(source.portraitComposition ?? DEFAULT_PORTRAIT_COMPOSITION).slice(0, PORTRAIT_COMPOSITION_PROMPT_LIMIT),
        portraitPromptFormat: normalizePortraitPromptFormat(source.portraitPromptFormat),
        portraitUseMood: source.portraitUseMood !== false,
        portraitUseLocation: source.portraitUseLocation === true,
        portraitSaveToGallery: source.portraitSaveToGallery === true,
    };
}

function normalizePortraitSettingsDraft(raw = {}) {
    const current = portraitSettingsSnapshot(getSettings());
    const key = PORTRAIT_THEME_PRESETS[raw.portraitThemePreset] ? raw.portraitThemePreset : (raw.portraitThemePreset === 'custom' ? 'custom' : current.portraitThemePreset);
    const preset = PORTRAIT_THEME_PRESETS[key];
    const next = {
        portraitGenerationEnabled: raw.portraitGenerationEnabled !== undefined ? Boolean(raw.portraitGenerationEnabled) : current.portraitGenerationEnabled,
        portraitThemePreset: key,
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
    }
    return next;
}

function portraitSettingsDraftFromUi() {
    return normalizePortraitSettingsDraft({
        portraitGenerationEnabled: $('#npc_state_delta_portrait_generation_enabled').prop('checked'),
        portraitThemePreset: String($('#npc_state_delta_portrait_theme_preset').val() || 'custom'),
        portraitStylePositive: String($('#npc_state_delta_portrait_style_positive').val() || ''),
        portraitStyleNegative: String($('#npc_state_delta_portrait_style_negative').val() || ''),
        portraitComposition: String($('#npc_state_delta_portrait_composition').val() || ''),
        portraitPromptFormat: String($('#npc_state_delta_portrait_prompt_format').val() || 'hybrid'),
        portraitUseMood: $('#npc_state_delta_portrait_use_mood').prop('checked'),
        portraitUseLocation: $('#npc_state_delta_portrait_use_location').prop('checked'),
        portraitSaveToGallery: $('#npc_state_delta_portrait_save_gallery').prop('checked'),
    });
}

function writePortraitSettingsDraftToUi(draft) {
    const next = normalizePortraitSettingsDraft(draft);
    $('#npc_state_delta_portrait_generation_enabled').prop('checked', next.portraitGenerationEnabled);
    $('#npc_state_delta_portrait_theme_preset').val(next.portraitThemePreset);
    $('#npc_state_delta_portrait_style_positive').val(next.portraitStylePositive);
    $('#npc_state_delta_portrait_style_negative').val(next.portraitStyleNegative);
    $('#npc_state_delta_portrait_composition').val(next.portraitComposition);
    $('#npc_state_delta_portrait_prompt_format').val(next.portraitPromptFormat);
    $('#npc_state_delta_portrait_use_mood').prop('checked', next.portraitUseMood);
    $('#npc_state_delta_portrait_use_location').prop('checked', next.portraitUseLocation);
    $('#npc_state_delta_portrait_save_gallery').prop('checked', next.portraitSaveToGallery);
    return next;
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
        refreshNpcViewer();
        globalThis.toastr?.success?.('NPC State Delta: portrait settings saved.');
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

function bindSettingsCheckbox(selector, key, after = null) {
    $(document).on('change.npcStateDelta', selector, function () {
        getSettings()[key] = Boolean(this.checked);
        persistSettings();
        after?.();
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
    bindSettingsCheckbox('#npc_state_delta_enabled', 'enabled', () => { updateInjection(); renderDossier(); });
    bindSettingsCheckbox('#npc_state_delta_auto', 'autoScan');
    $(document).on('change.npcStateDelta', '#npc_state_delta_scanner_connection_profile', function () {
        getSettings().scannerConnectionProfile = String(this.value || '').trim();
        persistSettings();
    });
    bindSettingsCheckbox('#npc_state_delta_full_scan_every_turn', 'fullScanEveryTurn');
    bindSettingsCheckbox('#npc_state_delta_inject', 'inject', updateInjection);
    bindSettingsNumber('#npc_state_delta_inject_budget', 'injectBudgetTokens', 512, 6000, 1800, updateInjection);
    bindSettingsCheckbox('#npc_state_delta_archive_deaths', 'autoArchiveDeaths');
    bindSettingsCheckbox('#npc_state_delta_reactivate_archived', 'autoReactivateArchived');
    bindSettingsCheckbox('#npc_state_delta_branch_rescan', 'branchRescan');
    $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_theme_preset', function () {
        const key = PORTRAIT_THEME_PRESETS[this.value] ? this.value : 'custom';
        const preset = PORTRAIT_THEME_PRESETS[key];
        if (key !== 'custom' && preset) {
            $('#npc_state_delta_portrait_style_positive').val(preset.positive);
            $('#npc_state_delta_portrait_style_negative').val(preset.negative);
        }
        markPortraitSettingsDirty();
    });
    $(document).on('input.npcStateDelta', '#npc_state_delta_portrait_style_positive, #npc_state_delta_portrait_style_negative, #npc_state_delta_portrait_composition', function () {
        if (this.id === 'npc_state_delta_portrait_style_positive' || this.id === 'npc_state_delta_portrait_style_negative') {
            $('#npc_state_delta_portrait_theme_preset').val('custom');
        }
        markPortraitSettingsDirty();
    });
    $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_generation_enabled, #npc_state_delta_portrait_prompt_format, #npc_state_delta_portrait_use_mood, #npc_state_delta_portrait_use_location, #npc_state_delta_portrait_save_gallery', () => {
        markPortraitSettingsDirty();
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_reset_portrait_theme', () => {
        writePortraitSettingsDraftToUi({
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
    bindSettingsNumber('#npc_state_delta_scan_every', 'scanEvery', 1, 20, 2);
    bindSettingsNumber('#npc_state_delta_scan_depth', 'scanDepth', 2, 30, 6);
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
    $(document).on('click.npcStateDelta', '#npc_state_delta_scan_now', () => scanNow({ manual: true, messageId: latestMessageId(true) }));
    $(document).on('click.npcStateDelta', '#npc_state_delta_add_manual', () => {
        if (!requireReadyChatMutation('add an NPC')) return;
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
    });
    $(document).on('click.npcStateDelta', '.npc-state-delta-roster-edit', function (event) { event.preventDefault?.(); event.stopPropagation?.(); openNpcEditorSafely(this.dataset.npcId); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-inline-edit-npc', function () { closeNpcViewer(); openNpcEditorSafely(this.dataset.npcId); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-scan-dossier', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void scanNpcDossier(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-refresh-chat', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void refreshNpcFromChat(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-copy-image-prompt', function () { copyNpcImagePrompt(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-generate-portrait', function (event) { event.preventDefault?.(); event.stopPropagation?.(); openPortraitGenerator(String(this.dataset.npcId || '')); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-reset', function (event) { event.preventDefault?.(); resetPortraitGeneratorFromDossier(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-run', function (event) { event.preventDefault?.(); void generatePortraitFromDialog(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-use', function (event) { event.preventDefault?.(); void useGeneratedPortrait(); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-archive-npc', function () { closeNpcViewer(); setNpcArchiveStateById(this.dataset.npcId, true, { reason: 'manual' }); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-restore-npc', function () { setNpcArchiveStateById(this.dataset.npcId, false); });
    $(document).on('click.npcStateDelta', '.npc-state-delta-delete-npc', function () { deleteNpcById(this.dataset.npcId); });
    $(document).on('keydown.npcStateDelta', '.npc-state-delta-delete-npc', function (event) {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault?.();
        deleteNpcById(this.dataset.npcId);
    });
    $(document).on('click.npcStateDelta', '#npc_state_delta_clear_chat', () => {
        if (!requireReadyChatMutation('clear this chat dossier')) return;
        if (!window.confirm('Clear every NPC State Delta dossier for this chat? Portraits and inline dossier cards will also be removed.')) return;
        closePortraitGenerator();
        const cleared = freshChatState();
        cleared.lineage = chatLineage(getContext().chat || []);
        setChatState(getChatKey(), cleared);
        persistCritical(); renderDossier(); updateInjection();
    });
    $(document).on('change.npcStateDelta', '.npc-state-delta-inline-portrait-file', async function () {
        const file = this.files?.[0];
        const npcId = this.dataset.npcId;
        const chatKey = getChatKey();
        this.value = '';
        if (!file) return;
        try {
            const applied = await setNpcPortrait(npcId, file, { chatKey });
            if (applied) globalThis.toastr?.info?.('NPC State Delta: portrait applied locally; durable save is pending.');
        } catch (error) {
            globalThis.toastr?.error?.(`NPC State Delta portrait: ${error?.message || error}`);
        }
    });
    $(document).on('click.npcStateDelta', '.npc-state-delta-inline-remove-portrait', function () {
        removeNpcPortrait(this.dataset.npcId, { chatKey: getChatKey() });
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
    syncSettingsControls();
    renderDossier();
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

async function handleAssistantMessageReceived(messageId, { bypassSwipeGuard = false, forceBranchRescan = false } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const eventChatKey = getChatKey();
    if (eventChatKey === 'no-chat' || !Number.isInteger(messageId) || messageId < 0) return;
    const eventMessage = getContext().chat?.[messageId];
    if (!eventMessage || eventMessage.is_user || eventMessage.is_system || !String(eventMessage.mes || '').trim()) return;
    const eventSourceKey = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
    try { await ensureChatStateLoaded(eventChatKey); }
    catch (error) {
        console.error('[NPC State Delta] assistant event deferred because chat hydration failed.', error);
        globalThis.toastr?.error?.('NPC State Delta could not load this chat dossier. Existing sidecar data was preserved; retry after the server is available.');
        return;
    }
    if (getChatKey() !== eventChatKey || eventSourceKey !== lineageCheckpointKey(chatLineage(getContext().chat || []), messageId)) return;

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
    const receipts = assistantReceipts.get(eventChatKey) || new Set();
    if (!forceBranchRescan && (receipts.has(eventSourceKey)
        || (state.lastScannedMessageId === messageId && eventSourceKey === lineageCheckpointKey(state.lineage, messageId)))) return;
    // Receipt deduplication is separate from successful scan completion and cadence.
    // Store bounded source keys, never copies of narrative text or dossier state.
    receipts.add(eventSourceKey);
    while (receipts.size > 64) receipts.delete(receipts.values().next().value);
    assistantReceipts.set(eventChatKey, receipts);
    if (Number.isInteger(messageId)) ensureBranchParentAnchor(state, getContext().chat || [], messageId, 'assistant-parent');
    state.turn = Number(state.turn || 0) + 1;
    const receivedMessage = Number.isInteger(messageId) ? getContext().chat?.[messageId] : null;
    const compactWorldStateTurn = hasCompactMeguminWorldState(receivedMessage?.mes || '');
    // Presence remains last-confirmed until a successful scanner observation replaces it.
    // A skipped, busy, failed, or timed-out scan must not make every NPC disappear.
    if (!compactWorldStateTurn) for (const npc of state.npcs) npc.worldActive = Boolean(npc.worldActive);
    state.assistantSinceScan = Number(state.assistantSinceScan || 0) + 1;
    const shouldForceBranchScan = forceBranchRescan && settings.branchRescan !== false;
    const autoScanDue = settings.autoScan && (settings.fullScanEveryTurn || state.assistantSinceScan >= settings.scanEvery);
    const scanExpected = shouldForceBranchScan || autoScanDue;
    // Receipt state belongs to this assistant even if scanning fails, skips or is busy.
    // A successful scan coalesces its changes into this same owned boundary.
    commitBranchCheckpoint(state, messageId, 'turn');
    persist();
    renderDossier();
    updateInjection();

    if (scanExpected) {
        if (await scanNow({ manual: false, messageId, allowDuringSwipe: bypassSwipeGuard }) === false) return;
    }
    if (getChatKey() !== eventChatKey || latestMessageId(true) !== messageId
        || eventSourceKey !== lineageCheckpointKey(chatLineage(getContext().chat || []), messageId)) return;
    await processPendingBackfills(messageId);
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
            try { await ensureChatStateLoaded(key); } catch (error) { console.error('[NPC State Delta] user-turn lineage update skipped because chat hydration failed.', error); return; }
            if (getChatKey() !== key) return;
            // This listener only maintains branch lineage; text never dispatches mutations.
            getChatState().lineage = chatLineage(getContext().chat || []);
        });
    }

    if (events.MESSAGE_RECEIVED) {
        source.on(events.MESSAGE_RECEIVED, async (messageId) => {
            await handleAssistantMessageReceived(messageId);
        });
    }
    if (events.CHARACTER_MESSAGE_RENDERED) source.on(events.CHARACTER_MESSAGE_RENDERED, () => queueInlineRender(0));
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
            queueBranchReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                operation: 'delete',
                rescan: true,
                reason: 'message-deleted',
            }, 70);
        });
    }
    if (events.MESSAGE_SWIPED) {
        source.on(events.MESSAGE_SWIPED, (messageId) => {
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
            closeNpcViewer();
            closeNpcEditor();
            let key = getChatKey();
            try {
                if (!getChatIdentity().pending && isCanonicalChatKey(getChatKey())) {
                    await migrateActiveLegacyNamespace();
                    key = getChatKey();
                }
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
            'chat rename migration',
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
    bindUi();
    installUiCaptureBridge();
    registerEvents();
    startInlineWatchdog();
    globalThis.addEventListener?.('pagehide', flushCurrentChatOnPageHide);
    globalThis.document?.addEventListener?.('visibilitychange', () => { if (globalThis.document?.visibilityState === 'hidden') flushCurrentChatOnPageHide(); });
    scheduleSettingsMountRetries();

    let key = getChatKey();
    try {
        await migrateLegacyChatStates();
        if (getChatKey() !== key) return;
        if (!getChatIdentity().pending && isCanonicalChatKey(getChatKey())) {
            await migrateActiveLegacyNamespace();
            key = getChatKey();
        }
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
    processBackfills: processPendingBackfills,
    scanDossier: value => { const npc = findNpcByIdOrName(value); return npc ? scanNpcDossier(npc.id) : false; },
    refreshFromChat: value => { const npc = findNpcByIdOrName(value); return npc ? refreshNpcFromChat(npc.id) : false; },
    portraitPrompts: value => { const npc = findNpcByIdOrName(value); return npc ? npcImagePromptPair(npc) : null; },
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
    openViewer: value => { const npc = findNpcByIdOrName(value); return npc ? openNpcViewer(npc.id, latestMessageId(true)) : false; },
    closeViewer: closeNpcViewer,
    uiStatus: () => ({
        version: NPC_STATE_VERSION,
        chatKey: getChatKey(),
        hydrationStatus: chatHydrationStatus(getChatKey()),
        hydrationError: hydrationErrors.get(getChatKey())?.message || null,
        scanBusyForChat: isScanBusy(getChatKey()),
        scanOperation: scanOperations.status(getChatKey()),
        scannerRouting: scannerRoutingMetrics(),
        inlineEntries: chatHydrationStatus(getChatKey()) === 'ready' ? (getChatState().inlineCards?.length || 0) : 0,
        mountedInlineAnchors: document.querySelectorAll?.('.npc-state-delta-inline-anchor')?.length || 0,
        integratedMeguminBlocks: document.querySelectorAll?.('.npc-state-delta-megumin-pane')?.length || 0,
        settingsPanelMounted: Boolean(document.querySelector?.(`#${UI_ID}`)),
        rosterMounted: Boolean(document.querySelector?.('#npc_state_delta_roster_summary')),
        editorMounted: editorIsMounted(),
        editorMode: activeEditorPopup ? 'sillytavern-popup' : (document.querySelector?.('#npc_state_delta_editor_overlay') ? 'legacy-overlay' : 'closed'),
        viewerOpen: Boolean(activeNpcViewerOverlay),
        viewerNpcId: activeNpcViewerId || null,
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
    }),
    exportBytes: exportBundleBytes,
    importBytes: importBundleBytes,
    reconcile: (options = {}) => reconcileCurrentBranch(options),
    scanMetrics: () => lastScanMetrics ? { ...lastScanMetrics } : null,
    diagnosticsSummary: () => diagnosticStore.summary(getChatKey()),
    diagnosticsRecords: options => diagnosticStore.records(getChatKey(), options || {}),
    diagnosticsForNpc: npcId => diagnosticStore.records(getChatKey(), { npcId: String(npcId || '') }),
    diagnosticBundle: () => diagnosticStore.bundle(getChatKey(), { applicationVersion: NPC_STATE_VERSION }),
    clearDiagnostics: () => diagnosticStore.clear(getChatKey()),
    getState: () => structuredClone(getChatState()),
    getNpc: npcId => {
        const npc = getChatState().npcs.find(item => item.id === String(npcId || ''));
        return npc ? structuredClone(npc) : null;
    },
    getDossierState: () => {
        const state = getChatState();
        return { turn: state.turn, npcs: structuredClone(state.npcs), portraitAssets: {} };
    },
    persistenceStatus: () => {
        const key = getChatKey();
        return {
            currentChatPending: Number(stateVersions.get(key) || 0) > Number(persistedVersions.get(key) || 0),
            writeInFlight: stateWritePromises.has(key),
            writeScheduled: stateWriteTimers.has(key),
        };
    },
    updateAppearance: updateNpcAppearance,
    updateLifeState: updateNpcLifeState,
    setPortrait: setNpcPortrait,
    setPortraitSeed: setNpcPortraitSeed,
    removePortrait: removeNpcPortrait,
    flush: () => flushStateFile(),
    dataFile: () => structuredClone(getSettings().dataFiles?.[getChatKey()] || null),
    archive: npcId => setNpcArchiveStateById(npcId, true, { reason: 'manual', confirmAction: false }),
    restore: npcId => setNpcArchiveStateById(npcId, false, { confirmAction: false }),
    deleteNpc: npcId => deleteNpcById(npcId, { confirmAction: false }),
});
