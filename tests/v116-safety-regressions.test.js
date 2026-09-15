import test from 'node:test';
import assert from 'node:assert/strict';

import { createNpcRecord, mergeScanResult } from '../core.js';
import { applyAppearanceUpdate, appearanceFormByName } from '../appearance.js';
import { encodeNpcStateBundle } from '../bundle.js';
import { augmentNativeBundle, decodeDeltaNativeBundle, prepareNativeImport } from '../native-transfer.js';
import { reconcileSocialState, SOCIAL_GRAPH_EDGE_LIMIT } from '../social.js';

function profileState(npc, update, options = {}) {
    return mergeScanResult({ npcs: [npc], candidates: [], turn: 1 }, {
        npcs: [],
        profileUpdates: [{ id: npc.id, ...update }],
    }, { turn: 2, ...options }).state.npcs[0];
}

test('v1.0.16 unmarked ordinary profile recovery cannot retire omitted established clauses', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Cautious, reserved, courteous, observant, and slow to trust; fiercely independent.';
    npc.speech = 'Soft, formal, measured, and precise; addresses elders with careful titles.';
    npc.appearance = 'Tall woman with olive skin, long wavy black hair, amber eyes, a faint scar beneath her left eye, and a dark wool travel coat.';

    const result = mergeScanResult({ npcs: [npc], candidates: [], turn: 3 }, { npcs: [{
        id: npc.id,
        name: npc.name,
        present: true,
        personality: 'Cautious, reserved, courteous, observant, and slow to trust; dryly humorous.',
        speech: 'Soft, formal, measured, and precise; uses careful technical vocabulary.',
        appearance: 'Tall woman with olive skin, long wavy black hair, amber eyes, a faint scar beneath her left eye, and a silver pendant.',
    }] }, { turn: 4 });

    const updated = result.state.npcs[0];
    assert.match(updated.personality, /fiercely independent/i);
    assert.doesNotMatch(updated.personality, /dryly humorous/i);
    assert.match(updated.speech, /addresses elders with careful titles/i);
    assert.doesNotMatch(updated.speech, /technical vocabulary/i);
    assert.match(updated.appearance, /dark wool travel coat/i);
    assert.doesNotMatch(updated.appearance, /silver pendant/i);
});

test('v1.0.16 unmarked profileUpdates recovery preserves established summaries while explicit refine still owns replacement', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Cautious, reserved, courteous, observant, and slow to trust; fiercely independent.';

    const unmarked = profileState(npc, {
        personality: 'Cautious, reserved, courteous, observant, and slow to trust; dryly humorous.',
    });
    assert.match(unmarked.personality, /fiercely independent/i);
    assert.doesNotMatch(unmarked.personality, /dryly humorous/i);

    const explicit = profileState(npc, {
        personalityState: 'refine',
        personality: 'Cautious, reserved, courteous, observant, and slow to trust; dryly humorous.',
    });
    assert.match(explicit.personality, /dryly humorous/i);
    assert.doesNotMatch(explicit.personality, /fiercely independent/i);
});

test('v1.0.16 keep-state overall and named-form appearance cannot invoke full-summary replacement', () => {
    const record = {
        ...createNpcRecord('Sora'),
        appearanceModelVersion: 1,
        overallAppearance: 'Long blue-gold hair, bright amber eyes, a faint cheek scar, and warm skin.',
        appearanceForms: [{
            name: 'Human Form',
            appearance: 'Slender young woman with warm skin, a long blue-gold braid, and bright amber eyes; wears a cerulean school dress and dark wool pinafore.',
        }],
        currentForm: 'Human Form',
        currentFormUnknown: false,
    };

    const updated = applyAppearanceUpdate(record, {
        overallAppearanceState: 'keep',
        overallAppearance: 'Long blue-gold hair, bright amber eyes, warm skin, and a small gold earring.',
        appearanceForms: [{
            name: 'Human Form',
            appearance: 'Slender young woman with warm skin, a long blue-gold braid, and bright amber eyes; wears a green embroidered vest.',
        }],
    });

    assert.match(updated.overallAppearance, /faint cheek scar/i);
    assert.doesNotMatch(updated.overallAppearance, /gold earring/i);
    const human = appearanceFormByName(updated, 'Human Form');
    assert.match(human.appearance, /cerulean school dress/i);
    assert.match(human.appearance, /dark wool pinafore/i);
    assert.doesNotMatch(human.appearance, /green embroidered vest/i);
});

test('v1.0.16 behavior-profile refine rejects agency reversal hidden behind a new category label', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = 'Kind, patient, independent, and considerate.';
    npc.behaviorProfile = [
        'Disposition: Broadly kind and patient.',
        'Independence: High; keeps her own judgment and personal boundaries.',
    ];

    const updated = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            'Disposition: Broadly kind, patient, and considerate.',
            'Conduct: Readily defers to authority and follows instructions.',
        ],
    });

    assert.deepEqual(updated.behaviorProfile, npc.behaviorProfile);
});

test('v1.0.16 behavior-profile refine rejects morality reversal hidden behind a new category label', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = 'Kind, patient, independent, and considerate.';
    npc.behaviorProfile = ['Disposition: Broadly kind and avoids needless suffering.'];

    const updated = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: ['Temperament: Merciless and enjoys suffering.'],
    });

    assert.deepEqual(updated.behaviorProfile, npc.behaviorProfile);
});

test('v1.0.19 cross-chat native import rebases pending Personality/Speech development provenance', () => {
    const npc = createNpcRecord('Ryu');
    npc.personality = 'Reserved, observant, and quietly protective.';
    npc.personalityDevelopment = {
        version: 2,
        epoch: 2,
        baselinePersonality: npc.personality,
        baselineTurn: 16,
        baselineSourceMessageId: 32,
        concepts: [{
            concept: 'confidence',
            firstTurn: 16,
            lastTurn: 20,
            observationCount: 3,
            sourceMessageIds: [32, 36, 40],
            turns: [16, 18, 20],
            evidenceSamples: [
                'confidence: volunteers her view in a small group',
                'confidence: defends her own decision calmly',
                'confidence: speaks before groups without prompting',
            ],
            latestEvidence: 'confidence: speaks before groups without prompting',
        }],
    };
    npc.speech = 'Soft, formal, and precise.';
    npc.speechDevelopment = {
        version: 2,
        epoch: 3,
        baselineSpeech: npc.speech,
        baselineTurn: 18,
        baselineSourceMessageId: 36,
        concepts: [{
            concept: 'technical vocabulary',
            firstTurn: 18,
            lastTurn: 20,
            observationCount: 3,
            sourceMessageIds: [36, 38, 40],
            turns: [18, 19, 20],
            evidenceSamples: [
                'technical vocabulary: names surgical instruments precisely',
                'technical vocabulary: uses formal medical terms',
                'technical vocabulary: uses exact anatomical terminology',
            ],
            latestEvidence: 'technical vocabulary: uses exact anatomical terminology',
        }],
    };

    const source = encodeNpcStateBundle({ npcs: [npc], dismissed: [] }, { appVersion: '1.0.16', chatKey: 'chat:source' });
    const native = augmentNativeBundle(source);
    const prepared = prepareNativeImport(native, 'chat:target');
    const imported = decodeDeltaNativeBundle(prepared.importBytes).state.npcs[0];

    assert.equal(imported.personalityDevelopment.baselinePersonality, npc.personality);
    assert.equal(imported.personalityDevelopment.epoch, 2);
    assert.equal(imported.personalityDevelopment.baselineTurn, null);
    assert.equal(imported.personalityDevelopment.baselineSourceMessageId, null);
    assert.deepEqual(imported.personalityDevelopment.concepts, []);
    assert.equal(imported.speechDevelopment.baselineSpeech, npc.speech);
    assert.equal(imported.speechDevelopment.epoch, 3);
    assert.equal(imported.speechDevelopment.baselineTurn, null);
    assert.equal(imported.speechDevelopment.baselineSourceMessageId, null);
    assert.deepEqual(imported.speechDevelopment.concepts, []);
});

test('v1.0.16 social graph capacity never evicts equal- or higher-authority edges', () => {
    const npcs = Array.from({ length: SOCIAL_GRAPH_EDGE_LIMIT + 2 }, (_, index) => ({
        id: `npc_${index}`,
        name: `Person ${index}`,
        aliases: [],
        keyRelationships: [],
        manualProfileFields: [],
    }));
    const edges = [];
    for (let i = 1; i <= SOCIAL_GRAPH_EDGE_LIMIT; i += 1) {
        edges.push({
            aId: 'npc_0',
            bId: `npc_${i}`,
            aToB: 'friend',
            bToA: 'friend',
            provenance: i === 1 ? 'manual' : 'scanner',
            confidence: i === 1 ? 'manual' : 'explicit',
            reason: i === 1 ? 'manual relationship' : 'explicit relationship',
        });
    }
    const state = { npcs, socialGraph: { version: 1, edges, unresolved: [] } };
    const reconciled = reconcileSocialState(state, {
        provenance: 'scanner',
        scanResult: {
            keyRelationshipEdges: [{
                aId: 'npc_0',
                bId: `npc_${SOCIAL_GRAPH_EDGE_LIMIT + 1}`,
                aToB: 'friend',
                bToA: 'friend',
                reason: 'new equally explicit relationship',
            }],
        },
    }).socialGraph;

    assert.equal(reconciled.edges.length, SOCIAL_GRAPH_EDGE_LIMIT);
    assert.ok(reconciled.edges.some(edge => edge.aId === 'npc_0' && edge.bId === 'npc_1' && edge.confidence === 'manual'));
    assert.ok(!reconciled.edges.some(edge => edge.aId === 'npc_0' && edge.bId === `npc_${SOCIAL_GRAPH_EDGE_LIMIT + 1}`));
});
