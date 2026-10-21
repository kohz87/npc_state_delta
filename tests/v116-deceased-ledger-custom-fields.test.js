import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildBackfillPrompt,
    buildInjection,
    buildProfileRefreshPrompt,
    buildScannerPrompt,
    createNpcRecord,
    mergeScanResult,
    normalizeCustomFieldNames,
    normalizeNpcRecord,
} from '../core.js';
import { dossierDetailProjection } from '../dossier-ui.js';

const dead = (extra = {}) => normalizeNpcRecord({
    id: 'npc_brenn', name: 'Old Brenn', gender: 'male', role: "ship's mate", archived: true, archiveReason: 'deceased',
    lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Died in the Heron fire.',
    keyRelationships: ["Maelis Varn — captain's daughter | loyal to the end"], ...extra,
});
const live = (extra = {}) => normalizeNpcRecord({ id: 'npc_maelis', name: 'Maelis Varn', present: true, personality: 'Warm, stubborn.', ...extra });

test('a confirmed-dead NPC named in the story gets one ledger line', () => {
    const text = buildInjection([live(), dead()], 'Maelis speaks about Old Brenn and the fire.', 1, 3);
    assert.match(text, /DECEASED, REFERENCED ONLY: these NPCs are dead and only mentioned\. Use these facts; never portray them alive, present, or speaking\./);
    assert.match(text, /- Old Brenn \(deceased; male; ship's mate; bond: Maelis Varn — captain's daughter\): Died in the Heron fire\./);
    assert.doesNotMatch(text, /- Old Brenn: IDENTITY/, 'the dead NPC never gets a dossier block');
    assert.doesNotMatch(buildInjection([live(), dead()], 'Maelis pours a drink.', 1, 3), /Old Brenn/, 'unmentioned dead NPCs are not sent');
});

test('the ledger is sent even when nobody is present', () => {
    const text = buildInjection([dead()], 'Old Brenn was a good man.', 1, 3);
    assert.match(text, /^NPC STATE DELTA DOSSIER\./);
    assert.match(text, /- Old Brenn \(deceased/);
    assert.equal(buildInjection([dead()], 'The tavern is quiet.', 1, 3), '');
});

test('only confirmed deaths, at most three, and never at the cost of present NPCs', () => {
    const inferred = dead({ id: 'npc_inferred', name: 'Ilsa Morn', archived: false, archiveReason: '', lifeStateCertainty: 'inferred' });
    assert.doesNotMatch(buildInjection([live(), inferred], 'They mention Ilsa Morn.', 1, 3), /Ilsa Morn \(deceased/, 'an uncertain death is not a ledger entry');
    const crowd = ['Arlo Fenn', 'Bria Tull', 'Cass Moor', 'Dane Voss'].map((name, i) => dead({ id: `npc_d${i}`, name }));
    const many = buildInjection([live(), ...crowd], 'Arlo Fenn, Bria Tull, Cass Moor and Dane Voss all died.', 1, 3);
    assert.equal((many.match(/\(deceased/g) || []).length, 3);
    const tight = buildInjection([live({ background: 'x'.repeat(1500) }), dead()], 'Maelis remembers Old Brenn.', 1, 3, undefined, 512);
    assert.match(tight, /- Maelis Varn: IDENTITY/, 'the present NPC block survives a tight budget');
});

test('custom field names normalize from text, dedupe and cap at six', () => {
    assert.deepEqual(normalizeCustomFieldNames('Level, Class, level, "HP":, Faction, A, B, C'), ['Level', 'Class', 'HP', 'Faction', 'A', 'B']);
    assert.deepEqual(normalizeCustomFieldNames(undefined), []);
    assert.deepEqual(normalizeNpcRecord({ name: 'Mira', customFields: { Level: 3, Class: '  Rogue ', Empty: '' } }).customFields, { Level: '3', Class: 'Rogue' });
    assert.equal('customFields' in normalizeNpcRecord({ name: 'Mira' }), false, 'records without custom fields are unchanged');
});

test('custom fields are set from grounded story text, kept when omitted, and changed only with a reason', () => {
    const base = { npcs: [{ ...createNpcRecord('Mira'), id: 'npc_mira' }], candidates: [], turn: 1 };
    const scan = (state, row, context, extra = {}) => mergeScanResult(state, { npcs: [{ id: 'npc_mira', name: 'Mira', ...row }] },
        { turn: 1, customFieldNames: ['Level', 'Class'], developmentContext: context, ...extra }).state;
    let state = scan(base, { customFields: { Level: '3', Class: 'Rogue', HP: '9' } }, 'Mira, a level 3 rogue, waves.');
    assert.deepEqual(state.npcs[0].customFields, { Level: '3', Class: 'Rogue' }, 'unconfigured fields are ignored');
    assert.deepEqual(scan(base, { customFields: { Level: '7' } }, 'Mira waves.').npcs[0].customFields, undefined, 'a value the story never states is rejected');
    assert.deepEqual(scan(state, { mood: 'calm' }, 'Mira waves.').npcs[0].customFields, { Level: '3', Class: 'Rogue' }, 'omission keeps');
    assert.deepEqual(scan(state, { customFields: { Level: '5' } }, 'Mira is level 5 now.').npcs[0].customFields, { Level: '3', Class: 'Rogue' }, 'a change without a reason is ignored');
    state = scan(state, { customFields: { Level: '5' }, customFieldsReason: 'reached level 5' }, 'Mira reached level 5.');
    assert.deepEqual(state.npcs[0].customFields, { Level: '5', Class: 'Rogue' });
    assert.deepEqual(scan(base, { customFields: { Level: '3' } }, 'Mira, level 3.', { customFieldNames: [] }).npcs[0].customFields, undefined, 'nothing is stored when no fields are configured');
    state.npcs[0].manualProfileFields = ['customFields'];
    assert.deepEqual(scan(state, { customFields: { Level: '9' }, customFieldsReason: 'jumped' }, 'Mira is level 9.').npcs[0].customFields, { Level: '5', Class: 'Rogue' }, 'a lock protects them');
});

test('prompts gain the custom-field rule only when fields are configured', () => {
    const npc = live({ customFields: { Level: '3' } });
    const options = { transcript: 'Maelis waves.', existingNpcs: [npc] };
    const plain = buildScannerPrompt(options);
    const configured = buildScannerPrompt({ ...options, customFieldNames: ['Level', 'Class'] });
    assert.equal(buildScannerPrompt({ ...options, customFieldNames: [] }), plain, 'no configured fields, no prompt change');
    assert.ok(configured.startsWith(plain));
    assert.match(configured.slice(plain.length), /CUSTOM FIELDS \(Level, Class\): .*"customFields":\{"Level":"value","Class":"value"\}.*customFieldsReason/);
    assert.match(configured, /Established custom fields: \{"npc_maelis":\{"Level":"3"\}\}/);
    assert.match(buildProfileRefreshPrompt({ transcript: '[m1] Maelis waves.', targetNpc: npc, customFieldNames: ['Level'] }), /CUSTOM FIELDS \(Level\)/);
    assert.match(buildBackfillPrompt({ transcript: 'Maelis waves.', targetName: 'Maelis Varn', existingNpc: npc, customFieldNames: ['Level'] }), /CUSTOM FIELDS \(Level\)/);
});

test('configured custom fields reach the roleplay injection and the dossier page', () => {
    const npc = live({ customFields: { Level: '3', Class: 'Rogue', Old: 'x' } });
    assert.match(buildInjection([npc], 'Maelis waves.', 1, 3, undefined, 4000, null, { customFieldNames: ['Level', 'Class'] }), /AGENCY\/OTHER BONDS: established details: Level: 3 · Class: Rogue/);
    assert.doesNotMatch(buildInjection([npc], 'Maelis waves.', 1, 3), /established details/, 'nothing is sent when no fields are configured');
    assert.deepEqual(dossierDetailProjection(npc).customFields, [['Level', '3'], ['Class', 'Rogue'], ['Old', 'x']]);
});

test('settings, editor, scans and imports are wired to the custom fields', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /customFieldNames: \[\],/);
    assert.match(index, /assign\('customFieldNames', normalizeCustomFieldNames\(settings\.customFieldNames\), sameJson\)/);
    assert.match(index, /id="npc_state_delta_custom_fields"/);
    assert.equal((index.match(/customFieldNames: settings\.customFieldNames/g) || []).length, 7, 'three prompts, three merges and the injection');
    assert.match(index, /\$\{customFieldEditorHtml\(npc\)\}/);
    assert.match(index, /customFields: customFieldEditorValues\(current\)/);
    assert.match(fs.readFileSync(new URL('../src/dossier-edit.js', import.meta.url), 'utf8'), /'keyRelationships', 'customFields'/, 'manual edits lock custom fields like other stable fields');
    assert.match(fs.readFileSync(new URL('../src/dossier-edit.js', import.meta.url), 'utf8'), /customFields: \['customFields'\],/, 'the lock map bundle import and branch restore share');
});
