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

    assert.match(prompts.positive, /auburn hair/i);
    assert.match(prompts.positive, /curly hair/i);
    assert.match(prompts.positive, /tangled hair/i);
    assert.match(prompts.positive, /loose hair/i);
    assert.match(prompts.positive, /hair ribbons/i);
    assert.match(prompts.positive, /pointed ears/i);
    assert.doesNotMatch(prompts.positive, /A young half-elf with tangled auburn curls/i);
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

test('comma tags retain unparsed appearance fragments instead of dropping them with parsed anchors', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Human',
        appearance: 'long black hair, freckles, a thin scar across the nose',
    }, {
        stylePositive: '',
        styleNegative: '',
        composition: '',
        format: 'tags',
    });

    assert.match(prompts.positive, /black hair/i);
    assert.match(prompts.positive, /long hair/i);
    assert.match(prompts.positive, /freckles/i);
    assert.match(prompts.positive, /thin scar across the nose/i);
    assert.doesNotMatch(prompts.positive, /long black hair, freckles/i);
});

test('natural portrait format writes fluent label-free prose with subject evidence ahead of style', () => {
    const prompts = buildNpcPortraitPrompts({
        species: 'Half-elf',
        apparentAge: '24',
        gender: 'female',
        role: 'Knight',
        appearance: 'long black hair; gray eyes. Wears a dark leather coat.',
    }, {
        stylePositive: 'STYLE_SENTINEL',
        styleNegative: '',
        composition: 'waist-up portrait',
        format: 'natural',
    });

    assert.doesNotMatch(prompts.positive, /Subject:|Appearance:|Role:|Clothing:|Composition:|Visual style:/);
    assert.match(prompts.positive, /^A portrait of a 24-year-old Half-elf woman with long black hair and gray eyes\./);
    assert.ok(indexOfOrFail(prompts.positive, 'long black hair') < indexOfOrFail(prompts.positive, 'look of a knight'));
    assert.ok(indexOfOrFail(prompts.positive, 'look of a knight') < indexOfOrFail(prompts.positive, 'She wears a dark leather coat'));
    assert.ok(indexOfOrFail(prompts.positive, 'Waist-up portrait') < indexOfOrFail(prompts.positive, 'STYLE_SENTINEL'));
});

const NATURAL_OPTIONS = { stylePositive: 'Soft painterly style', styleNegative: 'low quality', composition: 'waist-up portrait', format: 'natural' };

test('natural portrait prose covers a full dossier with mood, location and extra positive', () => {
    const prompts = buildNpcPortraitPrompts({
        name: 'Ashka', gender: 'female', species: 'fox-beastfolk', apparentAge: '21', role: 'itinerant nun',
        mood: 'Wary', location: 'a ruined chapel at dusk',
        appearance: 'russet fox ears; long tousled deep-red hair. Wears a patched ash-grey habit and flame-cross pendants.',
        portraitPromptPositive: 'soft rim light',
    }, { ...NATURAL_OPTIONS, useLocation: true });
    assert.equal(prompts.positive, 'A portrait of a 21-year-old fox-beastfolk woman with russet fox ears and long tousled deep-red hair. '
        + 'She carries the look of an itinerant nun. She wears a patched ash-grey habit and flame-cross pendants. '
        + 'Her expression is wary. Behind her, a ruined chapel at dusk. Waist-up portrait. Soft rim light. Soft painterly style.');
    const hybrid = buildNpcPortraitPrompts({ name: 'Ashka', gender: 'female', species: 'fox-beastfolk', apparentAge: '21', role: 'itinerant nun', mood: 'Wary', location: 'a ruined chapel at dusk',
        appearance: 'russet fox ears; long tousled deep-red hair. Wears a patched ash-grey habit and flame-cross pendants.', portraitPromptPositive: 'soft rim light' }, { ...NATURAL_OPTIONS, useLocation: true, format: 'hybrid' });
    assert.equal(prompts.negative, hybrid.negative);
});

test('natural portrait prose for a sparse dossier invents nothing', () => {
    const prompts = buildNpcPortraitPrompts({ species: 'Human', gender: 'male' }, { ...NATURAL_OPTIONS, stylePositive: '', composition: '' });
    assert.equal(prompts.positive, 'A portrait of a Human man.');
    assert.equal(buildNpcPortraitPrompts({}, { ...NATURAL_OPTIONS, stylePositive: '', composition: '' }).positive, 'A portrait of a person.');
});

test('natural portrait prose stays gender-neutral when gender is unknown', () => {
    const prompts = buildNpcPortraitPrompts({
        name: 'Sora', species: 'Half-elf', apparentAge: '~12', mood: 'shy', appearance: 'Amber-gold hair; bright gold eyes. Wearing a blue tunic.',
    }, NATURAL_OPTIONS);
    assert.doesNotMatch(prompts.positive, /\b(?:she|he|her|his|him|woman|man)\b/i);
    assert.match(prompts.positive, /^A portrait of a roughly 12-year-old Half-elf person with amber-gold hair and bright gold eyes\. Sora wears a blue tunic\. Sora's expression is shy\./);
    const anonymous = buildNpcPortraitPrompts({ appearance: 'Wearing a blue tunic.' }, { ...NATURAL_OPTIONS, stylePositive: '', composition: '' });
    assert.equal(anonymous.positive, 'A portrait of a person. The person wears a blue tunic.');
});

test('natural portrait prose drops mood and location when switched off and honours replaceAutomatic', () => {
    const npc = { gender: 'female', mood: 'angry', location: 'the harbour', appearance: 'red hair' };
    const off = buildNpcPortraitPrompts(npc, { ...NATURAL_OPTIONS, useMood: false, useLocation: false });
    assert.doesNotMatch(off.positive, /angry|harbour|expression|Behind/);
    const on = buildNpcPortraitPrompts(npc, { ...NATURAL_OPTIONS, useLocation: true });
    assert.match(on.positive, /Her expression is angry\. Behind her, the harbour\./);
    const replaced = buildNpcPortraitPrompts({ ...npc, portraitPromptPositive: 'only this', portraitPromptReplace: true }, NATURAL_OPTIONS);
    assert.equal(replaced.positive, 'only this');
});

test('hybrid and tags portrait formats are byte-identical to the base branch', () => {
    const npc = {
        name: 'Ashka', gender: 'female', species: 'fox-beastfolk', apparentAge: '21', role: 'itinerant nun', mood: 'Wary', location: 'a ruined chapel',
        appearance: 'russet fox ears; long tousled deep-red hair. Wears a patched ash-grey habit and a flame-cross pendant.',
        portraitPromptPositive: 'soft rim light',
    };
    const options = { stylePositive: 'Soft painterly style', styleNegative: 'low quality', composition: 'waist-up portrait', useLocation: true };
    assert.equal(buildNpcPortraitPrompts(npc, { ...options, format: 'hybrid' }).positive,
        'fox-beastfolk; female; apparent age 21; russet fox ears; long tousled deep-red hair; itinerant nun; patched ash-grey habit and a flame-cross pendant; Wary; a ruined chapel; waist-up portrait; soft rim light; Soft painterly style');
    assert.equal(buildNpcPortraitPrompts(npc, { ...options, format: 'tags' }).positive,
        'fox-beastfolk, female, apparent age 21, red hair, long hair, russet fox ears, itinerant nun, patched ash-grey habit and a flame-cross pendant, Wary, a ruined chapel, waist-up portrait, soft rim light, Soft painterly style');
});

const prose = (npc, extra = {}) => buildNpcPortraitPrompts(npc, { ...NATURAL_OPTIONS, ...extra }).positive;

test('natural portrait prose keeps a boy or a girl a boy or a girl', () => {
    assert.match(prose({ name: 'Pip', gender: 'boy', apparentAge: '9', appearance: 'freckles' }), /^A portrait of a 9-year-old boy with freckles\./);
    assert.match(prose({ name: 'Wren', gender: 'girl', apparentAge: '12', appearance: 'braids' }), /^A portrait of a 12-year-old girl with braids\./);
    assert.match(prose({ name: 'Tam', gender: 'male', apparentAge: '14', appearance: 'freckles' }), /^A portrait of a 14-year-old boy with freckles\./, 'a numeric age under 18 with male is a boy');
    assert.match(prose({ name: 'Ila', gender: 'female', apparentAge: '10-12', appearance: 'braids' }), /^A portrait of a 10-12-year-old girl with braids\./);
    assert.match(prose({ name: 'Orin', gender: 'male', apparentAge: '18', appearance: 'freckles' }), /^A portrait of an 18-year-old man with freckles\./, '18 is an adult');
    assert.doesNotMatch(prose({ name: 'Pip', gender: 'boy', apparentAge: '9' }), /\bman\b/);
});

test('natural portrait prose drops a leading "He/She/They has" and puts a bare adjective on the subject', () => {
    assert.match(prose({ name: 'Rook', gender: 'male', apparentAge: '~80', species: 'Human', appearance: 'He has a white beard. Scar over left eye.' }), /^A portrait of a roughly 80-year-old Human man with a white beard and scar over left eye\./);
    assert.match(prose({ name: 'Mae', gender: 'female', appearance: 'She has green eyes' }), /^A portrait of a woman with green eyes\./);
    assert.match(prose({ name: 'Ola', appearance: 'They have a crooked nose' }), /^A portrait of a person with a crooked nose\./);
    assert.match(prose({ name: 'Bram', gender: 'male', appearance: 'Burly' }), /^A portrait of a burly man\./);
    assert.match(prose({ name: 'Bram', gender: 'male', apparentAge: '40', appearance: 'Burly; a scarred jaw' }), /^A portrait of a 40-year-old burly man with a scarred jaw\./);
    assert.doesNotMatch(prose({ name: 'Bram', gender: 'male', appearance: 'Burly' }), /with burly/);
});

test('natural portrait prose picks a or an by sound', () => {
    assert.match(prose({ name: 'X', species: 'unicorn-kin', gender: 'female', appearance: 'Silver horn' }), /^A portrait of a unicorn-kin woman with silver horn\./);
    assert.match(prose({ name: 'X', species: 'elf', gender: 'female' }), /^A portrait of an elf woman\./);
    assert.match(prose({ name: 'X', species: 'one-eyed ogre', gender: 'male' }), /^A portrait of a one-eyed ogre man\./);
    assert.match(prose({ name: 'X', species: 'Umbral wraith', gender: 'male' }), /^A portrait of a male Umbral wraith\./);
});

test('natural portrait prose: a/an by sound, is/are stripped, capitalised words are not adjectives, no doubled noun, teen', () => {
    assert.match(prose({ name: 'A', gender: 'male', role: 'uninvited guest' }), /the look of an uninvited guest/);
    assert.match(prose({ name: 'A', species: 'unidentified beast', gender: 'male' }), /^A portrait of a male unidentified beast\./);
    assert.match(prose({ name: 'A', gender: 'female', role: 'utopian dreamer' }), /the look of a utopian dreamer/);
    assert.match(prose({ name: 'A', gender: 'female', role: 'uniform inspector' }), /the look of a uniform inspector/);
    assert.match(prose({ name: 'A', species: 'unicorn-kin', gender: 'female' }), /^A portrait of a unicorn-kin woman\./);
    assert.match(prose({ name: 'A', gender: 'female', appearance: 'She is tall' }), /^A portrait of a tall woman\./);
    assert.match(prose({ name: 'A', gender: 'male', appearance: 'They are scarred; He has red eyes' }), /with red eyes/);
    assert.match(prose({ name: 'A', gender: 'male', appearance: 'Red; tall' }), /^A portrait of a tall man with red\./, 'a capitalised -ed word is left alone');
    assert.match(prose({ name: 'A', gender: 'male', species: 'catboy', apparentAge: '15' }), /^A portrait of a 15-year-old catboy\./);
    assert.match(prose({ name: 'A', gender: 'male', apparentAge: 'teen' }), /^A portrait of a teenage boy\./);
    assert.doesNotMatch(prose({ name: 'A', gender: 'male', apparentAge: 'teen' }), /apparent age/);
});

test('natural portrait prose turns "His hair is white" into "white hair"', () => {
    assert.match(prose({ name: 'A', gender: 'male', appearance: 'His hair is white; Her eyes are green' }), /^A portrait of a man with white hair and green eyes\./);
});

test('natural portrait prose gives no human form to an animal, a dragon or a robot; humans and humanoids keep theirs', () => {
    assert.match(prose({ name: 'Fang', gender: 'male', species: 'wolf' }), /^A portrait of a male wolf\./);
    assert.match(prose({ name: 'Ember', gender: 'female', species: 'dragon' }), /^A portrait of a female dragon\./);
    assert.match(prose({ name: 'Unit 7', species: 'robot' }), /^A portrait of a robot\./);
    assert.match(prose({ name: 'Pup', gender: 'male', species: 'wolf', apparentAge: '2' }), /^A portrait of a 2-year-old male wolf\./);
    assert.match(prose({ name: 'A', gender: 'female', species: 'Human', apparentAge: '30' }), /^A portrait of a 30-year-old Human woman\./);
    assert.match(prose({ name: 'Pip', gender: 'boy', species: 'human', apparentAge: '9' }), /^A portrait of a 9-year-old human boy\./, 'a human boy stays a boy');
    assert.match(prose({ name: 'A', gender: 'female', species: 'fox-beastfolk', apparentAge: '21' }), /^A portrait of a 21-year-old fox-beastfolk woman\./);
    assert.match(prose({ name: 'A', gender: 'male', species: 'elf' }), /^A portrait of an elf man\./);
    assert.match(prose({ name: 'A', gender: 'male' }), /^A portrait of a man\./);
});

test('natural portrait prose joins "Tall, with silver hair" without a doubled "with"', () => {
    assert.match(prose({ name: 'A', gender: 'male', appearance: 'Tall, with silver hair' }), /^A portrait of a tall man with silver hair\./);
    assert.doesNotMatch(prose({ name: 'A', gender: 'male', appearance: 'Tall, with silver hair' }), /with tall|with[^.]*, with/);
});

test('natural portrait prose keeps a man for ogres, trolls, giants, centaurs and beast-men', () => {
    assert.match(prose({ name: 'A', gender: 'male', species: 'ogre' }), /^A portrait of an ogre man\./);
    assert.match(prose({ name: 'A', gender: 'female', species: 'troll' }), /^A portrait of a troll woman\./);
    assert.match(prose({ name: 'A', gender: 'male', species: 'giant' }), /^A portrait of a giant man\./);
    assert.match(prose({ name: 'A', gender: 'female', species: 'centaur' }), /^A portrait of a centaur woman\./);
    assert.match(prose({ name: 'A', gender: 'male', species: 'beastman' }), /^A portrait of a beastman\./);
    assert.match(prose({ name: 'A', gender: 'male', species: 'beast-man' }), /^A portrait of a beast-man\./);
    assert.match(prose({ name: 'A', gender: 'male', species: 'wolf' }), /^A portrait of a male wolf\./, 'an animal still gets none');
});
