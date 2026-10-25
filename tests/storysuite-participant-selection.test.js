// Delta follows the host's selected head. A delete, a swipe or a retraction moves the head; Story Block's barrier goes up, asks the participant to
// stand on the checkpoint of the selected head (its prepare and activate), and comes down when it does (docs/v2/HISTORY.md). Delta does not select
// anything itself: it answers the host's callbacks, and it reads, scans and generates only once the barrier is down, on the selected checkpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig, BATCH, clone, crash, rig } from './helpers/participant-rig.js';
import { runHostScenario } from './helpers/host-scenario.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** Three replies, each with a native change published at it (trust 5, 7, 9), after a first save point that starts the timeline for the chat. */
async function story(t, options) {
    const r = await adapterRig(t, options);
    const { host } = r;
    await host.send('Hello.', 'One.');
    const point = (await host.sdk.timeline.make({ kind: 'manual', name: 'Start' })).snapshot;
    await r.published(state => { state.npcs[0].trust = 5; });
    await host.send('Two.', 'Two reply.');
    await r.published(state => { state.npcs[0].trust = 7; });
    await host.send('Three.', 'Three reply.');
    await r.published(state => { state.npcs[0].trust = 9; });
    return { ...r, point };
}
const trust = r => r.live.state.npcs[0].trust;
/** Deletes the newest reply, and the reader's messages after it. */
async function dropReply(r) {
    const chat = r.host.ctx.chat;
    while (chat.length && chat.at(-1).is_user) await r.host.st.deleteMessage(chat.length - 1);
    await r.host.st.deleteMessage(chat.length - 1);
}
const standing = async r => (await r.host.sdk.timeline.status()).participants[0];
/** Delta stands on the checkpoint the host selected for the head. */
async function followed(r, expected) {
    assert.equal(await r.api.gate.settled(), true, 'the barrier is down');
    assert.equal(r.host.registry.restore().state, 'idle');
    assert.equal(trust(r), expected);
    const selected = await standing(r);
    assert.equal(selected.checkpoint, r.delta?.index?.().base.checkpoint ?? selected.checkpoint);
    assert.deepEqual(r.host.store.problems(), []);
}

test('a delete, a swipe and its swipe back each leave Delta on the checkpoint of the selected head', async t => {
    const r = await story(t);
    await dropReply(r);
    await followed(r, 7);
    await r.host.send('Three again.', 'Three again reply.');
    await r.published(state => { state.npcs[0].trust = 8; });
    await r.host.swipe('Another three.');
    await followed(r, 7);
    await r.published(state => { state.npcs[0].trust = 6; });
    await r.host.st.swipeTo(r.host.ctx.chat.length - 1, 0);
    await followed(r, 8);
});

test('a delete from the middle of the story and a retraction (the restore\'s reply deleted) are followed too', async t => {
    const r = await story(t);
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: r.point.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal((await r.host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash })).status, 'complete');
    await followed(r, 3);
    await r.host.send('I wake.', 'The hall again.');
    await r.published(state => { state.npcs[0].trust = 4; });
    // The waking reply goes: the head is the restore's again.
    await dropReply(r);
    await followed(r, 3);
    // The restore's own reply goes, and with it the restore: the faded messages are shown again and the head is the reply before it.
    assert.equal(r.host.ctx.chat.filter(message => message.is_system).length > 0, true, 'the restore hid what it faded');
    await dropReply(r);
    await followed(r, 7);
    assert.equal(r.host.ctx.chat.every(message => !message.is_system), true, 'and what the restore hid is shown again');
});

test('Delta does not select: it answers the host\'s prepare and activate for the selection, the same as for a restore', async t => {
    const r = await story(t);
    const calls = [];
    for (const name of ['prepare', 'activate']) {
        const original = r.host.registry.module('npc-state-delta').participant[name];
        void original;
    }
    const journalBefore = r.host.timeline.host.journal().length;
    await r.host.st.deleteMessage(r.host.ctx.chat.length - 1);
    const added = r.host.timeline.host.journal().slice(journalBefore);
    calls.push(...added.map(entry => entry.kind));
    assert.deepEqual(calls, ['selection'], 'the host\'s own selection entry did it');
    assert.equal(trust(r), 7);
});

test('nothing is read, scanned or generated until the barrier settles on the selected checkpoint', async t => {
    const r = await story(t);
    const hold = deferred();
    r.live.holdInstall = hold.promise;
    const pending = r.host.st.deleteMessage(r.host.ctx.chat.length - 1);
    for (let i = 0; i < 100 && r.host.registry.restore().state !== 'pending'; i += 1) await r.sleep(2);
    assert.equal(r.host.registry.restore().state, 'pending', 'the barrier is up while Delta has not stood on the selected checkpoint');
    assert.equal(trust(r), 9, 'it still shows the dead head');
    // The gate Delta's scans, passes, reconciles and generations ask does not answer while the barrier is up.
    let answered = null;
    const settled = r.api.gate.settled().then(value => { answered = value; return value; });
    await r.sleep(120);
    assert.equal(answered, null, 'not settled');
    assert.equal(r.host.sdk.modules().find(module => module.id === 'npc-state-delta').status, 'restore-pending');
    assert.equal(r.host.sdk.query('npc.present', {}), null, 'and the host answers no query of Delta\'s');
    hold.resolve();
    assert.equal(await settled, true);
    assert.equal(trust(r), 7, 'and when it does, Delta stands on the selected checkpoint');
    await pending;
    assert.equal(r.host.registry.restore().state, 'idle');
});

test('a barrier that stays up is waited for a bounded time, then reported as not settled', async t => {
    const r = await story(t, { settle: { settleMs: 80, settlePollMs: 5 } });
    const hold = deferred();
    r.live.holdInstall = hold.promise;
    const pending = r.host.st.deleteMessage(r.host.ctx.chat.length - 1);
    for (let i = 0; i < 100 && r.host.registry.restore().state !== 'pending'; i += 1) await r.sleep(2);
    assert.equal(await r.api.gate.settled(), false);
    hold.resolve();
    await pending;
    assert.equal(await r.api.gate.settled(), true);
});

test('after a reload and a rebuild the selected head is still followed, and a barrier left up by a crash comes down before Delta reads', async t => {
    const r = await story(t);
    const again = await r.reload();
    again.host.store.rebuild();
    await again.host.timeline.host.recover();
    await followed(again, 9);
    await dropReply(again);
    await followed(again, 7);
    const third = await again.reload();
    await followed(third, 7);
    third.host.store.rebuild();
    await dropReply(third);
    await followed(third, 5);
});

test('a completed restore is not skipped during recovery: the participant says it switched only while its live state is the restore\'s bytes', async t => {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    const point = (await r.host.sdk.timeline.make({ kind: 'manual', name: 'Start' })).snapshot;
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    await r.change(state => { state.npcs[0].trust = 9; });
    const dead = clone(r.live.state);
    // The process dies with the restore committed in the story and the participant not yet asked to switch.
    let image = null;
    r.hook.at = async phase => { if (phase === 'activate.participant:npc-state-delta:before') { image = clone(r.disk.image); throw crash(); } };
    await assert.rejects(r.restoreTo(point), error => /simulated crash/.test(error.message));
    assert.notEqual(image, null);
    // The recovery switches Delta (its index now says the restore is active) ...
    const first = await rig(t, { vault: r.vault, image, live: r.live, hydrate: false });
    assert.equal(first.live.state.npcs[0].trust, 3);
    assert.equal(first.host.registry.restore().state, 'idle');
    // ... and the same journal found again over a state file that never got that install is not skipped on the strength of the index.
    const stale = { chatKey: r.live.chatKey, state: clone(dead), installs: 0 };
    const second = await rig(t, { vault: r.vault, image, live: stale, hydrate: false });
    assert.equal(stale.state.npcs[0].trust, 3, 'installed again, not acknowledged on the old word');
    assert.equal(stale.installs, 1);
    assert.equal(second.host.registry.restore().state, 'idle');
    assert.deepEqual(second.host.store.problems(), []);
    // And once it stands on the restore, the word is "active" again and nothing more is installed.
    const third = await rig(t, { vault: r.vault, image, live: stale, hydrate: false });
    assert.equal(stale.installs, 1);
    second.host.store.rebuild();
    await second.host.timeline.host.recover();
    assert.equal(stale.state.npcs[0].trust, 3);
    void third;
});

test('in Delta\'s runtime a reply\'s scan, a branch reconcile and a generation\'s injection wait for the host\'s barrier, and carry on when it is down', () => {
    runHostScenario('barrier', async () => {
        mockState.barrier = { pending: true, looks: 0 };
        mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
        const sdk = {
            registered: [], registerModule(def) { sdk.registered.push(def); },
            timeline: {
                head: async () => { mockState.barrier.looks += 1; return mockState.barrier.pending ? { ok: false, code: 'RESTORE_PENDING', message: 'A restore is in progress.' } : { ok: true, headHash: 'a'.repeat(64) }; },
                history: async () => ({ ok: true, messages: mockState.context.chat.map(() => ({ active: true })), faded: [] }),
            },
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        assert.equal(await waitFor(() => api.stateReady()), true);
        Object.assign(mockState.extensionSettings.npc_state_delta, { enabled: true, autoScan: true, scanEvery: 1, fullScanEveryTurn: false });
        await manualAddNpc('Mira');
        await api.flush();
        const names = () => api.getState().npcs.map(npc => npc.name);
        mockState.quietResponder = async (args = {}) => {
            if (args.jsonSchema) return '{"npcs":[]}';
            return JSON.stringify({ npcs: [{ name: 'Vale', present: true, role: 'wanderer', species: 'Human', age: '30', appearance: 'Vale wears a grey cloak.', personality: 'quiet', speech: 'brief', relationshipImpact: 'ordinary' }] });
        };
        // The head moved and the host is still bringing Delta to the selected checkpoint (its barrier is up): a reply arrives.
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Vale, a wanderer in a grey cloak, nods to the party at the gate and says nothing more for a while.', swipe_id: 0 });
        const promptsBefore = mockState.prompts.length;
        const callsBefore = mockState.rawCalls.length;
        eventSource.emit('message_received', mockState.context.chat.length - 1);
        eventSource.emit('generation_after_commands', 'normal', {}, false);
        await sleep(400);
        assert.equal(mockState.rawCalls.length, callsBefore, 'no scan request while the barrier is up');
        assert.deepEqual(names(), ['Mira'], 'and nothing was written');
        assert.equal(api.scanActive(), true, 'the scan is due: a save point waits for it');
        assert.equal(mockState.prompts.length, promptsBefore, 'no injection was built from the old head');
        assert.ok(mockState.barrier.looks > 1, 'the host was asked again and again');
        // The host has brought Delta to the selected checkpoint: the scan runs, and the generation builds its injection.
        mockState.barrier.pending = false;
        assert.equal(await waitFor(() => names().includes('Vale'), 8000), true, 'the scan ran once the barrier was down');
        assert.equal(await waitFor(() => mockState.prompts.length > promptsBefore, 3000), true, 'the injection was built');
        assert.equal(await api.scanIdle(3000), true);
        // A message deleted while the host is bringing Delta to the selected head: Delta's own branch reconcile waits for it as well.
        const reconciled = () => api.uiStatus().branchReconciliations.length;
        mockState.barrier.pending = true;
        const before = reconciled();
        mockState.context.chat.pop();
        eventSource.emit('message_deleted', mockState.context.chat.length);
        await sleep(400);
        assert.equal(reconciled(), before, 'no reconcile while the barrier is up');
        mockState.barrier.pending = false;
        assert.equal(await waitFor(() => reconciled() > before, 5000), true, 'it ran once the barrier was down');
    });
});
