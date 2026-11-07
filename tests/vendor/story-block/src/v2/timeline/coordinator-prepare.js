// The timeline coordinator's making and preparing half (contract §8; docs/v2/TIMELINE.md), moved out of createTimeline unchanged: the save point
// (its input, the reservation, the participants' checkpoints, the archive, the commit), forgetting one, and the first two steps of a restore (the
// input, the checks of the save and of the sealed batch result, the pre-restore pin, each participant's prepare), and the abort of a prepared
// restore. `finish`, which switches the participants of a committed restore one at a time, lives in coordinator-prepare/finish.js.
// `createPrepare(s, deps)` is given the timeline's state holder `s` (this half reads none of it) and the coordinator functions it calls; it never
// imports coordinator.js. `complete` (the restore half's, called by `finish`) is given as a function that reads it when it is called.

import { hashJson, isHash, isPlainJson, isRecordId } from '../replay.js';
import { createFinish } from './coordinator-prepare/finish.js';
import { GENESIS_EPOCH, HOST_DOMAIN } from './gate.js';
import { appendHostBlock, stateHash } from './host-block.js';
import { capture, initialSavepoints, planRestore, previousDayOf } from './manifest.js';
import { fail, isObject, makeId } from './util.js';

export const MANUAL_LIMIT = 10;
export const MINUTES_PER_DAY = 1440;
const KINDS = Object.freeze(['initial', 'manual', 'day-start']);
const NAME_MAX = 80;

const textProblem = (value, max) => {
    if (typeof value !== 'string') return 'is not text';
    if (/[\u0000-\u001f\u007f]/.test(value)) return 'has a control character';
    if (value !== value.trim() || !value) return 'is empty or has a space at either end';
    if ([...value].length > max) return `is longer than ${max} characters`;
    return '';
};

export function createPrepare(s, deps) {
    const {
        store, registry, settings, announce, archive, participants, ask, block, brokenProblem, callParticipant, complete, durable, headNow, here, minuteOf,
        owe, pendingNow, point, pointsOf, quietly, sceneOf, selectionPlan, session, stillHere,
    } = deps;

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
    async function makeNow(input, { host, cause, marker = null }) {
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
        const taken = marker ? structuredClone(marker.entry) : capture({ registry, state: first.state, settings });
        if (marker) {
            // Earlier markers in this same root precede this logical capture, although their async
            // descriptors were necessarily published later. Carry only those proved predecessors.
            for (const point of Object.values(pointsOf(first.state))) {
                if (!marker.prior.includes(point.target.block)) continue;
                if (!taken.payload.domains[HOST_DOMAIN]) {
                    taken.payload.domains[HOST_DOMAIN] = initialSavepoints(first.epoch);
                    taken.payload.domainVersions[HOST_DOMAIN] = 1;
                }
                const domain = taken.payload.domains[HOST_DOMAIN];
                domain.points[point.id] = structuredClone(point);
                domain.dayStarts[String(point.day)] = point.id;
                domain.previousDay = previousDayOf(domain.dayStarts);
            }
        }
        archive.add({ id: journal, kind: 'make', phase: 'reserved', session: session(), snapshot: id, savekind: input.kind, expectedHead: first.headHash, block: blockId });
        await point('make.reserved');

        // 2. the participants' checkpoints, as of this head.
        const cursor = marker ? structuredClone(marker.cursor) : { ...structuredClone(first.cursor), block: blockId };
        const checkpoints = [];
        const historical = marker ? selectionPlan(marker.root.cursor) : {};
        for (const module of participants.modules()) {
            const selected = historical[module];
            const answer = selected ? { ok: true, ...selected } : await callParticipant(module, 'checkpoint', { cursor, headHash: marker ? marker.prefixHash : first.headHash });
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
            capturedAtRev: marker ? marker.cursor.rev : first.cursor.rev, label: name, id, kind: input.kind, name, epoch: first.epoch,
            target: cursor, eligibleFrom: structuredClone(cursor), minute: Number.isInteger(minute) ? minute : null, day,
            scene: sceneOf(marker ? { domains: taken.payload.domains } : first.state), journal: isObject(journalDay) ? journalDay : null,
            payloadHash, participants: checkpoints, lineage: marker ? marker.prefixHash : first.prefixHash, available: true,
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
        // A participant's native change that landed after its checkpoint was handed over is not in the head hash (it is published when its
        // change finishes): each participant that has a probe is asked, in this synchronous section, whether its state is still the one it
        // gave. Retryable: nothing is written or announced.
        if (marker && hashJson(historical) !== hashJson(selectionPlan(marker.root.cursor))) return fail('STALE', 'The native prefix of the clock marker changed before publication.');
        for (const item of checkpoints.filter(item => !historical[item.module])) {
            const probed = participants.probe(item.module, { checkpoint: item.checkpoint, hash: item.hash, schema: item.schema });
            if (!probed.current) {
                archive.patch(journal, { phase: 'discarded', why: `${item.module}: ${probed.why}` });
                return fail('STALE', `The participant ${item.module} changed its state while the save point was made (${probed.why}); nothing was saved. Try again.`);
            }
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
                predicate: { kind: 'make', snapshot: id, payloadHash, ...(marker ? { marker: { proof: marker.proof, pin: marker.pin } } : {}) }, payload: { kind: input.kind, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.kind === 'day-start' ? { day: input.day } : {}) },
                recorded: { payloadHash, participants: checkpoints }, result: { snapshot: id },
            },
        });
        if (!stored.ok) { archive.patch(journal, { phase: 'discarded', why: stored.message }); return stored; }
        owe(stored);
        archive.remember(checkpoints);
        if (marker) archive.putMarker(marker.cursor.block, { prefixHash: marker.prefixHash, snapshot: id });
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
        for (const module of participants.modules()) {
            const before = await callParticipant(module, 'checkpoint', { cursor: now.cursor, headHash: now.headHash });
            if (!before.ok) return before;
            pre.payload.participants.push({ module, checkpoint: before.checkpoint, hash: before.hash, schema: before.schema });
        }
        here();
        const checked = headNow();
        if (!checked || checked.headHash !== now.headHash) return fail('STALE', 'The head moved while the pre-restore checkpoints were saved.');
        const preHash = hashJson({ payload: pre.payload, proofs: pre.proofs });
        archive.putPayload(preHash, { payload: pre.payload, proofs: pre.proofs });
        const slots = {};
        for (const item of found.participants) slots[item.module] = { checkpoint: item.checkpoint, hash: item.hash, schema: item.schema, prepared: null, preparedHash: null, ack: null };
        archive.add({
            id: preparedId, kind: 'restore', phase: 'preparing', session: session(), return: returnId, snapshot: found.id, deathEvents: [...input.deathEvents],
            batchResult: { ...input.batchResult }, expectedHead: now.headHash, newEpoch, block: blockId, cue: record.cue, payloadHash: found.payloadHash,
            manifest: plan.manifest, manifestHash: plan.manifestHash, participants: slots, pre: preHash, before: pre.payload.participants, boundary: { cursor: now.cursor, prefixHash: now.prefixHash, stateHash: stateHash(now.state) },
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

    const finish = createFinish({ archive, block, callParticipant, complete, durable, participants, point });
    return { makeNow, forget, availability, abortEntry, prepare, finish };
}
