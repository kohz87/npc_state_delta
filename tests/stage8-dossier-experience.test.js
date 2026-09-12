import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lifeStateChoice, manualLifeStateRecord } from '../dossier-experience.js';

const source = fs.readFileSync(fileURLToPath(new URL('../dossier-experience.js', import.meta.url)), 'utf8');

test('manual life-state projection distinguishes unknown alive and terminal death', () => {
    assert.equal(lifeStateChoice({ lifeState: 'unknown' }), 'unknown');
    assert.equal(lifeStateChoice({ lifeState: 'alive' }), 'alive');
    assert.equal(lifeStateChoice({ lifeState: 'dead', lifeStateCertainty: 'confirmed' }), 'deceased');
    assert.equal(lifeStateChoice({ archiveReason: 'deceased', archived: true }), 'deceased');
});

test('manual deceased state is explicit terminal state and removes live presence', () => {
    const next = manualLifeStateRecord({
        id: 'npc-1', name: 'Maren', lifeState: 'alive', present: true, worldActive: true,
        archived: false, archiveReason: '', relationship: { trust: 12 },
    }, 'deceased', 12345);
    assert.equal(next.lifeState, 'dead');
    assert.equal(next.lifeStateCertainty, 'confirmed');
    assert.equal(next.present, false);
    assert.equal(next.worldActive, false);
    assert.equal(next.archived, true);
    assert.equal(next.archiveReason, 'deceased');
    assert.equal(next.archivedAt, 12345);
    assert.equal(next.archiveSourceMessageId, null);
    assert.deepEqual(next.relationship, { trust: 12 });
});

test('manual living correction clears only death-owned archive state', () => {
    const corrected = manualLifeStateRecord({
        id: 'npc-1', lifeState: 'dead', lifeStateCertainty: 'confirmed', archived: true,
        archiveReason: 'deceased', archivedAt: 44, archiveSourceMessageId: 9,
    }, 'alive', 99);
    assert.equal(corrected.lifeState, 'alive');
    assert.equal(corrected.lifeStateCertainty, 'confirmed');
    assert.equal(corrected.archived, false);
    assert.equal(corrected.archiveReason, '');
    assert.equal(corrected.archivedAt, null);
    assert.equal(corrected.archiveSourceMessageId, null);

    const manualArchive = manualLifeStateRecord({
        id: 'npc-2', lifeState: 'unknown', archived: true, archiveReason: 'manual', archivedAt: 55,
    }, 'alive', 99);
    assert.equal(manualArchive.lifeState, 'alive');
    assert.equal(manualArchive.archived, true);
    assert.equal(manualArchive.archiveReason, 'manual');
    assert.equal(manualArchive.archivedAt, 55);
});

test('cohesive experience owns launcher hub, screenshot-style rail, dossier actions and adaptive editor', () => {
    assert.match(source, /Dossiers[\s\S]*Settings[\s\S]*Backup \/ Restore[\s\S]*Diagnostics/);
    assert.match(source, /delta-cast-rail-wrap/);
    assert.match(source, /delta-dossier-actions-primary/);
    assert.match(source, /npc-state-delta-refresh-chat/);
    assert.match(source, /npc-state-delta-scan-dossier/);
    assert.match(source, /Archive dossier/);
    assert.match(source, /npc-state-delta-editor-popup\{width:min\(1320px,97vw\)/);
    assert.match(source, /data-delta-life-state/);
    assert.match(source, /npc-state-delta-copy-image-prompt/);
});

test('cohesive experience does not add a portrait image-generation path', () => {
    assert.doesNotMatch(source, /generatePortraitUrl|Generate preview|Apply preview|\/imagine/);
});
