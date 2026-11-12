/* NPC State Delta chat-state hydration state core: fresh and normalized chat state, cached-copy
   accessors, hydration revision metadata, freshness events, dirty marks and native-change notices.
   Split from runtime-hydration.js without change; the factory keeps the public exports. */

import { replayScope } from './runtime-scan-helpers.js';
import { normalizeAutomaticBackfillRequest } from './scan-context.js';
import { normalizeNpcRecord, normalizeNpcCandidate, normalizeFormPortraitAssets, refreshCalendarAges, storyDateKey, withStoryDateMemo } from './core.js';
import { BRANCH_LINEAGE_VERSION, ROLLBACK_JOURNAL_VERSION, normalizeUserDismissedGroups } from './branch.js';
import { normalizeSocialGraph, reconcileSocialState } from './social.js';
import { undurableNpcStateSnapshot } from './storage.js';
import { portraitHasImage } from './src/portrait-file.js';
import { getSettings } from './runtime-settings.js';

export function installHydrationState(api, rt, deps) {
    const { BACKFILL_MAX_ATTEMPTS, checkPortraitFilesSoon, getChatKey, touchChatCache } = deps;
    const { chatStateCache, hydratedChatKeys, hydratedStateMeta, workingCopyAdoptions, freshnessEvents, hydrationErrors, stateWriteTimers, stateWritePromises, stateVersions, persistedVersions, nativeChangeListeners, participantWrites } = rt;

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
        if (replayScope()?.key === key) return replayScope().state;   // a history replay works on its private copy
        // (ONEPASSCAPR2-6) Publish a deferred notice before a reopened chat's participant reads it for activation.
        if (key === getChatKey() && !((participantWrites.get(key) || 0) > 0) && owedAnnouncements.delete(key)) notifyNativeChange(key);
        if (!chatStateCache.has(key)) chatStateCache.set(key, freshChatState());
        touchChatCache(key);
        const state = chatStateCache.get(key);
        if (key === getChatKey()) refreshAgesWhenDue(key, state);
        return state;
    }

    // The stored calendarAge is fixed at scan time; a live read matches a reload (clock as it is now). The dossiers are
    // re-derived only when the story date, the dossier set or the chat's state version moved since the last pass.
    const agePasses = new WeakMap();
    function refreshAgesWhenDue(key, state) {
        const npcs = state.npcs;
        if (!Array.isArray(npcs) || !npcs.length) return;
        const stamp = `${storyDateKey()}|${Number(stateVersions.get(key) || 0)}|${npcs.length}`;
        const last = agePasses.get(npcs);
        if (last === stamp) return;
        refreshCalendarAges(npcs);
        agePasses.set(npcs, stamp);
    }

    function setChatState(key, state, { markLoaded = false } = {}) {
        if (!key || key === 'no-chat') return state;
        if (replayScope()?.key === key) return replayScope().replace(normalizeChatState(state));   // into the copy, in place
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

    function markStateDirty(key = getChatKey()) {
        if (!key || key === 'no-chat') return;
        stateVersions.set(key, Number(stateVersions.get(key) || 0) + 1);
        announceNativeChange(key);
    }

    // (ONEPASSCAP-1) A participant write holds back announcements for its chat while it waits for its save. Its own change is made in its first,
    // synchronous step (`ownStep`); a change Delta saves later in that window (a one-pass scan or a backfill committing) is owed and announced once
    // the chat's last participant write ends. Unannounced, it was never published and the host's next activate installed the older checkpoint.
    const owedAnnouncements = new Set();
    let ownStep = null;
    function announceNativeChange(key) {
        if ((participantWrites.get(key) || 0) > 0) {
            if (ownStep !== key) owedAnnouncements.add(key);
            return;
        }
        if (key !== getChatKey()) { owedAnnouncements.add(key); return; }
        notifyNativeChange(key);
    }
    function notifyNativeChange(key) {
        for (const listener of nativeChangeListeners) {
            try { listener({ key }); } catch (error) { console.debug('[NPC State Delta] a native-change listener failed', error); }
        }
    }
    async function quietly(key, task) {
        participantWrites.set(key, (participantWrites.get(key) || 0) + 1);
        const was = ownStep;
        try {
            let running;
            ownStep = key;
            try { running = task(); } finally { ownStep = was; }
            return await running;
        } finally {
            const left = (participantWrites.get(key) || 1) - 1;
            if (left > 0) participantWrites.set(key, left);
            else {
                participantWrites.delete(key);
                if (key === getChatKey() && owedAnnouncements.delete(key)) notifyNativeChange(key);
            }
        }
    }

    Object.assign(api, { freshChatState, normalizeChatState, getChatState, setChatState, workingCopyAdoption, hydratedRevision, updateHydratedStateMeta, recordFreshnessEvent, localWorkingStateDirty, markStateDirty, announceNativeChange, quietly });
}
