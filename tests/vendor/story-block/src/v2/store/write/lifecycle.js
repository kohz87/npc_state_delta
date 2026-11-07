// Story Suite v2: the store's lifecycle and maintenance writes: rebuild, archived, archiveList, batch and renamed.
// Moved out of createWrite unchanged; createWrite puts them in api at the places they were.

import { KEY, dropCopy, writeRecord } from '../../persist.js';

export function createLifecycle(s, deps) {
    const { archive, bury2, current, forgetMemos, headKey, idsOf, keeps, list, retain, sameKey, saver, settleAll } = deps;

    return {
        rebuild() {
            s.frozenCheckpoints = new WeakMap();
            const previous = s.idIndex;
            s.idIndex = null;
            s.cache = null;
            forgetMemos();
            // The record copies and old receipts are settled over the whole chat, and a record whose
            // swipe moved is stamped again (settleAll).
            if (settleAll(list())) saver.touch();
            // Ids this session knew of this chat that are no longer in it were deleted: they are archived. The index is
            // (re)built on every rebuild, so what is there now is the baseline of the next one (a store just opened over
            // saved records has one from its first rebuild); another chat's ids are never carried over.
            const now = idsOf(list());
            if (previous && previous.arr === list() && previous.chat === now.chat) bury2(previous, now);
            current();
        },

        /** Is this canonical sid, swipe key or evidence id archived (its reply or swipe was deleted)? It confers no eligibility. */
        archived(id) {
            return archive().has(id);
        },
        /** The archive: the ids that were deleted, sorted. */
        archiveList() {
            return [...archive()].sort();
        },

        // Runs `fn` (it may be async) with the swipe_info copies of every record it writes held back,
        // then copies each once: a reply's change lines are stored one by one (each must apply on its
        // own), but a long block is not copied once per line (B1-1).
        async batch(fn) {
            s.holding += 1;
            try {
                return await fn();
            } finally {
                s.holding -= 1;
                if (!s.holding) {
                    // The copies are written again as they are: a head cached before stays the head.
                    const arr = list();
                    const kept = s.cache && sameKey(s.cache.key, headKey(arr)) ? s.cache : null;
                    for (const message of s.held) {
                        const record = message.extra?.[KEY];
                        if (!record) continue;
                        if (keeps(message, arr)) writeRecord(message, record);
                        else dropCopy(message);
                    }
                    s.held.clear();
                    if (kept) retain(arr, kept.state, kept.problems);
                }
            }
        },

        /**
         * B-b2-timeline-r2-2: chat `from` was renamed `to` (SillyTavern's CHAT_RENAMED). A change not yet
         * saved, or left for its old chat's file, goes into the renamed chat's file instead: the old one
         * is gone, and a renamed open chat is read back as new messages, which looks like another chat.
         */
        renamed(from, to) {
            if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) return false;
            let moved = saver.renamed(from, to);
            for (const entry of s.unsaved.values()) {
                if (entry.chatId !== from) continue;
                entry.chatId = to;
                moved = true;
            }
            if (moved && saver.dirty()) saver.schedule();
            return moved;
        },
    };
}
