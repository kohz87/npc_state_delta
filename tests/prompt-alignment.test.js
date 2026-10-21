import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DURABLE_PROFILE_LIMITS,
    PROMPT_CAPS,
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildNarrationCaptureParts,
    buildProfileRefreshPrompt,
    buildRelationshipPassPrompt,
    buildScannerPrompt,
    normalizeNpcRecord,
    normalizeScanNpc,
    returnShape,
    setActiveCalendarConfig,
} from '../core.js';
import { RETURN_KEYS, RETURN_SHAPES } from '../src/fields/registry.js';

// Cleanup steps 12-13 (user-approved prompt changes): context caps at the stored limits, the one-pass
// rules' fixed Stage 4 / birthday rules and role words, *State keys in backfill and import, and the
// targeted return shapes written from the registry.

const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const rich = () => normalizeNpcRecord({
    id: 'npc_myla', name: 'Myla Venn', present: true,
    personality: 'Careful, patient, dry-humoured, loyal to the guild, wary of nobles, generous to children.',
    speech: 'Soft, formal, with river-quarter idioms.',
    mannerisms: ['Taps her quill twice before she writes anything down in the ledger.'],
    keyRelationships: ['Captain Renn — old rival from the duel | a grudging respect that grew after the flood of the lower docks.'],
    memories: ['Saved the miller and his two daughters from the spring flood of the lower river quarter.'],
    relationshipSummary: 'Cautious respect growing into trust after the archive fire.',
});
const transcript = 'USER: I ask what to sign.\nASSISTANT: Myla Venn sets down the ledger.';

test('step 12 I-7: what the scanner shows of a stored field is all of it, up to the stored limit', () => {
    const npc = rich();
    npc.personality = `${'a'.repeat(DURABLE_PROFILE_LIMITS.personality - 1)}.`;
    const prompt = buildScannerPrompt({ transcript, existingNpcs: [npc], userName: 'Ari', charName: 'Narrator' });
    assert.ok(prompt.includes(npc.personality), 'a personality at the stored cap is shown whole');
    for (const value of [npc.speech, npc.mannerisms[0], npc.keyRelationships[0], npc.memories[0]]) assert.ok(prompt.includes(value), value);
});

test('step 12 I-7: a value longer than the cap (a locked field) is cut at a word boundary, never mid-word', () => {
    const npc = rich();
    npc.personality = words(120);
    npc.manualProfileFields = ['personality'];
    const prompt = buildScannerPrompt({ transcript, existingNpcs: [npc], userName: 'Ari', charName: 'Narrator' });
    const shown = JSON.parse(prompt.slice(prompt.indexOf('Stable profile context'), prompt.length).split('\n')[1])[0].personality;
    assert.ok(shown.length <= DURABLE_PROFILE_LIMITS.personality);
    assert.ok(npc.personality.startsWith(shown) && npc.personality[shown.length] === ' ', `cut at a space: …${shown.slice(-12)}`);
});

test('step 12 I-7: backfill, import and Refresh show bonds, mannerisms and memories at the stored limits', () => {
    // A bond as stored (the social module compacts it), longer than the 180 the prompts used to show.
    const npc = normalizeNpcRecord({ ...rich(), keyRelationships: [`Captain Renn — old rival from the harbour duel and the long winter siege | ${words(34)}`] });
    const bond = npc.keyRelationships[0];
    assert.ok(bond.length > 180, `stored bond ${bond.length}`);
    const prompts = {
        backfill: buildBackfillPrompt({ transcript, targetName: 'Myla Venn', existingNpc: npc }),
        import: buildDossierImportPrompt({ dossierText: 'Name: Myla', targetName: 'Myla Venn', existingNpc: npc }),
        refresh: buildProfileRefreshPrompt({ transcript, targetNpc: npc }),
    };
    for (const [label, prompt] of Object.entries(prompts)) {
        assert.ok(prompt.includes(JSON.stringify(bond)), `${label} shows the whole bond`);
        assert.ok(prompt.includes(JSON.stringify(npc.mannerisms[0])), `${label} shows the whole mannerism`);
        assert.ok(prompt.includes(`caps: ${PROMPT_CAPS}`), `${label} states the stored caps`);
    }
    assert.ok(prompts.backfill.includes(JSON.stringify(npc.memories[0])), 'backfill shows the whole memory');
    assert.match(PROMPT_CAPS, new RegExp(`personality ${DURABLE_PROFILE_LIMITS.personality}, speech ${DURABLE_PROFILE_LIMITS.speech},.*mannerisms 4x${DURABLE_PROFILE_LIMITS.mannerism}, keyRelationships 5x${DURABLE_PROFILE_LIMITS.keyRelationship}, memory ${DURABLE_PROFILE_LIMITS.memory}`));
});

test('step 12 I-7: the relationship evaluator gets the whole stored summary it is told to copy', () => {
    const npc = rich();
    npc.relationshipSummary = `${words(40)}.`.slice(0, DURABLE_PROFILE_LIMITS.relationshipSummary);
    assert.ok(npc.relationshipSummary.length > 220);
    const prompt = buildRelationshipPassPrompt({ transcript, targets: [npc], userName: 'Ari' });
    assert.ok(prompt.includes(JSON.stringify(npc.relationshipSummary)), 'not cut to 220 characters');
});

test('step 12 I-10: the one-pass rules always carry the Stage 4 and birthday rules, whatever the text before the reply', () => {
    for (const compactCapture of [false, true]) {
        const plain = buildNarrationCaptureParts({ transcript, existingNpcs: [rich()], compactCapture }).rules;
        const eventful = buildNarrationCaptureParts({ transcript: `${transcript} It is her birthday; the dragon dies and she transforms.`, existingNpcs: [rich()], compactCapture }).rules;
        assert.equal(plain, eventful, 'the rules do not key on the text before the reply');
        assert.match(plain, /\nSTAGE 4: named forms=>appearanceForms/);
        assert.match(plain, /Explicit death \(deceased\+explicit\) is terminal: never alive\/present\/worldActive again\./);
        assert.match(plain, /\nBIRTHDAY: grounded evidence only: birthDate:"MM-DD\|YYYY-MM-DD"\+birthDateState:"establish\|correct"\+birthDateReason/);
        assert.doesNotMatch(plain, /S4: forms\/current/);
    }
    // The ordinary scanner, built after the reply, keeps its conditional rules.
    const scanner = buildScannerPrompt({ transcript, existingNpcs: [rich()] });
    assert.match(scanner, /S4: forms\/current; confirmed death terminal\./);
    assert.doesNotMatch(scanner, /STAGE 4 DEATH|BIRTHDAY:/);
});

test('step 12 I-10: with a calendar the birthday rule keeps the era in the rules and the date in the context', () => {
    setActiveCalendarConfig({ era: 'CR', months: [{ name: 'Redleaf', days: 30 }], currentYear: 821, currentMonth: 'Redleaf', currentDay: 3 });
    try {
        const parts = buildNarrationCaptureParts({ transcript, existingNpcs: [rich()] });
        assert.match(parts.rules, /birthDate:\{"era":"CR","year":number\|null,"month":"month name","day":number\}/);
        assert.doesNotMatch(parts.rules, /Current grounded world date/);
        assert.match(parts.context, /Current grounded world date=/);
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('b5b r2-8: the one-pass rules name roles; the people are named in the context part', () => {
    for (const compactCapture of [false, true]) {
        const solo = buildNarrationCaptureParts({ transcript, existingNpcs: [rich()], userName: 'Ari', charName: 'Elke', compactCapture });
        const next = buildNarrationCaptureParts({ transcript, existingNpcs: [rich()], userName: 'Ari', charName: 'Brecht', compactCapture });
        assert.equal(solo.rules, next.rules);
        assert.ok(!solo.rules.includes('Ari') && !solo.rules.includes('Elke'));
        assert.match(solo.context, /\nNot NPCs: the player is Ari; the character you play is Elke\.\n/);
        assert.match(next.context, /the character you play is Brecht\./);
    }
});

test('step 12 I-12: backfill and import shapes carry the scan\'s *State keys for values a dossier already has', () => {
    const backfill = buildBackfillPrompt({ transcript, targetName: 'Myla Venn', existingNpc: rich() });
    const imported = buildDossierImportPrompt({ dossierText: 'Name: Myla', targetName: 'Myla Venn', existingNpc: rich() });
    for (const key of ['ageState:keep|advance|correct', 'apparentAgeState:keep|evolve', 'personalityState:refine|evolve', 'speechState:refine|evolve',
        'appearanceState:refine|change', 'mannerismState:refine|evolve', 'behaviorProfileState:refine|evolve', 'keyRelationshipsState:keep|update|evolve',
        'backgroundState:keep|update', 'homeBaseState:keep|update', 'genderState:keep|correct']) {
        assert.ok(backfill.includes(key), `backfill ${key}`);
        assert.ok(imported.includes(key), `import ${key}`);
    }
    for (const key of ['moodState:keep|clear', 'locationState:keep|clear', 'goalState:keep|clear', 'statusState:keep|clear']) assert.ok(backfill.includes(key), `backfill ${key}`);
    assert.match(backfill, /12\. A value the dossier already has changes only by its \*State, as in the scan/);
});

test('step 12 I-13: the dossier import names the configured custom fields', () => {
    const plain = buildDossierImportPrompt({ dossierText: 'Name: Myla\nLevel: 3', targetName: 'Myla Venn', existingNpc: rich() });
    const custom = buildDossierImportPrompt({ dossierText: 'Name: Myla\nLevel: 3', targetName: 'Myla Venn', existingNpc: rich(), customFieldNames: ['Level', 'Class'] });
    assert.doesNotMatch(plain, /CUSTOM FIELDS/);
    assert.match(custom, /CUSTOM FIELDS \(Level, Class\): in an NPC row, "customFields":\{"Level":"value","Class":"value"\} only when the dossier text states that NPC's value explicitly\./);
});

test('step 13: every state key a return shape asks for is one normalizeScanNpc reads, with the same words', () => {
    const shapes = Object.values(RETURN_SHAPES).flatMap(shape => [...shape.npcs, ...(shape.profileUpdates || [])]);
    for (const name of new Set(shapes)) {
        assert.ok(RETURN_KEYS[name], `${name} has a registry entry`);
        const spec = RETURN_KEYS[name];
        if (!spec.states) continue;
        const key = spec.key || name;
        const stateKey = spec.stateKey || `${key}State`;
        for (const word of spec.states.split('|').filter(item => item !== 'keep')) {
            const row = normalizeScanNpc({ name: 'Myla Venn', [key]: name === 'gender' ? 'female' : 'x', [stateKey]: word, [`${key}Reason`]: 'r' });
            assert.equal(row[stateKey], word, `${stateKey}:${word}`);
        }
    }
});

test('step 13: the targeted shapes are written from the registry and leave out what code owns', () => {
    const refresh = returnShape('refresh', { id: '"<target id>"', name: '"<target name>"' });
    assert.ok(refresh.startsWith('Return shape (write it as JSON;'));
    assert.match(refresh, /"npcs":\[\{id:"<target id>",name:"<target name>",aliases:\[\],/);
    assert.match(refresh, /"profileUpdates":\[\{id:"<target id>",evidence:\{field:\[short quotes\]\},/);
    assert.match(refresh, /,"keyRelationshipEdges":\[\]\}$/);
    for (const kind of ['refresh', 'backfill', 'import']) {
        assert.doesNotMatch(returnShape(kind), /relationshipDelta|relationshipImpact/, `${kind}: every targeted pass zeroes the relationship numbers`);
    }
    assert.doesNotMatch(refresh, /present|worldActive/, 'Refresh ignores presence');
    assert.match(returnShape('backfill'), /present:true\|false,worldActive:true\|false/);
    assert.ok(buildProfileRefreshPrompt({ transcript, targetNpc: rich() }).includes(refresh));
});
