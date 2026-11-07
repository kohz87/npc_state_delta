// Exercise the production event, reconciliation, inheritance and participant paths against the synthetic host. Its file response is independent
// of the in-memory chat, so empty and partial loading, a genuine delete, and stale retry ownership can be distinguished.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function emptyChatChecks(mockState, eventSource, manualAddNpc, sleep) {
    const runtime = globalThis.NPCStateDelta;
    const fail = message => { throw new Error(message); };
    const lines = ['Lena waits by the gate.', 'Lena watches the road.', 'Kazuma waves.', 'Lena nods.'];
    const messages = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes }));
    const load = (count = messages.length) => { mockState.context.chat = structuredClone(messages.slice(0, count)); };
    const files = new Map();
    const reads = [];
    const routes = [];
    let blockedParent = '';
    let hungChat = '';
    let parentHold = null;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        if (url === blockedParent) throw new Error('synthetic parent unavailable');
        if (parentHold && url === parentHold.path) {
            const hold = parentHold;
            parentHold = null;
            hold.entered();
            await hold.wait;
        }
        if (url === '/api/chats/get' || url === '/api/chats/group/get') {
            const body = JSON.parse(options.body);
            const id = body.file_name || body.id;
            reads.push(id);
            routes.push(url);
            if (id === hungChat) return new Promise(() => {});
            const value = files.get(id);
            return value ? { ok: true, json: async () => structuredClone(value) } : { ok: false, status: 404 };
        }
        return oldFetch(url, options);
    };
    mockState.context.groupId = null;
    mockState.context.chatId = 'reload-empty';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    mockState.context.chatMetadata = {};
    files.set('reload-empty', [{ chat_metadata: {} }, ...messages]);
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
    const dossiersBefore = JSON.stringify(runtime.getState().npcs);
    const parentPath = runtime.dataFile().path;
    const uploadsBefore = mockState.uploadCalls;
    const { createParticipant, memoryVault } = await import(pathToFileURL(path.join(sourceRoot, 'src/storysuite-participant/index.js')).href);

    // The race: reload, the host has not loaded the chat, the automatic reconcile fires, then the chat loads.
    mockState.context.chat = [];
    eventSource.emit('chat_changed');
    await sleep(250);
    if (JSON.stringify(runtime.getState().npcs) !== dossiersBefore || runtime.getState().lineage.length !== lineageLength) fail('an empty not-yet-loaded chat rolled the dossiers back');
    if (runtime.uiStatus().branchReconciliations.some(event => event.currentLength === 0 && event.action !== 'deferred-chat-not-loaded')) fail('a destructive reconcile ran against the empty chat');
    const existingParticipant = createParticipant({ vault: memoryVault(), port: {
        chatKey: runtime.chatKey, readState: runtime.getState, writeTimeline: runtime.writeTimeline,
        ready: runtime.timelineReady, load: async () => {}, branchPending: runtime.branchPending, inheritBranch: runtime.inheritBranch,
    } });
    if ((await existingParticipant.hydrate()).ok || sidecar() !== savedBefore || mockState.uploadCalls !== uploadsBefore) fail('participant hydration wrote during deferred loading');
    files.set('reload-empty', [{ chat_metadata: null }]);
    eventSource.emit('chat_loaded');
    await sleep(100);
    if (!names().includes('Lena Empty') || sidecar() !== savedBefore) fail('a malformed host file authorized an empty-chat rollback');
    files.set('reload-empty', [{ chat_metadata: {} }, ...messages]);
    load(2);
    await sleep(650);
    if (JSON.stringify(runtime.getState().npcs) !== dossiersBefore || runtime.getState().lineage.length !== lineageLength) fail('a partially loaded chat rolled the dossiers back');
    if (sidecar() !== savedBefore || mockState.uploadCalls !== uploadsBefore) fail('the deferred path wrote the sidecar');
    files.delete('reload-empty');
    eventSource.emit('chat_loaded');
    await sleep(250);
    eventSource.emit('message_sent', 0);
    await sleep(150);
    if (JSON.stringify(runtime.getState().npcs) !== dossiersBefore || runtime.getState().lineage.length !== lineageLength
        || sidecar() !== savedBefore || mockState.uploadCalls !== uploadsBefore) fail('a missing host file authorized a partial-chat rollback');
    files.set('reload-empty', [{ chat_metadata: {} }, ...messages]);
    load();
    await sleep(900);
    if (JSON.stringify(runtime.getState().npcs) !== dossiersBefore || runtime.getState().lineage.length !== lineageLength) fail('the retry after the chat loaded changed the dossiers');
    await runtime.flush();
    if (sidecar() !== savedBefore) fail('the sidecar changed during the race');

    // An automatic reconcile delayed by a swipe stays automatic; swipe settlement cannot bypass the loading guard.
    mockState.swipeState = 'swiping';
    load(0); eventSource.emit('chat_changed');
    await sleep(180);
    mockState.swipeState = 'none';
    await sleep(150);
    const swipeDeferred = runtime.uiStatus().branchReconciliations.at(-1);
    if (swipeDeferred?.action !== 'deferred-chat-not-loaded' || swipeDeferred.operation !== 'auto' || sidecar() !== savedBefore) fail('swipe settlement bypassed automatic loading protection');
    load(); eventSource.emit('chat_loaded');
    await sleep(150);

    // A new branch cannot inherit its parent's root during empty or partial loading, even when participant hydration asks for it.
    mockState.context.chatId = 'loading-branch';
    mockState.context.chatMetadata = {}; // The parent metadata can arrive after CHAT_CHANGED too.
    files.set('loading-branch', [{ chat_metadata: { main_chat: 'reload-empty' } }, ...messages]);
    load(0);
    eventSource.emit('chat_changed');
    await sleep(200);
    const participant = createParticipant({ vault: memoryVault(), port: {
        chatKey: runtime.chatKey, readState: runtime.getState, writeTimeline: runtime.writeTimeline,
        branchPending: runtime.branchPending, inheritBranch: runtime.inheritBranch,
    } });
    if (!runtime.branchPending() || (await participant.hydrate()).ok) fail('participant hydration did not wait for branch loading');
    if (runtime.dataFile() || runtime.getState().timeline?.lineage) fail('the empty branch was written before loading');
    mockState.context.chatMetadata = { main_chat: 'reload-empty' };
    load(2);
    await sleep(650);
    if (!runtime.branchPending() || runtime.dataFile()) fail('partial branch inheritance wrote the wrong checkpoint');
    load();
    blockedParent = parentPath;
    eventSource.emit('chat_loaded');
    await sleep(250);
    if (!runtime.branchPending() || runtime.dataFile() || (await participant.hydrate()).ok) fail('an unreadable parent was treated as an empty branch');
    blockedParent = '';
    eventSource.emit('chat_loaded');
    await sleep(900);
    if (runtime.branchPending() || !names().includes('Lena Empty')) fail('the loaded branch did not inherit its parent checkpoint');

    // A brand-new chat holds a real reply without writing until its host file appears, then processes it once.
    mockState.context.chatId = 'brand-new-chat';
    mockState.context.chatMetadata = {};
    load(2);
    eventSource.emit('chat_changed');
    await sleep(300);
    if (!runtime.branchPending() || runtime.dataFile()) fail('a new chat without a host file was not left pending');
    eventSource.emit('message_received', 1);
    eventSource.emit('message_received', 1);
    await sleep(550);
    if (!runtime.branchPending() || runtime.dataFile() || runtime.getState().turn !== 0) fail('a reply wrote the pending chat before its host file appeared');
    files.set('brand-new-chat', [{ chat_metadata: {} }, ...messages.slice(0, 2)]);
    await sleep(900);
    if (runtime.branchPending() || runtime.getState().turn !== 1) fail('a new chat did not process the held reply exactly once after its host file appeared');
    mockState.context.chatMetadata = { main_chat: 'reload-empty' }; // (later checks reuse the branch metadata)

    // A real delete while a branch waits for its parent stays a delete across the deferred retry.
    blockedParent = parentPath;
    mockState.context.chatId = 'deleted-branch';
    files.set('deleted-branch', [{ chat_metadata: { main_chat: 'reload-empty' } }, ...messages]);
    load(); eventSource.emit('chat_changed');
    await sleep(180);
    if (!runtime.branchPending()) fail('the branch did not wait for its unavailable parent');
    load(0); eventSource.emit('message_deleted', 0);
    await sleep(180);
    files.set('deleted-branch', [{ chat_metadata: { main_chat: 'reload-empty' } }]);
    blockedParent = '';
    eventSource.emit('chat_loaded');
    await sleep(900);
    if (runtime.branchPending() || runtime.getState().lineage.length !== 0 || runtime.uiStatus().branchReconciliations.at(-1)?.operation !== 'delete') fail('the deferred full delete was lost');

    // A manual edit made while the parent is being read owns the new branch; a late inheritance must not overwrite it.
    let releaseParent;
    let parentEntered;
    const entered = new Promise(resolve => { parentEntered = resolve; });
    parentHold = { path: parentPath, entered: parentEntered, wait: new Promise(resolve => { releaseParent = resolve; }) };
    mockState.context.chatId = 'edited-branch';
    files.set('edited-branch', [{ chat_metadata: { main_chat: 'reload-empty' } }, ...messages]);
    load(); eventSource.emit('chat_changed');
    await Promise.race([entered, sleep(1000).then(() => fail('parent read did not start'))]);
    await manualAddNpc('Manual branch');
    await runtime.flush();
    releaseParent();
    await sleep(250);
    if (!names().includes('Manual branch') || names().includes('Lena Empty')) fail('a late inheritance overwrote a manual edit');

    // A timer from an earlier opening of a chat cannot run after leaving and reopening that same chat.
    mockState.context.chatId = 'reload-empty';
    mockState.context.chatMetadata = {};
    const turnBeforeSwitch = runtime.getState().turn;
    load(2);
    eventSource.emit('chat_changed');
    await sleep(180);
    eventSource.emit('message_received', 1);
    await sleep(100);
    mockState.context.chatId = 'other-chat';
    files.set('other-chat', [{ chat_metadata: {} }, ...messages]);
    load(); eventSource.emit('chat_changed');
    await sleep(80);
    mockState.context.chatId = 'reload-empty';
    load(); eventSource.emit('chat_changed');
    await sleep(200);
    const eventsAfterReturn = JSON.stringify(runtime.uiStatus().branchReconciliations);
    await sleep(500);
    if (JSON.stringify(runtime.uiStatus().branchReconciliations) !== eventsAfterReturn) fail('an earlier opening retried after a chat switch');
    if (runtime.getState().turn !== turnBeforeSwitch || sidecar() !== savedBefore) fail('an earlier opening delivered its held reply after a chat switch');

    // The retry is bounded even if the host never finishes loading, and a later load event still resumes reconciliation.
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 400 ? 4 : ms === 5000 ? 7 : ms, ...args);
    const readStart = reads.length;
    load(0); eventSource.emit('chat_changed');
    await sleep(600);
    const attempts = reads.length - readStart;
    await sleep(200);
    if (attempts !== 38 || reads.length - readStart !== attempts) fail(`the loading retry was not bounded: ${attempts}`);
    globalThis.setTimeout = originalTimeout;
    load(); eventSource.emit('chat_loaded');
    await sleep(150);
    if (!names().includes('Lena Empty') || sidecar() !== savedBefore) fail('the chat did not resume safely after retry exhaustion');

    // An unresponsive host read cannot hold reconciliation forever; it times out and remains non-destructive.
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 2000 ? 5 : ms, ...args);
    hungChat = 'reload-empty';
    load(0); eventSource.emit('chat_changed');
    await sleep(200);
    if (runtime.uiStatus().branchReconciliations.at(-1)?.action !== 'deferred-chat-not-loaded' || sidecar() !== savedBefore) fail('a hung host read did not defer safely');
    hungChat = '';
    globalThis.setTimeout = originalTimeout;
    load(); eventSource.emit('chat_loaded');
    await sleep(150);

    // Group chats use their own host route, and an explicit manual reconcile can still delete all messages.
    mockState.context.groupId = 'group-reload';
    mockState.context.chatId = 'group-story';
    files.set('group-story', [{ chat_metadata: {} }, ...messages]);
    load(); eventSource.emit('chat_changed');
    await sleep(150);
    await manualAddNpc('Group witness');
    await runtime.flush();
    const groupBefore = sidecar();
    load(0); eventSource.emit('chat_changed');
    await sleep(250);
    if (!names().includes('Group witness') || sidecar() !== groupBefore || !routes.includes('/api/chats/group/get')) fail('group loading was not deferred through the group file route');
    await runtime.reconcile();
    if (runtime.getState().lineage.length !== 0) fail('an explicit manual reconciliation could not delete all messages');
    mockState.context.groupId = null;
    mockState.context.chatId = 'reload-empty';
    load(); eventSource.emit('chat_changed');
    await sleep(150);

    // A genuine delete event of every message still rolls back, without needing a host-file read.
    mockState.context.chat = [];
    eventSource.emit('message_deleted', 0);
    await sleep(250);
    if (runtime.getState().lineage.length !== 0) fail('deleting every message no longer reconciles');
    const deletion = runtime.uiStatus().branchReconciliations.at(-1);
    if (deletion?.operation !== 'delete' || deletion?.action === 'deferred-chat-not-loaded') fail('the actual delete event was deferred');

    // An automatic full deletion is also allowed when the host file itself confirms it is empty.
    load(); eventSource.emit('chat_changed');
    await sleep(150);
    await manualAddNpc('Confirmed witness');
    await runtime.flush();
    files.set('reload-empty', [{ chat_metadata: {} }]);
    load(0); eventSource.emit('chat_changed');
    await sleep(250);
    if (runtime.getState().lineage.length !== 0 || runtime.uiStatus().branchReconciliations.at(-1)?.action === 'deferred-chat-not-loaded') fail('a host-confirmed empty file did not reconcile');
}

test('loading defers reconciliation and branch inheritance without writes; retries stay bounded and real deletes work', { timeout: 90000 }, async () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${emptyChatChecks.toString()})(mockState, eventSource, manualAddNpc, sleep);\n${marker}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-reload-test-'));
    const file = path.join(dir, 'host.mjs');
    try {
        fs.writeFileSync(file, source);
        await import(pathToFileURL(file).href);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
