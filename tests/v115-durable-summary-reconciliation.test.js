import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcRecord, mergeScanResult } from '../core.js';
import { applyAppearanceUpdate, appearanceFormByName, resolveNpcAppearance } from '../appearance.js';

function profileState(npc, update, options = {}) {
    return mergeScanResult({ npcs: [npc], candidates: [], turn: 1 }, {
        npcs: [],
        profileUpdates: [{ id: npc.id, ...update }],
    }, { turn: 2, ...options }).state.npcs[0];
}

test('v1.0.15 appearance refine replaces the full current summary instead of stacking an old outfit', () => {
    const npc = createNpcRecord('Sora');
    npc.appearance = 'Thick wave of shimmering blue-gold hair braided down to her waist with bone bodkins, bright amber eyes, soft youthful face, four inches taller with early budding bust development; wears a tailored cerulean silk dress with cream ribboning beneath a dark charcoal wool school pinafore and sturdy leather boots.';

    const updated = profileState(npc, {
        appearanceState: 'refine',
        appearance: 'Thick wave of shimmering blue-gold hair braided down to her waist with bone bodkins, bright amber eyes, soft youthful face, four inches taller with early budding bust development; dressed in a high-collared bleached flax smock under an embroidered green and saffron silk vest over a heavy slate-grey wool skirt.',
    });

    assert.match(updated.appearance, /bleached flax smock/i);
    assert.match(updated.appearance, /slate-grey wool skirt/i);
    assert.doesNotMatch(updated.appearance, /cerulean silk dress/i);
    assert.doesNotMatch(updated.appearance, /school pinafore/i);
    assert.doesNotMatch(updated.appearance, /sturdy leather boots/i);
});

test('v1.0.15 personality and speech refine replace accepted full summaries and retire omitted clauses', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Cautious, reserved, courteous, observant, and slow to trust; reflexively defers to guild authority.';
    npc.speech = 'Soft, formal, measured, and precise; addresses elders with careful titles; stammers whenever nervous.';

    const updated = profileState(npc, {
        personalityState: 'refine',
        personality: 'Cautious, reserved, courteous, observant, and slow to trust; dryly humorous with familiar classmates.',
        speechState: 'refine',
        speech: 'Soft, formal, measured, and precise; addresses elders with careful titles; uses concise technical vocabulary.',
    });

    assert.match(updated.personality, /dryly humorous/i);
    assert.doesNotMatch(updated.personality, /defers to guild authority/i);
    assert.match(updated.speech, /technical vocabulary/i);
    assert.doesNotMatch(updated.speech, /stammers whenever nervous/i);
});

test('v1.0.15 mannerism refine treats the accepted list as the full current set', () => {
    const npc = createNpcRecord('Toris');
    npc.mannerisms = [
        'Habitually scratches his beard before answering.',
        'Regularly taps twice on the table when impatient.',
    ];

    const updated = profileState(npc, {
        mannerismState: 'refine',
        mannerisms: ['Habitually scratches his beard before answering difficult questions.'],
    });

    assert.equal(updated.mannerisms.length, 1);
    assert.match(updated.mannerisms[0], /scratches his beard/i);
    assert.doesNotMatch(updated.mannerisms.join(' '), /taps twice/i);
});

test('v1.0.15 behavior profile refine treats the accepted list as the full current set', () => {
    const npc = createNpcRecord('Falia');
    npc.personality = 'Kind, patient, independent, and considerate.';
    npc.behaviorProfile = [
        'Disposition: Broadly kind and patient.',
        'Expressiveness: Low; feelings are shown subtly.',
        'Independence: High; keeps her own judgment.',
    ];

    const updated = profileState(npc, {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            'Disposition: Broadly kind, patient, and considerate.',
            'Independence: High; keeps her own judgment while accepting advice.',
        ],
    });

    assert.equal(updated.behaviorProfile.length, 2);
    assert.ok(updated.behaviorProfile.some(item => /Disposition:/i.test(item)));
    assert.ok(updated.behaviorProfile.some(item => /Independence:/i.test(item)));
    assert.ok(!updated.behaviorProfile.some(item => /Expressiveness:/i.test(item)));
});

test('v1.0.15 named appearance-form refine replaces only that form and preserves other forms', () => {
    const record = {
        ...createNpcRecord('Sora'),
        appearanceModelVersion: 1,
        overallAppearance: 'Thick blue-gold hair braided to her waist and bright amber eyes.',
        appearanceForms: [
            {
                name: 'Human Form',
                appearance: 'Soft youthful face, slender build, warm skin, long blue-gold braid, bright amber eyes; wears a tailored cerulean silk school dress beneath a dark wool pinafore.',
            },
            {
                name: 'Thunderbird Form',
                appearance: 'Massive avian body with layered blue-gold plumage, broad wings, hooked talons, and a proud crest.',
            },
        ],
        currentForm: 'Human Form',
        currentFormUnknown: false,
    };

    const updated = applyAppearanceUpdate(record, {
        appearanceForms: [{
            name: 'Human Form',
            state: 'refine',
            appearance: 'Soft youthful face, slender build, warm skin, long blue-gold braid, bright amber eyes; dressed in a high-collared bleached flax smock with a green and saffron silk vest over a heavy slate-grey wool skirt.',
        }],
    });

    const human = appearanceFormByName(updated, 'Human Form');
    const thunderbird = appearanceFormByName(updated, 'Thunderbird Form');
    assert.match(human.appearance, /bleached flax smock/i);
    assert.doesNotMatch(human.appearance, /cerulean silk school dress/i);
    assert.doesNotMatch(human.appearance, /dark wool pinafore/i);
    assert.match(thunderbird.appearance, /Massive avian body/i);
    const resolved = resolveNpcAppearance(updated);
    assert.match(resolved, /bleached flax smock/i);
    assert.doesNotMatch(resolved, /school dress/i);
});
