/* NPC State Delta chat-state freshness: revision conflicts, the server-copy check against the
   loaded state, preserved local work and canonical-state installation. Split from
   runtime-hydration.js without change; the factory keeps the public exports. */

import { NPC_STATE_VERSION } from './core.js';
import { cancelPendingNpcStateWrite, inspectNpcStateDataFile, probeNpcStateDataFilePointer, preserveUndurableNpcStateSnapshot } from './storage.js';
import { getSettings } from './runtime-settings.js';

export function installHydrationFreshness(api, rt, deps) {
    const { getChatKey, installCanonicalServerState, isCanonicalChatKey, ownershipEpoch, ownershipEpochCurrent, requestHeaders, sidecarMissTrusted, staleOwnershipError } = deps;
    const { chatStateCache, freshnessChecks, hydratedChatKeys, hydratedStateMeta, missingSidecarChats, stateWritePromises, stateWriteTimers } = rt;
    const { getChatState, hydratedRevision, updateHydratedStateMeta, recordFreshnessEvent, localWorkingStateDirty } = api;

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

    Object.assign(api, { reconcileCrossSessionWriteConflict, ensureHydratedStateFresh });
}
