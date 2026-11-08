/* NPC State Delta - standalone SillyTavern extension */
import { getContext } from '../../../extensions.js';
import { extension_prompt_types, extension_prompt_roles, getRequestHeaders } from '../../../../script.js';
import {
    scannerRoutingError,
    scannerRoutingMetrics,
    scannerDiagnosticLines,
} from './scanner-routing.js';
import { createDiagnosticStore } from './diagnostics-core.js';
import {
    useTranscriptSource,
    activeChat,
    useMessageGate,
} from './src/transcript.js';
import {
    NPC_STATE_VERSION,
    normalizeRelationshipBaseline,
    normalizeRelationshipCaps,
    normalizeName,
    setStoryClockSource,
} from './core.js';
import {
    createScanOperationRegistry,
    chatLineage,
    firstLineageDivergence,
    migrateLegacyLineage,
} from './branch.js';
import {
    adoptNpcStateDataFileMetadata,
    undurableNpcStateSnapshot,
    verifyPortraitFiles,
} from './storage.js';
import { isPortraitFileRecord, markPortraitFileMissing, portraitFilesVersion, PORTRAIT_FILE_DIR, PORTRAIT_FILE_PREFIX } from './src/portrait-file.js';
import {
    normalizeSourceOfTruth,
} from './suite-handshake.js';
import {
    fillPresentSceneText,
} from './present-scene.js';
import { createCardSettingsDefinition, SCAN_EVERY_RANGE } from './src/card-settings.js';
import { createRuntimeState } from './runtime-state.js';
import { chatContext, setNpcDossierScanIndicator, setNpcChatRefreshIndicator, stampManualEdit, narrationCaptureEnabled, setScanIndicator, relationshipNumber, latestReplyIndex, latestMessageId, currentLineageKeyForMessage, clearUserDismissedSuppression } from './runtime-scan-helpers.js';
import { createInjectionPart } from './runtime-injection.js';
import { createNarrationPart } from './runtime-narration.js';
import { createScanOpsPart } from './runtime-scan-ops.js';
import { createTargetedPart } from './runtime-targeted.js';
import { createScanPart } from './runtime-scan.js';
import { createBranchPart } from './runtime-branch.js';
import { createReconcilePart } from './runtime-reconcile.js';
import { createLifecyclePart } from './runtime-lifecycle.js';
import { createChatKeysPart } from './runtime-chat-keys.js';
import { createHydrationPart } from './runtime-hydration.js';
import { createPersistPart } from './runtime-persist.js';
import { createHostedPart } from './runtime-hosted.js';
import { createCastSyncPart } from './runtime-cast-sync.js';
import { createEditorPart } from './runtime-editor.js';
import { createMutationsPart } from './runtime-mutations.js';
import { createPortraitPart } from './runtime-portrait.js';
import { createPortraitSettingsPart } from './runtime-portrait-settings.js';
import { createInlineCardsPart } from './runtime-inline-cards.js';
import { createSettingsHtmlPart } from './runtime-settings-html.js';
import { createSettingsBindPart } from './runtime-settings-bind.js';
import { persistSettings, flushPendingSettingsSave, getSettings } from './runtime-settings.js';
import { createSuitePart } from './runtime-suite.js';
import { createEventRegistration } from './runtime-entry-events.js';
import { createUiCaptureParts } from './runtime-entry-ui-events.js';
import { createCardSettingsPart } from './runtime-entry-card-settings.js';
import { createStartup } from './runtime-entry-startup.js';
import { createPublicApiReadPart } from './runtime-entry-public-read.js';
import { createPublicApiStatePart } from './runtime-entry-public-write.js';

// The chat text helpers (src/transcript.js) read the host's chat and the Scan context setting.
useTranscriptSource({ context: () => chatContext(), scanDepth: () => getSettings().scanDepth });
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
    freshnessChecks,
    missingSidecarChats,
    freshnessEvents,
    hydrationErrors,
    pendingAutoScans,
    assistantReceipts,
    narrationCaptures,
    stateWriteTimers,
    stateWritePromises,
    stateVersions,
    persistedVersions,
    castPortraitMisses,
    retiredInSessionChats,
    nativeChangeListeners,
    staleHostChats,
    openingHostChats,
    portraitActions,
} = rt;
let uiCaptureBridgeInstalled = false;
const diagnosticStore = createDiagnosticStore({ limit: 40 });
const INLINE_HISTORY_LIMIT = 80;
// Swipe and regenerate rebuild the branch after the reply arrives, so their instruction would
// describe the replaced sibling; only fresh replies and continues are asked for a block.
const NARRATION_CAPTURE_TYPES = new Set(['', 'normal', 'continue']);
// (b6-soak-3) The capture's rules, which never change from reply to reply, stay in the system prompt
// on these roleplay generations too, swipes and regenerates included, so the prompt's cached head is
// the same on a swipe; only the reminder and context (the request for a block) follow the arming.
// Quiet and impersonate generations never carry them.
const CAPTURE_RULES_TYPES = new Set([...NARRATION_CAPTURE_TYPES, 'swipe', 'regenerate']);
const SCAN_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;
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


// A v2-hosted automatic boundary may skip the deterministic-path probe: this session already found
// no sidecar for the chat, has no pointer for it and nothing has found or written one since.
function sidecarMissTrusted(key) {
    if (!missingSidecarChats.has(key) || !storyBlockV2Hosted()) return false;
    const settings = getSettings();
    return !settings.dataFiles?.[key]?.path && !settings.sidecarTombstones?.[key];
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

function requestHeaders() {
    try {
        return typeof getRequestHeaders === 'function' ? getRequestHeaders() : { 'Content-Type': 'application/json' };
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}

// The last pre-generation freshness read, which the one MESSAGE_SENT that follows it may reuse.
const GENERATION_FRESHNESS_REUSE_MS = 5000;

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

const BACKFILL_MAX_ATTEMPTS = 3;



const { getChatKey, isCanonicalChatKey, resolveOwnedChatKey, resolveDeletedChatKey, touchChatCache, evictDormantChatStates, ownershipEpoch, bumpOwnershipEpoch, ownershipEpochCurrent, staleOwnershipError, assertOwnershipEpoch } = createChatKeysPart(rt, { isScanBusy, requestHeaders });

const { freshChatState, normalizeChatState, getChatState, setChatState, workingCopyAdoption, hydratedRevision, updateHydratedStateMeta, recordFreshnessEvent, localWorkingStateDirty, reconcileCrossSessionWriteConflict, ensureHydratedStateFresh, ensureFreshMutationBoundary, runFreshMutation, chatHydrationStatus, assertChatHydratedForWrite, requireReadyChatMutation, holdRetiredLocalWork, ensureChatStateLoaded, markStateDirty, announceNativeChange, quietly } = createHydrationPart(rt, { assertOwnershipEpoch, BACKFILL_MAX_ATTEMPTS, checkPortraitFilesSoon, getChatKey, installCanonicalServerState, isCanonicalChatKey, ownershipEpoch, ownershipEpochCurrent, requestHeaders, sidecarMissTrusted, staleOwnershipError, touchChatCache });

const { queueStateFileWrite, flushStateFile, settleStateFileWrite, persist, persistCritical, persistCriticalDurable } = createPersistPart(rt, { assertChatHydratedForWrite, chatHydrationStatus, getChatKey, getChatState, holdRetiredLocalWork, isCanonicalChatKey, markStateDirty, ownershipEpoch, ownershipEpochCurrent, reconcileCrossSessionWriteConflict, requestHeaders, requireReadyChatMutation, updateHydratedStateMeta });

const { commitBranchCheckpoint, seedBranchTracking, hostSwipeState, isHostSwipeActive, hostChatComplete, maybeInheritKnownBranch, branchInheritancePending, noteAdoptedDossier, staleHostActive, staleHostPrefix } = createBranchPart(rt, { ensureChatStateLoaded, evictDormantChatStates, freshChatState, getChatKey, getChatState, isCanonicalChatKey, queueStateFileWrite, requestHeaders, setChatState });

const { storyBlockV2Hosted, storySuiteV2Meters, scanAfterEveryReply, hostedStoryClock, hostedMeterView, isKeyNpc, keyReturnNotes, castList, scenePresenceView, scanScenePresent, dossierHostViews, viewNpcCopies, keyAwayScanOptions, hostedScanState, chatHeadMark, chatHeadUnchanged, forwardRelationshipChangesToHost, hostedNotePromptOptions, hostedTargetNotes, targetNoteOptions, forwardSecretEventsToHost, attachGeneratedSecrets, castEmptyReason } = createHostedPart(rt, { chatHydrationStatus, getChatKey, getChatState, latestMessageId, latestReplyIndex });

const { liveInjectionText, updateInjection, holdCaptureRules, keepCaptureRules, clearLegacyPromptKeys, injectionPreview, scannerPromptOptions } = createInjectionPart(rt, { CAPTURE_PROMPT_DEPTH, CAPTURE_PROMPT_KEY, CAPTURE_RULES_KEY, chatHydrationStatus, getChatKey, getChatState, hostedMeterView, hostedNotePromptOptions, keyReturnNotes, LEGACY_PROMPT_KEYS, PROMPT_KEY, scenePresenceView, storySuiteV2Meters });

const { narrationCaptureStats, hostedMeters, hostedOnePass, narrationCaptureKey, dropNarrationCaptures, noteNarrationCaptureVersion, renderCapturedReply, receiveNarrationBlock, stripSwipedNarrationBlock, disarmNarrationCapture, takeNarrationCapture } = createNarrationPart(rt, { getChatKey, storySuiteV2Meters, updateInjection });

const { recordInlineCardsInState, clearInlineCardsAtMessage, removeNpcInlineCardAtMessage, purgeInlineCardsInState, scanInlineNpcIds, currentNpcById, findNpcByIdOrName, scenePresentAt, presentCastDisplayMode, applyLauncherFlag, effectivePresentCastChoice, storyBlockCastHtml, ensureInlineObserver, inlineMountNeedsRepair, startInlineWatchdog, renderInlineCards, queueInlineRender } = createInlineCardsPart(rt, { chatHydrationStatus, currentLineageKeyForMessage, getChatKey, getChatState, INLINE_HISTORY_LIMIT, isKeyNpc, latestMessageId, scenePresenceView, storyBlockV2Hosted });

const { eventTargetClosest, openLauncherDossier, activatePresentCardFromEvent } = createUiCaptureParts({ currentNpcById });

const { editorIsMounted, openNpcEditorSafely, activateNpcEditorFromEvent, renderDossier, closeNpcEditor, saveNpcEditor } = createEditorPart(rt, { chatHydrationStatus, commitBranchCheckpoint, currentNpcById, ensureFreshMutationBoundary, eventTargetClosest, getChatKey, getChatState, hostedMeterView, latestMessageId, latestReplyIndex, persistCriticalDurable, queueInlineRender, relationshipNumber, requireReadyChatMutation, stampManualEdit, startInlineWatchdog, storySuiteV2Meters, updateInjection, workingCopyAdoption });

const { recordScanDiagnostics, beginScanOperation, scanOperationCurrent, scanCanonicalBaseCurrent, endScanOperation, cancelScanOperation, withScanIntent, deferUntilSettled, replyGuard, scanWorkPending, scanIdle, generationReady, queuePendingAutoScan, drainPendingAutoScanInner, noteScanFailure, BACKFILLS_PER_REPLY, scheduleReplyBackfills } = createScanOpsPart(rt, { chatHeadMark, diagnosticStore, drainPendingAutoScan, ensureHydratedStateFresh, getChatKey, hostedOnePass, hydratedRevision, isHostSwipeActive, isScanBusy, localWorkingStateDirty, processPendingBackfills, recordFreshnessEvent, SCAN_OPERATION_TIMEOUT_MS, scanNow, scanOperations, updateInjection });

const { queueSettledSwipeReconcile, branchHistoryDiagnostic, reconcileCurrentBranch, queueBranchReconcile, deferLoadingReceipt, loadingReconcilePending } = createReconcilePart(rt, { branchInheritancePending, cancelScanOperation, deferUntilSettled, drainPendingAutoScan, ensureChatStateLoaded, getChatKey, getChatState, handleAssistantMessageReceived, hostChatComplete, isHostSwipeActive, isScanBusy, maybeInheritKnownBranch, persist, queuePendingAutoScan, renderDossier, scanNow, seedBranchTracking, setChatState, staleHostPrefix, updateInjection });

const { retryCurrentChatHydration, detachBrokenSidecar, clearLifecycleCacheKey, removeDeletedChatState, moveRenamedChatState, flushLifecycleOwner, invalidateLifecycleOwner, flushCurrentChatOnPageHide, refreshCurrentChatFromServer, runBoundedLifecycleEvent } = createLifecyclePart(rt, { bumpOwnershipEpoch, cancelScanOperation, chatHydrationStatus, ensureChatStateLoaded, freshChatState, getChatKey, getChatState, holdRetiredLocalWork, isCanonicalChatKey, renderDossier, requestHeaders, resolveDeletedChatKey, resolveOwnedChatKey, setChatState, settleStateFileWrite, updateHydratedStateMeta, updateInjection });

const { prepareCanonicalScanBase, endTargetedRewriteTolerance, runTargetedDossierPassInner, scanNpcDossier, refreshNpcFromChat, processPendingBackfillsInner } = createTargetedPart(rt, { attachGeneratedSecrets, BACKFILL_MAX_ATTEMPTS, beginScanOperation, chatHydrationStatus, commitBranchCheckpoint, editorIsMounted, endScanOperation, ensureChatStateLoaded, ensureHydratedStateFresh, findMeguminDossierSources, flushStateFile, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedMeterView, hostedTargetNotes, isHostSwipeActive, isScanBusy, noteScanFailure, persist, recordInlineCardsInState, recordScanDiagnostics, removeNpcInlineCardAtMessage, renderDossier, requireReadyChatMutation, runTargetedDossierPass, saveNpcEditor, scanCanonicalBaseCurrent, scanOperationCurrent, scenePresentAt, setChatState, settleStateFileWrite, staleHostActive, targetNoteOptions, updateInjection });

const { scanNowInner, handleAssistantMessageReceivedInner } = createScanPart(rt, { attachGeneratedSecrets, BACKFILLS_PER_REPLY, beginScanOperation, clearInlineCardsAtMessage, commitBranchCheckpoint, drainPendingAutoScan, endScanOperation, ensureChatStateLoaded, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedMeters, hostedNotePromptOptions, hostedOnePass, hostedScanState, isHostSwipeActive, isScanBusy, keyAwayScanOptions, narrationCaptureKey, narrationCaptureStats, noteScanFailure, persist, prepareCanonicalScanBase, processPendingBackfills, queuePendingAutoScan, queueSettledSwipeReconcile, recordInlineCardsInState, recordScanDiagnostics, refreshNpcFromChat, renderDossier, scanAfterEveryReply, scanCanonicalBaseCurrent, scanInlineNpcIds, scannerPromptOptions, scanNow, scanOperationCurrent, scanScenePresent, scenePresentAt, scheduleReplyBackfills, setChatState, staleHostActive, takeNarrationCapture, updateInjection });

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


const { castPortraitDue, castSync } = createCastSyncPart(rt, { castList, chatHeadMark, chatHeadUnchanged, chatHydrationStatus, commitBranchCheckpoint, ensureFreshMutationBoundary, getChatKey, getChatState, latestMessageId, persistCritical, renderDossier, requestHeaders, setChatState, storySuiteV2Meters, updateInjection });

const { updateNpcAppearance, updateNpcLifeState, npcFormName, setNpcPortrait, setNpcPortraitSeed, removeNpcPortrait, deleteNpcById, setNpcArchiveStateById, exportBundleBytes, importBundleBytes, addNpcManually } = createMutationsPart(rt, { clearUserDismissedSuppression, closeNpcEditor, commitBranchCheckpoint, editorIsMounted, ensureFreshMutationBoundary, ensureHydratedStateFresh, getChatKey, getChatState, hydratedRevision, latestMessageId, ownershipEpoch, ownershipEpochCurrent, persistCritical, persistCriticalDurable, purgeInlineCardsInState, recordFreshnessEvent, renderDossier, requestHeaders, requireReadyChatMutation, setChatState, stampManualEdit, updateInjection, workingCopyAdoption });


const { handlePortraitGeneratorEscape, npcImagePromptPair, executeNativePortraitGeneration, closePortraitGenerator, openPortraitGenerator, resetPortraitGeneratorFromDossier, generatePortraitFromDialog, useGeneratedPortrait, portraitSettingsSnapshot, normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi, confirmDiscardPortraitDraft, updatePortraitSettingsSaveUi, markPortraitSettingsDirty } = createPortraitPart(rt, { currentNpcById, eventTargetClosest, flushStateFile, getChatKey, requireReadyChatMutation, setNpcPortrait });

const { SUITE_API, renderWhatsSent, afterEnabledChange, applySourceOfTruth, syncSuiteControls, connectStorySuite } = createSuitePart(rt, { chatHydrationStatus, effectivePresentCastChoice, getChatKey, getChatState, hostedNotePromptOptions, liveInjectionText, narrationCaptureEnabled, openLauncherDossier, queueInlineRender, renderDossier, scannerPromptOptions, scenePresenceView, startInlineWatchdog, UI_ID, updateInjection });
const { buildSettingsHtml, bindSettingsGroupMemory, syncScannerProfileControl, syncSettingsControls } = createSettingsHtmlPart(rt, { applyLauncherFlag, effectivePresentCastChoice, portraitSettingsSnapshot, syncSuiteControls, UI_ID, updatePortraitSettingsSaveUi, writePortraitSettingsDraftToUi });
const { savePortraitSettingsDraft, persistPortraitCustomPresetLibrary } = createPortraitSettingsPart(rt, { normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, portraitSettingsSnapshot, syncSettingsControls, updatePortraitSettingsSaveUi });

const { bindUi, scheduleSettingsMountRetries } = createSettingsBindPart(rt, { addNpcManually, afterEnabledChange, applyLauncherFlag, applySourceOfTruth, bindSettingsGroupMemory, buildSettingsHtml, closePortraitGenerator, confirmDiscardPortraitDraft, deleteNpcById, detachBrokenSidecar, ensureFreshMutationBoundary, freshChatState, generatePortraitFromDialog, getChatKey, getChatState, hostedOnePass, latestMessageId, markPortraitSettingsDirty, openNpcEditorSafely, persistCritical, persistPortraitCustomPresetLibrary, portraitFileFailed, portraitSettingsDraftFromUi, portraitSettingsSnapshot, processPendingBackfills, queueInlineRender, refreshNpcFromChat, renderDossier, renderWhatsSent, resetPortraitGeneratorFromDossier, retryCurrentChatHydration, savePortraitSettingsDraft, scanNow, scanNpcDossier, setChatState, setNpcArchiveStateById, startInlineWatchdog, syncSettingsControls, syncSuiteControls, UI_ID, updateInjection, useGeneratedPortrait, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi });

const registerEvents = createEventRegistration(rt, { getContext, extension_prompt_types, extension_prompt_roles, migrateLegacyLineage, chatLineage, setScanIndicator, narrationCaptureEnabled, syncScannerProfileControl, getChatKey, ensureChatStateLoaded, chatHydrationStatus, getChatState, staleHostActive, generationReady, updateInjection, noteNarrationCaptureVersion, GENERATION_FRESHNESS_REUSE_MS, NARRATION_CAPTURE_TYPES, CAPTURE_RULES_TYPES, disarmNarrationCapture, CAPTURE_RULES_KEY, CAPTURE_PROMPT_KEY, CAPTURE_PROMPT_DEPTH, holdCaptureRules, keepCaptureRules, receiveNarrationBlock, handleAssistantMessageReceived, renderCapturedReply, queueInlineRender, dropNarrationCaptures, queueBranchReconcile, endTargetedRewriteTolerance, stripSwipedNarrationBlock, queueSettledSwipeReconcile, flushPendingSettingsSave, castPortraitMisses, cancelScanOperation, closePortraitGenerator, closeNpcEditor, staleHostChats, retiredInSessionChats, openingHostChats, isCanonicalChatKey, maybeInheritKnownBranch, branchInheritancePending, deferLoadingReceipt, loadingReconcilePending, seedBranchTracking, persist, isScanBusy, renderDossier, ensureInlineObserver, drainPendingAutoScan, castPortraitDue, castSync, evictDormantChatStates, runBoundedLifecycleEvent, removeDeletedChatState, moveRenamedChatState, chatStateCache });
// What a character card may recommend (Story Block 2.21.0 card settings, src/card-settings.js). Each save is the one the
// settings panel itself makes: the prompt format through "Save prompt settings", Scan every as its box does.
const nsdCardSettings = createCardSettingsPart({ rt, createCardSettingsDefinition, SCAN_EVERY_RANGE, portraitSettingsSnapshot, getSettings, savePortraitSettingsDraft, portraitSettingsDraftFromUi, writePortraitSettingsDraftToUi, updatePortraitSettingsSaveUi, persistSettings });
const { init, safeInit } = createStartup(rt, { getSettings, clearLegacyPromptKeys, connectStorySuite, SUITE_API, UI_ID, NPC_STATE_VERSION, latestReplyIndex, castSync, castPortraitDue, normalizeSourceOfTruth, nsdCardSettings, setStoryClockSource, hostedStoryClock, bindUi, installUiCaptureBridge, registerEvents, startInlineWatchdog, flushCurrentChatOnPageHide, refreshCurrentChatFromServer, scheduleSettingsMountRetries, getChatKey, isCanonicalChatKey, ensureChatStateLoaded, maybeInheritKnownBranch, seedBranchTracking, getChatState, renderDossier, updateInjection, evictDormantChatStates });
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
const publicReadApi = createPublicApiReadPart({ getContext, NPC_STATE_VERSION, scannerRoutingMetrics, scannerDiagnosticLines, chatLineage, firstLineageDivergence, narrationCaptureEnabled, getSettings, UI_ID, rt, scanNow, getChatKey, pendingAutoScans, cancelScanOperation, processPendingBackfills, ensureFreshMutationBoundary, findNpcByIdOrName, scanNpcDossier, refreshNpcFromChat, npcFormName, npcImagePromptPair, executeNativePortraitGeneration, openPortraitGenerator, portraitSettingsSnapshot, savePortraitSettingsDraft, nsdCardSettings, renderDossier, renderInlineCards, openNpcEditorSafely, openLauncherDossier, injectionPreview, chatHydrationStatus, hydrationErrors, isScanBusy, scanOperations, narrationCaptureStats, narrationCaptures, getChatState, editorIsMounted, presentCastDisplayMode, inlineMountNeedsRepair, branchHistoryDiagnostic, branchReconciliationEvents, hostSwipeState, hydratedRevision, hydratedStateMeta, freshnessEvents, hydratedChatKeys, ensureChatStateLoaded, ensureHydratedStateFresh, exportBundleBytes, importBundleBytes, reconcileCurrentBranch, diagnosticStore });
const publicStateApi = createPublicApiStatePart({ normalizeChatState, getChatKey, requestHeaders, ensureFreshMutationBoundary, quietly, setChatState, persistCriticalDurable, renderDossier, updateInjection, getChatState, nativeChangeListeners, chatStateCache, branchInheritancePending, maybeInheritKnownBranch, chatHydrationStatus, loadingReconcilePending, scanWorkPending, scanIdle, useMessageGate, normalizeRelationshipBaseline, normalizeRelationshipCaps, getSettings, storyBlockCastHtml, castEmptyReason, addNpcManually, fillPresentSceneText, stateVersions, latestReplyIndex, viewNpcCopies, hostedMeterView, dossierHostViews, hydrationErrors, portraitFilesVersion, persistedVersions, stateWritePromises, stateWriteTimers, hydratedRevision, hydratedStateMeta, undurableNpcStateSnapshot, runFreshMutation, updateNpcAppearance, updateNpcLifeState, setNpcPortrait, setNpcPortraitSeed, removeNpcPortrait, flushStateFile, setNpcArchiveStateById, deleteNpcById, storySuiteV2Meters, freshChatState, installState: state => publicStateApi.installState(state), handleAssistantMessageReceivedInner, processPendingBackfills, hostedOnePass, BACKFILLS_PER_REPLY });
window.NPCStateDelta = Object.freeze({ ...publicReadApi, ...publicStateApi });
