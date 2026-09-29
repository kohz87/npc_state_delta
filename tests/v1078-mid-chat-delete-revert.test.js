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
    assert.deepEqual(result.deletedEffects.reverted.map(item => item.name), ['Elena']);
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
    assert.deepEqual(blocked.deletedEffects.reverted.filter(item => item.fields.includes('relationship')), []);
    assert.equal(elenaOf(blocked).relationship.trust, 22, 'canonical state is kept when a retained message also changed it');

    const manual = makeState();
    const manualChat = [];
    play(manual, manualChat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id);
        if (n === 5) { s.npcs[0].relationship = { trust: 50, affection: 10, desire: 0, tension: 0 }; s.npcs[0].lastRelationshipChange = { impact: 'manual', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: {}, reason: 'manual edit', sourceMessageId: id }; }
    });
    const kept = deleteMiddle(manual, manualChat, 5);
    assert.deepEqual(kept.deletedEffects.reverted.filter(item => item.fields.includes('relationship')), []);
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
    assert.deepEqual(result.deletedEffects.reverted, []);
});

test('v1.0.78 the journal alone or the checkpoints alone are enough; with neither nothing changes', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const checkpointsOnly = structuredClone(state);
    checkpointsOnly.rollbackJournalFloorMessageId = chat.length; // the journal no longer reaches back this far
    assert.deepEqual(deleteMiddle(checkpointsOnly, chat, 5).deletedEffects.reverted.map(item => item.name), ['Elena'], 'retained checkpoints are the fallback');
    const journalOnly = structuredClone(state);
    journalOnly.checkpoints = [];
    assert.deepEqual(deleteMiddle(journalOnly, chat, 5).deletedEffects.reverted.map(item => item.name), ['Elena'], 'the rollback journal covers pruned checkpoints');
    const neither = structuredClone(state);
    neither.checkpoints = [];
    neither.rollbackJournalFloorMessageId = chat.length;
    const result = deleteMiddle(neither, chat, 5);
    assert.deepEqual(result.deletedEffects.reverted, []);
    assert.equal(elenaOf(result).relationship.trust, 21);
});

test('v1.0.78 two separate deletions are not one contiguous block', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const scattered = chat.filter((_, i) => i !== 5 && i !== 9);
    const result = reconcileBranchState(structuredClone(state), scattered, { explicitDivergence: 5, operation: 'delete' });
    assert.deepEqual(result.deletedEffects.reverted, []);
    assert.equal(elenaOf(result).relationship.trust, 21);
});

test('v1.0.78 a tail deletion is unchanged: it restores exactly and reports no separate reversion', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 3, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const result = reconcileBranchState(state, chat.slice(0, -1), { explicitDivergence: chat.length - 1, operation: 'delete' });
    assert.equal(result.failClosed, false);
    assert.deepEqual(result.deletedEffects.reverted, []);
    assert.equal(elenaOf(result).relationship.trust, 20);
});

test('v1.0.78 everything the deleted message changed is reverted, and only that', () => {
    const state = makeState();
    state.npcs[0].mood = 'calm';
    state.npcs[0].goal = 'keep the inn';
    state.npcs[0].memories = ['Opened the inn'];
    state.npcs[0].appearance = 'Plain linen smock';
    state.npcs[0].overallAppearance = 'Slim, raven hair';
    const chat = [];
    play(state, chat, 6, (s, n) => {
        const elena = s.npcs[0];
        if (n === 3) {
            elena.mood = 'shaken';
            elena.goal = 'flee Farwick';
            elena.memories = [...elena.memories, 'Killed a man for the first time'];
            elena.mannerisms = ['Wrings her hands'];
            elena.appearance = 'Blood-spattered smock';
            elena.location = 'Market square';
            elena.profileEvidence = { ...elena.profileEvidence, mannerisms: ['wrings hands after the killing'] };
        }
        if (n === 5) {
            elena.goal = 'reach the northern road';
            elena.memories = [...elena.memories, 'Left Farwick at dawn'];
        }
    });
    const result = deleteMiddle(state, chat, 5);
    const elena = elenaOf(result);
    assert.equal(elena.mood, 'calm');
    assert.equal(elena.location, createNpcRecord('X').location, 'a field only the deleted scan set returns to its earlier value');
    assert.equal(elena.appearance, 'Plain linen smock');
    assert.deepEqual(elena.mannerisms, []);
    assert.deepEqual(elena.profileEvidence.mannerisms, []);
    assert.equal(elena.goal, 'reach the northern road', 'a field a retained message also changed is kept');
    assert.deepEqual(elena.memories, ['Opened the inn', 'Left Farwick at dawn'], 'only the memory the deleted message added is dropped');
    const row = result.deletedEffects.reverted.find(item => item.name === 'Elena');
    assert.ok(row.fields.includes('mood') && row.fields.includes('appearance') && !row.fields.includes('goal'));
});

test('v1.0.78 grouped fields revert together or not at all', () => {
    const state = makeState();
    state.npcs[0].overallAppearance = 'Slim, raven hair';
    state.npcs[0].appearance = 'Plain smock';
    const chat = [];
    play(state, chat, 6, (s, n) => {
        const elena = s.npcs[0];
        if (n === 3) { elena.appearance = 'Torn smock'; elena.overallAppearance = 'Slim, raven hair, scar on the cheek'; }
        if (n === 5) elena.appearance = 'Fresh wool coat';
    });
    const elena = elenaOf(deleteMiddle(state, chat, 5));
    assert.equal(elena.appearance, 'Fresh wool coat');
    assert.equal(elena.overallAppearance, 'Slim, raven hair, scar on the cheek', 'a later change to one member keeps the whole group as it is');
});

test('v1.0.78 an NPC introduced by the deleted message is removed with its bonds, unless a later message used them', () => {
    const state = makeState();
    const chat = [];
    let added;
    play(state, chat, 6, (s, n) => {
        if (n === 3) {
            added = createNpcRecord('Krey');
            added.goal = 'sell a mule';
            s.npcs.push(added);
            s.npcs[0].keyRelationships = ['Krey — buyer | haggled with her'];
            s.socialGraph.edges.push({ id: 'edge_elena_krey', aId: s.npcs[0].id, bId: added.id, aToB: 'friend', bToA: 'friend', confidence: 'explicit', provenance: 'scanner' });
            s.candidates.push({ name: 'Stranger', reason: 'seen once' });
        }
    });
    const removed = deleteMiddle(structuredClone(state), chat, 5);
    assert.deepEqual(removed.deletedEffects.removed.map(item => item.name), ['Krey']);
    assert.equal(removed.state.npcs.some(npc => npc.name === 'Krey'), false);
    assert.deepEqual(elenaOf(removed).keyRelationships, []);
    assert.equal(removed.state.socialGraph.edges.length, 0);
    assert.equal(removed.state.candidates.some(item => item.name === 'Stranger'), false);

    const used = structuredClone(state);
    used.npcs.find(npc => npc.name === 'Krey').goal = 'buy a horse'; // a later scan updated Krey
    const keptState = structuredClone(used);
    const kept = deleteMiddle(keptState, chat, 5);
    assert.deepEqual(kept.deletedEffects.removed, []);
    assert.equal(kept.state.npcs.some(npc => npc.name === 'Krey'), true);
});

test('v1.0.78 a death the deleted message caused is undone; an earlier or later death stays', () => {
    const state = makeState();
    const chat = [];
    const die = npc => { npc.lifeState = 'deceased'; npc.lifeStateCertainty = 'explicit'; npc.lifeStateReason = 'killed'; npc.archived = true; npc.archiveReason = 'deceased'; };
    play(state, chat, 6, (s, n) => { if (n === 3) die(s.npcs[1]); });
    const undone = deleteMiddle(structuredClone(state), chat, 5);
    const clara = undone.state.npcs.find(npc => npc.name === 'Clara');
    assert.equal(clara.lifeState, createNpcRecord('X').lifeState);
    assert.equal(clara.archived, false);

    const earlier = makeState();
    die(earlier.npcs[1]);
    const earlierChat = [];
    play(earlier, earlierChat, 6, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    assert.equal(deleteMiddle(earlier, earlierChat, 5).state.npcs.find(npc => npc.name === 'Clara').lifeState, 'deceased');
});

const deleteMiddleRewinding = (state, chat, index) => reconcileBranchState(state, chat.filter((_, i) => i !== index), { explicitDivergence: index, operation: 'delete', rewindMidDelete: true });

test('v1.0.78 the rewind option restores every dossier to just before the deleted message and drops later changes', () => {
    const state = makeState();
    state.npcs[0].goal = 'keep the inn';
    state.npcs[0].memories = ['Opened the inn'];
    const chat = [];
    play(state, chat, 6, (s, n, id) => {
        const elena = s.npcs[0];
        if (n === 3) { award(elena, s.turn, id); elena.mood = 'shaken'; }
        if (n === 5) {
            elena.goal = 'reach the northern road';
            elena.memories = [...elena.memories, 'Left Farwick at dawn'];
            const late = createNpcRecord('Harl');
            s.npcs.push(late);
        }
    });
    const undoOnly = deleteMiddle(structuredClone(state), chat, 5);
    assert.equal(elenaOf(undoOnly).goal, 'reach the northern road', 'the default keeps later changes');
    assert.equal(undoOnly.rewoundToBoundary, false);

    const rewound = deleteMiddleRewinding(structuredClone(state), chat, 5);
    assert.equal(rewound.rewoundToBoundary, true);
    assert.equal(rewound.failClosed, false);
    assert.equal(rewound.requiresRescan, false, 'the rewind uses no model requests');
    const elena = elenaOf(rewound);
    assert.equal(elena.goal, 'keep the inn');
    assert.deepEqual(elena.memories, ['Opened the inn']);
    assert.equal(elena.mood, createNpcRecord('X').mood);
    assert.deepEqual(elena.relationship, { trust: 20, affection: 10, desire: 0, tension: 0 });
    assert.equal(rewound.state.npcs.some(npc => npc.name === 'Harl'), false, 'an NPC a later message introduced is gone too');
    assert.ok(rewound.state.checkpoints.every(checkpoint => checkpoint.messageId < 5), 'later checkpoints describe a state that no longer exists');
});

test('v1.0.78 the rewind option falls back to undoing only the deleted message when the boundary is unreachable', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n, id) => {
        if (n === 3) award(s.npcs[0], s.turn, id);
        if (n === 5) s.npcs[0].goal = 'reach the northern road';
    });
    state.rollbackJournalFloorMessageId = chat.length;
    state.checkpoints = [];
    const result = deleteMiddleRewinding(state, chat, 5);
    assert.equal(result.rewoundToBoundary, false);
    assert.equal(result.failClosed, true);
    assert.equal(elenaOf(result).goal, 'reach the northern road');
});

test('v1.0.78 the rewind option never applies to swipes, edits or tail deletions', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 3, (s, n, id) => { if (n === 3) award(s.npcs[0], s.turn, id); });
    const tail = reconcileBranchState(state, chat.slice(0, -1), { explicitDivergence: chat.length - 1, operation: 'delete', rewindMidDelete: true });
    assert.equal(tail.rewoundToBoundary, false);
    assert.equal(elenaOf(tail).relationship.trust, 20);
});
