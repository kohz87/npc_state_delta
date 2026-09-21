import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildInjection,
    createNpcRecord,
    mergeScanResult,
} from '../core.js';

function speechUpdate(npc, evidence, speech, {
    state = 'evolve',
    scale = 'gradual',
    reason = 'Repeated scenes establish the changed speech pattern.',
    developmentReason = 'Repeated scenes establish the changed speech pattern.',
} = {}) {
    return {
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { speech: [evidence] },
            speechState: state,
            speech,
            speechReason: reason,
            developmentScale: scale,
            developmentReason,
        }],
    };
}

function scan(state, payload, turn, sourceMessageId, {
    developmentContext = 'Marris speaks in the observed way.',
    userDevelopmentContext = '',
} = {}) {
    return mergeScanResult(state, payload, {
        turn,
        sourceMessageId,
        developmentContext,
        userDevelopmentContext,
    });
}

test('additive Speech can converge from two independent candidate-supporting observations despite wording drift', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Formal and restrained.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const candidate = 'Formal and restrained; answers with concise conclusion-first explanations.';

    let result = scan(state, speechUpdate(
        npc,
        'explanation style: gives concise explanations with the conclusion first',
        candidate,
    ), 10, 100);
    state = result.state;
    assert.equal(state.npcs[0].speech, 'Formal and restrained.');

    result = scan(state, speechUpdate(
        npc,
        'delivery: again leads with the conclusion before a concise explanation',
        candidate,
    ), 12, 102);
    state = result.state;
    assert.equal(state.npcs[0].speech, candidate);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'applied-speech-candidate');
    assert.equal(diagnostic?.readinessPath, 'speech-candidate-support');
    assert.equal(diagnostic?.changeClass, 'additive');
    assert.equal(diagnostic?.requiredObservations, 2);
});

test('two unrelated Speech observations cannot cross-authorize one candidate', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Formal and restrained.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const candidate = 'Formal and restrained; answers with concise conclusion-first explanations.';

    state = scan(state, speechUpdate(
        npc,
        'directness: gives a concise conclusion before explaining',
        candidate,
    ), 10, 100).state;
    const result = scan(state, speechUpdate(
        npc,
        'formality: uses fewer honorific titles with close companions',
        candidate,
    ), 12, 102);

    assert.equal(result.state.npcs[0].speech, 'Formal and restrained.');
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'waiting-for-evidence');
    assert.equal(diagnostic?.requiredObservations, 2);
});

test('major Speech replacement remains three-observation development', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant, often trailing off.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const candidate = 'Crisp and authoritative; gives short decisive instructions.';

    for (const [turn, sourceMessageId, evidence] of [
        [10, 100, 'command voice: gives short decisive instructions with crisp authority'],
        [12, 102, 'delivery: speaks crisply and gives decisive instructions without hesitation'],
    ]) {
        state = scan(state, speechUpdate(npc, evidence, candidate), turn, sourceMessageId).state;
    }
    assert.equal(state.npcs[0].speech, 'Soft and hesitant, often trailing off.');

    const result = scan(state, speechUpdate(
        npc,
        'command register: again gives crisp authoritative and decisive instructions',
        candidate,
    ), 14, 104);
    assert.equal(result.state.npcs[0].speech, candidate);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.requiredObservations, 3);
});

test('declarative user-authored lasting Speech canon applies immediately', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant.';
    const candidate = 'Concise and direct; answers plainly without habitual hedging.';
    const context = '[m50] Lucien: Marris has become concise and direct, and now answers plainly without habitual hedging.';
    const result = scan(
        { npcs: [npc], candidates: [], turn: 20 },
        speechUpdate(
            npc,
            'directness: answers plainly without habitual hedging',
            candidate,
            {
                scale: 'explicit',
                reason: 'Marris has become concise and direct and answers plainly without habitual hedging.',
                developmentReason: 'Marris has become concise and direct and answers plainly without habitual hedging.',
            },
        ),
        21,
        51,
        { developmentContext: context, userDevelopmentContext: context },
    );

    assert.equal(result.state.npcs[0].speech, candidate);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'applied-explicit');
    assert.equal(diagnostic?.authority, 'user-explicit');
    assert.equal(diagnostic?.requiredObservations, 1);
});

test('assistant-declared explicit change is evidence, not one-turn authority', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant.';
    const candidate = 'Concise and direct; answers plainly without habitual hedging.';
    const assistantContext = 'Narrator: Marris has become concise and direct, and now answers plainly without habitual hedging.';
    const result = scan(
        { npcs: [npc], candidates: [], turn: 20 },
        speechUpdate(
            npc,
            'directness: answers plainly without habitual hedging',
            candidate,
            {
                scale: 'explicit',
                reason: 'Marris has become concise and direct and answers plainly without habitual hedging.',
                developmentReason: 'Marris has become concise and direct and answers plainly without habitual hedging.',
            },
        ),
        21,
        51,
        { developmentContext: assistantContext, userDevelopmentContext: '' },
    );

    assert.equal(result.state.npcs[0].speech, 'Soft and hesitant.');
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.authority, 'model-observed');
    assert.equal(diagnostic?.outcome, 'waiting-for-evidence');
});

test('user question containing change language does not gain explicit authority', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant.';
    const candidate = 'Concise and direct; answers plainly without habitual hedging.';
    const userContext = '[m50] Lucien: Has Marris become concise and direct and stopped hedging?';
    const result = scan(
        { npcs: [npc], candidates: [], turn: 20 },
        speechUpdate(
            npc,
            'directness: answers plainly without habitual hedging',
            candidate,
            {
                scale: 'explicit',
                reason: 'Marris has become concise and direct and stopped hedging.',
                developmentReason: 'Marris has become concise and direct and stopped hedging.',
            },
        ),
        21,
        51,
        { developmentContext: userContext, userDevelopmentContext: userContext },
    );

    assert.equal(result.state.npcs[0].speech, 'Soft and hesitant.');
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.notEqual(diagnostic?.outcome, 'applied-explicit');
});

test('Personality does not adopt a true replacement after only two ordinary observations', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Quiet and deferential, avoiding leadership decisions.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const candidate = 'Confident and decisive under pressure, independently taking responsibility for command decisions.';
    const payload = evidence => ({
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { personality: [evidence] },
            personalityState: 'evolve',
            personality: candidate,
            personalityReason: 'Repeated scenes show durable confidence and independent command decisions.',
            developmentScale: 'gradual',
            developmentReason: 'Repeated scenes show durable confidence and independent command decisions.',
        }],
    });

    state = scan(state, payload('confidence: takes command decisions independently under pressure'), 10, 100).state;
    const result = scan(state, payload('leadership: again takes responsibility and decides independently under pressure'), 12, 102);
    assert.equal(result.state.npcs[0].personality, 'Quiet and deferential, avoiding leadership decisions.');
});

test('roleplay injection gives established Speech explicit voice-fidelity priority', () => {
    const npc = createNpcRecord('Ryu');
    npc.present = true;
    npc.personality = 'Composed and analytical.';
    npc.speech = 'Conclusion first; short precise sentences; little social padding.';
    const injection = buildInjection([npc], 'Ryu answers the question.', 1, 3);
    assert.match(injection, /VOICE FIDELITY/i);
    assert.match(injection, /VOICE \(dialogue wording\/delivery\):/i);
    assert.match(injection, /Conclusion first/i);
});
