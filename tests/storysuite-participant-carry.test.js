// N1: what the participant keeps in the chat's state (state.timeline: lineage, np_ map, reserved ids, applied deaths) is carried by Delta's own
// lifecycle: a branch inherits it (branch.js), a bundle export carries it (bundle.js) and the sidecar a rename moves is the state itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import { bestAncestorState, chatLineage, recordBranchCheckpoint, setBranchProvenanceHint } from '../branch.js';
import { decodeNpcStateBundle, encodeNpcStateBundle } from '../bundle.js';
import { hydrateIdentity, storedTimeline, timelineOf } from '../src/storysuite-participant/index.js';

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
    const { currentExchangeMessages, recentTranscript, refreshMessageGate, useMessageGate, useTranscriptSource } = await import('../src/transcript.js');
    const chat = [user('I go north.'), assistant('The road bends.'), user('I turn back.'), assistant('The dead timeline\'s reply.')];
    useTranscriptSource({ context: () => ({ chat, name1: 'Kazuma', name2: 'Megumin' }), scanDepth: () => 6 });
    const plain = recentTranscript(4, { messageIds: true });
    assert.match(plain, /\[m3\]/);
    let refreshed = 0;
    let flags = [true, true, true, false];
    useMessageGate({ refresh: async () => { refreshed += 1; }, faded: () => flags.includes(false), active: index => flags[index] !== false });
    await refreshMessageGate();
    assert.equal(refreshed, 1);
    const gated = recentTranscript(4, { messageIds: true });
    assert.doesNotMatch(gated, /dead timeline/);
    assert.match(gated, /\[m2\]/);
    assert.deepEqual(currentExchangeMessages(1).map(message => message.mes), ['I go north.', 'The road bends.']);
    assert.equal(currentExchangeMessages(3)?.at(-1)?.mes === 'The dead timeline\'s reply.', false, 'a faded reply is not the current exchange');
    flags = [true, true, true, true];
    assert.equal(recentTranscript(4, { messageIds: true }), plain, 'nothing faded: the same bytes');
    useMessageGate(null);
    assert.equal(recentTranscript(4, { messageIds: true }), plain);
});

test('N2: every durable write of the chat\'s state ends in the one function that announces it to the participant', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const body = name => index.slice(index.indexOf(`function ${name}(`), index.indexOf('\n}\n', index.indexOf(`function ${name}(`)));
    assert.match(body('markStateDirty'), /announceNativeChange\(key\)/);
    // The three ways to save a chat's state, and the queue every scan, edit, import and reconcile goes through, all pass through it.
    for (const name of ['queueStateFileWrite', 'persistCritical']) assert.match(body(name), /markStateDirty\(key\)/, name);
    assert.match(index.slice(index.indexOf('async function persistCriticalDurable('), index.indexOf('async function persistCriticalDurable(') + 400), /markStateDirty\(key\)/);
    // The server's newer copy adopted as the working state is a change no persist call announces: it announces itself.
    assert.match(index.slice(index.indexOf('function installCanonicalServerState('), index.indexOf('async function reconcileCrossSessionWriteConflict(')), /announceNativeChange\(key\)/);
    // The participant's own writes are not changes.
    assert.match(index, /return quietly\(key, async \(\) => \{\s*setChatState\(key, state, \{ markLoaded: true \}\);/);
    assert.match(index, /const participantWrites = new Map\(\);/, 'the participant\'s own writes are counted per chat');
    assert.match(index, /writeTimeline: async block =>[\s\S]*?return quietly\(key, /);
    // Scan intent: the entry points that start dossier work hold it for their whole run, and the probe counts it with the queued automatic scans.
    for (const name of ['scanNow', 'drainPendingAutoScan', 'processPendingBackfills', 'runTargetedDossierPass', 'handleAssistantMessageReceived']) assert.match(index, new RegExp(`function ${name}\\([^)]*\\) \\{ return withScanIntent\\(`), name);
    assert.match(index, /function scanWorkPending\(key = getChatKey\(\)\) \{\s*return isScanBusy\(key\) \|\| \(scanIntents.get\(key\) \|\| 0\) > 0 \|\| pendingAutoScans.has\(key\);/);
});
