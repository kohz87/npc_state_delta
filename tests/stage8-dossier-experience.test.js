import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lifeStateChoice, manualLifeStateRecord, setNodeTextIfChanged } from '../dossier-experience.js';

const source = fs.readFileSync(fileURLToPath(new URL('../dossier-experience.js', import.meta.url)), 'utf8');

test('manual life-state projection distinguishes unknown alive terminal death and the short-lived manual dead shape', () => {
    assert.equal(lifeStateChoice({ lifeState: 'unknown' }), 'unknown');
    assert.equal(lifeStateChoice({ lifeState: 'alive' }), 'alive');
    assert.equal(lifeStateChoice({ lifeState: 'deceased', lifeStateCertainty: 'explicit' }), 'deceased');
    assert.equal(lifeStateChoice({ archiveReason: 'deceased', archived: true }), 'deceased');
    assert.equal(lifeStateChoice({ lifeState: 'dead', lifeStateCertainty: 'confirmed' }), 'deceased');
});

test('manual deceased state uses canonical explicit terminal state and removes live presence', () => {
    const next = manualLifeStateRecord({
        id: 'npc-1', name: 'Maren', lifeState: 'alive', present: true, worldActive: true,
        archived: false, archiveReason: '', relationship: { trust: 12 },
    }, 'deceased', 12345);
    assert.equal(next.lifeState, 'deceased');
    assert.equal(next.lifeStateCertainty, 'explicit');
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
        id: 'npc-1', lifeState: 'deceased', lifeStateCertainty: 'explicit', archived: true,
        archiveReason: 'deceased', archivedAt: 44, archiveSourceMessageId: 9,
    }, 'alive', 99);
    assert.equal(corrected.lifeState, 'alive');
    assert.equal(corrected.lifeStateCertainty, 'explicit');
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

test('editor synchronization is idempotent so MutationObserver refresh cannot self-loop', () => {
    let writes = 0;
    const node = {
        _text: 'Stable',
        get textContent() { return this._text; },
        set textContent(value) { writes += 1; this._text = value; },
    };
    assert.equal(setNodeTextIfChanged(node, 'Stable'), false);
    assert.equal(writes, 0);
    assert.equal(setNodeTextIfChanged(node, 'Changed'), true);
    assert.equal(writes, 1);
    assert.equal(setNodeTextIfChanged(node, 'Changed'), false);
    assert.equal(writes, 1);
});

test('launcher returns to direct dossier ownership while settings stays in Extensions', () => {
    assert.doesNotMatch(source, /openLauncherHub|data-hub-action|delta-experience-hub/);
    assert.match(source, /\.delta-open-settings\{display:none!important\}/);
});

test('dossier library uses a real one-column portrait card instead of squeezing the legacy two-column card', () => {
    assert.match(source, /\.delta-cast-card\{[^}]*grid-template-columns:1fr!important/);
    assert.match(source, /\.delta-cast-portrait\{[^}]*width:100%!important[^}]*height:68px!important/);
    assert.match(source, /delta-cast-rail-wrap/);
});

test('cohesive experience keeps dossier actions adaptive editor and manual life-state control', () => {
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
