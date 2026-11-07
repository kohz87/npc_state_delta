/* NPC State Delta reply-scan assistant handler (role: reply-scan-handler). The handler of a new assistant message:
   the receipt, lineage and swipe checks before the scan, the automatic-scan decision, and the cheap local check that
   asks whether a reply names someone. Split unchanged from runtime-scan.js behind the same rt/deps helpers. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { autoScanDue as autoScanDueAfterReply, replyMayChangeDossiers, replyScanned } from './scan-context.js';
import { currentExchangeBodies } from './src/transcript.js';
import { chatLineage, lineageCheckpointKey, ensureBranchParentAnchor, migrateLegacyLineage } from './branch.js';
import { getSettings } from './runtime-settings.js';
import { narrationCaptureEnabled, latestMessageId, notify, replayScope } from './runtime-scan-helpers.js';

export function createAssistantHandlerPart(rt, deps, helpers) {
    const { commitBranchCheckpoint, ensureChatStateLoaded, getChatKey, getChatState, isHostSwipeActive, narrationCaptureKey, persist, queueSettledSwipeReconcile, renderDossier, scanAfterEveryReply, scheduleReplyBackfills, scanNow, staleHostActive, updateInjection } = deps;
    const { assistantReceipts, narrationCaptures } = rt;
    const { replyParentKey, sameReplyRewritten, scanInner } = helpers;

    async function handleAssistantMessageReceivedInner(messageId, { bypassSwipeGuard = false, forceBranchRescan = false } = {}) {
        const settings = getSettings();
        if (!settings.enabled) return;
        const eventChatKey = getChatKey();
        if (eventChatKey === 'no-chat' || !Number.isInteger(messageId) || messageId < 0) return;
        const eventMessage = getContext().chat?.[messageId];
        if (!eventMessage || eventMessage.is_user || eventMessage.is_system || !String(eventMessage.mes || '').trim()) return;
        let eventSourceKey = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
        const eventParent = replyParentKey(messageId);
        // (1.2.9) The same reply rewritten in place by another extension keeps its receipt.
        const sourceStillHere = () => {
            if (getChatKey() !== eventChatKey) return false;
            const now = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
            if (now === eventSourceKey) return true;
            if (!sameReplyRewritten(eventChatKey, messageId, eventParent)) return false;
            eventSourceKey = now;
            return true;
        };
        try { await ensureChatStateLoaded(eventChatKey); }
        catch (error) {
            console.error('[NPC State Delta] assistant event deferred because chat hydration failed.', error);
            notify('error', 'NPC State Delta could not load this chat dossier. Existing sidecar data was preserved; retry after the server is available.');
            return;
        }
        if (!sourceStillHere()) return;

        // SillyTavern 1.18 emits MESSAGE_SWIPED before starting Generate('swipe'). Some
        // backends then emit MESSAGE_RECEIVED while swipeState is still SWIPING. Never run
        // dossier generation in that window; settlement will replay this message safely.
        if (!bypassSwipeGuard && isHostSwipeActive()) {
            if (Number.isInteger(messageId)) rt.deferredSwipeMessageId = messageId;
            queueSettledSwipeReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                rescan: true,
                reason: 'message-swiped-received',
            });
            return;
        }

        const state = getChatState();
        migrateLegacyLineage(state, getContext().chat || []);
        // A history replay keeps its own receipts, catch-up marks and (no) captures, so the live ones are never touched.
        const replay = replayScope();
        const receipts = (replay ? replay.receipts : assistantReceipts).get(eventChatKey) || new Set();
        if (!forceBranchRescan && (receipts.has(eventSourceKey)
            || (replyScanned(state, messageId) && eventSourceKey === lineageCheckpointKey(state.lineage, messageId)))) return;
        // Receipt deduplication is separate from successful scan completion and cadence.
        // Store bounded source keys, never copies of narrative text or dossier state.
        receipts.add(eventSourceKey);
        while (receipts.size > 64) receipts.delete(receipts.values().next().value);
        (replay ? replay.receipts : assistantReceipts).set(eventChatKey, receipts);
        if (Number.isInteger(messageId) && !staleHostActive(eventChatKey)) ensureBranchParentAnchor(state, getContext().chat || [], messageId, 'assistant-parent');
        state.turn = Number(state.turn || 0) + 1;
        // Presence remains last-confirmed until a successful scanner observation replaces it.
        // A skipped, busy, failed, or timed-out scan must not make every NPC disappear.
        state.assistantSinceScan = Number(state.assistantSinceScan || 0) + 1;
        const shouldForceBranchScan = forceBranchRescan && settings.branchRescan !== false;
        const autoScanDue = autoScanDueAfterReply({
            autoScan: settings.autoScan,
            full: settings.fullScanEveryTurn,
            sinceScan: state.assistantSinceScan,
            scanEvery: settings.scanEvery,
            everyReply: scanAfterEveryReply(),
            catchUp: settings.autoScan && (replay ? replay.catchUp : rt.catchUpChats).has(eventChatKey),
            replyChanges: settings.autoScan && !settings.fullScanEveryTurn && replyNamesSomeone(state, messageId),
        });
        // A complete capture block is a scan already paid for, so it merges whatever Scan every says.
        const captureDue = !replay && narrationCaptureEnabled(settings) && narrationCaptures.has(narrationCaptureKey(eventChatKey, messageId));
        const scanExpected = shouldForceBranchScan || autoScanDue || captureDue;
        // Receipt state belongs to this assistant even if scanning fails, skips or is busy.
        // A successful scan coalesces its changes into this same owned boundary.
        commitBranchCheckpoint(state, messageId, 'turn');
        persist();
        renderDossier();
        updateInjection();

        if (scanExpected) {
            // A replay runs the scan itself (no queue, no gate wait: the chat is held) and a failed one stops the whole catch-up.
            if (await (replay ? scanInner({ manual: false, messageId, allowDuringSwipe: true }) : scanNow({ manual: false, messageId, allowDuringSwipe: bypassSwipeGuard })) === false) {
                if (replay) replay.failed = 'The scan of reply ' + messageId + ' did not finish.';
                return;
            }
        }
        if (getChatKey() !== eventChatKey || latestMessageId(true) !== messageId || !sourceStillHere()) return;
        if (replay) await replay.backfills(messageId);   // inline, on the copy, at the live per-reply limit
        else scheduleReplyBackfills(eventChatKey, messageId);
    }

    // (lean) The cheap local check before an automatic scan: a quiet reply (no new name, no tracked NPC, no NPC State line) waits
    // for the safety scan every "Scan every" replies. The same text and roster give the same answer when a reply is replayed.
    function replyNamesSomeone(state, messageId) {
        try {
            const ctx = getContext();
            return replyMayChangeDossiers({
                texts: currentExchangeBodies(messageId),
                roster: [...(state?.npcs || []), ...(state?.candidates || [])],
                ignore: [ctx.name1, ctx.name2],
            });
        } catch { return true; }
    }

    return { handleAssistantMessageReceivedInner };
}
