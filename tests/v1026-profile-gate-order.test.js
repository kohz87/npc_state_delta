import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createNpcRecord,
    developmentEpisodeDiagnostic,
    developmentScaleReady,
    mergeScanResult,
} from '../core.js';

function soraBase() {
    const npc = createNpcRecord('Sora');
    npc.personality = 'Instinctive, gluttonous, and fiercely protective in private; inquisitive and playfully competitive, balancing a cheerful, demure student facade with sharp ambition.';
    npc.speech = 'Speaks with soft, melodic Ardessian etiquette and gentle cadence in public; shifts to rapid, serious declarations when analyzing biology, and blunt cries when distressed.';
    return npc;
}

const REASON = 'Two-month progression into collegiate rhetoric and chirurgery apprenticeship leading to the Suncrest 14 birthday banquet.';

test('v1.0.26 copied batch candidate is classified before a failed episode gate', () => {
    const npc = soraBase();
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 201 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    personality: [
                        '[m203] cheerful: becomes noticeably more cheerful and playfully competitive',
                        '[m204] demure poise: adopts a ladylike facade in high society',
                    ],
                },
                personalityState: 'refine',
                personality: npc.personality,
                personalityReason: 'Preserved core personality balanced with social cheer and emulation.',
                developmentScale: 'batch',
                developmentReason: REASON,
            }],
        },
        {
            turn: 204,
            sourceMessageId: 204,
            developmentContext: '[m202] Narrator: Two months passed. Ryu studied alone.\n[m203] Narrator: Sora laughed brightly.\n[m204] Narrator: Sora entered the banquet.',
            allowTargetedDurableSeed: true,
            developmentSourceMessageIds: [202, 203, 204],
        },
    );
    const row = result.report.profileDevelopment.find(item => item.field === 'personality');
    assert.equal(row?.candidateChanged, false);
    assert.equal(row?.candidateAlreadyRepresented, true);
    assert.equal(row?.evidenceAlreadyRepresented, false);
    assert.equal(row?.evidenceResolved, false);
    assert.equal(row?.outcome, 'waiting-for-revised-candidate');
    assert.ok((result.state.npcs[0].profileEvidence?.personality || []).length > 0);
});

test('v1.0.26 copied batch candidate can resolve only when its evidence is already represented', () => {
    const npc = soraBase();
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 201 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    speech: [
                        '[m204] gentle cadence: Speaks with soft, melodic Ardessian etiquette and gentle cadence in public',
                    ],
                },
                speechState: 'refine',
                speech: npc.speech,
                speechReason: 'Reinforces her established gentle public cadence.',
                developmentScale: 'batch',
                developmentReason: REASON,
            }],
        },
        {
            turn: 204,
            sourceMessageId: 204,
            developmentContext: '[m202] Narrator: Two months passed. Ryu studied alone.\n[m204] Narrator: Sora spoke politely.',
            allowTargetedDurableSeed: true,
            developmentSourceMessageIds: [202, 204],
        },
    );
    const row = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(row?.candidateChanged, false);
    assert.equal(row?.candidateAlreadyRepresented, true);
    assert.equal(row?.evidenceAlreadyRepresented, true);
    assert.equal(row?.evidenceResolved, true);
    assert.equal(row?.outcome, 'evidence-already-reflected');
});

test('v1.0.26 targeted source tags bridge a long montage beyond the generic sentence cap', () => {
    const filler = Array.from({ length: 20 }, (_, index) => `Unrelated scene-detail sentence ${index + 1}.`).join(' ');
    const context = [
        `[m202] Narrator: Two months passed. Sora studied collegiate rhetoric and continued her chirurgery apprenticeship throughout that time. ${filler}`,
        "[m203] Narrator: Sora adopts Seren's soft-spoken melodic cadence while practicing formal etiquette.",
        '[m204] Narrator: Sora speaks with measured, soft, thoroughly ladylike composure at the Suncrest birthday banquet.',
    ].join('\n');
    const binding = {
        npc: { id: 'npc_sora', name: 'Sora', aliases: [] },
        evidence: [
            "[m203] gentle cadence: Sora adopts Seren's soft-spoken melodic cadence while practicing formal etiquette",
            '[m204] soft spoken: Sora speaks with measured soft ladylike composure at the birthday banquet',
        ],
        targeted: true,
    };
    const diagnostic = developmentEpisodeDiagnostic(REASON, context, binding);
    assert.equal(diagnostic.detected, true);
    assert.equal(diagnostic.npcBound, true);
    assert.equal(diagnostic.grounded, true);
    assert.equal(diagnostic.anchorIndex, 202);
    assert.equal(developmentScaleReady('batch', REASON, context, binding), true);
});
