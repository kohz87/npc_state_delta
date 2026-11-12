/* NPC State Delta persistence facade: sidecar identity, payload codec, file transport and inspection
   live in focused parts; this file owns writer locking, the durability queue, sidecar writes and the
   recovery/retire/read/delete operations. Every public name previously exported here remains exported. */
import { createStorageIdentity } from './storage-identity.js';
import { bytesToBase64, decodeStateFileHead, decodeStateFilePayload, encodeRetiredStateFilePayload as encodeRetiredStateFilePayloadFile, encodeStateFilePayload as encodeStateFilePayloadFile, NPC_STATE_FILE_FORMAT, NPC_STATE_FILE_FORMAT_VERSION, pruneFormPortraitAssetsForState, prunePortraitAssetsForState, prunePortraitAssetsInPlace, retainedPortraitAssetIds } from './storage-payload.js';
import { dataFileExists, uploadPayload } from './storage-files.js';
import { createStorageInspection } from './storage-inspection.js';

export { dataFileExists, dataFilesExist, deleteNpcStateDataFile, readPortraitFileDataUrl, savePortraitFile, verifyPortraitFiles } from './storage-files.js';

const identity = createStorageIdentity();
const { fnv1a } = identity;
const inspection = createStorageInspection({ dataFileExists, decodeStateFilePayload, decodeStateFileHead, makeNpcStateDataFileName: identity.makeNpcStateDataFileName });
const { adoptNpcStateDataFileMetadata, inspectNpcStateDataFile, probeNpcStateDataFilePointer, remoteRevision } = inspection;

export const NPC_STATE_WRITE_RETRY_DELAYS_MS = Object.freeze([0, 1000, 2000, 5000, 15000, 30000]);
export const NPC_STATE_DURABILITY_RETRY_CAP_MS = 30000;

const durabilityQueue = new Map();
const undurableSnapshots = new Map();
const writerLocks = new Map();
const CROSS_TAB_LOCK_LEASE_MS = 15_000;
const CROSS_TAB_LOCK_ACQUIRE_MS = 5_000;
const writerId = identity.currentWriterId();

export const currentWriterId = identity.currentWriterId;
export const makeNpcStateDataFileName = identity.makeNpcStateDataFileName;
export const makeNpcStateRecoveryFileName = identity.makeNpcStateRecoveryFileName;
export { NPC_STATE_FILE_FORMAT, NPC_STATE_FILE_FORMAT_VERSION, bytesToBase64, decodeStateFileHead, decodeStateFilePayload, pruneFormPortraitAssetsForState, prunePortraitAssetsForState, prunePortraitAssetsInPlace, retainedPortraitAssetIds };
export { adoptNpcStateDataFileMetadata, inspectNpcStateDataFile, probeNpcStateDataFilePointer };

export function encodeStateFilePayload(chatKey, state, appVersion = '', metadata = {}) {
    return encodeStateFilePayloadFile(chatKey, state, appVersion, metadata, writerId);
}

export function encodeRetiredStateFilePayload(chatKey, reason = 'retired', appVersion = '', metadata = {}) {
    return encodeRetiredStateFilePayloadFile(chatKey, reason, appVersion, metadata, writerId);
}

async function withInProcessWriterLock(chatKey, task) {
    const key = String(chatKey || '');
    const previous = writerLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    writerLocks.set(key, queued);
    await previous.catch(() => {});
    try { return await task(); }
    finally {
        release();
        if (writerLocks.get(key) === queued) writerLocks.delete(key);
    }
}

function localStorageLockRecord(storage, key) {
    try {
        const value = JSON.parse(String(storage.getItem(key) || 'null'));
        if (!value || typeof value !== 'object') return null;
        return { token: String(value.token || ''), expiresAt: Number(value.expiresAt || 0) };
    } catch { return null; }
}

async function withLocalStorageWriterLock(chatKey, task) {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
        return withInProcessWriterLock(chatKey, task);
    }
    const key = `npc-state-delta-writer-lock:${fnv1a(String(chatKey || ''))}`;
    const token = `${writerId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + CROSS_TAB_LOCK_ACQUIRE_MS;
    while (Date.now() <= deadline) {
        const now = Date.now();
        const current = localStorageLockRecord(storage, key);
        if (!current || !current.token || current.expiresAt <= now) {
            try { storage.setItem(key, JSON.stringify({ token, expiresAt: now + CROSS_TAB_LOCK_LEASE_MS })); }
            catch { return withInProcessWriterLock(chatKey, task); }
            await wait(12 + Math.floor(Math.random() * 18));
            const confirmed = localStorageLockRecord(storage, key);
            if (confirmed?.token === token) {
                const renew = globalThis.setInterval?.(() => {
                    try {
                        const owned = localStorageLockRecord(storage, key);
                        if (owned?.token === token) storage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + CROSS_TAB_LOCK_LEASE_MS }));
                    } catch { /* lease expiry remains the safety fallback */ }
                }, Math.max(1000, Math.floor(CROSS_TAB_LOCK_LEASE_MS / 3)));
                try { return await withInProcessWriterLock(chatKey, task); }
                finally {
                    if (renew) globalThis.clearInterval?.(renew);
                    try { if (localStorageLockRecord(storage, key)?.token === token) storage.removeItem(key); } catch { /* lease expires */ }
                }
            }
        }
        await wait(18 + Math.floor(Math.random() * 24));
    }
    const error = new Error(`NPC State Delta could not acquire the cross-tab sidecar lock for ${chatKey}.`);
    error.code = 'NPC_STATE_LOCK_TIMEOUT';
    throw error;
}

async function withWriterLock(chatKey, task) {
    const name = `npc-state-delta-sidecar:${fnv1a(String(chatKey || ''))}`;
    const locks = globalThis.navigator?.locks;
    if (locks && typeof locks.request === 'function') {
        return locks.request(name, { mode: 'exclusive' }, () => withInProcessWriterLock(chatKey, task));
    }
    return withLocalStorageWriterLock(chatKey, task);
}

function retryableWriteError(error) {
    if (['NPC_STATE_WRITE_CONFLICT', 'NPC_STATE_WRITE_CANCELLED', 'NPC_STATE_UNSUPPORTED_FORMAT'].includes(error?.code)) return false;
    if (error?.code === 'NPC_STATE_LOCK_TIMEOUT') return true;
    const status = Number(error?.status || 0);
    if ([408, 425, 429].includes(status) || status >= 500) return true;
    // The wrapper says 'write failed' for every response. Do not let that wording
    // turn authentication, permission, validation or size rejection into endless retries.
    if (status >= 400 && status < 500) return false;
    return !status || /network|fetch|timeout|temporar|unavailable|failed/i.test(String(error?.message || error));
}

function wait(ms, sleepFn = globalThis.setTimeout) {
    return new Promise(resolve => sleepFn(resolve, Math.max(0, Number(ms) || 0)));
}

async function guardedWriteOnce(job) {
    const { chatKey, state, appVersion, pointer, fetchFn, headers, assertCurrent = () => {} } = job;
    return withWriterLock(chatKey, async () => {
        assertCurrent();
        const expectedRevision = Number.isFinite(Number(pointer?.revision)) ? Math.max(0, Math.trunc(Number(pointer.revision))) : null;
        const probedDeterministicPath = !pointer?.path;
        // A write with no pointer is a chat's first (the deterministic path is probed): the file is usually not there yet, so
        // it is asked about first (probeHeaders) and a chat's first save makes no 404 request. Pointered writes read it as before.
        const probeHeaders = probedDeterministicPath && headers && Object.keys(headers).length ? headers : null;
        const current = await remoteRevision(probeNpcStateDataFilePointer(chatKey, pointer), chatKey, fetchFn, probeHeaders);
        // The previous attempt of this same job may have become durable although its response or
        // post-upload verification was lost. Only the exact revision/writer/timestamp nonce of that
        // upload proves ownership; the job's state is immutable, so adopting it is byte-equivalent.
        const lost = job.lastUpload;
        if (lost && current.exists && current.revision === lost.revision
            && current.writerId === writerId && current.updatedAtText === lost.updatedAt) {
            return { name: lost.name, path: lost.path || pointer?.path || probeNpcStateDataFilePointer(chatKey, pointer).path, updatedAt: Date.now(), revision: lost.revision, writerId };
        }
        // An unpointered writer may replace a retired tombstone (for example a reused chat name), but
        // never a live canonical sidecar that another session created after this one hydrated.
        if (expectedRevision === null && current.exists && current.revision > 0 && !(probedDeterministicPath && current.retired)) {
            const error = new Error(`NPC State Delta sidecar already has revision ${current.revision}, but this tab has no matching revision token. Reload the chat before saving again.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = null;
            error.actualRevision = current.revision;
            throw error;
        }
        if (expectedRevision !== null && current.exists && current.revision !== expectedRevision) {
            const error = new Error(`NPC State Delta sidecar changed in another tab or writer (expected revision ${expectedRevision}, found ${current.revision}). Reload the chat before saving again.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = expectedRevision;
            error.actualRevision = current.revision;
            error.expectedWriterId = String(pointer?.writerId || '');
            error.actualWriterId = String(current.writerId || '');
            throw error;
        }
        const expectedWriterId = String(pointer?.writerId || '');
        if (expectedRevision !== null && current.exists && current.revision === expectedRevision
            && expectedWriterId && current.writerId && current.writerId !== expectedWriterId) {
            const error = new Error(`NPC State Delta sidecar revision ${expectedRevision} belongs to a different writer than this working copy. Reload the chat before saving again.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = expectedRevision;
            error.actualRevision = current.revision;
            error.expectedWriterId = expectedWriterId;
            error.actualWriterId = String(current.writerId || '');
            throw error;
        }
        const revision = Math.max(current.revision, expectedRevision ?? 0) + 1;
        const name = pointer?.name || makeNpcStateDataFileName(chatKey);
        const updatedAt = new Date().toISOString();
        const json = encodeStateFilePayload(chatKey, state, appVersion, { revision, writerId, updatedAt });
        assertCurrent();
        job.lastUpload = { name, path: '', revision, updatedAt };
        const result = await uploadPayload({ name, json, fetchFn, headers });
        job.lastUpload.path = String(result.path || '');
        // The read-back still asks the server; when it returns exactly the bytes just uploaded, their revision
        // and writer are the ones written, and the next boundary check finds this file by its ETag (1.10.1).
        const written = { text: json, meta: { chatKey: String(chatKey || ''), revision, writerId, retired: false, updatedAtText: updatedAt } };
        const verified = await remoteRevision({ path: result.path }, chatKey, fetchFn, null, written);
        if (!verified.exists || verified.revision !== revision || (verified.writerId && verified.writerId !== writerId)) {
            const error = new Error(`NPC State Delta sidecar write verification lost ownership at revision ${revision}; another session wrote the canonical file concurrently.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = revision;
            error.actualRevision = verified.exists ? verified.revision : null;
            error.expectedWriterId = writerId;
            error.actualWriterId = String(verified.writerId || '');
            throw error;
        }
        return { name, path: result.path, updatedAt: Date.now(), revision, writerId };
    });
}

export function cancelPendingNpcStateWrite(chatKey) {
    const key = String(chatKey || '');
    const job = durabilityQueue.get(key);
    if (job) job.cancelled = true;
    const removedQueued = durabilityQueue.delete(key);
    const removedShadow = undurableSnapshots.delete(key);
    return removedQueued || removedShadow;
}

export function pendingNpcStateDurabilityKeys() {
    return [...new Set([...durabilityQueue.keys(), ...undurableSnapshots.keys()])];
}

export function undurableNpcStateSnapshot(chatKey) {
    const entry = undurableSnapshots.get(String(chatKey || ''));
    return entry ? structuredClone(entry) : null;
}

function rememberUndurableSnapshot({ chatKey, state, appVersion = '', pointer = null, error = null, recoveryOnly = false, reason = '' }) {
    const key = String(chatKey || '');
    if (!key) return;
    undurableSnapshots.set(key, {
        chatKey: key,
        state: structuredClone(state || {}),
        appVersion: String(appVersion || ''),
        pointer: pointer && typeof pointer === 'object' ? structuredClone(pointer) : null,
        errorCode: String(error?.code || ''),
        expectedRevision: Number.isFinite(Number(error?.expectedRevision)) ? Math.max(0, Math.trunc(Number(error.expectedRevision))) : null,
        actualRevision: Number.isFinite(Number(error?.actualRevision)) ? Math.max(0, Math.trunc(Number(error.actualRevision))) : null,
        recoveryOnly: recoveryOnly === true,
        reason: String(reason || '').slice(0, 160),
        rememberedAt: Date.now(),
    });
}

export function preserveUndurableNpcStateSnapshot({ chatKey, state, appVersion = '', pointer = null, error = null, reason = 'cross-session-conflict' }) {
    rememberUndurableSnapshot({ chatKey, state, appVersion, pointer, error, recoveryOnly: true, reason });
    return undurableNpcStateSnapshot(chatKey);
}

export async function writeNpcStateDataFile({ chatKey, state, appVersion = '', pointer = null, operationKey = '', fetchFn = globalThis.fetch, headers = {}, sleepFn = globalThis.setTimeout, continuousRetry = true, recoveryState = () => state, isCurrent = () => true }) {
    const key = String(chatKey || '');
    const durabilityKey = String(operationKey || key);
    if (durabilityQueue.has(durabilityKey)) {
        const error = new Error(`NPC State Delta already has a durability retry in progress for ${durabilityKey}.`);
        error.code = 'NPC_STATE_WRITE_IN_PROGRESS';
        throw error;
    }
    const job = {
        chatKey: key, durabilityKey, state, appVersion, pointer, fetchFn, headers,
        cancelled: false, attempt: 0, lastError: null, recoveryState,
        assertCurrent() {
            if (!job.cancelled && isCurrent()) return;
            const error = new Error(`NPC State Delta durability retry for ${key} was cancelled.`);
            error.code = 'NPC_STATE_WRITE_CANCELLED';
            throw error;
        },
    };
    // Track cancellation from the first attempt, including failures while acquiring the lock
    // or checking the remote revision. Every terminal failure shares one recovery exit.
    durabilityQueue.set(durabilityKey, job);
    try {
        if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file persistence.');
        const retryDelays = continuousRetry ? NPC_STATE_WRITE_RETRY_DELAYS_MS : [0, 250, 750, 1500];
        for (const delay of retryDelays) {
            if (delay) await wait(delay, sleepFn);
            job.assertCurrent();
            try {
                const written = await guardedWriteOnce(job);
                job.assertCurrent();
                undurableSnapshots.delete(key);
                return written;
            } catch (error) {
                job.lastError = error;
                if (!retryableWriteError(error)) throw error;
            }
        }
        if (!continuousRetry) throw job.lastError || new Error(`NPC State Delta bounded sidecar write failed for ${key}.`);
        console.warn(`[NPC State Delta] sidecar write for ${key} is still dirty after bounded retries; retaining the active write lock and retrying every ${NPC_STATE_DURABILITY_RETRY_CAP_MS / 1000}s until it is durable.`);
        while (true) {
            await wait(NPC_STATE_DURABILITY_RETRY_CAP_MS, sleepFn);
            job.assertCurrent();
            try {
                const written = await guardedWriteOnce(job);
                job.assertCurrent();
                undurableSnapshots.delete(key);
                if (pointer && typeof pointer === 'object') Object.assign(pointer, written);
                console.info(`[NPC State Delta] recovered a previously failed sidecar write for ${key} at revision ${written.revision}.`);
                return written;
            } catch (error) {
                job.lastError = error;
                job.attempt += 1;
                if (!retryableWriteError(error)) throw error;
            }
        }
    } catch (error) {
        if (continuousRetry && !job.cancelled && isCurrent()) {
            rememberUndurableSnapshot({ chatKey: key, state: recoveryState(), appVersion, pointer, error });
        }
        throw error;
    } finally {
        if (durabilityQueue.get(durabilityKey) === job) durabilityQueue.delete(durabilityKey);
    }
}

// Detach of an unreadable sidecar: copy its exact bytes to a recovery file (verified), then replace
// the canonical file with a retired marker, which a fresh unpointered write may replace. Without
// this, the deterministic path still holds the unreadable bytes and every fresh write fails on them.
export async function quarantineUnreadableNpcStateDataFile({ chatKey, pointer, appVersion = '', fetchFn = globalThis.fetch, headers = {}, onPreserved = null }) {
    if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file persistence.');
    const key = String(chatKey || '');
    if (!pointer?.path) return null;
    cancelPendingNpcStateWrite(key);
    return withWriterLock(key, async () => {
        const response = await fetchFn(pointer.path, { method: 'GET', cache: 'no-store' });
        if (response?.status === 404) return null;
        if (!response?.ok) throw new Error(`NPC State Delta could not read the broken sidecar to preserve it (HTTP ${response?.status || 'error'}).`);
        const raw = typeof response.text === 'function' ? await response.text() : '';
        // A retry after an uncertain retirement acknowledgement finds this detach's own marker. The
        // original bytes were already preserved and registered (onPreserved), so the empty marker
        // must never be backed up in their place.
        let marker = null;
        try { marker = decodeStateFilePayload(raw); } catch { marker = null; }
        if (marker?.retired && marker.retireReason === 'manual-detach' && String(marker.chatKey || '') === key) {
            const recorded = marker.recoveryPath ? { name: String(marker.recoveryName || ''), path: String(marker.recoveryPath) } : {};
            return { alreadyDetached: true, preservedFrom: pointer.path, ...recorded };
        }
        const copyName = makeNpcStateRecoveryFileName(key).replace(/\.json$/i, '-unreadable.json');
        const copy = await uploadPayload({ name: copyName, json: raw, fetchFn, headers });
        const check = await fetchFn(copy.path, { method: 'GET', cache: 'no-store' });
        if (!check?.ok || (typeof check.text === 'function' ? await check.text() : null) !== raw) {
            throw new Error('NPC State Delta could not verify the preserved copy of the broken sidecar; nothing was detached.');
        }
        const preserved = { name: copyName, path: copy.path, preservedFrom: pointer.path };
        // Register the verified backup before the destructive canonical replacement, so a lost
        // acknowledgement of that replacement cannot lose the only reference to the original bytes.
        if (typeof onPreserved === 'function') await onPreserved({ ...preserved });
        const name = pointer.name || makeNpcStateDataFileName(key);
        await uploadPayload({ name, json: encodeRetiredStateFilePayload(key, 'manual-detach', appVersion, { revision: 1, writerId, recoveryPath: copy.path, recoveryName: copyName }), fetchFn, headers });
        return preserved;
    });
}

export async function retireNpcStateDataFile({ chatKey, pointer = null, reason = 'retired', appVersion = '', fetchFn = globalThis.fetch, headers = {} }) {
    if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file persistence.');
    const key = String(chatKey || '');
    cancelPendingNpcStateWrite(key);
    return withWriterLock(key, async () => {
        const name = pointer?.name || makeNpcStateDataFileName(key);
        const expectedRevision = Number.isFinite(Number(pointer?.revision)) ? Math.max(0, Math.trunc(Number(pointer.revision))) : null;
        let current = { revision: expectedRevision ?? 0, exists: false };
        if (pointer?.path) current = await remoteRevision(pointer, key, fetchFn);
        if (expectedRevision === null && current.exists && current.revision > 0) {
            const error = new Error(`NPC State Delta sidecar changed before retirement; this tab has no matching revision token (found revision ${current.revision}).`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = null;
            error.actualRevision = current.revision;
            throw error;
        }
        if (expectedRevision !== null && current.exists && current.revision !== expectedRevision) {
            const error = new Error(`NPC State Delta sidecar changed before retirement (expected revision ${expectedRevision}, found ${current.revision}).`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = expectedRevision;
            error.actualRevision = current.revision;
            error.expectedWriterId = String(pointer?.writerId || '');
            error.actualWriterId = String(current.writerId || '');
            throw error;
        }
        const expectedWriterId = String(pointer?.writerId || '');
        if (expectedRevision !== null && current.exists && current.revision === expectedRevision
            && expectedWriterId && current.writerId && current.writerId !== expectedWriterId) {
            const error = new Error(`NPC State Delta sidecar revision ${expectedRevision} changed writer before retirement.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = expectedRevision;
            error.actualRevision = current.revision;
            error.expectedWriterId = expectedWriterId;
            error.actualWriterId = String(current.writerId || '');
            throw error;
        }
        const revision = Math.max(current.revision, expectedRevision ?? 0) + 1;
        const json = encodeRetiredStateFilePayload(key, reason, appVersion, { revision, writerId });
        // Only an explicit client-error response proves the retired payload was not written. A lost
        // or unreadable acknowledgement, or a server error, may follow a committed write.
        let result;
        try {
            result = await uploadPayload({ name, json, fetchFn, headers });
        } catch (error) {
            const status = Number(error?.status || 0);
            if (!(status >= 400 && status < 500)) error.retirementUncertain = true;
            throw error;
        }
        // The retired payload may already have replaced the live dossier. Any failure from here on
        // leaves that outcome uncertain, so callers must keep every copy they made.
        let verified;
        try {
            verified = await remoteRevision({ path: result.path }, key, fetchFn);
        } catch (error) {
            error.retirementUncertain = true;
            throw error;
        }
        if (!verified.exists || verified.revision !== revision || (verified.writerId && verified.writerId !== writerId) || !verified.retired) {
            const error = new Error(`NPC State Delta sidecar retirement verification lost ownership at revision ${revision}.`);
            error.code = 'NPC_STATE_WRITE_CONFLICT';
            error.expectedRevision = revision;
            error.actualRevision = verified.exists ? verified.revision : null;
            error.expectedWriterId = writerId;
            error.actualWriterId = String(verified.writerId || '');
            error.retirementUncertain = true;
            throw error;
        }
        return { name, path: result.path, updatedAt: Date.now(), retired: true, revision, writerId };
    });
}

export async function readNpcStateDataFile(pointer, { fetchFn = globalThis.fetch, expectedChatKey = '', probeHeaders = null } = {}) {
    const pendingKey = String(expectedChatKey || '');
    const pending = pendingKey ? durabilityQueue.get(pendingKey) : null;
    const shadow = pendingKey ? undurableSnapshots.get(pendingKey) : null;
    const resident = pending && !pending.cancelled ? pending : (shadow?.recoveryOnly ? null : shadow);
    if (resident) {
        return {
            format: NPC_STATE_FILE_FORMAT,
            version: NPC_STATE_FILE_FORMAT_VERSION,
            appVersion: String(resident.appVersion || ''),
            chatKey: pendingKey,
            updatedAt: new Date(Number(resident.rememberedAt || Date.now())).toISOString(),
            retired: false,
            reason: '',
            revision: Math.max(0, Math.trunc(Number(pointer?.revision) || 0)),
            writerId,
            state: structuredClone(resident.recoveryState ? resident.recoveryState() : (resident.state || {})),
            undurable: true,
        };
    }
    if (!pointer?.path) return null;
    if (typeof fetchFn !== 'function') throw new Error('fetch() is unavailable for NPC State Delta data-file persistence.');
    const inspected = await inspectNpcStateDataFile(pointer, { fetchFn, expectedChatKey, probeHeaders });
    if (!inspected.exists) return null;
    // Full hydration is the point at which a caller deliberately adopts the durable revision.
    // A cheap freshness probe uses inspectNpcStateDataFile() directly and never mutates this
    // token before deciding whether a dirty working copy conflicts with the server.
    adoptNpcStateDataFileMetadata(pointer, inspected);
    return inspected.payload;
}
