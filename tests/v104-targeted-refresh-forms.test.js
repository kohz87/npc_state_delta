import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProfileRefreshPrompt,
    createNpcRecord,
    mergeScanResult,
} from '../core.js';

function ryuChimericRecord() {
    const npc = createNpcRecord('Ryu');
    return {
        ...npc,
        species: 'Silver Dragon Chimera',
        overallAppearance: 'Long silver hair and grey-blue eyes.',
        appearanceForms: [{
            name: 'Chimeric',
            appearance: 'Silver horns at her temples, broad bat-like wings, and a dark spade-tipped tail.',
        }],
        currentForm: 'Chimeric',
        currentFormUnknown: false,
        appearanceModelVersion: 1,
        appearance: 'Long silver hair and grey-blue eyes; silver horns at her temples, broad bat-like wings, and a dark spade-tipped tail.',
    };
}

const transitionText = `Ryu's silver horns thinned into pale glowing vapor and dissolved from her temples. Her broad bat-like wings broke into cool silver dust and vanished into her shoulders. Her dark spade-tipped tail retracted into her lower back until her smooth forehead and ordinary child silhouette remained.`;

test('v1.0.4 targeted Refresh declares appearance-form output and natural transition handling', () => {
    const targetNpc = ryuChimericRecord();
    const prompt = buildProfileRefreshPrompt({
        transcript: transitionText,
        targetNpc,
        userName: 'Lucien',
        charName: 'Narrator',
    });

    assert.match(prompt, /REFRESH: visible anatomy changes are form evidence/i);
    assert.match(prompt, /"appearanceState":"refine\|change","appearance":"","appearanceReason":"","overallAppearance":""/);
    assert.match(prompt, /"appearanceForms":\[\{"name":"stable established form name"/);
    assert.match(prompt, /"currentFormState":"keep\|select\|unknown"/);
    assert.match(prompt, /Established Stage 4 appearance forms/);
    assert.match(prompt, /"name":"Chimeric"/);
});

test('v1.0.4 targeted Refresh profile update can switch to an unnamed current presentation without erasing alternate anatomy', () => {
    const targetNpc = ryuChimericRecord();
    const initialState = {
        npcs: [targetNpc],
        candidates: [],
        dismissed: [],
        socialGraph: { version: 1, edges: [], unresolved: [] },
        turn: 4,
    };
    const scanResult = {
        npcs: [{
            id: targetNpc.id,
            name: 'Ryu',
            relationshipImpact: 'none',
            relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
        }],
        profileUpdates: [{
            id: targetNpc.id,
            evidence: { appearance: ['horns dissolved; wings vanished; tail retracted'] },
            appearance: 'Long silver hair and grey-blue eyes; smooth forehead with no horns, no wings, and no tail.',
            appearanceState: 'change',
            appearanceReason: 'Her horns dissolved, wings vanished into her shoulders, and tail retracted into her lower back.',
            currentForm: '',
            currentFormState: 'unknown',
            currentFormReason: 'The story visibly changes her anatomy but does not establish a stable name for this presentation.',
        }],
        keyRelationshipEdges: [],
    };

    const merged = mergeScanResult(initialState, scanResult, {
        turn: 5,
        sourceMessageId: 12,
        developmentContext: transitionText,
        skipRelationshipUpdate: true,
        allowTargetedDurableSeed: true,
    });
    const saved = merged.state.npcs.find(npc => npc.id === targetNpc.id);

    assert.ok(saved);
    assert.equal(saved.currentForm, '');
    assert.equal(saved.currentFormUnknown, true);
    assert.match(saved.unclassifiedAppearance, /smooth forehead/i);
    assert.ok(saved.appearanceForms.some(form => form.name === 'Chimeric'));
    assert.match(saved.appearanceForms.find(form => form.name === 'Chimeric').appearance, /bat-like wings/i);
    assert.doesNotMatch(saved.appearance, /bat-like wings/i);
});
