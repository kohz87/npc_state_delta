// An empty branch (no story line, no dossiers) that the host asks to prepare a journal-selected checkpoint adopts that checkpoint's line
// instead of minting a new one. A chat with dossiers or a line is never changed, and a bad file never gives a line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineOf } from '../src/storysuite-participant/index.js';
import { keep, makeDelta, npc } from './helpers/p24-port.js';

const JOURNAL = 'lg_jrnlline';

test('an empty branch adopts the journal line on prepare and activate installs the checkpoint on it', async () => {
    const r = makeDelta({ state: { npcs: [] } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [npc('npc_a', 'Mira')] });
    const prepared = await r.delta.participant.prepare({ return: 'rt_adopt0001', checkpoint: cp.id, hash: cp.hash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal(timelineOf(r.live.state).lineage, JOURNAL, 'the journal\'s line, not a minted one');
    const active = await r.delta.participant.activate({ return: 'rt_adopt0001', prepared: prepared.prepared });
    assert.equal(active.ok, true, active.message);
    assert.deepEqual(r.live.state.npcs.map(person => person.name), ['Mira']);
    assert.equal(timelineOf(r.live.state).lineage, JOURNAL);
    assert.equal(r.delta.index().selected, cp.id);
});

test('a branch with dossiers never adopts: the checkpoint of another line is refused as before', async () => {
    const r = makeDelta({ state: { npcs: [npc('npc_a', 'Mira')] } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [] });
    const out = await r.delta.participant.prepare({ return: 'rt_full00001', checkpoint: cp.id, hash: cp.hash });
    assert.equal(out.code, 'CONFLICT');
    assert.notEqual(timelineOf(r.live.state).lineage, JOURNAL);
});

test('a chat that already has a line keeps it', async () => {
    const r = makeDelta({ state: { npcs: [], timeline: { v: 1, lineage: 'lg_ownline1' } } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [] });
    const out = await r.delta.participant.prepare({ return: 'rt_lined0001', checkpoint: cp.id, hash: cp.hash });
    assert.equal(out.code, 'CONFLICT');
    assert.equal(timelineOf(r.live.state).lineage, 'lg_ownline1');
});

test('a missing file, a wrong hash or a malformed line fails without minting a line', async () => {
    const r = makeDelta({ state: { npcs: [] } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [] });
    const gone = await r.delta.participant.prepare({ return: 'rt_gone00001', checkpoint: 'nk_gone0001', hash: cp.hash });
    assert.equal(gone.code, 'SNAPSHOT_UNAVAILABLE');
    assert.equal(timelineOf(r.live.state).lineage, null);
    assert.equal(r.writes.timeline, 0);

    const r2 = makeDelta({ state: { npcs: [] } });
    const cp2 = await keep(r2.vault, JOURNAL, { npcs: [] });
    assert.equal((await r2.delta.participant.prepare({ return: 'rt_hash00001', checkpoint: cp2.id, hash: 'e'.repeat(64) })).code, 'CONFLICT');
    assert.equal(timelineOf(r2.live.state).lineage, null, 'a doc that fails the hash check never gives a line');

    const r3 = makeDelta({ state: { npcs: [] } });
    const bad = await keep(r3.vault, 'lg_BAD', { npcs: [] });
    await r3.delta.participant.prepare({ return: 'rt_badline01', checkpoint: bad.id, hash: bad.hash });
    assert.equal(timelineOf(r3.live.state).lineage, null);
});

test('an empty branch can select an earlier checkpoint after the newest one is missing', async () => {
    const r = makeDelta({ state: { npcs: [] } });
    const earlier = await keep(r.vault, JOURNAL, { npcs: [npc('npc_a', 'Mira')] });
    const missing = await r.delta.participant.prepare({ return: 'rt_select001', checkpoint: 'nk_gone0001', hash: earlier.hash });
    assert.equal(missing.code, 'SNAPSHOT_UNAVAILABLE');
    assert.equal((await r.delta.participant.verify({ checkpoint: earlier.id, hash: earlier.hash })).ok, true);
    const prepared = await r.delta.participant.prepare({ return: 'rt_select001', checkpoint: earlier.id, hash: earlier.hash });
    assert.equal(prepared.ok, true, prepared.message);
    const active = await r.delta.participant.activate({ return: 'rt_select001', prepared: prepared.prepared });
    assert.equal(active.ok, true, active.message);
    assert.equal(timelineOf(r.live.state).lineage, JOURNAL);
    assert.deepEqual(r.live.state.npcs.map(person => person.name), ['Mira']);
});

test('a dossier added while the selected checkpoint is read is not overwritten by lineage adoption', async () => {
    const r = makeDelta({ state: { npcs: [] } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [] });
    const get = r.vault.get.bind(r.vault);
    r.vault.get = async id => {
        const doc = await get(id);
        r.live.state.npcs.push(npc('npc_b', 'Briar'));
        return doc;
    };
    const out = await r.delta.participant.prepare({ return: 'rt_race00001', checkpoint: cp.id, hash: cp.hash });
    assert.equal(out.code, 'STALE');
    assert.equal(timelineOf(r.live.state).lineage, null);
    assert.deepEqual(r.live.state.npcs.map(person => person.name), ['Briar']);
    assert.equal(r.writes.timeline, 0);
});

test('a read that throws is not turned into a new line', async () => {
    const r = makeDelta({ state: { npcs: [] } });
    const cp = await keep(r.vault, JOURNAL, { npcs: [] });
    r.vault.get = async () => { throw new Error('the file could not be read (test)'); };
    const out = await r.delta.participant.prepare({ return: 'rt_throw0001', checkpoint: cp.id, hash: cp.hash });
    assert.equal(out.ok, false);
    assert.equal(timelineOf(r.live.state).lineage, null, 'nothing was minted over a failed read');
});
