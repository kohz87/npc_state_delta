// A reload's recovery can ask the participant before Delta has loaded the chat's state (the host recovers as the chat opens). Before the load
// the state Delta holds is an empty one with no story line: the participant must not read a lineage from it, mint one and write it over the
// real one, or the vault's index of the real line (the change in flight) is never found again and the chat stays held for good.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, crash, freshState, rig } from './helpers/participant-rig.js';

/** Delta published trust 9; the page died after the host journaled it and before Delta was asked to activate it. */
async function journaledThenClosed(t) {
    const r = await rig(t);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    let image = null;
    r.hook.at = async phase => { if (phase === 'native.journaled') { image = clone(r.disk.image); throw crash(); } };
    r.live.state.npcs[0].trust = 9;
    r.delta.noteChange();
    await r.delta.flush();
    assert.notEqual(image, null, 'the page died after the journal');
    r.hook.at = async () => {};
    return { r, image, lineage: r.live.state.timeline.lineage, indexes: r.vault.indexes.size };
}

/** Delta's side of a reload: an empty state until `load()` brings the saved one (`loads` false: the load never finishes). */
function unloaded(saved, { loads = true } = {}) {
    const live = { chatKey: 'chat:avatar.png:one', state: { npcs: [] }, installs: 0, loaded: false, loadsAsked: 0, writes: 0 };
    const port = {
        readState: () => structuredClone(live.state),
        ready: () => live.loaded,
        load: async () => { live.loadsAsked += 1; if (loads) { live.state = structuredClone(saved); live.loaded = true; } },
        writeTimeline: async block => { live.writes += 1; live.state = { ...live.state, timeline: structuredClone(block) }; },
        installState: async next => { live.installs += 1; live.state = structuredClone(next); },
    };
    return { live, port };
}

test('a reload whose recovery comes before Delta loaded the chat waits for the load: same story line, the change finished, the barrier down', async t => {
    const { r, image, lineage, indexes } = await journaledThenClosed(t);
    const { live, port } = unloaded(r.live.state);
    const again = await rig(t, { vault: r.vault, image, live, hydrate: false, quiet: port });
    assert.ok(live.loadsAsked >= 1, 'the participant asked Delta to load the chat');
    assert.equal(again.live.state.timeline.lineage, lineage, 'the story line is the one the chat had');
    assert.equal(r.vault.indexes.size, indexes, 'no index of a new story line');
    assert.equal(live.writes, 0, 'no story line written');
    assert.equal(again.host.registry.restore().state, 'idle', 'the barrier is down');
    assert.equal((await again.host.sdk.timeline.status()).state, 'idle');
    assert.ok(again.host.timeline.host.journal().every(entry => entry.kind !== 'native-mutation' || entry.phase === 'done'), 'the change was finished');
    assert.equal(again.live.state.npcs[0].trust, 9);
});

test('a chat whose state cannot be loaded yet answers a retryable failure: nothing minted or written, and the next recovery finishes', async t => {
    const { r, image, lineage, indexes } = await journaledThenClosed(t);
    const saved = clone(r.live.state);
    const { live, port } = unloaded(saved, { loads: false });
    const again = await rig(t, { vault: r.vault, image, live, hydrate: false, quiet: port });
    assert.equal(again.host.registry.restore().state, 'pending', 'held while Delta has not loaded the chat');
    assert.equal(live.writes, 0, 'no story line written');
    assert.equal(r.vault.indexes.size, indexes, 'no index of a new story line');
    assert.equal(live.state.timeline, undefined, 'the empty state was not given a story line');
    const status = await again.delta.participant.status({ return: 'nm_any' });
    assert.equal(status.ok, false);
    assert.equal(status.code, 'FAILED');
    assert.match(status.message, /not loaded this chat's dossiers yet; it is tried again/);
    // Delta's load finishes; the next recovery (the next turn) finds the line and finishes the change.
    live.state = structuredClone(saved);
    live.loaded = true;
    await again.host.timeline.recover();
    assert.equal(live.state.timeline.lineage, lineage);
    assert.equal(again.host.registry.restore().state, 'idle');
    assert.equal(r.vault.indexes.size, indexes);
});

test('a port without ready() is taken as loaded (the hydrate is unchanged)', async t => {
    const r = await rig(t, { state: freshState() });
    assert.equal(typeof r.port.ready, 'undefined');
    assert.ok(r.live.state.timeline.lineage, 'the line is made as before');
});

test('the adapter wires ready() to Delta\'s stateReady and load() to its ensureFresh', async t => {
    const { adapterRig } = await import('./helpers/participant-rig.js');
    const r = await adapterRig(t);
    await r.host.send('Hello.', 'One.');
    let loaded = false;
    let asked = 0;
    r.api.stateReady = () => loaded;
    r.api.ensureFresh = async () => { asked += 1; loaded = true; return true; };
    const made = await r.host.sdk.command('savepoint.make', {});
    assert.equal(made.ok, true, made.message);
    assert.equal(asked, 1, 'the participant asked Delta to load the chat before it read it');
});
