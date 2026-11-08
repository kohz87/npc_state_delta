// Hosted, the slice is the one truth for a person's relationship numbers and nothing writes them back into Delta's dossier.
// After a held event the slice (trust 5) and the sidecar (trust 8, its own part-points and an earned milestone) differ. Every
// reader below must answer from the slice: each test checks that, and most also change the sidecar again and expect the same answer.
// The only reads of the sidecar left while hosted are seeds for a person the slice has no entry for yet (src/npc-meters.js `identify`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildInjection, buildScannerPrompt, normalizeNpcRecord } from '../core.js';
import { MODULE_ID } from '../src/storysuite-v2.js';
import { applyFocusedRelationshipDecisions } from '../src/relationship-pass.js';
import { suite, major } from './helpers/pacing-suite.js';

const milestone25 = { axis: 'trust', polarity: 1, threshold: 25, reason: 'earned on the sidecar', sourceMessageId: 1, turn: 1, inferred: false };
const sidecarMira = (trust, extra = {}) => normalizeNpcRecord({
    id: 'npc_mira', name: 'Mira', aliases: [], present: true, archived: false,
    relationship: { trust, affection: 0, desire: 0, tension: 0 }, relationshipProgress: { trust: 0.5 }, relationshipMilestones: [milestone25], createdAt: 1, updatedAt: 1, ...extra,
});

// Two majors in one day on the slice: +3, then the held second one (+2): trust 5. The sidecar then says 8 (both applied as asked).
async function held() {
    const s = await suite({ records: { npc_mira: sidecarMira(0) } });
    await s.setDay(1);
    await s.say([major('Mira')]);
    await s.say([major('Mira')]);
    assert.equal(s.npc('Mira').meters.trust, 5);
    setSidecar(s, 8);
    return s;
}
const setSidecar = (s, trust) => { s.delta.records.npc_mira = sidecarMira(trust); };
const viewOf = s => s.adapter.sliceView(Object.values(s.delta.records))[0];

test('cast cards and the dossier view read the slice: numbers, part-points and earned milestones', async () => {
    const s = await held();
    try {
        const stored = Object.values(s.delta.records);
        const shown = s.adapter.sliceView(stored)[0];
        assert.equal(shown.relationship.trust, 5);
        assert.deepEqual(shown.relationshipProgress, { trust: 0, affection: 0, desire: 0, tension: 0 }, 'not the sidecar\'s 0.5');
        assert.deepEqual(shown.relationshipMilestones, [], 'the sidecar\'s earned 25 does not hold at the slice\'s 5');
        assert.equal(stored[0].relationship.trust, 8, 'the sidecar record itself is not changed by a read');
        assert.equal(s.host.sdk.query('npc.dossier', { name: 'Mira' }).relationship.trust, 5, 'public query: dossier');
        assert.equal(s.host.sdk.query('npc.present', { meters: true })[0].meters.trust, 5, 'public query: present');
        const before = JSON.stringify([shown, s.host.sdk.query('npc.dossier', { name: 'Mira' }), s.host.sdk.query('npc.present', { meters: true }), s.host.sdk.query('npc.cast', {})]);
        setSidecar(s, 70);
        assert.equal(JSON.stringify([viewOf(s), s.host.sdk.query('npc.dossier', { name: 'Mira' }), s.host.sdk.query('npc.present', { meters: true }), s.host.sdk.query('npc.cast', {})]), before, 'another sidecar, the same answers');
    } finally { s.host.close(); }
});

test('the prompt injection and the relationship lines the narrator sees read the slice', async () => {
    const s = await held();
    try {
        const text = 'Mira: hello.';
        const inject = npc => buildInjection([npc], text, 1, 3);
        const shown = viewOf(s);
        const control = { ...sidecarMira(5), relationshipProgress: shown.relationshipProgress, relationshipMilestones: [] };
        assert.equal(inject(shown), inject(control), 'built from the slice\'s numbers');
        setSidecar(s, 70);
        assert.equal(inject(viewOf(s)), inject(control), 'a different sidecar does not move it');
        assert.notEqual(inject(sidecarMira(70)), inject(control), 'the sidecar would have read differently');
        assert.match(fs.readFileSync(new URL('../runtime-injection.js', import.meta.url), 'utf8'), /buildInjection\(scenePresenceView\(hostedMeterView\(state\.npcs\)\)/);
        const def = s.host.registry.module(MODULE_ID);
        const tail = () => JSON.stringify(def.context.tail({ state: s.host.head(), chat: { length: s.host.ctx.chat.length } }));
        const lines = tail();
        setSidecar(s, 30);
        assert.equal(tail(), lines, 'the narrator\'s lines come from the slice alone');
    } finally { s.host.close(); }
});

test('stages, behaviour tiers and the social modifier read the slice', async () => {
    const s = await held();
    try {
        const read = () => JSON.stringify([s.npc('Mira'), s.host.sdk.query('npc.next', { name: 'Mira' }), s.host.sdk.query('npc.socialModifier', { name: 'Mira', skill: 'persuasion' })]);
        const before = read();
        setSidecar(s, 70);
        assert.equal(read(), before);
        assert.equal(s.npc('Mira').meters.trust, 5);
    } finally { s.host.close(); }
});

// The scanner: runtime-hosted.js hostedScanState is hostedMeterView(state.npcs) (adapter.sliceView) in a copy of the state (it cannot be
// imported here: it needs SillyTavern's modules), then the production prompt and pass run on that copy.
const hostedSource = fs.readFileSync(new URL('../runtime-hosted.js', import.meta.url), 'utf8');
assert.match(hostedSource, /function hostedMeterView\(npcs\) \{[^}]*adapter\.sliceView\(npcs\)/);
assert.match(hostedSource, /function hostedScanState\(state\) \{\n\s*const npcs = hostedMeterView\(state\?\.npcs\);\n\s*return npcs === state\?\.npcs \? state : \{ \.\.\.state, npcs \};/);
const scanStateOf = async s => ({ turn: 1, npcs: s.adapter.sliceView(Object.values(s.delta.records)) });

test('the scanner\'s currentRelationship and the focused pass\'s baseline are the slice\'s, progress and milestones included', async () => {
    const s = await held();
    try {
        const state = await scanStateOf(s);
        assert.equal(state.npcs[0].relationship.trust, 5);
        const prompt = buildScannerPrompt({ transcript: 'Mira: hello.', existingNpcs: state.npcs, candidates: [] });
        setSidecar(s, 70);
        const again = buildScannerPrompt({ transcript: 'Mira: hello.', existingNpcs: (await scanStateOf(s)).npcs, candidates: [] });
        assert.equal(again, prompt, 'the scanner prompt does not change with the sidecar');
        assert.notEqual(buildScannerPrompt({ transcript: 'Mira: hello.', existingNpcs: [sidecarMira(70)], candidates: [] }), prompt);
        assert.deepEqual(state.npcs[0].relationshipProgress, { trust: 0, affection: 0, desire: 0, tension: 0 });
        assert.deepEqual(state.npcs[0].relationshipMilestones, []);
    } finally { s.host.close(); }
});

// The gate: the slice stands at 24 with no earned 25; the sidecar stands at 30 with 25 earned. An ordinary +3 must stop at the gate.
test('a hosted scan\'s milestone gate and part-points start from the slice, never the sidecar', async () => {
    const s = await suite({ records: { npc_mira: sidecarMira(0) } });
    try {
        await s.say(['+ npc Mira | trust: +1']);
        assert.equal((await s.adapter.setMeters({ name: 'Mira', meters: { trust: 24 } }))?.ok, true);
        setSidecar(s, 30);
        assert.equal(s.npc('Mira').meters.trust, 24);
        const text = 'Ari handed Mira the lantern and she smiled.';
        const decision = () => new Map([['npc_mira', { relationshipImpact: 'ordinary', relationshipDelta: { trust: 3 }, relationshipEvidence: { trust: text }, relationshipChangeReason: text }]]);
        const viaView = await scanStateOf(s);
        applyFocusedRelationshipDecisions(viaView, decision(), undefined, 5, null, null);
        assert.ok(viaView.npcs[0].relationship.trust <= 25, `gated at the slice's base, not passed on the sidecar's earned 25: ${viaView.npcs[0].relationship.trust}`);
        const raw = { turn: 1, npcs: [sidecarMira(30)] };
        applyFocusedRelationshipDecisions(raw, decision(), undefined, 5, null, null);
        assert.ok(raw.npcs[0].relationship.trust > 30, 'the sidecar alone would have read its own base');
    } finally { s.host.close(); }
});

test('replay: a hosted history replay reads Story Block as of its reply and leaves the slice equal to live; the sidecar is never read', async () => {
    const s = await held();
    try {
        const live = JSON.stringify(s.host.head().domains.npc);
        s.host.store.rebuild();
        assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'the slice\'s own ops are the record');
        await s.host.st.loadChat(s.host.ctx.chat);
        await s.adapter.ticked();
        assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'also after a cold reload');
        assert.equal(Object.values(s.delta.records)[0].relationship.trust, 8, 'the sidecar keeps what Delta stored (it may differ; nothing reads it)');
    } finally { s.host.close(); }
});
