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
import { setNpcDossierScanIndicator, setNpcChatRefreshIndicator, stampManualEdit, narrationCaptureEnabled, setScanIndicator, relationshipNumber, latestReplyIndex, latestMessageId, currentLineageKeyForMessage, clearUserDismissedSuppression } from './runtime-scan-helpers.js';
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
import { persistSettings, getSettings } from './runtime-settings.js';
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
let lastPresentCardActivation = { npcId: '', at: 0 };
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

const { commitBranchCheckpoint, seedBranchTracking, hostSwipeState, isHostSwipeActive, maybeInheritKnownBranch, branchInheritancePending, noteAdoptedDossier, staleHostActive, staleHostPrefix } = createBranchPart(rt, { ensureChatStateLoaded, evictDormantChatStates, freshChatState, getChatKey, getChatState, isCanonicalChatKey, queueStateFileWrite, setChatState });

const { storyBlockV2Hosted, storySuiteV2Meters, scanAfterEveryReply, hostedStoryClock, hostedMeterView, isKeyNpc, keyReturnNotes, castList, scenePresenceView, scanScenePresent, dossierHostViews, viewNpcCopies, keyAwayScanOptions, hostedScanState, chatHeadMark, chatHeadUnchanged, forwardRelationshipChangesToHost, hostedNotePromptOptions, hostedTargetNotes, targetNoteOptions, forwardSecretEventsToHost, attachGeneratedSecrets, castEmptyReason } = createHostedPart(rt, { chatHydrationStatus, getChatKey, getChatState, latestMessageId, latestReplyIndex });

const { liveInjectionText, updateInjection, holdCaptureRules, keepCaptureRules, clearLegacyPromptKeys, injectionPreview, scannerPromptOptions } = createInjectionPart(rt, { CAPTURE_PROMPT_DEPTH, CAPTURE_PROMPT_KEY, CAPTURE_RULES_KEY, chatHydrationStatus, getChatKey, getChatState, hostedMeterView, hostedNotePromptOptions, keyReturnNotes, LEGACY_PROMPT_KEYS, PROMPT_KEY, scenePresenceView, storySuiteV2Meters });

const { narrationCaptureStats, hostedMeters, hostedOnePass, narrationCaptureKey, dropNarrationCaptures, noteNarrationCaptureVersion, renderCapturedReply, receiveNarrationBlock, stripSwipedNarrationBlock, disarmNarrationCapture, takeNarrationCapture } = createNarrationPart(rt, { getChatKey, storySuiteV2Meters, updateInjection });

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

const { recordScanDiagnostics, beginScanOperation, scanOperationCurrent, scanCanonicalBaseCurrent, endScanOperation, cancelScanOperation, withScanIntent, deferUntilSettled, replyGuard, scanWorkPending, scanIdle, generationReady, queuePendingAutoScan, drainPendingAutoScanInner, noteScanFailure, BACKFILLS_PER_REPLY, scheduleReplyBackfills } = createScanOpsPart(rt, { chatHeadMark, diagnosticStore, drainPendingAutoScan, ensureHydratedStateFresh, getChatKey, hostedOnePass, hydratedRevision, isHostSwipeActive, isScanBusy, localWorkingStateDirty, processPendingBackfills, recordFreshnessEvent, SCAN_OPERATION_TIMEOUT_MS, scanNow, scanOperations, updateInjection });

const { queueSettledSwipeReconcile, branchHistoryDiagnostic, reconcileCurrentBranch, queueBranchReconcile } = createReconcilePart(rt, { cancelScanOperation, deferUntilSettled, drainPendingAutoScan, ensureChatStateLoaded, getChatKey, getChatState, handleAssistantMessageReceived, isHostSwipeActive, isScanBusy, persist, queuePendingAutoScan, renderDossier, scanNow, seedBranchTracking, setChatState, staleHostPrefix, updateInjection });

const { retryCurrentChatHydration, detachBrokenSidecar, clearLifecycleCacheKey, removeDeletedChatState, moveRenamedChatState, flushLifecycleOwner, invalidateLifecycleOwner, flushCurrentChatOnPageHide, refreshCurrentChatFromServer, runBoundedLifecycleEvent } = createLifecyclePart(rt, { bumpOwnershipEpoch, cancelScanOperation, chatHydrationStatus, ensureChatStateLoaded, freshChatState, getChatKey, getChatState, holdRetiredLocalWork, isCanonicalChatKey, renderDossier, requestHeaders, resolveDeletedChatKey, resolveOwnedChatKey, setChatState, settleStateFileWrite, updateHydratedStateMeta, updateInjection });

const { prepareCanonicalScanBase, endTargetedRewriteTolerance, runTargetedDossierPassInner, scanNpcDossier, refreshNpcFromChat, processPendingBackfillsInner } = createTargetedPart(rt, { attachGeneratedSecrets, BACKFILL_MAX_ATTEMPTS, beginScanOperation, chatHydrationStatus, commitBranchCheckpoint, editorIsMounted, endScanOperation, ensureChatStateLoaded, ensureHydratedStateFresh, findMeguminDossierSources, flushStateFile, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedTargetNotes, isHostSwipeActive, isScanBusy, noteScanFailure, persist, recordInlineCardsInState, recordScanDiagnostics, removeNpcInlineCardAtMessage, renderDossier, requireReadyChatMutation, runTargetedDossierPass, saveNpcEditor, scanCanonicalBaseCurrent, scanOperationCurrent, scenePresentAt, setChatState, settleStateFileWrite, staleHostActive, targetNoteOptions, updateInjection });

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
    stateFailed: () => chatHydrationStatus() === 'error',
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
