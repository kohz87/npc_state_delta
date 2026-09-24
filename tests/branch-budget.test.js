import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    BRANCH_SNAPSHOT_MAX_BYTES,
    chatLineage,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
} from '../branch.js';

const user = turn => ({ is_user: true, is_system: false, name: 'User', mes: `user-${turn}` });
const bot = turn => ({ is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${turn}` });

function makeState() {
    const npc = createNpcRecord('Seren Lowen');
    npc.goal = 'baseline';
    const state = {
        npcs: [npc], candidates: [], pendingBackfills: [],
        socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0,
        checkpoints: [], inlineCards: [], lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION,
        branchRootSnapshot: null, portraitAssets: {}, userDismissedGroups: [],
        rollbackJournal: [], rollbackJournalSequence: 0,
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

test('current branch checkpoint storage limits remain explicit', () => {
    assert.equal(BRANCH_SNAPSHOT_BUDGET_BYTES, 8_000_000);
    assert.equal(BRANCH_SNAPSHOT_MAX_BYTES, 2_000_000);
});

test('current branch engine keeps multi-megabyte active checkpoint history within budget', () => {
    const state = makeState();
    state.npcs[0].background = `large-dossier:${'x'.repeat(900_000)}`;
    const chat = [user(0)];
    state.lineage = chatLineage(chat);
    ensureRollbackJournalBaseline(state, state.lineage);

    for (let turn = 0; turn < 3; turn += 1) {
        if (turn > 0) {
            chat.push(user(turn));
            state.lineage = chatLineage(chat);
        }
        chat.push(bot(turn));
        state.turn += 1;
        recordBranchCheckpoint(state, chat, chat.length - 1, 'scan');
    }

    const bytes = state.checkpoints.reduce((sum, item) => sum + JSON.stringify(item.snapshot || {}).length + 256, 0);
    assert.equal(state.checkpoints.length, 3);
    assert.ok(bytes > 2_000_000);
    assert.ok(bytes <= BRANCH_SNAPSHOT_BUDGET_BYTES);
    assert.ok(state.checkpoints.every(item => JSON.stringify(item.snapshot || {}).length + 256 < BRANCH_SNAPSHOT_MAX_BYTES));
});
