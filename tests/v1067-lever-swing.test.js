import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScannerPrompt, createNpcRecord, mergeScanResult } from '../core.js';

const DISPOSITION = 'Disposition: reserved - practical and guarded';
const AVOIDANT = 'Conflict/Assertiveness: avoidant - answers challenges with cold politeness';
const ASSERTIVE = 'Conflict/Assertiveness: assertive - confronts rule-breakers directly and holds her ground';

function malia() {
    const npc = createNpcRecord('Malia');
    npc.present = true;
    npc.personality = 'Reserved, practical and wary of strangers.';
    npc.behaviorProfile = [DISPOSITION, AVOIDANT];
    return npc;
}

function evolveScan(npc, evidence, turn) {
    const context = `[m${turn}] ${evidence}.`;
    return mergeScanResult({ npcs: [npc], turn }, { npcs: [], profileUpdates: [{
        id: npc.id,
        name: 'Malia',
        behaviorProfileState: 'evolve',
        behaviorProfileReason: 'She has started confronting troublemakers directly.',
        behaviorProfile: [DISPOSITION, ASSERTIVE],
        evidence: { behaviorProfile: [evidence] },
    }] }, { developmentContext: context, sourceMessageId: turn, turn });
}

test('automatic scan prompt allows Behavioral Profile evolve with a reason', () => {
    const prompt = buildScannerPrompt({ transcript: 'Malia answers.', existingNpcs: [malia()], userName: 'Ari', charName: 'Narrator' });
    assert.match(prompt, /personality\/speech\/mannerism\/behaviorProfile "evolve"\+reason/);
});

test('one scene cannot swing a lever; a second scene of the same behaviour can', () => {
    const first = evolveScan(malia(), 'Malia confronts the drunk boarder directly and holds her ground', 10);
    assert.deepEqual(first.state.npcs[0].behaviorProfile, [DISPOSITION, AVOIDANT]);
    assert.equal(first.state.npcs[0].profileEvidence.behaviorProfile.length, 1, 'the first sighting is kept as pending evidence');

    const second = evolveScan(first.state.npcs[0], 'Malia confronts the late-paying boarder directly and holds her ground', 14);
    assert.deepEqual(second.state.npcs[0].behaviorProfile, [DISPOSITION, ASSERTIVE]);
    assert.equal(second.report.profileDevelopment.find(row => row.field === 'behaviorProfile')?.outcome, 'applied-evolve');
});

test('re-scanning the same observation or unrelated behaviour does not count as a second sighting', () => {
    const observation = 'Malia confronts the drunk boarder directly and holds her ground';
    const first = evolveScan(malia(), observation, 10);
    const replay = evolveScan(first.state.npcs[0], observation, 10);
    assert.deepEqual(replay.state.npcs[0].behaviorProfile, [DISPOSITION, AVOIDANT]);

    const unrelated = evolveScan(first.state.npcs[0], 'Malia hums while hanging laundry in the courtyard', 14);
    assert.deepEqual(unrelated.state.npcs[0].behaviorProfile, [DISPOSITION, AVOIDANT]);
});
