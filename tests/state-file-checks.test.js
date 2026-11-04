import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    NPC_STATE_CHECK_REUSE_MS, beginNpcStateCheckTurn, deleteNpcStateDataFile, encodeStateFilePayload, inspectNpcStateDataFile, writeNpcStateDataFile,
} from '../storage.js';

// (perf checks) Fewer state-file requests per reply: concurrent checks of one path share a request, a check right after
// another (or after our own verified write) in the same turn may reuse its answer, and the write guards always ask the server.

const HEADERS = { 'Content-Type': 'application/json' };

// A SillyTavern-like file route (weak ETags that change with every write). `hold()` makes the next GET wait for `release()`;
// a held GET answers with the file as it was when the request arrived.
function fileServer() {
    const files = new Map();
    let stamp = 0;
    const log = { gets: 0, uploads: 0 };
    let held = null;
    const put = (path, text) => files.set(path, { text, etag: `W/"${(stamp += 1).toString(16)}"` });
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            log.uploads += 1;
            const body = JSON.parse(options.body);
            put(`/user/files/${body.name}`, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }) };
        }
        if (url === '/api/files/delete') {
            const body = JSON.parse(options.body);
            const existed = files.delete(body.path);
            return { ok: existed, status: existed ? 200 : 404, text: async () => '' };
        }
        if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}) };
        log.gets += 1;
        const file = files.get(url);
        if (held) { const gate = held; held = null; gate.entered(); await gate.promise; }
        if (file?.fail) return { ok: false, status: 500, headers: new Headers(), text: async () => '' };
        if (!file) return { ok: false, status: 404, headers: new Headers() };
        return { ok: true, status: 200, headers: new Headers({ etag: file.etag, 'last-modified': 'Wed, 04 Nov 2026 08:00:00 GMT' }), text: async () => file.text };
    };
    const hold = () => {
        let release;
        let entered;
        const promise = new Promise(resolve => { release = resolve; });
        const arrived = new Promise(resolve => { entered = resolve; });
        held = { promise, entered };
        return { release, arrived };
    };
    return { files, put, fetchFn, log, hold };
}

const sidecar = (chatKey, revision, writerId) => encodeStateFilePayload(chatKey, { npcs: [{ id: 'mira', name: 'Mira' }] }, '1.10.2', { revision, writerId, updatedAt: `2026-11-04T08:00:0${revision % 10}.000Z` });

test('perf checks, single-flight: concurrent checks of one path share one request and its answer; each gets its own payload', async () => {
    beginNpcStateCheckTurn();
    const server = fileServer();
    const chatKey = 'chat:checks.png:flight';
    const path = '/user/files/checks-flight.json';
    server.put(path, sidecar(chatKey, 4, 'tab-a'));
    const gate = server.hold();
    const first = inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    await gate.arrived;
    const second = inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    const third = inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    gate.release();
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.equal(server.log.gets, 1, 'one request for three concurrent checks');
    assert.deepEqual([a.revision, b.revision, c.revision], [4, 4, 4]);
    assert.deepEqual(b, a, 'the same answer');
    assert.notEqual(a.payload, b.payload, 'never one decoded object for two callers');
    a.payload.state.npcs.push({ id: 'intruder' });
    assert.equal(b.payload.state.npcs.length, 1);
    // The chat check is each caller's own.
    const gate2 = server.hold();
    const mine = inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    await gate2.arrived;
    const other = inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: 'chat:other.png:x' });
    gate2.release();
    assert.equal((await mine).revision, 4);
    await assert.rejects(other, /different chat/);
    assert.equal(server.log.gets, 2);
    // Done: the next check asks again (single-flight is only while a request is in flight).
    await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(server.log.gets, 3);
});

test('perf checks, single-flight: a check that starts after an upload of ours never joins a request from before it', async () => {
    beginNpcStateCheckTurn();
    const server = fileServer();
    const chatKey = 'chat:checks.png:flight-write';
    const pointer = await writeNpcStateDataFile({ chatKey, state: { npcs: [] }, appVersion: '1.10.2', fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false });
    const gets = server.log.gets;
    const gate = server.hold();
    const early = inspectNpcStateDataFile(pointer, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    await gate.arrived;
    // Our write lands while that check is still in flight (its guard and read-back are their own requests).
    const next = await writeNpcStateDataFile({ chatKey, state: { npcs: [{ id: 'n', name: 'N' }] }, appVersion: '1.10.2', pointer: { ...pointer }, fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false });
    assert.equal(server.log.gets, gets + 3, 'the early check, the guard and the read-back: three requests, none shared');
    const late = await inspectNpcStateDataFile(next, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(server.log.gets, gets + 4, 'the late check sends its own request');
    assert.equal(late.revision, next.revision, 'and sees our write');
    gate.release();
    await early;
});

test('perf checks, pre-write guard: always its own request, never a reused or shared answer, and it still catches another tab\'s write', async () => {
    beginNpcStateCheckTurn();
    const server = fileServer();
    const chatKey = 'chat:checks.png:guard';
    const pointer = await writeNpcStateDataFile({ chatKey, state: { npcs: [] }, appVersion: '1.10.2', fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false });
    assert.equal((await inspectNpcStateDataFile(pointer, { fetchFn: server.fetchFn, expectedChatKey: chatKey })).revision, pointer.revision);
    // Another tab saves revision N+1 inside the reuse window.
    server.put(pointer.path, sidecar(chatKey, pointer.revision + 1, 'other-tab'));
    const gets = server.log.gets;
    const reused = await inspectNpcStateDataFile(pointer, { fetchFn: server.fetchFn, expectedChatKey: chatKey, reuse: true });
    assert.equal(server.log.gets, gets, 'a boundary check that may reuse takes the answer of the check just before');
    assert.equal(reused.revision, pointer.revision);
    // The guard asks the server and refuses to overwrite the other tab's revision.
    await assert.rejects(
        writeNpcStateDataFile({ chatKey, state: { npcs: [{ id: 'x', name: 'X' }] }, appVersion: '1.10.2', pointer: { ...pointer }, fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT' && error.actualRevision === pointer.revision + 1,
    );
    assert.equal(server.log.gets, gets + 1, 'the guard sent its own request');
    assert.equal(server.log.uploads, 1, 'nothing was uploaded over the other tab\'s file');
    // A guard does not join a check already in flight either: it sends its own request beside it.
    server.put(pointer.path, sidecar(chatKey, pointer.revision + 2, 'other-tab'));
    const gate = server.hold();
    const inFlight = inspectNpcStateDataFile(pointer, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    await gate.arrived;
    await assert.rejects(
        writeNpcStateDataFile({ chatKey, state: { npcs: [] }, appVersion: '1.10.2', pointer: { ...pointer, revision: pointer.revision + 1 }, fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT' && error.actualRevision === pointer.revision + 2,
    );
    assert.equal(server.log.gets, gets + 3, 'the in-flight check and the guard\'s own request');
    gate.release();
    await inFlight;
});

test('perf checks, reuse window: only for a caller that asks, within one turn and the window, and never across a write of ours', async () => {
    beginNpcStateCheckTurn();
    const server = fileServer();
    const chatKey = 'chat:checks.png:window';
    const pointer = await writeNpcStateDataFile({ chatKey, state: { npcs: [] }, appVersion: '1.10.2', fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false });
    let gets = server.log.gets;
    const ask = (options = {}) => inspectNpcStateDataFile(pointer, { fetchFn: server.fetchFn, expectedChatKey: chatKey, ...options });
    // Our verified write is a check: the one right after it reuses its read-back.
    assert.equal((await ask({ reuse: true })).revision, pointer.revision);
    assert.equal(server.log.gets, gets, 'right after our verified write: no request');
    assert.equal((await ask()).revision, pointer.revision);
    assert.equal(server.log.gets, (gets += 1), 'a caller that does not ask for reuse always sends a request');
    await ask({ reuse: true });
    assert.equal(server.log.gets, gets, 'right after another check: no request');
    const reusedPayload = (await ask({ reuse: true })).payload;
    assert.deepEqual(reusedPayload.state.npcs, [], 'a reused answer still decodes the file on demand');
    // A new turn: asked again.
    beginNpcStateCheckTurn();
    await ask({ reuse: true });
    assert.equal(server.log.gets, (gets += 1), 'a new turn sends a request');
    // Our write: the answer from before it is not reused; the read-back of the write is.
    const next = await writeNpcStateDataFile({ chatKey, state: { npcs: [{ id: 'n', name: 'N' }] }, appVersion: '1.10.2', pointer: { ...pointer }, fetchFn: server.fetchFn, headers: HEADERS, continuousRetry: false });
    gets = server.log.gets;
    assert.equal((await ask({ reuse: true })).revision, next.revision, 'never the answer from before our write');
    assert.equal(server.log.gets, gets);
    await deleteNpcStateDataFile(pointer, { fetchFn: server.fetchFn, headers: HEADERS });
    assert.equal((await ask({ reuse: true })).exists, false, 'after our delete the server is asked again');
    assert.equal(server.log.gets, (gets += 1));
    // The window is short.
    server.put(pointer.path, sidecar(chatKey, 9, 'other-tab'));
    await ask();
    gets = server.log.gets;
    const now = Date.now;
    try {
        const later = now() + NPC_STATE_CHECK_REUSE_MS + 1;
        Date.now = () => later;
        await ask({ reuse: true });
        assert.equal(server.log.gets, (gets += 1), 'an answer older than the window is not reused');
    } finally {
        Date.now = now;
    }
    // A failed request leaves nothing to reuse, and another fetch never takes this one's answer.
    server.files.get(pointer.path).fail = true;
    await assert.rejects(ask(), /HTTP 500/);
    delete server.files.get(pointer.path).fail;
    await ask({ reuse: true });
    assert.equal(server.log.gets, (gets += 2));
    const other = async (url, options) => server.fetchFn(url, options);
    await inspectNpcStateDataFile(pointer, { fetchFn: other, expectedChatKey: chatKey, reuse: true });
    assert.equal(server.log.gets, (gets += 1));
});

// ---- one reply on the synthetic host ----

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runReplyScenario(name, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
mockState.context.updateMessageBlock = () => {};
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await (${replyHelpers.toString()})(mockState, eventSource, sleep, ${scenario.toString()});
    console.log('state file checks scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

// Runs inside the synthetic host: the state-file GETs and uploads of each reply, and a turn as SillyTavern runs it.
async function replyHelpers(mockState, eventSource, sleep, scenario) {
    const fail = message => { throw new Error(message); };
    const equal = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const runtime = globalThis.NPCStateDelta;
    const log = [];
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        if (typeof url === 'string' && url.startsWith('/user/files/npc-state-delta-') && (!options.method || options.method === 'GET')) log.push('get');
        if (url === '/api/files/upload') log.push('upload');
        return inner(url, options);
    };
    const emitAsync = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); await sleep(40); };
    let reply = 0;
    mockState.onScan = null;
    mockState.quietResponder = async (args = {}) => {
        if (/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) {
            await mockState.onScan?.();
            return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'scanned adventurer', mood: `mood ${reply}` }] });
        }
        return '{"npcs":[]}';
    };
    const turn = async (userText, replyText) => {
        reply += 1;
        const from = log.length;
        // SillyTavern's order: GENERATION_AFTER_COMMANDS, then the user message (MESSAGE_SENT), then the reply.
        await emitAsync('generation_after_commands', 'normal', {}, false);
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: userText });
        await emitAsync('message_sent', mockState.context.chat.length - 1);
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: replyText, swipe_id: 0, swipes: [replyText] });
        await emitAsync('message_received', mockState.context.chat.length - 1);
        await sleep(400);
        await runtime.flush?.();
        await sleep(100);
        const done = log.slice(from);
        return { gets: done.filter(item => item === 'get').length, uploads: done.filter(item => item === 'upload').length, sequence: done.join(' ') };
    };
    await scenario({ fail, equal, runtime, mockState, turn, sleep });
}

test('perf checks, one reply on the synthetic host: 9 state-file requests instead of 12; every write still has its guard and read-back', () => {
    runReplyScenario('reply-count', async h => {
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        await h.turn('We walk on.', 'Yunyun walks beside you.');
        const counted = await h.turn('Go on.', 'Yunyun nods.');
        // generation boundary, reply boundary, [flushed write: guard, upload, read-back], scan commit checks
        // (after the scanner, after the relationship evaluator, final commit), [the scan's write: guard, upload, read-back].
        h.equal(counted.sequence, 'get get get upload get get get get get upload get', 'the requests of one reply, in order');
        h.equal([counted.gets, counted.uploads], [9, 2], 'GETs and uploads per reply');
    });
});

test('perf checks, synthetic host: another tab\'s write during the scan is still caught by the scan\'s commit check', () => {
    runReplyScenario('remote-during-scan', async h => {
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        await h.turn('We walk on.', 'Yunyun walks beside you.');
        const pointer = h.runtime.dataFile();
        let remoteRevision = 0;
        h.mockState.onScan = async () => {
            h.mockState.onScan = null;
            const payload = JSON.parse(h.mockState.files.get(pointer.path));
            payload.state.npcs.find(npc => npc.name === 'Yunyun').mood = 'remote';
            payload.revision += 1;
            remoteRevision = payload.revision;
            payload.writerId = 'other-tab';
            payload.updatedAt = new Date(Date.now() + 5).toISOString();
            h.mockState.files.set(pointer.path, JSON.stringify(payload));
        };
        await h.turn('Go on.', 'Yunyun nods.');
        const yunyun = h.runtime.getState().npcs.find(npc => npc.name === 'Yunyun');
        h.equal(yunyun.mood, 'remote', 'the other tab\'s dossier is kept; the stale scan result was not committed over it');
        if (!remoteRevision) h.fail('the other tab wrote during the scan');
        h.equal(h.runtime.uiStatus().hydratedRevision, remoteRevision, 'the other tab\'s revision is adopted, nothing written over it');
        const events = h.runtime.uiStatus().freshnessEvents.map(event => event.type);
        if (!events.includes('stale-operation-rejected')) h.fail(`the scan result was rejected as stale: ${events.join(', ')}`);
    });
});
