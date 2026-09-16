import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProfileRefreshPrompt,
    createNpcRecord,
    durableProfileCollectionCandidateGrounded,
    mergeScanResult,
} from '../core.js';

function baseSora() {
    const npc = createNpcRecord('Sora');
    npc.personality = 'Instinctive, gluttonous, and fiercely protective in private; inquisitive and playfully competitive, balancing a cheerful, demure student facade with sharp ambition.';
    npc.speech = 'Speaks with soft, melodic Ardessian etiquette and gentle cadence in public; shifts to rapid, serious declarations when analyzing biology, and blunt cries when distressed.';
    npc.mannerisms = [
        'Ruffling downy ear-feathers and buzzing with faint static when agitated or intellectually stimulated.',
        'Smoothing cerulean skirts and curtsying with delicate, ladylike grace in formal company.',
        'Slamming her palm against the table when demanding food or whole cream at home.',
    ];
    npc.behaviorProfile = [
        'Primal & Protective: Lashes out instinctively against threats to Lucien before seeking physical comfort.',
        'Refined Emulation: Mirrors ladylike etiquette, gentle speech, and delicate tea service to project poise.',
        'Empirical Application: Transcribes anatomical notes, tests herbal tinctures, and operates with surgical precision.',
        'Mana Manifestation: Consciously summons ear crests, thunderbird plumage wings, lightning, or raptor form.',
    ];
    return npc;
}

const SORA_EPISODE = 'Over ten weeks since the first thaw, Sora studied anatomy and herbal medicine every day. Sora tapped the edge of her slate with a chalk stub while explaining deductions and practiced formal etiquette throughout the same period. By the nameday feast, she curtsied with pristine poise.';

test('v1.0.24 time-compressed refine recovers an omitted developmentReason from candidate-specific evidence', () => {
    const npc = baseSora();
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 200 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    mannerisms: [
                        '[m202] chalk tap: tapping the edge of her slate with a chalk stub',
                        '[m204] curtsy: curtsied with pristine poise',
                    ],
                },
                mannerismState: 'refine',
                mannerisms: [
                    ...npc.mannerisms.slice(0, 2),
                    'Tapping her chalk stub against her slate frame when explaining deductions.',
                    npc.mannerisms[2],
                ],
                developmentScale: 'gradual',
                developmentReason: '',
            }],
        },
        { turn: 204, sourceMessageId: 204, developmentContext: SORA_EPISODE, allowTargetedDurableSeed: true },
    );
    const sora = result.state.npcs.find(item => item.id === npc.id);
    assert.ok(sora.mannerisms.some(value => /chalk stub/i.test(value)));
    const row = result.report.profileDevelopment.find(item => item.field === 'mannerisms');
    assert.equal(row?.outcome, 'applied-inferred-batch');
    assert.equal(row?.inferredScale, true);
    assert.equal(row?.candidateGrounded, true);
    assert.equal(row?.effectiveReasonSource, 'evidence');
    assert.equal(row?.providerReasonPresent, false);
    assert.equal(row?.episode?.grounded, true);
});

test('v1.0.24 unrelated evidence cannot authorize a new time-compressed mannerism', () => {
    const npc = baseSora();
    const candidate = [...npc.mannerisms, 'Twirls a knife between her fingers while thinking.'];
    assert.equal(durableProfileCollectionCandidateGrounded(
        'mannerisms', npc.mannerisms, candidate, ['curtsy: curtsied with pristine poise'],
    ), false);
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 200 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { mannerisms: ['[m204] curtsy: curtsied with pristine poise'] },
                mannerismState: 'refine',
                mannerisms: candidate,
                developmentScale: 'gradual',
                developmentReason: '',
            }],
        },
        { turn: 204, sourceMessageId: 204, developmentContext: SORA_EPISODE, allowTargetedDurableSeed: true },
    );
    const sora = result.state.npcs.find(item => item.id === npc.id);
    assert.equal(sora.mannerisms.some(value => /knife/i.test(value)), false);
    const row = result.report.profileDevelopment.find(item => item.field === 'mannerisms');
    assert.equal(row?.inferredScale, false);
    assert.equal(row?.candidateGrounded, false);
});

test('v1.0.24 aggregate fragmented evidence already reflected by the current Speech resolves its epoch', () => {
    const npc = createNpcRecord('Sora');
    npc.speech = 'Measured, soft-spoken, melodic and thoroughly polite in formal company.';
    let state = { npcs: [npc], candidates: [], turn: 200 };
    const scan = (evidence, sourceMessageId) => mergeScanResult(
        state,
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { speech: [evidence] },
                speechState: 'refine',
                speech: npc.speech,
                developmentScale: 'gradual',
                developmentReason: '',
            }],
        },
        { turn: sourceMessageId, sourceMessageId },
    );
    state = scan('[m202] analytical: measured delivery remains steady during analysis', 202).state;
    state = scan('[m203] soft-spoken: soft-spoken delivery stays gentle in public', 203).state;
    const final = scan('[m204] melodic: melodic polite cadence recurs at formal gatherings', 204);
    const row = final.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(row?.aggregateReady, true);
    assert.equal(row?.aggregateFallback, true);
    assert.equal(row?.candidateChanged, false);
    assert.equal(row?.candidateAlreadyRepresented, true);
    assert.equal(row?.outcome, 'evidence-already-reflected');
    assert.equal(final.state.npcs[0].speechDevelopment.concepts.length, 0);
});

test('v1.0.24 Refresh contract requires a reason for time-compressed refine as well as evolve', () => {
    const prompt = buildProfileRefreshPrompt({
        transcript: SORA_EPISODE,
        targetNpc: baseSora(),
        userName: 'Lucien',
        charName: 'Narrator',
    });
    assert.match(prompt, /time-compressed development MUST include developmentReason, even when state is refine/i);
});
