import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64, encodeStateFilePayload, inspectNpcStateDataFile, writeNpcStateDataFile } from '../storage.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { runHostScenario } from './helpers/host-scenario.js';

// 1.10.1: the freezes of a long chat with many dossiers and portraits. Each fix keeps what is saved, read
// and shown exactly as before; these tests hold the results equal and count the work that was removed.

test('1.10.1 sidecar upload encoding: one call per chunk, byte-identical base64 (empty, chunk edges, every byte value, 1 MB)', () => {
    const sizes = [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 0x10000 + 7, 1024 * 1024 + 5];
    for (const size of sizes) {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) bytes[i] = (i * 131 + (i >> 8)) & 0xff;
        assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `${size} bytes`);
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.equal(bytesToBase64(all), Buffer.from(all).toString('base64'));
    // What uploadPayload sends: the UTF-8 bytes of the sidecar's JSON (non-ASCII names, emoji).
    const json = JSON.stringify({ name: 'Ersveil — Æðelflǣd 🐉', text: 'x'.repeat(70000) });
    assert.equal(bytesToBase64(new TextEncoder().encode(json)), Buffer.from(json, 'utf8').toString('base64'));
    // An ArrayBuffer is accepted as before.
    assert.equal(bytesToBase64(new TextEncoder().encode('abc').buffer), 'YWJj');
});

const GREGORIAN_CLOCK = {
    era: '',
    months: [['January', 31], ['February', 28], ['March', 31], ['April', 30], ['May', 31], ['June', 30], ['July', 31],
        ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31]].map(([name, days]) => ({ name, days })),
    leapYears: true,
};
// Minutes from year 0, January 1 (as Story Director counts) to 611-06-15.
const MINUTES_611_06_15 = (() => {
    const at = new Date(Date.UTC(2000, 0, 1)); at.setUTCFullYear(611, 5, 15);
    const epoch = new Date(Date.UTC(2000, 0, 1)); epoch.setUTCFullYear(0, 0, 1);
    return Math.round((at.getTime() - epoch.getTime()) / 60000);
})();
const birthdayCast = () => Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`, name: `Person ${i}`, createdAt: 1000 + i, updatedAt: 2000 + i,
    // established full dates, month-day dates whose year is derived from the age, and none (generated)
    ...(i % 3 === 0 ? { birthDate: { era: '', year: 580 + i, month: '03', day: 1 + i }, birthDateSource: 'established' } : {}),
    ...(i % 3 === 1 ? { birthDate: { era: '', year: null, month: '07', day: 2 + (i % 20) }, birthDateSource: 'established', age: String(20 + i) } : {}),
}));

test('1.10.1 story date: one clock read per normalize pass, the same dossiers as reading it per dossier', async () => {
    const { normalizeNpcRecord, setStoryClockSource, withStoryDateMemo, applyNpcStateCommand } = await import('../core.js');
    let reads = 0;
    setStoryClockSource(() => { reads += 1; return { minutes: MINUTES_611_06_15, calendar: GREGORIAN_CLOCK }; });
    try {
        const cast = birthdayCast();
        reads = 0;
        const perDossier = cast.map(normalizeNpcRecord);
        const unmemoReads = reads;
        assert.ok(unmemoReads >= cast.length, `without the memo every dossier reads the clock (${unmemoReads})`);
        reads = 0;
        const once = withStoryDateMemo(() => cast.map(normalizeNpcRecord));
        assert.equal(reads, 1, 'one read for the whole pass');
        assert.deepEqual(once, perDossier, 'same ages, derived years and display dates');
        assert.ok(once.some(npc => Number.isInteger(npc.calendarAge)), 'the clock was used (ages from the story date)');
        // Nested passes share the outer read; after the pass the clock is read live again (it may have moved).
        reads = 0;
        withStoryDateMemo(() => withStoryDateMemo(() => cast.map(normalizeNpcRecord)));
        assert.equal(reads, 1);
        reads = 0;
        normalizeNpcRecord(cast[0]);
        normalizeNpcRecord(cast[0]);
        assert.ok(reads >= 2, 'outside a pass every call reads the clock as before');
        // A clock that throws inside a pass is "no story date", exactly as outside one; the pass still ends cleanly.
        setStoryClockSource(() => { reads += 1; throw new Error('host gone'); });
        reads = 0;
        const thrown = withStoryDateMemo(() => cast.map(normalizeNpcRecord));
        assert.equal(reads, 1);
        setStoryClockSource(() => { throw new Error('host gone'); });
        assert.deepEqual(thrown, cast.map(normalizeNpcRecord));
        // The command path's own pass reads once too.
        setStoryClockSource(() => { reads += 1; return { minutes: MINUTES_611_06_15, calendar: GREGORIAN_CLOCK }; });
        const stored = { npcs: cast.map(normalizeNpcRecord), turn: 1 };
        reads = 0;
        applyNpcStateCommand(stored, { action: 'noop' });
        const commandReads = reads;
        reads = 0;
        cast.map(normalizeNpcRecord);
        assert.ok(commandReads < reads, `the command's re-normalize reads once (${commandReads}) where per-dossier reads ${reads}`);
    } finally {
        setStoryClockSource(null);
    }
});

test('1.10.1 story date: the chat state normalization is one memo pass (index.js)', async () => {
    const fs = await import('node:fs');
    const source = runtimeSource();
    assert.match(source, /function normalizeChatState\(raw = \{\}\) \{\n\s+return withStoryDateMemo\(\(\) => normalizeChatStateOnce\(raw\)\);\n    \}/);
    assert.equal((source.match(/normalizeChatStateOnce\(/g) || []).length, 2, 'only the memo wrapper calls the pass');
});

// A SillyTavern-like file route: weak ETags that change with every write (express.static), the body read only through text().
function fileServer() {
    const files = new Map();
    let stamp = 0;
    const log = { gets: [], textReads: 0 };
    const put = (path, text) => files.set(path, { text, etag: `W/"${text.length.toString(16)}-${(stamp += 1).toString(16)}"`, lastModified: `Wed, 04 Nov 2026 08:00:${String(stamp % 60).padStart(2, '0')} GMT` });
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            put(`/user/files/${body.name}`, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }) };
        }
        if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}) };
        log.gets.push({ url, cache: options.cache });
        const file = files.get(url);
        if (!file) return { ok: false, status: 404, headers: new Headers() };
        return { ok: true, status: 200, headers: new Headers({ etag: file.etag, 'last-modified': file.lastModified }), text: async () => { log.textReads += 1; return file.text; } };
    };
    return { files, put, fetchFn, log };
}

const sidecarText = (chatKey, revision, writerId, npcs = [{ id: 'mira', name: 'Mira' }]) => encodeStateFilePayload(chatKey, { npcs }, '1.10.1', { revision, writerId, updatedAt: '2026-11-04T08:00:00.000Z' });

test('1.10.1 boundary check: an unchanged sidecar (same ETag, or 304) is not read or parsed again; a changed one is', async () => {
    const server = fileServer();
    const chatKey = 'chat:perf.png:etag';
    const path = '/user/files/perf-etag.json';
    server.put(path, sidecarText(chatKey, 4, 'other-tab'));
    const first = await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(server.log.textReads, 1);
    const again = await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(server.log.textReads, 1, 'same ETag and Last-Modified: the body is not read');
    assert.equal(server.log.gets.length, 2, 'but the server is still asked every time');
    assert.ok(server.log.gets.every(get => get.cache === 'no-cache'), 'always revalidated, never read stale');
    assert.deepEqual(again, first, 'the same revision, writer, flags and (decoded on demand) payload');
    again.payload.state.npcs.push({ id: 'intruder' });
    const third = await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(third.payload.state.npcs.length, 1, 'each result decodes its own payload; a caller\'s change never leaks into the next');
    await assert.rejects(inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: 'chat:other.png:x' }), /different chat/, 'the chat check still holds');
    // A 304 for a file this session has read answers from what it read.
    const notModified = async url => (url === path ? { ok: false, status: 304, headers: new Headers() } : server.fetchFn(url));
    assert.equal((await inspectNpcStateDataFile({ path }, { fetchFn: notModified, expectedChatKey: chatKey })).revision, 4);
    // Another tab's or device's write changes the validators: read and parsed in full, the new revision seen.
    server.put(path, sidecarText(chatKey, 5, 'device-b'));
    const reads = server.log.textReads;
    const changed = await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
    assert.equal(server.log.textReads, reads + 1);
    assert.deepEqual([changed.revision, changed.writerId], [5, 'device-b']);
    // Gone: missing as before, and nothing remembered for it.
    server.files.delete(path);
    assert.equal((await inspectNpcStateDataFile({ path }, { fetchFn: server.fetchFn, expectedChatKey: chatKey })).exists, false);
    await assert.rejects(inspectNpcStateDataFile({ path }, { fetchFn: notModified, expectedChatKey: chatKey }), /HTTP 304/, 'a 304 for a file not remembered is an error, as before');
    // A server without validators: every check reads the file, as before.
    const bare = async url => { const answer = await server.fetchFn(url); return answer.ok ? { ...answer, headers: new Headers() } : answer; };
    server.put(path, sidecarText(chatKey, 6, 'x'));
    const before = server.log.textReads;
    await inspectNpcStateDataFile({ path }, { fetchFn: bare, expectedChatKey: chatKey });
    await inspectNpcStateDataFile({ path }, { fetchFn: bare, expectedChatKey: chatKey });
    assert.equal(server.log.textReads, before + 2);
});

test('1.10.1 own write: the read-back of the bytes just written is not parsed, and the next boundary check reads nothing', async () => {
    const server = fileServer();
    const chatKey = 'chat:perf.png:own-write';
    const npcs = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, name: `Person ${i}`, background: 'x'.repeat(4000) }));
    const headers = { 'Content-Type': 'application/json' };
    const pointer = await writeNpcStateDataFile({ chatKey, state: { npcs }, appVersion: '1.10.1', fetchFn: server.fetchFn, headers, continuousRetry: false });
    const parse = JSON.parse;
    let bigParses = 0;
    JSON.parse = function counted(text, ...rest) { if (typeof text === 'string' && text.startsWith('{"format":"npc_state_delta_chat_data"')) bigParses += 1; return parse.call(this, text, ...rest); };
    let next;
    let boundary;
    try {
        next = await writeNpcStateDataFile({ chatKey, state: { npcs: npcs.slice(1) }, appVersion: '1.10.1', pointer: { ...pointer }, fetchFn: server.fetchFn, headers, continuousRetry: false });
        const reads = server.log.textReads;
        boundary = await inspectNpcStateDataFile(next, { fetchFn: server.fetchFn, expectedChatKey: chatKey });
        assert.equal(server.log.textReads, reads, 'the boundary check after our own write does not read the body');
    } finally {
        JSON.parse = parse;
    }
    assert.equal(bigParses, 0, 'neither the pre-write check, the read-back nor the boundary check parsed the sidecar');
    assert.equal(next.revision, pointer.revision + 1);
    assert.deepEqual([boundary.revision, boundary.writerId], [next.revision, next.writerId]);
    assert.equal(boundary.payload.state.npcs.length, 19, 'the payload, when asked for, is the file that was written');
    // Another session writing between our upload and our read-back is still caught: its bytes are not ours.
    const racingFetch = async (url, options) => {
        const answer = await server.fetchFn(url, options);
        if (url === '/api/files/upload') server.put(next.path, sidecarText(chatKey, next.revision + 1, 'other-session'));
        return answer;
    };
    await assert.rejects(
        writeNpcStateDataFile({ chatKey, state: { npcs }, appVersion: '1.10.1', pointer: { ...next }, fetchFn: racingFetch, headers, continuousRetry: false }),
        error => error.code === 'NPC_STATE_WRITE_CONFLICT',
    );
});

test('hosted live read: calendarAge follows the story clock; dossiers are re-derived only when the clock, the set or the state version moved', () => {
    const prelude = async () => {
        const sdk = {
            clock: null, registerModule() {}, on() { return () => {}; }, command: async () => ({ ok: true, receipt: { summary: '' } }), settings: () => ({}),
            query: name => name === 'director.time' ? (sdk.clock ? { minutes: sdk.clock } : null)
                : name === 'director.calendar' ? { era: '', leapYears: true, months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map((days, at) => ({ name: `M${at + 1}`, days })) } : null,
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(300);
        const sdk = globalThis.StoryBlock.sdk;
        const out = {};
        const state = api.getState();
        state.npcs = [{ id: 'npc_mira', name: 'Mira', age: '21', birthDate: { era: '', year: 600, month: '03', day: 4 }, birthDateSource: 'established', birthDateYearSource: 'established' }];
        await api.installState(state);
        const age = () => api.getState().npcs[0].calendarAge;
        out.noClock = age();
        sdk.clock = (621 * 365 + 200) * 1440;
        out.withClock = age();
        const { calendarAgeStats } = await import(pathToFileURL(path.join(extRoot, 'core.js')).href);
        const passes = calendarAgeStats.passes;
        for (let at = 0; at < 20; at += 1) age();
        out.passesTotal = passes;
        out.passesSameClock = calendarAgeStats.passes - passes;
        sdk.clock = (631 * 365 + 200) * 1440;
        out.clockMoved = age();
        console.log('RESULT ' + JSON.stringify(out));
    };
    const output = runHostScenario('hosted-live-calendar-age', prelude, scenario);
    const out = JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.equal(out.noClock, null, 'no hosted date: no calendar age');
    assert.ok(Number.isInteger(out.withClock) && out.withClock >= 20, `the live read takes the age from the clock (${out.withClock}); fails if getChatState stops refreshing`);
    assert.ok(out.passesTotal >= 1, 'the counter is the runtime\'s own');
    assert.equal(out.passesSameClock, 0, 'same clock, same state: 20 reads, no pass over the dossiers');
    assert.ok(Number.isInteger(out.clockMoved) && out.clockMoved > out.withClock, `a moved clock re-derives (${out.clockMoved})`);
});
