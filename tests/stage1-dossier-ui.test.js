import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseDossierSelection,
  dossierDetailProjection,
  dossierIndexProjection,
  dossierLifeBucket,
  dossierStatusLabel,
  filterDossierIndex,
  projectDossierState,
  sortDossierIndex,
} from '../dossier-ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const uiSource = fs.readFileSync(path.join(root, 'dossier-ui.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');

const cast = [
  { id: 'mira', name: 'Mira', role: 'Scout', species: 'Human', homeBase: 'Northwatch Lodge', present: false, worldActive: true, location: 'North road' },
  { id: 'sora', name: 'Sora', aliases: ['Stormcrown'], role: 'Ward', species: 'Chimera', present: true, worldActive: false, mood: 'Curious', relationship: { trust: 12 } },
  { id: 'old', name: 'Old Clerk', role: 'Clerk', archived: true, archiveReason: 'stale' },
  { id: 'fallen', name: 'Fallen Guard', role: 'Guard', archived: true, archiveReason: 'deceased', lifeState: 'dead' },
];

test('Stage 1 lifecycle buckets are presentation-only and expose active archived dead filters', () => {
  assert.equal(dossierLifeBucket(cast[0]), 'active');
  assert.equal(dossierLifeBucket(cast[2]), 'archived');
  assert.equal(dossierLifeBucket(cast[3]), 'dead');
  assert.equal(dossierStatusLabel(cast[1]), 'In chat');
  assert.equal(dossierStatusLabel(cast[0]), 'Active off-screen');
  assert.equal(dossierStatusLabel(cast[2]), 'Archived · stale');
  assert.equal(dossierStatusLabel(cast[3]), 'Deceased');
});

test('Stage 1 cast ordering keeps present and active dossiers first', () => {
  const rows = sortDossierIndex(cast.map(npc => dossierIndexProjection(npc)));
  assert.deepEqual(rows.map(row => row.id), ['sora', 'mira', 'old', 'fallen']);
});

test('Stage 1 cast search and lifecycle filters compose', () => {
  const rows = cast.map(npc => dossierIndexProjection(npc));
  assert.deepEqual(filterDossierIndex(rows, { query: 'stormcrown' }).map(row => row.id), ['sora']);
  assert.deepEqual(filterDossierIndex(rows, { query: 'north road', filter: 'active' }).map(row => row.id), ['mira']);
  assert.deepEqual(filterDossierIndex(rows, { query: 'northwatch lodge', filter: 'active' }).map(row => row.id), ['mira']);
  assert.deepEqual(filterDossierIndex(rows, { filter: 'archived' }).map(row => row.id), ['old']);
  assert.deepEqual(filterDossierIndex(rows, { filter: 'dead' }).map(row => row.id), ['fallen']);
});

test('Stage 1 selection survives updates while the selected dossier remains visible', () => {
  const rows = sortDossierIndex(cast.map(npc => dossierIndexProjection(npc)));
  const visible = filterDossierIndex(rows, { filter: 'active' });
  assert.equal(chooseDossierSelection('mira', visible, rows), 'mira');
  assert.equal(chooseDossierSelection('old', visible, rows), 'sora');
  assert.equal(chooseDossierSelection('', [], rows), 'sora');
  const updated = rows.map(row => row.id === 'mira' ? { ...row, status: 'Moving' } : row);
  assert.equal(chooseDossierSelection('mira', filterDossierIndex(updated, { filter: 'active' }), updated), 'mira');
});

test('Stage 1 projections stay read-only and discard heavy history fields', () => {
  const source = {
    turn: 9,
    portraitAssets: { sora: { dataUrl: 'data:image/png;base64,AA==' } },
    npcs: [{
      ...cast[1],
      appearance: 'Golden-blue hair.',
      behaviorProfile: ['Observant', 'Proud'],
      memories: ['First meeting'],
      relationshipHistory: [{ reason: 'heavy history should not reach the view projection' }],
      branchSnapshots: [{ huge: true }],
    }],
  };
  const before = structuredClone(source);
  const projected = projectDossierState(source, { chatKey: 'chat-1', hydrationStatus: 'ready' });
  assert.deepEqual(source, before);
  assert.equal(projected.turn, 9);
  assert.equal(projected.npcs[0].portrait, 'data:image/png;base64,AA==');
  assert.equal(projected.npcs[0].relationship.trust, 12);
  assert.equal('relationshipHistory' in projected.npcs[0], false);
  assert.equal('branchSnapshots' in projected.npcs[0], false);
});

test('Stage 1 no-chat projection does not create or mutate dossier state', () => {
  const projected = projectDossierState({}, { chatKey: 'no-chat', hydrationStatus: 'ready' });
  assert.equal(projected.chatKey, 'no-chat');
  assert.deepEqual(projected.npcs, []);
  assert.deepEqual(projected.index, []);
});

test('Detail projection preserves editable fields and represents a flat appearance as one safe Base form', () => {
  const projected = dossierDetailProjection({
    id: 'ryu', name: 'Ryu', species: 'Chimera', homeBase: 'Towerhouse', age: '6 years', apparentAge: '~6',
    appearance: 'Long silver hair.', personality: 'Composed', speech: 'Precise',
    behaviorProfile: ['Analytical'], mannerisms: ['Studies details'], background: 'Unknown past',
    mood: 'Calm', location: 'Towerhouse', goal: 'Observe', status: 'Well',
    keyRelationships: ['Lucien - guardian'], memories: ['Learned to read'],
    relationshipSummary: 'Quiet trust', relationship: { trust: 9, affection: 4, desire: 0, tension: -2 },
  });
  assert.equal(projected.appearance, 'Long silver hair.');
  assert.equal(projected.homeBase, 'Towerhouse');
  assert.deepEqual(projected.behaviorProfile, ['Analytical']);
  assert.equal(projected.relationship.trust, 9);
  assert.deepEqual(projected.appearanceModel.appearanceForms, [{ name: 'Base', appearance: 'Long silver hair.' }]);
  assert.equal(projected.appearanceModel.currentForm, 'Base');
});

test('Stage 1 UI is a thin adapter over the existing runtime editor/settings owners', () => {
  assert.match(uiSource, /this\.api\.openEditor\(id\)/);
  assert.match(uiSource, /Behavioral Levers/);
  assert.match(uiSource, /Player Dynamic/);
  assert.match(uiSource, /Condition \/ Activity/);
  assert.match(uiSource, /Home Base \/ Usual Location/);
  assert.doesNotMatch(uiSource, /proseHtml\(selected\.appearance\)/, 'resolved flat appearance must not be rendered beside the form model');
  assert.match(uiSource, /npc_state_delta_settings/);
  assert.match(uiSource, /MutationObserver/);
  assert.doesNotMatch(uiSource, /persistCritical\s*\(/);
  assert.doesNotMatch(uiSource, /applyNpcStateCommand\s*\(/);
  assert.doesNotMatch(uiSource, /relationshipDelta\s*=/);
  assert.doesNotMatch(uiSource, /scanNow\s*\(/);
});

test('Stage 1 UI loads after the canonical legacy runtime and remains package-reachable', () => {
  const engine = bootstrap.indexOf("await import('./index.js')");
  const ui = bootstrap.indexOf("await import('./dossier-ui.js')");
  assert.ok(engine >= 0, 'canonical runtime import missing');
  assert.ok(ui > engine, 'Stage 1 UI must load after the canonical runtime API exists');
});
