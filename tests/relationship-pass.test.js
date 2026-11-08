// Focused relationship decisions, the hosted pacing query, and synthetic host reconciliation.
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

// While hosted the slice holds the allowance. The pass reads its tier first (adapter.paceTier, read only) and applies the decision with
// it, then the change is forwarded with that used tier (as runtime-hosted.js forwardRelationshipChangesToHost does), so both sides agree.
async function hostedPair(allowance, queryMode = 'normal') {
    const clock = { id: 'clock', name: 'Clock', domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
        queries: { 'director.time': state => state?.domains?.director?.time } };
    const host = await createHost({ modules: [clock] });
    const state = { turn: 1, npcs: [mira()] };
    const sdk = queryMode === 'normal' ? host.sdk : { ...host.sdk, query: (name, ...args) => {
        if (name === 'npc.pace') {
            if (queryMode === 'throws') throw new Error('query unavailable');
            return null;
        }
        return host.sdk.query(name, ...args);
    } };
    const box = { ready: Promise.resolve(sdk), sdk };
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
        const pace = { used: (npc, tier, at) => adapter.paceTier({ name: npc.name, reply: at, tier }) };
        applyFocusedRelationshipDecisions(state, new Map([['npc_mira', decision]]), undefined, reply, null, pace);
        const after = state.npcs[0];
        const trust = after.relationship.trust - before.relationship.trust;
        const last = after.lastRelationshipChange;
        const sent = Boolean(trust) && JSON.stringify(last) !== JSON.stringify(before.lastRelationshipChange);
        if (sent) await adapter.adjust({ name: 'Mira', meters: { trust }, start: before.relationship, reply, ...(typeof last.impact === 'string' ? { impact: last.impact } : {}) });
        return { sent, reply };
    };
    const slice = () => host.head().domains.npc.npcs.mira;
    const agree = label => {
        const stored = state.npcs[0];
        assert.equal(adapter.sliceView(state.npcs)[0].relationship.trust, stored.relationship.trust, `${label}: shown trust is the sidecar's`);
        const entry = host.sdk.query('npc.meters', { name: 'Mira' });
        if (!entry) return;   // nothing reached the slice (an ignored event): the sidecar's numbers are shown as they are
        assert.equal(entry.meters.trust, stored.relationship.trust, `${label}: slice trust is the sidecar's`);
        assert.deepEqual(slice().progress ?? {}, Object.fromEntries(Object.entries(stored.relationshipProgress ?? {}).filter(([, v]) => v)), `${label}: progress`);
    };
    return { host, state, adapter, scan, slice, agree };
}

test('hosted: a downgraded scanner decision leaves the sidecar and the slice on the same numbers, progress, milestones and history, also after a reload', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        assert.equal(h.state.npcs[0].relationship.trust, 13);
        h.agree('first major');
        const second = await h.scan('Ari stood between Mira and the tax collector.', 'major');
        assert.equal(second.sent, true);
        assert.equal(h.state.npcs[0].relationship.trust, 15, 'the second major of the day counts as meaningful: +2');
        assert.equal(h.state.npcs[0].lastRelationshipChange.impact, 'meaningful');
        assert.deepEqual(h.state.npcs[0].relationshipEventHistory.map(event => event.impact), ['major', 'meaningful']);
        h.agree('downgraded');
        assert.equal(h.slice().impactDay.meaningful, 1, 'the slice counted the used tier once');
        h.host.store.rebuild();
        h.agree('after a rebuild');
        await h.host.st.loadChat(h.host.ctx.chat);   // a cold reload of the chat: the slice is replayed from its stored ops
        await h.adapter.ticked();
        h.state.npcs = structuredClone(h.state.npcs);   // and Delta's own save and load hand its records back
        h.agree('after a reload');
        assert.deepEqual(h.state.npcs[0].relationshipMilestones, [], 'no milestone on either side');
    } finally { h.host.close(); }
});

test('hosted: an ignored scanner decision changes nothing on either side and sends nothing', async () => {
    const h = await hostedPair({ ordinary: 0, meaningful: 0, major: 0, extreme: 0 });
    try {
        const out = await h.scan('Ari rescued Mira from the fire.', 'major');
        assert.equal(out.sent, false, 'nothing to forward');
        assert.equal(h.state.npcs[0].relationship.trust, 10);
        assert.deepEqual(h.state.npcs[0].relationshipEventHistory ?? [], [], 'no event in the sidecar history');
        assert.equal(h.state.npcs[0].impactDay, undefined, 'the sidecar does not count while hosted');
        assert.equal(h.slice()?.impactDay, undefined);
        h.agree('ignored');
    } finally { h.host.close(); }
});

test('hosted: a decision with room is applied as asked and the two sides agree', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        h.agree('with room');
        assert.equal(h.slice().impactDay.major, 1);
    } finally { h.host.close(); }
});

test('hosted: repeated pace queries are read-only and the forwarded decision spends once', async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        const first = await h.scan('Ari rescued Mira from the fire.', 'major');
        const before = JSON.stringify(h.host.head());
        for (let n = 0; n < 3; n += 1) {
            assert.deepEqual(h.adapter.paceTier({ name: 'Mira', reply: first.reply, tier: 'major' }), { used: 'meaningful', skipped: ['major'] });
            assert.equal(JSON.stringify(h.host.head()), before, 'query must not spend or write');
        }
        await h.scan('Ari defended Mira from the tax collector.', 'major');
        assert.equal(h.slice().impactDay.major, 1);
        assert.equal(h.slice().impactDay.meaningful, 1, 'the pass and the forward did not each spend');
    } finally { h.host.close(); }
});

for (const mode of ['missing', 'throws']) {
    test(`hosted: a ${mode} pace query leaves the scan working without pacing`, async () => {
        const h = await hostedPair(null, mode);
        try {
            assert.equal(h.adapter.paceTier({ name: 'Mira', reply: 1, tier: 'major' }), null);
            const out = await h.scan('Ari rescued Mira from the fire.', 'major');
            assert.equal(out.sent, true);
            assert.equal(h.state.npcs[0].relationship.trust, 13);
            h.agree(mode);
        } finally { h.host.close(); }
    });
}

test('hosted: a failed pace query does not desynchronize an active allowance', { todo: 'the pass falls back before the slice applies its allowance' }, async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 }, 'throws');
    try {
        await h.scan('Ari rescued Mira from the fire.', 'major');
        await h.scan('Ari defended Mira from the tax collector.', 'major');
        assert.equal(h.state.npcs[0].relationship.trust, h.host.sdk.query('npc.meters', { name: 'Mira' }).meters.trust);
    } finally { h.host.close(); }
});

test('hosted: a downgraded decision keeps fractional progress in the slice', { todo: 'forwarding sends whole meter changes only' }, async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        h.state.npcs[0].relationship.trust = 60;
        await h.scan('Ari rescued Mira from the fire.', 'major');
        await h.scan('Ari defended Mira from the tax collector.', 'major');
        assert.equal(h.state.npcs[0].lastRelationshipChange.impact, 'meaningful');
        h.agree('fractional progress after downgrade');
    } finally { h.host.close(); }
});

test('hosted: a fraction-only scanner event spends the shared allowance', { todo: 'forwarding ignores events without a whole meter change' }, async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        h.state.npcs[0].relationship.trust = 60;
        const out = await h.scan('Ari offered Mira shelter.', 'ordinary');
        assert.equal(h.state.npcs[0].relationshipProgress.trust, 0.5);
        assert.equal(out.sent, true, 'the event must reach the slice even when the visible delta is zero');
        assert.equal(h.slice().impactDay.ordinary, 1);
    } finally { h.host.close(); }
});

test('hosted: a complete primary scanner decision uses the slice allowance', { todo: 'only focused decisions ask npc.pace' }, async () => {
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
        await h.adapter.adjust({ name: after.name, meters: { trust: after.relationship.trust - before.relationship.trust },
            start: before.relationship, reply, impact: after.lastRelationshipChange.impact });
        assert.equal(after.relationship.trust, h.host.sdk.query('npc.meters', { name: 'Mira' }).meters.trust);
    } finally { h.host.close(); }
});

test('hosted: a scanner yields to the story before storing a matching meter event', { todo: 'the pass applies an event the host later drops' }, async () => {
    const h = await hostedPair({ ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    try {
        await h.host.send('Continue', 'The story continues.\n\n<Changes>\n~ npc Mira | trust: +1 | impact: ordinary\n</Changes>');
        await h.adapter.ticked();
        h.state.npcs = h.adapter.sliceView(h.state.npcs);
        const before = structuredClone(h.state.npcs[0]);
        const reply = h.host.store.headIndex();
        const text = 'Ari rescued Mira from the fire.';
        applyFocusedRelationshipDecisions(h.state, new Map([[before.id, { relationshipImpact: 'major', relationshipDelta: { trust: 9 },
            relationshipEvidence: { trust: text }, relationshipChangeReason: text }]]), undefined, reply, null,
        { used: (npc, tier, at) => h.adapter.paceTier({ name: npc.name, reply: at, tier }) });
        const after = h.state.npcs[0];
        await h.adapter.adjust({ name: after.name, meters: { trust: after.relationship.trust - before.relationship.trust },
            start: before.relationship, reply, impact: after.lastRelationshipChange.impact });
        assert.equal(after.relationship.trust, h.host.sdk.query('npc.meters', { name: 'Mira' }).meters.trust);
    } finally { h.host.close(); }
});

test('hosted, the scan reads the slice\'s tier first; alone it counts on the dossier', () => {
    assert.match(runtimeSource(), /const scanPace = settings => \(hostedMeters\(\) \? \{ used: hostedPaceTier \} : \{ allowance: normalizeAllowance\(settings\.relationshipAllowance\), day: null \}\)/);
});
