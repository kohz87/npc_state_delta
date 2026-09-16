import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProfileRefreshPrompt,
    buildScannerPrompt,
    createNpcRecord,
    durableProfileEvidenceAlreadyRepresented,
    mergeScanResult,
} from '../core.js';

function soraBase() {
    const npc = createNpcRecord('Sora');
    npc.personality = 'Instinctive, gluttonous, and fiercely protective in private; inquisitive and playfully competitive, balancing a cheerful, demure student facade with sharp ambition.';
    npc.speech = 'Speaks with soft, melodic Ardessian etiquette and gentle cadence in public; shifts to rapid, serious declarations when analyzing biology, and blunt cries when distressed.';
    npc.behaviorProfile = [
        'Primal & Protective: Lashes out instinctively against threats to Lucien before seeking physical comfort.',
        'Refined Emulation: Mirrors ladylike etiquette, gentle speech, and delicate tea service to project poise.',
        'Empirical Application: Transcribes anatomical notes, tests herbal tinctures, and operates with surgical precision.',
        'Mana Manifestation: Consciously summons ear crests, thunderbird plumage wings, lightning, or raptor form.',
    ];
    return npc;
}

const REASON = "Elapsed ten weeks of collegiate rhetoric, chirurgery training, and conscious emulation of Seren's feminine etiquette for the Suncrest birthday banquet.";
const EPISODE = "Over ten weeks Sora followed a collegiate rhetoric curriculum and chirurgery training. Throughout that time Sora consciously emulated Seren's feminine etiquette for the Suncrest birthday banquet. Sora became more cheerful, tested seasonal resins, and used sharp empirical analysis while practicing measured formal speech.";

test('v1.0.25 copied batch Personality/Speech candidates keep novel evidence pending', () => {
    const npc = soraBase();
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 201 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    personality: [
                        '[m202] empirical curiosity: Sora insists on smelling steam and tasting bitterness while comparing herbal potency',
                        '[m203] cheerful: Sora became more cheerful during the curriculum',
                        '[m204] competitive poise: Sora shows playful triumph while maintaining formal composure',
                    ],
                    speech: [
                        '[m202] clear empirical declarations: Sora gives crisp declarations while analyzing botanical potency',
                        '[m204] measured cadence: Sora speaks in a measured ladylike cadence at the banquet',
                    ],
                },
                personalityState: 'refine',
                personality: npc.personality,
                personalityReason: 'Maintains her cheerful ambition while developing stronger empirical curiosity.',
                speechState: 'refine',
                speech: npc.speech,
                speechReason: 'Her analytical declarations and measured public cadence were repeatedly observed.',
                developmentScale: 'batch',
                developmentReason: REASON,
            }],
        },
        { turn: 204, sourceMessageId: 204, developmentContext: EPISODE, allowTargetedDurableSeed: true },
    );
    const rows = result.report.profileDevelopment;
    for (const field of ['personality', 'speech']) {
        const row = rows.find(item => item.field === field);
        assert.equal(row?.outcome, 'waiting-for-revised-candidate');
        assert.equal(row?.candidateAlreadyRepresented, true);
        assert.equal(row?.evidenceAlreadyRepresented, false);
        assert.equal(row?.evidenceResolved, false);
    }
    const sora = result.state.npcs[0];
    assert.ok(sora.personalityDevelopment?.concepts?.length > 0);
    assert.ok(sora.speechDevelopment?.concepts?.length > 0);
    assert.ok((sora.profileEvidence?.personality || []).length > 0);
    assert.ok((sora.profileEvidence?.speech || []).length > 0);
});

test('v1.0.25 redundant evidence may resolve without forcing wording churn', () => {
    const current = 'Measured, soft-spoken, melodic and thoroughly polite in formal company.';
    assert.equal(durableProfileEvidenceAlreadyRepresented('speech', current, [
        '[m202] measured: measured delivery remains steady in formal company',
        '[m203] soft-spoken: soft-spoken delivery stays gentle in formal company',
        '[m204] melodic: melodic cadence recurs in formal company',
    ]), true);
    assert.equal(durableProfileEvidenceAlreadyRepresented('speech', current, [
        '[m202] empirical declarations: crisp empirical declarations accompany botanical analysis',
    ]), false);
});

test('v1.0.25 unchanged Behavioral Profile retains novel evidence and diagnoses stale candidate', () => {
    const npc = soraBase();
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 201 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    behaviorProfile: ['[m202] seasonal resin cataloguing: systematically compares resin yields across temperature bands'],
                },
                behaviorProfileState: 'refine',
                behaviorProfile: npc.behaviorProfile,
                behaviorProfileReason: 'Sustained empirical study expanded into seasonal comparative cataloguing.',
                developmentScale: 'batch',
                developmentReason: REASON,
            }],
        },
        { turn: 204, sourceMessageId: 204, developmentContext: EPISODE, allowTargetedDurableSeed: true },
    );
    const row = result.report.profileDevelopment.find(item => item.field === 'behaviorProfile');
    assert.equal(row?.outcome, 'waiting-for-revised-candidate');
    assert.equal(row?.candidateAlreadyRepresented, true);
    assert.equal(row?.evidenceAlreadyRepresented, false);
    assert.equal(row?.evidenceResolved, false);
    assert.ok((result.state.npcs[0].profileEvidence?.behaviorProfile || []).length > 0);
});

test('v1.0.25 provider prompts forbid unchanged refine/evolve candidates', () => {
    const npc = soraBase();
    const refresh = buildProfileRefreshPrompt({ transcript: EPISODE, targetNpc: npc, userName: 'Lucien', charName: 'Narrator' });
    assert.match(refresh, /changed FULL CURRENT candidate/i);
    assert.match(refresh, /never claim refine\/evolve with a copied field/i);
    const routine = buildScannerPrompt({ transcript: EPISODE, existingNpcs: [npc], userName: 'Lucien', charName: 'Narrator' });
    assert.match(routine, /Time-compressed refine\/evolve\/change MUST include developmentReason \+ changed FULL candidate/i);
    assert.match(routine, /unchanged\/reinforcing=>omit\/keep/i);
});
