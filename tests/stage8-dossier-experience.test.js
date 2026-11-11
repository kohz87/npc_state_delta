import { manualLifeStateRecord } from '../terminal-lifecycle.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lifeStateChoice, setNodeTextIfChanged } from '../dossier-experience.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { faceRingVar, keyFirstRows, libraryFaceHtml, libraryRows } from '../dossier-ui-library.js';

const source = [
    fs.readFileSync(fileURLToPath(new URL('../dossier-experience.js', import.meta.url)), 'utf8'),
    fs.readFileSync(fileURLToPath(new URL('../dossier-experience-styles.js', import.meta.url)), 'utf8'),
].join('\n');

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

test('dossier library is a grid of tone-ringed faces; the old collapsible cast rail is gone', () => {
    const styles = fs.readFileSync(fileURLToPath(new URL('../dossier-ui-styles-board.js', import.meta.url)), 'utf8');
    assert.match(styles, /\.delta-library-faces \{ display:grid; grid-template-columns:repeat\(auto-fill,minmax\(140px,1fr\)\)/);
    assert.match(styles, /\.delta-library-portrait \{[^}]*box-shadow:0 0 0 2px var\(--dsk-tile\), 0 0 0 3\.5px var\(--rc\)/);
    assert.doesNotMatch(source, /delta-cast-card|delta-cast-rail-wrap|delta-rail-arrow|libraryCollapsed|ensureLibraryChrome/);
    assert.doesNotMatch(source, /delta-library-collapsed|data-delta-library-toggle/);
});

test('the library puts key people first and keeps the search and dead rules', () => {
    const rows = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', key: true }, { id: 'c', name: 'C' }, { id: 'd', name: 'D', key: true }];
    assert.deepEqual(keyFirstRows(rows).map(row => row.id), ['b', 'd', 'a', 'c'], 'a stable partition: key people first, the order inside each group kept');
    const index = [{ id: 'x', name: 'Xen', bucket: 'active', aliases: [] }, { id: 'y', name: 'Yara', bucket: 'dead', aliases: [] }];
    assert.deepEqual(libraryRows(index).map(row => row.id), ['x'], 'the dead only by search');
    assert.deepEqual(libraryRows(index, { query: 'yara' }).map(row => row.id), ['y']);
    assert.match(libraryFaceHtml({ id: 'z', name: '<b>', bucket: 'active', tone: 'rival' }), /&lt;b&gt;[\s\S]*--rc:var\(--bad\)|--rc:var\(--bad\)[\s\S]*&lt;b&gt;/, 'escaped name, red ring for a rival');
    assert.equal(faceRingVar('ally'), 'var(--good)');
    assert.equal(faceRingVar('nonsense'), 'var(--dial)');
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
    const index = runtimeSource();
    const html = index.slice(index.indexOf('function buildSettingsHtml()'), index.indexOf('function readOpenSettingsGroups()'));
    const groups = [...html.matchAll(/settingsGroup\('([a-z]+)', '([^']+)'/g)].map(match => match[2]);
    // The rarely needed groups sit inside one closed "Expert" fold (built first in the source, shown last); the rest are the everyday groups.
    assert.deepEqual(groups, ['Source of truth', 'Calendar & birthdays', 'Scanner rules', 'Advanced', 'Scanning', 'Roster & continuity', 'Meter presets', 'Portrait generation', 'Data & maintenance', 'Expert']);
    assert.match(html, /delta-settings-quickbar[\s\S]*npc_state_delta_enabled[\s\S]*npc_state_delta_auto[\s\S]*data-delta-settings-open-dossiers[\s\S]*npc_state_delta_scan_now[\s\S]*npc_state_delta_add_manual/);
    assert.match(html, /delta-settings-maintenance-actions[\s\S]*data-delta-settings-backup[\s\S]*data-delta-settings-restore[\s\S]*data-delta-settings-diagnostics/);
    assert.match(html, /npc_state_delta_roster_summary[\s\S]*delta-settings-danger[\s\S]*npc_state_delta_clear_chat/);
    assert.match(html, /native SillyTavern Image Generation handoff/);
    assert.match(html, /npc_state_delta_portrait_generation_enabled/);
    assert.match(html, /npc_state_delta_portrait_save_gallery/);
    assert.match(index, /dispatchEvent\?\.\(new CustomEvent\('npc-state-delta:settings-mounted'/);
    assert.match(source, /data-delta-settings-backup/);
    assert.match(source, /data-delta-settings-restore/);
    assert.match(source, /data-delta-settings-diagnostics/);
    assert.match(source, /data-delta-settings-open-dossiers/);
    assert.match(source, /delta-tools-data,[\s\S]*delta-tools-diagnostics-button\{display:none!important\}/);
    assert.doesNotMatch(source, /ensureSettingsExperience|moveSettingsRows|#npc_state_delta_settings /, 'the dossier experience never restructures or styles the settings panel');
});

test('cohesive experience keeps selected dossier actions routed through the maintained Portrait tool', () => {
    const header = fs.readFileSync(fileURLToPath(new URL('../dossier-ui-header.js', import.meta.url)), 'utf8');
    assert.match(source, /delta-header-slot/);
    assert.match(source, /dossierMenuHtml\(npcId/);
    assert.match(header, /npc-state-delta-refresh-chat/);
    assert.match(header, /npc-state-delta-scan-dossier/);
    assert.match(header, /delta-experience-portrait/);
    assert.match(header, /Archive dossier/);
    assert.match(source, /openPortraitTools/);
    assert.doesNotMatch(source, /\/imagine/);
});
