// The participant on the real Story Block host with the timeline (the vendored testkit from track-e/e6a-timeline): the host registers it
// with the module, a save point carries its checkpoint, a native change is published through the handle, a confirmed death reaches it once,
// and a restore puts the dossiers, the relationship map and the np_ map back together. The module here is a stand-in carrying the real
// participant and the `npc.identity` query; wiring them into src/storysuite-v2.js is the lead's (docs/dev/storysuite-participant.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { hashJson } from './vendor/story-block/src/v2/replay.js';
import { MODULE_ID, createParticipant, memoryVault } from '../src/storysuite-participant/index.js';
import { isTerminalNpcDeath } from '../terminal-lifecycle.js';

const reply = (text, lines = []) => (lines.length ? `${text}\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : text);
const npc = (id, name, extra = {}) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive', trust: 3, ...extra });
const BATCH = { id: 'br_batch001', hash: hashJson({ batch: 'br_batch001', outcome: 'dead' }) };

// Who owns the sealed result of a death (RPG Battle's, later): the host asks `batchResults.resolve` for its bytes.
const sealer = () => ({
    id: 'tl-sealer', name: 'Sealer', version: '0.0.1', domains: { death: { initial: () => ({ batches: {} }) } },
    commands: { 'tl.seal'(ctx, { id }) { ctx.draft('death').batches[id] = { batch: id, outcome: 'dead' }; return { summary: 'Sealed.', narrate: false }; } },
    batchResults: { resolve: ({ id, state }) => { const bytes = state.domains.death?.batches?.[id]; return bytes === undefined ? null : { id, hash: hashJson(bytes), bytes }; } },
});

async function started(t, { quiet = {} } = {}) {
    const live = { chatKey: 'chat:avatar.png:one', state: { npcs: [npc('npc_mira', 'Mira', { aliases: ['The Weaver'] }), npc('npc_tom', 'Old Tom')], socialGraph: { edges: [{ a: 'npc_mira', b: 'npc_tom', kind: 'friends' }] }, checkpoints: [], lineage: [], turn: 1 }, installs: 0 };
    const ref = { host: null };
    const port = {
        chatKey: () => live.chatKey,
        readState: () => structuredClone(live.state),
        installState: async state => { live.installs += 1; live.state = structuredClone(state); },
        writeTimeline: async block => { live.state = { ...live.state, timeline: structuredClone(block) }; },
        // The host's own head Source (the testkit's seam; production reads head().source once Story Block carries it: docs/dev/storysuite-participant.md).
        headSource: () => ref.host.store.sourceAt(ref.host.store.headIndex()),
        ...quiet,
    };
    const delta = createParticipant({ port, vault: memoryVault(), debounceMs: 1 });
    await delta.hydrate();
    const def = { id: MODULE_ID, name: 'NPC State Delta (test)', version: '0.0.1', domains: { marks: { initial: () => ({ n: 0 }) } }, participant: delta.participant, queries: delta.queries };
    const host = await createHost({ modules: [sealer(), def] });
    ref.host = host;
    t.after(() => host.close());
    await host.send('Hello.', reply('The road.'));
    return { host, live, delta };
}

test('the host registers the participant with the module and hands it its own handle; the np_ query is the module\'s', async t => {
    const { host, delta } = await started(t);
    assert.deepEqual(host.timeline.host.participants(), [MODULE_ID]);
    const mira = delta.identity().byKey.npc_mira;
    assert.deepEqual(host.sdk.query('npc.identity', { id: mira }), { id: mira, nativeKey: 'npc_mira', name: 'Mira' });
    assert.equal(host.sdk.query('npc.identity', { name: 'the weaver' }).id, mira);
    assert.equal(host.sdk.query('npc.identity', { id: 'np_zzzzzzzz' }), null);
    assert.equal(host.sdk.query('npc.identity', {}), null);
});

test('a save point carries the checkpoint; a native change through the handle moves the head; a restore puts dossiers, map and np_ back together', async t => {
    const { host, live, delta } = await started(t);
    const mira = delta.identity().byKey.npc_mira;
    const made = await host.sdk.timeline.make({ kind: 'manual', name: 'Before the keep' });
    assert.equal(made.ok, true, made.message);
    const saved = made.snapshot;
    assert.equal(saved.participants[0].module, MODULE_ID);
    assert.match(saved.participants[0].checkpoint, /^nk_/);
    // The story goes on, and Delta's native state with it: a scan adds a person and a bond, a rename, through the published route.
    await host.send('Onward.', reply('The keep.'));
    const headBefore = (await host.sdk.timeline.head()).headHash;
    const changed = await delta.nativeChange({
        source: host.store.sourceAt(host.store.headIndex()),
        edit: state => { state.npcs.push(npc('npc_vale', 'Vale')); state.npcs[0].name = 'Mira Vane'; state.socialGraph.edges.push({ a: 'npc_mira', b: 'npc_vale', kind: 'rivals' }); },
    });
    assert.equal(changed.ok, true, changed.message);
    assert.notEqual((await host.sdk.timeline.head()).headHash, headBefore, 'a native change moves the head though the story did not');
    assert.deepEqual(live.state.npcs.map(item => item.name), ['Mira Vane', 'Old Tom', 'Vale']);
    const vale = delta.identity().byKey.npc_vale;
    assert.ok(vale, 'the new dossier has its np_ before its head was published');
    assert.equal(host.sdk.query('npc.identity', { id: mira }).name, 'Mira Vane', 'the pair survived the rename');
    assert.equal(host.sdk.query('npc.identity', { id: vale }).nativeKey, 'npc_vale');
    // The lethal batch is sealed on the dead timeline, then the restore.
    assert.equal((await host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await host.sdk.timeline.head();
    const prepared = await host.timeline.host.prepare({ snapshot: saved.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal(live.state.npcs.length, 3, 'prepare shows nothing');
    const activated = await host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash });
    assert.deepEqual([activated.ok, activated.status], [true, 'complete']);
    assert.deepEqual(live.state.npcs.map(item => item.name), ['Mira', 'Old Tom'], 'the dossiers');
    assert.equal(live.state.socialGraph.edges.length, 1, 'the relationship map');
    assert.equal(host.sdk.query('npc.identity', { id: mira }).name, 'Mira', 'the np_ of the saved time');
    assert.equal(host.sdk.query('npc.identity', { id: vale }), null, 'the dead timeline\'s id resolves through nothing');
    assert.equal(host.sdk.query('npc.identity', { name: 'Vale' }), null);
    assert.equal(delta.index().selected, saved.participants[0].checkpoint);
    const status = await host.sdk.timeline.status();
    assert.equal(status.state, 'idle');
    // Delta's own sidecar of the chat is whole again: Vale comes back as a new person with a new id, never the old one.
    live.state.npcs.push(npc('npc_vale', 'Vale'));
    await delta.hydrate();
    assert.notEqual(delta.identity().byKey.npc_vale, vale);
});

test('a confirmed death reaches the dossier once, by np_ id resolved through npc.identity; the same event is answered from the journal', async t => {
    const { host, live, delta } = await started(t);
    const tom = delta.identity().byKey.npc_tom;
    const before = (await host.sdk.timeline.make({ kind: 'manual', name: 'Before the duel' })).snapshot;
    await host.send('The duel.', reply('Steel rings.'));
    const head = await host.sdk.timeline.head();
    const input = { event: 'ev_death001', participant: MODULE_ID, kind: 'confirmed-death', npc: tom, expectedHead: head.headHash };
    const first = await host.timeline.host.nativeEvent(input);
    assert.equal(first.ok, true, first.message);
    assert.deepEqual([first.event, first.ack, /^nk_/.test(first.checkpoint)], ['ev_death001', true, true]);
    const dead = live.state.npcs.find(item => item.id === 'npc_tom');
    assert.equal(isTerminalNpcDeath(dead), true);
    assert.equal(isTerminalNpcDeath(live.state.npcs.find(item => item.id === 'npc_mira')), false);
    const installs = live.installs;
    assert.deepEqual(await host.timeline.host.nativeEvent({ ...input, expectedHead: (await host.sdk.timeline.head()).headHash }), first);
    assert.equal(live.installs, installs, 'delivered once');
    assert.equal((await host.timeline.host.nativeEvent({ ...input, npc: 'np_ghost001', event: 'ev_death002', expectedHead: (await host.sdk.timeline.head()).headHash })).code, 'REFUSED', 'an unknown person holds the death');
    // The person is still the same np_ and still resolves (they are dead, not deleted).
    assert.equal(host.sdk.query('npc.identity', { id: tom }).nativeKey, 'npc_tom');
    // A restore to a save from before the death brings the living person back with the same id, and the death is not applied any more.
    assert.equal((await host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const now = await host.sdk.timeline.head();
    const prepared = await host.timeline.host.prepare({ snapshot: before.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: now.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal((await host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: now.headHash })).status, 'complete');
    assert.equal(isTerminalNpcDeath(live.state.npcs.find(item => item.id === 'npc_tom')), false);
    assert.equal(host.sdk.query('npc.identity', { id: tom }).nativeKey, 'npc_tom');
    assert.deepEqual(delta.timeline().applied, {}, 'the death is not applied any more');
});

test('a participant that cannot be registered is a missing participant, not a silent one: the host says so', async t => {
    const warned = [];
    t.mock.method(console, 'warn', (...args) => warned.push(args.join(' ')));
    const broken = { id: MODULE_ID, name: 'NPC State Delta (test)', version: '0.0.1', participant: { schema: 1 } };
    const host = await createHost({ modules: [broken] });
    t.after(() => host.close());
    assert.equal(warned.some(line => /participant was not registered/.test(line)), true);
});

// ---- the reviewer's cases, on the real host ----

async function restoreTo(host, snapshot) {
    assert.equal((await host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await host.sdk.timeline.head();
    const prepared = await host.timeline.host.prepare({ snapshot: snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    if (!prepared.ok) return prepared;
    return host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash });
}

test('N2: a scan that lands while the reader presses Save is waited for: the save point has the person, and a restore to it keeps him', async t => {
    let scanning = false;
    let landed = false;
    const ref = { live: null };
    const { host, live, delta } = await started(t, {
        quiet: {
            busy: () => scanning,
            idle: async () => { while (scanning) await new Promise(resolve => setTimeout(resolve, 2)); return true; },
        },
    });
    ref.live = live;
    // The scan of the reply just shown is running when Save is pressed, and lands a moment later.
    scanning = true;
    setTimeout(() => { live.state.npcs.push(npc('npc_vale', 'Vale')); landed = true; scanning = false; }, 20);
    const made = await host.sdk.timeline.make({ kind: 'manual', name: 'Save' });
    assert.equal(made.ok, true, made.message);
    assert.equal(landed, true, 'the save waited for the scan');
    await host.send('Onward.', reply('Further.'));
    live.state.npcs = live.state.npcs.filter(item => item.id !== 'npc_vale');
    const restored = await restoreTo(host, made.snapshot);
    assert.equal(restored.ok, true, restored.message);
    assert.deepEqual(live.state.npcs.map(item => item.name), ['Mira', 'Old Tom', 'Vale'], 'the person the story still has is still there');
    void delta;
});

test('N2: a save the participant cannot make true is refused as a retryable STALE', async t => {
    const { host } = await started(t, { quiet: { busy: () => true, idle: async () => false } });
    const made = await host.sdk.timeline.make({ kind: 'manual', name: 'Save' });
    assert.equal(made.ok, false);
    assert.equal(made.code, 'STALE');
});

test('N2: every change Delta saves is published: a scan after a save point is a native mutation at the head, and a restore to the save point drops it', async t => {
    const { host, live, delta } = await started(t);
    const made = await host.sdk.timeline.make({ kind: 'manual', name: 'Before the scan' });
    assert.equal(made.ok, true, made.message);
    await host.send('Onward.', reply('A stranger.'));
    const before = (await host.sdk.timeline.head()).headHash;
    // A scan lands, Delta saves it (its persist hook tells the participant), and the participant publishes it.
    live.state.npcs.push(npc('npc_vale', 'Vale'));
    delta.noteChange();
    const out = await delta.flush();
    assert.equal(out.ok, true, out.message);
    assert.notEqual((await host.sdk.timeline.head()).headHash, before, 'the native change moved the head');
    assert.equal(host.sdk.query('npc.identity', { name: 'Vale' }).nativeKey, 'npc_vale');
    const second = await host.sdk.timeline.make({ kind: 'manual', name: 'After the scan' });
    assert.equal(second.ok, true, second.message);
    const restored = await restoreTo(host, made.snapshot);
    assert.equal(restored.ok, true, restored.message);
    assert.deepEqual(live.state.npcs.map(item => item.name), ['Mira', 'Old Tom'], 'the save point before the scan');
    assert.equal(host.sdk.query('npc.identity', { name: 'Vale' }), null);
});

test('N1: the chat is renamed (Delta moves its state to a new key): the ids are the same and a save point made before it still restores', async t => {
    const { host, live, delta } = await started(t);
    const mira = delta.identity().byKey.npc_mira;
    const made = await host.sdk.timeline.make({ kind: 'manual', name: 'Save' });
    assert.equal(made.ok, true, made.message);
    live.chatKey = 'chat:avatar.png:renamed';
    await delta.hydrate();
    assert.equal(delta.identity().byKey.npc_mira, mira);
    live.state.npcs[0].trust = 9;
    const restored = await restoreTo(host, made.snapshot);
    assert.equal(restored.ok, true, restored.message);
    assert.equal(live.state.npcs[0].trust, 3);
    assert.equal(host.sdk.query('npc.identity', { id: mira }).nativeKey, 'npc_mira');
});
