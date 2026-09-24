import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildNpcPortraitPrompts,
    buildProfileRefreshPrompt,
    buildScannerPrompt,
    createNpcRecord,
    mergeScanResult,
    normalizeGender,
    normalizeNpcRecord,
} from '../core.js';
import {
    dossierIndexProjection,
    filterDossierIndex,
    projectDossierState,
} from '../dossier-ui.js';
import { encodeNpcStateBundle, decodeNpcStateBundle } from '../bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dossierUiSource = fs.readFileSync(path.join(root, 'dossier-ui.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

test('gender is canonical male/female identity metadata with blank unknown', () => {
    assert.equal(normalizeGender('male'), 'male');
    assert.equal(normalizeGender('Man'), 'male');
    assert.equal(normalizeGender('boy'), 'male');
    assert.equal(normalizeGender('female'), 'female');
    assert.equal(normalizeGender('Woman'), 'female');
    assert.equal(normalizeGender('girl'), 'female');
    assert.equal(normalizeGender(''), '');
    assert.equal(normalizeGender('unknown'), '');
    assert.equal(normalizeGender('nonbinary'), '');

    assert.equal(createNpcRecord('Unspecified').gender, '');
    assert.equal(normalizeNpcRecord({ name: 'Mira', gender: 'Female' }).gender, 'female');
    assert.equal(normalizeNpcRecord({ name: 'Toris', sex: 'male' }).gender, 'male');
});

test('scanner establishes gender but cannot silently flip an established value', () => {
    const npc = createNpcRecord('Mira');
    const established = mergeScanResult({ npcs: [npc], turn: 1 }, {
        npcs: [{ id: npc.id, name: npc.name, gender: 'female' }],
    }, { turn: 2, developmentContext: 'Mira is a woman serving at the inn.' }).state.npcs[0];
    assert.equal(established.gender, 'female');

    const accidentalFlip = mergeScanResult({ npcs: [established], turn: 2 }, {
        npcs: [{ id: npc.id, name: npc.name, gender: 'male' }],
    }, { turn: 3, developmentContext: 'Mira continues her work at the inn.' }).state.npcs[0];
    assert.equal(accidentalFlip.gender, 'female');

    const corrected = mergeScanResult({ npcs: [accidentalFlip], turn: 3 }, {
        npcs: [{
            id: npc.id,
            name: npc.name,
            gender: 'male',
            genderState: 'correct',
            genderReason: 'The story explicitly corrects the earlier record and identifies Mira as male.',
        }],
    }, { turn: 4, developmentContext: 'The record was mistaken; Mira is explicitly identified as male.' }).state.npcs[0];
    assert.equal(corrected.gender, 'male');
});

test('alias dedupe preserves stable identity learned on the canonical proper-name record', () => {
    const interim = normalizeNpcRecord({
        ...createNpcRecord('half-elf girl'),
        id: 'npc_interim',
        createdAt: 1,
        updatedAt: 10,
    });
    const named = normalizeNpcRecord({
        ...createNpcRecord('Cerys'),
        id: 'npc_cerys',
        aliases: ['half-elf girl'],
        gender: 'female',
        homeBase: 'The Horn & Flue, Gatefall',
        createdAt: 2,
        updatedAt: 20,
    });
    const merged = mergeScanResult({ npcs: [interim, named], turn: 2 }, { npcs: [] }, { turn: 2 });
    assert.equal(merged.state.npcs.length, 1);
    assert.equal(merged.state.npcs[0].id, 'npc_interim', 'the older dossier remains the continuity owner');
    assert.equal(merged.state.npcs[0].name, 'Cerys');
    assert.equal(merged.state.npcs[0].gender, 'female');
    assert.equal(merged.state.npcs[0].homeBase, 'The Horn & Flue, Gatefall');
});

test('alias dedupe cannot overwrite manually locked stable profile fields', () => {
    const locked = normalizeNpcRecord({
        ...createNpcRecord('half-elf girl'),
        id: 'npc_locked_interim',
        gender: 'female',
        homeBase: 'Lower Caravan Yard',
        personality: 'Quiet and wary.',
        mannerisms: ['Keeps her gaze lowered.'],
        behaviorProfile: ['Independence: guarded around strangers.'],
        keyRelationships: ['Varn — cobbler | trusted outfitter'],
        manualProfileLocksExplicit: true,
        manualProfileFields: ['gender', 'homeBase', 'personality', 'mannerisms', 'behaviorProfile', 'keyRelationships'],
        createdAt: 1,
        updatedAt: 10,
    });
    const duplicate = normalizeNpcRecord({
        ...createNpcRecord('Cerys'),
        id: 'npc_duplicate_named',
        aliases: ['half-elf girl'],
        gender: 'male',
        homeBase: 'Wrong New Address',
        personality: 'Verbose automatic text that must not replace the player-locked personality.',
        mannerisms: ['Automatic replacement gesture.'],
        behaviorProfile: ['Disposition: automatic replacement.'],
        keyRelationships: ['Someone Else — friend | automatic duplicate'],
        createdAt: 2,
        updatedAt: 20,
    });
    const merged = mergeScanResult({ npcs: [locked, duplicate], turn: 3 }, { npcs: [] }, { turn: 3 }).state.npcs[0];
    assert.equal(merged.name, 'Cerys');
    assert.equal(merged.gender, 'female');
    assert.equal(merged.homeBase, 'Lower Caravan Yard');
    assert.equal(merged.personality, 'Quiet and wary.');
    assert.deepEqual(merged.mannerisms, ['Keeps her gaze lowered.']);
    assert.deepEqual(merged.behaviorProfile, ['Independence: guarded around strangers.']);
    assert.deepEqual(merged.keyRelationships, ['Varn — cobbler | trusted outfitter']);
    assert.ok(merged.manualProfileFields.includes('personality'));
});

test('alias dedupe preserves manually locked Name and full Stage 4 Appearance state', () => {
    const locked = normalizeNpcRecord({
        ...createNpcRecord('half-elf girl'),
        id: 'npc_locked_identity',
        appearanceModelVersion: 1,
        appearance: 'Burnished bronze hair; charcoal wool smock.',
        overallAppearance: 'Burnished bronze hair.',
        appearanceForms: [{ name: 'Base', appearance: 'Charcoal wool smock; greased bull-hide boots.' }],
        currentForm: 'Base',
        manualProfileLocksExplicit: true,
        manualProfileFields: ['name', 'appearance'],
        createdAt: 1,
        updatedAt: 10,
    });
    const duplicate = normalizeNpcRecord({
        ...createNpcRecord('Cerys'),
        id: 'npc_named_duplicate',
        aliases: ['half-elf girl'],
        appearanceModelVersion: 1,
        appearance: 'Wrong silver hair.',
        overallAppearance: 'Wrong shared appearance.',
        appearanceForms: [{ name: 'Base', appearance: 'Wrong clothing.' }],
        currentForm: 'Base',
        createdAt: 2,
        updatedAt: 20,
    });
    const expectedAppearance = {
        appearance: locked.appearance,
        overallAppearance: locked.overallAppearance,
        unclassifiedAppearance: locked.unclassifiedAppearance,
        appearanceForms: structuredClone(locked.appearanceForms),
        currentForm: locked.currentForm,
        currentFormUnknown: locked.currentFormUnknown,
        appearanceModelVersion: locked.appearanceModelVersion,
    };
    const merged = mergeScanResult({ npcs: [locked, duplicate], turn: 3 }, { npcs: [] }, { turn: 3 }).state.npcs[0];
    assert.equal(merged.name, 'half-elf girl');
    assert.ok(merged.aliases.includes('Cerys'));
    assert.deepEqual({
        appearance: merged.appearance,
        overallAppearance: merged.overallAppearance,
        unclassifiedAppearance: merged.unclassifiedAppearance,
        appearanceForms: merged.appearanceForms,
        currentForm: merged.currentForm,
        currentFormUnknown: merged.currentFormUnknown,
        appearanceModelVersion: merged.appearanceModelVersion,
    }, expectedAppearance, 'alias dedupe must preserve the normalized Stage 4 state owned by the lock');
    assert.doesNotMatch(JSON.stringify(merged.appearanceForms), /Wrong clothing/i);
    assert.ok(merged.manualProfileFields.includes('name'));
    assert.ok(merged.manualProfileFields.includes('appearance'));
});

test('portrait identity sends species then gender then apparent age before visual details', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Human',
        gender: 'female',
        apparentAge: '~20',
        role: 'Barmaid and scullery maid at the Fordhouse Inn',
        appearance: 'Brown hair tied back; green eyes. Wears a plain linen dress and apron.',
    }, {
        stylePositive: 'STYLE_LAST',
        styleNegative: '',
        composition: 'portrait',
        format: 'hybrid',
    });
    const species = prompts.positive.indexOf('Human');
    const gender = prompts.positive.indexOf('female');
    const age = prompts.positive.indexOf('apparent age ~20');
    const role = prompts.positive.indexOf('Barmaid and scullery maid at the Fordhouse Inn');
    assert.ok(species >= 0 && gender > species && age > gender && role > age);
});

test('scanner, refresh, backfill and dossier import all carry the explicit-only gender contract', () => {
    const npc = normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', species: 'Human', gender: 'female' });
    const prompts = [
        buildScannerPrompt({ transcript: 'Mira is a woman working at the inn.', existingNpcs: [npc] }),
        buildProfileRefreshPrompt({ transcript: 'Mira is a woman working at the inn.', targetNpc: npc }),
        buildBackfillPrompt({ transcript: 'Mira is a woman working at the inn.', targetName: 'Mira', existingNpc: npc }),
        buildDossierImportPrompt({ dossierText: 'Gender: Female', targetName: 'Mira', existingNpc: npc }),
    ];
    for (const prompt of prompts) {
        assert.match(prompt, /gender/i);
        assert.match(prompt, /male/i);
        assert.match(prompt, /female/i);
        assert.match(prompt, /never infer/i);
    }
});

test('dossier UI places gender between species and role and makes it searchable', () => {
    const npc = { id: 'mira', name: 'Mira', species: 'Human', gender: 'female', role: 'Barmaid', apparentAge: '~20' };
    const row = dossierIndexProjection(npc);
    assert.equal(row.gender, 'female');
    assert.deepEqual(filterDossierIndex([row], { query: 'female' }).map(item => item.id), ['mira']);
    const projected = projectDossierState({ npcs: [npc] }, { chatKey: 'chat-1', hydrationStatus: 'ready' });
    assert.equal(projected.index[0].gender, 'female');

    assert.match(dossierUiSource, /npc\?\.species,\s*\n\s*npc\?\.gender,\s*\n\s*npc\?\.role/);
    assert.match(dossierUiSource, /\[npc\.species, npc\.gender, npc\.role\]/);
    assert.match(runtimeSource, /id="npc_state_delta_edit_gender"/);
    assert.match(runtimeSource, /Gender<select/);
});

test('native bundle preserves canonical gender without a format bump', () => {
    const npc = normalizeNpcRecord({ ...createNpcRecord('Mira'), gender: 'female' });
    const bytes = encodeNpcStateBundle({ npcs: [npc] }, { chatKey: 'chat:test' });
    const decoded = decodeNpcStateBundle(bytes);
    assert.equal(decoded.state.npcs[0].gender, 'female');
});
