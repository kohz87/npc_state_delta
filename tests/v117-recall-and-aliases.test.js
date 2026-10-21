import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildInjection, createNpcRecord, isRoleDescriptionLabel, mergeScanResult, normalizeNpcRecord, npcNamedInText } from '../core.js';
import { dossierDetailProjection } from '../dossier-ui.js';

const hask = { id: 'h', name: 'Capt. Orrin Hask' };
const roster = [hask, { id: 'm', name: 'Maelis Varn' }, { id: 'a', name: 'Adaine Varn' }, { id: 'w', name: 'Will Turner' },
    { id: 'r', name: 'Redmond Shaw', aliases: ['Red', 'Innkeeper'] }];
const named = text => roster.filter(npc => npcNamedInText(npc, text, roster)).map(npc => npc.name);

test('role descriptions are told apart from names and nicknames', () => {
    for (const label of ['Innkeeper', 'the innkeeper', 'The Innkeeper', 'Captain', 'the old man', 'Guard Captain', 'the hooded stranger']) assert.equal(isRoleDescriptionLabel(label), true, label);
    for (const label of ['Red', 'the Butcher of Vell', 'Old Brenn', 'Captain Hask', 'Sister Callow', 'the Innkeeper of the Drowned Rat']) assert.equal(isRoleDescriptionLabel(label), false, label);
});

test('any distinctive part of a name recalls the NPC; titles and everyday words do not', () => {
    assert.deepEqual(named('Hask is coming.'), ['Capt. Orrin Hask'], 'a surname');
    assert.deepEqual(named('Orrin is coming.'), ['Capt. Orrin Hask'], 'the first name after a title');
    assert.deepEqual(named('The capt nodded.'), [], 'an abbreviated title names nobody');
    assert.deepEqual(named('Varn waves.'), [], 'a shared surname is ambiguous');
    assert.deepEqual(named('maelis waves.'), ['Maelis Varn'], 'a first name may be typed in lower case');
    assert.deepEqual(named('I will go.'), [], 'an everyday word needs a capital');
    assert.deepEqual(named('Will waves.'), ['Will Turner']);
    assert.deepEqual(named('Shaw arrived.'), ['Redmond Shaw']);
    assert.deepEqual(named('shaw arrived'), [], 'a surname needs a capital');
});

test('nicknames recall when capitalised; role-description aliases never recall', () => {
    assert.deepEqual(named('Red waved.'), ['Redmond Shaw']);
    assert.deepEqual(named('a red cloak'), []);
    assert.deepEqual(named('the innkeeper smiled'), []);
});

test('off-screen NPCs the story mentions get one line with their established facts', () => {
    const live = normalizeNpcRecord({ id: 'npc_maelis', name: 'Maelis Varn', present: true, personality: 'Warm.' });
    const away = normalizeNpcRecord({ id: 'npc_hask', name: 'Capt. Orrin Hask', gender: 'male', role: 'debt collector', homeBase: 'the Heron docks',
        relationshipSummary: 'Hostile after the brawl.', customFields: { Level: '7' }, archived: true, archiveReason: 'stale' });
    const text = buildInjection([live, away], 'Maelis warns that Hask will come for the debt.', 1, 3, undefined, 4000, null, { customFieldNames: ['Level'] });
    assert.match(text, /MENTIONED, NOT PRESENT: NPCs the recent story names\. Use these established facts if they come up or arrive; do not bring them on-screen unprompted\./);
    assert.match(text, /- Capt\. Orrin Hask \(mentioned, not present; male; debt collector; home base: the Heron docks; Level: 7; toward the player: Hostile after the brawl\.\)/);
    assert.doesNotMatch(text, /- Capt\. Orrin Hask: IDENTITY/, 'a mention is never a dossier block');
    assert.doesNotMatch(buildInjection([live, away], 'Maelis pours a drink.', 1, 3), /Hask/);
    assert.match(buildInjection([away], 'Orrin Hask is overdue.', 1, 3), /^NPC STATE DELTA DOSSIER\.[\s\S]*- Capt\. Orrin Hask \(mentioned, not present/, 'also when nobody is present');
});

test('mention lines are capped at four, living first, and never displace the cast', () => {
    const live = normalizeNpcRecord({ id: 'npc_maelis', name: 'Maelis Varn', present: true, background: 'x'.repeat(1500) });
    const names = ['Arlo Fenn', 'Bria Tull', 'Cass Moor', 'Dane Voss', 'Esme Rook'];
    const away = names.map((name, i) => normalizeNpcRecord({ id: `npc_${i}`, name }));
    const dead = normalizeNpcRecord({ id: 'npc_dead', name: 'Gale Hurst', archived: true, archiveReason: 'deceased', lifeState: 'deceased', lifeStateCertainty: 'explicit' });
    const text = buildInjection([live, ...away, dead], `${names.join(', ')} and Gale Hurst were all mentioned.`, 1, 3);
    assert.equal((text.match(/\(mentioned, not present/g) || []).length, 4);
    assert.doesNotMatch(text, /Gale Hurst \(deceased/, 'living mentions fill the cap first');
    assert.match(buildInjection([live, ...away], 'Arlo Fenn is mentioned.', 1, 3, undefined, 512), /- Maelis Varn: IDENTITY/, 'the cast survives a tight budget');
});

test('hand-edited aliases are kept from scanner additions and shown on the dossier', () => {
    const base = { npcs: [{ ...createNpcRecord('Redmond Shaw'), id: 'npc_red', aliases: ['Red'], manualProfileFields: ['aliases'] }], candidates: [], turn: 1 };
    const locked = mergeScanResult(base, { npcs: [{ id: 'npc_red', name: 'Redmond Shaw', aliases: ['Old Red', 'the barkeep'] }] }, { turn: 1 }).state.npcs[0];
    assert.deepEqual(locked.aliases, ['Red']);
    base.npcs[0].manualProfileFields = [];
    assert.deepEqual(mergeScanResult(base, { npcs: [{ id: 'npc_red', name: 'Redmond Shaw', aliases: ['Old Red'] }] }, { turn: 1 }).state.npcs[0].aliases, ['Red', 'Old Red']);
    assert.match(dossierDetailProjection(locked).aliases.join(','), /Red/);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /id="npc_state_delta_edit_aliases"/);
    assert.match(index, /aliases: cleanEditorList\(editorField\('npc_state_delta_edit_aliases'\), 8\)/);
    assert.match(fs.readFileSync(new URL('../src/dossier-edit.js', import.meta.url), 'utf8'), /'customFields', 'aliases',\n\]\);/);
    assert.match(fs.readFileSync(new URL('../dossier-ui.js', import.meta.url), 'utf8'), /currentCard\('Also known as'/);
    assert.match(fs.readFileSync(new URL('../src/dossier-edit.js', import.meta.url), 'utf8'), /aliases: \['aliases'\],/, 'the lock map bundle import and branch restore share');
});
