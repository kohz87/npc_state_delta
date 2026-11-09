// A new person's missing looks are filled in to fit the story; a stated detail always replaces them. The fill is the targeted
// Refresh's own call (no extra request): a tail prompt line, and one narrow merge allowance (fillBlankAppearance) that lets the BLANK
// look fields take a fitted value without quoted evidence. Everything else keeps the evidence rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillPrompt, buildDossierImportPrompt, buildProfileRefreshPrompt, buildScannerPrompt, createNpcRecord, DURABLE_PROFILE_LIMITS, mergeScanResult } from '../core.js';
import { blankLookFields, fillLooksLine } from '../appearance-fill.js';

const NONE = { relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } };
const story = 'Tamsin, the ferry keeper from the salt marsh, tied the boat and asked the stranger for the toll. The tide was out.';
const person = (extra = {}) => ({ ...createNpcRecord('Tamsin'), role: 'ferry keeper', species: 'fox-eared human', ...extra });
const state = npc => ({ npcs: [npc], candidates: [], dismissed: [], socialGraph: { version: 1, edges: [], unresolved: [] }, turn: 4 });
const run = (npc, update, context, extra = {}) => mergeScanResult(state(npc), {
    npcs: [{ id: npc.id, name: 'Tamsin', ...NONE }], profileUpdates: [{ id: npc.id, ...update }], keyRelationshipEdges: [],
}, { turn: 5, sourceMessageId: 12, developmentContext: context, skipRelationshipUpdate: true, allowTargetedDurableSeed: true, ...extra }).state.npcs[0];
const FILL = { fillBlankAppearance: true };
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
    assert.deepEqual(blankLookFields(person({ overallAppearance: 'Tall.', appearance: 'A coat.' })), []);
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
    for (const npc of [person({ lifeState: 'deceased' }), person({ archived: true }), person({ overallAppearance: 'Tall.', appearance: 'A coat.' })]) {
        assert.equal(buildProfileRefreshPrompt({ transcript: story, targetNpc: npc, fillLooks: true }), buildProfileRefreshPrompt({ transcript: story, targetNpc: npc }));
    }
    console.log(`fill line adds ${line.length} chars (both fields blank); one field blank: ${fillLooksLine(person({ overallAppearance: 'Tall.' })).length}`);
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
