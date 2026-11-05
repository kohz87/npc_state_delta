/* NPC State Delta persistence scheduling (role: chat-state-persistence). The one owner of writing a chat's state to its sidecar: the delayed write queue,
   the flush with its ownership and conflict handling, settling a write, and the persist calls the rest of Delta makes (normal, critical, critical and
   durable). Built by index.js once per module instance with the shared runtime state. Bodies are moved from index.js without change. */

import { NPC_STATE_VERSION } from './core.js';
import { writeNpcStateDataFile } from './storage.js';
import { persistSettings, getSettings } from './runtime-settings.js';

export function createPersistPart(rt, deps) {
    const { assertChatHydratedForWrite, chatHydrationStatus, getChatKey, getChatState, holdRetiredLocalWork, isCanonicalChatKey, markStateDirty, ownershipEpoch, ownershipEpochCurrent, reconcileCrossSessionWriteConflict, requestHeaders, requireReadyChatMutation, updateHydratedStateMeta } = deps;
    const { chatStateCache, missingSidecarChats, stateWriteTimers, stateWritePromises, stateVersions, persistedVersions } = rt;

    const STATE_WRITE_DELAY = 120;

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

    return { queueStateFileWrite, flushStateFile, settleStateFileWrite, persist, persistCritical, persistCriticalDurable };
}
