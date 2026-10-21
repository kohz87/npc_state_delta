import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Story Suite v2 with the real runtime: the established synthetic host (runtime-smoke.mjs) loads
// Delta beside a fake Story Block v2 global. Delta registers with it, offers none of v1's tabs or
// registry announcement, answers npc.portrait from its own stored images, and gives v1 everything
// back when the v2 host goes away.

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

test('with a Story Block v2 host, Delta registers through the sdk only, answers npc.portrait, and gives v1 back when the host leaves', () => {
    runHostScenario('v2-host', async () => {
        // A v2 host that (wrongly) also offers v1's registerTab: Delta must still not use it.
        const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk, registerTab: tab => mockState.storyBlockTabs.push(tab), unregisterTab() {} };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        const sdk = mockState.sdk;
        assert.ok(await waitFor(() => sdk.registered.length === 1), 'Delta registers with the v2 host');
        const def = sdk.registered[0];
        assert.equal(def.id, 'npc-state-delta');
        assert.deepEqual(Object.keys(def.queries).sort(), ['npc.cast', 'npc.dossier', 'npc.known', 'npc.meters', 'npc.portrait', 'npc.present']);
        assert.deepEqual(mockState.storyBlockTabs, [], 'no v1 Present NPCs / Dossiers tabs');
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlock, undefined);
        assert.equal(globalThis.StorySuite?.has?.('npc-state-delta') ?? false, false, 'not announced to v1\'s Story Suite registry');

        // A portrait attached in Delta (the same upload path as the dossier's) is what npc.portrait returns.
        await manualAddNpc('Mira');
        await api.flush();
        const npc = api.getState().npcs.find(item => item.name === 'Mira');
        assert.ok(npc, 'Mira has a dossier');
        assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), null, 'no portrait yet');
        const chatKey = api.uiStatus().chatKey;
        const originalCreate = document.createElement;
        const originalReader = globalThis.FileReader;
        const originalImage = globalThis.Image;
        let dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = dataUrl; this.onload?.(); }); } };
        globalThis.Image = class { width = 32; height = 48; set src(value) { queueMicrotask(() => this.onload?.()); } };
        document.createElement = tag => tag === 'canvas' ? { getContext: () => ({ drawImage() {} }), toDataURL: () => dataUrl } : originalCreate.call(document, tag);
        const file = name => ({ name, type: 'image/png', size: 100 });
        try {
            assert.equal(await api.setPortrait(npc.id, file('mira.png'), { chatKey }), true);
            assert.equal(def.queries['npc.portrait']({}, { name: 'mira' }), 'data:image/png;base64,iVBORw0KGgo=');
            assert.equal(def.queries['npc.portrait']({}, { name: npc.id }), 'data:image/png;base64,iVBORw0KGgo=');
            // The current form's own image wins, as in the dossier.
            assert.equal(await api.updateAppearance(npc.id, { currentForm: 'Human', formsText: 'Human | Brown hair.\nRaven | Black feathers.' }, { chatKey, lockAppearance: true }), true);
            assert.equal(await api.updateAppearance(npc.id, { currentForm: 'Raven' }, { chatKey, lockAppearance: true }), true);
            dataUrl = 'data:image/png;base64,UmF2ZW4=';
            assert.equal(await api.setPortrait(npc.id, file('raven.png'), { chatKey, form: 'Raven' }), true);
            assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), 'data:image/png;base64,UmF2ZW4=');
            assert.equal(await api.updateAppearance(npc.id, { currentForm: 'Human' }, { chatKey, lockAppearance: true }), true);
            assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), 'data:image/png;base64,iVBORw0KGgo=');
        } finally {
            document.createElement = originalCreate;
            globalThis.FileReader = originalReader;
            globalThis.Image = originalImage;
        }
        assert.equal(def.queries['npc.portrait']({}, { name: 'Nobody' }), null);

        // The host goes away and a v1 Story Block takes its place: v1's tabs and announcement come back.
        globalThis.StoryBlock = { apiVersion: 1, registerTab: tab => mockState.storyBlockTabs.push(tab), unregisterTab() {}, refresh() {} };
        const v2 = await import(pathToFileURL(path.join(extRoot, 'src', 'storysuite-v2.js')).href);
        const adapter = v2.startStorySuiteV2();
        assert.equal(adapter.check(), false);
        assert.ok(await waitFor(() => mockState.storyBlockTabs.length === 2), 'v1 tabs registered with the v1 host');
        assert.deepEqual(mockState.storyBlockTabs.map(tab => tab.label), ['Present NPCs', 'Dossiers']);
        assert.equal(globalThis.StorySuite.has('npc-state-delta'), true, 'announced to v1\'s registry again');
        adapter.stop();
    });
});
