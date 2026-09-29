import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProfileRefreshPrompt,
    calendarDayNumber,
    createNpcRecord,
    mergeScanResult,
    normalizeNpcRecord,
    setActiveCalendarConfig,
    storyDayFromText,
} from '../core.js';

const CALENDAR = Object.freeze({
    era: 'CY',
    months: [
        { name: 'Goldfield', days: 30 },
        { name: 'Leafturn', days: 30 },
        { name: 'Deepfrost', days: 30 },
    ],
});
const worldState = date => `<details><summary>World State</summary>Time | ${date} | dusk\nLocation | The Grey Post</details>\nElena counts the coin.`;
const BEFORE = 'Timid and deferential; endures mistreatment silently.';
const CANDIDATE = 'Candid and self-assured; bargains openly and objects to unfair treatment.';

test.beforeEach(() => setActiveCalendarConfig(CALENDAR));
test.afterEach(() => setActiveCalendarConfig(null));

function scan(state, evidence, personality, { turn, message, date }) {
    const npc = state.npcs[0];
    return mergeScanResult(state, { npcs: [], profileUpdates: [{
        id: npc.id, evidence: { personality: [evidence] }, personalityState: 'refine', personality, developmentScale: 'gradual',
    }] }, { turn, sourceMessageId: message, calendarSource: date ? worldState(date) : '' });
}

function elena() {
    const npc = createNpcRecord('Elena');
    npc.personality = BEFORE;
    return { npcs: [npc], candidates: [], turn: 10 };
}

test('v1.0.77 story days come from a dated World State block', () => {
    assert.equal(calendarDayNumber('CY308, Leafturn 3', CALENDAR) - calendarDayNumber('CY308, Goldfield 28', CALENDAR), 5);
    assert.equal(storyDayFromText(worldState('CY308, Leafturn 3')), calendarDayNumber('CY308, Leafturn 3', CALENDAR));
    assert.equal(storyDayFromText('No world state here.'), null);
});

test('v1.0.77 a trend confirmed a week of story time later changes Personality, even a few messages apart', () => {
    let state = elena();
    state = scan(state, 'candid: openly objects that the rent is unfair and bargains self-assured', BEFORE, { turn: 11, message: 60, date: 'CY308, Goldfield 2' }).state;
    const result = scan(state, 'candid: openly objects the factor price is unfair and bargains self-assured', CANDIDATE, { turn: 12, message: 62, date: 'CY308, Goldfield 12' });
    assert.equal(result.state.npcs[0].personality, CANDIDATE);
    assert.equal(result.report.profileDevelopment.find(row => row.field === 'personality')?.requiredObservations, 2);
});

test('v1.0.77 story time outranks message distance: the same day stays at three observations', () => {
    let state = elena();
    state = scan(state, 'candid: openly objects that the rent is unfair and bargains self-assured', BEFORE, { turn: 11, message: 60, date: 'CY308, Goldfield 2' }).state;
    const result = scan(state, 'candid: openly objects the factor price is unfair and bargains self-assured', CANDIDATE, { turn: 40, message: 160, date: 'CY308, Goldfield 4' });
    assert.equal(result.state.npcs[0].personality, BEFORE, 'two days apart is close together however many messages passed');
});

test('v1.0.77 without World State dates the message/turn fallback still applies', () => {
    let state = elena();
    state = scan(state, 'candid: openly objects that the rent is unfair and bargains self-assured', BEFORE, { turn: 11, message: 60 }).state;
    const far = scan(state, 'candid: openly objects the factor price is unfair and bargains self-assured', CANDIDATE, { turn: 40, message: 150 });
    assert.equal(far.state.npcs[0].personality, CANDIDATE);
});

test('v1.0.77 a contrary sighting breaks the trend so it has to start again', () => {
    let state = elena();
    state = scan(state, 'confident: moves with quick confident steps and bargains self-assured', BEFORE, { turn: 11, message: 60, date: 'CY308, Goldfield 2' }).state;
    state = scan(state, 'cowed: timid and shrinking when the factor raises his voice', BEFORE, { turn: 12, message: 64, date: 'CY308, Goldfield 5' }).state;
    const concepts = state.npcs[0].personalityDevelopment.concepts.map(record => record.concept);
    assert.ok(!concepts.includes('confident'), 'the confident trend was broken');
    const result = scan(state, 'confident: confident steps, bargains self-assured with a new buyer', 'Confident and self-assured; bargains openly.', { turn: 13, message: 70, date: 'CY308, Goldfield 14' });
    assert.equal(result.state.npcs[0].personality, BEFORE, 'one sighting after the break is a new trend, not a confirmation');
});

test('v1.0.77 Refresh measures unchanged traits in story days when the chat is dated', () => {
    const npc = normalizeNpcRecord({
        name: 'Elena',
        personality: BEFORE,
        fieldChanges: { personality: 5 },
        fieldChangeDays: { personality: calendarDayNumber('CY308, Goldfield 1', CALENDAR) },
    });
    const line = options => buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: npc, ...options }).split('\n').find(text => text.startsWith('Stored ')) || '';
    assert.match(line({ turn: 12, storyDay: calendarDayNumber('CY308, Leafturn 5', CALENDAR) }), /^Stored personality unchanged for 30\+ story days/);
    assert.equal(line({ turn: 80, storyDay: calendarDayNumber('CY308, Goldfield 20', CALENDAR) }), '', 'many turns but few story days is not stale');
    assert.match(line({ turn: 80 }), /^Stored personality unchanged for 30\+ turns/, 'without a story day the turn rule applies');
});

test('v1.0.77 merges stamp the story day on changed stable fields', () => {
    const npc = createNpcRecord('Elena');
    npc.personality = BEFORE;
    const result = mergeScanResult({ npcs: [npc], candidates: [], turn: 10 }, {
        npcs: [{ id: npc.id, name: 'Elena', background: 'Daughter of the late Master Corin; now owns The Grey Post.' }],
    }, { turn: 11, sourceMessageId: 60, calendarSource: worldState('CY308, Goldfield 9'), developmentContext: 'Elena, daughter of the late Master Corin, now owns The Grey Post.' });
    const record = result.state.npcs[0];
    assert.ok(Number.isInteger(record.fieldChanges.background));
    assert.equal(record.fieldChangeDays.background, calendarDayNumber('CY308, Goldfield 9', CALENDAR));
    assert.equal(normalizeNpcRecord({ name: 'X' }).fieldChangeDays, undefined, 'undated records stay unchanged');
});
