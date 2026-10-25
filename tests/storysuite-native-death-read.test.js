import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig } from './helpers/participant-rig.js';

test('a native dependency reads a confirmed-dead dossier by np_ identity and follows its selected checkpoint', async t => {
    const r = await adapterRig(t);
    await r.host.send('Hello.', 'Mira is here.');
    assert.equal((await r.host.sdk.timeline.make({ kind: 'manual', name: 'Alive' })).ok, true);
    const identity = r.host.sdk.query('npc.identity', { name: 'Mira' });
    assert.equal(r.host.sdk.query('npc.dossier', { id: identity.id }).lifeState, 'alive');
    await r.host.send('Go on.', 'The lethal reply.');
    const head = await r.host.sdk.timeline.head();
    const delivered = await r.host.timeline.host.nativeEvent({ event: 'de_death001', participant: 'npc-state-delta',
        kind: 'confirmed-death', npc: identity.id, expectedHead: head.headHash });
    assert.equal(delivered.ok, true, delivered.message);
    assert.equal(r.live.state.npcs[0].archived, true);
    assert.equal(r.host.sdk.query('npc.dossier', { name: 'Mira' }), null);
    assert.equal(r.host.sdk.query('npc.dossier', { id: identity.id }).lifeState, 'deceased');
    r.api.isEnabled = () => false;
    assert.equal(r.host.sdk.query('npc.dossier', { id: identity.id }).lifeState, 'deceased', 'native confirmation remains available with optional features off');
    r.api.isEnabled = () => true;
    assert.equal(r.host.sdk.query('npc.dossier', { id: 'np_missing0', name: 'Old Tom' }), null, 'an unresolved id never falls back to a name');
    assert.equal(r.host.sdk.query('npc.dossier', { id: null, name: 'Old Tom' }), null);
    assert.equal(r.host.sdk.query('npc.dossier', { id: '', name: 'Old Tom' }), null);
    await r.host.st.deleteMessage(r.host.ctx.chat.length - 1);
    assert.equal(r.host.sdk.query('npc.dossier', { id: identity.id }).lifeState, 'alive');
    assert.deepEqual(r.host.store.problems(), []);
});
