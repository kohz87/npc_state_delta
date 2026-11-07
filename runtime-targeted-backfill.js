/* NPC State Delta targeted backfill (role: targeted-backfill). The history backfill for one NPC and the queue
   of pending backfills. Split from runtime-targeted.js; bodies are moved without change. */

import { getContext } from '../../../extensions.js';
import { isScannerRoutingError } from './scanner-routing.js';
import { automaticBackfillStillRelevant, backfillNeedsRequest } from './scan-context.js';
import { recentTranscript, recentUserDevelopmentContext, currentExchangeTranscript, refreshMessageGate } from './src/transcript.js';
import { IMPORTANT_MEMORY_LIMIT, inferNpcIdentityKind, npcCurrentlyAbsentInText, buildBackfillPrompt } from './core.js';
import { getSettings } from './runtime-settings.js';
import { createTargetedScopePart } from './runtime-targeted-scope.js';

const { backfillScanMatchesTarget, rowContradictsTarget, soleRowMayBeTarget, transcriptMentionsBackfillTarget } = createTargetedScopePart();

export function createTargetedBackfillPart(rt, deps, { prepareCanonicalScanBase, scopeTargetedChannels }) {
    const { BACKFILL_MAX_ATTEMPTS, ensureChatStateLoaded, getChatKey, getChatState, hostedTargetNotes, isHostSwipeActive, isScanBusy, noteScanFailure, persist, recordInlineCardsInState, removeNpcInlineCardAtMessage, requireReadyChatMutation, runTargetedDossierPass, targetNoteOptions } = deps;

    const BACKFILL_RETRY_COOLDOWN_MS = 60 * 1000;

    // The live state a backfill that preserves it keeps: the record's own, whatever the model returned.
    function backfillLiveState(liveBefore, keptPresent) {
        return {
            present: keptPresent,
            worldActive: Boolean(liveBefore.worldActive) && !keptPresent,
            mood: liveBefore.mood || '',
            location: liveBefore.location || '',
            goal: liveBefore.goal || '',
            status: liveBefore.status || '',
        };
    }

    async function backfillNpcFromHistory(request, messageId = null, { automatic = false } = {}) {
        const settings = getSettings();
        const ctx = getContext();
        const chatKey = getChatKey();
        if (!request?.npcId || !request?.label || chatKey === 'no-chat') return false;
        try { await ensureChatStateLoaded(chatKey); } catch { return false; }
        if (getChatKey() !== chatKey || !requireReadyChatMutation('backfill a dossier', chatKey, { notify: false })) return false;
        if (isScanBusy(chatKey)) return false;
        if (!await prepareCanonicalScanBase(chatKey, 'dossier backfill')) return false;
        // (timeline) The window is read from the messages the story stands on: the gate is asked first.
        await refreshMessageGate();
        if (getChatKey() !== chatKey) return false;
        const state = getChatState(chatKey);
        const existing = state.npcs.find(npc => npc.id === request.npcId);
        if (!existing) return false;
        const transcript = recentTranscript(settings.scanDepth);
        if (!transcript) return false;
        if (automatic) {
            if (!automaticBackfillStillRelevant(request, existing, state.npcs, currentExchangeTranscript(request.requestedMessageId))) return true;
        } else if (!backfillNeedsRequest(existing, state.npcs)) {
            return true;
        }
        const notes = hostedTargetNotes(existing, { newDossier: request.reason === 'new-admission', messageId });
        const prompt = buildBackfillPrompt({
            transcript,
            targetName: request.label,
            existingNpc: existing,
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || 'Character',
            memoryCriteria: settings.memoryCriteria,
            customFieldNames: settings.customFieldNames,
            ...targetNoteOptions(notes),
        });
        return runTargetedDossierPass({
            chatKey, ctx, prompt, messageId, notes,
            id: request.npcId,
            label: `backfill for ${request.label}`,
            systemPrompt: "You are NPC State Delta's isolated dossier backfill scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
            indicator: 'backfill',
            staleLabel: 'dossier backfill',
            checkpoint: 'dossier-backfill',
            metricsLabel: 'dossier-backfill',
            onStale: () => console.info('[NPC State Delta] discarded stale dossier backfill after chat or dossier state changed.'),
            scope: (parsed, { latest, liveBefore }) => {
                const roster = latest.npcs;
                const target = liveBefore || { id: request.npcId, name: request.label, aliases: [], identityKind: inferNpcIdentityKind(request.label) };
                const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
                // The backfill prompt is single-target by construction. If the model expands a short
                // label (e.g. Toris -> Toris Vale) without repeating the alias, accept the sole result
                // when the requested target is actually present in the supplied history.
                const labels = [request.label, ...(liveBefore ? [liveBefore.name, ...(liveBefore.aliases || [])] : [])];
                let matches = returned.filter(npc => backfillScanMatchesTarget(npc, request));
                if (!matches.length && returned.length === 1 && transcriptMentionsBackfillTarget(transcript, request.label)
                    && soleRowMayBeTarget(returned[0], { npcId: request.npcId, labels }, roster)) matches = returned;
                matches = matches.filter(row => !rowContradictsTarget(row, target, roster));
                const preserved = request.preserveLiveState === true ? liveBefore : null;
                // A missed-participant repair exists because the NPC takes part in the current exchange;
                // the broad scan's omission is not evidence of absence, so a grounded present=true stands.
                // Other repairs keep the live presence (older history must not make an NPC present).
                const repairedPresence = request.reason === 'missed-participant' && matches[0]?.present === true
                    && !npcCurrentlyAbsentInText(existing, currentExchangeTranscript(request.requestedMessageId));
                const keptPresent = preserved ? (repairedPresence || Boolean(preserved.present)) : false;
                parsed.npcs = matches.slice(0, 1).map(npc => ({
                    ...npc,
                    id: request.npcId,
                    // (C-3) The same live state the merge result keeps below, so the merge sees no change.
                    ...(preserved ? backfillLiveState(preserved, keptPresent) : {}),
                    relationshipImpact: 'none',
                    relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                    relationshipChangeReason: '',
                }));
                if (!parsed.npcs.length) {
                    const literalMention = transcriptMentionsBackfillTarget(transcript, request.label);
                    console.warn('[NPC State Delta] targeted backfill returned no accepted NPC', { target: request.label, literalMention, returnedCount: returned.length });
                    if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: ${request.label} was added, but the backfill model returned no matching dossier details from the last ${settings.scanDepth} messages.`);
                    return { ok: false, result: false };
                }
                // A single-target backfill may change only its target, in every result channel: profile
                // updates and social edges for other dossiers are dropped like their npc rows.
                scopeTargetedChannels(parsed, target, roster);
                return { ok: true, preserved, keptPresent, repairedPresence };
            },
            mergeOptions: {
                // The backfill prompt asks for up to five memories (a first, whole dossier).
                memoryInputLimit: IMPORTANT_MEMORY_LIMIT,
                allowTargetedDurableSeed: true,
                developmentContext: transcript,
                userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
            },
            afterMerge: (finalNpc, { scoped }) => {
                const { preserved, keptPresent, repairedPresence } = scoped;
                if (!preserved) return;
                Object.assign(finalNpc, backfillLiveState(preserved, keptPresent));
                finalNpc.seenCount = Number(preserved.seenCount || 0);
                finalNpc.lastSeenTurn = repairedPresence
                    ? Math.max(Number(preserved.lastSeenTurn || 0), Number(state.turn || 0))
                    : Number(preserved.lastSeenTurn || 0);
                finalNpc.lastWorldActiveTurn = Number(preserved.lastWorldActiveTurn || 0);
            },
            beforeCheckpoint: (nextState, finalNpc, targetMessageId) => {
                if (!finalNpc.archived && finalNpc.present) recordInlineCardsInState(nextState, targetMessageId, [finalNpc.id], 'dossier-backfill');
                else removeNpcInlineCardAtMessage(nextState, targetMessageId, finalNpc.id);
            },
            onDone: savedNpc => {
                if (!request.silent) globalThis.toastr?.success?.(`NPC State Delta: backfilled ${savedNpc?.name || request.label} from recent story context.`);
                return true;
            },
            onError: error => {
                noteScanFailure('dossier backfill', error, getChatKey());
                if (error?.code === 'NPC_SCANNER_ROUTE_CANCELLED' || error?.code === 'NPC_SCANNER_ROUTE_TIMEOUT') return null;
                if (!request.silent || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.warning?.(`NPC State Delta backfill failed for ${request.label}: ${error?.message || error}`);
                return false;
            },
        });
    }

    async function processPendingBackfillsInner(messageId = null, { limit = Infinity, skipNpcIds = [] } = {}) {
        const chatKey = getChatKey();
        if (chatKey === 'no-chat' || !requireReadyChatMutation('process queued dossier backfills', chatKey, { notify: false }) || isScanBusy(chatKey) || isHostSwipeActive()) return 0;
        let processed = 0;
        // Model calls made (each backfill is one request, plus a compact retry at most).
        let calls = 0;
        const attemptedNpcIds = new Set(skipNpcIds);
        while (getChatKey() === chatKey && !isScanBusy(chatKey) && calls < limit) {
            const state = getChatState(chatKey);
            if (!Array.isArray(state.pendingBackfills) || !state.pendingBackfills.length) break;
            const request = state.pendingBackfills.find(item => item?.npcId && !attemptedNpcIds.has(item.npcId));
            if (!request) break;
            attemptedNpcIds.add(request.npcId);
            const target = state.npcs.find(npc => npc.id === request.npcId);
            const owningExchange = Number.isInteger(request.requestedMessageId) ? currentExchangeTranscript(request.requestedMessageId) : '';
            if (!automaticBackfillStillRelevant(request, target, state.npcs, owningExchange)) {
                state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
                persist();
                continue;
            }
            const attempts = Math.max(0, Math.round(Number(request.attempts) || 0));
            if (attempts >= BACKFILL_MAX_ATTEMPTS) {
                state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
                persist();
                if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: stopped automatic backfill retries for ${request.label} after ${BACKFILL_MAX_ATTEMPTS} failed attempts. The bare dossier is preserved; use Scan dossier to retry manually.`);
                continue;
            }
            const lastAttemptAt = Math.max(0, Number(request.lastAttemptAt || 0) || 0);
            if (attempts > 0 && lastAttemptAt && Date.now() - lastAttemptAt < BACKFILL_RETRY_COOLDOWN_MS) continue;

            calls += 1;
            const succeeded = await backfillNpcFromHistory(request, messageId, { automatic: true });
            if (succeeded === null) break;
            if (getChatKey() !== chatKey || !requireReadyChatMutation('settle queued dossier backfill', chatKey, { notify: false })) break;
            // (1.10.1) A scan that began while this backfill was getting ready holds the chat: the backfill made no request (it found the chat
            // busy). Writing the queue now would change the dossier state under that scan, which then discards its result; the request stays
            // queued, uncounted, for the next run.
            if (isScanBusy(chatKey)) break;
            const latest = getChatState(chatKey);
            const currentRequest = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
            if (!currentRequest || currentRequest.requestedAt !== request.requestedAt || currentRequest.requestedMessageId !== request.requestedMessageId) continue;
            if (!succeeded) {
                const queued = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
                if (queued) {
                    queued.attempts = attempts + 1;
                    queued.lastAttemptAt = Date.now();
                    if (queued.attempts >= BACKFILL_MAX_ATTEMPTS) {
                        latest.pendingBackfills = latest.pendingBackfills.filter(item => item.npcId !== request.npcId);
                        if (!queued.silent) globalThis.toastr?.warning?.(`NPC State Delta: automatic backfill for ${queued.label} failed ${BACKFILL_MAX_ATTEMPTS} times and was removed from the retry queue. The dossier itself was not deleted.`);
                    }
                }
                persist();
                // One failed dossier must not starve other queued targeted repairs.
                continue;
            }
            latest.pendingBackfills = (latest.pendingBackfills || []).filter(item => item.npcId !== request.npcId);
            persist();
            processed += 1;
        }
        return processed;
    }

    return { backfillNpcFromHistory, processPendingBackfillsInner };
}
