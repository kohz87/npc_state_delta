import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord } from '../core.js';
import {
    applyManualKeyRelationshipEdit,
    canonicalizeNpcKeyRelationships,
    normalizeSocialGraph,
    parseKeyRelationshipEntry,
    reconcileSocialState,
} from '../social.js';

function stateWith(...npcs) {
    return { npcs, candidates: [], dismissed: [], socialGraph: normalizeSocialGraph(), turn: 1 };
}

const staleDynamic = 'clings to her side, squabbling childishly over food while drawing security and courage from her steady presence';

test('v1.0.5 canonicalizes semicolon bond dynamics and removes a subsumed orphan line', () => {
    const sora = createNpcRecord('Sora');
    const ryu = createNpcRecord('Ryu', [sora.id]);
    sora.keyRelationships = [
        staleDynamic,
        `Ryu — Chimeric twin sister; ${staleDynamic}.`,
    ];

    canonicalizeNpcKeyRelationships([sora, ryu]);

    assert.deepEqual(sora.keyRelationships, [
        `Ryu — Chimeric twin sister | ${staleDynamic}.`,
    ]);
    const parsed = parseKeyRelationshipEntry(sora.keyRelationships[0]);
    assert.equal(parsed?.relation, 'Chimeric twin sister');
    assert.equal(parsed?.dynamic, `${staleDynamic}.`);
});

test('v1.0.5 manual same-counterpart rewrite replaces stale graph prose instead of enriching it back', () => {
    const sora = createNpcRecord('Sora');
    const ryu = createNpcRecord('Ryu', [sora.id]);
    sora.keyRelationships = [`Ryu — Chimeric twin sister | ${staleDynamic}.`];
    ryu.keyRelationships = ['Sora — Chimeric twin sister | quietly protective when Sora is uncertain'];
    let state = stateWith(sora, ryu);
    state.socialGraph = normalizeSocialGraph({
        edges: [{
            aId: sora.id,
            bId: ryu.id,
            aToB: 'Chimeric twin sister',
            bToA: 'twin sibling',
            aDynamic: staleDynamic,
            bDynamic: 'quietly protective when Sora is uncertain',
            provenance: 'scanner',
            confidence: 'explicit',
        }],
    });

    const before = [...sora.keyRelationships];
    sora.keyRelationships = ['Ryu — Chimeric twin sister | trusts her judgment but argues over small things'];
    applyManualKeyRelationshipEdit(state, sora.id, before, sora.keyRelationships, { turn: 2, sourceMessageId: 9 });
    state = reconcileSocialState(state, { provenance: 'manual', confidence: 'manual', turn: 2, sourceMessageId: 9 }).state;

    const savedSora = state.npcs.find(npc => npc.id === sora.id);
    const savedRyu = state.npcs.find(npc => npc.id === ryu.id);
    assert.deepEqual(savedSora.keyRelationships, [
        'Ryu — Chimeric twin sister | trusts her judgment but argues over small things',
    ]);
    assert.doesNotMatch(savedSora.keyRelationships.join(' '), /drawing security and courage/i);
    assert.match(savedRyu.keyRelationships.join(' '), /quietly protective when Sora is uncertain/i);

    const edge = state.socialGraph.edges.find(item => [item.aId, item.bId].includes(sora.id) && [item.aId, item.bId].includes(ryu.id));
    assert.ok(edge);
    const ownerDynamic = edge.aId === sora.id ? edge.aDynamic : edge.bDynamic;
    assert.equal(ownerDynamic, 'trusts her judgment but argues over small things');
});
