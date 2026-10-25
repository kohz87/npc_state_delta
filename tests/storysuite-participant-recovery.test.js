// Recovery acknowledges an in-place publication only after the journal-selected bytes are the live state: a change Delta published after
// the fact is activated by the host from the journal (docs/v2/TIMELINE.md "Recovery"), and when the live state is not what the journal
// selected (a write that never reached the file) the selected bytes are installed durably and looked at again before the acknowledgement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, crash, hashJson, rig } from './helpers/participant-rig.js';

/**
 * Delta published trust 9 at the head and the process died after the host journaled it, before it asked Delta to activate. The file the
 * chat is reloaded from is the last save; Delta's own state file is the one the test hands over (`liveTrust`).
 */
async function crashed(t, { liveTrust = 3 } = {}) {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    let image = null;
    r.hook.at = async phase => { if (phase === 'native.journaled') { image = clone(r.disk.image); throw crash(); } };
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    await r.delta.flush();
    assert.notEqual(image, null, 'the process died after the journal');
    r.hook.at = async () => {};
    r.live.state.npcs[0].trust = liveTrust;
    const again = await rig(t, { vault: r.vault, image, live: r.live, hydrate: false });
    return { r, again, image };
}

const selected = async host => (await host.sdk.timeline.status()).participants[0];

test('recovery installs the selected bytes when the live state is not what the journal selected: trust 3 live, trust 9 selected', async t => {
    const { again } = await crashed(t);
    assert.equal(again.live.state.npcs[0].trust, 9, 'the selected bytes are the live state');
    assert.equal(again.live.installs, 1);
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.deepEqual(again.host.store.problems(), []);
    assert.deepEqual(again.warnings, []);
    const standing = await selected(again.host);
    assert.equal(standing.checkpoint, again.delta.index().base.checkpoint);
    assert.equal(standing.hash, again.delta.index().base.hash);
    assert.deepEqual(again.delta.participant.current({ checkpoint: standing.checkpoint, hash: standing.hash, schema: 1 }), { ok: true, current: true }, 'the commit probe agrees');
});

test('a live state that already is the selected bytes is acknowledged as it is, nothing installed', async t => {
    const { again } = await crashed(t, { liveTrust: 9 });
    assert.equal(again.live.state.npcs[0].trust, 9);
    assert.equal(again.live.installs, 0);
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.deepEqual(again.host.store.problems(), []);
});

test('an install that cannot be saved is not acknowledged: the barrier holds and the retry installs', async t => {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    let image = null;
    r.hook.at = async phase => { if (phase === 'native.journaled') { image = clone(r.disk.image); throw crash(); } };
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    await r.delta.flush();
    r.live.state.npcs[0].trust = 3;
    r.live.failInstall = 1;
    const again = await rig(t, { vault: r.vault, image, live: r.live, hydrate: false });
    assert.equal(again.host.registry.restore().state, 'pending', 'not acknowledged: the barrier is up');
    assert.equal(again.live.state.npcs[0].trust, 3);
    const recovered = await again.host.timeline.host.recover();
    assert.equal(recovered.state, 'idle');
    assert.equal(again.live.state.npcs[0].trust, 9);
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.deepEqual(again.host.store.problems(), []);
});

test('a newer change of Delta\'s own that landed after the publication was prepared is not overwritten by the older bytes, and is published next', async t => {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    let landed = false;
    r.hook.at = async phase => {
        if (phase === 'native.journaled' && !landed) {
            landed = true;
            r.live.state.npcs[0].trust = 8;
            r.delta.noteChange();
        }
    };
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    const out = await r.delta.flush();
    assert.equal(out.ok, true, out.message);
    assert.equal(landed, true);
    assert.equal(r.live.state.npcs[0].trust, 8, 'the newer change is still there');
    assert.equal(r.live.installs, 0);
    assert.equal((await r.delta.flush()).ok, true);
    const standing = await selected(r.host);
    assert.equal(standing.checkpoint, r.delta.index().base.checkpoint, 'and the story stands on it once it is published');
    assert.equal(r.delta.index().base.stateHash, hashJson(r.live.state));
});

test('after another reload and a rebuild the selected bytes are the live state and the story stands on them', async t => {
    const { again } = await crashed(t);
    again.host.store.rebuild();
    assert.equal((await again.host.timeline.host.recover()).state, 'idle');
    const standing = await selected(again.host);
    const next = await again.reload();
    assert.equal(next.live.state.npcs[0].trust, 9);
    assert.equal(next.host.registry.restore().state, 'idle');
    assert.deepEqual(await selected(next.host), standing);
    assert.deepEqual(next.host.store.problems(), []);
    assert.equal(next.live.installs, again.live.installs, 'nothing is installed again');
});

/** The change Delta announces while the checkpoint of a publication is being uploaded: trust 8 lands after trust 9 was read. */
async function announcedDuringUpload(t, { crashAfter = false } = {}) {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    let image = null;
    if (crashAfter) r.hook.at = async phase => { if (phase === 'native.journaled') { image = clone(r.disk.image); throw crash(); } };
    const put = r.vault.put.bind(r.vault);
    let armed = true;
    r.vault.put = async (id, doc) => {
        await put(id, doc);
        if (armed && doc.state.npcs[0].trust === 9) {
            armed = false;
            r.live.state.npcs[0].trust = 8;
            r.delta.noteChange();
        }
    };
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    const out = await r.delta.flush();
    r.vault.put = put;
    return { r, out, image };
}

test('a change announced while the checkpoint is being uploaded is not overwritten by the selected bytes: it ends live and is published', async t => {
    const { r, out } = await announcedDuringUpload(t);
    assert.equal(out.ok, true, out.message);
    assert.equal((await r.delta.flush()).ok, true);
    assert.equal(r.live.state.npcs[0].trust, 8, 'trust 8 is live');
    assert.equal(r.live.installs, 0, 'nothing was installed over it');
    assert.equal(r.host.registry.restore().state, 'idle');
    assert.deepEqual(r.host.store.problems(), []);
    assert.deepEqual(r.warnings, []);
    const standing = await selected(r.host);
    assert.equal(standing.checkpoint, r.delta.index().base.checkpoint, 'and the story stands on a checkpoint that has it');
    assert.equal(r.delta.index().base.stateHash, hashJson(r.live.state));
    const next = await r.reload();
    next.host.store.rebuild();
    await next.host.timeline.host.recover();
    assert.equal(next.live.state.npcs[0].trust, 8);
    assert.deepEqual(await selected(next.host), standing);
});

test('and after a restart that finds the publication in the journal, the newer change is still there', async t => {
    const { r, image } = await announcedDuringUpload(t, { crashAfter: true });
    assert.notEqual(image, null);
    assert.equal(r.live.state.npcs[0].trust, 8);
    r.hook.at = async () => {};
    const again = await rig(t, { vault: r.vault, image, live: r.live, hydrate: false });
    assert.equal(again.live.state.npcs[0].trust, 8, 'the selected 9 did not replace the newer 8');
    assert.equal(again.live.installs, 0);
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.deepEqual(again.host.store.problems(), []);
    assert.equal((await again.delta.flush()).ok, true);
    assert.equal(again.delta.index().base.stateHash, hashJson(again.live.state), 'and it is published on the baseline');
    assert.equal((await selected(again.host)).checkpoint, again.delta.index().base.checkpoint);
    again.host.store.rebuild();
    await again.host.timeline.host.recover();
    assert.equal(again.live.state.npcs[0].trust, 8);
});
