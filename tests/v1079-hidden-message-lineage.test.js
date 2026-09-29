import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    fingerprintMessage,
    legacySystemFingerprint,
    lineageCheckpointKeys,
    migrateLegacyLineage,
    reconcileBranchState,
    recordBranchCheckpoint,
    remapLineageKeys,
} from '../branch.js';

const user = turn => ({ is_user: true, is_system: false, name: 'User', mes: `user-${turn}`, send_date: `ud-${turn}` });
const bot = turn => ({ is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${turn}`, send_date: `ad-${turn}`, extra: { gen_id: `g-${turn}` } });

function build(exchanges = 20) {
    const npc = createNpcRecord('Elena');
    npc.goal = 'start';
    const state = {
        npcs: [npc], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [], turn: 0,
        assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [], lineage: [],
        branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    const chat = [];
    scan(state, chat, 1, exchanges);
    return { state, chat };
}

function scan(state, chat, from, to) {
    for (let i = from; i <= to; i += 1) {
        chat.push(user(i), bot(i));
        const id = chat.length - 1;
        ensureBranchParentAnchor(state, chat, id, 'assistant-parent');
        state.turn += 1;
        state.npcs[0].goal = `goal-${i}`;
        recordBranchCheckpoint(state, chat, id, 'scan');
    }
}

const hide = (chat, indexes) => indexes.forEach(index => { chat[index].is_system = true; });
const deleteTail = (state, chat, count) => {
    const surviving = chat.slice(0, chat.length - count);
    return reconcileBranchState(state, surviving, { explicitDivergence: surviving.length, operation: 'delete' });
};

test('v1.0.79 hiding or unhiding a message does not change the lineage', () => {
    const message = bot(1);
    const visible = fingerprintMessage(message);
    message.is_system = true;
    assert.equal(fingerprintMessage(message), visible);
    assert.notEqual(legacySystemFingerprint(message), visible, 'the old flag-sensitive value is still computable for migration');
    const chat = [user(1), bot(1), user(2), bot(2)];
    const before = chatLineage(chat);
    hide(chat, [0, 1]);
    assert.deepEqual(chatLineage(chat), before);
});

test('v1.0.79 deleting the tail after earlier messages were hidden still restores exactly', () => {
    const { state, chat } = build();
    hide(chat, [2, 3, 4, 5, 6, 7]); // a memory extension hides summarised messages
    const result = deleteTail(state, chat, 12);
    assert.equal(result.lineageRelation, 'tail-truncation');
    assert.equal(result.failClosed, false);
    assert.equal(result.recoveryAction, 'rollback-journal');
    assert.equal(result.state.npcs[0].goal, 'goal-14');
});

test('v1.0.79 messages hidden between scans do not orphan the later checkpoints', () => {
    const { state, chat } = build(10);
    hide(chat, [0, 1, 2, 3]);
    scan(state, chat, 11, 20);
    hide(chat, [4, 5, 6, 7]);
    const result = deleteTail(state, chat, 8);
    assert.equal(result.failClosed, false);
    assert.equal(result.state.npcs[0].goal, 'goal-16');
    const unhidden = build(10);
    hide(unhidden.chat, [0, 1]);
    scan(unhidden.state, unhidden.chat, 11, 14);
    unhidden.chat[0].is_system = false;
    unhidden.chat[1].is_system = false;
    assert.equal(deleteTail(unhidden.state, unhidden.chat, 4).state.npcs[0].goal, 'goal-12');
});

// Fabricates what earlier versions stored: hidden messages hashed with the system flag set, and
// every stored key chained through those hashes.
function legacyStateFor(state, chat, hiddenIndexes) {
    const current = chatLineage(chat);
    const legacy = current.map((value, index) => (hiddenIndexes.includes(index) ? legacySystemFingerprint(chat[index]) : value));
    remapLineageKeys(state, current, legacy);
    return legacy;
}

test('v1.0.79 a chat saved by an earlier version while messages were hidden is migrated once and then recovers', () => {
    const { state, chat } = build();
    const hiddenIndexes = [2, 3, 4, 5];
    hide(chat, hiddenIndexes);
    const legacy = legacyStateFor(state, chat, hiddenIndexes);
    assert.deepEqual(state.lineage, legacy);
    assert.notDeepEqual(state.lineage, chatLineage(chat));
    const result = deleteTail(state, chat, 12);
    assert.equal(result.lineageRelation, 'tail-truncation', 'the stored flag-sensitive hashes no longer look like a divergence');
    assert.equal(result.failClosed, false);
    assert.equal(result.state.npcs[0].goal, 'goal-14');
    assert.deepEqual(result.state.lineage, chatLineage(chat.slice(0, chat.length - 12)));
});

test('v1.0.79 migration adopts only flag differences and leaves real content changes to reconciliation', () => {
    const { state, chat } = build();
    assert.equal(migrateLegacyLineage(state, chat), false, 'nothing to migrate for a chat stored under the current hash');
    const hiddenIndexes = [2, 3];
    hide(chat, hiddenIndexes);
    legacyStateFor(state, chat, hiddenIndexes);
    const edited = chat.map(message => ({ ...message }));
    edited[10].mes = 'an edited reply';
    const result = reconcileBranchState(state, edited, { explicitDivergence: 10, operation: 'edit' });
    assert.equal(result.divergence, 10, 'the divergence is the edited message, not the hidden ones');
});

test('v1.0.79 stored keys stay consistent after a migration', () => {
    const { state, chat } = build(6);
    hide(chat, [2, 3]);
    legacyStateFor(state, chat, [2, 3]);
    assert.equal(migrateLegacyLineage(state, chat), true);
    const keys = lineageCheckpointKeys(chatLineage(chat));
    assert.ok(state.checkpoints.every(item => keys[item.messageId] === item.lineageKey), 'every checkpoint key matches the chat again');
    assert.ok(state.rollbackJournal.every(entry => keys[entry.messageId] === entry.lineageKey), 'every journal key matches the chat again');
    assert.equal(state.rollbackHead.lineageKey, keys[state.rollbackHead.messageId]);
});

// Gives every stored key the value a version that hashed the flag would have written when only the
// first `cut` currently hidden messages were hidden (progressive hiding by a memory extension).
function eraKeysFor(chat, hidden, cut) {
    const target = chatLineage(chat);
    const legacySet = new Set(hidden.slice(0, cut));
    return {
        lineage: target.map((value, index) => (legacySet.has(index) ? legacySystemFingerprint(chat[index]) : value)),
        keys: lineageCheckpointKeys(target.map((value, index) => (legacySet.has(index) ? legacySystemFingerprint(chat[index]) : value))),
    };
}

test('v1.0.79 history saved across several progressive hides is repaired era by era', () => {
    const { state, chat } = build(20);
    const hidden = [2, 3, 4, 5, 6, 7, 8, 9];
    hide(chat, hidden);
    const cutFor = messageId => (messageId < 12 ? 0 : (messageId < 24 ? 4 : 8));
    const eras = new Map([0, 4, 8].map(cut => [cut, eraKeysFor(chat, hidden, cut)]));
    for (const item of state.checkpoints) {
        const era = eras.get(cutFor(item.messageId));
        item.lineageKey = era.keys[item.messageId];
        item.parentLineageKey = item.messageId > 0 ? era.keys[item.messageId - 1] : 'root';
    }
    for (const entry of state.rollbackJournal) {
        const era = eras.get(cutFor(entry.messageId));
        entry.lineageKey = era.keys[entry.messageId];
        entry.parentLineageKey = entry.messageId > 0 ? era.keys[entry.messageId - 1] : 'root';
    }
    const headEra = eras.get(cutFor(state.rollbackHead.messageId));
    state.rollbackHead.lineageKey = headEra.keys[state.rollbackHead.messageId];
    state.lineage = eras.get(8).lineage;

    const result = deleteTail(state, chat, 24);
    assert.equal(result.lineageRelation, 'tail-truncation');
    assert.equal(result.failClosed, false, 'entries from every earlier era are reachable again');
    assert.ok(['rollback-journal', 'exact-checkpoint'].includes(result.recoveryAction));
    assert.equal(result.state.npcs[0].goal, 'goal-8');
});
