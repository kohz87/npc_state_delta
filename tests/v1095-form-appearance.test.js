import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNpcAppearance } from '../appearance.js';

// Since 1.0.98 these unversioned records are version-1 data: the checks cover the one-time
// conversion, which stores exactly what each form showed.
const SHARED = 'Tall and slender, long silver hair, violet eyes, pale skin';
const FORMS = [
    { name: 'Human', appearance: 'Long silver hair, violet eyes, pale skin; wearing a grey travelling cloak' },
    { name: 'Dragon', appearance: 'A forty-foot silver dragon with violet eyes, pearl-white scales and vast membranous wings' },
    { name: 'Demi-human', appearance: 'Silver hair, violet eyes, small curved horns and a scaled tail; light leather armour' },
    { name: 'Red-eyed', appearance: 'Crimson eyes and a hooded black cloak' },
];
const noela = (extra = {}) => ({ id: 'npc_noela', name: 'Noela', overallAppearance: SHARED, appearanceForms: structuredClone(FORMS), ...extra });
const count = (text, phrase) => text.toLowerCase().split(phrase).length - 1;

test('v1.0.95 a form that restates shared features does not repeat them', () => {
    const human = resolveNpcAppearance(noela({ currentForm: 'Human' }));
    assert.equal(count(human, 'silver hair'), 1, human);
    assert.equal(count(human, 'violet eyes'), 1, human);
    assert.equal(count(human, 'pale skin'), 1, human);
    assert.match(human, /grey travelling cloak/);
    const demi = resolveNpcAppearance(noela({ currentForm: 'Demi-human' }));
    assert.equal(count(demi, 'silver hair'), 1, 'the shorter restatement gives way to the shared "long silver hair"');
    assert.match(demi, /long silver hair/);
    assert.match(demi, /small curved horns and a scaled tail/);
});

test('v1.0.95 a form\'s own description of a trait replaces the shared one', () => {
    const red = resolveNpcAppearance(noela({ currentForm: 'Red-eyed' }));
    assert.match(red, /Crimson eyes/);
    assert.doesNotMatch(red, /violet eyes/, 'the form\'s eyes are not listed beside the shared eyes');
    assert.match(red, /long silver hair/, 'traits the form does not describe still come from the shared slot');
    // A concealed mention does not describe the trait.
    const hooded = resolveNpcAppearance(noela({ appearanceForms: [{ name: 'Masked', appearance: 'Eyes hidden beneath a silver visor' }], currentForm: 'Masked' }));
    assert.match(hooded, /violet eyes/);
});
