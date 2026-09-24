import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, applyStaleNpcLifecycle } from '../core.js';
import {
    ROLLBACK_JOURNAL_WINDOW_MESSAGES,
    applyRollbackUndo,
    buildRollbackUndo,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { normalizeSocialGraph } from '../social.js';
import { prunePortraitAssetsForState } from '../storage.js';

function user(index) {
    return {
        is_user: true,
        is_system: false,
        name: 'Lucien',
        mes: `user-${index}`,
        send_date: `2026-09-14T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
    };
}

function assistant(index) {
    return {
        is_user: false,
        is_system: false,
        name: 'Narrator',
        mes: `assistant-${index}`,
        send_date: `2026-09-14T01:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
    };
}

function alternatingChat(rawMessages = 220) {
    return Array.from({ length: rawMessages }, (_, index) => index % 2 === 0 ? user(index) : assistant(index));
}

function baseState({ heavy = false } = {}) {
    const ryu = createNpcRecord('Ryu');
    ryu.manual = false;
    if (heavy) ryu.background = 'checkpoint-pressure '.repeat(3_200);
    return {
        npcs: [ryu],
        candidates: [],
        pendingBackfills: [],
        socialGraph: normalizeSocialGraph(),
        turn: 0,
        assistantSinceScan: 0,
        lastScanAt: 0,
        lastScannedMessageId: null,
        scanCount: 0,
        dismissed: [],
        inlineCards: [],
        portraitAssets: {},
        checkpoints: [],
        lineage: [],
        branchLineageVersion: 4,
        branchParent: null,
        branchForkMessageId: null,
        branchRootSnapshot: null,
        userDismissedGroups: [],
    };
}

function advanceAlternating(state, chat, messageId) {
    const prefix = chat.slice(0, messageId + 1);
    if (chat[messageId].is_user) {
        state.lineage = chatLineage(prefix);
        return;
    }
    ensureBranchParentAnchor(state, prefix, messageId, 'assistant-parent');
    state.turn += 1;
    state.assistantSinceScan += 1;
    const ryu = state.npcs.find(npc => npc.name === 'Ryu');
    ryu.mood = `mood-${messageId}`;
    ryu.lastSeenTurn = state.turn;
    state.lastScannedMessageId = messageId;
    state.assistantSinceScan = 0;
    state.lastScanAt = messageId + 1;
    state.scanCount += 1;
    recordBranchCheckpoint(state, prefix, messageId, 'scan');
}

test('v1.0.8 recovery treats a strict lineage prefix as forward extension, never rollback', () => {
    const storedChat = [user(0), assistant(1)];
    const currentChat = [...storedChat, user(2), assistant(3), user(4), assistant(5)];
    const state = baseState();
    state.npcs[0].mood = 'OLD_STATE';
    state.turn = 5;
    recordBranchCheckpoint(state, storedChat, 1, 'scan');
    state.npcs[0].mood = 'NEW_STATE';
    state.turn = 20;

    const result = reconcileBranchState(state, currentChat, { explicitDivergence: 1 });
    assert.equal(result.invalidated, false);
    assert.equal(result.lineageRelation, 'forward-extension');
    assert.equal(result.state.npcs[0].mood, 'NEW_STATE');
    assert.equal(result.state.turn, 20);
    assert.deepEqual(result.state.lineage, chatLineage(currentChat));
});

test('v1.0.8 journal crosses unchanged user boundaries for a 100-message deletion after checkpoint pruning', () => {
    const chat = alternatingChat(220);
    const state = baseState({ heavy: true });
    ensureRollbackJournalBaseline(state, []);
    for (let messageId = 0; messageId < chat.length; messageId += 1) advanceAlternating(state, chat, messageId);

    state.checkpoints = state.checkpoints.filter(checkpoint => checkpoint.messageId !== 119);
    assert.equal(state.checkpoints.some(checkpoint => checkpoint.messageId === 119), false,
        'remove the surviving-tail checkpoint so this proves journal traversal');
    const result = reconcileBranchState(state, chat.slice(0, 120));
    assert.equal(result.exactRestored, true);
    assert.equal(result.restoredFromJournal, true);
    assert.equal(result.restoredFromMessageId, 119);
    assert.equal(result.state.turn, 60);
    assert.equal(result.state.npcs[0].mood, 'mood-119');
});

test('v1.0.8 interleaved journal supports two successive 50-message deletions', () => {
    const chat = alternatingChat(220);
    const state = baseState({ heavy: true });
    ensureRollbackJournalBaseline(state, []);
    for (let messageId = 0; messageId < chat.length; messageId += 1) advanceAlternating(state, chat, messageId);

    const first = reconcileBranchState(state, chat.slice(0, 170));
    assert.equal(first.exactRestored, true);
    assert.equal(first.restoredFromJournal, true);
    assert.equal(first.state.turn, 85);

    const second = reconcileBranchState(first.state, chat.slice(0, 120));
    assert.equal(second.exactRestored, true);
    assert.equal(second.restoredFromJournal, true);
    assert.equal(second.state.turn, 60);
    assert.equal(second.state.npcs[0].mood, 'mood-119');
});

test('v1.0.8 message-horizon guarantee is expressed in raw chat boundaries', () => {
    assert.equal(ROLLBACK_JOURNAL_WINDOW_MESSAGES, 256);
});

test('v1.0.8 social graph undo stores changed records instead of a complete prior graph', () => {
    const npcs = Array.from({ length: 40 }, (_, index) => createNpcRecord(`NPC ${index}`));
    const edges = [];
    let edgeIndex = 0;
    for (let a = 0; a < npcs.length && edgeIndex < 240; a += 1) {
        for (let b = a + 1; b < npcs.length && edgeIndex < 240; b += 1) {
            edges.push({
                id: `edge-${edgeIndex}`,
                aId: npcs[a].id,
                bId: npcs[b].id,
                aToB: 'friend',
                bToA: 'friend',
                aDynamic: `shared context ${edgeIndex}`,
                bDynamic: `shared context ${edgeIndex}`,
                provenance: 'scanner',
                confidence: 'explicit',
                turn: 10,
            });
            edgeIndex += 1;
        }
    }
    const before = { npcs, candidates: [], pendingBackfills: [], dismissed: [], socialGraph: normalizeSocialGraph({ edges }), turn: 10 };
    const after = structuredClone(before);
    after.socialGraph.edges[20].turn = 11;
    const undo = buildRollbackUndo(before, after);
    assert.equal(undo.socialGraph?.kind, 'delta');
    assert.equal(undo.socialGraph.edges.changes.length, 1);
    assert.ok(JSON.stringify(undo.socialGraph).length < JSON.stringify(before.socialGraph).length / 4,
        'one-edge change must not retain the whole graph');
});

test('v1.0.8 stale deletion cleans structured references but keeps rollback-reachable portrait bytes until history pruning', () => {
    const ryu = createNpcRecord('Ryu');
    const elara = createNpcRecord('Elara', [ryu.id]);
    ryu.manual = false;
    elara.manual = false;
    ryu.lastSeenTurn = 100;
    elara.lastSeenTurn = 0;
    elara.archived = true;
    elara.archiveReason = 'stale';
    ryu.keyRelationships = ['Elara — friend | trusted merchant'];
    const portrait = { dataUrl: 'data:image/webp;base64,AAAA', mime: 'image/webp' };
    const state = {
        ...baseState(),
        npcs: [ryu, elara],
        turn: 100,
        portraitAssets: { [elara.id]: portrait },
        socialGraph: normalizeSocialGraph({ edges: [{ aId: ryu.id, bId: elara.id, aToB: 'friend', bToA: 'friend' }] }),
    };
    const result = applyStaleNpcLifecycle(state, { turn: 100, archiveAfter: 30, deleteAfter: 50 });
    assert.equal(result.state.npcs.some(npc => npc.id === elara.id), false);
    assert.deepEqual(result.state.npcs.find(npc => npc.id === ryu.id).keyRelationships, []);
    assert.equal(result.state.socialGraph.edges.length, 0);
    assert.equal(result.state.portraitAssets[elara.id]?.dataUrl, portrait.dataUrl,
        'lifecycle removal must not destroy portrait bytes before rollback ownership is journaled');

    // Once an undo record proves Elara is rollback-reachable, ordinary portrait GC must retain it.
    const chat = [assistant(1)];
    ensureRollbackJournalBaseline(state, []);
    const beforeRemoval = structuredClone(state);
    beforeRemoval.npcs = [ryu, elara];
    beforeRemoval.portraitAssets = { [elara.id]: portrait };
    beforeRemoval.socialGraph = normalizeSocialGraph({ edges: [{ aId: ryu.id, bId: elara.id, aToB: 'friend', bToA: 'friend' }] });
    ensureRollbackJournalBaseline(beforeRemoval, []);
    const removed = applyStaleNpcLifecycle(beforeRemoval, { turn: 100, archiveAfter: 30, deleteAfter: 50 }).state;
    recordBranchCheckpoint(removed, chat, 0, 'scan');
    const retained = prunePortraitAssetsForState(removed);
    assert.equal(retained[elara.id]?.dataUrl, portrait.dataUrl);
});

test('v1.0.8 failed scan can roll back across its preceding unchanged user boundary', () => {
    const chat = [user(0), assistant(1), user(2), assistant(3)];
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);

    // First assistant turn succeeds and becomes durable rollback history.
    state.lineage = chatLineage(chat.slice(0, 1));
    ensureBranchParentAnchor(state, chat.slice(0, 2), 1, 'assistant-parent');
    state.turn = 1;
    state.npcs[0].mood = 'after-success';
    state.lastScannedMessageId = 1;
    recordBranchCheckpoint(state, chat.slice(0, 2), 1, 'scan');

    // User turn changes lineage only. The next assistant is received, but its scan fails,
    // so no child checkpoint/journal mutation is committed for message 3.
    state.lineage = chatLineage(chat.slice(0, 3));
    ensureBranchParentAnchor(state, chat, 3, 'assistant-parent');
    state.turn = 2;
    state.assistantSinceScan = 1;
    state.lineage = chatLineage(chat);

    // Delete the failed assistant response together with its preceding user message.
    const result = reconcileBranchState(state, chat.slice(0, 2));
    assert.equal(result.exactRestored, true);
    assert.equal(result.restoredFromJournal, true);
    assert.equal(result.state.turn, 1);
    assert.equal(result.state.npcs[0].mood, 'after-success');
    assert.equal(result.state.lastScannedMessageId, 1);
});

test('v1.0.8 journal guarantees the last 256 raw message boundaries from its trustworthy baseline', () => {
    const chat = alternatingChat(300);
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);
    for (let messageId = 0; messageId < chat.length; messageId += 1) advanceAlternating(state, chat, messageId);

    assert.equal(state.rollbackHead.messageId, 299);
    assert.equal(state.rollbackJournalFloorMessageId, 43);
    assert.equal(state.rollbackJournalCoverageMessages, 256);
    assert.ok(state.rollbackJournal.every(entry => entry.messageId >= 43));

    // Remove full checkpoints so this can only succeed through the message journal.
    state.checkpoints = [];
    state.branchRootSnapshot = null;
    const withinWindow = reconcileBranchState(structuredClone(state), chat.slice(0, 44));
    assert.equal(withinWindow.restoredFromJournal, true);
    assert.equal(withinWindow.exactRestored, true);
    assert.equal(withinWindow.restoredFromMessageId, 43);
    assert.equal(withinWindow.state.turn, 22);
    assert.equal(withinWindow.state.npcs[0].mood, 'mood-43');

    const beyondWindow = reconcileBranchState(structuredClone(state), chat.slice(0, 43));
    assert.equal(beyondWindow.restoredFromJournal, false,
        'history older than the advertised 256-message floor must not pretend to be exact journal recovery');
});

test('v1.0.8 coalesces repeated canonical commits owned by the same raw message', () => {
    const chat = [assistant(1)];
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);
    const baselineMood = state.npcs[0].mood;

    state.npcs[0].mood = 'first-pass';
    recordBranchCheckpoint(state, chat, 0, 'scan');
    const firstSeq = state.rollbackHead.seq;
    assert.equal(state.rollbackJournal.length, 1);

    state.npcs[0].mood = 'later-backfill';
    state.npcs[0].goal = 'new goal';
    recordBranchCheckpoint(state, chat, 0, 'backfill');

    assert.equal(state.rollbackJournal.length, 1);
    assert.equal(state.rollbackHead.seq, firstSeq);
    assert.equal(state.rollbackHead.snapshot.npcs[0].mood, 'later-backfill');
    const reverted = applyRollbackUndo(state.rollbackHead.snapshot, state.rollbackJournal[0].undo).state;
    assert.equal(reverted.npcs[0].mood, baselineMood);
    assert.equal(reverted.npcs[0].goal, '');
});

test('current rollback ignores obsolete full-socialGraph undo records', () => {
    const aNpc = createNpcRecord('A');
    const bNpc = createNpcRecord('B');
    const beforeGraph = normalizeSocialGraph({ edges: [{ aId: aNpc.id, bId: bNpc.id, aToB: 'friend', bToA: 'friend', turn: 1 }] });
    const afterGraph = normalizeSocialGraph({ edges: [{ aId: aNpc.id, bId: bNpc.id, aToB: 'rival', bToA: 'rival', turn: 2 }] });
    const current = { ...baseState(), npcs: [aNpc, bNpc], socialGraph: afterGraph };

    const reverted = applyRollbackUndo(current, { socialGraph: beforeGraph }).state;
    assert.equal(reverted.socialGraph.edges.length, 1);
    assert.equal(reverted.socialGraph.edges[0].aToB, 'rival');
    assert.equal(reverted.socialGraph.edges[0].turn, 2);
});

test('v1.0.8 retained window rebases a journal head after an old mutation ages out across unchanged messages', () => {
    const first = assistant(0);
    const chat = [first];
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);
    ensureBranchParentAnchor(state, chat, 0, 'assistant-parent');
    state.turn = 1;
    state.npcs[0].mood = 'old-stable-state';
    recordBranchCheckpoint(state, chat, 0, 'scan');
    assert.ok(state.rollbackHead.seq > 0);

    // More than one retention window of user-only messages advances lineage but not canonical
    // NPC state. The next assistant parent-anchor settles that unchanged span.
    for (let messageId = 1; messageId <= 300; messageId += 1) {
        chat.push(user(messageId));
        state.lineage = chatLineage(chat);
    }
    chat.push(assistant(301));
    ensureBranchParentAnchor(state, chat, 301, 'assistant-parent');
    assert.equal(state.rollbackHead.messageId, 300);
    assert.equal(state.rollbackHead.seq, 0,
        'an aged-out mutation must become a clean retained-window baseline, not a dangling seq');

    state.turn = 2;
    state.npcs[0].mood = 'new-assistant-state';
    recordBranchCheckpoint(state, chat, 301, 'scan');
    assert.equal(state.rollbackJournal.at(-1).prevSeq, 0);

    // Delete the latest assistant and 99 unchanged user messages. This remains well inside the
    // 256-message horizon and must restore the old stable state exactly.
    const result = reconcileBranchState(state, chat.slice(0, 202));
    assert.equal(result.restoredFromJournal, true);
    assert.equal(result.exactRestored, true);
    assert.equal(result.state.turn, 1);
    assert.equal(result.state.npcs[0].mood, 'old-stable-state');
});
