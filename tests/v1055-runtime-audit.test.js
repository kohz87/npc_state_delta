import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function unpointeredSessionChecks(mockState, eventSource, manualAddNpc, sleep, storageUrl) {
    const runtime = globalThis.NPCStateDelta;
    const { makeNpcStateDataFileName, encodeStateFilePayload } = await import(storageUrl);
    mockState.context.groupId = null;
    mockState.context.chatId = 'late-sidecar-session';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    mockState.context.chat = [
        { is_user: true, name: 'User', mes: 'Remote Keeper opens the shop.' },
        { is_user: false, name: 'Narrator', mes: 'Remote Keeper counts the coins.' },
    ];
    eventSource.emit('chat_changed');
    await sleep(120);
    const key = runtime.uiStatus().chatKey;
    assert.equal(runtime.dataFile(), null, 'this session hydrated before any sidecar existed');

    // Another desktop/mobile session creates and advances the canonical sidecar after this
    // session hydrated an empty working copy. This session never learns a pointer for it.
    const name = makeNpcStateDataFileName(key);
    const path = `/user/files/${name}`;
    const remoteNpc = { id: 'npc-remote-keeper', name: 'Remote Keeper', present: true, status: 'created by another session' };
    mockState.files.set(path, encodeStateFilePayload(key, { npcs: [remoteNpc], turn: 4 }, '1.0.54', { revision: 5, writerId: 'other-session' }));

    await manualAddNpc('Local Visitor');
    await runtime.flush();
    const saved = JSON.parse(mockState.files.get(path));
    assert.ok(saved.revision > 5, 'the local write advances from the adopted canonical revision');
    assert.ok(saved.state.npcs.some(npc => npc.name === 'Remote Keeper'), 'the other session\'s dossier was not overwritten');
    assert.ok(saved.state.npcs.some(npc => npc.name === 'Local Visitor'));
    assert.equal(runtime.dataFile()?.path, path);

    // The dossier editor hosts its own Life-state/Appearance controls. Their durable saves advance
    // the revision from this same session and must not make the editor's main Save look stale.
    const visitor = runtime.getState().npcs.find(npc => npc.name === 'Local Visitor');
    const previousGetElementById = document.getElementById;
    // Minimal editor fields: an unchanged birthday display so the synthetic save reaches the guard under test.
    document.getElementById = id => (id === 'npc_state_delta_edit_birthday'
        ? { value: runtime.getNpc(visitor.id)?.birthDateDisplay || '' }
        : null);
    const saveOpenEditor = async () => {
        const popup = mockState.popupCalls.at(-1);
        popup.result = 1;
        return popup.options.onClosing(popup);
    };
    await runtime.openEditor(visitor.id);
    await sleep(30);
    assert.equal(runtime.uiStatus().editorMounted, true);
    const beforeOwnWrite = runtime.uiStatus().hydratedRevision;
    assert.equal(await runtime.updateLifeState(visitor.id, 'alive', { chatKey: key }), true);
    await runtime.flush();
    assert.ok(runtime.uiStatus().hydratedRevision > beforeOwnWrite, 'the in-editor control committed a new durable revision');
    assert.equal(await saveOpenEditor(), true, 'this session\'s own in-editor commit does not invalidate its editor');

    // A server copy from another session installed while the editor is open still blocks Save.
    await runtime.openEditor(visitor.id);
    await sleep(30);
    const current = JSON.parse(mockState.files.get(path));
    current.revision += 1;
    current.writerId = 'other-session';
    current.state.npcs.find(npc => npc.id === visitor.id).status = 'edited on another device';
    mockState.files.set(path, JSON.stringify(current));
    assert.equal(await saveOpenEditor(), false, 'an editor opened before another session\'s revision cannot overwrite it');
    assert.equal(runtime.getNpc(visitor.id).status, 'edited on another device');
    document.getElementById = previousGetElementById;

    // A provider/host text reply (no JSON object) keeps the single accepted retry, and the failure
    // shows a bounded excerpt of what was actually returned instead of a ten-character parse error.
    const errors = [];
    const previousError = globalThis.toastr.error;
    globalThis.toastr.error = message => errors.push(String(message));
    const requestsBefore = mockState.rawCalls.length;
    const longTail = ' more detail'.repeat(60);
    mockState.quietResponder = async () => `The prompt was blocked by the provider safety filter (PROHIBITED_CONTENT).${longTail}`;
    assert.equal(await runtime.scan(), false);
    mockState.quietResponder = null;
    globalThis.toastr.error = previousError;
    assert.equal(mockState.rawCalls.length - requestsBefore, 2, 'one scan request plus the existing single JSON retry');
    const failure = errors.find(message => /scan failed/.test(message)) || '';
    assert.match(failure, /text reply instead of JSON twice/);
    assert.match(failure, /The provider\/model said: "The prompt was blocked by the provider safety filter \(PROHIBITED_CONTENT\)\./);
    assert.ok(failure.length < 700, 'the excerpt is bounded rather than the whole provider response');
}

test('a session hydrated before another session created the sidecar adopts it instead of overwriting it', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    const storageUrl = new URL('../storage.js', import.meta.url).href;
    source = source.replace(marker, `    await (${unpointeredSessionChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, ${JSON.stringify(storageUrl)});\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
    });
});
