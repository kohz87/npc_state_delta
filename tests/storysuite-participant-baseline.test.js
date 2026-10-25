// The checkpoint the story stands on (the baseline of a native change) is verified before a change is published on it. When its bytes are gone
// or are not the ones recorded, the change is refused with a Problem and nothing is published: the participant never makes a baseline up from
// the new state, which would tell the story it stood where it did not (docs/dev/storysuite-participant.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/participant-rig.js';

async function twoChanges(t, options) {
    const r = await rig(t, options);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    return r;
}

/** Publishes a change now and answers the participant's word on it. */
async function tryChange(r, trust) {
    r.live.state.npcs[0].trust = trust;
    r.delta.noteChange();
    return r.delta.flush();
}

const standing = async r => (await r.host.sdk.timeline.status()).participants[0];

test('a baseline whose bytes are gone is refused with a Problem; nothing is published', async t => {
    const r = await twoChanges(t);
    const before = await standing(r);
    const head = (await r.host.sdk.timeline.head()).headHash;
    r.vault.lose(r.delta.index().base.checkpoint);
    const out = await tryChange(r, 6);
    assert.equal(out.ok, false);
    assert.match(out.message, /story stands on/i);
    assert.equal(r.warnings.length > 0, true, 'a Problem is told');
    assert.match(r.warnings.at(-1), /not usable|gone/);
    assert.deepEqual(await standing(r), before, 'the story still stands on the checkpoint it stood on');
    assert.equal((await r.host.sdk.timeline.head()).headHash, head, 'the head did not move');
    assert.equal(r.trust(), 6, 'Delta\'s own state is not touched');
});

test('a baseline whose bytes are not the recorded ones is refused the same way', async t => {
    const r = await twoChanges(t);
    const before = await standing(r);
    const id = r.delta.index().base.checkpoint;
    const doc = JSON.parse(r.vault.docs.get(id));
    doc.state.npcs[0].trust = 77;
    r.vault.docs.set(id, JSON.stringify(doc));
    const out = await tryChange(r, 6);
    assert.equal(out.ok, false);
    assert.equal(r.warnings.length > 0, true);
    assert.match(r.warnings.at(-1), /another hash|not the one/);
    assert.deepEqual(await standing(r), before);
});

test('an edit made through the handle is refused on a damaged baseline as well', async t => {
    const r = await twoChanges(t);
    const before = await standing(r);
    r.vault.lose(r.delta.index().base.checkpoint);
    const source = r.host.store.sourceAt(r.host.store.headIndex());
    const out = await r.delta.nativeChange({ source, edit: state => { state.npcs[0].trust = 8; } });
    assert.equal(out.ok, false);
    assert.equal(r.warnings.length > 0, true);
    assert.deepEqual(await standing(r), before);
    assert.equal(r.trust(), 5, 'the edit was made on a copy: the live state is as it was');
});

test('after a reload and a rebuild the damaged baseline is still refused, and an intact one still publishes', async t => {
    const r = await twoChanges(t);
    r.vault.lose(r.delta.index().base.checkpoint);
    const again = await r.reload();
    again.host.store.rebuild();
    await again.host.timeline.host.recover();
    const before = await standing(again);
    const out = await tryChange(again, 6);
    assert.equal(out.ok, false);
    assert.equal(again.warnings.length > 0, true);
    assert.deepEqual(await standing(again), before);

    // The control: the same story with its baseline intact publishes the same change.
    const fine = await twoChanges(t);
    const moved = await standing(fine);
    const published = await tryChange(fine, 6);
    assert.equal(published.ok, true, published.message);
    assert.notEqual((await standing(fine)).checkpoint, moved.checkpoint);
    assert.equal(fine.warnings.length, 0);
    const reloaded = await fine.reload();
    reloaded.host.store.rebuild();
    await reloaded.host.timeline.host.recover();
    assert.equal((await tryChange(reloaded, 7)).ok, true);
});
