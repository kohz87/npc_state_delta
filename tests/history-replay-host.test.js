// The fallback and the catch-up end to end on the real Story Block host (the vendored testkit, 2.24 with `restored`, `asOf`, `progress`, `skip`):
// the newest saved dossier files are missing -> the host falls back to the nearest earlier one -> tells Delta (`restored`) -> Delta reads the
// replies it missed, as of each reply, on a copy -> installs it once -> one publication. A reader's "Return here" starts no catch-up. Progress and
// Skip go through the host. The runtime's replay boundaries are a small stand-in over the rig's chat state (history-replay-wiring.test.js runs the
// real ones in the synthetic SillyTavern); the controller, the participant, the adapter and Story Block are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig, BATCH } from './helpers/participant-rig.js';

const tally = () => ({
    id: 'tally', name: 'Tally', version: '0.0.1', domains: { tally: { initial: () => ({ n: 0 }) } },
    commands: { 'tally.add'(ctx, { by }) { ctx.draft('tally').n += by; return { summary: 'Added.', narrate: false }; } },
    queries: { 'tally.value': state => state.domains.tally.n },
});

// Four replies (chat positions 1, 3, 5, 7), each with a published dossier change; the scan marker is the reply it was published at.
async function story(t) {
    const r = await adapterRig(t, { modules: [tally()] });
    const { host } = r;
    const checkpoints = [];
    const markers = [];
    const mark = async n => {
        const id = host.store.headIndex();
        markers.push(id);
        await r.published(state => { state.npcs[0].trust = 3 + n; state.lastScannedMessageId = id; });
        checkpoints.push((await host.sdk.timeline.status()).participants[0].checkpoint);
    };
    await host.send('One.', 'First.');
    assert.equal((await host.sdk.timeline.make({ kind: 'manual', name: 'Start' })).ok, true);
    await host.sdk.command('tally.add', { by: 1 });
    await mark(1);
    for (const [index, word] of ['Second', 'Third', 'Fourth'].entries()) {
        await host.send(`${word}.`, `${word} reply.`);
        await host.sdk.command('tally.add', { by: index + 2 });
        await mark(index + 2);
    }
    return { ...r, checkpoints, markers };
}

/** The runtime's replay boundaries over the rig's state: each reply adds one to the first dossier's trust and notes what Story Block said as of it. */
function boundaries(r, log) {
    const { host, live } = r;
    const replies = () => host.ctx.chat.flatMap((message, index) => (message && !message.is_user ? [index] : []));
    return {
        state: () => live.state,
        pending: () => {
            const after = Number.isInteger(live.state.lastScannedMessageId) ? live.state.lastScannedMessageId : -1;
            return { ids: replies().filter(id => id > after), marker: after >= 0 ? after : null };
        },
        all: replies,
        active: ids => ids.every(id => replies().includes(id)),
        copy: () => structuredClone(live.state),
        empty: () => ({ npcs: [{ ...live.state.npcs[0], trust: 3 }], socialGraph: { edges: [] }, checkpoints: [], lineage: [], turn: 1 }),
        markRead: (state, id) => Object.assign(state, { lastScannedMessageId: id }),
        head: () => ({ key: live.chatKey, length: host.ctx.chat.length, last: host.ctx.chat.at(-1), swipe: 0, state: JSON.stringify(live.state.npcs) }),
        install: async state => { log.installs.push(structuredClone(state)); await r.api.installState(state); },
        writeCatchUp: async field => { if (field) live.state.catchUp = field; else delete live.state.catchUp; },
        markReadLive: async id => { live.state.lastScannedMessageId = id; delete live.state.catchUp; },
        reply: async (copy, id) => {
            log.replies.push(id);
            if (log.gate) await log.gate.promise;
            copy.npcs[0].trust += 1;
            copy.lastScannedMessageId = id;
            copy.reads = [...(copy.reads ?? []), host.sdk.query('tally.value', { asOf: id })];
        },
    };
}
const journalOf = (host, kind) => host.timeline.host.journal().filter(entry => entry.kind === kind);
const waitFor = async (check, what) => {
    for (let i = 0; i < 300; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`timed out: ${what}`);
};
const dropNewestReply = async r => {
    const chat = r.host.ctx.chat;
    while (chat.length && chat.at(-1).is_user) await r.host.st.deleteMessage(chat.length - 1);
    await r.host.st.deleteMessage(chat.length - 1);
};

test('missing newest checkpoints -> fallback -> restored -> catch-up as of each reply -> install -> one publication', async t => {
    const r = await story(t);
    const log = { replies: [], installs: [] };
    r.api.replay = boundaries(r, log);
    // The head is reply 5 after the delete; its file and the one before it are gone, so the host walks back to the file at reply 1.
    for (const id of r.checkpoints.slice(1)) r.vault.lose(id);
    await dropNewestReply(r);
    const nativeBefore = journalOf(r.host, 'native-mutation').length;
    const head = r.host.store.headIndex();
    await waitFor(() => r.host.timeline.host.progress()?.outcome === 'done', 'the catch-up to finish');
    const selection = journalOf(r.host, 'selection').find(entry => entry.fell);
    assert.ok(selection, 'the host fell back');
    // Delta read the replies after the restored point, oldest first, once each (the greeting and the older replies are not read again)
    const wanted = r.host.ctx.chat.flatMap((message, index) => (!message.is_user && index > r.markers[0] ? [index] : []));
    assert.equal(wanted.length, 2);
    assert.deepEqual(log.replies, wanted);
    assert.equal(log.installs.length, 1, 'installed once, at the end');
    assert.equal(r.live.state.npcs[0].trust, 4 + 2, 'the restored dossier at the first mark (4) plus one per reply read');
    // each reply saw Story Block as of that reply, not as of the head
    assert.deepEqual(r.live.state.reads, wanted.map(id => r.host.sdk.query('tally.value', { asOf: id })));
    assert.ok(r.live.state.reads[0] < r.host.sdk.query('tally.value'), 'the first reply was not read at the head');
    assert.equal(r.live.state.reads.at(-1), r.host.sdk.query('tally.value'), 'the last reply is the head');
    assert.equal(r.host.store.headIndex(), head, 'the head did not move');
    // exactly one publication for the whole catch-up
    await waitFor(() => journalOf(r.host, 'native-mutation').length > nativeBefore, 'the publication');
    await r.sleep(30);
    assert.equal(journalOf(r.host, 'native-mutation').length, nativeBefore + 1);
    assert.equal(r.host.registry.restore().state, 'idle');
    assert.deepEqual(r.host.timeline.host.progress() && { reason: r.host.timeline.host.progress().reason, active: r.host.timeline.host.progress().active, outcome: r.host.timeline.host.progress().outcome },
        { reason: 'fallback', active: false, outcome: 'done' });
    assert.deepEqual(r.host.store.problems().filter(problem => problem.code !== 'SELECTION_FELL'), []);
});

test('progress goes through the host while it reads, and Skip keeps the dossiers as restored and marks the replies read', async t => {
    const r = await story(t);
    let open;
    const log = { replies: [], installs: [], gate: { promise: new Promise(resolve => { open = resolve; }) } };
    r.api.replay = boundaries(r, log);
    for (const id of r.checkpoints.slice(1)) r.vault.lose(id);
    await dropNewestReply(r);
    await r.host.sdk.timeline.status();
    await waitFor(() => r.host.timeline.host.progress()?.active === true, 'the catch-up to start');
    const reading = r.host.timeline.host.progress();
    assert.equal(reading.reason, 'fallback');
    assert.equal(reading.total, 2);
    assert.equal(reading.older, 0);
    assert.equal(reading.from, r.markers[0], 'restored to the dossiers of the first marked reply');
    assert.equal(reading.outcome, null);
    await waitFor(() => log.replies.length === 1, 'the first reply to be under way');
    assert.deepEqual(await r.host.timeline.host.skip('npc-state-delta'), { ok: true });
    open();
    await waitFor(() => r.host.timeline.host.progress()?.outcome === 'skipped', 'the skip');
    assert.equal(log.installs.length, 0, 'nothing was installed');
    assert.equal(r.live.state.npcs[0].trust, 4, 'the dossiers stay as they were restored');
    assert.equal(r.live.state.lastScannedMessageId, r.host.store.headIndex(), 'the skipped replies are marked read');
    assert.equal(r.host.timeline.host.progress().active, false);
});

test('Return here is exact: no catch-up, nothing read', async t => {
    const r = await story(t);
    const log = { replies: [], installs: [] };
    r.api.replay = boundaries(r, log);
    const point = (await r.host.sdk.timeline.list()).points?.[0] ?? (await r.host.sdk.timeline.list())[0];
    assert.ok(point, 'a save point');
    assert.equal((await r.host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await r.host.sdk.timeline.head();
    const prepared = await r.host.timeline.host.prepare({ snapshot: point.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    assert.equal((await r.host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash })).status, 'complete');
    await r.sleep(60);
    assert.deepEqual(log.replies, []);
    assert.equal(log.installs.length, 0);
    const progress = r.host.timeline.host.progress();
    assert.ok(!progress || (progress.active === false && progress.outcome === null), 'no catch-up ran');
});
