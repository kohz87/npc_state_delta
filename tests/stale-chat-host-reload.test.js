import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The stale-chat mark protects a dossier adopted from another session while this browser still
// holds the older chat. A host chat load (CHAT_CHANGED) reads the chat from the server, so it is
// never stale: a dossier lineage it only prefixes lost those messages to a deletion. Neither case
// may leave dossier Refresh permanently blocked.
async function hostReloadChecks(mockState, eventSource, manualAddNpc, sleep, uiHandlers) {
    const runtime = globalThis.NPCStateDelta;
    const warnings = [];
    const previousToastr = { ...globalThis.toastr };
    globalThis.toastr.warning = message => warnings.push(String(message));
    const fail = message => { throw new Error(message); };
    const open = async (id, lines) => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes }));
        eventSource.emit('chat_changed');
        await sleep(150);
    };
    const writeServerCopy = mutate => {
        const pointer = runtime.dataFile();
        const payload = JSON.parse(mockState.files.get(pointer.path));
        mutate(payload.state);
        payload.revision += 1;
        payload.writerId = 'previous-page-load';
        mockState.files.set(pointer.path, JSON.stringify(payload));
    };
    const refresh = uiHandlers.get('click.npcStateDelta|.npc-state-delta-refresh-chat');
    if (typeof refresh !== 'function') fail('the dossier Refresh button is not connected');
    const clickRefresh = async npcId => {
        const before = mockState.rawCalls.length;
        refresh.call({ dataset: { npcId } }, { preventDefault() {}, stopPropagation() {} });
        await sleep(400);
        return mockState.rawCalls.length - before;
    };
    const previousResponder = mockState.quietResponder;
    mockState.quietResponder = () => '{"npcs":[]}';

    // A reload over a saved dossier whose lineage is longer than the chat the host loaded: the
    // tail was deleted (its truncation never reached the server), so it is not a stale chat.
    await open('reload-longer-lineage', ['Lena waits by the gate.', 'Lena watches the road.', 'Kazuma waves.', 'Lena nods.']);
    await manualAddNpc('Lena Reload');
    await runtime.flush();
    const lenaId = runtime.getState().npcs.find(npc => npc.name === 'Lena Reload').id;
    mockState.context.chat.length = 2;
    writeServerCopy(() => {});
    eventSource.emit('chat_changed');
    await sleep(400);
    if (runtime.uiStatus().branchReconciliations.at(-1)?.action === 'deferred-stale-chat') fail('a reloaded chat was treated as stale');
    if (runtime.getState().lineage.length !== 2) fail('the reloaded chat did not become the dossier lineage');
    warnings.length = 0;
    if (await clickRefresh(lenaId) !== 1) fail(`Refresh did not dispatch after a reload: ${warnings.join(' | ')}`);

    // Another session's newer dossier adopted mid-session still blocks Refresh until the host
    // reloads the chat; the reload then clears the mark.
    await open('stale-until-reload', ['Mira waits by the gate.', 'Mira watches the road.']);
    await manualAddNpc('Mira Reload');
    await runtime.flush();
    const miraId = runtime.getState().npcs.find(npc => npc.name === 'Mira Reload').id;
    writeServerCopy(state => { state.lineage = [...state.lineage, 'remote-message-3', 'remote-message-4']; });
    await runtime.ensureFresh({ reason: 'remote-advance' });
    warnings.length = 0;
    if (await clickRefresh(miraId) !== 0) fail('Refresh ran against a chat older than the adopted dossier');
    if (!warnings.some(message => /Reload the chat first/.test(message))) fail('the stale-chat block was not explained');
    eventSource.emit('chat_changed');
    await sleep(400);
    warnings.length = 0;
    if (await clickRefresh(miraId) !== 1) fail(`Refresh stayed blocked after the chat reloaded: ${warnings.join(' | ')}`);

    mockState.quietResponder = previousResponder;
    Object.assign(globalThis.toastr, previousToastr);
    setTimeout(() => process.exit(0), 300);
}

test('a host chat reload clears the stale-chat mark and dossier Refresh dispatches', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${hostReloadChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, uiHandlers);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
    });
});
