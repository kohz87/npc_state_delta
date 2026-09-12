import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    configuredScannerMaxOutputTokens,
    dispatchScannerRequest,
    normalizeScannerMaxOutputTokens,
    SCANNER_MAX_OUTPUT_TOKENS_MAX,
} from '../scanner-routing.js';

function fixture(profileId = '') {
    const calls = { host: [], profile: [] };
    const profiles = [{ id: 'fast', name: 'Fast' }];
    const ctx = {
        extensionSettings: {
            npc_state_delta: { scannerConnectionProfile: profileId, scannerMaxOutputTokens: 0 },
            connectionManager: { profiles },
            disabledExtensions: [],
        },
        generateRaw(options) { calls.host.push(options); return Promise.resolve('{"npcs":[]}'); },
        ConnectionManagerRequestService: {
            getProfile(id) { return profiles.find(profile => profile.id === id); },
            isProfileSupported() { return true; },
            sendRequest(...args) { calls.profile.push(args); return Promise.resolve({ content: '{"npcs":[]}' }); },
        },
    };
    return { ctx, calls };
}

test('scanner output setting normalizes disabled, bounded, and oversized values', () => {
    assert.equal(normalizeScannerMaxOutputTokens(undefined), 0);
    assert.equal(normalizeScannerMaxOutputTokens(0), 0);
    assert.equal(normalizeScannerMaxOutputTokens(-1), 0);
    assert.equal(normalizeScannerMaxOutputTokens(1), 128);
    assert.equal(normalizeScannerMaxOutputTokens(4096.4), 4096);
    assert.equal(normalizeScannerMaxOutputTokens(999999), SCANNER_MAX_OUTPUT_TOKENS_MAX);
});

test('configured scanner output setting remains separate from the roleplay connection', () => {
    const { ctx } = fixture('fast');
    ctx.extensionSettings.npc_state_delta.scannerMaxOutputTokens = 12000;
    assert.equal(configuredScannerMaxOutputTokens(ctx), 12000);
    assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, undefined);
});

test('default scanner route applies the configured maximum only to scanner request options', async () => {
    const { ctx, calls } = fixture('');
    ctx.extensionSettings.npc_state_delta.scannerMaxOutputTokens = 7000;
    const payload = { prompt: 'scan', responseLength: 1800 };
    await dispatchScannerRequest(ctx, payload, { route: { profileId: '' } });
    assert.equal(calls.host.length, 1);
    assert.equal(calls.host[0].responseLength, 7000);
    assert.equal(payload.responseLength, 1800, 'caller-owned request object must not be mutated');
});

test('profile scanner route applies and pins the configured maximum across later calls', async () => {
    const { ctx, calls } = fixture('fast');
    ctx.extensionSettings.npc_state_delta.scannerMaxOutputTokens = 9000;
    const route = { profileId: 'fast' };
    await dispatchScannerRequest(ctx, { prompt: 'scan', responseLength: 1800 }, { route });
    ctx.extensionSettings.npc_state_delta.scannerMaxOutputTokens = 3000;
    await dispatchScannerRequest(ctx, { prompt: 'retry', responseLength: 5200 }, { route });
    assert.equal(calls.profile.length, 2);
    assert.deepEqual(calls.profile.map(call => call[2]), [9000, 9000]);
    assert.equal(route.maxOutputTokens, 9000);
});

test('zero scanner output setting preserves built-in request lengths', async () => {
    const { ctx, calls } = fixture('fast');
    ctx.extensionSettings.npc_state_delta.scannerMaxOutputTokens = 0;
    await dispatchScannerRequest(ctx, { prompt: 'relationship', responseLength: 900 }, { route: { profileId: 'fast' } });
    assert.equal(calls.profile[0][2], 900);
});

test('scanner output UI keeps settings bounded, groups full cast with scanning, and keeps cast cards taller', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.match(source, /Maximum output tokens/);
    assert.match(source, /FULL_CAST_CONTROL_ID = 'npc_state_delta_full_cast_scan'/);
    assert.match(source, /function moveFullCastIntoScanning/);
    assert.match(source, /npc_state_delta_full_scan_every_turn/);
    assert.match(source, /npc-state-delta-actions:not\(\.delta-settings-maintenance-actions\)[^}]*flex-wrap:wrap/s);
    assert.match(source, /delta-settings-maintenance-actions\{display:grid!important;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/s);
    assert.match(source, /delta-settings-maintenance-actions>\.menu_button[^}]*width:100%!important/s);
    assert.match(source, /delta-scanner-output-row[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(150px,180px\)/s);
    assert.match(source, /@media\(max-width:760px\)[\s\S]*delta-scanner-output-row\{grid-template-columns:minmax\(0,1fr\)!important/s);
    assert.match(source, /delta-cast-card[^}]*height:168px/s);
    assert.match(source, /@media\(max-width:620px\)[\s\S]*height:150px/);
    assert.match(source, /roleplay or image-generation limits/);
});
