// Story Suite v2: one save per burst (SPEC §3.3). `touch()` marks a change; `schedule(ms)` saves `ms` after the last call;
// `saveSoon()` saves now and never throws (a failure is told and tried again); `flush()` saves now
// (waiting for a save already running) and rethrows a failure.
//
// Which chat a change belongs to is taken when it is made (`target()`, e.g. { chatId, carrier }), and
// `check(target)` is asked right before each save, in the same tick as the save starts (`save(target)`
// must start writing before it returns):
//   ''                  → save the chat that is open;
//   { wait: reason }    → a chat is being loaded (SillyTavern empties the chat before it reads the next
//                         one): nothing is written, it is tried again shortly (`waitMs`, `waits` times),
//                         then less often (`retry`'s longest) for as long as it takes: the change stays
//                         unsaved, never dropped (a big chat on a slow connection can take a while);
//   { moved: reason }   → another chat is open: the change is the other chat's, so the chat that is open
//                         is NOT saved; `rescue(target)` puts the change into that chat's own file;
//   { gone: reason }    → nothing of the change is left in the chat (its reply was deleted): nothing to save.
// A change made in one chat while another chat's change is still unsaved hands that one to `rescue` too.
// A failed save stays dirty: the reader is told once (`onError`) until a save works again, and it is
// tried again after `retry` ms (growing). `verify` (SPEC §3.3): `{ before() → token, after(token) → '' |
// problem }` around each save; a problem counts as a failed save.
// A save (or a rescue) the server does not answer within `timeout` ms counts as failed too: it is given
// up (`save` gets `{ signal }`, aborted then) and tried again, so a request left hanging (a dropped
// connection, a stuck proxy) never holds the next save, the reader's command or the next reply.
// A save of a chat renamed while it was on its way (`renamed`) landed under the old name: it does not
// count, and the change is saved again, into the renamed chat's file.
// A save given up that way may still be written: its body can already be at the server, which writes it
// when it gets to it, after the retry that carried a newer change (SillyTavern's integrity token is the
// same on both). So after a timeout of a save or a rescue, that chat is "suspect" (by its chat ID, kept
// through a rename, and in `memo` so a reload of the page goes on with it): each later write of it (a save
// or a rescue) is asked to stamp its file (`{ stamp: true }`; it resolves to `{ stamp }`, a rising number
// in the chat's metadata), and once one is answered the file is read back after each of `recheck` ms
// (`confirm.holds(target, stamp)` → true when the file holds that write or a newer one), whether the chat
// is open or not. A file holding an older one is put right at once: the open chat is saved again when it
// holds at least that write (`confirm.fresh(stamp)`); otherwise that write is put back
// (`confirm.restore(target, stamp)`, the page's copy of it), and when that is not possible either the
// reader is told. The read-backs end when the last delay has passed (about five minutes: a server drops a
// request whose body has not arrived by then). Without a timeout nothing is stamped or read. The
// read-backs never hold a save, the reader's command or the next reply.

import { createSaverApi } from './api.js';
import { createSuspects } from './suspects.js';
import { RECHECK_MS, IDLE_MS, IDLE_MAX_MS, FOLLOW_MS } from './constants.js';
import { createIo } from './io.js';

export function createSaver({
    save, onError = null, timers = globalThis, verify = null, target = null, check = null, rescue = null,
    retry = [1000, 2000, 4000, 8000, 15000], waitMs = 200, waits = 50, timeout = 20000,
    confirm = null, recheck = RECHECK_MS, memo = null,
} = {}) {
    if (typeof save !== 'function') throw new TypeError('createSaver needs a save function.');
    let version = 0;
    let saved = 0;
    let timer = null;
    let deadline = null;        // the idle window's latest save (idle())
    let lateWindow = false;     // the window was opened as a late one (late()) and the turn's save has not taken it over
    let follow = null;          // timer: the turn's save went out less than FOLLOW_MS ago (late changes join a late window)
    let running = null;
    let latest = null;          // target of the newest change
    const orphans = [];         // [{ target, tries }]: changes of a chat that is no longer open
    let failures = 0;           // failed saves in a row
    let told = false;           // the reader was told about this run of failures
    let waited = 0;             // saves put off in a row because a chat was being opened
    let sending = null;         // { chatId, renamed } of the save on its way

    const state = {
        get version() { return version; },
        set version(value) { version = value; },
        get saved() { return saved; },
        set saved(value) { saved = value; },
        get timer() { return timer; },
        set timer(value) { timer = value; },
        get deadline() { return deadline; },
        set deadline(value) { deadline = value; },
        get lateWindow() { return lateWindow; },
        set lateWindow(value) { lateWindow = value; },
        get follow() { return follow; },
        set follow(value) { follow = value; },
        get running() { return running; },
        set running(value) { running = value; },
        get latest() { return latest; },
        set latest(value) { latest = value; },
        get orphans() { return orphans; },
        get failures() { return failures; },
        set failures(value) { failures = value; },
        get told() { return told; },
        set told(value) { told = value; },
        get waited() { return waited; },
        set waited(value) { waited = value; },
        get sending() { return sending; },
        set sending(value) { sending = value; },
    };

    const dirty = () => version !== saved || orphans.length > 0;
    const backoff = () => retry[Math.max(0, Math.min(failures, retry.length) - 1)];

    function clearTimer() {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
    }
    function clearDeadline() {
        if (deadline !== null) timers.clearTimeout(deadline);
        deadline = null;
        lateWindow = false;
    }
    function endFollow() {
        if (follow !== null) timers.clearTimeout(follow);
        follow = null;
    }
    function startFollow() {
        endFollow();
        follow = timers.setTimeout(() => { follow = null; }, FOLLOW_MS);
        follow?.unref?.();
    }
    function cancel() {
        endFollow();   // an explicit save (flush, saveSoon, urgent) or a chat switch ends the late phase
        clearTimer();
        clearDeadline();
    }

    function later(ms) {
        clearTimer();
        timer = timers.setTimeout(() => {
            timer = null;
            const window = deadline !== null;
            clearDeadline();
            if (window) startFollow();
            saveNow().then(followUp, failed);
        }, ms);
        timer?.unref?.();
    }

    // The window's latest save: `ms` after the call that opens it (a window already open keeps its own).
    function openWindow(ms) {
        if (deadline !== null) return;
        deadline = timers.setTimeout(() => {
            deadline = null;
            lateWindow = false;
            clearTimer();
            startFollow();
            saveNow().then(followUp, failed);
        }, ms);
        deadline?.unref?.();
    }

    // The idle window (see IDLE_MS): each call puts the save `wait` ms after it, never past `max` ms after
    // the call that opened the window.
    function idle(wait = IDLE_MS, max = IDLE_MAX_MS) {
        // The turn's save or a reader's action joins a late window: the window becomes the turn's own, with
        // its shorter limit counted from now.
        if (deadline !== null && lateWindow) clearDeadline();
        openWindow(Math.max(wait, max));
        later(wait);
    }

    function tell(error) {
        if (told) return;
        told = true;
        try { onError?.(error); } catch { /* a missing toastr is not an error */ }
    }

    // A save that did not happen: told once, tried again later (a wait is not a failure).
    const waitDelay = () => (waited > waits ? retry[retry.length - 1] : waitMs);
    function failed(error) {
        if (error?.wait) later(waitDelay());
        else {
            tell(error);
            later(backoff());
        }
    }

    // Another chat's change that could not be written yet is tried again later.
    function followUp() {
        if (orphans.length && timer === null) later(backoff());
    }

    function reopen(now) {
        if (version === saved) {
            version++;
            latest = now;
        }
    }

    const { answered, exclusive } = createIo({ timers, timeout, state });
    const suspects = createSuspects({
        timers, confirm, memo, recheck, target, onError,
        answered, exclusive, cancel, saveNow, followUp, failed, reopen,
    });
    const { markSuspect, confirmed, startRechecks, startAll, suspectOf } = suspects;

    // Changes left behind in a chat that is no longer open go to that chat's own file. Never throws:
    // the chat that is open is saved either way; a rescue that keeps failing is given up and told.
    async function rescueOrphans() {
        for (const orphan of [...orphans]) {
            // Its chat is open again (and still holds the change, or took it back on): saved with it.
            const verdict = typeof check === 'function' ? check(orphan.target) : { moved: true };
            if (!verdict?.moved && !verdict?.wait) {
                orphans.splice(orphans.indexOf(orphan), 1);
                if (!verdict?.gone) {
                    // A change of a third chat still pending (`latest`) is that chat's: handed on, not overwritten.
                    if (version !== saved && latest && latest.chatId !== orphan.target?.chatId) orphans.push({ target: latest, tries: 0 });
                    if (version === saved) version++;
                    latest = orphan.target;
                }
                continue;
            }
            try {
                if (typeof rescue !== 'function') throw new Error('this page cannot write to another chat');
                // A1-5: a rescue is a write of that chat's file too: the same stamp and read-backs.
                const watched = suspectOf(orphan.target?.chatId);
                const result = await exclusive(() => answered(() => rescue(orphan.target, watched ? { stamp: true } : {}), () => markSuspect(orphan.target)));
                confirmed(watched, result);
                orphans.splice(orphans.indexOf(orphan), 1);
                startRechecks(orphan.target?.chatId);
            } catch (error) {
                orphan.tries++;
                if (orphan.tries < 3) continue;
                orphans.splice(orphans.indexOf(orphan), 1);
                try {
                    // B-b2-timeline-r2-2: the reason is the one the rescue met, not a guess at what happened.
                    const why = String(error?.message ?? error).trim().replace(/[.\s]*$/, '');
                    onError?.(new Error(`A change made in chat "${orphan.target?.chatId ?? '?'}" was not saved: that chat was no longer open when it was saved, and ${why}.`));
                } catch { /* told in the console below */ }
                console.warn('[Story Suite] a change of another chat was not saved', error);
            }
        }
    }

    async function saveNow(options = {}) {
        await rescueOrphans();
        let goal = 0;
        let token;
        const outcome = await exclusive(() => {
            if (version === saved) return 'clean';
            goal = version;
            const now = latest;
            const verdict = now && typeof check === 'function' ? check(now) : '';
            // C4-3: a chat being opened is waited for however long it takes; the change is never
            // dropped for it (the same chat read again takes the change back on, see `check`).
            if (verdict?.wait) {
                waited++;
                return verdict;
            }
            waited = 0;
            if (verdict?.gone) {
                saved = goal;
                return 'clean';
            }
            if (verdict?.moved) {
                orphans.push({ target: now, tries: 0 });
                saved = goal;
                return 'moved';
            }
            token = verify?.before?.();
            const trip = { chatId: now?.chatId, renamed: false, goal };
            sending = trip;
            // After a timeout of this chat's write, this one is stamped, so a read-back can tell it from the
            // late one (startRechecks).
            const watched = suspectOf(trip.chatId);
            const opts = watched ? { ...options, stamp: true } : options;
            return answered(signal => save(now, signal ? { ...opts, signal } : opts), () => markSuspect(now)).then(result => {
                confirmed(watched, result);
                return trip.renamed ? 'renamed' : 'saved';
            }, error => {
                failures++;
                throw error;
            }).finally(() => {
                if (sending === trip) sending = null;
            });
        });
        if (outcome?.wait) {
            const error = new Error(`The story is not saved yet: ${outcome.wait}.`);
            error.wait = true;
            throw error;
        }
        if (outcome === 'moved') await rescueOrphans();
        // C4-2: it landed under the chat's old name; the renamed chat's file is written next.
        if (outcome === 'renamed') return saveNow(options);
        if (outcome !== 'saved') return;
        // A change made while the save ran goes with the next save, which checks it then.
        const problem = version === goal ? verify?.after?.(token) : '';
        if (problem) {
            failures++;
            throw new Error(problem);
        }
        saved = goal;
        failures = 0;
        told = false;
        startAll();
    }

    return createSaverApi({
        state, dirty, target, check, save, endFollow, later, openWindow, idle, cancel, clearTimer, clearDeadline,
        markSuspect, confirmed, saveNow, suspectOf, suspects, waitDelay, backoff, followUp, failed,
    });
}
