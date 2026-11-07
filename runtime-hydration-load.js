/* NPC State Delta chat-state loading and write gates: sidecar discovery and retry, loaded-state
   installation, freshness-gated mutations, hydration status, retirement holding and the readiness
   checks a write must pass. Split from runtime-hydration.js without change; the factory keeps the
   public exports. */

import { NPC_STATE_VERSION } from './core.js';
import { cancelPendingNpcStateWrite, makeNpcStateDataFileName, preserveUndurableNpcStateSnapshot, readNpcStateDataFile, undurableNpcStateSnapshot } from './storage.js';
import { persistSettings, getSettings } from './runtime-settings.js';

export function installHydrationLoad(api, rt, deps) {
    const { assertOwnershipEpoch, checkPortraitFilesSoon, getChatKey, isCanonicalChatKey, ownershipEpoch, requestHeaders, staleOwnershipError } = deps;
    const { chatStateCache, hydratedChatKeys, missingSidecarChats, loadingChatStates, hydrationErrors, stateWriteTimers, stateVersions, persistedVersions, retiredInSessionChats } = rt;
    const { freshChatState, setChatState, updateHydratedStateMeta, ensureHydratedStateFresh } = api;

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

    Object.assign(api, { ensureFreshMutationBoundary, runFreshMutation, chatHydrationStatus, assertChatHydratedForWrite, requireReadyChatMutation, holdRetiredLocalWork, ensureChatStateLoaded });
}
