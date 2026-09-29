import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNpcRecord } from '../core.js';
import { applyManualKeyRelationshipEdit, reconcileSocialState } from '../social.js';

const npc = (name, gender, keyRelationships = [], extra = {}) => normalizeNpcRecord({
    id: `npc_${name.toLowerCase()}`, name, gender, species: 'human', keyRelationships, ...extra,
});
const bonds = (state, name) => state.npcs.find(item => item.name === name).keyRelationships;
const edit = (state, name, after) => {
    const owner = state.npcs.find(item => item.name === name);
    const before = [...owner.keyRelationships];
    owner.keyRelationships = after;
    applyManualKeyRelationshipEdit(state, owner.id, before, after, {});
    return reconcileSocialState(state, { provenance: 'manual', confidence: 'manual' }).state;
};
// Greta wrongly lists her brother Marek as a parent, so Marek holds two "children".
const family = () => reconcileSocialState({ npcs: [
    npc('Talia', 'female', ['Marek — late father', 'Greta — sibling']),
    npc('Greta', 'female', ['Marek — parent', 'Talia — sibling']),
    npc('Marek', 'male', [], { lifeState: 'deceased' }),
], socialGraph: { edges: [], unresolved: [] } }, {}).state;

test('a shared parent does not make siblings of NPCs who name another blood tie', () => {
    let state = edit(family(), 'Talia', ['Marek — late father', 'Greta — aunt']);
    for (let i = 0; i < 3; i += 1) state = reconcileSocialState(state, { provenance: 'scanner' }).state;
    assert.deepEqual(bonds(state, 'Talia'), ['Marek — late father', 'Greta — aunt']);
    assert.deepEqual(bonds(state, 'Greta').filter(entry => /^Talia/.test(entry)), ['Talia — niece'], 'the mirrored entry follows the edit');
    assert.ok(!state.socialGraph.edges.some(edge => edge.inferred && /sibling/.test(edge.aToB)), 'no inferred sibling edge survives');
});

test('correcting a relation also corrects the other NPC\'s mirrored entry', () => {
    let state = edit(family(), 'Greta', ['Marek — brother', 'Talia — niece']);
    assert.deepEqual(bonds(state, 'Marek'), ['Talia — child', 'Greta — sibling'], 'Marek no longer lists Greta as his child');
    assert.deepEqual(bonds(state, 'Talia').filter(entry => /^Greta/.test(entry)), ['Greta — aunt']);
    state = reconcileSocialState(state, { provenance: 'scanner' }).state;
    assert.deepEqual(bonds(state, 'Greta'), ['Marek — brother | deceased', 'Talia — niece']);
});

test('a locked counterpart and a relation with no inverse are left alone', () => {
    const locked = family();
    locked.npcs.find(item => item.name === 'Marek').manualProfileFields = ['keyRelationships'];
    const marekBefore = [...bonds(locked, 'Marek')];
    const state = edit(locked, 'Greta', ['Marek — brother', 'Talia — niece']);
    assert.deepEqual(bonds(state, 'Marek'), marekBefore);
    const other = edit(reconcileSocialState({ npcs: [npc('Talia', 'female', ['Hanna — cousin']), npc('Hanna', 'female', ['Talia — cousin'])], socialGraph: { edges: [], unresolved: [] } }, {}).state,
        'Talia', ['Hanna — tormentor']);
    assert.deepEqual(bonds(other, 'Hanna'), ['Talia — cousin'], 'no inverse means the other side keeps its own statement');
});

test('children of a shared parent are still inferred as siblings', () => {
    const state = reconcileSocialState({ npcs: [
        npc('Ria', 'female', ['Orin — father']),
        npc('Sef', 'male', ['Orin — father']),
        npc('Orin', 'male'),
    ], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    assert.ok(bonds(state, 'Ria').some(entry => /^Sef — sibling/.test(entry)), JSON.stringify(bonds(state, 'Ria')));
});
