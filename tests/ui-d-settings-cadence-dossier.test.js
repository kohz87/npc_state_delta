import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_SCAN_EVERY_WITHOUT_EVERY_REPLY, autoScanDue } from '../scan-context.js';
import { FEATURES, FEATURE_SCAN_EVERY_REPLY, FEATURE_SOCIAL, FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS } from '../src/npc-meters.js';
import { runtimeSource } from './helpers/runtime-source.js';

// UI cleanup (1 Nov): "Scan after every reply" (npc-state-delta.scan-every-reply) and its presets, the settings folds
// (Meter presets, Expert) and the phone-width dossier window.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('scan after every reply: on is the old cadence, off waits for three replies or "Scan every" when larger', () => {
    const due = (sinceScan, extra = {}) => autoScanDue({ autoScan: true, full: false, scanEvery: 1, sinceScan, ...extra });
    assert.equal(AUTO_SCAN_EVERY_WITHOUT_EVERY_REPLY, 3);
    // On (and the default, with no host): exactly the old rule.
    assert.equal(due(1), true);
    assert.equal(due(0), false);
    assert.equal(due(1, { everyReply: true }), true);
    assert.equal(due(1, { scanEvery: 4 }), false);
    assert.equal(due(4, { scanEvery: 4 }), true);
    assert.equal(due(0, { full: true }), true, 'Full scan every turn scans every reply');
    // Off: every 3 replies.
    assert.equal(due(1, { everyReply: false }), false);
    assert.equal(due(2, { everyReply: false }), false);
    assert.equal(due(3, { everyReply: false }), true);
    // Off with a larger "Scan every": that one wins.
    assert.equal(due(3, { everyReply: false, scanEvery: 5 }), false);
    assert.equal(due(5, { everyReply: false, scanEvery: 5 }), true);
    // Off with Full scan every turn: the full scan waits for the cadence too.
    assert.equal(due(1, { everyReply: false, full: true }), false);
    assert.equal(due(3, { everyReply: false, full: true }), true);
    // Auto scan off: never, whatever the switch says.
    assert.equal(due(9, { autoScan: false, everyReply: false }), false);
    assert.equal(due(9, { autoScan: false }), false);
});

test('the scan switch is read by the automatic scan only; a manual scan does not ask it', () => {
    const index = runtimeSource();
    assert.match(index, /function scanAfterEveryReply\(\) \{\s*const adapter = storySuiteV2Meters\(\);\s*if \(!adapter\) return true;/);
    assert.match(index, /everyReply: scanAfterEveryReply\(\)/);
    assert.equal(index.split('scanAfterEveryReply()').length - 1, 2, 'asked in one place only (plus its definition)');
});

test('features: scan-every-reply is on by default; Lean turns off it, stages and meter presets (the prompt-costly ones)', () => {
    const byId = Object.fromEntries(FEATURES.map(feature => [feature.id, feature]));
    assert.equal(FEATURE_SCAN_EVERY_REPLY, 'npc-state-delta.scan-every-reply');
    const scan = byId[FEATURE_SCAN_EVERY_REPLY];
    assert.equal(scan.default, true);
    assert.deepEqual(scan.presets, { lean: false });
    assert.notEqual(scan.prompt, true, 'it changes no prompt text');
    assert.ok(scan.describe.length <= 240 && scan.label.length <= 60);
    assert.deepEqual(byId[FEATURE_STAGES].presets, { lean: false });
    assert.deepEqual(byId[FEATURE_PRESETS].presets, { lean: false });
    // Not marked: drift defaults off already; social checks cost no prompt.
    assert.equal(byId[FEATURE_DRIFT].presets, undefined);
    assert.equal(byId[FEATURE_SOCIAL].presets, undefined);
    // Every feature that is marked is frozen, and a preset key only ever says lean/full true/false.
    for (const feature of FEATURES) {
        if (feature.presets === undefined) continue;
        assert.ok(Object.isFrozen(feature.presets));
        assert.ok(Object.entries(feature.presets).every(([key, value]) => ['lean', 'full'].includes(key) && typeof value === 'boolean'));
    }
});

test('settings panel: Meter presets fold; Expert holds the five rarely needed groups, last; every group keeps its key', () => {
    const index = runtimeSource();
    const html = index.slice(index.indexOf('<div class="delta-settings-experience story-suite-folds">'), index.indexOf('const SETTINGS_OPEN_GROUPS_KEY'));
    const top = [...html.matchAll(/\$\{settingsGroup\('(\w+)'/g)].map(match => match[1]);
    assert.deepEqual(top, ['scanning', 'roster', 'presets', 'portrait', 'maintenance', 'expert'], 'everyday groups, then Expert last');
    assert.match(html, /settingsGroup\('presets', 'Meter presets', .*settingsSlot\('meter-presets'\), \{ hidden: true \}\)/, 'the preset block has its own closed fold, hidden until it holds the block');
    assert.match(html, /settingsGroup\('expert', 'Expert', "Source of truth, calendar, scanner rules, what's sent, advanced", expert\)/);
    const expert = index.slice(index.indexOf('const expert = `'), index.indexOf('return `\n    <div id="${UI_ID}"'));
    assert.deepEqual([...expert.matchAll(/settingsGroup\('(\w+)'/g)].map(match => match[1]), ['suite', 'calendar', 'rules', 'sent', 'advanced']);
    assert.match(expert, /data-delta-expert-note/);
    // The groups the reader had open before keep working: one memory key, the What's sent refresh still follows its group.
    assert.match(index, /data-delta-settings-group="sent"/);
    assert.match(index, /const SETTINGS_OPEN_GROUPS_KEY = 'npc_state_delta_settings_open_groups'/);
    const css = read('style.css');
    assert.match(css, /\.delta-settings-group\[hidden\] \{ display: none; \}/);
    assert.match(css, /\.delta-settings-slot \.npc-state-delta-v2-presets-head \{ display: none; \}/);
});

test('the Expert note says the Story Director sentence only while it is true', () => {
    const index = runtimeSource();
    const notes = index.slice(index.indexOf('const EXPERT_NOTES = '), index.indexOf('function syncExpertNote'));
    assert.match(notes, /'story-director': 'Rarely needed\. With Story Director installed its calendar is used, so the calendar here only matters on its own\.'/);
    assert.match(notes, /own: "Rarely needed\. You keep the calendar here \(Source of truth\), so Story Director's calendar is not used\."/);
    assert.match(notes, /none: 'Rarely needed\. No Story Director calendar is linked, so the calendar here is the one in use\.'/);
    assert.match(index, /storySuiteV2\?\.calendarLink\?\.\(\) \?\? 'none'/);
    assert.match(index, /function syncSettingsControls\(\) \{\s*syncExpertNote\(\);/);
});

test('phone: the dossier window is the whole screen even inside Story Suite\'s zoomed root', () => {
    // Story Suite draws the panel (class ss-cards) at CSS zoom 0.8, so 100vw drew 312px of a 390px phone; the length is
    // divided by the zoom (--ss-zoomed, unset = 1 outside Story Suite) in both places that size the window.
    const launcher = read('launcher-ui.js');
    const phone = launcher.slice(launcher.indexOf('@media (max-width: 1100px)'));
    assert.match(phone, /#\$\{ROOT_ID\} \.delta-panel \{[^}]*width: calc\(100vw \/ var\(--ss-zoomed, 1\)\) !important;[^}]*height: calc\(100dvh \/ var\(--ss-zoomed, 1\)\) !important;/s);
    assert.doesNotMatch(phone, /width: 100vw !important/);
    const ui = read('dossier-ui.js');
    assert.match(ui, /\.delta-panel \{ width:calc\(100vw \/ var\(--ss-zoomed, 1\)\); height:calc\(100dvh \/ var\(--ss-zoomed, 1\)\);/);
});
