import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    applyManualKeyRelationshipEdit,
    normalizeSocialGraph,
    reconcileSocialState,
} from '../social.js';

function stateWith(...npcs) {
    return { npcs, candidates: [], dismissed: [], socialGraph: normalizeSocialGraph(), turn: 1 };
}

const corruptedHildeBond = "Mistress Hilde — Host / Caretaker | Grudgingly accommodated while vehemently protesting separation from Lucien. / Guildmaster's wife who treats her to honey buns and admires her demure manners. / w | Grudgingly accommodated while vehemently protesting separation from Lucien. / Guildmaster's wife who treats her to honey buns and admires her demure manners. / w | Grudgingly accommodated while vehemently protesting sepa";

test('v1.0.14 repeated malformed Important Bond fragments canonicalize once and stay idempotent', () => {
    const sora = createNpcRecord('Sora');
    const hilde = createNpcRecord('Mistress Hilde', [sora.id]);
    sora.keyRelationships = [corruptedHildeBond];

    let state = reconcileSocialState(stateWith(sora, hilde), { provenance: 'migration', confidence: 'migration' }).state;
    const first = state.npcs.find(npc => npc.id === sora.id).keyRelationships[0];

    assert.equal((first.match(/\|/g) || []).length, 1, 'canonical bond must contain only one structural pipe');
    assert.match(first, /^Mistress Hilde — Host \/ Caretaker \| /);
    assert.equal((first.match(/Grudgingly accommodated/gi) || []).length, 1);
    assert.equal((first.match(/Guildmaster's wife/gi) || []).length, 1);
    assert.doesNotMatch(first, /(?:^|[;|/]\s*)w(?:\s*[;|/]|$)/i);

    const stable = JSON.stringify(state.npcs.find(npc => npc.id === sora.id).keyRelationships);
    for (let i = 0; i < 6; i += 1) {
        state = reconcileSocialState(state, { provenance: 'migration', confidence: 'migration' }).state;
        assert.equal(JSON.stringify(state.npcs.find(npc => npc.id === sora.id).keyRelationships), stable);
    }
});

test('v1.0.14 manual Important Bond deletion removes mirrored graph projection and survives reconciliation', () => {
    const sora = createNpcRecord('Sora');
    const hilde = createNpcRecord('Mistress Hilde', [sora.id]);
    sora.keyRelationships = [corruptedHildeBond];
    hilde.keyRelationships = ['Sora — Guest / Ward | Treats her to honey buns and watches over her while Lucien is away.'];

    let state = reconcileSocialState(stateWith(sora, hilde), { provenance: 'migration', confidence: 'migration' }).state;
    const savedSora = state.npcs.find(npc => npc.id === sora.id);
    const before = [...savedSora.keyRelationships];
    savedSora.keyRelationships = [];

    applyManualKeyRelationshipEdit(state, sora.id, before, [], { sourceMessageId: 125, turn: 63 });
    state = reconcileSocialState(state, { provenance: 'manual', confidence: 'manual', sourceMessageId: 125, turn: 63 }).state;

    const afterSora = state.npcs.find(npc => npc.id === sora.id);
    const afterHilde = state.npcs.find(npc => npc.id === hilde.id);
    assert.equal(afterSora.keyRelationships.some(entry => /Mistress Hilde/i.test(entry)), false);
    assert.equal(afterHilde.keyRelationships.some(entry => /\bSora\b/i.test(entry)), false);
    assert.equal(state.socialGraph.edges.some(edge => [edge.aId, edge.bId].includes(sora.id) && [edge.aId, edge.bId].includes(hilde.id)), false);

    state = reconcileSocialState(state, { provenance: 'scanner', confidence: 'strong-context' }).state;
    assert.equal(state.npcs.find(npc => npc.id === sora.id).keyRelationships.some(entry => /Mistress Hilde/i.test(entry)), false);
    assert.equal(state.socialGraph.edges.some(edge => [edge.aId, edge.bId].includes(sora.id) && [edge.aId, edge.bId].includes(hilde.id)), false);
});
