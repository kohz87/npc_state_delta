/* NPC State Delta scan operations (role: scan-operations). The lifecycle of one scan operation (begin, the canonical-base check before a result is merged,
   end, cancel), the dossier-work intent gate and the deferral of work that finds the host's head-selection barrier still up, the idle wait, the
   generation gate, the queue of automatic scans and its drain, the backfills started after a reply, and the scan diagnostics record. The registry
   itself is created in index.js (the chat-key part takes isScanBusy at construction). Built by index.js once per module instance with the shared
   runtime state. Bodies are moved from index.js without change. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { isEmptyScannerAnswer } from './scanner-routing.js';
import { refreshMessageGate, messageGateSettled } from './src/transcript.js';
import { chatLineage, fingerprintMessage, lineageCheckpointKey } from './branch.js';
import { getSettings } from './runtime-settings.js';
import { replayScope, setNpcDossierScanIndicator, setNpcChatRefreshIndicator, lineageMoved, setScanIndicator, latestMessageId } from './runtime-scan-helpers.js';

export function createScanOpsPart(rt, deps) {
    const { chatHeadMark, diagnosticStore, drainPendingAutoScan, ensureHydratedStateFresh, getChatKey, hostedOnePass, hydratedRevision, isHostSwipeActive, isScanBusy, localWorkingStateDirty, processPendingBackfills, recordFreshnessEvent, SCAN_OPERATION_TIMEOUT_MS, scanNow, scanOperations, updateInjection } = deps;
    const { hydratedStateMeta, pendingAutoScans, stateVersions, scanIntents, deferredWork, emptyAnswerChats } = rt;

    function diagnosticNpcIds(scanResult = {}, report = null) {
        const values = [];
        for (const row of Array.isArray(scanResult?.npcs) ? scanResult.npcs : []) if (row?.id) values.push(String(row.id));
        const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
            : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
        for (const row of profile) if (row?.id) values.push(String(row.id));
        for (const row of Array.isArray(report?.profileDevelopment) ? report.profileDevelopment : []) if (row?.npcId) values.push(String(row.npcId));
        for (const row of Array.isArray(report?.birthdayDiagnostics) ? report.birthdayDiagnostics : []) if (row?.npcId) values.push(String(row.npcId));
        return [...new Set(values)].slice(0, 64);
    }
    function recordScanDiagnostics(chatKey, metrics = {}, scanResult = {}, report = null, extra = {}) {
        return diagnosticStore.record(chatKey, {
            type: metrics?.label || extra?.type || 'scan',
            at: metrics?.at || Date.now(),
            durationMs: metrics?.durationMs || 0,
            sourceMessageId: extra?.sourceMessageId,
            retried: metrics?.retried,
            targeted: extra?.targeted,
            npcIds: extra?.npcIds?.length ? extra.npcIds : diagnosticNpcIds(scanResult, report),
            profileUpdates: metrics?.profileUpdates || 0,
            profileApplied: metrics?.profileApplied || 0,
            profileEvidenceAdded: metrics?.profileEvidenceAdded || 0,
            relationshipApplied: Number(report?.relationshipEvents?.length || 0),
            promptEstimateTokens: Math.ceil(Number(metrics?.promptChars || 0) / 4),
            responseEstimateTokens: Math.ceil(Number(metrics?.responseChars || 0) / 4),
            profileDevelopment: report?.profileDevelopment || metrics?.profileDevelopment || [],
            birthdayDiagnostics: report?.birthdayDiagnostics || [],
        });
    }

    function beginScanOperation(key, label, metadata = {}) {
        const operation = scanOperations.begin(key, label, metadata);
        if (!operation) return null;
        const lineage = chatLineage(getContext().chat || []);
        const localRevision = Number(stateVersions.get(key) || 0);
        const canonicalRevision = hydratedRevision(key);
        operation.canonicalRevision = canonicalRevision;
        // The chat's head when the scan began (forwardRelationshipChangesToHost).
        operation.chatHead = chatHeadMark();
        operation.requestController = new AbortController();
        operation.requestScope = {
            route: { profileId: getSettings().scannerConnectionProfile },
            chatKey: key,
            operationId: operation.id,
            signal: operation.requestController.signal,
            deadline: operation.startedAt + SCAN_OPERATION_TIMEOUT_MS,
            isCurrent: () => scanOperations.isCurrent(key, operation)
                && getChatKey() === key
                && Number(stateVersions.get(key) || 0) === localRevision
                && hydratedRevision(key) === canonicalRevision
                && !lineageMoved(lineage, chatLineage(getContext().chat || []), operation.sourceMessageId),
        };
        return operation;
    }
    function scanOperationCurrent(key, operation) { return scanOperations.isCurrent(key, operation); }
    async function scanCanonicalBaseCurrent(key, operation, label = 'scan') {
        if (replayScope()?.key === key) return getChatKey() === key && scanOperationCurrent(key, operation);
        const baseRevision = Math.max(0, Math.trunc(Number(operation?.canonicalRevision) || 0));
        try {
            await ensureHydratedStateFresh(key, { reason: `${label}-commit` });
        } catch (error) {
            recordFreshnessEvent(key, 'stale-operation-rejected', {
                reason: label,
                hydratedRevision: baseRevision,
                serverRevision: hydratedStateMeta.get(key)?.latestObservedServerRevision ?? hydratedRevision(key),
                dirty: localWorkingStateDirty(key),
            });
            return false;
        }
        const currentRevision = hydratedRevision(key);
        // The awaited read is a window in which the source can be edited or deleted; the result must
        // still belong to the exact history it was extracted from before it is merged or checkpointed.
        const sourceIntact = getChatKey() === key && (!Array.isArray(operation?.sourceLineage)
            || !lineageMoved(operation.sourceLineage, chatLineage(getContext().chat || []), operation?.sourceMessageId));
        const current = sourceIntact && scanOperationCurrent(key, operation) && currentRevision === baseRevision;
        if (!current) {
            recordFreshnessEvent(key, 'stale-operation-rejected', {
                reason: label,
                hydratedRevision: baseRevision,
                serverRevision: hydratedStateMeta.get(key)?.latestObservedServerRevision ?? currentRevision,
                dirty: false,
            });
            console.info(`[NPC State Delta] rejected stale ${label} result because the canonical sidecar advanced from revision ${baseRevision} to ${currentRevision}.`);
        }
        return current;
    }
    function endScanOperation(key, operation) {
        const ended = scanOperations.end(key, operation);
        operation?.requestController?.abort();
        if (ended && getChatKey() === key && pendingAutoScans.has(key)) void drainPendingAutoScan(key);
        return ended;
    }
    function cancelScanOperation(key, reason = 'cancelled') {
        const operation = scanOperations.cancel(key, reason);
        if (!operation) return false;
        operation.requestController?.abort();
        if (getChatKey() === key) {
            setScanIndicator(false);
            const npcId = String(operation.metadata?.npcId || '');
            if (npcId && operation.metadata?.indicator === 'dossier') setNpcDossierScanIndicator(npcId, false);
            if (npcId && operation.metadata?.indicator === 'refresh') setNpcChatRefreshIndicator(npcId, false);
        }
        return true;
    }

    async function withScanIntent(key, task, skipped = false, defer = null) {
        scanIntents.set(key, (scanIntents.get(key) || 0) + 1);
        const check = defer?.guard?.() ?? null;   // what the work stood on when it was asked for, kept for a retry
        try {
            // (timeline) No dossier work starts, and nothing is read for it, until the host's head-selection barrier is down and Delta stands on the
            // checkpoint of the selected head (a delete, a swipe or a retraction moved the head; the host asks Delta to follow it first). Work that
            // cannot start in time is not dropped: it waits in the queue below and starts when the barrier is down.
            if (!await messageGateSettled()) return deferUntilSettled(key, defer, check, skipped);
            return await task();
        } finally {
            const left = (scanIntents.get(key) || 1) - 1;
            if (left > 0) scanIntents.set(key, left); else scanIntents.delete(key);
        }
    }
    // (timeline) Work that found the host's barrier still up after the wait is kept here, by chat and kind, and retried when the barrier is down: a
    // reply's scan (its receipt), a queued drain, backfills, a reconcile, a targeted pass, an injection. It counts as dossier work meanwhile (a save point
    // waits for it). If the host does not settle within HEAD_SETTLE_PROBLEM_MS a Problem tells the reader the work is pending; it is still not dropped. It
    // is given up only when its chat is no longer the open one, or the reply it was for is no longer there (the new one has its own event).
    const HEAD_SETTLE_PROBLEM_MS = 10 * 60 * 1000;
    function deferredWorkPending(key) {
        for (const entry of deferredWork.values()) if (entry.key === key) return true;
        return false;
    }
    function deferUntilSettled(key, defer, check, answer) {
        if (!defer?.label || typeof defer.retry !== 'function') return headNotSettled(answer);
        const id = `${key}|${defer.label}`;
        const kept = deferredWork.get(id);
        if (kept) {
            // The same kind of work asked for again: one retry, with the newest request (a reconcile merges the options).
            kept.defer = { ...defer, options: defer.merge && kept.defer.options ? defer.merge(kept.defer.options, defer.options) : defer.options };
            kept.check = check;
            return answer;
        }
        const entry = { key, defer, check, since: Date.now(), told: false };
        deferredWork.set(id, entry);
        void (async () => {
            try {
                for (;;) {
                    if (getChatKey() !== key) return;
                    if (await messageGateSettled()) break;
                    if (!entry.told && Date.now() - entry.since >= HEAD_SETTLE_PROBLEM_MS) {
                        entry.told = true;
                        const text = `NPC State Delta: Story Block has not finished bringing the story to the selected point for ${Math.round(HEAD_SETTLE_PROBLEM_MS / 60000)} minutes, so ${defer.what || 'a scan'} is still pending. It runs as soon as Story Block is ready.`;
                        console.warn(`[NPC State Delta] ${text}`);
                        globalThis.toastr?.warning?.(text);
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                if (getChatKey() !== key) return;
                deferredWork.delete(id);
                if (typeof entry.check === 'function' && !entry.check()) return;   // the reply it was for is gone: its replacement has its own event
                await entry.defer.retry(entry.defer.options);
            } catch (error) {
                console.warn('[NPC State Delta] deferred dossier work failed', error);
            } finally {
                if (deferredWork.get(id) === entry) deferredWork.delete(id);
            }
        })();
        return answer;
    }
    /** The state of reply `messageId` as it is now, as a test for a retry: the same text on the same line of the story. null for no reply. */
    function replyGuard(messageId) {
        if (!Number.isInteger(messageId) || messageId < 0) return null;
        const chat = getContext().chat || [];
        const message = chat[messageId];
        const fingerprint = message ? fingerprintMessage(message) : '';
        const lineageKey = lineageCheckpointKey(chatLineage(chat), messageId);
        return () => {
            const now = getContext().chat || [];
            const current = now[messageId];
            return Boolean(current) && fingerprintMessage(current) === fingerprint && lineageCheckpointKey(chatLineage(now), messageId) === lineageKey;
        };
    }
    /** Whether dossier work is running, due or queued for the chat: an active operation, an intent, a queued automatic scan. */
    function scanWorkPending(key = getChatKey()) {
        return isScanBusy(key) || (scanIntents.get(key) || 0) > 0 || pendingAutoScans.has(key) || deferredWorkPending(key);
    }
    /** Resolves true when no scan or dossier pass is in flight, due or queued for the open chat, false after `ms`. */
    async function scanIdle(ms = 20000) {
        const key = getChatKey();
        const until = Date.now() + Math.max(0, Number(ms) || 0);
        while (scanWorkPending(key)) {
            if (Date.now() >= until) return false;
            await new Promise(resolve => setTimeout(resolve, 25));
            if (getChatKey() !== key) return true;
        }
        return true;
    }


    // (timeline participant) The entry points that start dossier work hold a scan intent for their whole run (see scanWorkPending).
    // (timeline) Before a generation's prompt is built from the dossiers and the chat: the host's barrier is down and the gate has been asked. If it is
    // not down in time the injection is built when it is (the host holds the generation meanwhile).
    //
    // One bounded wait per send: a send runs this twice (GENERATION_AFTER_COMMANDS, then MESSAGE_SENT). When the first found the barrier still up
    // after its wait (or the host said the block is permanent), the second only looks once, so a send into a chat that is not ready is held for
    // one wait at most, not two. The memo belongs to that one send: the second handler uses it up, and it lapses within seconds (a handler of the
    // same send follows at once), so the next send waits in full again.
    const GENERATION_WAIT_MEMO_MS = 3 * 1000;
    let generationBlocked = { key: '', at: 0 };
    async function generationReady(key) {
        const waited = generationBlocked.key === key && Date.now() - generationBlocked.at < GENERATION_WAIT_MEMO_MS;
        generationBlocked = { key: '', at: 0 };
        if (!await messageGateSettled(waited ? { wait: false } : undefined)) {
            if (!waited) generationBlocked = { key, at: Date.now() };
            deferUntilSettled(key, { label: 'injection', what: 'the dossier injection', retry: async () => { await refreshMessageGate(); if (getChatKey() === key) updateInjection(); } }, null, false);
            return false;
        }
        await refreshMessageGate();
        return getChatKey() === key;
    }
    function headNotSettled(answer) {
        console.info('[NPC State Delta] the host has not settled the selected head (its barrier is still up), so no dossier work was started.');
        return answer;
    }

    function queuePendingAutoScan(chatKey, messageId, reason = 'automatic') {
        if (!chatKey || chatKey === 'no-chat' || getChatKey() !== chatKey || !Number.isInteger(messageId) || messageId < 0) return false;
        const chat = getContext().chat || [];
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return false;
        const lineage = chatLineage(chat);
        const queued = {
            chatKey,
            messageId,
            reason,
            queuedAt: Date.now(),
            fingerprint: fingerprintMessage(message),
            lineageKey: lineageCheckpointKey(lineage, messageId),
        };
        const previous = pendingAutoScans.get(chatKey);
        if (!previous || messageId >= previous.messageId) pendingAutoScans.set(chatKey, queued);
        return true;
    }

    async function drainPendingAutoScanInner(chatKey) {
        if (!chatKey || getChatKey() !== chatKey || isScanBusy(chatKey) || isHostSwipeActive()) return false;
        const pending = pendingAutoScans.get(chatKey);
        if (!pending) return false;
        const chat = getContext().chat || [];
        const message = chat[pending.messageId];
        const lineage = chatLineage(chat);
        const currentFingerprint = message ? fingerprintMessage(message) : '';
        const currentLineageKey = lineageCheckpointKey(lineage, pending.messageId);
        if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()
            || pending.fingerprint !== currentFingerprint
            || pending.lineageKey !== currentLineageKey) {
            pendingAutoScans.delete(chatKey);
            return false;
        }
        pendingAutoScans.delete(chatKey);
        const succeeded = await scanNow({ manual: false, messageId: pending.messageId });
        if (succeeded && getChatKey() === chatKey && latestMessageId(true) === pending.messageId) {
            scheduleReplyBackfills(chatKey, pending.messageId);
        }
        return succeeded;
    }

    function noteScanFailure(label, error, chatKey = '') {
        if (!isEmptyScannerAnswer(error)) {
            console.error(`[NPC State Delta] ${label} failed`, error);
            return;
        }
        const key = String(chatKey || '');
        if (emptyAnswerChats.has(key)) return;
        emptyAnswerChats.add(key);
        console.warn(`[NPC State Delta] ${label}: the model answered nothing, so nothing changed; the next reply scans again. (Said once per chat.)`);
    }

    // (b6-soak-2) Queued backfills never hold a reply: SillyTavern waits for every MESSAGE_RECEIVED
    // listener before it draws the reply and gives back the Send button. The queue is started, not
    // awaited, so the handler returns at once; at most BACKFILLS_PER_REPLY model calls per reply, the
    // rest stay queued for the next one.
    // Hosted one-pass mode runs the queue here too, on its own cadence (not the Refresh's), one call per reply, and
    // never for an NPC the same reply's catch-up Refresh has in hand (one model call per NPC per reply).
    const BACKFILLS_PER_REPLY = 2;
    function scheduleReplyBackfills(chatKey, messageId) {
        const limit = hostedOnePass() ? 1 : BACKFILLS_PER_REPLY;
        queueMicrotask(() => {
            if (getChatKey() !== chatKey || latestMessageId(true) !== messageId) return;
            const skipNpcIds = [...(rt.catchUpTaken?.get(chatKey) || [])];
            processPendingBackfills(messageId, { limit, skipNpcIds })
                .catch(error => console.warn('[NPC State Delta] queued dossier backfills stopped.', error));
        });
    }

    return { recordScanDiagnostics, beginScanOperation, scanOperationCurrent, scanCanonicalBaseCurrent, endScanOperation, cancelScanOperation, withScanIntent, deferUntilSettled, replyGuard, scanWorkPending, scanIdle, generationReady, queuePendingAutoScan, drainPendingAutoScanInner, noteScanFailure, BACKFILLS_PER_REPLY, scheduleReplyBackfills };
}
