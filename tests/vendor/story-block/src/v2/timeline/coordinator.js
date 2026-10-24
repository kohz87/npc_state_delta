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

import { deriveId, hashJson, isHash, isPlainJson, isRecordId, sourceProblem } from '../replay.js';
import { cutAt } from '../../text.js';
import { createArchive } from './archive.js';
import { GENESIS_EPOCH, HOST_DOMAIN, epochOf } from './gate.js';
import { appendHostBlock, stateHash } from './host-block.js';
import { capture, initialSavepoints, planRestore, previousDayOf } from './manifest.js';
import { createParticipants } from './participants.js';
import { crashing, fail, isNotDurable, isObject, isStaleChat, makeId, notDurable, staleChat } from './util.js';

export const MANUAL_LIMIT = 10;
const MINUTES_PER_DAY = 1440;
const KINDS = Object.freeze(['initial', 'manual', 'day-start']);
// The phases a journal entry ends in, by kind; any other is work to recover.
const ENDS = Object.freeze({ make: ['committed', 'discarded', 'aborted'], restore: ['complete', 'aborted', 'retracted'], 'native-mutation': ['done', 'aborted'], 'native-event': ['done', 'aborted'] });
const settled = entry => (ENDS[entry.kind] ?? []).includes(entry.phase);
const NAME_MAX = 80;

const textProblem = (value, max) => {
    if (typeof value !== 'string') return 'is not text';
    if (/[\u0000-\u001f\u007f]/.test(value)) return 'has a control character';
    if (value !== value.trim() || !value) return 'is empty or has a space at either end';
    if ([...value].length > max) return `is longer than ${max} characters`;
    return '';
};

const ordered = (a, b) => (a.target.rev - b.target.rev) || (a.target.op - b.target.op) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * createTimeline({ store, registry, metadata, chat?, barrier, announce?, query?, settings?, faults? }) →
 * { api, host, capability, attach(def), guard(view, info), available(hash), recover, makeCommand(payload), archive }.
 * * `metadata()`: the open chat's metadata object (the archive lives in it); `chat()`: its messages;
 * * `barrier(state, reason)`: raises or drops the host-wide restore barrier (registry.setRestore and the announcement);
 * * `announce(receipt)`: told of each block the host stores (the `committed` event);
 * * `query(name, args, state)`: a registered query over `state` (the clock, the atlas, the journal), or throws when there is none;
 * * `faults`: `{ at(phase) }`, awaited at every phase boundary (tests simulate a crash by throwing `crash()` there).
 */
export function createTimeline({ store, registry, metadata, chat = () => [], barrier = () => {}, announce = null, query = null, settings = () => ({}), faults = null }) {
    // The chat the running operation began in (operations run one at a time): every write and every clean-up of it is bound to that
    // chat, and when another one is open it touches nothing there (`staleChat`, answered STALE).
    let scope = null;
    const archive = createArchive({ metadata, touch: () => store.touch?.(), bound: () => scope?.holder ?? null });
    const participants = createParticipants();
    const capability = Object.freeze({ timeline: 'story-block' });
    const handles = new Map();
    const broken = new Map();   // module -> why its participant declaration was not registered
    // (this run's id, made when first needed: a chat that never uses the timeline draws nothing from the random source)
    let sessionId = null;
    const session = () => (sessionId ??= makeId('ss'));
    let busy = Promise.resolve();
    // Operations started and not ended, by the chat they were made for: they own that chat's journal entries. A chat's work is its own.
    const running = new Map();
    const runningIn = holder => running.get(holder) ?? 0;
    const bump = (holder, by) => { if (runningIn(holder) + by > 0) running.set(holder, runningIn(holder) + by); else running.delete(holder); };
    // In-memory state belongs to one chat. A block stored and not yet told is owed to the listeners once the chat file has it, and
    // carries the chat and the receipt it was stored with; the barrier this raised carries the chat it was raised for. On a change of
    // chat what belongs to another is dropped (`settle`), and before anything is told the chat and the receipt are looked at again.
    let owed = [];     // [{ stored, holder, id }]
    let barrierOwner = null;   // the chat whose restore or native change raised the barrier (null: not raised by the timeline)
    let barrierEarly = false;  // raised by `settle` as the chat opened, before its recovery had its turn (not by a running operation)

    // ---- helpers -----------------------------------------------------------------------------------------

    // One thing at a time: a make, a prepare, an activate or a recover starts when the one before it has ended.
    // Work carries its chat from the moment it is made (`holder`, taken when it is queued, not when its turn comes): if another chat is
    // open when its turn comes, it is STALE and does not run. The queue is one line for the whole host, so two chats' work never
    // overlaps, but nothing in it is anonymous.
    const scoped = async (fn, holder) => {
        settle();
        if (archive.holder() !== holder) return fail('STALE', 'Another chat was opened before this was done; nothing was changed in the chat that is open now.');
        scope = { holder };
        try { return await fn(); } finally { scope = null; }
    };
    const exclusive = fn => {
        const holder = archive.holder();
        bump(holder, 1);
        const run = busy.then(() => scoped(fn, holder), () => scoped(fn, holder));
        busy = run.then(() => {}, () => {});
        run.then(() => bump(holder, -1), () => bump(holder, -1));
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
    const stillHere = () => scope === null || archive.holder() === scope.holder;
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
        const told = owed;
        owed = [];
        if (told.length) {
            const holder = archive.holder();
            let ids = null;
            try { ids = new Set(store.receipts().map(entry => entry.receipt.id)); } catch { ids = new Set(); }
            for (const each of told) if (each.holder === holder && ids.has(each.id)) each.stored.tell();
        }
    };
    // What belongs to a chat that is not the open one is dropped: announcements owed, and a barrier raised for it (its own journal
    // keeps what it was doing, and its `recover` raises the barrier again when that chat is opened).
    function settle() {
        const holder = archive.holder();
        owed = owed.filter(each => each.holder === holder);
        if (barrierOwner !== null && barrierOwner !== holder) {
            barrierOwner = null;
            barrierEarly = false;
            barrier('idle', '');
        }
        // A chat whose journal has work unfinished is barred from the moment it is open; its recovery follows when the queue gives it
        // its turn (a make of another chat may be holding the line meanwhile).
        if (holder && barrierOwner === null && pendingEntry() !== null) {
            barrierOwner = holder;
            barrierEarly = true;
            barrier('pending', 'A restore is finishing; every part must agree before the story goes on.');
        }
    }
    // A clean-up after a failure that is not itself a durable step: the journal word it writes rides with the next save (a
    // restart reads the unsettled entry and does the same), so a save that fails here changes nothing about what is answered.
    const quietly = async fn => {
        try { await fn(); } catch (error) {
            if (crashing(error) || isStaleChat(error)) throw error;
            if (!isNotDurable(error)) throw error;
        }
    };
    const owe = stored => { owed.push({ stored, holder: archive.holder(), id: stored.receipt.id }); return stored; };
    // The host's restore barrier, raised or dropped only for the chat the operation is in, and remembered as that chat's.
    const raise = reason => { here(); barrierOwner = archive.holder(); barrierEarly = false; barrier('pending', reason); };
    const lower = () => { here(); barrierOwner = null; barrierEarly = false; barrier('idle', ''); };
    const isHost = auth => auth === capability || auth?.capability === capability;
    const pendingEntry = () => archive.entries().find(entry => entry.kind === 'restore' && ['committed', 'participants-pending', 'acked'].includes(entry.phase))
        ?? archive.entries().find(entry => ['native-mutation', 'native-event'].includes(entry.kind) && entry.phase === 'prepared')
        ?? null;
    const pendingNow = () => {
        settle();
        return registry.restore?.().state === 'pending' || pendingEntry() !== null;
    };
    // A module that declared a participant the host could not register holds the timeline: a save or a restore without it would
    // leave its native state out of step with the story (fail closed).
    const brokenProblem = () => {
        const [module, why] = [...broken.entries()][0] ?? [];
        return module ? `the participant ${module} could not be registered (${why}), so its native state cannot be saved or restored` : '';
    };
    const pointsOf = state => (isObject(state?.domains?.[HOST_DOMAIN]?.points) ? state.domains[HOST_DOMAIN].points : {});

    // The clock, the scene and the journal day a descriptor shows.
    const ask = (name, args, state) => {
        if (typeof query !== 'function') return null;
        try { return query(name, args, state) ?? null; } catch { return null; }
    };
    function minuteOf(state) {
        const time = ask('director.time', {}, state);
        const minutes = isObject(time) ? time.minutes : time;
        if (Number.isInteger(minutes)) return minutes;
        const own = state?.domains?.director?.time;
        const value = isObject(own) ? own.minutes : own;
        return Number.isInteger(value) ? value : null;
    }
    function sceneOf(state) {
        const scene = state?.domains?.scene;
        const name = typeof scene?.place?.name === 'string' ? scene.place.name.trim() : '';
        const present = Array.isArray(scene?.present) ? scene.present.map(person => (isObject(person) ? person.name : person)).filter(item => typeof item === 'string' && item.trim()) : [];
        const text = [name ? `At ${name}.` : '', present.length ? `With ${present.join(', ')}.` : ''].filter(Boolean).join(' ');
        const canonical = ask('atlas.canonical', {}, state);
        const place = isObject(canonical) && typeof canonical.id === 'string' && canonical.id ? canonical.id : null;
        return { place, text: cutAt(text, 240) };
    }

    // ---- the head ------------------------------------------------------------------------------------------

    // The committed head: the state, where the story ends, and one hash that changes whenever any of it does (the story's
    // prefix, the rev, the epoch, the native mutations that were published). Native mutations and makes check against it.
    function headNow() {
        const state = store.head();
        if (!state) return null;
        const boundary = store.boundary();
        if (!boundary) return null;
        const epoch = epochOf(state);
        const headHash = hashJson({ v: 1, prefix: boundary.prefixHash, rev: boundary.cursor.rev, epoch, native: archive.nativeSeq() });
        return { state, boundary, cursor: boundary.cursor, prefixHash: boundary.prefixHash, epoch, headHash };
    }

    async function head() {
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress; the head is not settled until every part agrees.');
        const now = headNow();
        if (!now) return fail('NOT_FOUND', 'This chat has no story state yet.');
        return { ok: true, headHash: now.headHash, cursor: structuredClone(now.cursor), epoch: now.epoch, prefixHash: now.prefixHash };
    }

    // ---- list, status, history ---------------------------------------------------------------------------

    // The eligible points of the head state, in target order, with their bytes checked now.
    function listNow(state) {
        return Object.values(pointsOf(state)).filter(isObject).map(point => ({ ...structuredClone(point), available: archive.hasPayload(point.payloadHash) })).sort(ordered);
    }
    async function list() {
        const state = store.head();
        return { ok: true, points: state ? listNow(state) : [] };
    }

    async function status() {
        const entries = archive.entries();
        const damaged = entries.some(entry => !['make', 'restore', 'native-mutation', 'native-event'].includes(entry.kind));
        const pending = pendingEntry();
        const state = damaged ? 'failed' : pending || registry.restore?.().state === 'pending' ? 'pending' : 'idle';
        const out = [];
        for (const module of participants.modules()) {
            const latest = archive.prefixes(module).at(-1);
            const selected = latest?.[latest.selected];
            if (selected) out.push({ module, checkpoint: selected.checkpoint, hash: selected.hash, schema: selected.schema });
        }
        return { ok: true, state, return: pending?.kind === 'restore' ? pending.return : null, participants: out };
    }

    // A projection of the chat's messages for the readers of the story (prompt, extraction, native scans): the canonical
    // ids of each message and whether it is on the active line. A message with no carrier record of its own (the reader's
    // own) gets a projection-only msg_ id worked out from where it stands. The faded interval of a return, (target, restore],
    // is carrier-wide here: the replies after the target's reply through the restoring one, and the reader's messages between.
    // The exclusion of the reply a target falls inside of, and the head-selection barrier, are the next package's.
    async function history(input = {}) {
        if (!isObject(input) || Object.keys(input).some(key => key !== 'through')) return fail('INVALID', 'history takes { through? }.');
        const through = input.through;
        if (through !== undefined && (!isObject(through) || !isRecordId(through.sid))) return fail('INVALID', 'through is a cursor.');
        const state = store.head();
        const messages = typeof chat === 'function' ? chat() : [];
        const sids = messages.map((message, at) => (message?.is_user ? null : store.sourceAt(at)));
        const cut = through === undefined ? messages.length - 1 : sids.findIndex(source => source?.sid === through.sid);
        if (cut < 0) return fail('NOT_FOUND', 'No message of this chat has that cursor.');
        const returns = Object.values(isObject(state?.domains?.[HOST_DOMAIN]?.returns) ? state.domains[HOST_DOMAIN].returns : {}).filter(isObject);
        const faded = returns.map(item => item.faded).filter(item => isObject(item?.after) && isObject(item?.through))
            .map(item => ({ after: structuredClone(item.after), through: structuredClone(item.through) }));
        const spans = faded.map(item => ({ from: sids.findIndex(source => source?.sid === item.after.sid), to: sids.findIndex(source => source?.sid === item.through.sid) }))
            .filter(span => span.from >= 0 && span.to >= span.from);
        const out = [];
        for (let at = 0; at <= cut && at < messages.length; at++) {
            const message = messages[at];
            const source = sids[at];
            const ids = source ?? (() => {
                const id = deriveId('msg', hashJson({ lineage: archive.lineage(), at, name: message?.name ?? '', date: message?.send_date ?? '', mes: message?.mes ?? '' }));
                return { sid: id, swipeKey: id };
            })();
            out.push({ sid: ids.sid, swipeKey: ids.swipeKey, text: String(message?.mes ?? ''), active: !spans.some(span => at > span.from && at <= span.to) });
        }
        return { ok: true, messages: out, faded };
    }

    // ---- make --------------------------------------------------------------------------------------------------

    function makeInput(input, host) {
        if (!isObject(input)) return fail('INVALID', 'make takes { kind, name?, target?, day? }.');
        for (const key of Object.keys(input)) if (!['kind', 'name', 'target', 'day'].includes(key)) return fail('INVALID', `make does not take "${key}".`);
        if (!KINDS.includes(input.kind)) return fail('INVALID', `A save point is one of ${KINDS.join(', ')}, not "${input.kind}".`);
        if (input.name !== undefined) {
            const why = textProblem(input.name, NAME_MAX);
            if (why) return fail('INVALID', `The name ${why}.`);
        }
        if (input.kind === 'day-start') {
            if (!Number.isSafeInteger(input.day)) return fail('INVALID', 'A day start names its day (a whole number).');
        } else if (input.day !== undefined) return fail('INVALID', 'Only a day start names a day.');
        if (input.target !== undefined && (!isObject(input.target) || !isRecordId(input.target.sid) || !isRecordId(input.target.swipeKey) || !Number.isInteger(input.target.op) || !Number.isInteger(input.target.rev))) {
            return fail('INVALID', 'target is a cursor.');
        }
        if (input.kind !== 'manual' && !host) return fail('REFUSED', 'Only the host makes an initial or a day-start save point; a reader\'s save is a manual one.');
        return { ok: true };
    }

    // One save point: reserve it, ask the participants for their checkpoints, put the bytes in the archive, then, only
    // if the story has not moved, store the descriptor and its receipt together. → { ok: true, snapshot, receipt } | failure.
    async function makeNow(input, { host, cause }) {
        const bad = makeInput(input, host);
        if (!bad.ok) return bad;
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress; a save point cannot be made until every part agrees.');
        const unregistered = brokenProblem();
        if (unregistered) return fail('SNAPSHOT_UNAVAILABLE', `A save point cannot be made: ${unregistered}.`);
        const first = headNow();
        if (!first) return fail('NOT_FOUND', 'There is no story state to save yet.');
        if (!archive.holder()) return fail('FAILED', 'This chat has no metadata to keep the save in.');
        if (input.target !== undefined) {
            const t = input.target;
            if (t.sid !== first.cursor.sid || t.swipeKey !== first.cursor.swipeKey || t.op !== first.cursor.op || t.rev !== first.cursor.rev) {
                return fail('STALE', 'The story has moved on from that cursor; a save point is made at the head.');
            }
        }
        const points = pointsOf(first.state);
        const kinds = Object.values(points).filter(isObject);
        if (input.kind === 'manual' && kinds.filter(item => item.kind === 'manual').length >= MANUAL_LIMIT) {
            return fail('LIMITED', `This story keeps ${MANUAL_LIMIT} manual save points, the most there are; forget one first.`);
        }
        if (input.kind === 'initial' && kinds.some(item => item.kind === 'initial')) return fail('CONFLICT', 'This story has its initial save point already.');
        const dayKey = input.kind === 'day-start' ? String(input.day) : null;
        if (dayKey !== null && isObject(first.state.domains?.[HOST_DOMAIN]?.dayStarts) && Object.hasOwn(first.state.domains[HOST_DOMAIN].dayStarts, dayKey)) {
            return fail('CONFLICT', `Day ${input.day} has its start saved already.`);
        }

        // 1. reserve: the action is fixed here (what is saved, where, and the head it is made against).
        const id = makeId('sn');
        const blockId = makeId('bl');
        const name = input.name ?? (input.kind === 'initial' ? 'Start' : input.kind === 'day-start' ? `Day ${input.day}` : 'Save point');
        const journal = makeId('jr');
        const taken = capture({ registry, state: first.state, settings });
        archive.add({ id: journal, kind: 'make', phase: 'reserved', session: session(), snapshot: id, savekind: input.kind, expectedHead: first.headHash, block: blockId });
        await point('make.reserved');

        // 2. the participants' checkpoints, as of this head.
        const cursor = { ...structuredClone(first.cursor), block: blockId };
        const checkpoints = [];
        for (const module of participants.modules()) {
            const answer = await callParticipant(module, 'checkpoint', { cursor, headHash: first.headHash });
            if (!answer.ok) {
                archive.patch(journal, { phase: 'aborted', why: answer.message });
                return fail(answer.code === 'FAILED' ? 'SNAPSHOT_UNAVAILABLE' : answer.code, `The participant ${module} could not save its state: ${answer.message}`);
            }
            if (answer.schema !== participants.get(module).schema) {
                archive.patch(journal, { phase: 'aborted', why: 'a participant saved another schema than it registered' });
                return fail('SNAPSHOT_UNAVAILABLE', `The participant ${module} saved checkpoint schema ${answer.schema}, and registered ${participants.get(module).schema}.`);
            }
            checkpoints.push({ module, checkpoint: answer.checkpoint, hash: answer.hash, schema: answer.schema });
            await point(`make.checkpoint:${module}`);
        }
        taken.payload.participants = checkpoints.map(item => ({ ...item }));
        const payloadHash = hashJson({ payload: taken.payload, proofs: taken.proofs });
        archive.patch(journal, { phase: 'checkpointed', participants: checkpoints, payloadHash });
        await point('make.checkpointed');

        // 3. the bytes and the descriptor go into the archive, and are made durable before the story refers to them.
        const minute = input.kind === 'day-start' ? input.day * MINUTES_PER_DAY : minuteOf(first.state);
        const day = input.kind === 'day-start' ? input.day : Number.isInteger(minute) ? Math.floor(minute / MINUTES_PER_DAY) : null;
        const journalDay = day === null ? null : ask('journal.day', { day }, first.state);
        const descriptor = {
            capturedAtRev: first.cursor.rev, label: name, id, kind: input.kind, name, epoch: first.epoch,
            target: cursor, eligibleFrom: structuredClone(cursor), minute: Number.isInteger(minute) ? minute : null, day,
            scene: sceneOf(first.state), journal: isObject(journalDay) ? journalDay : null,
            payloadHash, participants: checkpoints, lineage: first.prefixHash, available: true,
        };
        archive.putPayload(payloadHash, { payload: taken.payload, proofs: taken.proofs });
        archive.putSnapshot(id, { descriptor, payloadHash });
        archive.patch(journal, { phase: 'archived' });
        try { await durable(); } catch (error) {
            await quietly(async () => archive.patch(journal, { phase: 'discarded', why: error.message }));
            throw error;
        }
        await point('make.archived');

        // 4. commit: in one section (nothing awaited from the look to the writes): the chat, the story and the participants are what
        // they were, and the save is stored with the journal's word. Else the descriptor is dropped and the bytes stay as a cache.
        here();
        const now = headNow();
        if (!now || now.headHash !== first.headHash) {
            archive.patch(journal, { phase: 'discarded', why: 'the story moved while the save was made' });
            return fail('STALE', 'The story moved while the save point was made; nothing was saved. Try again.');
        }
        const lacking = availability(checkpoints);
        if (lacking) {
            archive.patch(journal, { phase: 'discarded', why: lacking });
            return fail('SNAPSHOT_UNAVAILABLE', `A save point cannot be made: ${lacking}.`);
        }
        const domain = isObject(now.state.domains?.[HOST_DOMAIN]) ? now.state.domains[HOST_DOMAIN] : null;
        const ops = [];
        if (!domain) {
            const fresh = initialSavepoints(GENESIS_EPOCH);
            fresh.points[id] = descriptor;
            if (dayKey !== null) { fresh.dayStarts[dayKey] = id; fresh.previousDay = previousDayOf(fresh.dayStarts); }
            ops.push({ op: 'add', path: `/domains/${HOST_DOMAIN}`, value: fresh });
        } else {
            ops.push({ op: 'add', path: `/domains/${HOST_DOMAIN}/points/${id}`, value: descriptor });
            if (dayKey !== null) {
                ops.push({ op: 'add', path: `/domains/${HOST_DOMAIN}/dayStarts/${dayKey}`, value: id });
                const before = previousDayOf({ ...domain.dayStarts, [dayKey]: id });
                if (domain.previousDay !== before) ops.push({ op: 'replace', path: `/domains/${HOST_DOMAIN}/previousDay`, value: before });
            }
        }
        const stored = appendHostBlock({
            store, head: now, ops, announce, here: stillHere,
            spec: {
                type: 'savepoint.make', cause, summary: `Save point "${name}" made.`, key: `make:${id}`, blockId,
                predicate: { kind: 'make', snapshot: id, payloadHash }, payload: { kind: input.kind, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.kind === 'day-start' ? { day: input.day } : {}) },
                recorded: { payloadHash, participants: checkpoints }, result: { snapshot: id },
            },
        });
        if (!stored.ok) { archive.patch(journal, { phase: 'discarded', why: stored.message }); return stored; }
        owe(stored);
        archive.patch(journal, { phase: 'committed' });
        await point('make.committed');
        // Made only once the chat file has it: a failed save is the caller's failure (the save point stands in memory and the store tries again).
        await durable('The save point was made, but the chat could not be saved yet');
        return { ok: true, snapshot: structuredClone(descriptor), receipt: stored.receipt };
    }

    // ---- forget ------------------------------------------------------------------------------------------------

    async function forget(input, auth) {
        void auth;
        if (!isObject(input) || Object.keys(input).some(key => key !== 'snapshot') || typeof input.snapshot !== 'string') return fail('INVALID', 'forget takes { snapshot }.');
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress; a save point cannot be forgotten until every part agrees.');
        const now = headNow();
        if (!now) return fail('NOT_FOUND', 'There is no story state.');
        const found = pointsOf(now.state)[input.snapshot];
        if (!isObject(found)) return fail('NOT_FOUND', 'That save point is not on this story\'s line of history.');
        if (archive.entries().some(entry => entry.kind === 'restore' && entry.snapshot === found.id && ['preparing', 'prepared', 'committed', 'participants-pending', 'acked'].includes(entry.phase))) {
            return fail('REFUSED', 'That save point is the one a return is using; it cannot be forgotten yet.');
        }
        if (found.kind !== 'manual') return fail('REFUSED', 'Only a manual save point can be forgotten; the story\'s own anchors stay.');
        const ops = [{ op: 'remove', path: `/domains/${HOST_DOMAIN}/points/${found.id}` }];
        const stored = appendHostBlock({
            store, head: now, ops, announce, here: stillHere,
            spec: { type: 'savepoint.forget', cause: 'ui', summary: `Save point "${found.name}" forgotten.`, key: `forget:${found.id}`, blockId: makeId('bl'),
                predicate: { kind: 'forget', snapshot: found.id }, payload: { snapshot: found.id }, recorded: null, result: { forgotten: found.id } },
        });
        if (!stored.ok) return stored;
        owe(stored);
        await durable('The save point was forgotten, but the chat could not be saved yet');
        return { ok: true, forgotten: found.id };
    }

    // ---- prepare, activate, abort ------------------------------------------------------------------------

    function prepareInput(input) {
        if (!isObject(input)) return fail('INVALID', 'prepare takes { snapshot, deathEvents, batchResult, expectedHead }.');
        for (const key of Object.keys(input)) if (!['snapshot', 'deathEvents', 'batchResult', 'expectedHead'].includes(key)) return fail('INVALID', `prepare does not take "${key}".`);
        if (typeof input.snapshot !== 'string' || !input.snapshot) return fail('INVALID', 'prepare names the snapshot.');
        if (!Array.isArray(input.deathEvents) || !input.deathEvents.length || input.deathEvents.some(item => typeof item !== 'string' || !item) || new Set(input.deathEvents).size !== input.deathEvents.length) {
            return fail('INVALID', 'deathEvents is a list of different event ids, at least one.');
        }
        if (!isObject(input.batchResult) || !isRecordId(input.batchResult.id) || !isHash(input.batchResult.hash) || Object.keys(input.batchResult).length !== 2) return fail('INVALID', 'batchResult is { id, hash }.');
        if (!isHash(input.expectedHead)) return fail('INVALID', 'expectedHead is the head hash.');
        return { ok: true };
    }

    // The participants of the save must be the participants there are: each one it holds is registered at the schema it was
    // saved with, and none registered now is missing from it (its installed native state would have no bytes to go back to).
    function participantProblem(point) {
        const saved = Array.isArray(point.participants) ? point.participants : [];
        for (const item of saved) {
            const now = participants.get(item.module);
            if (!now) return `the participant ${item.module} is not registered, so its saved state cannot be restored`;
            if (now.schema !== item.schema) return `the participant ${item.module} reads checkpoint schema ${now.schema}, the save holds ${item.schema}`;
        }
        for (const module of participants.modules()) {
            if (!saved.some(item => item.module === module)) return `the participant ${module} has native state this save never held`;
        }
        return '';
    }

    // The participants as they are now against the ones an operation was made for (a make's checkpoints, a save's participants): looked
    // at again in the synchronous section right before the commit, since a module may register, or fail to, while the operation waited.
    function availability(expected) {
        return brokenProblem() || participantProblem({ participants: expected });
    }

    // The sealed result a restore is prepared for: the module that owns it resolves it (`batchResults.resolve({ id, state })` on its
    // definition, synchronous, pure: → null when the result is not its, else { id, hash, bytes }); the host checks the bytes against
    // the hash it was given and against the hash the owner gives, and pins the bytes. No resolver, no result, or bytes that do
    // not hash to it: the restore is not prepared.
    function resolveBatch(batch, state) {
        const owners = (registry.modules?.() ?? []).filter(def => isObject(def.batchResults) && typeof def.batchResults.resolve === 'function' && registry.held?.(def.id) !== true);
        if (!owners.length) return fail('DEPENDENCY_UNAVAILABLE', 'No module resolves sealed batch results, so the one this restore is for cannot be checked.');
        const found = [];
        for (const def of owners) {
            let answer = null;
            try { answer = def.batchResults.resolve({ id: batch.id, state }); } catch { answer = null; }
            if (answer && typeof answer.then === 'function') { answer.then(null, () => {}); answer = null; }
            if (answer !== null && answer !== undefined) found.push({ module: def.id, answer });
        }
        if (!found.length) return fail('NOT_FOUND', 'No module holds a sealed batch result with that id.');
        if (found.length > 1) return fail('CONFLICT', 'More than one module claims that sealed batch result.');
        const { module, answer } = found[0];
        if (!isObject(answer) || answer.id !== batch.id || !isHash(answer.hash) || answer.bytes === undefined || !isPlainJson(answer.bytes)) {
            return fail('CONFLICT', `${module} answered the sealed batch result with something that is not { id, hash, bytes }.`);
        }
        if (answer.hash !== batch.hash) return fail('CONFLICT', `The sealed batch result held by ${module} has another hash than the one given.`);
        if (hashJson(answer.bytes) !== answer.hash) return fail('CONFLICT', `The sealed batch result held by ${module} does not hash to its hash.`);
        return { ok: true, module, bytes: structuredClone(answer.bytes) };
    }

    async function abortParticipants(entry) {
        for (const [module, item] of Object.entries(entry.participants ?? {})) {
            if (!item.prepared || item.ack) continue;
            const answer = await callParticipant(module, 'abort', { return: entry.return, prepared: item.prepared });
            void answer;   // idempotent on its side; a failure leaves its precommit work for its own cleanup
        }
    }

    async function abortEntry(entry, why) {
        await abortParticipants(entry);
        archive.patch(entry.id, { phase: 'aborted', why });
        const pin = archive.pin(entry.batchResult.id);
        if (pin && pin.prepared === entry.id) archive.putPin(entry.batchResult.id, { ...pin, aborted: true });
        // (told as the failure that made it necessary, not as another: a save that fails here leaves an entry a restart aborts again)
        await quietly(() => durable());
    }
    // The preparation of a restore is dropped because the chat file would not take it: nothing durable is left to do.
    async function dropPrepared(preparedId, error) {
        await quietly(async () => {
            const entry = archive.get(preparedId);
            if (!entry) return;
            await abortParticipants(entry);
            archive.patch(preparedId, { phase: 'aborted', why: error.message });
            const pin = archive.pin(entry.batchResult.id);
            if (pin && pin.prepared === entry.id) archive.putPin(entry.batchResult.id, { ...pin, aborted: true });
        });
        throw error;
    }

    async function prepare(input) {
        const bad = prepareInput(input);
        if (!bad.ok) return bad;
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress.');
        const unregistered = brokenProblem();
        if (unregistered) return fail('SNAPSHOT_UNAVAILABLE', `A restore cannot be prepared: ${unregistered}.`);
        // An identical retry returns the original; the same batch with another meaning is a CONFLICT.
        const known = archive.entries().filter(entry => entry.kind === 'restore' && entry.batchResult?.id === input.batchResult.id && entry.phase !== 'aborted');
        const pinned = archive.pin(input.batchResult.id);
        if (pinned && pinned.hash !== input.batchResult.hash) return fail('CONFLICT', 'That batch result is pinned with another hash.');
        if (known.length) {
            const same = known.find(entry => entry.phase === 'prepared' && entry.snapshot === input.snapshot && entry.expectedHead === input.expectedHead
                && hashJson(entry.deathEvents) === hashJson(input.deathEvents) && entry.batchResult.hash === input.batchResult.hash);
            if (same) return { ok: true, prepared: same.id, return: same.return, manifestHash: same.manifestHash };
            return fail('CONFLICT', 'That batch result already has a return.');
        }
        const now = headNow();
        if (!now) return fail('NOT_FOUND', 'There is no story state.');
        if (now.headHash !== input.expectedHead) return fail('STALE', 'The story moved since the head was read; nothing was prepared.');
        const found = pointsOf(now.state)[input.snapshot];
        if (!isObject(found)) return fail('NOT_FOUND', 'That save point is not on this story\'s line of history.');
        const stored = archive.snapshot(found.id);
        const entry = archive.payload(found.payloadHash, { fresh: true });
        if (!stored || !isObject(stored.descriptor) || !entry) return fail('SNAPSHOT_UNAVAILABLE', 'The bytes of that save point are not in the archive.');
        if (hashJson(stored.descriptor) !== hashJson(found)) return fail('CONFLICT', 'The save point in the story is not the one that was archived.');
        const lacking = participantProblem(found);
        if (lacking) return fail('SNAPSHOT_UNAVAILABLE', `That save point cannot be restored: ${lacking}.`);
        const sealed = resolveBatch(input.batchResult, now.state);
        if (!sealed.ok) return sealed;

        const preparedId = makeId('pp');
        const returnId = makeId('rt');
        const newEpoch = makeId('ep');
        const blockId = makeId('bl');
        const record = {
            id: returnId, deathEvents: [...input.deathEvents], batchResult: { ...input.batchResult }, snapshot: found.id, target: structuredClone(found.target),
            restoreAt: { ...structuredClone(now.cursor), block: blockId }, oldEpoch: now.epoch, newEpoch,
            faded: { after: structuredClone(found.target), through: { ...structuredClone(now.cursor), block: blockId } },
            memory: 'deja-vu', cue: makeId('cu'), status: 'committed',
        };
        const plan = planRestore({ registry, state: now.state, entry, descriptor: stored.descriptor, returnRecord: record, newEpoch, deathEvents: input.deathEvents, batchResult: input.batchResult });
        if (!plan.ok) return plan;

        // The story as it is now (the dead timeline) is pinned beside the batch result: what the restore replaces stays retrievable.
        const pre = capture({ registry, state: now.state, settings });
        const preHash = hashJson({ payload: pre.payload, proofs: pre.proofs });
        archive.putPayload(preHash, { payload: pre.payload, proofs: pre.proofs });
        const slots = {};
        for (const item of found.participants) slots[item.module] = { checkpoint: item.checkpoint, hash: item.hash, schema: item.schema, prepared: null, preparedHash: null, ack: null };
        archive.add({
            id: preparedId, kind: 'restore', phase: 'preparing', session: session(), return: returnId, snapshot: found.id, deathEvents: [...input.deathEvents],
            batchResult: { ...input.batchResult }, expectedHead: now.headHash, newEpoch, block: blockId, cue: record.cue, payloadHash: found.payloadHash,
            manifest: plan.manifest, manifestHash: plan.manifestHash, participants: slots, pre: preHash,
        });
        archive.putPin(input.batchResult.id, { id: input.batchResult.id, hash: input.batchResult.hash, bytes: sealed.bytes, resolvedBy: sealed.module, return: returnId, prepared: preparedId, deathEvents: [...input.deathEvents], manifestHash: plan.manifestHash, preRestore: preHash, aborted: false });
        try { await durable(); } catch (error) { await dropPrepared(preparedId, error); }
        await point('prepare.journaled');

        // Each participant verifies its bytes without switching what the reader sees.
        for (const module of Object.keys(slots).sort()) {
            const answer = await callParticipant(module, 'prepare', { return: returnId, checkpoint: slots[module].checkpoint, hash: slots[module].hash });
            if (!answer.ok) {
                await abortEntry(archive.get(preparedId), answer.message);
                return fail(answer.code === 'FAILED' ? 'SNAPSHOT_UNAVAILABLE' : answer.code, `The participant ${module} could not prepare: ${answer.message}`);
            }
            if (answer.hash !== slots[module].hash) {
                await abortEntry(archive.get(preparedId), 'a participant prepared other bytes');
                return fail('CONFLICT', `The participant ${module} prepared other bytes than the save holds.`);
            }
            slots[module] = { ...slots[module], prepared: answer.prepared, preparedHash: answer.hash };
            archive.patch(preparedId, { participants: slots });
            // (what the participant holds is named in the chat file before the next one is asked, so an abort can find it)
            try { await durable(); } catch (error) { await dropPrepared(preparedId, error); }
            await point(`prepare.participant:${module}`);
        }
        here();
        const again = headNow();
        if (!again || again.headHash !== now.headHash) {
            await abortEntry(archive.get(preparedId), 'the story moved while the restore was prepared');
            return fail('STALE', 'The story moved while the restore was prepared; nothing was prepared.');
        }
        archive.patch(preparedId, { phase: 'prepared' });
        try { await durable(); } catch (error) { await dropPrepared(preparedId, error); }
        await point('prepare.prepared');
        return { ok: true, prepared: preparedId, return: returnId, manifestHash: plan.manifestHash };
    }

    // The participants of a committed restore switch, one at a time, each acknowledged in the journal as it answers. Nothing is
    // switched before the commit is in the chat file (a participant that switched while the story could still be lost would be
    // split from it for good). A failure leaves the barrier up and the restore waiting on its participants (`participants-pending`);
    // a retry or a restart carries on. A save that fails is the caller's failure, never a success.
    async function finish(entry) {
        const fresh = () => archive.get(entry.id);
        const hold = async why => {
            archive.patch(entry.id, { phase: 'participants-pending', why });
            await durable();
            return { ok: true, return: entry.return, status: 'participants-pending' };
        };
        await durable();
        for (const module of Object.keys(fresh().participants).sort()) {
            let slot = fresh().participants[module];
            if (slot.ack) continue;
            const registered = participants.get(module);
            if (!registered || registered.schema !== slot.schema) return hold(`the participant ${module} is not registered at the schema the save holds (${slot.schema})`);
            await point(`activate.participant:${module}:before`);
            // After a crash it may have switched already: its own status says so.
            let answer = null;
            const asked = await callParticipant(module, 'status', { return: entry.return });
            if (asked.ok && asked.status === 'active' && asked.hash === slot.hash && asked.checkpoint === slot.checkpoint) answer = asked;
            else if (asked.ok && asked.status === 'aborted') return hold(`the participant ${module} reports the restore aborted`);
            if (!answer) {
                const done = await callParticipant(module, 'activate', { return: entry.return, prepared: slot.prepared });
                if (!done.ok) return hold(done.message);
                answer = done;
            }
            // Exactly the checkpoint that was saved and prepared, by its id and by its hash.
            if (answer.checkpoint !== slot.checkpoint || answer.hash !== slot.hash) return hold(`the participant ${module} switched to another checkpoint than the save holds`);
            slot = { ...slot, ack: { checkpoint: answer.checkpoint, hash: answer.hash } };
            archive.patch(entry.id, { participants: { ...fresh().participants, [module]: slot }, phase: 'committed' });
            await durable();
            await point(`activate.participant:${module}:acked`);
        }
        archive.patch(entry.id, { phase: 'acked' });
        await durable();
        await point('activate.acked');
        return complete(entry);
    }

    // Every part agreed: the barrier drops, then the return is marked complete in the story (with the barrier down, so
    // every module's blocks are asked again and the block sees the story whole). Complete is told only once the chat file has it.
    async function complete(entry) {
        lower();
        const now = headNow();
        const returns = now?.state?.domains?.[HOST_DOMAIN]?.returns;
        const found = isObject(returns) ? returns[entry.return] : null;
        if (found?.status === 'committed') {
            const stored = appendHostBlock({
                store, announce, here: stillHere, head: now, ops: [{ op: 'replace', path: `/domains/${HOST_DOMAIN}/returns/${entry.return}/status`, value: 'complete' }],
                spec: { type: 'savepoint.complete', cause: 'system', summary: 'The return is complete.', key: `complete:${entry.return}`, blockId: makeId('bl'),
                    predicate: { kind: 'complete', return: entry.return }, payload: { return: entry.return }, recorded: null, result: { return: entry.return, status: 'complete' } },
            });
            if (!stored.ok) {
                // (the story cannot take the word yet: the restore waits, behind the barrier, for recover to try again)
                archive.patch(entry.id, { phase: 'acked', why: stored.message });
                raise('A restore is finishing; every part must agree before the story goes on.');
                return { ok: true, return: entry.return, status: 'participants-pending' };
            }
            owe(stored);
        }
        publishRestore(entry);
        archive.patch(entry.id, { phase: 'complete' });
        await durable();
        await point('activate.completed');
        return { ok: true, return: entry.return, status: 'complete' };
    }

    async function activate(input) {
        if (!isObject(input) || Object.keys(input).some(key => !['prepared', 'expectedHead'].includes(key)) || typeof input.prepared !== 'string' || !isHash(input.expectedHead)) {
            return fail('INVALID', 'activate takes { prepared, expectedHead }.');
        }
        const entry = archive.get(input.prepared);
        if (!entry || entry.kind !== 'restore') return fail('NOT_FOUND', 'There is no prepared restore with that token.');
        // Once: a restore that is committed or complete answers what it did; it is never run twice. It is told complete only
        // when the chat file has it.
        if (entry.phase === 'complete') {
            await durable();
            return { ok: true, return: entry.return, status: 'complete' };
        }
        if (['committed', 'participants-pending', 'acked'].includes(entry.phase)) {
            raise('A restore is finishing; every part must agree before the story goes on.');
            return finish(entry);
        }
        if (entry.phase !== 'prepared') return fail('REFUSED', 'That restore was aborted.');
        here();
        const now = headNow();
        if (input.expectedHead !== entry.expectedHead || !now || now.headHash !== entry.expectedHead) {
            await abortEntry(entry, 'the story moved before the restore was activated');
            return fail('STALE', 'The story moved since the restore was prepared; it was aborted.');
        }
        // Checked again, from the bytes: what is installed is what was prepared.
        const found = pointsOf(now.state)[entry.snapshot];
        const stored = archive.snapshot(entry.snapshot);
        const bytes = archive.payload(entry.payloadHash, { fresh: true });
        if (!isObject(found) || !stored || !bytes) {
            await abortEntry(entry, 'the bytes of the save are gone');
            return fail('SNAPSHOT_UNAVAILABLE', 'The bytes of that save point are not in the archive any more; the restore was aborted.');
        }
        const record = {
            id: entry.return, deathEvents: [...entry.deathEvents], batchResult: { ...entry.batchResult }, snapshot: entry.snapshot, target: structuredClone(found.target),
            restoreAt: { ...structuredClone(now.cursor), block: entry.block }, oldEpoch: now.epoch, newEpoch: entry.newEpoch,
            faded: { after: structuredClone(found.target), through: { ...structuredClone(now.cursor), block: entry.block } },
            memory: 'deja-vu', cue: entry.cue, status: 'committed',
        };
        const plan = planRestore({ registry, state: now.state, entry: bytes, descriptor: stored.descriptor, returnRecord: record, newEpoch: entry.newEpoch, deathEvents: entry.deathEvents, batchResult: entry.batchResult });
        if (!plan.ok) { await abortEntry(entry, plan.message); return plan; }
        if (plan.manifestHash !== entry.manifestHash) {
            await abortEntry(entry, 'the manifest is not the one that was prepared');
            return fail('CONFLICT', 'What would be installed is not what was prepared; the restore was aborted.');
        }
        await point('activate.checked');
        // Anything may have happened while that waited (the reader acts, a chat is opened). The head, its source and the chat are
        // looked at again, and the commit follows with nothing awaited between: one synchronous section.
        here();
        const last = headNow();
        if (!last || last.headHash !== entry.expectedHead) {
            await abortEntry(entry, 'the story moved while the restore was activated');
            return fail('STALE', 'The story moved while the restore was activated; it was aborted.');
        }
        // The participants too: one that failed to register, was registered, or changed its schema since the preparation holds the restore.
        const lacking = availability(Array.isArray(pointsOf(last.state)[entry.snapshot]?.participants) ? pointsOf(last.state)[entry.snapshot].participants : null)
            || Object.entries(entry.participants ?? {}).map(([module, slot]) => (participants.get(module)?.schema === slot.schema ? '' : `the participant ${module} is not registered at the schema the save holds`)).find(Boolean);
        if (lacking) {
            await abortEntry(entry, lacking);
            return fail('SNAPSHOT_UNAVAILABLE', `The restore cannot be activated: ${lacking}.`);
        }
        const stored2 = appendHostBlock({
            store, announce, here: stillHere, head: last, ops: plan.ops,
            spec: {
                type: 'savepoint.restore', cause: 'system', summary: `Restored to "${stored.descriptor.name}".`, key: `restore:${entry.return}`, blockId: entry.block,
                predicate: { kind: 'restore', return: entry.return, snapshot: entry.snapshot, payloadHash: entry.payloadHash, manifestHash: entry.manifestHash },
                payload: { snapshot: entry.snapshot, deathEvent: entry.deathEvents[0], prepared: entry.id }, recorded: { manifestHash: entry.manifestHash },
                result: { return: entry.return, status: 'committed' },
            },
        });
        if (!stored2.ok) { await abortEntry(entry, stored2.message); return stored2; }
        owe(stored2);
        archive.patch(entry.id, { phase: 'committed' });
        raise('A restore is finishing; every part must agree before the story goes on.');
        // Nothing is switched before the commit is in the chat file: a failed save is the caller's failure, and the barrier stays up.
        await durable();
        await point('activate.committed');
        return finish(archive.get(entry.id));
    }

    async function abort(input) {
        if (!isObject(input) || Object.keys(input).some(key => key !== 'prepared') || typeof input.prepared !== 'string') return fail('INVALID', 'abort takes { prepared }.');
        const entry = archive.get(input.prepared);
        if (!entry || entry.kind !== 'restore') return fail('NOT_FOUND', 'There is no prepared restore with that token.');
        if (entry.phase === 'aborted') return { ok: true, status: 'aborted' };
        if (entry.phase !== 'prepared' && entry.phase !== 'preparing') return fail('REFUSED', 'The restore is committed; it must finish, it cannot be aborted.');
        await abortEntry(entry, 'aborted by the host');
        return { ok: true, status: 'aborted' };
    }

    // ---- recover -----------------------------------------------------------------------------------------------

    // The story as it stands with the modules not held back, read in one synchronous step while commands stay barred: the barrier is
    // put back before anything else can run and nothing is announced, so no listener sees the host ready (or acts) on a story whose
    // native state has not caught up. Internal to recovery; nothing outside this file can ask it.
    function wholeStory() {
        const was = registry.restore();
        if (was.state !== 'pending') return store.head();
        registry.setRestore('idle', '');
        try {
            store.lifecycleChanged?.();   // (the guarded blocks are asked again with the modules not held: no 'modules' event, no 'head' event)
            return store.head();
        } finally {
            registry.setRestore(was.state, was.reason);
            store.lifecycleChanged?.();
        }
    }

    // Host startup: what was committed is finished, what was only prepared is aborted. No clock, no target is chosen again.
    async function recover() {
        if (!archive.exists()) return { ok: true, state: 'idle', return: null };
        const early = barrierEarly && barrierOwner === archive.holder();
        let ret = null;
        for (const entry of archive.entries()) {
            if (entry.kind === 'make') {
                if (['reserved', 'checkpointed', 'archived'].includes(entry.phase)) {
                    // Whether the story already holds the point (it was committed in the same section as the journal's word, so it cannot) is checked, not assumed.
                    const holds = isObject(pointsOf(store.head())[entry.snapshot]);
                    archive.patch(entry.id, { phase: holds ? 'committed' : 'aborted', ...(holds ? {} : { why: 'the process stopped before the save point was stored' }) });
                }
            } else if (entry.kind === 'restore') {
                if (entry.phase === 'preparing' || entry.phase === 'prepared') {
                    const now = headNow();
                    const mine = entry.session === session() && entry.phase === 'prepared' && now && now.headHash === entry.expectedHead;
                    if (!mine) await abortEntry(entry, 'a prepared restore that was never activated');
                } else if (['committed', 'participants-pending', 'acked'].includes(entry.phase)) {
                    // A start finds the story whole and asks whether it still holds the restore. Within a run that already has the
                    // barrier up it cannot ask: with the modules held, their guarded blocks are off and the story is not whole.
                    // (the barrier `settle` raised when this chat opened is not one of a run: the story is looked at whole, as it was before)
                    const state = early ? wholeStory() : store.head();
                    const there = state?.domains?.[HOST_DOMAIN]?.returns?.[entry.return];
                    if ((early || registry.restore?.().state !== 'pending') && !isObject(there)) {
                        // The story no longer holds the restore (its reply was swiped or deleted): its participants are the next package's.
                        archive.patch(entry.id, { phase: 'retracted', why: 'the story no longer holds the restore' });
                        continue;   // (the barrier comes down once, below, when nothing else is left to finish)
                    }
                    raise('A restore is finishing; every part must agree before the story goes on.');
                    const done = await finish(archive.get(entry.id));
                    if (done.ok === false) return done;
                    ret = entry.return;
                    if (done.status === 'complete') ret = null;
                }
            } else if (entry.kind === 'native-mutation' || entry.kind === 'native-event') {
                if (entry.phase === 'prepared') {
                    raise('A native change is finishing; every part must agree before the story goes on.');
                    const done = await finishNative(archive.get(entry.id));
                    if (done.ok === false && done.code !== 'CONFLICT') return done;
                }
            }
        }
        // (a barrier raised as this chat opened, for work that turned out to be nothing to finish, does not stay up)
        if (barrierOwner === archive.holder() && pendingEntry() === null) lower();
        await durable();
        const left = pendingEntry();
        return { ok: true, state: left ? 'pending' : 'idle', return: left?.kind === 'restore' ? left.return : ret };
    }

    // ---- native mutations and events ---------------------------------------------------------------------

    const prefixKey = (cursor, prefixHash) => [archive.lineage(), cursor.sid, cursor.swipeKey, cursor.block, cursor.op, prefixHash].join('|');

    function publish(entry) {
        const key = prefixKey(entry.boundary.cursor, entry.boundary.prefixHash);
        const seq = archive.bumpNative();
        archive.putPrefix(entry.participant, key, {
            seq, participant: entry.participant, tx: entry.id, source: entry.source ?? null, schema: entry.after.schema,
            before: entry.before, after: entry.after, selected: 'after',
        });
        archive.patch(entry.id, { phase: 'done' });
    }

    // After a restore every participant's selected checkpoint is the one it acknowledged, for the prefix the story now ends at.
    function publishRestore(entry) {
        const now = headNow();
        if (!now) return;
        const key = prefixKey(now.cursor, now.prefixHash);
        let moved = false;
        for (const [module, slot] of Object.entries(entry.participants ?? {})) {
            if (!slot.ack || archive.prefix(module, key)?.tx === entry.id) continue;
            archive.putPrefix(module, key, {
                seq: archive.bumpNative(), participant: module, tx: entry.id, source: null, schema: slot.schema, before: null,
                after: { module, checkpoint: slot.ack.checkpoint, hash: slot.ack.hash, schema: slot.schema }, selected: 'after',
            });
            moved = true;
        }
        void moved;
    }

    // The activation of a native entry, or its recovery after a crash: whatever the participant's own status says it did.
    // A mutation names the checkpoint it will switch to (`after`); an event learns it from the participant's ack.
    async function finishNative(entry) {
        const module = entry.participant;
        // The journal is in the chat file before the participant is asked to change anything: a change with no journal behind it
        // is one no restart could finish or undo (this is also what a retry after a failed save does first).
        await durable();
        const asked = await callParticipant(module, 'status', { return: entry.id });
        let answer = null;
        if (asked.ok && asked.status === 'active') answer = asked;
        else if (asked.ok && asked.status === 'aborted') {
            archive.patch(entry.id, { why: `the participant ${module} reports it aborted` });
            return fail('CONFLICT', `The participant ${module} aborted a change the journal committed; it is held until it is reconciled.`);
        }
        if (!answer) {
            const done = entry.kind === 'native-event'
                ? await callParticipant(module, 'applyEvent', { event: entry.event, nativeKey: entry.nativeKey, kind: entry.eventKind })
                : await callParticipant(module, 'activate', { return: entry.id, prepared: entry.preparedId });
            if (!done.ok) return done;
            if (entry.kind === 'native-event' && done.event !== entry.event) return fail('CONFLICT', 'The participant acknowledged another event.');
            answer = done;
        }
        let settled = entry;
        if (!entry.after) settled = archive.patch(entry.id, { after: { module, checkpoint: answer.checkpoint, hash: answer.hash, schema: entry.before.schema } });
        else if (answer.checkpoint !== entry.after.checkpoint || answer.hash !== entry.after.hash) {
            return fail('CONFLICT', `The participant ${module} answered other bytes than the change prepared.`);
        }
        publish(settled);
        lower();
        // Told done only when the file has it; a failed save is the caller's failure (a retry of the same event answers once it is saved).
        await durable();
        return { ok: true, checkpoint: settled.after.checkpoint, hash: settled.after.hash };
    }

    const participantShape = (item, module) => isObject(item) && item.module === module && typeof item.checkpoint === 'string' && item.checkpoint && isHash(item.hash) && Number.isInteger(item.schema) && item.schema >= 0;

    async function nativeMutation(input, who) {
        if (!isObject(input) || Object.keys(input).some(key => !['participant', 'source', 'expectedHead', 'prepare'].includes(key))) return fail('INVALID', 'nativeMutation takes { participant, source, expectedHead, prepare }.');
        if (typeof input.participant !== 'string' || input.participant !== who) return fail('REFUSED', 'Only the registered participant makes its own native mutations.');
        if (!participants.has(who)) return fail('NOT_FOUND', `The participant ${who} is not registered.`);
        const why = sourceProblem(input.source);
        if (why) return fail('INVALID', `source: ${why}.`);
        if (!isHash(input.expectedHead)) return fail('INVALID', 'expectedHead is the head hash.');
        if (typeof input.prepare !== 'function') return fail('INVALID', 'prepare is a function.');
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress.');
        const first = headNow();
        if (!first) return fail('NOT_FOUND', 'There is no story state.');
        if (first.headHash !== input.expectedHead) return fail('STALE', 'The head moved since it was read; the change was not made.');
        if (input.source.sid !== first.cursor.sid || input.source.swipeKey !== first.cursor.swipeKey) return fail('STALE', 'That source is not the reply at the head.');
        // The participant makes both checkpoints durable on its side and gives back what it made, without showing the new state.
        let made;
        try { made = await input.prepare(); } catch (error) {
            if (crashing(error)) throw error;
            return fail('FAILED', `The participant ${who} could not prepare its change: ${error?.message ?? error}`);
        }
        if (!isObject(made) || !participantShape(made.before, who) || !participantShape(made.after, who) || typeof made.prepared !== 'string' || !made.prepared) {
            return fail('INVALID', 'prepare gives { before, after, prepared }, both checkpoints whole.');
        }
        await point('native.prepared');
        const tx = makeId('nm');
        // The chat, the head and the participant are looked at again, and the journal follows with nothing awaited between.
        const same = stillHere();
        const again = same ? headNow() : null;
        const registered = participants.get(who);
        if (!same || !again || again.headHash !== first.headHash || !registered || registered.schema !== made.before.schema || registered.schema !== made.after.schema) {
            await callParticipant(who, 'abort', { return: tx, prepared: made.prepared });
            here();
            if (!registered || registered.schema !== made.before.schema || registered.schema !== made.after.schema) return fail('SNAPSHOT_UNAVAILABLE', `The participant ${who} is not registered at the schema of the change.`);
            return fail('STALE', 'The head moved while the change was prepared; it was cancelled before it was shown.');
        }
        archive.add({ id: tx, kind: 'native-mutation', phase: 'prepared', session: session(), participant: who, source: structuredClone(input.source), expectedHead: first.headHash,
            before: structuredClone(made.before), after: structuredClone(made.after), preparedId: made.prepared, boundary: { cursor: structuredClone(first.cursor), prefixHash: first.prefixHash } });
        raise('A native change is finishing; every part must agree before the story goes on.');
        await durable();
        await point('native.journaled');
        return finishNative(archive.get(tx));
    }

    async function nativeEvent(input) {
        if (!isObject(input) || Object.keys(input).some(key => !['event', 'participant', 'kind', 'npc', 'expectedHead'].includes(key))) return fail('INVALID', 'nativeEvent takes { event, participant, kind, npc, expectedHead }.');
        if (typeof input.event !== 'string' || !input.event || typeof input.participant !== 'string' || !isRecordId(input.npc) || !isHash(input.expectedHead)) return fail('INVALID', 'nativeEvent names the event, the participant, the npc and the head.');
        if (input.kind !== 'confirmed-death') return fail('INVALID', 'The only native event is a confirmed-death.');
        // The same event again with the same meaning is answered from the journal; another meaning is a CONFLICT.
        const prior = archive.event(input.event);
        if (prior) {
            if (prior.participant === input.participant && prior.npc === input.npc && prior.kind === input.kind) {
                const entry = archive.get(prior.tx);
                if (entry?.phase === 'done') {
                    await durable();   // (a delivery whose save failed is not acknowledged until the file has it)
                    return { ok: true, event: input.event, checkpoint: entry.after.checkpoint, hash: entry.after.hash, ack: true };
                }
                if (entry?.phase === 'prepared') {
                    raise('A native change is finishing; every part must agree before the story goes on.');
                    const done = await finishNative(entry);
                    return done.ok ? { ok: true, event: input.event, checkpoint: done.checkpoint, hash: done.hash, ack: true } : done;
                }
            }
            return fail('CONFLICT', 'That event was delivered already with another meaning.');
        }
        const target = participants.get(input.participant);
        if (!target || typeof target.applyEvent !== 'function') return fail('REFUSED', `The participant ${input.participant} takes no native events.`);
        if (pendingNow()) return fail('RESTORE_PENDING', 'A restore is in progress.');
        const first = headNow();
        if (!first) return fail('NOT_FOUND', 'There is no story state.');
        if (first.headHash !== input.expectedHead) return fail('STALE', 'The head moved since it was read; the event was not delivered.');
        // The native identity: an np_ id is resolved by the participant's own query; one it does not know holds the death.
        // The query must be the participant's own: another module's answer to "who is this npc" is not the participant's word.
        if (registry.queryOwner?.('npc.identity') !== input.participant) return fail('REFUSED', `The participant ${input.participant} does not own npc.identity, so it cannot take a death by an npc id.`);
        const identity = ask('npc.identity', { id: input.npc }, first.state);
        if (!isObject(identity) || identity.id !== input.npc || typeof identity.nativeKey !== 'string' || !identity.nativeKey) {
            return fail('REFUSED', 'The native target of that death is unknown, so the death is held rather than guessed.');
        }
        // The participant gives back the checkpoint before and after, durable on its side.
        const before = await callParticipant(input.participant, 'checkpoint', { cursor: first.cursor, headHash: first.headHash });
        if (!before.ok) return before;
        // The head, its source, the chat and the participant are looked at again after the wait; the journal follows with nothing awaited between.
        here();
        const again = headNow();
        if (!again || again.headHash !== first.headHash) return fail('STALE', 'The head moved while the participant made its checkpoint; the event was not delivered.');
        const registered = participants.get(input.participant);
        if (!registered || before.schema !== registered.schema) return fail('SNAPSHOT_UNAVAILABLE', `The participant ${input.participant} saved another checkpoint schema than it registered.`);
        const tx = makeId('nm');
        archive.putEvent(input.event, { participant: input.participant, npc: input.npc, kind: input.kind, nativeKey: identity.nativeKey, tx });
        archive.add({ id: tx, kind: 'native-event', phase: 'prepared', session: session(), participant: input.participant, event: input.event, eventKind: input.kind, nativeKey: identity.nativeKey, npc: input.npc,
            expectedHead: first.headHash, before: { module: input.participant, checkpoint: before.checkpoint, hash: before.hash, schema: before.schema }, after: null,
            boundary: { cursor: structuredClone(first.cursor), prefixHash: first.prefixHash } });
        raise('A native change is finishing; every part must agree before the story goes on.');
        await durable();
        await point('native.journaled');
        const done = await finishNative(archive.get(tx));
        return done.ok ? { ok: true, event: input.event, checkpoint: done.checkpoint, hash: done.hash, ack: true } : done;
    }

    // ---- registration ------------------------------------------------------------------------------------------

    function register(spec) {
        return participants.register(spec);
    }

    // The host registers a module's participant when it registers the module: `def.participant` is
    // { schema, checkpoint, prepare, activate, abort, status, applyEvent?, attach? }. `attach(handle)` is given the
    // module's own handle (`head()` and `nativeMutation(input)`), the only way a module reaches nativeMutation.
    function attach(def) {
        if (def?.participant === undefined || handles.has(def.id) || broken.has(def.id)) return null;
        // The identity is the registering module's, whatever the declaration says: a declaration that names another module is refused.
        let done;
        if (!isObject(def.participant)) done = fail('INVALID', `The participant of ${def.id} is not a record.`);
        else if (def.participant.module !== undefined && def.participant.module !== def.id) done = fail('INVALID', `The participant of ${def.id} names another module (${String(def.participant.module)}).`);
        else done = register({ ...def.participant, module: def.id });
        if (!done.ok) {
            broken.set(def.id, done.message);
            return done;
        }
        const handle = Object.freeze({
            head: () => head(),
            nativeMutation: input => exclusive(() => guarded(() => nativeMutation(input, def.id))),
        });
        handles.set(def.id, handle);
        if (typeof def.participant.attach === 'function') {
            try { def.participant.attach(handle); } catch (error) { console.warn(`[Story Suite] ${def.id}'s participant could not take its handle`, error); }
        }
        return done;
    }

    // ---- the guard of the host's own blocks --------------------------------------------------------------

    /** The host's `hooks.replayGuard`: its blocks are asked again on the story before them (host-block.js). */
    function guard({ state }, { guard: asked }) {
        const predicate = asked?.predicate;
        if (!isObject(predicate)) return { ok: false, reason: 'its guard names no predicate' };
        if (asked.inputHash !== hashJson({ predicate, stateHash: stateHash(state) })) return { ok: false, reason: 'the story before it is not the story it was made on' };
        switch (predicate.kind) {
            case 'make': return { ok: true };
            // (a restore carries what it installs in its own changes: replaying it needs no archive)
            case 'restore': return { ok: true };
            case 'forget':
                return isObject(pointsOf(state)[predicate.snapshot]) ? { ok: true } : { ok: false, reason: 'the save point it forgets is not there' };
            case 'complete':
                return state?.domains?.[HOST_DOMAIN]?.returns?.[predicate.return]?.status === 'committed' ? { ok: true } : { ok: false, reason: 'the return it completes is not committed' };
            default: return { ok: false, reason: `it names a predicate (${predicate.kind}) that this host does not know` };
        }
    }

    // ---- the public adapter of savepoint.make ------------------------------------------------------------

    /** sdk.command('savepoint.make', payload): the receipt envelope of §3, after the checkpoints and the head check. */
    function makeCommand(payload) {
        if (!isObject(payload) || Object.keys(payload).some(key => key !== 'name')) return Promise.resolve(fail('INVALID', 'savepoint.make takes { name? } and nothing else.'));
        return exclusive(() => guarded(async () => {
            const made = await makeNow({ kind: 'manual', ...(payload.name !== undefined ? { name: payload.name } : {}) }, { host: false, cause: 'ui' });
            return made.ok ? { ok: true, receipt: made.receipt } : made;
        }));
    }

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
        make: input => api.make(input, capability),
        registerParticipant: spec => api.registerParticipant(spec, capability),
        prepare: input => api.prepare(input, capability),
        activate: input => api.activate(input, capability),
        abort: input => api.abort(input, capability),
        recover: () => api.recover({}, capability),
        nativeEvent: input => api.nativeEvent(input, capability),
        /** The batch result pinned with a restore, → { id, hash, bytes (the sealed result as its owner gave it), resolvedBy, return, prepared, deathEvents, manifestHash, preRestore: { payload, proofs } | null, aborted } | null. */
        pin(id) {
            const pin = archive.pin(id);
            if (!pin) return null;
            const kept = archive.payload(pin.preRestore);
            return structuredClone({ ...pin, preRestore: kept ? { payload: kept.payload, proofs: kept.proofs } : null });
        },
        /** The journal's entries, oldest first (read only). */
        journal: () => structuredClone(archive.entries()),
        /** The participant prefix map entry for a participant and the cursor and prefix hash of a head, or null. */
        prefix: (participant, cursor, prefixHash) => structuredClone(archive.prefix(participant, prefixKey(cursor, prefixHash))),
        participants: () => participants.modules(),
    });

    return Object.freeze({
        api: Object.freeze(api),
        host,
        capability,
        attach,
        guard,
        makeCommand,
        recover: () => exclusive(() => guarded(() => recover())),
        /** A chat was opened: what belongs to the one before it is dropped (the host calls it before it recovers). */
        settle,
        available: hash => archive.hasPayload(hash),
        /** Whether the journal holds work no operation owns (a crashed make, a restore left half way): the host recovers it. */
        needsRecovery: () => runningIn(archive.holder()) === 0 && archive.exists() && archive.entries().some(entry => !settled(entry)),
        archive,
        pending: pendingNow,
        /** Points of `state` with their bytes checked, in target order (the savepoint.list query). */
        points: state => listNow(state),
    });
}
