// Work that finds the host's barrier still up after the wait is not dropped. A reply's receipt, a queued drain, a reconcile and a generation's
// injection are kept and carried out when the barrier is down; a Problem tells the reader if the host does not settle for ten minutes; work for a
// reply that changed meanwhile, or for a chat that is no longer open, is the only work given up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostScenario } from './helpers/host-scenario.js';

const prelude = async () => {
    mockState.gate = { pending: false, calls: 0 };
    mockState.warned = [];
    globalThis.toastr.warning = text => mockState.warned.push(String(text));
    mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
    const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
    mockState.sdk = sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
};

test('a reply\'s scan whose barrier wait timed out is kept and runs when the barrier is down; a Problem tells of ten minutes; a changed reply is not scanned', () => {
    runHostScenario('barrier-timeout', prelude, async () => {
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        assert.equal(await waitFor(() => api.stateReady()), true);
        // The gate the adapter gives answers "not settled" at once, as it does after its bound.
        api.useMessageGate({ refresh: async () => null, settled: async () => { mockState.gate.calls += 1; return !mockState.gate.pending; } });
        Object.assign(mockState.extensionSettings.npc_state_delta, { enabled: true, autoScan: true, scanEvery: 1, fullScanEveryTurn: false });
        await manualAddNpc('Mira');
        await api.flush();
        const names = () => api.getState().npcs.map(npc => npc.name);
        const responder = name => async (args = {}) => {
            if (args.jsonSchema) return '{"npcs":[]}';
            return JSON.stringify({ npcs: [{ name, present: true, role: 'wanderer', species: 'Human', age: '30', appearance: `${name} wears a grey cloak.`, personality: 'quiet', speech: 'brief', relationshipImpact: 'ordinary' }] });
        };
        const reply = text => { mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0 }); return mockState.context.chat.length - 1; };
        // 1. The barrier is up when the reply arrives and does not come down in time.
        mockState.gate.pending = true;
        mockState.quietResponder = responder('Vale');
        const calls = mockState.rawCalls.length;
        eventSource.emit('message_received', reply('Vale, a wanderer in a grey cloak, nods to the party at the gate and says nothing more for a while.'));
        await sleep(700);
        assert.equal(mockState.rawCalls.length, calls, 'no scan while the barrier is up');
        assert.deepEqual(names(), ['Mira']);
        assert.equal(api.scanActive(), true, 'the receipt is kept: a save point waits for it');
        assert.deepEqual(mockState.warned, [], 'no Problem yet');
        // 2. Ten minutes pass with the host still not settled: the reader is told, and the scan is still kept.
        const realNow = Date.now;
        let skew = 11 * 60 * 1000;
        Date.now = () => realNow() + skew;
        assert.equal(await waitFor(() => mockState.warned.some(text => /still pending/.test(text)), 3000), true, 'a visible Problem says the scan is pending');
        assert.deepEqual(names(), ['Mira']);
        assert.equal(api.scanActive(), true);
        // 3. The barrier comes down: the scan runs for that reply.
        mockState.gate.pending = false;
        assert.equal(await waitFor(() => names().includes('Vale'), 8000), true, 'the new NPC appears');
        assert.equal(await api.scanIdle(5000), true);
        Date.now = realNow;
        skew = 0;
        // 4. A reply that changed while its scan waited (swiped) is not scanned for its old text; the new one has its own event.
        mockState.gate.pending = true;
        mockState.quietResponder = responder('Orrin');
        const at = reply('Orrin, a courier with a satchel of letters, hurries in from the road and asks after the party by name.');
        eventSource.emit('message_received', at);
        await sleep(500);
        mockState.context.chat[at].mes = 'Nobody comes. The road stays empty and the party waits at the gate through the whole long evening.';
        mockState.gate.pending = false;
        await sleep(900);
        assert.equal(names().includes('Orrin'), false, 'the stale receipt was given up');
        assert.equal(await api.scanIdle(5000), true);
    });
});

test('a reconcile after a deleted message and the injection of a generation wait too, and run when the barrier is down', () => {
    runHostScenario('barrier-timeout-reconcile', prelude, async () => {
        mockState.gate.pending = true;   // the page was reloaded while the host was still bringing Delta to the selected head
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        assert.equal(await waitFor(() => api.stateReady()), true);
        api.useMessageGate({ refresh: async () => null, settled: async () => { mockState.gate.calls += 1; return !mockState.gate.pending; } });
        Object.assign(mockState.extensionSettings.npc_state_delta, { enabled: true, autoScan: true, scanEvery: 1, fullScanEveryTurn: false });
        await manualAddNpc('Mira');
        await api.flush();
        mockState.quietResponder = async (args = {}) => (args.jsonSchema ? '{"npcs":[]}' : JSON.stringify({ npcs: [{ name: 'Vale', present: true, role: 'wanderer', species: 'Human', age: '30', appearance: 'Vale wears a grey cloak.', personality: 'quiet', speech: 'brief', relationshipImpact: 'ordinary' }] }));
        const chat = mockState.context.chat;
        chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Vale, a wanderer in a grey cloak, nods to the party at the gate and says nothing more for a while.', swipe_id: 0 });
        mockState.gate.pending = false;
        eventSource.emit('message_received', chat.length - 1);
        assert.equal(await waitFor(() => api.getState().npcs.some(npc => npc.name === 'Vale'), 8000), true);
        assert.equal(await api.scanIdle(5000), true);
        // A message is deleted while the barrier is up (and stays up past the wait): the reconcile is kept and runs after.
        const before = api.uiStatus().branchReconciliations.length;
        const prompts = mockState.prompts.length;
        mockState.gate.pending = true;
        chat.pop();
        eventSource.emit('message_deleted', chat.length);
        eventSource.emit('generation_after_commands', 'normal', {}, false);
        await sleep(700);
        assert.equal(api.uiStatus().branchReconciliations.length, before, 'no reconcile yet');
        assert.equal(mockState.prompts.length, prompts, 'no injection yet');
        assert.equal(api.scanActive(), true, 'both are kept');
        mockState.gate.pending = false;
        assert.equal(await waitFor(() => api.uiStatus().branchReconciliations.length > before, 8000), true, 'the reconcile ran');
        assert.equal(await waitFor(() => mockState.prompts.length > prompts, 8000), true, 'the injection was built');
        assert.equal(await api.scanIdle(5000), true);
    });
});
