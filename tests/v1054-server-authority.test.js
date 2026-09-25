import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function serverAuthorityChecks(mockState, eventSource, manualAddNpc, sleep) {
    const runtime = globalThis.NPCStateDelta;
    const open = async id => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = [
            { is_user: true, name: 'User', mes: 'Freshness Probe enters the room.' },
            { is_user: false, name: 'Narrator', mes: 'Freshness Probe waits beside the window.' },
        ];
        eventSource.emit('chat_changed');
        await sleep(120);
    };
    const waitUntil = async predicate => {
        for (let i = 0; i < 200; i++) {
            if (predicate()) return;
            await sleep(5);
        }
        assert.fail('server-authority synthetic runtime did not settle');
    };
    const remoteAdvance = (steps = 1, mutate = () => {}, writer = 'remote-session-test') => {
        const pointer = runtime.dataFile();
        assert.ok(pointer?.path, 'test requires a durable sidecar pointer');
        const payload = JSON.parse(mockState.files.get(pointer.path));
        mutate(payload.state);
        payload.revision += steps;
        payload.writerId = writer;
        payload.updatedAt = new Date(Date.now() + payload.revision).toISOString();
        mockState.files.set(pointer.path, JSON.stringify(payload));
        return payload;
    };

    await open('server-authority');
    await manualAddNpc('Freshness Probe');
    await runtime.flush();
    let npc = runtime.getState().npcs.find(item => item.name === 'Freshness Probe');
    assert.ok(npc);
    const key = runtime.uiStatus().chatKey;
    const rev0 = runtime.uiStatus().hydratedRevision;

    // Cache still current: verification leaves the working copy and durable revision unchanged.
    const beforeCurrent = runtime.getState();
    assert.equal(await runtime.ensureFresh({ reason: 'test-current' }), true);
    assert.equal(runtime.uiStatus().hydratedRevision, rev0);
    assert.deepEqual(runtime.getState(), beforeCurrent);
    assert.equal(runtime.uiStatus().freshnessEvents.at(-1)?.type, 'current');

    // Desktop rev N, remote/mobile advances directly to N+2.
    const remote2 = remoteAdvance(2, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.mood = 'remote revision N+2';
    });
    assert.equal(await runtime.ensureFresh({ reason: 'test-stale-cache' }), true);
    assert.equal(runtime.uiStatus().hydratedRevision, remote2.revision);
    assert.equal(runtime.getNpc(npc.id).mood, 'remote revision N+2');
    assert.equal(runtime.uiStatus().freshnessEvents.at(-1)?.type, 'stale-cache-refresh');

    // Several remote saves are observed as one jump to the latest durable revision.
    const remote5 = remoteAdvance(3, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.status = 'remote revision N+5';
    });
    await runtime.ensureFresh({ reason: 'test-multiple-advance' });
    assert.equal(runtime.uiStatus().hydratedRevision, remote5.revision);
    assert.equal(runtime.getNpc(npc.id).status, 'remote revision N+5');

    // Re-entering an already-hydrated chat must still verify the server sidecar.
    const handoff = remoteAdvance(1, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.goal = 'mobile handoff goal';
    });
    eventSource.emit('chat_changed');
    await waitUntil(() => runtime.uiStatus().hydratedRevision === handoff.revision);
    assert.equal(runtime.getNpc(npc.id).goal, 'mobile handoff goal');

    // Same numeric revision but a different durable writer is a fork, not "still fresh".
    const forked = remoteAdvance(0, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.mood = 'same revision server fork';
    }, 'remote-same-revision-fork');
    await runtime.ensureFresh({ reason: 'test-same-revision-writer' });
    assert.equal(runtime.uiStatus().hydratedRevision, forked.revision);
    assert.equal(runtime.getNpc(npc.id).mood, 'same revision server fork');
    assert.equal(runtime.persistenceStatus().recoverySnapshot, true, 'the displaced same-revision working copy remains recoverable');
    assert.ok(runtime.uiStatus().freshnessEvents.some(event => event.type === 'same-revision-writer-conflict'));

    // A provider result produced against revision R must be rejected if another session
    // commits R+1 while the request is in flight.
    let releaseProvider;
    mockState.quietResponder = () => new Promise(resolve => { releaseProvider = resolve; });
    const scan = runtime.scan();
    await waitUntil(() => typeof releaseProvider === 'function');
    const remoteDuringScan = remoteAdvance(1, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.status = 'canonical remote during scan';
    });
    releaseProvider(JSON.stringify({ npcs: [{ id: npc.id, name: npc.name, present: true, status: 'stale provider result' }] }));
    assert.equal(await scan, false);
    await runtime.ensureFresh({ reason: 'test-after-stale-scan' });
    assert.equal(runtime.uiStatus().hydratedRevision, remoteDuringScan.revision);
    assert.equal(runtime.getNpc(npc.id).status, 'canonical remote during scan');
    assert.ok(runtime.uiStatus().freshnessEvents.some(event => event.type === 'stale-operation-rejected'));

    // CHAT_LOADED is also a freshness boundary even for a hydrated key.
    const loadedAdvance = remoteAdvance(1, state => {
        const target = state.npcs.find(item => item.id === npc.id);
        target.location = 'remote loaded boundary';
    });
    eventSource.emit('chat_loaded');
    await waitUntil(() => runtime.uiStatus().hydratedRevision === loadedAdvance.revision);
    assert.equal(runtime.getNpc(npc.id).location, 'remote loaded boundary');

    await runtime.flush();
    assert.equal(runtime.uiStatus().chatKey, key);
}

test('server-authoritative multi-session freshness and stale provider guards execute in the synthetic runtime', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${serverAuthorityChecks.toString()})(mockState, eventSource, manualAddNpc, sleep);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
    });
});

test('freshness boundaries cover resume, editor, portrait and destructive mutation paths without polling', () => {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /addEventListener\?\.\('pageshow',[\s\S]*refreshCurrentChatFromServer\('pageshow'\)/);
    assert.match(source, /visibilityState === 'visible'[\s\S]*refreshCurrentChatFromServer\('visibility-resume'\)/);
    assert.match(source, /activeEditorBaseRevision[\s\S]*workingCopyAdoption\(originChatKey\)/);
    assert.match(source, /portrait-commit[\s\S]*originCanonicalRevision/);
    assert.match(source, /runFreshMutation\('archive a dossier'/);
    assert.match(source, /runFreshMutation\('delete a dossier'/);
    assert.doesNotMatch(source, /setInterval\([^\n]*ensureHydratedStateFresh|setInterval\([^\n]*inspectNpcStateDataFile/);
});
