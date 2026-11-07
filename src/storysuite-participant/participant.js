// NPC State Delta as a timeline participant (Story Block docs/v2/TIMELINE.md, contract §8; track B6): the module has native state beside
// the story (dossiers with their evidence, the relationship map, its own rollback history), so a save point and a restore must take its
// checkpoint with them, and a character's confirmed death must reach it.
//
//   checkpoint({ cursor, headHash })            -> { checkpoint, hash, schema }    the native state (with its np_ map and applied deaths), once Delta is quiet
//   verify({ checkpoint, hash })                -> { checkpoint, hash }            the checks of prepare, changing nothing (the host's fallback asks it)
//   prepare({ return, checkpoint, hash })       -> { prepared, hash }              verifies the bytes; shows nothing
//   activate({ return, prepared })              -> { checkpoint, hash }            installs state, map and deaths together; idempotent
//   abort({ return, prepared })                 -> { aborted: true }               before the commit only
//   status({ return })                          -> { checkpoint, hash, status }
//   applyEvent({ event, nativeKey, kind })      -> { event, checkpoint, hash, ack }  a confirmed death, once per event
//   rebuild({ replies }) / progress() / skip()   the catch-up (history-replay.js): start from the chat, the banner's read, stop
//   attach(handle)                              the host's handle { head(), nativeMutation(input) }
// and the query `npc.identity({ id } | { name })`. Every answer is `{ ok: true, ... }` or `{ ok: false, code, message }`; the callbacks run
// one at a time. Nothing here reads the chat or prompts: Delta's prompt text is not touched.
//
// `port` is what the participant needs of Delta's runtime (index.js and src/storysuite-v2.js):
//   chatKey()            the open chat's key (a string)
//   readState()          the chat's native state now, synchronously (a copy; window.NPCStateDelta.getState())
//   installState(state)  replaces the chat's native state absolutely and makes it durable (asynchronous); not a native change
//   writeTimeline(block) writes the participant's block (`state.timeline`) into the chat's state and makes it durable; not a native change
//   started()            whether the chat has its story line already (`state.timeline.lineage`), without reading the whole state (optional)
//   busy()               whether a scan or dossier pass is in flight for the open chat (optional)
//   idle(ms)             resolves true when none is, false after `ms` (optional)
//   headSource()         the Source of the reply at the head, for a host whose head() carries no `source` (optional; the host's head().source is used first)
//   enabled()            whether Delta is on (a catch-up runs only then)
//   live()               the runtime's history-replay boundaries (runtime-entry-public-write.js); without them no catch-up runs
//   changed()            the catch-up banner redraws (optional)
//   warn(text)           where problems are told (optional)
//   ready()              whether Delta has loaded the open chat's state (optional; without it the state is taken as loaded)
//   load()               loads the open chat's state when it is not loaded yet (asynchronous, optional)
//   normalize(state)     the state as Delta keeps it once installed (its own normalization; synchronous, optional)
//   branchPending()      whether the open chat is a branch still waiting for its parent's dossiers (optional)
//   inheritBranch()      runs Delta's branch inheritance for the open chat now (asynchronous, optional)
// `vault` keeps the bytes (vault.js). The np_ map, the reserved ids and the applied deaths live in the chat's state (timeline.js), the restores
// in flight and the acknowledged deaths in the vault's index of the state's lineage.

import { resolveIdentity } from './identity.js';
import { timelineOf } from './timeline.js';
import { manualLifeStateRecord } from '../../terminal-lifecycle.js';
import { createCatchUp } from './history-replay.js';
import { createParticipantHandlers } from './participant/handlers.js';
import { createPublication } from './participant/publication.js';
import { createSessionOps } from './participant/session-ops.js';
import { fail, isRecord, plain } from './participant/support.js';

export const MODULE_ID = 'npc-state-delta';

/** A dossier marked dead by a confirmed event: Delta's own explicit, terminal death record, with the event as its reason. */
export function confirmedDeath(npc, { event, now }) {
    const dead = manualLifeStateRecord(npc, 'deceased', now);
    dead.lifeStateReason = `Confirmed dead by the rules (event ${String(event).slice(0, 60)}).`;
    return dead;
}

const SNAPSHOT_EXPIRED = Symbol('snapshot-expired');

export function createParticipant({ port, vault, module = MODULE_ID, now = () => Date.now(), random, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), debounceMs = 300, retryMs = 1500, idleMs = 8000, boundMs = 8000, pollMs = 50, vaultTimeoutMs = 15000 }) {
    let session = null;      // { key, lineage, index }
    let handle = null;
    let queue = Promise.resolve();
    let hydrating = false;
    const indexRepairs = new Map(); // lineage -> function returning the index to restore before further participant work
    const writtenIndexes = new Map(); // last confirmed index per lineage, for a write that settles after its timeout
    const pendingAborts = new Map(); // host aborts that must be finished after a blocked repair or snapshot
    let repairQueued = false;
    const unfinishedSnapshots = new Set(); // timed-out calls remain here until their queued work actually ends
    let announced = 0;          // changes announced to the participant (noteChange), in this run
    const preparedAt = new Map();   // prepared id of an in-place publication -> `announced` when it was prepared (this run only)
    const warn = text => { try { port.warn?.(text); } catch { /* telling is best effort */ } };
    const keyNow = () => String(port.chatKey() ?? '');
    const usable = key => Boolean(key) && key !== 'no-chat';
    const readyNow = () => { try { return port.ready() === true; } catch { return false; } };

    // An injected vault, or a file response body, can ignore cancellation altogether. Bound every vault operation so one such call cannot
    // hold the participant queue forever. A timed-out index write that later settles is repaired to the latest confirmed index in the queue.
    const backend = vault;
    const vaultLimit = Number.isFinite(vaultTimeoutMs) && vaultTimeoutMs > 0 ? vaultTimeoutMs : 15000;
    function vaultCall(method, args) {
        const lineage = args[0];
        const index = method === 'putIndex' ? plain(args[1]) : null;
        if (index) args = [lineage, index];
        let timedOut = false;
        let timer;
        const operation = Promise.resolve().then(() => backend[method](...args)).then(value => {
            if (index) {
                if (timedOut) repairLateIndex(lineage);
                else writtenIndexes.set(lineage, plain(index));
            }
            return value;
        }, error => {
            if (index && timedOut) repairLateIndex(lineage);
            throw error;
        });
        const timeout = new Promise((_, reject) => {
            timer = schedule(() => { timedOut = true; reject(new Error(`The participant's vault ${method} did not answer in ${vaultLimit} ms.`)); }, vaultLimit);
        });
        return Promise.race([operation, timeout]).finally(() => cancel(timer));
    }
    vault = Object.fromEntries(['put', 'get', 'getIndex', 'putIndex'].map(method => [method, (...args) => vaultCall(method, args)]));
    /**
     * Whether Delta has loaded the open chat's state, loading it first when it has not. Before the load `readState()` is an empty state with
     * no story line: a lineage read from it would be minted anew and written over the real one, and the vault's index of the real one (the
     * changes in flight) would never be found again. A port without `ready` is taken as loaded.
     */
    async function loaded(until = null) {
        if (typeof port.ready !== 'function' || readyNow()) return true;
        let settled = false;
        const load = Promise.resolve().then(() => port.load?.()).catch(() => { /* answered by the look below */ }).then(() => { settled = true; });
        if (until === null) { await load; return readyNow(); }
        // A callback of the host has a bound of its own (10 s): the load is waited for inside it, never past it. Another load may be running
        // (the chat just opened), so the state is looked at every `pollMs`, not only when this load answers. A load that failed (`loadFailed`)
        // ends the wait; so does a load that answered while nothing is loading and the state is still not ready (a chat that cannot be loaded
        // now, e.g. not saved yet): the host asks again. A settled load is never raced again (it would answer at once and the timer would never run).
        const failedNow = () => { try { return port.loadFailed?.() === true; } catch { return false; } };
        const loadingNow = () => { try { return port.loading?.() !== false; } catch { return true; } };
        while (!readyNow() && !failedNow() && until - now() > 0) {
            if (settled && !loadingNow()) break;
            const tick = new Promise(resolve => { const id = schedule(resolve, Math.min(pollMs, Math.max(1, until - now()))); id?.unref?.(); });
            await (settled ? tick : Promise.race([load, tick]));
        }
        return readyNow();
    }
    /** When a host callback that must answer inside the host's bound has to be done: now + boundMs. */
    const deadline = () => now() + boundMs;
    const abortPendingHere = () => [...pendingAborts.values()].some(pending => pending.key === keyNow());
    const bookkeepingPending = () => fail('STALE', indexRepairs.size
        ? 'NPC State Delta is still restoring the participant index after a failed save; try again in a moment.'
        : 'NPC State Delta is still finishing an earlier abort; try again in a moment.');
    const earlierSnapshot = (allowRepair = false) => {
        if (unfinishedSnapshots.size) return fail('STALE', 'NPC State Delta is still finishing an earlier timed-out save; try again in a moment.');
        if ((!indexRepairs.size && !abortPendingHere()) || allowRepair) return null;
        // Do not wait for the repair inside the host's lock: its file request may itself need that lock to be released.
        queueRepair();
        return bookkeepingPending();
    };
    /** Passes the host callback's deadline to its load wait, starting when the host asks (the queue wait counts). */
    const bounded = fn => input => {
        const earlier = earlierSnapshot();
        if (earlier) return Promise.resolve(earlier);
        const until = deadline();
        return exclusive(() => fn(input, until));
    };

    // A checkpoint also needs to answer while an earlier callback, a durable write, or a vault request is stuck. Keep that work in the
    // exclusive queue until it really settles; an expired checkpoint must not start later or continue to hand the host a late snapshot.
    const boundedCheckpoint = fn => input => {
        const earlier = earlierSnapshot();
        if (earlier) return Promise.resolve(earlier);
        const until = deadline();
        let expired = false;
        const ticket = {};
        let phase = 'waiting for earlier participant work';
        const failure = () => fail('STALE', `NPC State Delta could not save in time while ${phase}; save again in a moment.`);
        const check = () => {
            if (!expired && now() < until) return;
            expired = true;
            const error = new Error(failure().message);
            error[SNAPSHOT_EXPIRED] = true;
            throw error;
        };
        let timer;
        const timeout = new Promise(resolve => {
            timer = schedule(() => { expired = true; unfinishedSnapshots.add(ticket); resolve(failure()); }, Math.max(0, until - now()));
        });
        const guard = { until, check, enter: next => { check(); phase = next; }, wait: promise => Promise.race([promise, timeout]) };
        const run = exclusive(async () => { check(); return fn(input, guard); });
        run.then(() => unfinishedSnapshots.delete(ticket), () => unfinishedSnapshots.delete(ticket));
        return Promise.race([run, timeout]).finally(() => cancel(timer));
    };

    /** Runs `fn` after every earlier callback is done; a thrown error is a FAILED answer, never a crash of the queue. */
    const exclusive = fn => {
        const run = queue.then(async () => {
            try {
                for (const [lineage, repair] of indexRepairs) {
                    try { await vault.putIndex(lineage, repair()); }
                    catch { return fail('STALE', 'NPC State Delta is still restoring the participant index after a failed save; try again in a moment.'); }
                    if (indexRepairs.get(lineage) === repair) indexRepairs.delete(lineage);
                }
                for (const [id, pending] of pendingAborts) {
                    if (pending.key !== keyNow()) continue;
                    const answer = await abortPrepared(pending.input);
                    if (!answer.ok && answer.code !== 'REFUSED') return answer;
                    if (pendingAborts.get(id) === pending) pendingAborts.delete(id);
                }
                return await fn();
            } catch (error) {
                if (error?.[SNAPSHOT_EXPIRED]) return fail('STALE', error.message);
                return fail('FAILED', `${module} failed: ${error?.message ?? error}`);
            }
        });
        queue = run;
        return run;
    };

    function queueRepair() {
        if (repairQueued) return;
        repairQueued = true;
        void exclusive(async () => ({ ok: true })).finally(() => { repairQueued = false; });
    }
    function repairLateIndex(lineage) {
        if (!writtenIndexes.has(lineage)) return;
        if (!indexRepairs.has(lineage)) indexRepairs.set(lineage, () => writtenIndexes.get(lineage));
        queueRepair();
    }

    // A timed-out snapshot may still need the host's lock. Abort and status must also get a pending repair processed: the host does not
    // retry abort. If that repair needs the host's lock, release it on time and leave the actual callback queued behind the repair.
    const hostExclusive = (fn, allowRepair = false) => {
        const earlier = earlierSnapshot(allowRepair);
        if (earlier) return Promise.resolve(earlier);
        const repairing = allowRepair && (indexRepairs.size > 0 || abortPendingHere());
        const key = keyNow();
        const run = exclusive(() => allowRepair && keyNow() !== key
            ? fail('STALE', 'Another chat was opened before the participant callback could finish.') : fn());
        if (!repairing) return run;
        let timer;
        const timeout = new Promise(resolve => {
            timer = schedule(() => resolve(bookkeepingPending()), boundMs);
        });
        return Promise.race([run, timeout]).finally(() => cancel(timer));
    };

    /** `exclusive` for a native change's `prepare`: a failure is thrown, so the host tells the reason (it reads a failure envelope as a malformed answer). */
    const preparing = fn => hostExclusive(fn).then(out => {
        if (out?.ok === false) throw new Error(out.message);
        return out;
    });

    const save = () => vault.putIndex(session.lineage, session.index);

    async function restoreIndex(s) {
        try { await vault.putIndex(s.lineage, s.index); }
        catch (error) {
            indexRepairs.set(s.lineage, () => s.index);
            warn(`NPC State Delta could not restore the participant index after a failed save: ${error?.message ?? error}`);
        }
    }

    async function abortPrepared(input) {
        const s = await hydrate();
        if (!s) return { ok: true, aborted: true };
        const idx = s.index;
        const entry = isRecord(input) ? idx.prepared[input.prepared] : null;
        if (!entry) return { ok: true, aborted: true };
        const ret = idx.returns[input.return];
        if (ret?.status === 'active') return fail('REFUSED', 'That return was committed; it finishes, it is not aborted.');
        if (ret) idx.returns[input.return] = { ...ret, status: 'aborted' };
        delete idx.prepared[input.prepared];
        try { await save(); }
        catch (error) {
            if (ret) idx.returns[input.return] = ret;
            idx.prepared[input.prepared] = entry;
            await restoreIndex(s);
            throw error;
        }
        return { ok: true, aborted: true };
    }

    function abort(input) {
        const key = keyNow();
        return hostExclusive(() => abortPrepared(input), true).then(answer => {
            // The host discards abort failures. Retain valid cleanup work after a blocked snapshot/repair or failed write and run it in
            // the participant queue, with the original chat's ownership, before any subsequent participant operation in that chat.
            if (['STALE', 'FAILED'].includes(answer?.code) && isRecord(input)
                && typeof input.return === 'string' && typeof input.prepared === 'string' && usable(key)) {
                const id = JSON.stringify([key, input.return, input.prepared]);
                pendingAborts.set(id, { key, input: { return: input.return, prepared: input.prepared } });
                queueRepair();
            }
            return answer;
        });
    }

    const sessionOps = createSessionOps({
        port, vault, now, random, idleMs, keyNow, usable, loaded, restoreIndex, writtenIndexes,
        getSession: () => session,
        setSession: value => { session = value; },
    });
    const { hydrate, made, verified, verifyOnly, started, busy: scanBusy, stands, standsOnBytes, hand, quiet } = sessionOps;
    const busy = scanBusy;
    const publication = createPublication({
        cancel, exclusive, getAnnounced: () => announced, getHandle: () => handle,
        hydrate, made, module, port, preparedAt, preparing, retryMs, save, schedule, started, verified, warn, keyNow,
    });
    const { participant } = createParticipantHandlers({
        abort, bounded, boundedCheckpoint, busy, confirmedDeath, getAnnounced: () => announced, getHandle: () => handle,
        getLast: publication.getLast, hand, hostExclusive, hydrate, made, now, port, preparedAt, quiet, restoreIndex, save,
        schedulePublish: publication.schedulePublish, setHandle: value => { handle = value; }, stands, standsOnBytes, verified, verifyOnly, vault,
    });
    const { nativeChange, schedulePublish, flush, getLast } = publication;
    // The history replay (history-replay.js): Story Block's `restored` (a fallback installed an earlier checkpoint), the resume on chat open, the
    // rebuild and Skip. The one publication after an install is the ordinary one (a change announced, then published at once).
    const catchUp = createCatchUp({
        chatKey: keyNow, enabled: () => port.enabled?.() !== false && typeof port.live === 'function', live: () => port.live(), changed: () => port.changed?.(), warn, settled: () => port.settled?.(),
        publish: async () => { announced += 1; if (handle && started()) { schedulePublish(0); await flush(); } },
    });
    const api = {
        module,
        participant: Object.freeze({
            ...participant,
            restored: () => catchUp.restored(),
            // "Start from the chat": answers at once ({ ok, started }) while the replies are read; Story Block follows progress() and asks skip().
            rebuild: options => catchUp.rebuild(options),
            // The catch-up banner's synchronous read: { active, done, total, older, from, reason, outcome, message }.
            progress: () => catchUp.status(),
            skip: async () => ({ ok: true, ...(await catchUp.skip()) }),
        }),
        catchUp,
        /**
         * The query the host resolves a death's npc with and Story Director a check's target with. It reads the chat's state, where the ids
         * are, so it answers at once after a reload; a dossier with no np_ yet (a scan, an import) is hydrated behind it, never inside it.
         */
        queries: {
            /** The catch-up banner: { active, done, total, older, from, reason } (+ outcome and message once it ended). */
            'npc.catchUp': () => catchUp.status(),
            'npc.identity': (_state, args) => {
                const key = keyNow();
                if (!usable(key)) return null;
                const state = port.readState();
                const block = timelineOf(state);
                const npcs = state?.npcs;
                const unsettled = Array.isArray(npcs) && npcs.some(npc => typeof npc?.id === 'string' && !Object.hasOwn(block.identity.byKey, npc.id));
                if (unsettled && !hydrating) {
                    hydrating = true;
                    void exclusive(async () => { try { await hydrate(); } finally { hydrating = false; } });
                }
                return resolveIdentity(block.identity, npcs, args);
            },
        },
        /** Hydrates the open chat now, making its line if it has none. */
        hydrate: () => exclusive(async () => { const s = await hydrate(); return s ? { ok: true, npcs: Object.keys(timelineOf(port.readState()).identity.byKey).length, lineage: s.lineage } : fail('FAILED', 'There is no open chat.'); }),
        /** Runs `fn` in the exclusive queue every checkpoint write takes (the Storage clean-up checks and deletes inside it). */
        exclusive,
        nativeChange,
        /** Delta's state was written durably by something other than the participant: publish it as a native change (debounced). */
        noteChange: () => {
            announced += 1;
            // A publication being finished (prepared, not yet activated) is older than this change: say so in its index entry, which is saved, so a
            // restart that finds the publication in the host's journal does not take the newer live state for a lost write.
            if (session && preparedAt.size) {
                let marked = false;
                for (const id of preparedAt.keys()) {
                    const entry = session.index.prepared[id];
                    if (entry && !entry.newer) { entry.newer = true; marked = true; }
                }
                if (marked) void exclusive(async () => { await save(); return { ok: true }; });
            }
            if (handle && started()) schedulePublish(debounceMs);
        },
        /** Publishes now what is pending and resolves with the answer (tests; and a chat closing). */
        flush,
        lastPublish: getLast,
        identity: () => timelineOf(port.readState()).identity,
        timeline: () => timelineOf(port.readState()),
        index: () => (session ? plain(session.index) : null),
    };
    return api;
}
