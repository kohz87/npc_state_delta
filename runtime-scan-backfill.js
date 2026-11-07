/* NPC State Delta reply-scan backfill helpers (role: reply-scan-backfill). The pending-backfill queue entry a scan
   records for a missed participant or a new admission, and the cap on new people admitted from one capture block.
   Split unchanged from runtime-scan.js. */

import { AUTOMATIC_BACKFILL_QUEUE_VERSION } from './scan-context.js';
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
