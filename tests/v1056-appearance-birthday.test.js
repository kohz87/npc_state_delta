import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearanceUpdate } from '../appearance.js';
import { createNpcRecord, mergeScanResult } from '../core.js';

const physical = 'Long silver hair, violet eyes, slender build, a thin scar across her left cheek; wearing a travel-stained blue cloak and leather boots.';
const change = (appearance, reason) => ({ appearance, appearanceState: 'change', appearanceReason: reason });

test('an outfit change keeps omitted physical traits and retires the old outfit', () => {
    const reason = 'Myla changed out of her cloak into an emerald ballgown with long silk gloves.';
    const next = applyAppearanceUpdate({ appearance: physical }, change('Wearing an emerald ballgown and long silk gloves.', reason), { context: reason });
    for (const trait of ['Long silver hair', 'violet eyes', 'slender build', 'scar across her left cheek']) assert.match(next.appearance, new RegExp(trait));
    assert.match(next.appearance, /emerald ballgown/);
    assert.doesNotMatch(next.appearance, /blue cloak|leather boots/, 'old clothing does not survive the full current presentation');
});

test('a physical trait changes only when the update itself describes it', () => {
    const context = 'Myla dyed her hair crimson and cut it to her shoulders. She now wears a plain linen shirt.';
    const next = applyAppearanceUpdate({ appearance: physical }, change('Hair freshly dyed crimson and cut to her shoulders; wearing a plain linen shirt.', context), { context });
    assert.match(next.appearance, /crimson/);
    assert.doesNotMatch(next.appearance, /silver hair/, 'an explicitly re-described trait replaces the old one');
    assert.match(next.appearance, /violet eyes/);
});

test('a covering mention does not erase the covered trait', () => {
    const context = 'Myla pulled on a deep hood that hides her hair and a grey travelling coat.';
    const next = applyAppearanceUpdate({ appearance: physical }, change('Wearing a deep hood that hides her hair and a grey travelling coat.', context), { context });
    assert.match(next.appearance, /Long silver hair/);
});

test('clothing-only history and ungrounded updates are unchanged', () => {
    const context = 'Myla changed into an emerald ballgown.';
    assert.equal(applyAppearanceUpdate({ appearance: 'Wearing a blue cloak and leather boots.' }, change('Wearing an emerald ballgown.', context), { context }).appearance, 'Wearing an emerald ballgown.');
    assert.equal(applyAppearanceUpdate({ appearance: physical }, change('Wearing golden plate armor.', 'She put on armor.'), { context: 'Myla sips her tea quietly.' }).appearance, physical);
});

test('carried traits are not duplicated and are not lost to the shared slot', () => {
    const context = 'Myla changed into an emerald ballgown.';
    const next = applyAppearanceUpdate({ overallAppearance: 'Long silver hair', appearance: physical }, change('Wearing an emerald ballgown.', context), { context });
    assert.equal(next.appearance.match(/silver hair/g)?.length, 1);
});

test('a narrated birthday in a profileUpdates row establishes the birthday', () => {
    const npc = createNpcRecord('Myla');
    const transcript = 'Myla smiled. "My birthday is on 07-14, you know."';
    const row = { id: npc.id, birthDate: '07-14', birthDateState: 'establish', birthDateReason: 'Myla states her birthday is 07-14.' };
    for (const scan of [
        { npcs: [], profileUpdates: [row] },
        { npcs: [{ id: npc.id, name: 'Myla', present: true }], profileUpdates: [row] },
    ]) {
        const merged = mergeScanResult({ npcs: [structuredClone(npc)], turn: 3 }, scan, { transcript, sourceMessageId: 4 }).state.npcs.find(item => item.id === npc.id);
        assert.equal(merged.birthDateSource, 'established');
        assert.equal(merged.birthDateDisplay, '07-14');
    }
    const kept = mergeScanResult({ npcs: [structuredClone(npc)], turn: 3 }, { npcs: [], profileUpdates: [{ ...row, birthDateState: 'keep' }] }, { transcript }).state.npcs[0];
    assert.equal(kept.birthDateSource, 'generated', 'the establish/correct gate still applies to the profile channel');
});

test('a selected named form keeps its omitted physical traits without duplicating shared appearance', () => {
    const context = 'Myla changed into an emerald ballgown.';
    const record = {
        overallAppearance: 'Long silver hair',
        appearanceForms: [{ name: 'Human', appearance: 'Violet eyes, slender build; wearing a blue cloak' }],
        currentForm: 'Human',
    };
    const next = applyAppearanceUpdate(record, change('Long silver hair; wearing an emerald ballgown.', context), { context });
    const form = next.appearanceForms.find(item => item.name === 'Human').appearance;
    assert.match(form, /Violet eyes, slender build/);
    assert.match(form, /emerald ballgown/);
    assert.doesNotMatch(form, /blue cloak|silver hair/);
    assert.equal(next.appearance.match(/silver hair/g)?.length, 1);
});
