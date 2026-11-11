import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInjection, buildScannerPrompt, createNpcRecord, mergeScanResult } from '../core.js';
import { decodeNpcStateBundle, encodeNpcStateBundle, mergeImportedDossierState } from '../bundle.js';
import { reconcileBranchState, recordBranchCheckpoint, snapshotBranchState, BRANCH_LINEAGE_VERSION } from '../branch.js';
import { preserveUserNpcMetadata } from '../branch-core.js';
import { dossierDetailProjection, dossierIndexProjection, projectDossierState } from '../dossier-ui.js';
import { decodeStateFilePayload, encodeStateFilePayload, readPortraitFileDataUrl, savePortraitFile, verifyPortraitFiles } from '../storage.js';
import {
    PORTRAIT_FILE_PREFIX, isPortraitFileRecord, markPortraitFileMissing, markPortraitFilePresent, parseImageDataUrl,
    portraitFileName, portraitHasImage, portraitSrc, sha256Hex,
} from '../src/portrait-file.js';
import { portraitUrl } from '../src/storysuite-v2.js';

// The cast portraits as user files (src/portrait-file.js, storage.js): one content-named file per picture, written only when absent, with
// the dossier keeping only { path, type, hash, … }. Chats that hold the picture itself in the dossier (dataUrl) are read as before.

const HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 't' };
// A real (1x1) PNG and a second picture.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEBP = `data:image/webp;base64,${Buffer.from('RIFF....WEBPVP8 pretend image bytes').toString('base64')}`;
const bytesOf = dataUrl => Buffer.from(dataUrl.split(',')[1], 'base64');
const hashOf = dataUrl => createHash('sha256').update(bytesOf(dataUrl)).digest('hex');

/** SillyTavern's file routes: upload (binary-true), verify, and a GET of what is stored. `routes` switches parts off. */
function server({ verify = true, upload = true } = {}) {
    const files = new Map();
    const calls = [];
    const fetchFn = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET' });
        if (url === '/api/files/verify') {
            if (!verify) return { ok: false, status: 404, json: async () => ({}) };
            const { urls } = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => Object.fromEntries(urls.map(path => [path, files.has(path)])) };
        }
        if (url === '/api/files/upload') {
            if (!upload) return { ok: false, status: 500, text: async () => '' };
            const { name, data } = JSON.parse(options.body);
            files.set(`/user/files/${name}`, Buffer.from(data, 'base64'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${name}` }) };
        }
        if (files.has(url)) {
            const bytes = files.get(url);
            return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    return { files, calls, fetchFn, gets: () => calls.filter(call => call.method === 'GET'), uploads: () => calls.filter(call => call.url === '/api/files/upload') };
}

const castNpc = (name, record, extra = {}) => ({ ...createNpcRecord(name), portrait: record, ...extra });
async function fileRecord(dataUrl = PNG, s = server()) {
    const record = await savePortraitFile(dataUrl, { fetchFn: s.fetchFn, headers: HEADERS });
    assert.ok(record, 'the picture was saved');
    return { record, s };
}

test('the picture is named by its content: the hash is the platform\'s SHA-256, and a path that is not the record\'s own is never trusted', async () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
    const { record } = await fileRecord();
    assert.equal(record.hash, hashOf(PNG));
    assert.equal(record.type, 'image/png');
    assert.equal(record.path, `/user/files/${PORTRAIT_FILE_PREFIX}${record.hash.slice(0, 40)}.png`);
    assert.equal(portraitFileName(record.hash, 'image/webp'), `${PORTRAIT_FILE_PREFIX}${record.hash.slice(0, 40)}.webp`);
    assert.equal(portraitFileName(record.hash, 'image/svg+xml'), '', 'only raster types are stored');
    assert.equal(isPortraitFileRecord(record), true);
    for (const forged of [{ ...record, path: '/user/files/other.png' }, { ...record, path: 'https://example.com/x.png' }, { ...record, hash: 'a'.repeat(64) }, { ...record, type: 'image/svg+xml' }, { path: record.path }]) {
        assert.equal(isPortraitFileRecord(forged), false, JSON.stringify(forged).slice(0, 80));
        assert.equal(portraitSrc(forged), '');
    }
    assert.equal(parseImageDataUrl('data:image/svg+xml;base64,AAAA'), null);
    assert.equal(parseImageDataUrl(`data:image/png;base64,${Buffer.alloc(400 * 1024).toString('base64')}`), null, 'too big');
});

test('a picture is written once, only when absent, and asking never makes a 404: a file that is there is not written again', async () => {
    const s = server();
    const first = await savePortraitFile(PNG, { fetchFn: s.fetchFn, headers: HEADERS });
    assert.equal(s.calls[0].url, '/api/files/verify', 'asked first');
    assert.deepEqual(s.gets(), [], 'nothing was fetched that is not there');
    assert.equal(s.uploads().length, 1);
    assert.deepEqual(s.files.get(first.path), bytesOf(PNG), 'the file holds the picture\'s own bytes');
    const again = await savePortraitFile(PNG, { fetchFn: s.fetchFn, headers: HEADERS });
    assert.deepEqual(again, first, 'the same picture, the same record');
    assert.equal(s.uploads().length, 1, 'present: not written again');
    const other = await savePortraitFile(WEBP, { fetchFn: s.fetchFn, headers: HEADERS });
    assert.notEqual(other.path, first.path);
    assert.equal(s.uploads().length, 2);
    assert.equal(s.gets().length, 0);
});

test('a server that cannot say still saves the picture, and a failed write or a picture that is not stored leaves the caller its own copy', async () => {
    const odd = server({ verify: false });
    const record = await savePortraitFile(PNG, { fetchFn: odd.fetchFn, headers: HEADERS });
    assert.ok(record);
    assert.equal(odd.uploads().length, 1);
    assert.deepEqual(odd.gets(), [], 'still no read of a file that may not be there');
    const broken = server({ upload: false });
    assert.equal(await savePortraitFile(PNG, { fetchFn: broken.fetchFn, headers: HEADERS }), null, 'the write failed: null, so the caller keeps the data URL as before');
    const none = server();
    assert.equal(await savePortraitFile('data:image/svg+xml;base64,AAAA', { fetchFn: none.fetchFn, headers: HEADERS }), null);
    assert.equal(await savePortraitFile(PNG, { fetchFn: async () => { throw new Error('offline'); }, headers: HEADERS }), null);
    assert.deepEqual(none.calls, [], 'nothing is asked for a picture that is not stored');
});

test('a portrait file that is gone shows the normal no-portrait look: the list, the dossier and the hosted portrait query; one that is back shows again', async () => {
    const { record, s } = await fileRecord();
    const npc = castNpc('Fenna', record);
    assert.equal(dossierIndexProjection(npc).portrait, record.path, 'the list shows the file');
    assert.equal(dossierDetailProjection(npc).portrait, record.path, 'the dossier shows the file');
    assert.equal(portraitUrl(npc), record.path, 'and so does the hosted portrait query');
    s.files.delete(record.path);
    assert.equal(await verifyPortraitFiles([npc.portrait], { fetchFn: s.fetchFn, headers: HEADERS }), 1, 'one file gone, said in one request');
    assert.equal(s.calls.filter(call => call.url === '/api/files/verify').length, 2, 'save asked once, the check once');
    assert.deepEqual(s.gets(), [], 'no fetch of the missing file: no 404');
    assert.equal(dossierIndexProjection(npc).portrait, '');
    assert.equal(dossierDetailProjection(npc).portrait, '');
    assert.equal(portraitUrl(npc), null);
    assert.equal(portraitHasImage(npc.portrait), true, 'it is still the person\'s portrait record; nothing is deleted from the state');
    const html = projectDossierState({ npcs: [npc] }).index[0];
    assert.equal(html.portrait, '');
    markPortraitFilePresent(record.path);
    assert.equal(dossierIndexProjection(npc).portrait, record.path, 'the file came back');
});

test('a file the picture fails to load from is remembered as gone', () => {
    const npc = castNpc('Brecht', { path: `/user/files/${PORTRAIT_FILE_PREFIX}${hashOf(PNG).slice(0, 40)}.png`, type: 'image/png', hash: hashOf(PNG) });
    assert.equal(dossierIndexProjection(npc).portrait, npc.portrait.path);
    markPortraitFileMissing(npc.portrait.path);
    assert.equal(dossierIndexProjection(npc).portrait, '');
    markPortraitFilePresent(npc.portrait.path);
});

test('records that hold the picture (an upload, a chat made before) are read exactly as before, beside the file form', () => {
    const old = castNpc('Mira', { dataUrl: PNG, mime: 'image/png', sourceName: 'mira.png', updatedAt: 1 });
    assert.equal(portraitSrc(old.portrait), PNG);
    assert.equal(dossierIndexProjection(old).portrait, PNG);
    assert.equal(dossierDetailProjection(old).portrait, PNG);
    assert.equal(portraitUrl(old), PNG);
    assert.equal(portraitHasImage(old.portrait), true);
    const assetOnly = createNpcRecord('Tom');
    assert.equal(dossierIndexProjection(assetOnly, { [assetOnly.id]: { dataUrl: WEBP } }).portrait, WEBP, 'an asset copy still shows for a record without its picture');
    assert.equal(portraitUrl({ portrait: { url: '/user/images/Mira.png' } }), '/user/images/Mira.png');
    assert.equal(portraitSrc(null), '');
});

test('a readback of the file gives the picture as a data URL; a gone file or other bytes give nothing', async () => {
    const { record, s } = await fileRecord(WEBP);
    assert.equal(await readPortraitFileDataUrl(record, { fetchFn: s.fetchFn }), WEBP);
    s.files.set(record.path, Buffer.from('not the picture'));
    assert.equal(await readPortraitFileDataUrl(record, { fetchFn: s.fetchFn }), null, 'bytes that are not the record\'s hash are not handed out');
    s.files.delete(record.path);
    assert.equal(await readPortraitFileDataUrl(record, { fetchFn: s.fetchFn }), null);
    assert.equal(await readPortraitFileDataUrl({ path: '/etc/passwd', type: 'image/png', hash: 'x' }, { fetchFn: s.fetchFn }), null);
});

test('the chat\'s saved state: a file-form portrait is a few hundred bytes with no second copy; an older dataUrl chat is saved exactly as before', async () => {
    const big = `data:image/webp;base64,${Buffer.alloc(150 * 1024, 7).toString('base64')}`;
    const { record } = await fileRecord(PNG);
    const filed = { ...createNpcRecord('Fenna'), portrait: { ...record, sourceName: 'fenna.webp', updatedAt: 5, appearanceFingerprint: 'a2:x' } };
    const text = encodeStateFilePayload('chat:a.png:one', { npcs: [filed], portraitAssets: {}, checkpoints: [] }, 'test');
    assert.ok(!text.includes('data:image'), 'no picture in the saved state');
    const back = decodeStateFilePayload(text);
    assert.deepEqual(back.state.npcs[0].portrait, filed.portrait, 'the record comes back as it was saved');
    assert.deepEqual(back.state.portraitAssets, {}, 'and no second copy is kept in portraitAssets');
    // An older chat: the picture is in the dossier and its asset copy; the file keeps the one copy (portraitAssets) as it always did.
    const old = { ...createNpcRecord('Mira'), portrait: { dataUrl: big, mime: 'image/webp' } };
    const oldText = encodeStateFilePayload('chat:a.png:two', { npcs: [old], portraitAssets: { [old.id]: old.portrait }, checkpoints: [] }, 'test');
    const oldBack = decodeStateFilePayload(oldText);
    assert.equal(oldBack.state.portraitAssets[old.id].dataUrl, big, 'the older form is saved and read as before');
    assert.equal(oldBack.state.npcs[0].portrait, null, 'as before: the picture is held once in the file, by portraitAssets');
    assert.ok(oldText.length > 150 * 1024, 'the older form is as big as it was; nothing is rewritten to migrate it');
    assert.ok(text.length < 20 * 1024, `the file form is small (${text.length} bytes for a dossier)`);
    // Both forms in one chat.
    const both = encodeStateFilePayload('chat:a.png:three', { npcs: [filed, old], portraitAssets: { [old.id]: old.portrait } }, 'test');
    const bothBack = decodeStateFilePayload(both).state;
    assert.equal(bothBack.npcs.find(npc => npc.name === 'Fenna').portrait.path, record.path);
    assert.equal(bothBack.portraitAssets[old.id].dataUrl, big);
    assert.equal(Object.keys(bothBack.portraitAssets).length, 1);
});

const user = text => ({ is_user: true, is_system: false, name: 'Kazuma', mes: text });
const assistant = (text, swipe = 0) => ({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: swipe });
const baseState = () => ({ npcs: [], dismissed: [], inlineCards: [], checkpoints: [], lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0 });

test('checkpoints and rollback: a file-form portrait stays in the snapshot (a few hundred bytes) and a rollback, swipe or middle delete restores the person with it; the picture itself is still left out', async () => {
    const { record } = await fileRecord();
    const chat = [user('Hello.'), assistant('Fenna looks up.', 0), user('And then?'), assistant('She nods.', 0)];
    const state = baseState();
    const fenna = castNpc('Fenna', structuredClone(record));
    state.npcs = [fenna];
    recordBranchCheckpoint(state, chat, 1, 'cast-dossier');
    assert.deepEqual(state.checkpoints[0].snapshot.npcs[0].portrait, record, 'the record is in the checkpoint');
    const withPicture = baseState();
    withPicture.npcs = [castNpc('Mira', { dataUrl: PNG, mime: 'image/png' })];
    recordBranchCheckpoint(withPicture, chat, 1, 'scan');
    assert.equal(withPicture.checkpoints[0].snapshot.npcs[0].portrait, null, 'a picture in the dossier is still left out of snapshots, as before');
    assert.equal(snapshotBranchState(state).npcs[0].portrait.path, record.path);
    // A later reply; then the head swipes. Fenna exists in both, the portrait stays.
    state.turn = 1;
    recordBranchCheckpoint(state, chat, 3, 'scan');
    const swiped = structuredClone(chat);
    swiped[3] = assistant('She shakes her head.', 1);
    const swipe = reconcileBranchState(state, swiped, { explicitDivergence: 3 });
    assert.equal(swipe.state.npcs.find(npc => npc.name === 'Fenna').portrait.path, record.path, 'a swipe keeps the portrait');
    // A middle delete of the later exchange; the person is restored from the checkpoint with the portrait, even after being removed from the live state.
    const gone = structuredClone(swipe.state);
    gone.npcs = [];
    gone.portraitAssets = {};
    const rolled = reconcileBranchState(gone, chat.slice(0, 2), { explicitDivergence: 2 });
    const restored = rolled.state.npcs.find(npc => npc.name === 'Fenna');
    assert.ok(restored, 'the person is back');
    assert.deepEqual(restored.portrait, record, 'with their portrait, with no asset kept for them');
    // The user's current portrait wins over the snapshot's.
    const current = castNpc('Fenna', { dataUrl: PNG, mime: 'image/png' }, { id: fenna.id });
    const metadata = preserveUserNpcMetadata([{ ...fenna, portrait: structuredClone(record) }], [current]);
    assert.equal(metadata[0].portrait.dataUrl, PNG);
    const filedCurrent = preserveUserNpcMetadata([{ ...fenna, portrait: null }], [castNpc('Fenna', structuredClone(record), { id: fenna.id })]);
    assert.equal(filedCurrent[0].portrait.path, record.path);
});

test('export and import: a bundle carries the picture (inlined at export, with its hash as the mark) and the import side can make the file again', async () => {
    const { record, s } = await fileRecord(WEBP);
    // What index.js does at export: the picture read from the file takes the place of the record, keeping hash and type.
    const dataUrl = await readPortraitFileDataUrl(record, { fetchFn: s.fetchFn });
    const { path, ...rest } = record;
    const inlined = castNpc('Fenna', { ...rest, dataUrl, mime: record.type, sourceName: 'fenna.webp' });
    const bytes = encodeNpcStateBundle({ npcs: [inlined] }, { appVersion: 'test', chatKey: 'chat:a.png:one' });
    const decoded = decodeNpcStateBundle(bytes);
    const carried = decoded.state.npcs[0].portrait;
    assert.equal(carried.dataUrl, WEBP, 'the bundle carries the picture');
    assert.equal(carried.hash, record.hash, 'with the mark that it was a file');
    assert.equal(carried.path, undefined);
    // The import side writes the file when it is absent and keeps only the record (the same as index.js importBundleBytes).
    const target = server();
    const again = await savePortraitFile(carried.dataUrl, { fetchFn: target.fetchFn, headers: HEADERS });
    assert.equal(again.path, record.path, 'the same content gives the same file');
    assert.equal(target.uploads().length, 1);
    const merged = mergeImportedDossierState({ npcs: [], dismissed: [] }, { npcs: [{ ...decoded.state.npcs[0], portrait: { ...again, sourceName: 'fenna.webp' } }], dismissed: [] }, { maxNpcs: 40 });
    assert.equal(merged.npcs[0].portrait.path, record.path, 'the imported dossier keeps its file-form portrait');
    // Merged into a dossier that has none, and over one that has another.
    const existing = createNpcRecord('Fenna');
    const intoPlain = mergeImportedDossierState({ npcs: [existing], dismissed: [] }, { npcs: [{ ...existing, portrait: structuredClone(again) }], dismissed: [] }, { maxNpcs: 40 });
    assert.equal(intoPlain.npcs[0].portrait.path, record.path, 'a file-form portrait is an image like any other when dossiers merge');
});

test('what is sent to the model never carries a portrait: not the path, not the hash, not a data URL', async () => {
    const { record } = await fileRecord();
    const npc = { ...castNpc('Fenna', structuredClone(record), { present: true, role: 'ferrywoman', speech: 'Plain, quick.' }) };
    npc.relationship = { ...npc.relationship, trust: 30 };
    const injection = buildInjection([npc], 'Fenna coils the rope at the ferry.', 3, 3);
    assert.match(injection, /Fenna/, 'she is in the dossier text');
    const prompt = buildScannerPrompt({ transcript: 'Fenna coils the rope at the ferry.', existingNpcs: [npc] });
    for (const text of [injection, prompt]) {
        assert.doesNotMatch(text, /npc-state-delta-portrait|\/user\/files|data:image|portrait/i);
        assert.ok(!text.includes(record.hash));
    }
    const withPicture = { ...npc, portrait: { dataUrl: PNG, mime: 'image/png' } };
    assert.ok(!buildInjection([withPicture], 'Fenna coils the rope.', 3, 3).includes('data:image'), 'and as before for the older form');
});

test('a cast dossier made with a file-form portrait carries the record, and one made with the picture (the file could not be written) carries that', async () => {
    const { record } = await fileRecord();
    const { applyCastEntry } = await import('../src/cast-dossier.js');
    const person = { key: 'p:t', pack: 'p', id: 't', name: 'Tom', entry: { aliases: [], fields: {}, meters: { values: {} }, secrets: [], stages: [], start: {}, about: 'a' } };
    assert.equal(applyCastEntry(createNpcRecord('Tom'), person, { portrait: structuredClone(record) }).portrait.path, record.path);
    assert.equal(applyCastEntry(createNpcRecord('Tom'), person, { portrait: { dataUrl: PNG, mime: 'image/png' } }).portrait.dataUrl, PNG);
    assert.equal(applyCastEntry(createNpcRecord('Tom'), person, { portrait: null }).portrait, null);
});

test('a scan or a Refresh that updates a dossier keeps its file-form portrait as it keeps any other', async () => {
    const { record } = await fileRecord();
    const fenna = { ...createNpcRecord('Fenna'), portrait: { ...record, sourceName: 'fenna.webp', appearanceFingerprint: 'a2:x' }, role: 'ferrywoman', present: true };
    const state = { ...baseState(), npcs: [fenna], turn: 3 };
    const out = mergeScanResult(state, { npcs: [{ id: fenna.id, name: 'Fenna', present: true, role: 'ferry captain', mood: 'wary' }] }, { turn: 4, maxNpcs: 10 });
    const after = out.state.npcs.find(npc => npc.id === fenna.id);
    assert.deepEqual(after.portrait, fenna.portrait, 'the record is untouched by the scan');
    assert.equal(out.state.portraitAssets === undefined || Object.keys(out.state.portraitAssets).length === 0, true, 'and no second copy is made');
});

test('a failed image load alone does not blank a cast portrait; a file known gone lets cast sync refill it, a present one does not', async () => {
    const { castPortraitWanted } = await import('../src/cast-dossier.js');
    const { portraitFileKnownGone } = await import('../src/portrait-file.js');
    const record = { path: `/user/files/${PORTRAIT_FILE_PREFIX}${hashOf(PNG).slice(0, 40)}.png`, type: 'image/png', hash: hashOf(PNG) };
    const npc = castNpc('Brecht', record, { castFrom: { key: 'pack:brecht' } });
    assert.equal(portraitSrc(npc.portrait), record.path, 'nothing marks it missing without a fresh check');
    assert.equal(castPortraitWanted(npc), false);
    markPortraitFileMissing(record.path); // what index.js does only after dataFileExists said false
    assert.equal(portraitFileKnownGone(npc.portrait), true);
    assert.equal(castPortraitWanted(npc), true, 'a known-missing file is refilled by cast sync');
    assert.equal(castPortraitWanted({ ...npc, castFrom: { key: 'pack:brecht', portraitRemoved: true } }), false, 'a portrait the reader removed stays removed');
    markPortraitFilePresent(record.path);
    assert.equal(castPortraitWanted(npc), false);
});
