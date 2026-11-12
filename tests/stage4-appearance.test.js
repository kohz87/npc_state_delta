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
import { appearanceFormsHtml, dossierDetailProjection } from '../dossier-ui.js';

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

test('Stage 4 flat appearance remains a scalar current presentation without old-format Base migration', () => {
    const npc = normalizeNpcRecord({ id: 'npc_ryu', name: 'Ryu', appearance: 'Long silver hair, grey eyes, spruce-green wool dress.' });
    assert.equal(npc.currentForm, '');
    assert.deepEqual(npc.appearanceForms, []);
    assert.equal(resolveNpcAppearance(npc), npc.appearance);
});


test('Stage 4 scalar-only current Appearance is rendered as the current dossier presentation', () => {
    const text = 'Slender jawline, hazel eyes, pale skin, and thick neck-length waves of burnished bronze hair; developed figure with narrow waist; fitted charcoal-gray wool smock, heavy wool hose, and bull-hide mountain boots.';
    const npc = normalizeNpcRecord({
        ...createNpcRecord('Cerys'),
        appearanceModelVersion: 1,
        appearance: text,
        appearanceForms: [],
        currentForm: '',
        currentFormUnknown: false,
    });
    const projected = dossierDetailProjection(npc);
    const html = appearanceFormsHtml(projected);

    assert.equal(npc.currentForm, '');
    assert.equal(npc.currentFormUnknown, false);
    assert.equal(npc.appearanceForms.length, 0);
    assert.match(projected.appearanceModel.appearance, /burnished bronze hair/i);
    assert.match(projected.appearance, /charcoal-gray wool smock/i);
    assert.match(html, /Current presentation/i);
    assert.match(html, /bull-hide mountain boots/i);
    assert.doesNotMatch(html, /No named forms established/i);
});

test('Stage 4 flat scanner Appearance on a form-less record is visible without changing form identity', () => {
    const base = normalizeNpcRecord({
        ...createNpcRecord('Cerys'),
        appearanceModelVersion: 1,
        appearance: '',
        appearanceForms: [],
        currentForm: '',
        currentFormUnknown: false,
    });
    const narration = 'Her hair was not dark at all; thick waves of burnished bronze framed her neck. A fitted charcoal-gray wool smock showed a narrow waist, and she wore heavy hose with greased bull-hide mountain boots.';
    const currentAppearance = 'Thick waves of burnished bronze hair; developed figure with narrow waist; fitted charcoal-gray wool smock, heavy wool hose, and greased bull-hide mountain boots.';
    const result = mergeScanResult({ npcs: [base], turn: 1 }, {
        profileUpdates: [{
            id: base.id,
            evidence: { appearance: [narration] },
            appearance: currentAppearance,
            appearanceState: 'change',
            appearanceReason: 'Her cleaned appearance and fitted travel clothing are explicitly revealed.',
        }],
    }, { turn: 2, sourceMessageId: 118, developmentContext: narration });

    const npc = result.state.npcs[0];
    const projected = dossierDetailProjection(npc);
    const html = appearanceFormsHtml(projected);
    assert.equal(npc.currentForm, '');
    assert.equal(npc.currentFormUnknown, false);
    assert.equal(npc.appearanceForms.length, 0);
    assert.match(npc.appearance, /burnished bronze hair/i);
    assert.match(projected.appearance, /charcoal-gray wool smock/i);
    assert.match(html, /Current presentation/i);
    assert.match(html, /bull-hide mountain boots/i);
});

test('Stage 4 dossier fallback does not suppress species identity in portrait prompts', () => {
    const npc = normalizeNpcRecord({
        ...createNpcRecord('Yunyun'),
        species: 'Crimson Demon',
        apparentAge: '~23',
        appearanceModelVersion: 1,
        appearance: 'Young woman with long dark brown hair, crimson eyes, a slim build, and a black-and-red adventurer outfit.',
        appearanceForms: [],
        currentForm: '',
        currentFormUnknown: false,
    });
    const portrait = buildNpcPortraitPrompts(npc).positive;
    assert.match(portrait, /Crimson Demon/i);
    assert.match(portrait, /crimson eyes/i);
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
    // Since 1.0.99 an unknown form of an NPC with named forms is described completely: the shared
    // features (the pendant) are not added, and no other form's anatomy is borrowed.
    assert.equal((resolveNpcAppearance(twice).match(/Small silver pendant/gi) || []).length, 0);
    assert.doesNotMatch(resolveNpcAppearance(twice), /ordinary human ears|hooked beak/i);
});

test('Stage 4 unidentified current form never borrows previous or scalar-only anatomy', () => {
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

    const scalarOnly = normalizeNpcRecord({ ...createNpcRecord('Riven'), appearanceModelVersion: 1, appearance: 'Human face, brown hair, ordinary human ears.' });
    const unknown = mergeScanResult({ npcs: [scalarOnly], turn: 4 }, { npcs: [{ id: scalarOnly.id, name: scalarOnly.name, currentFormState: 'unknown', present: true }] }, { turn: 4 }).state.npcs[0];
    assert.equal(resolveNpcAppearance(unknown), '');
    assert.deepEqual(unknown.appearanceForms, []);
});

test('Stage 4 selecting a named form without a description never falls back to prior scalar anatomy', () => {
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
    const base = normalizeNpcRecord({ ...formNpc('Astra'), manualProfileFields: ['appearance'] });
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
    assert.match(injection, /APPEARANCE \(authoritative; species cannot override the form\)/i);
    assert.equal((injection.match(/ordinary human ears/gi) || []).length, 1, 'resolved current appearance should be injected once, not duplicated after the budgeted dossier');
});

test('Stage 4 form-only switch diagnostics report the applied resolved presentation', () => {
    const base = formNpc('Mira');
    const result = mergeScanResult({ npcs: [base], turn: 8 }, {
        profileUpdates: [{
            id: base.id,
            currentForm: 'Stormcrown',
            currentFormState: 'select',
        }],
    }, {
        turn: 8,
        sourceMessageId: 808,
        developmentContext: 'Mira changes from her Human form into her established Stormcrown form.',
    });
    const current = result.state.npcs[0];
    assert.equal(current.currentForm, 'Stormcrown');
    assert.match(resolveNpcAppearance(current), /storm-blue plumage/i);
    const diagnostic = result.report.profileDevelopment.find(row => row.field === 'appearance');
    assert.equal(diagnostic?.outcome, 'applied-form-update');
    assert.equal(diagnostic?.structuredAppearancePresent, true);
    assert.match(diagnostic?.candidate || '', /storm-blue plumage/i);
});

test('Stage 4 accepts a grounded current-presentation change without a development-scale gate', () => {
    const base = normalizeNpcRecord({
        ...createNpcRecord('Mara'),
        appearance: 'Dark hair hidden under frozen muck; loose sheepskin rags and worn boots.',
    });
    const narration = 'Her hair, freed from the crust of frozen muck and dried with a rough towel, was not dark at all; it fell in thick, blunt waves of burnished bronze around her slender neck, catching copper highlights from the glowing coals. The new wool smock drew taut across a surprisingly developed chest, accentuating a narrow waist and flare of hip. The greased bull-hide boots gave her posture a firm, grounded stance.';
    const currentAppearance = 'Thick blunt waves of burnished bronze hair with copper highlights around a slender neck; surprisingly developed chest, narrow waist and flared hips; new wool smock and greased bull-hide boots.';
    const result = mergeScanResult({ npcs: [base], turn: 9 }, {
        npcs: [{
            id: base.id,
            name: base.name,
            appearance: currentAppearance,
            appearanceState: 'change',
            appearanceReason: 'Her cleaned hair is revealed as burnished bronze and she is now wearing a new wool smock with greased bull-hide boots.',
            present: true,
        }],
        profileUpdates: [{
            id: base.id,
            evidence: { appearance: [narration] },
            appearance: currentAppearance,
            appearanceState: 'change',
            appearanceReason: 'Her cleaned hair is revealed as burnished bronze and she is now wearing a new wool smock with greased bull-hide boots.',
        }],
    }, { turn: 9, sourceMessageId: 900, developmentContext: narration });

    const npc = result.state.npcs[0];
    assert.match(resolveNpcAppearance(npc), /burnished bronze/i);
    assert.match(resolveNpcAppearance(npc), /wool smock/i);
    assert.match(resolveNpcAppearance(npc), /bull-hide boots/i);
    assert.doesNotMatch(resolveNpcAppearance(npc), /dark hair|sheepskin rags/i);
});

test('Stage 4 accepts explicit appearance corrections that replace a misleading earlier impression', () => {
    const base = normalizeNpcRecord({
        ...createNpcRecord('Mara'),
        appearance: 'Dark hair, slender build, weather-stained face.',
    });
    const narration = 'Once the frozen muck was washed away, her hair was not dark at all; thick blunt waves of burnished bronze framed her slender neck.';
    const result = mergeScanResult({ npcs: [base], turn: 10 }, {
        profileUpdates: [{
            id: base.id,
            evidence: { appearance: [narration] },
            appearanceState: 'refine',
            appearance: 'Thick blunt waves of burnished bronze hair frame her slender neck; weather-stained face.',
        }],
    }, { turn: 10, sourceMessageId: 901, developmentContext: narration });

    const npc = result.state.npcs[0];
    assert.match(resolveNpcAppearance(npc), /burnished bronze/i);
    assert.doesNotMatch(resolveNpcAppearance(npc), /dark hair/i);
});

test('scanner prompt treats current outfit and explicit visual corrections as Appearance evidence', () => {
    const prompt = buildScannerPrompt({
        transcript: 'Mara washes clean; her hair was not dark at all. She changes into a wool smock and bull-hide boots.',
        currentTranscript: 'Mara washes clean; her hair was not dark at all. She changes into a wool smock and bull-hide boots.',
        existingNpcs: [normalizeNpcRecord({ ...createNpcRecord('Mara'), appearance: 'Dark hair beneath frozen muck; sheepskin rags.' })],
        userName: 'Lucien',
        charName: 'Narrator',
    });
    assert.match(prompt, /appearance=clothes and their state/i);
    assert.match(prompt, /overallAppearance \(no named forms\)=readable: kind, apparent age, build, hair, eyes, then unmistakable marks/i);
    assert.match(prompt, /clothes and their state/i);
    assert.match(prompt, /Correction\/reveal/i);
    assert.doesNotMatch(prompt, /Ignore transient visual state/i);
});

test('rejectedOverallLook: a refused durable look is reported, an accepted or unchanged one is not', async () => {
    const { rejectedOverallLook } = await import('../appearance-update.js');
    const held = 'White hair, yellow-green eyes.';
    assert.deepEqual(rejectedOverallLook(held, held, { overallAppearance: 'Black hair, brown eyes.' }), { incoming: 'Black hair, brown eyes.' });
    assert.deepEqual(rejectedOverallLook(held, held, { overall_appearance: 'Black hair.' }), { incoming: 'Black hair.' });
    assert.equal(rejectedOverallLook(held, 'Black hair, brown eyes.', { overallAppearance: 'Black hair, brown eyes.' }), null, 'accepted');
    assert.equal(rejectedOverallLook(held, held, { overallAppearance: 'white hair, yellow-green eyes' }), null, 'same look');
    assert.equal(rejectedOverallLook('', '', { overallAppearance: 'Black hair.' }), null, 'no lock yet');
    assert.equal(rejectedOverallLook(held, held, { appearance: 'A red coat.' }), null, 'not a durable look');
    assert.equal(rejectedOverallLook(held, held, null), null);
});

// (card traits win) A pack card's physical traits stay unless a story EVENT changes them (a grounded `change`); a refine adds detail.
const TEMIWA_CARD = 'Dogfolk woman, about 160 cm. Black dog ears with cream points, the left one notched. A curled black tail with a cream underside. Long straight black hair that falls like a waterfall. An exceptionally full, curvy figure, especially her chest. Fingertips scarred from flame rites. Brown eyes ringed dark from too little sleep. She smells of lye and smoke.';
const TEMIWA_REFINE = `${TEMIWA_CARD.replace('Brown eyes', 'Pale eyes')} A grey wool mantle hangs from her shoulders.`;
const TEMIWA_STORY = 'Sister Temiwa looked up, her pale eyes ringed dark from too little sleep. A grey wool mantle hangs from her shoulders as she sweeps the salt yard.';
function temiwa(extra = {}) {
    return normalizeNpcRecord({
        id: 'npc_sister-temiwa', name: 'Sister Temiwa', present: true, role: 'Church novice', overallAppearance: TEMIWA_CARD,
        castFrom: { key: 'ersveil:temiwa', pack: 'ersveil', id: 'temiwa', first: { overallAppearance: TEMIWA_CARD } }, ...extra,
    });
}
function scanTemiwa(npc, update, context = TEMIWA_STORY, channel = 'profileUpdates') {
    const reply = channel === 'npcs'
        ? { npcs: [{ id: npc.id, name: npc.name, ...update }] }
        : { npcs: [{ id: npc.id, name: npc.name }], profileUpdates: [{ id: npc.id, name: npc.name, ...update }] };
    return mergeScanResult({ npcs: [npc], candidates: [], turn: 3 }, reply, { turn: 4, sourceMessageId: 5, developmentContext: context }).state.npcs[0];
}

test('physicalTraitSwaps: a swapped value is named; a shade, a synonym, a fill or an omission is not a swap', async () => {
    const { physicalTraitSwaps, physicalTraitSwapped } = await import('../appearance-physical.js');
    assert.deepEqual(physicalTraitSwaps(TEMIWA_CARD, TEMIWA_REFINE), [{ trait: 'eyes', said: 'pale', kept: 'brown' }]);
    assert.deepEqual(physicalTraitSwaps('Long black hair', 'Short black hair'), [{ trait: 'hair', said: 'short', kept: 'long' }]);
    assert.deepEqual(physicalTraitSwaps('Slender build, blue eyes', 'Stocky build, green eyes'), [{ trait: 'eyes', said: 'green', kept: 'blue' }, { trait: 'build', said: 'stocky', kept: 'slender' }]);
    assert.equal(physicalTraitSwapped('Brown eyes', 'Dark brown eyes'), false, 'a shade of the same colour');
    assert.equal(physicalTraitSwapped('Dark eyes', 'Brown eyes'), false, 'a tone that fits the hue');
    assert.equal(physicalTraitSwapped('Grey eyes', 'Silver eyes'), false, 'a synonym');
    assert.equal(physicalTraitSwapped('Tall and slender', 'Tall and slender, violet eyes'), false, 'a trait the record does not name is a fill');
    assert.equal(physicalTraitSwapped('Long silver hair', 'Silver hair'), false, 'an omission is not a swap');
    assert.equal(physicalTraitSwapped('Brown eyes', 'Brown eyes, a pale scarf'), false, 'clothing is not a trait');
});

test('card traits win: Temiwa\'s card keeps its brown eyes when a Refresh refine says pale; the mantle is added and the drift names the swap', async () => {
    const { rejectedOverallLook } = await import('../appearance-update.js');
    const { lookDrift } = await import('../src/npc-notes-look.js');
    const before = temiwa();
    const after = scanTemiwa(before, { overallAppearance: TEMIWA_REFINE, overallAppearanceState: 'refine' });
    assert.match(after.overallAppearance, /Brown eyes ringed dark from too little sleep/);
    assert.doesNotMatch(after.overallAppearance, /Pale eyes/);
    assert.match(after.overallAppearance, /grey wool mantle/);
    const rejected = rejectedOverallLook(before.overallAppearance, after.overallAppearance, { overallAppearance: TEMIWA_REFINE });
    assert.deepEqual(rejected?.swaps, [{ trait: 'eyes', said: 'pale', kept: 'brown' }]);
    assert.equal(lookDrift(before.overallAppearance, { ...rejected, name: 'Sister Temiwa' }), 'Look drift refused: the story called Sister Temiwa\'s eyes pale; the record keeps brown.');
    // Replay == live: the same inputs make the same record.
    assert.deepEqual(scanTemiwa(temiwa(), { overallAppearance: TEMIWA_REFINE, overallAppearanceState: 'refine' }).overallAppearance, after.overallAppearance);
});

test('card traits win: a refine that only swaps a card trait is refused whole and reported the old way', async () => {
    const { rejectedOverallLook } = await import('../appearance-update.js');
    const swapOnly = TEMIWA_CARD.replace('Brown eyes', 'Pale eyes');
    const after = scanTemiwa(temiwa(), { overallAppearance: swapOnly, overallAppearanceState: 'refine' });
    assert.equal(after.overallAppearance, TEMIWA_CARD);
    assert.deepEqual(rejectedOverallLook(TEMIWA_CARD, after.overallAppearance, { overallAppearance: swapOnly }), { incoming: swapOnly });
});

test('card traits win: a grounded change event may change a card trait', () => {
    const story = 'The curse struck Sister Temiwa at the altar: her brown eyes turned pale as milk and stayed that way.';
    const changed = scanTemiwa(temiwa(), {
        overallAppearance: TEMIWA_CARD.replace('Brown eyes', 'Pale eyes'), overallAppearanceState: 'change', overallAppearanceReason: 'The curse turned her brown eyes pale as milk.',
    }, `${story} Sister Temiwa's pale eyes were ringed dark from too little sleep.`);
    assert.match(changed.overallAppearance, /Pale eyes/);
    assert.doesNotMatch(changed.overallAppearance, /Brown eyes/);
    const ungrounded = scanTemiwa(temiwa(), {
        overallAppearance: TEMIWA_CARD.replace('Brown eyes', 'Pale eyes'), overallAppearanceState: 'change', overallAppearanceReason: 'Corrected eye color.',
    });
    assert.match(ungrounded.overallAppearance, /Brown eyes/, 'a change without a story event keeps the card');
});

test('card traits win: the flat appearance and a named form keep a card trait; a look that is not the card\'s is protected too', async () => {
    const { applyAppearanceUpdate } = await import('../appearance-update.js');
    const habit = 'Brown eyes ringed dark from too little sleep, a grey Church habit';
    const flat = temiwa({ overallAppearance: '', appearance: habit });
    const story = 'Sister Temiwa, her pale eyes ringed dark from too little sleep, pulled a grey wool mantle over her grey Church habit.';
    const offered = { appearance: 'Pale eyes ringed dark from too little sleep, a grey Church habit, a grey wool mantle', appearanceState: 'refine' };
    const kept = scanTemiwa(flat, offered, story, 'npcs');
    assert.match(kept.appearance, /Brown eyes/);
    assert.match(kept.appearance, /wool mantle/);
    assert.match(scanTemiwa(flat, offered, story).appearance, /Brown eyes/, 'the profileUpdates[] channel applies the same rule');
    const formed = applyAppearanceUpdate({ ...temiwa(), appearanceForms: [{ name: 'Rite', appearance: habit }] },
        { appearanceForms: [{ name: 'Rite', appearance: offered.appearance, state: 'refine' }] }, { context: story });
    assert.match(formed.appearanceForms[0].appearance, /Brown eyes/);
    // Not a cast dossier: an established story-given value is protected the same way (only a fill guess is replaceable, see below).
    const plain = scanTemiwa(temiwa({ castFrom: undefined }), { overallAppearance: TEMIWA_REFINE, overallAppearanceState: 'refine' });
    assert.match(plain.overallAppearance, /Brown eyes/);
    assert.doesNotMatch(plain.overallAppearance, /Pale eyes/);
});

// ---- (card traits win, round 2) items 1, 2, 3, 5 ----
const STORY_PALE = 'Sister Temiwa looked up, her pale eyes ringed dark from too little sleep. A grey wool mantle hangs from her shoulders.';
test('item 1: an established trait is protected whatever its source; a fill guess alone is replaceable; a missing trait fills; a grounded change swaps', async () => {
    const { applyAppearanceUpdate } = await import('../appearance-update.js');
    const nonCard = { castFrom: undefined };
    const refine = { overallAppearance: TEMIWA_REFINE, overallAppearanceState: 'refine' };
    for (const channel of ['npcs', 'profileUpdates']) {
        assert.match(scanTemiwa(temiwa(nonCard), refine, STORY_PALE, channel).overallAppearance, /Brown eyes/, `${channel}: overall, not the card's`);
    }
    const flat = temiwa({ ...nonCard, overallAppearance: '', appearance: 'Brown eyes ringed dark from too little sleep, a grey Church habit' });
    const offered = { appearance: 'Pale eyes ringed dark from too little sleep, a grey Church habit, a grey wool mantle', appearanceState: 'refine' };
    for (const channel of ['npcs', 'profileUpdates']) assert.match(scanTemiwa(flat, offered, STORY_PALE, channel).appearance, /Brown eyes/, `${channel}: flat/current`);
    const form = applyAppearanceUpdate({ ...temiwa(nonCard), appearanceForms: [{ name: 'Rite', appearance: 'Brown eyes, a grey habit' }] },
        { appearanceForms: [{ name: 'Rite', appearance: 'Pale eyes, a grey habit, a wool mantle', state: 'refine' }] }, { context: STORY_PALE });
    assert.match(form.appearanceForms[0].appearance, /Brown eyes/, 'named form');
    // A trait the record does not name is a fill, not a swap.
    const sparse = temiwa({ ...nonCard, overallAppearance: 'Dogfolk woman, about 160 cm.' });
    assert.match(scanTemiwa(sparse, { overallAppearance: 'Dogfolk woman, about 160 cm. Brown eyes ringed dark from too little sleep.', overallAppearanceState: 'refine' },
        'Sister Temiwa, brown eyes ringed dark from too little sleep, swept the yard.').overallAppearance, /Brown eyes/);
    // A grounded change event swaps an established trait in a non-card record too.
    const event = 'A curse struck Sister Temiwa and her eyes turned pale as milk.';
    const changed = scanTemiwa(temiwa(nonCard), { overallAppearance: TEMIWA_CARD.replace('Brown eyes', 'Pale eyes'), overallAppearanceState: 'change', overallAppearanceReason: 'A curse turned her eyes pale as milk.' }, event);
    assert.match(changed.overallAppearance, /Pale eyes/);
    // Provenance: the fill call's guess (record.lookGuess) is the one replaceable value, and a story-given value is then protected.
    const guess = applyAppearanceUpdate(createNpcRecord('Tamsin', []), { overallAppearance: 'Slim young woman, amber eyes' }, { fillBlank: true });
    assert.ok(guess.lookGuess.includes('eyes'), 'the fill marks its guess');
    const stated = scanTemiwa(normalizeNpcRecord({ ...guess, id: 'npc_t', name: 'Tamsin', present: true }),
        { overallAppearance: 'Slim young woman, green eyes', overallAppearanceState: 'refine' }, 'Tamsin pushed back her hood; her eyes were green as bottle glass.');
    assert.match(stated.overallAppearance, /green eyes/, 'a story line replaces a guess');
    assert.ok(!(stated.lookGuess || []).includes('eyes'), 'and the trait is now established');
    const again = scanTemiwa(stated, { overallAppearance: 'Slim young woman, grey eyes', overallAppearanceState: 'refine' }, 'Tamsin blinked; her eyes looked grey in the dusk.');
    assert.match(again.overallAppearance, /green eyes/, 'a second swap is refused');
    assert.deepEqual(scanTemiwa(temiwa(nonCard), refine, STORY_PALE).lookGuess ?? [], [], 'a record with no marker has no guesses');
});

test('item 2: distinct hues, multicolour parts, marks and facial features are told apart; shades and fills are not swaps', async () => {
    const { physicalTraitSwaps: swaps } = await import('../appearance-physical.js');
    const traits = (a, b) => swaps(a, b).map(item => item.trait);
    assert.deepEqual(traits('White hair', 'Grey hair'), ['hair']);
    assert.deepEqual(traits('Long black and red hair', 'Long black and blonde hair'), ['hair'], 'one shared colour does not hide a changed one');
    assert.deepEqual(traits('Black hair with red streaks', 'Black hair with blue streaks'), ['hair'], 'changed streaks');
    assert.deepEqual(traits('A scar over her left cheek', 'A scar over her right cheek'), ['scar'], 'marks');
    assert.deepEqual(traits('A broad jaw', 'A narrow jaw'), ['face'], 'facial features');
    assert.deepEqual(traits('A tattoo on her left arm', 'A tattoo on her right arm'), ['tattoo']);
    assert.deepEqual(traits('Brown eyes', 'Dark brown eyes'), [], 'a shade');
    assert.deepEqual(traits('Black hair', 'Black hair with red streaks'), [], 'an added streak keeps the held colour');
    assert.deepEqual(traits('Tall build', 'Tall build, violet eyes'), [], 'a true fill');
    assert.deepEqual(traits('A jaw scar', 'A scar'), [], 'an omission');
});

test('item 3: a shared clause keeps its unrelated details; the stored overall text and the additive detail go through the real merge', () => {
    const held = 'Brown eyes, long black hair, a grey habit';
    const record = temiwa({ castFrom: undefined, overallAppearance: held });
    const story = 'Sister Temiwa, her pale eyes and long black hair framed by a grey habit, folded a grey wool mantle.';
    for (const offered of ['Pale eyes and long black hair, a grey habit, a grey wool mantle', 'Pale eyes with long black hair, a grey habit, a grey wool mantle']) {
        for (const channel of ['npcs', 'profileUpdates']) {
            const out = scanTemiwa(record, { overallAppearance: offered, overallAppearanceState: 'refine' }, story, channel).overallAppearance;
            assert.match(out, /Brown eyes/, `${channel}: the held eyes stay (${offered.slice(0, 18)})`);
            assert.match(out, /long black hair/, `${channel}: the hair is not lost`);
            assert.doesNotMatch(out, /Pale/);
        }
    }
    const mantle = scanTemiwa(record, { overallAppearance: 'Brown eyes, long black hair and a grey wool mantle, a grey habit', overallAppearanceState: 'refine' }, story).overallAppearance;
    assert.match(mantle, /long black hair/);
});

test('item 5: a bare description is not a change event; the reason and the event must be this person\'s own', () => {
    const swap = TEMIWA_CARD.replace('Brown eyes', 'Pale eyes');
    const change = reason => ({ overallAppearance: swap, overallAppearanceState: 'change', overallAppearanceReason: reason });
    assert.match(scanTemiwa(temiwa(), change('Her eyes are pale.'), STORY_PALE).overallAppearance, /Brown eyes/, 'her pale eyes is a description, not an event');
    assert.match(scanTemiwa(temiwa(), change('A curse turned her eyes pale.'), STORY_PALE).overallAppearance, /Brown eyes/, 'an invented reason');
    const other = 'A curse struck Brother Anselm and his eyes turned pale as milk. Sister Temiwa watched, her pale eyes wide.';
    assert.match(scanTemiwa(temiwa(), change('A curse turned her eyes pale as milk.'), other).overallAppearance, /Brown eyes/, 'another person\'s event');
    assert.match(scanTemiwa(temiwa(), change('A curse turned her eyes pale as milk.'), '').overallAppearance, /Brown eyes/, 'empty context');
    const real = 'A curse struck Sister Temiwa and her eyes turned pale as milk.';
    for (const channel of ['npcs', 'profileUpdates']) {
        assert.match(scanTemiwa(temiwa(), change('A curse turned her eyes pale as milk.'), real, channel).overallAppearance, /Pale eyes/, `${channel}: a real event`);
    }
    // Roles: another person's title does not authorise a promotion; the person's own event does, with no unrequested keys.
    const role = (context, fields = { role: 'Lay Sealer' }) => scanTemiwa(temiwa(), fields, context).role;
    assert.equal(role('The abbess named Brother Anselm Lay Sealer of the chapel.'), 'Church novice', 'another person\'s title');
    assert.equal(role(''), 'Church novice', 'empty context');
    assert.equal(role('Sister Temiwa polished the Lay Sealer\'s seal, wishing to be a Lay Sealer one day.'), 'Church novice', 'a wish is not an event');
    assert.equal(role('The abbess named Sister Temiwa Lay Sealer of the chapel.'), 'Lay Sealer', 'a bare role with the event in the story');
    assert.equal(role('The abbess named Sister Temiwa Lay Sealer of the chapel.', { role: 'Lay Sealer', roleState: 'update', roleReason: 'Invented reason words.' }), 'Church novice', 'an explicit reason must be the story\'s event');
});

test('item 7: the same reply row on the same prior record gives the same record live and on a rebuild; an unmarked non-conflicting refine is unchanged', () => {
    // The scanner's reply is not persisted per reply (core contract: blocks are held in memory only, a rebuild re-asks), so there is no
    // recorded old output to keep: what holds is that both paths run the one deterministic merge on the same inputs.
    const row = { overallAppearance: TEMIWA_REFINE, overallAppearanceState: 'refine' };
    const live = scanTemiwa(temiwa(), row, STORY_PALE);
    const rebuilt = scanTemiwa(temiwa(), row, STORY_PALE);
    assert.deepEqual([live.overallAppearance, live.appearance, live.role, live.lookGuess], [rebuilt.overallAppearance, rebuilt.appearance, rebuilt.role, rebuilt.lookGuess]);
    const additive = scanTemiwa(temiwa(), { overallAppearance: `${TEMIWA_CARD} A grey wool mantle hangs from her shoulders.`, overallAppearanceState: 'refine' }, STORY_PALE);
    assert.match(additive.overallAppearance, /wool mantle/);
    assert.equal('lookGuess' in additive, false, 'a record that never had a fill guess gains no new field');
});
