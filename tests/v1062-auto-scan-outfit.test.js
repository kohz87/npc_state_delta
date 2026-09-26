import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, mergeScanResult } from '../core.js';

// Routine (non-targeted) scans with two present NPCs, so NPC-scoped evidence rules apply as in a real
// auto scan. Outfit changes are usually narrated in the sentence after the one naming the NPC.
const CONTEXT = '[m3] User: Show me the new dress.\n[m4] Assistant: Myla smiles and slips behind the folding screen. A moment later she returns in a white summer sundress and straw sandals, twirling once. Kael grunts approvingly from the doorway.';
function cast() {
    const myla = createNpcRecord('Myla');
    myla.present = true;
    myla.appearance = 'Long silver hair, violet eyes, slender build; wearing a blue travel cloak.';
    const kael = createNpcRecord('Kael');
    kael.present = true;
    kael.appearance = 'Short black hair; chainmail.';
    return { myla, kael };
}
function scan(where, change, context = CONTEXT) {
    const { myla, kael } = cast();
    const app = { appearanceState: 'change', ...change };
    const result = where === 'profileUpdates'
        ? { npcs: [{ id: myla.id, name: 'Myla', present: true }, { id: kael.id, name: 'Kael', present: true }], profileUpdates: [{ id: myla.id, name: 'Myla', ...app }, { id: kael.id, name: 'Kael', speechState: 'refine', speech: 'Gruff grunts.', evidence: { speech: ['Kael grunts approvingly'] } }] }
        : { npcs: [{ id: myla.id, name: 'Myla', present: true, ...app }, { id: kael.id, name: 'Kael', present: true }], profileUpdates: [] };
    return mergeScanResult({ npcs: [myla, kael], turn: 5 }, result, { transcript: context, developmentContext: context, sourceMessageId: 4 })
        .state.npcs.find(npc => npc.id === myla.id).appearance;
}
const sundress = { appearance: 'Wearing a white summer sundress and straw sandals.', appearanceReason: 'Myla changed into a white summer sundress and straw sandals.' };

test('an auto scan captures an outfit change narrated in the sentence after the NPC is named', () => {
    for (const where of ['npcs', 'profileUpdates']) {
        const appearance = scan(where, sundress);
        assert.match(appearance, /white summer sundress/, `${where} row`);
        assert.match(appearance, /Long silver hair, violet eyes, slender build/, `${where} row keeps physical traits`);
        assert.doesNotMatch(appearance, /blue travel cloak/, `${where} row retires the old outfit`);
    }
    const full = scan('npcs', { ...sundress, appearance: 'Long silver hair, violet eyes, slender build; wearing a white summer sundress and straw sandals.' });
    assert.match(full, /white summer sundress/, 'a full presentation restating physical traits is accepted too');
});

test('an outfit change narrated for another NPC is not credited to this one', () => {
    const context = '[m4] Assistant: Myla smiles at you. Kael pulls on a heavy fur coat and laces his boots.';
    const appearance = scan('npcs', { appearance: 'Wearing a heavy fur coat.', appearanceReason: 'Myla put on a heavy fur coat.' }, context);
    assert.match(appearance, /blue travel cloak/);
    assert.doesNotMatch(appearance, /fur coat/);
});

test('an ungrounded outfit change is still rejected', () => {
    const appearance = scan('npcs', { appearance: 'Wearing golden plate armor.', appearanceReason: 'Myla put on golden plate armor.' });
    assert.match(appearance, /blue travel cloak/);
    assert.doesNotMatch(appearance, /plate armor/);
});
