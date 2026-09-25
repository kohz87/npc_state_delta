import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeStateFilePayload,
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
