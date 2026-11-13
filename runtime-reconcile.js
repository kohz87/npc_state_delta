/* NPC State Delta branch reconciliation (role: branch-reconcile). What happens to the dossiers when the chat is swiped, regenerated, edited or has a
   message deleted: the swipe settlement that waits for the host, the merged and delayed reconcile requests, the rollback to a checkpoint or the
   journal (the pure rules stay in branch.js), the reconciliation diagnostics and the rescan after it. Built by index.js once per module instance
   with the shared runtime state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { messageGateSettled } from './src/transcript.js';
import { BRANCH_SNAPSHOT_BUDGET_BYTES, BRANCH_SNAPSHOT_MAX_BYTES, ROLLBACK_JOURNAL_BUDGET_BYTES, chatLineage, firstLineageDivergence, onlyStorySuiteBlocksChanged, reconcileBranchState, remapLineageKeys, snapshotBranchState } from './branch.js';
import { getSettings } from './runtime-settings.js';
import { textCapture } from './runtime-narration.js';

export function createReconcilePart(rt, deps) {
    const { branchInheritancePending, cancelScanOperation, deferUntilSettled, drainPendingAutoScan, ensureChatStateLoaded, getChatKey, getChatState, handleAssistantMessageReceived, hostChatComplete, hostedOnePass, narrationCaptureKey, isHostSwipeActive, isScanBusy, maybeInheritKnownBranch, persist, queuePendingAutoScan, renderDossier, scanNow, seedBranchTracking, setChatState, staleHostPrefix, updateInjection } = deps;
    const { branchReconciliationEvents, assistantReceipts } = rt;

    const BRANCH_RECONCILIATION_EVENT_LIMIT = 16;
    const SWIPE_SETTLE_POLL_MS = 80;
    const SWIPE_SETTLE_TIMEOUT_MS = 120000;

    function findLatestAssistantAtOrAfter(messageId) {
        const chat = getContext().chat || [];
        for (let i = chat.length - 1; i >= Math.max(0, Number(messageId) || 0); i -= 1) {
            if (chat[i] && !chat[i].is_system && !chat[i].is_user && String(chat[i].mes || '').trim()) return i;
        }
        return -1;
    }

    function branchOperationPriority(value) {
        return ({ auto: 0, edit: 1, delete: 2, swipe: 3 })[String(value || 'auto').toLowerCase()] ?? 0;
    }

    function mergeBranchOptions(base = {}, incoming = {}) {
        const next = { ...base, ...incoming };
        const a = base.explicitDivergence;
        const b = incoming.explicitDivergence;
        if (Number.isInteger(a) && Number.isInteger(b)) next.explicitDivergence = Math.min(a, b);
        else if (Number.isInteger(a)) next.explicitDivergence = a;
        else if (Number.isInteger(b)) next.explicitDivergence = b;
        const baseOperation = String(base.operation || 'auto').toLowerCase();
        const incomingOperation = String(incoming.operation || 'auto').toLowerCase();
        next.operation = branchOperationPriority(incomingOperation) >= branchOperationPriority(baseOperation)
            ? incomingOperation
            : baseOperation;
        next.rescan = Boolean(base.rescan || incoming.rescan);
        next.explicit = Boolean(base.explicit || incoming.explicit);
        return next;
    }

    function queueSettledSwipeReconcile(options = {}) {
        const originKey = options.chatKey || getChatKey();
        if (originKey === 'no-chat') return;
        let next = { reason: 'message-swiped', rescan: true, ...options, operation: options.operation || 'auto', chatKey: originKey };

        // A normal branch timer must never be allowed to fire inside SillyTavern's swipe window.
        // Fold it into the swipe settlement instead.
        if (rt.branchReconcileTimer) {
            clearTimeout(rt.branchReconcileTimer);
            rt.branchReconcileTimer = null;
        }
        if (rt.branchReconcilePending) {
            next = mergeBranchOptions(rt.branchReconcilePending, next);
            rt.branchReconcilePending = null;
        }
        if (rt.swipeSettlementPending) next = mergeBranchOptions(rt.swipeSettlementPending, next);
        rt.swipeSettlementPending = next;

        const sequence = ++rt.swipeSettlementSequence;
        if (rt.swipeSettlementTimer) clearTimeout(rt.swipeSettlementTimer);
        const startedAt = Date.now();

        const poll = async () => {
            if (sequence !== rt.swipeSettlementSequence) return;
            if (getChatKey() !== originKey) {
                rt.swipeSettlementTimer = null;
                rt.swipeSettlementPending = null;
                rt.deferredSwipeMessageId = null;
                return;
            }
            if (isHostSwipeActive()) {
                if (Date.now() - startedAt >= SWIPE_SETTLE_TIMEOUT_MS) {
                    rt.swipeSettlementTimer = null;
                    rt.swipeSettlementPending = null;
                    rt.deferredSwipeMessageId = null;
                    console.warn('[NPC State Delta] swipe stayed active too long; branch rescan was skipped to avoid hijacking the host generation pipeline.');
                    return;
                }
                rt.swipeSettlementTimer = setTimeout(poll, SWIPE_SETTLE_POLL_MS);
                return;
            }

            rt.swipeSettlementTimer = null;
            const pending = rt.swipeSettlementPending || {};
            rt.swipeSettlementPending = null;
            const receivedMessageId = Number.isInteger(rt.deferredSwipeMessageId) ? rt.deferredSwipeMessageId : null;
            rt.deferredSwipeMessageId = null;

            try {
                const reconciliation = await reconcileCurrentBranch({ ...pending, rescan: false, reason: `${pending.reason || 'message-swiped'}-settled` });
                if (!reconciliation) return; // A deferred load is not permission to scan the incomplete chat.
                if (reconciliation?.requiresRescan === false) return;
                const chat = getContext().chat || [];
                const received = Number.isInteger(receivedMessageId) ? chat[receivedMessageId] : null;
                if (received && !received.is_user && !received.is_system && String(received.mes || '').trim()) {
                    await handleAssistantMessageReceived(receivedMessageId, {
                        bypassSwipeGuard: true,
                        forceBranchRescan: Boolean(pending.rescan),
                    });
                    return;
                }

                if (pending.rescan && getSettings().branchRescan !== false) {
                    const targetAssistant = findLatestAssistantAtOrAfter(pending.explicitDivergence);
                    if (targetAssistant >= 0) await scanNow({ manual: false, messageId: targetAssistant, allowDuringSwipe: true });
                }
            } catch (error) {
                console.warn('[NPC State Delta] settled swipe reconciliation failed', error);
            }
        };

        // The host emits MESSAGE_SWIPED before Generate('swipe'). Polling the host's own
        // swipe state keeps NPC State Delta completely out of that pre-generation gap.
        rt.swipeSettlementTimer = setTimeout(poll, 0);
    }

    function diagnosticSerializedBytes(value) {
        try {
            const text = JSON.stringify(value ?? null);
            return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
        } catch {
            return 0;
        }
    }

    function branchHistoryDiagnostic(state) {
        if (!state || typeof state !== 'object') return null;
        const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
        const rollbackJournal = Array.isArray(state.rollbackJournal) ? state.rollbackJournal : [];
        const checkpointSizes = checkpoints.map(item => diagnosticSerializedBytes(item?.snapshot || {}) + 256);
        return {
            lineageVersion: Number(state.branchLineageVersion || 0),
            lineageMessages: Array.isArray(state.lineage) ? state.lineage.length : 0,
            currentNarrativeSnapshotBytes: diagnosticSerializedBytes(snapshotBranchState(state)),
            checkpointCount: checkpoints.length,
            checkpointBytes: checkpointSizes.reduce((sum, size) => sum + size, 0),
            largestCheckpointBytes: checkpointSizes.length ? Math.max(...checkpointSizes) : 0,
            checkpointBudgetBytes: BRANCH_SNAPSHOT_BUDGET_BYTES,
            checkpointMaxBytes: BRANCH_SNAPSHOT_MAX_BYTES,
            rollbackJournalEntries: rollbackJournal.length,
            rollbackJournalBytes: Number(state.rollbackJournalBytes || 0) || diagnosticSerializedBytes(rollbackJournal),
            rollbackJournalBudgetBytes: ROLLBACK_JOURNAL_BUDGET_BYTES,
            rollbackJournalCoverageMessages: Number(state.rollbackJournalCoverageMessages || 0),
            rollbackJournalBudgetExceeded: state.rollbackJournalBudgetExceeded === true,
        };
    }

    function recordBranchReconciliationEvent({ key, reason, operation, result, beforeNpcCount, previousLength, currentLength }) {
        if (!result) return;
        const state = result.state || null;
        branchReconciliationEvents.push({
            at: Date.now(),
            chatKey: key,
            reason: String(reason || 'branch'),
            operation: String(result.recoveryOperation || operation || 'auto'),
            relation: String(result.lineageRelation || 'unknown'),
            divergence: Number.isInteger(result.divergence) ? result.divergence : null,
            action: String(result.recoveryAction || (result.invalidated ? 'reconciled' : 'none')),
            invalidated: Boolean(result.invalidated),
            exactRestored: Boolean(result.exactRestored),
            requestedRecoveryMessageId: Number.isInteger(result.requestedRecoveryMessageId) ? result.requestedRecoveryMessageId : null,
            affectedAssistantMessages: Math.max(0, Number(result.affectedAssistantMessages || 0)),
            linearSuffixReplaySafe: result.linearSuffixReplaySafe !== false,
            recoveryBlockedByRetainedDescendants: Boolean(result.recoveryBlockedByRetainedDescendants),
            journalTargetReachable: Boolean(result.journalTargetReachable),
            exactCheckpointAvailable: Boolean(result.exactCheckpointAvailable),
            nearestOlderCheckpointMessageId: Number.isInteger(result.nearestOlderCheckpointMessageId) ? result.nearestOlderCheckpointMessageId : null,
            olderCheckpointRejected: Boolean(result.olderCheckpointRejected),
            recoveryDistance: Number.isInteger(result.recoveryDistance) ? result.recoveryDistance : null,
            requiresRescan: Boolean(result.requiresRescan),
            restoredFromMessageId: Number.isInteger(result.restoredFromMessageId) ? result.restoredFromMessageId : null,
            restoredFromJournal: Boolean(result.restoredFromJournal),
            restoredFromRoot: Boolean(result.restoredFromRoot),
            failClosed: Boolean(result.failClosed),
            revertedNpcCount: Array.isArray(result.deletedEffects?.reverted) ? result.deletedEffects.reverted.length : 0,
            removedNpcCount: Array.isArray(result.deletedEffects?.removed) ? result.deletedEffects.removed.length : 0,
            rewoundToBoundary: Boolean(result.rewoundToBoundary),
            linearHistoryPruned: Boolean(result.linearHistoryPruned),
            previousLength: Math.max(0, Number(previousLength || 0)),
            currentLength: Math.max(0, Number(currentLength || 0)),
            npcCountBefore: Math.max(0, Number(beforeNpcCount || 0)),
            npcCountAfter: Array.isArray(state?.npcs) ? state.npcs.length : 0,
            history: branchHistoryDiagnostic(state),
        });
        if (branchReconciliationEvents.length > BRANCH_RECONCILIATION_EVENT_LIMIT) {
            branchReconciliationEvents.splice(0, branchReconciliationEvents.length - BRANCH_RECONCILIATION_EVENT_LIMIT);
        }
    }

    // Loading may expose no messages or only a prefix. Keep one bounded retry per chat opening; a later host load or explicit event can try again.
    const EMPTY_CHAT_RETRY_MS = 400;
    const EMPTY_CHAT_RETRY_LIMIT = 25;
    // After the fast tries a new chat whose file is not saved yet is still waited for, slowly; the next received reply also asks again.
    const SLOW_CHAT_RETRY_MS = 5000;
    const SLOW_CHAT_RETRY_LIMIT = 12;
    let loadingRetry = null;
    let loadingReceipts = null;
    const hostChecks = new Set();

    function loadingReconcilePending(key = getChatKey()) {
        const sequence = rt.chatOpenSequence || 0;
        const owned = item => item?.key === key && item.sequence === sequence;
        const pending = rt.branchReconcilePending;
        return branchInheritancePending(key) || rt.openingHostChats.has(key) || owned(loadingRetry) || owned(loadingReceipts)
            || (pending?.chatKey === key && (!pending.operation || pending.operation === 'auto')) || [...hostChecks].some(owned);
    }

    // A reply received before branch loading is proved must not create a sidecar before inheritance.
    // Keep its position and parent in memory, then give it to the ordinary receipt owner after verification.
    function deferLoadingReceipt(messageId) {
        const key = getChatKey();
        const sequence = rt.chatOpenSequence || 0;
        if (!loadingReconcilePending(key)) return false;
        const chat = getContext().chat || [];
        const message = chat[messageId];
        if (!Number.isInteger(messageId) || messageId < 0 || !message || message.is_user || message.is_system || !String(message.mes || '').trim()) return false;
        if (loadingReceipts?.key !== key || loadingReceipts.sequence !== sequence) loadingReceipts = { key, sequence, items: [] };
        const parent = chatLineage(chat).slice(0, messageId);
        if (!loadingReceipts.items.some(item => item.messageId === messageId && firstLineageDivergence(item.parent, parent) === -1)) {
            loadingReceipts.items.push({ messageId, parent });
        }
        queueBranchReconcile({ chatKey: key, rescan: false, reason: 'message-received-pending' }, 400);
        return true;
    }

    async function deliverLoadingReceipts(key, sequence) {
        if (loadingReceipts?.key !== key || loadingReceipts.sequence !== sequence) return;
        const receipts = loadingReceipts.items;
        loadingReceipts = null;
        for (const { messageId, parent } of receipts) {
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence) return;
            const chat = getContext().chat || [];
            const message = chat[messageId];
            if (message && !message.is_user && !message.is_system && firstLineageDivergence(parent, chatLineage(chat).slice(0, messageId)) === -1) {
                await handleAssistantMessageReceived(messageId);
            }
        }
    }

    function deferLoadingChat(key, options, before, lineage) {
        const sequence = rt.chatOpenSequence || 0;
        if (!loadingRetry || loadingRetry.key !== key || loadingRetry.sequence !== sequence) {
            if (loadingRetry?.timer) clearTimeout(loadingRetry.timer);
            loadingRetry = { key, sequence, attempts: 0, timer: null, options: null };
        }
        const retry = loadingRetry;
        retry.options = retry.options ? mergeBranchOptions(retry.options, { ...options, chatKey: key }) : { ...options, chatKey: key };
        recordBranchReconciliationEvent({
            key, reason: options.reason, operation: options.operation,
            result: { recoveryOperation: options.operation, lineageRelation: 'unknown', recoveryAction: 'deferred-chat-not-loaded', invalidated: false },
            beforeNpcCount: before?.npcs?.length || 0, previousLength: before?.lineage?.length || 0, currentLength: lineage.length,
        });
        if (!retry.timer && retry.attempts < EMPTY_CHAT_RETRY_LIMIT + SLOW_CHAT_RETRY_LIMIT) {
            const delay = retry.attempts < EMPTY_CHAT_RETRY_LIMIT ? EMPTY_CHAT_RETRY_MS : SLOW_CHAT_RETRY_MS;
            retry.attempts += 1;
            retry.timer = setTimeout(() => {
                retry.timer = null;
                const pending = retry.options;
                retry.options = null;
                if (getChatKey() === key && (rt.chatOpenSequence || 0) === sequence) queueBranchReconcile(pending, 0);
            }, delay);
        }
    }
    function clearLoadingRetry(key) {
        if (loadingRetry?.key !== key) return;
        if (loadingRetry.timer) clearTimeout(loadingRetry.timer);
        loadingRetry = null;
    }

    async function reconcileCurrentBranch({ explicitDivergence = null, rescan = true, reason = 'branch', chatKey = null, operation = 'auto', explicit = false } = {}) {
        const key = chatKey || getChatKey();
        const sequence = rt.chatOpenSequence || 0;
        if (key === 'no-chat' || getChatKey() !== key) return null;
        // (timeline) A head that moved is followed by the host first (Delta installs the checkpoint of the selected head); this reads Delta's state after.
        if (!await messageGateSettled()) {
            // Not dropped: it runs, with every request made meanwhile merged, when the barrier is down.
            return deferUntilSettled(key, { label: 'reconcile', what: 'a rollback after a deleted or swiped message', options: { explicitDivergence, rescan, reason, chatKey, operation, explicit }, merge: mergeBranchOptions, retry: options => reconcileCurrentBranch(options) }, null, null);
        }
        if (getChatKey() !== key) return null;
        if ((rt.chatOpenSequence || 0) !== sequence) return null;
        await ensureChatStateLoaded(key);
        if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence) return null;
        if (branchInheritancePending(key)) {
            const inherited = await maybeInheritKnownBranch();
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence) return null;
            if (branchInheritancePending(key)) {
                deferLoadingChat(key, { explicitDivergence, rescan, reason, operation, explicit }, getChatState(key), chatLineage(getContext().chat || []));
                return null;
            }
            if (inherited) { renderDossier(); updateInjection(); }
        }
        const ctx = getContext();
        const before = getChatState(key);
        const beforeNpcCount = Array.isArray(before.npcs) ? before.npcs.length : 0;
        const previousLength = Array.isArray(before.lineage) ? before.lineage.length : 0;
        const lineageBefore = chatLineage(ctx.chat || []);
        const divergence = firstLineageDivergence(before.lineage || [], lineageBefore);
        const receiptWaiting = loadingReceipts?.key === key && loadingReceipts.sequence === sequence;
        if (!explicit && String(operation || 'auto').toLowerCase() === 'auto'
            && ((divergence >= 0 && divergence < previousLength) || receiptWaiting)) {
            const check = { key, sequence };
            hostChecks.add(check);
            let complete;
            try { complete = await hostChatComplete(key); } finally { hostChecks.delete(check); }
            if (!complete) {
                if (getChatKey() === key && (rt.chatOpenSequence || 0) === sequence) deferLoadingChat(key, { explicitDivergence, rescan, reason, operation, explicit }, before, lineageBefore);
                return null;
            }
            if (getChatKey() !== key || (rt.chatOpenSequence || 0) !== sequence || getChatState(key) !== before || firstLineageDivergence(lineageBefore, chatLineage(getContext().chat || [])) !== -1) return null;
        }
        clearLoadingRetry(key);
        seedBranchTracking(before);
        // (EDITKEEP) An edit that only touched Story Suite's own hidden blocks (<Changes>, <Changes-assist>, the STORY_SUITE_V2 comment) left the
        // story and every other block as they were: nothing to roll back. The stored keys follow the new text and the dossiers stay.
        if (String(operation || '').toLowerCase() === 'edit' && onlyStorySuiteBlocksChanged(before.lineage, ctx.chat || [])) {
            remapLineageKeys(before, before.lineage, lineageBefore);
            recordBranchReconciliationEvent({ key, reason, operation, result: { recoveryOperation: operation, lineageRelation: 'hidden-blocks-only', recoveryAction: 'content-unchanged', invalidated: false, divergence: -1 }, beforeNpcCount, previousLength, currentLength: lineageBefore.length });
            persist(key);
            await deliverLoadingReceipts(key, sequence);
            return { state: before, divergence: -1, lineageRelation: 'hidden-blocks-only', recoveryOperation: 'edit', recoveryAction: 'content-unchanged', requiresRescan: false, invalidated: false, exactRestored: false, failClosed: false };
        }
        // The dossier can be newer than this browser's chat: another session wrote it after messages
        // this chat has not loaded yet. Until the host reloads the chat, a local chat that is only a
        // shorter prefix of that dossier is stale, not a deletion, so it must not roll the dossier back.
        if (staleHostPrefix(key, operation, explicitDivergence)) {
            recordBranchReconciliationEvent({
                key, reason, operation,
                result: { recoveryOperation: operation, lineageRelation: 'tail-truncation', recoveryAction: 'deferred-stale-chat', invalidated: false, divergence: lineageBefore.length },
                beforeNpcCount, previousLength, currentLength: lineageBefore.length,
            });
            return null;
        }
        const result = reconcileBranchState(before, ctx.chat || [], { explicitDivergence, operation, rewindMidDelete: getSettings().midDeleteRewind === true });
        if (getChatKey() !== key || firstLineageDivergence(lineageBefore, chatLineage(getContext().chat || [])) !== -1) return null;
        recordBranchReconciliationEvent({
            key, reason, operation, result, beforeNpcCount,
            previousLength, currentLength: lineageBefore.length,
        });
        if (!result.invalidated) {
            before.lineage = result.state.lineage;
            await deliverLoadingReceipts(key, sequence);
            return result;
        }

        cancelScanOperation(key, reason);
        assistantReceipts.delete(key);
        setChatState(key, result.state);
        persist(key);
        renderDossier();
        updateInjection();
        // A message deleted from the middle keeps the dossiers (later messages depend on them), except
        // what the deleted message itself changed and nothing later touched, which is undone exactly.
        if (result.rewoundToBoundary) {
            globalThis.toastr?.info?.('NPC State Delta: a message was deleted from the middle of the chat, so every dossier was rewound to how it was just before it. Changes made by the messages after it were discarded.');
        } else if (result.failClosed && result.recoveryBlockedByRetainedDescendants && result.recoveryOperation === 'delete') {
            const names = list => {
                const values = (Array.isArray(list) ? list : []).map(item => item.name).filter(Boolean);
                return `${values.slice(0, 4).join(', ')}${values.length > 4 ? ` +${values.length - 4} more` : ''}`;
            };
            const reverted = result.deletedEffects?.reverted || [];
            const removed = result.deletedEffects?.removed || [];
            const parts = [];
            if (reverted.length) parts.push(`reverted what the deleted message changed for ${names(reverted)}`);
            if (removed.length) parts.push(`removed ${names(removed)}, who only appeared in it`);
            globalThis.toastr?.info?.(parts.length
                ? `NPC State Delta: a message was deleted from the middle of the chat. Later messages depend on the dossiers, so they were kept, but Delta ${parts.join(' and ')}. Anything a later message also changed was left as it is.`
                : 'NPC State Delta: a message was deleted from the middle of the chat. Later messages depend on the dossiers, so they were kept as they are; edit them manually if the deleted message had changed anything.');
        }

        const targetAssistant = findLatestAssistantAtOrAfter(result.divergence);
        const shouldRescan = result.requiresRescan !== undefined ? Boolean(result.requiresRescan) : !result.exactRestored;
        if (rescan && shouldRescan && getSettings().branchRescan !== false && targetAssistant >= 0) {
            if (getChatKey() !== key) return result;
            // (EDITKEEP) A real edit rolled the reply back: its hosted one-pass block, if the text still holds a valid one, is applied again the way the
            // live capture did (the scan records it in the journal under the new key); the catch-up covers only what the block does not. Held only
            // here, where the scan is certain to run.
            if (operation === 'edit' && hostedOnePass()) {
                const found = textCapture(ctx.chat?.[targetAssistant]);
                if (found) rt.narrationCaptures.set(narrationCaptureKey(key, targetAssistant), found);
            }
            if (isScanBusy(key)) queueBranchRescan(targetAssistant, 0, key);
            else await scanNow({ manual: false, messageId: targetAssistant });
        }
        await deliverLoadingReceipts(key, sequence);
        return result;
    }

    function queueBranchRescan(messageId, _attempt = 0, originKey = getChatKey()) {
        if (!queuePendingAutoScan(originKey, messageId, 'branch-rescan')) return;
        if (getChatKey() === originKey && !isScanBusy(originKey) && !isHostSwipeActive()) void drainPendingAutoScan(originKey);
    }

    function queueBranchReconcile(options = {}, delay = 90) {
        const originKey = options.chatKey || getChatKey();
        if (originKey === 'no-chat') return;
        options = { ...options, chatKey: originKey };
        if (loadingRetry?.key === originKey && loadingRetry.sequence === (rt.chatOpenSequence || 0) && loadingRetry.options) {
            options = mergeBranchOptions(loadingRetry.options, options);
            if (loadingRetry.timer) clearTimeout(loadingRetry.timer);
            loadingRetry.timer = null;
            loadingRetry.options = null;
        }
        if (isHostSwipeActive()) {
            queueSettledSwipeReconcile(options);
            return;
        }
        let next = { ...options };
        if (rt.branchReconcilePending?.chatKey && rt.branchReconcilePending.chatKey !== originKey) {
            if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
            rt.branchReconcileTimer = null;
            rt.branchReconcilePending = null;
        }
        if (rt.branchReconcilePending) next = mergeBranchOptions(rt.branchReconcilePending, next);
        rt.branchReconcilePending = next;
        if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
        rt.branchReconcileTimer = setTimeout(async () => {
            const pending = rt.branchReconcilePending || {};
            rt.branchReconcilePending = null;
            rt.branchReconcileTimer = null;
            let check = null;
            try {
                if (pending.chatKey && getChatKey() !== pending.chatKey) return;
                if (!pending.operation || pending.operation === 'auto') {
                    check = { key: pending.chatKey || getChatKey(), sequence: rt.chatOpenSequence || 0 };
                    hostChecks.add(check);
                }
                await reconcileCurrentBranch(pending);
            } catch (error) {
                console.warn('[NPC State Delta] branch reconciliation failed', error);
            } finally {
                if (check) hostChecks.delete(check);
            }
        }, delay);
    }

    return { queueSettledSwipeReconcile, branchHistoryDiagnostic, reconcileCurrentBranch, queueBranchReconcile, deferLoadingReceipt, loadingReconcilePending };
}
