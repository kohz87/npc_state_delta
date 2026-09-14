import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function hotfixChecks(mockState, eventSource, manualAddNpc, sleep, extRoot) {
    const runtime = globalThis.NPCStateDelta;
    const settings = mockState.extensionSettings.npc_state_delta;
    const storage = await import(pathToFileURL(path.join(extRoot, 'storage.js')).href);
    const open = async (id, chat = []) => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = chat;
        eventSource.emit('chat_changed');
        await sleep(100);
    };
    const waitUntil = async predicate => {
        for (let i = 0; i < 150; i++) { if (predicate()) return; await sleep(10); }
        assert.fail('synthetic runtime did not settle');
    };
    await open('v110-persistence');
    manualAddNpc('Recovery Probe');
    await runtime.flush();
    const npc = runtime.getState().npcs.find(npc => npc.name === 'Recovery Probe');
    const key = runtime.uiStatus().chatKey;
    const durableFetch = globalThis.fetch;
    const originalTimer = globalThis.setTimeout;
    let attempts = 0, release;
    globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, [1000, 2000, 5000, 15000, 30000].includes(ms) ? 0 : ms, ...args);
    globalThis.fetch = async (url, options) => {
        if (url !== '/api/files/upload') return durableFetch(url, options);
        attempts++;
        if (attempts <= 6) return { ok: false, status: 503, text: async () => 'synthetic unavailable' };
        return new Promise(resolve => { release = () => resolve({ ok: false, status: 413, text: async () => 'synthetic size rejection' }); });
    };
    try {
        assert.equal(runtime.archive(npc.id), true);
        const save = runtime.flush();
        await waitUntil(() => release);
        assert.equal(runtime.updateAppearance(npc.id, { currentForm: 'Human', formsText: 'Human | Newer accepted blue coat.' }, { chatKey: key, lockAppearance: true }), true);
        release();
        await assert.rejects(save, error => error.status === 413);
        assert.equal(attempts, 7);
        assert.match(storage.undurableNpcStateSnapshot(key).state.npcs.find(item => item.id === npc.id).appearance, /blue coat/);
    } finally {
        globalThis.fetch = durableFetch;
        globalThis.setTimeout = originalTimer;
    }
    for (let i = 0; i < 8; i++) await open(`v110-eviction-${i}`);
    await open('v110-persistence');
    assert.equal(runtime.persistenceStatus().currentChatPending, true);
    assert.equal(runtime.getNpc(npc.id).archived, true);
    assert.match(runtime.getNpc(npc.id).appearance, /blue coat/);
    await runtime.flush();
    assert.equal(runtime.persistenceStatus().currentChatPending, false);
    assert.equal(storage.undurableNpcStateSnapshot(key), null);
    const saved = JSON.parse(mockState.files.get(runtime.dataFile().path));
    assert.match(saved.state.npcs.find(item => item.id === npc.id).appearance, /blue coat/);

    await open('v110-receipts');
    Object.assign(settings, { autoScan: true, fullScanEveryTurn: true, scanEvery: 1, branchRescan: false });
    const msg = (id, is_user = false, is_system = false) => ({ is_user, is_system, name: is_user ? 'User' : 'Narrator', mes: `hotfix story ${id}` });
    const send = async item => {
        mockState.context.chat.push(item);
        const id = mockState.context.chat.length - 1;
        eventSource.emit(item.is_user ? 'message_sent' : 'message_received', id);
        await sleep(60);
        return id;
    };
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Receipt Probe', present: true, mood: 'steady', role: 'guide' }] });
    await send(msg(0, true));
    await send(msg(1));
    await waitUntil(() => runtime.getState().lastScannedMessageId === 1);
    assert.equal(runtime.getState().turn, 1);
    const beforeFailed = runtime.getState();
    mockState.quietResponder = async () => { throw new Error('synthetic scan failure'); };
    await send(msg(2, true));
    await send(msg(3));
    await waitUntil(() => !runtime.uiStatus().scanBusy);
    assert.equal(runtime.getState().turn, 2);
    assert.deepEqual(runtime.getState().npcs, beforeFailed.npcs, 'failed scan cannot fabricate absence or dossier/lifecycle changes');
    eventSource.emit('message_received', 3);
    eventSource.emit('message_received', 2);
    await sleep(40);
    assert.equal(runtime.getState().turn, 2);
    await send(msg(4, true));
    mockState.context.chat.pop();
    eventSource.emit('message_deleted', 4);
    await sleep(100);
    assert.equal(runtime.getState().turn, 2, 'deleting only the later user preserves the failed assistant receipt');
    mockState.context.chat.pop();
    eventSource.emit('message_deleted', 3);
    await sleep(100);
    assert.equal(runtime.getState().turn, 1);
    eventSource.emit('message_deleted', 3);
    await sleep(50);
    assert.equal(runtime.getState().turn, 1, 'repeated deletion cannot reverse twice');
    settings.autoScan = false;
    await send(msg('skipped'));
    assert.equal(runtime.getState().turn, 2);
    await send(msg('system', false, true));
    assert.equal(runtime.getState().turn, 2);
    // A delayed request cannot adopt the next receipt. The busy/skipped receipt still
    // owns its turn checkpoint, and stale completion must leave both increments intact.
    settings.autoScan = true;
    let resolveScan;
    mockState.quietResponder = () => new Promise(resolve => { resolveScan = resolve; });
    const delayedId = await send(msg('delayed'));
    await waitUntil(() => resolveScan);
    await send(msg('busy'));
    assert.equal(runtime.getState().turn, 4);
    resolveScan('{"npcs":[]}');
    await sleep(100);
    assert.equal(runtime.getState().turn, 4);
    assert.deepEqual(runtime.getState().npcs, beforeFailed.npcs);
    settings.autoScan = false;
    mockState.context.chat = mockState.context.chat.slice(0, delayedId);
    eventSource.emit('message_deleted', delayedId);
    await sleep(100);
    assert.equal(runtime.getState().turn, 2);
    await runtime.flush();
}

test('v1.0.10 recovery and receipt boundaries execute in the synthetic runtime host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${hotfixChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, extRoot);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 40000, maxBuffer: 8 * 1024 * 1024,
    });
});
