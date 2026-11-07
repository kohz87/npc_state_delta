/* NPC State Delta reply-scan backfill helpers (role: reply-scan-backfill). The pending-backfill queue entry a scan
   records for a missed participant or a new admission, and the cap on new people admitted from one capture block.
   Split unchanged from runtime-scan.js. */

import { AUTOMATIC_BACKFILL_QUEUE_VERSION, AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT, npcParticipatesInExchange } from './scan-context.js';
import { npcMatchesLabel } from './core.js';
import { rawScanMatchesExisting } from './src/relationship-pass.js';

export function queueNpcBackfillInState(state, npcId, label, requestedMessageId = null, options = {}) {
    const reason = String(options?.reason || '').trim();
    if (!state || !npcId || !String(label || '').trim() || !['missed-participant', 'new-admission'].includes(reason)) return state;
    if (!Array.isArray(state.pendingBackfills)) state.pendingBackfills = [];
    const cleanLabel = String(label || '').trim().slice(0, 120);
    state.pendingBackfills = state.pendingBackfills.filter(item => item?.npcId !== npcId);
    state.pendingBackfills.push({
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason,
        npcId: String(npcId).slice(0, 100),
        label: cleanLabel,
        requestedMessageId: Number.isInteger(requestedMessageId) ? requestedMessageId : null,
        preserveLiveState: options?.preserveLiveState === true,
        silent: options?.silent === true,
        requestedAt: Date.now(),
        attempts: 0,
        lastAttemptAt: 0,
    });
    if (state.pendingBackfills.length > 100) state.pendingBackfills.splice(0, state.pendingBackfills.length - 100);
    return state;
}

// (b6-soak-2) One capture block admits at most this many new people. A crowd scene (a block naming
// forty dockhands) otherwise makes forty dossiers, each with its own backfill request later; the
// people left out are admitted from a later reply that names them again.
const CAPTURE_NEW_NPCS_PER_BLOCK = 4;
export function capCaptureAdmissions(parsed, npcs = []) {
    const rows = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
    let fresh = 0;
    const kept = rows.filter(raw => {
        if (npcs.some(npc => rawScanMatchesExisting(raw, npc))) return true;
        fresh += 1;
        return fresh <= CAPTURE_NEW_NPCS_PER_BLOCK;
    });
    if (kept.length === rows.length) return;
    console.info(`[NPC State Delta] a one-pass block named ${fresh} new people; ${CAPTURE_NEW_NPCS_PER_BLOCK} were admitted from it, the others wait for a later reply.`);
    parsed.npcs = kept;
}

// The follow-ups a scan queues in its new state (the backfill queue): a silent targeted repair for each person the broad scan left out of an exchange they
// took part in (bounded), and for each newly admitted dossier. Moved unchanged from runtime-scan.js.
export function queueScanFollowUps(nextState, { newlyAdmittedIds, resolvedParsed, targetMessageId, currentTranscript }) {
    // If the broad scanner omitted an NPC explicitly involved anywhere in the current
    // exchange, schedule a silent targeted continuity repair so memories/profile changes
    // get the same second chance as relationship scoring.
    const touchedIds = new Set(newlyAdmittedIds);
    const markBroadScanTarget = raw => {
        const id = String(raw?.id || '').trim();
        if (id && nextState.npcs.some(npc => npc.id === id)) {
            touchedIds.add(id);
            return;
        }
        const name = String(raw?.name || '').trim();
        if (!name) return;
        const matched = nextState.npcs.find(npc => npcMatchesLabel(npc, name));
        if (matched) touchedIds.add(matched.id);
    };
    for (const raw of Array.isArray(resolvedParsed?.npcs) ? resolvedParsed.npcs : []) markBroadScanTarget(raw);
    for (const raw of Array.isArray(resolvedParsed?.profileUpdates) ? resolvedParsed.profileUpdates : []) markBroadScanTarget(raw);
    const missedParticipants = [];
    for (const npc of nextState.npcs || []) {
        if (npc.archived || touchedIds.has(npc.id) || !npcParticipatesInExchange(npc, nextState.npcs || [], currentTranscript || '', { includeRole: false })) continue;
        missedParticipants.push(npc);
    }
    if (missedParticipants.length <= AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT) {
        for (const npc of missedParticipants) {
            queueNpcBackfillInState(nextState, npc.id, npc.name, targetMessageId, {
                reason: 'missed-participant',
                preserveLiveState: true,
                silent: true,
            });
        }
    } else {
        console.warn('[NPC State Delta] suppressed automatic per-NPC continuity fan-out after broad scan omitted multiple apparent participants.', {
            omittedParticipants: missedParticipants.length,
            limit: AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
        });
    }

    // Newly admitted dossiers may need richer recent-history enrichment than the broad
    // first pass provides. Repair only those new/promoted dossiers; admitting one NPC must
    // never fan out into targeted model calls for unrelated established cast members.
    for (const id of newlyAdmittedIds) {
        const admitted = nextState.npcs.find(npc => npc.id === id && !npc.archived);
        if (!admitted) continue;
        queueNpcBackfillInState(nextState, admitted.id, admitted.name, targetMessageId, {
            reason: 'new-admission',
            preserveLiveState: true,
            silent: true,
        });
    }
}
