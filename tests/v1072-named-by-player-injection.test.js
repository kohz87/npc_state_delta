import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjection, createNpcRecord, npcNamedInText } from '../core.js';

function npc(name, extra = {}) {
    const record = createNpcRecord(name);
    Object.assign(record, {
        present: false, lastSeenTurn: 2, seenCount: 3, species: 'Half-elf',
        personality: 'Guarded and quietly proud.',
        speech: 'Short, clipped sentences.',
        appearanceModelVersion: 1,
        overallAppearance: 'Petite, willowy frame, generous bust, slate-gray eyes, hip-length ink-black hair.',
        appearance: 'Petite, willowy frame, generous bust, slate-gray eyes, hip-length ink-black hair.',
        ...extra,
    });
    return record;
}

test('an off-screen NPC is only injected when the pending player message names her', () => {
    const linnea = npc('Linnea');
    assert.equal(buildInjection([linnea], 'I call Linnea over to the table.', 6, 3), '', 'without the named option presence still gates injection');
    const text = buildInjection([linnea], 'I call Linnea over to the table.', 6, 3, undefined, 4000, null, { namedNpcIds: [linnea.id] });
    assert.match(text, /^- Linnea \(named by player\): IDENTITY/m);
    assert.match(text, /Exception: NPCs marked "named by player" are not yet confirmed on-screen/);
    assert.match(text, /generous bust/, 'the called-in NPC keeps her anatomy');
    assert.equal(linnea.present, false, 'injection never changes presence');
});

test('present NPCs are unmarked and the header is unchanged when nobody is called in', () => {
    const present = npc('Kora', { present: true, lastSeenTurn: 6 });
    const plain = buildInjection([present], 'Kora pours ale.', 6, 3, undefined, 4000, null);
    const withOption = buildInjection([present], 'Kora pours ale.', 6, 3, undefined, 4000, null, { namedNpcIds: [present.id] });
    assert.equal(withOption, plain);
    assert.doesNotMatch(plain, /named by player/);
});

test('archived NPCs stay out even when named', () => {
    const archived = npc('Linnea', { archived: true });
    assert.equal(buildInjection([archived], 'Where is Linnea?', 6, 3, undefined, 4000, null, { namedNpcIds: [archived.id] }), '');
});

test('names, aliases and a distinctive first name are recognised; unrelated text is not', () => {
    const record = npc('Linnea Vael', { aliases: ['the miller\'s girl'] });
    assert.equal(npcNamedInText(record, 'I wave to Linnea Vael.'), true);
    assert.equal(npcNamedInText(record, 'Linnea, come here.'), true);
    assert.equal(npcNamedInText(record, 'Is the miller\'s girl around?'), true);
    assert.equal(npcNamedInText(record, 'I head back to the inn alone.'), false);
    assert.equal(npcNamedInText(record, ''), false);
});
