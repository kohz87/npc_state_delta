// Byte parity for a chat that never uses the timeline: registering with the host, opening the chat, replies, scans and rebuilds hydrate nothing,
// write nothing and publish nothing, so a populated chat stays exactly what Delta alone keeps. The chat uses the timeline when it first saves a
// point, loses a person to a confirmed death, restores, or asks npc.identity; from then on its changes are published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig, clone } from './helpers/participant-rig.js';

const untouched = async (r, plain) => {
    assert.equal(r.live.writes, 0, 'nothing written into the chat state');
    assert.equal(r.live.installs, 0);
    assert.equal(r.vault.docs.size, 0, 'no checkpoint file');
    assert.equal(r.vault.indexes.size, 0, 'no participant index');
    assert.equal(Object.hasOwn(r.live.state, 'timeline'), false, 'no story line in the state');
    assert.deepEqual(r.live.state, plain);
    assert.equal(r.host.ctx.chatMetadata.storySuite?.timeline, undefined, 'nothing of the timeline in the chat file');
    assert.deepEqual((await r.host.sdk.timeline.status()).participants, [], 'the host has no native checkpoint of it');
};

test('a populated chat that never uses the timeline is left alone: registering, replies, scans and checks write and publish nothing', async t => {
    const r = await adapterRig(t);
    const plain = clone(r.live.state);
    await r.host.send('Hello.', 'Mira looks up.');
    await r.host.send('Onward.', 'The keep.');
    r.adapter.check();
    // Scans change the dossiers and say so; the participant is told and does nothing for a chat that does not use the timeline.
    r.announce(state => { state.npcs[0].trust = 5; });
    r.announce(state => { state.npcs[0].trust = 6; });
    await r.sleep(450);
    plain.npcs[0].trust = 6;
    await untouched(r, plain);
    r.host.store.rebuild();
    r.adapter.check();
    await r.sleep(10);
    await untouched(r, plain);
});

test('after a reload the untouched chat is still untouched, and the host\'s own timeline calls that do not need Delta do not start it', async t => {
    const r = await adapterRig(t);
    await r.host.send('Hello.', 'Mira looks up.');
    const plain = clone(r.live.state);
    const again = await r.reload();
    await again.host.send('Onward.', 'The keep.');
    again.announce(state => { state.npcs[0].trust = 4; });
    await again.sleep(450);
    plain.npcs[0].trust = 4;
    await untouched(again, plain);
    assert.equal((await again.host.sdk.timeline.head()).ok, true);
    assert.equal((await again.host.sdk.timeline.history()).ok, true);
    await untouched(again, plain);
});

test('the first save point starts the timeline for the chat: the line and the ids are made then, and its changes are published from then on', async t => {
    const r = await adapterRig(t);
    await r.host.send('Hello.', 'Mira looks up.');
    r.announce(state => { state.npcs[0].trust = 5; });
    await r.sleep(20);
    assert.equal(r.live.writes, 0);
    const made = await r.host.sdk.timeline.make({ kind: 'manual', name: 'Before the keep' });
    assert.equal(made.ok, true, made.message);
    assert.match(r.live.state.timeline.lineage, /^lg_[0-9a-z]{8}$/);
    assert.equal(r.vault.docs.size > 0, true);
    const head = (await r.host.sdk.timeline.head()).headHash;
    r.announce(state => { state.npcs[0].trust = 8; });
    await r.sleep(450);
    assert.notEqual((await r.host.sdk.timeline.head()).headHash, head, 'a change after the first use is published');
    const standing = (await r.host.sdk.timeline.status()).participants[0];
    assert.equal(standing.module, 'npc-state-delta');
    // And after a reload and a rebuild it still is.
    const again = await r.reload();
    again.host.store.rebuild();
    const before = (await again.host.sdk.timeline.head()).headHash;
    again.announce(state => { state.npcs[0].trust = 9; });
    await again.sleep(450);
    assert.notEqual((await again.host.sdk.timeline.head()).headHash, before);
    assert.equal(again.live.state.npcs[0].trust, 9);
});

test('the first npc.identity question starts it as well: the ids are made behind the first ask, and the next ask finds them', async t => {
    const r = await adapterRig(t);
    await r.host.send('Hello.', 'Mira looks up.');
    await r.sleep(20);
    assert.equal(r.live.writes, 0);
    assert.equal(r.host.sdk.query('npc.identity', { name: 'Mira' }), null);
    await r.sleep(50);
    assert.match(r.live.state.timeline.lineage, /^lg_[0-9a-z]{8}$/);
    const found = r.host.sdk.query('npc.identity', { name: 'Mira' });
    assert.match(found.id, /^np_[0-9a-z]{8}$/);
    assert.equal(found.nativeKey, 'npc_mira');
    const head = (await r.host.sdk.timeline.head()).headHash;
    r.announce(state => { state.npcs[0].trust = 7; });
    await r.sleep(450);
    assert.notEqual((await r.host.sdk.timeline.head()).headHash, head);
});
