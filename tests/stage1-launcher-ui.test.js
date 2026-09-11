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

test('mobile launcher escapes the old root stacking context and stays visible above host chrome', () => {
    assert.match(source, /#\$\{ROOT_ID\}\s*\{[\s\S]*position:\s*static\s*!important;[\s\S]*z-index:\s*auto\s*!important;/);
    assert.match(source, /\.delta-launcher\s*\{[\s\S]*z-index:\s*2147483400\s*!important/);
    assert.match(source, /display:\s*inline-flex\s*!important/);
    assert.match(source, /visibility:\s*visible\s*!important/);
    assert.match(source, /pointer-events:\s*auto\s*!important/);
    assert.match(source, /env\(safe-area-inset-right\)/);
    assert.match(source, /env\(safe-area-inset-bottom\)/);
});

test('settings remain owned by the Extensions settings surface, not the launcher panel', () => {
    assert.match(source, /removeEmbeddedSettingsAccess/);
    assert.match(source, /querySelectorAll\('\.delta-open-settings'\)/);
    assert.match(source, /\.delta-open-settings \{ display: none !important; \}/);
    assert.doesNotMatch(source, /openSettings\s*\(/);
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
