// A chat whose story line was replaced before NSD 1.7.1 (a reload's recovery read the state before Delta loaded it and minted a new line over
// the chat's own): the chat's journal still names checkpoints of the line it had. They are this chat's, so they are accepted, and only they are:
// a checkpoint of another chat, or of a line nobody kept, is still another story line. A chat that never changed its line is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, rig } from './helpers/participant-rig.js';
import { buildCheckpoint, restoredState, storedTimeline, timelineOf } from '../src/storysuite-participant/index.js';

const FAMILY = 'b5c2d3e4-0000-4000-8000-000000000001';
const familyState = () => ({ ...freshState(), branchFamilyId: FAMILY });

/** Deletes the newest reply, and the reader's messages after it. */
async function dropReply(r) {
    const chat = r.host.ctx.chat;
    while (chat.length && chat.at(-1).is_user) await r.host.st.deleteMessage(chat.length - 1);
    await r.host.st.deleteMessage(chat.length - 1);
}

/** Three replies with trust 5, 7, 9 published on line L1; then the line is replaced in Delta's state (what the old reload did), and the page reloads. */
async function rotated(t) {
    const r = await rig(t, { state: familyState() });
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    await r.change(state => { state.npcs[0].trust = 7; });
    await r.host.send('Three.', 'Three reply.');
    await r.change(state => { state.npcs[0].trust = 9; });
    const former = r.live.state.timeline.lineage;
    r.live.state.timeline = { ...r.live.state.timeline, lineage: 'lg_rotated1' };
    const again = await r.reload();
    return { r, again, former };
}

test('after a line was replaced, a delete back selects a checkpoint of the former line: it is installed, the barrier comes down', async t => {
    const { again, former } = await rotated(t);
    assert.equal(again.host.registry.restore().state, 'idle');
    await dropReply(again);
    assert.equal(again.host.registry.restore().state, 'idle', 'the selection finished');
    assert.equal((await again.host.sdk.timeline.status()).state, 'idle');
    assert.equal(again.live.state.npcs[0].trust, 7, 'the former line\'s checkpoint is the state');
    assert.deepEqual(again.host.store.problems(), []);
    assert.equal(again.live.state.timeline.lineage, 'lg_rotated1', 'the chat keeps the line it has');
    assert.deepEqual(again.live.state.timeline.former, [former], 'and records the former one');
    // And the story goes on: a new reply and a change of Delta's are published on the line it has.
    await again.host.send('Three again.', 'Three again reply.');
    await again.change(state => { state.npcs[0].trust = 8; });
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.equal(again.live.state.npcs[0].trust, 8);
});

test('another chat\'s checkpoint, a forged line, a malformed line and a chat with no family are still refused', async t => {
    const r = await rig(t, { state: familyState() });
    const { participant } = r.delta;
    const lineOf = state => ({ ...state, timeline: storedTimeline({ ...timelineOf(null), lineage: state.timeline?.lineage ?? null }) });
    const refused = async (lineage, family, { index = true } = {}) => {
        const state = lineOf({ ...freshState(), ...(family ? { branchFamilyId: family } : {}), timeline: { lineage } });
        const made = buildCheckpoint({ lineage, state });
        await r.vault.put(made.id, made.doc);
        if (index) await r.vault.putIndex(lineage, { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null });
        return (await participant.prepare({ return: `rt_${lineage.slice(-6)}${family ? 'f' : 'n'}`, checkpoint: made.id, hash: made.hash })).code;
    };
    assert.equal(await refused('lg_otherone', 'another-family-id'), 'CONFLICT', 'another chat (another family), its index kept');
    assert.equal(await refused('lg_forged01', FAMILY, { index: false }), 'CONFLICT', 'a line this participant never kept');
    assert.equal(await refused('lg_BAD', FAMILY), 'CONFLICT', 'a malformed line');
    assert.equal(await refused('lg_nofamily', null), 'CONFLICT', 'a checkpoint with no family');
    // A chat with no family accepts no unrecorded line, even one with an index.
    const bare = await rig(t);
    const state = { ...freshState(), timeline: storedTimeline({ ...timelineOf(null), lineage: 'lg_keptone1' }) };
    const made = buildCheckpoint({ lineage: 'lg_keptone1', state });
    await bare.vault.put(made.id, made.doc);
    await bare.vault.putIndex('lg_keptone1', { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null });
    assert.equal((await bare.delta.participant.prepare({ return: 'rt_bare0001', checkpoint: made.id, hash: made.hash })).code, 'CONFLICT');
    assert.equal(r.live.state.timeline.former, undefined, 'nothing was recorded');
});

test('a chat that never changed its line is unchanged: no former line in its state or its checkpoints, a delete back as before', async t => {
    const r = await rig(t, { state: familyState() });
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    await r.change(state => { state.npcs[0].trust = 7; });
    const keys = Object.keys(r.live.state.timeline).sort();
    assert.deepEqual(keys, ['applied', 'identity', 'lineage', 'reserved', 'v'], 'the block it always had');
    const saved = await r.delta.participant.checkpoint({});
    assert.equal('former' in (await r.vault.get(saved.checkpoint)).state.timeline, false);
    await dropReply(r);
    assert.equal(r.host.registry.restore().state, 'idle');
    assert.equal(r.live.state.npcs[0].trust, 5);
    assert.equal('former' in r.live.state.timeline, false);
    // restoredState on one line adds nothing.
    assert.equal('former' in restoredState(r.live.state, r.live.state).timeline, false);
});

test('a line that changes under the participant in the same chat (another copy of the state adopted) is recorded as a former line', async t => {
    const r = await rig(t, { state: familyState() });
    const first = r.live.state.timeline.lineage;
    r.live.state.timeline = { ...r.live.state.timeline, lineage: 'lg_adopted1' };
    const out = await r.delta.hydrate();
    assert.equal(out.ok, true);
    assert.equal(r.live.state.timeline.lineage, 'lg_adopted1');
    assert.deepEqual(r.live.state.timeline.former, [first]);
});
