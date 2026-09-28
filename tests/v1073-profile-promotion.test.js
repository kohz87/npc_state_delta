import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileRefreshPrompt, createNpcRecord, mergeScanResult, normalizeNpcRecord } from '../core.js';

function profileScan(state, update, turn, sourceMessageId, developmentContext = '') {
    return mergeScanResult(state, { npcs: [], profileUpdates: [update] }, { turn, sourceMessageId, developmentContext });
}

function speechRow(result) {
    return result.report.profileDevelopment.find(row => row.field === 'speech');
}

test('v1.0.73 labelled quotes accumulate into a grounded Speech change', () => {
    const npc = createNpcRecord('Linnea');
    npc.speech = 'Timid, strained and quiet.';
    let state = { npcs: [npc], candidates: [], turn: 70 };
    const update = (evidence, speech = npc.speech) => ({
        id: npc.id, evidence: { speech: [evidence] }, speechState: 'refine', speech, developmentScale: 'gradual',
    });
    state = profileScan(state, update('formal aphorisms: "The merchant thought he bought his life."'), 75, 150).state;
    state = profileScan(state, update('formal aphorisms: "He gave away his coin to escape his own shadow."'), 78, 156).state;
    const result = profileScan(state, update('formal aphorisms: "The ground gives more than it takes."', 'Calm and measured; speaks in formal aphorisms.'), 81, 162);
    assert.equal(result.state.npcs[0].speech, 'Calm and measured; speaks in formal aphorisms.');
    assert.match(result.state.npcs[0].speech, /formal aphorisms/);
});

test('v1.0.73 bare quotes still cannot ground a description of how an NPC speaks', () => {
    const npc = createNpcRecord('Linnea');
    npc.speech = 'Timid, strained and quiet.';
    let state = { npcs: [npc], candidates: [], turn: 70 };
    const update = (evidence, speech = npc.speech) => ({
        id: npc.id, evidence: { speech: [evidence] }, speechState: 'refine', speech, developmentScale: 'gradual',
    });
    state = profileScan(state, update('"The merchant thought he bought his life."'), 75, 150).state;
    state = profileScan(state, update('"He gave away his coin to escape his own shadow."'), 78, 156).state;
    const result = profileScan(state, update('"The ground gives more than it takes."', 'Calm and measured; speaks in formal aphorisms.'), 81, 162);
    assert.equal(result.state.npcs[0].speech, 'Timid, strained and quiet.');
    assert.notEqual(speechRow(result)?.outcome, 'applied');
});

test('v1.0.73 lever evidence keeps two observations per category instead of four shared slots', () => {
    const record = normalizeNpcRecord({
        name: 'Linnea',
        profileEvidence: { behaviorProfile: ['Honesty/Candor: high - openly insists the rent is too high', 'Drive/Ambition: high - studies script late into the night', 'Loyalty: steady - keeps watch over the camp unasked', 'Care/Warmth: moderate - dresses the mare hoof gently', 'Threat Sensitivity: high - scans every doorway before entering', 'Analytical Style: careful - counts coin twice before paying']
            .map((item, i) => `[m${60 + i}] ${item}`) },
    });
    assert.equal(record.profileEvidence.behaviorProfile.length, 6, 'different categories no longer rotate each other out');
    const same = normalizeNpcRecord({
        name: 'Linnea',
        profileEvidence: { behaviorProfile: [
            '[m10] Honesty/Candor: high - argues the rent is unfair at the inn',
            '[m20] Honesty/Candor: high - tells the guard captain his plan will fail',
            '[m30] Honesty/Candor: high - admits to the scribe she lied about her age',
        ] },
    });
    assert.deepEqual(same.profileEvidence.behaviorProfile.map(item => item.slice(0, 5)), ['[m20]', '[m30]'], 'one category keeps its two newest observations');
});

test('v1.0.73 a second sighting still swings the lever after unrelated behaviour arrives in between', () => {
    const npc = createNpcRecord('Linnea');
    npc.personality = 'Quietly resilient and watchful.';
    npc.behaviorProfile = ['Conflict/Assertiveness: low - avoids open defiance'];
    let state = { npcs: [npc], candidates: [], turn: 30 };
    const evidenceOnly = item => ({ id: npc.id, evidence: { behaviorProfile: [item] } });
    state = profileScan(state, evidenceOnly('[m62] Honesty/Candor: high - openly insists the rent is too high and bargains fairly'), 31, 62).state;
    for (const [i, item] of [
        'Drive/Ambition: high - studies script late into the night',
        'Loyalty: steady - keeps watch over the camp without being asked',
        'Care/Warmth: moderate - dresses the mare hoof gently',
        'Threat Sensitivity: high - scans every doorway before entering',
        'Analytical Style: careful - counts coin twice before paying',
    ].entries()) {
        state = profileScan(state, evidenceOnly(`[m${70 + i * 4}] ${item}`), 35 + i * 2, 70 + i * 4).state;
    }
    assert.ok(state.npcs[0].profileEvidence.behaviorProfile.some(item => /Honesty\/Candor/.test(item)), 'the first Honesty sighting is still waiting');
    const result = profileScan(state, {
        id: npc.id,
        evidence: { behaviorProfile: ['Honesty/Candor: high - tells the factor plainly that his price is unfair'] },
        behaviorProfileState: 'evolve',
        behaviorProfile: ['Conflict/Assertiveness: low - avoids open defiance', 'Honesty/Candor: high - says plainly when a price or plan is unfair'],
        behaviorProfileReason: 'She again openly challenged an unfair price.',
    }, 50, 100);
    assert.ok(result.state.npcs[0].behaviorProfile.some(entry => /^Honesty\/Candor: high/.test(entry)));
});

test('v1.0.73 Personality changes after two observations when they are far apart', () => {
    const before = 'Timid and deferential; endures mistreatment silently.';
    const candidate = 'Candid and self-assured; bargains openly and objects to unfair treatment.';
    const run = (secondMessage, secondTurn) => {
        const npc = createNpcRecord('Linnea');
        npc.personality = before;
        let state = { npcs: [npc], candidates: [], turn: 30 };
        const update = (evidence, personality = before) => ({
            id: npc.id, evidence: { personality: [evidence] }, personalityState: 'refine', personality, developmentScale: 'gradual',
        });
        state = profileScan(state, update('candid: openly objects that the rent is unfair and bargains self-assured'), 31, 62).state;
        return profileScan(state, update('candid: openly objects the factor price is unfair and bargains self-assured', candidate), secondTurn, secondMessage);
    };
    const far = run(150, 75);
    assert.equal(far.state.npcs[0].personality, candidate);
    assert.equal(far.report.profileDevelopment.find(row => row.field === 'personality')?.requiredObservations, 2);
    const close = run(66, 33);
    assert.equal(close.state.npcs[0].personality, before, 'two scenes close together are still not enough');
    assert.equal(close.report.profileDevelopment.find(row => row.field === 'personality')?.outcome, 'waiting-for-evidence');
});

test('v1.0.73 Refresh names long-unchanged stable fields for re-checking', () => {
    const npc = normalizeNpcRecord({
        name: 'Linnea',
        personality: 'Enduring under harsh mistreatment.',
        speech: 'Timid and quiet.',
        behaviorProfile: ['Conflict/Assertiveness: low - endures servitude without open defiance'],
        fieldChanges: { personality: 32, speech: 70, behaviorProfile: 32 },
    });
    const prompt = options => buildProfileRefreshPrompt({ transcript: '[m170] Linnea tends the mounts.', targetNpc: npc, userName: 'Noc', charName: 'Ternia', ...options });
    assert.match(prompt({ turn: 85 }), /Stored personality\/behaviorProfile unchanged for 30\+ turns/);
    assert.doesNotMatch(prompt({ turn: 50 }), /unchanged for 30\+ turns/);
    assert.doesNotMatch(prompt({}), /unchanged for 30\+ turns/, 'without a turn the prompt is unchanged');
    const locked = normalizeNpcRecord({ ...npc, manualProfileFields: ['personality', 'behaviorProfile'] });
    assert.doesNotMatch(buildProfileRefreshPrompt({ transcript: '[m170] x', targetNpc: locked, turn: 85 }), /unchanged for 30\+ turns/, 'locked fields are never named');
});

test('v1.0.73 scanner prompts still carry only the newest four lever observations', () => {
    const npc = normalizeNpcRecord({
        name: 'Linnea',
        behaviorProfile: ['Conflict/Assertiveness: low - avoids open defiance'],
        profileEvidence: { behaviorProfile: ['Honesty/Candor: high - openly insists the rent is too high', 'Drive/Ambition: high - studies script late into the night', 'Loyalty: steady - keeps watch over the camp unasked', 'Care/Warmth: moderate - dresses the mare hoof gently', 'Threat Sensitivity: high - scans every doorway before entering', 'Analytical Style: careful - counts coin twice before paying']
            .map((item, i) => `[m${60 + i}] ${item}`) },
    });
    const prompt = buildProfileRefreshPrompt({ transcript: '[m170] x', targetNpc: npc });
    const existing = JSON.parse(prompt.match(/Existing dossier \(current authority\): (\{.*\})/)[1]);
    assert.equal(existing.recentProfileEvidence.behaviorProfile.length, 4);
    assert.match(existing.recentProfileEvidence.behaviorProfile.at(-1), /Analytical Style/);
});
