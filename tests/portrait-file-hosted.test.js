import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostScenario } from './helpers/host-scenario.js';

// The cast portraits as user files, through Delta's real runtime on the synthetic host: the chat's saved state, an export and an import, a
// file deleted by hand, and a chat made before (the picture inside the dossier) beside a new one (a file).

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const scenarioOutput = output => JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));

test('runtime: a file-form portrait is saved with no picture in the chat state, exports with its picture, imports as a file again, and shows the no-portrait look when the file is gone; an older chat keeps its picture as before', () => {
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(300);
        const png = '__PNG__';
        const out = {};
        // SillyTavern's file routes the way the server answers them (binary-true), in front of the mock's.
        const plainFetch = globalThis.fetch;
        const store = new Map();
        const seen = { portraitUploads: 0, portraitGets: [], verifies: 0 };
        const nameOf = url => String(url).split('/').pop();
        globalThis.fetch = async (url, options = {}) => {
            if (url === '/api/files/verify') {
                seen.verifies += 1;
                return { ok: true, status: 200, json: async () => Object.fromEntries(JSON.parse(options.body).urls.map(path => [path, store.has(path) || mockState.files.has(path)])) };
            }
            if (url === '/api/files/upload' && JSON.parse(options.body).name.startsWith('npc-state-delta-portrait-')) {
                const body = JSON.parse(options.body);
                seen.portraitUploads += 1;
                store.set(`/user/files/${body.name}`, Buffer.from(body.data, 'base64'));
                return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }) };
            }
            if (String(url).startsWith('/user/files/npc-state-delta-portrait-')) {
                seen.portraitGets.push(nameOf(url));
                if (!store.has(url)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
                const bytes = store.get(url);
                return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
            }
            return plainFetch(url, options);
        };
        const storage = await import(pathToFileURL(path.join(extRoot, 'storage.js')).href);
        const mechanics = await import(pathToFileURL(path.join(extRoot, 'core-mechanics.js')).href);
        const bundle = await import(pathToFileURL(path.join(extRoot, 'bundle.js')).href);
        const view = await import(pathToFileURL(path.join(extRoot, 'dossier-ui.js')).href);
        const portraits = () => Object.fromEntries(view.projectDossierState(api.getDossierState()).npcs.map(npc => [npc.name, npc.portrait]));
        const sidecar = () => [...mockState.files.entries()].find(([path]) => /\/npc-state-delta-[a-z0-9]+\.json$/.test(path))?.[1] ?? '';

        // A chat with one person made before (the picture inside the dossier) and one made now (a file).
        const record = await storage.savePortraitFile(png, { fetchFn: globalThis.fetch, headers: { 'Content-Type': 'application/json' } });
        const state = api.getState();
        const fenna = mechanics.createNpcRecord('Fenna', []);
        fenna.portrait = { ...record, sourceName: 'fenna.webp', updatedAt: 1 };
        const mira = mechanics.createNpcRecord('Mira', [fenna.id]);
        mira.portrait = { dataUrl: png, mime: 'image/png', updatedAt: 1 };
        state.npcs = [fenna, mira];
        state.portraitAssets = { [mira.id]: structuredClone(mira.portrait) };
        await api.installState(state);
        await api.flush();
        await sleep(200);
        out.shown = portraits();
        out.liveFenna = api.getState().npcs.find(npc => npc.name === 'Fenna').portrait;
        out.liveAssets = Object.keys(api.getState().portraitAssets);
        out.sidecarPictures = (sidecar().match(/data:image/g) || []).length;
        out.sidecarHasFennaPath = sidecar().includes(record.path);

        // Export: the picture goes in the bundle (read back from the file); the older form goes as it always did.
        const bytes = await api.exportBytes();
        const decoded = bundle.decodeNpcStateBundle(bytes);
        const carried = Object.fromEntries(decoded.state.npcs.map(npc => [npc.name, npc.portrait]));
        out.exported = { fenna: carried.Fenna?.dataUrl === png, fennaHash: carried.Fenna?.hash === record.hash, fennaPath: carried.Fenna?.path ?? null, mira: carried.Mira?.dataUrl === png, miraHash: carried.Mira?.hash ?? null };

        // Import with the file gone (a chat on another machine): the file is written again and the dossier keeps the file form.
        store.clear();
        seen.portraitUploads = 0;
        const imported = await api.importBytes(bytes);
        out.importOk = imported !== false;
        out.uploadsAtImport = seen.portraitUploads;
        out.importedFenna = api.getState().npcs.find(npc => npc.name === 'Fenna')?.portrait ?? null;
        out.importedMira = Boolean(api.getState().npcs.find(npc => npc.name === 'Mira')?.portrait?.dataUrl || api.getState().portraitAssets[api.getState().npcs.find(npc => npc.name === 'Mira')?.id]?.dataUrl);

        // A file deleted by hand: the next load asks once (no fetch of the missing file) and the person shows no portrait, with no error.
        store.clear();
        seen.portraitGets.length = 0;
        const errors = [];
        const warn = console.error;
        console.error = (...args) => { errors.push(args.map(String).join(' ')); };
        await api.installState(api.getState());
        await sleep(200);
        console.error = warn;
        out.afterDelete = portraits();
        out.getsOfMissing = seen.portraitGets.length;
        out.errors = errors.length;
        out.stateKeptRecord = Boolean(api.getState().npcs.find(npc => npc.name === 'Fenna').portrait?.path);
        out.miraStill = portraits().Mira === png;
        console.log('RESULT ' + JSON.stringify(out));
    };
    const source = scenario.toString().replace('__PNG__', PNG);
    const out = scenarioOutput(runHostScenario('portrait-file-hosted', async () => {}, { toString: () => source }));
    assert.match(out.shown.Fenna, /^\/user\/files\/npc-state-delta-portrait-[a-f0-9]{40}\.png$/, 'the new form shows its file');
    assert.equal(out.shown.Mira, PNG, 'the older form shows its picture, as before');
    assert.deepEqual(out.liveAssets, [out.liveAssets[0]], 'one asset: the older form\'s; the new form has no second copy');
    assert.equal(out.liveFenna.dataUrl, undefined);
    assert.equal(out.sidecarPictures, 1, 'the saved state holds the older picture once (as before) and the new one not at all');
    assert.equal(out.sidecarHasFennaPath, true);
    assert.deepEqual(out.exported, { fenna: true, fennaHash: true, fennaPath: null, mira: true, miraHash: null }, 'an export carries both pictures; the file form is marked by its hash');
    assert.equal(out.importOk, true);
    assert.equal(out.uploadsAtImport, 1, 'the import wrote the missing file');
    assert.match(out.importedFenna.path, /^\/user\/files\/npc-state-delta-portrait-/, 'and the dossier is a file form again');
    assert.equal(out.importedFenna.dataUrl, undefined);
    assert.equal(out.importedMira, true, 'the older form stays an older form');
    assert.equal(out.afterDelete.Fenna, '', 'a file deleted by hand: the normal no-portrait look');
    assert.equal(out.getsOfMissing, 0, 'without fetching it');
    assert.equal(out.errors, 0, 'and without an error');
    assert.equal(out.stateKeptRecord, true, 'the dossier keeps its record');
    assert.equal(out.miraStill, true);
});
