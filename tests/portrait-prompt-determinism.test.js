import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNpcPortraitPrompts, createNpcRecord } from '../core.js';

function indexOfOrFail(text, fragment) {
    const index = text.toLowerCase().indexOf(fragment.toLowerCase());
    assert.notEqual(index, -1, 'Expected prompt to contain: ' + fragment);
    return index;
}

test('portrait prompt assembly is deterministic, subject-first, label-free in tag formats, and style-last', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Half-elf',
        apparentAge: '18',
        role: 'Civilian Guild Intake Clerk',
        appearance: 'Tangled red hair coming loose from lost hair ribbons; pointed ears; pale hazel eyes; ample bust. Wears a slightly crooked rough wool tunic beneath a leather vest pinned with an Ardelian registration badge.',
        mood: 'Harried, observant, practical',
        location: 'Adventurer Guildhall, Rimecross Waystation',
    }, {
        stylePositive: 'STYLE_SENTINEL',
        styleNegative: 'BASE_NEGATIVE',
        composition: 'solo portrait, face visible',
        format: 'hybrid',
        useMood: true,
        useLocation: true,
    });

    const order = [
        'Half-elf',
        'Tangled red hair',
        'Civilian Guild Intake Clerk',
        'rough wool tunic',
        'Harried, observant, practical',
        'Adventurer Guildhall, Rimecross Waystation',
        'solo portrait, face visible',
        'STYLE_SENTINEL',
    ].map(fragment => indexOfOrFail(prompts.positive, fragment));
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], 'portrait sections must remain in deterministic subject-first order');

    assert.doesNotMatch(prompts.positive, /\brole\s*:/i);
    assert.doesNotMatch(prompts.positive, /expression\s*\/\s*bearing\s*:/i);
    assert.doesNotMatch(prompts.positive, /background\s*\/\s*location\s*:/i);
    assert.match(prompts.negative, /white hair/);
    assert.match(prompts.negative, /silver hair/);
    assert.match(prompts.negative, /blonde hair/);
    assert.match(prompts.negative, /blue hair/);
    assert.match(prompts.negative, /purple hair/);
    assert.doesNotMatch(prompts.negative, /^red hair(?:,|$)/i);
});

test('portrait prompt appearance splitting deduplicates strong-boundary repeats and separates clear clothing', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Human',
        appearance: 'red hair; red hair; green eyes. Wears a blue wool dress; blue wool dress',
    }, {
        stylePositive: 'STYLE_LAST',
        styleNegative: '',
        composition: '',
        format: 'tags',
    });

    assert.equal((prompts.positive.match(/red hair/gi) || []).length, 1);
    assert.equal((prompts.positive.match(/blue wool dress/gi) || []).length, 1);
    assert.ok(indexOfOrFail(prompts.positive, 'green eyes') < indexOfOrFail(prompts.positive, 'blue wool dress'));
    assert.ok(indexOfOrFail(prompts.positive, 'blue wool dress') < indexOfOrFail(prompts.positive, 'STYLE_LAST'));
});

test('resolved human form excludes alternate-form anatomy and turns explicit absent anatomy into safe negatives', () => {
    const npc = createNpcRecord('Sora');
    Object.assign(npc, {
        species: 'Stormcrown Thunderbird Chimera',
        overallAppearance: 'shoulder-length distinctly golden-blue hair with warm gold and blue pigmentation',
        appearanceForms: [
            { name: 'Thunderbird', appearance: 'vast cobalt wings, bright feathers, hooked talons' },
            { name: 'Human', appearance: 'young human girl with ordinary human ears, two arms, two legs, no avian wings or feathers, no tail' },
        ],
        currentForm: 'Human',
        currentFormUnknown: false,
        appearanceModelVersion: 1,
    });

    const prompts = buildNpcPortraitPrompts(npc, {
        stylePositive: 'anime portrait',
        styleNegative: 'low quality',
        composition: 'face visible',
        format: 'hybrid',
    });
    assert.match(prompts.positive, /golden-blue/i);
    assert.match(prompts.positive, /ordinary human ears/i);
    assert.doesNotMatch(prompts.positive, /vast cobalt wings|hooked talons|Stormcrown Thunderbird Chimera/i);
    assert.match(prompts.negative, /\bwings\b/i);
    assert.match(prompts.negative, /\bfeathers\b/i);
    assert.match(prompts.negative, /\btail\b/i);
    assert.doesNotMatch(prompts.negative, /\bblue hair\b/i, 'explicit blue pigmentation must never be negated');
});

test('comma tags promote explicit visual anchors from prose without dropping the accepted appearance', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Half-elf',
        apparentAge: '~18',
        role: 'Civilian Guild Intake Clerk',
        appearance: 'A young half-elf with tangled auburn curls coming loose from lost hair ribbons, pointed ears, pale hazel eyes, and an ample bust. Wears a slightly crooked rough wool tunic beneath a leather vest pinned with an Ardelian registration badge.',
        mood: 'Harried, observant, practical',
        location: 'Adventurer Guildhall, Rimecross Waystation',
    }, {
        stylePositive: 'STYLE_SENTINEL',
        styleNegative: 'BASE_NEGATIVE',
        composition: '',
        format: 'tags',
        useMood: true,
        useLocation: true,
    });

    assert.ok(indexOfOrFail(prompts.positive, 'auburn hair') < indexOfOrFail(prompts.positive, 'A young half-elf with tangled auburn curls'));
    assert.match(prompts.positive, /curly hair/i);
    assert.match(prompts.positive, /tangled hair/i);
    assert.match(prompts.positive, /pointed ears/i);
    assert.match(prompts.positive, /pale hazel eyes/i);
    assert.match(prompts.positive, /ample bust/i);
    assert.match(prompts.positive, /rough wool tunic/i);
    assert.ok(indexOfOrFail(prompts.positive, 'auburn hair') < indexOfOrFail(prompts.positive, 'STYLE_SENTINEL'));

    assert.match(prompts.negative, /white hair/i);
    assert.match(prompts.negative, /silver hair/i);
    assert.match(prompts.negative, /blonde hair/i);
    assert.match(prompts.negative, /blue hair/i);
    assert.match(prompts.negative, /purple hair/i);
    assert.doesNotMatch(prompts.negative, /(?:^|,\s*)auburn hair(?:,|$)/i);
});

test('comma tags preserve explicit multicolor hair as one standalone anchor and do not negate its components', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Human',
        appearance: 'shoulder-length distinctly golden-blue hair with warm gold and blue pigmentation; silvery-gray eyes',
    }, {
        stylePositive: 'STYLE_LAST',
        styleNegative: '',
        composition: '',
        format: 'tags',
    });

    assert.match(prompts.positive, /golden-blue hair/i);
    assert.match(prompts.positive, /shoulder-length hair/i);
    assert.doesNotMatch(prompts.negative, /\b(?:golden|blue) hair\b/i);
});

test('natural portrait format keeps subject evidence ahead of style while retaining readable labels', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Half-elf',
        apparentAge: '24',
        role: 'Knight',
        appearance: 'long black hair; gray eyes. Wears a dark leather coat.',
    }, {
        stylePositive: 'STYLE_SENTINEL',
        styleNegative: '',
        composition: 'waist-up portrait',
        format: 'natural',
    });

    assert.ok(indexOfOrFail(prompts.positive, 'Subject:') < indexOfOrFail(prompts.positive, 'Appearance:'));
    assert.ok(indexOfOrFail(prompts.positive, 'Appearance:') < indexOfOrFail(prompts.positive, 'Role:'));
    assert.ok(indexOfOrFail(prompts.positive, 'Role:') < indexOfOrFail(prompts.positive, 'Clothing:'));
    assert.ok(indexOfOrFail(prompts.positive, 'Composition:') < indexOfOrFail(prompts.positive, 'Visual style: STYLE_SENTINEL'));
});
