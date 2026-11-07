/* NPC State Delta - public state, host-integration and manual-mutation API (role: runtime-entry-public-write). The
   second half of the window.NPCStateDelta surface split from index.js. Built by index.js with the controller closure;
   index.js still assigns and freezes the combined object in its original property order. */

import { readAheadOf } from './scan-context.js';
import { activeReplyIds } from './src/transcript.js';
import { chatContext, inReplay } from './runtime-scan-helpers.js';

const quietKeys = new Set(['timeline', 'catchUp']);

/**
 * What a history replay needs of the live runtime. Nothing here changes the open chat's dossiers except install (the finished copy, once) and the
 * quiet writes of the catch-up field and of the scan marker; none of them is a native change. `reply` runs the live per-reply path on the copy: the
 * chat is the messages up to that reply, Story Block is read as of it, its time is that reply's send date, and every outward write goes to the sink.
 */
function createReplayBoundaries(deps) {
    const { getChatKey, getChatState, freshChatState, normalizeChatState, installState, handleAssistantMessageReceivedInner, processPendingBackfills, hostedOnePass, BACKFILLS_PER_REPLY, quietly, persistCriticalDurable } = deps;
    const runs = new WeakMap();   // copy -> the receipts and catch-up marks the replay keeps for itself
    const fingerprint = state => JSON.stringify(Object.fromEntries(Object.entries(state ?? {}).filter(([key]) => !quietKeys.has(key))));
    const writeLive = async change => {
        const key = getChatKey();
        return quietly(key, async () => {
            change(getChatState(key));
            if (!await persistCriticalDurable(key)) throw new Error('The catch-up could not be saved yet.');
            return true;
        });
    };
    const markRead = (state, id) => Object.assign(state, { lastScannedMessageId: id, assistantSinceScan: 0, readAhead: [] });
    return {
        // The surviving replies the saved scan marker has not reached, oldest first, and whether every one of `ids` is still a reply of the chat.
        pending: () => {
            const state = getChatState();
            const after = Number.isInteger(state.lastScannedMessageId) ? state.lastScannedMessageId : -1;
            const read = new Set(readAheadOf(state));
            return { ids: activeReplyIds().filter(id => id > after && !read.has(id)), marker: after >= 0 ? after : null };
        },
        all: () => activeReplyIds(),
        active: ids => { const now = new Set(activeReplyIds()); return ids.every(id => now.has(id)); },
        copy: () => structuredClone(normalizeChatState(getChatState())),
        empty: () => structuredClone(freshChatState()),
        state: () => getChatState(),
        markRead,
        head: () => {
            const chat = chatContext().chat || [];
            const last = chat[chat.length - 1] ?? null;
            return { key: getChatKey(), length: chat.length, last, swipe: Number.isInteger(last?.swipe_id) ? last.swipe_id : null, state: fingerprint(getChatState()) };
        },
        install: async state => { await installState(state); },
        writeCatchUp: field => writeLive(live => { if (field) live.catchUp = field; else delete live.catchUp; }),
        markReadLive: id => writeLive(live => { markRead(live, id); delete live.catchUp; }),
        reply: async (copy, id, sink, key) => {
            if (getChatKey() !== key) return { ok: false, message: 'The chat changed.' };
            const real = chatContext().chat || [];
            if (!real[id]) return { ok: false, message: `Reply ${id} is not in the chat.` };
            const run = runs.get(copy) ?? runs.set(copy, { receipts: new Map(), catchUp: new Set(), time: null }).get(copy);
            const sent = Date.parse(real[id]?.send_date);
            if (Number.isFinite(sent)) run.time = sent;
            const scope = {
                key, state: copy, chat: real.slice(0, id + 1), at: id, sink, receipts: run.receipts, catchUp: run.catchUp, failed: null,
                now: () => run.time ?? Date.now(),
                replace: next => { for (const name of Object.keys(copy)) delete copy[name]; return Object.assign(copy, next); },
                backfills: mid => processPendingBackfills(mid, { limit: hostedOnePass() ? 1 : BACKFILLS_PER_REPLY, skipNpcIds: [] }).catch(() => {}),
            };
            await inReplay(scope, () => handleAssistantMessageReceivedInner(id, { bypassSwipeGuard: true }));
            return scope.failed ? { ok: false, message: scope.failed } : undefined;
        },
    };
}

export function createPublicApiStatePart(deps) {
    const {
        normalizeChatState, getChatKey, requestHeaders, ensureFreshMutationBoundary, quietly, setChatState,
        persistCriticalDurable, renderDossier, updateInjection, getChatState, nativeChangeListeners, chatStateCache,
        branchInheritancePending, maybeInheritKnownBranch, chatHydrationStatus, loadingReconcilePending, scanWorkPending, scanIdle,
        useMessageGate, normalizeRelationshipBaseline, normalizeRelationshipCaps, getSettings, storyBlockCastHtml,
        castEmptyReason, addNpcManually, fillPresentSceneText, stateVersions, latestReplyIndex, viewNpcCopies,
        hostedMeterView, dossierHostViews, hydrationErrors, portraitFilesVersion, persistedVersions,
        stateWritePromises, stateWriteTimers, hydratedRevision, hydratedStateMeta, undurableNpcStateSnapshot,
        runFreshMutation, updateNpcAppearance, updateNpcLifeState, setNpcPortrait, setNpcPortraitSeed,
        removeNpcPortrait, flushStateFile, setNpcArchiveStateById, deleteNpcById, storySuiteV2Meters,
    } = deps;

    return {
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
    timelineReady: () => chatHydrationStatus() === 'ready' && !loadingReconcilePending(),
    stateFailed: () => chatHydrationStatus() === 'error',
    stateLoading: () => chatHydrationStatus() === 'loading',
    scanActive: () => scanWorkPending(),
    scanIdle: ms => scanIdle(ms),
    // History replay (src/storysuite-participant/history-replay.js reads these): the boundaries between the engine and the live scan path.
    replay: createReplayBoundaries(deps),
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
    };
}
