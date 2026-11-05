/* NPC State Delta chat lifecycle (role: chat-lifecycle). What happens to a chat's sidecar when the chat or its owner is deleted, renamed or
   reloaded: the transactional delete and rename (recovery copy, retirement, tombstone), owner flush and invalidation, the page-hide flush, the
   bounded lifecycle event with its background retry, and the manual reload or detach of a chat's sidecar. Built by index.js once per module
   instance with the shared runtime state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { saveSettings as saveHostSettings } from '../../../../script.js';
import { NPC_STATE_VERSION } from './core.js';
import { chatLineage } from './branch.js';
import { deleteNpcStateDataFile, makeNpcStateDataFileName, makeNpcStateRecoveryFileName, readNpcStateDataFile, retireNpcStateDataFile, quarantineUnreadableNpcStateDataFile, writeNpcStateDataFile } from './storage.js';
import { buildQualifiedChatKey, getCharacterOwnerId, parseQualifiedChatKey } from './identity.js';
import { lifecycleRenameStateIsEmpty } from './hardening-core.js';
import { persistSettings, flushPendingSettingsSave, getSettings } from './runtime-settings.js';

export function createLifecyclePart(rt, deps) {
    const { bumpOwnershipEpoch, cancelScanOperation, chatHydrationStatus, ensureChatStateLoaded, freshChatState, getChatKey, getChatState, holdRetiredLocalWork, isCanonicalChatKey, renderDossier, requestHeaders, resolveDeletedChatKey, resolveOwnedChatKey, setChatState, settleStateFileWrite, updateHydratedStateMeta, updateInjection } = deps;
    const { chatStateCache, hydratedChatKeys, hydratedStateMeta, freshnessChecks, loadingChatStates, hydrationErrors, pendingAutoScans, assistantReceipts, stateWriteTimers, stateWritePromises, stateVersions, persistedVersions, chatCacheTouches, lifecycleEventOperations, lifecycleRetryTimers } = rt;

    const LIFECYCLE_EVENT_WAIT_MS = 12_000;
    const LIFECYCLE_RETRY_DELAY_MS = 30_000;

    async function retryCurrentChatHydration() {
        flushPendingSettingsSave();
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
        flushPendingSettingsSave();
        const key = getChatKey();
        if (key === 'no-chat' || !hydratedChatKeys.has(key) || !chatStateCache.has(key)) return;
        void settleStateFileWrite(key, { flush: true }).catch(error => console.debug('[NPC State Delta] page-hide flush deferred', error));
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

    return { retryCurrentChatHydration, detachBrokenSidecar, clearLifecycleCacheKey, removeDeletedChatState, moveRenamedChatState, flushLifecycleOwner, invalidateLifecycleOwner, flushCurrentChatOnPageHide, refreshCurrentChatFromServer, runBoundedLifecycleEvent };
}
