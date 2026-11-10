// A new person's missing looks are filled in to fit the story; a stated detail always replaces them. The fill is the targeted
// Refresh's own call (no extra request): a tail prompt line, and one narrow merge allowance (fillBlankAppearance) that lets the BLANK
// look fields take a fitted value without quoted evidence. Everything else keeps the evidence rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillPrompt, buildDossierImportPrompt, buildProfileRefreshPrompt, buildScannerPrompt, createNpcRecord, DURABLE_PROFILE_LIMITS, mergeScanResult, normalizeNpcRecord } from '../core.js';
import { appendedLooks, blankLookFields, describedFeatures, fillLooksLine, fillWanted, missingFeatures, partialLookGaps } from '../appearance-fill.js';

const NONE = { relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } };
const story = 'Tamsin, the ferry keeper from the salt marsh, tied the boat and asked the stranger for the toll. The tide was out.';
const person = (extra = {}) => ({ ...createNpcRecord('Tamsin'), role: 'ferry keeper', species: 'fox-eared human', ...extra });
const state = npc => ({ npcs: [npc], candidates: [], dismissed: [], socialGraph: { version: 1, edges: [], unresolved: [] }, turn: 4 });
const run = (npc, update, context, extra = {}) => mergeScanResult(state(npc), {
    npcs: [{ id: npc.id, name: 'Tamsin', ...NONE }], profileUpdates: [{ id: npc.id, ...update }], keyRelationshipEdges: [],
}, { turn: 5, sourceMessageId: 12, developmentContext: context, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, ...extra }).state.npcs[0];
const FILL = { fillBlankAppearance: true };
const FULL = 'Tall, lean woman with grey braids and blue eyes.';
const invented = { overallAppearance: 'A slim young fox-eared woman, russet hair, amber eyes, weathered hands.', appearance: 'A salt-stained oilskin coat, boots.' };

test('a new person with blank looks is filled through the Refresh merge without quoted evidence', () => {
    const saved = run(person(), invented, story, FILL);
    assert.match(saved.overallAppearance, /fox-eared.*russet hair.*amber eyes/);
    assert.match(saved.appearance, /oilskin coat/);
});

test('the fill also works when the model returns the looks on the ordinary npcs row', () => {
    const npc = person();
    const saved = mergeScanResult(state(npc), { npcs: [{ id: npc.id, name: 'Tamsin', ...invented, ...NONE }], profileUpdates: [], keyRelationshipEdges: [] },
        { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, ...FILL }).state.npcs[0];
    assert.match(saved.overallAppearance, /russet hair/);
    assert.match(saved.appearance, /oilskin coat/);
});

test('without the fill allowance the same invented looks are still refused (scanner, capture and ordinary Refresh)', () => {
    const saved = run(person(), invented, story);
    assert.equal(saved.overallAppearance || '', '');
    assert.doesNotMatch(saved.appearance || '', /oilskin|russet/);
});

test('a non-fill targeted NPC row cannot seed an unsupported current look', () => {
    const npc = person();
    const saved = mergeScanResult(state(npc), { npcs: [{ id: npc.id, name: npc.name, appearance: 'A crimson silk coat.', ...NONE }] },
        { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, requireAppearanceSeedGrounding: true }).state.npcs[0];
    assert.equal(saved.appearance, '');
    const grounded = mergeScanResult(state(npc), { npcs: [{ id: npc.id, name: npc.name, appearance: 'A crimson silk coat.', ...NONE }] },
        { turn: 5, sourceMessageId: 12, developmentContext: `${story} Tamsin wears a crimson silk coat.`, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, requireAppearanceSeedGrounding: true }).state.npcs[0];
    assert.match(grounded.appearance, /crimson silk coat/);
});

test('personality, speech and the rest keep the evidence rule even in a fill call', () => {
    const saved = run(person(), { ...invented, personality: 'Warm, patient and endlessly generous.', speech: 'Soft and lilting.', mannerisms: ['hums while she works'] }, story, FILL);
    assert.ok(saved.overallAppearance, 'the looks were filled');
    assert.equal(saved.personality || '', '');
    assert.equal(saved.speech || '', '');
    assert.deepEqual(saved.mannerisms || [], []);
});

test('a stated look is never replaced by the fill', () => {
    const stated = person({ overallAppearance: 'A broad woman with grey braids and one blue eye.', appearance: 'A patched green cloak.' });
    const saved = run(stated, invented, story, FILL);
    assert.equal(saved.overallAppearance, stated.overallAppearance);
    assert.match(saved.appearance, /patched green cloak/);
    assert.doesNotMatch(saved.appearance, /oilskin/);
});

test('a later grounded story line replaces an invented detail through the normal refine gate', () => {
    const filled = run(person(), invented, story, FILL);
    const line = 'Tamsin pushed back her hood; her hair was black and cut short, and her eyes were green as bottle glass.';
    const saved = run(filled, {
        evidence: { appearance: ['her hair was black and cut short', 'eyes were green as bottle glass'] },
        overallAppearance: 'A slim young fox-eared woman, short black hair, green eyes, weathered hands.', overallAppearanceState: 'refine',
    }, `${story} ${line}`);
    assert.match(saved.overallAppearance, /black hair/);
    assert.match(saved.overallAppearance, /green eyes/);
    assert.doesNotMatch(saved.overallAppearance, /russet|amber/);
    assert.match(saved.overallAppearance, /fox-eared/, 'what the story gave is kept');
});

test('the fill is deterministic: the same inputs make the same record (replay == live)', () => {
    const a = run(person(), invented, story, FILL), b = run(person(), invented, story, FILL);
    assert.equal(JSON.stringify({ ...a, id: 0, lastScannedAt: 0, createdAt: 0, updatedAt: 0 }), JSON.stringify({ ...b, id: 0, lastScannedAt: 0, createdAt: 0, updatedAt: 0 }));
});

test('who qualifies: blank, alive, not archived, no named forms, no appearance lock', () => {
    assert.deepEqual(blankLookFields(person()), ['overallAppearance', 'appearance']);
    assert.deepEqual(blankLookFields(person({ overallAppearance: 'Tall, dark.' })), ['appearance']);
    assert.deepEqual(blankLookFields(person({ overallAppearance: FULL, appearance: 'A coat.' })), []);
    assert.deepEqual(blankLookFields(person({ lifeState: 'deceased' })), []);
    assert.deepEqual(blankLookFields(person({ archived: true })), []);
    assert.deepEqual(blankLookFields(person({ appearanceForms: [{ name: 'Wolf', appearance: 'Grey fur.' }] })), []);
    assert.deepEqual(blankLookFields(person({ manualProfileFields: ['appearance'] })), []);
});

test('the Refresh prompt gets one tail line only on a fill call; the prefix and every other prompt are untouched', () => {
    const base = buildProfileRefreshPrompt({ transcript: story, targetNpc: person() });
    const fill = buildProfileRefreshPrompt({ transcript: story, targetNpc: person(), fillLooks: true });
    const line = fillLooksLine(person());
    assert.equal(fill.length - base.length, line.length);
    assert.equal(fill, base.replace('\nUse the exact id/name', `${line}\nUse the exact id/name`));
    assert.ok(fill.startsWith(base.slice(0, base.indexOf('Target NPC:'))), 'static rules and window come first, unchanged');
    assert.match(line, /no quoted evidence needed/);
    assert.match(line, /Never contradict or repeat anything stated/);
    assert.doesNotMatch(line, /sex|nude|breast|body shape/i);
    for (const npc of [person({ lifeState: 'deceased' }), person({ archived: true }), person({ overallAppearance: FULL, appearance: 'A coat.' })]) {
        assert.equal(buildProfileRefreshPrompt({ transcript: story, targetNpc: npc, fillLooks: true }), buildProfileRefreshPrompt({ transcript: story, targetNpc: npc }));
    }
    console.log(`fill line adds ${line.length} chars (both fields blank); one field blank: ${fillLooksLine(person({ overallAppearance: FULL })).length}`);
});

test('an 800-character stored appearance reaches the backfill, import, refresh and scanner prompts whole, and a refine keeps its tail', () => {
    const tail = 'TAILMARK';
    const text = `${'A tall woman with grey braids and ink-stained fingers. '.repeat(15)}`.slice(0, DURABLE_PROFILE_LIMITS.appearance - tail.length - 1) + ` ${tail}`;
    assert.equal(text.length, DURABLE_PROFILE_LIMITS.appearance);
    const npc = person({ overallAppearance: text, appearance: text });
    const prompts = [
        buildBackfillPrompt({ transcript: story, targetName: 'Tamsin', existingNpc: npc }),
        buildDossierImportPrompt({ dossierText: 'Name: Tamsin', targetName: 'Tamsin', existingNpc: npc }),
        buildProfileRefreshPrompt({ transcript: story, targetNpc: npc }),
    ];
    for (const prompt of prompts) assert.ok(prompt.includes(`${tail}`), 'the tail is in the prompt');
    assert.match(prompts[0], new RegExp(`appearance ${DURABLE_PROFILE_LIMITS.appearance},`), 'the cap told to the model is the stored limit');
    // A refine replaces the whole text: what the model returns whole is what is kept.
    const refined = run(person({ overallAppearance: text }), { evidence: { appearance: ['ink-stained fingers'] }, overallAppearance: `${text.slice(0, 780)} ${tail}`, overallAppearanceState: 'refine' }, `${story} Her ink-stained fingers drummed the rail.`);
    assert.ok(refined.overallAppearance.endsWith(tail) || refined.overallAppearance.includes(tail), 'the tail survives a refine');
    const scanner = buildScannerPrompt({ transcript: `[m1] ${story}`, existingNpcs: [{ ...npc, present: true }] });
    assert.ok(scanner.includes(tail), 'the scanner hint carries the whole stored appearance');
});

// ---- partial descriptions: the fill adds only the missing hair, eyes and build; the written text is kept word for word ----
const PARTIAL = 'Young human woman';
const partial = (extra = {}) => person({ overallAppearance: PARTIAL, appearance: 'A salt-stained coat.', ...extra });
const ADDED = `${PARTIAL}, long copper hair, green eyes, lean build`;

test('a partial description missing hair and eyes gets exactly those (and build) appended, the written text untouched', () => {
    assert.deepEqual(partialLookGaps(partial()), ['hair', 'eyes', 'build']);
    const saved = run(partial(), { overallAppearance: ADDED }, story, FILL);
    assert.equal(saved.overallAppearance, ADDED);
    assert.ok(saved.overallAppearance.startsWith(PARTIAL), 'byte-identical prefix');
    assert.deepEqual(partialLookGaps(saved), [], 'nothing missing afterwards, so no further fill line');
    const hairless = partial({ overallAppearance: 'Slim young woman with green eyes' });
    assert.deepEqual(partialLookGaps(hairless), ['hair']);
    assert.match(fillLooksLine(hairless), /does not yet describe this person's hair\. /);
    assert.doesNotMatch(fillLooksLine(hairless), /hair, eyes|eyes, build|blank/);
    assert.match(fillLooksLine(partial()), /followed by a short addition for hair, eyes, build only/);
    assert.match(fillLooksLine(partial()), /Add nothing already described, and never a second colour or style/);
});

test('a fully described person sends no fill line and changes nothing', () => {
    const full = person({ overallAppearance: FULL, appearance: 'A coat.' });
    assert.equal(fillWanted(full), false);
    assert.equal(fillLooksLine(full), '');
    assert.equal(buildProfileRefreshPrompt({ transcript: story, targetNpc: full, fillLooks: true }), buildProfileRefreshPrompt({ transcript: story, targetNpc: full }));
    const saved = run(full, { overallAppearance: `${FULL} Copper hair.` }, story, FILL);
    assert.equal(saved.overallAppearance, FULL, 'a pointless addition is refused');
});

test('detection is per feature and generous: a copper mane is hair, scales need no hair, gaze is eyes', () => {
    assert.deepEqual(describedFeatures('A copper mane down her back'), ['hair']);
    for (const text of ['bald and scarred', 'braided locks', 'a shaved head', 'tight curls', 'a grey ponytail', 'long tresses']) assert.ok(describedFeatures(text).includes('hair'), text);
    for (const text of ['a steady gaze', 'pale irises', 'one blue eye', 'amber-eyed']) assert.ok(describedFeatures(text).includes('eyes'), text);
    for (const text of ['stocky', 'a gaunt frame', 'broad-shouldered', 'wiry', 'curvy figure', 'heavy-set', 'tall', 'muscled', 'slender']) assert.ok(describedFeatures(text).includes('build'), text);
    assert.deepEqual(missingFeatures('Scaled lizardfolk with a gaze like glass'), ['build']);
    assert.ok(!missingFeatures('Feathered, tall harpy').includes('hair'));
    assert.ok(!missingFeatures('Chitin-plated insectoid').includes('hair'));
    assert.deepEqual(missingFeatures('Young human woman'), ['hair', 'eyes', 'build']);
    assert.deepEqual(missingFeatures(''), [], 'blank is the blank fill, not a gap');
    assert.deepEqual(partialLookGaps(person({ overallAppearance: 'Scaled, tall, one gold eye' })), []);
});

test('the existing text survives byte for byte; a rewrite or a changed word is refused and the record is unchanged', () => {
    assert.equal(appendedLooks(PARTIAL, ADDED), ADDED);
    for (const rewrite of ['A young woman, long copper hair, green eyes', 'young human woman, long copper hair, green eyes', 'Young human womankind, long copper hair']) {
        assert.equal(appendedLooks(PARTIAL, rewrite), null, rewrite);
        const saved = run(partial(), { overallAppearance: rewrite }, story, FILL);
        assert.equal(saved.overallAppearance, PARTIAL, `refused: ${rewrite}`);
    }
});

test('an addition that describes what is already written (a second hair colour) is refused', () => {
    const had = 'Young human woman with dark hair';
    assert.equal(appendedLooks(had, `${had}, bright red hair, green eyes`), null);
    assert.equal(run(partial({ overallAppearance: had }), { overallAppearance: `${had}, bright red hair, green eyes` }, story, FILL).overallAppearance, had);
    assert.equal(appendedLooks(had, `${had}, green eyes`), `${had}, green eyes`);
    assert.equal(appendedLooks('Scaled lizardfolk', 'Scaled lizardfolk, long blonde hair'), null);
});

test('a result over the 800-character limit changes nothing', () => {
    const near = `${PARTIAL} ${'x'.repeat(DURABLE_PROFILE_LIMITS.appearance - PARTIAL.length - 10)}`.trim();
    assert.equal(appendedLooks(near, `${near}, green eyes, copper hair, lean build`), null);
    const saved = run(partial({ overallAppearance: near }), { overallAppearance: `${near}, green eyes, copper hair, lean build` }, story, FILL);
    assert.equal(saved.overallAppearance, near);
    assert.equal(appendedLooks(PARTIAL, `${PARTIAL}, ${'green eyes, '.repeat(100)}`), null);
});

test('a later stated line replaces an appended detail: the refine and change paths leave no old invented eye colour', () => {
    const filled = run(partial(), { overallAppearance: `${PARTIAL}, long copper hair, amber eyes, lean build` }, story, FILL);
    assert.match(filled.overallAppearance, /amber eyes/);
    const line = 'Tamsin pushed back her hood; her eyes were green as bottle glass.';
    // The refine path: the model returns the whole text, the new clause is grounded, the old invented one never needed to be.
    const refined = run(filled, {
        evidence: { appearance: ['her eyes were green as bottle glass'] },
        overallAppearance: `${PARTIAL}, long copper hair, green eyes, lean build`, overallAppearanceState: 'refine',
    }, `${story} ${line}`);
    assert.match(refined.overallAppearance, /green eyes/);
    assert.doesNotMatch(refined.overallAppearance, /amber/);
    // The change path (preserveOmittedPhysicalTraits): the stated eyes own the trait, so the invented eyes do not come back.
    const changed = run(filled, {
        evidence: { appearance: ['her eyes were green as bottle glass'] },
        overallAppearance: 'Green eyes, as bottle glass', overallAppearanceState: 'change', overallAppearanceReason: 'her eyes were green as bottle glass',
    }, `${story} ${line}`);
    assert.doesNotMatch(changed.overallAppearance, /amber/);
});

test('personality, speech and mannerisms are still refused in a partial fill call', () => {
    const saved = run(partial(), { overallAppearance: ADDED, personality: 'Warm and endlessly generous.', speech: 'Soft and lilting.', mannerisms: ['hums'] }, story, FILL);
    assert.equal(saved.overallAppearance, ADDED);
    assert.equal(saved.personality || '', '');
    assert.equal(saved.speech || '', '');
    assert.deepEqual(saved.mannerisms || [], []);
});

test('without the allowance (scanner, capture, ordinary Refresh) an invented addition to a partial text is refused', () => {
    assert.equal(run(partial(), { overallAppearance: ADDED }, story).overallAppearance, PARTIAL);
});

test('the partial fill is excluded for dead, archived, named-form and locked records, and clothes stay blank-only', () => {
    for (const extra of [{ lifeState: 'deceased' }, { archived: true }, { appearanceForms: [{ name: 'Wolf', appearance: 'Grey fur.' }] }, { manualProfileFields: ['appearance'] }]) {
        assert.equal(fillWanted(partial(extra)), false, JSON.stringify(extra));
    }
    const saved = run(partial(), { overallAppearance: ADDED, appearance: 'A scarlet gown, silver rings.' }, story, FILL);
    assert.match(saved.appearance, /salt-stained coat/, 'a written appearance is not rewritten');
    assert.doesNotMatch(saved.appearance, /scarlet/);
});

test('the partial fill is deterministic (replay == live) and a new person with partial looks reaches the fill', () => {
    const a = run(partial(), { overallAppearance: ADDED }, story, FILL), b = run(partial(), { overallAppearance: ADDED }, story, FILL);
    const norm = x => JSON.stringify({ ...x, id: 0, lastScannedAt: 0, createdAt: 0, updatedAt: 0 });
    assert.equal(norm(a), norm(b));
    assert.equal(fillWanted(partial()), true, 'the Refresh asks for the fill on a person whose looks are only partly written');
    assert.equal(buildProfileRefreshPrompt({ transcript: story, targetNpc: partial(), fillLooks: true }).includes('FILL LOOKS: overallAppearance does not yet describe'), true);
    assert.equal(buildProfileRefreshPrompt({ transcript: story, targetNpc: partial() }).includes('FILL LOOKS'), false, 'a normal call is unchanged');
    console.log(`partial fill line adds ${fillLooksLine(partial()).length} chars (hair, eyes, build missing, appearance written)`);
});

test('an ungrounded partial fill cannot append unrelated claims, including in the same sentence', () => {
    for (const suffix of [', owns three ships', ', green eyes and a scar', ', green eyes and secretly cruel', ', green eyes; she is a spy', ', green eyes, a ruby']) {
        const update = `${PARTIAL}${suffix}`;
        assert.equal(appendedLooks(PARTIAL, update), null, suffix);
        assert.equal(run(partial(), { overallAppearance: update }, story, FILL).overallAppearance, PARTIAL, suffix);
    }
    assert.equal(run(partial(), { overallAppearance: ADDED }, story, FILL).overallAppearance, ADDED);
    const natural = `${PARTIAL}, with long auburn hair, blue eyes and a broad frame`;
    assert.equal(run(partial(), { overallAppearance: natural }, story, FILL).overallAppearance, natural);
});

test('stored physical traits in the current look cannot be contradicted by the fill', () => {
    const flat = normalizeNpcRecord(person({ appearance: 'Short black hair and a blue cloak.' }));
    const saved = run(flat, { overallAppearance: 'A slender woman with long red hair and green eyes.' }, story, FILL);
    assert.equal(saved.overallAppearance, '');
    assert.match(saved.appearance, /black hair/);
    assert.doesNotMatch(saved.appearance, /red hair/);
    const other = run(flat, { overallAppearance: 'A slender woman with long red hair and green eyes.' }, `${story} Mira revealed her long red hair and green eyes.`, FILL);
    assert.equal(other.overallAppearance, '', 'another person does not authorize a correction');
    const split = normalizeNpcRecord(person({ overallAppearance: PARTIAL, appearance: 'Short black hair; a blue cloak.' }));
    assert.ok(!partialLookGaps(split).includes('hair'));
    assert.equal(run(split, { overallAppearance: `${PARTIAL}, long red hair and green eyes` }, story, FILL).overallAppearance, PARTIAL);
});

test('a resolved physical projection does not hide a blank outfit', () => {
    const npc = normalizeNpcRecord(person({ overallAppearance: FULL }));
    assert.equal(npc.appearance, FULL);
    assert.deepEqual(blankLookFields(npc), ['appearance']);
    const saved = run(npc, { appearance: 'A patched green cloak.' }, story, FILL);
    assert.equal(saved.overallAppearance, FULL);
    assert.match(saved.appearance, /patched green cloak/);
    const conflicting = run(npc, { appearance: 'Long red hair; a green cloak.' }, story, FILL);
    assert.equal(conflicting.appearance, FULL, 'a blank outfit cannot invent a conflicting body');
    const npcRow = mergeScanResult(state(npc), { npcs: [{ id: npc.id, name: npc.name, appearance: 'A patched green cloak.', ...NONE }] },
        { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, ...FILL }).state.npcs[0];
    assert.match(npcRow.appearance, /patched green cloak/);
});

test('both fill prompts supply the exact partial physical text separately from its resolved outfit', () => {
    const npc = normalizeNpcRecord(person({ overallAppearance: PARTIAL, appearance: 'A salt-stained coat.' }));
    const expected = `Existing overallAppearance: ${JSON.stringify(PARTIAL)}.`;
    for (const prompt of [buildBackfillPrompt({ transcript: story, targetName: npc.name, existingNpc: npc, fillLooks: true }),
        buildProfileRefreshPrompt({ transcript: story, targetNpc: npc, fillLooks: true })]) {
        assert.ok(prompt.includes(expected));
        assert.ok(prompt.includes('salt-stained coat'));
    }
    assert.ok(!buildBackfillPrompt({ transcript: story, targetName: npc.name, existingNpc: npc }).includes(expected));
});

test('a partial body too long to accept any addition does not request one', () => {
    const npc = person({ overallAppearance: 'Young human woman ' + 'x'.repeat(785), appearance: 'A coat.' });
    assert.deepEqual(partialLookGaps(npc), []);
    assert.doesNotMatch(fillLooksLine(npc), /Existing overallAppearance/);
});

test('an ungrounded blank fill is looks-only: a deed, secret or object clause is refused or the whole fill is dropped', () => {
    for (const bad of ['A slim woman with green eyes; she secretly murdered the ferryman.', 'Young human woman, green eyes with a ruby', 'A slim woman with green eyes, trusted by the duke.']) {
        const saved = run(person(), { overallAppearance: bad, appearance: 'A grey tunic and she stole the toll.' }, story, FILL);
        assert.equal(saved.overallAppearance || '', '', bad);
        assert.doesNotMatch(saved.appearance || '', /stole/, bad);
        assert.doesNotMatch(JSON.stringify(saved), /murdered|ruby|trusted/, bad);
    }
    const ok = run(person(), invented, story, FILL);
    assert.match(ok.overallAppearance, /russet hair/);
});

test('an ungrounded partial addition is looks-only, and a clause ending in a non-look word is refused', () => {
    assert.equal(appendedLooks('Young human woman', 'Young human woman, green eyes with a ruby'), null);
    assert.equal(appendedLooks('Young human woman', 'Young human woman, green eyes and she killed a guard'), null);
    assert.equal(appendedLooks('Young human woman', 'Young human woman, green eyes'), 'Young human woman, green eyes');
});

test('a claim in a fill that the story itself supports is still accepted, so evidence keeps its route', () => {
    const grounded = 'A slim woman with green eyes who limps.';
    const saved = run(person(), { overallAppearance: grounded }, `${story} Tamsin is a slim woman with green eyes who limps.`, FILL);
    assert.equal(saved.overallAppearance, grounded);
});

test('a non-fill targeted call keeps its old first-appearance rule; only the fill call demands support', () => {
    const npc = person();
    const row = { npcs: [{ id: npc.id, name: npc.name, appearance: 'A crimson silk coat.', ...NONE }] };
    const base = { turn: 5, sourceMessageId: 12, developmentContext: story, skipRelationshipUpdate: true, allowTargetedDurableSeed: true };
    assert.match(mergeScanResult(state(npc), row, base).state.npcs[0].appearance, /crimson/);
    assert.equal(mergeScanResult(state(npc), row, { ...base, ...FILL, requireAppearanceSeedGrounding: true }).state.npcs[0].appearance, '');
});
