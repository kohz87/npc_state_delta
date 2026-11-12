// N1: what the participant keeps in the chat's state (state.timeline: lineage, np_ map, reserved ids, applied deaths) is carried by Delta's own
// lifecycle: a branch inherits it (branch.js), a bundle export carries it (bundle.js) and the sidecar a rename moves is the state itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import { bestAncestorState, chatLineage, recordBranchCheckpoint, setBranchProvenanceHint } from '../branch.js';
import { decodeNpcStateBundle, encodeNpcStateBundle } from '../bundle.js';
import { hydrateIdentity, storedTimeline, timelineOf } from '../src/storysuite-participant/index.js';
import { runtimeSource } from './helpers/runtime-source.js';

const user = text => ({ mes: text, is_user: true, is_system: false, name: 'Kazuma' });
const assistant = text => ({ mes: text, is_user: false, is_system: false, name: 'Megumin' });

function parentWithTimeline() {
    const state = {
        npcs: [createNpcRecord('Yunyun')], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [], turn: 1,
        assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], lineage: [], inlineCards: [],
    };
    const identity = hydrateIdentity(null, state.npcs, { seed: 'lg_aaaaaaaa' }).identity;
    state.timeline = storedTimeline({ ...timelineOf(null), lineage: 'lg_aaaaaaaa', identity, applied: { ev_one: { nativeKey: state.npcs[0].id, at: 3 } } });
    return state;
}

test('N1: a branch inherits the parent\'s story line: the same lineage, np_ map and applied deaths', () => {
    const parentChat = [user('A'), assistant('B'), user('C'), assistant('D'), user('E')];
    const parent = parentWithTimeline();
    recordBranchCheckpoint(parent, parentChat, 1, 'scan');
    parent.lineage = chatLineage(parentChat);
    const branchChat = [user('A'), assistant('B'), user('C'), assistant('D'), user('Different continuation')];
    setBranchProvenanceHint({ mainChat: 'parent', currentKey: 'chat:card.png:branch' });
    const inherited = bestAncestorState({ 'chat:card.png:parent': parent }, 'chat:card.png:branch', branchChat);
    setBranchProvenanceHint({});
    assert.ok(inherited);
    assert.deepEqual(inherited.timeline, parent.timeline);
    assert.notEqual(inherited.timeline, parent.timeline, 'a copy');
    assert.equal(timelineOf(inherited.timeline ? inherited : null).lineage, 'lg_aaaaaaaa');
    // A parent from before the participant has no block, and the branch has none to carry.
    const old = parentWithTimeline();
    delete old.timeline;
    recordBranchCheckpoint(old, parentChat, 1, 'scan');
    old.lineage = chatLineage(parentChat);
    setBranchProvenanceHint({ mainChat: 'parent', currentKey: 'chat:card.png:branch' });
    const bare = bestAncestorState({ 'chat:card.png:parent': old }, 'chat:card.png:branch', branchChat);
    setBranchProvenanceHint({});
    assert.equal(Object.hasOwn(bare, 'timeline'), false);
});

test('N1: a bundle export carries the block with the dossiers it names, and a bundle without one decodes as it did', () => {
    const state = parentWithTimeline();
    const bytes = encodeNpcStateBundle(state, { appVersion: 'test', chatKey: 'chat:card.png:one' });
    const decoded = decodeNpcStateBundle(bytes);
    assert.deepEqual(decoded.state.timeline, state.timeline);
    const plain = parentWithTimeline();
    delete plain.timeline;
    const decodedPlain = decodeNpcStateBundle(encodeNpcStateBundle(plain, { appVersion: 'test', chatKey: 'chat:card.png:one' }));
    assert.equal(Object.hasOwn(decodedPlain.state, 'timeline'), false);
});

test('N2: after a restore the scanner reads the messages the story stands on: faded replies are skipped, indexes kept; no gate, or nothing faded, reads the chat as it is', async () => {
    const { activeChat, currentExchangeMessages, recentTranscript, refreshMessageGate, storyDayAt, useMessageGate, useTranscriptSource } = await import('../src/transcript.js');
    const chat = [user('I go north.'), assistant('The road bends.'), user('I turn back.'), assistant('The dead timeline\'s reply.')];
    useTranscriptSource({ context: () => ({ chat, name1: 'Kazuma', name2: 'Megumin' }), scanDepth: () => 6 });
    const plain = recentTranscript(4, { messageIds: true });
    assert.match(plain, /\[m3\]/);
    let refreshed = 0;
    let flags = [true, true, true, false];
    useMessageGate({ refresh: async () => { refreshed += 1; return flags; } });
    assert.match(recentTranscript(4, { messageIds: true }), /dead timeline/, 'nothing is known before the gate is asked');
    await refreshMessageGate();
    assert.equal(refreshed, 1);
    const gated = recentTranscript(4, { messageIds: true });
    assert.doesNotMatch(gated, /dead timeline/);
    assert.match(gated, /\[m2\]/);
    assert.deepEqual(currentExchangeMessages(1).map(message => message.mes), ['I go north.', 'The road bends.']);
    assert.equal(currentExchangeMessages(3)?.at(-1)?.mes === 'The dead timeline\'s reply.', false, 'a faded reply is not the current exchange');
    assert.equal(activeChat(chat)[3].is_system, true);
    assert.equal(chat[3].is_system, false, 'the chat itself is not changed');
    flags = [true, true, true, true];
    await refreshMessageGate();
    assert.equal(recentTranscript(4, { messageIds: true }), plain, 'nothing faded: the same bytes');
    assert.equal(activeChat(chat), chat, 'and the same array');
    useMessageGate(null);
    assert.equal(recentTranscript(4, { messageIds: true }), plain);
    void storyDayAt;
});
test('N2: every durable write of the chat\'s state ends in the one function that announces it to the participant', async () => {
    const { readFileSync } = await import('node:fs');
    const index = runtimeSource();
    const body = name => index.slice(index.indexOf(`function ${name}(`), index.indexOf('\n}\n', index.indexOf(`function ${name}(`)));
    assert.match(body('markStateDirty'), /announceNativeChange\(key\)/);
    // The three ways to save a chat's state, and the queue every scan, edit, import and reconcile goes through, all pass through it.
    for (const name of ['queueStateFileWrite', 'persistCritical']) assert.match(body(name), /markStateDirty\(key\)/, name);
    assert.match(index.slice(index.indexOf('async function persistCriticalDurable('), index.indexOf('async function persistCriticalDurable(') + 400), /markStateDirty\(key\)/);
    // The server's newer copy adopted as the working state is a change no persist call announces: it announces itself.
    assert.match(index.slice(index.indexOf('function installCanonicalServerState('), index.indexOf('async function reconcileCrossSessionWriteConflict(')), /announceNativeChange\(key\)/);
    // The participant's own writes are not changes.
    assert.match(index, /return quietly\(key, async \(\) => \{\s*setChatState\(key, state, \{ markLoaded: true \}\);/);
    const runtimeState = readFileSync(new URL('../runtime-state.js', import.meta.url), 'utf8');
    assert.match(runtimeState, /participantWrites: new Map\(\),/, 'the participant\'s own writes are counted per chat');
    assert.match(index, /writeTimeline: async block =>[\s\S]*?return quietly\(key, /);
    // Scan intent: the entry points that start dossier work hold it for their whole run, and the probe counts it with the queued automatic scans.
    for (const name of ['scanNow', 'drainPendingAutoScan', 'processPendingBackfills', 'runTargetedDossierPass', 'handleAssistantMessageReceived']) assert.match(index, new RegExp(`function ${name}\\([^)]*\\) \\{\\s*(?:const key = [^;]*;\\s*)?return withScanIntent\\(`), name);
    assert.match(index, /function scanWorkPending\(key = getChatKey\(\)\) \{\s*return isScanBusy\(key\) \|\| \(scanIntents.get\(key\) \|\| 0\) > 0 \|\| pendingAutoScans.has\(key\) \|\| deferredWorkPending\(key\);/);
});

// (ONEPASSCAP-1) A participant write (installState, writeTimeline, the catch-up's writes) holds back native-change announcements for the whole chat
// while it waits for its durable save. A change Delta saved in that window (a one-pass reply's scan has no model call, so it commits as the host
// records the reply; a backfill can land there too) used to go unannounced: never published, and the host's next activate installed the older
// checkpoint over it. It is now announced once the participant's write ends; the participant's own change (made in the write's first step) never is.
test('ONEPASSCAP-1: a change Delta saves while a participant write is in flight is announced when the write ends; the participant\'s own never is', async t => {
    // The real module in a temp tree beside a stub host (it imports SillyTavern's extensions.js), as settings-debounce.test.js loads it.
    const [fs, os, path, url] = await Promise.all([import('node:fs'), import('node:os'), import('node:path'), import('node:url')]);
    const sourceRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-quietly-'));
    const extRoot = path.join(tempRoot, 'public', 'scripts', 'extensions', 'third-party', 'npc_state_delta');
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const { path: file } of JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime-modules.json'), 'utf8')).modules) {
        fs.mkdirSync(path.dirname(path.join(extRoot, file)), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, file), path.join(extRoot, file));
    }
    fs.cpSync(path.join(sourceRoot, 'src'), path.join(extRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'public', 'scripts', 'extensions.js'), 'export const extension_settings = {};\nexport function getContext() { return { chat: [] }; }\n');
    fs.writeFileSync(path.join(tempRoot, 'public', 'script.js'), 'export function getRequestHeaders() { return {}; }\nexport async function saveSettings() {}\n');
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const { installHydrationState } = await import(url.pathToFileURL(path.join(extRoot, 'runtime-hydration-state.js')).href);
    const rt = {
        chatStateCache: new Map(), hydratedChatKeys: new Set(), hydratedStateMeta: new Map(), workingCopyAdoptions: new Map(), freshnessEvents: [],
        hydrationErrors: new Map(), stateWriteTimers: new Map(), stateWritePromises: new Map(), stateVersions: new Map(), persistedVersions: new Map(),
        nativeChangeListeners: new Set(), participantWrites: new Map(),
    };
    let open = 'chat-a';
    const api = {};
    installHydrationState(api, rt, { getChatKey: () => open, touchChatCache: () => {}, checkPortraitFilesSoon: () => {}, BACKFILL_MAX_ATTEMPTS: 3 });
    let heard = 0;
    rt.nativeChangeListeners.add(() => { heard += 1; });
    const window = () => { let release; const gate = new Promise(resolve => { release = resolve; }); return { gate, release }; };

    // The participant's own write: its change is made in its first step and is not a native change.
    const a = window();
    const write = api.quietly('chat-a', async () => { api.markStateDirty('chat-a'); await a.gate; return true; });
    assert.equal(heard, 0, 'the participant\'s own write is not announced');
    api.markStateDirty('chat-a');   // a one-pass scan commits while the write waits for its save
    api.markStateDirty('chat-a');
    assert.equal(heard, 0, 'held while the participant writes');
    a.release();
    assert.equal(await write, true);
    assert.equal(heard, 1, 'announced once (not once per save) when the participant\'s write ends');

    // Nothing of Delta's own meanwhile: nothing announced.
    await api.quietly('chat-a', async () => { api.markStateDirty('chat-a'); await null; });
    assert.equal(heard, 1);

    // Nested writes: announced only when the last one ends; a write that throws still announces the held change.
    const b = window();
    const outer = api.quietly('chat-a', async () => { await b.gate; });
    const inner = api.quietly('chat-a', async () => { await null; throw new Error('save failed'); });
    api.markStateDirty('chat-a');
    await assert.rejects(inner, /save failed/);
    assert.equal(heard, 1, 'the outer write still runs');
    b.release();
    await outer;
    assert.equal(heard, 2);

    // Another chat opened meanwhile: the held change belongs to a chat no longer open, so it is not announced to the open one.
    const c = window();
    const away = api.quietly('chat-a', async () => { await c.gate; });
    api.markStateDirty('chat-a');
    open = 'chat-b';
    c.release();
    await away;
    assert.equal(heard, 2);
});
