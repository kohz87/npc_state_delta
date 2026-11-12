import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScanResult, normalizeNpcRecord } from '../core.js';

// Cleanup step 5 (audit I-3): a durable fact in profileUpdates[] is applied by the same rules as in the
// NPC's own npcs[] entry. Before, profileUpdates silently dropped background, homeBase, role, species,
// gender, ages, custom fields and Key Relationships. Each case runs once per channel and compares.

const context = [
    'Myla Venn, now a former royal archivist, says she lives in rooms above the bakery on Mill Street.',
    'She served ten years as a royal archivist. She passed the guild trial: Level 4.',
    'Tobin Ash, her courier, brings her letters. She is thirty-five now; her birthday was yesterday.',
].join(' ');

function dossier(extra = {}) {
    return normalizeNpcRecord({
        id: 'npc_myla', name: 'Myla Venn', present: true, role: 'Archivist', species: 'Human', gender: 'female', age: '34', apparentAge: '~30',
        homeBase: 'The old archive tower', background: 'Raised in the river quarter.', customFields: { Level: '3' },
        keyRelationships: ['Ilse Venn — sister | close'], ...extra,
    });
}

function run(channel, fields, extra = {}) {
    const state = { turn: 3, npcs: [dossier(extra)], candidates: [] };
    const reply = channel === 'npcs'
        ? { npcs: [{ id: 'npc_myla', name: 'Myla Venn', present: true, ...fields }] }
        : { npcs: [{ id: 'npc_myla', name: 'Myla Venn', present: true }], profileUpdates: [{ id: 'npc_myla', name: 'Myla Venn', ...fields }] };
    return mergeScanResult(state, reply, { turn: 4, sourceMessageId: 9, developmentContext: context, customFieldNames: ['Level'] }).state.npcs[0];
}

const cases = [
    // [label, field read back, fields sent, expected (null = unchanged), dossier extra]
    // (card traits win) An established role is keep-by-default like the home base; a first role still fills.
    ['role rewrite without roleState is kept', 'role', { role: 'Former royal archivist' }, null],
    ['role update with state, reason and grounding', 'role', { role: 'Former royal archivist', roleState: 'update', roleReason: 'She is now a former royal archivist.' }, 'Former royal archivist'],
    ['role update without a reason is kept', 'role', { role: 'Former royal archivist', roleState: 'update' }, null],
    ['role update not in the story is kept', 'role', { role: 'Queen of the river quarter', roleState: 'update', roleReason: 'Crowned.' }, null],
    ['a first role fills', 'role', { role: 'Former royal archivist' }, 'Former royal archivist', { role: '' }],
    ['species replaced', 'species', { species: 'Half-elf' }, 'Half-elf'],
    ['background replaced', 'background', { background: 'Raised in the river quarter; served ten years as a royal archivist.' }, 'Raised in the river quarter; served ten years as a royal archivist.'],
    ['homeBase update with state, reason and grounding', 'homeBase', { homeBase: 'Rooms above the bakery on Mill Street', homeBaseState: 'update', homeBaseReason: 'She says she lives there now.' }, 'Rooms above the bakery on Mill Street'],
    ['homeBase without state is kept', 'homeBase', { homeBase: 'Rooms above the bakery on Mill Street' }, null],
    ['homeBase not in the story is kept', 'homeBase', { homeBase: 'A castle in the clouds', homeBaseState: 'update', homeBaseReason: 'Moved.' }, null],
    ['gender change without correction is kept', 'gender', { gender: 'male' }, null],
    ['gender correction with reason', 'gender', { gender: 'male', genderState: 'correct', genderReason: 'The story corrects it.' }, 'male'],
    ['age advance with reason', 'age', { age: '35', ageState: 'advance', ageReason: 'Her birthday was yesterday.' }, '35'],
    ['age advance backwards is kept', 'age', { age: '33', ageState: 'advance', ageReason: 'Birthday.' }, null],
    ['age without state is kept', 'age', { age: '35' }, null],
    ['apparent age needs evolve', 'apparentAge', { apparentAge: '~35' }, null],
    ['custom field change with reason', 'customFields', { customFields: { Level: '4' }, customFieldsReason: 'Passed the guild trial.' }, { Level: '4' }],
    ['custom field change without reason is kept', 'customFields', { customFields: { Level: '4' } }, null],
    ['unconfigured custom field is ignored', 'customFields', { customFields: { Rank: 'Gold' }, customFieldsReason: 'x' }, null],
    ['a new counterpart is added', 'keyRelationships', { keyRelationships: ['Tobin Ash — courier | brings her letters'] }, ['Ilse Venn — sister | close', 'Tobin Ash — courier | brings her letters']],
    ['an unmarked rewrite of a known counterpart is kept', 'keyRelationships', { keyRelationships: ['Ilse Venn — sister | estranged'] }, null],
    ['a locked field is kept', 'role', { role: 'Former royal archivist' }, null, { manualProfileFields: ['role'] }],
    ['a locked custom field is kept', 'customFields', { customFields: { Level: '4' }, customFieldsReason: 'Trial.' }, null, { manualProfileFields: ['customFields'] }],
];

for (const [label, field, fields, expected, extra = {}] of cases) {
    test(`npcs[] and profileUpdates[] agree: ${label}`, () => {
        const before = dossier(extra)[field];
        const viaRow = run('npcs', fields, extra)[field];
        const viaProfile = run('profileUpdates', fields, extra)[field];
        assert.deepEqual(viaRow, expected === null ? before : expected, 'npcs[]');
        assert.deepEqual(viaProfile, viaRow, 'profileUpdates[] applies the same rule');
    });
}

test('profileUpdates[] leaves live state to npcs[] (mood, location, goal, status are not durable)', () => {
    const npc = run('profileUpdates', { mood: 'Elated', location: 'Mill Street', goal: 'Unpack', status: 'Busy' });
    assert.equal(npc.mood, dossier().mood);
    assert.equal(npc.location, dossier().location);
});

test('a durable fact from profileUpdates[] is stamped as a change like any other', () => {
    const npc = run('profileUpdates', { homeBase: 'Rooms above the bakery on Mill Street', homeBaseState: 'update', homeBaseReason: 'She lives there now.' });
    assert.equal(npc.fieldChangeMessages?.homeBase, 9);
});

// (card traits win) The pack cast's role stays as written unless a story event (a promotion, a new job, a revealed identity) changes it.
test('Temiwa\'s pack role is kept against an unmarked rewrite; a promotion with a reason in the story is taken', () => {
    const story = 'The abbess named Sister Temiwa Lay Sealer of the Bluewatch chapel before the whole congregation.';
    const temiwa = () => normalizeNpcRecord({ id: 'npc_sister-temiwa', name: 'Sister Temiwa', present: true, role: 'Church novice',
        castFrom: { key: 'ersveil:temiwa', pack: 'ersveil', id: 'temiwa', first: {} } });
    const scan = (fields, channel) => mergeScanResult({ turn: 3, npcs: [temiwa()], candidates: [] }, channel === 'npcs'
        ? { npcs: [{ id: 'npc_sister-temiwa', name: 'Sister Temiwa', ...fields }] }
        : { npcs: [{ id: 'npc_sister-temiwa', name: 'Sister Temiwa' }], profileUpdates: [{ id: 'npc_sister-temiwa', name: 'Sister Temiwa', ...fields }] },
    { turn: 4, sourceMessageId: 9, developmentContext: story }).state.npcs[0].role;
    for (const channel of ['npcs', 'profileUpdates']) {
        assert.equal(scan({ role: 'Exiled Saintess Candidate and Lay Sealer' }, channel), 'Church novice', `${channel}: no event, the card's role stays`);
        assert.equal(scan({ role: 'Lay Sealer of the Bluewatch chapel', roleState: 'promote', roleReason: 'The abbess named her Lay Sealer.' }, channel), 'Lay Sealer of the Bluewatch chapel', `${channel}: a promotion`);
    }
});
