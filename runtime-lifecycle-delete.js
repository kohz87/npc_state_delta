/* NPC State Delta deleted-chat lifecycle transaction: preserve a recovery copy, settle the newest
   writer, retire the revision-checked sidecar, publish the tombstone and clear only after proof.
   Split unchanged from runtime-lifecycle.js with live rt/deps helper references supplied by
   createLifecyclePart. */
import { saveSettings as saveHostSettings } from '../../../../script.js';
import { NPC_STATE_VERSION } from './core.js';
import { deleteNpcStateDataFile, makeNpcStateDataFileName, makeNpcStateRecoveryFileName, retireNpcStateDataFile, writeNpcStateDataFile } from './storage.js';
import { persistSettings, getSettings } from './runtime-settings.js';

export function createLifecycleDelete(deps, helpers) {
    const { requestHeaders, resolveDeletedChatKey, settleStateFileWrite } = deps;
    const { clearLifecycleCacheKey, loadLatestLifecycleState, queueRecoveryGarbagePointer } = helpers;

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

    return { removeDeletedChatState };
}
