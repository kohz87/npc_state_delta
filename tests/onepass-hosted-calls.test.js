import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// (user decision 5, b6-soak-2) Model calls per reply in one-pass mode, through Delta's real event
// handlers on the synthetic SillyTavern host (runtime-smoke.mjs), alone or beside a fake Story Block
// v2 with the npc meters slice. Hosted, an ordinary one-pass reply makes no model call of Delta's
// own: no focused relationship pass, no backfill. Without a host the calls are the ones Delta always
// made (a new dossier's backfill, an evaluator for a relationship the block left open), and queued
// backfills no longer hold the reply.

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runCalls(name, hosted, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.documentElement = { dataset: {} };
globalThis.document.readyState = 'loading';
fs.cpSync(path.join(sourceRoot, 'src'), path.join(extRoot, 'src'), { recursive: true });
mockState.storyBlockTabs = [];
mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
mockState.context.eventTypes.GENERATION_STOPPED = 'generation_stopped';
mockState.context.eventTypes.CHAT_COMPLETION_PROMPT_READY = 'chat_completion_prompt_ready';
mockState.context.updateMessageBlock = () => {};
if (${hosted}) {
    const sdk = {
        registered: [], sent: [],
        registerModule(def) { sdk.registered.push(def); },
        command: async (type, payload, options) => { sdk.sent.push({ type, payload, options: options ?? null }); return { ok: true, receipt: { summary: '' } }; },
        query: () => null,
        settings: () => ({}),
    };
    mockState.sdk = sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
}
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await import(pathToFileURL(path.join(extRoot, 'story-block-tabs.js')).href);
    await sleep(30);
    if (${hosted}) await waitFor(() => mockState.sdk.registered.length === 1);
    const settings = mockState.extensionSettings.npc_state_delta;
    settings.narrationCapture = true;
    globalThis.ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
    // A backfill finds the NPC it asks for; every other request finds nothing new.
    mockState.quietResponder = async (args = {}) => {
        const asked = String(args.prompt || '').match(/^Requested NPC: (.+)$/m)?.[1];
        return asked ? JSON.stringify({ npcs: [{ name: asked, present: true, role: 'regular', relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
    };
    const emitAll = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); };
    const kinds = () => {
        const out = { scanner: 0, relationship: 0, backfill: 0, refresh: 0 };
        for (const call of mockState.rawCalls) {
            const system = String(call?.[0]?.systemPrompt || '');
            if (/isolated dossier scanner\\./i.test(system)) out.scanner += 1;
            else if (/relationship evaluator/i.test(system)) out.relationship += 1;
            else if (/backfill scanner/i.test(system)) out.backfill += 1;
            else if (/reconciliation scanner/i.test(system)) out.refresh += 1;
        }
        return out;
    };
    const minus = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] - b[key]]));
    // One reply with a capture block: the calls the reply's MESSAGE_RECEIVED awaited, and all the
    // calls it led to once Delta settled.
    const reply = async (text, payload, { unterminated = false } = {}) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
        await emitAll('message_sent', mockState.context.chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const mes = payload === null ? text : text + '\\n\\n<!--npc_state_delta\\n' + raw + (unterminated ? '' : '\\n-->');
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
        const id = mockState.context.chat.length - 1;
        const before = kinds();
        await emitAll('message_received', id);
        const held = minus(kinds(), before);
        await emitAll('character_message_rendered', id);
        await sleep(400);
        return { id, held, all: minus(kinds(), before) };
    };
    const result = await (${scenario.toString()})({ reply, settings, mockState, sleep, kinds, emitAll });
    console.log('RESULT ' + JSON.stringify(result));
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    let output;
    try {
        output = execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
    const line = String(output).split('\n').find(text => text.startsWith('RESULT '));
    assert.ok(line, `scenario ${name} printed its result`);
    return JSON.parse(line.slice(7));
}

// The scenarios run in the child process; ZERO (no relationship change) is defined there.
/* global ZERO */
// Two ordinary one-pass replies: Yunyun arrives (a new dossier, a complete no-change decision), then
// speaks again with a row that leaves her relationship open (the evaluator's case).
const twoReplies = async ({ reply }) => {
    const first = await reply('Yunyun, a young woman with crimson eyes, waves from the gate.',
        { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
    const second = await reply('Yunyun tells Kazuma she trusts him more and is fond of him.',
        { npcs: [{ name: 'Yunyun', present: true, mood: 'warm' }] });
    return { first: first.all, firstHeld: first.held, second: second.all };
};

test('hosted one-pass: an ordinary reply makes no extra model call (no relationship pass, no backfill)', () => {
    const hosted = runCalls('hosted-two-replies', true, twoReplies);
    assert.deepEqual(hosted.first, { scanner: 0, relationship: 0, backfill: 1, refresh: 0 }, 'a new NPC in the block: its one backfill (own cadence, batch D), no evaluator');
    assert.deepEqual(hosted.second, { scanner: 0, relationship: 0, backfill: 0, refresh: 0 }, 'an open relationship in the block: no evaluator (the story\'s ~ npc lines move the meters)');
});

test('without a host the same replies make the calls they always made; the reply never waits for a backfill', () => {
    const plain = runCalls('unhosted-two-replies', false, twoReplies);
    assert.deepEqual(plain.first, { scanner: 0, relationship: 0, backfill: 1, refresh: 0 }, 'the new dossier still gets its one backfill');
    assert.equal(plain.firstHeld.backfill, 0, 'the backfill runs after the reply\'s MESSAGE_RECEIVED has returned');
    assert.deepEqual(plain.second, { scanner: 0, relationship: 1, backfill: 0, refresh: 0 }, 'the open relationship still gets its evaluator');
});

test('b6-soak-2: a crowd block admits at most 4 new people and runs at most 2 backfills per reply, none awaited', () => {
    const crowd = async ({ reply, mockState, sleep }) => {
        const npcs = Array.from({ length: 12 }, (_, i) => ({ name: `Dockhand ${String.fromCharCode(65 + i)}`, present: true, role: 'dockhand', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }));
        const first = await reply('Twelve dockhands, Dockhand A to Dockhand L, unload the barge.', { npcs });
        const admitted = globalThis.NPCStateDelta.getState().npcs.filter(npc => npc.name.startsWith('Dockhand')).length;
        const queuedAfterFirst = globalThis.NPCStateDelta.getState().pendingBackfills.length;
        const second = await reply('The quay is quiet.', { npcs: [] });
        await sleep(100);
        return { admitted, first: first.all, firstHeld: first.held, queuedAfterFirst, second: second.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length, calls: mockState.rawCalls.length };
    };
    const plain = runCalls('unhosted-crowd', false, crowd);
    assert.equal(plain.admitted, 4, 'one block admits at most 4 new people');
    assert.equal(plain.firstHeld.backfill, 0, 'MESSAGE_RECEIVED awaited no backfill');
    assert.equal(plain.first.backfill, 2, 'at most 2 backfills follow the reply');
    assert.equal(plain.queuedAfterFirst, 2, 'the other admitted dossiers wait in the queue');
    assert.equal(plain.second.backfill, 2, 'the next reply takes the next 2');
    assert.equal(plain.queued, 0);
    const hosted = runCalls('hosted-crowd', true, crowd);
    assert.equal(hosted.admitted, 4);
    assert.deepEqual([hosted.first.backfill, hosted.second.backfill], [1, 1], 'hosted one-pass: one backfill per reply (batch D)');
    assert.equal(hosted.queued, 2, 'the rest wait their turn');
});

test('hosted one-pass: the backfill runs on the reply, the catch-up Refresh on its own schedule', () => {
    const result = runCalls('hosted-catch-up', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 2;
        const first = await reply('Yunyun waves from the gate.',
            { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const second = await reply('Yunyun smiles at Kazuma.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, second: second.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.equal(result.first.backfill, 1, 'the new person is backfilled on the reply');
    assert.equal(result.second.refresh, 1, 'the catch-up Refresh of the second captured reply');
    assert.equal(result.second.backfill, 0, 'nothing left to backfill');
    assert.equal(result.queued, 0);
});

test('ONEPASSMISS-1: missing hosted capture scans the same reply once, admits new people and reports it quietly', () => {
    const result = runCalls('missing-capture', true, async ({ reply, settings, mockState, emitAll, sleep, kinds }) => {
        settings.scanEvery = 10;
        mockState.sdk.feature = id => id !== 'npc-state-delta.scan-every-reply';
        const people = ['Sieke', 'Sister Temiwa'].map(name => ({ name, present: true, role: 'clerk', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named person', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }));
        mockState.quietResponder = async (args = {}) => /isolated dossier scanner\./i.test(String(args.systemPrompt || '')) ? JSON.stringify({ npcs: people }) : '{"npcs":[]}';
        const first = await reply('Sieke waves. Sister Temiwa greets her at the gate.', null);
        const scanCount = globalThis.NPCStateDelta.getState().scanCount;
        await emitAll('message_received', first.id);
        await sleep(100);
        return {
            calls: first.all, afterDuplicate: kinds(), scanCount, scanCountAfterDuplicate: globalThis.NPCStateDelta.getState().scanCount,
            people: globalThis.NPCStateDelta.getState().npcs.map(npc => npc.name),
            lines: globalThis.NPCStateDelta.scannerReport().filter(line => line.includes('the reply had no NPC capture')),
            prompt: mockState.rawCalls.find(call => /isolated dossier scanner\./i.test(String(call?.[0]?.systemPrompt || '')))?.[0]?.prompt,
        };
    });
    assert.equal(result.calls.scanner, 1);
    assert.equal(result.calls.relationship, 0, 'hosted one-pass keeps its focused-pass budget');
    assert.ok(result.calls.backfill <= 1, 'the existing hosted per-reply backfill limit remains');
    assert.equal(result.afterDuplicate.scanner, 1, 'a duplicate receipt does not scan again');
    assert.equal(result.scanCountAfterDuplicate, result.scanCount, 'a duplicate receipt is not applied twice');
    assert.ok(result.people.includes('Sieke') && result.people.includes('Sister Temiwa'));
    assert.match(result.prompt, /Sieke waves/);
    assert.deepEqual(result.lines, ['Problems: the reply had no NPC capture; scanned it instead.']);
});

test('ONEPASSMISS-1: valid and salvageable hosted captures replace the scan; empty and broken captures fall back', () => {
    const result = runCalls('capture-salvage-and-fallback', true, async ({ reply, settings, mockState }) => {
        settings.scanEvery = 10;
        mockState.sdk.feature = id => id !== 'npc-state-delta.scan-every-reply';
        const valid = await reply('The night is quiet.', { npcs: [] });
        const openEnvelope = await reply('The road is empty.', '{"npcs":[]}', { unterminated: true });
        const slipped = await reply('Sieke is weary.', '{"npcs":[{"name":"Sieke","present":true,"moodV:0,"moodA":1}]}', { unterminated: true });
        const empty = await reply('They walk down the road.', '');
        const emptyObject = await reply('They stop at a bridge.', '{}');
        const broken = await reply('They rest by the fire.', '{"npcs":[{"name":"Sis', { unterminated: true });
        return { valid: valid.all, openEnvelope: openEnvelope.all, slipped: slipped.all, empty: empty.all, emptyObject: emptyObject.all, broken: broken.all, stats: globalThis.NPCStateDelta.uiStatus().narrationCapture };
    });
    assert.equal(result.valid.scanner, 0, 'an empty NPC array is still a complete capture');
    assert.equal(result.openEnvelope.scanner, 0, 'a complete JSON object in an unclosed envelope is read');
    assert.equal(result.slipped.scanner, 0, 'existing key salvage runs before fallback');
    assert.equal(result.empty.scanner, 1, 'an empty block is not a capture');
    assert.equal(result.emptyObject.scanner, 1, 'an empty object is not a capture');
    assert.equal(result.broken.scanner, 1, 'irrecoverably cut-off JSON is scanned');
    assert.equal(result.stats.used, 3);
    assert.equal(result.stats.invalid, 2);
    assert.equal(result.stats.unterminated, 1);
});

test('ONEPASSMISS-1: a fallback result is discarded if its chat changes during the request', () => {
    const result = runCalls('fallback-chat-change', true, async ({ reply, settings, mockState, sleep }) => {
        settings.scanEvery = 10;
        mockState.sdk.feature = id => id !== 'npc-state-delta.scan-every-reply';
        let release;
        mockState.quietResponder = async args => {
            if (!/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
            return new Promise(resolve => { release = resolve; });
        };
        const pending = reply('Sieke waves at the gate.', null);
        for (let i = 0; i < 100 && !release; i += 1) await sleep(10);
        if (!release) throw new Error('the fallback did not start');
        mockState.context.chatId = 'another-chat';
        mockState.context.getCurrentChatId = () => 'another-chat';
        release(JSON.stringify({ npcs: [{ name: 'Sieke', present: true, identityKind: 'proper_name', dossierSignal: 'high', directInteraction: true }] }));
        await pending;
        mockState.context.chatId = 'smoke-chat';
        mockState.context.getCurrentChatId = () => 'smoke-chat';
        await sleep(100);
        return { names: globalThis.NPCStateDelta.getState().npcs.map(npc => npc.name), lines: globalThis.NPCStateDelta.scannerReport().filter(line => line.includes('the reply had no NPC capture')) };
    });
    assert.ok(!result.names.includes('Sieke'), 'no stale dossier is committed');
    assert.deepEqual(result.lines, [], 'a discarded result is not reported as scanned');
});

test('ONEPASSMISS-2: one-pass with Auto scan off still captures; a missing block falls back exactly once', () => {
    const result = runCalls('autoscan-off', true, async ({ reply, settings, mockState, emitAll, sleep, kinds }) => {
        settings.autoScan = false;
        settings.scanEvery = 10;
        mockState.sdk.feature = id => id !== 'npc-state-delta.scan-every-reply';
        const enabled = globalThis.NPCStateDelta.uiStatus().narrationCapture.enabled;
        const captured = await reply('Sieke waves at the gate.', { npcs: [{ name: 'Sieke', present: true, role: 'clerk', identityKind: 'proper_name', dossierSignal: 'high', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const names = globalThis.NPCStateDelta.getState().npcs.map(npc => npc.name);
        mockState.quietResponder = async (args = {}) => /isolated dossier scanner\./i.test(String(args.systemPrompt || '')) ? JSON.stringify({ npcs: [{ name: 'Temiwa', present: true, role: 'nun', identityKind: 'proper_name', dossierSignal: 'high', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
        const missing = await reply('Sister Temiwa greets her.', null);
        await sleep(150);
        const scanCount = globalThis.NPCStateDelta.getState().scanCount;
        await emitAll('message_received', missing.id);
        await sleep(100);
        const noticeAfterMissing = globalThis.NPCStateDelta.scannerReport().filter(line => line.includes('the reply had no NPC capture')).length;
        const scanCountAfterDuplicate = globalThis.NPCStateDelta.getState().scanCount;
        await reply('The gate closes.', { npcs: [] });
        return { enabled, captured: captured.all, names, missing: missing.all, afterDuplicate: kinds(), scanCount, scanCountAfterDuplicate, noticeAfterMissing, noticeAfterCapture: globalThis.NPCStateDelta.scannerReport().filter(line => line.includes('the reply had no NPC capture')).length };
    });
    assert.equal(result.enabled, true);
    assert.equal(result.captured.scanner, 0, 'the block alone updated the dossiers');
    assert.ok(result.names.includes('Sieke'), 'a capture with Auto scan off is applied');
    assert.equal(result.missing.scanner, 1, 'a missing block scans once');
    assert.equal(result.afterDuplicate.scanner, 1, 'a duplicate receipt never scans or applies twice');
    assert.equal(result.scanCountAfterDuplicate, result.scanCount);
    assert.equal(result.noticeAfterMissing, 1);
    assert.equal(result.noticeAfterCapture, 0, 'the notice follows the latest reply only');
});

test('ONEPASSMISS-2: the settings text no longer ties one-pass to Auto scan', () => {
    const html = fs.readFileSync(new URL('../runtime-settings-html.js', import.meta.url), 'utf8');
    assert.match(html, /Works on its own, with Auto scan on or off/);
    assert.doesNotMatch(html, /'With Auto scan, the roleplay model/);
});
