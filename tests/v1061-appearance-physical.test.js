import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appearanceDraftRecord, currentPresentationText, resolveNpcAppearance } from '../appearance.js';
import { createNpcRecord, mergeScanResult } from '../core.js';

// Scans go through the full production merge: the core applies an accepted flat Appearance update
// before the appearance model sees it, which is where physical traits used to be lost.
function outfitScan(npc, appearance, narration) {
    const scan = {
        npcs: [{ id: npc.id, name: npc.name, present: true }],
        profileUpdates: [{ id: npc.id, name: npc.name, appearanceState: 'change', appearance, appearanceReason: narration, evidence: { appearance: [narration] } }],
    };
    return mergeScanResult({ npcs: [npc], turn: 5 }, scan, { transcript: `[m4] Assistant: ${narration}`, sourceMessageId: 4 })
        .state.npcs.find(item => item.id === npc.id);
}
function npcWith(appearance, name = 'Myla') {
    const npc = createNpcRecord(name);
    npc.present = true;
    npc.appearance = appearance;
    return npc;
}

test('an outfit change through the full scan merge keeps hair, eyes, build and scars', () => {
    const merged = outfitScan(
        npcWith('Long silver hair, violet eyes, slender build, a thin scar across her left cheek; wearing a travel-stained blue cloak and leather boots.'),
        'Wearing an emerald ballgown with long silk gloves.',
        'Myla returns having changed into an emerald ballgown with long silk gloves.',
    );
    for (const trait of ['Long silver hair', 'violet eyes', 'slender build', 'scar across her left cheek', 'emerald ballgown']) assert.match(merged.appearance, new RegExp(trait));
    assert.doesNotMatch(merged.appearance, /blue cloak|leather boots/, 'the old outfit is replaced');
    const again = outfitScan(structuredClone(merged), 'Wearing an emerald ballgown with long silk gloves.', 'Myla returns having changed into an emerald ballgown with long silk gloves.');
    assert.equal(again.appearance, merged.appearance, 'repeating the scan is stable');
});

test('traits inside mixed clauses survive, and a passing changeable mention does not erase them', () => {
    const mixed = outfitScan(
        npcWith('A tall woman with long silver hair tied back with a blue ribbon, violet eyes and a slender build, wearing a blue cloak.'),
        'Wearing an emerald ballgown and silk gloves.',
        'Myla changed into an emerald ballgown and silk gloves.',
    );
    assert.match(mixed.appearance, /tall woman/);
    assert.match(mixed.appearance, /long silver hair/);
    assert.doesNotMatch(mixed.appearance, /blue ribbon|blue cloak/);
    const wet = outfitScan(
        npcWith('Long silver hair, violet eyes, pale skin; wearing a blue cloak.'),
        'Her hair is wet and plastered to her face; wearing a soaked linen shift.',
        'Myla climbed out of the river, her hair wet and plastered to her face, wearing a soaked linen shift.',
    );
    assert.match(wet.appearance, /Long silver hair/, 'wet hair is a condition, not a new hair description');
    const dyed = outfitScan(
        npcWith('Long silver hair, violet eyes, pale skin; wearing a blue cloak.'),
        'Long crimson hair tied with a black ribbon; wearing a leather jerkin.',
        'Myla had dyed her hair crimson, tied with a black ribbon, and wore a leather jerkin.',
    );
    assert.match(dyed.appearance, /crimson hair/);
    assert.doesNotMatch(dyed.appearance, /silver hair/, 'an explicit re-description still replaces the trait');
});

test('enduring physical features and the current outfit are edited and kept separately', () => {
    let npc = createNpcRecord('Myla');
    npc = appearanceDraftRecord(npc, {
        overallAppearance: 'Long silver hair, violet eyes, a thin scar across her left cheek',
        currentForm: '__none__',
        currentAppearance: 'Wearing a travel-stained blue cloak',
        formsText: '',
    });
    assert.equal(currentPresentationText(npc), 'Wearing a travel-stained blue cloak');
    assert.equal(resolveNpcAppearance(npc), 'Long silver hair, violet eyes, a thin scar across her left cheek; Wearing a travel-stained blue cloak');
    npc.present = true;
    const changed = outfitScan(npc, 'Wearing an emerald ballgown.', 'Myla changed into an emerald ballgown.');
    assert.equal(changed.overallAppearance, 'Long silver hair, violet eyes, a thin scar across her left cheek', 'an outfit change never touches physical features');
    assert.equal(currentPresentationText(changed), 'Wearing an emerald ballgown.');
    const restated = outfitScan(structuredClone(npc), 'Long silver hair, violet eyes; wearing an emerald ballgown.', 'Myla, silver hair and violet eyes, changed into an emerald ballgown.');
    assert.equal(restated.appearance.match(/silver hair/g)?.length, 1, 'restated physical features are not repeated');
});

test('applying the appearance editor on an NPC without named forms keeps its current appearance', () => {
    const npc = npcWith('Long silver hair, violet eyes; wearing a blue cloak.');
    const saved = appearanceDraftRecord(npc, { overallAppearance: '', currentForm: '__none__', unclassifiedAppearance: '', formsText: '' });
    assert.equal(saved.appearance, 'Long silver hair, violet eyes; wearing a blue cloak.', 'an unchanged Apply must not blank the appearance');
});

test('the dossier editor identifies its NPC so appearance, life-state and section add-ons mount', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const experience = fs.readFileSync(new URL('../dossier-experience.js', import.meta.url), 'utf8');
    const continuityUi = fs.readFileSync(new URL('../continuity-ui.js', import.meta.url), 'utf8');
    assert.match(index, /content\.id = 'npc_state_delta_editor_content';[\s\S]{0,200}content\.dataset\.npcId = npc\.id;/);
    assert.match(experience, /function editorNpcId\(editor\) \{\s*return plain\(editor\?\.querySelector\?\.\('\[data-npc-id\]'\)/);
    assert.match(continuityUi, /data-delta-current-appearance/);
    assert.match(experience, /\['npc_state_delta_edit_gender', false\]/, 'gender sits inside Identity & profile');
});
