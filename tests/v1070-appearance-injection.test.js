import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjection, createNpcRecord } from '../core.js';

const PHYSICAL = 'Petite (~160 cm), narrow willowy frame, slender arms and limbs, remarkably generous bust; straight ink-black hair to her hips; faintly pointed, swept-back half-elven ears.';
const OUTFIT = 'threadbare boiled gray linen shift torn at the shoulder seams, stained with water rings, barley chaff and meal dust on collarbones and cheeks.';

function npc(name, overall = PHYSICAL, outfit = OUTFIT) {
    const record = createNpcRecord(name);
    Object.assign(record, {
        present: true, lastSeenTurn: 10, seenCount: 5, species: 'Half-elf', apparentAge: '~19',
        personality: 'Guarded, quietly proud and fiercely self-reliant; hides exhaustion behind brisk competence and distrusts kindness that seems to want something back.',
        speech: 'Short, clipped sentences with a soft southern forest lilt; answers questions with questions when uneasy.',
        behaviorProfile: ['Threat Sensitivity: high - reads every stranger for danger before relaxing', 'Independence/Agency: high - refuses help she has not asked for', 'Loyalty: fierce - stands by the few who earn it'],
        mannerisms: ['Tucks loose hair behind a pointed ear when thinking', 'Flexes aching wrists after heavy lifting'],
        goal: 'Earn enough coin at the mill to leave Farwick before winter.', mood: 'Wary', status: 'Hauling water tubs', location: 'Farwick mill yard',
        memories: ['Fled the southern forest after her village burned', 'Was cheated of a month of wages by a river trader'],
        appearanceModelVersion: 1, overallAppearance: overall, appearance: `${overall.replace(/\.$/, '')}; ${outfit}`,
    });
    return record;
}
const line = (text, name) => text.split('\n').find(entry => entry.startsWith(`- ${name}:`)) || '';
const cast = () => [npc('Elin'), npc('Kora', 'Heavyset matron with ruddy cheeks, an iron-gray braid and thick forearms.', 'flour-dusted apron over a brown wool dress.'), npc('Tam', 'Thick-necked young man with a broken nose and a sunburned neck.', 'sweat-stained tunic.')];

test('the full current appearance is injected when it fits', () => {
    const text = buildInjection(cast(), 'Elin hauls the tub.', 10, 3, undefined, 1800, null);
    assert.match(line(text, 'Elin'), /CURRENT VISIBLE APPEARANCE \(authoritative anatomy; species\/race cannot override the selected form\): Petite[\s\S]*generous bust[\s\S]*linen shift/);
});

test('when the full appearance does not fit, enduring physical features are injected instead of nothing', () => {
    const text = buildInjection(cast(), 'Elin hauls the tub.', 10, 3, undefined, 1200, null);
    const elin = line(text, 'Elin');
    assert.doesNotMatch(elin, /CURRENT VISIBLE APPEARANCE/);
    assert.match(elin, /ENDURING PHYSICAL FEATURES \(authoritative anatomy\): Petite[\s\S]*generous bust/);
    for (const name of ['Elin', 'Kora', 'Tam']) assert.match(line(text, name), /IDENTITY \(authoritative\)/, `${name} keeps its essential block`);
    assert.ok(text.length <= 1200 * 4);
    assert.match(line(text, 'Kora'), /ENDURING PHYSICAL FEATURES|CURRENT VISIBLE APPEARANCE/, 'a second NPC also keeps its anatomy');
});

test('a last-resort appearance is cut at a clause boundary, never inside its label or a word', () => {
    const long = `${PHYSICAL.replace(/\.$/, '')}; ${'amber freckles across the nose and shoulders, '.repeat(6)}a thin white scar through the left eyebrow.`;
    const text = buildInjection([npc('Elin', long)], 'Elin hauls the tub.', 10, 3, undefined, 512, null);
    const elin = line(text, 'Elin');
    const match = elin.match(/(?:CURRENT VISIBLE APPEARANCE|ENDURING PHYSICAL FEATURES)[^:]*\): ([^\n]*)/);
    if (match) {
        assert.match(match[1], /^Petite/);
        assert.doesNotMatch(match[1], /…$/);
    }
    assert.ok(text.length <= 512 * 4);
});

test('an NPC in a named form gets no outfit-free variant; its form anatomy is the appearance', () => {
    const shifter = npc('Sora');
    shifter.appearanceForms = [{ name: 'Raptor', appearance: 'Sleek storm-blue raptor with lightning-streaked plumage.' }];
    shifter.currentForm = 'Raptor';
    const text = buildInjection([shifter], 'Sora circles overhead.', 10, 3, undefined, 1800, null);
    assert.match(line(text, 'Sora'), /CURRENT VISIBLE APPEARANCE[^:]*\): [\s\S]*raptor/i);
    assert.doesNotMatch(text, /ENDURING PHYSICAL FEATURES/);
});

test('injected levers keep their effect when there is room, and every category when there is not', () => {
    const roomy = buildInjection([npc('Elin')], 'Elin hauls the tub.', 10, 3, undefined, 1800, null);
    assert.match(line(roomy, 'Elin'), /Independence: high - refuses help she has not asked for/);
    assert.match(line(roomy, 'Elin'), /Loyalty: fierce - stands by the few who earn it/);
    const tight = buildInjection(cast(), 'Elin hauls the tub.', 10, 3, undefined, 512, null);
    const elin = line(tight, 'Elin') || line(tight, 'Kora') || line(tight, 'Tam');
    for (const category of ['Independence: high', 'Threat Sensitivity: high', 'Loyalty: fierce']) assert.ok(elin.includes(category), `${category} in ${elin}`);
});
