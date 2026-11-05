// The timeline coordinator's native half (contract §8; docs/v2/TIMELINE.md), moved out of createTimeline unchanged: which checkpoint each participant stands
// on for the selected story (the selection rule, the plan, its check, the selection of a head), the native mutations and events of a participant, what a
// restore publishes, the registration of a participant, the guard of the host's own blocks, the capability projection, the `savepoint.make` adapter and
// the read of a pinned batch result.
// `createNative(s, deps)` is given the timeline's state holder `s` and the coordinator functions it calls; it never imports coordinator.js. Whatever it
// needs from the reading, preparing and restoring halves (wired after it) is given as a function that reads it when it is called.

import { hashJson, isHash, isRecordId, sourceProblem } from '../replay.js';
import { HOST_DOMAIN } from './gate.js';
import { stateHash } from './host-block.js';
import { crashing, fail, isObject, isStaleChat, makeId } from './util.js';

export function createNative(s, deps) {
    const {
        store, registry, activeHistory, archive, ask, block, availability, brokenProblem, callParticipant, durable, exclusive, guarded, head, headNow, here,
        makeNow, participants, pendingNow, point, pointsOf, raise, release, session, stillHere, unmaterializedMarkers,
    } = deps;

    // One selection rule for every head change. Prefix identity AND replayed state must match;
    // no revision, positional fallback or nearest-swipe rebinding is allowed.
    // The hash of a witness's state, worked out once per state object: the store hands out the same deep-frozen state while the chat is unchanged.
    function witnessStateHash(state) {
        if (!state || typeof state !== 'object' || !Object.isFrozen(state)) return stateHash(state);
        let hash = s.witnessHashes.get(state);
        if (hash === undefined) s.witnessHashes.set(state, hash = stateHash(state));
        return hash;
    }
    function selectionPlan(limit = null) {
        if (!archive.exists()) return {};
        return withWholePrefixes(() => (store.witnessScope ?? (read => read()))(() => {
            const result = { ...archive.baseline() };
            const through = limit ? store.prefixWitness(limit) : null;
            if (limit && !through) throw new Error('The marker root no longer has a unique prefix.');
            for (const module of participants.modules()) {
                const candidates = [];
                for (const mapping of archive.prefixes(module)) {
                    if (!mapping.boundary || !mapping.after) continue;
                    const witness = store.prefixWitness(mapping.boundary.cursor);
                    if (witness && (!through || witness.index < through.index || (witness.index === through.index && witness.op <= through.op)) && witness.prefixHash === mapping.boundary.prefixHash && witnessStateHash(witness.state) === mapping.boundary.stateHash) {
                        candidates.push({ mapping, index: witness.index, op: witness.op });
                    }
                }
                candidates.sort((a, b) => a.index - b.index || a.op - b.op || a.mapping.seq - b.mapping.seq);
                if (candidates.length) result[module] = candidates.at(-1).mapping.after;
            }
            return result;
        }));
    }
    function withWholePrefixes(fn) {
        const was = registry.restore();
        if (was.state !== 'pending') return fn();
        registry.setRestore('idle', '');
        try { store.lifecycleChanged?.(); return fn(); }
        finally { registry.setRestore(was.state, was.reason); store.lifecycleChanged?.(); }
    }
    const selectionNeeded = () => hashJson(selectionPlan()) !== hashJson(archive.selection());

    // Owners may declare a native dependency through a synchronous, read-only hook. Check it only after
    // checkpoint selection, on the whole selected story, while the barrier still holds every public reader.
    function nativeSelectionProblem() {
        const events = Object.freeze(archive.entries().filter(entry => entry.kind === 'native-event' && entry.phase === 'done')
            .map(({ event, npc, participant }) => Object.freeze({ event, npc, participant })));
        if (!events.length) return null;
        return withWholePrefixes(() => {
            const state = store.head();
            for (const { moduleId, fn } of registry.hookEntries('nativeSelection')) {
                let answer;
                try { answer = fn({ state, query: (name, args) => ask(name, args, state) }, { events }); }
                catch { answer = null; }
                if (typeof answer?.then === 'function') { Promise.resolve(answer).catch(() => {}); answer = null; }
                if (answer?.ok === true) continue;
                return typeof answer?.reason === 'string' && answer.reason ? answer.reason
                    : `The records needed by ${moduleId} could not follow the selected story. Restore a save point from before the change, or put the changed reply back.`;
            }
            return null;
        });
    }

    const WAITING = 'The selected story is waiting for its records.';

    async function selectHead() {
        if (!selectionNeeded()) return { ok: true };
        const desired = selectionPlan();
        const lacking = availability(Object.values(desired));
        if (lacking) return block.note(null, fail('SNAPSHOT_UNAVAILABLE', lacking));
        const entry = archive.add({ id: makeId('hs'), kind: 'selection', phase: 'prepared', desired, slots: {} });
        raise(WAITING);
        await durable();
        return finishSelection(entry);
    }

    async function finishSelection(entry) {
        // (a block that is being retried keeps its own reason up; a first try says only that it is waiting)
        if (!block.current()) raise(WAITING);
        await durable();
        for (const [module, target] of Object.entries(entry.desired)) {
            const registered = participants.get(module);
            if (!registered || registered.schema !== target.schema) return block.note(module, fail('SNAPSHOT_UNAVAILABLE', `The participant ${module} is unavailable for the selected head.`));
            let slot = archive.get(entry.id).slots[module];
            if (!slot) {
                const prepared = await callParticipant(module, 'prepare', { return: entry.id, checkpoint: target.checkpoint, hash: target.hash });
                if (!prepared.ok) return block.note(module, prepared);
                if (prepared.hash !== target.hash) return block.note(module, fail('CONFLICT', 'The participant prepared other selected bytes.'));
                slot = { prepared: prepared.prepared, ack: false };
                archive.patch(entry.id, { slots: { ...archive.get(entry.id).slots, [module]: slot } });
                await durable();
            }
            if (!slot.ack) {
                const done = await callParticipant(module, 'activate', { return: entry.id, prepared: slot.prepared });
                if (!done.ok) return block.note(module, done);
                if (done.checkpoint !== target.checkpoint || done.hash !== target.hash) return block.note(module, fail('CONFLICT', 'The participant selected other bytes.'));
                archive.patch(entry.id, { slots: { ...archive.get(entry.id).slots, [module]: { ...slot, ack: true } } });
                await durable();
            }
        }
        // A head may move during any callback: settle this durable selection, then plan again.
        archive.select(entry.desired);
        archive.patch(entry.id, { phase: 'complete' });
        await durable();
        block.clear();
        return { ok: true };
    }

    // ---- native mutations and events ---------------------------------------------------------------------

    const prefixKey = (cursor, prefixHash) => [archive.lineage(), cursor.sid, cursor.swipeKey, cursor.block, cursor.op, prefixHash].join('|');

    function publish(entry) {
        const key = prefixKey(entry.boundary.cursor, entry.boundary.prefixHash);
        const seq = archive.bumpNative();
        archive.putPrefix(entry.participant, key, {
            seq, participant: entry.participant, tx: entry.id, source: entry.source ?? null, schema: entry.after.schema,
            before: entry.before, after: entry.after, selected: 'after', boundary: entry.boundary,
        });
        archive.remember([entry.before]);
        archive.select({ ...archive.selection(), [entry.participant]: entry.after });
        archive.patch(entry.id, { phase: 'done' });
    }

    // After a restore every participant's selected checkpoint is the one it acknowledged, for the prefix the story now ends at.
    function publishRestore(entry) {
        const now = headNow();
        if (!now) return;
        const key = prefixKey(now.cursor, now.prefixHash);
        const beforeKey = prefixKey(entry.boundary.cursor, entry.boundary.prefixHash);
        archive.remember(entry.before);
        for (const item of entry.before) archive.putPrefix(item.module, beforeKey, {
            seq: archive.bumpNative(), participant: item.module, tx: entry.id, schema: item.schema,
            before: null, after: item, selected: 'after', boundary: entry.boundary,
        });
        let moved = false;
        for (const [module, slot] of Object.entries(entry.participants ?? {})) {
            if (!slot.ack || archive.prefix(module, key)?.tx === entry.id) continue;
            archive.putPrefix(module, key, {
                seq: archive.bumpNative(), participant: module, tx: entry.id, source: null, schema: slot.schema, before: null,
                after: { module, checkpoint: slot.ack.checkpoint, hash: slot.ack.hash, schema: slot.schema }, selected: 'after', boundary: { cursor: now.cursor, prefixHash: now.prefixHash, stateHash: stateHash(now.state) },
            });
            moved = true;
        }
        if (moved) archive.select(Object.fromEntries(Object.entries(entry.participants).map(([module, slot]) => [module, { module, checkpoint: slot.ack.checkpoint, hash: slot.ack.hash, schema: slot.schema }])));
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
            // (`unprepared`: the participant has nothing prepared under that id, which `recover` may let go for a native mutation)
            if (!done.ok) return done.code === 'NOT_FOUND' && entry.kind === 'native-mutation' ? { ...done, unprepared: true } : done;
            if (entry.kind === 'native-event' && done.event !== entry.event) return fail('CONFLICT', 'The participant acknowledged another event.');
            answer = done;
        }
        let settled = entry;
        if (!entry.after) settled = archive.patch(entry.id, { after: { module, checkpoint: answer.checkpoint, hash: answer.hash, schema: entry.before.schema } });
        else if (answer.checkpoint !== entry.after.checkpoint || answer.hash !== entry.after.hash) {
            return fail('CONFLICT', `The participant ${module} answered other bytes than the change prepared.`);
        }
        publish(settled);
        // Told done only when the file has it; a failed save is the caller's failure (a retry of the same event answers once it is saved).
        // The barrier comes down in `release`, once the participants stand on the selected head: the reply this change stood on may be
        // gone by now. (A selection that cannot be confirmed yet leaves the barrier up for a recovery; the change itself is done.)
        await release(settled.id);
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
        try { made = await participants.run(who, () => input.prepare());
            here(); } catch (error) {
            if (crashing(error)) throw error;
            if (isStaleChat(error)) throw error;
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
            before: structuredClone(made.before), after: structuredClone(made.after), preparedId: made.prepared, boundary: { cursor: structuredClone(first.cursor), prefixHash: first.prefixHash, stateHash: stateHash(first.state) } });
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
            boundary: { cursor: structuredClone(first.cursor), prefixHash: first.prefixHash, stateHash: stateHash(first.state) } });
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
        if (def?.participant === undefined || s.handles.has(def.id) || s.broken.has(def.id)) return null;
        // The identity is the registering module's, whatever the declaration says: a declaration that names another module is refused.
        let done;
        if (!isObject(def.participant)) done = fail('INVALID', `The participant of ${def.id} is not a record.`);
        else if (def.participant.module !== undefined && def.participant.module !== def.id) done = fail('INVALID', `The participant of ${def.id} names another module (${String(def.participant.module)}).`);
        else done = register({ ...def.participant, module: def.id });
        if (!done.ok) {
            s.broken.set(def.id, done.message);
            return done;
        }
        const handle = Object.freeze({
            head: () => head(),
            nativeMutation: input => exclusive(() => guarded(() => nativeMutation(input, def.id))),
        });
        s.handles.set(def.id, handle);
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
            case 'make': return !predicate.marker || state?.meta?.proofs?.[predicate.marker.proof] === predicate.marker.pin ? { ok: true } : { ok: false, reason: 'the clock marker no longer belongs to the active prefix' };
            // (a restore carries what it installs in its own changes: replaying it needs no archive)
            case 'restore': return { ok: true };
            case 'forget':
                return isObject(pointsOf(state)[predicate.snapshot]) ? { ok: true } : { ok: false, reason: 'the save point it forgets is not there' };
            case 'complete':
                return state?.domains?.[HOST_DOMAIN]?.returns?.[predicate.return]?.status === 'committed' ? { ok: true } : { ok: false, reason: 'the return it completes is not committed' };
            default: return { ok: false, reason: `it names a predicate (${predicate.kind}) that this host does not know` };
        }
    }

    // Synchronous §2 capability projection. Reading it creates no archive or participant checkpoint.
    // Installed NSD needs its native participant even when its optional UI/social features are off.
    function contract() {
        const snapshots = archive.holder() !== null && store.readOnly?.() == null;
        const declarations = registry.modules().filter(def => def.participant !== undefined || def.id === 'npc-state-delta');
        const installed = declarations.every(def => participants.has(def.id) && !s.broken.has(def.id));
        const oldWitnesses = archive.entries().some(entry => entry.kind === 'restore' && entry.phase !== 'aborted' && !entry.boundary);
        const participantsReady = installed && participants.ready() && !brokenProblem() && !oldWitnesses && registry.restore?.().state !== 'pending' && !selectionNeeded() && !nativeSelectionProblem();
        // (a restore fades earlier messages: retained-chat restore is offered only while Story Block's own readers of earlier messages filter
        // them, and not for a chat where a faded message could not be hidden)
        const retainedChatRestore = snapshots && unmaterializedMarkers().length === 0 && activeHistory.wired() && !s.hideFailed.has(archive.holder());
        return { api: 2, snapshots, retainedChatRestore, participantsReady };
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

    /** The batch result pinned with a restore, → { id, hash, bytes (the sealed result as its owner gave it), resolvedBy, return, prepared, deathEvents, manifestHash, preRestore: { payload, proofs } | null, aborted } | null. */
    function pin(id) {
        const pin = archive.pin(id);
        if (!pin) return null;
        const kept = archive.payload(pin.preRestore);
        return structuredClone({ ...pin, preRestore: kept ? { payload: kept.payload, proofs: kept.proofs } : null });
    }

    return { selectionPlan, withWholePrefixes, nativeSelectionProblem, selectionNeeded, selectHead, finishSelection, prefixKey, publishRestore, finishNative, pin, nativeEvent, register, attach, guard, contract, makeCommand };
}
