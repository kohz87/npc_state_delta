import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    lineageCheckpointKey,
    recordBranchCheckpoint,
    reconcileBranchState,
    snapshotBranchState,
} from '../branch.js';

const user = turn => ({
    is_user: true,
    is_system: false,
    name: 'User',
    mes: `user-${turn}`,
});

const bot = (turn, variant = 'A') => ({
    is_user: false,
    is_system: false,
    name: 'Narrator',
    mes: `assistant-${turn}-${variant}`,
});

function makeState(name = 'Seren Lowen') {
    const npc = createNpcRecord(name);
    npc.goal = 'baseline';
    const state = {
        npcs: [npc],
        candidates: [],
        pendingBackfills: [],
        socialGraph: { edges: [], unresolved: [] },
        dismissed: [],
        turn: 0,
        assistantSinceScan: 0,
        lastScanAt: 0,
        lastScannedMessageId: null,
        scanCount: 0,
        checkpoints: [],
        inlineCards: [],
        lineage: [],
        branchLineageVersion: BRANCH_LINEAGE_VERSION,
        portraitAssets: {},
        userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

function receiveAssistant(state, chat, messageId, goal) {
    ensureBranchParentAnchor(state, chat, messageId, 'assistant-parent');
    state.turn = Number(state.turn || 0) + 1;
    state.assistantSinceScan = Number(state.assistantSinceScan || 0) + 1;
    state.npcs[0].goal = goal;
    recordBranchCheckpoint(state, chat, messageId, 'scan');
}

function buildThreeExchangeState() {
    const state = makeState();
    const chat = [];
    for (let turn = 0; turn < 3; turn += 1) {
        chat.push(user(turn));
        state.lineage = chatLineage(chat);
        chat.push(bot(turn, 'A'));
        receiveAssistant(state, chat, chat.length - 1, `after-${turn}`);
    }
    return { state, chat };
}

test('v1.0.13 near-tail edit reconstructs the exact parent from journal when its full checkpoint is missing', () => {
    const { state, chat } = buildThreeExchangeState();
    const previous = chatLineage(chat);
    const targetMessageId = 4;
    state.checkpoints = (state.checkpoints || []).filter(item => item.messageId !== targetMessageId);
    assert.ok(state.checkpoints.some(item => item.messageId < targetMessageId), 'older checkpoint remains to tempt an unsafe fallback');

    const edited = chat.map((message, index) => index === 5 ? { ...message, mes: 'assistant-2-edited' } : message);
    const result = reconcileBranchState(state, edited, { explicitDivergence: 5, operation: 'edit' });

    assert.equal(result.lineageRelation, 'replacement-divergence');
    assert.equal(result.requestedRecoveryMessageId, 4);
    assert.equal(result.affectedAssistantMessages, 1);
    assert.equal(result.linearSuffixReplaySafe, true);
    assert.equal(result.recoveryAction, 'rollback-journal');
    assert.equal(result.restoredFromJournal, true);
    assert.equal(result.exactRestored, true);
    assert.equal(result.restoredFromMessageId, 4);
    assert.equal(result.state.rollbackHead.messageId, 4, 'journal head remains owned by the exact restored parent');
    assert.equal(result.state.npcs[0].goal, 'after-1', 'state immediately before the edited assistant is restored');
    assert.equal(result.requiresRescan, true, 'the edited assistant still needs a fresh scan after exact parent recovery');
    assert.notEqual(result.restoredFromMessageId, 3);
    assert.equal(previous.slice(0, 5).every((value, index) => value === chatLineage(edited)[index]), true);
});

test('v1.0.13 near-tail edit fails closed instead of restoring an older checkpoint when exact proof is unavailable', () => {
    const { state, chat } = buildThreeExchangeState();
    const lineage = chatLineage(chat);
    const currentGoal = state.npcs[0].goal;
    state.checkpoints = (state.checkpoints || []).filter(item => item.messageId < 4);
    state.rollbackJournal = [];
    state.rollbackJournalFloorMessageId = 5;
    state.rollbackHead = {
        seq: 0,
        messageId: 5,
        lineageKey: lineageCheckpointKey(lineage, 5),
        snapshot: snapshotBranchState(state),
    };

    const edited = chat.map((message, index) => index === 5 ? { ...message, mes: 'assistant-2-edited-without-proof' } : message);
    const result = reconcileBranchState(state, edited, { explicitDivergence: 5, operation: 'edit' });

    assert.equal(result.requestedRecoveryMessageId, 4);
    assert.equal(result.journalTargetReachable, false);
    assert.equal(result.exactCheckpointAvailable, false);
    assert.equal(result.failClosed, true);
    assert.equal(result.recoveryAction, 'fail-closed-keep-current');
    assert.equal(result.restoredFromMessageId, null);
    assert.equal(result.olderCheckpointRejected, true);
    assert.ok(result.nearestOlderCheckpointMessageId < 4);
    assert.ok(result.recoveryDistance > 0);
    assert.equal(result.state.npcs[0].goal, currentGoal, 'accepted canonical state survives missing historical proof');
    assert.equal(result.requiresRescan, true);
});

function longChat(messageCount = 123) {
    return Array.from({ length: messageCount }, (_, index) => (
        index % 2 === 0 ? user(Math.floor(index / 2)) : bot(Math.floor(index / 2), 'A')
    ));
}

function oldCheckpointFor(state, lineage, messageId = 3) {
    const old = makeState('Seren Lowen');
    old.npcs[0].goal = 'ancient-message-3-state';
    return {
        messageId,
        fingerprint: lineage[messageId],
        lineageKey: lineageCheckpointKey(lineage, messageId),
        parentLineageKey: messageId > 0 ? lineageCheckpointKey(lineage, messageId - 1) : 'root',
        reason: 'ancient-anchor',
        createdAt: 1,
        rollbackSeq: 0,
        snapshot: snapshotBranchState(old),
    };
}

test('v1.0.13 reproduces message-99 reset signature and rejects ancient message-3 recovery', () => {
    const chat = longChat(123);
    const lineage = chatLineage(chat);
    const state = makeState('NPC 01');
    state.npcs = Array.from({ length: 26 }, (_, index) => {
        const npc = createNpcRecord(`NPC ${String(index + 1).padStart(2, '0')}`);
        npc.goal = `current-${index + 1}`;
        return npc;
    });
    state.lineage = lineage;
    state.checkpoints = [oldCheckpointFor(state, lineage, 3)];
    state.rollbackJournal = [];
    state.rollbackJournalFloorMessageId = 0;
    state.rollbackHead = {
        seq: 0,
        messageId: 122,
        lineageKey: lineageCheckpointKey(lineage, 122),
        snapshot: snapshotBranchState(state),
    };

    const edited = chat.map((message, index) => index === 99 ? { ...message, mes: 'assistant-49-edited-deep-history' } : message);
    const result = reconcileBranchState(state, edited, { explicitDivergence: 99, operation: 'edit' });

    assert.equal(result.lineageRelation, 'replacement-divergence');
    assert.equal(result.requestedRecoveryMessageId, 98);
    assert.ok(result.affectedAssistantMessages > 1);
    assert.equal(result.linearSuffixReplaySafe, false);
    assert.equal(result.recoveryBlockedByRetainedDescendants, true);
    assert.equal(result.nearestOlderCheckpointMessageId, 3);
    assert.equal(result.olderCheckpointRejected, true);
    assert.equal(result.recoveryDistance, 95);
    assert.equal(result.failClosed, true);
    assert.equal(result.recoveryAction, 'fail-closed-keep-current');
    assert.equal(result.exactRestored, false);
    assert.equal(result.restoredFromMessageId, null);
    assert.equal(result.state.npcs.length, 26, 'deep edit must preserve all current dossiers rather than restoring ancient state');
    assert.equal(result.state.npcs[25].goal, 'current-26');
    assert.equal(result.requiresRescan, true);
});

test('v1.0.13 deep edit refuses destructive rewind even when exact parent checkpoint survives', () => {
    const chat = longChat(123);
    const lineage = chatLineage(chat);
    const state = makeState('Current NPC');
    state.npcs.push(createNpcRecord('Second Current NPC'));
    state.lineage = lineage;

    const parent = makeState('Parent Snapshot NPC');
    parent.lineage = lineage.slice(0, 99);
    state.checkpoints = [
        oldCheckpointFor(state, lineage, 3),
        {
            messageId: 98,
            fingerprint: lineage[98],
            lineageKey: lineageCheckpointKey(lineage, 98),
            parentLineageKey: lineageCheckpointKey(lineage, 97),
            reason: 'exact-parent',
            createdAt: 2,
            rollbackSeq: 0,
            snapshot: snapshotBranchState(parent),
        },
    ];
    state.rollbackJournal = [];
    state.rollbackJournalFloorMessageId = 0;
    state.rollbackHead = {
        seq: 0,
        messageId: 122,
        lineageKey: lineageCheckpointKey(lineage, 122),
        snapshot: snapshotBranchState(state),
    };

    const edited = chat.map((message, index) => index === 99 ? { ...message, mes: 'assistant-49-deep-edit' } : message);
    const result = reconcileBranchState(state, edited, { explicitDivergence: 99, operation: 'edit' });

    assert.equal(result.exactCheckpointAvailable, true);
    assert.equal(result.recoveryBlockedByRetainedDescendants, true);
    assert.equal(result.failClosed, true);
    assert.equal(result.restoredFromMessageId, null);
    assert.equal(result.state.npcs.length, 2, 'later accepted suffix state must not be discarded merely because parent snapshot exists');
});

test('v1.0.13 exact swipe sibling still restores without a rescan', () => {
    let state = makeState();
    const opening = user(0);
    const branchA = [opening, bot(0, 'A')];
    state.lineage = chatLineage([opening]);
    receiveAssistant(state, branchA, 1, 'branch-A');

    const branchB = [opening, bot(0, 'B')];
    state = reconcileBranchState(state, branchB, { explicitDivergence: 1, operation: 'swipe' }).state;
    receiveAssistant(state, branchB, 1, 'branch-B');

    const result = reconcileBranchState(state, branchA, { explicitDivergence: 1, operation: 'swipe' });
    assert.equal(result.exactRestored, true);
    assert.equal(result.recoveryAction, 'exact-checkpoint');
    assert.equal(result.restoredFromMessageId, 1);
    assert.equal(result.state.npcs[0].goal, 'branch-A');
    assert.equal(result.requiresRescan, false);
});
