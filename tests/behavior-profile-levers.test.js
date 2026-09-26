import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildInjection,
    buildProfileRefreshPrompt,
    buildScannerPrompt,
    createNpcRecord,
    normalizeNpcRecord,
} from '../core.js';

test('behavior profile soft aliases consolidate into stable lever families', () => {
    const npc = normalizeNpcRecord({
        name: 'Marris',
        behaviorProfile: [
            'Warmth: Practical and understated.',
            'Care: Helps through action before reassurance.',
            'Anxiety: High under uncertainty; checks assumptions before acting.',
            'Threat Sensitivity: Cautious around ambiguous danger.',
            'Reasoning: Evidence-first; compares observations before deciding.',
            'Analytical Style: Tests competing explanations before accepting one.',
            'Formality: Deliberately polished in official settings.',
            'Social Presentation: Regulates casual habits to maintain professional poise.',
            'Assertiveness: Calm and firm under opposition.',
            'Conflict: De-escalates first, then sets a clear boundary.',
        ],
    });

    assert.deepEqual(
        npc.behaviorProfile.map(entry => entry.split(':', 1)[0]),
        ['Care', 'Threat Sensitivity', 'Analytical Style', 'Social Presentation', 'Conflict'],
    );
    assert.match(npc.behaviorProfile[0], /Practical and understated/i);
    assert.match(npc.behaviorProfile[0], /action before reassurance/i);
    assert.match(npc.behaviorProfile[1], /uncertainty/i);
    assert.match(npc.behaviorProfile[2], /Evidence-first/i);
    assert.match(npc.behaviorProfile[3], /professional poise/i);
    assert.match(npc.behaviorProfile[4], /clear boundary/i);
});

test('scanner and reconciliation prompts define behaviorProfile as behavioral levers rather than action history', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Reserved, kind, observant, and increasingly self-possessed.';
    npc.behaviorProfile = ['Care: Practical; helps through action before reassurance.'];

    const scanner = buildScannerPrompt({
        transcript: 'Marris checks the wound, compares two possible causes, then calmly explains the safer treatment.',
        existingNpcs: [npc],
    });
    assert.match(scanner, /behaviorProfile FULL max6 "Label: level - effect" levers, not routines\/duties\/habits \(habits=>mannerisms\)/);

    const refresh = buildProfileRefreshPrompt({
        transcript: 'Over several months Marris consistently checks evidence before committing to a conclusion.',
        targetNpc: npc,
    });
    const LEVER = /behaviorProfile=max6 "Label: level - effect" levers: how they generally respond\/decide \(supported labels only[^)]*\)\. Actions are evidence; routines, duties, house rules and habits are not levers \(habits=>mannerisms\)\./;
    assert.match(refresh, LEVER);

    const backfill = buildBackfillPrompt({
        transcript: 'Marris repeatedly favors practical help over verbal reassurance.',
        targetName: 'Marris',
        existingNpc: npc,
    });
    assert.match(backfill, LEVER);

    const imported = buildDossierImportPrompt({
        dossierText: 'Marris is evidence-driven, professionally formal, and practical when caring for others.',
        targetName: 'Marris',
        existingNpc: npc,
    });
    assert.match(imported, LEVER);
    assert.match(imported, /supported labels only/i);
});

test('roleplay injection tells the model to generalize behavioral profile levers to new situations', () => {
    const npc = createNpcRecord('Marris');
    npc.present = true;
    npc.personality = 'Reserved and analytical.';
    npc.behaviorProfile = [
        'Analytical Style: Evidence-first; compares observations before deciding.',
        'Care: Practical; solves immediate problems before reassuring.',
    ];

    const injection = buildInjection([npc], 'Marris examines an unfamiliar mechanism.', 4, 1);
    assert.match(injection, /behavioral profile translates it into target-general response\/decision levers/i);
    assert.match(injection, /behavioral profile:/i);
    assert.match(injection, /Analytical Style:/i);
});
