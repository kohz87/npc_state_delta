// Settings round 3 (the user's live test #4): Delta's section in Story Block's Settings → Diagnostics
// (the module's optional hooks.diagnostics: the scanner's route, profile, calls and last outcome), the
// plain note when there is no connection profile to pick, and the panel's drawer held open inside Story
// Block's module fold (two levels, never three).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scannerDiagnosticLines } from '../scanner-routing.js';
import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

function ctxWith(profiles, { disabled = [], service = true } = {}) {
    return {
        extensionSettings: { connectionManager: { profiles }, disabledExtensions: disabled },
        ...(service ? {
            ConnectionManagerRequestService: {
                isProfileSupported: profile => Boolean(profile?.api),
                sendRequest: async () => ({ content: '{}' }),
            },
        } : {}),
    };
}
const PROFILES = [{ id: 'fast', name: 'Scanner Fast', api: 'custom', 'api-url': 'http://10.1.2.3:5000/v1', 'secret-id': 'sec-123' }];
const idle = { total: 0, defaultRoute: 0, profileRoute: 0, succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, rejected: 0, inflight: 0, last: null };

test('the scanner lines: the current connection, no calls yet', () => {
    const lines = scannerDiagnosticLines({ ctx: ctxWith(PROFILES), settings: { autoScan: true }, metrics: idle, enabled: true });
    assert.deepEqual(lines, [
        'Delta on: yes. Auto scan: yes. Full scan every turn: no. One-pass narration capture: no.',
        'Connection Profiles: 1 usable for text.',
        'Scanner route: the current roleplay connection.',
        'Scanner output limit: the default per pass.',
        'Calls this page load: 0 sent (current connection 0, profile 0); succeeded 0, failed 0, timed out 0, cancelled 0, refused before sending 0; in flight 0.',
        'Last call: none yet.',
    ]);
});

test('the scanner lines: a picked profile by name and id, the last call\'s outcome, never an address, key or NPC name', () => {
    const metrics = {
        ...idle, total: 3, profileRoute: 3, succeeded: 2, failed: 1,
        last: { label: 'chat refresh for Anna Kessler (JSON retry)', route: 'profile', profileId: 'fast', dispatched: true, outcome: 'failure', code: 'NPC_SCANNER_PROFILE_REQUEST_FAILED', durationMs: 1234, effectiveResponseLength: 1800, at: 1000 },
    };
    const lines = scannerDiagnosticLines({ ctx: ctxWith(PROFILES), settings: { scannerConnectionProfile: 'fast', scannerMaxOutputTokens: 2000 }, metrics, now: 6000 });
    assert.ok(lines.includes('Scanner route: the profile Scanner Fast (id fast), available.'));
    assert.ok(lines.includes('Scanner output limit: 2000 tokens.'));
    assert.ok(lines.includes('Calls this page load: 3 sent (current connection 0, profile 3); succeeded 2, failed 1, timed out 0, cancelled 0, refused before sending 0; in flight 0.'));
    assert.equal(lines.at(-1), 'Last call: chat refresh, through the profile, sent, failure (NPC_SCANNER_PROFILE_REQUEST_FAILED), 1.2 s, asked for 1800 tokens, 5 s ago.');
    const all = lines.join('\n');
    for (const leak of ['10.1.2.3', 'sec-123', 'http', 'Anna', 'Kessler']) assert.ok(!all.includes(leak), leak);
});

test('the scanner lines: a missing profile fails closed, Connection Profiles off or absent is said plainly', () => {
    const missing = scannerDiagnosticLines({ ctx: ctxWith(PROFILES), settings: { scannerConnectionProfile: 'gone' }, metrics: idle });
    assert.ok(missing.some(line => /profile id gone, which is missing or not usable for text: scans fail until another is picked \(no fallback\)/.test(line)));
    const off = scannerDiagnosticLines({ ctx: ctxWith(PROFILES, { disabled: ['connection-manager'] }), settings: {}, metrics: idle });
    assert.ok(off.includes('Connection Profiles: turned off in SillyTavern.'));
    const none = scannerDiagnosticLines({ ctx: ctxWith([], { service: false }), settings: {}, metrics: idle });
    assert.ok(none.includes('Connection Profiles: this SillyTavern has no Connection Manager request service.'));
    assert.doesNotThrow(() => scannerDiagnosticLines());
});

function fakeDoc() {
    return { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent: () => true, createElement: () => ({ dataset: {}, style: {}, appendChild() {}, replaceChildren() {} }) };
}

test('the module definition offers hooks.diagnostics: the scanner report, the dossier counts, hosted or not', () => {
    const report = ['Scanner route: the current roleplay connection.'];
    const a = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [{ id: '1', name: 'Fenna', present: true, archived: false }, { id: '2', name: 'Bram', present: false, archived: true }] },
        delta: () => ({ isEnabled: () => true, scannerReport: () => report }),
        host: () => null, doc: fakeDoc(), logger: { warn() {} },
    });
    const hook = a.definition.hooks.diagnostics;
    assert.equal(typeof hook, 'function');
    const lines = hook();
    assert.equal(lines[0], report[0]);
    assert.ok(lines.includes('Dossiers in this chat: 1 active, 1 archived, 1 present.'));
    assert.ok(lines.includes('Hosted in Story Block: no. Settings panel in the overlay: no.'));
    for (const name of ['Fenna', 'Bram']) assert.ok(!lines.join('\n').includes(name), 'no NPC names');
    // Delta not loaded yet: one plain line.
    const early = createStorySuiteV2Adapter({ delta: () => null, host: () => null, doc: fakeDoc(), logger: { warn() {} } });
    assert.deepEqual(early.definition.hooks.diagnostics(), ['NPC State Delta is still loading (no scanner report yet).']);
});

test('the scanner profile list says plainly when there is no profile to pick; the drawer is held open in Story Block\'s fold', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /id="npc_state_delta_scanner_profile_none"[^>]*hidden> There is no connection profile yet/);
    assert.match(index, /\$\('#npc_state_delta_scanner_profile_none'\)\.prop\('hidden', usable\)/);
    assert.match(index, /scannerReport: \(\) => scannerDiagnosticLines\(/);
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.story-suite-section \.story-suite-drawer > \.inline-drawer-content \{ display: block !important; \}/);
    assert.match(css, /\.story-suite-section \.story-suite-drawer > \.inline-drawer-header \{ display: none !important; \}/);
});
