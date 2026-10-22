import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { inspectNpcStateDataFile, dataFileExists, readNpcStateDataFile } from '../storage.js';
import { isEmptyScannerAnswer } from '../scanner-routing.js';

// The final breaker's NSD lows on a fresh chat (B-final-13 / a3-4), with Story Block v2:
//  1. A new chat has no per-chat data file yet. Fetching it only to be told so put a red 404 in the
//     browser console on every new chat: where a missing file is expected Delta now asks SillyTavern
//     whether it exists first (/api/files/verify) and reads it only when it does (or when the server
//     cannot say, as before).
//  2. A scanner call the model answered with nothing ("No message generated") is a quiet note once
//     per chat, not console.error with a stack per reply (isEmptyScannerAnswer; index.js noteScanFailure).
//  3. The Cast tab shows the meters the story's change lines set right away, from the state, for people
//     with no dossier yet (no scan has made one), when Story Block's scene has them here.

const PATH = '/user/files/npc-state-delta-abc.json';
const HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 't' };

// A fake server: `files` the paths that exist, `verify` how /api/files/verify answers ('ok', 'missing'
// for a 404 route, 'throw'). Records every request.
function server({ files = {}, verify = 'ok' } = {}) {
    const calls = [];
    const fetchFn = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET', body: options.body ?? null });
        if (url === '/api/files/verify') {
            if (verify === 'throw') throw new Error('offline');
            if (verify === 'missing') return { ok: false, status: 404, json: async () => ({}) };
            if (verify === 'odd') return { ok: true, status: 200, json: async () => ['nope'] };
            const { urls } = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => Object.fromEntries(urls.map(path => [path, Object.hasOwn(files, path)])) };
        }
        if (Object.hasOwn(files, url)) return { ok: true, status: 200, text: async () => files[url], json: async () => JSON.parse(files[url]) };
        return { ok: false, status: 404, text: async () => '' };
    };
    return { fetchFn, calls, gets: () => calls.filter(call => call.method === 'GET').map(call => call.url) };
}

test('a file the server says is missing is "missing" without fetching it: no 404', async () => {
    const s = server();
    const inspected = await inspectNpcStateDataFile({ path: PATH }, { fetchFn: s.fetchFn, probeHeaders: HEADERS });
    assert.equal(inspected.exists, false);
    assert.deepEqual(s.gets(), [], 'nothing fetched');
    assert.equal(s.calls[0].url, '/api/files/verify');
    assert.deepEqual(JSON.parse(s.calls[0].body), { urls: [PATH] });
    assert.equal(await readNpcStateDataFile({ path: PATH }, { fetchFn: s.fetchFn, probeHeaders: HEADERS }), null);
    assert.deepEqual(s.gets(), []);
});

test('the server cannot say (an older SillyTavern, an error, another answer): the file is fetched as before', async () => {
    for (const verify of ['missing', 'throw', 'odd']) {
        const s = server({ verify });
        assert.equal(await dataFileExists(PATH, { fetchFn: s.fetchFn, headers: HEADERS }), null, verify);
        const inspected = await inspectNpcStateDataFile({ path: PATH }, { fetchFn: s.fetchFn, probeHeaders: HEADERS });
        assert.equal(inspected.exists, false, '404 still reads as missing');
        assert.deepEqual(s.gets(), [PATH], `${verify}: fetched once`);
    }
});

test('a file that exists is fetched; without probe headers nothing is asked first (every other read)', async () => {
    const s = server({ files: { [PATH]: '{}' } });
    assert.equal(await dataFileExists(PATH, { fetchFn: s.fetchFn, headers: HEADERS }), true);
    await inspectNpcStateDataFile({ path: PATH }, { fetchFn: s.fetchFn, probeHeaders: HEADERS }).catch(() => null);
    assert.deepEqual(s.gets(), [PATH]);
    const plain = server();
    await inspectNpcStateDataFile({ path: PATH }, { fetchFn: plain.fetchFn });
    assert.deepEqual(plain.calls.map(call => call.url), [PATH], 'no verify call without probe headers');
    assert.equal(await dataFileExists(PATH, { fetchFn: plain.fetchFn, headers: null }), null, 'no headers, no POST');
});

test('an empty scanner answer is told apart from other failures', () => {
    for (const error of [new Error('No message generated'), 'no message generated', new Error('The provider sent an empty response.')]) {
        assert.equal(isEmptyScannerAnswer(error), true, String(error));
    }
    for (const error of [new Error('HTTP 500'), new Error('Request through profile "x" failed.'), null, undefined, new Error('Scanner returned invalid JSON')]) {
        assert.equal(isEmptyScannerAnswer(error), false, String(error));
    }
});

// ---- the Cast tab on a whole Story Block host ----

async function suite(t, records = []) {
    t.mock.method(console, 'warn', () => {});
    const host = await createHost({});
    t.after(() => host.close());
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        isEnabled: () => true,
        getNpc: id => structuredClone(records.find(npc => npc.id === id) ?? null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        presentCastHtml: () => '',
        castEmptyReason: () => ({ text: 'No NPC has a dossier in this chat yet.' }),
        fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => records.map(({ id, name, aliases = [], present = false, archived = false }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true);
    t.after(() => adapter.stop());
    const cast = () => {
        const el = { innerHTML: '', addEventListener() {}, isConnected: true, dataset: {} };
        adapter.definition.tabs[0].render(el);
        return el.innerHTML;
    };
    return { host, adapter, cast };
}

test('the Cast tab shows meters the change lines set, before any dossier exists, for those in the scene', async t => {
    const { host, cast } = await suite(t);
    await host.send('We walk in.', 'Odda nods at you; Brecht is away at the mill.\n\n<Changes>\n+ present Odda\n~ npc Odda | trust: +10\n~ npc Brecht | trust: +5\n</Changes>');
    const html = cast();
    assert.match(html, /No NPC has a dossier in this chat yet/, 'Delta\'s own empty-cast line stays');
    assert.match(html, /<h4>Odda<\/h4>/, 'Odda\'s meters show right away');
    assert.match(html, /aria-label="Trust"[^>]*aria-valuenow="10"/);
    assert.doesNotMatch(html, /Brecht/, 'not in the scene: not shown');
    // Once Brecht arrives, his meters show too.
    await host.send('Brecht?', 'Brecht comes in from the mill.\n\n<Changes>\n+ present Brecht\n</Changes>');
    assert.match(cast(), /<h4>Brecht<\/h4>/);
});

test('a person with a dossier keeps the dossier\'s presence: away in the dossier, not drawn from the slice', async t => {
    const records = [{ id: 'npc_odda', name: 'Odda', present: false }];
    const { host, cast } = await suite(t, records);
    await host.send('We walk in.', 'Odda waves.\n\n<Changes>\n+ present Odda\n~ npc Odda | trust: +10\n</Changes>');
    assert.doesNotMatch(cast(), /<h4>Odda<\/h4>/, 'her dossier says she is not present; Delta\'s own rule stands');
    records[0].present = true;
    assert.match(cast(), /<h4>Odda<\/h4>/);
});
