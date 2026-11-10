import test from 'node:test';
import assert from 'node:assert/strict';
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
