import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cancelScannerRequests,
    dispatchScannerRequest,
    scannerRoutingMetrics,
    selectedScannerProfileId,
} from '../scanner-routing.js';

function makeContext({ profileId = '', profiles = [], responder = null } = {}) {
    const calls = { host: [], profile: [] };
    const extensionSettings = {
        npc_state_delta: { scannerConnectionProfile: profileId },
        connectionManager: { profiles },
    };
    const service = {
        getProfile(id) {
            const profile = profiles.find(item => item.id === id);
            if (!profile) throw new Error(`Profile not found (ID: ${id})`);
            return profile;
        },
        isProfileSupported(profile) { return Boolean(profile?.supported !== false); },
        async sendRequest(id, prompt, maxTokens, options) {
            calls.profile.push({ id, prompt, maxTokens, options });
            if (responder) return responder({ id, prompt, maxTokens, options });
            return { content: '{"npcs":[]}' };
        },
    };
    return {
        calls,
        context: {
            extensionSettings,
            ConnectionManagerRequestService: service,
            async generateRaw(options) {
                calls.host.push(options);
                return '{"npcs":[]}';
            },
        },
    };
}

test('default scanner route preserves the existing host generateRaw path', async () => {
    const { context, calls } = makeContext();
    const result = await dispatchScannerRequest(context, {
        systemPrompt: 'scanner system',
        prompt: 'scanner payload',
        responseLength: 321,
    }, { label: 'automatic dossier scan' });
    assert.equal(result, '{"npcs":[]}');
    assert.equal(calls.host.length, 1);
    assert.equal(calls.profile.length, 0);
    assert.equal(selectedScannerProfileId(context), '');
});

test('selected scanner profile uses request-scoped Connection Manager routing only', async () => {
    const { context, calls } = makeContext({
        profileId: 'scan-fast',
        profiles: [{ id: 'scan-fast', name: 'Scanner Fast', supported: true }],
    });
    const result = await dispatchScannerRequest(context, {
        systemPrompt: 'scanner system',
        prompt: 'scanner payload',
        responseLength: 777,
    }, { label: 'focused relationship pass' });
    assert.equal(result, '{"npcs":[]}');
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 1);
    assert.equal(calls.profile[0].id, 'scan-fast');
    assert.equal(calls.profile[0].maxTokens, 777);
    assert.deepEqual(calls.profile[0].prompt, [
        { role: 'system', content: 'scanner system' },
        { role: 'user', content: 'scanner payload' },
    ]);
    assert.equal(calls.profile[0].options.stream, false);
    assert.equal(calls.profile[0].options.extractData, true);
    assert.equal(calls.profile[0].options.includePreset, true);
    assert.equal(calls.profile[0].options.includeInstruct, true);
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, undefined);
});

test('missing selected profile is recoverable and never silently falls back', async () => {
    const { context, calls } = makeContext({ profileId: 'deleted-profile' });
    await assert.rejects(
        dispatchScannerRequest(context, { prompt: 'payload', responseLength: 100 }, { label: 'manual dossier scan' }),
        error => error?.code === 'NPC_SCANNER_PROFILE_UNAVAILABLE' && /deleted-profile/.test(error.message),
    );
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 0);
    assert.equal(selectedScannerProfileId(context), 'deleted-profile');
});

test('unsupported selected profile fails without changing the roleplay connection', async () => {
    const { context, calls } = makeContext({
        profileId: 'unsupported',
        profiles: [{ id: 'unsupported', name: 'Unsupported', supported: false }],
    });
    context.extensionSettings.connectionManager.selectedProfile = 'roleplay-main';
    await assert.rejects(
        dispatchScannerRequest(context, { prompt: 'payload', responseLength: 100 }),
        error => error?.code === 'NPC_SCANNER_PROFILE_UNAVAILABLE' && /not supported/.test(error.message),
    );
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, 'roleplay-main');
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 0);
});

test('cancelling an in-flight profile request aborts it and does not fall back', async () => {
    let entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const { context, calls } = makeContext({
        profileId: 'scan-slow',
        profiles: [{ id: 'scan-slow', name: 'Scanner Slow', supported: true }],
        responder: ({ options }) => new Promise((resolve, reject) => {
            entered();
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    });
    const pending = dispatchScannerRequest(context, { prompt: 'payload', responseLength: 100 }, { label: 'backfill' });
    await enteredPromise;
    assert.equal(cancelScannerRequests('chat changed'), 1);
    await assert.rejects(pending, error => error?.code === 'NPC_SCANNER_ROUTE_CANCELLED');
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 1);
    assert.equal(scannerRoutingMetrics().inflight, 0);
});

test('profile timeout aborts the scoped request without host fallback', async () => {
    const before = scannerRoutingMetrics();
    const { context, calls } = makeContext({
        profileId: 'scan-timeout',
        profiles: [{ id: 'scan-timeout', name: 'Scanner Timeout', supported: true }],
        responder: ({ options }) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    });
    await assert.rejects(
        dispatchScannerRequest(context, { prompt: 'payload', responseLength: 100 }, { label: 'timeout pass', timeoutMs: 25 }),
        error => error?.code === 'NPC_SCANNER_ROUTE_TIMEOUT',
    );
    const after = scannerRoutingMetrics();
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 1);
    assert.equal(after.timedOut, before.timedOut + 1);
    assert.equal(after.inflight, 0);
    assert.equal(after.last.outcome, 'timeout');
});

test('scanner routing metrics count actual dispatcher requests, including route and outcome', async () => {
    const before = scannerRoutingMetrics();
    const { context } = makeContext();
    await dispatchScannerRequest(context, { prompt: 'payload', responseLength: 100 }, { label: 'retry request' });
    const after = scannerRoutingMetrics();
    assert.equal(after.total, before.total + 1);
    assert.equal(after.defaultRoute, before.defaultRoute + 1);
    assert.equal(after.succeeded, before.succeeded + 1);
    assert.equal(after.last.label, 'retry request');
    assert.equal(after.last.route, 'default');
    assert.equal(after.last.outcome, 'success');
});
