/* NPC State Delta capture catch-up (role: capture-catchup). The quiet Refresh that a one-pass chat gives its most-seen NPCs every
   `narrationCaptureCatchUp` captured replies. It runs on its own schedule and no longer runs the backfill queue (that is started once
   per reply by scheduleReplyBackfills). One model call per NPC per reply: a person admitted by this reply's capture block is left to
   the backfill, and an NPC the catch-up takes is skipped by that reply's backfill. Built by runtime-scan.js; nothing here is saved. */

import { getSettings } from './runtime-settings.js';

export function createCatchUpPart(rt, deps) {
    const { getChatKey, getChatState, isHostSwipeActive, isScanBusy, persist, refreshNpcFromChat } = deps;
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
    // A new admission whose backfill has not tried yet is the backfill's; once it has tried and failed, the Refresh may cover the person.
    const leftToBackfill = (chatKey, id) => { const entry = queueEntry(chatKey, id); return entry?.reason === 'new-admission' && !(Number(entry.attempts) > 0); };

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
        const due = [...entry.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, CATCH_UP_TARGETS).map(([id]) => id)
            .filter(id => !leftToBackfill(chatKey, id));
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
        try {
            for (const id of ids) {
                if (getChatKey() !== chatKey) return;
                if (!getChatState(chatKey).npcs.some(npc => npc.id === id && !npc.archived)) continue;
                if (leftToBackfill(chatKey, id)) continue;
                const refreshed = await refreshNpcFromChat(id, { automatic: true });
                // A Refresh that worked has covered this person; the queued repair would only repeat it.
                if (refreshed && getChatKey() === chatKey) {
                    const latest = getChatState(chatKey);
                    if ((latest.pendingBackfills || []).some(item => item?.npcId === id)) {
                        latest.pendingBackfills = latest.pendingBackfills.filter(item => item?.npcId !== id);
                        persist();
                    }
                }
            }
        } finally { taken.delete(chatKey); }
    }

    return { noteCaptureCatchUp, runCaptureCatchUp };
}
