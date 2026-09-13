import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    ROLLBACK_JOURNAL_LIMIT,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { normalizeSocialGraph } from '../social.js';
import { prunePortraitAssetsForState } from '../storage.js';

function assistant(index) {
    return {
        is_user: false,
        is_system: false,
        name: 'Narrator',
        mes: `turn-${index}`,
        send_date: `2026-09-13T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
    };
}

function baseState() {
    const ryu = createNpcRecord('Ryu');
    ryu.manual = false;
    // Make full branch snapshots expensive enough that the 2 MB checkpoint budget must
    // discard middle checkpoints. The rollback journal should stay compact because this
    // static field never changes.
    ryu.background = 'old-canon '.repeat(3_200);
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

function advanceMessage(state, chat, messageId) {
    const prefix = chat.slice(0, messageId + 1);
    ensureBranchParentAnchor(state, prefix, messageId, 'assistant-parent');
    state.turn += 1;
    state.assistantSinceScan += 1;
    const ryu = state.npcs.find(npc => npc.name === 'Ryu');
    ryu.mood = `mood-${messageId}`;
    ryu.lastSeenTurn = state.turn;

    if (messageId === 130) {
        const elara = createNpcRecord('Elara', state.npcs.map(npc => npc.id));
        elara.manual = false;
        elara.role = 'Merchant';
        elara.mood = 'Wary';
        state.npcs.push(elara);
        ryu.keyRelationships = ['Elara — Trusted merchant; relies on her trade network.'];
        state.socialGraph = normalizeSocialGraph({
            edges: [{
                aId: ryu.id,
                bId: elara.id,
                aToB: 'Trusted merchant',
                bToA: 'Valued client',
                aDynamic: 'Relies on her trade network.',
                bDynamic: 'Keeps rare stock aside for Ryu.',
                provenance: 'scan',
                confidence: 'explicit',
                sourceMessageId: messageId,
                turn: state.turn,
            }],
        });
    }

    const elara = state.npcs.find(npc => npc.name === 'Elara');
    if (elara && messageId === 150) {
        elara.memories.push('Ryu entrusted her with a sealed parcel.');
        elara.speech = 'Quick, clipped merchant patter.';
        elara.profileEvidence.speech = ['cadence: repeatedly answers in clipped bargaining phrases'];
        elara.speechDevelopment = {
            epoch: 1,
            baseline: elara.speech,
            concepts: [{
                concept: 'cadence',
                firstTurn: state.turn,
                lastTurn: state.turn,
                observationCount: 1,
                sourceMessageIds: [messageId],
                turns: [state.turn],
                latestEvidence: 'cadence: repeatedly answers in clipped bargaining phrases',
            }],
        };
        state.pendingBackfills.push({
            npcId: elara.id,
            label: elara.name,
            requestedMessageId: messageId,
            requestedAt: state.turn,
            attempts: 0,
        });
    }
    if (elara && messageId === 170) {
        elara.archived = true;
        elara.archiveReason = 'deceased';
        elara.lifeState = 'deceased';
        elara.lifeStateCertainty = 'explicit';
        elara.present = false;
    }

    state.lastScannedMessageId = messageId;
    state.assistantSinceScan = 0;
    state.lastScanAt = messageId + 1;
    state.scanCount += 1;
    recordBranchCheckpoint(state, prefix, messageId, 'scan');
}

test('v1.0.7 exact journal rollback survives a 100-message tail deletion beyond the full-checkpoint budget', () => {
    const chat = Array.from({ length: 220 }, (_, index) => assistant(index));
    const state = baseState();
    ensureRollbackJournalBaseline(state, chatLineage([]));

    for (let messageId = 0; messageId < chat.length; messageId += 1) advanceMessage(state, chat, messageId);

    assert.ok(state.rollbackJournal.length <= ROLLBACK_JOURNAL_LIMIT);
    assert.equal(state.checkpoints.some(checkpoint => checkpoint.messageId === 119), false,
        'the exact 119 checkpoint should be gone so this proves journal recovery rather than snapshot luck');
    assert.ok(state.npcs.some(npc => npc.name === 'Elara'));
    assert.equal(state.socialGraph.edges.length, 1);

    // User-owned metadata is intentionally not narrative rollback state.
    state.npcs.find(npc => npc.name === 'Ryu').portraitPromptPositive = 'my manual portrait prompt';

    const surviving = chat.slice(0, 120);
    const result = reconcileBranchState(state, surviving);

    assert.equal(result.exactRestored, true);
    assert.equal(result.restoredFromJournal, true);
    assert.equal(result.restoredFromMessageId, 119);
    assert.equal(result.state.turn, 120);
    assert.equal(result.state.scanCount, 120);
    assert.equal(result.state.lastScannedMessageId, 119);
    assert.equal(result.state.npcs.length, 1, 'NPC introduced only inside deleted history must disappear');
    assert.equal(result.state.npcs[0].name, 'Ryu');
    assert.equal(result.state.npcs[0].mood, 'mood-119');
    assert.equal(result.state.npcs[0].portraitPromptPositive, 'my manual portrait prompt');
    assert.deepEqual(result.state.npcs[0].keyRelationships, []);
    assert.equal(result.state.socialGraph.edges.length, 0, 'social edges to rolled-away NPCs must disappear');
    assert.deepEqual(result.state.pendingBackfills, [], 'pending work sourced only from deleted history must disappear');
});

test('v1.0.7 deep rollback can continue across two 50-message deletion batches', () => {
    const chat = Array.from({ length: 220 }, (_, index) => assistant(index));
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);
    for (let messageId = 0; messageId < chat.length; messageId += 1) advanceMessage(state, chat, messageId);

    const first = reconcileBranchState(state, chat.slice(0, 170));
    assert.equal(first.exactRestored, true);
    assert.equal(first.restoredFromJournal, true);
    assert.equal(first.state.npcs.some(npc => npc.name === 'Elara'), true, 'Elara exists at message 169');
    assert.equal(first.state.npcs.find(npc => npc.name === 'Elara').lifeState, 'unknown', 'later death must be reversed');

    const second = reconcileBranchState(first.state, chat.slice(0, 120));
    assert.equal(second.exactRestored, true);
    assert.equal(second.restoredFromJournal, true);
    assert.equal(second.state.npcs.some(npc => npc.name === 'Elara'), false);
    assert.equal(second.state.npcs[0].mood, 'mood-119');
    assert.equal(second.state.turn, 120);
});


test('v1.0.7 failed scan leaves no rollback hole and the next parent anchor settles the surviving turn', () => {
    const chat = Array.from({ length: 3 }, (_, index) => assistant(index));
    const state = baseState();
    ensureRollbackJournalBaseline(state, []);

    // Message 0 completes normally.
    advanceMessage(state, chat, 0);
    const afterZero = structuredClone(state);

    // Message 1 reaches the host but its scanner never commits. The canonical cadence
    // counters changed, while the journal head intentionally remains at message 0.
    ensureBranchParentAnchor(state, chat.slice(0, 2), 1, 'assistant-parent');
    state.turn += 1;
    state.assistantSinceScan += 1;

    const immediateDelete = reconcileBranchState(structuredClone(state), chat.slice(0, 1));
    assert.equal(immediateDelete.exactRestored, true);
    assert.equal(immediateDelete.restoredFromJournal, true);
    assert.equal(immediateDelete.state.turn, afterZero.turn);
    assert.equal(immediateDelete.state.assistantSinceScan, afterZero.assistantSinceScan);

    // If message 1 survives, arrival of message 2 settles its uncheckpointed state into
    // the journal before the new branch anchor advances. Deleting only message 2 must
    // therefore preserve message 1's cadence state rather than jumping back to message 0.
    ensureBranchParentAnchor(state, chat, 2, 'assistant-parent');
    assert.equal(state.rollbackHead.messageId, 1);
    const afterOneTurn = state.turn;
    const afterOneCadence = state.assistantSinceScan;
    state.turn += 1;
    state.assistantSinceScan += 1;
    recordBranchCheckpoint(state, chat, 2, 'scan');

    const deleteTwo = reconcileBranchState(state, chat.slice(0, 2));
    assert.equal(deleteTwo.exactRestored, true);
    assert.equal(deleteTwo.restoredFromJournal, true);
    assert.equal(deleteTwo.state.turn, afterOneTurn);
    assert.equal(deleteTwo.state.assistantSinceScan, afterOneCadence);
});

test('v1.0.7 journal keeps portrait assets reachable for an NPC that can be restored after full checkpoints are gone', () => {
    const chat = Array.from({ length: 6 }, (_, index) => assistant(index));
    const state = baseState();
    const elara = createNpcRecord('Elara', state.npcs.map(npc => npc.id));
    elara.manual = false;
    elara.portrait = null;
    state.npcs.push(elara);
    state.portraitAssets[elara.id] = { dataUrl: 'data:image/webp;base64,AAAA', mime: 'image/webp' };
    ensureRollbackJournalBaseline(state, []);

    for (let messageId = 0; messageId < 5; messageId += 1) {
        const prefix = chat.slice(0, messageId + 1);
        state.turn += 1;
        state.lastScannedMessageId = messageId;
        recordBranchCheckpoint(state, prefix, messageId, 'scan');
    }

    const removalPrefix = chat.slice(0, 6);
    state.npcs = state.npcs.filter(npc => npc.id !== elara.id);
    state.socialGraph = normalizeSocialGraph(state.socialGraph);
    state.turn += 1;
    state.lastScannedMessageId = 5;
    recordBranchCheckpoint(state, removalPrefix, 5, 'scan');

    // Simulate the full-snapshot retention window having dropped every historical
    // checkpoint for Elara. The journal is now the only restoration proof.
    state.checkpoints = [];
    state.branchRootSnapshot = null;
    const retained = prunePortraitAssetsForState(state);
    assert.equal(retained[elara.id]?.dataUrl, 'data:image/webp;base64,AAAA');
    state.portraitAssets = retained;

    const result = reconcileBranchState(state, chat.slice(0, 5));
    const restoredElara = result.state.npcs.find(npc => npc.id === elara.id);
    assert.ok(restoredElara, 'NPC existing before the deleted tail must be restored');
    assert.equal(restoredElara.portrait?.dataUrl, 'data:image/webp;base64,AAAA', 'retained user portrait must reattach after journal restore');
});
