import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearanceUpdate } from '../appearance.js';
import { buildBackfillPrompt, buildDossierImportPrompt, buildProfileRefreshPrompt, buildScannerPrompt, createNpcRecord, currentPresentationText, mergeScanResult } from '../core.js';

// She is introduced as "the half elf woman" and "she"; the story never names her.
const INTRO = "Ari: When I arrived, I saw Kora's son looking at the half elf woman, the woman wasn't exactly tall, her long black hair falls like a waterfall to her waist but her attires looked torn and worn out.\n"
    + 'Narrator: She was small, barely reaching your chest in height, her frame narrow and willowy beneath a shift of boiled gray linen so threadbare the weave parted at the shoulder seams. '
    + 'A cascade of straight, ink-black hair spilled past her shoulders, reaching down to her hips. The faint point of an ear showed through the dark strands, delicate and swept back.';
const PHYSICAL = 'Small and willowy, barely chest height; straight ink-black hair to her hips; faintly pointed, swept-back ears.';
const OUTFIT = 'Threadbare boiled gray linen shift parted at the shoulder seams.';

test('a first scan stores enduring physical features apart from the current outfit, even before the NPC is named', () => {
    const kora = createNpcRecord('Kora');
    const result = mergeScanResult({ npcs: [kora], candidates: [], turn: 1 }, { npcs: [{
        name: 'Elin', identityKind: 'proper_name', dossierSignal: 'meaningful', dossierReason: 'half-elf at the mill',
        sameIndividual: true, directInteraction: true, overallAppearance: PHYSICAL, appearance: OUTFIT, present: true,
    }] }, { developmentContext: INTRO, sourceMessageId: 1, turn: 1 });
    const elin = result.state.npcs.find(npc => npc.name === 'Elin');
    assert.equal(elin.overallAppearance, PHYSICAL);
    assert.equal(currentPresentationText(elin), OUTFIT);
    assert.equal(elin.appearance, `${PHYSICAL.replace(/\.$/, '')}; ${OUTFIT}`, 'resolved appearance joins them once, without ".;"');
});

test('physical features can move out of a stored outfit slot without the scene re-describing the body', () => {
    const elin = createNpcRecord('Elin');
    elin.present = true;
    elin.appearance = `${PHYSICAL.replace(/\.$/, '')}; ${OUTFIT}`;
    const result = mergeScanResult({ npcs: [elin, createNpcRecord('Kora')], turn: 9 }, { npcs: [], profileUpdates: [{
        id: elin.id, name: 'Elin', overallAppearance: PHYSICAL,
    }] }, { developmentContext: '[m9] Elin hauls another tub of water to the mill. Kora watches from the porch.', sourceMessageId: 9, turn: 9 });
    const updated = result.state.npcs.find(npc => npc.name === 'Elin');
    assert.equal(updated.overallAppearance, PHYSICAL);
    assert.equal(currentPresentationText(updated), OUTFIT, 'the outfit slot no longer repeats the physical features');
});

test('physical features the scene and stored appearance do not support are not seeded', () => {
    const elin = createNpcRecord('Elin');
    elin.present = true;
    elin.appearance = OUTFIT;
    const result = mergeScanResult({ npcs: [elin], turn: 9 }, { npcs: [], profileUpdates: [{
        id: elin.id, name: 'Elin', overallAppearance: 'Towering and broad-shouldered with a shaved head and green eyes.',
    }] }, { developmentContext: '[m9] Elin hauls another tub of water to the mill.', sourceMessageId: 9, turn: 9 });
    assert.equal(result.state.npcs[0].overallAppearance, '');
});

test('the outfit keeps pieces that add, negate or change a physical trait', () => {
    const model = applyAppearanceUpdate({ name: 'Elin', appearance: 'Straight ink-black hair to her hips, hair wet from the rain; not ink-black at the roots, gray linen shift.' }, {
        overallAppearance: 'Straight ink-black hair to her hips.',
    });
    const outfit = currentPresentationText(model);
    assert.match(outfit, /wet from the rain/);
    assert.match(outfit, /not ink-black at the roots/);
    assert.match(outfit, /gray linen shift/);
    assert.doesNotMatch(outfit, /^Straight ink-black hair to her hips,/);
});

test('scanner, Refresh, backfill and import prompts separate enduring body from current outfit', () => {
    const npc = createNpcRecord('Elin');
    const PHYS = /overallAppearance=enduring body (?:traits shared by all forms )?\(height\/build\/hair\/eyes\/ears\/skin\/marks\)/;
    assert.match(buildScannerPrompt({ transcript: 'Elin works.', existingNpcs: [npc], userName: 'Ari', charName: 'N' }), PHYS);
    assert.match(buildProfileRefreshPrompt({ transcript: '[m1] Elin works.', targetNpc: npc, userName: 'Ari', charName: 'N' }), PHYS);
    const backfill = buildBackfillPrompt({ transcript: 'Elin works.', targetName: 'Elin', existingNpc: npc });
    assert.match(backfill, PHYS);
    assert.match(backfill, /"overallAppearance":"enduring body traits","appearance":"current outfit\/gear\/condition"/);
    assert.match(buildDossierImportPrompt({ dossierText: 'Elin is small.', targetName: 'Elin', existingNpc: npc }), /Appearance=>overallAppearance \(enduring body\)\+appearance \(outfit\)/);
});
