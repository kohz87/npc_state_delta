import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Story Suite v2 hosted-mode polish, with the real runtime: the established synthetic host
// (runtime-smoke.mjs) loads Delta beside a fake Story Block v2 global.
//   1. A new chat with no sidecar yet: Delta looks for the file once and, while hosted, automatic
//      boundaries trust that miss instead of asking again (each ask is a 404 in the console). The
//      reader's own actions still look, and the first save creates the file. Without a v2 host the
//      checks are as before.
//   2. The floating npc state launcher hides while hosted unless the reader keeps it, and comes back
//      when the host goes away.
//   3. Under a v2 host the in-chat present cast takes v1's "Only in Story Block" default: shown only
//      when the reader chose to show it.

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
// Every request for one of Delta's chat sidecars, and what the server answered.
mockState.sidecarReads = [];
const sidecarFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    const response = await sidecarFetch(url, options);
    if (typeof url === 'string' && /^\\/user\\/files\\/npc-state-delta-[^/]*\\.json$/.test(url)) mockState.sidecarReads.push({ url, status: response.status });
    return response;
};
const misses = () => mockState.sidecarReads.filter(read => read.status === 404).length;
async function turn(text) {
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
    const userId = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
    const id = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
    await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
    await sleep(150);
    return id;
}
// Chat events that make Delta check its sidecar without writing anything; the reads they made.
async function quietEvents() {
    const before = mockState.sidecarReads.length;
    const uploads = mockState.uploadCalls;
    for (const name of ['chat_loaded', 'chat_changed', 'message_edited', 'message_swiped']) {
        await Promise.all((mockState.listeners.get(name) || []).map(fn => fn(0)));
        await sleep(250);
    }
    assert.equal(mockState.uploadCalls, uploads, 'these events write nothing');
    return mockState.sidecarReads.slice(before);
}
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
    console.log('story suite v2 hosted scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        return execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

const v2HostPrelude = async () => {
    const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
    mockState.sdk = sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
};
const noHostPrelude = async () => {};

test('hosted: a new chat with no sidecar is looked for once; automatic checks trust the miss, the reader\'s own look still asks', () => {
    runHostScenario('sidecar-miss-hosted', v2HostPrelude, async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1), 'Delta registers with the v2 host');
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2, '1');
        await sleep(200);
        assert.ok(misses() >= 1, 'the new chat was looked for');
        assert.equal(api.dataFile(), null, 'no sidecar yet');

        assert.deepEqual(await quietEvents(), [], 'while hosted, chat events do not ask for the missing file again');
        assert.deepEqual(await quietEvents(), [], 'not on the second round either');
        assert.equal(api.getState().npcs.length, 0, 'no sidecar yet reads as an empty dossier');

        // An explicit look (the public freshness check) still asks the server.
        let before = mockState.sidecarReads.length;
        assert.equal(await api.ensureFresh(), true);
        assert.deepEqual(mockState.sidecarReads.slice(before).map(read => read.status), [404]);

        // Another session creates the sidecar meanwhile. Automatic checks keep trusting the miss,
        // but the reader's own action looks first and adopts it instead of overwriting it.
        const { makeNpcStateDataFileName, encodeStateFilePayload } = await import(pathToFileURL(path.join(extRoot, 'storage.js')).href);
        const key = api.uiStatus().chatKey;
        const filePath = `/user/files/${makeNpcStateDataFileName(key)}`;
        mockState.files.set(filePath, encodeStateFilePayload(key, { npcs: [{ id: 'npc-remote-keeper', name: 'Remote Keeper', present: true }], turn: 4 }, '1.2.19', { revision: 5, writerId: 'other-session' }));
        assert.deepEqual(await quietEvents(), [], 'automatic checks still trust the miss');
        await manualAddNpc('Local Visitor');
        await api.flush();
        const saved = JSON.parse(mockState.files.get(filePath));
        assert.ok(saved.revision > 5, 'the save advances from the adopted revision');
        assert.deepEqual(saved.state.npcs.map(npc => npc.name).sort(), ['Local Visitor', 'Remote Keeper'], 'the other session\'s dossier was kept');
        assert.equal(api.dataFile()?.path, filePath);

        // With a sidecar, checks use it as before (and never 404).
        before = mockState.sidecarReads.length;
        const reads = await quietEvents();
        assert.ok(reads.length >= 1 && reads.every(read => read.status === 200), 'an existing sidecar is checked as before');
        assert.equal(mockState.sidecarReads.slice(before).filter(read => read.status === 404).length, 0);
    });
});

test('hosted: the first save still creates the sidecar, with one check before it and no 404 after it', () => {
    runHostScenario('sidecar-first-save-hosted', v2HostPrelude, async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        await sleep(200);
        mockState.sidecarReads.length = 0;
        await turn('The wind blows over the empty road.');
        await api.flush();
        assert.ok(api.dataFile()?.path, 'the first save created the sidecar');
        assert.ok(mockState.files.has(api.dataFile().path));
        assert.equal(misses(), 1, 'only the save\'s own check (it never overwrites a file another session made) found nothing');
        await turn('Still nobody on the road.');
        await turn('Still nobody on the road.');
        assert.equal(misses(), 1, 'no 404 after the file exists');
    });
});

test('hosted, then the host goes away: chat events check for the sidecar as before', () => {
    runHostScenario('sidecar-host-leaves', v2HostPrelude, async () => {
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        await sleep(200);
        assert.deepEqual(await quietEvents(), []);
        globalThis.StoryBlock = undefined;
        const v2 = await import(pathToFileURL(path.join(extRoot, 'src', 'storysuite-v2.js')).href);
        const adapter = v2.startStorySuiteV2();
        assert.equal(adapter.check(), false);
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2, undefined, 'the hosted flag is gone');
        const reads = await quietEvents();
        assert.ok(reads.length >= 1 && reads.every(read => read.status === 404), 'unhosted, the missing sidecar is asked for again, as v1 does');
        adapter.stop();
    });
});

test('without a v2 host the sidecar checks are unchanged', () => {
    runHostScenario('sidecar-alone', noHostPrelude, async () => {
        await sleep(300);
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2, undefined);
        const first = await quietEvents();
        assert.ok(first.length >= 4 && first.every(read => read.status === 404), `chat events ask for the missing sidecar (${first.length})`);
        const second = await quietEvents();
        assert.equal(second.length, first.length, 'every time, as before');
    });
});

test('hosted: the launcher hides unless kept, and the in-chat cast shows only when the reader chose it; both come back when the host leaves', () => {
    runHostScenario('launcher-and-cast-hosted', v2HostPrelude, async () => {
        const api = globalThis.NPCStateDelta;
        const settings = mockState.extensionSettings.npc_state_delta;
        const data = globalThis.document.documentElement.dataset;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        await sleep(100);

        // The launcher: CSS hides it while data-npc-state-delta-story-block-v2="1" unless the
        // reader keeps it (data-npc-state-delta-launcher-v2="keep").
        assert.equal(data.npcStateDeltaStoryBlockV2, '1');
        assert.equal(settings.launcherWithStoryBlockV2, false, 'off by default');
        assert.equal(data.npcStateDeltaLauncherV2, 'auto');
        const keep = uiHandlers.get('change.npcStateDelta|#npc_state_delta_launcher_with_story_block_v2');
        assert.equal(typeof keep, 'function', 'the setting is connected');
        keep.call({ checked: true });
        assert.equal(settings.launcherWithStoryBlockV2, true);
        assert.equal(data.npcStateDeltaLauncherV2, 'keep');
        keep.call({ checked: false });
        assert.equal(data.npcStateDeltaLauncherV2, 'auto');
        assert.equal(settings.launcherWithStoryBlock, false, 'v1\'s own setting is untouched');

        // The in-chat cast: the Cast tab carries it, so the unchosen default stays out of the chat.
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        const id = await turn('Yunyun waves from the gate.');
        await sleep(200);
        assert.ok(api.getState().npcs.some(npc => npc.name === 'Yunyun' && npc.present), 'Yunyun is present');
        assert.match(api.presentCastHtml(), /Yunyun/, 'the Cast tab has her');
        const inChat = () => inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id));
        assert.equal(settings.presentCastDisplayChosen, false);
        api.renderInline();
        assert.equal(inChat(), false, 'the unchosen default is not shown twice');
        assert.equal(api.uiStatus().presentCastDisplay, 'full', 'the stored choice is unchanged');

        settings.presentCastDisplay = 'full';
        settings.presentCastDisplayChosen = true;
        api.renderInline();
        assert.equal(inChat(), true, 'Full cards chosen: shown in the chat too');
        settings.presentCastDisplay = 'storyblock';
        api.renderInline();
        assert.equal(inChat(), false, 'Only in Story Block: the Cast tab only');
        settings.presentCastDisplay = 'compact';
        api.renderInline();
        assert.equal(inChat(), true, 'Compact is always a deliberate choice');

        // The host goes away: the flag goes, so the launcher shows again, and the unchosen default
        // brings the cards back to the chat.
        settings.presentCastDisplay = 'full';
        settings.presentCastDisplayChosen = false;
        api.renderInline();
        assert.equal(inChat(), false);
        globalThis.StoryBlock = undefined;
        const v2 = await import(pathToFileURL(path.join(extRoot, 'src', 'storysuite-v2.js')).href);
        const adapter = v2.startStorySuiteV2();
        assert.equal(adapter.check(), false);
        assert.equal(data.npcStateDeltaStoryBlockV2, undefined, 'no hosted flag: the launcher CSS no longer hides it');
        assert.ok(await waitFor(inChat), 'the in-chat cast comes back on its own');
        adapter.stop();
    });
});

test('without a v2 host the launcher and the in-chat cast are as before', () => {
    runHostScenario('launcher-and-cast-alone', noHostPrelude, async () => {
        const api = globalThis.NPCStateDelta;
        const data = globalThis.document.documentElement.dataset;
        await sleep(200);
        assert.equal(data.npcStateDeltaStoryBlockV2, undefined);
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        const id = await turn('Yunyun waves from the gate.');
        await sleep(200);
        api.renderInline();
        assert.ok(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), 'the default full cards stay in the chat');
    });
});

test('the launcher rule, the setting row and its CSS follow the hosted flag', () => {
    const launcher = fs.readFileSync(new URL('../launcher-ui.js', import.meta.url), 'utf8');
    assert.match(launcher, /html\[data-npc-state-delta-story-block-v2="1"\]:not\(\[data-npc-state-delta-launcher-v2="keep"\]\) #\$\{LAUNCHER_ID\} \{ display: none !important; \}/);
    // v1's rule is unchanged.
    assert.match(launcher, /html\[data-npc-state-delta-story-block="1"\]:not\(\[data-npc-state-delta-launcher="keep"\]\) #\$\{LAUNCHER_ID\} \{ display: none !important; \}/);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /<div class="npc-state-delta-v2-hosted-only">\$\{settingRow\('npc_state_delta_launcher_with_story_block_v2', 'Show NSD\\'s own launcher with Story Block v2'/);
    assert.match(index, /launcherWithStoryBlockV2: false,/);
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /html:not\(\[data-npc-state-delta-story-block-v2="1"\]\) \.npc-state-delta-v2-hosted-only \{ display: none !important; \}/, 'the v2 setting shows only while hosted');
    assert.match(css, /html\[data-npc-state-delta-story-block-v2="1"\] \.npc-state-delta-v2-hosted-hide \{ display: none !important; \}/, 'v1\'s Story Block launcher setting steps aside while hosted');
});
