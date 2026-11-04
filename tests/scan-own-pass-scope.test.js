// A dossier scan is discarded when its chat or its dossiers change under it (index.js beginScanOperation `isCurrent`, and the scan's own
// stale checks). Delta's own queued backfill loop must not be such a change: a backfill that was getting ready when a scan began finds the
// scan holding the chat, makes no request, and writes nothing (it stays queued), so the scan's result is kept. A real change still discards it.
// Delta alone on the synthetic host (no Story Block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostScenario } from './helpers/host-scenario.js';

function scenarioOutput(stdout) {
    const line = String(stdout).split('\n').find(item => item.startsWith('RESULT '));
    assert.ok(line, 'the scenario printed its result');
    return JSON.parse(line.slice('RESULT '.length));
}

test('runtime: a backfill that finds a scan holding the chat writes nothing, so the scan is kept; an edit, an import or a chat switch still discards it', () => {
    const out = scenarioOutput(runHostScenario('scan-own-pass-scope', async () => {}, async () => {
        const api = globalThis.NPCStateDelta;
        const emit = async (name, ...args) => { for (const fn of mockState.listeners.get(name) || []) await fn(...args); };
        mockState.context.chatId = 'scope-chat';
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = [];
        eventSource.emit('chat_changed');
        await sleep(100);
        const chat = mockState.context.chat;
        const row = extra => JSON.stringify({ npcs: [{ name: 'Aqua', present: true, role: 'priestess', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, ...extra }] });
        const calls = { scan: [], backfill: [], other: [] };
        let phase = 'setup';
        let held = null;
        mockState.quietResponder = async (...args) => {
            const system = String(args[0]?.systemPrompt || '');
            const backfill = /backfill/i.test(system);
            (backfill ? calls.backfill : (/isolated dossier scanner/.test(system) ? calls.scan : calls.other)).push(phase);
            if (backfill) return phase === 'setup' ? new Promise(() => {}) : '{"npcs":[]}';
            if (phase === 'setup') return row({ mood: 'cheerful', location: 'the guild door' });
            if (held === null) return new Promise(resolve => { held = resolve; });
            return '{"npcs":[]}';
        };
        const aqua = () => api.getState().npcs.find(npc => npc.name === 'Aqua') || null;
        const queue = () => structuredClone(api.getState().pendingBackfills || []);
        // A held scan: started, its request waiting for `answer`; resolves with the scan's result.
        const holdScan = async start => {
            held = null;
            let done = false;
            const scanning = start().then(value => { done = true; return value; });
            await waitFor(() => held || done, { timeout: 5000 });
            return { scanning, answer: text => { if (typeof held === 'function') held(text); } };
        };

        // A reply admits Aqua; the scan queues her new-admission backfill, whose automatic run is cancelled (so it stays queued, untried).
        chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the door?' });
        await emit('message_sent', 0);
        chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Aqua the priestess waves from the guild door.', swipe_id: 0, swipes: ['Aqua the priestess waves from the guild door.'] });
        await emit('message_received', 1);
        await emit('character_message_rendered', 1);
        await waitFor(() => calls.backfill.length === 1, { timeout: 5000 });
        api.cancelScan();
        await waitFor(() => !api.uiStatus().scanBusyForChat, { timeout: 5000 });
        await sleep(100);
        const setup = { aqua: Boolean(aqua()), queue: queue() };

        // 1. The race: the queued backfill is getting ready (its state-file read is held) when a scan starts; the scan takes the chat first.
        phase = 'race';
        let releaseRead;
        let markEntered;
        const entered = new Promise(resolve => { markEntered = resolve; });
        mockState.readBarrier = { entered: markEntered, promise: new Promise(resolve => { releaseRead = resolve; }) };
        const backfills = api.processBackfills();
        await entered;
        held = null;
        let raceDone = false;
        const raceScan = api.scan().then(value => { raceDone = true; return value; });
        await sleep(30);
        releaseRead();
        const backfillsProcessed = await backfills;
        await waitFor(() => held || raceDone, { timeout: 5000 });
        if (typeof held === 'function') held(row({ mood: 'triumphant', location: 'the guild hall' }));
        const race = {
            scanned: await raceScan,
            backfillsProcessed,
            backfillRequests: calls.backfill.filter(item => item === 'race').length,
            scanRequests: calls.scan.filter(item => item === 'race').length,
            mood: aqua()?.mood,
            location: aqua()?.location,
            queue: queue(),
        };
        await sleep(100);

        // 2. A real dossier change under a scan (an import / restore): the scan is discarded.
        phase = 'import';
        const imported = await holdScan(() => api.scan());
        const restored = api.getState();
        restored.npcs = restored.npcs.map(npc => (npc.name === 'Aqua' ? { ...npc, mood: 'restored-mood' } : npc));
        await api.installState(restored);
        imported.answer(row({ mood: 'import-scan-mood', location: 'the import-scan room' }));
        const importResult = { scanned: await imported.scanning, mood: aqua()?.mood, location: aqua()?.location };
        await sleep(100);

        // 3. The reply the scan reads is edited under it: discarded.
        phase = 'edit';
        const edited = await holdScan(() => api.scan());
        chat[1].mes = 'Aqua the priestess storms off toward the river.';
        chat[1].swipes = [chat[1].mes];
        await emit('message_edited', 1);
        edited.answer(row({ mood: 'edit-scan-mood', location: 'the edit-scan room' }));
        const editResult = { scanned: await edited.scanning, mood: aqua()?.mood, location: aqua()?.location };
        await waitFor(() => !api.uiStatus().scanBusyForChat, { timeout: 5000 });
        await sleep(100);

        // 4. The chat is switched under a scan: discarded, nothing written to either chat.
        phase = 'switch';
        const switched = await holdScan(() => api.scan());
        const homeChat = mockState.context.chat;
        mockState.context.chatId = 'scope-other';
        mockState.context.chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: 'Elsewhere, a quiet road.' }];
        eventSource.emit('chat_changed');
        switched.answer(row({ mood: 'switch-scan-mood', location: 'the switch-scan room' }));
        const switchScanned = await switched.scanning;
        await sleep(150);
        const otherHasAqua = Boolean(aqua());
        mockState.context.chatId = 'scope-chat';
        mockState.context.chat = homeChat;
        eventSource.emit('chat_changed');
        await sleep(200);
        const switchResult = { scanned: switchScanned, otherHasAqua, mood: aqua()?.mood, location: aqua()?.location };
        mockState.quietResponder = null;
        console.log('RESULT ' + JSON.stringify({ setup, race, importResult, editResult, switchResult }));
    }));

    assert.equal(out.setup.aqua, true, 'the reply admitted Aqua');
    assert.equal(out.setup.queue.length, 1, 'and queued her backfill');
    assert.equal(out.setup.queue[0].attempts, 0, 'untried');

    // The scan took the chat; the backfill made no request.
    assert.equal(out.race.scanRequests, 1, 'the scan asked the scanner (once)');
    assert.equal(out.race.backfillRequests, 0, 'the backfill that found the scan running made no request');
    assert.equal(out.race.scanned, true, 'the scan was not discarded by Delta\'s own backfill loop');
    assert.equal(out.race.mood, 'triumphant', 'its result was applied');
    assert.equal(out.race.location, 'the guild hall');
    assert.equal(out.race.queue.length, 1, 'the backfill is still queued');
    assert.equal(out.race.queue[0].attempts, 0, 'a backfill that never ran is not counted as a failed attempt');
    assert.equal(out.race.queue[0].requestedAt, out.setup.queue[0].requestedAt, 'the same request');

    assert.equal(out.importResult.scanned, false, 'an import under a scan discards it');
    assert.equal(out.importResult.mood, 'restored-mood', 'the imported dossier stands');
    assert.notEqual(out.importResult.location, 'the import-scan room');

    assert.equal(out.editResult.scanned, false, 'an edit of the reply under a scan discards it');
    assert.notEqual(out.editResult.mood, 'edit-scan-mood');
    assert.notEqual(out.editResult.location, 'the edit-scan room');

    assert.equal(out.switchResult.scanned, false, 'a chat switch under a scan discards it');
    assert.equal(out.switchResult.otherHasAqua, false, 'nothing was written to the other chat');
    assert.notEqual(out.switchResult.mood, 'switch-scan-mood', 'nor to the chat it started in');
    assert.notEqual(out.switchResult.location, 'the switch-scan room');
});
