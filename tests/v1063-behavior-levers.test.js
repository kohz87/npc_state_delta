import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileRefreshPrompt, createNpcRecord, isBehaviorLever, mergeScanResult, normalizeNpcRecord } from '../core.js';

const CONTEXT = 'Malia keeps a quiet household and enforces advance payment and dusk curfews. She sizes up every prospective boarder at the door before admitting them, and she avoids open confrontation, answering challenges with cold politeness.';
const HABITS = [
    'Keeps a quiet household and strictly enforces advance payment and dusk curfews.',
    'Sizes up prospective boarders carefully at the door before admitting them.',
];
function landlady(behaviorProfile = []) {
    const npc = createNpcRecord('Malia');
    npc.present = true;
    npc.personality = 'Reserved, practical and wary of strangers.';
    npc.behaviorProfile = behaviorProfile;
    return npc;
}
function scan(npc, update) {
    return mergeScanResult({ npcs: [npc], turn: 10 }, { npcs: [], profileUpdates: [{ id: npc.id, name: 'Malia', ...update }] }, { developmentContext: CONTEXT, sourceMessageId: 9, turn: 10 });
}

test('routines, duties, house rules and habits are not Behavioral Levers; labelled or tendency rules are', () => {
    for (const entry of HABITS) assert.equal(isBehaviorLever(entry), false, entry);
    assert.equal(isBehaviorLever('Habit: sizes up boarders at the door'), false, 'a "Habit:" label does not make a lever');
    for (const entry of [
        'Threat Sensitivity: high - assesses strangers before extending trust',
        'Conflict/Assertiveness: firm - enforces boundaries without apology',
        'Avoids open confrontation; answers challenges with cold politeness.',
        'When pressed, defers to written rules.',
    ]) assert.equal(isBehaviorLever(entry), true, entry);
});

test('a scan cannot add habit entries as levers; they become Mannerisms evidence instead', () => {
    const result = scan(landlady(), {
        behaviorProfileState: 'refine',
        behaviorProfile: [...HABITS, 'Conflict/Assertiveness: firm - avoids open confrontation and answers challenges with cold politeness'],
        evidence: { behaviorProfile: ['avoids open confrontation, answering challenges with cold politeness'] },
    });
    const npc = result.state.npcs[0];
    assert.ok(npc.behaviorProfile.every(isBehaviorLever), JSON.stringify(npc.behaviorProfile));
    assert.ok(npc.behaviorProfile.some(entry => /Conflict\/Assertiveness/.test(entry)));
    assert.ok(!npc.behaviorProfile.some(entry => /curfews|boarders/.test(entry)));
    assert.ok((npc.profileEvidence?.mannerisms || []).some(entry => /boarders/.test(entry)), 'the habit is kept as Mannerisms evidence');
});

test('a behavior update made only of habits cannot clear or replace existing levers', () => {
    const levers = ['Threat Sensitivity: high - assesses strangers before extending trust'];
    for (const state of ['refine', 'evolve']) {
        const result = scan(landlady([...levers]), { behaviorProfileState: state, behaviorProfile: HABITS, behaviorProfileReason: 'She runs the boarding house strictly.' });
        assert.deepEqual(result.state.npcs[0].behaviorProfile, levers, state);
    }
});

test('manual edits and stored dossiers are not filtered', () => {
    const npc = normalizeNpcRecord({ ...landlady(), behaviorProfile: HABITS });
    assert.deepEqual(npc.behaviorProfile, HABITS);
});

test('a refine that replaces stored habit entries with grounded new levers is accepted and retires the habits', () => {
    const disposition = 'Disposition: reserved - practical and guarded with strangers';
    const result = scan(landlady([disposition, ...HABITS]), {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            disposition,
            'Conflict/Assertiveness: low - avoids open confrontation, answers challenges with cold politeness',
            'Threat Sensitivity: high - sizes up every stranger before admitting them',
        ],
        evidence: { behaviorProfile: ['avoids open confrontation, answering challenges with cold politeness', 'sizes up every prospective boarder at the door before admitting them'] },
    });
    const levers = result.state.npcs[0].behaviorProfile;
    assert.ok(!levers.some(entry => /curfews|quiet household/.test(entry)), JSON.stringify(levers));
    assert.ok(levers.some(entry => /^Conflict\/Assertiveness:/.test(entry)), 'lever label words need not appear in the story');
    assert.ok(levers.some(entry => /^Threat Sensitivity:/.test(entry)));
});

test('an ungrounded new lever is dropped on its own; established levers a partial refine omits stay', () => {
    const disposition = 'Disposition: reserved - practical and guarded with strangers';
    const threat = 'Threat Sensitivity: high - assesses strangers before extending trust';
    const result = scan(landlady([disposition, threat, ...HABITS]), {
        behaviorProfileState: 'refine',
        behaviorProfile: [
            disposition,
            'Conflict/Assertiveness: low - avoids open confrontation, answers challenges with cold politeness',
            'Analytical Style: reckless - gambles on long odds for the thrill of it',
        ],
        evidence: { behaviorProfile: ['avoids open confrontation, answering challenges with cold politeness'] },
    });
    const levers = result.state.npcs[0].behaviorProfile;
    assert.ok(levers.some(entry => /^Conflict\/Assertiveness:/.test(entry)), 'grounded addition kept');
    assert.ok(!levers.some(entry => /reckless/.test(entry)), 'ungrounded addition dropped');
    assert.ok(levers.includes(threat), 'omitted established lever survives a partial refine');
    assert.ok(!levers.some(entry => /curfews|boarders/.test(entry)), 'stored habits still retire');
});

test('an existing list gains the same new levers that seeding an empty list would accept', () => {
    const disposition = 'Disposition: reserved - practical and guarded';
    const proposal = [
        'Threat Sensitivity: high - wary of strangers until they prove themselves',
        'Conflict/Assertiveness: firm - holds her ground with calm silence when challenged',
        'Analytical Style: reckless - gambles on long odds for the thrill of it',
    ];
    const context = '[m1] Malia studies the stranger from the doorway for a long moment before she unbars the door. [m2] When he argues, Malia simply waits in silence until he pays.';
    const run = (stored, behaviorProfile) => {
        const npc = landlady(stored);
        npc.personality = 'Reserved, shrewd and wary of strangers; pragmatic and unsentimental.';
        return mergeScanResult({ npcs: [npc], turn: 10 }, { npcs: [], profileUpdates: [{ id: npc.id, name: 'Malia', behaviorProfileState: 'refine', behaviorProfile }] },
            { developmentContext: context, sourceMessageId: 2, turn: 10 }).state.npcs[0].behaviorProfile;
    };
    const seeded = run([], proposal);
    assert.ok(seeded.length >= 1 && !seeded.some(entry => /reckless/.test(entry)), JSON.stringify(seeded));
    assert.deepEqual(run([disposition], [disposition, ...proposal]), [disposition, ...seeded]);
});

const STORED = ['Disposition: reserved - practical and guarded', ...HABITS];
function refresh(update) {
    const npc = landlady([...STORED]);
    return mergeScanResult({ npcs: [npc], turn: 10 }, { npcs: [], profileUpdates: [{ id: npc.id, name: 'Malia', ...update }] }, {
        developmentContext: '[m1] Malia pours tea for the new boarder.', sourceMessageId: 1, turn: 10,
        developmentSingleTarget: true, allowTargetedDurableSeed: true,
    });
}
const behaviorOutcomes = result => (result.report?.profileDevelopment || []).filter(row => row.field === 'behaviorProfile').map(row => row.outcome);

test('Refresh names stored non-lever entries only for that target and only when unlocked', () => {
    const args = { transcript: '[m1] Malia pours tea.', userName: 'Ari', charName: 'Narrator' };
    const prompt = buildProfileRefreshPrompt({ ...args, targetNpc: landlady([...STORED]) });
    const hint = prompt.split('\n').find(line => line.startsWith('Stored behaviorProfile entries'));
    assert.ok(hint && HABITS.every(entry => hint.includes(entry)) && !hint.includes('Disposition:'), hint);
    assert.ok(prompt.indexOf(hint) > prompt.indexOf('Existing dossier (current authority)'), 'hint stays after the shared prefix');
    assert.ok(!buildProfileRefreshPrompt({ ...args, targetNpc: landlady([STORED[0]]) }).includes('Stored behaviorProfile entries'));
    const locked = landlady([...STORED]);
    locked.manualProfileFields = ['behaviorProfile'];
    assert.ok(!buildProfileRefreshPrompt({ ...args, targetNpc: locked }).includes('Stored behaviorProfile entries'));
});

test('a lever restating a stored habit is grounded by that entry; unrelated levers are not', () => {
    const restated = refresh({ behaviorProfileState: 'refine', behaviorProfile: [
        STORED[0],
        'Conflict/Assertiveness: firm - strictly enforces advance payment and curfews',
        'Threat Sensitivity: high - sizes up prospective boarders carefully before admitting them',
    ] });
    assert.deepEqual(restated.state.npcs[0].behaviorProfile.filter(entry => !isBehaviorLever(entry)), []);
    assert.equal(restated.state.npcs[0].behaviorProfile.length, 3);
    assert.deepEqual(behaviorOutcomes(restated), ['applied-refine']);
    const unrelated = refresh({ behaviorProfileState: 'refine', behaviorProfile: [STORED[0], 'Analytical Style: reckless - gambles on long odds for the thrill of it'] });
    assert.deepEqual(unrelated.state.npcs[0].behaviorProfile, [STORED[0]], 'unrelated lever dropped; habits the refine omitted retire');
});

test('diagnostics explain why stored non-lever entries survived', () => {
    assert.deepEqual(behaviorOutcomes(refresh({ personalityState: 'keep' })), ['not-provided']);
    assert.deepEqual(behaviorOutcomes(refresh({ behaviorProfileState: 'refine', behaviorProfile: HABITS })), ['non-lever-only']);
});
