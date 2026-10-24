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
    const reply = async (text, payload) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
        await emitAll('message_sent', mockState.context.chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        const mes = \`\${text}\\n\\n<!--npc_state_delta\\n\${JSON.stringify(payload)}\\n-->\`;
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
        const id = mockState.context.chat.length - 1;
        const before = kinds();
        await emitAll('message_received', id);
        const held = minus(kinds(), before);
        await emitAll('character_message_rendered', id);
        await sleep(400);
        return { id, held, all: minus(kinds(), before) };
    };
    const result = await (${scenario.toString()})({ reply, settings, mockState, sleep, kinds });
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
    assert.deepEqual(hosted.first, { scanner: 0, relationship: 0, backfill: 0, refresh: 0 }, 'a new NPC in the block: no backfill, no evaluator');
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
    assert.deepEqual([hosted.first.backfill, hosted.second.backfill], [0, 0], 'hosted one-pass: no backfill per reply');
    assert.equal(hosted.queued, 4, 'they wait for the catch-up or the reader');
});

test('hosted one-pass: the backfill queue runs with the one-pass catch-up', () => {
    const result = runCalls('hosted-catch-up', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 2;
        const first = await reply('Yunyun waves from the gate.',
            { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const second = await reply('Yunyun smiles at Kazuma.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, second: second.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.equal(result.first.backfill, 0, 'not on the reply');
    assert.equal(result.second.refresh, 1, 'the catch-up Refresh of the second captured reply');
    assert.equal(result.second.backfill, 1, 'and the queued backfill with it');
    assert.equal(result.queued, 0);
});
