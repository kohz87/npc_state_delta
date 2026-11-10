import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    LEVEL_FIELD_RULE, buildBackfillPrompt, buildDossierImportPrompt, buildNarrationCaptureParts, buildProfileRefreshPrompt,
    buildScannerPrompt, createNpcRecord, mergeScanResult, normalizeNpcRecord,
} from '../core.js';

// The Level field rule (owner-approved, core contract C10): one sentence in the custom-field rule, only when the
// configured names include Level (any case); every other prompt and field is unchanged.

const npc = normalizeNpcRecord({ id: 'npc_maelis', name: 'Maelis Varn', present: true, personality: 'Warm.' });
const options = { transcript: 'Maelis waves.', existingNpcs: [npc], existingNpc: npc, targetNpc: npc, targetName: 'Maelis Varn' };
const builders = {
    scanner: o => buildScannerPrompt(o),
    capture: o => buildNarrationCaptureParts(o).context,
    backfill: o => buildBackfillPrompt(o),
    refresh: o => buildProfileRefreshPrompt(o),
    dossierImport: o => buildDossierImportPrompt(o),
};

for (const [label, build] of Object.entries(builders)) {
    test(`${label} prompt: the Level sentence only when Level is configured, in any case`, () => {
        const without = build({ ...options, customFieldNames: ['Class', 'Faction'] });
        assert.ok(!without.includes(LEVEL_FIELD_RULE));
        assert.equal(build({ ...options, customFieldNames: ['Class', 'Faction'] }), without);
        for (const name of ['Level', 'level', 'LEVEL']) {
            const withLevel = build({ ...options, customFieldNames: [name, 'Class'] });
            assert.ok(withLevel.includes(`Never guess.${LEVEL_FIELD_RULE}`), name);
            assert.equal(withLevel.split('Level is the one exception').length, 2, 'once');
        }
        const a = build({ ...options, customFieldNames: ['Class'] });
        const b = build({ ...options, customFieldNames: ['Class', 'Level'] });
        assert.ok(b.length - a.length > LEVEL_FIELD_RULE.length, 'the delta is the sentence plus the name');
        assert.equal(build({ ...options, customFieldNames: [] }).includes('CUSTOM FIELDS'), false);
    });
}

test('the Level sentence is stated, generic, and leaves "Never guess" for every other field', () => {
    assert.match(LEVEL_FIELD_RULE, /named level or rank|names that person's level or rank/);
    assert.match(LEVEL_FIELD_RULE, /"C-D"/);
    assert.match(LEVEL_FIELD_RULE, /Never from dramatic description/);
    assert.match(LEVEL_FIELD_RULE, /not quotes, questions or wishes/);
    assert.match(LEVEL_FIELD_RULE, /customFieldsReason/);
    const prompt = buildScannerPrompt({ ...options, customFieldNames: ['Level', 'Class'] });
    assert.match(prompt, /Never guess\. Level is the one exception/, 'Never guess stays; Level alone is excepted');
    assert.doesNotMatch(buildScannerPrompt({ ...options, customFieldNames: ['Class'] }), /exception/);
});

test('in a one-pass capture the Level sentence sits in the context part, not the cached rules part', () => {
    const parts = buildNarrationCaptureParts({ ...options, customFieldNames: ['Level'] });
    assert.ok(!parts.rules.includes('Level is the one exception'));
    assert.ok(parts.context.includes(LEVEL_FIELD_RULE));
});

test('merge: a Level estimate needs a quote that is really in the story; hand-set values and other fields keep their rules', () => {
    const base = { npcs: [{ ...createNpcRecord('Mira'), id: 'npc_mira' }], candidates: [], turn: 1 };
    const scan = (state, fields, reason, context) => mergeScanResult(state, { npcs: [{ id: 'npc_mira', name: 'Mira', customFields: fields, customFieldsReason: reason }] },
        { turn: 1, customFieldNames: ['Level', 'Class'], developmentContext: context }).state;
    const story = 'Mira walks in. "He is far beyond anything I can sense," the captain whispers. Mira is level 3.';
    const quote = 'Level: "far beyond anything I can sense"';
    assert.equal(scan(base, { Level: '40' }, quote, story).npcs[0].customFields?.Level, '40', 'quoted line in the text passes');
    assert.equal(scan(base, { Level: '40' }, 'Level: "he is a legend of the northern wars"', story).npcs[0].customFields, undefined, 'a made-up reason is dropped');
    assert.equal(scan(base, { Level: '40' }, 'Level: "beyond"', story).npcs[0].customFields, undefined, 'a one-word quote is dropped');
    assert.equal(scan(base, { Level: '40' }, 'far beyond anything I can sense', story).npcs[0].customFields, undefined, 'a quote not written after "Level" is dropped');
    assert.equal(scan(base, { Level: '40' }, '', story).npcs[0].customFields, undefined, 'no reason, no estimate');
    assert.equal(scan(base, { Level: '40', Class: 'Rogue' }, 'Class: "far beyond anything I can sense" Level: a guess', story).npcs[0].customFields, undefined, 'a quote meant for another field does not carry Level');
    assert.equal(scan(base, { Level: '40' }, 'Level: "far beyond anything I can sense"', story).npcs[0].customFields?.Level, '40');
    const aged = (fields, reason) => mergeScanResult(base, { npcs: [{ id: 'npc_mira', name: 'Mira', customFields: fields, customFieldsReason: reason }] },
        { turn: 1, customFieldNames: ['Level', 'Age'], developmentContext: 'The damage she did was far beyond anything I can sense.' }).state.npcs[0].customFields;
    assert.equal(aged({ Level: '40' }, 'Level: "the damage she did was far beyond anything I can sense"')?.Level, '40', 'a field name inside the quote does not cut it');
    assert.equal(aged({ Level: '40', Age: '30' }, 'Age: "x" Level: "the damage she did was far beyond anything I can sense"')?.Level, '40');
    assert.equal(scan(base, { Level: '3' }, '', story).npcs[0].customFields?.Level, '3', 'a value in the text keeps its path');
    assert.equal(scan(base, { Class: 'Rogue' }, 'a guess', story).npcs[0].customFields, undefined, 'other fields still need the value in the text');
    const set = scan(base, { Level: '40' }, quote, story);
    assert.equal(scan(set, { Level: '50' }, '', story).npcs[0].customFields.Level, '40', 'an established value needs a reason');
    set.npcs[0].manualProfileFields = ['customFields'];
    assert.equal(scan(set, { Level: '50' }, quote, story).npcs[0].customFields.Level, '40', 'a hand-set value is never overwritten');
});

// ---- the Level field appears by itself while Story Block's RPG feature is on (read time, never stored) ----
// runtime-settings.js imports SillyTavern's extensions.js, so it is loaded from a temp tree with a stub host (as settings-debounce.test.js does).
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-level-auto-'));
const extRoot = path.join(tempRoot, 'public', 'scripts', 'extensions', 'third-party', 'npc_state_delta');
fs.mkdirSync(extRoot, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ type: 'module' }));
for (const { path: file } of JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime-modules.json'), 'utf8')).modules) {
    fs.mkdirSync(path.dirname(path.join(extRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file), path.join(extRoot, file));
}
fs.writeFileSync(path.join(tempRoot, 'public', 'scripts', 'extensions.js'), 'export const extension_settings = {};\nexport function getContext() { return {}; }\n');
fs.writeFileSync(path.join(tempRoot, 'public', 'script.js'), 'export function getRequestHeaders() { return {}; }\nexport async function saveSettings() {}\n');
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
const { effectiveCustomFieldNames, setRpgProbe } = await import(pathToFileURL(path.join(extRoot, 'runtime-settings.js')).href);
const { buildInjection } = await import('../core.js');
const { suite } = await import('./helpers/pacing-suite.js');
const setNames = names => ({ customFieldNames: names });
const rpg = { on: false };

test('the accessor adds Level while the RPG is on, once, and exactly the configured names otherwise', () => {
    try {
        setRpgProbe(null);
        assert.deepEqual(effectiveCustomFieldNames(setNames(['Class'])), ['Class'], 'standalone');
        setRpgProbe(() => rpg.on);
        rpg.on = false;
        assert.deepEqual(effectiveCustomFieldNames(setNames(['Class'])), ['Class'], 'RPG off');
        rpg.on = true;
        assert.deepEqual(effectiveCustomFieldNames(setNames(['Class'])), ['Class', 'Level']);
        assert.deepEqual(effectiveCustomFieldNames(setNames([])), ['Level']);
        assert.deepEqual(effectiveCustomFieldNames(setNames(['LEVEL', 'Class'])), ['LEVEL', 'Class'], 'a configured Level (any case) is not added twice');
        const settings = setNames(['Class']);
        effectiveCustomFieldNames(settings);
        assert.deepEqual(settings.customFieldNames, ['Class'], 'nothing is written to settings');
        rpg.on = false;
        assert.deepEqual(effectiveCustomFieldNames(setNames(['Class'])), ['Class'], 'switched off mid-chat: the next read sees it');
        setRpgProbe(() => { throw new Error('host gone'); });
        assert.deepEqual(effectiveCustomFieldNames(setNames(['Class'])), ['Class'], 'a probe that throws means off');
    } finally { setRpgProbe(null); }
});

test('RPG on: prompts, injection and merge use Level; off: byte-identical; the stored value stays', () => {
    const npcWithLevel = normalizeNpcRecord({ id: 'npc_maelis', name: 'Maelis Varn', present: true, personality: 'Warm.', customFields: { Level: '3', Class: 'Rogue' } });
    const state = { turn: 1, candidates: [], npcs: [npcWithLevel] };
    const text = 'Maelis waves.';
    const inject = names => buildInjection([npcWithLevel], text, 1, 3, undefined, 4000, null, { customFieldNames: names });
    try {
        setRpgProbe(() => rpg.on);
        rpg.on = false;
        const off = effectiveCustomFieldNames(setNames(['Class']));
        const promptOff = buildScannerPrompt({ ...options, customFieldNames: off });
        const injectedOff = inject(off);
        assert.equal(promptOff, buildScannerPrompt({ ...options, customFieldNames: ['Class'] }), 'off: the prompt is the configured one');
        assert.doesNotMatch(promptOff, /Level is the one exception/);
        assert.doesNotMatch(injectedOff, /Level: 3/, 'the stored Level is not injected while off');
        rpg.on = true;
        const on = effectiveCustomFieldNames(setNames(['Class']));
        assert.match(buildScannerPrompt({ ...options, customFieldNames: on }), /CUSTOM FIELDS \(Class, Level\)[\s\S]*Level is the one exception/);
        assert.match(inject(on), /Class: Rogue · Level: 3|Level: 3 · Class: Rogue/);
        const merged = mergeScanResult(state, { npcs: [{ id: 'npc_maelis', name: 'Maelis Varn', customFields: { Level: '4' }, customFieldsReason: 'Level up.' }] },
            { turn: 2, customFieldNames: on, developmentContext: 'Maelis reached level 4.' }).state.npcs[0];
        assert.equal(merged.customFields.Level, '4', 'merge accepts Level while on');
        rpg.on = false;
        const kept = mergeScanResult({ ...state, npcs: [merged] }, { npcs: [{ id: 'npc_maelis', name: 'Maelis Varn', customFields: { Class: 'Mage' }, customFieldsReason: 'Retrained.' }] },
            { turn: 3, customFieldNames: effectiveCustomFieldNames(setNames(['Class'])), developmentContext: 'Maelis retrained as a Mage.' }).state.npcs[0];
        assert.equal(kept.customFields.Level, '4', 'the value stays in the dossier when RPG goes off');
        assert.doesNotMatch(inject(effectiveCustomFieldNames(setNames(['Class']))), /Level: 4/);
    } finally { setRpgProbe(null); }
});

test('the adapter answers rpgOn from the host feature (hosted), false when off', async () => {
    const s = await suite({});
    assert.equal(s.adapter.rpgOn(), true === s.host.sdk.feature('story-block.rpg'), 'it follows the host');
    s.host.features.set('story-block.rpg', true);
    assert.equal(s.adapter.rpgOn(), true);
    s.host.features.set('story-block.rpg', false);
    assert.equal(s.adapter.rpgOn(), false, 'switched off mid-chat: the next read sees it');
});
