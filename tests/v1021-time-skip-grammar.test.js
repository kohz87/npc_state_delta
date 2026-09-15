import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, mergeScanResult } from '../core.js';

function ryuBatchPayload(npc) {
    return {
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: {
                speech: [
                    '[m202] cadence: speaks in matter-of-fact statements regarding anatomy and tinctures',
                    '[m204] cadence: smooth, soft-spoken, and measured lilt adopted from Seren, discarding guttural hisses',
                ],
            },
            speechState: 'evolve',
            speech: "Smooth, soft-spoken, and measured cadence with a gentle lilt adopted from Seren; speaks in quiet, impeccably polite sentences while discarding harsh mountain hisses.",
            speechReason: "Acquired Seren's polite, ladylike cadence over two months of study and practice.",
            developmentScale: 'batch',
            developmentReason: 'Two-month domestic time jump covering parish schooling, hospice chirurgery, and nameday preparation.',
        }],
    };
}

test('v1.0.21 natural elapsed-duration grammar accepts the grounded live-style batch Speech transition', () => {
    const npc = createNpcRecord('Ryu');
    npc.speech = 'Developing verbal speech, carefully testing words with measured syllables; communicates non-verbally through territorial hisses, wails, and affectionate gestures.';
    const developmentContext = [
        '[m204] Therin said, "Two months of your mountain wolves did not tame them. One season under Hilde\'s roof, watching the scribe\'s desk, suddenly they walk like high-born daughters."',
        '[m204] Up close, the changes of the past seventy days were impossible to miss.',
        '[m204] Ryu looked up through her pale lashes.',
        '[m204] When she spoke, the harsh guttural mountain hiss was entirely gone, replaced by a smooth, measured cadence that carried the gentle lilt of Seren\'s ledger desk.',
        '[m204] In two months, the girls had devoured three years of collegiate arithmetic and natural history, turning afternoon study halls into exhaustive debates on root chemistry.',
        '[m204] Their parish studies continued while Sister Althea supervised the hospice work.',
        '[m204] The nameday feast marked their formal presentation to the city.',
        '[m204] Seren had given them private lessons in posture and ladylike diction over the past month.',
    ].join('\n');

    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 204 },
        ryuBatchPayload(npc),
        {
            turn: 204,
            sourceMessageId: 204,
            developmentSourceMessageIds: [202, 203, 204],
            developmentContext,
        },
    );

    assert.equal(result.state.npcs[0].speech, "Smooth, soft-spoken, and measured cadence with a gentle lilt adopted from Seren; speaks in quiet, impeccably polite sentences while discarding harsh mountain hisses.", JSON.stringify(result.report.profileDevelopment));
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'applied-model-evolve');
    assert.equal(diagnostic?.scale, 'batch');
});

test('v1.0.21 a grounded time-compressed Refresh can refine Personality Mannerisms and Behavioral Profile alongside Speech', () => {
    const npc = createNpcRecord('Ryu');
    npc.personality = 'Quiet, wary in public, intensely attached to kin, and driven by predatory curiosity.';
    npc.mannerisms = ['Flexes her fingers against a slate frame while fixing a predatory stare on difficult study subjects.'];
    npc.behaviorProfile = ['Sisterly Attachment: Seeks Sora for reassurance and shared focus.', 'Territorial Caution: Remains wary of strangers and unfamiliar settings.'];

    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 204 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    personality: ['[m204] composure: poised, quiet, and impeccably polite during the formal gathering'],
                    mannerisms: ['[m204] posture: walks with deliberate quiet steps and dips into a small graceful curtsy'],
                    behaviorProfile: ['[m204] public conduct: consciously suppresses territorial reactions and follows learned civil etiquette'],
                },
                personalityState: 'refine',
                personality: 'Quiet and intensely attached to kin, with predatory curiosity tempered by poised, impeccably polite public composure.',
                mannerismState: 'refine',
                mannerisms: [
                    'Dips into a small, graceful curtsy while smoothing her skirts.',
                    'Flexes her fingers against a slate frame while fixing a predatory stare on difficult study subjects.',
                ],
                behaviorProfileState: 'refine',
                behaviorProfile: [
                    'Sisterly Attachment: Seeks Sora for reassurance and shared focus.',
                    'Civil Self-Control: Consciously suppresses territorial reactions and follows learned public etiquette.',
                ],
                developmentScale: 'batch',
                developmentReason: 'Two months of schooling, household etiquette practice, and public preparation reshaped her social presentation.',
            }],
        },
        {
            turn: 204,
            sourceMessageId: 204,
            developmentSourceMessageIds: [202, 203, 204],
            developmentContext: 'Over the past two months, Ryu repeatedly studied parish lessons, practiced household etiquette with Seren, and prepared for formal public appearances. By the nameday feast she walks with deliberate quiet steps, curtsies gracefully, and consciously suppresses territorial reactions while maintaining poised, polite public composure.',
        },
    );

    assert.match(result.state.npcs[0].personality, /poised, impeccably polite public composure/i);
    assert.deepEqual(result.state.npcs[0].mannerisms, [
        'Dips into a small, graceful curtsy while smoothing her skirts.',
        'Flexes her fingers against a slate frame while fixing a predatory stare on difficult study subjects.',
    ]);
    assert.deepEqual(result.state.npcs[0].behaviorProfile, [
        'Sisterly Attachment: Seeks Sora for reassurance and shared focus.',
        'Civil Self-Control: Consciously suppresses territorial reactions and follows learned public etiquette.',
    ]);
});

test('v1.0.21 a duration plus unrelated change does not authorize batch Speech evolution', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant.';
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 40 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { speech: ['Speaks politely once at the gate.'] },
                speechState: 'evolve',
                speech: 'Consistently polished and formal in public conversation.',
                speechReason: 'Acquired polished formal speech through sustained academy practice.',
                developmentScale: 'batch',
                developmentReason: 'Two months of sustained academy speech training made the formal cadence habitual.',
            }],
        },
        {
            turn: 40,
            sourceMessageId: 140,
            developmentContext: 'For two months the valley weather changed daily. Marris returned today and spoke politely once at the gate.',
        },
    );

    assert.equal(result.state.npcs[0].speech, 'Soft and hesitant.');
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'waiting-for-explicit-gate');
});
