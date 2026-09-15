import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createNpcRecord,
    mergeScanResult,
    applyStaleNpcLifecycle,
} from '../core.js';
import {
    encodeNpcStateBundle,
    mergeImportedDossierState,
} from '../bundle.js';
import {
    decodeDeltaNativeBundle,
    nativeStateForTarget,
    prepareNativeImport,
} from '../native-transfer.js';
import {
    reconcileSocialState,
    normalizeSocialGraph,
    SOCIAL_GRAPH_EDGE_LIMIT,
} from '../social.js';

function emptyGraph() {
    return { version: 1, edges: [], unresolved: [] };
}

function profileState(npc, update, options = {}) {
    return mergeScanResult({ npcs: [npc], candidates: [], turn: 1 }, {
        npcs: [],
        profileUpdates: [{ id: npc.id, ...update }],
    }, { turn: 2, ...options }).state.npcs[0];
}

function ordinaryState(npc, update, options = {}) {
    return mergeScanResult({ npcs: [npc], candidates: [], turn: 1 }, {
        npcs: [{ id: npc.id, name: npc.name, present: false, ...update }],
    }, { turn: 2, ...options }).state.npcs[0];
}

function importedNpc(name, id, seen, active = seen) {
    const npc = createNpcRecord(name);
    npc.id = id;
    npc.manual = false;
    npc.present = false;
    npc.worldActive = false;
    npc.lastSeenTurn = seen;
    npc.lastWorldActiveTurn = active;
    return npc;
}

test('v1.0.17 foreign new dossiers rebase low and high source activity clocks onto target turn', () => {
    const low = importedNpc('Low Clock', 'npc_low_clock', 2);
    const high = importedNpc('High Clock', 'npc_high_clock', 9999);
    const current = { npcs: [], turn: 100, socialGraph: emptyGraph(), dismissed: [] };
    const merged = mergeImportedDossierState(current, { npcs: [low, high], socialGraph: emptyGraph(), dismissed: [] }, {
        foreignOwnership: true,
    });

    for (const npc of merged.npcs) {
        assert.equal(npc.lastSeenTurn, 100);
        assert.equal(npc.lastWorldActiveTurn, 100);
    }
    const lifecycle = applyStaleNpcLifecycle(merged, { turn: 101, archiveAfter: 30, deleteAfter: 50 });
    assert.equal(lifecycle.removed.length, 0);
    assert.equal(lifecycle.archived.length, 0);
    assert.equal(lifecycle.state.npcs.length, 2);
});

test('v1.0.17 foreign matching dossiers preserve valid target activity in both source-clock directions', () => {
    const target = importedNpc('Marris', 'npc_marris', 88, 90);
    target.personality = 'Cautious and observant.';
    const current = { npcs: [target], turn: 100, socialGraph: emptyGraph(), dismissed: [] };

    for (const sourceTurn of [2, 9999]) {
        const source = importedNpc('Marris', 'npc_marris', sourceTurn, sourceTurn);
        source.personality = 'Cautious, observant, and dryly humorous.';
        const merged = mergeImportedDossierState(current, { npcs: [source], socialGraph: emptyGraph(), dismissed: [] }, {
            foreignOwnership: true,
        });
        const npc = merged.npcs[0];
        assert.equal(npc.lastSeenTurn, 88);
        assert.equal(npc.lastWorldActiveTurn, 90);
        assert.match(npc.personality, /dryly humorous/i);
    }
});

test('v1.0.17 same-chat import retains canonical same-chat activity behavior', () => {
    const target = importedNpc('Marris', 'npc_marris', 88, 90);
    const source = importedNpc('Marris', 'npc_marris', 55, 57);
    const merged = mergeImportedDossierState(
        { npcs: [target], turn: 100, socialGraph: emptyGraph(), dismissed: [] },
        { npcs: [source], socialGraph: emptyGraph(), dismissed: [] },
        { foreignOwnership: false },
    );
    assert.equal(merged.npcs[0].lastSeenTurn, 55);
    assert.equal(merged.npcs[0].lastWorldActiveTurn, 57);
});

test('v1.0.17 prepared foreign import preserves source identity until canonical target rebasing', () => {
    const sourceNpc = importedNpc('Prepared Import', 'npc_prepared', 2);
    sourceNpc.birthDateSourceMessageId = 44;
    const raw = encodeNpcStateBundle({ npcs: [sourceNpc], socialGraph: emptyGraph(), dismissed: [] }, {
        appVersion: '1.0.16',
        chatKey: 'chat:source',
    });
    const prepared = prepareNativeImport(raw, 'chat:target');
    const decoded = decodeDeltaNativeBundle(prepared.importBytes);
    assert.equal(decoded.metadata.sourceChatKey, 'chat:source');

    const foreignOwnership = decoded.metadata.sourceChatKey !== 'chat:target';
    const safeState = nativeStateForTarget(decoded, 'chat:target');
    assert.equal(safeState.npcs[0].birthDateSourceMessageId, null);
    const merged = mergeImportedDossierState(
        { npcs: [], turn: 100, socialGraph: emptyGraph(), dismissed: [] },
        safeState,
        { foreignOwnership },
    );
    assert.equal(merged.npcs[0].lastSeenTurn, 100);
    assert.equal(merged.npcs[0].lastWorldActiveTurn, 100);
});

test('v1.0.17 foreign activity rebasing preserves manual archive terminal death and retention protection', () => {
    const manual = importedNpc('Manual Archive', 'npc_manual_archive', 1);
    manual.archived = true;
    manual.archiveReason = 'manual';
    const dead = importedNpc('Confirmed Dead', 'npc_confirmed_dead', 1);
    dead.lifeState = 'deceased';
    dead.lifeStateCertainty = 'explicit';
    dead.archived = true;
    dead.archiveReason = 'deceased';
    const retained = importedNpc('Retained', 'npc_retained', 1);
    retained.retentionProtected = true;

    const merged = mergeImportedDossierState(
        { npcs: [], turn: 100, socialGraph: emptyGraph(), dismissed: [] },
        { npcs: [manual, dead, retained], socialGraph: emptyGraph(), dismissed: [] },
        { foreignOwnership: true },
    );
    const lifecycle = applyStaleNpcLifecycle(merged, { turn: 1000, archiveAfter: 30, deleteAfter: 50 });
    assert.equal(lifecycle.removed.length, 0);
    assert.equal(lifecycle.state.npcs.find(npc => npc.id === manual.id)?.archiveReason, 'manual');
    assert.equal(lifecycle.state.npcs.find(npc => npc.id === dead.id)?.lifeState, 'deceased');
    assert.equal(lifecycle.state.npcs.find(npc => npc.id === retained.id)?.retentionProtected, true);
});

const BASE_PERSONALITY = 'Kind, patient, cautious, reserved, and considerate.';
const UNSAFE_PERSONALITY = 'Kind, patient, cautious, reserved, and considerate, but cruel and enjoys suffering.';
const BASE_SPEECH = 'Soft, formal, measured, and precise.';
const UNSAFE_SPEECH = 'No longer soft, formal, measured, and precise; speaks in blunt slang.';

test('v1.0.17 ordinary keep/missing markers cannot bypass Personality or Speech safety', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = BASE_PERSONALITY;
    npc.speech = BASE_SPEECH;

    const updated = ordinaryState(npc, {
        personalityState: 'keep',
        personality: UNSAFE_PERSONALITY,
        speech: UNSAFE_SPEECH,
    });
    assert.equal(updated.personality, BASE_PERSONALITY);
    assert.equal(updated.speech, BASE_SPEECH);
});

test('v1.0.17 profileUpdates keep/missing markers cannot bypass Personality or Speech safety', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = BASE_PERSONALITY;
    npc.speech = BASE_SPEECH;

    const updated = profileState(npc, {
        personality: UNSAFE_PERSONALITY,
        speechState: 'keep',
        speech: UNSAFE_SPEECH,
    });
    assert.equal(updated.personality, BASE_PERSONALITY);
    assert.equal(updated.speech, BASE_SPEECH);
});

test('v1.0.17 exact unsafe proposals remain rejected when explicitly marked refine', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = BASE_PERSONALITY;
    npc.speech = BASE_SPEECH;

    const ordinary = ordinaryState(npc, {
        personalityState: 'refine',
        personality: UNSAFE_PERSONALITY,
        speechState: 'refine',
        speech: UNSAFE_SPEECH,
    });
    assert.equal(ordinary.personality, BASE_PERSONALITY);
    assert.equal(ordinary.speech, BASE_SPEECH);

    const profile = profileState(npc, {
        personalityState: 'refine',
        personality: UNSAFE_PERSONALITY,
        speechState: 'refine',
        speech: UNSAFE_SPEECH,
    });
    assert.equal(profile.personality, BASE_PERSONALITY);
    assert.equal(profile.speech, BASE_SPEECH);
});

test('v1.0.17 legitimate additive keep recovery and safe explicit refine remain supported', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Cautious, reserved, courteous, observant, and slow to trust.';

    const additive = ordinaryState(npc, {
        personality: 'Cautious, reserved, courteous, observant, and slow to trust; dryly humorous.',
    });
    assert.match(additive.personality, /dryly humorous/i);

    const explicit = profileState(npc, {
        personalityState: 'refine',
        personality: 'Cautious, reserved, courteous, observant, and dryly humorous.',
    });
    assert.match(explicit.personality, /dryly humorous/i);
    assert.doesNotMatch(explicit.personality, /slow to trust/i);
});

function independentNpc(name = 'Independent') {
    const npc = createNpcRecord(name);
    npc.personality = 'Independent, thoughtful, and considerate.';
    npc.behaviorProfile = ['Independence: High; keeps her own judgment and personal boundaries.'];
    return npc;
}

function kindNpc(name = 'Kind') {
    const npc = createNpcRecord(name);
    npc.personality = 'Kind, patient, and considerate.';
    npc.behaviorProfile = ['Disposition: Broadly kind and considerate.'];
    return npc;
}

test('v1.0.17 mixed-category agency reversal rejects the full Behavioral Profile atomically on both update paths', () => {
    const proposal = [
        'Temperament: Independent and thoughtful.',
        'Conduct: Readily defers to authority and follows instructions.',
    ];
    for (const apply of [ordinaryState, profileState]) {
        const npc = independentNpc();
        const updated = apply(npc, {
            behaviorProfileState: 'refine',
            behaviorProfile: proposal,
        });
        assert.deepEqual(updated.behaviorProfile, npc.behaviorProfile);
    }
});

test('v1.0.17 mixed-category morality reversal rejects the full Behavioral Profile atomically on both update paths', () => {
    const proposal = [
        'Temperament: Kind and considerate.',
        'Conduct: Merciless and enjoys suffering.',
    ];
    for (const apply of [ordinaryState, profileState]) {
        const npc = kindNpc();
        const updated = apply(npc, {
            behaviorProfileState: 'refine',
            behaviorProfile: proposal,
        });
        assert.deepEqual(updated.behaviorProfile, npc.behaviorProfile);
    }
});

test('v1.0.17 bounded agency negation is recognized without treating ordinary cooperation as obedience', () => {
    const npc = independentNpc();
    const negated = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: ['Conduct: Not independent; readily defers to authority and follows instructions.'],
    });
    assert.deepEqual(negated.behaviorProfile, npc.behaviorProfile);

    const nuanced = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            'Independence: High; keeps her own judgment and personal boundaries in difficult negotiations.',
            'Conduct: Cooperates with lawful authorities when goals align.',
        ],
    });
    assert.notDeepEqual(nuanced.behaviorProfile, npc.behaviorProfile);
    assert.ok(nuanced.behaviorProfile.some(entry => /cooperates with lawful authorities/i.test(entry)));
});

test('v1.0.17 an already mixed contextual agency profile can refine without being frozen by the aggregate guard', () => {
    const npc = independentNpc('Contextually Mixed');
    npc.behaviorProfile = [
        'Independence: High; keeps her own judgment and personal boundaries.',
        'Conduct: Follows instructions during emergency drills.',
    ];
    const updated = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            'Independence: High; keeps her own judgment and personal boundaries in difficult negotiations.',
            'Conduct: Follows instructions during emergency drills and coordinates closely with the team.',
        ],
    });
    assert.notDeepEqual(updated.behaviorProfile, npc.behaviorProfile);
    assert.ok(updated.behaviorProfile.some(entry => /coordinates closely with the team/i.test(entry)));
});

function socialNpc(id, name) {
    return {
        id,
        name,
        aliases: [],
        keyRelationships: [],
        manualProfileFields: [],
        present: false,
        worldActive: false,
        lifeState: 'alive',
    };
}

function siblingEdge(aId, bId, overrides = {}) {
    return {
        aId,
        bId,
        aToB: 'sibling',
        bToA: 'sibling',
        provenance: 'inferred',
        confidence: 'inferred',
        inferred: true,
        reason: 'shared established parent',
        ...overrides,
    };
}

test('v1.0.17 explicit reversed-edge confirmation clears inferred status and survives repeated normalization', () => {
    const a = socialNpc('npc_a', 'Aster');
    const b = socialNpc('npc_b', 'Bryn');
    const state = { npcs: [a, b], socialGraph: { version: 1, edges: [siblingEdge(a.id, b.id)], unresolved: [] } };
    const reconciled = reconcileSocialState(state, {
        provenance: 'scanner',
        scanResult: { keyRelationshipEdges: [{ aId: b.id, bId: a.id, aToB: 'sibling', bToA: 'sibling', reason: 'explicitly confirmed siblings' }] },
        turn: 12,
        sourceMessageId: 24,
    });
    const edge = reconciled.socialGraph.edges.find(item => [item.aId, item.bId].includes(a.id) && [item.aId, item.bId].includes(b.id));
    assert.equal(edge?.confidence, 'explicit');
    assert.equal(edge?.inferred, false);
    assert.match(reconciled.state.npcs.find(npc => npc.id === a.id)?.keyRelationships.join(' '), /Bryn.*sibling/i);
    assert.match(reconciled.state.npcs.find(npc => npc.id === b.id)?.keyRelationships.join(' '), /Aster.*sibling/i);

    const once = normalizeSocialGraph(reconciled.socialGraph);
    const twice = normalizeSocialGraph(once);
    assert.equal(twice.edges[0].confidence, 'explicit');
    assert.equal(twice.edges[0].inferred, false);
});

test('v1.0.17 manual structured confirmation promotes an inferred edge to manual authority', () => {
    const a = socialNpc('npc_a', 'Aster');
    const b = socialNpc('npc_b', 'Bryn');
    a.manualProfileFields = ['keyRelationships'];
    a.keyRelationships = ['Bryn — sibling | manually confirmed family'];
    const reconciled = reconcileSocialState({
        npcs: [a, b],
        socialGraph: { version: 1, edges: [siblingEdge(a.id, b.id)], unresolved: [] },
    }, { provenance: 'scanner', turn: 12, sourceMessageId: 24 });
    const edge = reconciled.socialGraph.edges[0];
    assert.equal(edge.confidence, 'manual');
    assert.equal(edge.inferred, false);
    assert.match(reconciled.state.npcs.find(npc => npc.id === b.id)?.keyRelationships.join(' '), /Aster.*sibling/i);
});

test('v1.0.17 an explicitly confirmed former inferred bond survives later equal-authority capacity pressure', () => {
    const npcs = Array.from({ length: SOCIAL_GRAPH_EDGE_LIMIT + 2 }, (_, index) => socialNpc(`npc_${index}`, `Person ${index}`));
    const edges = [siblingEdge('npc_0', 'npc_1')];
    for (let i = 2; i <= SOCIAL_GRAPH_EDGE_LIMIT; i += 1) {
        edges.push({
            aId: 'npc_0', bId: `npc_${i}`,
            aToB: 'friend', bToA: 'friend',
            provenance: 'scanner', confidence: 'explicit', inferred: false,
            reason: 'explicit friendship',
        });
    }
    assert.equal(edges.length, SOCIAL_GRAPH_EDGE_LIMIT);

    const confirmed = reconcileSocialState({ npcs, socialGraph: { version: 1, edges, unresolved: [] } }, {
        provenance: 'scanner',
        scanResult: { keyRelationshipEdges: [{ aId: 'npc_0', bId: 'npc_1', aToB: 'sibling', bToA: 'sibling', reason: 'explicitly confirmed sibling' }] },
        turn: 20,
        sourceMessageId: 40,
    });
    const sibling = confirmed.socialGraph.edges.find(edge => (edge.aId === 'npc_0' && edge.bId === 'npc_1') || (edge.aId === 'npc_1' && edge.bId === 'npc_0'));
    assert.equal(sibling?.confidence, 'explicit');
    assert.equal(sibling?.inferred, false);

    const pressured = reconcileSocialState(confirmed.state, {
        provenance: 'scanner',
        scanResult: { keyRelationshipEdges: [{
            aId: 'npc_0', bId: `npc_${SOCIAL_GRAPH_EDGE_LIMIT + 1}`,
            aToB: 'friend', bToA: 'friend', reason: 'new equally explicit relationship',
        }] },
        turn: 21,
        sourceMessageId: 42,
    });
    assert.equal(pressured.socialGraph.edges.length, SOCIAL_GRAPH_EDGE_LIMIT);
    assert.ok(pressured.socialGraph.edges.some(edge => (edge.aId === 'npc_0' && edge.bId === 'npc_1') || (edge.aId === 'npc_1' && edge.bId === 'npc_0')));
    assert.ok(!pressured.socialGraph.edges.some(edge => edge.aId === 'npc_0' && edge.bId === `npc_${SOCIAL_GRAPH_EDGE_LIMIT + 1}`));
});
