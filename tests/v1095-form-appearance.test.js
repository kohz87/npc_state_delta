import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyAppearanceUpdate,
    formatAppearanceForms,
    normalizeAppearanceModel,
    parseAppearanceFormsText,
    resolveNpcAppearance,
} from '../appearance.js';
import { buildScannerPrompt } from '../continuity-core.js';
import { mergeImportedDossierState } from '../bundle.js';
import { normalizeNpcRecord } from '../core.js';
import { appearanceFormsHtml } from '../dossier-ui.js';

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

test('v1.0.95 a [full] form replaces the whole body, and the editor round-trips the marker', () => {
    const forms = parseAppearanceFormsText('Human | Long silver hair, violet eyes\nDragon [full] | A forty-foot silver dragon with pearl-white scales');
    assert.equal(forms[1].name, 'Dragon');
    assert.equal(forms[1].fullTransformation, true);
    assert.equal(forms[0].fullTransformation, undefined);
    assert.match(formatAppearanceForms(forms), /^Dragon \[full\] \| /m);
    assert.deepEqual(parseAppearanceFormsText(formatAppearanceForms(forms)), forms);
    const npc = noela({ appearanceForms: forms, currentForm: 'Dragon' });
    assert.equal(resolveNpcAppearance(npc), 'A forty-foot silver dragon with pearl-white scales');
    assert.match(resolveNpcAppearance({ ...npc, currentForm: 'Human' }), /Tall and slender/, 'other forms still get the shared features');
    assert.throws(() => parseAppearanceFormsText('Dragon [full] | a\nDragon | b'), /Duplicate appearance form/);
});

test('v1.0.95 scans keep a form\'s [full] marker and never add shared features to it', () => {
    const npc = normalizeAppearanceModel(noela({ appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon with pearl-white scales', fullTransformation: true }], currentForm: 'Dragon' }));
    const refined = applyAppearanceUpdate(npc, { appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon with pearl-white scales and a jagged scar on one wing', state: 'refine' }] });
    assert.equal(refined.appearanceForms[0].fullTransformation, true, 'the marker survives a form refinement');
    assert.doesNotMatch(refined.appearance, /Tall and slender|pale skin/);
    const flat = applyAppearanceUpdate(npc, { appearance: 'A silver dragon with pearl-white scales, now dusted with ash', appearanceState: 'change', appearanceReason: 'ash from the fire' });
    assert.match(flat.appearanceForms[0].appearance, /dusted with ash/, 'the accepted change reached the full form');
    assert.doesNotMatch(flat.appearanceForms[0].appearance, /Tall and slender|silver hair|pale skin/, 'the shared body is not stored into a full form');
});

test('v1.0.95 the [full] marker survives native import and shows in the dossier', () => {
    const forms = [{ name: 'Human', appearance: 'Long silver hair' }, { name: 'Dragon', appearance: 'A silver dragon', fullTransformation: true }];
    const merged = mergeImportedDossierState({ npcs: [], socialGraph: { edges: [], unresolved: [] } }, { npcs: [normalizeNpcRecord(noela({ appearanceForms: forms }))], socialGraph: { edges: [], unresolved: [] } });
    assert.equal(merged.npcs[0].appearanceForms.find(form => form.name === 'Dragon').fullTransformation, true);
    const html = appearanceFormsHtml({ id: 'npc_noela', appearanceModel: normalizeAppearanceModel(noela({ appearanceForms: forms })) });
    assert.match(html, /Dragon<span class="delta-appearance-current-badge"[^>]*>Full form<\/span>/);
    assert.doesNotMatch(html, /Human<span class="delta-appearance-current-badge"[^>]*>Full form/);
});

test('v1.0.95 the scanner keeps one form\'s body out of the shared slot', () => {
    const prompt = buildScannerPrompt({ transcript: 'Noela shifts into her dragon form.', existingNpcs: [normalizeNpcRecord(noela({ currentForm: 'Human' }))] });
    assert.match(prompt, /overallAppearance=enduring traits identical in every form; one form's body \(hair\/build\/size\/skin\) goes in that form only\./);
});
