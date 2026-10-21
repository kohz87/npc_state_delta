import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { escapeHtml } from '../src/util/html.js';
import { escapeHtml as toolsEscape } from '../dossier-tools-core.js';
import { matchingNpcRecords, scanRowMatchesNpc } from '../core.js';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 11: one HTML escape, one "is this row / record that NPC" pair, no dead pass-through,
// and the settings other modules keep controls for are declared and normalized by the settings owner.

const runtime = JSON.parse(fs.readFileSync(new URL('../runtime-modules.json', import.meta.url), 'utf8')).modules.map(module => module.path);
const sources = Object.fromEntries([...runtime, 'src/storysuite-v2.js', 'src/npc-meters.js', 'src/npc-meters-screen.js']
    .filter((path, i, all) => all.indexOf(path) === i && fs.existsSync(new URL(`../${path}`, import.meta.url)))
    .map(path => [path, fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]));

test('one escapeHtml: every module imports src/util/html.js', () => {
    const owners = Object.entries(sources).filter(([, source]) => /(?:function escapeHtml\(|const escapeHtml\s*=)/.test(source)).map(([path]) => path);
    assert.deepEqual(owners, ['src/util/html.js']);
    assert.equal(toolsEscape, escapeHtml, 'dossier-tools-core re-exports the same function');
    assert.equal(escapeHtml(`<a href="x">Tom & 'Ann'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#039;Ann&#039;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
});

test('one sameNpc / matchingPrevious: core-mechanics owns them', () => {
    for (const path of ['core.js', 'continuity-core.js']) {
        assert.doesNotMatch(sources[path], /function (?:sameNpc|matchingPrevious)\(/, path);
    }
    const npc = { id: 'npc_m', name: 'Myla Venn', aliases: ['The Archivist'] };
    assert.equal(scanRowMatchesNpc({ id: 'npc_m' }, npc), true);
    assert.equal(scanRowMatchesNpc({ name: 'the archivist' }, npc), true);
    assert.equal(scanRowMatchesNpc({ aliases: ['Myla Venn'] }, npc), true);
    assert.equal(scanRowMatchesNpc({ name: 'Renn' }, npc), false);
    assert.deepEqual(matchingNpcRecords(npc, [{ id: 'x', name: 'Renn' }, { id: 'y', name: 'The Archivist' }, null]).map(item => item.id), ['y']);
});

test('dead code is gone', () => {
    const index = sources['index.js'];
    assert.doesNotMatch(index, /function prepareFullWindowRelationshipEvaluation/);
    assert.doesNotMatch(index, /npc\.worldActive = Boolean\(npc\.worldActive\)/);
});

test('the settings owner declares the settings other modules keep controls for, and the dossier NPC limit has one', () => {
    runEditorHostScenario('settings-owner', async () => {
        const settings = () => mockState.extensionSettings.npc_state_delta;
        assert.equal(settings().fullCastScanEveryTurn, false);
        assert.equal(settings().scannerMaxOutputTokens, 0);
        assert.deepEqual(settings().relationshipMap, { enabled: true, defaultLens: 'warmth' });
        assert.equal(settings().injectLimit, 3);
        assert.equal('calendarConfig' in settings(), false, 'no calendar unless one is saved');
        Object.assign(settings(), { injectLimit: 40, scannerMaxOutputTokens: 50, fullCastScanEveryTurn: 'yes', relationshipMap: { enabled: false, defaultLens: 'nope' }, calendarConfig: 'broken' });
        globalThis.NPCStateDelta.injectionPreview();
        assert.equal(settings().injectLimit, 12, 'clamped to 1-12');
        assert.equal(settings().scannerMaxOutputTokens, 128, 'the scanner routing normalization');
        assert.equal(settings().fullCastScanEveryTurn, false);
        assert.deepEqual(settings().relationshipMap, { enabled: false, defaultLens: 'warmth' });
        assert.equal('calendarConfig' in settings(), false, 'a stored non-object is not a calendar');
    });
    const index = sources['index.js'];
    assert.match(index, /settingRow\('npc_state_delta_inject_limit', 'NPCs in the dossier', numberControl\('npc_state_delta_inject_limit', 1, 12, 'NPCs'\)/);
    assert.match(index, /bindSettingsNumber\('#npc_state_delta_inject_limit', 'injectLimit', 1, 12, 3, updateInjection\);/);
    assert.match(index, /\$\('#npc_state_delta_inject_limit'\)\.val\(s\.injectLimit\);/);
    assert.doesNotMatch(sources['full-cast.js'], /root\[FULL_CAST_KEY\] = false/, 'full-cast.js no longer writes its own default');
});
