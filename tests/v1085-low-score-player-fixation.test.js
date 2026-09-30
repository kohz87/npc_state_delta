import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjection, createNpcRecord, mergeScanResult, relationshipSummaryConsistent } from '../core.js';

const elena = (relationship = { trust: 15, affection: 11, desire: 6, tension: 0 }) => {
    const npc = createNpcRecord('Elena');
    npc.present = true;
    npc.personality = 'Guarded and quiet.';
    npc.mood = 'Overwhelmed, breathless, awe-struck, devoted';
    npc.relationship = relationship;
    return npc;
};
const FIXATED = 'Views Noc as her chosen partner, protector, and provider, devotedly caring for his needs.';

test('obligation and fixation summaries need established trust or affection', () => {
    const low = { trust: 15, affection: 11, desire: 0, tension: 0 };
    for (const summary of [FIXATED, 'Feels she must repay him for everything.', 'Believes only he can save the inn.', 'Will follow him anywhere.']) {
        assert.equal(relationshipSummaryConsistent(summary, low), false, summary);
    }
    assert.equal(relationshipSummaryConsistent('Grateful for his help with the inn and warming to him.', low), true, 'ordinary warmth still passes');
    assert.equal(relationshipSummaryConsistent(FIXATED.replace(/devotedly /, ''), { trust: 55, affection: 60, desire: 0, tension: 0 }), true, 'depth that the scores back up is allowed');
});

test('a fixated summary from a scan is not stored at low scores', () => {
    const scan = summary => {
        const npc = elena();
        npc.id = 'npc_elena';
        return mergeScanResult({ npcs: [npc], candidates: [], turn: 5 }, { npcs: [{ id: 'npc_elena', name: 'Elena', relationshipSummary: summary }] },
            { developmentContext: 'Elena calls Noc her chosen partner, protector and provider, grateful for his help with the inn.' }).state.npcs[0].relationshipSummary;
    };
    assert.equal(scan(FIXATED), '');
    assert.equal(scan('Grateful for his help with the inn.'), 'Grateful for his help with the inn.', 'an ordinary first summary is still stored');
});

test('the roleplay injection drops stance moods and adds the low-score rule only when it applies', () => {
    const npc = elena();
    npc.relationshipSummary = FIXATED;
    const low = buildInjection([npc], 'Elena', 10);
    assert.match(low, /mood: Overwhelmed, breathless, awe-struck;/);
    assert.doesNotMatch(low, /devoted|chosen partner/);
    assert.match(low, /LOW SCORES: the player is not uniquely important/);
    const high = buildInjection([elena({ trust: 60, affection: 72, desire: 0, tension: 0 })], 'Elena', 10);
    assert.match(high, /mood: Overwhelmed, breathless, awe-struck, devoted/, 'established affection keeps the mood as written');
    assert.doesNotMatch(high, /LOW SCORES/);
});
