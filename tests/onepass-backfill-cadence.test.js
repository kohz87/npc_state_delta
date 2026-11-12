import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        const asked = (/backfill scanner/i.test(String(args.systemPrompt || '')) ? String(args.prompt || '').match(/^(?:Requested|Target) NPC: (.+?)(?: [(].*)?$/m)?.[1] : undefined);
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
    // (ONEPASSCAPR2-3) Every new admission gets its one fill in its own reply, none waits for another reply.
    assert.equal(r.two.backfill, 2, 'two new people: each gets its backfill this reply');
    assert.equal(r.two.refresh, 2, 'both people in the reply are new admissions: each gets the Refresh');
    assert.equal(r.queuedAfterTwo, 0, 'nothing waits');
    assert.equal(r.three.backfill, 0, 'the next reply owes nothing');
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
    assert.deepEqual(r.sizes, [0, 0, 0, 0], '(ONEPASSCAPR2-3) every admission is filled in its own reply, none waits');
});

test('catch-up: every due NPC is held from the reply backfill; a newly met NPC keeps its queue entry and gets its backfill after the Refresh (established ones skipped)', async () => {
    // The real module in a temp tree whose two imports are small stubs (the real ones need the host).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsd-catchup-'));
    try {
        fs.copyFileSync(fileURLToPath(new URL('../runtime-catchup.js', import.meta.url)), path.join(dir, 'runtime-catchup.js'));
        fs.writeFileSync(path.join(dir, 'runtime-settings.js'), 'export const getSettings = () => ({ narrationCaptureCatchUp: 1 });\n');
        fs.writeFileSync(path.join(dir, 'runtime-scan-helpers.js'), 'export const latestMessageId = () => 5;\n');
        var { createCatchUpPart } = await import(pathToFileURL(path.join(dir, 'runtime-catchup.js')).href);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const key = 'chat-x';
    const state = {
        npcs: [{ id: 'new1', archived: false, overallAppearance: 'Young human woman' }, { id: 'old1', archived: false }],
        pendingBackfills: [
            { npcId: 'new1', reason: 'new-admission', attempts: 0 },
            { npcId: 'old1', reason: 'missed-participant', attempts: 0 },
        ],
    };
    const calls = { refresh: [], backfill: [], opts: {} };
    const rt = { captureCatchUp: new Map(), settings: {} };
    const part = createCatchUpPart(rt, {
        getChatKey: () => key, getChatState: () => state, isHostSwipeActive: () => false, isScanBusy: () => false, persist() {},
        refreshNpcFromChat: async (id, opts) => { calls.refresh.push(id); calls.opts[id] = opts; return true; },
        processPendingBackfills: async (mid, opts) => { calls.backfill.push(opts); return 0; },
    });
    const due = part.noteCaptureCatchUp(key, ['new1', 'old1']);
    assert.deepEqual([...due].sort(), ['new1', 'old1']);
    assert.deepEqual([...rt.catchUpTaken.get(key)].sort(), ['new1', 'old1'], 'the reply backfill start skips both');
    await part.runCaptureCatchUp(key, due);
    assert.deepEqual(calls.refresh.sort(), ['new1', 'old1'], 'one Refresh each');
    assert.equal(calls.opts.new1.fillLooks, false, '(ONEPASSCAPR2-3) the admission backfill owns the one fill, so the newly met person\'s Refresh does not fill');
    assert.equal(calls.opts.old1.fillLooks, false, 'an established person\'s Refresh never does');
    assert.deepEqual(state.pendingBackfills.map(i => i.npcId), ['new1'], 'the established entry is covered by its Refresh; the new one is kept');
    assert.equal(calls.backfill.length, 1, 'one backfill start after the Refreshes');
    assert.equal(calls.backfill[0].limit, 0, 'no repair call beyond the admissions');
    assert.equal(calls.backfill[0].admissions, true);
    assert.deepEqual(calls.backfill[0].skipNpcIds, ['old1'], 'established NPCs are not backfilled again');
    assert.equal(rt.catchUpTaken.has(key), false, 'the hold is released');
});

test('send-drop: a reply without a capture block starts its automatic scan but the MESSAGE_RECEIVED listener returns at once (the reply and Send are not held); the scan still lands', () => {
    const r = runCalls('detached-scan', false, async ({ settings, mockState, sleep, kinds }) => {
        const emitAll = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); };
        settings.autoScan = true; settings.fullScanEveryTurn = true; settings.narrationCapture = false;
        const orig = mockState.quietResponder;
        mockState.quietResponder = async args => { await sleep(700); return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] }); };
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
        await emitAll('message_sent', mockState.context.chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        const mes = 'Yunyun waves at you from the gate.';
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
        const id = mockState.context.chat.length - 1;
        const t0 = Date.now();
        await emitAll('message_received', id);
        const heldMs = Date.now() - t0;
        const busyAfter = Boolean(globalThis.NPCStateDelta.scanActive?.());
        await sleep(2500);
        mockState.quietResponder = orig;
        return { heldMs, busyAfter, scans: kinds().scanner, names: globalThis.NPCStateDelta.getState().npcs.map(n => n.name) };
    });
    assert.ok(r.heldMs < 400, `the listener returned in ${r.heldMs} ms`);
    assert.equal(r.busyAfter, true, 'the scan was still pending when the listener returned');
    assert.ok(r.scans >= 1, 'the scan ran');
    assert.ok(r.names.includes('Yunyun'), 'its result was kept: ' + JSON.stringify(r.names));
});

// A Send during the automatic scan costs no extra scanner call: the in-flight scan is dropped and the next reply's own scan reads the
// window, so the count EQUALS the count when the reply and Send were held (the first scan and the next reply's scan = 2), in every
// timing: the next reply's message appearing before the scan request ends, after it ends, a non-streaming reply, and a Send late in the
// scan (during the full-window new-NPC relationship pass). The scenario reads its timings from the SR_OPTS environment variable.
const sendScenario = async ({ settings, mockState, sleep, kinds }) => {
    const o = JSON.parse(process.env.SR_OPTS);
    const emitAll = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); };
    settings.autoScan = true; settings.fullScanEveryTurn = o.full; settings.narrationCapture = false;
    mockState.quietResponder = async () => { await sleep(500); return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] }); };
    const chat = mockState.context.chat;
    chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
    await emitAll('message_sent', chat.length - 1);
    await emitAll('generation_after_commands', 'normal', {}, false);
    const mes = 'Yunyun waves at you from the gate.';
    chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
    await emitAll('message_received', chat.length - 1);
    await sleep(o.sendAt);
    if (o.edit) {
        chat[chat.length - 2].mes = 'And then, tell me more?';
        await sleep(o.settle);
    } else {
        chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is she?' });
        await emitAll('message_sent', chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        if (o.noReply) {
            await sleep(o.settle);
            o.callsBeforeReply = kinds().scanner; o.namesBeforeReply = globalThis.NPCStateDelta.getState().npcs.map(n => n.name);
        }
        await sleep(o.replyAfter);
        const next = { is_user: false, is_system: false, name: 'Megumin', mes: '', swipe_id: 0, swipes: [''] };
        chat.push(next);
        if (o.stream) {
            const words = 'She is a crimson demon and a friend of Megumin who likes to compete'.split(' ');
            for (let i = 0; i < 26; i += 1) { next.mes += words[i % words.length] + ' '; next.swipes[0] = next.mes; await sleep(150); }
        } else {
            next.mes = 'She is a crimson demon and a friend of Megumin.'; next.swipes[0] = next.mes;
        }
        await emitAll('message_received', chat.length - 1);
    }
    await sleep(o.settle);
    return { total: kinds().scanner, before: o.callsBeforeReply ?? null, namesBefore: o.namesBeforeReply ?? null, names: globalThis.NPCStateDelta.getState().npcs.map(n => n.name) };
};
const runSend = (name, opts) => {
    process.env.SR_OPTS = JSON.stringify({ sendAt: 150, replyAfter: 300, stream: true, settle: 3000, ...opts });
    try { return runCalls(name, false, sendScenario); } finally { delete process.env.SR_OPTS; }
};
const SEND_TIMINGS = [
    ['the next reply message appears before the scan request ends (streamed)', { sendAt: 150, replyAfter: 300, stream: true }],
    ['the next reply message appears after the scan request ends (slow prompt build or first chunk)', { sendAt: 150, replyAfter: 900, stream: true }],
    ['a non-streaming reply that arrives 3 s after the Send', { sendAt: 150, replyAfter: 3000, stream: false, settle: 4000 }],
    ['the Send lands late in the scan (the full-window new-NPC relationship pass)', { sendAt: 900, replyAfter: 300, stream: true }],
];
for (const full of [true, false]) {
    for (const [label, timing] of SEND_TIMINGS) {
        test(`send-drop: a Send during the scan makes exactly the same scanner calls as when it was held (${full ? 'full window' : 'lean'}; ${label})`, () => {
            const r = runSend('send-count', { ...timing, full });
            assert.equal(r.total, 2, `scanner calls: ${r.total}`);
            assert.ok(r.names.includes('Yunyun'), 'the NPC was kept: ' + JSON.stringify(r.names));
        });
    }
}

test('send-drop: a Send with no reply makes no re-run (1 scanner call); the next reply\'s scan then lands the NPC (2 in total)', () => {
    const r = runSend('send-noreply', { noReply: true, replyAfter: 100, stream: false, settle: 3000 });
    assert.equal(r.before, 1, `scanner calls before the next reply: ${r.before}`);
    assert.equal(r.total, 2, `scanner calls in total: ${r.total}`);
    assert.ok(r.names.includes('Yunyun'), 'the NPC landed with the next reply: ' + JSON.stringify(r.names));
});

test('send-drop: an earlier message edited during the scan (nothing appended) runs the scan again once and lands on that reply', () => {
    const r = runSend('send-edit', { edit: true, sendAt: 150, settle: 4000 });
    assert.equal(r.total, 2, `scanner calls: ${r.total}`);
    assert.ok(r.names.includes('Yunyun'), 'its result landed: ' + JSON.stringify(r.names));
});

test('FOLLOWREFRESH: a new person\'s follow-up is read like a Refresh (memories, tie, look), keeps the reply\'s one-pass live fields and never moves meters', () => {
    const r = runCalls('followrefresh', true, async ({ reply, mockState }) => {
        const prompts = [];
        mockState.quietResponder = async (args = {}) => {
            if (!/backfill scanner/i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
            prompts.push(String(args.prompt || ''));
            return JSON.stringify({ npcs: [{ name: 'Yunyun', present: false, mood: 'furious', goal: 'leave town', status: 'asleep', location: 'the cellar', role: 'adventurer',
                memories: ['Yunyun once saved a lost lamb on the moor.'], keyRelationships: ['Mira — innkeeper | trades gossip with her'],
                overallAppearance: 'A slim young woman, long dark hair, crimson eyes.', relationshipImpact: 'major', relationshipDelta: { trust: 5, affection: 5, desire: 0, tension: 0 }, relationshipChangeReason: 'x' }] });
        };
        await reply('Yunyun waves at the gate.', { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', goal: 'guard the gate', status: 'standing watch', location: 'the gate', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const npc = globalThis.NPCStateDelta.getState().npcs.find(item => item.name === 'Yunyun');
        return { count: prompts.length, refreshForm: /TARGETED REFRESH FROM CHAT/.test(prompts[0] || ''), oldForm: /targeted dossier backfill extractor/.test(prompts[0] || ''), fill: /FILL LOOKS/.test(prompts[0] || ''), window: /^\[m\d+\]/m.test(prompts[0] || ''),
            memories: npc.memories, ties: npc.keyRelationships, look: npc.overallAppearance, live: { present: npc.present, mood: npc.mood, goal: npc.goal, status: npc.status, location: npc.location }, relationship: npc.relationship };
    });
    assert.equal(r.count, 1, 'still one call for the new person');
    assert.equal(r.refreshForm, true);
    assert.equal(r.oldForm, false);
    assert.equal(r.fill, true, 'the look fill rides on the same call');
    assert.equal(r.window, true, 'the Refresh story window (with message ids)');
    assert.ok(r.memories.some(text => /lost lamb/.test(text)), 'memories come back like a Refresh');
    assert.ok(r.ties.some(text => /^Mira/.test(text)), 'ties come back like a Refresh');
    assert.match(r.look || '', /crimson eyes/, 'the fill is kept');
    assert.deepEqual(r.live, { present: true, mood: 'calm', goal: 'guard the gate', status: 'standing watch', location: 'the gate' }, 'the same reply\'s one-pass live fields are kept');
    assert.deepEqual({ ...r.relationship }, { trust: 0, affection: 0, desire: 0, tension: 0 }, 'meters never move');
});
