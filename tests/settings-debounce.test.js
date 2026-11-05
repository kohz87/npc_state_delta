// settings.json is written once per burst, not after every dossier change (runtime-settings.js persistSettingsLazy, runtime-persist.js).
// Real modules in a temp tree with a stub host; fake timers; a small in-memory file server for the sidecar.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-settings-debounce-'));
const extRoot = path.join(tempRoot, 'public', 'scripts', 'extensions', 'third-party', 'npc_state_delta');
fs.mkdirSync(extRoot, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ type: 'module' }));
const modules = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime-modules.json'), 'utf8')).modules;
for (const { path: file } of modules) {
    const target = path.join(extRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file), target);
}
fs.writeFileSync(path.join(tempRoot, 'public', 'scripts', 'extensions.js'), `
export const extension_settings = globalThis.__settingsHost.extensionSettings;
export function getContext() { return globalThis.__settingsHost.context; }
`);
fs.writeFileSync(path.join(tempRoot, 'public', 'script.js'), `
export function getRequestHeaders() { return {}; }
export async function saveSettings() {}
`);
const host = { extensionSettings: {}, saves: 0, context: null };
host.context = { saveSettingsDebounced: () => { host.saves += 1; } };
globalThis.__settingsHost = host;
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const load = file => import(pathToFileURL(path.join(extRoot, file)).href);
const settingsMod = await load('runtime-settings.js');
const { createPersistPart } = await load('runtime-persist.js');
const storage = await load('storage.js');
const { buildQualifiedChatKey } = await load('identity.js');
const { persistSettings, persistSettingsLazy, flushPendingSettingsSave, getSettings, SETTINGS_LAZY_QUIET_MS, SETTINGS_LAZY_MAX_MS } = settingsMod;

const settle = async () => { for (let i = 0; i < 300; i += 1) await new Promise(resolve => setImmediate(resolve)); };
// One mock clock for the whole file (enabled once, only moving forward): a second enable/reset cycle left a later setTimeout unticked.
let clockOn = false;
const startTimers = () => { if (!clockOn) { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); clockOn = true; } };
const stopTimers = () => {};
test.after(() => mock.timers.reset());
const tick = async ms => { mock.timers.tick(ms); await settle(); };

function freshSettings() {
    host.extensionSettings.npc_state_delta = undefined;
    flushPendingSettingsSave();
    getSettings();
    host.saves = 0;
}

test('a burst of lazy settings saves is one save, SETTINGS_LAZY_QUIET_MS after the last request', async () => {
    startTimers();
    try {
        freshSettings();
        for (let i = 0; i < 10; i += 1) { persistSettingsLazy(); await tick(1500); }
        assert.equal(host.saves, 0, 'nothing is saved while the burst lasts');
        await tick(SETTINGS_LAZY_QUIET_MS - 1500 - 1);
        assert.equal(host.saves, 0);
        await tick(1);
        assert.equal(host.saves, 1);
        await tick(60_000);
        assert.equal(host.saves, 1, 'no second save');
    } finally { stopTimers(); }
});

test('a burst that never goes quiet is saved at the SETTINGS_LAZY_MAX_MS bound, then a new window starts', async () => {
    startTimers();
    try {
        freshSettings();
        const step = 3000;
        for (let elapsed = 0; elapsed < SETTINGS_LAZY_MAX_MS; elapsed += step) { persistSettingsLazy(); await tick(step); }
        // requests every 3 s for 21 s: the first window closes at the bound (20 s), not 5 s after the last request
        assert.equal(host.saves, 1);
        persistSettingsLazy();
        await tick(SETTINGS_LAZY_QUIET_MS);
        assert.equal(host.saves, 2);
    } finally { stopTimers(); }
});

test('an immediate save covers the pending lazy one and leaves no second save', async () => {
    startTimers();
    try {
        freshSettings();
        persistSettingsLazy();
        persistSettings();
        assert.equal(host.saves, 1);
        await tick(SETTINGS_LAZY_MAX_MS * 2);
        assert.equal(host.saves, 1);
    } finally { stopTimers(); }
});

test('flushPendingSettingsSave saves a pending request now and does nothing when none is pending (page hide, chat change)', async () => {
    startTimers();
    try {
        freshSettings();
        assert.equal(flushPendingSettingsSave(), false);
        assert.equal(host.saves, 0);
        persistSettingsLazy();
        assert.equal(flushPendingSettingsSave(), true);
        assert.equal(host.saves, 1);
        await tick(SETTINGS_LAZY_MAX_MS);
        assert.equal(host.saves, 1);
    } finally { stopTimers(); }
});

// ---- the persistence part ----

let KEY = '';
let keySequence = 0;

function sidecarServer() {
    const files = new Map();
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const filePath = `/user/files/${body.name}`;
            files.set(filePath, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: filePath }) };
        }
        if (url === '/api/files/verify') {
            const urls = JSON.parse(options.body).urls;
            return { ok: true, status: 200, json: async () => Object.fromEntries(urls.map(u => [u, files.has(u)])) };
        }
        if (files.has(url)) return { ok: true, status: 200, headers: { get: () => null }, text: async () => files.get(url) };
        return { ok: false, status: 404, text: async () => '' };
    };
    return { files, fetchFn };
}

function persistRig() {
    // a chat of its own per test: the storage module keeps its writer locks and retry queue per chat key
    KEY = buildQualifiedChatKey('chat', `A${keySequence += 1}.png`, 'Adventure');
    const state = { npcs: [{ name: 'Aria' }] };
    const rt = {
        chatStateCache: new Map([[KEY, state]]),
        missingSidecarChats: new Set(),
        stateWriteTimers: new Map(),
        stateWritePromises: new Map(),
        stateVersions: new Map([[KEY, 0]]),
        persistedVersions: new Map(),
    };
    const part = createPersistPart(rt, {
        assertChatHydratedForWrite: () => {},
        chatHydrationStatus: () => 'ready',
        getChatKey: () => KEY,
        getChatState: key => rt.chatStateCache.get(key),
        holdRetiredLocalWork: () => null,
        isCanonicalChatKey: () => true,
        markStateDirty: key => rt.stateVersions.set(key, Number(rt.stateVersions.get(key) || 0) + 1),
        ownershipEpoch: () => 1,
        ownershipEpochCurrent: () => true,
        reconcileCrossSessionWriteConflict: async () => {},
        requestHeaders: () => ({}),
        requireReadyChatMutation: () => true,
        updateHydratedStateMeta: () => {},
    });
    return { rt, part, state };
}

async function withServer(run) {
    const server = sidecarServer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = server.fetchFn;
    startTimers();
    try { await run(server); } finally { stopTimers(); globalThis.fetch = realFetch; }
}

test('persist() on dossier changes saves no settings; the sidecar upload costs one coalesced settings save', async () => {
    await withServer(async server => {
        freshSettings();
        const { part, rt, state } = persistRig();
        // a catch-up: eight dossier changes, 1.5 s apart, each followed by its own sidecar upload
        for (let i = 0; i < 8; i += 1) {
            state.npcs[0].note = `change ${i}`;
            assert.equal(part.persist(KEY), true);
            await tick(1500);
        }
        assert.equal(server.files.size, 1, 'the dossier went to the sidecar');
        assert.equal(rt.persistedVersions.get(KEY), 8);
        assert.ok(getSettings().dataFiles[KEY]?.path, 'the pointer is set in memory');
        const beforeQuiet = host.saves;
        assert.equal(beforeQuiet, 0, 'no settings save while the burst lasts');
        await tick(SETTINGS_LAZY_QUIET_MS);
        assert.equal(host.saves, 1, 'one settings save for the whole burst');
    });
});

test('persistCritical and persistCriticalDurable still save settings at once', async () => {
    await withServer(async () => {
        freshSettings();
        const { part, state } = persistRig();
        state.npcs[0].note = 'critical';
        assert.equal(part.persistCritical(KEY), true);
        assert.equal(host.saves, 1, 'saved before the sidecar write finishes');
        await part.flushStateFile(KEY);
        host.saves = 0;
        state.npcs[0].note = 'durable';
        const done = part.persistCriticalDurable(KEY);
        assert.equal(host.saves, 1, 'saved before the sidecar write finishes');
        assert.equal(await done, true);
        await tick(SETTINGS_LAZY_MAX_MS);
    });
});

test('upload, then a crash before the debounced settings write: reload finds the newest sidecar and writes on', async () => {
    await withServer(async server => {
        freshSettings();
        const { part, state } = persistRig();
        state.npcs[0].note = 'first';
        part.persist(KEY);
        await tick(200);
        const firstPointer = structuredClone(getSettings().dataFiles[KEY]);
        assert.equal(firstPointer.revision, 1);
        // the first pointer reached settings.json (an earlier settings save); then two more writes whose pointer saves never happen
        const onDisk = { dataFiles: { [KEY]: firstPointer }, sidecarTombstones: {}, recoveryFiles: {} };
        for (const note of ['second', 'third']) { state.npcs[0].note = note; part.persist(KEY); await tick(200); }
        assert.equal(getSettings().dataFiles[KEY].revision, 3);
        assert.equal(host.saves, 0, 'the debounced settings write had not happened yet');
        // crash: the page is gone, settings.json still holds the first pointer
        const stale = structuredClone(onDisk.dataFiles[KEY]);
        const read = await storage.readNpcStateDataFile(stale, { expectedChatKey: KEY });
        assert.equal(read.state.npcs[0].note, 'third', 'the newest file is found through the stale pointer');
        assert.equal(stale.revision, 3, 'hydration adopts the durable revision');
        // and the reloaded page writes on without a conflict
        const next = await storage.writeNpcStateDataFile({ chatKey: KEY, state: { npcs: [{ name: 'Aria', note: 'fourth' }] }, pointer: stale, headers: {} });
        assert.equal(next.revision, 4);
        assert.equal(server.files.size, 1);
    });
});

test('upload, then a crash before any settings write: a chat with no pointer at all is found by its deterministic path', async () => {
    await withServer(async server => {
        freshSettings();
        const { part, state } = persistRig();
        state.npcs[0].note = 'only';
        part.persist(KEY);
        await tick(200);
        
        assert.equal(host.saves, 0);
        // reload: settings.json has no pointer for the chat
        const probe = storage.probeNpcStateDataFilePointer(KEY, undefined);
        const read = await storage.readNpcStateDataFile(probe, { expectedChatKey: KEY });
        assert.equal(read.state.npcs[0].note, 'only');
        assert.equal(server.files.size, 1);
    });
});
