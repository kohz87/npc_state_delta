import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_HISTORY_COMPACTION_VERSION,
    BRANCH_LINEAGE_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    BRANCH_SNAPSHOT_MAX_BYTES,
    chatLineage,
    compactLegacyBranchHistory,
    ensureRollbackJournalBaseline,
    legacyChatLineageV4,
    lineageCheckpointKey,
    migrateLegacyBranchState,
    recordBranchCheckpoint,
    snapshotBranchState,
} from '../branch.js';

const user = (turn = 0) => ({
    is_user: true,
    is_system: false,
    name: 'User',
    mes: `user-${turn}`,
    send_date: `user-date-${turn}`,
});

const bot = (turn, variant, sendDate = `assistant-date-${turn}-${variant}`) => ({
    is_user: false,
    is_system: false,
    name: 'Narrator',
    mes: `assistant-${turn}-${variant}`,
    send_date: sendDate,
    extra: { gen_id: `generation-${turn}-${variant}` },
});

function makeState() {
    const npc = createNpcRecord('Seren Lowen');
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
        branchHistoryCompactionVersion: 0,
        branchHistoryCompaction: null,
        branchRootSnapshot: null,
        portraitAssets: {},
        userDismissedGroups: [],
        rollbackJournal: [],
        rollbackJournalSequence: 0,
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

function swipeChat() {
    const opening = user(0);
    const active = {
        ...bot(0, 'B'),
        swipes: ['assistant-0-A', 'assistant-0-B'],
        swipe_id: 1,
        swipe_info: [
            { send_date: 'assistant-date-0-A', extra: { gen_id: 'generation-0-A' } },
            { send_date: 'assistant-date-0-B', extra: { gen_id: 'generation-0-B' } },
        ],
    };
    return [opening, active];
}

function checkpointFor(lineage, messageId, snapshot, rollbackSeq = 0, reason = 'legacy') {
    return {
        messageId,
        fingerprint: lineage[messageId],
        lineageKey: lineageCheckpointKey(lineage, messageId),
        parentLineageKey: messageId > 0 ? lineageCheckpointKey(lineage, messageId - 1) : 'root',
        reason,
        createdAt: Date.now(),
        rollbackSeq,
        snapshot: structuredClone(snapshot),
    };
}

test('v1.0.12 expands full-checkpoint storage limits', () => {
    assert.equal(BRANCH_SNAPSHOT_BUDGET_BYTES, 8_000_000);
    assert.equal(BRANCH_SNAPSHOT_MAX_BYTES, 2_000_000);
    assert.equal(BRANCH_HISTORY_COMPACTION_VERSION, 1);
});

test('v1.0.12 compaction keeps active history and host-proven swipes while dropping unreachable legacy siblings', () => {
    const chat = swipeChat();
    const activeLineage = chatLineage(chat);
    const alternateChat = [chat[0], { ...chat[1], mes: 'assistant-0-A' }];
    const alternateLineage = chatLineage(alternateChat);
    const ghostChat = [chat[0], { ...chat[1], mes: 'assistant-0-C' }];
    const ghostLineage = chatLineage(ghostChat);

    const state = makeState();
    state.lineage = activeLineage;
    const snapshot = snapshotBranchState(state);
    state.checkpoints = [
        checkpointFor(activeLineage, 1, snapshot, 4, 'active'),
        checkpointFor(alternateLineage, 1, snapshot, 2, 'explicit-swipe'),
        checkpointFor(ghostLineage, 1, snapshot, 3, 'old-delete-regenerate'),
    ];
    state.inlineCards = [
        { messageId: 1, fingerprint: activeLineage[1], lineageKey: lineageCheckpointKey(activeLineage, 1), cards: [] },
        { messageId: 1, fingerprint: alternateLineage[1], lineageKey: lineageCheckpointKey(alternateLineage, 1), cards: [] },
        { messageId: 1, fingerprint: ghostLineage[1], lineageKey: lineageCheckpointKey(ghostLineage, 1), cards: [] },
    ];
    state.rollbackJournal = [1, 2, 3, 4].map(seq => ({
        seq,
        prevSeq: seq === 4 ? 1 : 0,
        messageId: 1,
        beforeMessageId: 0,
        fingerprint: [1, 4].includes(seq) ? activeLineage[1] : (seq === 2 ? alternateLineage[1] : ghostLineage[1]),
        lineageKey: [1, 4].includes(seq)
            ? lineageCheckpointKey(activeLineage, 1)
            : (seq === 2 ? lineageCheckpointKey(alternateLineage, 1) : lineageCheckpointKey(ghostLineage, 1)),
        parentLineageKey: lineageCheckpointKey(activeLineage, 0),
        reason: 'legacy',
        createdAt: Date.now() + seq,
        undo: { scalars: { turn: 0 } },
    }));
    state.rollbackJournalSequence = 4;
    state.rollbackHead = {
        seq: 4,
        messageId: 1,
        lineageKey: lineageCheckpointKey(activeLineage, 1),
        snapshot: structuredClone(snapshot),
    };
    state.rollbackJournalFloorMessageId = 0;

    const result = compactLegacyBranchHistory(state, chat);
    const keys = new Set(result.state.checkpoints.map(item => item.lineageKey));
    assert.equal(result.deferred, false);
    assert.equal(result.state.branchHistoryCompactionVersion, BRANCH_HISTORY_COMPACTION_VERSION);
    assert.ok(keys.has(lineageCheckpointKey(activeLineage, 1)));
    assert.ok(keys.has(lineageCheckpointKey(alternateLineage, 1)));
    assert.equal(keys.has(lineageCheckpointKey(ghostLineage, 1)), false);
    assert.equal(result.state.inlineCards.length, 2);
    assert.deepEqual(result.state.rollbackJournal.map(item => item.seq).sort((a, b) => a - b), [1, 2, 4]);
    assert.equal(result.summary.provenSwipeCheckpoints, 1);
    assert.equal(result.summary.checkpointsBefore, 3);
    assert.equal(result.summary.checkpointsAfter, 2);

    const second = compactLegacyBranchHistory(result.state, chat);
    assert.equal(second.changed, false);
    assert.equal(second.deferred, false);
    assert.deepEqual(second.summary, result.summary);
});

test('v1.0.12 v4 migration preserves only active and host-retained swipe checkpoints without sibling collapse', () => {
    const chat = swipeChat();
    const activeV5 = chatLineage(chat);
    const altV5Chat = [chat[0], { ...chat[1], mes: 'assistant-0-A' }];
    const altV5 = chatLineage(altV5Chat);
    const ghostV5Chat = [chat[0], { ...chat[1], mes: 'assistant-0-C' }];

    const activeV4 = legacyChatLineageV4(chat);
    const altV4Chat = [chat[0], {
        ...chat[1],
        mes: 'assistant-0-A',
        send_date: 'assistant-date-0-A',
        extra: { gen_id: 'generation-0-A' },
    }];
    const altV4 = legacyChatLineageV4(altV4Chat);
    const ghostV4Chat = [chat[0], {
        ...chat[1],
        mes: 'assistant-0-C',
        send_date: 'assistant-date-0-C',
        extra: { gen_id: 'generation-0-C' },
    }];
    const ghostV4 = legacyChatLineageV4(ghostV4Chat);

    const state = makeState();
    state.branchLineageVersion = 4;
    state.lineage = activeV4;
    const snapshot = snapshotBranchState(state);
    state.checkpoints = [
        checkpointFor(activeV4, 1, snapshot, 1, 'active-v4'),
        checkpointFor(altV4, 1, snapshot, 2, 'swipe-v4'),
        checkpointFor(ghostV4, 1, snapshot, 3, 'ghost-v4'),
    ];

    migrateLegacyBranchState(state, chat);
    const migratedKeys = state.checkpoints.map(item => item.lineageKey);
    assert.equal(state.branchLineageVersion, BRANCH_LINEAGE_VERSION);
    assert.equal(state.checkpoints.length, 2);
    assert.ok(migratedKeys.includes(lineageCheckpointKey(activeV5, 1)));
    assert.ok(migratedKeys.includes(lineageCheckpointKey(altV5, 1)));
    assert.equal(migratedKeys.includes(lineageCheckpointKey(chatLineage(ghostV5Chat), 1)), false);
    assert.equal(new Set(migratedKeys).size, 2, 'active and swipe siblings must not collapse onto one v5 key');
});

test('v1.0.12 keeps multi-megabyte active checkpoints that exceeded the former 2 MB pool', () => {
    const state = makeState();
    state.npcs[0].background = `large-dossier:${'x'.repeat(900_000)}`;
    let chat = [user(0)];
    state.lineage = chatLineage(chat);
    ensureRollbackJournalBaseline(state, state.lineage);

    for (let turn = 0; turn < 3; turn += 1) {
        if (turn > 0) {
            chat.push(user(turn));
            state.lineage = chatLineage(chat);
        }
        chat.push(bot(turn, 'A'));
        state.turn += 1;
        recordBranchCheckpoint(state, chat, chat.length - 1, 'scan');
    }

    const bytes = state.checkpoints.reduce((sum, item) => sum + JSON.stringify(item.snapshot || {}).length + 256, 0);
    assert.equal(state.checkpoints.length, 3);
    assert.ok(bytes > 2_000_000, 'regression must exceed the former aggregate budget');
    assert.ok(bytes <= BRANCH_SNAPSHOT_BUDGET_BYTES);
    assert.ok(state.checkpoints.every(item => JSON.stringify(item.snapshot || {}).length + 256 < BRANCH_SNAPSHOT_MAX_BYTES));
});

test('v1.0.12 compaction defers while a destructive lineage divergence is unresolved', () => {
    const original = [user(0), bot(0, 'A')];
    const changed = [original[0], bot(0, 'B')];
    const state = makeState();
    state.lineage = chatLineage(original);
    const snapshot = snapshotBranchState(state);
    state.checkpoints = [checkpointFor(state.lineage, 1, snapshot, 0, 'current-before-divergence')];

    const before = structuredClone(state.checkpoints);
    const result = compactLegacyBranchHistory(state, changed);
    assert.equal(result.deferred, true);
    assert.equal(state.branchHistoryCompactionVersion, 0);
    assert.deepEqual(state.checkpoints, before);
});
