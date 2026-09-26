import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    createNpcRecord,
    developmentScaleReady,
    durableProfileAggregateCandidateGrounded,
    mergeScanResult,
} from '../core.js';
import { createDiagnosticStore, DIAGNOSTIC_BUNDLE_VERSION } from '../diagnostics-core.js';

function profileScan(state, update, turn, sourceMessageId, developmentContext = '') {
    return mergeScanResult(state, { npcs: [], profileUpdates: [update] }, { turn, sourceMessageId, developmentContext });
}

test('v1.0.23 bounded development episode reaches a later NPC montage segment', () => {
    const context = 'Two months passed. Rowan trained sword forms every morning. The household settled into a new routine. Mira practiced formal speech every evening until her cadence became measured and polished.';
    assert.equal(developmentScaleReady(
        'batch',
        'Two months of practicing formal speech made her cadence measured and polished.',
        context,
        { npc: { name: 'Mira', aliases: [] }, evidence: ['measured polished formal cadence'], targeted: false, otherLabels: ['Rowan'] },
    ), true);
});

test('v1.0.23 another NPCs development cannot authorize the target merely because both appear in the montage', () => {
    const context = 'Two months passed. Rowan trained command drills every morning until his delivery became clipped and authoritative. Mira attended supper with the household and read quietly by the fire.';
    assert.equal(developmentScaleReady(
        'batch',
        'Two months of command drills made the delivery clipped and authoritative.',
        context,
        { npc: { name: 'Mira', aliases: [] }, evidence: ['clipped authoritative delivery'], targeted: false, otherLabels: ['Rowan'] },
    ), false);
});

test('v1.0.23 multiple elapsed episodes remain separated by the next time-skip anchor', () => {
    const context = 'Two months passed. Rowan practiced formal debate until his cadence became measured. Five years passed. Mira trained daily in battlefield command until her orders became concise and decisive.';
    assert.equal(developmentScaleReady(
        'batch',
        'Five years of battlefield command training made her orders concise and decisive.',
        context,
        { npc: { name: 'Mira', aliases: [] }, evidence: ['concise decisive orders'], targeted: false, otherLabels: ['Rowan'] },
    ), true);
    assert.equal(developmentScaleReady(
        'batch',
        'Five years of battlefield command training made her orders concise and decisive.',
        'Two months passed. Rowan practiced formal debate until his cadence became measured. Mira later ordered tea.',
        { npc: { name: 'Mira', aliases: [] }, evidence: ['concise decisive orders'], targeted: false, otherLabels: ['Rowan'] },
    ), false);
});

test('v1.0.23 aggregate gradual candidate grounding uses independent differently-labelled observations without merging concepts', () => {
    assert.equal(durableProfileAggregateCandidateGrounded(
        'speech',
        'Soft and formal.',
        'Measured, soft-spoken, melodic and politely controlled.',
        [
            'measured delivery remains steady in public conversation',
            'soft-spoken delivery stays quiet under pressure',
            'melodic polite cadence recurs at formal gatherings',
        ],
    ), true);
    assert.equal(durableProfileAggregateCandidateGrounded(
        'speech',
        'Soft and formal.',
        'Measured, soft-spoken, melodic and politely controlled.',
        ['laughs at jokes', 'switches languages', 'speaks more loudly once'],
    ), false);
});

test('v1.0.23 gradual Speech can become ready from three independent differently-labelled observations', () => {
    const npc = createNpcRecord('Mira');
    npc.speech = 'Soft and formal.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const update = (evidence, speech = npc.speech) => ({
        id: npc.id,
        evidence: { speech: [evidence] },
        speechState: 'refine',
        speech,
        developmentScale: 'gradual',
        developmentReason: 'Repeated later scenes show a stable public speaking pattern.',
    });
    state = profileScan(state, update('analytical: measured delivery remains steady in public conversation'), 10, 100).state;
    state = profileScan(state, update('soft-spoken: soft-spoken delivery stays quiet under pressure'), 12, 101).state;
    const result = profileScan(
        state,
        update('melodic: melodic polite cadence recurs at formal gatherings', 'Measured, soft-spoken, melodic and politely controlled.'),
        14,
        102,
    );
    assert.equal(result.state.npcs[0].speech, 'Measured, soft-spoken, melodic and politely controlled.');
    assert.equal(result.report.profileDevelopment.find(row => row.field === 'speech')?.outcome, 'applied-aggregate-gradual');
});

test('v1.0.23 one shared time skip can independently update two NPCs without cross-authorization', () => {
    const ryu = createNpcRecord('Ryu');
    const sora = createNpcRecord('Sora');
    ryu.speech = 'Hesitant and sparse.';
    sora.speech = 'Bright and impulsive.';
    const result = mergeScanResult(
        { npcs: [ryu, sora], candidates: [], turn: 30 },
        {
            npcs: [],
            profileUpdates: [
                {
                    id: ryu.id,
                    evidence: { speech: ['measured: measured polished formal cadence recurs during study'] },
                    speechState: 'refine',
                    speech: 'Measured, polished and formal in academic discussion.',
                    developmentScale: 'gradual',
                    developmentReason: 'Two months of practicing a measured formal cadence during study.',
                },
                {
                    id: sora.id,
                    evidence: { speech: ['melodic: soft-spoken melodic polite cadence recurs at gatherings'] },
                    speechState: 'refine',
                    speech: 'Soft-spoken, melodic and politely measured in formal gatherings.',
                    developmentScale: 'gradual',
                    developmentReason: 'Two months of practicing a soft-spoken melodic cadence for formal gatherings.',
                },
            ],
        },
        {
            turn: 40,
            sourceMessageId: 140,
            developmentContext: 'Two months passed. Ryu practiced a measured formal cadence during daily study until her academic discussion became polished and formal. Sora practiced a soft-spoken melodic cadence for formal gatherings every evening until her delivery became politely measured.',
        },
    );
    assert.match(result.state.npcs.find(npc => npc.id === ryu.id).speech, /Measured, polished/i);
    assert.match(result.state.npcs.find(npc => npc.id === sora.id).speech, /Soft-spoken, melodic/i);
    const rows = result.report.profileDevelopment.filter(row => row.field === 'speech');
    assert.equal(rows.filter(row => row.outcome === 'applied-batch').length, 2);
    assert.ok(rows.every(row => row.episode?.npcBound === true));
});

test('v1.0.23 inferred time-compressed development also reaches Mannerisms and Behavioral Profile', () => {
    const npc = createNpcRecord('Mira');
    npc.mannerisms = ['Folds her hands when waiting.'];
    npc.behaviorProfile = ['Defers difficult decisions to senior staff.'];
    const result = mergeScanResult(
        { npcs: [npc], candidates: [], turn: 20 },
        {
            npcs: [],
            profileUpdates: [{
                id: npc.id,
                evidence: {
                    mannerisms: ['poise: practices a formal bow until it becomes habitual'],
                    behaviorProfile: ['leadership: repeatedly makes routine administrative decisions independently'],
                },
                mannerismState: 'refine',
                mannerisms: ['Uses a practiced formal bow when greeting officials.'],
                behaviorProfileState: 'refine',
                // Lever-shaped (1.0.63): a bare routine description is not accepted as a Behavioral Lever.
                behaviorProfile: ['Independence/Agency: high - makes routine administrative decisions independently after checking the relevant records.'],
                developmentScale: 'gradual',
                developmentReason: 'Over two months of daily administrative practice and etiquette training, independent decisions and the formal bow became habitual.',
            }],
        },
        {
            turn: 30,
            sourceMessageId: 130,
            developmentContext: 'Over two months of daily administrative practice and etiquette training, Mira repeatedly made routine administrative decisions independently after checking records. Mira also practiced a formal bow each day until the greeting became habitual.',
        },
    );
    const current = result.state.npcs[0];
    assert.ok(current.mannerisms.some(value => /formal bow/i.test(value)));
    assert.ok(current.behaviorProfile.some(value => /administrative decisions independently/i.test(value)));
    const fields = new Set(result.report.profileDevelopment.filter(row => /mannerisms|behaviorProfile/.test(row.field)).map(row => row.field));
    assert.deepEqual(fields, new Set(['mannerisms', 'behaviorProfile']));
});

test('v1.0.23 diagnostic store is always bounded, filterable per NPC, and strips unsafe payload fields from export', () => {
    let now = 1000;
    const store = createDiagnosticStore({ limit: 8, now: () => now++ });
    for (let i = 0; i < 12; i += 1) {
        store.record('owner:chat', {
            type: 'refresh',
            npcIds: [i % 2 ? 'npc_a' : 'npc_b'],
            prompt: 'SECRET PROMPT',
            story: 'SECRET STORY',
            credentials: 'SECRET TOKEN',
            profileDevelopment: [{ npcId: i % 2 ? 'npc_a' : 'npc_b', field: 'speech', outcome: 'waiting-for-evidence', candidate: 'Measured cadence.', fieldReason: 'Repeated formal practice.' }],
        });
    }
    assert.equal(store.summary('owner:chat').operationCount, 8);
    assert.ok(store.records('owner:chat', { npcId: 'npc_a' }).every(row => row.npcIds.includes('npc_a')));
    const bundle = store.bundle('owner:chat', { applicationVersion: '1.0.23' });
    assert.equal(bundle.diagnosticVersion, DIAGNOSTIC_BUNDLE_VERSION);
    assert.equal(bundle.deltaApplicationVersion, '1.0.23');
    assert.equal(bundle.operations[0].profile[0].fieldReason, 'Repeated formal practice.');
    const exported = JSON.stringify(bundle);
    assert.doesNotMatch(exported, /SECRET PROMPT|SECRET STORY|SECRET TOKEN/);
    assert.equal(bundle.operations.length, 8);
});

test('secondary profile diagnostics use the actual durable field parser and formatter', () => {
    const core = fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');
    const block = core.slice(
        core.indexOf('function recordSecondaryProfileDiagnostics'),
        core.indexOf('function recordBirthdayDiagnostic'),
    );
    assert.match(block, /parseProfileDevelopmentEvidence\(field, item\)/);
    assert.match(block, /profileDevelopmentText\(field, item, mechanics\.DURABLE_PROFILE_LIMITS\.evidence\)/);
    assert.match(block, /profileDevelopmentText\(field, previousValue, 720\)/);
    assert.match(block, /profileDevelopmentText\(field, candidateValue, 720\)/);
    assert.doesNotMatch(block, /parseProfileDevelopmentEvidence\('speech', item\)/);
    assert.doesNotMatch(block, /profileDevelopmentText\('appearance', (?:previousValue|candidateValue), 720\)/);
});

test('diagnostic sanitizer preserves unknown numeric provenance as null without erasing real message zero', () => {
    const store = createDiagnosticStore({ limit: 4, now: () => 1234 });
    store.record('owner:chat', {
        type: 'scan',
        npcIds: ['npc_cerys'],
        profileDevelopment: [{
            npcId: 'npc_cerys',
            field: 'appearance',
            outcome: 'unchanged',
            episode: { detected: false, grounded: false, npcBound: null, anchorIndex: null, segmentCount: 0 },
            evidence: [
                { sourceMessageId: null, concept: 'bronze hair', sample: 'Burnished bronze hair.' },
                { sourceMessageId: 0, concept: 'opening', sample: 'Opening-message evidence.' },
            ],
        }],
    });
    const row = store.records('owner:chat')[0].profile[0];
    assert.equal(row.episode.anchorIndex, null);
    assert.equal(row.evidence[0].sourceMessageId, null);
    assert.equal(row.evidence[1].sourceMessageId, 0);
});

test('v1.0.23 per-NPC diagnostic visibility is presentation-only while Maintenance export uses the runtime store', () => {
    const experience = fs.readFileSync(new URL('../dossier-experience.js', import.meta.url), 'utf8');
    const tools = fs.readFileSync(new URL('../dossier-tools.js', import.meta.url), 'utf8');
    assert.match(experience, /const diagnosticVisibleNpcIds = new Set\(\)/);
    assert.match(experience, /diagnosticsForNpc/);
    assert.doesNotMatch(experience, /saveSettings.*diagnosticVisibleNpcIds|manualProfileFields.*diagnosticVisibleNpcIds/);
    assert.match(tools, /data-export-diagnostics/);
    assert.match(tools, /diagnosticBundle/);
    assert.match(tools, /clearDiagnostics/);
});
