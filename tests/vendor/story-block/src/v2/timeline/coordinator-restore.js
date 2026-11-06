// The timeline coordinator's restoring half (contract §8; docs/v2/TIMELINE.md), moved out of createTimeline unchanged: whether a committed restore
// is in the selected story, the completion of a restore, its activation (the commit), the abort of a prepared one, the host's recovery of the journal
// at a start, and the clock markers it materializes.
// `createRestore(s, deps)` is given the timeline's state holder `s` and the coordinator functions it calls (they are all defined by the time it is
// called); it never imports coordinator.js.

import { isHash } from '../replay.js';
import { MINUTES_PER_DAY } from './coordinator-prepare.js';
import { HOST_DOMAIN } from './gate.js';
import { appendHostBlock } from './host-block.js';
import { planRestore } from './manifest.js';
import { fail, isObject, makeId } from './util.js';

export function createRestore(s, deps) {
    const {
        store, registry, announce, problem, archive, participants, block, abortEntry, availability, durable, finish, finishNative, finishSelection, headNow,
        here, makeNow, owe, pendingEntry, pendingNow, point, pointsOf, publishRestore, raise, release, selectionNeeded, session, stillHere,
        syncHidden, withWholePrefixes,
    } = deps;

    // Whether the committed restore is in the story that is selected now. The story is read whole (the barrier holds the modules, and
    // their blocks, back): a swipe, a delete or a Re-read that took the restore away leaves no return of it.
    function restoreHeld(entry) {
        return withWholePrefixes(() => isObject(store.head()?.domains?.[HOST_DOMAIN]?.returns?.[entry.return]));
    }

    // Every part agreed. In one synchronous section the story is read whole and the restore is looked for in the head that is selected
    // now; only if it is there is the return marked complete (a small block of its own) and the restore published for that head. Else
    // the restore is retracted, nothing is published, and the participants, which stand on its checkpoint, are brought to the checkpoint
    // of the selected head. The barrier comes down in `release`, after the chat file has it all and the participants are on the selected
    // head. Complete is told only once the chat file has it.
    async function complete(entry) {
        if (pendingEntry(entry.id) !== null) {
            // Another change is outstanding in this journal (it cannot be through the API): this restore is not complete until it has settled.
            archive.patch(entry.id, { phase: 'acked', why: 'another change is outstanding in this chat' });
            return { ok: true, return: entry.return, status: 'participants-pending' };
        }
        here();
        const section = withWholePrefixes(() => {
            if (!restoreHeld(entry)) return { held: false };
            const now = headNow();
            const found = now?.state?.domains?.[HOST_DOMAIN]?.returns?.[entry.return];
            if (found?.status === 'committed') {
                const stored = appendHostBlock({
                    store, announce, here: stillHere, head: now, ops: [{ op: 'replace', path: `/domains/${HOST_DOMAIN}/returns/${entry.return}/status`, value: 'complete' }],
                    spec: { type: 'savepoint.complete', cause: 'system', summary: 'The return is complete.', key: `complete:${entry.return}`, blockId: makeId('bl'),
                        predicate: { kind: 'complete', return: entry.return }, payload: { return: entry.return }, recorded: null, result: { return: entry.return, status: 'complete' } },
                });
                if (!stored.ok) return { held: true, failed: stored };
                owe(stored);
            }
            publishRestore(entry);
            return { held: true };
        });
        if (section.failed) {
            // (the story cannot take the word yet: the restore waits, behind the barrier, for recover to try again)
            archive.patch(entry.id, { phase: 'acked', why: section.failed.message });
            raise('A restore is finishing; every part must agree before the story goes on.');
            return { ok: true, return: entry.return, status: 'participants-pending' };
        }
        archive.patch(entry.id, section.held ? { phase: 'complete' } : { phase: 'retracted', why: 'the story no longer holds the restore' });
        const released = await release(entry.id);
        if (!section.held) return { ok: true, return: entry.return, status: 'retracted' };
        await point('activate.completed');
        return { ok: true, return: entry.return, status: released.ok ? 'complete' : 'participants-pending' };
    }

    // A restore taken back by a swipe, a delete or a Re-read while its participants were switching did not take: say so.
    const answered = done => (done.ok && done.status === 'retracted'
        ? fail('STALE', 'The restore was taken back (its reply was swiped or deleted, or an earlier reply changed) while its participants were switching; the story does not hold it, and the participants follow the selected head.')
        : done);

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
            // (a save that failed after the restore was complete left the barrier up: it comes down now that the file has it)
            if (s.barrierOwner !== null && s.barrierOwner === archive.holder()) {
                const released = await release();
                if (!released.ok) return { ok: true, return: entry.return, status: 'participants-pending' };
            }
            return { ok: true, return: entry.return, status: 'complete' };
        }
        if (['committed', 'participants-pending', 'acked'].includes(entry.phase)) {
            if (!block.current()) raise('A restore is finishing; every part must agree before the story goes on.');
            return answered(await finish(entry));
        }
        if (entry.phase !== 'prepared') return fail('REFUSED', 'That restore was aborted.');
        // One change at a time: a restore does not start while a native event or change (or another restore) is outstanding, whatever order
        // they were prepared in. It stays prepared; once the other has settled (retry it, or recover) it can be activated.
        const other = pendingEntry(entry.id);
        if (other) return fail('RESTORE_PENDING', `Another change (${other.id}) is still outstanding in this chat; the restore was not activated and stays prepared.`);
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
        // The messages the restore faded are hidden in this same section, and noted on the restore's journal entry; the flush below makes both durable.
        syncHidden();
        raise('A restore is finishing; every part must agree before the story goes on.');
        // Nothing is switched before the commit is in the chat file: a failed save is the caller's failure, and the barrier stays up.
        await durable();
        await point('activate.committed');
        return answered(await finish(archive.get(entry.id)));
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

    // Host startup: what was committed is finished, what was only prepared is aborted. No clock, no target is chosen again.
    async function recover() {
        if (!archive.exists() && !(store.head()?.meta?.proofs && store.timelineMarkers().length)) return { ok: true, state: 'idle', return: null };
        // Two unfinished changes at once cannot happen through the API (a second is refused while one is pending): a journal that holds them
        // was damaged or edited. Finishing one would let go of the barrier with the other still undone, so none is touched, the chat stays
        // barred and nothing is announced ready: it fails safe until the file is put right.
        const unfinished = archive.entries().filter(entry => (entry.kind === 'restore' && ['committed', 'participants-pending', 'acked'].includes(entry.phase))
            || (entry.kind === 'selection' && entry.phase !== 'complete')
            || (['native-mutation', 'native-event'].includes(entry.kind) && entry.phase === 'prepared'));
        if (unfinished.length > 1) {
            if (s.barrierOwner === null) raise('A restore is finishing; every part must agree before the story goes on.');
            return fail('FAILED', `The journal holds ${unfinished.length} unfinished changes (${unfinished.map(entry => entry.id).join(', ')}); only one can be, so the chat stays held until the file is put right.`);
        }
        const early = s.barrierEarly && s.barrierOwner === archive.holder();
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
                    if ((early || registry.restore?.().state !== 'pending') && !restoreHeld(entry)) {
                        // The story no longer holds the restore (its reply was swiped or deleted): its participants, which may stand on its
                        // checkpoints (they are recorded as selected as they acknowledge), are brought to the selected head below.
                        archive.remember(entry.before);
                        archive.patch(entry.id, { phase: 'retracted', why: 'the story no longer holds the restore' });
                        continue;   // (the barrier comes down once, below, when nothing else is left to finish)
                    }
                    if (!block.current()) raise('A restore is finishing; every part must agree before the story goes on.');
                    const done = await finish(archive.get(entry.id));
                    if (done.ok === false) return done;
                    ret = entry.return;
                    if (done.status === 'complete' || done.status === 'retracted') ret = null;
                }
            } else if (entry.kind === 'selection') {
                if (entry.phase !== 'complete') {
                    const done = await finishSelection(entry);
                    if (!done.ok) return done;
                }
            } else if (entry.kind === 'native-mutation' || entry.kind === 'native-event') {
                if (entry.phase === 'prepared') {
                    if (!block.current()) raise('A native change is finishing; every part must agree before the story goes on.');
                    const done = await finishNative(archive.get(entry.id));
                    if (done.ok === false && done.unprepared && entry.kind === 'native-mutation') {
                        // The participant has no record of the change it published (the page closed before it was activated, and the
                        // participant's own record of it is gone): it never switched to it, so nothing stands on it. The journal lets it go,
                        // the barrier comes down below, the reader is told, and the participant publishes what it holds now as a new change.
                        // (A native event, a death, is never let go: it stays held as before.)
                        archive.patch(entry.id, { phase: 'aborted', why: `the participant ${entry.participant} has no record of the change (${done.message})` });
                        const name = registry.module?.(entry.participant)?.name ?? entry.participant;
                        try { problem?.({ module: entry.participant, code: 'NATIVE_ABORTED', toast: true, message: `A change ${name} was making when the page closed could not be finished; the story goes on from its current state.` }); } catch { /* a listener is not the timeline's business */ }
                        continue;
                    }
                    if (done.ok === false && done.code !== 'CONFLICT') return done;
                }
            }
        }
        // The participants are brought to the selected head, and the barrier (a barrier raised as this chat opened, for work that turned
        // out to be nothing to finish, does not stay up) comes down: in `release`, the one place that does.
        if (pendingEntry() === null && (s.barrierOwner === archive.holder() || selectionNeeded())) {
            const released = await release();
            if (!released.ok) return released;
        }
        if (pendingEntry() === null) {
            const markers = await materializeMarkers();
            if (!markers.ok) return markers;
        }
        await durable();
        const left = pendingEntry();
        return { ok: true, state: left ? 'pending' : 'idle', return: left?.kind === 'restore' ? left.return : ret };
    }

    function unmaterializedMarkers() {
        if (!store.head()?.meta?.proofs) return [];
        return withWholePrefixes(() => store.timelineMarkers().filter(marker => archive.marker(marker.cursor.block)?.prefixHash !== marker.prefixHash));
    }
    async function materializeMarkers() {
        for (const marker of unmaterializedMarkers()) {
            if (archive.marker(marker.cursor.block)) return fail('CONFLICT', 'The clock marker changed its captured prefix; its old identity is retired, not rebound.');
            if (pendingNow()) return fail('RESTORE_PENDING', 'The clock anchors are waiting for native recovery.');
            const made = await makeNow({ kind: 'day-start', day: marker.minute / MINUTES_PER_DAY }, { host: true, cause: 'system', marker });
            if (!made.ok) return made;
        }
        return { ok: true };
    }

    return { complete, activate, abort, recover, unmaterializedMarkers };
}
