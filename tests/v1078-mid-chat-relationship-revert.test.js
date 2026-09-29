import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    chatLineage,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';

const user = turn => ({ is_user: true, is_system: false, name: 'User', mes: `user-${turn}`, send_date: `ud-${turn}` });
const bot = turn => ({ is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${turn}`, send_date: `ad-${turn}`, extra: { gen_id: `g-${turn}` } });

function makeState() {
    const elena = createNpcRecord('Elena');
    elena.relationship = { trust: 20, affection: 10, desire: 0, tension: 0 };
    elena.relationshipSummary = 'Warming toward Noc.';
    const clara = createNpcRecord('Clara');
    clara.relationship = { trust: 5, affection: 5, desire: 0, tension: 0 };
    const state = {
        npcs: [elena, clara], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [],
        lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

function award(npc, turn, messageId, { trust = 1, affection = 1, reason = 'comfort', summary = null } = {}) {
    npc.relationship = { ...npc.relationship, trust: npc.relationship.trust + trust, affection: npc.relationship.affection + affection };
    const event = { impact: 'meaningful', delta: { trust, affection, desire: 0, tension: 0 }, evidence: { trust: 'x', affection: 'y', desire: '', tension: '' }, reason, sourceMessageId: messageId, turn };
    npc.relationshipEventHistory = [...npc.relationshipEventHistory, event];
    npc.lastRelationshipChange = event;
    if (summary) npc.relationshipSummary = summary;
}

// Exchange `n` is scanned; `change(state, n, messageId)` may mutate dossiers as that scan.
function play(state, chat, count, change = () => {}) {
    for (let i = 1; i <= count; i += 1) {
        chat.push(user(i), bot(i));
        const messageId = chat.length - 1;
        ensureBranchParentAnchor(state, chat, messageId, 'assistant-parent');
        state.turn += 1;
        change(state, i, messageId);
        recordBranchCheckpoint(state, chat, messageId, 'scan');
    }
}

const deleteMiddle = (state, chat, index) => reconcileBranchState(state, chat.filter((_, i) => i !== index), { explicitDivergence: index, operation: 'delete' });
const elenaOf = result => result.state.npcs.find(npc => npc.name === 'Elena');

test('v1.0.78 deleting a middle message reverts the relationship change it caused', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id, { summary: 'Devoted to Noc.' }); });
    assert.equal(state.npcs[0].relationship.trust, 21);
    const result = deleteMiddle(state, chat, 5);
    assert.equal(result.failClosed, true, 'the retained descendants are still not replayed');
    assert.deepEqual(result.relationshipReverted.map(item => item.name), ['Elena']);
    const elena = elenaOf(result);
    assert.deepEqual(elena.relationship, { trust: 20, affection: 10, desire: 0, tension: 0 });
    assert.equal(elena.relationshipEventHistory.length, 0);
    assert.equal(elena.lastRelationshipChange?.reason || '', '');
    assert.equal(elena.relationshipSummary, 'Warming toward Noc.', 'an untouched summary written by the deleted scan is restored too');
    assert.deepEqual(result.state.npcs.find(npc => npc.name === 'Clara').relationship, { trust: 5, affection: 5, desire: 0, tension: 0 }, 'unrelated NPCs are untouched');
});

test('v1.0.78 the previous accepted event returns to the card when the deleted one was later', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => {
        if (n === 2) award(s.npcs[0], s.turn, id, { reason: 'shared a meal' });
        if (n === 4) award(s.npcs[0], s.turn, id, { reason: 'grounding comfort' });
    });
    const result = deleteMiddle(state, chat, 7);
    const elena = elenaOf(result);
    assert.equal(elena.lastRelationshipChange.reason, 'shared a meal');
    assert.equal(elena.relationship.trust, 21);
    assert.equal(elena.relationshipEventHistory.length, 1);
});

test('v1.0.78 a later retained relationship change or manual edit blocks the reversion', () => {
    const later = makeState();
    const chat = [];
    play(later, chat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id, { reason: 'comfort' });
        if (n === 5) award(s.npcs[0], s.turn, id, { reason: 'shared a meal' });
    });
    const blocked = deleteMiddle(later, chat, 5);
    assert.deepEqual(blocked.relationshipReverted, []);
    assert.equal(elenaOf(blocked).relationship.trust, 22, 'canonical state is kept when a retained message also changed it');

    const manual = makeState();
    const manualChat = [];
    play(manual, manualChat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id);
        if (n === 5) { s.npcs[0].relationship = { trust: 50, affection: 10, desire: 0, tension: 0 }; s.npcs[0].lastRelationshipChange = { impact: 'manual', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: {}, reason: 'manual edit', sourceMessageId: id }; }
    });
    const kept = deleteMiddle(manual, manualChat, 5);
    assert.deepEqual(kept.relationshipReverted, []);
    assert.equal(elenaOf(kept).relationship.trust, 50);
});

test('v1.0.78 a locked or later-edited relationship summary is not reverted', () => {
    const locked = makeState();
    locked.npcs[0].manualProfileFields = ['relationshipSummary'];
    const chat = [];
    play(locked, chat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id, { summary: 'My own words.' }); });
    const result = deleteMiddle(locked, chat, 5);
    assert.equal(elenaOf(result).relationship.trust, 20);
    assert.equal(elenaOf(result).relationshipSummary, 'My own words.');

    const edited = makeState();
    const editedChat = [];
    play(edited, editedChat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id, { summary: 'Devoted to Noc.' });
        if (n === 5) s.npcs[0].relationshipSummary = 'Later rewritten.';
    });
    const kept = deleteMiddle(edited, editedChat, 5);
    assert.equal(elenaOf(kept).relationship.trust, 20);
    assert.equal(elenaOf(kept).relationshipSummary, 'Later rewritten.');
});

test('v1.0.78 confirmed-dead NPCs keep their terminal relationship record', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id);
        if (n === 4) { s.npcs[0].lifeState = 'deceased'; s.npcs[0].lifeStateCertainty = 'explicit'; s.npcs[0].archived = true; s.npcs[0].archiveReason = 'deceased'; }
    });
    const result = deleteMiddle(state, chat, 5);
    assert.deepEqual(result.relationshipReverted, []);
});

test('v1.0.78 nothing changes without both boundary checkpoints or for scattered deletions', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const pruned = structuredClone(state);
    pruned.checkpoints = pruned.checkpoints.filter(item => item.messageId !== 5);
    assert.deepEqual(deleteMiddle(pruned, chat, 5).relationshipReverted, [], 'without the deleted scan checkpoint the state cannot be compared');
    const scattered = chat.filter((_, i) => i !== 5 && i !== 9);
    const result = reconcileBranchState(structuredClone(state), scattered, { explicitDivergence: 5, operation: 'delete' });
    assert.deepEqual(result.relationshipReverted, [], 'two separate deletions are not one contiguous block');
    assert.equal(elenaOf(result).relationship.trust, 21);
});

test('v1.0.78 a tail deletion is unchanged: it restores exactly and reports no separate reversion', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 3, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const result = reconcileBranchState(state, chat.slice(0, -1), { explicitDivergence: chat.length - 1, operation: 'delete' });
    assert.equal(result.failClosed, false);
    assert.deepEqual(result.relationshipReverted, []);
    assert.equal(elenaOf(result).relationship.trust, 20);
});
