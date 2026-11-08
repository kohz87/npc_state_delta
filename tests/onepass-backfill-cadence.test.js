import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// (batch D) The backfill queue and the capture catch-up Refresh run on separate cadences. Hosted one-pass, the queue runs after every
// reply (limit 1), whatever `narrationCaptureCatchUp` says, and never makes a second long call on a person the same reply's Refresh
// took. Same harness as onepass-hosted-calls.test.js: Delta's real handlers on the synthetic host.

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

/* global ZERO */
test('hosted, catch-up 8, one new admission: the backfill runs that reply, no Refresh', () => {
    const r = runCalls('cadence-8', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 8;
        const first = await reply('Yunyun waves.', { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, held: first.held, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.deepEqual(r.first, { scanner: 0, relationship: 0, backfill: 1, refresh: 0 });
    assert.equal(r.held.backfill, 0, 'not awaited by the reply');
    assert.equal(r.queued, 0);
});

test('hosted, catch-up 0: backfills still run, no Refresh', () => {
    const r = runCalls('cadence-0', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 0;
        const first = await reply('Yunyun waves.', { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const second = await reply('Yunyun nods.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, second: second.all };
    });
    assert.equal(r.first.backfill, 1);
    assert.equal(r.first.refresh + r.second.refresh, 0);
});

test('hosted, catch-up 1, new admissions: each new NPC gets the Refresh and a backfill; limit 1 backfill per reply; backlog drains, none lost', () => {
    const r = runCalls('cadence-1', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 1;
        const mk = n => ({ name: n, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO });
        const one = await reply('Yunyun waves.', { npcs: [mk('Yunyun')] });
        const two = await reply('Wiz and Chris arrive.', { npcs: [mk('Wiz'), mk('Chris')] });
        const queuedAfterTwo = globalThis.NPCStateDelta.getState().pendingBackfills.length;
        const three = await reply('The hall is quiet.', { npcs: [] });
        return { one: one.all, two: two.all, three: three.all, queuedAfterTwo, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    // Changed (new-NPC rule): a newly met NPC gets the catch-up's targeted Refresh (it writes the structured appearance) AND its backfill.
    assert.deepEqual(r.one, { scanner: 0, relationship: 0, backfill: 1, refresh: 1 }, 'the new person: the Refresh and the backfill');
    assert.equal(r.two.backfill, 1, 'two new people: one backfill this reply');
    assert.equal(r.two.refresh, 2, 'both people in the reply are new admissions: each gets the Refresh');
    assert.equal(r.queuedAfterTwo, 1, 'the other waits, not lost');
    assert.equal(r.three.backfill, 1, 'the next reply takes it');
    assert.equal(r.queued, 0);
});

test('hosted: an NPC the catch-up Refreshes is not also backfilled in that reply; its queue entry is dropped', () => {
    const r = runCalls('cadence-taken', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 1;
        const mk = n => ({ name: n, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO });
        await reply('Yunyun waves.', { npcs: [mk('Yunyun')] });
        const st = globalThis.NPCStateDelta.getState();
        const yun = st.npcs.find(n => n.name === 'Yunyun');
        // A repair queued for her by an earlier reply (not a new admission).
        st.pendingBackfills.push({ queueVersion: st.pendingBackfills.queueVersion ?? 1, reason: 'missed-participant', npcId: yun.id, label: 'Yunyun', requestedMessageId: 1, preserveLiveState: true, silent: true, requestedAt: Date.now(), attempts: 0, lastAttemptAt: 0 });
        const next = await reply('Yunyun nods.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { next: next.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.equal(r.queued, 0, 'the entry is gone');
    assert.equal(r.next.refresh + r.next.backfill, 1, `one call for her, got ${JSON.stringify(r.next)}`);
});

test('hosted: a newly met NPC gets a targeted Refresh on its first reply and its backfill; the queue entry is kept for the backfill', () => {
    const r = runCalls('cadence-new', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 1;
        const first = await reply('Yunyun waves.', { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.equal(r.first.refresh, 1, 'the targeted Refresh ran on the first reply ' + JSON.stringify(r));
    assert.equal(r.first.backfill, 1, 'and so did the backfill ' + JSON.stringify(r));
    assert.equal(r.queued, 0);
});

test('hosted: an established NPC still gets one call per reply (Refresh or backfill, never both)', () => {
    const r = runCalls('cadence-established', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 1;
        const mk = n => ({ name: n, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO });
        await reply('Yunyun waves.', { npcs: [mk('Yunyun')] });
        const st = globalThis.NPCStateDelta.getState();
        const yun = st.npcs.find(n => n.name === 'Yunyun');
        st.pendingBackfills.push({ queueVersion: st.pendingBackfills.queueVersion ?? 1, reason: 'missed-participant', npcId: yun.id, label: 'Yunyun', requestedMessageId: 1, preserveLiveState: true, silent: true, requestedAt: Date.now(), attempts: 0, lastAttemptAt: 0 });
        const next = await reply('Yunyun nods.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { next: next.all };
    });
    assert.equal(r.next.refresh + r.next.backfill, 1, `one call, got ${JSON.stringify(r.next)}`);
});

test('non-hosted: the calls are unchanged (limit 2 per reply, no Refresh)', () => {
    const r = runCalls('cadence-plain', false, async ({ reply }) => {
        const npcs = Array.from({ length: 4 }, (_, i) => ({ name: `Dockhand ${String.fromCharCode(65 + i)}`, present: true, role: 'dockhand', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }));
        const first = await reply('Dockhand A to Dockhand D unload.', { npcs });
        return { first: first.all };
    });
    assert.equal(r.first.backfill, 2);
    assert.equal(r.first.refresh, 0);
});

test('an old saved state with pendingBackfills drains one per reply, the 100 cap kept', () => {
    const r = runCalls('cadence-old', true, async ({ reply }) => {
        const mk = n => ({ name: n, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO });
        await reply('Ann, Bea and Cy arrive.', { npcs: [mk('Ann'), mk('Bea'), mk('Cy')] });
        const sizes = [globalThis.NPCStateDelta.getState().pendingBackfills.length];
        for (let i = 0; i < 3; i += 1) { await reply('Quiet.', { npcs: [] }); sizes.push(globalThis.NPCStateDelta.getState().pendingBackfills.length); }
        return { sizes };
    });
    assert.deepEqual(r.sizes, [2, 1, 0, 0]);
});
