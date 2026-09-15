import test from 'node:test';
import assert from 'node:assert/strict';

import { createNpcRecord, normalizeNpcRecord } from '../core.js';
import {
    compactSocialKeyRelationship,
    reconcileSocialState,
    SOCIAL_DYNAMIC_MAX_CHARS,
    SOCIAL_KEY_RELATIONSHIP_MAX_CHARS,
} from '../social.js';

function npc(id, name) {
    const record = createNpcRecord(name);
    record.id = id;
    record.manual = false;
    record.lifeState = 'alive';
    return record;
}

function assertCleanBoundary(value) {
    assert.ok(value.length <= SOCIAL_KEY_RELATIONSHIP_MAX_CHARS, `bond exceeded ${SOCIAL_KEY_RELATIONSHIP_MAX_CHARS}: ${value.length}`);
    assert.doesNotMatch(value, /(?:\||\/|;)\s*$/);
    assert.doesNotMatch(value, /\b(?:bon|resp)$/i);
}

test('v1.0.18 canonical Important Bonds no longer hard-cut at the former 220-character ceiling', () => {
    const dynamic = Array.from({ length: 27 }, (_, index) => `detail${String(index).padStart(2, '0')}`).join(' ');
    assert.equal(dynamic.length, 242);
    assert.ok(dynamic.length > 220 && dynamic.length <= SOCIAL_DYNAMIC_MAX_CHARS);
    const sora = `Sora — twin sister | ${dynamic}`;
    const record = npc('npc_ryu', 'Ryu');
    record.keyRelationships = [sora];

    const normalized = normalizeNpcRecord(record);
    const bond = normalized.keyRelationships[0];
    assertCleanBoundary(bond);
    assert.ok(bond.length > 220, `expected canonical storage to preserve useful detail beyond 220 chars, got ${bond.length}`);
    assert.ok(bond.endsWith(dynamic), 'expected the complete >220-character dynamic to survive canonical storage');
});

test('v1.0.18 over-budget dynamics drop whole trailing fragments instead of slicing a word', () => {
    const first = 'Stern parish instructor whose high academic and behavioral standards she meticulously exceeds to maintain a spotless public reputation.';
    const second = 'Classroom teacher whose authority she respects because lessons are exacting, predictable, and consistently fair.';
    const third = 'Maintains a private correspondence about advanced examinations and future academic placements that would otherwise overflow the bond budget.';
    const raw = `Sister Morwenna — teacher | ${first}; ${second}; ${third}`;
    const compacted = compactSocialKeyRelationship(raw);

    assertCleanBoundary(compacted);
    assert.ok(compacted.includes(first));
    assert.ok(compacted.includes(second) || !compacted.includes('Classroom teacher'));
    assert.ok(!compacted.endsWith('resp'));
    if (!compacted.includes(third)) assert.doesNotMatch(compacted, /future academic placem/i);
});

test('v1.0.18 a single oversized dynamic is shortened only at a readable boundary', () => {
    const huge = `Seren Lowen — trusted receptionist | ${'Her gentle presence is a steady source of reassurance during crowded guild business and difficult administrative conversations '.repeat(8)}`;
    const compacted = compactSocialKeyRelationship(huge);
    assertCleanBoundary(compacted);
    assert.ok(compacted.length <= SOCIAL_KEY_RELATIONSHIP_MAX_CHARS);
    assert.ok(compacted.endsWith('…') || /[.!?]$/.test(compacted), compacted);
    assert.ok(compacted.includes('Seren Lowen — trusted receptionist'));
});

test('v1.0.18 graph projection uses the same boundary-safe canonical bond representation', () => {
    const owner = npc('npc_owner', 'Ryu');
    const sora = npc('npc_sora', 'Sora');
    const fragments = [
        'Recognizes Sora as her sister after an instinctive confrontation and mutual comfort',
        'Twin hatchling counterpart born from the twin titan eggs and raised beside her',
        'Shares an innate telepathic bond that carries emotion and intent between them',
        'Keeps a separate ceremonial title used only during formal household introductions',
    ];
    const state = { npcs: [owner, sora], socialGraph: { version: 1, edges: [], unresolved: [] } };
    const reconciled = reconcileSocialState(state, {
        provenance: 'scanner',
        turn: 9,
        sourceMessageId: 18,
        scanResult: {
            keyRelationshipEdges: [{
                aId: owner.id,
                bId: sora.id,
                aToB: 'twin sister',
                bToA: 'twin sister',
                aDynamic: fragments.join('; '),
                bDynamic: fragments.join('; '),
                reason: 'explicit twin bond',
            }],
        },
    });
    const bond = reconciled.state.npcs.find(item => item.id === owner.id).keyRelationships[0];
    assertCleanBoundary(bond);
    assert.ok((reconciled.socialGraph.edges[0].aDynamic || '').length <= SOCIAL_DYNAMIC_MAX_CHARS);
    assert.doesNotMatch(reconciled.socialGraph.edges[0].aDynamic || '', /(?:\||\/|;)\s*$/);
});

test('v1.0.18 boundary-safe bond normalization is idempotent, including explicit manual locks', () => {
    const record = npc('npc_hilde_ward', 'Ward');
    record.manualProfileLocksExplicit = true;
    record.manualProfileFields = ['keyRelationships'];
    record.keyRelationships = [
        `Mistress Hilde — guardian / hostess | ${'Respects her maternal authority and relishes her heavy hearty cooking during long household evenings '.repeat(6)}`,
    ];
    const once = normalizeNpcRecord(record);
    const twice = normalizeNpcRecord(once);
    assert.deepEqual(twice.keyRelationships, once.keyRelationships);
    assertCleanBoundary(once.keyRelationships[0]);
}
);
