import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackfillPrompt,
  buildDossierImportPrompt,
  buildProfileRefreshPrompt,
  buildScannerPrompt,
  createNpcRecord,
  mergeScanResult,
  normalizeNpcRecord,
} from '../core.js';

test('dossier consolidation retires legacy Importance and generic manual metadata', () => {
  const created = createNpcRecord('Mira');
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'importance'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'manual'), false);

  const migrated = normalizeNpcRecord({ name: 'Mira', importance: 99, manual: true });
  assert.equal(Object.prototype.hasOwnProperty.call(migrated, 'importance'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(migrated, 'manual'), false);
});

test('Home Base is durable ongoing-life geography, separate from current Location', () => {
  const migrated = normalizeNpcRecord({
    name: 'Vrena',
    whereToFind: 'East Ward Hospice',
    location: 'Lucien\'s towerhouse',
  });
  assert.equal(migrated.homeBase, 'East Ward Hospice');
  assert.equal(migrated.location, 'Lucien\'s towerhouse');

  const npc = createNpcRecord('Vrena');
  const established = mergeScanResult({ npcs: [npc], turn: 1 }, { npcs: [{
    id: npc.id,
    homeBase: 'East Ward Hospice',
    location: 'Lucien\'s towerhouse',
  }] }, {
    turn: 2,
    developmentContext: 'Vrena normally works and can be found at the East Ward Hospice. Today she is visiting Lucien\'s towerhouse.',
  }).state.npcs[0];
  assert.equal(established.homeBase, 'East Ward Hospice');
  assert.equal(established.location, 'Lucien\'s towerhouse');

  const transient = mergeScanResult({ npcs: [established], turn: 2 }, { npcs: [{
    id: npc.id,
    homeBase: 'Lucien\'s towerhouse',
  }] }, {
    turn: 3,
    developmentContext: 'Vrena is spending the afternoon at Lucien\'s towerhouse.',
  }).state.npcs[0];
  assert.equal(transient.homeBase, 'East Ward Hospice', 'a temporary scene must not silently replace durable Home Base');

  const relocated = mergeScanResult({ npcs: [transient], turn: 3 }, { npcs: [{
    id: npc.id,
    homeBase: 'Towerhouse Infirmary',
    homeBaseState: 'update',
    homeBaseReason: 'Vrena permanently relocated her practice to the Towerhouse Infirmary.',
  }] }, {
    turn: 4,
    developmentContext: 'Vrena permanently relocated her practice to the Towerhouse Infirmary and now works there on ordinary days.',
  }).state.npcs[0];
  assert.equal(relocated.homeBase, 'Towerhouse Infirmary');

  const locked = normalizeNpcRecord({ ...relocated, manualProfileLocksExplicit: true, manualProfileFields: ['homeBase'] });
  const blocked = mergeScanResult({ npcs: [locked], turn: 4 }, { npcs: [{
    id: npc.id,
    homeBase: 'Harbor Clinic',
    homeBaseState: 'update',
    homeBaseReason: 'She moved again.',
  }] }, {
    turn: 5,
    developmentContext: 'Vrena moved her practice to the Harbor Clinic.',
  }).state.npcs[0];
  assert.equal(blocked.homeBase, 'Towerhouse Infirmary');
});

test('model-facing dossier contracts include Home Base and no longer request Importance', () => {
  const npc = normalizeNpcRecord({
    id: 'npc_vrena',
    name: 'Vrena',
    homeBase: 'East Ward Hospice',
    location: 'Towerhouse',
  });
  const prompts = [
    buildScannerPrompt({ transcript: 'Vrena works at the East Ward Hospice.', existingNpcs: [npc] }),
    buildProfileRefreshPrompt({ transcript: 'Vrena works at the East Ward Hospice.', targetNpc: npc }),
    buildBackfillPrompt({ transcript: 'Vrena works at the East Ward Hospice.', targetName: 'Vrena', existingNpc: npc }),
    buildDossierImportPrompt({ dossierText: 'Where to Find Them: East Ward Hospice', targetName: 'Vrena', existingNpc: npc }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /homeBase|HOME BASE|Home Base|Where to Find Them/i);
    assert.doesNotMatch(prompt, /"importance"\s*:/i);
    assert.doesNotMatch(prompt, /Importance is manual|Importance manual/i);
  }
});
