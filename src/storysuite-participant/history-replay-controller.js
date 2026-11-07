// Catch-up controller for history replay. The replay engine lives in history-replay.js; this module owns the open chat's
// task, status, Skip, trigger, loop, runOnce and barrier wait, and decides when the engine runs.

import { createHistoryReplay, HISTORY_REPLAY_CAP, HISTORY_REPLAY_MAX_ATTEMPTS, isRecord } from './history-replay.js';
import { restoredState } from './timeline.js';

// ---- the catch-up controller: what the participant and the adapter use of the engine for the open chat ----
// `port` (src/adapter/timeline.js): chatKey(), enabled(), live() (the runtime's replay boundaries, runtime-entry-public-write.js), publish() (one native
// change, after the install), changed() (the banner redraws). `restored` (Story Block's fallback), the resume on chat open and `rebuild` all come
// here. The hold is set before any of them returns: canGenerate answers "not yet" while a catch-up is pending or running. Failure, a switch of
// chat or a change of head ends the hold and leaves the dossiers as they were; the saved field makes the next chat open try again (3 tries).
export function createCatchUp(port) {
    let task = null, queued = null, engine = null, held = false;
    let staleRetries = 0;    // a live edit during the wait makes the result stale: one more try on top of it
    let skipAsked = false;   // Skip pressed for the job in hand, also before the engine exists (while Story Block's barrier is still up)
    let info = { active: false, done: 0, total: 0, older: 0, from: null, reason: '', outcome: null, message: '' };
    const live = () => port.live();
    const changed = () => { try { port.changed?.(); } catch { /* the banner is best effort */ } };
    const status = () => ({ ...info, active: held });

    // The job for a trigger, worked out at once (the count is on the banner and in the hold's words before anything runs).
    function plan(kind, { reason, last } = {}) {
        const L = live();
        const field = L.state().catchUp;
        const saved = isRecord(field) && !field.skipped && Array.isArray(field.ids) && field.attempt < HISTORY_REPLAY_MAX_ATTEMPTS && L.active(field.ids) ? field : null;
        if (kind === 'resume') {
            if (!saved) return null;
            return { reason: saved.reason, empty: saved.reason === 'rebuild', ids: saved.ids.slice(), cap: saved.cap, from: saved.since ?? null, saved };
        }
        if (reason === 'rebuild') return { reason, empty: true, ids: L.all(), cap: last === null ? Infinity : last, from: null, saved: null };
        const { ids, marker } = L.pending();
        return { reason, empty: false, ids, cap: HISTORY_REPLAY_CAP, from: marker, saved: null };
    }

    async function runOnce(job) {
        const L = live();
        const key = port.chatKey();
        const { ids, reason } = job;
        const cap = Math.max(0, Number.isFinite(job.cap) ? job.cap : ids.length);
        const base = job.empty ? L.empty() : L.copy();
        if (job.saved) base.catchUp = job.saved; else delete base.catchUp;
        const head = L.head();
        const sameHead = now => now.key === key && now.length === head.length && now.last === head.last && now.swipe === head.swipe;
        const first = () => (job.saved && job.saved.to < ids.length ? job.saved.from : Math.max(0, ids.length - cap));
        engine = createHistoryReplay({
            cap,
            copyState: from => { const copy = structuredClone(from); if (first() > 0) L.markRead(copy, ids[first() - 1]); return copy; },
            viewFor: index => ids[index],
            runReply: (copy, id, sink) => L.reply(copy, id, sink, key),
            stillValid: () => { const now = L.head(); return sameHead(now) && now.state === head.state; },
            install: state => L.install(restoredState(state, L.state())),
            publishOnce: () => port.publish(),
        retryPublish: error => port.retryPublish?.(error),
            persistCatchUp: field => L.writeCatchUp(field ? { ...field, ids, cap, since: job.from } : null),
            progress: ({ done, total }) => { info = { ...info, done, total }; changed(); },
        });
        const result = await engine.run({ base, replies: ids.map(id => ({ id })), reason });
        if (result.skipped && ids.length) { await L.markReadLive(ids[ids.length - 1]); }
        const outcome = result.code === 'DONE' || result.code === 'EMPTY' ? 'done' : result.skipped ? 'skipped' : result.code === 'STALE' ? 'stale' : 'failed';
        info = { ...info, done: result.done ?? info.done, outcome, message: result.error ?? '' };
        // Not finished, and only the dossiers moved meanwhile (a live edit during the wait): the caller tries once more on top of it.
        return outcome !== 'done' && outcome !== 'skipped' && sameHead(L.head()) && L.head().state !== head.state;
    }

    async function loop() {
        try {
            while (queued) {
                const job = queued;
                queued = null; engine = null; skipAsked = false;
                info = { active: true, done: 0, total: Math.min(job.ids.length, job.cap), older: Math.max(0, job.ids.length - job.cap), from: job.from, reason: job.reason, outcome: null, message: '' };
                changed();
                try {
                    // Story Block asks Story Block's queries only once its barrier is down; a barrier that stays up ends this try (nothing is read as null).
                    if (typeof port.settled === 'function' && await port.settled() === false) { info = { ...info, outcome: 'stale', message: 'The host was still busy.' }; continue; }
                    if (skipAsked) { await live().markReadLive(job.ids[job.ids.length - 1]); info = { ...info, outcome: 'skipped' }; continue; }
                    if (await runOnce(job) && staleRetries++ < 1) queued = plan('resume');
                } catch (error) { info = { ...info, outcome: 'failed', message: error?.message ?? String(error) }; }
            }
        } finally {
            held = false;
            task = null;
            changed();
        }
    }

    function trigger(kind, options) {
        if (!port.enabled()) return { ok: true, started: false };
        let job = null;
        try { job = plan(kind, options); } catch (error) { port.warn?.(`The catch-up could not be planned: ${error?.message ?? error}`); }
        if (!job || !job.ids.length) return { ok: true, started: false };
        held = true; staleRetries = 0;
        info = { ...info, active: true, total: Math.min(job.ids.length, job.cap), done: 0, from: job.from, reason: job.reason };
        queued = job;
        if (!task) task = loop();
        return { ok: true, started: true };
    }

    return {
        /** Story Block's `restored({ from, to, reason })`: a fallback installed an earlier checkpoint. Answers at once (its callbacks have 10 s). */
        restored: () => trigger('new', { reason: 'fallback' }),
        /** Chat opened (dossiers loaded): resumes a saved, unfinished catch-up. */
        resume: () => trigger('resume'),
        /** "Start this branch's dossiers from the chat": the last `replies` replies (null: all) onto an empty state; nothing is installed before the end. */
        rebuild: ({ replies = HISTORY_REPLAY_CAP } = {}) => trigger('new', { reason: 'rebuild', last: replies === null ? null : Math.max(0, Math.floor(Number(replies)) || 0) }),
        /** canGenerate: false while sending is held. */
        canGenerate: () => (held ? { ok: false, reason: `Sending waits until the dossiers catch up (reply ${Math.min(info.done + 1, info.total)} of ${info.total}).` } : true),
        status,
        /** Skip: stop after the current reply, keep the installed dossiers, mark the replies read. */
        async skip() {
            if (task) { skipAsked = true; engine?.skip(); return status(); }
            const field = live().state().catchUp;
            if (isRecord(field) && Array.isArray(field.ids) && field.ids.length) {
                await live().markReadLive(field.ids[field.ids.length - 1]);
                info = { ...info, outcome: 'skipped' };
                changed();
            }
            return status();
        },
        idle: () => task ?? Promise.resolve(),
    };
}
