import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampLauncherPosition, launcherPositionRecord } from '../launcher-ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'launcher-ui.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');

test('movable launcher clamps saved coordinates inside the visible viewport', () => {
    assert.deepEqual(
        clampLauncherPosition({ left: -50, top: 999 }, { width: 390, height: 844 }, { width: 120, height: 44 }),
        { left: 8, top: 792 },
    );
    assert.deepEqual(
        clampLauncherPosition({ left: 180, top: 300 }, { width: 390, height: 844 }, { width: 120, height: 44 }),
        { left: 180, top: 300 },
    );
});

test('launcher persistence record is compact integer UI state', () => {
    assert.deepEqual(launcherPositionRecord({ left: 12.6, top: 44.2, extra: 'ignored' }), { left: 13, top: 44 });
});

test('launcher uses Pointer Events so the same drag path works for mouse pen and touch', () => {
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        assert.match(source, new RegExp(`addEventListener\\('${event}'`));
    }
    assert.match(source, /setPointerCapture/);
    assert.match(source, /touch-action:\s*none\s*!important/);
    assert.match(source, /DRAG_THRESHOLD_PX\s*=\s*5/);
    assert.match(source, /suppressClickUntil/);
});

test('mobile and tablet launcher is top-level, icon-sized, and parked at the side midpoint', () => {
    assert.match(source, /document\.body\.appendChild\(this\.launcher\)/);
    assert.match(source, /LAUNCHER_ID\s*=\s*'npc_state_delta_dossier_launcher'/);
    assert.match(source, /#\$\{LAUNCHER_ID\}[\s\S]*z-index:\s*2147483647\s*!important/);
    assert.match(source, /visibility:\s*visible\s*!important/);
    assert.match(source, /pointer-events:\s*auto\s*!important/);
    assert.match(source, /@media \(max-width:\s*1100px\)/);
    assert.match(source, /top:\s*50%\s*!important/);
    assert.match(source, /transform:\s*translateY\(-50%\)\s*!important/);
    assert.match(source, /width:\s*48px/);
    assert.match(source, /env\(safe-area-inset-right\)/);
});

test('settings stay under Extensions and the duplicate document-header Edit button is removed', () => {
    assert.match(source, /querySelectorAll\('\.delta-open-settings'\)/);
    assert.match(source, /querySelectorAll\('\.delta-document-head > \.delta-edit'\)/);
    assert.match(source, /\.delta-open-settings \{ display: none !important; \}/);
    assert.match(source, /\.delta-document-head > \.delta-edit \{ display: none !important; \}/);
    assert.doesNotMatch(source, /openSettings\s*\(/);
});

test('dossier overlay has a real clickable backdrop that closes through the Stage 1 controller', () => {
    assert.match(source, /className\s*=\s*'delta-backdrop'/);
    assert.match(source, /this\.backdrop\.addEventListener\('click', this\.boundBackdropClick\)/);
    assert.match(source, /onBackdropClick\(event\)/);
    assert.match(source, /controller\.close\(\{ restoreFocus: false \}\)/);
    assert.match(source, /\.delta-backdrop\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
    assert.match(source, /\.delta-panel\s*\{[\s\S]*box-shadow:\s*0 20px 70px/);
});

test('launcher refinement remains UI-only and does not gain canonical mutation paths', () => {
    assert.match(source, /npc_state_delta_launcher_position_v1/);
    assert.doesNotMatch(source, /persistCritical\s*\(/);
    assert.doesNotMatch(source, /applyNpcStateCommand\s*\(/);
    assert.doesNotMatch(source, /scanNow\s*\(/);
    assert.doesNotMatch(source, /relationshipDelta/);
    assert.doesNotMatch(source, /getState\s*\(/);
});

test('launcher refinement loads after the Stage 1 dossier surface', () => {
    const dossierAt = bootstrap.indexOf("await import('./dossier-ui.js')");
    const launcherAt = bootstrap.indexOf("await import('./launcher-ui.js')");
    assert.ok(dossierAt >= 0);
    assert.ok(launcherAt > dossierAt);
});
