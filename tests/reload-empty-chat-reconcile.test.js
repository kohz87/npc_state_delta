import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A reload's CHAT_CHANGED can reconcile while the host chat array is still empty. That is "not loaded yet", never a deletion of every message:
// the dossiers and the saved sidecar stay as they are and the reconcile is retried once the chat is there. Deleting all messages (the delete
// event, or an explicit reconcile) still rolls back as before.
async function emptyChatChecks(mockState, eventSource, manualAddNpc, sleep) {
    const runtime = globalThis.NPCStateDelta;
    const fail = message => { throw new Error(message); };
    const lines = ['Lena waits by the gate.', 'Lena watches the road.', 'Kazuma waves.', 'Lena nods.'];
    const load = () => { mockState.context.chat = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes })); };
    mockState.context.groupId = null;
    mockState.context.chatId = 'reload-empty';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    load();
    eventSource.emit('chat_changed');
    await sleep(150);
    await manualAddNpc('Lena Empty');
    await runtime.flush();
    const names = () => runtime.getState().npcs.map(npc => npc.name).join('|');
    const sidecar = () => mockState.files.get(runtime.dataFile().path);
    const lineageLength = runtime.getState().lineage.length;
    if (!lineageLength || !names().includes('Lena Empty')) fail('setup failed');
    const savedBefore = sidecar();

    // The race: reload, the host has not loaded the chat, the automatic reconcile fires, then the chat loads.
    mockState.context.chat = [];
    eventSource.emit('chat_changed');
    await sleep(250);
    if (!names().includes('Lena Empty') || runtime.getState().lineage.length !== lineageLength) fail('an empty not-yet-loaded chat rolled the dossiers back');
    if (runtime.uiStatus().branchReconciliations.some(event => event.currentLength === 0 && event.action !== 'deferred-chat-not-loaded')) fail('a destructive reconcile ran against the empty chat');
    load();
    await sleep(900);
    if (!names().includes('Lena Empty') || runtime.getState().lineage.length !== lineageLength) fail('the retry after the chat loaded changed the dossiers');
    await runtime.flush();
    if (sidecar() !== savedBefore) fail('the sidecar changed during the race');

    // A genuine delete of every message still rolls back.
    mockState.context.chat = [];
    await runtime.reconcile({ operation: 'delete', explicitDivergence: 0 });
    if (runtime.getState().lineage.length !== 0) fail('deleting every message no longer reconciles');
    setTimeout(() => process.exit(0), 300);
}

test('an automatic reconcile against a not-yet-loaded (empty) chat leaves the dossiers and sidecar alone', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${emptyChatChecks.toString()})(mockState, eventSource, manualAddNpc, sleep);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
});
