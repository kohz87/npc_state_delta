import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeNpcRecord } from '../core.js';
import {
    RELATIONSHIP_RESPONSE_LENGTH,
} from '../src/scanner-request.js';
import {
    applyFocusedRelationshipDecisions,
    currentExchangeRelationshipRelevant,
    hasCompletePrimaryRelationshipDecision,
    runFocusedRelationshipPass,
    suppressPrimaryRelationshipForFocusedDecisions,
} from '../src/relationship-pass.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { createHost } from './vendor/story-block/testkit/index.js';
import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

// Cleanup step 10: the focused relationship pass moved from index.js to src/relationship-pass.js unchanged.

const scope = { route: { profileId: '' }, isCurrent: () => true };
const transcript = 'Ari: I give Mira the warm bread.\nMira: Mira smiles and thanks Ari warmly for the bread.';
const mira = () => normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', present: true, relationship: { trust: 10, affection: 10, desire: 0, tension: 0 } });
const settings = { relationshipCriteria: '', relationshipImpactCriteria: '', relationshipCaps: undefined };
const decisionReply = JSON.stringify({ npcs: [{
    id: 'npc_mira', name: 'Mira', relationshipImpact: 'ordinary',
    relationshipDelta: { trust: 0, affection: 1, desire: 0, tension: 0 },
    relationshipEvidence: { trust: '', affection: 'Mira smiles and thanks Ari warmly for the bread.', desire: '', tension: '' },
    relationshipChangeReason: 'Ari gave her warm bread and she thanked him.',
}] });

test('who needs a decision: named in the current exchange, and not already decided by the primary row', () => {
    assert.equal(currentExchangeRelationshipRelevant(mira(), transcript), true);
    assert.equal(currentExchangeRelationshipRelevant(mira(), 'Ari: The road is quiet.', null, { currentExchangeOnly: true }), false);
    assert.equal(hasCompletePrimaryRelationshipDecision({ relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, relationshipImpact: 'none' }), true);
    assert.equal(hasCompletePrimaryRelationshipDecision({ relationshipDelta: { trust: 0, affection: 1, desire: 0, tension: 0 }, relationshipImpact: 'none' }), false);
});

test('the evaluator is asked once for the target and its decision is applied with the reply number', async () => {
    const calls = [];
    const ctx = { name1: 'Ari', generateRaw: async options => { calls.push(options); return decisionReply; } };
    const pass = await runFocusedRelationshipPass(ctx, { npcs: [] }, [mira()], transcript, settings, { requestScope: scope });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].responseLength, RELATIONSHIP_RESPONSE_LENGTH);
    assert.match(calls[0].systemPrompt, /isolated relationship evaluator/);
    assert.equal(pass.used, true);
    assert.equal(pass.targetCount, 1);
    assert.deepEqual(pass.decisions.get('npc_mira').relationshipDelta, { trust: 0, affection: 1, desire: 0, tension: 0 });

    const state = { turn: 4, npcs: [mira()] };
    const report = { updated: [] };
    applyFocusedRelationshipDecisions(state, pass.decisions, undefined, 7, report);
    assert.equal(state.npcs[0].relationship.affection, 11);
    assert.equal(state.npcs[0].lastRelationshipChange.message, 7);
    assert.deepEqual(report.updated, ['npc_mira']);
});

test('a decided NPC\'s primary relationship output is zeroed; matching by name reads the chat\'s dossiers', () => {
    const decisions = new Map([['npc_mira', { relationshipSummaryDecisionProvided: false }]]);
    const parsed = { npcs: [{ name: 'Mira', relationshipDelta: { trust: 3, affection: 3, desire: 0, tension: 0 }, relationshipImpact: 'meaningful' }] };
    const out = suppressPrimaryRelationshipForFocusedDecisions(parsed, decisions, () => [mira()]);
    assert.deepEqual(out.npcs[0].relationshipDelta, { trust: 0, affection: 0, desire: 0, tension: 0 });
    assert.equal(out.npcs[0].relationshipImpact, 'none');
    assert.equal(parsed.npcs[0].relationshipImpact, 'meaningful', 'the input is not changed');
    const unmatched = suppressPrimaryRelationshipForFocusedDecisions(parsed, decisions);
    assert.equal(unmatched.npcs[0].relationshipImpact, 'meaningful', 'no dossiers, no name match');
});

test('a scanner decision can accumulate fractional progress without a visible meter change', () => {
    const npc = normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', relationship: { trust: 60 } });
    const state = { turn: 4, npcs: [npc] };
    const decision = { relationshipImpact: 'ordinary', relationshipDelta: { trust: 1 },
        relationshipEvidence: { trust: 'Ari offered Mira shelter.' }, relationshipChangeReason: 'Ari offered Mira shelter.' };
    applyFocusedRelationshipDecisions(state, new Map([['npc_mira', decision]]), undefined, 7);
    assert.equal(state.npcs[0].relationship.trust, 60);
    assert.equal(state.npcs[0].relationshipProgress.trust, 0.5);
    assert.equal(state.npcs[0].lastRelationshipChange.impact, 'ordinary');
});

test('index.js imports the pass and keeps no copy', () => {
    const index = runtimeSource();
    assert.match(index, /\} from '\.\/src\/relationship-pass\.js';/);
    assert.doesNotMatch(runtimeSource(), /function (?:runFocusedRelationshipPass|applyFocusedRelationshipDecisions|suppressPrimaryRelationshipForFocusedDecisions|stampNpcChanges|currentExchangeRelationshipRelevant)\(/);
    assert.match(index, /suppressPrimaryRelationshipForFocusedDecisions\(fullWindowRelationship\.mergeSafe, relationshipPass\.decisions, \(\) => getChatState\(\)\.npcs\)/);
});

test('a hosted held scanner decision does not leave a conflicting stored relationship', { todo: 'the hosted projection does not reconcile the sidecar' }, async () => {
    const clock = { id: 'clock', name: 'Clock', domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
        queries: { 'director.time': state => state?.domains?.director?.time } };
    const host = await createHost({ modules: [clock] });
    const state = { turn: 1, npcs: [mira()] };
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => state.npcs },
        delta: () => ({ isEnabled: () => true, getNpc: () => state.npcs[0],
            relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
            relationshipCaps: () => ({ ordinary: 1, meaningful: 2, major: 3, extreme: 6 }),
            relationshipAllowance: () => ({ ordinary: 0, meaningful: 0, major: 0, extreme: 0 }) }),
        host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() {} },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} }, logger: { warn() {} },
    });
    try {
        adapter.start(); assert.equal(await adapter.settled(), true);
        await host.send('Continue', 'The story continues.'); await adapter.ticked();
        const before = structuredClone(state.npcs[0].relationship);
        const decision = { relationshipImpact: 'major', relationshipDelta: { trust: 3 },
            relationshipEvidence: { trust: 'Ari rescued Mira from the fire.' }, relationshipChangeReason: 'Ari rescued Mira from the fire.' };
        applyFocusedRelationshipDecisions(state, new Map([['npc_mira', decision]]), undefined, host.store.headIndex());
        assert.equal(state.npcs[0].relationship.trust, 13, 'the scanner accepted the major on the sidecar');
        await adapter.adjust({ name: 'Mira', meters: { trust: state.npcs[0].relationship.trust - before.trust }, start: before,
            reply: host.store.headIndex(), impact: 'major' });
        assert.equal(host.sdk.query('npc.meters', { name: 'Mira' }).meters.trust, 10, 'the slice held the event');
        assert.equal(adapter.sliceView(state.npcs)[0].relationship.trust, state.npcs[0].relationship.trust,
            'the held event must not leave the sidecar at its unheld value');
    } finally { host.close(); }
});
