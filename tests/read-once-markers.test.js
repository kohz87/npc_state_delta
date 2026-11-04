import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_AHEAD_MAX, readAheadOf, replyScanned, settleScan } from '../scan-context.js';
import { activeReplyIds, recentReplyIds, skippedExchangesWindow, useTranscriptSource } from '../src/transcript.js';
import { restoreSnapshotIntoState, snapshotBranchState } from '../branch-core.js';
import { mergeImportedDossierState } from '../bundle.js';

// The chat: reply k is message 2k (message 0 is the opening); user messages sit between.
const chatOf = replies => {
    const chat = [{ is_user: false, name: 'Nar', mes: 'R0 opening.' }];
    for (let k = 1; k <= replies; k += 1) { chat.push({ is_user: true, name: 'User', mes: `U${k}` }); chat.push({ is_user: false, name: 'Nar', mes: `R${k} She sighs.` }); }
    return chat;
};
const useChat = chat => useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => 6 });
const ids = [0, 2, 4, 6, 8, 10, 12];   // the replies of a 6-reply chat

test('settleScan: nothing waiting moves the marker to the target as before, and takes in replies read ahead that follow it', () => {
    assert.deepEqual(settleScan({ marker: 4, readIds: [10], target: 10, replyIds: ids }), { marker: 4, readAhead: [10], deferred: true, waiting: 3 });
    assert.deepEqual(settleScan({ marker: 4, readIds: [6, 8, 10], target: 10, replyIds: ids }), { marker: 10, readAhead: [], deferred: false, waiting: 0 });
    // The marker meets a reply read ahead: it passes it.
    assert.deepEqual(settleScan({ marker: 4, readAhead: [8, 12], readIds: [6], target: 6, replyIds: ids }), { marker: 8, readAhead: [12], deferred: false, waiting: 0 });
    // A new chat reads from the start (marker -1); with nothing to track against (not a new chat) the marker simply moves.
    assert.deepEqual(settleScan({ marker: null, readIds: [12], target: 12, replyIds: ids, fresh: false }), { marker: 12, readAhead: [], deferred: false, waiting: 0 });
    assert.deepEqual(settleScan({ marker: null, readIds: [12], target: 12, replyIds: ids, fresh: true }), { marker: -1, readAhead: [12], deferred: true, waiting: 6 });
    assert.deepEqual(settleScan({ marker: null, readIds: ids, target: 12, replyIds: ids, fresh: true }), { marker: 12, readAhead: [], deferred: false, waiting: 0 });
});

test('settleScan: a catch-up window moves the marker to what it read and does not count as deferred', () => {
    assert.deepEqual(settleScan({ marker: 2, readIds: [4, 6], target: 6, replyIds: ids }), { marker: 6, readAhead: [], deferred: false, waiting: 0 });
});

test('settleScan: more than READ_AHEAD_MAX read ahead passes the oldest unread replies instead of forgetting a read one', () => {
    const many = Array.from({ length: 80 }, (_, k) => 2 * (k + 1));
    const out = settleScan({ marker: 0, readIds: many.slice(1), target: many.at(-1), replyIds: [0, ...many] });
    assert.equal(out.readAhead.length <= READ_AHEAD_MAX, true);
    assert.ok(out.marker >= 2, 'the marker passed the oldest unread reply');
    assert.ok(out.readAhead.every(id => id > out.marker));
    assert.equal(new Set(out.readAhead).size, out.readAhead.length);
});

test('readAheadOf and replyScanned: cleaned lists; a reply is scanned when the marker is at it or it was read ahead', () => {
    assert.deepEqual(readAheadOf({ readAhead: [8, 'x', 4, 4, -1, 2.5, null] }), [4, 8]);
    assert.deepEqual(readAheadOf({}), []);
    assert.deepEqual(readAheadOf(null), []);
    assert.equal(replyScanned({ lastScannedMessageId: 6, readAhead: [10] }, 6), true);
    assert.equal(replyScanned({ lastScannedMessageId: 6, readAhead: [10] }, 10), true);
    assert.equal(replyScanned({ lastScannedMessageId: 6, readAhead: [10] }, 8), false);
    assert.equal(replyScanned({ lastScannedMessageId: 6 }, null), false);
});

test('the window skips replies read ahead (and the user message each answers), always reads the current reply, and lists what it read', () => {
    useChat(chatOf(6));
    const open = skippedExchangesWindow(12, { afterId: 2, replies: 5, limit: 6 });
    assert.deepEqual(open.readIds, [4, 6, 8, 10, 12]);
    const skipped = skippedExchangesWindow(12, { afterId: 2, replies: 5, limit: 6, skip: [6, 12] });
    assert.deepEqual(skipped.readIds, [4, 8, 10, 12], 'the current reply is read even if listed');
    assert.ok(!/R3 /.test(skipped.transcript) && !/U3/.test(skipped.transcript), 'reply 3 and its user message are not read again');
    assert.ok(/U2/.test(skipped.transcript) && /R2 /.test(skipped.transcript) && /R6 /.test(skipped.transcript));
    // Fewer than two replies left once the read ones are taken out: the current exchange alone, as before.
    assert.equal(skippedExchangesWindow(12, { afterId: 8, replies: 2, limit: 6, skip: [10] }), null);
});

test('the replies a recent window holds, and every active reply', () => {
    const chat = chatOf(6);
    useChat(chat);
    assert.deepEqual(recentReplyIds(4), [10, 12]);
    assert.deepEqual(recentReplyIds(6), [8, 10, 12]);
    assert.deepEqual(activeReplyIds(), ids);
    chat[4].is_system = true;
    assert.deepEqual(activeReplyIds(), [0, 2, 6, 8, 10, 12]);
});

test('rollback snapshots keep what was read ahead, and an old snapshot restores to none', () => {
    const state = { npcs: [], lastScannedMessageId: 4, readAhead: [8, 10], scanCount: 2 };
    const snap = snapshotBranchState(state);
    assert.deepEqual(snap.readAhead, [8, 10]);
    assert.deepEqual(restoreSnapshotIntoState({ readAhead: [99] }, snap).readAhead, [8, 10]);
    const { readAhead, ...old } = snap;
    assert.deepEqual(restoreSnapshotIntoState({ readAhead: [99] }, old).readAhead, []);
    assert.deepEqual(snapshotBranchState({}).readAhead, []);
});

test('a bundle import starts with nothing read ahead', () => {
    const empty = { npcs: [], candidates: [], dismissed: [], socialGraph: { edges: [], unresolved: [] }, scanCount: 0, lastScannedMessageId: null, readAhead: [4, 6] };
    const merged = mergeImportedDossierState(empty, { npcs: [{ id: 'a', name: 'Mira Vale' }], lastScannedMessageId: 79, scanCount: 12 });
    assert.deepEqual(merged.readAhead, []);
    assert.equal(merged.lastScannedMessageId, null);
});
