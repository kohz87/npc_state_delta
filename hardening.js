import { extension_settings, getContext } from '../../../extensions.js';
import { getRequestHeaders, saveSettings as saveHostSettings } from '../../../../script.js';
import { NPC_STATE_VERSION } from './core.js';
import { setBranchProvenanceHint } from './branch.js';
import {
    buildQualifiedChatKey,
    chatOwnerScope,
    getCharacterOwnerId,
    getChatIdentityFromContext,
    parseQualifiedChatKey,
} from './identity.js';
import {
    deleteNpcStateDataFile,
    makeNpcStateRecoveryFileName,
    readNpcStateDataFile,
    retireNpcStateDataFile,
    writeNpcStateDataFile,
} from './storage.js';
import {
    allSettingsKeys,
    applyCanonicalOwnershipMove,
    destinationKeyForOwnerRename,
    qualifiedKeysForOwner,
    resolveGroupOwnerId,
    uniqueQualifiedKeyForChat,
} from './hardening-core.js';

const EXTENSION_NAME = 'npc_state_delta';
const RECOVERY_HISTORY_LIMIT = 80;
const LIFECYCLE_EVENT_WAIT_MS = 12_000;
const LIFECYCLE_RETRY_DELAY_MS = 30_000;
const lifecycleEventOperations = new Map();
const lifecycleRetryTimers = new Map();
let installed = false;
let lifecycleEventSequence = 0;

function settings() {
    const value = extension_settings[EXTENSION_NAME] && typeof extension_settings[EXTENSION_NAME] === 'object'
        ? extension_settings[EXTENSION_NAME]
        : (extension_settings[EXTENSION_NAME] = {});
    for (const key of ['dataFiles', 'sidecarTombstones', 'recoveryFiles', 'recoveryHistory', 'recoveryGarbage']) {
        if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) value[key] = {};
    }
    return value;
}

function queueSettingsSave() {
    try { getContext()?.saveSettingsDebounced?.(); }
    catch (error) { console.debug('[NPC State Delta] settings save was deferred', error); }
}

async function saveSettingsNow() {
    await saveHostSettings();
}

function headers() {
    try { return getRequestHeaders?.() || {}; }
    catch { return {}; }
}

function archiveRecoveryRecord(config, key, reason = 'superseded') {
    const existing = config.recoveryFiles?.[key];
    if (!existing) return;
    const stamp = Date.now();
    const historyKey = `${key}@${stamp}:${Math.random().toString(36).slice(2, 8)}`;
    config.recoveryHistory[historyKey] = { ...structuredClone(existing), archivedAt: stamp, archiveReason: reason };
    delete config.recoveryFiles[key];
    const entries = Object.entries(config.recoveryHistory).sort((a, b) => Number(b[1]?.archivedAt || 0) - Number(a[1]?.archivedAt || 0));
    for (const [oldKey, record] of entries.slice(RECOVERY_HISTORY_LIMIT)) {
        if (record?.path) config.recoveryGarbage[oldKey] = { name: record.name || '', path: record.path, queuedAt: Date.now() };
        delete config.recoveryHistory[oldKey];
    }
}

async function cleanupRecoveryGarbage(config = settings()) {
    let changed = false;
    for (const [key, pointer] of Object.entries(config.recoveryGarbage || {})) {
        if (!pointer?.path) { delete config.recoveryGarbage[key]; changed = true; continue; }
        try {
            await deleteNpcStateDataFile(pointer, { headers: headers() });
            delete config.recoveryGarbage[key];
            changed = true;
        } catch (error) {
            console.debug(`[NPC State Delta] recovery garbage cleanup deferred for ${pointer.path}.`, error);
        }
    }
    if (changed) await saveHostSettings();
    return changed;
}

async function stateFromPointer(key, pointer, inlineState = null) {
    if (pointer?.path) {
        const payload = await readNpcStateDataFile(pointer, { expectedChatKey: key });
        if (!payload || payload.retired || !payload.state) return null;
        return structuredClone(payload.state);
    }
    return inlineState && typeof inlineState === 'object' ? structuredClone(inlineState) : null;
}

async function writeVerifiedState(key, state, pointer = null, { operationKey = '' } = {}) {
    const written = await writeNpcStateDataFile({
        chatKey: key,
        state,
        appVersion: NPC_STATE_VERSION,
        pointer,
        operationKey,
        continuousRetry: false,
        headers: headers(),
    });
    const verified = await readNpcStateDataFile(written, { expectedChatKey: key });
    if (!verified || verified.retired || !verified.state) throw new Error(`NPC State Delta verification failed after writing ${key}.`);
    return written;
}

async function writeRecovery(key, state, reason) {
    const name = makeNpcStateRecoveryFileName(key);
    const operationKey = `recovery:${key}:${name}`;
    const pointer = await writeVerifiedState(key, state, { name }, { operationKey });
    return { ...pointer, reason: String(reason || 'recovery'), recoveredAt: Date.now() };
}

function installBranchProvenanceHint() {
    const ctx = getContext() || {};
    const identity = getChatIdentityFromContext(ctx);
    const metadata = ctx.chatMetadata || ctx.chat_metadata || {};
    setBranchProvenanceHint({
        mainChat: metadata?.main_chat || '',
        ownerScope: chatOwnerScope(identity.key),
        currentKey: identity.key,
    });
}

async function moveCharacterOwnerState(oldAvatar, newAvatar) {
    const oldOwner = String(oldAvatar || '').trim();
    const newOwner = String(newAvatar || '').trim();
    if (!oldOwner || !newOwner || oldOwner === newOwner) return false;
    const config = settings();
    const moved = new Map();
    const retiredPredecessors = [];
    let changed = false;
    let cachesSettled = false;
    const failedKeys = [];
    try {
        await globalThis.__NPCStateDeltaLifecycle?.flushOwner?.('chat', oldOwner);
        cachesSettled = true;

        const sourceKeys = qualifiedKeysForOwner(config, 'chat', oldOwner);
        if (!sourceKeys.length) return false;

        for (const oldKey of sourceKeys) {
            const newKey = destinationKeyForOwnerRename(oldKey, newOwner);
            if (!newKey || newKey === oldKey) continue;
            const oldPointer = config.dataFiles?.[oldKey] || null;

            // Preserve historical retirement knowledge without pretending recovery/branch-index
            // records are live state that can be copied into a new canonical owner.
            if (!oldPointer?.path) {
                if (config.sidecarTombstones?.[oldKey]) {
                    applyCanonicalOwnershipMove(config, { oldKey, newKey, reason: 'character-renamed' });
                    moved.set(oldKey, newKey);
                    changed = true;
                }
                continue;
            }
            if (config.dataFiles?.[newKey]) {
                console.warn(`[NPC State Delta] character rename preserved ${oldKey}; destination ${newKey} already has live state.`);
                continue;
            }

            let state = null;
            let newPointer = null;
            let recoveryPointer = null;
            let sourceRetired = !oldPointer?.path;
            try {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    state = await stateFromPointer(oldKey, oldPointer);
                    if (!state) throw new Error(`NPC State Delta character rename could not read live source ${oldKey}.`);
                    newPointer = await writeVerifiedState(newKey, state, newPointer?.path ? newPointer : null);
                    if (recoveryPointer?.path) {
                        try { await deleteNpcStateDataFile(recoveryPointer, { headers: headers() }); }
                        catch (error) {
                            config.recoveryGarbage[`rename-temp:${oldKey}:${Date.now()}:${attempt}`] = { ...recoveryPointer, queuedAt: Date.now(), reason: 'rename-temp-cleanup' };
                            console.debug('[NPC State Delta] queued failed rename recovery cleanup.', error);
                        }
                    }
                    recoveryPointer = await writeRecovery(oldKey, state, `character-renamed:${newKey}`);
                    if (!oldPointer?.path) { sourceRetired = true; break; }
                    try {
                        await retireNpcStateDataFile({ chatKey: oldKey, pointer: oldPointer, reason: `character-renamed:${newKey}`, appVersion: NPC_STATE_VERSION, headers: headers() });
                        sourceRetired = true;
                        break;
                    } catch (error) {
                        if (error?.code !== 'NPC_STATE_WRITE_CONFLICT' || attempt >= 3) throw error;
                        console.info(`[NPC State Delta] character rename retirement raced another writer for ${oldKey}; re-reading before retry.`);
                    }
                }
                if (!sourceRetired || !state || !newPointer) throw new Error(`NPC State Delta character rename could not retire ${oldKey} safely.`);

                archiveRecoveryRecord(config, newKey, 'canonical-ownership-reestablished');
                applyCanonicalOwnershipMove(config, { oldKey, newKey, newPointer, recoveryPointer, reason: 'character-renamed' });
                moved.set(oldKey, newKey);
                if (oldPointer?.path) retiredPredecessors.push({ key: oldKey, pointer: oldPointer });
                changed = true;
            } catch (error) {
                if (newPointer?.path) {
                    try { await deleteNpcStateDataFile(newPointer, { headers: headers() }); } catch { /* best effort */ }
                }
                if (recoveryPointer?.path) {
                    try { await deleteNpcStateDataFile(recoveryPointer, { headers: headers() }); }
                    catch {
                        config.recoveryGarbage[`rename-failed:${oldKey}:${Date.now()}`] = { ...recoveryPointer, queuedAt: Date.now(), reason: 'rename-failed-cleanup' };
                    }
                }
                failedKeys.push({ key: oldKey, error });
                console.warn(`[NPC State Delta] character rename preserved ${oldKey} and continued with other chats.`, error);
            }
        }

        if (changed) {
            await saveSettingsNow();
            for (const predecessor of retiredPredecessors) {
                try { await deleteNpcStateDataFile(predecessor.pointer, { headers: headers() }); }
                catch (error) { console.warn(`[NPC State Delta] retired character-rename predecessor ${predecessor.key} could not be physically deleted.`, error); }
            }
            await cleanupRecoveryGarbage(config);
        }
        if (failedKeys.length) {
            const error = new AggregateError(failedKeys.map(item => item.error), `NPC State Delta character rename left ${failedKeys.length} chat(s) under the old owner for retry.`);
            error.code = 'NPC_STATE_OWNER_RENAME_PARTIAL';
            error.failures = failedKeys.map(item => item.key);
            throw error;
        }
        return changed;
    } finally {
        if (cachesSettled) {
            globalThis.__NPCStateDeltaLifecycle?.invalidateOwner?.('chat', oldOwner);
            globalThis.__NPCStateDeltaLifecycle?.invalidateOwner?.('chat', newOwner);
        }
    }
}

async function retireCharacterOwner(avatar, reason = 'character-deleted') {
    const owner = String(avatar || '').trim();
    if (!owner) return false;
    const config = settings();
    let changed = false;
    const retiredPredecessors = [];
    let cachesSettled = false;
    const failedKeys = [];
    try {
        await globalThis.__NPCStateDeltaLifecycle?.flushOwner?.('chat', owner);
        cachesSettled = true;
        const keys = qualifiedKeysForOwner(config, 'chat', owner).filter(key => config.dataFiles?.[key]?.path);
        if (!keys.length) return false;

        for (const key of keys) {
            const pointer = config.dataFiles?.[key] || null;
            let recoveryPointer = null;
            try {
                const state = await stateFromPointer(key, pointer);
                recoveryPointer = state ? await writeRecovery(key, state, reason) : null;
                if (pointer?.path) await retireNpcStateDataFile({ chatKey: key, pointer, reason, appVersion: NPC_STATE_VERSION, headers: headers() });

                archiveRecoveryRecord(config, key, 'character-deleted-replaced');
                if (recoveryPointer) config.recoveryFiles[key] = recoveryPointer;
                config.sidecarTombstones[key] = { reason, at: Date.now() };
                delete config.dataFiles[key];                if (pointer?.path) retiredPredecessors.push({ key, pointer });
                changed = true;
            } catch (error) {
                if (recoveryPointer?.path) {
                    try { await deleteNpcStateDataFile(recoveryPointer, { headers: headers() }); }
                    catch {
                        config.recoveryGarbage[`delete-failed:${key}:${Date.now()}`] = { ...recoveryPointer, queuedAt: Date.now(), reason: 'delete-failed-cleanup' };
                    }
                }
                failedKeys.push({ key, error });
                console.warn(`[NPC State Delta] character deletion preserved ${key} and continued with other chats.`, error);
            }
        }
        if (changed) {
            await saveSettingsNow();
            for (const predecessor of retiredPredecessors) {
                try { await deleteNpcStateDataFile(predecessor.pointer, { headers: headers() }); }
                catch (error) { console.warn(`[NPC State Delta] retired character-delete predecessor ${predecessor.key} could not be physically deleted.`, error); }
            }
            await cleanupRecoveryGarbage(config);
        }
        if (failedKeys.length) {
            const error = new AggregateError(failedKeys.map(item => item.error), `NPC State Delta character deletion left ${failedKeys.length} live chat(s) for retry.`);
            error.code = 'NPC_STATE_OWNER_DELETE_PARTIAL';
            error.failures = failedKeys.map(item => item.key);
            throw error;
        }
        return changed;
    } finally {
        if (cachesSettled) globalThis.__NPCStateDeltaLifecycle?.invalidateOwner?.('chat', owner);
    }
}

function reportLifecycleError(label, error) {
    console.error(`[NPC State Delta] ${label} failed`, error);
    try { globalThis.toastr?.error?.(`NPC State Delta ${label} failed safely. Existing state was preserved or recovery-staged.`, 'NPC State Delta'); } catch { /* noop */ }
}

function queueActiveCharacterCacheRefresh(newAvatar) {
    const expectedOwner = String(newAvatar || '').trim();
    if (!expectedOwner) return;
    const delays = [0, 60, 180, 400, 800];
    let completed = false;
    for (const delay of delays) {
        globalThis.setTimeout?.(() => {
            if (completed) return;
            void (async () => {
                const ctx = getContext() || {};
                if (ctx.groupId) { completed = true; return; }
                if (getCharacterOwnerId(ctx) !== expectedOwner) return;
                const event = (ctx.eventTypes || ctx.event_types || {}).CHAT_CHANGED;
                const source = ctx.eventSource;
                if (!event || typeof source?.emit !== 'function') return;
                completed = true;
                await source.emit(event, ctx.chatId || ctx.getCurrentChatId?.() || '');
            })().catch(error => reportLifecycleError('post-rename cache hydration', error));
        }, delay);
    }
}

function scheduleHardeningRetry(operationKey, label, task) {
    if (lifecycleRetryTimers.has(operationKey)) return;
    const timer = globalThis.setTimeout?.(() => {
        lifecycleRetryTimers.delete(operationKey);
        void runBoundedHardeningEvent(operationKey, label, task);
    }, LIFECYCLE_RETRY_DELAY_MS);
    if (timer) lifecycleRetryTimers.set(operationKey, timer);
}

async function runBoundedHardeningEvent(operationKey, label, task, { retryOnFailure = true } = {}) {
    const key = String(operationKey || label || 'hardening');
    let operation = lifecycleEventOperations.get(key);
    if (!operation) {
        operation = Promise.resolve().then(task);
        lifecycleEventOperations.set(key, operation);
        void operation.catch(error => {
            console.warn(`[NPC State Delta] ${label} background transaction failed; scheduling retry.`, error);
            if (retryOnFailure) scheduleHardeningRetry(key, label, task);
        });
        operation.then(
            () => lifecycleEventOperations.get(key) === operation && lifecycleEventOperations.delete(key),
            () => lifecycleEventOperations.get(key) === operation && lifecycleEventOperations.delete(key),
        );
    }
    let timer = null;
    const timeout = new Promise(resolve => {
        timer = globalThis.setTimeout?.(() => resolve({ timedOut: true }), LIFECYCLE_EVENT_WAIT_MS);
    });
    const observed = operation.then(
        value => ({ timedOut: false, value }),
        error => ({ timedOut: false, error }),
    );
    const outcome = await Promise.race([observed, timeout]);
    if (timer) globalThis.clearTimeout?.(timer);
    if (outcome.timedOut) {
        console.warn(`[NPC State Delta] ${label} exceeded ${LIFECYCLE_EVENT_WAIT_MS / 1000}s; SillyTavern may continue while the fail-closed transaction remains in the background.`);
        return false;
    }
    if (outcome.error) {
        reportLifecycleError(label, outcome.error);
        if (retryOnFailure) scheduleHardeningRetry(key, label, task);
        return false;
    }
    return true;
}

export async function prepareNpcStateHardening() {
    if (installed) return;
    const ctx = getContext() || {};
    const source = ctx.eventSource;
    const events = ctx.eventTypes || ctx.event_types || {};
    if (!source || typeof source.on !== 'function') return;
    installed = true;
    const on = source.on.bind(source);

    if (events.CHARACTER_RENAMED) on(events.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const eventId = ++lifecycleEventSequence;
        return runBoundedHardeningEvent(
            `character-rename:${String(oldAvatar || '')}->${String(newAvatar || '')}:${eventId}`,
            'character owner rename',
            async () => {
                try { await moveCharacterOwnerState(oldAvatar, newAvatar); }
                finally { queueActiveCharacterCacheRefresh(newAvatar); }
            },
        );
    });
    if (events.CHARACTER_DELETED) on(events.CHARACTER_DELETED, data => {
        const avatar = String(data?.character?.avatar || data?.avatar || '').trim();
        if (!avatar) return undefined;
        const eventId = ++lifecycleEventSequence;
        return runBoundedHardeningEvent(
            `character-delete:${avatar}:${eventId}` ,
            'character deletion retirement',
            () => retireCharacterOwner(avatar, 'character-deleted'),
        );
    });

    installBranchProvenanceHint();
    // Recovery garbage cleanup is best-effort; do not block bootstrap on a sidecar outage.
    void cleanupRecoveryGarbage(settings()).catch(error => console.debug('[NPC State Delta] startup recovery garbage cleanup deferred.', error));
}
