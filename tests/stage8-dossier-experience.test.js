import { manualLifeStateRecord } from '../terminal-lifecycle.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lifeStateChoice, setNodeTextIfChanged } from '../dossier-experience.js';

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

test('launcher remains direct-to-dossier and is presented as a circular 48px floating control', () => {
    assert.doesNotMatch(source, /openLauncherHub|data-hub-action|delta-experience-hub/);
    assert.match(source, /npc_state_delta_dossier_launcher\{border-radius:50%!important\}/);
    assert.match(source, /delta-open-settings/);
});

test('dossier library is a full-portrait cast carousel with overlaid text and hidden scrollbar', () => {
    assert.match(source, /\.delta-cast-card\{position:relative!important[^}]*height:132px!important/);
    assert.match(source, /\.delta-cast-portrait\{position:absolute!important[^}]*inset:0!important[^}]*height:100%!important/);
    assert.match(source, /\.delta-cast-copy\{position:absolute!important[^}]*bottom:0[^}]*linear-gradient/);
    assert.match(source, /\.delta-cast-list::-webkit-scrollbar\{display:none!important/);
    assert.match(source, /delta-cast-rail-wrap/);
});

test('editor uses one scroll body and task-grouped form sections', () => {
    assert.match(source, /\.npc-state-delta-editor-popup \.popup-content\{[^}]*overflow:hidden!important/);
    assert.match(source, /#npc_state_delta_editor_content\{[^}]*overflow-y:auto!important/);
    assert.match(source, /editorSection\('Identity & profile'/);
    assert.match(source, /editorSection\('Current state'/);
    assert.match(source, /editorSection\('Relationships'/);
    assert.match(source, /editorSection\('Continuity'/);
    assert.match(source, /Advanced NPC options/);
    assert.match(source, /npc-state-delta-editor-portrait-overrides\{display:none!important/);
    assert.match(source, /data-delta-life-state/);
});

test('settings are grouped by task and extension-wide backup diagnostics live in Settings', () => {
    for (const label of ['General', 'Scanning', 'Continuity & injection', 'Roster & cleanup', 'Portrait generation', 'Relationship tuning', 'Memory & behavior rules', 'Data & maintenance']) {
        assert.match(source, new RegExp(label.replace(/[&]/g, '\\&')));
    }
    assert.match(source, /data-delta-settings-backup/);
    assert.match(source, /data-delta-settings-restore/);
    assert.match(source, /data-delta-settings-diagnostics/);
    assert.match(source, /delta-tools-data,[\s\S]*delta-tools-diagnostics-button\{display:none!important\}/);
    assert.match(source, /native SillyTavern Image Generation handoff/);
    assert.match(source, /npc_state_delta_portrait_generation_enabled/);
    assert.match(source, /npc_state_delta_portrait_save_gallery/);
    assert.match(source, /generationRow\.hidden = false/);
    assert.match(source, /galleryRow\.hidden = false/);
    assert.match(source, /rosterActions\.appendChild\(addNpc\)/);
    assert.match(source, /delta-settings-maintenance-actions/);
    assert.match(source, /maintenanceActions\.appendChild\(scanNow\)/);
    assert.match(source, /maintenanceActions\.appendChild\(clearChat\)/);
    assert.doesNotMatch(source, /querySelectorAll\(':scope > \.npc-state-delta-actions'\)/);
});

test('cohesive experience keeps selected dossier actions routed through the maintained Portrait tool', () => {
    assert.match(source, /delta-dossier-actions-primary/);
    assert.match(source, /npc-state-delta-refresh-chat/);
    assert.match(source, /npc-state-delta-scan-dossier/);
    assert.match(source, /Archive dossier/);
    assert.match(source, /openPortraitTools/);
    assert.doesNotMatch(source, /\/imagine/);
});
