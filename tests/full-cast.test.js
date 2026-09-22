import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modulePath = path.join(root, 'full-cast.js');
const source = fs.readFileSync(modulePath, 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');

test('full-cast owner parses and loads after the canonical runtime', () => {
  const result = spawnSync(process.execPath, ['--check', modulePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(bootstrap, /await import\('\.\/index\.js'\);[\s\S]*await import\('\.\/full-cast\.js'\);/);
  assert.doesNotMatch(bootstrap, /enhancements\.js/);
});

test('full cast scan remains opt-in and targets participation plus physical presence', () => {
  assert.match(source, /fullCastScanEveryTurn/);
  assert.match(source, /if \(npc\.present\) ids\.add\(npc\.id\)/);
  assert.match(source, /npcParticipatesInExchange\(npc, npcs, exchangeText\)/);
  assert.match(source, /before\.get\(npc\.id\) !== fingerprint\(npc\)/);
  assert.match(source, /await npcApi\.refreshFromChat\(id\)/);
  assert.match(source, />Full cast scan</);
});

test('superseded enhancement dossier library is not retained beside Stage 1 UI', () => {
  assert.doesNotMatch(source, /Dossier Library/);
  assert.doesNotMatch(source, /npc-state-delta-library/);
  assert.doesNotMatch(source, /openLibrary|closeLibrary|renderLibrary/);
});

test('full-cast manual action mounts only in the Scanning action group', () => {
  assert.match(source, /delta-settings-scanning-actions/);
  assert.match(source, /npc_state_delta_full_scan_every_turn/);
  assert.match(source, /legacyScan\?\.closest\?\.\('\.npc-state-delta-actions'\)/);
  assert.doesNotMatch(source, /panel\.querySelector\('\.npc-state-delta-actions'\)/);
});

test('Diagnostics can request the manual full-cast scan without owning scanner logic', () => {
  assert.match(source, /npc-state-delta:request-full-cast-scan/);
  assert.match(source, /runFullCastScan\(latestAssistantId\(\), snapshot\(\), \{ manual: true \}\)/);
});

test('full-cast owner never patches the host text-model route', () => {
  assert.doesNotMatch(source, /generateRaw/);
  assert.doesNotMatch(source, /installBackfillGuard/);
  assert.match(source, /npcParticipatesInExchange/);
});
