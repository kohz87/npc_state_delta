import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildProfileRefreshPrompt,
    buildScannerPrompt,
    createNpcRecord,
    normalizeNpcRecord,
} from '../core.js';
import { inverseSocialRelation, reconcileSocialState } from '../social.js';

const npc = (name, gender, species, keyRelationships = []) => normalizeNpcRecord({
    id: `npc_${name.toLowerCase()}`, name, gender, species, keyRelationships,
});
const bonds = (state, name) => state.npcs.find(item => item.name === name).keyRelationships;
const reconcile = state => reconcileSocialState(state, {}).state;

test('v1.0.81 a mirrored bond keeps only the words both sides share', () => {
    assert.equal(inverseSocialRelation('disinherited half-elf cousin'), 'cousin');
    assert.equal(inverseSocialRelation('older cousin'), 'cousin');
    assert.equal(inverseSocialRelation('childhood friend'), 'childhood friend');
    assert.equal(inverseSocialRelation('second cousin'), 'second cousin');
    assert.equal(inverseSocialRelation('sworn enemy'), 'sworn enemy');
    assert.equal(inverseSocialRelation('aunt'), 'niece/nephew');
    assert.equal(inverseSocialRelation('servant to bully and order around'), '', 'no safe inverse');
    assert.equal(inverseSocialRelation('employer'), '');
    assert.equal(inverseSocialRelation('disinherited half-elf cousin / servant to bully'), 'cousin');
});

test('v1.0.81 a new bond gives the counterpart the inverse, not a copy', () => {
    const state = reconcile({ npcs: [
        npc('Talia', 'female', 'half-elf'),
        npc('Hanna', 'female', 'human', ['Talia — disinherited half-elf cousin | orders her around']),
        npc('Bram', 'male', 'human', ['Talia — servant']),
        npc('Greta', 'female', 'human', ['Talia — niece | resents her']),
    ], socialGraph: { edges: [], unresolved: [] } });
    const talia = bonds(state, 'Talia');
    assert.ok(talia.includes('Hanna — cousin'), JSON.stringify(talia));
    assert.ok(talia.includes('Greta — aunt'));
    assert.ok(!talia.some(entry => /^Bram/.test(entry)), 'an unknown relation is not mirrored as-is');
    assert.deepEqual(bonds(state, 'Hanna'), ['Talia — disinherited half-elf cousin | orders her around'], 'the original stays');
});

test('v1.0.81 stored mirrored copies are repaired in one pass and stay repaired', () => {
    let state = { npcs: [
        npc('Talia', 'female', 'half-elf', [
            'Hanna — Disinherited half-elf cousin / Servant to bully and order around',
            'Clara — Disinherited half-elf cousin / Scullery target for mockery',
            'Marek — Late father whose built legacy was seized from her',
            'Greta — Niece / sibling',
        ]),
        npc('Hanna', 'female', 'human', ['Talia — disinherited half-elf cousin / servant to bully and order around']),
        npc('Clara', 'female', 'human', ['Talia — disinherited half-elf cousin / scullery target for mockery']),
        npc('Marek', 'male', 'human'),
        npc('Greta', 'female', 'human', ['Talia — niece | resents her']),
    ], socialGraph: { edges: [{
        aId: 'npc_hanna', bId: 'npc_talia', confidence: 'strong-context',
        aToB: 'disinherited half-elf cousin / servant to bully and order around',
        bToA: 'disinherited half-elf cousin / servant to bully and order around',
    }], unresolved: [] } };
    state = reconcile(state);
    const talia = bonds(state, 'Talia');
    assert.deepEqual(talia.filter(entry => !/^Marek/.test(entry)).sort(), ['Clara — cousin', 'Greta — aunt', 'Hanna — cousin']);
    assert.ok(talia.includes('Marek — Late father whose built legacy was seized from her'), 'a correct bond is untouched');
    assert.deepEqual(bonds(state, 'Hanna'), ['Talia — disinherited half-elf cousin / servant to bully and order around']);
    const edge = state.socialGraph.edges.find(item => item.aId === 'npc_hanna' && item.bId === 'npc_talia');
    assert.equal(edge.bToA, 'cousin', 'the persisted edge loses the mirrored copy too');
    const again = reconcile(structuredClone(state));
    assert.deepEqual(again.npcs.map(item => item.keyRelationships), state.npcs.map(item => item.keyRelationships), 'idempotent');
});

test('v1.0.81 without a species clue the side that established the edge keeps the text', () => {
    const state = reconcile({ npcs: [
        npc('Ada', 'female', 'human', ['Bea — older cousin']),
        npc('Bea', 'female', 'human', ['Ada — older cousin']),
    ], socialGraph: { edges: [{ aId: 'npc_ada', bId: 'npc_bea', aToB: 'older cousin', bToA: 'older cousin', confidence: 'strong-context' }], unresolved: [] } });
    assert.deepEqual(bonds(state, 'Ada'), ['Bea — older cousin']);
    assert.deepEqual(bonds(state, 'Bea'), ['Ada — cousin']);
});

test('v1.0.81 conflicting blood ties keep the later one; other combinations still join', () => {
    const conflicting = reconcile({ npcs: [npc('Talia', 'female', 'human', ['Greta — niece / sibling']), npc('Greta', 'female', 'human')], socialGraph: { edges: [], unresolved: [] } });
    assert.deepEqual(bonds(conflicting, 'Talia'), ['Greta — sibling']);
    const mixed = reconcile({ npcs: [npc('Talia', 'female', 'human', ['Oren — cousin / business partner']), npc('Oren', 'male', 'human')], socialGraph: { edges: [], unresolved: [] } });
    assert.deepEqual(bonds(mixed, 'Talia'), ['Oren — cousin / business partner']);
});

test('v1.0.81 prompts say which way a bond reads', () => {
    const target = createNpcRecord('Talia');
    assert.match(buildScannerPrompt({ transcript: 'Talia sweeps.', existingNpcs: [target] }), /aToB=b's role to a/);
    assert.match(buildProfileRefreshPrompt({ transcript: '[m4] Talia sweeps.', targetNpc: target }), /"Name — their role to this NPC \| durable dynamic"/);
    assert.match(buildBackfillPrompt({ transcript: 'Talia sweeps.', targetName: 'Talia', existingNpc: target }), /Name — their role to this NPC/);
    assert.match(buildDossierImportPrompt({ dossierText: 'Talia, half-elf.', targetName: 'Talia', existingNpc: target }), /"Name — their role to this NPC \| durable dynamic" entry each/);
});
