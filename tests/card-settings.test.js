import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    CARD_SETTINGS_OWNER, createCardSettingsDefinition, validPortraitPromptFormat, validScanEvery,
} from '../src/card-settings.js';
import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

// ---- the definition (pure) ----

function memory(initial = {}) {
    const store = { portraitPromptFormat: 'hybrid', scanEvery: 5, ...initial, saves: [] };
    return {
        store,
        definition: createCardSettingsDefinition({
            readFormat: () => store.portraitPromptFormat,
            saveFormat: async format => { store.portraitPromptFormat = format; store.saves.push(['format', format]); return true; },
            readScanEvery: () => store.scanEvery,
            saveScanEvery: value => { store.scanEvery = value; store.saves.push(['scan', value]); return true; },
        }),
    };
}

test('card settings: owner, label and the two keys with their labels', () => {
    const { definition } = memory();
    assert.equal(definition.owner, 'npc-state-delta');
    assert.equal(definition.owner, CARD_SETTINGS_OWNER);
    assert.equal(definition.label, 'NSD');
    assert.deepEqual(Object.keys(definition.keys), ['portraitPromptFormat', 'scanEvery']);
    assert.equal(definition.keys.portraitPromptFormat.label, 'NSD portraits');
    assert.equal(definition.keys.scanEvery.label, 'NSD scan every');
});

test('card settings: valueText is the format\'s own name and "5 replies" for Scan every', () => {
    const { keys } = memory().definition;
    assert.equal(keys.portraitPromptFormat.valueText('natural'), 'Natural');
    assert.equal(keys.portraitPromptFormat.valueText('hybrid'), 'Structured hybrid');
    assert.equal(keys.portraitPromptFormat.valueText('tags'), 'Comma tags');
    assert.equal(keys.scanEvery.valueText(5), '5 replies');
    assert.equal(keys.scanEvery.valueText(1), '1 reply');
});

test('card settings: valid accepts only the formats normalizePortraitPromptFormat knows and Scan every 1 to 20', () => {
    for (const ok of ['hybrid', 'tags', 'natural']) assert.equal(validPortraitPromptFormat(ok), true, ok);
    for (const bad of ['', 'Natural language', 'prose', null, undefined, 3, {}]) assert.equal(validPortraitPromptFormat(bad), false, String(bad));
    for (const ok of [1, 5, 20]) assert.equal(validScanEvery(ok), true, String(ok));
    for (const bad of [0, 21, 2.5, '5', null, NaN, -1]) assert.equal(validScanEvery(bad), false, String(bad));
    const { keys } = memory().definition;
    assert.equal(keys.portraitPromptFormat.valid('natural'), true);
    assert.equal(keys.portraitPromptFormat.valid('bogus'), false);
    assert.equal(keys.scanEvery.valid(7), true);
    assert.equal(keys.scanEvery.valid(99), false);
});

test('card settings: read returns the current settings; apply saves each valid key and reports them', async () => {
    const { definition, store } = memory({ portraitPromptFormat: 'tags', scanEvery: 3 });
    assert.equal(definition.read('portraitPromptFormat'), 'tags');
    assert.equal(definition.read('scanEvery'), 3);
    assert.equal(definition.read('other'), undefined);
    const out = await definition.apply({ portraitPromptFormat: 'natural', scanEvery: 8 });
    assert.deepEqual(out, { applied: ['portraitPromptFormat', 'scanEvery'] });
    assert.deepEqual(store.saves, [['format', 'natural'], ['scan', 8]]);
    assert.equal(definition.read('portraitPromptFormat'), 'natural');
    assert.equal(definition.read('scanEvery'), 8);
});

test('card settings: apply skips an invalid value and a key it does not own, and a failed save is not reported applied', async () => {
    const { definition, store } = memory();
    assert.deepEqual(await definition.apply({ portraitPromptFormat: 'bogus', scanEvery: 100, unknown: 1 }), { applied: [] });
    assert.deepEqual(store.saves, []);
    const failing = createCardSettingsDefinition({ readFormat: () => 'hybrid', saveFormat: async () => false, readScanEvery: () => 5, saveScanEvery: () => true });
    assert.deepEqual(await failing.apply({ portraitPromptFormat: 'tags', scanEvery: 2 }), { applied: ['scanEvery'] });
});

// ---- registration with the host ----

function fakeDoc() {
    return {
        documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; },
        createElement: () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {} } }),
    };
}
const manualTimers = () => ({ setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval: () => 2, clearInterval() {} });

async function hostWith(sdkExtras, definition) {
    const live = [];
    const refusing = sdkExtras === 'refusing';
    const sdk = {
        registerModule: async () => {},
        ...(refusing ? { registerCardSettings: () => { throw new Error('owner taken'); } } : {}),
        ...(sdkExtras === 'with' ? { registerCardSettings: def => { live.push(def); return () => live.splice(live.indexOf(def), 1); } } : {}),
    };
    const host = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [] }, delta: () => null, host: () => host, doc: fakeDoc(), timers: manualTimers(),
        loadEmptyCast: async () => null, logger: { warn() {} }, cardSettings: definition,
    });
    adapter.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    await adapter.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return { adapter, live };
}

test('card settings: the adapter registers them with a Story Block 2.21.0 sdk and unregisters on stop', async () => {
    const { definition } = memory();
    const { adapter, live } = await hostWith('with', definition);
    assert.equal(adapter.hosted(), true);
    assert.deepEqual(live, [definition]);
    adapter.stop();
    assert.deepEqual(live, [], 'unregistered on unload');
});

test('card settings: a refusal by the host is logged and Delta is still hosted', async () => {
    const { definition } = memory();
    const { adapter, live } = await hostWith('refusing', definition);
    assert.equal(adapter.hosted(), true);
    assert.deepEqual(live, []);
    adapter.stop();
});

test('card settings: with an older Story Block (no registerCardSettings) Delta is hosted as before and registers nothing', async () => {
    const { definition } = memory();
    const { adapter, live } = await hostWith('without', definition);
    assert.equal(adapter.hosted(), true);
    assert.deepEqual(live, []);
    adapter.stop();
});

// ---- the real extension in the synthetic host (its definition is NPCStateDelta.cardSettings()): apply persists like the panel's own saves, and survives a reload ----

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runInHost(scenario, { settings = { scanEvery: 1 } } = {}) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    source = source.replace('extensionSettings: { npc_state_delta: { scanEvery: 1 } },', `extensionSettings: { npc_state_delta: ${JSON.stringify(settings)} },`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
let result = null;
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(60);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(60);
    result = await (${scenario.toString()})({ card: globalThis.NPCStateDelta.cardSettings(), mockState, sleep });
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log('RESULT:' + JSON.stringify(result));
`;
    const out = execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out.split('\n').find(line => line.startsWith('RESULT:')).slice('RESULT:'.length));
}

test('card settings: the extension definition reads the live settings', () => {
    const result = runInHost(async ({ card }) => ({
        owner: card.owner,
        format: card.read('portraitPromptFormat'),
        scan: card.read('scanEvery'),
    }), { settings: { scanEvery: 9, portraitPromptFormat: 'tags' } });
    assert.equal(result.owner, 'npc-state-delta');
    assert.equal(result.format, 'tags');
    assert.equal(result.scan, 9);
});

test('card settings: apply persists the prompt format like "Save prompt settings" and Scan every like its box; a reload reads them back', () => {
    const first = runInHost(async ({ card, mockState }) => {
        const def = card;
        const savesBefore = mockState.saveSettingsCalls;
        const out = await def.apply({ portraitPromptFormat: 'natural', scanEvery: 7 });
        return {
            out,
            savedToHost: mockState.saveSettingsCalls > savesBefore,
            stored: JSON.parse(JSON.stringify(mockState.extensionSettings.npc_state_delta)),
            readBack: [def.read('portraitPromptFormat'), def.read('scanEvery')],
        };
    });
    assert.deepEqual(first.out, { applied: ['portraitPromptFormat', 'scanEvery'] });
    assert.equal(first.savedToHost, true, 'the format went through the host save the Save button uses');
    assert.equal(first.stored.portraitPromptFormat, 'natural');
    assert.equal(first.stored.scanEvery, 7);
    assert.deepEqual(first.readBack, ['natural', 7]);
    // A reload: a fresh host starts from what was stored.
    const second = runInHost(async ({ card }) => ({ format: card.read('portraitPromptFormat'), scan: card.read('scanEvery') }), { settings: first.stored });
    assert.deepEqual(second, { format: 'natural', scan: 7 });
});

test('card settings: with a custom portrait preset active, apply changes the preset\'s own format too', () => {
    const result = runInHost(async ({ card, mockState }) => {
        const def = card;
        const before = def.read('portraitPromptFormat');
        await def.apply({ portraitPromptFormat: 'tags' });
        const s = mockState.extensionSettings.npc_state_delta;
        const active = (s.portraitCustomPresets || []).find(item => item.id === s.portraitCustomPresetId);
        return { before, after: def.read('portraitPromptFormat'), theme: s.portraitThemePreset, preset: active?.promptFormat, setting: s.portraitPromptFormat };
    }, { settings: { scanEvery: 1, portraitThemePreset: 'custom' } });
    assert.equal(result.theme, 'custom');
    assert.equal(result.after, 'tags');
    assert.equal(result.setting, 'tags');
    assert.equal(result.preset, 'tags');
});
