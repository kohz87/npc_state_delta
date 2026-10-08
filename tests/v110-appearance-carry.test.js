import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_MODEL_VERSION, applyAppearanceUpdate, carryOmittedPhysicalTraits, completeFormWithShared, normalizeAppearanceModel } from '../appearance.js';

const BODY = 'Tall and slender, long silver hair, violet eyes';

test('1.1.0: what the NPC is survives an outfit or condition update', () => {
    const npc = normalizeAppearanceModel({ appearanceModelVersion: APPEARANCE_MODEL_VERSION, currentForm: 'Dragon',
        appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon' }, { name: 'Spirit', appearance: 'Spirit form, translucent and glowing' }] });
    const flat = (form, text) => applyAppearanceUpdate({ ...npc, currentForm: form }, { appearance: text, appearanceState: 'change', appearanceReason: 'ash fell from the burning tower' })
        .appearanceForms.find(item => item.name === form).appearance;
    const named = (form, text) => applyAppearanceUpdate(npc, { appearanceForms: [{ name: form, appearance: text, state: 'change', reason: 'ash fell from the burning tower' }] })
        .appearanceForms.find(item => item.name === form).appearance;
    assert.equal(flat('Dragon', 'Dusted with ash'), 'A silver dragon; Dusted with ash');
    assert.equal(named('Dragon', 'Dusted with ash'), 'A silver dragon; Dusted with ash');
    assert.equal(flat('Spirit', 'Dusted with ash'), 'Spirit form; Dusted with ash');
    assert.equal(flat('Dragon', 'A great black wolf, dusted with ash'), 'A great black wolf, dusted with ash', 'a new description of what she is replaces the old one');
    assert.equal(carryOmittedPhysicalTraits({ appearance: 'A wiry old man; wearing a patched coat' }, { appearance: 'Wearing a red silk robe' }).appearance, 'A wiry old man; Wearing a red silk robe');
    assert.equal(carryOmittedPhysicalTraits({ appearance: 'A grey cloak, muddy boots' }, { appearance: 'Wearing a red silk robe' }).appearance, 'Wearing a red silk robe', 'clothing is not an identity');
});

test('1.1.0: a creature form with an accessory is not mistaken for an outfit', () => {
    for (const text of ['A silver dragon wearing a golden collar', 'A black wolf with a red ribbon', 'A silver dragon']) assert.equal(completeFormWithShared(BODY, text), text, text);
    for (const text of ['Wearing a grey cloak', 'In her battle armour, sword drawn', 'Dressed in a blood-stained blue gown']) assert.equal(completeFormWithShared(BODY, text), `${BODY}; ${text}`, text);
});

test('1.1.0: "light" and "dark" re-describe hair only as colours', () => {
    const prior = { appearance: 'Long silver hair, violet eyes; wearing a grey cloak' };
    const keeps = text => /long silver hair/i.test(carryOmittedPhysicalTraits(prior, { appearance: text }).appearance);
    assert.equal(keeps('Her hair catches the light; wearing a red dress'), true);
    assert.equal(keeps('Her hair is a dark tangle after the storm; wearing a red dress'), true);
    assert.equal(keeps('Her hair is now dyed black; wearing a red dress'), false);
    assert.equal(keeps('Dark brown hair now; wearing a red dress'), false);
});
