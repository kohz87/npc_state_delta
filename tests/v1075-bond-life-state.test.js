import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNpcRecord, mergeScanResult, normalizeNpcRecord } from '../core.js';
import { compactSocialKeyRelationship, reconcileSocialState } from '../social.js';

const CORIN = 'Master Corin — late father | original builder and owner of The Grey Post, deeply revered by Elena; deceased';

function editorList() {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const body = source.match(/function cleanEditorList\(value, max = 12\) \{([\s\S]*?)\n\}/)[1];
    return new Function('value', 'max = 12', body);
}

test('v1.0.75 saving the dossier editor keeps a bond with a semicolon on one line', () => {
    const cleanEditorList = editorList();
    const text = [CORIN, 'Clara — late cousin | endures her harsh scolding; deceased'].join('\n');
    assert.deepEqual(cleanEditorList(text, 5), [CORIN, 'Clara — late cousin | endures her harsh scolding; deceased']);
    assert.deepEqual(cleanEditorList('Saved her from the river; swore an oath\nLost the inn', 5), ['Saved her from the river; swore an oath', 'Lost the inn'], 'memories with two clauses stay whole');
});

test('v1.0.75 a bare "deceased" fragment is never kept as a bond', () => {
    assert.equal(compactSocialKeyRelationship('deceased'), '');
    assert.equal(compactSocialKeyRelationship('(dead)'), '');
    const unlocked = normalizeNpcRecord({ name: 'Elena', keyRelationships: [CORIN, 'deceased'] });
    assert.deepEqual(unlocked.keyRelationships.filter(entry => /^deceased$/i.test(entry)), []);
    const locked = normalizeNpcRecord({ name: 'Elena', keyRelationships: [CORIN, 'deceased'], manualProfileFields: ['keyRelationships'] });
    assert.deepEqual(locked.keyRelationships.filter(entry => /^deceased$/i.test(entry)), [], 'even protected bonds drop the fragment');
    assert.equal(locked.keyRelationships.length, 1);
});

test('v1.0.75 an orphan "deceased" line is dropped by social reconciliation and does not return', () => {
    const elena = createNpcRecord('Elena');
    const clara = createNpcRecord('Clara');
    clara.lifeState = 'deceased';
    elena.keyRelationships = ['Clara — late cousin | endures her harsh scolding', 'deceased'];
    const state = { npcs: [elena, clara], socialGraph: {} };
    for (let i = 0; i < 3; i += 1) reconcileSocialState(state, { provenance: 'scanner' });
    assert.equal(elena.keyRelationships.length, 1);
    assert.match(elena.keyRelationships[0], /^Clara — late cousin \| endures her harsh scolding/);
});

test('v1.0.75 a neutral "aunt / uncle" bond names the relation that fits a known gender', () => {
    const elena = createNpcRecord('Elena');
    const vena = createNpcRecord('Vena');
    elena.gender = 'female';
    vena.gender = 'female';
    elena.keyRelationships = ['Vena — aunt / uncle | usurped the inn and subjected her to harsh servitude'];
    vena.keyRelationships = ['Elena — niece / nephew'];
    let state = { npcs: [elena, vena], candidates: [], turn: 3 };
    state = mergeScanResult(state, { npcs: [] }, { turn: 4, sourceMessageId: 8 }).state;
    reconcileSocialState(state, { provenance: 'scanner' });
    assert.match(state.npcs[0].keyRelationships[0], /^Vena — aunt \| usurped the inn/);
    assert.equal(state.npcs[1].keyRelationships[0], 'Elena — niece');
    const unknown = createNpcRecord('Tam');
    const owner = createNpcRecord('Ros');
    owner.keyRelationships = ['Tam — aunt / uncle'];
    const other = { npcs: [owner, unknown], socialGraph: {} };
    reconcileSocialState(other, { provenance: 'scanner' });
    assert.equal(owner.keyRelationships[0], 'Tam — aunt / uncle', 'without a known gender the neutral form stays');
});
