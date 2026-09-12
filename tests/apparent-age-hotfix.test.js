import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildScannerPrompt,
    mergeScanResult,
    normalizeNpcRecord,
} from '../core.js';

test('grounded appearance age cues recover apparentAge when the scanner omits the field', () => {
    const young = normalizeNpcRecord({ id: 'npc_mara', name: 'Mara', appearance: 'A young woman with silver hair and grey eyes.' });
    assert.equal(young.age, '');
    assert.match(young.apparentAge, /^~\d+$/);
    assert.ok(Number(young.apparentAge.slice(1)) >= 18 && Number(young.apparentAge.slice(1)) <= 29);

    const exact = normalizeNpcRecord({ id: 'npc_talia', name: 'Talia', appearance: 'A 24-year-old woman with a cropped black bob.' });
    assert.equal(exact.age, '');
    assert.equal(exact.apparentAge, '~24');

    const decade = normalizeNpcRecord({ id: 'npc_sera', name: 'Sera', appearance: 'A woman in her early thirties with tired amber eyes.' });
    assert.match(decade.apparentAge, /^~3[0-3]$/);
});

test('appearance fallback remains conservative and never derives age from species alone', () => {
    const elf = normalizeNpcRecord({ id: 'npc_elaria', name: 'Elaria', species: 'Elf', appearance: 'Tall elf with silver hair and clear green eyes.' });
    assert.equal(elf.age, '');
    assert.equal(elf.apparentAge, '');
});

test('first-pass scanner requires and locally recovers grounded apparent age', () => {
    const prompt = buildScannerPrompt({
        transcript: 'Mara is a young woman with cropped auburn hair and grey eyes.',
        existingNpcs: [],
        userName: 'Ari',
        charName: 'Narrator',
    });
    assert.match(prompt, /Age\/ApparentAge separate/i);
    assert.match(prompt, /apparentAge=visual cue/i);
    assert.match(prompt, /MUST return apparentAge when age unknown/i);
    assert.match(prompt, /no species-aging inference/i);

    const result = mergeScanResult({ npcs: [], turn: 0 }, { npcs: [{
        name: 'Mara', identityKind: 'proper_name', dossierSignal: 'meaningful',
        appearance: 'A young woman with cropped auburn hair and grey eyes.', present: true,
    }] }, { turn: 1, transcript: 'Mara is a young woman with cropped auburn hair and grey eyes.' });
    assert.equal(result.state.npcs.length, 1);
    assert.equal(result.state.npcs[0].age, '');
    assert.match(result.state.npcs[0].apparentAge, /^~\d+$/);
});
