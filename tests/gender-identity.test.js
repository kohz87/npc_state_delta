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
