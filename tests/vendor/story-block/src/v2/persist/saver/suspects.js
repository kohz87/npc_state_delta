// Story Suite v2: the timed-out-save watch. A chat whose write timed out stays suspect: later writes stamp
// its file, read it back on the configured delays, and put a newer copy back when the file is stale.

export function createSuspects({
    timers, confirm, memo, recheck, target, onError,
    answered, exclusive, cancel, saveNow, followUp, failed, reopen,
}) {
    // chat ID → { target, good: stamp | null, step, stale, timer }: a write of that chat timed out.
    const suspects = new Map();

    // The suspect chats, kept in `memo` (a reload of the page goes on with their read-backs).
    function remember(chatId, entry) {
        try { memo?.set?.(chatId, entry ? { good: entry.good, step: entry.step, place: entry.target?.place ?? null } : null); } catch { /* only a convenience */ }
    }
    function forgetStamp(stamp) {
        if (stamp === null || stamp === undefined) return;
        try { confirm?.forget?.(stamp); } catch { /* nothing kept */ }
    }
    function markSuspect(where, good = null) {
        const chatId = where?.chatId;
        if (chatId === undefined || chatId === null) return null;
        const old = suspects.get(chatId);
        if (old?.timer !== null && old?.timer !== undefined) timers.clearTimeout(old.timer);
        const entry = { target: where, good: good ?? old?.good ?? null, step: 0, stale: 0, timer: null };
        suspects.set(chatId, entry);
        remember(chatId, entry);
        return entry;
    }
    // A write of a suspect chat was answered: its stamp is what the file must hold from now on.
    function confirmed(entry, result) {
        const stamp = result?.stamp;
        if (!entry || stamp === null || stamp === undefined || ![...suspects.values()].includes(entry)) return;
        if (entry.good !== stamp) forgetStamp(entry.good);
        entry.good = stamp;
        remember(entry.target.chatId, entry);
    }
    function finish(entry) {
        const chatId = entry.target?.chatId;
        if (suspects.get(chatId) !== entry) return;
        suspects.delete(chatId);
        remember(chatId, null);
        forgetStamp(entry.good);
    }
    const suspectOf = chatId => (chatId === undefined || chatId === null ? null : suspects.get(chatId) ?? null);

    // After a timeout: is the newest answered write of the suspect chat still the one in its file? Read
    // back after each delay; an older one found there is put right at once, and read again at that delay.
    const MAX_STALE = 5;
    function startRechecks(chatId) {
        const run = suspectOf(chatId);
        if (!run || run.timer !== null || run.good === null || run.good === undefined || typeof confirm?.holds !== 'function') return;
        if (run.step >= recheck.length) {
            finish(run);
            return;
        }
        run.timer = timers.setTimeout(async () => {
            let holds = true;
            try { holds = await answered(() => confirm.holds(run.target, run.good)) !== false; } catch { holds = true; }
            run.timer = null;
            if (suspects.get(run.target?.chatId) !== run) return;     // a newer timeout started its own
            if (!holds && run.stale < MAX_STALE) {
                run.stale++;
                await putBack(run);
            } else run.step++;
            // (a put-back that timed out made the chat suspect anew: that entry goes on instead)
            const chatId = run.target?.chatId;
            if (suspects.get(chatId) === run) remember(chatId, run);
            startRechecks(chatId);
        }, recheck[run.step]);
        run.timer?.unref?.();
    }
    function startAll() {
        for (const chatId of [...suspects.keys()]) startRechecks(chatId);
    }

    // The file holds an older write than `run.good`.
    async function putBack(run) {
        const now = typeof target === 'function' ? target() : null;
        const open = now && now.chatId === run.target.chatId;
        if (open && (typeof confirm?.fresh !== 'function' || confirm.fresh(run.good) !== false)) {
            // The open chat holds that write or a newer one: saved again (stamped anew).
            reopen(now);
            cancel();
            await saveNow().then(followUp, failed);
            return;
        }
        let why = '';
        try {
            const done = typeof confirm?.restore === 'function'
                ? await exclusive(() => answered(() => confirm.restore(run.target, run.good), () => markSuspect(run.target, run.good)))
                : false;
            if (done === false) {
                // Nothing of that write is kept on this page (it was reloaded since): it cannot be put back.
                run.stale = MAX_STALE;
                why = 'this page no longer holds the newer copy, so the latest changes before the reload may be missing';
            } else if (open) why = 'the newer copy is back in the file: reload the chat to see it';
        } catch (error) {
            why = `putting the newer copy back failed (${String(error?.message ?? error).trim().replace(/[.\s]*$/, '')}); it is tried again`;
        }
        if (!why || run.told) return;
        run.told = true;
        try {
            onError?.(new Error(`A save of chat "${run.target.chatId}" that took too long reached the server late and put an older copy of the chat back: ${why}.`));
        } catch { /* told in the console below */ }
        console.warn(`[Story Suite] a late save put an older copy of chat "${run.target.chatId}" back`);
    }

    /**
     * A1-2: chat `now` (a target) was opened: the read-backs a reload of the page left (`memo`) go on.
     */
    function resume(now) {
        const chatId = now?.chatId;
        if (chatId === undefined || chatId === null || suspects.has(chatId)) return false;
        let kept = null;
        try { kept = memo?.get?.(chatId) ?? null; } catch { kept = null; }
        if (!kept || !Number.isFinite(kept.good)) return false;
        const step = Number.isInteger(kept.step) && kept.step >= 0 ? kept.step : 0;
        suspects.set(chatId, { target: { ...now, place: now.place ?? kept.place ?? null }, good: kept.good, step, stale: 0, timer: null });
        startRechecks(chatId);
        return true;
    }

    // A1-3: a suspect chat's read-backs follow it to its new name.
    function rename(from, to, move) {
        const entry = suspects.get(from);
        if (!entry) return false;
        suspects.delete(from);
        remember(from, null);
        entry.target = move(entry.target) ?? { chatId: to };
        suspects.set(to, entry);
        remember(to, entry);
        return true;
    }

    return { markSuspect, confirmed, startRechecks, startAll, suspectOf, resume, rename, size: () => suspects.size };
}
