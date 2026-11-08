// Focused relationship decisions, hosted pacing (the slice counts; Delta's sidecar is never written from it), and synthetic host reconciliation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeScanResult, normalizeNpcRecord } from '../core.js';
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
import { newestFlatDay as fromFlatDay } from './helpers/pacing-suite.js';
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

// While hosted the slice holds the allowance and is the one truth: Delta's scan applies the decision as asked and the change is
// forwarded with its tier (as runtime-hosted.js forwardRelationshipChangesToHost does). Nothing writes the slice's numbers back into
// Delta's record: the sidecar may differ (a held tier, a yield to the story), and every reader reads the slice
// (tests/hosted-slice-readers.test.js).
async function hostedPair(allowance) {
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
            relationshipAllowance: () => allowance }),
        host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() {} },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} }, logger: { warn() {} },
    });
    adapter.start(); assert.equal(await adapter.settled(), true);
    const scan = async (text, impact) => {
        await host.send('Continue', 'The story continues.'); await adapter.ticked();
        const reply = host.store.headIndex();
        const before = structuredClone(state.npcs[0]);
        const decision = { relationshipImpact: impact, relationshipDelta: { trust: 9 },
            relationshipEvidence: { trust: text }, relationshipChangeReason: text };
        applyFocusedRelationshipDecisions(state, new Map([['npc_mira', decision]]), undefined, reply, null, null);
        const after = state.npcs[0];
        const trust = after.relationship.trust - before.relationship.trust;
        const last = after.lastRelationshipChange;
        const sent = Boolean(trust) && JSON.stringify(last) !== JSON.stringify(before.lastRelationshipChange);
        if (sent) await adapter.adjust({ name: 'Mira', meters: { trust }, start: before.relationship, reply, ...(typeof last.impact === 'string' ? { impact: last.impact } : {}) });
        return { sent, reply };
    };
    const slice = () => host.head().domains.npc.npcs.mira;
    const sliceTrust = () => host.sdk.query('npc.meters', { name: 'Mira' })?.meters.trust;
    const shownTrust = () => adapter.sliceView(state.npcs)[0].relationship.trust;
    return { host, state, adapter, scan, slice, sliceTrust, shownTrust };
}

test('hosted: a downgraded scanner decision leaves the slice on the held number and the sidecar untouched, also after a reload', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        assert.deepEqual([h.state.npcs[0].relationship.trust, h.sliceTrust()], [13, 13]);
        const second = await h.scan('Ari stood between Mira and the tax collector.', 'major');
        assert.equal(second.sent, true);
        assert.equal(h.state.npcs[0].relationship.trust, 16, 'the sidecar applied the second major as asked (and nothing wrote the slice back)');
        assert.equal(h.sliceTrust(), 15, 'the slice held it to meaningful: +2');
        assert.equal(h.shownTrust(), 15, 'what is shown is the slice\'s');
        assert.equal(h.state.npcs[0].lastRelationshipChange.impact, 'major', 'the event history keeps the tier the scanner asked');
        assert.deepEqual(h.state.npcs[0].relationshipEventHistory.map(event => event.impact), ['major', 'major']);
        assert.equal(fromFlatDay(h.slice().impactDay).meaningful, 1, 'the slice counted the used tier once');
        h.host.store.rebuild();
        assert.equal(h.sliceTrust(), 15, 'after a rebuild');
        await h.host.st.loadChat(h.host.ctx.chat);   // a cold reload of the chat: the slice is replayed from its stored ops
        await h.adapter.ticked();
        assert.equal(h.sliceTrust(), 15, 'after a reload');
        assert.equal(h.shownTrust(), 15);
        assert.equal(h.state.npcs[0].relationship.trust, 16, 'the sidecar is only ever what Delta stored');
    } finally { h.host.close(); }
});

test('hosted: an ignored scanner decision moves nothing on the slice; the sidecar keeps what it applied and is not read', async () => {
    const h = await hostedPair({ ordinary: 0, meaningful: 0, major: 0, extreme: 0 });
    try {
        const out = await h.scan('Ari rescued Mira from the fire.', 'major');
        assert.equal(out.sent, true, 'the sidecar applied it as asked, so it is forwarded');
        assert.deepEqual(['ordinary', 'meaningful', 'major', 'extreme'].map(tier => fromFlatDay(h.slice().impactDay)[tier]), [0, 0, 0, 0], 'the slice counted nothing');
        assert.equal(h.state.npcs[0].impactDay, undefined, 'the sidecar does not count while hosted');
        assert.equal(h.state.npcs[0].relationship.trust, 13);
        assert.equal(h.sliceTrust(), 10, 'her number is the slice\'s');
        assert.equal(h.shownTrust(), 10);
    } finally { h.host.close(); }
});

test('hosted: a decision with room is applied as asked and the two sides agree', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        assert.deepEqual([h.shownTrust(), h.sliceTrust()], [13, 13]);
        assert.equal(fromFlatDay(h.slice().impactDay).major, 1);
    } finally { h.host.close(); }
});

test('hosted: nothing of the slice is written into a Delta record (no adopt function, no slice-number query)', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        assert.equal(h.adapter.sliceNumbers, undefined);
        assert.doesNotMatch(fs.readFileSync(new URL('../runtime-hosted.js', import.meta.url), 'utf8'), /adoptSlice|sliceNumbers|persist\(/);
        assert.doesNotMatch(fs.readFileSync(new URL('../src/relationship-pass.js', import.meta.url), 'utf8'), /adoptSlice/);
    } finally { h.host.close(); }
});

test('hosted: a downgraded decision keeps the slice and the shown number together', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        h.state.npcs[0].relationship.trust = 60;
        await h.scan('Ari rescued Mira from the fire.', 'major');
        await h.scan('Ari defended Mira from the tax collector.', 'major');
        assert.equal(h.shownTrust(), h.sliceTrust());
    } finally { h.host.close(); }
});

// A scanner event that moved no whole point has nothing to forward, so it spends no allowance (accepted): the slice never hears of it.
test('hosted: a fraction-only scanner event spends no allowance and is not forwarded', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        h.state.npcs[0].relationship.trust = 60;
        const out = await h.scan('Ari offered Mira shelter.', 'ordinary');
        assert.equal(h.state.npcs[0].relationshipProgress.trust, 0.5);
        assert.equal(out.sent, false);
        assert.equal(h.slice()?.impactDay, undefined);
    } finally { h.host.close(); }
});

test('hosted: a complete primary scanner decision leaves the slice on the held number', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        const text = 'Ari defended Mira from the tax collector.';
        await h.host.send('Continue', text); await h.adapter.ticked();
        const reply = h.host.store.headIndex();
        const before = structuredClone(h.state.npcs[0]);
        const primary = { id: before.id, name: before.name, relationshipImpact: 'major',
            relationshipDelta: { trust: 9, affection: 0, desire: 0, tension: 0 },
            relationshipEvidence: { trust: text }, relationshipChangeReason: text, relationshipSummary: 'Mira trusts Ari.' };
        assert.equal(hasCompletePrimaryRelationshipDecision(primary, text), true);
        const pass = await runFocusedRelationshipPass({}, { npcs: [primary] }, [before], text, settings, { requestScope: scope });
        assert.equal(pass.used, false, 'a complete primary row does not take the focused route');
        const merged = mergeScanResult({ ...h.state, candidates: [] }, { npcs: [primary] }, { sourceMessageId: reply, developmentContext: text });
        const after = merged.state.npcs[0];
        assert.equal(after.relationship.trust, 16, 'the primary row was applied as asked, unpaced');
        h.state.npcs[0] = after;
        await h.adapter.adjust({ name: after.name, meters: { trust: after.relationship.trust - before.relationship.trust },
            start: before.relationship, reply, impact: after.lastRelationshipChange.impact });
        assert.equal(h.sliceTrust(), 15, 'the slice held the second major to meaningful: +2');
        assert.equal(h.shownTrust(), 15);
    } finally { h.host.close(); }
});

test('hosted: a scanner yields to the story before storing a matching meter event', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.host.send('Continue', 'The story continues.\n\n<Changes>\n~ npc Mira | trust: +1 | impact: ordinary\n</Changes>');
        await h.adapter.ticked();
        h.state.npcs = h.adapter.sliceView(h.state.npcs);
        const before = structuredClone(h.state.npcs[0]);
        const reply = h.host.store.headIndex();
        const text = 'Ari rescued Mira from the fire.';
        applyFocusedRelationshipDecisions(h.state, new Map([[before.id, { relationshipImpact: 'major', relationshipDelta: { trust: 9 },
            relationshipEvidence: { trust: text }, relationshipChangeReason: text }]]), undefined, reply, null, null);
        const after = h.state.npcs[0];
        assert.equal(after.relationship.trust, 14, 'the sidecar applied the event the slice will drop (11 + 3)');
        await h.adapter.adjust({ name: after.name, meters: { trust: after.relationship.trust - before.relationship.trust },
            start: before.relationship, reply, impact: after.lastRelationshipChange.impact });
        assert.equal(h.sliceTrust(), 11, 'the story line moved her: the slice dropped the scanner\'s change');
        assert.equal(h.shownTrust(), 11);
    } finally { h.host.close(); }
});

test('hosted, the scan counts nothing itself: the slice counts', () => {
    assert.match(runtimeSource(), /const scanPace = settings => \(hostedMeters\(\) \? null : \{ allowance: normalizeAllowance\(settings\.relationshipAllowance\), day: null \}\)/);
});
