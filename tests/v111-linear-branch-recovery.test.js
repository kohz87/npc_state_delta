import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    lineageCheckpointKey,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';

const user = turn => ({
    is_user: true,
    is_system: false,
    name: 'User',
    mes: `user-${turn}`,
    send_date: `user-date-${turn}`,
});

const bot = (turn, variant) => ({
    is_user: false,
    is_system: false,
    name: 'Narrator',
    mes: `assistant-${turn}-${variant}`,
    send_date: `assistant-date-${turn}-${variant}`,
    extra: { gen_id: `generation-${turn}-${variant}` },
});

function makeState({ large = false } = {}) {
    const npc = createNpcRecord('Seren Lowen');
    npc.manual = false;
    npc.goal = 'baseline';
    if (large) npc.background = `continuity:${'x'.repeat(115_000)}`;
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
    return state;
}

function deleteTail(state, chat, messageId) {
    const discardedKey = lineageCheckpointKey(chatLineage(chat), messageId);
    const surviving = chat.slice(0, -1);
    const result = reconcileBranchState(state, surviving, {
        explicitDivergence: messageId,
        operation: 'delete',
    });
    assert.equal(result.recoveryOperation, 'delete');
    assert.equal(result.linearHistoryPruned, true);
    assert.equal(result.restoredFromRoot, false, 'ordinary tail deletion must never fall back to root');
    assert.equal(result.failClosed, false, 'covered recent tail deletion should restore exactly');
    assert.ok(result.recoveryAction === 'rollback-journal' || result.recoveryAction === 'exact-checkpoint');
    assert.ok(result.state.checkpoints.every(checkpoint => checkpoint.messageId < messageId));
    assert.equal(result.state.checkpoints.some(checkpoint => checkpoint.lineageKey === discardedKey), false);
    return { state: result.state, chat: surviving, discardedKey };
}

test('v1.0.11 scattered delete/regenerate cycles stay linear under checkpoint-byte pressure', () => {
    let state = makeState({ large: true });
    let chat = [];
    const discardedKeys = new Set();
    let expectedGoal = 'baseline';

    // Ten user/assistant pairs leave twenty live messages. Every assistant is regenerated
    // multiple times, approximating the real scattered 2-3 replacement pattern without
    // turning discarded generations into sibling branches.
    for (let turn = 0; turn < 10; turn += 1) {
        chat.push(user(turn));
        state.lineage = chatLineage(chat);
        const messageId = chat.length;

        chat.push(bot(turn, 'A'));
        expectedGoal = `turn-${turn}-A`;
        receiveAssistant(state, chat, messageId, expectedGoal);

        let deleted = deleteTail(state, chat, messageId);
        discardedKeys.add(deleted.discardedKey);
        state = deleted.state;
        chat = deleted.chat;

        chat.push(bot(turn, 'B'));
        expectedGoal = `turn-${turn}-B`;
        receiveAssistant(state, chat, messageId, expectedGoal);

        deleted = deleteTail(state, chat, messageId);
        discardedKeys.add(deleted.discardedKey);
        state = deleted.state;
        chat = deleted.chat;

        chat.push(bot(turn, 'C'));
        expectedGoal = `turn-${turn}-C`;
        receiveAssistant(state, chat, messageId, expectedGoal);

        // Half the turns receive a fourth generation to push the synthetic run closer to
        // the user's roughly fifty total generated/deleted message instances.
        if (turn % 2 === 0) {
            deleted = deleteTail(state, chat, messageId);
            discardedKeys.add(deleted.discardedKey);
            state = deleted.state;
            chat = deleted.chat;
            chat.push(bot(turn, 'D'));
            expectedGoal = `turn-${turn}-D`;
            receiveAssistant(state, chat, messageId, expectedGoal);
        }
    }

    assert.equal(chat.length, 20);
    assert.equal(state.npcs.length, 1);
    assert.equal(state.npcs[0].goal, expectedGoal);
    for (const discardedKey of discardedKeys) {
        assert.equal(state.checkpoints.some(checkpoint => checkpoint.lineageKey === discardedKey), false,
            'discarded delete/regenerate continuation must not survive as a sibling checkpoint');
    }
    const checkpointBytes = state.checkpoints.reduce((sum, checkpoint) => {
        return sum + JSON.stringify(checkpoint.snapshot || {}).length + 256;
    }, 0);
    assert.ok(checkpointBytes <= BRANCH_SNAPSHOT_BUDGET_BYTES);
    assert.ok(state.rollbackJournalCoverageMessages >= 0);
});

test('v1.0.11 explicit swipes remain siblings and survive a later linear delete', () => {
    let state = makeState();
    const opening = user(0);
    const branchA = [opening, bot(0, 'A')];
    state.lineage = chatLineage([opening]);
    receiveAssistant(state, branchA, 1, 'branch-A');
    const branchAKey = lineageCheckpointKey(chatLineage(branchA), 1);

    const branchB = [opening, bot(0, 'B')];
    let result = reconcileBranchState(state, branchB, { explicitDivergence: 1, operation: 'swipe' });
    assert.equal(result.recoveryOperation, 'swipe');
    assert.equal(result.linearHistoryPruned, false);
    state = result.state;
    receiveAssistant(state, branchB, 1, 'branch-B');
    const branchBKey = lineageCheckpointKey(chatLineage(branchB), 1);
    assert.ok(state.checkpoints.some(checkpoint => checkpoint.lineageKey === branchAKey));
    assert.ok(state.checkpoints.some(checkpoint => checkpoint.lineageKey === branchBKey));

    result = reconcileBranchState(state, branchA, { explicitDivergence: 1, operation: 'swipe' });
    assert.equal(result.exactRestored, true);
    assert.equal(result.state.npcs[0].goal, 'branch-A');

    // Continue from B, then delete only the later tail. Both genuine message-1 swipe siblings
    // must remain because they predate the linear replacement boundary.
    state = reconcileBranchState(result.state, branchB, { explicitDivergence: 1, operation: 'swipe' }).state;
    const withUser = [...branchB, user(1)];
    state.lineage = chatLineage(withUser);
    const withTail = [...withUser, bot(1, 'A')];
    receiveAssistant(state, withTail, 3, 'later-tail');
    result = reconcileBranchState(state, withUser, { explicitDivergence: 3, operation: 'delete' });
    assert.equal(result.linearHistoryPruned, true);
    assert.ok(result.state.checkpoints.some(checkpoint => checkpoint.lineageKey === branchAKey));
    assert.ok(result.state.checkpoints.some(checkpoint => checkpoint.lineageKey === branchBKey));
});

test('v1.0.11 unproven passive divergence keeps canonical state instead of restoring root', () => {
    const state = makeState();
    const original = [user(0), bot(0, 'A'), user(1), bot(1, 'A')];
    state.lineage = chatLineage(original);
    state.checkpoints = [];
    state.rollbackJournal = [];
    state.rollbackHead = {
        seq: 0,
        messageId: 3,
        lineageKey: lineageCheckpointKey(state.lineage, 3),
        snapshot: structuredClone({ ...state, checkpoints: [], rollbackJournal: [] }),
    };
    const second = createNpcRecord('Maren');
    second.goal = 'must survive';
    state.npcs.push(second);
    state.branchRootSnapshot = {
        npcs: [{ ...createNpcRecord('Old Root'), goal: 'obsolete' }],
        candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0,
    };

    const changed = [original[0], { ...original[1], mes: 'unexpected replacement' }, original[2], original[3]];
    const result = reconcileBranchState(state, changed, { operation: 'auto' });
    assert.equal(result.failClosed, true);
    assert.equal(result.recoveryAction, 'fail-closed-keep-current');
    assert.equal(result.restoredFromRoot, false);
    assert.equal(result.state.npcs.length, 2);
    assert.ok(result.state.npcs.some(npc => npc.name === 'Maren' && npc.goal === 'must survive'));
});

test('v1.0.11 explicit edit is linear and removes the replaced descendant checkpoint', () => {
    let state = makeState();
    const chatA = [user(0), bot(0, 'A')];
    state.lineage = chatLineage([chatA[0]]);
    receiveAssistant(state, chatA, 1, 'edited-away');
    const oldKey = lineageCheckpointKey(chatLineage(chatA), 1);
    const chatB = [chatA[0], bot(0, 'B')];
    const result = reconcileBranchState(state, chatB, { explicitDivergence: 1, operation: 'edit' });
    assert.equal(result.recoveryOperation, 'edit');
    assert.equal(result.linearHistoryPruned, true);
    assert.equal(result.restoredFromRoot, false);
    assert.equal(result.state.checkpoints.some(checkpoint => checkpoint.lineageKey === oldKey), false);
    assert.equal(result.state.npcs[0].goal, 'baseline');
});

test('v1.0.11 production host events classify only swipes as sibling branching', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const eventBlock = index.slice(index.indexOf('if (events.MESSAGE_DELETED)'), index.indexOf('if (events.CHAT_CHANGED)'));
    assert.match(eventBlock, /MESSAGE_DELETED[\s\S]*operation: 'delete'/);
    assert.match(eventBlock, /MESSAGE_EDITED[\s\S]*operation: 'edit'/);
    assert.match(eventBlock, /MESSAGE_SWIPED[\s\S]*operation: 'swipe'/);
    assert.match(eventBlock, /MESSAGE_SWIPE_DELETED[\s\S]*operation: 'swipe'/);
    assert.match(index, /branchReconciliations:/);
    assert.match(index, /failClosed: Boolean\(result\.failClosed\)/);
});
