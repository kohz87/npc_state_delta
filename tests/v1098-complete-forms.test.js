import test from 'node:test';
import assert from 'node:assert/strict';
import {
    APPEARANCE_MODEL_VERSION,
    appearanceDraftRecord,
    appearanceFingerprint,
    applyAppearanceUpdate,
    carryOmittedPhysicalTraits,
    formatAppearanceForms,
    normalizeAppearanceModel,
    resolveNpcAppearance,
} from '../appearance.js';
import { buildScannerPrompt } from '../continuity-core.js';
import { mergeImportedDossierState } from '../bundle.js';
import { normalizeNpcRecord } from '../core.js';

const SHARED = 'Tall and slender, long silver hair, violet eyes, pale skin';
const v1 = (extra = {}) => ({
    id: 'npc_noela', name: 'Noela', appearanceModelVersion: 1, overallAppearance: SHARED,
    appearanceForms: [
        { name: 'Human', appearance: 'Long silver hair, violet eyes, pale skin; wearing a grey travelling cloak' },
        { name: 'Dragon', appearance: 'A forty-foot silver dragon with pearl-white scales', fullTransformation: true },
        { name: 'Demi-human', appearance: 'Small curved horns and a scaled tail; light leather armour' },
    ],
    ...extra,
});

test('v1.0.98 a version-1 record converts once to complete forms that show exactly what they showed', () => {
    const before = form => resolveNpcAppearance({ ...v1(), currentForm: form });
    const model = normalizeAppearanceModel(v1());
    assert.equal(model.appearanceModelVersion, APPEARANCE_MODEL_VERSION);
    const stored = Object.fromEntries(model.appearanceForms.map(form => [form.name, form.appearance]));
    assert.equal(stored.Human, 'Tall and slender, long silver hair, violet eyes, pale skin; wearing a grey travelling cloak');
    assert.equal(stored.Dragon, 'A forty-foot silver dragon with pearl-white scales', 'a [full] form already stood alone');
    assert.equal(stored['Demi-human'], 'Tall and slender, long silver hair, violet eyes, pale skin; Small curved horns and a scaled tail; light leather armour');
    for (const form of ['Human', 'Dragon', 'Demi-human']) assert.equal(resolveNpcAppearance({ ...model, currentForm: form }), before(form));
    assert.equal(model.appearanceForms.some(form => 'fullTransformation' in form), false, 'the retired marker is not kept');
    assert.deepEqual(normalizeAppearanceModel(model).appearanceForms, model.appearanceForms, 'conversion happens once');
    // Portraits recorded before the conversion keep their identity.
    const npc = normalizeNpcRecord({ ...v1(), currentForm: 'Human' });
    assert.equal(appearanceFingerprint(npc), appearanceFingerprint({ ...v1(), currentForm: 'Human' }));
});

test('v1.0.98 a named form is its own complete appearance; the shared slot serves only the no-form presentation', () => {
    const npc = normalizeAppearanceModel({ overallAppearance: 'Long silver hair, violet eyes', appearance: 'Wearing a grey cloak', appearanceModelVersion: APPEARANCE_MODEL_VERSION,
        appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon with pearl-white scales' }] });
    assert.equal(resolveNpcAppearance({ ...npc, currentForm: 'Dragon' }), 'A silver dragon with pearl-white scales');
    assert.equal(resolveNpcAppearance({ ...npc, currentForm: '' }), 'Long silver hair, violet eyes; Wearing a grey cloak');
    assert.doesNotMatch(formatAppearanceForms(npc.appearanceForms), /\[full\]/);
    // A manual form edit is current-version data and is never combined again.
    const edited = appearanceDraftRecord(npc, { overallAppearance: 'Long silver hair, violet eyes', formsText: 'Dragon | A silver dragon\nHuman | Short black hair', currentForm: 'Human' });
    assert.equal(edited.appearanceModelVersion, APPEARANCE_MODEL_VERSION);
    assert.equal(resolveNpcAppearance(edited), 'Short black hair');
});

test('v1.0.98 a form keeps its body through outfit and styling updates, but a real hair change replaces it', () => {
    const base = normalizeAppearanceModel({ appearanceModelVersion: APPEARANCE_MODEL_VERSION, currentForm: 'Human',
        appearanceForms: [{ name: 'Human', appearance: 'Tall and slender, long silver hair, violet eyes, pale skin, a thin scar on her left cheek; wearing a grey travelling cloak' }] });
    const update = appearance => applyAppearanceUpdate(base, { appearanceForms: [{ name: 'Human', appearance, state: 'change', reason: 'she changed' }] }).appearanceForms[0].appearance;
    for (const text of ['Wearing a red silk dress', 'Her hair is tied up in a bun; wearing a red silk dress', 'Hair soaked from the rain, wearing a red silk dress', 'Eyes hidden behind dark glasses, wearing a red silk dress']) {
        const result = update(text);
        assert.match(result, /long silver hair/, text);
        assert.match(result, /violet eyes/, text);
        assert.match(result, /thin scar/, text);
        assert.doesNotMatch(result, /grey travelling cloak/, text);
    }
    const dyed = update('Her hair is now cropped short and dyed black; wearing a red silk dress');
    assert.doesNotMatch(dyed, /long silver hair/);
    assert.match(dyed, /cropped short and dyed black/);
    // The same styling rule protects the shared slot of an NPC without forms.
    const flat = carryOmittedPhysicalTraits({ appearance: 'Long silver hair, violet eyes; wearing a grey cloak' }, { appearance: 'Her hair is pinned back; wearing a red silk dress' });
    assert.match(flat.appearance, /long silver hair/i);
});

test('v1.0.98 import converts version-1 forms the same way, and scans describe each form completely', () => {
    const merged = mergeImportedDossierState({ npcs: [], socialGraph: { edges: [], unresolved: [] } }, { npcs: [normalizeNpcRecord(v1())], socialGraph: { edges: [], unresolved: [] } });
    assert.match(merged.npcs[0].appearanceForms.find(form => form.name === 'Demi-human').appearance, /long silver hair/);
    const prompt = buildScannerPrompt({ transcript: 'Noela shifts into her dragon form.', existingNpcs: [normalizeNpcRecord({ ...v1(), currentForm: 'Human' })] });
    assert.match(prompt, /With named forms, each form appearance is that form's COMPLETE visible appearance \(body\+outfit\); overallAppearance is only for an NPC without forms\./);
    assert.doesNotMatch(prompt, /enduring traits identical in every form/);
});
