// Story Suite v2: the store's saving methods (touch, lifecycleChanged, saveIdle, saveLate, idleSaves), moved out of
// createWrite unchanged: the ones that mark the chat or its timing as changed and leave the writing to persist.js.
// createWrite puts them in api at the places they were: createSavingStart returns the first two, createSavingEnd the
// last three, so the object's key order and the store's method order stay as they were.

export function createSavingStart(s, deps) {
    const { saver, markNow, forgetMemos, markFlipped, current } = deps;

    return {
        /** Marks the chat as changed outside its records (the timeline's archive in the chat's metadata): the next save writes it. */
        touch() {
            saver.touch();
        },

        /**
         * The modules' lifecycle changed (a module turned ready or dormant, the `modules` event): the checkpoints over guarded
         * blocks that were made under other owners no longer hold (chain), so the head is replayed again from before them with
         * the guards asked, and only then does the caller publish a head. Guarded blocks before the checkpoint a replay would
         * start from are found by that replay. → true when the chat holds guarded blocks.
         * `{ barrier: true }`: only the restore barrier went up or down (no module turned ready or dormant by itself): the guards'
         * answers under a mark seen since the last data change still hold, so its memos come back (memo.js markFlipped).
         */
        lifecycleChanged({ barrier = false } = {}) {
            const mark = markNow();
            // A barrier flip to another guard mark with no write: what was read under the other marks is banked and this mark's comes
            // back. A module turned ready or dormant, the same mark, or a chat with no guarded block: all is forgotten and the guards are asked.
            if (barrier && s.guardSeen && mark !== s.lastMark) markFlipped(mark);
            else {
                s.lastMark = mark;
                s.cache = null;
                forgetMemos();
            }
            current();
            return s.guardSeen;
        },
    };
}

export function createSavingEnd(s, deps) {
    const { saver, rescue, place } = deps;

    return {
        /**
         * The turn's save (docs/v2/PERFORMANCE.md, "Long chats"): the reply's capture and the reader's actions
         * after it are written once, a moment after the last of them (persist.js IDLE_MS, at most IDLE_MAX_MS
         * after the first). Only where a change left behind by a chat switch can still be put into its own
         * chat's file (a chat file and `rescue`): then → true. Elsewhere (no chat file this page can write,
         * e.g. a temporary chat) → false, and the caller saves at once as before.
         */
        saveIdle(wait, max) {
            let where = null;
            try { where = typeof rescue === 'function' ? place() : null; } catch { where = null; }
            if (!where) return false;
            saver.idle(wait, max);
            return true;
        },
        /**
         * A change after the reply (a module's command, a reader's action): as saveIdle, but within FOLLOW_MS of the
         * turn's save it joins one late window (persist.js LATE_MS / LATE_MAX_MS) instead of a save of its own. Same
         * condition as saveIdle: false where the caller must save at once.
         */
        saveLate() {
            let where = null;
            try { where = typeof rescue === 'function' ? place() : null; } catch { where = null; }
            if (!where) return false;
            saver.late();
            return true;
        },
        /** True when changes are saved by the turn's idle save here (see saveIdle). */
        idleSaves() {
            try { return typeof rescue === 'function' && !!place(); } catch { return false; }
        },
    };
}
