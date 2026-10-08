import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_MODEL_VERSION, applyAppearanceUpdate, carryOmittedPhysicalTraits, normalizeAppearanceModel } from '../appearance.js';

const carry = (previous, next) => carryOmittedPhysicalTraits({ appearance: previous }, { appearance: next }).appearance;
const dragon = normalizeAppearanceModel({ appearanceModelVersion: APPEARANCE_MODEL_VERSION, currentForm: 'Dragon', appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon' }] });
const dragonAfter = text => applyAppearanceUpdate(dragon, { appearance: text, appearanceState: 'change', appearanceReason: 'ash fell from the burning tower' }).appearanceForms[0].appearance;

test('1.1.1: a passing look is not an identity and does not stick', () => {
    assert.equal(carry('A tired smile, long silver hair; wearing a grey cloak', 'Wearing a red silk dress'), 'long silver hair; Wearing a red silk dress');
});

test('1.1.1: an opening look or body-part sentence keeps what she is', () => {
    assert.equal(dragonAfter('A weary look, dusted with ash'), 'A silver dragon; A weary look, dusted with ash');
    assert.equal(dragonAfter('The scales are dusted with ash'), 'A silver dragon; The scales are dusted with ash');
    assert.equal(dragonAfter('Dusted with ash'), 'A silver dragon; Dusted with ash');
    assert.equal(dragonAfter('A great black wolf, dusted with ash'), 'A great black wolf, dusted with ash');
});

test('1.1.1: "now a", "has become" and "turned into" describe a new identity', () => {
    assert.equal(carry('A wiry old man; wearing a patched coat', 'Now a towering ogre in rags'), 'Now a towering ogre in rags');
    assert.equal(carry('A wiry old man; wearing a patched coat', 'She has become a towering ogre'), 'She has become a towering ogre');
    assert.equal(carry('A wiry old man; wearing a patched coat', 'He turned into a grey wolf'), 'He turned into a grey wolf');
    assert.equal(carry('A wiry old man; wearing a patched coat', 'Her boots are now a mess, wearing rags'), 'A wiry old man; Her boots are now a mess, wearing rags');
    assert.equal(carry('A wiry old man; wearing a patched coat', 'Wearing a red silk robe'), 'A wiry old man; Wearing a red silk robe');
});
