// NPC State Delta as a timeline participant (Story Block docs/v2/TIMELINE.md, contract §8; track B6): the module has native state beside
// the story (dossiers with their evidence, the relationship map, its own rollback history), so a save point and a restore must take its
// checkpoint with them, and a character's confirmed death must reach it.
//
//   checkpoint({ cursor, headHash })            -> { checkpoint, hash, schema }    the native state (with its np_ map and applied deaths), once Delta is quiet
//   prepare({ return, checkpoint, hash })       -> { prepared, hash }              verifies the bytes; shows nothing
//   activate({ return, prepared })              -> { checkpoint, hash }            installs state, map and deaths together; idempotent
//   abort({ return, prepared })                 -> { aborted: true }               before the commit only
//   status({ return })                          -> { checkpoint, hash, status }
//   applyEvent({ event, nativeKey, kind })      -> { event, checkpoint, hash, ack }  a confirmed death, once per event
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
//   restored()           told after a restore installed a state (optional)
//   warn(text)           where problems are told (optional)
//   ready()              whether Delta has loaded the open chat's state (optional; without it the state is taken as loaded)
//   load()               loads the open chat's state when it is not loaded yet (asynchronous, optional)
//   normalize(state)     the state as Delta keeps it once installed (its own normalization; synchronous, optional)
//   branchPending()      whether the open chat is a branch still waiting for its parent's dossiers (optional)
//   inheritBranch()      runs Delta's branch inheritance for the open chat now (asynchronous, optional)
// `vault` keeps the bytes (vault.js). The np_ map, the reserved ids and the applied deaths live in the chat's state (timeline.js), the restores
// in flight and the acknowledged deaths in the vault's index of the state's lineage.

import { PARTICIPANT_SCHEMA, buildCheckpoint, checkpointProblem } from './checkpoint.js';
import { hydrateIdentity, resolveIdentity } from './identity.js';
import { hashJson } from './hash.js';
import { LINEAGE_ID, mintLineage, restoredState, storedTimeline, timelineOf } from './timeline.js';
import { isTerminalNpcDeath } from '../../terminal-lifecycle.js';
import { cleanIndex, confirmedDeath, fail, isRecord, plain, preparedId } from './participant-helpers.js';
import { createParticipantCallbacks } from './participant-callbacks.js';
import { createParticipantPublication } from './participant-publication.js';

export { confirmedDeath };

export const MODULE_ID = 'npc-state-delta';
const SNAPSHOT_EXPIRED = Symbol('snapshot-expired');

export function createParticipant({ port, vault, module = MODULE_ID, now = () => Date.now(), random, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), debounceMs = 300, retryMs = 1500, idleMs = 8000, boundMs = 8000, pollMs = 50 }) {
    let session = null;      // { key, lineage, index }
    let handle = null;
    let queue = Promise.resolve();
    let hydrating = false;
    let indexRepair = null;  // { lineage, index }: an unconfirmed baseline write must be restored before further participant work
    let repairQueued = false;
    const unfinishedSnapshots = new Set(); // timed-out calls remain here until their queued work actually ends
    const handed = new Map();   // checkpoint id -> { hash, stateHash }: what the participant handed the host, for `current`
    let announced = 0;          // changes announced to the participant (noteChange), in this run
    const preparedAt = new Map();   // prepared id of an in-place publication -> `announced` when it was prepared (this run only)
    const warn = text => { try { port.warn?.(text); } catch { /* telling is best effort */ } };
    const keyNow = () => String(port.chatKey() ?? '');
    const usable = key => Boolean(key) && key !== 'no-chat';
    const readyNow = () => { try { return port.ready() === true; } catch { return false; } };
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
    const earlierSnapshot = () => {
        if (unfinishedSnapshots.size) return fail('STALE', 'NPC State Delta is still finishing an earlier timed-out save; try again in a moment.');
        if (!indexRepair) return null;
        // Do not wait for the repair inside the host's lock: its file request may itself need that lock to be released.
        if (!repairQueued) {
            repairQueued = true;
            void exclusive(async () => ({ ok: true })).finally(() => { repairQueued = false; });
        }
        return fail('STALE', 'NPC State Delta is still restoring the participant index after a failed save; try again in a moment.');
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
        const guard = { until, check, enter: next => { check(); phase = next; } };
        let timer;
        const timeout = new Promise(resolve => {
            timer = schedule(() => { expired = true; unfinishedSnapshots.add(ticket); resolve(failure()); }, Math.max(0, until - now()));
        });
        const run = exclusive(async () => { check(); return fn(input, guard); });
        run.then(() => unfinishedSnapshots.delete(ticket), () => unfinishedSnapshots.delete(ticket));
        return Promise.race([run, timeout]).finally(() => cancel(timer));
    };

    /** Runs `fn` after every earlier callback is done; a thrown error is a FAILED answer, never a crash of the queue. */
    const exclusive = fn => {
        const run = queue.then(async () => {
            try {
                if (indexRepair) {
                    const repair = indexRepair;
                    try { await vault.putIndex(repair.lineage, repair.index); }
                    catch { return fail('STALE', 'NPC State Delta is still restoring the participant index after a failed save; try again in a moment.'); }
                    if (indexRepair === repair) indexRepair = null;
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

    // The host may ask another callback while a timed-out snapshot still needs its lock. Refuse until the old work ends, never wait for it
    // while holding that same host lock. Background work stays queued so its own durable bookkeeping is not dropped.
    const hostExclusive = fn => {
        const earlier = earlierSnapshot();
        return earlier ? Promise.resolve(earlier) : exclusive(fn);
    };

    /** `exclusive` for a native change's `prepare`: a failure is thrown, so the host tells the reason (it reads a failure envelope as a malformed answer). */
    const preparing = fn => hostExclusive(fn).then(out => {
        if (out?.ok === false) throw new Error(out.message);
        return out;
    });

    const save = () => vault.putIndex(session.lineage, session.index);

    /**
     * Brings the open chat's state up to date: it has a lineage, every dossier has its np_ and a dossier that is gone has its np_ archived;
     * written into the state (durably) when it changed. The chat is looked at again after every await: a chat that changed meanwhile ends it.
     * Only a chat that uses the timeline gets here: a save point, a restore, a death, a published change of a chat that has its line already, or a
     * question to `npc.identity`. Opening a chat, a reply, or a scan writes nothing (`started`).
     * → the session { key, lineage, index } or null (no chat, or it changed).
     */
    async function hydrate(until = null, guard = null) {
        const key = keyNow();
        if (!usable(key)) return null;
        // Nothing is read, minted or written before the chat's state is loaded: a retryable failure (the host asks again later).
        guard?.enter('loading the dossiers');
        if (!await loaded(until)) {
            guard?.check();
            if (keyNow() !== key) return null;
            throw new Error('NPC State Delta has not loaded this chat\'s dossiers yet; it is tried again in a moment.');
        }
        guard?.check();
        if (keyNow() !== key) return null;
        let state = port.readState();
        let block = timelineOf(state);
        // A branch waiting for its parent's dossiers gets them (and the parent's line) from Delta's branch inheritance: a line minted here first
        // would be written into the branch's file and the inheritance would never come (the branch's dossiers empty, its parent's checkpoints refused).
        if (!block.lineage && port.branchPending?.() === true) {
            guard?.enter('inheriting the parent dossiers');
            try { await port.inheritBranch?.(); } catch { /* looked at below */ }
            guard?.check();
            if (keyNow() !== key) return null;
            if (port.branchPending?.() === true) throw new Error('NPC State Delta is still carrying the parent chat\'s dossiers into this branch; it is tried again in a moment.');
            state = port.readState();
            block = timelineOf(state);
        }
        let write = false;
        if (!block.lineage) {
            block.lineage = mintLineage(random);
            write = true;
        }
        // The open chat's line changed under the participant (another copy of the state was adopted): the line it knew stays this chat's.
        if (session?.key === key && session.lineage !== block.lineage && !block.former.includes(session.lineage)) {
            block.former = [...block.former, session.lineage];
            write = true;
        }
        const out = hydrateIdentity(block.identity, state?.npcs, { seed: block.lineage, reserved: block.reserved });
        if (out.changed || out.reserved.length !== block.reserved.length) write = true;
        block.identity = out.identity;
        block.reserved = out.reserved;
        if (write) {
            const was = hashJson(state);
            guard?.enter('saving the story-line identity');
            await port.writeTimeline(storedTimeline(block));
            if (keyNow() !== key) return null;
            // The participant's own write is not a change of the story's: a baseline that was the state before it is the state after it.
            if (session?.index.base?.stateHash === was) session.index.base.stateHash = hashJson(port.readState());
            guard?.check();
        }
        if (!session || session.key !== key || session.lineage !== block.lineage) {
            guard?.enter('reading the participant index');
            const index = cleanIndex(await vault.getIndex(block.lineage));
            guard?.check();
            if (keyNow() !== key) return null;
            session = { key, lineage: block.lineage, index };
        }
        if (!session.index.base) {
            guard?.enter('building the baseline checkpoint');
            const built = buildCheckpoint({ lineage: block.lineage, state: port.readState() });
            guard?.enter('saving the baseline checkpoint');
            await vault.put(built.id, built.doc);
            guard?.check();
            if (keyNow() !== key) return null;
            const base = { checkpoint: built.id, hash: built.hash, stateHash: hashJson(port.readState()) };
            guard?.enter('saving the participant index');
            await vault.putIndex(session.lineage, { ...session.index, base });
            session.index.base = base;
            guard?.check();
        }
        return session;
    }

    async function made({ state = port.readState(), cursor = null, headHash = null }, guard = null) {
        const s = session ?? await hydrate();
        if (!s) throw new Error('There is no open chat to take a checkpoint of.');
        guard?.enter('building the native checkpoint');
        const built = buildCheckpoint({ lineage: s.lineage, state, cursor, headHash });
        guard?.enter('saving the native checkpoint');
        await vault.put(built.id, built.doc);
        guard?.check();
        return built;
    }

    /** The checkpoint `id` from the vault, checked against `hash`: { doc } or a failure. */
    async function verified(id, hash) {
        const doc = await vault.get(id);
        if (!doc) return fail('SNAPSHOT_UNAVAILABLE', `The native checkpoint ${id} is gone, so its dossiers cannot be put back.`);
        const problem = checkpointProblem(doc, doc?.kind ? hashJson(doc) : '');
        if (problem && /newer|not a native|missing|plain/.test(problem)) return fail('SNAPSHOT_UNAVAILABLE', problem);
        if (hashJson(doc) !== hash) return fail('CONFLICT', `The native checkpoint ${id} is not the one that was saved (another hash).`);
        if (doc.lineage !== session?.lineage && !await formerLine(doc)) return fail('CONFLICT', `The native checkpoint ${id} belongs to another story line.`);
        return { ok: true, doc };
    }

    /**
     * Whether `doc` is a checkpoint of an earlier story line of this same chat. Before NSD 1.7.1 a reload's recovery could read the chat's state
     * before Delta had loaded it and mint a new line over the chat's own (hydrate waits for the load now); the chat's journal still names
     * checkpoints of the line it had, and refusing them held the chat for good on a swipe, a delete or a branch back past that point. Such a line
     * is accepted, and only such a line: one the chat records as its former line (`timeline.former`), or a well-formed line this participant kept
     * an index for whose checkpoint belongs to the chat's own family (`branchFamilyId`, a random id per chat and its branches). A checkpoint of
     * another chat (another family), or a line nobody kept (forged), is still another story line. Installing it records the line (restoredState).
     */
    async function formerLine(doc) {
        const lineage = doc?.lineage;
        if (typeof lineage !== 'string' || !LINEAGE_ID.test(lineage)) return false;
        const live = port.readState();
        if (timelineOf(live).former.includes(lineage)) return true;
        const family = typeof live?.branchFamilyId === 'string' ? live.branchFamilyId.trim() : '';
        if (!family || doc.state?.branchFamilyId !== family) return false;
        try { return Boolean(await vault.getIndex(lineage)); } catch { return false; }
    }

    /**
     * Whether the open chat uses the timeline: it has its story line (the state carries a lineage, made by the first save point, restore, death
     * or `npc.identity` question) or this run has made it. A chat that never did is left exactly as Delta alone keeps it: nothing is hydrated,
     * written or published for it, so a populated chat that never asks for the timeline stays byte for byte what it was.
     */
    const started = () => {
        if (session && session.key === keyNow()) return true;
        try { if (typeof port.started === 'function') return port.started() === true; } catch { return false; }
        return Boolean(timelineOf(port.readState()).lineage);
    };
    const busy = () => (typeof port.busy === 'function' ? port.busy() === true : false);
    /** Whether the native state is, now, the one this checkpoint was handed over (or installed) as: the part of the host's commit probe that reads the state. */
    const stands = (checkpoint, hash) => {
        const held = handed.get(checkpoint);
        return Boolean(held) && held.hash === hash && hashJson(port.readState()) === held.stateHash;
    };
    /** Whether the live state is what installing this checkpoint's document leaves (its state with the timeline block's reserved ids of both timelines). */
    const standsOnBytes = doc => {
        const live = port.readState();
        const wanted = restoredState(doc.state, live);
        if (hashJson(wanted) === hashJson(live)) return true;
        // Delta normalizes a state as it installs it (a milestone's missing turn becomes 0, ...), and a checkpoint made in the run that wrote a
        // record may hold it as written: compared raw, such a checkpoint never "stands" once installed, and its activation is refused for good.
        // The bytes are compared as Delta keeps them too.
        if (typeof port.normalize !== 'function') return false;
        try { return hashJson(port.normalize(wanted)) === hashJson(live); } catch { return false; }
    };
    const hand = (checkpoint, hash, stateHash) => {
        handed.set(checkpoint, { hash, stateHash });
        while (handed.size > 16) handed.delete(handed.keys().next().value);
    };
    // Ends inside the host's bound for the callback (`until`): longer than that, the host gives up on the call and calls the save a failure.
    const quiet = async until => (typeof port.idle === 'function' ? (await port.idle(Math.max(0, Math.min(idleMs, until - now())))) !== false : true);

    const publication = createParticipantPublication({
        PARTICIPANT_SCHEMA, fail, isRecord, plain, hashJson, hydrate, verified, made, warn, getHandle: () => handle, preparing, port, timelineOf, hydrateIdentity,
        storedTimeline, preparedId, save, module, started, keyNow, exclusive, getAnnounced: () => announced, preparedAt, schedule, cancel, retryMs,
    });
    const { nativeChange, schedulePublish, flush, lastPublish } = publication;

    const participant = createParticipantCallbacks({
        PARTICIPANT_SCHEMA, fail, isRecord, plain, hashJson, verified, hydrate, made, busy, stands, standsOnBytes, hand, save,
        vault, warn, port, timelineOf, restoredState, isTerminalNpcDeath, confirmedDeath, storedTimeline, now,
        boundedCheckpoint, bounded, hostExclusive, quiet, preparedId, preparedAt, schedulePublish,
        getLast: () => publication.lastPublish(), getHandle: () => handle, setHandle: given => { handle = given; },
        setIndexRepair: repair => { indexRepair = repair; }, getAnnounced: () => announced,
    });


    return {
        module,
        participant,
        /**
         * The query the host resolves a death's npc with and Story Director a check's target with. It reads the chat's state, where the ids
         * are, so it answers at once after a reload; a dossier with no np_ yet (a scan, an import) is hydrated behind it, never inside it.
         */
        queries: {
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
        lastPublish,
        identity: () => timelineOf(port.readState()).identity,
        timeline: () => timelineOf(port.readState()),
        index: () => (session ? plain(session.index) : null),
    };
}
