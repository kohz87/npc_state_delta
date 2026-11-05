/* NPC State Delta chat-state hydration (role: chat-state-hydration). The owner of a chat's loaded state: the fresh and normalized state, reading
   and replacing the cached copy, loading the chat's sidecar, the freshness check against the server copy and its conflict handling, the hydration
   status and the gates a write must pass, and the dirty mark and native-change notice. Built by index.js once per module instance with the shared
   runtime state. Bodies are moved from index.js without change. */

import { normalizeAutomaticBackfillRequest } from './scan-context.js';
import { NPC_STATE_VERSION, normalizeNpcRecord, normalizeNpcCandidate, normalizeFormPortraitAssets, withStoryDateMemo } from './core.js';
import { BRANCH_LINEAGE_VERSION, ROLLBACK_JOURNAL_VERSION, normalizeUserDismissedGroups } from './branch.js';
import { normalizeSocialGraph, reconcileSocialState } from './social.js';
import { cancelPendingNpcStateWrite, inspectNpcStateDataFile, makeNpcStateDataFileName, probeNpcStateDataFilePointer, preserveUndurableNpcStateSnapshot, readNpcStateDataFile, undurableNpcStateSnapshot } from './storage.js';
import { portraitHasImage } from './src/portrait-file.js';
import { persistSettings, getSettings } from './runtime-settings.js';

export function createHydrationPart(rt, deps) {
    const { assertOwnershipEpoch, BACKFILL_MAX_ATTEMPTS, checkPortraitFilesSoon, getChatKey, installCanonicalServerState, isCanonicalChatKey, ownershipEpoch, ownershipEpochCurrent, requestHeaders, sidecarMissTrusted, staleOwnershipError, touchChatCache } = deps;
    const { chatStateCache, hydratedChatKeys, hydratedStateMeta, workingCopyAdoptions, freshnessChecks, missingSidecarChats, freshnessEvents, loadingChatStates, hydrationErrors, stateWriteTimers, stateWritePromises, stateVersions, persistedVersions, retiredInSessionChats, nativeChangeListeners, participantWrites } = rt;

    const FRESHNESS_EVENT_LIMIT = 24;

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

    return { freshChatState, normalizeChatState, getChatState, setChatState, workingCopyAdoption, hydratedRevision, updateHydratedStateMeta, recordFreshnessEvent, localWorkingStateDirty, reconcileCrossSessionWriteConflict, ensureHydratedStateFresh, ensureFreshMutationBoundary, runFreshMutation, chatHydrationStatus, assertChatHydratedForWrite, requireReadyChatMutation, holdRetiredLocalWork, ensureChatStateLoaded, markStateDirty, announceNativeChange, quietly };
}
