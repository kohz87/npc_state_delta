import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const core = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('successful hydration is the only default authority transition', () => {
    assert.match(index, /function setChatState\(key, state, \{ markLoaded = false \} = \{\}\)/);
    assert.match(index, /setChatState\(key, sourceState, \{ markLoaded: true \}\)/);
    assert.match(index, /requireReadyChatMutation\('save chat dossier changes'/);
    assert.match(index, /refused to queue an unhydrated state write/);
});

test('hydration errors render an explicit read-only retry surface', () => {
    assert.match(index, /Dossier load failed/);
    assert.match(index, /Retry Load/);
    assert.match(index, /npc-state-delta-retry-hydration/);
    assert.match(index, /Existing sidecar data is preserved and all dossier writes are locked/);
});

test('rename verifies new storage before switching ownership', () => {
    const fn = index.slice(index.indexOf('async function moveRenamedChatState'), index.indexOf('function flushCurrentChatOnPageHide'));
    const write = fn.indexOf('writeNpcStateDataFile');
    const verify = fn.indexOf('readNpcStateDataFile(newPointer');
    const retire = fn.indexOf('retireNpcStateDataFile');
    const switchPointer = fn.indexOf('settings.dataFiles[newKey] = newPointer');
    assert.ok(write >= 0 && verify > write && retire > verify && switchPointer > retire);
    assert.match(fn, /original durable ownership remains recoverable/);
    assert.match(fn, /makeNpcStateDataFileName\(newKey\)/);
});

test('scan timeout drains coalesced automatic work', () => {
    const block = index.slice(index.indexOf('onExpire: operation =>'), index.indexOf('function isScanBusy'));
    assert.match(block, /pendingAutoScans\.has\(operation\.key\)/);
    assert.match(block, /drainPendingAutoScan\(operation\.key\)/);
});

test('automatic backfill retries are durable cooled down bounded and version-scoped', () => {
    assert.match(index, /BACKFILL_MAX_ATTEMPTS = 3/);
    assert.match(index, /BACKFILL_RETRY_COOLDOWN_MS = 60 \* 1000/);
    assert.match(index, /\.map\(normalizeAutomaticBackfillRequest\)/);
    assert.match(index, /attempts: Math\.max\(0, Math\.min\(BACKFILL_MAX_ATTEMPTS, item\.attempts\)\)/);
    assert.match(index, /queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION/);
    assert.match(index, /automaticBackfillStillRelevant\(request, target, state\.npcs, owningExchange\)/);
    assert.match(index, /stopped automatic backfill retries/);
});

test('editor and portrait workflows are chat-affine', () => {
    assert.match(index, /let activeEditorChatKey = ''/);
    assert.match(index, /let activePortraitGeneratorChatKey = ''/);
    assert.match(index, /activeEditorChatKey = originChatKey/);
    assert.match(index, /activePortraitGeneratorChatKey = originChatKey/);
    assert.match(index, /originRevision = Number\(stateVersions\.get\(originChatKey\)/);
    assert.match(index, /closePortraitGenerator\(\);\n\s*closeNpcViewer\(\);\n\s*closeNpcEditor\(\);/);
});

test('Delta application metadata is v1.0.55 and active core ownership is semantic', () => {
    assert.match(core, /NPC_STATE_VERSION = '1\.0\.55'/);
    assert.match(core, /export \* from '\.\/core-mechanics\.js'/);
    assert.doesNotMatch(core, /NPC_STATE_SOURCE_ENGINE_VERSION|core-v0218/);
    assert.equal(manifest.version, '1.0.55');
    assert.equal(manifest.author, 'kohz87');
});


test('portrait custom presets use the current named persistent library without legacy field migration', () => {
    assert.match(index, /schemaVersion: 30/);
    assert.match(index, /older Delta schemas are unsupported/);
    assert.doesNotMatch(index, /previousSchema|legacy\.portraitStyle/);
    assert.match(index, /portraitCustomPresets/);
    assert.match(index, /portraitCustomPresetId/);
});

test('portrait custom preset library exposes named management and keeps visual controls per preset', () => {
    for (const id of [
        'npc_state_delta_portrait_custom_preset',
        'npc_state_delta_portrait_custom_add',
        'npc_state_delta_portrait_custom_duplicate',
        'npc_state_delta_portrait_custom_rename',
        'npc_state_delta_portrait_custom_delete',
    ]) assert.match(index, new RegExp(id));
    assert.match(index, /PORTRAIT_CUSTOM_PRESET_LIMIT = 24/);
    assert.match(index, /promptFormat: next\.portraitPromptFormat/);
    assert.match(index, /useMood: next\.portraitUseMood/);
    assert.match(index, /useLocation: next\.portraitUseLocation/);
    assert.match(index, /composition: next\.portraitComposition/);
    assert.match(index, /portraitSaveToGallery: source\.portraitSaveToGallery === true/);
    assert.match(index, /const settings = portraitSettingsSnapshot\(getSettings\(\)\)/);
    assert.match(index, /Custom · \$\{preset\.name\}/);
});

test('portrait custom preset CRUD is durable, dirty-safe, and name-unambiguous', () => {
    assert.match(index, /async function persistPortraitCustomPresetLibrary/);
    assert.match(index, /await saveHostSettings\(\)/);
    assert.match(index, /custom portrait preset save failed/);
    assert.match(index, /portraitCustomPresetNameTaken/);
    assert.match(index, /uniquePortraitCustomPresetName/);
    assert.match(index, /portraitSettingsDirty && !\(await savePortraitSettingsDraft\(\)\)/);
    assert.match(index, /operational: snapshot/);
    assert.match(index, /Math\.min\(Math\.max\(0, targetIndex\), presets\.length - 1\)/);
});
