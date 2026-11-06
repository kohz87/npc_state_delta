// The timeline coordinator (contract §8; docs/v2/TIMELINE.md): save points, the restore protocol and the native
// participants' mutations, behind one host-local object, `sdk.timeline`.
//
// Everything that waits (a participant's checkpoint, a flush to the chat file) is a phase between two synchronous
// sections; each section changes the story (a block stored) and the journal (in the chat's metadata) together, so a
// crash between two phases leaves a state the next start reads whole: `recover()` finishes what was committed and
// aborts what was not. The journal is the only thing that decides.
//
//   make:     reserved -> checkpointed -> archived -> committed            (or discarded: the head moved; aborted: a crash)
//   restore:  preparing -> prepared -> committed -> acked -> complete      (or aborted before committed)
//   native:   prepared -> done                                             (or aborted before activation)
//
// Authority. Public callers (a button, a screen, a module through sdk.timeline) may make (a manual save), forget, list,
// read the status, the head and the history. Everything else (prepare, activate, abort, recover, nativeEvent,
// registerParticipant, a make of another kind) needs the host capability, an object only createTimeline's caller holds,
// or, for nativeMutation, the handle the host gave the participant when it registered it.

import { createActiveHistory } from './active.js';
import { createArchive } from './archive.js';
import { createBlock } from './coordinator-block.js';
import { createNative } from './coordinator-native.js';
import { createPrepare } from './coordinator-prepare.js';
import { createRead } from './coordinator-read.js';
import { createRestore } from './coordinator-restore.js';
import { HOST_DOMAIN } from './gate.js';
import { createParticipants } from './participants.js';
import { crashing, fail, isNotDurable, isObject, isStaleChat, makeId, notDurable, staleChat } from './util.js';

export { MANUAL_LIMIT } from './coordinator-prepare.js';
// The phases a journal entry ends in, by kind; any other is work to recover.
const ENDS = Object.freeze({ make: ['committed', 'discarded', 'aborted'], restore: ['complete', 'aborted', 'retracted'], 'native-mutation': ['done', 'aborted'], 'native-event': ['done', 'aborted'], selection: ['complete'] });
const settled = entry => (ENDS[entry.kind] ?? []).includes(entry.phase);

/**
 * createTimeline({ store, registry, metadata, chat?, barrier, announce?, query?, settings?, faults? }) →
 * { api, host, capability, attach(def), guard(view, info), available(hash), recover, makeCommand(payload), archive }.
 * * `metadata()`: the open chat's metadata object (the archive lives in it); `chat()`: its messages;
 * * `barrier(state, reason)`: raises or drops the host-wide restore barrier (registry.setRestore and the announcement);
 * * `announce(receipt)`: told of each block the host stores (the `committed` event);
 * * `query(name, args, state)`: a registered query over `state` (the clock, the atlas, the journal), or throws when there is none;
 * * `problem(entry)`: told of a Problem the host reader should see (faded messages that could not be hidden); `redraw(index, message)`: told when a
 *   message's hidden flag changed, so the page can draw it;
 * * `faults`: `{ at(phase) }`, awaited at every phase boundary (tests simulate a crash by throwing `crash()` there).
 */
export function createTimeline({ store, registry, metadata, chat = () => [], barrier = () => {}, announce = null, query = null, settings = () => ({}), faults = null, problem = null, redraw = null }) {
    // The timeline's state: one object, so the parts of the timeline can share it (`s.name`).
    const s = {
        // The chat the running operation began in (operations run one at a time): every write and every clean-up of it is bound to that
        // chat, and when another one is open it touches nothing there (`staleChat`, answered STALE).
        scope: null,
        capability: Object.freeze({ timeline: 'story-block' }),
        handles: new Map(),
        broken: new Map(),  // module -> why its participant declaration was not registered
        sessionId: null,
        busy: Promise.resolve(),
        running: new Map(),
        // In-memory state belongs to one chat. A block stored and not yet told is owed to the listeners once the chat file has it, and
        // carries the chat and the receipt it was stored with; the barrier this raised carries the chat it was raised for. On a change of
        // chat what belongs to another is dropped (`settle`), and before anything is told the chat and the receipt are looked at again.
        owed: [],  // [{ stored, holder, id }]
        barrierOwner: null,  // the chat whose restore or native change raised the barrier (null: not raised by the timeline)
        barrierEarly: false,  // raised by `settle` as the chat opened, before its recovery had its turn (not by a running operation)
        hideFailed: new WeakSet(),  // chats (by their holder) where a faded message could not be hidden or shown
        witnessHashes: new WeakMap(),
        block: null,  // the open chat's participant wait or failure (session only)
        retryTimer: null,  // the timer of the next try of a transient block (session only)
    };
    const archive = createArchive({ metadata, touch: () => store.touch?.(), bound: () => s.scope?.holder ?? null });
    const participants = createParticipants({ chat: () => archive.holder() });
    // (this run's id, made when first needed: a chat that never uses the timeline draws nothing from the random source)
    const session = () => (s.sessionId ??= makeId('ss'));
    // Operations started and not ended, by the chat they were made for: they own that chat's journal entries. A chat's work is its own.
    const runningIn = holder => s.running.get(holder) ?? 0;
    const bump = (holder, by) => { if (runningIn(holder) + by > 0) s.running.set(holder, runningIn(holder) + by); else s.running.delete(holder); };

    // ---- helpers -----------------------------------------------------------------------------------------

    // One thing at a time: a make, a prepare, an activate or a recover starts when the one before it has ended.
    // Work carries its chat from the moment it is made (`holder`, taken when it is queued, not when its turn comes): if another chat is
    // open when its turn comes, it is STALE and does not run. The queue is one line for the whole host, so two chats' work never
    // overlaps, but nothing in it is anonymous.
    const scoped = async (fn, holder) => {
        settle();
        if (archive.holder() !== holder) return fail('STALE', 'Another chat was opened before this was done; nothing was changed in the chat that is open now.');
        s.scope = { holder };
        try {
            const out = await fn();
            await reconcile();
            return out;
        } finally { s.scope = null; }
    };
    const exclusive = fn => {
        settle();
        const holder = archive.holder();
        bump(holder, 1);
        const run = s.busy.then(() => scoped(fn, holder), () => scoped(fn, holder));
        s.busy = run.then(() => {}, () => {});
        run.then(() => bump(holder, -1), () => bump(holder, -1));
        return run;
    };
    // Recovery requested by a send, module setup or a retry timer shares the same work for this chat.
    // An explicit host recovery keeps its own turn: the host may have fixed the cause since an earlier try started.
    const recovering = new Map();
    const recoverOnce = () => {
        const holder = archive.holder();
        if (recovering.has(holder)) return recovering.get(holder);
        const run = exclusive(() => guarded(() => recover()));
        recovering.set(holder, run);
        const clear = () => { if (recovering.get(holder) === run) recovering.delete(holder); };
        run.then(clear, clear);
        return run;
    };
    const guarded = async fn => {
        try { return await fn(); } catch (error) {
            if (crashing(error)) throw error;
            if (isNotDurable(error)) return fail('FAILED', error.message);
            if (isStaleChat(error)) {
                // The chat this began in is gone: what it owes is not told, and a barrier it raised does not hold the chat that is open.
                settle();
                return fail('STALE', error.message);
            }
            return fail('FAILED', `The timeline failed: ${error?.message ?? error}`);
        }
    };
    // Whatever waits (a phase boundary, a participant's answer) ends by looking at the chat again: the code after it reads and writes the
    // chat the operation began in, or does not run.
    const point = async phase => {
        if (faults && typeof faults.at === 'function') await faults.at(phase);
        here();
    };
    const callParticipant = async (module, name, input) => {
        const answer = await participants.call(module, name, input);
        here();
        return answer;
    };
    const stillHere = () => s.scope === null || archive.holder() === s.scope.holder;
    const here = () => { if (!stillHere()) throw staleChat(); };
    // The one way anything is made durable: the chat file has what the journal and the story say, or this throws (the caller's
    // failure; nothing after it runs, nothing is retried as if it had worked, nothing is announced). The blocks the host stored
    // are told only now, once the file has them. `context` opens the sentence the caller is given when the save fails.
    const durable = async (context = 'The chat could not be saved') => {
        here();
        try { await store.flush(); } catch (error) {
            if (crashing(error)) throw error;
            here();   // (a save that failed because the chat was left is the chat's change, not a failed save)
            throw notDurable(`${context}: ${error?.message ?? error}`);
        }
        here();
        // Told now, and only what is still this chat's and still in it (a reply deleted meanwhile took its receipt with it).
        const told = s.owed;
        s.owed = [];
        if (told.length) {
            const holder = archive.holder();
            let ids = null;
            try { ids = new Set(store.receipts().map(entry => entry.receipt.id)); } catch { ids = new Set(); }
            for (const each of told) if (each.holder === holder && ids.has(each.id)) each.stored.tell();
        }
    };
    // A clean-up after a failure that is not itself a durable step: the journal word it writes rides with the next save (a
    // restart reads the unsettled entry and does the same), so a save that fails here changes nothing about what is answered.
    const quietly = async fn => {
        try { await fn(); } catch (error) {
            if (crashing(error) || isStaleChat(error)) throw error;
            if (!isNotDurable(error)) throw error;
        }
    };
    const owe = stored => { s.owed.push({ stored, holder: archive.holder(), id: stored.receipt.id }); return stored; };
    // The host's restore barrier, raised or dropped only for the chat the operation is in, and remembered as that chat's.
    const raise = reason => { here(); s.barrierOwner = archive.holder(); s.barrierEarly = false; barrier('pending', reason); };
    const isHost = auth => auth === s.capability || auth?.capability === s.capability;
    // A change that is outstanding: a restore committed and not complete, a native change prepared and not done (`ignore`: the one being settled).
    const pendingEntry = (ignore = null) => archive.entries().find(entry => entry.id !== ignore && entry.kind === 'restore' && ['committed', 'participants-pending', 'acked'].includes(entry.phase))
        ?? archive.entries().find(entry => entry.id !== ignore && entry.kind === 'selection' && entry.phase !== 'complete')
        ?? archive.entries().find(entry => entry.id !== ignore && ['native-mutation', 'native-event'].includes(entry.kind) && entry.phase === 'prepared')
        ?? null;
    const pendingNow = () => {
        settle();
        return registry.restore?.().state === 'pending' || pendingEntry() !== null;
    };
    // A module that declared a participant the host could not register holds the timeline: a save or a restore without it would
    // leave its native state out of step with the story (fail closed).
    const brokenProblem = () => {
        const [module, why] = [...s.broken.entries()][0] ?? [];
        return module ? `the participant ${module} could not be registered (${why}), so its native state cannot be saved or restored` : '';
    };
    const pointsOf = state => (isObject(state?.domains?.[HOST_DOMAIN]?.points) ? state.domains[HOST_DOMAIN].points : {});

    // The clock, the scene and the journal day a descriptor shows.
    const ask = (name, args, state) => {
        if (typeof query !== 'function') return null;
        try { return query(name, args, state) ?? null; } catch { return null; }
    };
    // Story Block's own readers of earlier messages (the chatter queries, the module view, the late lines) ask this
    // (src/v2/timeline/active.js), by name; the capability counts the names. A generation request is not one of them: faded messages
    // leave it because they are hidden (below).
    const activeHistory = createActiveHistory({ faded: () => activeLine().at });

    // The native half (coordinator-native.js), wired first of the halves: it needs `headNow`, `head`, `release`, `availability`, `makeNow` and
    // `unmaterializedMarkers` from the halves wired after it, and gets each as a function that reads it when it is called (none runs before the last wiring).
    // The blocked selection (coordinator-block.js): classifies a participant's failure, retries a transient one on a timer, tells a permanent one.
    const block = createBlock(s, { archive, registry, problem, raise, again: recoverOnce });
    const { selectionPlan, withWholePrefixes, nativeSelectionProblem, selectionNeeded, selectHead, finishSelection, prefixKey, publishRestore, finishNative, pin, nativeEvent, register, attach, guard, contract, makeCommand } = createNative(s, { store, registry, activeHistory, archive, ask, block, availability: modules => availability(modules), brokenProblem, callParticipant, durable, exclusive, guarded, head: () => head(), headNow: () => headNow(), here, makeNow: (input, options) => makeNow(input, options), participants, pendingNow, point, pointsOf, raise, release: id => release(id), session, stillHere, unmaterializedMarkers: () => unmaterializedMarkers() });
    // The reading half (coordinator-read.js), wired once everything it calls is defined (the native half, above, is the last it needs).
    const { settle, release, reconcile, minuteOf, sceneOf, headNow, head, listNow, list, status, activeLine, syncHidden, history } = createRead(s, { block, store, registry, chat, barrier, problem, redraw, archive, participants, durable, here, ask, pointsOf, pendingEntry, pendingNow, raise, nativeSelectionProblem, selectionNeeded, selectHead, withWholePrefixes });
    // The making and preparing half (coordinator-prepare.js), wired once everything it calls is defined: `headNow`, `minuteOf` and `sceneOf` are the
    // reading half's (just above). `complete` is the restoring half's, wired next; `finish` calls it only when it runs, so it is given as a function.
    const { makeNow, forget, availability, abortEntry, prepare, finish } = createPrepare(s, { store, registry, settings, announce, archive, participants, ask, block, brokenProblem, callParticipant, complete: entry => complete(entry), durable, headNow, here, minuteOf, owe, pendingNow, point, pointsOf, quietly, sceneOf, selectionPlan, session, stillHere });
    // The restoring half (coordinator-restore.js), wired after the making and preparing half it calls.
    const { complete, activate, abort, recover, unmaterializedMarkers } = createRestore(s, { store, registry, announce, problem, archive, participants, block, abortEntry, availability, durable, finish, finishNative, finishSelection, headNow, here, makeNow, owe, pendingEntry, pendingNow, point, pointsOf, publishRestore, raise, release, selectionNeeded, session, stillHere, syncHidden, withWholePrefixes });

    // ---- the API -----------------------------------------------------------------------------------------------

    const needsHost = (auth, what) => (isHost(auth) ? null : fail('REFUSED', `${what} needs the host's authority; a caller cannot supply it.`));
    const strip = result => {
        if (!result.ok) return result;
        const { receipt, ...rest } = result;
        void receipt;
        return rest;
    };

    const api = {
        head: () => head(),
        make: (input, auth) => exclusive(() => guarded(async () => strip(await makeNow(input, { host: isHost(auth), cause: isHost(auth) ? 'system' : 'ui' })))),
        list: () => list(),
        status: () => status(),
        history: input => history(input),
        forget: input => exclusive(() => guarded(() => forget(input))),
        registerParticipant: async (spec, auth) => needsHost(auth, 'registerParticipant') ?? register(spec),
        prepare: async (input, auth) => needsHost(auth, 'prepare') ?? exclusive(() => guarded(() => prepare(input))),
        activate: async (input, auth) => needsHost(auth, 'activate') ?? exclusive(() => guarded(() => activate(input))),
        abort: async (input, auth) => needsHost(auth, 'abort') ?? exclusive(() => guarded(() => abort(input))),
        recover: async (input, auth) => needsHost(auth, 'recover')
            ?? (isObject(input) && Object.keys(input).length === 0 ? exclusive(() => guarded(() => recover())) : fail('INVALID', 'recover takes {}.')),
        nativeEvent: async (input, auth) => needsHost(auth, 'nativeEvent') ?? exclusive(() => guarded(() => nativeEvent(input))),
        nativeMutation: async () => fail('REFUSED', 'Only the registered participant makes native mutations, through the handle the host gave it when it registered.'),
    };
    // The same, with the host's authority already given (what the runtime and its host code use).
    const host = Object.freeze({
        make: input => api.make(input, s.capability),
        registerParticipant: spec => api.registerParticipant(spec, s.capability),
        prepare: input => api.prepare(input, s.capability),
        activate: input => api.activate(input, s.capability),
        abort: input => api.abort(input, s.capability),
        recover: () => api.recover({}, s.capability),
        nativeEvent: input => api.nativeEvent(input, s.capability),
        pin,
        /** The journal's entries, oldest first (read only). */
        journal: () => structuredClone(archive.entries()),
        /** The participant prefix map entry for a participant and the cursor and prefix hash of a head, or null. */
        prefix: (participant, cursor, prefixHash) => structuredClone(archive.prefix(participant, prefixKey(cursor, prefixHash))),
        participants: () => participants.modules(),
    });

    return Object.freeze({
        api: Object.freeze(api),
        host,
        capability: s.capability,
        attach,
        guard,
        makeCommand,
        recover: recoverOnce,
        /** A chat was opened: what belongs to the one before it is dropped (the host calls it before it recovers). */
        settle,
        available: hash => archive.hasPayload(hash),
        /** Internal turn hint: unchanged roots must keep Sources once native checkpoints depend on their prefixes. */
        hasNativeChanges: () => archive.entries().some(entry => ['native-event', 'native-mutation'].includes(entry.kind)),
        /** Whether the journal holds work no operation owns (a crashed make, a restore left half way): the host recovers it. */
        needsRecovery: () => runningIn(archive.holder()) === 0 && ((archive.exists() && (archive.entries().some(entry => !settled(entry)) || selectionNeeded())) || unmaterializedMarkers().length > 0
            || (s.barrierOwner !== null && s.barrierOwner === archive.holder())),
        archive,
        /** The active-history reader one of Story Block's own readers of earlier messages asks for by name (active.js ACTIVE_READERS): → { messages, faded }. */
        active: name => activeHistory.reader(name),
        pending: pendingNow,
        /** Points of `state` with their bytes checked, in target order (the savepoint.list query). */
        points: state => listNow(state),
        contract,
    });
}
