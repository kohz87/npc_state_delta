// History replay for NPC State Delta's restored-checkpoint fallback and "start from the chat" rebuild.
//
// createHistoryReplay(deps) owns only orchestration. Every effect outside the private state copy is injected:
//   copyState(base)                  -> a private working copy of the state (value or Promise)
//   viewFor(replyIndex)              -> the as-of view for that zero-based index in the supplied replies
//   runReply(state, view, sink)      -> the live per-reply path; sink records every outward write instead of sending it
//   stillValid(start)                -> true when the chat, lineage and head mark are unchanged since the run began
//   install(state)                   -> installs the finished copy once (value or Promise)
//   publishOnce()                    -> publishes the one native change after install
//   persistCatchUp(field | null)     -> stores { from, to, reason, attempt }; null clears it
//   progress({ done, total })        -> reports bounded replay progress
//   cap                              -> the number of newest replies to read (default 40)
//
// The sink is callable and also gives every property name as a recording method. Each call is appended to
// sink.calls as { name, args }; sink.replyIndex is the original reply index currently being replayed. Nothing
// in this module writes the live state, publishes, or forwards a Story Block operation itself.

import { restoredState } from './timeline.js';

export const HISTORY_REPLAY_CAP = 40;
export const HISTORY_REPLAY_MAX_ATTEMPTS = 3;

function messageOf(error) {
    return error?.message ?? String(error);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredCap(value) {
    const number = typeof value === 'function' ? value() : value;
    if (!Number.isFinite(number) || number < 0) return HISTORY_REPLAY_CAP;
    return Math.floor(number);
}

function fieldOf({ from, to, reason, attempt, skipped = false }) {
    return skipped
        ? { from, to, reason, attempt, skipped: true }
        : { from, to, reason, attempt };
}

function fieldCopy(field) {
    return field ? { ...field } : null;
}

function persistedOf(base) {
    const field = isRecord(base) ? base.catchUp : null;
    if (!isRecord(field)) return null;
    if (!Number.isInteger(field.from) || !Number.isInteger(field.to) || field.to < field.from) return null;
    return {
        from: field.from,
        to: field.to,
        reason: typeof field.reason === 'string' ? field.reason : '',
        attempt: Number.isInteger(field.attempt) && field.attempt > 0 ? field.attempt : 0,
        skipped: field.skipped === true,
    };
}

function failedResult(result) {
    return result === false || result === null || result instanceof Error
        || (isRecord(result) && result.ok === false);
}

function makeSink() {
    const calls = [];
    const methods = new Map();
    const record = (name, args) => {
        calls.push({ name, args });
        return undefined;
    };
    const target = (...args) => record('write', args);
    const sink = new Proxy(target, {
        apply: (_target, _thisArg, args) => record('write', args),
        get(object, property) {
            if (property === 'calls' || property === 'writes' || property === 'records') return calls;
            if (Reflect.has(object, property)) return Reflect.get(object, property);
            if (typeof property !== 'string') return undefined;
            if (!methods.has(property)) methods.set(property, (...args) => record(property, args));
            return methods.get(property);
        },
    });
    sink.calls = calls;
    return sink;
}

export function createHistoryReplay(deps = {}) {
    const required = ['copyState', 'viewFor', 'runReply', 'stillValid', 'install', 'publishOnce', 'persistCatchUp', 'progress'];
    for (const name of required) {
        if (typeof deps[name] !== 'function') throw new TypeError(`createHistoryReplay requires deps.${name}()`);
    }

    let phase = 'idle';
    let inFlight = false;
    let done = 0;
    let total = 0;
    let older = 0;
    let attempt = 0;
    let reason = '';
    let lastCatchUp = null;
    let lastResult = null;
    let lastError = null;
    let skipRequested = false;

    const snapshot = () => ({
        state: phase,
        status: phase,
        running: inFlight,
        pending: inFlight || Boolean(lastCatchUp && !lastCatchUp.skipped),
        done,
        total,
        older,
        attempt,
        reason,
        skipped: phase === 'skipped',
        installed: lastResult?.installed === true,
        published: lastResult?.published === true,
        canRetry: Boolean(lastCatchUp && !lastCatchUp.skipped && attempt < HISTORY_REPLAY_MAX_ATTEMPTS),
        maxAttempts: HISTORY_REPLAY_MAX_ATTEMPTS,
        catchUp: fieldCopy(lastCatchUp),
        error: lastError,
    });

    function finish(nextPhase, result) {
        phase = nextPhase;
        inFlight = false;
        lastResult = result;
        lastError = result.error ?? null;
        const answer = { ...result, ...snapshot() };
        return answer;
    }

    function failure(code, error, installed = false, published = false) {
        return finish('failed', {
            ok: false, code, error: messageOf(error), message: messageOf(error), installed, published, skipped: false,
        });
    }

    function planFor(base, replies, requestedReason) {
        const previous = persistedOf(base) ?? lastCatchUp;
        const runReason = requestedReason === undefined || requestedReason === null
            ? (previous?.reason ?? '')
            : String(requestedReason);
        const resumed = Boolean(previous && previous.reason === runReason);
        const cap = declaredCap(deps.cap);

        if (resumed && previous.skipped) {
            return { previous, resumed, runReason, cap, alreadySkipped: true };
        }

        const length = replies.length;
        let from = Math.max(0, length - cap);
        let to = length - 1;
        let indexes = null;
        let offset = 0;

        if (resumed) {
            const span = previous.to - previous.from + 1;
            if (previous.to < length) {
                from = previous.from;
                to = previous.to;
            } else if (length === span) {
                from = previous.from;
                to = previous.to;
                offset = previous.from;
            } else {
                return { previous, resumed, runReason, cap, stalePlan: true };
            }
            indexes = Array.from({ length: to - from + 1 }, (_unused, index) => offset + index);
        } else {
            indexes = Array.from({ length: Math.max(0, length - from) }, (_unused, index) => from + index);
        }

        return {
            previous, resumed, runReason, cap,
            from, to, indexes,
            older: resumed ? Math.max(0, from) : Math.max(0, length - cap),
            total: indexes.length,
            nextAttempt: resumed ? previous.attempt + 1 : 1,
        };
    }

    async function run({ base = null, replies = [], reason: requestedReason } = {}) {
        if (inFlight) return { ok: false, code: 'BUSY', message: 'A history replay is already running.', ...snapshot() };
        if (!Array.isArray(replies)) return { ok: false, code: 'INVALID', message: 'replies must be an array.', ...snapshot() };

        const source = replies.slice();
        const plan = planFor(base, source, requestedReason);
        done = 0;
        total = plan.total ?? 0;
        older = plan.older ?? 0;
        reason = plan.runReason ?? '';
        attempt = plan.previous?.attempt ?? 0;
        skipRequested = false;
        lastError = null;
        phase = 'running';
        inFlight = true;

        if (plan.alreadySkipped) {
            lastCatchUp = fieldCopy(plan.previous);
            attempt = plan.previous.attempt;
            return finish('skipped', {
                ok: true, code: 'SKIPPED', skipped: true, installed: false, published: false,
            });
        }

        if (plan.stalePlan) {
            lastCatchUp = fieldCopy(plan.previous);
            attempt = plan.previous.attempt;
            return finish('stale', {
                ok: false, code: 'STALE', skipped: false, installed: false, published: false,
                error: 'The saved replay range does not match the supplied replies.',
            });
        }

        attempt = plan.nextAttempt;
        if (attempt > HISTORY_REPLAY_MAX_ATTEMPTS) {
            lastCatchUp = fieldCopy(plan.previous);
            attempt = plan.previous.attempt;
            return finish('blocked', {
                ok: false, code: 'RETRY_CAP', skipped: false, installed: false, published: false,
                error: `History replay stopped after ${HISTORY_REPLAY_MAX_ATTEMPTS} attempts.`,
            });
        }

        if (plan.indexes.length === 0) {
            lastCatchUp = null;
            try { await deps.persistCatchUp(null); }
            catch (error) { return failure('PERSIST_FAILED', error); }
            return finish('done', { ok: true, code: 'EMPTY', skipped: false, installed: false, published: false });
        }

        lastCatchUp = fieldOf({ from: plan.from, to: plan.to, reason, attempt });
        try { await deps.persistCatchUp(fieldCopy(lastCatchUp)); }
        catch (error) { return failure('PERSIST_FAILED', error); }

        try { await deps.progress({ done: 0, total }); }
        catch (error) { return failure('PROGRESS_FAILED', error); }

        if (skipRequested) {
            const field = fieldOf({ from: plan.from, to: plan.to, reason, attempt, skipped: true });
            lastCatchUp = field;
            try { await deps.persistCatchUp(fieldCopy(field)); }
            catch (error) { return failure('PERSIST_FAILED', error); }
            return finish('skipped', { ok: true, code: 'SKIPPED', skipped: true, installed: false, published: false });
        }

        let copy;
        try { copy = await deps.copyState(base); }
        catch (error) { return failure('COPY_FAILED', error); }
        if (isRecord(copy) && Object.hasOwn(copy, 'catchUp')) delete copy.catchUp;

        const start = Object.freeze({ base, replies: source, reason, from: plan.from, to: plan.to, older, attempt });
        const sink = makeSink();

        for (const replyIndex of plan.indexes) {
            if (skipRequested) break;
            sink.replyIndex = replyIndex;
            try {
                const view = await deps.viewFor(replyIndex);
                const answer = await deps.runReply(copy, view, sink);
                if (failedResult(answer)) throw answer instanceof Error ? answer : new Error(answer?.message || 'runReply failed');
            } catch (error) {
                return failure('REPLY_FAILED', error);
            }
            done += 1;
            try { await deps.progress({ done, total }); }
            catch (error) { return failure('PROGRESS_FAILED', error); }
            if (skipRequested) break;
        }

        if (skipRequested) {
            const field = fieldOf({ from: plan.from, to: plan.to, reason, attempt, skipped: true });
            lastCatchUp = field;
            try { await deps.persistCatchUp(fieldCopy(field)); }
            catch (error) { return failure('PERSIST_FAILED', error); }
            return finish('skipped', { ok: true, code: 'SKIPPED', skipped: true, installed: false, published: false });
        }

        let valid = false;
        try { valid = await deps.stillValid(start); }
        catch (error) { return failure('STALE', error); }
        if (!valid) {
            lastCatchUp = fieldOf({ from: plan.from, to: plan.to, reason, attempt });
            return finish('stale', {
                ok: false, code: 'STALE', skipped: false, installed: false, published: false,
                error: 'The chat, lineage or head changed during history replay.',
            });
        }

        if (skipRequested) {
            const field = fieldOf({ from: plan.from, to: plan.to, reason, attempt, skipped: true });
            lastCatchUp = field;
            try { await deps.persistCatchUp(fieldCopy(field)); }
            catch (error) { return failure('PERSIST_FAILED', error); }
            return finish('skipped', { ok: true, code: 'SKIPPED', skipped: true, installed: false, published: false });
        }

        try {
            const installed = await deps.install(copy);
            if (failedResult(installed)) throw installed instanceof Error ? installed : new Error(installed?.message || 'install failed');
        } catch (error) {
            return failure('INSTALL_FAILED', error);
        }

        try { await deps.publishOnce(); }
        catch (error) { return failure('PUBLISH_FAILED', error, true, false); }

        try { await deps.persistCatchUp(null); }
        catch (error) { return failure('PERSIST_FAILED', error, true, true); }

        lastCatchUp = null;
        return finish('done', { ok: true, code: 'DONE', skipped: false, installed: true, published: true });
    }

    async function skip() {
        if (!inFlight) {
            if (lastCatchUp && !lastCatchUp.skipped) {
                const field = { ...lastCatchUp, skipped: true };
                lastCatchUp = field;
                try { await deps.persistCatchUp(fieldCopy(field)); }
                catch (error) { return failure('PERSIST_FAILED', error); }
                phase = 'skipped';
                lastResult = { ok: true, code: 'SKIPPED', skipped: true, installed: false, published: false };
                return snapshot();
            }
            return snapshot();
        }
        skipRequested = true;
        return snapshot();
    }

    return { run, skip, status: snapshot };
}

// ---- the catch-up controller: what the participant and the adapter use of the engine for the open chat ----
// `port` (src/adapter/timeline.js): chatKey(), enabled(), live() (the runtime's replay boundaries, runtime-entry-public-write.js), publish() (one native
// change, after the install), changed() (the banner redraws). `restored` (Story Block's fallback), the resume on chat open and `rebuild` all come
// here. The hold is set before any of them returns: canGenerate answers "not yet" while a catch-up is pending or running. Failure, a switch of
// chat or a change of head ends the hold and leaves the dossiers as they were; the saved field makes the next chat open try again (3 tries).
export function createCatchUp(port) {
    let task = null;
    let queued = null;
    let engine = null;
    let held = false;
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
        const first = () => (job.saved && job.saved.to < ids.length ? job.saved.from : Math.max(0, ids.length - cap));
        engine = createHistoryReplay({
            cap,
            copyState: from => { const copy = structuredClone(from); if (first() > 0) L.markRead(copy, ids[first() - 1]); return copy; },
            viewFor: index => ids[index],
            runReply: (copy, id, sink) => L.reply(copy, id, sink, key),
            stillValid: () => { const now = L.head(); return now.key === key && now.length === head.length && now.last === head.last && now.swipe === head.swipe && now.state === head.state; },
            install: state => L.install(restoredState(state, L.state())),
            publishOnce: () => port.publish(),
            persistCatchUp: field => L.writeCatchUp(field ? { ...field, ids, cap, since: job.from } : null),
            progress: ({ done, total }) => { info = { ...info, done, total }; changed(); },
        });
        const result = await engine.run({ base, replies: ids.map(id => ({ id })), reason });
        if (result.skipped && ids.length) { await L.markReadLive(ids[ids.length - 1]); }
        const outcome = result.code === 'DONE' || result.code === 'EMPTY' ? 'done' : result.skipped ? 'skipped' : result.code === 'STALE' ? 'stale' : 'failed';
        info = { ...info, done: result.done ?? info.done, outcome, message: result.error ?? '' };
    }

    async function loop() {
        try {
            while (queued) {
                const job = queued;
                queued = null;
                info = { active: true, done: 0, total: Math.min(job.ids.length, job.cap), older: Math.max(0, job.ids.length - job.cap), from: job.from, reason: job.reason, outcome: null, message: '' };
                changed();
                try { await runOnce(job); } catch (error) { info = { ...info, outcome: 'failed', message: error?.message ?? String(error) }; }
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
        held = true;
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
            if (task) { engine?.skip(); return status(); }
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
