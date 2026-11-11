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

// ---- (hosted) an active party member's Level follows their sheet (Story Block's `party.levels`) ----
test('active party member: stored Level follows the sheet and the scanner\'s Level is ignored; after leaving the last sheet level stays until the scanner states another', async () => {
    const reason = 'Level: "far beyond anything I can sense"';
    const story = 'The captain whispers: he is far beyond anything I can sense. Mira is level 3.';
    const mira = { ...createNpcRecord('Mira'), id: 'npc_mira', aliases: ['the Ranger'], customFields: { Level: '4' } };
    const scan = (state, fields, party) => mergeScanResult(state, { npcs: [{ id: 'npc_mira', name: 'Mira', customFields: fields, customFieldsReason: reason }] },
        { turn: 2, customFieldNames: ['Level'], developmentContext: story, ...(party ? { partyLevels: party } : {}) });
    const active = [{ name: 'Mira', level: 5 }];
    const a = scan({ npcs: [mira], candidates: [], turn: 1 }, { Level: '40' }, active);
    assert.equal(a.state.npcs[0].customFields.Level, '5', 'the sheet level, not the scanner\'s 40');
    assert.deepEqual(a.report.sheetLevels, [{ id: 'npc_mira', reason: 'Level: from the party sheet' }]);
    assert.equal(scan(a.state, { Level: '40' }, [{ name: 'the ranger', level: 6 }]).state.npcs[0].customFields.Level, '6', 'an alias matches, in any case');
    assert.equal(scan(a.state, { Level: '40' }, [{ name: 'Mira', level: 5 }]).report.sheetLevels.length, 0, 'unchanged: nothing written');
    // Left the party: no override; the last sheet level stays, then the scanner's quoted Level wins.
    const away = scan(a.state, {}, []);
    assert.equal(away.state.npcs[0].customFields.Level, '5', 'after leaving: the last sheet level stays');
    assert.equal(scan(away.state, { Level: '40' }, []).state.npcs[0].customFields.Level, '40', 'a later scanner Level wins');
    // Not hosted / query absent or null: as today.
    for (const party of [undefined, null, []]) {
        assert.equal(scan({ npcs: [mira], candidates: [], turn: 1 }, { Level: '40' }, party).state.npcs[0].customFields.Level, '40', `no sheet (${JSON.stringify(party)}): the scanner's Level, as before`);
    }
    // Level not configured, or a hand-locked custom fields set: untouched.
    assert.equal(mergeScanResult({ npcs: [mira], candidates: [], turn: 1 }, { npcs: [] }, { turn: 2, customFieldNames: ['Class'], partyLevels: active }).state.npcs[0].customFields.Level, '4');
    assert.equal(scan({ npcs: [{ ...mira, manualProfileFields: ['customFields'] }], candidates: [], turn: 1 }, {}, active).state.npcs[0].customFields.Level, '4', 'a hand-set value is never overwritten');
});

test('the adapter reads party.levels (null without the query), the dossier marks Level "from the party sheet" only for those people', async () => {
    assert.equal((await suite({})).adapter.partyLevelsAnswer(), null, 'a host without the query: as today (the answer with the query: cast-dossier.test.js)');
    const { projectDossierState } = await import('../dossier-ui-catalog.js');
    const { currentCard } = await import('../dossier-ui-html.js');
    const people = [normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', customFields: { Level: '5' } }), normalizeNpcRecord({ id: 'npc_bo', name: 'Bo', customFields: { Level: '2' } })];
    const marked = projectDossierState({ npcs: people, customFieldNames: ['Level'], sheetLevels: { npc_mira: true } }, { chatKey: 'c1' }).npcs;
    assert.equal(marked[0].levelFromSheet, true);
    assert.equal(marked[1].levelFromSheet, undefined, 'a person off the sheet (or left) has no mark');
    assert.equal(projectDossierState({ npcs: people, customFieldNames: ['Level'] }, { chatKey: 'c1' }).npcs[0].levelFromSheet, undefined, 'standalone: no mark');
    assert.match(currentCard('Level', '5', '', '', 'from the party sheet'), /5<em class="delta-from">from the party sheet<\/em>/);
    assert.doesNotMatch(currentCard('Level', '5', ''), /delta-from/);
});

// ---- the sheet level holds on every scan path; the mark only when it matches ----
const hostedPart = async answer => {
    globalThis.document = { documentElement: { dataset: { npcStateDeltaStoryBlockV2: '1' } } };
    const { createHostedPart } = await import(pathToFileURL(path.join(extRoot, 'runtime-hosted.js')).href);
    const rt = { storySuiteV2: { hosted: () => true, partyLevelsAnswer: () => answer } };
    return createHostedPart(rt, { chatHydrationStatus: () => 'ready', getChatKey: () => 'c1', getChatState: () => ({ npcs: [] }), latestMessageId: () => 1, latestReplyIndex: () => 1 });
};

test('partyLevelList drops a member who left (rule 2), keeps whole-number levels only, and the mark needs the stored Level to equal the sheet', async () => {
    const prior = globalThis.document;
    try {
        const part = await hostedPart([{ name: 'Mira', level: 5, left: false }, { name: 'Bo', level: 3, left: true }, { name: 'Cy', level: 2.5 }, { name: 'Di', level: 4 }]);
        assert.deepEqual(part.partyLevelList(), [{ name: 'Mira', level: 5 }, { name: 'Di', level: 4 }], 'Bo left; Cy has no whole level');
        const person = (id, name, level) => normalizeNpcRecord({ id, name, customFields: level === null ? {} : { Level: level } });
        const state = { npcs: [person('m', 'Mira', '5'), person('b', 'Bo', '3'), person('d', 'Di', 'C'), person('x', 'Xu', '5')] };
        assert.deepEqual(part.dossierHostViews({ ...state }).sheetLevels, { m: true }, 'Mira matches; Bo left; Di holds another value (hand-locked or not yet scanned); Xu is not a member');
        assert.equal(part.dossierHostViews({ npcs: [person('d', 'Di', null)] }).sheetLevels, undefined, 'no stored Level: no mark');
    } finally { globalThis.document = prior; }
});

test('every merge call site passes the party levels: the reply scan and the targeted passes (backfill, Refresh, catch-up and import go through them)', () => {
    const read = file => fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    for (const file of ['runtime-scan.js', 'runtime-targeted.js']) {
        const source = read(file);
        const calls = source.split('mergeScanResult(').length - 1;
        assert.equal(source.split('partyLevels: partyLevelList()').length - 1, calls, `${file}: each mergeScanResult call passes partyLevels`);
        assert.ok(calls >= 1, file);
    }
    assert.match(read('index.js'), /createTargetedPart\(rt, \{[^}]*partyLevelList/, 'the targeted part is given the one shared helper');
});
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));   // last: the hosted-part test above imports from it
