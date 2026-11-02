// "Return here" opens a branch while Delta may still be publishing its last change in the chat before. The publication belongs to that chat:
// once another chat is open it stops, and it never hydrates the new one. And a branch waiting for its parent's dossiers (no file of its own,
// a main chat in its metadata) gets no story line minted before Delta's branch inheritance has run: a line written first would cost the branch
// its dossiers and its parent's checkpoints. A new chat that is not a branch mints its line as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParticipant, memoryVault } from '../src/storysuite-participant/index.js';
import { freshState, npc } from './helpers/participant-rig.js';

const HEAD = { ok: true, headHash: 'a'.repeat(64), cursor: { sid: 'sr_1', swipeKey: 'sw_1', block: 'bl_1', op: 1, rev: 1 }, source: { sid: 'sr_1', swipeKey: 'sw_1', evidence: 'e', ordinal: 0 } };

function setup({ state = freshState(), chatKey = 'chat:avatar.png:one', extra = {} } = {}) {
    const live = { chatKey, state, writes: [], states: { [chatKey]: state } };
    const port = {
        chatKey: () => live.chatKey,
        readState: () => structuredClone(live.states[live.chatKey] ?? { npcs: [] }),
        installState: async next => { live.states[live.chatKey] = structuredClone(next); },
        writeTimeline: async block => { live.writes.push({ key: live.chatKey, lineage: block.lineage }); live.states[live.chatKey] = { ...live.states[live.chatKey], timeline: structuredClone(block) }; },
        ...extra,
    };
    const vault = memoryVault();
    const delta = createParticipant({ port, vault, debounceMs: 1, retryMs: 5 });
    return { live, port, vault, delta };
}

test('a publication answered STALE because another chat was opened stops there: no retry, and the new chat is not hydrated', async () => {
    const { live, delta, vault } = setup();
    assert.equal((await delta.hydrate()).ok, true);
    const indexes = vault.indexes.size;
    let asked = 0;
    delta.participant.attach({
        head: async () => HEAD,
        nativeMutation: async () => {
            asked += 1;
            // "Return here": the branch opens (empty until Delta's inheritance runs) while the host refuses the change of the chat before.
            live.chatKey = 'chat:avatar.png:branch';
            live.states[live.chatKey] = { npcs: [] };
            return { ok: false, code: 'STALE', message: 'The head moved.' };
        },
    });
    live.states['chat:avatar.png:one'].npcs[0].trust = 9;
    delta.noteChange();
    const out = await delta.flush();
    assert.equal(out.ok, true, 'not a failure to tell');
    assert.equal(out.left, true);
    assert.equal(asked, 1, 'not retried');
    assert.deepEqual(live.writes.filter(write => write.key === 'chat:avatar.png:branch'), [], 'nothing written into the new chat');
    assert.equal(live.states['chat:avatar.png:branch'].timeline, undefined, 'no line minted for it');
    assert.equal(vault.indexes.size, indexes, 'no index of a new line');
});

test('a publication whose prepare would run after another chat was opened does not hydrate it either', async () => {
    const { live, delta } = setup();
    await delta.hydrate();
    delta.participant.attach({
        head: async () => HEAD,
        nativeMutation: async input => {
            live.chatKey = 'chat:avatar.png:branch';
            live.states[live.chatKey] = { npcs: [] };
            try { await input.prepare(); } catch (error) { return { ok: false, code: 'FAILED', message: error.message }; }
            return { ok: false, code: 'FAILED', message: 'prepared in the wrong chat' };
        },
    });
    live.states['chat:avatar.png:one'].npcs[0].trust = 9;
    delta.noteChange();
    const out = await delta.flush();
    assert.equal(out.left, true);
    assert.deepEqual(live.writes.filter(write => write.key === 'chat:avatar.png:branch'), []);
});

test('a branch with a main chat and no file of its own is left to Delta\'s inheritance: it gets the parent\'s line, nothing is minted', async () => {
    const parent = { ...freshState(), branchFamilyId: 'fam-parent', timeline: { v: 1, lineage: 'lg_parent01', identity: { map: {} }, reserved: [], applied: {} } };
    let pending = true;
    let inherits = 0;
    const { live, delta } = setup({ state: { npcs: [] }, chatKey: 'chat:avatar.png:branch', extra: {
        branchPending: () => pending,
        inheritBranch: async () => { inherits += 1; live.states[live.chatKey] = structuredClone(parent); pending = false; return true; },
    } });
    const out = await delta.hydrate();
    assert.equal(out.ok, true, out.message);
    assert.equal(inherits, 1, 'the inheritance was asked to run');
    assert.equal(out.lineage, 'lg_parent01', 'the parent\'s line');
    assert.equal(live.states[live.chatKey].timeline.lineage, 'lg_parent01');
    assert.equal(live.states[live.chatKey].npcs.length, 2, 'the parent\'s dossiers');
    assert.ok(live.writes.every(write => write.lineage === 'lg_parent01'), 'no other line written');
});

test('a branch still waiting answers a retryable failure and writes nothing; once the inheritance has run (even with nothing to carry) it mints', async () => {
    let pending = true;
    const { live, delta } = setup({ state: { npcs: [] }, chatKey: 'chat:avatar.png:branch', extra: {
        branchPending: () => pending,
        inheritBranch: async () => false,
    } });
    const first = await delta.hydrate();
    assert.equal(first.ok, false);
    assert.equal(first.code, 'FAILED');
    assert.match(first.message, /still carrying the parent chat's dossiers into this branch; it is tried again/);
    assert.deepEqual(live.writes, []);
    pending = false;   // the inheritance ran and found nothing to carry: the branch is a chat of its own
    const second = await delta.hydrate();
    assert.equal(second.ok, true);
    assert.match(live.states[live.chatKey].timeline.lineage, /^lg_[0-9a-z]{8}$/);
});

test('a new chat that is not a branch mints its line as before', async () => {
    let inherits = 0;
    const { live, delta } = setup({ state: { npcs: [npc('npc_a', 'A')] }, chatKey: 'chat:avatar.png:new', extra: {
        branchPending: () => false,
        inheritBranch: async () => { inherits += 1; },
    } });
    const out = await delta.hydrate();
    assert.equal(out.ok, true);
    assert.equal(inherits, 0);
    assert.match(live.states[live.chatKey].timeline.lineage, /^lg_[0-9a-z]{8}$/);
    assert.equal(live.writes.length, 1);
});

test('the adapter wires branchPending() and inheritBranch() to Delta\'s runtime', async t => {
    const { adapterRig } = await import('./helpers/participant-rig.js');
    const r = await adapterRig(t, { state: { npcs: [] } });
    await r.host.send('Hello.', 'One.');
    let pending = true;
    let inherits = 0;
    r.api.branchPending = () => pending;
    r.api.inheritBranch = async () => { inherits += 1; r.live.state = { ...freshState(), timeline: { v: 1, lineage: 'lg_parent02', identity: { map: {} }, reserved: [], applied: {} } }; pending = false; return true; };
    const made = await r.host.sdk.command('savepoint.make', {});
    assert.equal(made.ok, true, made.message);
    assert.equal(inherits, 1);
    assert.equal(r.live.state.timeline.lineage, 'lg_parent02');
});
