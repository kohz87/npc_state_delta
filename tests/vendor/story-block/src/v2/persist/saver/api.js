// Story Suite v2: the saver's public object. It keeps the original method order and the live closure state
// shared with the save loop and the suspect-chat watch.

import { LATE_MS, LATE_MAX_MS } from './constants.js';

export function createSaverApi({
    state, dirty, target, check, save, endFollow, later, openWindow, idle, cancel, clearTimer, clearDeadline,
    markSuspect, confirmed, saveNow, suspectOf, suspects, waitDelay, backoff, followUp, failed,
}) {
    return {
        touch() {
            const wasDirty = state.version !== state.saved;
            state.version++;
            const now = typeof target === 'function' ? target() : null;
            if (wasDirty && state.latest && now && state.latest.chatId !== now.chatId) state.orphans.push({ target: state.latest, tries: 0 });
            state.latest = now ?? state.latest;
        },
        dirty,
        /**
         * Chat `from` is now called `to` (SillyTavern renamed its file): its unsaved changes, waiting or
         * left behind, belong to `to` and its file. True when there was any.
         */
        renamed(from, to) {
            if (!from || !to || from === to) return false;
            let moved = false;
            const move = change => {
                if (!change || change.chatId !== from) return change;
                moved = true;
                return { ...change, chatId: to, place: change.place ? { ...change.place, chatId: to } : change.place };
            };
            state.latest = move(state.latest);
            for (const orphan of state.orphans) orphan.target = move(orphan.target);
            // A1-3: a suspect chat's read-backs follow it to its new name.
            if (suspects.rename(from, to, move)) moved = true;
            if (state.sending && state.sending.chatId === from) {
                state.sending.renamed = true;
                moved = true;
            }
            return moved;
        },
        pending: () => state.timer !== null || state.deadline !== null || state.running !== null,
        /** True while a write of some chat timed out and its file is still to be read back. */
        suspect: () => suspects.size() > 0,
        /** True while a save of the open chat is on its way (the server has not answered yet). */
        inFlight: () => state.sending !== null,
        /**
         * A1-2: chat `now` (a target) was opened: the read-backs a reload of the page left (`memo`) go on.
         */
        resume(now) {
            return suspects.resume(now);
        },
        /**
         * A1-4: the page is closing. With a save of the open chat still on its way, the newest state goes
         * out at once (with `options`, e.g. keepalive), not behind it; it is stamped and the chat is
         * suspect, as after a timeout (the page may stay). Otherwise as saveSoon. Never throws.
         * A save on its way that already carries the newest change is not sent twice, unless `force`
         * (the page is going away and may cut that request off).
         */
        urgent({ force = false, ...options } = {}) {
            endFollow();
            if (!state.sending || state.version === state.saved || !state.latest) return this.saveSoon(options);
            if (!force && state.sending.goal === state.version) return Promise.resolve(false);
            const now = state.latest;
            const verdict = typeof check === 'function' ? check(now) : '';
            if (verdict) return this.saveSoon(options);
            const entry = markSuspect(now);
            try {
                return Promise.resolve(save(now, { ...options, stamp: true })).then(result => {
                    confirmed(entry, result);
                    return false;
                }, () => false);
            } catch {
                return Promise.resolve(false);
            }
        },
        /** True while the last save failed (until one works again). */
        failing: () => state.failures > 0,
        /** Saves `ms` after the last call; inside an idle window (idle()) the window's save stands instead. */
        schedule(ms = 400) {
            if (state.deadline !== null) return;
            later(ms);
        },
        /**
         * The turn's save (IDLE_MS): `wait` ms after the last call, at most `max` ms after the first one of
         * the window. A failed save stays dirty and is tried again as any other.
         */
        idle,
        /**
         * A module's own step after the reply (`sdk.command` with `background`; the only user of the late phase):
         * inside the turn's window it is saveIdle; inside a late window the wait is extended (a pending failure retry
         * is kept); within FOLLOW_MS of a window's save it opens a late window (LATE_MS, LATE_MAX_MS); otherwise it is
         * the turn's save (IDLE_MS).
         */
        late() {
            // A failed save's retry (backoff) is earlier than any late wait: it stays.
            if (state.deadline !== null) {
                if (!state.lateWindow) idle();
                else if (state.failures === 0) later(LATE_MS);
                return;
            }
            if (state.follow === null) { idle(); return; }
            openWindow(LATE_MAX_MS);
            state.lateWindow = true;
            if (!(state.failures > 0 && state.timer !== null)) later(LATE_MS);
        },
        /**
         * Puts off the save that is only waiting (the reply's own save takes it along). Inside an idle window
         * its latest save (`max`) still stands, so a change never waits longer than that.
         */
        defer() {
            endFollow();
            clearTimer();
            if (state.lateWindow) clearDeadline();   // a late window's bound (15 s) must not outlive the generation that ends the phase
        },
        /** Saves now; resolves to true when saved, false when not (told and tried again). */
        saveSoon(options = {}) {
            cancel();
            return saveNow(options).then(() => {
                followUp();
                return !dirty();
            }, error => {
                failed(error);
                return false;
            });
        },
        async flush() {
            cancel();
            try {
                await saveNow();
            } catch (error) {
                // The caller tells the reader; the save is still tried again.
                later(error?.wait ? waitDelay() : backoff());
                throw error;
            }
            followUp();
        },
        cancel,
    };
}
