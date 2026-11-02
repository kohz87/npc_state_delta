// Delta normalizes a state as it installs it. A checkpoint made in the run that wrote a record holds it as written (a milestone's turn null),
// so after the install the live state is not those raw bytes: the participant's look after the install compares them as Delta keeps them too,
// or a selection or restore to such a checkpoint is refused for good ("could not confirm ... installed").
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, rig } from './helpers/participant-rig.js';

// What Delta's normalization does to the record in the test: a missing milestone turn becomes 0.
const normalize = state => {
    const out = structuredClone(state);
    for (const npc of out.npcs ?? []) for (const m of npc.milestones ?? []) if (m.turn === null) m.turn = 0;
    return out;
};

async function rawCheckpoint(t, port) {
    const live = { chatKey: 'chat:avatar.png:one', state: { ...freshState(), branchFamilyId: 'fam-normal' }, installs: 0 };
    const r = await rig(t, { live, quiet: { installState: async next => { live.installs += 1; live.state = normalize(next); }, ...port } });
    await r.host.send('Hello.', 'One.');
    // The record as written in this run (raw), published: its checkpoint holds it raw.
    const saved = await r.change(state => { state.npcs[0].milestones = [{ axis: 'trust', threshold: 25, turn: null }]; });
    live.state = normalize(live.state);            // a reload: Delta loads the state normalized
    live.state.npcs[0].trust = 1;                  // and the story moved on
    return { r, live, saved };
}

test('a checkpoint holding a raw record is installed and confirmed when the port gives Delta\'s normalization', async t => {
    const { r, live, saved } = await rawCheckpoint(t, { normalize });
    const prepared = await r.delta.participant.prepare({ return: 'hs_norm0001', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.equal(prepared.ok, true, prepared.message);
    const done = await r.delta.participant.activate({ return: 'hs_norm0001', prepared: prepared.prepared });
    assert.equal(done.ok, true, done.message);
    assert.equal(live.state.npcs[0].trust, 3);
    assert.equal(live.state.npcs[0].milestones[0].turn, 0);
    assert.equal((await r.delta.participant.status({ return: 'hs_norm0001' })).status, 'active', 'and status says it switched');
});

test('without normalize() the look stays strict: the raw bytes must be the live state', async t => {
    const { r, saved } = await rawCheckpoint(t, {});
    const prepared = await r.delta.participant.prepare({ return: 'hs_norm0002', checkpoint: saved.checkpoint, hash: saved.hash });
    const done = await r.delta.participant.activate({ return: 'hs_norm0002', prepared: prepared.prepared });
    assert.equal(done.code, 'STALE');
});

test('the adapter gives Delta\'s normalizeState as normalize(): a delete back to a checkpoint holding a raw record settles', async t => {
    const { adapterRig } = await import('./helpers/participant-rig.js');
    const r = await adapterRig(t);
    let asked = 0;
    r.api.normalizeState = state => { asked += 1; return normalize(state); };
    r.api.installState = async next => { r.live.installs += 1; r.live.state = normalize(next); };
    await r.host.send('Hello.', 'One.');
    await r.host.sdk.timeline.make({ kind: 'manual', name: 'Start' });
    await r.published(state => { state.npcs[0].milestones = [{ axis: 'trust', threshold: 25, turn: null }]; });
    await r.host.send('Two.', 'Two reply.');
    await r.published(state => { state.npcs[0].trust = 7; });
    const chat = r.host.ctx.chat;
    while (chat.length && chat.at(-1).is_user) await r.host.st.deleteMessage(chat.length - 1);
    await r.host.st.deleteMessage(chat.length - 1);
    assert.equal(await r.api.gate.settled(), true, 'the barrier is down');
    assert.equal(r.host.registry.restore().state, 'idle');
    assert.equal(r.live.state.npcs[0].trust, 3);
    assert.equal(r.live.state.npcs[0].milestones[0].turn, 0);
    assert.ok(asked > 0, 'the participant asked for the normalization');
});
