// A timeline snapshot must answer inside its own budget even when the participant queue, a host-dependent write, or the vault is stuck.
// These tests use the production participant and the synthetic Story Block host; no live chat or files are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParticipant, fileVault, memoryVault } from '../src/storysuite-participant/index.js';
import { adapterRig, BATCH, freshState, rig } from './helpers/participant-rig.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function participantRig(options = {}) {
    const live = { state: freshState(), chatKey: 'chat:avatar.png:one' };
    const vault = memoryVault();
    const port = {
        chatKey: () => live.chatKey,
        readState: () => structuredClone(live.state),
        writeTimeline: async block => { live.state.timeline = structuredClone(block); },
    };
    const delta = createParticipant({ port, vault, boundMs: 120, ...options });
    return { live, vault, port, delta };
}

test('a snapshot waiting on the host queue releases the host and a later save succeeds', { timeout: 3000 }, async t => {
    const r = await adapterRig(t, { participantOptions: { boundMs: 120 } });
    await r.host.send('Hello.', 'The road is quiet.');
    assert.equal(r.live.state.timeline, undefined);
    const finished = deferred();
    let first = true;
    r.api.writeTimeline = async block => {
        if (first) {
            first = false;
            // forget queues behind make on the actual host coordinator; make is waiting for this write.
            const answer = await r.host.sdk.timeline.forget({ snapshot: 'sn_missing' });
            assert.equal(answer.code, 'NOT_FOUND');
        }
        r.live.state.timeline = structuredClone(block);
        finished.resolve();
    };
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'At the road' });
    assert.equal(saved.code, 'STALE', saved.message);
    assert.match(saved.message, /saving the story-line identity/);
    await finished.promise;
    await new Promise(resolve => setImmediate(resolve)); // the expired participant callback leaves its queue
    assert.equal(r.vault.docs.size, 0, 'the expired callback made no late baseline or snapshot');
    const retry = await r.host.sdk.timeline.make({ kind: 'manual', name: 'At the road' });
    assert.equal(retry.ok, true, retry.message);
    assert.equal(retry.snapshot.participants.length, 1);
});

test('a snapshot expires while an earlier participant operation holds the queue and does not run later', { timeout: 3000 }, async () => {
    const r = participantRig();
    const entered = deferred();
    const release = deferred();
    const write = r.port.writeTimeline;
    r.port.writeTimeline = async block => { entered.resolve(); await release.promise; await write(block); };
    const earlier = r.delta.hydrate();
    await entered.promise;
    const out = await r.delta.participant.checkpoint({ headHash: 'a'.repeat(64) });
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /waiting for earlier participant work/);
    assert.equal(r.vault.docs.size, 0);
    release.resolve();
    assert.equal((await earlier).ok, true);
    await r.delta.hydrate(); // follows the expired callback in the participant queue
    assert.equal(r.vault.docs.size, 1, 'only the earlier hydration made its baseline');
    const retry = await r.delta.participant.checkpoint({ headHash: 'a'.repeat(64) });
    assert.equal(retry.ok, true, retry.message);
});

test('host callbacks refuse promptly while an expired snapshot is still finishing', { timeout: 3000 }, async () => {
    const r = participantRig();
    const entered = deferred();
    const release = deferred();
    const write = r.port.writeTimeline;
    r.port.writeTimeline = async block => { entered.resolve(); await release.promise; await write(block); };
    const pending = r.delta.participant.checkpoint({});
    await entered.promise;
    assert.equal((await pending).code, 'STALE');
    const callbacks = [
        () => r.delta.participant.checkpoint({}),
        () => r.delta.participant.prepare({}),
        () => r.delta.participant.activate({}),
        () => r.delta.participant.abort({}),
        () => r.delta.participant.status({}),
        () => r.delta.participant.applyEvent({}),
    ];
    for (const callback of callbacks) {
        const out = await callback();
        assert.equal(out.code, 'STALE');
        assert.match(out.message, /still finishing an earlier timed-out save/);
    }
    let edited = false;
    r.delta.participant.attach({
        head: async () => ({ ok: true, headHash: 'a'.repeat(64) }),
        nativeMutation: async ({ prepare }) => {
            try { await prepare(); return { ok: true }; }
            catch (error) { return { ok: false, message: error.message }; }
        },
    });
    const native = await r.delta.nativeChange({ source: {}, edit: () => { edited = true; } });
    assert.match(native.message, /still finishing an earlier timed-out save/);
    assert.equal(edited, false, 'native preparation did not enter the blocked participant queue');
    release.resolve();
    assert.equal((await r.delta.hydrate()).ok, true);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});

test('a slow checkpoint file cannot publish a late snapshot or change the baseline', { timeout: 3000 }, async () => {
    const r = participantRig();
    await r.delta.hydrate();
    const before = r.delta.index().base;
    const entered = deferred();
    const release = deferred();
    const put = r.vault.put.bind(r.vault);
    r.vault.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
    const pending = r.delta.participant.checkpoint({ headHash: 'b'.repeat(64) });
    await entered.promise;
    const out = await pending;
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /saving the native checkpoint/);
    assert.deepEqual(r.delta.index().base, before);
    release.resolve();
    await r.delta.hydrate();
    assert.deepEqual(r.delta.index().base, before);
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
    r.vault.put = put;
    assert.equal((await r.delta.participant.checkpoint({ headHash: 'b'.repeat(64) })).ok, true);
});

test('a late first baseline index is restored without installing or handing over the expired baseline', { timeout: 3000 }, async () => {
    const r = participantRig();
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    let candidate;
    r.vault.putIndex = async (...args) => {
        if (first) { first = false; candidate = structuredClone(args[1].base); entered.resolve(); await release.promise; }
        return putIndex(...args);
    };
    const pending = r.delta.participant.checkpoint({ headHash: 'f'.repeat(64) });
    await entered.promise;
    const out = await pending;
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /saving the participant index/);
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.delta.index().base, null, 'the expired call did not install a baseline in memory');
    assert.equal((await r.vault.getIndex(r.delta.timeline().lineage)).base, null, 'the previous durable index was restored');
    assert.deepEqual(r.delta.participant.current(candidate), { ok: true, current: false });
    assert.equal(r.vault.docs.size, 1, 'only the baseline was made before the timeout');
    assert.equal((await r.delta.participant.checkpoint({ headHash: 'f'.repeat(64) })).ok, true);
    assert.deepEqual((await r.vault.getIndex(r.delta.timeline().lineage)).base, r.delta.index().base);
});

test('a failed first-baseline restoration is repaired before a later save', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 35 });
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let calls = 0;
    r.vault.putIndex = async (...args) => {
        calls += 1;
        if (calls === 1) { entered.resolve(); await release.promise; }
        if (calls === 2) throw new Error('index temporarily unavailable');
        return putIndex(...args);
    };
    const slow = r.delta.participant.checkpoint({});
    await entered.promise;
    assert.equal((await slow).code, 'STALE');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.delta.index().base, null);
    assert.equal((await r.delta.participant.checkpoint({})).code, 'STALE');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await r.vault.getIndex(r.delta.timeline().lineage)).base, null);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

for (const method of ['getIndex', 'put', 'putIndex']) {
    test(`a vault ${method} that never settles cannot strand the participant queue`, { timeout: 3000 }, async () => {
        const r = participantRig({ boundMs: 25, vaultTimeoutMs: 70 });
        const entered = deferred();
        const original = r.vault[method].bind(r.vault);
        let first = true;
        r.vault[method] = (...args) => {
            if (first) { first = false; entered.resolve(); return new Promise(() => {}); }
            return original(...args);
        };
        const slow = r.delta.participant.checkpoint({});
        await entered.promise;
        assert.equal((await slow).code, 'STALE');
        assert.equal((await r.delta.hydrate()).ok, true, 'the queue moves on without a reload');
        assert.equal((await r.delta.participant.checkpoint({})).ok, true);
        assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
    });
}

test('a stalled vault checkpoint read releases later host callbacks', { timeout: 3000 }, async () => {
    const r = participantRig({ vaultTimeoutMs: 60 });
    const saved = await r.delta.participant.checkpoint({});
    const get = r.vault.get.bind(r.vault);
    let first = true;
    r.vault.get = (...args) => {
        if (first) { first = false; return new Promise(() => {}); }
        return get(...args);
    };
    const failed = await r.delta.participant.prepare({ return: 'rt_stalled', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.equal(failed.code, 'FAILED');
    assert.match(failed.message, /vault get did not answer/);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});

test('a file-vault response body that never settles cannot strand the queue', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 25, vaultTimeoutMs: 70 });
    let first = true;
    const file = fileVault({ headers: {}, fetchFn: async () => {
        if (first) { first = false; return { ok: true, json: () => new Promise(() => {}) }; }
        return { ok: false, status: 404 };
    } });
    r.vault.getIndex = file.getIndex;
    const out = await r.delta.participant.checkpoint({});
    assert.equal(out.code, 'STALE');
    assert.equal((await r.delta.hydrate()).ok, true);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});

test('a timed-out index write that finishes after a newer save is repaired to the newer index', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 25, vaultTimeoutMs: 70 });
    await r.delta.hydrate();
    const lineage = r.delta.timeline().lineage;
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = async (id, index) => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return putIndex(id, index);
    };
    const slow = r.delta.participant.checkpoint({ headHash: 'c'.repeat(64) });
    await entered.promise;
    assert.equal((await slow).code, 'STALE');
    assert.equal((await r.delta.hydrate()).ok, true);
    const saved = await r.delta.participant.checkpoint({ headHash: 'd'.repeat(64) });
    assert.equal(saved.ok, true, saved.message);
    const latest = r.delta.index();
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await r.delta.hydrate();
    assert.deepEqual(await r.vault.getIndex(lineage), latest, 'the late older write did not remain on disk');
    assert.deepEqual(r.delta.index(), latest);
});

test('an index write that persists but never answers is rolled back before the queue resumes', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 25, vaultTimeoutMs: 70 });
    await r.delta.hydrate();
    const before = r.delta.index();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = async (...args) => {
        if (first) {
            first = false;
            await putIndex(...args);
            return new Promise(() => {});
        }
        return putIndex(...args);
    };
    assert.equal((await r.delta.participant.checkpoint({ headHash: 'c'.repeat(64) })).code, 'STALE');
    assert.equal((await r.delta.hydrate()).ok, true);
    assert.deepEqual(r.delta.index(), before);
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), before);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});

test('a late participant-index write restores the previous baseline before later work', { timeout: 3000 }, async () => {
    const r = participantRig();
    await r.delta.hydrate();
    const lineage = r.delta.timeline().lineage;
    const before = r.delta.index().base;
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let candidate;
    let first = true;
    r.vault.putIndex = async (id, index) => {
        if (first) { first = false; candidate = structuredClone(index.base); entered.resolve(); await release.promise; }
        return putIndex(id, index);
    };
    const pending = r.delta.participant.checkpoint({ headHash: 'c'.repeat(64) });
    await entered.promise;
    const out = await pending;
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /saving the participant index/);
    assert.deepEqual(r.delta.index().base, before);
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    release.resolve();
    await r.delta.hydrate();
    assert.deepEqual(r.delta.index().base, before);
    assert.deepEqual((await r.vault.getIndex(lineage)).base, before, 'the durable index was restored');
    assert.equal(r.live.state.npcs[0].trust, 9, 'a newer native change remains live');
    assert.deepEqual(r.delta.participant.current(candidate), { ok: true, current: false }, 'the abandoned checkpoint was never handed over');
    assert.equal((await r.delta.participant.checkpoint({ headHash: 'c'.repeat(64) })).ok, true);
});

test('a failed index restoration holds later work until the previous baseline is durable', { timeout: 3000 }, async () => {
    const r = participantRig();
    await r.delta.hydrate();
    const lineage = r.delta.timeline().lineage;
    const before = r.delta.index().base;
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let calls = 0;
    r.vault.putIndex = async (id, index) => {
        calls += 1;
        if (calls === 1) { entered.resolve(); await release.promise; return putIndex(id, index); }
        if (calls <= 3) throw new Error('index temporarily unavailable');
        if (calls === 4) assert.deepEqual(index.base, before, 'the original baseline is repaired before the retry');
        return putIndex(id, index);
    };
    const pending = r.delta.participant.checkpoint({ headHash: 'd'.repeat(64) });
    await entered.promise;
    const out = await pending;
    assert.equal(out.code, 'STALE');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve)); // the failed rollback is recorded before the next callback
    const blocked = await r.delta.participant.checkpoint({});
    assert.equal(blocked.code, 'STALE');
    assert.match(blocked.message, /still restoring the participant index/);
    assert.deepEqual(r.delta.index().base, before);
    await new Promise(resolve => setImmediate(resolve)); // the first background repair failed
    assert.equal((await r.delta.participant.checkpoint({})).code, 'STALE');
    await new Promise(resolve => setImmediate(resolve)); // the next background repair succeeded
    const retried = await r.delta.participant.checkpoint({ headHash: 'd'.repeat(64) });
    assert.equal(retried.ok, true, retried.message);
    assert.deepEqual((await r.vault.getIndex(lineage)).base, r.delta.index().base);
});

async function leaveIndexRepair(r) {
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let calls = 0;
    r.vault.putIndex = async (lineage, index) => {
        calls += 1;
        if (calls === 1) { entered.resolve(); await release.promise; }
        if (calls === 2) throw new Error('index temporarily unavailable');
        return putIndex(lineage, index);
    };
    const slow = r.delta.participant.checkpoint({ headHash: 'e'.repeat(64) });
    await entered.promise;
    assert.equal((await slow).code, 'STALE');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
}

test('status runs a pending index repair before reporting a prepared return', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 35 });
    const saved = await r.delta.participant.checkpoint({});
    const prepared = await r.delta.participant.prepare({ return: 'rt_repair', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.equal(prepared.ok, true);
    await leaveIndexRepair(r);
    const status = await r.delta.participant.status({ return: 'rt_repair' });
    assert.equal(status.status, 'prepared', status.message);
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

test('the host aborts its prepared return after repairing the participant index', { timeout: 3000 }, async t => {
    const r = await rig(t, { participantOptions: { boundMs: 35 } });
    await r.host.send('Hello.', 'The road is quiet.');
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'First' });
    assert.equal(saved.ok, true, saved.message);
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: saved.snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal(r.delta.index().returns[prepared.return].status, 'prepared');
    await leaveIndexRepair(r);
    const aborted = await r.host.timeline.host.abort({ prepared: prepared.prepared });
    assert.equal(aborted.status, 'aborted', aborted.message);
    assert.equal(r.delta.index().returns[prepared.return].status, 'aborted', 'the participant cleanup ran even though the host ignores its answer');
    assert.equal(Object.values(r.delta.index().prepared).some(entry => entry.return === prepared.return), false);
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

test('a host abort is retained when its first repair attempt also fails', { timeout: 3000 }, async t => {
    const r = await rig(t, { participantOptions: { boundMs: 35 } });
    await r.host.send('Hello.', 'The road is quiet.');
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'First' });
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: saved.snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    await leaveIndexRepair(r);
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = (...args) => {
        if (first) { first = false; throw new Error('repair still unavailable'); }
        return putIndex(...args);
    };
    assert.equal((await r.host.timeline.host.abort({ prepared: prepared.prepared })).status, 'aborted');
    await r.delta.hydrate();
    assert.equal(r.delta.index().returns[prepared.return].status, 'aborted', 'cleanup is retried even though the host ignored the failure');
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

test('a failed abort index write is restored and the host cleanup is retried', { timeout: 3000 }, async t => {
    const r = await rig(t, { participantOptions: { boundMs: 35 } });
    await r.host.send('Hello.', 'The road is quiet.');
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'First' });
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: saved.snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = async (...args) => {
        await putIndex(...args);
        if (first) { first = false; throw new Error('answer lost after write'); }
    };
    assert.equal((await r.host.timeline.host.abort({ prepared: prepared.prepared })).status, 'aborted');
    await r.delta.hydrate();
    assert.equal(r.delta.index().returns[prepared.return].status, 'aborted');
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

test('a deferred abort stays with its original chat when the active chat changes', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 35 });
    const saved = await r.delta.participant.checkpoint({});
    const prepared = await r.delta.participant.prepare({ return: 'rt_chat', checkpoint: saved.checkpoint, hash: saved.hash });
    await leaveIndexRepair(r);
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = async (...args) => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return putIndex(...args);
    };
    const aborting = r.delta.participant.abort({ return: 'rt_chat', prepared: prepared.prepared });
    await entered.promise;
    assert.equal((await aborting).code, 'STALE');
    r.live.chatKey = 'chat:avatar.png:other';
    release.resolve();
    await r.delta.hydrate();
    assert.equal(r.delta.index().returns.rt_chat.status, 'prepared', 'the other chat did not receive the abort');
    r.live.chatKey = 'chat:avatar.png:one';
    await r.delta.hydrate();
    assert.equal(r.delta.index().returns.rt_chat.status, 'aborted', 'cleanup follows the original chat');
});

test('other host callbacks do not wait behind a deferred abort write', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 35 });
    const saved = await r.delta.participant.checkpoint({});
    const prepared = await r.delta.participant.prepare({ return: 'rt_abort_wait', checkpoint: saved.checkpoint, hash: saved.hash });
    await leaveIndexRepair(r);
    const entered = deferred();
    const release = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let calls = 0;
    r.vault.putIndex = async (...args) => {
        calls += 1;
        if (calls === 2) { entered.resolve(); await release.promise; }
        return putIndex(...args);
    };
    const aborting = r.delta.participant.abort({ return: 'rt_abort_wait', prepared: prepared.prepared });
    await entered.promise;
    assert.equal((await aborting).code, 'STALE');
    const blocked = await r.delta.participant.activate({});
    assert.equal(blocked.code, 'STALE');
    assert.match(blocked.message, /finishing an earlier abort/);
    assert.equal((await r.delta.participant.status({ return: 'rt_abort_wait' })).code, 'STALE');
    release.resolve();
    await r.delta.hydrate();
    assert.equal((await r.delta.participant.status({ return: 'rt_abort_wait' })).status, 'aborted');
});

test('an abort waiting on a host-dependent repair releases the host and finishes cleanup afterwards', { timeout: 3000 }, async t => {
    const r = await rig(t, { participantOptions: { boundMs: 35 } });
    await r.host.send('Hello.', 'The road is quiet.');
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'First' });
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: saved.snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    await leaveIndexRepair(r);
    const putIndex = r.vault.putIndex.bind(r.vault);
    let first = true;
    r.vault.putIndex = async (...args) => {
        if (first) {
            first = false;
            const answer = await r.host.sdk.timeline.forget({ snapshot: 'sn_missing' });
            assert.equal(answer.code, 'NOT_FOUND');
        }
        return putIndex(...args);
    };
    const aborted = await r.host.timeline.host.abort({ prepared: prepared.prepared });
    assert.equal(aborted.status, 'aborted');
    await r.delta.hydrate(); // follows the deferred abort in the participant queue
    assert.equal(r.delta.index().returns[prepared.return].status, 'aborted');
    assert.deepEqual(await r.vault.getIndex(r.delta.timeline().lineage), r.delta.index());
});

test('a participant-index repair does not wait under the host queue', { timeout: 3000 }, async t => {
    const r = await adapterRig(t, { participantOptions: { boundMs: 120 } });
    await r.host.send('Hello.', 'The road is quiet.');
    assert.equal((await r.host.sdk.timeline.make({ kind: 'manual', name: 'First' })).ok, true);
    const entered = deferred();
    const release = deferred();
    const repaired = deferred();
    const putIndex = r.vault.putIndex.bind(r.vault);
    let calls = 0;
    r.vault.putIndex = async (lineage, index) => {
        calls += 1;
        if (calls === 1) { entered.resolve(); await release.promise; }
        if (calls === 2) throw new Error('index temporarily unavailable');
        if (calls === 3) {
            const answer = await r.host.sdk.timeline.forget({ snapshot: 'sn_missing' });
            assert.equal(answer.code, 'NOT_FOUND');
            await putIndex(lineage, index);
            repaired.resolve();
            return;
        }
        return putIndex(lineage, index);
    };
    const slow = r.host.sdk.timeline.make({ kind: 'manual', name: 'Slow' });
    await entered.promise;
    assert.equal((await slow).code, 'STALE');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const blocked = await r.host.sdk.timeline.make({ kind: 'manual', name: 'Retry' });
    assert.equal(blocked.code, 'STALE');
    assert.match(blocked.message, /restoring the participant index/);
    await repaired.promise;
    await new Promise(resolve => setImmediate(resolve));
    const saved = await r.host.sdk.timeline.make({ kind: 'manual', name: 'Retry' });
    assert.equal(saved.ok, true, saved.message);
});

test('a stalled branch inheritance returns without minting a competing lineage', { timeout: 3000 }, async () => {
    const r = participantRig();
    const entered = deferred();
    const release = deferred();
    let pending = true;
    r.port.branchPending = () => pending;
    r.port.inheritBranch = async () => { entered.resolve(); await release.promise; pending = false; };
    const snapshot = r.delta.participant.checkpoint({});
    await entered.promise;
    const out = await snapshot;
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /inheriting the parent dossiers/);
    assert.equal(r.live.state.timeline, undefined);
    release.resolve();
    await r.delta.hydrate();
    assert.equal(r.vault.docs.size, 1, 'only the subsequent hydration made its baseline');
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});

test('a scan-idle promise that never answers still gives a retryable reason', { timeout: 3000 }, async () => {
    const r = participantRig();
    const release = deferred();
    r.port.idle = () => release.promise;
    const out = await r.delta.participant.checkpoint({});
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /waiting for dossier work/);
    assert.equal(r.vault.docs.size, 0);
    release.resolve(true);
    await r.delta.hydrate();
    assert.equal(r.vault.docs.size, 1, 'the expired snapshot did not resume when the scan became idle');
});

test('a scan-idle promise that never settles does not strand later callbacks', { timeout: 3000 }, async () => {
    const r = participantRig({ boundMs: 35 });
    r.port.idle = () => new Promise(() => {});
    const out = await r.delta.participant.checkpoint({});
    assert.equal(out.code, 'STALE');
    assert.match(out.message, /waiting for dossier work/);
    delete r.port.idle;
    assert.equal((await r.delta.hydrate()).ok, true);
    assert.equal((await r.delta.participant.checkpoint({})).ok, true);
});
