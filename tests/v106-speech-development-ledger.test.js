import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createNpcRecord,
    mergeScanResult,
    normalizeNpcRecord,
} from '../core.js';
import { decodeNpcStateBundle, encodeNpcStateBundle } from '../bundle.js';

function gradualSpeechUpdate(npc, evidence, speech = 'Confident and direct; speaks in concise sentences without habitual hedging.') {
    return {
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { speech: [evidence] },
            speechState: 'evolve',
            speech,
            speechReason: 'Her direct delivery has become a recurring speech habit.',
            developmentScale: 'gradual',
            developmentReason: 'Repeated later scenes show the same speech habit.',
        }],
    };
}

function scan(state, payload, turn, sourceMessageId, developmentContext = 'She answers directly and without hedging.') {
    return mergeScanResult(state, payload, { turn, sourceMessageId, developmentContext });
}

test('v1.0.6 gradual speech evolution counts independent same-concept observations and ignores replay of one source message', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft, hesitant, and prone to trailing off when challenged.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const evidence = 'directness: answers plainly and without hedging';

    state = scan(state, gradualSpeechUpdate(npc, evidence), 10, 100).state;
    assert.equal(state.npcs[0].speech, npc.speech);
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 1);

    state = scan(state, gradualSpeechUpdate(npc, evidence), 11, 100).state;
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 1, 'replaying the same source message must not count twice');
    assert.equal(state.npcs[0].speech, npc.speech);

    state = scan(state, gradualSpeechUpdate(npc, evidence), 12, 101).state;
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 2);
    assert.equal(state.npcs[0].speech, npc.speech);

    state = scan(state, gradualSpeechUpdate(npc, evidence), 14, 102).state;
    assert.match(state.npcs[0].speech, /Confident and direct/i);
    assert.deepEqual(state.npcs[0].speechDevelopment.concepts, [], 'accepted replacement starts a fresh speech epoch');
    assert.equal(state.npcs[0].speechDevelopment.epoch, 1);
    assert.deepEqual(state.npcs[0].profileEvidence.speech, []);
});

test('v1.0.6 unrelated speech concepts do not combine to unlock gradual evolution', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and formal.';
    let state = { npcs: [npc], candidates: [], turn: 9 };

    state = scan(state, gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'), 10, 100).state;
    state = scan(state, gradualSpeechUpdate(npc, 'formality: uses fewer titles with close companions'), 12, 101).state;
    state = scan(state, gradualSpeechUpdate(npc, 'directness: gives concise answers without hedging'), 15, 102).state;

    assert.equal(state.npcs[0].speech, 'Soft and formal.');
    const directness = state.npcs[0].speechDevelopment.concepts.find(item => item.concept === 'directness');
    const formality = state.npcs[0].speechDevelopment.concepts.find(item => item.concept === 'formality');
    assert.equal(directness?.observationCount, 2);
    assert.equal(formality?.observationCount, 1);
});

test('v1.0.6 grounded batch speech evolution overwrites the old baseline and resets pending gradual evidence', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft, hesitant, and formal.';
    let state = { npcs: [npc], candidates: [], turn: 9 };

    state = scan(state, gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'), 10, 100).state;
    state = scan(state, gradualSpeechUpdate(npc, 'directness: again gives a direct answer without hedging'), 12, 101).state;
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 2);

    const batch = {
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            speechState: 'evolve',
            speech: 'Crisp and authoritative; gives short, decisive instructions while retaining habitual politeness.',
            speechReason: 'Over three years she became a practiced commander and stopped hedging.',
            developmentScale: 'batch',
            developmentReason: 'Over three years she gradually became a practiced commander, consistently speaking directly without hedging.',
        }],
    };
    state = scan(
        state,
        batch,
        20,
        120,
        'Three years passed. During that time, she gradually became a practiced commander, consistently speaking directly without hedging while retaining her habitual politeness.',
    ).state;

    assert.match(state.npcs[0].speech, /Crisp and authoritative/i);
    assert.deepEqual(state.npcs[0].speechDevelopment.concepts, []);
    assert.equal(state.npcs[0].speechDevelopment.epoch, 1);
    assert.equal(state.npcs[0].speechDevelopment.baselineTurn, 20);
    assert.equal(state.npcs[0].speechDevelopment.baselineSourceMessageId, 120);
});

test('v1.0.6 a time skip without grounded speech development preserves the pending slate', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and formal.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    state = scan(state, gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'), 10, 100).state;
    const before = structuredClone(state.npcs[0].speechDevelopment);

    state = scan(state, { npcs: [], profileUpdates: [] }, 40, 140, 'Three years passed. Marris returned to the city.').state;

    assert.equal(state.npcs[0].speech, 'Soft and formal.');
    assert.deepEqual(state.npcs[0].speechDevelopment, before);
});

test('v1.0.6 manual speech baseline replacement clears stale pending concepts before later scans', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and formal.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    state = scan(state, gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'), 10, 100).state;
    assert.equal(state.npcs[0].speechDevelopment.concepts.length, 1);

    state.npcs[0].speech = 'Playful and conversational, with dry teasing and relaxed contractions.';
    state = scan(state, { npcs: [], profileUpdates: [] }, 11, 101).state;

    assert.equal(state.npcs[0].speechDevelopment.epoch, 1);
    assert.deepEqual(state.npcs[0].speechDevelopment.concepts, []);
    assert.match(state.npcs[0].speechDevelopment.baselineSpeech, /Playful and conversational/i);
});

test('v1.0.6 manual speech lock still blocks evolution and does not accumulate hidden speech observations', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and formal.';
    npc.manualProfileFields = ['speech'];
    npc.manualProfileLocksExplicit = true;
    const result = scan(
        { npcs: [npc], candidates: [], turn: 9 },
        gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'),
        10,
        100,
    );

    assert.equal(result.state.npcs[0].speech, 'Soft and formal.');
    assert.equal(result.state.npcs[0].speechDevelopment, undefined);
});

test('v1.0.6 speech development ledger survives normalization and native bundle round-trip', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and formal.';
    const result = scan(
        { npcs: [npc], candidates: [], turn: 9 },
        gradualSpeechUpdate(npc, 'directness: answers plainly without hedging'),
        10,
        100,
    );
    const normalized = normalizeNpcRecord(result.state.npcs[0]);
    assert.equal(normalized.speechDevelopment.concepts[0].observationCount, 1);

    const bytes = encodeNpcStateBundle({ npcs: [normalized], socialGraph: { version: 1, edges: [], unresolved: [] }, dismissed: [] }, { appVersion: '1.0.6' });
    const decoded = decodeNpcStateBundle(bytes);
    assert.deepEqual(decoded.state.npcs[0].speechDevelopment, normalized.speechDevelopment);
});

test('v1.0.19 unlabeled Speech evidence accumulates across independent scans and can promote a grounded refine candidate', () => {
    const npc = createNpcRecord('Ryu');
    npc.speech = 'Developing verbal speech, carefully testing words with measured syllables; communicates non-verbally through territorial hisses, wails, and affectionate gestures.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const stale = npc.speech;
    const payload = (evidence, speech = stale) => ({
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { speech: [evidence] },
            speechState: 'refine',
            speech,
            speechReason: '',
            developmentScale: 'gradual',
            developmentReason: 'Repeated later scenes show the same speech habit.',
        }],
    });

    state = scan(state, payload('Speaks in clear, measured, matter-of-fact statements about practical details.'), 10, 100).state;
    assert.equal(state.npcs[0].speech, stale);
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 1);

    state = scan(state, payload('Again speaks in clear, measured, matter-of-fact statements while explaining practical equipment details.'), 12, 101).state;
    assert.equal(state.npcs[0].speech, stale);
    assert.equal(state.npcs[0].speechDevelopment.concepts.length, 1);
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 2);

    const result = scan(
        state,
        payload(
            'Uses clear, measured, matter-of-fact statements when reporting technical and practical details.',
            'Clear, measured, and matter-of-fact; gives concise practical or technical statements.',
        ),
        14,
        102,
    );
    assert.equal(result.state.npcs[0].speech, 'Clear, measured, and matter-of-fact; gives concise practical or technical statements.');
    assert.equal(result.state.npcs[0].speechDevelopment.epoch, 1);
    assert.deepEqual(result.state.npcs[0].speechDevelopment.concepts, []);
    assert.equal(result.report.profileDevelopment.at(-1)?.outcome, 'applied');
});

test('v1.0.19 semantically equivalent Speech labels share one deterministic concept bucket', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft, hesitant, and prone to trailing off when challenged.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const payload = (evidence, speech = npc.speech) => ({
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { speech: [evidence] },
            speechState: 'refine',
            speech,
            developmentScale: 'gradual',
        }],
    });

    state = scan(state, payload('directness: answers plainly and directly without hedging'), 10, 100).state;
    state = scan(state, payload('direct speech: answers plainly and directly without hedging when challenged'), 12, 101).state;
    assert.equal(state.npcs[0].speechDevelopment.concepts.length, 1);
    assert.equal(state.npcs[0].speechDevelopment.concepts[0].observationCount, 2);

    const result = scan(
        state,
        payload('assertiveness: answers plainly and directly without hedging during planning', 'Direct and concise; answers plainly without habitual hedging.'),
        14,
        102,
    );
    assert.equal(result.state.npcs[0].speech, 'Direct and concise; answers plainly without habitual hedging.');
});

test('v1.0.19 one Refresh can count distinct tagged messages for gradual Personality development', () => {
    const npc = createNpcRecord('Marris');
    npc.personality = 'Quiet and reserved, avoiding public attention.';
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 40 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { personality: [
                    '[m10] confidence: speaks before the group and states her own view without prompting',
                    '[m12] confidence: speaks before the group again and defends her own view calmly',
                    '[m14] confidence: takes the floor before the group and states her view during debate',
                ] },
                personalityState: 'refine',
                personality: 'Reserved with strangers, but speaks before groups and states her own views when needed.',
                personalityReason: '',
                developmentScale: 'gradual',
            }],
        },
        {
            turn: 40,
            sourceMessageId: 20,
            developmentSourceMessageIds: [10, 11, 12, 13, 14],
            developmentContext: '[m10] Marris speaks before the group.\n[m12] Marris defends her view.\n[m14] Marris takes the floor again.',
        },
    );

    assert.equal(result.state.npcs[0].personality, 'Reserved with strangers, but speaks before groups and states her own views when needed.');
    assert.equal(result.state.npcs[0].personalityDevelopment.epoch, 1);
    assert.deepEqual(result.state.npcs[0].personalityDevelopment.concepts, []);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'personality');
    assert.equal(diagnostic?.outcome, 'applied');
    assert.equal(diagnostic?.ready, true);
});

test('v1.0.19 a ready Speech ledger reports waiting-for-candidate when Refresh copies the stale summary', () => {
    const npc = createNpcRecord('Ryu');
    npc.speech = 'Developing verbal speech, carefully testing words with measured syllables; communicates non-verbally through territorial hisses, wails, and affectionate gestures.';
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 40 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { speech: [
                    '[m20] directness: speaks in clear, measured, matter-of-fact statements about practical details',
                    '[m22] directness: again speaks in clear, measured, matter-of-fact statements about equipment',
                    '[m24] directness: uses clear, measured, matter-of-fact statements while reporting technical details',
                ] },
                speechState: 'refine',
                speech: npc.speech,
                speechReason: '',
                developmentScale: 'gradual',
            }],
        },
        {
            turn: 40,
            sourceMessageId: 30,
            developmentSourceMessageIds: [20, 21, 22, 23, 24],
            developmentContext: '[m20] Ryu speaks clearly.\n[m22] Ryu speaks clearly again.\n[m24] Ryu reports technical details clearly.',
        },
    );

    assert.equal(result.state.npcs[0].speech, npc.speech);
    assert.equal(result.state.npcs[0].speechDevelopment.concepts[0].observationCount, 3);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'waiting-for-candidate');
    assert.equal(diagnostic?.ready, true);
});

test('v1.0.19 Refresh source tags count only when they belong to the supplied window', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Soft and hesitant.';
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 40 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: { speech: [
                    '[m100] directness: answers plainly without hedging',
                    '[m102] directness: again answers plainly without hedging',
                    '[m104] directness: answers plainly without hedging in public',
                ] },
                speechState: 'refine',
                speech: 'Direct and concise; answers plainly without habitual hedging.',
                developmentScale: 'gradual',
            }],
        },
        {
            turn: 40,
            sourceMessageId: 30,
            developmentSourceMessageIds: [20, 21, 22],
            developmentContext: '[m20] Actual supplied story line.\n[m21] Actual supplied story line.\n[m22] Actual supplied story line.',
        },
    );

    assert.equal(result.state.npcs[0].speech, npc.speech);
    assert.equal(result.state.npcs[0].speechDevelopment.concepts[0].observationCount, 1);
    const diagnostic = result.report.profileDevelopment.find(item => item.field === 'speech');
    assert.equal(diagnostic?.outcome, 'waiting-for-evidence');
    assert.equal(diagnostic?.ready, false);
});
