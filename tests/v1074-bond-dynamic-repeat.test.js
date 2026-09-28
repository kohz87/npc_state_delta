import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, mergeScanResult } from '../core.js';
import { normalizeSocialGraph, reconcileSocialState } from '../social.js';

const SCOLDING = 'endures her harsh scolding and abuse in submissive silence';
const SERVITUDE = 'trapped under her control and subjected to harsh servitude';

function cast() {
    const linnea = createNpcRecord('Linnea');
    const clara = createNpcRecord('Clara');
    const vena = createNpcRecord('Vena');
    linnea.keyRelationships = [`Clara — cousin | ${SCOLDING}`, `Vena — aunt | ${SERVITUDE}`];
    return { linnea, clara, vena };
}

test('v1.0.74 a dynamic folded into an edge relation is not printed twice in Important Bonds', () => {
    const { linnea, clara, vena } = cast();
    const state = {
        npcs: [linnea, clara, vena],
        socialGraph: { edges: [
            { aId: linnea.id, bId: clara.id, aToB: `cousin | ${SCOLDING}`, bToA: 'cousin', aDynamic: SCOLDING, confidence: 'explicit', provenance: 'scanner' },
            { aId: linnea.id, bId: vena.id, aToB: `aunt | ${SERVITUDE}`, bToA: 'niece', aDynamic: SERVITUDE, confidence: 'explicit', provenance: 'scanner' },
        ] },
    };
    for (let i = 0; i < 3; i += 1) reconcileSocialState(state, { provenance: 'scanner' });
    assert.deepEqual(linnea.keyRelationships.slice().sort(), [`Clara — cousin | ${SCOLDING}`, `Vena — aunt | ${SERVITUDE}`]);
    for (const edge of state.socialGraph.edges) assert.doesNotMatch(edge.aToB, /\|/, 'the graph relation holds only the relation');
});

test('v1.0.74 a scanner edge that repeats its dynamic inside the relation stays single through repeated scans', () => {
    const { linnea, clara, vena } = cast();
    let state = { npcs: [linnea, clara, vena], candidates: [], turn: 5 };
    const scan = { npcs: [], keyRelationshipEdges: [
        { aId: linnea.id, a: 'Linnea', bId: clara.id, b: 'Clara', aToB: `cousin | ${SCOLDING}`, bToA: 'cousin', aDynamic: SCOLDING, reason: 'Clara scolds Linnea' },
        { aId: linnea.id, a: 'Linnea', bId: vena.id, b: 'Vena', aToB: `aunt | ${SERVITUDE}`, bToA: 'niece', aDynamic: SERVITUDE, reason: 'Vena, her aunt, controls Linnea' },
    ] };
    for (let i = 0; i < 3; i += 1) {
        state = mergeScanResult(state, scan, { turn: 6 + i, sourceMessageId: 10 + i }).state;
    }
    const bonds = state.npcs.find(npc => npc.name === 'Linnea').keyRelationships;
    for (const bond of bonds) assert.equal(bond.split('|').length, 2, `one dynamic per bond: ${bond}`);
    assert.ok(bonds.some(bond => bond === `Clara — cousin | ${SCOLDING}`));
    assert.ok(bonds.some(bond => bond === `Vena — aunt | ${SERVITUDE}`), 'a specific relation is not widened to its neutral inverse');
    assert.deepEqual(state.npcs.find(npc => npc.name === 'Vena').keyRelationships, ['Linnea — niece']);
});

test('v1.0.74 stored graphs with a folded relation are repaired on load without losing the dynamic', () => {
    const graph = normalizeSocialGraph({ edges: [{ aId: 'npc_a', bId: 'npc_b', aToB: `cousin | ${SCOLDING}`, bToA: 'cousin', confidence: 'explicit' }] });
    assert.equal(graph.edges[0].aToB, 'cousin');
    assert.equal(graph.edges[0].aDynamic, SCOLDING);
});
