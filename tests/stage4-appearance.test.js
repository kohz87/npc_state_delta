import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyNpcStateCommand,
    buildInjection,
    buildNpcPortraitPrompts,
    buildScannerPrompt,
    createNpcRecord,
    isTerminalNpcDeath,
    mergeScanResult,
    normalizeNpcRecord,
    parseAppearanceFormsText,
    resolveNpcAppearance,
    setNpcArchived,
} from '../core.js';
import { BRANCH_LINEAGE_VERSION, recordBranchCheckpoint, reconcileBranchState } from '../branch.js';
import { mergeImportedDossierState } from '../bundle.js';
import { dossierDetailProjection } from '../dossier-ui.js';

function formNpc(name = 'Sora') {
    return normalizeNpcRecord({
        ...createNpcRecord(name),
        appearanceModelVersion: 1,
        overallAppearance: 'Small silver pendant worn in every form.',
        appearanceForms: [
            { name: 'Human', appearance: 'Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns; cobalt tailored wool dress and calfskin boots.' },
            { name: 'Stormcrown', appearance: 'Storm-blue plumage, hooked beak, talons, and broad lightning-marked wings.' },
        ],
        currentForm: 'Human',
    });
}

test('Stage 4 flat appearance upgrades to one Base form without fabricating alternates', () => {
    const npc = normalizeNpcRecord({ id: 'npc_ryu', name: 'Ryu', appearance: 'Long silver hair, grey eyes, spruce-green wool dress.' });
    assert.equal(npc.currentForm, 'Base');
    assert.deepEqual(npc.appearanceForms, [{ name: 'Base', appearance: 'Long silver hair, grey eyes, spruce-green wool dress.' }]);
    assert.equal(resolveNpcAppearance(npc), npc.appearance);
});

test('Stage 4 form identity preserves meaningful punctuation instead of collapsing distinct names', () => {
    const forms = parseAppearanceFormsText(`A-B | First presentation.\nA B | Second presentation.`);
    assert.equal(forms.length, 2);
    assert.equal(forms[0].name, 'A-B');
    assert.equal(forms[1].name, 'A B');
    assert.throws(() => parseAppearanceFormsText(`Human | First.\nhuman | Duplicate.`), /Duplicate appearance form/);
});

test('Stage 4 selected form owns anatomy while overall presentation remains available', () => {
    const npc = formNpc();
    const human = resolveNpcAppearance(npc);
    assert.match(human, /cobalt tailored wool dress/i);
    assert.match(human, /small silver pendant/i);
    assert.match(human, /ordinary human ears/i);
    assert.doesNotMatch(human, /hooked beak|talons|broad lightning/i);
    const storm = resolveNpcAppearance({ ...npc, currentForm: 'Stormcrown' });
    assert.match(storm, /Storm-blue plumage/);
    assert.doesNotMatch(storm, /ordinary human ears/i);
});

test('Stage 4 form switching and refinement preserve unrelated forms', () => {
    const base = formNpc('Ryu');
    const result = mergeScanResult({ npcs: [base], turn: 2 }, { npcs: [{
        id: base.id,
        name: base.name,
        appearanceForms: [{ name: 'Human', appearance: 'Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns; faint cheek scar.', state: 'refine' }],
        currentForm: 'Stormcrown',
        currentFormState: 'select',
        present: true,
    }] }, { turn: 2, developmentContext: "Ryu's Human form has long silver hair, grey eyes, ordinary human ears, and a faint cheek scar. Ryu then switches forms." });
    const npc = result.state.npcs[0];
    assert.equal(npc.currentForm, 'Stormcrown');
    assert.equal(npc.appearanceForms.length, 2);
    assert.match(npc.appearanceForms.find(form => form.name === 'Human').appearance, /cheek scar/);
    assert.match(npc.appearanceForms.find(form => form.name === 'Stormcrown').appearance, /Storm-blue plumage/);
});

test('Stage 4 unnamed form keeps form-independent appearance exactly once across normalization', () => {
    const known = formNpc('Mira');
    const transformed = mergeScanResult({ npcs: [known], turn: 3 }, { npcs: [{
        id: known.id,
        name: known.name,
        appearance: 'A silhouette wrapped in pale mist; anatomy is obscured.',
        appearanceState: 'change',
        appearanceReason: 'Mira changed into a visibly different presentation.',
        currentFormState: 'unknown',
        present: true,
    }] }, { turn: 3, developmentContext: 'Mira changed into a visibly different presentation, a silhouette wrapped in pale mist; anatomy is obscured.' }).state.npcs[0];
    const twice = normalizeNpcRecord(normalizeNpcRecord(transformed));
    assert.equal(twice.currentFormUnknown, true);
    assert.match(twice.unclassifiedAppearance, /silhouette wrapped in pale mist/i);
    assert.equal((resolveNpcAppearance(twice).match(/Small silver pendant/gi) || []).length, 1);
    assert.doesNotMatch(resolveNpcAppearance(twice), /ordinary human ears|hooked beak/i);
});

test('Stage 4 unidentified current form never borrows previous or migrated Base anatomy', () => {
    const known = formNpc('Mira');
    const transformed = mergeScanResult({ npcs: [known], turn: 3 }, { npcs: [{
        id: known.id,
        name: known.name,
        appearance: 'A silhouette wrapped in pale mist; anatomy is obscured.',
        appearanceState: 'change',
        appearanceReason: 'Mira changed into a visibly different presentation.',
        developmentScale: 'explicit',
        developmentReason: 'Mira changed into a visibly different presentation.',
        currentFormState: 'unknown',
        present: true,
    }] }, { turn: 3, developmentContext: 'Mira changed into a visibly different presentation, a silhouette wrapped in pale mist; anatomy is obscured.' }).state.npcs[0];
    assert.equal(transformed.currentForm, '');
    assert.equal(transformed.currentFormUnknown, true);
    assert.match(resolveNpcAppearance(transformed), /silhouette wrapped in pale mist/i);
    assert.doesNotMatch(resolveNpcAppearance(transformed), /hooked beak|ordinary human ears/i);

    const migrated = normalizeNpcRecord({ id: 'legacy', name: 'Legacy', appearance: 'Human face, brown hair, ordinary human ears.' });
    const unknown = mergeScanResult({ npcs: [migrated], turn: 4 }, { npcs: [{ id: migrated.id, name: migrated.name, currentFormState: 'unknown', present: true }] }, { turn: 4 }).state.npcs[0];
    assert.equal(resolveNpcAppearance(unknown), '');
    assert.equal(unknown.appearanceForms[0].name, 'Base');
});

test('Stage 4 selecting a named form without a description never falls back to migrated Base anatomy', () => {
    const migrated = normalizeNpcRecord({ id: 'npc_shift', name: 'Shift', appearance: 'Human face, brown hair, ordinary human ears.' });
    const switched = mergeScanResult({ npcs: [migrated], turn: 5 }, { npcs: [{
        id: migrated.id,
        name: migrated.name,
        currentForm: 'Dragon',
        currentFormState: 'select',
        present: true,
    }] }, { turn: 5, developmentContext: 'Shift transforms into a Dragon form, but the mist hides its anatomy.' }).state.npcs[0];
    assert.equal(switched.currentForm, 'Dragon');
    assert.equal(resolveNpcAppearance(switched), '');
    assert.doesNotMatch(resolveNpcAppearance(switched), /human face|ordinary human ears/i);
});

test('Stage 4 established form anatomy rejects ungrounded rewrites but accepts grounded explicit changes', () => {
    const base = formNpc('Sora');
    const rejected = mergeScanResult({ npcs: [base], turn: 6 }, { npcs: [{
        id: base.id,
        name: base.name,
        appearanceForms: [{ name: 'Human', appearance: 'Black hair, curved horns, red eyes.', state: 'change', reason: 'Her human form changed completely.' }],
        present: true,
    }] }, { turn: 6, developmentContext: 'Sora greets Lucien and sits beside the window.' }).state.npcs[0];
    assert.match(rejected.appearanceForms.find(form => form.name === 'Human').appearance, /Golden-blue hair/i);
    assert.doesNotMatch(rejected.appearanceForms.find(form => form.name === 'Human').appearance, /curved horns/i);

    const accepted = mergeScanResult({ npcs: [base], turn: 7 }, { npcs: [{
        id: base.id,
        name: base.name,
        appearanceForms: [{ name: 'Human', appearance: 'Black hair, ordinary human ears, small ivory horns.', state: 'change', reason: 'Sora human form hair turned black and small ivory horns emerged.' }],
        present: true,
    }] }, { turn: 7, developmentContext: 'Sora human form hair turned black and small ivory horns emerged; her ordinary human ears remain visible.' }).state.npcs[0];
    assert.match(accepted.appearanceForms.find(form => form.name === 'Human').appearance, /Black hair/i);
    assert.match(accepted.appearanceForms.find(form => form.name === 'Human').appearance, /small ivory horns/i);
});

test('Stage 4 appearance lock protects overall presentation, forms, and selection together', () => {
    const base = normalizeNpcRecord({ ...formNpc('Astra'), manualProfileLocksExplicit: true, manualProfileFields: ['appearance'] });
    const result = mergeScanResult({ npcs: [base], turn: 5 }, { npcs: [{
        id: base.id,
        name: base.name,
        appearance: 'Red coat.',
        appearanceState: 'change',
        appearanceForms: [{ name: 'Beast', appearance: 'Wolf ears and tail.', state: 'change' }],
        currentForm: 'Beast',
        currentFormState: 'select',
        present: true,
    }] }, { turn: 5 });
    const npc = result.state.npcs[0];
    assert.equal(npc.appearance, base.appearance);
    assert.equal(npc.currentForm, 'Human');
    assert.equal(npc.appearanceForms.length, 2);
});

test('Stage 4 portrait and roleplay injection resolve the same current form', () => {
    const npc = { ...formNpc(), present: true, role: 'Companion', species: 'Stormcrown Thunderbird' };
    const portrait = buildNpcPortraitPrompts(npc).positive;
    const injection = buildInjection([npc], 'Sora stands nearby.', 10, 3, undefined, 2000);
    assert.match(portrait, /ordinary human ears/i);
    assert.match(injection, /ordinary human ears/i);
    assert.doesNotMatch(portrait, /Storm-blue plumage/i);
    assert.doesNotMatch(injection, /Storm-blue plumage/i);
    assert.doesNotMatch(portrait, /Stormcrown Thunderbird/i, 'species identity must not override a selected non-Base form in portrait anatomy');
    assert.match(injection, /CURRENT VISIBLE APPEARANCE \(authoritative anatomy; species\/race cannot override the selected form\)/i);
    assert.equal((injection.match(/ordinary human ears/gi) || []).length, 1, 'resolved current appearance should be injected once, not duplicated after the budgeted dossier');
});

