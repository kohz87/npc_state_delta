import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chooseDossierSelection, dossierIndexProjection, filterDossierIndex } from '../dossier-ui.js';

const rows = [
    { id: 'mira', name: 'Mira', role: 'Scout', worldActive: true },
    { id: 'old', name: 'Old Clerk', role: 'Clerk', archived: true, archiveReason: 'stale' },
    { id: 'fallen', name: 'Fallen Guard', aliases: ['The Warden'], role: 'Guard', archived: true, archiveReason: 'deceased', lifeState: 'dead' },
    { id: 'lost', name: 'Lost Scout', role: 'Scout', lifeState: 'dead' },
].map(npc => dossierIndexProjection(npc));
const ids = options => filterDossierIndex(rows, options).map(row => row.id);

test('1.1.4: the dead are left out of every list view', () => {
    assert.deepEqual(ids({}), ['mira', 'old']);
    assert.deepEqual(ids({ filter: 'active' }), ['mira']);
    assert.deepEqual(ids({ filter: 'archived' }), ['old']);
    assert.deepEqual(ids({ filter: 'dead' }), ['mira', 'old'], 'the retired Dead view falls back to All');
});

test('1.1.4: a search finds the dead, by name or alias, in any view', () => {
    assert.deepEqual(ids({ query: 'fallen' }), ['fallen']);
    assert.deepEqual(ids({ query: 'warden' }), ['fallen']);
    assert.deepEqual(ids({ query: 'scout' }), ['mira', 'lost']);
    assert.deepEqual(ids({ query: 'scout', filter: 'archived' }), ['lost']);
});

test('1.1.4: a dead dossier stays listed only while it is selected', () => {
    assert.deepEqual(ids({ keepId: 'fallen' }), ['mira', 'old', 'fallen']);
    assert.deepEqual(ids({ keepId: 'old', filter: 'active' }), ['mira'], 'keeping applies to the dead only');
    const allDead = rows.filter(row => row.bucket === 'dead');
    const visible = filterDossierIndex(allDead, {});
    assert.deepEqual(visible, []);
    assert.equal(chooseDossierSelection('', visible, allDead.filter(row => row.bucket !== 'dead')), '', 'a hidden dead dossier is never picked by default');
});

test('1.1.4: the library offers All, Active and Archived only, and its counts leave out the dead', () => {
    const source = fs.readFileSync(new URL('../dossier-ui.js', import.meta.url), 'utf8');
    assert.match(source, /\['all', 'active', 'archived'\]\.map\(key =>/);
    assert.match(source, /if \(row\?\.bucket === 'dead'\) continue;/);
    assert.match(source, /keepId: this\.selectedNpcId/);
    assert.match(source, /search by name to find them/);
});
