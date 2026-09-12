import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appearanceDraftRecord, appearanceUiModel } from '../continuity-ui.js';
import { normalizeNpcRecord, resolveNpcAppearance } from '../core.js';

function formNpc() {
    return normalizeNpcRecord({
        id: 'npc_sora',
        name: 'Sora',
        species: 'Stormcrown Thunderbird',
        overallAppearance: 'Small silver pendant worn in every form.',
        appearanceForms: [
            { name: 'Human', appearance: 'Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns.' },
            { name: 'Stormcrown', appearance: 'Storm-blue plumage, hooked beak, talons, and broad lightning-marked wings.' },
        ],
        currentForm: 'Human',
        appearanceModelVersion: 1,
    });
}

test('continuity UI model exposes canonical named forms and selected form without a second appearance authority', () => {
    const npc = formNpc();
    const model = appearanceUiModel(npc);
    assert.equal(model.currentForm, 'Human');
    assert.equal(model.currentFormUnknown, false);
    assert.deepEqual(model.appearanceForms.map(form => form.name), ['Human', 'Stormcrown']);
    assert.match(model.resolvedAppearance, /ordinary human ears/i);
    assert.doesNotMatch(model.resolvedAppearance, /hooked beak|broad lightning/i);
});

test('appearance form editor draft switches current anatomy while preserving unrelated forms', () => {
    const npc = formNpc();
    const next = appearanceDraftRecord(npc, {
        overallAppearance: 'Small silver pendant worn in every form.',
        currentForm: 'Stormcrown',
        formsText: [
            'Human | Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns.',
            'Stormcrown | Storm-blue plumage, hooked beak, talons, and broad lightning-marked wings.',
        ].join('\n'),
    });
    assert.equal(next.currentForm, 'Stormcrown');
    assert.equal(next.appearanceForms.length, 2);
    assert.match(next.appearanceForms.find(form => form.name === 'Human').appearance, /ordinary human ears/i);
    assert.match(resolveNpcAppearance(next), /hooked beak/i);
    assert.doesNotMatch(resolveNpcAppearance(next), /ordinary human ears/i);
    assert.match(next.appearance, /hooked beak/i);
});

test('appearance form editor rejects a selected form that is absent from the canonical form list', () => {
    const npc = formNpc();
    assert.throws(() => appearanceDraftRecord(npc, {
        currentForm: 'Dragon',
        formsText: 'Human | Ordinary human ears.\nStormcrown | Broad wings.',
    }), /Current form is not in the appearance-form list/);
});

test('appearance form editor preserves other manual locks and adds appearance lock only when requested', () => {
    const npc = normalizeNpcRecord({
        ...formNpc(),
        manualProfileLocksExplicit: true,
        manualProfileFields: ['speech'],
    });
    const unlocked = appearanceDraftRecord(npc, {
        currentForm: 'Human',
        formsText: 'Human | Golden-blue hair, ordinary human ears.\nStormcrown | Storm-blue plumage and broad wings.',
    });
    assert.deepEqual(unlocked.manualProfileFields, ['speech']);

    const locked = appearanceDraftRecord(npc, {
        currentForm: 'Human',
        formsText: 'Human | Golden-blue hair, ordinary human ears.\nStormcrown | Storm-blue plumage and broad wings.',
    }, { lockAppearance: true });
    assert.ok(locked.manualProfileFields.includes('speech'));
    assert.ok(locked.manualProfileFields.includes('appearance'));
});

test('appearance form editor supports an explicitly unclassified current presentation', () => {
    const npc = formNpc();
    const next = appearanceDraftRecord(npc, {
        currentForm: '__unknown__',
        unclassifiedAppearance: 'A silhouette wrapped in pale mist; anatomy is obscured.',
        formsText: 'Human | Golden-blue hair, ordinary human ears.\nStormcrown | Storm-blue plumage and broad wings.',
    });
    assert.equal(next.currentForm, '');
    assert.equal(next.currentFormUnknown, true);
    assert.match(next.unclassifiedAppearance, /silhouette wrapped in pale mist/i);
    assert.match(resolveNpcAppearance(next), /silhouette wrapped in pale mist/i);
    assert.doesNotMatch(resolveNpcAppearance(next), /ordinary human ears|broad wings/i);
});

test('continuity UI ships dedicated calendar/birthday and appearance-form surfaces', () => {
    const source = readFileSync(new URL('../continuity-ui.js', import.meta.url), 'utf8');
    const bootstrap = readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8');
    assert.match(source, /Calendar & birthdays/);
    assert.match(source, /delta-continuity-birthday-card/);
    assert.match(source, /Appearance forms/);
    assert.match(source, /Apply appearance forms/);
    assert.match(bootstrap, /import\('\.\/continuity-ui\.js'\)/);
});
