import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildInjection,
    buildNpcPortraitPrompts,
    createNpcRecord,
    durableProfileEvidenceAlreadyRepresented,
    mergeScanResult,
    normalizeNpcRecord,
    resolveNpcAppearance,
} from '../core.js';
import { reconcileSocialState } from '../social.js';

const state = (...npcs) => ({ npcs, candidates: [], turn: 1 });
const merge = (npc, update, context = '', extra = {}) => mergeScanResult(
    state(npc),
    { npcs: [], profileUpdates: [{ id: npc.id, ...update }] },
    { turn: 2, sourceMessageId: 2, developmentContext: context, ...extra },
);

function profileRow(result, field) {
    return result.report?.profileDevelopment?.find(row => row.field === field) || null;
}

test('unsupported durable meaning cannot ride through refine while directly grounded clarification still can', () => {
    const npc = createNpcRecord('Mira');
    npc.personality = 'Kind, curious and independent; careful and methodical in public.';
    npc.speech = 'Soft, melodic speech with measured cadence in public.';

    const rejected = merge(npc, {
        personalityState: 'refine',
        personality: `${npc.personality}; enjoys inflicting pain on strangers.`,
        speechState: 'refine',
        speech: `${npc.speech}; fluent in an extinct celestial language.`,
        evidence: {
            personality: ['Mira pours a cup of tea.'],
            speech: ['Mira says hello.'],
        },
    }, 'Mira pours a cup of tea and says hello.');

    assert.equal(rejected.state.npcs[0].personality, npc.personality);
    assert.equal(rejected.state.npcs[0].speech, npc.speech);
    assert.ok(rejected.state.npcs[0].profileEvidence.personality.some(item => /tea/i.test(item)));
    assert.ok(rejected.state.npcs[0].profileEvidence.speech.some(item => /hello/i.test(item)));

    const grounded = merge(npc, {
        personalityState: 'refine',
        personality: `${npc.personality}; carefully prepares tea for nervous guests.`,
        speechState: 'refine',
        speech: `${npc.speech}; greets elders with the formal phrase Good evening.`,
        evidence: {
            personality: ['Mira carefully prepares tea for nervous guests.'],
            speech: ['Mira greets an elder with the formal phrase Good evening.'],
        },
    }, 'Mira carefully prepares tea for nervous guests, then greets an elder with the formal phrase Good evening.');

    assert.match(grounded.state.npcs[0].personality, /prepares tea for nervous guests/i);
    assert.match(grounded.state.npcs[0].speech, /formal phrase Good evening/i);
});

test('Behavioral Profile refinement is atomic and rejects unsupported new agency', () => {
    const npc = createNpcRecord('Mira');
    npc.behaviorProfile = [
        'Study: Records careful botanical observations.',
        'Hospitality: Serves warm tea to visitors.',
    ];
    const unsupported = merge(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            ...npc.behaviorProfile,
            'Leadership: Commands a fleet of airships and negotiates intercontinental treaties.',
        ],
        evidence: { behaviorProfile: ['Mira serves warm tea to visitors.'] },
    }, 'Mira serves warm tea to visitors.');
    assert.deepEqual(unsupported.state.npcs[0].behaviorProfile, npc.behaviorProfile);
    assert.equal(profileRow(unsupported, 'behaviorProfile')?.candidateGrounded, false);

    const grounded = merge(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            ...npc.behaviorProfile,
            'Triage: Records symptoms before suggesting simple remedies.',
        ],
        evidence: { behaviorProfile: ['Triage: Records symptoms before suggesting simple remedies.'] },
    }, 'Mira records symptoms before suggesting simple remedies.');
    assert.ok(grounded.state.npcs[0].behaviorProfile.some(item => /^Triage:/i.test(item)));
});

test('accepted flat current appearance updates the selected canonical form and every projection', () => {
    const npc = normalizeNpcRecord({
        ...createNpcRecord('Mira'),
        appearanceModelVersion: 1,
        overallAppearance: 'Silver hair and blue eyes.',
        currentForm: 'Human',
        appearanceForms: [
            { name: 'Human', appearance: 'Silver hair and blue eyes. Wears a green dress.' },
            { name: 'Dragon', appearance: 'Mirror-steel scales, silver wings, and a long tail.' },
        ],
    });
    const context = 'Mira has silver hair and blue eyes. She changes into a red coat with brass buttons.';
    const changed = merge(npc, {
        appearance: 'Silver hair and blue eyes; wears a red coat with brass buttons.',
        appearanceState: 'refine',
        evidence: { appearance: ['Mira wears a red coat with brass buttons.'] },
    }, context);
    const current = changed.state.npcs[0];
    const human = current.appearanceForms.find(form => form.name === 'Human');
    const dragon = current.appearanceForms.find(form => form.name === 'Dragon');

    assert.match(human.appearance, /red coat with brass buttons/i);
    assert.doesNotMatch(human.appearance, /green dress/i);
    assert.match(dragon.appearance, /silver wings/i);
    assert.match(resolveNpcAppearance(current), /red coat with brass buttons/i);
    assert.doesNotMatch(resolveNpcAppearance(current), /green dress/i);
    const injection = buildInjection([{ ...current, present: true }], 'Mira is here.', 2, 3, undefined, 2000);
    const portrait = buildNpcPortraitPrompts(current).positive;
    assert.match(injection, /red coat with brass buttons/i);
    assert.doesNotMatch(injection, /green dress/i);
    assert.match(portrait, /red coat with brass buttons/i);
    assert.doesNotMatch(portrait, /green dress/i);
    assert.equal(changed.report.profileUpdateStats.applied, 1);
});

test('form selection and flat appearance update target the newly selected form without old-form leakage', () => {
    const npc = normalizeNpcRecord({
        ...createNpcRecord('Mira'),
        appearanceModelVersion: 1,
        currentForm: 'Human',
        appearanceForms: [
            { name: 'Human', appearance: 'Silver hair, blue eyes, and a green dress.' },
            { name: 'Dragon', appearance: 'Mirror-steel scales, silver wings, and a long tail.' },
        ],
    });
    const changed = merge(npc, {
        currentForm: 'Dragon',
        currentFormState: 'select',
        appearance: 'Mirror-steel scales, silver wings, a long tail, and a crimson mantle.',
        appearanceState: 'refine',
        evidence: { appearance: ['Her Dragon form wears a crimson mantle over mirror-steel scales and silver wings.'] },
    }, 'Mira changes into her Dragon form. Mirror-steel scales and silver wings frame a crimson mantle.');
    const current = changed.state.npcs[0];
    assert.equal(current.currentForm, 'Dragon');
    assert.match(resolveNpcAppearance(current), /crimson mantle/i);
    assert.doesNotMatch(resolveNpcAppearance(current), /green dress/i);
    assert.match(current.appearanceForms.find(form => form.name === 'Human').appearance, /green dress/i);
    assert.match(current.appearanceForms.find(form => form.name === 'Dragon').appearance, /crimson mantle/i);
});

test('Shared appearance is deduplicated at clause boundaries in resolved, injection, and portrait text', () => {
    const npc = normalizeNpcRecord({
        ...createNpcRecord('Mira'),
        appearanceModelVersion: 1,
        overallAppearance: 'Silver hair and blue eyes.',
        currentForm: 'Human',
        appearanceForms: [{ name: 'Human', appearance: 'Silver hair and blue eyes. Wears a green dress.' }],
    });
    const resolved = resolveNpcAppearance(npc);
    const injection = buildInjection([{ ...npc, present: true }], 'Mira is here.', 2, 3, undefined, 2000);
    const portrait = buildNpcPortraitPrompts(npc).positive;
    for (const value of [resolved, injection, portrait]) {
        assert.equal((value.match(/silver hair and blue eyes/gi) || []).length, 1);
        assert.match(value, /green dress/i);
    }

    const distinct = normalizeNpcRecord({
        ...createNpcRecord('Vera'),
        appearanceModelVersion: 1,
        overallAppearance: 'Silver hair and blue eyes.',
        currentForm: 'Veiled',
        appearanceForms: [{ name: 'Veiled', appearance: 'Her blue eyes are not visible beneath an opaque black veil.' }],
    });
    const distinctResolved = resolveNpcAppearance(distinct);
    assert.match(distinctResolved, /Silver hair and blue eyes/i);
    assert.match(distinctResolved, /not visible beneath an opaque black veil/i);
    assert.equal(resolveNpcAppearance(normalizeNpcRecord(distinct)), distinctResolved);
});

test('fully proven collective bonds retire into named members while partial groups and unrelated unresolved bonds remain', () => {
    const parent = createNpcRecord('Mira Hest');
    parent.background = 'Mother of two twin daughters.';
    parent.keyRelationships = [
        'Twin Daughters — daughters | Raising and supervising her two twelve-year-old daughters.',
        'Late Husband — deceased spouse | Died in a scree fall during the previous winter.',
    ];
    let family = reconcileSocialState(state(parent), { provenance: 'scanner' }).state;
    const elda = createNpcRecord('Elda Hest');
    family.npcs.push(elda);
    family.npcs[0].keyRelationships.push('Elda Hest — daughter');
    family = reconcileSocialState(family, { provenance: 'scanner' }).state;
    assert.ok(family.npcs[0].keyRelationships.some(item => item.startsWith('Twin Daughters')));
    assert.ok(family.npcs[0].keyRelationships.some(item => item.startsWith('Late Husband')));
    assert.equal(family.socialGraph.unresolved.length, 1);

    const tessa = createNpcRecord('Tessa Hest');
    family.npcs.push(tessa);
    family.npcs[0].keyRelationships.push('Tessa Hest — daughter');
    family = reconcileSocialState(family, { provenance: 'scanner' }).state;
    const bonds = family.npcs[0].keyRelationships;
    assert.equal(family.socialGraph.unresolved.length, 0);
    assert.equal(bonds.some(item => item.startsWith('Twin Daughters')), false);
    assert.ok(bonds.some(item => /^Elda Hest — daughter/i.test(item)));
    assert.ok(bonds.some(item => /^Tessa Hest — daughter/i.test(item)));
    assert.ok(bonds.some(item => item.startsWith('Late Husband')));
    assert.ok(bonds.filter(item => /Elda Hest|Tessa Hest/.test(item)).every(item => /Raising and supervising/i.test(item)));
    assert.ok(family.socialGraph.edges.some(edge => edge.aToB === 'twin sibling' || edge.bToA === 'twin sibling'));
    const stable = structuredClone(family.npcs[0].keyRelationships);
    family = reconcileSocialState(family, { provenance: 'scanner' }).state;
    assert.deepEqual(family.npcs[0].keyRelationships, stable);
});

test('explicit scanner edges still correct mother/daughter direction', () => {
    const parent = createNpcRecord('Mira Hest');
    const daughter = createNpcRecord('Elda Hest');
    parent.keyRelationships = ['Elda Hest — mother'];
    const corrected = mergeScanResult(state(parent, daughter), {
        npcs: [],
        keyRelationshipEdges: [{
            aId: parent.id,
            bId: daughter.id,
            aToB: 'daughter',
            bToA: 'mother',
            reason: "Elda is Mira Hest's daughter.",
        }],
    }, { turn: 2, sourceMessageId: 2, developmentContext: "Elda is Mira Hest's daughter." });
    assert.match(corrected.state.npcs[0].keyRelationships[0], /daughter/i);
    assert.match(corrected.state.npcs[1].keyRelationships[0], /mother/i);
});

test('collection reorder and partial refinement retain only evidence not represented by final canon', () => {
    const behavior = createNpcRecord('Mira');
    behavior.behaviorProfile = [
        'Study: Records careful botanical observations.',
        'Hospitality: Serves warm tea to visitors.',
    ];
    const reordered = merge(behavior, {
        behaviorProfileState: 'refine',
        behaviorProfile: [...behavior.behaviorProfile].reverse(),
        evidence: { behaviorProfile: ['[m2] clinical diagnosis: independently diagnoses complex illnesses and prescribes treatment'] },
    }, 'Mira independently diagnoses complex illnesses and prescribes treatment.');
    assert.deepEqual(reordered.state.npcs[0].behaviorProfile, behavior.behaviorProfile);
    assert.equal(reordered.state.npcs[0].profileEvidence.behaviorProfile.length, 1);
    const behaviorRow = profileRow(reordered, 'behaviorProfile');
    assert.equal(behaviorRow.candidateChanged, false);
    assert.equal(behaviorRow.evidenceAlreadyRepresented, false);
    assert.equal(behaviorRow.evidenceResolved, false);
    assert.equal(behaviorRow.outcome, 'waiting-for-revised-candidate');

    const manner = createNpcRecord('Lina');
    manner.mannerisms = ['Taps a pencil while thinking.', 'Folds her hands before greeting visitors.'];
    const reorderedManner = merge(manner, {
        mannerismState: 'refine',
        mannerisms: [...manner.mannerisms].reverse(),
        evidence: { mannerisms: ['[m2] diagnosis: checks a patient pulse before speaking'] },
    }, 'Lina checks a patient pulse before speaking.');
    assert.deepEqual(reorderedManner.state.npcs[0].mannerisms, manner.mannerisms);
    assert.equal(reorderedManner.state.npcs[0].profileEvidence.mannerisms.length, 1);
    const mannerRow = profileRow(reorderedManner, 'mannerisms');
    assert.equal(mannerRow.candidateChanged, false);
    assert.equal(mannerRow.evidenceResolved, false);

    const partialManner = merge(manner, {
        mannerismState: 'refine',
        mannerisms: [
            'Taps a pencil twice while thinking through difficult diagnoses.',
            manner.mannerisms[1],
        ],
        evidence: { mannerisms: [
            '[m2] habit: Taps a pencil twice while thinking through difficult diagnoses.',
            '[m2] pulse check: checks a patient pulse before speaking.',
        ] },
    }, 'Lina taps a pencil twice while thinking through difficult diagnoses. She also checks a patient pulse before speaking.');
    assert.match(partialManner.state.npcs[0].mannerisms[0], /twice while thinking/i);
    assert.equal(partialManner.state.npcs[0].profileEvidence.mannerisms.length, 1);
    assert.match(partialManner.state.npcs[0].profileEvidence.mannerisms[0], /patient pulse/i);

    const partial = merge(behavior, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            'Study: Records careful botanical observations and dates each specimen.',
            behavior.behaviorProfile[1],
        ],
        evidence: { behaviorProfile: [
            '[m2] Study: Records careful botanical observations and dates each specimen.',
            '[m2] clinical diagnosis: independently diagnoses complex illnesses and prescribes treatment.',
        ] },
    }, 'Mira records careful botanical observations and dates each specimen. Separately, she independently diagnoses complex illnesses and prescribes treatment.');
    assert.match(partial.state.npcs[0].behaviorProfile[0], /dates each specimen/i);
    assert.equal(partial.state.npcs[0].profileEvidence.behaviorProfile.length, 1);
    assert.match(partial.state.npcs[0].profileEvidence.behaviorProfile[0], /diagnoses complex illnesses/i);
});

test('evidence coverage requires the claim body and polarity rather than a matching concept label', () => {
    const currentBehavior = ['Study: Records careful botanical observations.'];
    assert.equal(durableProfileEvidenceAlreadyRepresented('behaviorProfile', currentBehavior, [
        '[m2] Study: Independently diagnoses complex illnesses and prescribes treatment.',
    ]), false);
    assert.equal(durableProfileEvidenceAlreadyRepresented('behaviorProfile', currentBehavior, [
        '[m2] Study: Does not record careful botanical observations.',
    ]), false);
    assert.equal(durableProfileEvidenceAlreadyRepresented('behaviorProfile', currentBehavior, [
        '[m2] Study: Records careful botanical observations.',
    ]), true);
    assert.equal(durableProfileEvidenceAlreadyRepresented('speech', 'Soft, melodic speech in public.', [
        '[m2] melodic: speaks fluent medical Ardessian with complex diagnostic explanations',
    ]), false);
    assert.equal(durableProfileEvidenceAlreadyRepresented('personality', 'Kind and compassionate.', [
        '[m2] kind: abandons compassion and delights in cruelty',
    ]), false);
});

test('Speech copied-candidate negative control still retains novel body and waits for a revised candidate', () => {
    const speaker = createNpcRecord('Mira');
    speaker.speech = 'Soft, melodic speech in public.';
    const result = merge(speaker, {
        speech: speaker.speech,
        speechState: 'refine',
        developmentScale: 'batch',
        developmentReason: 'Over three months Mira studied medicine and learned fluent medical Ardessian.',
        evidence: { speech: ['[m2] melodic: speaks fluent medical Ardessian with complex diagnostic explanations'] },
    }, '[m1] Over three months Mira studied medicine. [m2] Mira speaks fluent medical Ardessian with complex diagnostic explanations.', { allowTargetedDurableSeed: true });
    const row = profileRow(result, 'speech');
    assert.equal(row.outcome, 'waiting-for-revised-candidate');
    assert.equal(row.evidenceAlreadyRepresented, false);
    assert.ok(result.state.npcs[0].profileEvidence.speech.some(item => /medical Ardessian/i.test(item)));
});
