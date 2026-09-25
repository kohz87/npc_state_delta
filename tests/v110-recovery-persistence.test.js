import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, applyStaleNpcLifecycle } from '../core.js';
import { applyStaleNpcLifecycle as mechanicsLifecycle } from '../core-mechanics.js';
import { ensureRollbackJournalBaseline, ensureBranchParentAnchor, recordBranchCheckpoint, reconcileBranchState, pruneRollbackJournal } from '../branch.js';
import { writeNpcStateDataFile, readNpcStateDataFile, undurableNpcStateSnapshot, pendingNpcStateDurabilityKeys, cancelPendingNpcStateWrite, retireNpcStateDataFile, encodeStateFilePayload } from '../storage.js';

const immediate = resolve => resolve();
const rejection = status => ({ ok: false, status, text: async () => 'synthetic rejection' });
const message = (id, user = false) => ({ mes: `story-${id}`, name: user ? 'User' : 'Narrator', is_user: user, is_system: false });
function baseline() {
    const npc = createNpcRecord('Ryu');
    npc.manual = false;
    npc.mood = 'baseline';
    const state = { npcs: [npc], turn: 0, assistantSinceScan: 0, checkpoints: [], lineage: [], branchLineageVersion: 4 };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

for (const transient of [0, 6]) test(`recovery retains turn 56 after ${transient} transient attempts and permanent rejection, then flushes`, async () => {
    const chatKey = `chat:hotfix-transition-${transient}`;
    let calls = 0;
    const delays = [];
    await assert.rejects(writeNpcStateDataFile({ chatKey, state: { turn: 56 },
        fetchFn: async () => rejection(++calls <= transient ? 503 : 413),
        sleepFn: resolve => { delays.push(true); resolve(); },
    }), error => error.status === 413);
    assert.equal(calls, transient + 1);
    assert.equal(delays.length, transient);
    assert.ok(pendingNpcStateDurabilityKeys().includes(chatKey));
    const recovered = await readNpcStateDataFile(null, { expectedChatKey: chatKey, fetchFn: () => assert.fail('recovery must avoid disk') });
    assert.equal(recovered.undurable, true);
    assert.equal(recovered.state.turn, 56);
    let durable;
    let durableJson = '';
    await writeNpcStateDataFile({ chatKey, state: recovered.state, fetchFn: async (url, options = {}) => {
        if (url === '/synthetic') return { ok: true, status: 200, text: async () => durableJson };
        durableJson = Buffer.from(JSON.parse(options.body).data, 'base64').toString();
        durable = JSON.parse(durableJson);
        return { ok: true, status: 200, json: async () => ({ path: '/synthetic' }), text: async () => '' };
    } });
    assert.equal(durable.state.turn, 56);
    assert.equal(undurableNpcStateSnapshot(chatKey), null);
    assert.equal(pendingNpcStateDurabilityKeys().includes(chatKey), false);
});

test('in-flight recovery reads and terminal failure retain newer accepted mutations', async () => {
    const chatKey = 'chat:hotfix-newer';
    let current = { turn: 56 };
    let reject;
    const task = writeNpcStateDataFile({ chatKey, state: structuredClone(current), recoveryState: () => current,
        fetchFn: () => new Promise(resolve => { reject = resolve; }) });
    while (!reject) await new Promise(resolve => setImmediate(resolve));
    current = { turn: 57, npcs: [{ id: 'new' }] };
    const pending = await readNpcStateDataFile(null, { expectedChatKey: chatKey });
    assert.equal(pending.undurable, true);
    assert.deepEqual(pending.state, current);
    reject(rejection(413));
    await assert.rejects(task, error => error.status === 413);
    assert.deepEqual(undurableNpcStateSnapshot(chatKey).state, current);
    cancelPendingNpcStateWrite(chatKey);
});

for (const exit of ['cancel', 'owner', 'retire']) for (const transient of [0, 6]) {
    test(`${exit} during attempt ${transient + 1} cannot resurrect recovery`, async () => {
        const chatKey = `chat:hotfix-${exit}-${transient}`;
        let calls = 0, release, current = true;
        const task = writeNpcStateDataFile({ chatKey, state: { turn: 56 }, isCurrent: () => current, sleepFn: immediate,
            fetchFn: async () => ++calls <= transient ? rejection(503) : new Promise(resolve => { release = resolve; }) });
        while (!release) await new Promise(resolve => setImmediate(resolve));
        let retirement;
        if (exit === 'owner') current = false;
        else if (exit === 'retire') {
            let retiredJson = '';
            retirement = retireNpcStateDataFile({ chatKey, fetchFn: async (url, options = {}) => {
                if (url === '/retired') return { ok: true, status: 200, text: async () => retiredJson };
                retiredJson = Buffer.from(JSON.parse(options.body).data, 'base64').toString();
                return { ok: true, status: 200, json: async () => ({ path: '/retired' }), text: async () => '' };
            } });
        } else cancelPendingNpcStateWrite(chatKey);
        release(rejection(413));
        await assert.rejects(task);
        if (retirement) await retirement;
        assert.equal(undurableNpcStateSnapshot(chatKey), null);
        assert.equal(pendingNpcStateDurabilityKeys().includes(chatKey), false);
    });
}

test('revision conflict after retry is recoverable without bypassing the remote revision', async () => {
    const chatKey = 'chat:hotfix-conflict';
    const pointer = { path: '/conflict', revision: 1 };
    let uploads = 0;
    const fetchFn = async url => url === pointer.path
        ? { ok: true, text: async () => encodeStateFilePayload(chatKey, { turn: 1 }, '', { revision: uploads < 6 ? 1 : 2 }) }
        : (uploads++, rejection(503));
    await assert.rejects(writeNpcStateDataFile({ chatKey, state: { turn: 56 }, pointer, fetchFn, sleepFn: immediate }), { code: 'NPC_STATE_WRITE_CONFLICT' });
    assert.equal(undurableNpcStateSnapshot(chatKey).state.turn, 56);
    const recovered = await readNpcStateDataFile(pointer, { expectedChatKey: chatKey });
    assert.equal(pointer.revision, 1);
    await assert.rejects(writeNpcStateDataFile({ chatKey, state: recovered.state, pointer, fetchFn }), { code: 'NPC_STATE_WRITE_CONFLICT' });
    assert.equal(uploads, 6);
    cancelPendingNpcStateWrite(chatKey);
});

test('missing fetch also retains an accepted unsaved snapshot', async () => {
    const chatKey = 'chat:hotfix-no-fetch';
    await assert.rejects(writeNpcStateDataFile({ chatKey, state: { turn: 56 }, fetchFn: null }), /unavailable/);
    assert.equal(undurableNpcStateSnapshot(chatKey).state.turn, 56);
    cancelPendingNpcStateWrite(chatKey);
});

for (const netZero of [false, true]) test(`sibling revisits preserve immutable parent history (net-zero=${netZero})`, () => {
    let state = baseline();
    const parent = [message(0)];
    state.npcs[0].mood = 'A';
    recordBranchCheckpoint(state, parent, 0, 'scan');
    const original = structuredClone(state.rollbackJournal[0]);
    const branchA = [...parent, message('1-A')];
    state.npcs[0].goal = 'child-A';
    recordBranchCheckpoint(state, branchA, 1, 'scan');
    state = reconcileBranchState(state, parent).state;
    state.npcs[0].mood = 'baseline';
    state.npcs[0].goal = netZero ? '' : 'modified-parent';
    recordBranchCheckpoint(state, parent, 0, 'scan');
    assert.deepEqual(state.rollbackJournal.find(entry => entry.seq === original.seq), original);
    if (netZero) assert.equal(state.rollbackHead.seq, 0);
    else assert.notEqual(state.rollbackHead.seq, original.seq);
    const branchB = [...parent, message('1-B')];
    state.npcs[0].goal = 'child-B';
    recordBranchCheckpoint(state, branchB, 1, 'scan');
    for (const [chat, mood, goal] of [[branchA, 'A', 'child-A'], [branchB, 'baseline', 'child-B'], [branchA, 'A', 'child-A']]) {
        const result = reconcileBranchState(state, chat);
        assert.equal(result.exactRestored, true);
        state = result.state;
        assert.equal(state.npcs[0].mood, mood);
        assert.equal(state.npcs[0].goal, goal);
        // Extend the revisited branch far enough to prune its old full checkpoint, then
        // perform sequential journal-only deletions back through the original parent.
        const deep = structuredClone(state);
        const deepChat = [...chat];
        for (let id = 2; id < 122; id++) {
            deepChat.push(message(`${goal}-${id}`));
            deep.turn = id;
            deep.npcs[0].goal = `deep-${id}`;
            recordBranchCheckpoint(deep, deepChat, id, 'scan');
        }
        deep.checkpoints = [];
        deep.branchRootSnapshot = null;
        const first = reconcileBranchState(deep, deepChat.slice(0, 62));
        assert.equal(first.restoredFromJournal, true);
        const second = reconcileBranchState(first.state, chat);
        assert.equal(second.restoredFromJournal, true);
        assert.equal(second.state.npcs[0].goal, goal);
        const root = reconcileBranchState(second.state, []);
        assert.equal(root.exactRestored, true);
        assert.equal(root.state.npcs[0].mood, 'baseline');
        assert.equal(root.state.npcs[0].goal, '');
    }
});

test('ordinary net-zero coalescing removes undo without losing its predecessor', () => {
    const state = baseline();
    const chat = [message(0), message(1)];
    state.turn = 1;
    recordBranchCheckpoint(state, chat.slice(0, 1), 0);
    const previous = state.rollbackHead.seq;
    state.npcs[0].mood = 'temporary';
    recordBranchCheckpoint(state, chat, 1);
    state.npcs[0].mood = 'baseline';
    recordBranchCheckpoint(state, chat, 1);
    assert.equal(state.rollbackHead.seq, previous);
    const root = reconcileBranchState(state, []);
    assert.equal(root.exactRestored, true);
    assert.equal(root.state.turn, 0);
});

test('retention keeps checkpoint predecessors beyond the diagnostic byte target', () => {
    const undo = { scalars: { value: 'x'.repeat(6_100_000) } };
    const entries = [1, 2, 3].map(seq => ({ seq, prevSeq: seq - 1, messageId: seq, beforeMessageId: seq - 1, undo, createdAt: seq }));
    const retained = pruneRollbackJournal(entries, 0, 64, 4, -1, [3]);
    assert.deepEqual(retained.map(entry => entry.seq), [1, 2, 3]);
    assert.deepEqual(pruneRollbackJournal(entries, 0, 64, 300, 44, [3]), []);
});

test('production receipt checkpoint survives deleting a later user, then reverses exactly once', () => {
    let state = baseline();
    const chat = [message(0, true), message(1), message(2, true), message(3), message(4, true)];
    for (const id of [1, 3]) {
        ensureBranchParentAnchor(state, chat.slice(0, id + 1), id);
        state.turn += 1;
        state.assistantSinceScan += 1;
        recordBranchCheckpoint(state, chat.slice(0, id + 1), id, 'turn');
        if (id === 1) {
            state.npcs[0].mood = 'scan-success';
            state.assistantSinceScan = 0;
            recordBranchCheckpoint(state, chat.slice(0, 2), 1, 'scan');
        }
    }
    state = reconcileBranchState(state, chat).state;
    const userDeleted = reconcileBranchState(state, chat.slice(0, 4));
    assert.equal(userDeleted.exactRestored, true);
    assert.equal(userDeleted.state.turn, 2);
    assert.equal(userDeleted.state.npcs[0].mood, 'scan-success');
    const assistantDeleted = reconcileBranchState(userDeleted.state, chat.slice(0, 3));
    assert.equal(assistantDeleted.exactRestored, true);
    assert.equal(assistantDeleted.state.turn, 1);
    assert.equal(reconcileBranchState(assistantDeleted.state, chat.slice(0, 3)).state.turn, 1);
});

for (const lifecycle of [mechanicsLifecycle, applyStaleNpcLifecycle]) test(`terminal death survives 30/50 cleanup through ${lifecycle === mechanicsLifecycle ? 'mechanics' : 'facade'}`, () => {
    const make = (name, overrides) => ({ ...createNpcRecord(name), manual: false, present: false, worldActive: false, lastSeenTurn: 0, lastWorldActiveTurn: 0, ...overrides });
    const dead = make('Dead', { lifeState: 'deceased', lifeStateCertainty: 'explicit', archived: false, memories: ['Remembered'] });
    const living = make('Living', { lifeState: 'alive' });
    const protectedNpcs = [dead, make('Manual', { archived: true, archiveReason: 'manual' }), make('Death archive', { archived: true, archiveReason: 'deceased' }), make('Protected', { retentionProtected: true }), make('Present', { present: true }), make('Active', { worldActive: true }), make('Referenced', {})];
    let state = { npcs: [...protectedNpcs, living] };
    for (const turn of [30, 50]) {
        const result = lifecycle(state, { turn, protectedIds: [protectedNpcs.at(-1).id] });
        state = result.state;
        for (const npc of protectedNpcs) assert.ok(state.npcs.some(item => item.id === npc.id));
        assert.equal(state.npcs.find(npc => npc.id === dead.id).archived, false);
        assert.deepEqual(state.npcs.find(npc => npc.id === dead.id).memories, ['Remembered']);
        if (turn === 30) assert.deepEqual(result.archived.map(npc => npc.id), [living.id]);
        else assert.deepEqual(result.removed.map(npc => npc.id), [living.id]);
    }
});
