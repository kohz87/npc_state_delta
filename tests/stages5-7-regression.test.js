import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as core from '../core.js';
import { buildInjection as baselineInjection } from '../core-mechanics.js';
import { scoringCases, canonicalResult } from './fixtures/scoring-cases.mjs';
import { BRANCH_LINEAGE_VERSION, recordBranchCheckpoint, reconcileBranchState } from '../branch.js';
import { decodeStateFilePayload, encodeStateFilePayload, readNpcStateDataFile, writeNpcStateDataFile } from '../storage.js';
import { dossierDetailProjection } from '../dossier-ui.js';

const zero = { trust: 0, affection: 0, desire: 0, tension: 0 };
const user = (mes, id) => ({ mes, is_user: true, name: 'Lucien', send_date: id });
const bot = (mes, id) => ({ mes, is_user: false, name: 'Eos', send_date: id, swipe_id: 0 });
const oracle = JSON.parse(fs.readFileSync(new URL('./fixtures/scoring-oracle.json', import.meta.url), 'utf8'));

test('Stage 5 numerical outputs match the pinned source across 41,070 boundary, signed, fractional and cap cases', () => {
    const hash = createHash('sha256'); let count = 0;
    for (const args of scoringCases()) { hash.update(JSON.stringify(canonicalResult(core.applyRelationshipDelta(...args))) + '\n'); count++; }
    assert.equal(count, oracle.cases);
    assert.equal(hash.digest('hex'), oracle.sha256, `Numerical output diverged from pinned source blob ${oracle.sourceBlob}`);
});

test('Stage 5 directional gates, fractions and tied-axis rejection retain observable baseline behavior', () => {
    for (const sign of [-1, 1]) {
        const ordinary = core.applyRelationshipDelta({ ...zero, trust: 25 * sign }, { ...zero, trust: sign }, 'ordinary');
        assert.equal(ordinary.relationship.trust, 25 * sign);
        assert.equal(ordinary.relationshipProgress.trust, 0);
        assert.equal(ordinary.milestoneBlocks[0].threshold, 25);
        const meaningful = core.applyRelationshipDelta(ordinary.relationship, { ...zero, trust: sign }, 'meaningful');
        assert.equal(meaningful.relationship.trust, 26 * sign);
        assert.equal(meaningful.milestoneCrossings[0].polarity, sign);
        const major = core.applyRelationshipDelta({ ...zero, trust: 50 * sign }, { ...zero, trust: 3 * sign }, 'major');
        assert.equal(major.relationship.trust, 51 * sign);
        assert.equal(major.relationshipProgress.trust, 0.5 * sign);
        const high = core.applyRelationshipDelta({ ...zero, trust: 90 * sign }, { ...zero, trust: 8 * sign }, 'extreme');
        assert.equal(high.relationship.trust, 91 * sign);
        assert.equal(high.relationshipProgress.trust, 0.6 * sign);
    }
    const tied = core.applyRelationshipDelta(zero, { ...zero, trust: 1, affection: 1 }, 'ordinary');
    assert.deepEqual(tied.relationship, zero);
    assert.equal(tied.evidenceAccepted, false);
});

test('Stage 5 parsed proposal persists one award, preserves fractional state on repeat and rolls back by owned source', () => {
    const npc = core.normalizeNpcRecord({ ...core.createNpcRecord('Astra'), relationship: { ...zero, trust: 50 } });
    const chat = [user('Wait here.', 'u1'), bot('Astra waits.', 'a1'), user('I keep the promise.', 'u2'), bot('Lucien kept his promise to protect Astra.', 'a2')];
    let state = { npcs: [npc], turn: 1, checkpoints: [], lineage: [], dismissed: [], branchLineageVersion: BRANCH_LINEAGE_VERSION };
    recordBranchCheckpoint(state, chat, 1, 'scan');
    const raw = JSON.stringify({ npcs: [{ id: npc.id, name: npc.name, present: true, relationshipImpact: 'major', relationshipDelta: { ...zero, trust: 3 }, relationshipEvidence: { trust: 'Lucien kept his promise to protect Astra.', affection: '', desire: '', tension: '' }, relationshipChangeReason: 'Lucien kept his promise to protect Astra.' }] });
    const parsed = core.parseScanJson(raw);
    const options = { turn: 2, sourceMessageId: 3, developmentContext: chat[3].mes };
    state = core.mergeScanResult(state, parsed, options).state;
    recordBranchCheckpoint(state, chat, 3, 'scan');
    const first = structuredClone(state.npcs[0]);
    assert.equal(first.relationship.trust, 51);
    assert.equal(first.relationshipProgress.trust, 0.5);
    assert.equal(first.relationshipEventHistory.length, 1);
    state = core.mergeScanResult(state, parsed, options).state;
    assert.deepEqual(state.npcs[0].relationship, first.relationship);
    assert.deepEqual(state.npcs[0].relationshipProgress, first.relationshipProgress);
    assert.deepEqual(state.npcs[0].relationshipEventHistory, first.relationshipEventHistory);
    const saved = decodeStateFilePayload(encodeStateFilePayload('chat:card.png:scoring', state, '0.1.0')).state;
    assert.deepEqual(dossierDetailProjection(saved.npcs[0]).relationship, first.relationship);
    assert.deepEqual(saved.npcs[0].relationshipMilestones, first.relationshipMilestones);
    const rolled = reconcileBranchState(saved, chat.slice(0, 3), { explicitDivergence: 3 }).state.npcs[0];
    assert.equal(rolled.relationship.trust, 50);
    assert.deepEqual(rolled.relationshipProgress, npc.relationshipProgress);
    assert.equal(rolled.relationshipEventHistory.length, 0);
    assert.equal(rolled.relationshipMilestones.some(item => item.threshold === 50), false);
});

function character(overrides = {}) {
    return core.normalizeNpcRecord({
        ...core.createNpcRecord('Mira'), present: true,
        personality: 'Patient, principled, and independent.',
        behaviorProfile: ['Duty: Protects the archive.', 'Boundary: Refuses dishonest work.'],
        speech: 'Formal, measured sentences; addresses elders by title.',
        mannerisms: ['Straightens her cuffs before answering.'],
        role: 'Archivist', goal: 'Protect the archive',
        ...overrides,
    });
}

test('Stage 6 omission retains accepted characterization but tentative evidence is not injected as canon', () => {
    const prior = character({ profileEvidence: { speech: [{ text: 'UNACCEPTED_SECRET_VOICE', count: 1 }] } });
    const next = core.mergeScanResult({ npcs: [prior], turn: 1 }, core.parseScanJson(JSON.stringify({ npcs: [{ id: prior.id, name: prior.name, present: true, mood: 'Alert' }] })), { turn: 2, sourceMessageId: 3, developmentContext: 'Mira looks alert.' }).state.npcs[0];
    for (const key of ['personality', 'behaviorProfile', 'speech', 'mannerisms']) assert.deepEqual(next[key], prior[key]);
    const prompt = core.buildInjection([next], 'Mira answers.', 2, 3, undefined, 1800);
    for (const text of ['Patient', 'Duty:', 'Formal', 'Straightens']) assert.ok(prompt.includes(text), text);
    assert.equal(prompt.includes('UNACCEPTED_SECRET_VOICE'), false);
});

test('Stage 6 current appearance cannot consume the baseline identity/agency allocation', () => {
    const npc = character({ appearance: 'A blue coat and silver braid. '.repeat(35) });
    for (const budget of [400, 600, 800, 1200, 1800]) {
        const base = baselineInjection([npc], 'Mira answers.', 2, 3, undefined, budget);
        const rendered = core.buildInjection([npc], 'Mira answers.', 2, 3, undefined, budget);
        const identity = base.split('\n').find(line => line.startsWith('- Mira:'))?.split('; important memories:')[0].split('; species/race:')[0];
        assert.ok(identity && rendered.includes(identity), `identity/agency lost at budget ${budget}`);
        assert.ok(rendered.length <= core.normalizeInjectionBudgetTokens(budget) * 4);
    }
    const full = core.buildInjection([npc], 'Mira answers.', 2, 3, undefined, 1800);
    assert.equal((full.match(/CURRENT VISIBLE APPEARANCE/g) || []).length, 1);
    assert.ok(full.indexOf('IDENTITY (authoritative)') < full.indexOf('CURRENT VISIBLE APPEARANCE'));
});

test('Stage 6 unknown form is not replaced with species anatomy in continuity', () => {
    const npc = character({ appearanceModelVersion: 1, species: 'Dragon', currentForm: '', currentFormUnknown: true, unclassifiedAppearance: '', appearanceForms: [{ name: 'Dragon', appearance: 'Red scales and wings.' }] });
    const rendered = core.buildInjection([npc], 'Mira remains in the mist.', 2, 3, undefined, 1800);
    assert.match(rendered, /do not infer anatomy from species or another form/);
    assert.doesNotMatch(rendered, /Red scales and wings/);
});

test('Stage 7 removed command exports are absent; explicit manual operations remain usable', () => {
    assert.equal(core.parseOocNpcStateCommands, undefined);
    assert.equal(core.stripOocNpcStateControls, undefined);
    const added = core.applyNpcStateCommand({ npcs: [] }, { action: 'add', name: 'Mira' });
    assert.equal(added.report.status, 'added');
    const removed = core.applyNpcStateCommand(added.state, { action: 'remove', npcId: added.report.npcId, name: 'Mira' });
    assert.equal(removed.state.npcs.length, 0);
});

test('Stage 7 explicit death correction round-trips while an unrelated terminal record remains dead', () => {
    const dead = core.setNpcArchived(character(), true, { reason: 'deceased', sourceMessageId: 5 });
    const other = core.setNpcArchived(core.createNpcRecord('Other'), true, { reason: 'deceased', sourceMessageId: 7 });
    const corrected = core.setNpcArchived(dead, false, { allowDeathCorrection: true, sourceMessageId: 9, lifeStateReason: 'The recorded death was a mistaken identity.' });
    const saved = decodeStateFilePayload(encodeStateFilePayload('chat:card.png:correction', { npcs: [corrected, other] }, '0.1.0')).state;
    assert.equal(saved.npcs[0].lifeState, 'alive');
    assert.equal(saved.npcs[0].present, false);
    assert.equal(saved.npcs[0].deathCorrection.previousDeathSourceMessageId, 5);
    assert.equal(core.isTerminalNpcDeath(saved.npcs[1]), true);
});

test('Stage 7 an interrupted owner save retries without crossing same-name chat ownership', async () => {
    const files = new Map(); let attempts = 0;
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            attempts++;
            if (attempts === 1) return { ok: false, status: 503, text: async () => 'Temporary failure' };
            const body = JSON.parse(options.body); const path = `/user/files/${body.name}`;
            files.set(path, Buffer.from(body.data, 'base64').toString());
            return { ok: true, json: async () => ({ path }) };
        }
        return files.has(url) ? { ok: true, status: 200, text: async () => files.get(url) } : { ok: false, status: 404 };
    };
    const state = { npcs: [character()], checkpoints: [] };
    const a = await writeNpcStateDataFile({ chatKey: 'chat:a.png:shared', state, fetchFn, sleepFn: callback => callback(), continuousRetry: false });
    assert.equal(attempts, 2);
    const b = await writeNpcStateDataFile({ chatKey: 'chat:b.png:shared', state: { npcs: [] }, fetchFn, sleepFn: callback => callback(), continuousRetry: false });
    assert.notEqual(a.path, b.path);
    const restored = await readNpcStateDataFile(a, { expectedChatKey: 'chat:a.png:shared', fetchFn });
    assert.equal(restored.state.npcs[0].name, 'Mira');
    await assert.rejects(readNpcStateDataFile(a, { expectedChatKey: 'chat:b.png:shared', fetchFn }), /belong|match|chat|owner/i);
});
