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
