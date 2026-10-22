import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import {
    buildNarrationCaptureParts, calendarPromptContext, getActiveCalendarConfig, hostedStoryDate, setActiveCalendarConfig, setStoryClockSource,
    storyClockDate, storyCurrentDate,
} from '../core.js';
import { effectiveChronologicalAge } from '../birthday.js';

// Two v1 features back under Story Block v2 (V1 audit #8 and #9):
//  1. Delta's own prompt in Story Block's prompt size. Delta sends its live dossier (and, with one-pass
//     capture on, its instruction) under its own prompt keys; its `ownPrompt` hook tells the host what, so
//     the host's prompt size shows it as a row of its own and counts it toward the share of the context.
//  2. The story's date from Story Director's clock. Hosted with Story Director, birthdays and ages follow
//     `director.time` on `director.calendar` (read through the host's queries, never a hard dependency)
//     where Delta's own calendar agrees with it; without Story Director (or with the calendar kept as
//     "mine") Delta's own dates stand, exactly as before.

const GREGORIAN = [
    ['January', 31], ['February', 28], ['March', 31], ['April', 30], ['May', 31], ['June', 30],
    ['July', 31], ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31],
].map(([name, days]) => ({ name, days }));
const SD_GREGORIAN = { preset: 'gregorian', era: '', months: GREGORIAN, leapYears: true };
const FANTASY = [{ name: 'Frostmoon', days: 30 }, { name: 'Thaw', days: 28 }, { name: 'Bloom', days: 31 }];
const SD_FANTASY = { preset: 'custom', era: 'AR', months: FANTASY, leapYears: false };

// Minutes since year 0, January 1, 00:00 (proleptic Gregorian, as Story Director counts), from the
// platform's own date maths: an oracle independent of the code under test.
function gregorianMinutes(year, month, day, minute = 0) {
    const at = new Date(Date.UTC(2000, 0, 1));
    at.setUTCFullYear(year, month - 1, day);
    const epoch = new Date(Date.UTC(2000, 0, 1));
    epoch.setUTCFullYear(0, 0, 1);
    return Math.round((at.getTime() - epoch.getTime()) / 60000) + minute;
}
// Minutes on the fantasy calendar (89 days a year, no leap years).
const fantasyMinutes = (year, monthIndex, day) => ((year * 89) + FANTASY.slice(0, monthIndex).reduce((sum, m) => sum + m.days, 0) + day - 1) * 1440;

test.afterEach(() => {
    setStoryClockSource(null);
    setActiveCalendarConfig(null);
});

// ---- the date arithmetic ----

test('storyClockDate: Story Director\'s Gregorian clock on Delta\'s numeric calendar (no calendar of its own)', () => {
    for (const [year, month, day] of [[611, 3, 15], [612, 2, 29], [2000, 12, 31], [1, 1, 1], [0, 1, 1], [1900, 3, 1]]) {
        const minutes = gregorianMinutes(year, month, day, 8 * 60 + 40);
        assert.deepEqual(storyClockDate({ minutes, calendar: SD_GREGORIAN }, null), { era: '', year, month: String(month).padStart(2, '0'), day }, `${year}-${month}-${day}`);
    }
    // Before year 0: the last day of year -1.
    assert.deepEqual(storyClockDate({ minutes: -1, calendar: SD_GREGORIAN }, null), { era: '', year: -1, month: '12', day: 31 });
    // A Gregorian-length calendar without leap years, or another calendar, is not Delta's numeric one.
    assert.equal(storyClockDate({ minutes: 0, calendar: { ...SD_GREGORIAN, leapYears: false } }, null), null);
    assert.equal(storyClockDate({ minutes: 0, calendar: SD_FANTASY }, null), null);
});

test('storyClockDate: on Delta\'s own months only when Story Director\'s are the same months', () => {
    const own = { era: 'AR', months: FANTASY.map(month => ({ ...month, name: month.name.toUpperCase() })) };
    const minutes = fantasyMinutes(611, 2, 12);
    assert.deepEqual(storyClockDate({ minutes, calendar: SD_FANTASY }, own), { era: 'AR', year: 611, month: 'BLOOM', day: 12 }, 'Delta\'s own month names and era');
    assert.deepEqual(storyClockDate({ minutes: fantasyMinutes(3, 0, 1), calendar: SD_FANTASY }, own), { era: 'AR', year: 3, month: 'FROSTMOON', day: 1 });
    // Different months (a name, a length, the order) or a different count: Delta's own dates stand.
    assert.equal(storyClockDate({ minutes, calendar: { ...SD_FANTASY, months: [FANTASY[0], { name: 'Thaw', days: 29 }, FANTASY[2]] } }, own), null);
    assert.equal(storyClockDate({ minutes, calendar: { ...SD_FANTASY, months: [FANTASY[1], FANTASY[0], FANTASY[2]] } }, own), null);
    assert.equal(storyClockDate({ minutes, calendar: { ...SD_FANTASY, months: FANTASY.slice(0, 2) } }, own), null);
    assert.equal(storyClockDate({ minutes, calendar: SD_GREGORIAN }, own), null);
    // Story Director's leap day that Delta's calendar has not got (the 29th of a 28-day month): none that day.
    const gregorianOwn = { era: '', months: GREGORIAN };
    assert.equal(storyClockDate({ minutes: gregorianMinutes(612, 2, 29), calendar: SD_GREGORIAN }, gregorianOwn), null);
    assert.deepEqual(storyClockDate({ minutes: gregorianMinutes(612, 3, 1), calendar: SD_GREGORIAN }, gregorianOwn), { era: '', year: 612, month: 'March', day: 1 });
});

test('storyClockDate: a malformed clock is no date', () => {
    for (const clock of [null, {}, { minutes: 1.5, calendar: SD_GREGORIAN }, { minutes: '10', calendar: SD_GREGORIAN }, { minutes: Number.MAX_VALUE, calendar: SD_GREGORIAN },
        { minutes: 0, calendar: null }, { minutes: 0, calendar: { months: [] } }, { minutes: 0, calendar: { months: [{ name: 'A', days: 0 }] } },
        { minutes: 0, calendar: { months: [{ name: 'A', days: 'x' }] } }, { minutes: 1e15, calendar: SD_FANTASY }]) {
        assert.equal(storyClockDate(clock, null), null, JSON.stringify(clock));
    }
});

// ---- the date Delta uses ----

test('with no clock source (Delta alone, or no Story Director) the date is Delta\'s own manual clock, as before', () => {
    setActiveCalendarConfig({ era: 'AR', months: FANTASY, currentYear: 600, currentMonth: 'Thaw', currentDay: 3 });
    assert.equal(hostedStoryDate(), null);
    assert.deepEqual(storyCurrentDate({ era: 'AR', months: FANTASY, currentYear: 600, currentMonth: 'Thaw', currentDay: 3 }), { era: 'AR', year: 600, month: 'Thaw', day: 3 });
    // A source that answers null (not hosted, no Story Director, its clock unset) or throws: the same.
    for (const source of [() => null, () => { throw new Error('gone'); }, () => ({ minutes: null, calendar: SD_FANTASY })]) {
        setStoryClockSource(source);
        assert.equal(hostedStoryDate(), null);
        assert.equal(calendarPromptContext(getActiveCalendarConfig()), 'Current grounded world date=AR600, Thaw 3.');
    }
});

test('hosted with Story Director: ages and the prompt\'s current date follow its clock; a given date still wins', () => {
    setActiveCalendarConfig({ era: 'AR', months: FANTASY, currentYear: 600, currentMonth: 'Thaw', currentDay: 3 });
    const npc = { name: 'Mira', birthDate: { era: 'AR', year: 590, month: 'Bloom', day: 10 }, birthDateSource: 'established', birthDateYearSource: 'established' };
    assert.equal(effectiveChronologicalAge(npc), '9', 'the manual clock: AR600, Thaw 3');
    let minutes = fantasyMinutes(611, 2, 12);
    setStoryClockSource(() => ({ minutes, calendar: SD_FANTASY }));
    assert.deepEqual(hostedStoryDate(), { era: 'AR', year: 611, month: 'Bloom', day: 12 });
    assert.equal(effectiveChronologicalAge(npc), '21', 'AR611, Bloom 12: her birthday has passed');
    assert.equal(calendarPromptContext(getActiveCalendarConfig()), 'Current grounded world date=AR611, Bloom 12.');
    // The clock moves on, and back (a swipe or a delete): the age follows it either way.
    minutes = fantasyMinutes(611, 2, 9);
    assert.equal(effectiveChronologicalAge(npc), '20', 'the day before her birthday');
    minutes = fantasyMinutes(612, 2, 10);
    assert.equal(effectiveChronologicalAge(npc), '22');
    // A reference date the caller gives (a World State date in v1's text) still wins over the clock.
    assert.equal(effectiveChronologicalAge(npc, undefined, { era: 'AR', year: 600, month: 'Thaw', day: 3 }), '9');
});

test('prompts: the capture rules stay byte-identical; only the current-date line, already dynamic, changes', () => {
    const options = { transcript: 'USER: hi', userName: 'Astra', charName: 'Narrator', existingNpcs: [] };
    // Delta with no calendar of its own (numeric dates): Story Director's Gregorian clock changes no prompt text.
    const plain = buildNarrationCaptureParts(options);
    setStoryClockSource(() => ({ minutes: gregorianMinutes(611, 3, 15), calendar: SD_GREGORIAN }));
    const clocked = buildNarrationCaptureParts(options);
    assert.equal(clocked.rules, plain.rules);
    assert.equal(clocked.context, plain.context, 'no date line on a numeric calendar, as before');
    // Delta's own calendar: the rules are unchanged; the context's date line carries the clock's date in
    // place of the manual clock's.
    setStoryClockSource(null);
    setActiveCalendarConfig({ era: 'AR', months: FANTASY, currentYear: 600, currentMonth: 'Thaw', currentDay: 3 });
    const own = buildNarrationCaptureParts(options);
    setStoryClockSource(() => ({ minutes: fantasyMinutes(611, 2, 12), calendar: SD_FANTASY }));
    const hosted = buildNarrationCaptureParts(options);
    assert.equal(hosted.rules, own.rules, 'the in-prompt rules are byte-identical');
    assert.match(own.context, /^Current grounded world date=AR600, Thaw 3\.$/m);
    assert.match(hosted.context, /^Current grounded world date=AR611, Bloom 12\.$/m);
    assert.equal(hosted.context.replace(/^Current grounded world date=.*$/m, ''), own.context.replace(/^Current grounded world date=.*$/m, ''), 'nothing else changed');
});

// ---- the adapter on a whole Story Block host (tests/vendor/story-block, see its VERSION) ----

// A stand-in for Story Director: only its two time queries (`minutes` null until the story sets it).
const director = clock => ({
    id: 'story-director', name: 'Story Director',
    queries: {
        'director.time': () => ({ minutes: clock.minutes, text: '' }),
        'director.calendar': () => structuredClone(clock.calendar),
    },
});

async function suite(t, { modules = [], preview = null, enabled = true, calendarOwn = () => false, contextSize = 8192 } = {}) {
    t.mock.method(console, 'warn', () => {});
    const host = await createHost({ modules, st: { contextSize } });
    t.after(() => host.close());
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const state = { enabled };
    const api = { isEnabled: () => state.enabled, getNpc: () => null, relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }) };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [], manage: { preview: () => preview ?? { label: 'NPC State Delta', text: '', parts: [] } } },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null, calendarOwn,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true, 'the adapter registers');
    t.after(() => adapter.stop());
    return { host, adapter, state };
}

const DOSSIER = `NPC STATE (present):\n- Mira: IDENTITY ${'quiet smith with soot on her hands; '.repeat(60)}`;
const CAPTURE = `One-pass capture: ${'rule '.repeat(400)}`;
const PREVIEW = { label: 'NPC State Delta', text: '', parts: [{ label: 'Live dossier', text: DOSSIER, tokens: 1 }, { label: 'One-pass capture instruction (end of the prompt)', text: CAPTURE, tokens: 1 }] };

test('Delta\'s own prompt reaches the host\'s prompt size and share; nothing while Delta is off', async t => {
    const { host, state } = await suite(t, { preview: PREVIEW, contextSize: 6000 });
    const { own } = host.turn.previewFit();
    assert.deepEqual(own.map(part => [part.module, part.label, part.text]), [
        [MODULE_ID, 'Live dossier', DOSSIER],
        [MODULE_ID, 'One-pass capture instruction (end of the prompt)', CAPTURE],
    ]);
    await host.send('Hello.', 'Mira looks up.');
    const fit = host.turn.previewFit().fit;
    assert.equal(fit.own, own.reduce((sum, part) => sum + part.tokens, 0), 'counted toward the share');
    assert.ok(!host.st.promptLog.some(entry => String(entry.value ?? '').includes('quiet smith')), 'Story Block never sends Delta\'s text');
    state.enabled = false;
    assert.deepEqual(host.turn.previewFit().own, [], 'Delta off: nothing of its own');
});

test('Delta with nothing to send (no present NPC): no row of its own', async t => {
    const { host } = await suite(t, {});
    assert.deepEqual(host.turn.previewFit().own, []);
});

test('storyClock: Story Director\'s minutes and calendar while hosted; null alone, unset, or with the calendar kept here', async t => {
    const clock = { minutes: gregorianMinutes(611, 3, 15), calendar: SD_GREGORIAN };
    const withSd = await suite(t, { modules: [director(clock)] });
    assert.deepEqual(withSd.adapter.storyClock(), { minutes: clock.minutes, calendar: { era: '', months: GREGORIAN, leapYears: true } });
    assert.deepEqual(storyClockDate(withSd.adapter.storyClock(), null), { era: '', year: 611, month: '03', day: 15 });
    clock.minutes = null;
    assert.equal(withSd.adapter.storyClock(), null, 'the story has not set the time yet');
    // Story Block alone (no Story Director): its queries are unknown, so no clock and no error.
    const alone = await suite(t, {});
    assert.equal(alone.adapter.storyClock(), null);
    // The reader keeps the calendar in Delta (Source of truth: calendar "mine").
    const mine = await suite(t, { modules: [director({ minutes: 0, calendar: SD_GREGORIAN })], calendarOwn: () => true });
    assert.equal(mine.adapter.storyClock(), null);
    // Not hosted (stopped): none.
    const gone = await suite(t, { modules: [director({ minutes: 0, calendar: SD_GREGORIAN })] });
    gone.adapter.stop();
    assert.equal(gone.adapter.storyClock(), null);
});

test('end to end: hosted with Story Director, Delta\'s age arithmetic reads the clock through the adapter', async t => {
    const clock = { minutes: fantasyMinutes(611, 2, 12), calendar: SD_FANTASY };
    const { adapter } = await suite(t, { modules: [director(clock)] });
    setActiveCalendarConfig({ era: 'AR', months: FANTASY });
    setStoryClockSource(() => adapter.storyClock());
    const npc = { name: 'Mira', birthDate: { era: 'AR', year: 590, month: 'Bloom', day: 10 }, birthDateSource: 'established', birthDateYearSource: 'established' };
    assert.equal(effectiveChronologicalAge(npc), '21');
    clock.minutes = fantasyMinutes(611, 2, 9);
    assert.equal(effectiveChronologicalAge(npc), '20');
});
