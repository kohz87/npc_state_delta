// The timeline participant inside the real runtime (lead-owned wiring): the synthetic host (runtime-smoke.mjs) loads Delta beside a fake
// Story Block v2 global; the module definition Delta registers carries the participant and `npc.identity`, and the runtime's
// `installState` puts a native state back absolutely and durably.
import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runHostScenario(name, prelude, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.documentElement = { dataset: {} };
globalThis.document.readyState = 'loading';
// index.js imports the adapter from src/ at runtime, as the package ships it.
fs.cpSync(path.join(sourceRoot, 'src'), path.join(extRoot, 'src'), { recursive: true });
mockState.storyBlockTabs = [];
await (${prelude.toString()})();
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await import(pathToFileURL(path.join(extRoot, 'story-block-tabs.js')).href);
    await sleep(30);
    await (${scenario.toString()})();
    console.log('story suite v2 scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

test('the registered module declares the participant and answers npc.identity; a checkpoint restores the dossiers through the runtime', () => {
    runHostScenario('participant', async () => {
        const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        const sdk = mockState.sdk;
        assert.ok(await waitFor(() => sdk.registered.length === 1), 'Delta registers with the v2 host');
        const def = sdk.registered[0];
        assert.equal(def.participant.schema, 1);
        for (const name of ['checkpoint', 'prepare', 'activate', 'abort', 'status', 'applyEvent', 'attach']) assert.equal(typeof def.participant[name], 'function', name);
        assert.equal(typeof def.queries['npc.identity'], 'function');
        await manualAddNpc('Mira');
        await api.flush();
        assert.equal(typeof api.chatKey(), 'string');
        assert.equal(api.chatKey(), api.uiStatus().chatKey);
        // The first ask hydrates behind itself; the next finds the np_.
        assert.equal(def.queries['npc.identity']({}, { name: 'Mira' }), null);
        await sleep(30);
        const found = def.queries['npc.identity']({}, { name: 'Mira' });
        assert.match(found.id, /^np_[0-9a-z]{8}$/);
        // N1: the ids and the lineage are in Delta's own chat state, so a rename, a branch and an export carry them.
        const timeline = api.getState().timeline;
        assert.match(timeline.lineage, /^lg_[0-9a-z]{8}$/);
        assert.equal(timeline.identity.map[found.id].nativeKey, found.nativeKey);
        assert.equal(found.name, 'Mira');
        assert.equal(def.queries['npc.identity']({}, { id: found.id }).nativeKey, found.nativeKey);
        // A checkpoint, a change, then the restore: the dossier is as it was, and the state is durable.
        const saved = await def.participant.checkpoint({ cursor: null, headHash: 'a'.repeat(64) });
        assert.equal(saved.ok, true, saved.message);
        // N2: whatever Delta saves is told to the participant (a manual add here; a scan, an edit, a delete or a meter step the same way);
        // the participant's own writes are not changes.
        let heard = 0;
        const stop = api.onNativeChange(() => { heard += 1; });
        await manualAddNpc('Orrin');
        await api.flush();
        assert.ok(heard > 0, 'a saved change was announced');
        stop();
        assert.deepEqual(api.getState().npcs.map(npc => npc.name).sort(), ['Mira', 'Orrin']);
        const prepared = await def.participant.prepare({ return: 'rt_00000001', checkpoint: saved.checkpoint, hash: saved.hash });
        assert.equal(prepared.ok, true, prepared.message);
        assert.equal(api.getState().npcs.length, 2, 'prepare shows nothing');
        const activated = await def.participant.activate({ return: 'rt_00000001', prepared: prepared.prepared });
        assert.equal(activated.ok, true, activated.message);
        assert.deepEqual(api.getState().npcs.map(npc => npc.name), ['Mira']);
        assert.equal(api.persistenceStatus().currentChatPending, false, 'the restored state is durable');
        assert.equal(def.queries['npc.identity']({}, { id: found.id }).name, 'Mira', 'the same np_');
        let again = 0;
        const stopAgain = api.onNativeChange(() => { again += 1; });
        await api.installState(structuredClone(api.getState()));
        await api.writeTimeline(structuredClone(api.getState().timeline));
        assert.equal(again, 0, 'the participant\'s own writes are not native changes');
        assert.equal(api.scanActive(), false);
        assert.equal(await api.scanIdle(50), true);
        stopAgain();
        await assert.rejects(() => api.installState(null), /object/);
    });
});

test('N-B1: from a reply arriving until its scan is written, and across a queued scan, Delta is never idle: no save point can land in the gap', () => {
    runHostScenario('intent', async () => {
        const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        const settings = mockState.extensionSettings.npc_state_delta;
        Object.assign(settings, { enabled: true, autoScan: true, scanEvery: 1, fullScanEveryTurn: false });
        await manualAddNpc('Mira');
        await api.flush();
        const slow = name => async (args = {}) => {
            if (args.jsonSchema) return '{"npcs":[]}';
            await sleep(120);
            return JSON.stringify({ npcs: [{ name, present: true, role: 'wanderer', species: 'Human', age: '30', appearance: `${name} wears a grey cloak.`, personality: 'quiet', speech: 'brief', relationshipImpact: 'ordinary' }] });
        };
        const reply = text => mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0 });
        const names = () => api.getState().npcs.map(npc => npc.name);
        // Sample the whole time: whenever Delta says it is idle, nothing may still be on its way.
        const samples = [];
        let stop = false;
        const sampler = (async () => { while (!stop) { samples.push({ idle: !api.scanActive(), names: names() }); await sleep(2); } })();
        mockState.quietResponder = slow('Vale');
        reply('Vale, a wanderer in a grey cloak, nods to the party at the gate and says nothing more for a while.');
        const first = mockState.context.chat.length - 1;
        eventSource.emit('message_received', first);
        assert.equal(api.scanActive(), true, 'the reply has arrived: its scan is due');
        // A second reply arrives while the first scan runs: it is queued, and starts only when the first ends.
        await sleep(40);
        mockState.quietResponder = slow('Orrin');
        reply('Orrin, a courier with a satchel of letters, hurries in from the road and asks after the party by name.');
        eventSource.emit('message_received', mockState.context.chat.length - 1);
        assert.equal(await waitFor(() => names().includes('Orrin'), 8000), true, 'the queued scan ran');
        await sleep(30);
        stop = true;
        await sampler;
        const wrong = samples.filter(sample => sample.idle && !(sample.names.includes('Vale') && sample.names.includes('Orrin')) && sample.names.includes('Mira'));
        // Idle is allowed only before anything was due (the first sample) and after both are written.
        assert.ok(wrong.length <= 1, `Delta was idle with a scan still to land: ${JSON.stringify(wrong.slice(0, 3))}`);
        assert.equal(await api.scanIdle(2000), true);
        assert.equal(api.scanActive(), false);
    });
});

test('N1 end to end: the real rename lifecycle keeps the lineage and the ids, and a checkpoint made before it still restores; a bundle from another chat gets a lineage of its own', () => {
    runHostScenario('rename', async () => {
        const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        const def = mockState.sdk.registered[0];
        await manualAddNpc('Mira');
        await api.flush();
        assert.equal(def.queries['npc.identity']({}, { name: 'Mira' }), null, 'the first ask hydrates behind itself');
        await sleep(40);
        const mira = def.queries['npc.identity']({}, { name: 'Mira' });
        const before = structuredClone(api.getState().timeline);
        assert.match(before.lineage, /^lg_[0-9a-z]{8}$/);
        const keyBefore = api.chatKey();
        const saved = await def.participant.checkpoint({ cursor: null, headHash: 'a'.repeat(64) });
        assert.equal(saved.ok, true, saved.message);
        // SillyTavern renames the chat: the context now has the new id, and the event moves Delta's state to the new key.
        mockState.context.chatId = 'renamed-chat';
        mockState.context.getCurrentChatId = () => 'renamed-chat';
        eventSource.emit('chat_renamed', { oldFileName: 'smoke-chat.jsonl', newFileName: 'renamed-chat.jsonl', avatarId: 'megumin.png' });
        await sleep(200);
        eventSource.emit('chat_changed');
        await sleep(120);
        assert.notEqual(api.chatKey(), keyBefore, 'the chat has a new key');
        assert.equal(await waitFor(() => api.stateReady()), true);
        assert.deepEqual(api.getState().timeline, before, 'the same lineage, ids and deaths: the block moved with the state');
        assert.equal(def.queries['npc.identity']({}, { id: mira.id }).nativeKey, mira.nativeKey, 'the same np_');
        const prepared = await def.participant.prepare({ return: 'rt_00000001', checkpoint: saved.checkpoint, hash: saved.hash });
        assert.equal(prepared.ok, true, prepared.message);
        const activated = await def.participant.activate({ return: 'rt_00000001', prepared: prepared.prepared });
        assert.equal(activated.ok, true, activated.message);
        // A bundle exported here and imported into a chat of another key keeps the ids and takes a lineage of its own.
        const bytes = await api.exportBytes({ chatKey: api.chatKey() });
        mockState.context.chatId = 'other-chat';
        mockState.context.getCurrentChatId = () => 'other-chat';
        mockState.context.chat = [{ is_user: false, is_system: false, name: 'Megumin', mes: 'Another story.' }];
        eventSource.emit('chat_changed');
        await sleep(120);
        assert.equal(await waitFor(() => api.stateReady()), true);
        assert.equal(api.getState().timeline, undefined, 'a chat of its own starts with no line');
        await api.importBytes(bytes);
        const adopted = api.getState().timeline;
        assert.equal(adopted.lineage, null, 'a fresh lineage is made by the participant, not the source\'s');
        assert.deepEqual(adopted.identity.map, before.identity.map, 'the ids are kept');
    });
});
