import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cancelScannerRequests, dispatchScannerRequest, scannerRoutingMetrics,
    selectedScannerProfileId, scannerProfileOptions,
} from '../scanner-routing.js';

const payload = { systemPrompt: 'scanner system', prompt: 'scanner payload', responseLength: 777, quietToLoud: false, instructOverride: true, trimNames: false };
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function fixture(profileId = '') {
    const calls = { host: [], profile: [] };
    const profiles = [{ id: 'fast', name: 'Scanner Fast', supported: true, model: 'scanner-model' }];
    const ctx = {
        extensionSettings: { npc_state_delta: { scannerConnectionProfile: profileId }, connectionManager: { profiles, selectedProfile: 'roleplay' }, disabledExtensions: [] },
        generateRaw(options) { calls.host.push(options); return Promise.resolve('{"npcs":[]}'); },
        ConnectionManagerRequestService: {
            getProfile(id) { const found = profiles.find(p => p.id === id); if (!found) throw new Error('missing'); return found; },
            isProfileSupported(p) { return p.supported !== false; },
            sendRequest(...args) { calls.profile.push(args); return Promise.resolve({ content: '{"npcs":[]}' }); },
        },
    };
    return { ctx, calls, profiles };
}
const code = expected => error => error?.code === expected;

test('default uses unchanged generateRaw options exactly once and creates no settings', async () => {
    const { ctx, calls } = fixture();
    delete ctx.extensionSettings.npc_state_delta;
    const before = structuredClone(ctx.extensionSettings);
    assert.equal(await dispatchScannerRequest(ctx, payload), '{"npcs":[]}');
    assert.equal(calls.host.length, 1);
    assert.equal(calls.host[0], payload);
    assert.equal(calls.profile.length, 0);
    assert.deepEqual(ctx.extensionSettings, before);
    assert.equal(selectedScannerProfileId(ctx), '');
});

test('selected profile uses request-local host API, token limit, and scanner-only messages', async () => {
    const { ctx, calls } = fixture('fast');
    const before = structuredClone(ctx.extensionSettings);
    assert.equal(await dispatchScannerRequest(ctx, payload), '{"npcs":[]}');
    assert.equal(calls.host.length, 0);
    assert.equal(calls.profile.length, 1);
    const [id, messages, maxTokens, custom] = calls.profile[0];
    assert.equal(id, 'fast');
    assert.equal(maxTokens, 777);
    assert.deepEqual(messages, [{ role: 'system', content: 'scanner system' }, { role: 'user', content: 'scanner payload' }]);
    assert.equal(custom.stream, false);
    assert.equal(custom.extractData, true);
    assert.equal(custom.includePreset, true);
    assert.equal(custom.includeInstruct, true);
    assert.ok(custom.signal instanceof AbortSignal);
    assert.deepEqual(ctx.extensionSettings, before);
});

test('operation-pinned profile does not follow a changed global selection on retry', async () => {
    const { ctx, calls } = fixture('fast');
    const route = { profileId: 'fast' };
    await dispatchScannerRequest(ctx, payload, { route });
    ctx.extensionSettings.npc_state_delta.scannerConnectionProfile = '';
    await dispatchScannerRequest(ctx, { ...payload, responseLength: 5200 }, { route, label: 'scanner JSON retry' });
    assert.deepEqual(calls.profile.map(args => args[0]), ['fast', 'fast']);
    assert.equal(calls.profile[1][2], 5200);
    assert.equal(calls.host.length, 0);
});

test('a pinned default remains default even when a profile is selected later', async () => {
    const { ctx, calls } = fixture('fast');
    await dispatchScannerRequest(ctx, payload, { route: { profileId: '' } });
    assert.equal(calls.host.length, 1);
    assert.equal(calls.profile.length, 0);
});

for (const kind of ['missing', 'unsupported', 'disabled']) test(`${kind} profile never falls back or counts a provider invocation`, async () => {
    const { ctx, calls, profiles } = fixture(kind === 'missing' ? 'deleted' : 'fast');
    if (kind === 'unsupported') profiles[0].supported = false;
    if (kind === 'disabled') ctx.extensionSettings.disabledExtensions.push('connection-manager');
    const before = scannerRoutingMetrics();
    await assert.rejects(dispatchScannerRequest(ctx, payload), code('NPC_SCANNER_PROFILE_UNAVAILABLE'));
    assert.equal(calls.host.length + calls.profile.length, 0);
    assert.equal(scannerRoutingMetrics().total, before.total);
    assert.equal(scannerRoutingMetrics().rejected, before.rejected + 1);
    assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, 'roleplay');
});

test('malformed API type throwing in host support check fails closed', async () => {
    const { ctx, calls } = fixture('fast');
    ctx.ConnectionManagerRequestService.isProfileSupported = () => { throw new Error('unknown API'); };
    await assert.rejects(dispatchScannerRequest(ctx, payload), code('NPC_SCANNER_PROFILE_UNAVAILABLE'));
    assert.equal(calls.host.length + calls.profile.length, 0);
});

test('provider failure has an actionable error, no retry/fallback, and redacted metrics', async () => {
    const { ctx, calls } = fixture('fast');
    ctx.ConnectionManagerRequestService.sendRequest = () => { calls.profile.push([]); throw new Error('secret-key-in-url'); };
    await assert.rejects(dispatchScannerRequest(ctx, payload), error => error.code === 'NPC_SCANNER_PROFILE_REQUEST_FAILED' && /credentials/.test(error.message));
    assert.equal(calls.profile.length, 1);
    assert.equal(calls.host.length, 0);
    assert.doesNotMatch(JSON.stringify(scannerRoutingMetrics()), /secret-key-in-url|scanner payload|scanner system/);
});

for (const value of [null, {}, { content: {} }, () => {}]) test(`invalid profile response ${typeof value} does not coerce to fake JSON`, async () => {
    const { ctx } = fixture('fast');
    ctx.ConnectionManagerRequestService.sendRequest = async () => value;
    await assert.rejects(dispatchScannerRequest(ctx, payload), code('NPC_SCANNER_PROFILE_RESPONSE'));
});

for (const routeName of ['default', 'profile']) {
    test(`${routeName} timeout settles even if the provider ignores abort`, async () => {
        const { ctx } = fixture(routeName === 'profile' ? 'fast' : '');
        const held = deferred();
        let signal;
        if (routeName === 'profile') ctx.ConnectionManagerRequestService.sendRequest = (...args) => { signal = args[3].signal; return held.promise; };
        else ctx.generateRaw = () => held.promise;
        const before = scannerRoutingMetrics();
        await assert.rejects(dispatchScannerRequest(ctx, payload, { timeoutMs: 10 }), code('NPC_SCANNER_ROUTE_TIMEOUT'));
        if (signal) assert.equal(signal.aborted, true);
        assert.equal(scannerRoutingMetrics().inflight, 0);
        held.resolve({ content: '{"npcs":[]}' });
        await Promise.resolve();
        assert.equal(scannerRoutingMetrics().timedOut, before.timedOut + 1);
        assert.equal(scannerRoutingMetrics().succeeded, before.succeeded);
    });
    test(`${routeName} scope cancellation rejects late output without changing roleplay settings`, async () => {
        const { ctx } = fixture(routeName === 'profile' ? 'fast' : '');
        const held = deferred(), entered = deferred();
        const controller = new AbortController();
        if (routeName === 'profile') ctx.ConnectionManagerRequestService.sendRequest = () => { entered.resolve(); return held.promise; };
        else ctx.generateRaw = () => { entered.resolve(); return held.promise; };
        const pending = dispatchScannerRequest(ctx, payload, { signal: controller.signal });
        await entered.promise;
        controller.abort();
        await assert.rejects(pending, code('NPC_SCANNER_ROUTE_CANCELLED'));
        held.reject(new Error('late provider failure'));
        await Promise.resolve();
        assert.equal(scannerRoutingMetrics().inflight, 0);
        assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, 'roleplay');
    });
}

test('pre-aborted and expired scopes make zero provider calls', async () => {
    const { ctx, calls } = fixture('fast');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(dispatchScannerRequest(ctx, payload, { signal: controller.signal }), code('NPC_SCANNER_ROUTE_CANCELLED'));
    await assert.rejects(dispatchScannerRequest(ctx, payload, { deadline: Date.now() - 1 }), code('NPC_SCANNER_ROUTE_TIMEOUT'));
    assert.equal(calls.host.length + calls.profile.length, 0);
});

test('stale scope rejects before dispatch and after response', async () => {
    const { ctx, calls } = fixture('fast');
    await assert.rejects(dispatchScannerRequest(ctx, payload, { isCurrent: () => false }), code('NPC_SCANNER_ROUTE_CANCELLED'));
    assert.equal(calls.profile.length, 0);
    let current = true;
    ctx.ConnectionManagerRequestService.sendRequest = async () => { current = false; return { content: '{"npcs":[]}' }; };
    await assert.rejects(dispatchScannerRequest(ctx, payload, { isCurrent: () => current }), code('NPC_SCANNER_ROUTE_CANCELLED'));
});

test('cancellation is isolated to the owning chat and operation', async () => {
    const { ctx } = fixture('fast');
    const first = deferred(), second = deferred(), entered = deferred();
    let n = 0;
    ctx.ConnectionManagerRequestService.sendRequest = () => { n += 1; if (n === 2) entered.resolve(); return n === 1 ? first.promise : second.promise; };
    const a = dispatchScannerRequest(ctx, payload, { chatKey: 'a', operationId: 1 });
    const b = dispatchScannerRequest(ctx, payload, { chatKey: 'b', operationId: 2 });
    await entered.promise;
    assert.equal(cancelScannerRequests('expired owner', { chatKey: 'a', operationId: 1 }), 1);
    await assert.rejects(a, code('NPC_SCANNER_ROUTE_CANCELLED'));
    second.resolve({ content: '{"npcs":[]}' });
    assert.equal(await b, '{"npcs":[]}');
    first.resolve({ content: 'late' });
    assert.equal(scannerRoutingMetrics().inflight, 0);
});

test('profile edits invalidate later retry/focused calls in the same route', async () => {
    const { ctx, calls, profiles } = fixture('fast');
    const route = { profileId: 'fast' };
    await dispatchScannerRequest(ctx, payload, { route });
    profiles[0].model = 'new-model';
    await assert.rejects(dispatchScannerRequest(ctx, payload, { route }), code('NPC_SCANNER_PROFILE_CHANGED'));
    assert.equal(calls.profile.length, 1);
    assert.equal(calls.host.length, 0);
});

test('profile deletion during a response prevents accepting that response', async () => {
    const { ctx, profiles } = fixture('fast');
    ctx.ConnectionManagerRequestService.sendRequest = async () => { profiles.length = 0; return { content: '{"npcs":[]}' }; };
    await assert.rejects(dispatchScannerRequest(ctx, payload), code('NPC_SCANNER_PROFILE_CHANGED'));
});

test('profile option projection preserves unavailable selections without owning settings', () => {
    const { ctx } = fixture('deleted');
    const before = structuredClone(ctx.extensionSettings);
    const options = scannerProfileOptions(ctx);
    assert.ok(options.some(option => option.id === 'deleted' && /Unavailable/.test(option.name)));
    assert.equal(options[0].id, '');
    assert.deepEqual(ctx.extensionSettings, before);
});

test('metrics distinguish actual calls from rejected preflights and keep terminal totals consistent', () => {
    const m = scannerRoutingMetrics();
    assert.equal(m.total, m.defaultRoute + m.profileRoute);
    assert.equal(m.total, m.succeeded + m.failed + m.timedOut + m.cancelled);
    assert.equal(m.attempts, m.total + m.rejected);
    assert.equal(m.inflight, 0);
    m.last.code = 'mutation';
    assert.notEqual(scannerRoutingMetrics().last.code, 'mutation');
});
