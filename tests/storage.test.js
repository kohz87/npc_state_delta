import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    decodeStateFilePayload,
    decodeStateFileHead,
    encodeStateFilePayload,
    makeNpcStateDataFileName,
    readNpcStateDataFile,
    writeNpcStateDataFile,
    deleteNpcStateDataFile,
    cancelPendingNpcStateWrite,
    inspectNpcStateDataFile,
    preserveUndurableNpcStateSnapshot,
    undurableNpcStateSnapshot,
} from '../storage.js';
import { createNpcRecord } from '../core.js';

test('extension data filename is deterministic and filesystem-safe', () => {
    const a = makeNpcStateDataFileName('chat:My Adventure/01');
    const b = makeNpcStateDataFileName('chat:My Adventure/01');
    assert.equal(a, b);
    assert.match(a, /^npc-state-delta-[a-z0-9]+\.json$/);
});

test('extension-owned JSON payload round-trips full chat state', () => {
    const npc = createNpcRecord('Yunyun');
    npc.relationship.desire = 27;
    npc.present = true;
    npc.mannerisms = ['boasts when embarrassed'];
    npc.species = 'Crimson Demon';
    const text = encodeStateFilePayload('chat:test', { npcs: [npc], checkpoints: [{ messageId: 9 }] }, '0.1.7');
    assert.equal(text.includes('\n'), false, 'active sidecar payload should use compact JSON encoding');
    const decoded = decodeStateFilePayload(text);
    assert.equal(decoded.chatKey, 'chat:test');
    assert.equal(decoded.state.npcs[0].relationship.desire, 27);
    assert.equal(decoded.state.npcs[0].present, true);
    assert.equal(decoded.state.npcs[0].species, 'Crimson Demon');
    assert.equal(decoded.state.checkpoints[0].messageId, 9);
});

test('v0.2.11 sidecar round-trips exact sibling checkpoints, root anchor, and relationship milestone internals', () => {
    const npc = createNpcRecord('Myla');
    npc.relationship = { trust: 50, affection: 0, desire: 0, tension: 0 };
    npc.relationshipProgress = { trust: 0.4, affection: 0, desire: 0, tension: 0 };
    npc.relationshipMilestones = [{
        axis: 'trust', polarity: 1, threshold: 25,
        reason: 'Myla deliberately entrusted the player with a dangerous confidence.',
        sourceMessageId: 3, turn: 2, inferred: false,
    }];
    npc.relationshipEventHistory = [{
        impact: 'meaningful',
        reason: 'The player kept Myla\'s confidence.',
        evidence: { trust: 'The secret remained protected.', affection: '', desire: '', tension: '' },
        sourceMessageId: 4, turn: 3,
    }];
    const rootNpc = createNpcRecord('Myla');
    const state = {
        npcs: [npc],
        lineage: ['line-a', 'line-b'],
        branchLineageVersion: 2,
        userDismissedGroups: [{ primary: 'old clerk', labels: ['old clerk', 'the clerk'], createdAt: 99 }],
        branchRootSnapshot: { npcs: [rootNpc], candidates: [], pendingBackfills: [], dismissed: [], turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, processedOocMessageId: null },
        checkpoints: [{
            messageId: 1,
            fingerprint: 'finger-b',
            lineageKey: 'branch-b',
            parentLineageKey: 'branch-a',
            reason: 'scan',
            createdAt: 123,
            snapshot: { npcs: [npc], candidates: [], pendingBackfills: [], dismissed: [], turn: 3, assistantSinceScan: 0, lastScanAt: 10, lastScannedMessageId: 1, scanCount: 2, processedOocMessageId: null },
        }],
    };
    const decoded = decodeStateFilePayload(encodeStateFilePayload('chat:branches', state, '0.2.11'));
    assert.equal(decoded.state.branchLineageVersion, 2);
    assert.deepEqual(decoded.state.userDismissedGroups[0].labels, ['old clerk', 'the clerk']);
    assert.equal(decoded.state.checkpoints[0].lineageKey, 'branch-b');
    assert.equal(decoded.state.checkpoints[0].parentLineageKey, 'branch-a');
    assert.equal(decoded.state.checkpoints[0].snapshot.npcs[0].relationshipProgress.trust, 0.4);
    assert.equal(decoded.state.checkpoints[0].snapshot.npcs[0].relationshipMilestones[0].threshold, 25);
    assert.match(decoded.state.checkpoints[0].snapshot.npcs[0].relationshipEventHistory[0].reason, /kept Myla's confidence/i);
    assert.equal(decoded.state.branchRootSnapshot.npcs[0].relationship.trust, 0);
});

test('data-file API writes JSON bytes, reads them back, and deletes the sidecar', async () => {
    const files = new Map();
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const path = `/user/files/${body.name}`;
            files.set(path, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        if (url === '/api/files/delete') {
            const body = JSON.parse(options.body);
            const existed = files.delete(body.path);
            return { ok: existed, status: existed ? 200 : 404, text: async () => '' };
        }
        if (files.has(url)) return { ok: true, status: 200, text: async () => files.get(url) };
        return { ok: false, status: 404, text: async () => '' };
    };

    const npc = createNpcRecord('Wiz');
    const pointer = await writeNpcStateDataFile({ chatKey: 'chat:test', state: { npcs: [npc] }, appVersion: '0.1.8', fetchFn, headers: { 'Content-Type': 'application/json' } });
    assert.match(pointer.path, /npc-state-delta-.*\.json$/);
    const loaded = await readNpcStateDataFile(pointer, { fetchFn });
    assert.equal(loaded.state.npcs[0].name, 'Wiz');
    assert.equal(await deleteNpcStateDataFile(pointer, { fetchFn, headers: { 'Content-Type': 'application/json' } }), true);
    assert.equal(await readNpcStateDataFile(pointer, { fetchFn }), null);
});

test('sidecar read rejects a valid NPC State Delta payload belonging to another chat', async () => {
    const text = encodeStateFilePayload('chat:other', { npcs: [createNpcRecord('Wiz')] }, '0.2.7');
    const fetchFn = async () => ({ ok: true, status: 200, text: async () => text });
    await assert.rejects(
        () => readNpcStateDataFile({ path: '/user/files/npc-state-delta-collision.json' }, { fetchFn, expectedChatKey: 'chat:expected' }),
        /different chat/i,
    );
});


test('v0.2.7 sidecar persists high-resolution portrait binary only once', () => {
    const npc = createNpcRecord('Falia');
    const dataUrl = `data:image/webp;base64,${Buffer.from('high-resolution-portrait-binary').toString('base64')}`;
    npc.portrait = { dataUrl, mime: 'image/webp', width: 1200, height: 1536, updatedAt: 123 };
    const text = encodeStateFilePayload('chat:portrait', { npcs: [npc], portraitAssets: {} }, '0.2.7');
    const occurrences = text.split(dataUrl).length - 1;
    assert.equal(occurrences, 1, 'base64 portrait must not be duplicated in npc and portraitAssets');
    const decoded = decodeStateFilePayload(text);
    assert.equal(decoded.state.npcs[0].portrait, null);
    assert.equal(decoded.state.portraitAssets[npc.id].dataUrl, dataUrl);
    assert.equal(decoded.state.portraitAssets[npc.id].width, 1200);
});


test('v0.2.7 sidecar portrait compaction prefers the live NPC portrait over a stale asset copy', () => {
    const npc = createNpcRecord('Falia');
    const live = `data:image/webp;base64,${Buffer.from('new-live-portrait').toString('base64')}`;
    const stale = `data:image/webp;base64,${Buffer.from('old-stale-portrait').toString('base64')}`;
    npc.portrait = { dataUrl: live, mime: 'image/webp', updatedAt: 200 };
    const decoded = decodeStateFilePayload(encodeStateFilePayload('chat:portrait-race', {
        npcs: [npc],
        portraitAssets: { [npc.id]: { dataUrl: stale, mime: 'image/webp', updatedAt: 100 } },
    }, '0.2.7'));
    assert.equal(decoded.state.npcs[0].portrait, null);
    assert.equal(decoded.state.portraitAssets[npc.id].dataUrl, live);
    assert.equal(decoded.state.portraitAssets[npc.id].updatedAt, 200);
});

test('v0.2.12 sidecar round-trips social graph edges and unresolved family slots', () => {
    const brina = createNpcRecord('Brina');
    const liza = createNpcRecord('Liza', [brina.id]);
    const state = {
        npcs: [brina, liza],
        socialGraph: {
            version: 1,
            edges: [{ aId: brina.id, bId: liza.id, aToB: 'daughter', bToA: 'parent', confidence: 'explicit', reason: 'introduced as daughter' }],
            unresolved: [{ ownerId: brina.id, relation: 'daughter', groupId: 'family_brina', descriptor: 'younger', confidence: 'explicit' }],
        },
    };
    const decoded = decodeStateFilePayload(encodeStateFilePayload('chat:social', state, '0.2.12'));
    assert.equal(decoded.state.socialGraph.edges.length, 1);
    assert.equal(decoded.state.socialGraph.unresolved.length, 1);
    assert.equal(decoded.state.socialGraph.unresolved[0].descriptor, 'younger');
});


test('v1.0.8 permanent write rejection keeps the newest undurable snapshot recoverable after cache eviction', async () => {
    const chatKey = 'chat:permanent-write-shadow';
    const pointer = { name: makeNpcStateDataFileName(chatKey), path: `/user/files/${makeNpcStateDataFileName(chatKey)}`, revision: 0 };
    const state = { turn: 56, npcs: [createNpcRecord('Ryu')], lineage: ['a', 'b', 'c'] };
    const rejectUpload = async (url) => {
        if (url === pointer.path) return { ok: false, status: 404, text: async () => '' };
        if (url === '/api/files/upload') return { ok: false, status: 413, text: async () => 'payload too large' };
        return { ok: false, status: 404, text: async () => '' };
    };

    await assert.rejects(
        () => writeNpcStateDataFile({ chatKey, state, appVersion: '1.0.8', pointer, fetchFn: rejectUpload }),
        error => Number(error?.status) === 413,
    );
    assert.equal(undurableNpcStateSnapshot(chatKey)?.state?.turn, 56);

    let networkReads = 0;
    const recovered = await readNpcStateDataFile(pointer, {
        expectedChatKey: chatKey,
        fetchFn: async () => { networkReads += 1; throw new Error('disk should not win over the undurable shadow'); },
    });
    assert.equal(networkReads, 0);
    assert.equal(recovered.undurable, true);
    assert.equal(recovered.state.turn, 56);
    assert.equal(recovered.state.npcs[0].name, 'Ryu');
    assert.equal(cancelPendingNpcStateWrite(chatKey), true);
    assert.equal(undurableNpcStateSnapshot(chatKey), null);
});


test('server freshness inspection observes a newer revision without granting it to the stale local pointer', async () => {
    const chatKey = 'chat:freshness:inspect';
    const pointer = { path: '/user/files/npc-state-delta-freshness.json', revision: 10, writerId: 'desktop' };
    const text = encodeStateFilePayload(chatKey, { turn: 12, npcs: [createNpcRecord('Remote')] }, '1.0.47', {
        revision: 12,
        writerId: 'mobile',
    });
    const inspected = await inspectNpcStateDataFile(pointer, {
        expectedChatKey: chatKey,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => text }),
    });
    assert.equal(inspected.revision, 12);
    assert.equal(inspected.state, undefined);
    assert.equal(inspected.payload.state.turn, 12);
    assert.equal(pointer.revision, 10, 'inspection must not adopt the remote token before conflict/freshness policy runs');
    assert.equal(pointer.writerId, 'desktop');
});

test('recovery-only conflict snapshot remains recoverable but cannot replace the canonical sidecar on read', async () => {
    const chatKey = 'chat:freshness:recovery';
    const pointer = { path: '/user/files/npc-state-delta-recovery-only.json', revision: 4, writerId: 'desktop' };
    const conflict = Object.assign(new Error('conflict'), { code: 'NPC_STATE_WRITE_CONFLICT', expectedRevision: 4, actualRevision: 5 });
    preserveUndurableNpcStateSnapshot({
        chatKey,
        state: { turn: 4, npcs: [createNpcRecord('Local Draft')] },
        appVersion: '1.0.47',
        pointer,
        error: conflict,
        reason: 'test-conflict',
    });
    const recovery = undurableNpcStateSnapshot(chatKey);
    assert.equal(recovery.recoveryOnly, true);
    assert.equal(recovery.state.npcs[0].name, 'Local Draft');
    assert.equal(recovery.actualRevision, 5);

    const durable = encodeStateFilePayload(chatKey, { turn: 5, npcs: [createNpcRecord('Server Winner')] }, '1.0.47', {
        revision: 5,
        writerId: 'mobile',
    });
    const loaded = await readNpcStateDataFile(pointer, {
        expectedChatKey: chatKey,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => durable }),
    });
    assert.equal(loaded.undurable, undefined);
    assert.equal(loaded.state.npcs[0].name, 'Server Winner');
    assert.equal(pointer.revision, 5);
    assert.equal(undurableNpcStateSnapshot(chatKey).state.npcs[0].name, 'Local Draft', 'local conflict draft remains available for explicit recovery');
    cancelPendingNpcStateWrite(chatKey);
});


test('guarded write rejects a same-revision sidecar owned by a different writer', async () => {
    const chatKey = 'chat:writer-token-conflict';
    const pointer = {
        name: makeNpcStateDataFileName(chatKey),
        path: `/user/files/${makeNpcStateDataFileName(chatKey)}`,
        revision: 9,
        writerId: 'writer-a',
    };
    const remote = encodeStateFilePayload(chatKey, { turn: 9, npcs: [createNpcRecord('Remote')] }, '1.0.47', {
        revision: 9,
        writerId: 'writer-b',
    });
    let uploads = 0;
    const fetchFn = async (url, options = {}) => {
        if (url === pointer.path) return { ok: true, status: 200, text: async () => remote };
        if (url === '/api/files/upload') {
            uploads += 1;
            return { ok: true, status: 200, json: async () => ({ path: pointer.path }), text: async () => '' };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        writeNpcStateDataFile({
            chatKey,
            state: { turn: 10, npcs: [createNpcRecord('Local')] },
            appVersion: '1.0.47',
            pointer,
            fetchFn,
            headers: { 'Content-Type': 'application/json' },
        }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT'
            && error.expectedRevision === 9
            && error.actualRevision === 9
            && error.expectedWriterId === 'writer-a'
            && error.actualWriterId === 'writer-b',
    );
    assert.equal(uploads, 0, 'same-revision writer mismatch must fail before upload');
});

test('guarded write verifies writer ownership after upload', async () => {
    const chatKey = 'chat:post-write-owner';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    let server = encodeStateFilePayload(chatKey, { turn: 2, npcs: [] }, '1.0.47', {
        revision: 2,
        writerId: 'base-writer',
    });
    let reads = 0;
    const fetchFn = async (url, options = {}) => {
        if (url === path) {
            reads += 1;
            return { ok: true, status: 200, text: async () => server };
        }
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const uploaded = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8'));
            uploaded.writerId = 'competing-writer';
            server = JSON.stringify(uploaded);
            return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        writeNpcStateDataFile({
            chatKey,
            state: { turn: 3, npcs: [createNpcRecord('Local')] },
            appVersion: '1.0.47',
            pointer: { name, path, revision: 2, writerId: 'base-writer' },
            fetchFn,
            headers: { 'Content-Type': 'application/json' },
            continuousRetry: false,
        }),
        error => error?.code === 'NPC_STATE_WRITE_CONFLICT'
            && error.expectedRevision === 3
            && error.actualRevision === 3
            && error.actualWriterId === 'competing-writer',
    );
    assert.ok(reads >= 2, 'write path must verify the durable owner after upload');
});

// ---- inspection hot path: a boundary check reads the file's head, not its megabytes of checkpoints ----
test('head decode gives the same meta as the full decode, and refuses what is not the compact layout', () => {
    const state = { npcs: [], checkpoints: Array.from({ length: 50 }, (_, i) => ({ messageId: i, pad: 'x'.repeat(200) })) };
    const text = encodeStateFilePayload('chat:head,"state":{x', state, '1.0.0', { revision: 7, writerId: 'w1', updatedAt: '2026-11-12T00:00:00.000Z' });
    const full = decodeStateFilePayload(text);
    const head = decodeStateFileHead(text);
    for (const key of ['chatKey', 'revision', 'writerId', 'updatedAt', 'retired']) assert.equal(head[key], full[key], key);
    assert.equal(head.state, undefined, 'the state is not read');
    assert.equal(decodeStateFileHead(JSON.stringify(JSON.parse(text), null, 2)), null, 'pretty layout: decode in full');
    assert.equal(decodeStateFileHead(text.slice(0, -5)), null, 'cut-off file: decode in full');
    assert.equal(decodeStateFileHead('{"format":"other","state":{}}'), null);
    assert.equal(decodeStateFileHead('not json'), null);
});

test('inspecting a changed sidecar parses only the head; the whole file is parsed once, when payload is read', async () => {
    const state = { npcs: [], checkpoints: Array.from({ length: 100 }, (_, i) => ({ messageId: i, pad: 'y'.repeat(300) })) };
    const text = encodeStateFilePayload('chat:hot', state, '1.0.0', { revision: 3, writerId: 'w2', updatedAt: '2026-11-12T00:00:00.000Z' });
    assert.ok(text.length > 20000);
    const fetchFn = async () => ({ ok: true, status: 200, headers: { get: name => (name === 'etag' ? '"e1"' : '') }, text: async () => text });
    const realParse = JSON.parse; let big = 0;
    JSON.parse = (value, ...rest) => { if (typeof value === 'string' && value.length > 20000) big += 1; return realParse(value, ...rest); };
    try {
        const inspected = await inspectNpcStateDataFile({ path: '/user/files/hot.json' }, { fetchFn, expectedChatKey: 'chat:hot' });
        assert.equal(inspected.revision, 3);
        assert.equal(inspected.writerId, 'w2');
        assert.equal(big, 0, 'no whole-file parse for the boundary check');
        assert.equal(inspected.payload.state.checkpoints.length, 100);
        assert.equal(big, 1);
        void inspected.payload;
        assert.equal(big, 1, 'once per result');
    } finally { JSON.parse = realParse; }
});

test('head decode: a retired flag written after the state is not missed (the whole file is decoded)', () => {
    const payload = JSON.parse(encodeStateFilePayload('chat:r', { npcs: [] }, '1.0.0', { revision: 2, writerId: 'w' }));
    payload.retired = true;
    payload.state = {};
    const text = JSON.stringify(payload);
    assert.equal(decodeStateFileHead(text), null);
    assert.equal(decodeStateFilePayload(text).retired, true);
});

// ---- sidecar format 2 (packed checkpoints), wired at the file boundary ----
import { reconcileBranchState, recordBranchCheckpoint, ensureBranchParentAnchor, fingerprintMessage, BRANCH_LINEAGE_VERSION } from '../branch.js';
import { NPC_STATE_FILE_FORMAT, NPC_STATE_FILE_FORMAT_VERSION, prunePortraitAssetsForState, pruneFormPortraitAssetsForState } from '../storage.js';
import { isPortraitFileRecord } from '../src/portrait-file.js';

// Frozen copies of the format-1 behaviour (storage-payload.js at e2d027d): the compact + encode an older build runs on save.
function legacyCompactState(state) {
    const snapshot = structuredClone(state || {});
    snapshot.portraitAssets = prunePortraitAssetsForState(snapshot);
    snapshot.formPortraitAssets = pruneFormPortraitAssetsForState(snapshot);
    for (const npc of Array.isArray(snapshot.npcs) ? snapshot.npcs : []) {
        if (!npc?.id) continue;
        if (npc.portrait?.dataUrl) snapshot.portraitAssets[npc.id] = structuredClone(npc.portrait);
        if (snapshot.portraitAssets[npc.id]?.dataUrl && !(isPortraitFileRecord(npc.portrait) && !npc.portrait.dataUrl)) npc.portrait = null;
    }
    return snapshot;
}
const legacyEncodeV1 = (chatKey, state, revision = 1) => JSON.stringify({ format: NPC_STATE_FILE_FORMAT, formatVersion: 1, appVersion: 't', chatKey, updatedAt: 'u', revision, writerId: 'w', state: legacyCompactState(state) });
function legacyDecode(text) {
    const payload = JSON.parse(text);
    if (!payload || payload.format !== 'npc_state_delta_chat_data') throw new Error('Not an NPC State Delta chat data file.');
    if (payload.formatVersion !== 1) throw new Error(`Unsupported NPC State Delta data file version: ${payload.formatVersion}.`);
    return payload;
}
const viaV1 = (state) => decodeStateFilePayload(legacyEncodeV1('chat:v2', state)).state;
const viaV2 = (state) => decodeStateFilePayload(encodeStateFilePayload('chat:v2', state, 't')).state;
function firstDifference(a, b, path = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDifference(a[key], b[key], `${path}/${key}`); if (d) return d; }
    }
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`;
}
// Reconcile stamps Date.now(); both routes must see the same clock for their results to be comparable.
function atClock(fn) { const real = Date.now; Date.now = () => 1_800_000_000_000; try { return fn(); } finally { Date.now = real; } }
const same = (a, b, note) => assert.equal(firstDifference(a, b), null, note);

const msgU = text => ({ is_user: true, is_system: false, name: 'Kazuma', mes: text });
const msgA = (text, swipe = 0) => ({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: swipe });

// A chat of `replies` exchanges built through the production checkpoint writers: two checkpoints per reply (the
// assistant-parent anchor and the scan), `npcCount` dossiers of about `noteChars` characters each that grow a little per reply.
function buildChat(replies, { npcCount = 6, noteChars = 600, limit } = {}) {
    const chat = [];
    const state = { npcs: [], dismissed: [], inlineCards: [], checkpoints: [], lineage: [], portraitAssets: {}, formPortraitAssets: {}, branchLineageVersion: BRANCH_LINEAGE_VERSION, turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0 };
    for (let i = 0; i < npcCount; i += 1) {
        const npc = createNpcRecord(`Npc${i}`, state.npcs.map(n => n.id));
        npc.mannerisms = [`${'seed '.repeat(Math.ceil(noteChars / 5))}`.slice(0, noteChars)];
        state.npcs.push(npc);
    }
    for (let r = 0; r < replies; r += 1) {
        chat.push(msgU(`user turn ${r}`));
        ensureBranchParentAnchor(state, chat.concat(msgA(`reply ${r}`)), chat.length, 'assistant-parent', limit);
        chat.push(msgA(`reply ${r}`));
        state.turn += 1;
        const npc = state.npcs[r % npcCount];
        npc.relationship.trust = (npc.relationship.trust + 1) % 100;
        npc.mannerisms.push(`beat ${r} of ${npc.name}`);
        state.lastScannedMessageId = chat.length - 1;
        recordBranchCheckpoint(state, chat, chat.length - 1, 'scan', limit);
    }
    return { state, chat };
}

test('v2: encode writes formatVersion 2 with the packing header before state; checkpoints round-trip stringify-identical', () => {
    const { state } = buildChat(30);
    const text = encodeStateFilePayload('chat:v2', state, 't');
    const raw = JSON.parse(text);
    assert.equal(raw.formatVersion, 2);
    assert.equal(NPC_STATE_FILE_FORMAT_VERSION, 2);
    assert.ok(text.indexOf('"packing"') < text.indexOf(',"state":{'));
    assert.ok(raw.state.checkpoints.some(entry => entry.packed), 'a 30-reply chat has packed entries');
    const decoded = decodeStateFilePayload(text);
    assert.equal('packing' in decoded, false);
    same(decoded.state, viaV1(state), 'v2 load == v1 load');
    same(decoded.state, state);
    assert.equal(decodeStateFileHead(text).formatVersion, 2);
    assert.equal(decodeStateFileHead(text).revision, 0);
});

// The corpus is 9 synthetic states built here (not the states every other test file builds; those now all round-trip through v2
// inside the full suite). Portrait and journal states are compared v2-load against v1-load, because both compact the portrait.
function portraitState() {
    const { state } = buildChat(12);
    state.npcs[0].portrait = { dataUrl: 'data:image/png;base64,AAAA', seed: 7 };
    state.formPortraitAssets = { [state.npcs[1].id]: { alt: { dataUrl: 'data:image/png;base64,BBBB' } } };
    state.checkpoints.forEach(entry => { if (entry.snapshot.npcs?.[0]) entry.snapshot.npcs[0].portrait = null; });
    return state;
}
test('v2 migration: every state shape is read from v1, saved as v2, and read back equal (v1 -> v2 -> back)', () => {
    const journalState = buildChat(20).state;
    assert.ok(Array.isArray(journalState.rollbackJournal) ? journalState.rollbackJournal.length > 0 : Object.keys(journalState.rollbackJournal || {}).length > 0, 'the built state carries a rollback journal');
    const states = [
        buildChat(0).state, buildChat(1).state, buildChat(7).state, buildChat(26).state, buildChat(60, { limit: 20 }).state,
        journalState, portraitState(),
        { npcs: [createNpcRecord('Wiz')], portraitAssets: {}, formPortraitAssets: {} },
        { npcs: [], portraitAssets: {}, formPortraitAssets: {}, checkpoints: [{ messageId: 9 }, { messageId: 10, pad: 'x' }, { messageId: 11, base: 0, patch: [] }] },
    ];
    for (const state of states) {
        const v1Text = legacyEncodeV1('chat:v2', state);
        const loaded = decodeStateFilePayload(v1Text);
        assert.equal(loaded.formatVersion, 1);
        const v2Text = encodeStateFilePayload('chat:v2', loaded.state, 't');
        const again = decodeStateFilePayload(v2Text);
        assert.equal(JSON.parse(v2Text).formatVersion, 2);
        same(again.state, loaded.state);   // v1 -> v2 -> back equals what the v1 file held
        same(decodeStateFilePayload(encodeStateFilePayload('chat:v2', state, 't')).state, loaded.state);   // saving the live state as v2 loads as the v1 save would
        same(JSON.parse(v2Text).state.checkpoints?.length, loaded.state.checkpoints?.length);
    }
    assert.equal(decodeStateFilePayload(encodeStateFilePayload('chat:v2', portraitState(), 't')).state.portraitAssets[portraitState().npcs[0].id].dataUrl, 'data:image/png;base64,AAAA');
});

test('v2 migration: a checkpoint that already carries a reserved key falls back to a whole v1 file; it still loads', () => {
    const { state } = buildChat(8);
    state.checkpoints[3].packed = { owner: 'hand-edit' };
    const text = encodeStateFilePayload('chat:v2', state, 't');
    assert.equal(JSON.parse(text).formatVersion, 1);
    same(decodeStateFilePayload(text).state, state);
});

test('v2: a v1 file is read without any write; reading never converts it', async () => {
    const { state } = buildChat(6);
    const text = legacyEncodeV1('chat:v2', state);
    let uploads = 0;
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') { uploads += 1; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; }
        return { ok: true, status: 200, text: async () => text };
    };
    const loaded = await readNpcStateDataFile({ path: '/user/files/x.json', revision: 1 }, { fetchFn });
    same(loaded.state, state);
    assert.equal(uploads, 0);
});

test('v2 rollback: rolling back to every reply gives byte-identical results from the v1 and the v2 file', () => {
    const { state, chat } = buildChat(60);
    const a = viaV1(state);
    const b = viaV2(state);
    for (let k = 1; k <= 60; k += 1) {
        const cut = chat.slice(0, k * 2);
        const ra = atClock(() => reconcileBranchState(structuredClone(a), cut, { explicitDivergence: cut.length }));
        const rb = atClock(() => reconcileBranchState(structuredClone(b), cut, { explicitDivergence: cut.length }));
        same(rb, ra, `reply ${k}`);
        const da = atClock(() => reconcileBranchState(structuredClone(a), cut, { explicitDivergence: cut.length - 1, operation: 'delete', rewindMidDelete: true }));
        const db = atClock(() => reconcileBranchState(structuredClone(b), cut, { explicitDivergence: cut.length - 1, operation: 'delete', rewindMidDelete: true }));
        same(db, da, `delete to ${k}`);
    }
});

test('v2 reconcile: swipe, regenerate, edit and mid-chat delete give the same result on the v1 and v2 files', () => {
    const { state, chat } = buildChat(30);
    const a = viaV1(state);
    const b = viaV2(state);
    const swipe = chat.slice(0, 41).concat(msgA('reply 20 swiped', 1)).concat(chat.slice(42));
    const edited = chat.map((m, i) => (i === 30 ? { ...m, mes: `${m.mes} (edited)` } : m));
    const cases = [
        [swipe, { explicitDivergence: 41, operation: 'swipe' }],
        [chat.slice(0, 41), { explicitDivergence: 41, operation: 'regenerate' }],
        [edited, { explicitDivergence: 30, operation: 'edit' }],
        [chat.filter((_, i) => i !== 20), { explicitDivergence: 20, operation: 'delete', rewindMidDelete: true }],
        [chat.filter((_, i) => i !== 20), { explicitDivergence: 20, operation: 'delete' }],
    ];
    for (const [live, options] of cases) {
        const ra = atClock(() => reconcileBranchState(structuredClone(a), live, options));
        const rb = atClock(() => reconcileBranchState(structuredClone(b), live, options));
        same(rb, ra, options.operation);
        // and back again: the re-saved result of one case reads back equal
        same(viaV2(rb.state), viaV1(ra.state));
    }
});

test('v2 crash mid-save: a failed or cut-off upload leaves the previous bytes; a truncated v2 file is refused, never half-read', async () => {
    const chatKey = 'chat:v2:crash';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    const { state } = buildChat(20);
    let server = encodeStateFilePayload(chatKey, state, 't', { revision: 1, writerId: 'w0' });
    const before = server;
    const failing = async (url) => (url === path ? { ok: true, status: 200, text: async () => server } : { ok: false, status: 413, text: async () => 'too large' });
    await assert.rejects(writeNpcStateDataFile({ chatKey, state, appVersion: 't', pointer: { name, path, revision: 1, writerId: 'w0' }, fetchFn: failing, continuousRetry: false }), error => error.status === 413);
    assert.equal(server, before);
    cancelPendingNpcStateWrite(chatKey);
    for (let i = 1; i < 16; i += 1) {
        const cut = before.slice(0, Math.floor(before.length * i / 16));
        assert.throws(() => decodeStateFilePayload(cut), /invalid JSON/, `cut at ${i}/16`);
    }
    assert.equal(decodeStateFileHead(before.slice(0, Math.floor(before.length / 2))), null, 'a cut-off file is decoded in full (and refused there)');
});

test('v2 refusal: tampered packed entries and a missing packing header are refused with no partial state', () => {
    const { state } = buildChat(30);
    const good = JSON.parse(encodeStateFilePayload('chat:v2', state, 't'));
    const at = good.state.checkpoints.findIndex(entry => entry.packed);
    const mutate = fn => { const copy = structuredClone(good); fn(copy); return JSON.stringify(copy); };
    const bad = [
        mutate(p => { delete p.packing; }),
        mutate(p => { p.state.checkpoints[at].packed.base = at; }),
        mutate(p => { p.state.checkpoints[at].packed.base = -1; }),
        mutate(p => { p.state.checkpoints[at].packed.base = 0.5; }),
        mutate(p => { p.state.checkpoints[at].packed.patch[0].op = 'move'; }),
        mutate(p => { p.state.checkpoints[at].packed.patch[0].path = '/nope/nope'; }),
        mutate(p => { p.state.checkpoints[at].snapshot = {}; }),
    ];
    for (const text of bad) assert.throws(() => decodeStateFilePayload(text), /could not be rebuilt|packing header/);
});

test('v2 older build: a v1 decoder refuses a v2 file and the file bytes are untouched; the newest build refuses format 3 without retrying', async () => {
    const { state } = buildChat(12);
    const v2 = encodeStateFilePayload('chat:v2', state, 't');
    assert.throws(() => legacyDecode(v2), /Unsupported NPC State Delta data file version: 2/);
    // frozen old-build write path: the unsupported-version error carries no code, so an old build retries it (measured in review);
    // the file stays unchanged either way. The new build marks the error, so a future format 3 is not retried.
    const chatKey = 'chat:v2:future';
    const name = makeNpcStateDataFileName(chatKey);
    const path = `/user/files/${name}`;
    const server = JSON.stringify({ ...JSON.parse(v2), formatVersion: 3 });
    let gets = 0; let uploads = 0; let sleeps = 0;
    const fetchFn = async (url) => {
        if (url === path) { gets += 1; return { ok: true, status: 200, text: async () => server }; }
        if (url === '/api/files/upload') uploads += 1;
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        writeNpcStateDataFile({ chatKey, state, appVersion: 't', pointer: { name, path, revision: 1 }, fetchFn, sleepFn: (fn) => { sleeps += 1; fn(); } }),
        error => error.code === 'NPC_STATE_UNSUPPORTED_FORMAT' && /newer NPC State Delta; update the extension/.test(error.message),
    );
    assert.equal(uploads, 0);
    assert.equal(sleeps, 0, 'no retry');
    assert.ok(gets >= 1);
    assert.equal(undurableNpcStateSnapshot(chatKey)?.state?.turn, state.turn, 'the unsaved copy is kept in memory');
    assert.equal(cancelPendingNpcStateWrite(chatKey), true);
});

// T9b: the real pre-format-2 build (origin/main at the time of format 2) meets a v2 file on its write path. Its decoder refuses
// (no error code, so it retries a bounded number of times); it must never upload, and the server bytes stay unchanged.
// Skipped when git or the base ref is not available (a source tarball). Uses the real old storage.js, not a copy kept here.
test('v2 older build (T9b): the real previous build, writing over a v2 file, uploads nothing and leaves the bytes unchanged', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'nsd-old-build-'));
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const packed = spawnSync('sh', ['-c', 'git archive "$0" | tar -x -C "$1"', 'origin/main', dir], { cwd: join(here, '..') });
        if (packed.status !== 0 || !existsSync(join(dir, 'storage.js'))) { t.skip('no git history for origin/main'); return; }
        const old = await import(pathToFileURL(join(dir, 'storage.js')).href);
        if (old.NPC_STATE_FILE_FORMAT_VERSION !== 1) { t.skip('origin/main already writes format 2'); return; }
        const { state } = buildChat(30);
        const chatKey = 'chat:old-tab';
        const v2 = encodeStateFilePayload(chatKey, state, 'new', { revision: 5, writerId: 'newtab' });
        assert.equal(JSON.parse(v2).formatVersion, 2);
        assert.throws(() => old.decodeStateFilePayload(v2), /Unsupported NPC State Delta data file version: 2/);
        const name = old.makeNpcStateDataFileName(chatKey);
        const path = `/user/files/${name}`;
        let gets = 0; let uploads = 0;
        const fetchFn = async (url) => {
            if (String(url).startsWith(path)) { gets += 1; return { ok: true, status: 200, headers: { get: () => null }, text: async () => v2 }; }
            if (url === '/api/files/upload') { uploads += 1; return { ok: true, status: 200, json: async () => ({ path }), text: async () => '' }; }
            return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
        };
        await assert.rejects(old.writeNpcStateDataFile({ chatKey, state: { turn: 1, npcs: [] }, appVersion: 'old', pointer: { name, path, revision: 4, writerId: 'oldtab' }, fetchFn, sleepFn: (fn) => fn(), continuousRetry: false }), /Unsupported/);
        assert.equal(uploads, 0, 'the old build uploads nothing over a v2 file');
        assert.ok(gets >= 1);
        old.cancelPendingNpcStateWrite?.(chatKey);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v2 size and cost: 28 / 100 / 500 replies, measured against the v1 text of the same state (numbers are printed)', () => {
    const rows = [];
    for (const replies of [28, 100, 500]) {
        const { state } = buildChat(replies, { npcCount: 24, noteChars: 5000 });
        const v1 = legacyEncodeV1('chat:v2', state);
        // Interleaved rounds so a busy machine slows both sides alike; the best round of each is kept.
        let v2 = '';
        let back;
        let encodeMs = Infinity; let decodeMs = Infinity; let v1EncodeMs = Infinity;
        const timed = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
        encodeStateFilePayload('chat:v2', state, 't');   // warm up the JIT
        for (let round = 0; round < 9; round += 1) {
            v1EncodeMs = Math.min(v1EncodeMs, timed(() => JSON.stringify(structuredClone(state))));   // today's encode: one clone + one stringify
            encodeMs = Math.min(encodeMs, timed(() => { v2 = encodeStateFilePayload('chat:v2', state, 't'); }));
            decodeMs = Math.min(decodeMs, timed(() => { back = decodeStateFilePayload(v2); }));
        }
        same(back.state, state);
        rows.push({ replies, checkpoints: state.checkpoints.length, snapshotKB: Math.round(JSON.stringify(state.checkpoints[0].snapshot).length / 1024), v1KB: Math.round(v1.length / 1024), v2KB: Math.round(v2.length / 1024), ratio: +(v2.length / v1.length).toFixed(3), encodeMs, decodeMs, v1EncodeMs, encodeRatio: +(encodeMs / v1EncodeMs).toFixed(2) });
        assert.ok(v2.length < v1.length * 0.5, `${replies} replies: ${v2.length} vs ${v1.length}`);
        // Review bound: 2.0x of today's encode. Measured 1.6-2.0x on a quiet machine (printed below); the assertion is a 3x guard so a busy machine does not fail the suite.
        assert.ok(encodeMs <= 3 * v1EncodeMs, `v2 encode ${encodeMs} ms vs today's ${v1EncodeMs} ms (guard 3x)`);
    }
    console.log('V2-SIZE', JSON.stringify(rows));
});

// Seeded fuzz at the file boundary: random replies, swipes, regenerates, edits, middle/tail deletes and rewinds. After every step the
// state is saved and loaded once as v1 and once as v2; the reconcile of both must match exactly and the v2 file must read back equal.
// FUZZ_SEEDS="1-200" (or "5,17") picks the seeds (default 5, 17, 41); FUZZ_STEPS the steps (default 18).
const fuzzSeeds = (spec, fallback) => (spec ? spec.split(',').flatMap(part => { const [a, b] = part.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; }) : fallback);
function seededRandom(seed) {
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), chance: p => next() < p };
}
for (const seed of fuzzSeeds(process.env.FUZZ_SEEDS, [5, 17, 41])) {
    test(`v2 file fuzz seed ${seed}: delete/swipe/edit/rewind replay is identical through the v1 and the v2 file`, () => {
        const r = seededRandom(seed);
        let { state, chat } = buildChat(r.int(2, 34), { npcCount: 3, noteChars: 200 });
        for (let step = 0; step < (Number(process.env.FUZZ_STEPS) || 18); step += 1) {
            const a = viaV1(state);
            const b = viaV2(state);
            same(b, a, `seed ${seed} step ${step}: load`);
            const kind = r.int(0, 7);
            let live = chat;
            let options = {};
            if (kind <= 1 || chat.length < 4) {
                live = chat.concat(msgU(`u${step}`), msgA(`a${step}`));
                options = {};
            } else if (kind === 2) {
                const at = r.int(1, Math.floor(chat.length / 2)) * 2 - 1;
                live = chat.map((m, i) => (i === at ? msgA(`swiped ${step}`, r.int(1, 3)) : m));
                options = { explicitDivergence: at, operation: 'swipe' };
            } else if (kind === 3) {
                const at = r.int(0, chat.length - 1);
                live = chat.map((m, i) => (i === at ? { ...m, mes: `${m.mes} edit${step}` } : m));
                options = { explicitDivergence: at, operation: 'edit' };
            } else if (kind === 4) {
                const at = r.int(0, chat.length - 1);
                live = chat.filter((_, i) => i !== at);
                options = { explicitDivergence: at, operation: 'delete', rewindMidDelete: r.chance(0.5) };
            } else {
                const keep = r.int(1, chat.length - 1);
                live = chat.slice(0, keep);
                options = { explicitDivergence: keep, operation: kind === 5 ? 'delete' : 'regenerate', rewindMidDelete: kind === 5 };
            }
            const ra = atClock(() => reconcileBranchState(structuredClone(a), live, options));
            const rb = atClock(() => reconcileBranchState(structuredClone(b), live, options));
            same(rb, ra, `seed ${seed} step ${step}: reconcile ${options.operation || 'extend'}`);
            state = rb.state;
            chat = live;
            if (chat.length >= 2 && chat.at(-1).is_user === false) {
                state.turn += 1;
                state.npcs[step % state.npcs.length].relationship.trust = (state.npcs[step % state.npcs.length].relationship.trust + 3) % 100;
                recordBranchCheckpoint(state, chat, chat.length - 1, 'scan');
            }
        }
        same(viaV2(state), viaV1(state), `seed ${seed}: final`);
    });
}
