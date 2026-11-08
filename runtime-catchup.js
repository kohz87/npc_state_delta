/* NPC State Delta capture catch-up (role: capture-catchup). The quiet Refresh that a one-pass chat gives its most-seen NPCs every
   `narrationCaptureCatchUp` captured replies. It runs on its own schedule and no longer runs the backfill queue (that is started once
   per reply by scheduleReplyBackfills). One model call per established NPC per reply: an NPC the catch-up takes is skipped by that
   reply's backfill. A newly met NPC (a new admission whose backfill has not tried) is the exception: the catch-up's targeted Refresh
   writes its structured appearance, so it gets the Refresh AND its backfill (never skipped, its queue entry kept). Built by runtime-scan.js; nothing here is saved. */

import { getSettings } from './runtime-settings.js';
import { latestMessageId } from './runtime-scan-helpers.js';

export function createCatchUpPart(rt, deps) {
    const { getChatKey, getChatState, isHostSwipeActive, isScanBusy, persist, processPendingBackfills, refreshNpcFromChat } = deps;
    const captureCatchUp = rt.captureCatchUp;
    // chat key -> ids the catch-up has in hand for the current reply (memory only); scheduleReplyBackfills skips them.
    const taken = rt.catchUpTaken ?? (rt.catchUpTaken = new Map());

    // (1.2.11) One-pass catch-up. Mannerisms, levers and memories fill from evidence gathered over
    // scenes, and a block written beside the story tends to leave them thin, while a Refresh (which
    // reads a window of scenes) fills them. So every `narrationCaptureCatchUp` captured replies, the
    // NPCs most in them get a quiet Refresh. Counted per chat in this session only; nothing is saved.
    const CATCH_UP_TARGETS = 2;
    const CATCH_UP_RETRY_MS = 3000;
    const CATCH_UP_RETRIES = 20;

    const queueEntry = (chatKey, id) => (getChatState(chatKey).pendingBackfills || []).find(item => item?.npcId === id);
    // A newly met NPC: a new admission whose backfill has not tried yet. It gets both the Refresh and the backfill.
    const newlyMet = (chatKey, id) => { const entry = queueEntry(chatKey, id); return entry?.reason === 'new-admission' && !(Number(entry.attempts) > 0); };

    /** Counts one captured reply and the NPCs in it; the NPC ids due a catch-up now, or []. */
    function noteCaptureCatchUp(chatKey, npcIds = []) {
        const every = Math.max(0, Math.round(Number(getSettings().narrationCaptureCatchUp) || 0));
        if (!every) return [];
        const entry = captureCatchUp.get(chatKey) ?? { count: 0, seen: new Map() };
        entry.count += 1;
        for (const id of new Set(npcIds)) if (id) entry.seen.set(id, (entry.seen.get(id) || 0) + 1);
        captureCatchUp.set(chatKey, entry);
        if (entry.count < every) return [];
        captureCatchUp.delete(chatKey);
        const due = [...entry.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, CATCH_UP_TARGETS).map(([id]) => id);
        // Every due NPC is held from the reply's own backfill start (it would race the Refresh for the chat and could win it, leaving a
        // newly met NPC without the Refresh); a newly met NPC's backfill runs right after the Refresh instead (runCaptureCatchUp).
        if (due.length) taken.set(chatKey, new Set(due));
        return due;
    }

    async function runCaptureCatchUp(chatKey, ids, tries = 0) {
        if (!ids.length || getChatKey() !== chatKey) { taken.delete(chatKey); return; }
        if (isScanBusy(chatKey) || isHostSwipeActive()) {
            if (tries < CATCH_UP_RETRIES) setTimeout(() => void runCaptureCatchUp(chatKey, ids, tries + 1), CATCH_UP_RETRY_MS);
            else taken.delete(chatKey);
            return;
        }
        let meetsBackfill = false;
        const established = [];
        try {
            for (const id of ids) {
                if (getChatKey() !== chatKey) return;
                if (!getChatState(chatKey).npcs.some(npc => npc.id === id && !npc.archived)) continue;
                const fresh = newlyMet(chatKey, id);
                if (fresh) meetsBackfill = true; else established.push(id);
                const refreshed = await refreshNpcFromChat(id, { automatic: true });
                // A Refresh that worked has covered an established person; the queued repair would only repeat it. A newly met one keeps its backfill.
                if (refreshed && !fresh && getChatKey() === chatKey) {
                    const latest = getChatState(chatKey);
                    if ((latest.pendingBackfills || []).some(item => item?.npcId === id)) {
                        latest.pendingBackfills = latest.pendingBackfills.filter(item => item?.npcId !== id);
                        persist();
                    }
                }
            }
        } finally { taken.delete(chatKey); }
        // The reply's own backfill start finds the chat busy while the Refresh runs; a newly met NPC's backfill runs now (one call).
        if (meetsBackfill && getChatKey() === chatKey) await processPendingBackfills(latestMessageId(true), { limit: 1, skipNpcIds: established });
    }

    return { noteCaptureCatchUp, runCaptureCatchUp };
}
