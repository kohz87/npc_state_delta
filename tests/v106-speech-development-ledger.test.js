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
