import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeScanResult, normalizeNpcRecord } from '../core.js';
import { mergeImportedDossierState } from '../bundle.js';
import { dossierDetailProjection, projectDossierState } from '../dossier-ui.js';
import { dossierFields } from '../src/storysuite-v2.js';

// Cleanup step 7 (audit I-8, I-9, I-13): an alias merge keeps the newer custom values and live
// state and honours an aliases lock; a bundle import honours the target's aliases lock; the Megumin
// dossier import merges configured custom fields like every other path; the dossier view and the v2
// npc.dossier query show the configured custom fields only.

function duplicates(extraNewer = {}) {
    const older = normalizeNpcRecord({ id: 'npc_archivist', name: 'The Archivist', identityKind: 'role_label', present: false,
        mood: 'Quietly irritated by the late shipment', status: 'Sorting old ledgers late into the night', customFields: { Level: '3', Class: 'Scholar' },
        memories: ['Typed: she hid the forged page.'], manualMemories: ['Typed: she hid the forged page.'], createdAt: 1, updatedAt: 10 });
    const newer = normalizeNpcRecord({ id: 'npc_myla', name: 'Myla Venn', aliases: ['The Archivist', 'Myla'], present: true,
        mood: 'Relieved', status: 'Packing', customFields: { level: '4' }, createdAt: 2, updatedAt: 20, ...extraNewer });
    return { older, newer };
}

function consolidate(older, newer) {
    const result = mergeScanResult({ turn: 3, npcs: [older, newer], candidates: [] }, { npcs: [] }, { turn: 4 });
    assert.equal(result.state.npcs.length, 1, 'the alias-linked duplicates are merged');
    return result.state.npcs[0];
}

test('alias merge: newer custom values and live state win; typed memories stay typed', () => {
    const { older, newer } = duplicates();
    const npc = consolidate(older, newer);
    assert.deepEqual(npc.customFields, { Class: 'Scholar', level: '4' }, 'the newer Level replaces the older one (it used to keep the older record\'s only)');
    assert.equal(npc.mood, 'Relieved', 'the most recently updated mood, not the longer one');
    assert.equal(npc.status, 'Packing');
    assert.ok(npc.memories.includes('Typed: she hid the forged page.'));
    assert.deepEqual(npc.manualMemories, ['Typed: she hid the forged page.']);
});

test('alias merge: a locked live field and locked custom fields keep their source', () => {
    const { older, newer } = duplicates();
    older.manualProfileFields = ['mood', 'customFields'];
    const npc = consolidate(older, newer);
    assert.equal(npc.mood, older.mood);
    assert.deepEqual(npc.customFields, { Level: '3', Class: 'Scholar' });
});

test('alias merge: hand-locked aliases take only the absorbed name', () => {
    const { older, newer } = duplicates({ manualProfileFields: ['aliases'], aliases: ['The Archivist', 'Myla'] });
    older.aliases = ['Old Ink', 'Ledger Lady'];
    const npc = consolidate(older, newer);
    assert.deepEqual(npc.aliases, ['The Archivist', 'Myla'], 'the old record\'s own aliases are not added to a locked list');
});

test('bundle import keeps the target\'s locked aliases', () => {
    const target = normalizeNpcRecord({ id: 'npc_myla', name: 'Myla Venn', aliases: ['Myla'], manualProfileFields: ['aliases'], manualProfileLocksExplicit: true });
    const imported = { ...structuredClone(target), id: 'foreign_myla', aliases: ['The Archivist', 'Ink Witch'], manualProfileFields: [] };
    const merged = mergeImportedDossierState({ npcs: [target], turn: 2 }, { npcs: [imported] }, { foreignOwnership: true });
    assert.deepEqual(merged.npcs.find(npc => npc.name === 'Myla Venn').aliases, ['Myla']);
    const unlocked = mergeImportedDossierState({ npcs: [{ ...target, manualProfileFields: [] }], turn: 2 }, { npcs: [imported] }, { foreignOwnership: true });
    assert.ok(unlocked.npcs[0].aliases.includes('Ink Witch'), 'without a lock the import still adds aliases');
});

test('the Megumin dossier import merges configured custom fields like every other path', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const importer = index.slice(index.indexOf('async function scanNpcDossier'), index.indexOf('function refreshChangedFields'));
    assert.match(importer, /customFieldNames: getSettings\(\)\.customFieldNames,/);
    const state = { turn: 2, npcs: [normalizeNpcRecord({ id: 'npc_myla', name: 'Myla Venn', customFields: { Level: '3' } })], candidates: [] };
    const out = mergeScanResult(state, { npcs: [{ id: 'npc_myla', name: 'Myla Venn', customFields: { Level: '4' }, customFieldsReason: 'Dossier says Level 4.' }] },
        { turn: 3, preservePresence: true, skipRelationshipUpdate: true, developmentContext: 'Name: Myla Venn\nLevel: 4', customFieldNames: ['Level'] });
    assert.equal(out.state.npcs[0].customFields.Level, '4');
});

test('the dossier view and npc.dossier show the configured custom fields only', () => {
    const npc = normalizeNpcRecord({ id: 'npc_myla', name: 'Myla', customFields: { Level: '4', Retired: 'old value' } });
    assert.deepEqual(dossierDetailProjection(npc, {}, {}, { customFieldNames: ['level'] }).customFields, [['Level', '4']]);
    assert.equal(dossierDetailProjection(npc).customFields.length, 2, 'older callers without names see every stored value');
    const projection = projectDossierState({ npcs: [npc], customFieldNames: ['Level'] }, { chatKey: 'c1' });
    assert.deepEqual(projection.npcs[0].customFields, [['Level', '4']], 'getDossierState passes the configured names');
    assert.deepEqual(dossierFields(npc, { customFieldNames: ['Level'] }).customFields, { Level: '4' });
    assert.deepEqual(dossierFields(npc).customFields, { Level: '4', Retired: 'old value' });
    assert.equal('customFields' in dossierFields(npc, { customFieldNames: [] }), false);
    const adapter = fs.readFileSync(new URL('../src/storysuite-v2.js', import.meta.url), 'utf8');
    assert.match(adapter, /const names = runtime\(\)\?\.customFieldNames\?\.\(\);/);
});
