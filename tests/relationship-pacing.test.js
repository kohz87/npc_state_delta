// Relationship pacing against the production mechanics and a synthetic Story Suite host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../src/storysuite-v2.js';
import { validateNpcSlice } from '../src/npc-meters.js';
import { DEFAULT_RELATIONSHIP_CAPS, normalizeNpcRecord } from '../core.js';
import { applyFocusedRelationshipDecisions } from '../src/relationship-pass.js';
import { DEFAULT_IMPACT_CRITERIA } from '../core-prompts-criteria.js';
import { DEFAULT_ALLOWANCE, flatDayProblems, fromFlatDay, impactDayProblems, toFlatDay, normalizeAllowance, pacingDefaults, spendEvent, spendFlatEvent } from '../src/relationship-pacing.js';
import { cutToTier, eventSummary, pacingNote, readEvent } from '../src/npc-meters-pacing.js';
import { FEATURE_GATE, FEATURE_MOOD_PULL, CONTEXT_BUDGET } from '../src/npc-meters-config.js';
import { gateApproach, readApproachRing } from '../npc-meters-gate.js';
import { createNpcPart } from '../src/npc-meters.js';
import { applyEvents, easeAxis, eventsFromMoves, moodBars, moodWord, restMood, restingMood } from '../npc-mood.js';
import { stepPull } from '../npc-instincts.js';
import { DAY, dossiers, suite, major, newestFlatDay } from './helpers/pacing-suite.js';

// Relationship pacing: points per event 1 / 2 / 3 / 6 and events per story day for each person
// (3 ordinary, 1 meaningful, 1 major, 1 extreme). An event over its allowance counts as the next tier down; the count is on the
// slice record (`impactDay`), so it replays. Story Director's clock is stood in for by a small module with `director.time`.

test('the allowance setting: a blank field is no limit (null), a missing one is the default, 0 is none, 0..99 whole numbers', () => {
    assert.deepEqual(normalizeAllowance(undefined), { ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    assert.deepEqual(normalizeAllowance({ ordinary: null, meaningful: '', major: 0, extreme: 250 }), { ordinary: null, meaningful: null, major: 0, extreme: 99 });
    assert.deepEqual(normalizeAllowance({ ordinary: '2.6', meaningful: 'x', major: -4 }), { ordinary: 3, meaningful: 1, major: 0, extreme: 1 });
});

test('the used tier: down the chain extreme > major > meaningful > ordinary, none left means nothing', () => {
    const allowance = normalizeAllowance();
    let record;
    const event = (tier, reply = `r${Math.random()}`) => {
        const out = spendEvent(record, { tier, reply, clockDay: 5, allowance });
        record = out.next ?? record;
        return out;
    };
    assert.equal(event('extreme').used, 'extreme');
    assert.equal(event('extreme').used, 'major', 'extreme is used up: the next one is a major');
    assert.equal(event('extreme').used, 'meaningful');
    assert.equal(event('major').used, 'ordinary');
    assert.equal(event('meaningful').used, 'ordinary');
    assert.equal(event('ordinary').used, 'ordinary');
    const none = event('extreme');
    assert.equal(none.used, null, 'every tier is used: ignored');
    assert.deepEqual(none.skipped, ['ordinary', 'meaningful', 'major', 'extreme']);
    assert.equal(pacingNote('major', null, ['ordinary', 'meaningful', 'major']), "today's ordinary, meaningful and major are used");
    assert.equal(pacingNote('major', 'meaningful', ['major']), "major counted as meaningful: today's major is used");
    assert.equal(pacingNote('major', 'major', []), '');
});

test('blank is no limit, 0 is none of that tier, a new story day starts again, an unknown tier or no clock is not paced', () => {
    const free = normalizeAllowance({ major: null });
    let record;
    for (let n = 0; n < 5; n += 1) {
        const out = spendEvent(record, { tier: 'major', reply: `a${n}`, clockDay: 1, allowance: free });
        assert.equal(out.used, 'major');
        record = out.next;
    }
    assert.equal(spendEvent(undefined, { tier: 'major', reply: 'z', clockDay: 1, allowance: normalizeAllowance({ major: 0 }) }).used, 'meaningful', '0 means none: counted as meaningful');
    const day1 = spendEvent(undefined, { tier: 'major', reply: 'a', clockDay: 1, allowance: normalizeAllowance() });
    assert.equal(spendEvent(day1.next, { tier: 'major', reply: 'b', clockDay: 1, allowance: normalizeAllowance() }).used, 'meaningful');
    assert.equal(spendEvent(day1.next, { tier: 'major', reply: 'b', clockDay: 2, allowance: normalizeAllowance() }).used, 'major', 'tomorrow the major is back');
    assert.deepEqual(spendEvent(day1.next, { tier: 'major', reply: 'b', clockDay: null, allowance: normalizeAllowance() }), { used: 'major', next: null, skipped: [] }, 'no clock: no limit, nothing counted');
    assert.equal(spendEvent(day1.next, { tier: 'nonsense', reply: 'b', clockDay: 1, allowance: normalizeAllowance() }).used, null);
    const full = { day: 1, reply: 'a', ordinary: 1000, meaningful: 0, major: 0, extreme: 0 };
    const unlimited = spendEvent(full, { tier: 'ordinary', reply: 'b', clockDay: 1, allowance: normalizeAllowance({ ordinary: null }) });
    assert.equal(unlimited.next.ordinary, 1000, 'an unlimited tier remains valid after a thousand events');
    assert.deepEqual(impactDayProblems(unlimited.next), []);
    assert.equal(spendEvent(unlimited.next, { tier: 'ordinary', reply: 'c', clockDay: 1, allowance: normalizeAllowance({ ordinary: 99 }) }).used, null);
});

test('one reply keeps the day it started on: a later event of it never reads the clock again', () => {
    const allowance = normalizeAllowance();
    const first = spendEvent(undefined, { tier: 'major', reply: 'r1', clockDay: 4, allowance });
    const later = spendEvent(first.next, { tier: 'major', reply: 'r1', clockDay: 5, allowance });
    assert.equal(later.used, 'meaningful', 'the clock crossed midnight inside the reply: still the day it started on');
    assert.equal(later.next.day, 4);
});

test('a downgraded move is cut to the used tier\'s points and stops on a gate that needs a higher tier', () => {
    const caps = { ordinary: 1, meaningful: 2, major: 3, extreme: 6 };
    const at = { trust: 49, affection: 10, desire: 0 };
    const cut = cutToTier([{ meter: 'trust', value: 3 }, { meter: 'affection', value: 5 }, { meter: 'desire', value: -4 }], 'meaningful', caps, id => at[id]);
    assert.deepEqual(cut.map(change => change.value), [1, 2, -2], 'trust 49 stops on the gate at 50 (it needs a major); the others are held to 2');
    assert.deepEqual(cutToTier([{ meter: 'trust', value: 3 }], 'major', caps, () => 49).map(change => change.value), [3], 'a major may cross 50');
    assert.deepEqual(cutToTier([{ meter: 'loyalty', value: 3 }], 'meaningful', caps, () => 49).map(change => change.value), [2], 'custom meters have the tier cap, not relationship gates');
    const flat = toFlatDay({ day: 3, reply: 'a', ordinary: 1, meaningful: 0, major: 0, extreme: 0 });
    assert.deepEqual(flat, { reply: 'a', 'd3:ordinary': 1, 'd3:meaningful': 0, 'd3:major': 0, 'd3:extreme': 0 });
    assert.deepEqual(fromFlatDay(flat, 3), { day: 3, reply: 'a', ordinary: 1, meaningful: 0, major: 0, extreme: 0 });
    const leftovers = { reply: 'b', 'd2:ordinary': 3, 'd4:meaningful': 1 };
    assert.deepEqual(fromFlatDay(leftovers, 4), { day: 4, reply: 'b', ordinary: 0, meaningful: 1, major: 0, extreme: 0 }, 'only the day asked for is read; a missing key is zero');
    assert.deepEqual(fromFlatDay(leftovers, 2), { day: 2, reply: 'b', ordinary: 3, meaningful: 0, major: 0, extreme: 0 }, 'an older day is read when the clock is on it: never "the newest day"');
    assert.equal(fromFlatDay(leftovers, 9).ordinary + fromFlatDay(leftovers, 9).meaningful, 0, 'a day with no keys counts nothing, whatever other days hold');
    assert.equal(fromFlatDay(leftovers, null), null);
    assert.deepEqual(flatDayProblems(flat), []);
    assert.ok(flatDayProblems({ reply: 'a', 'd3:major': -1, day: 3 }).length >= 2);
    assert.deepEqual(fromFlatDay({ reply: 'a' }, 3), { day: 3, reply: 'a', ordinary: 0, meaningful: 0, major: 0, extreme: 0 });
    // A write stores the current day's four keys only: every other day's key the record held is dropped with it.
    const written = spendFlatEvent({ reply: 'a', 'd9:major': 1, 'd2:ordinary': 2 }, { tier: 'major', reply: 'b', clockDay: 5, allowance: normalizeAllowance() });
    assert.deepEqual(written.next, { reply: 'b', 'd5:ordinary': 0, 'd5:meaningful': 0, 'd5:major': 1, 'd5:extreme': 0 });
    assert.equal(written.used, 'major', 'day 9\'s major (a clock that went back, or a leftover) does not count on day 5');
    assert.deepEqual(impactDayProblems({ day: 3, reply: 'a', ordinary: 1, meaningful: 0, major: 0, extreme: 0 }), []);
    assert.ok(impactDayProblems({ day: 3, reply: 'a', ordinary: -1, meaningful: 0, major: 0, extreme: 0, sneaky: 1 }).length >= 2);
});

// ---- settings ----

test('the defaults: points 1 / 2 / 3 / 6; a saved 1 / 2 / 5 / 10 moves once, any other saved set is the reader\'s', () => {
    assert.deepEqual({ ...DEFAULT_RELATIONSHIP_CAPS }, { ordinary: 1, meaningful: 2, major: 3, extreme: 6 });
    assert.deepEqual(DEFAULT_ALLOWANCE, { ordinary: 3, meaningful: 1, major: 1, extreme: 1 });
    assert.deepEqual(pacingDefaults({ relationshipCaps: { ordinary: 1, meaningful: 2, major: 5, extreme: 10 } }).caps, { ordinary: 1, meaningful: 2, major: 3, extreme: 6 });
    assert.deepEqual(pacingDefaults({ relationshipCaps: { ordinary: 1, meaningful: 2, major: 4, extreme: 10 } }).caps, { ordinary: 1, meaningful: 2, major: 4, extreme: 10 }, 'a value the reader chose stays');
    assert.deepEqual(pacingDefaults({ relationshipPacingMigrated: true, relationshipCaps: { ordinary: 1, meaningful: 2, major: 5, extreme: 10 } }).caps, { ordinary: 1, meaningful: 2, major: 5, extreme: 10 }, 'a later deliberate 1 / 2 / 5 / 10 stays');
    assert.equal(pacingDefaults({ relationshipImpactCriteria: 'my own words' }).impactCriteria, 'my own words');
    assert.equal(pacingDefaults({}).impactCriteria, DEFAULT_IMPACT_CRITERIA);
});

// ---- on the story's slice ----


test('two majors on one story day: the second counts as meaningful, then ordinary, and the receipt says so', async () => {
    const s = await suite();
    await s.setDay(3);
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 3, 'the first major is worth 3');
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 5, 'the second counts as meaningful: +2');
    assert.match(JSON.stringify(s.host.store.receipts()), /Oren: trust 3 → 5 \(major counted as meaningful: today's major is used\)/);
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 6, 'then ordinary: +1');
    await s.say([major()]);
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 8, 'ordinary is allowed three times a day');
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 8, 'nothing is left: ignored');
    assert.match(JSON.stringify(s.host.store.receipts()), /Oren: nothing changed \(today's ordinary, meaningful and major are used\)/);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    await s.setDay(4);
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 11, 'a new story day brings the allowance back');
});

test('one line naming three meters is one event; a different person has their own allowance', async () => {
    const s = await suite();
    await s.setDay(1);
    await s.say(['~ npc Oren | trust: +9 | affection: +9 | desire: +9 | impact: major']);
    const first = s.npc('Oren').meters;
    assert.deepEqual([first.trust, first.affection, first.desire], [3, 3, 3]);
    assert.equal(s.day('oren').major, 1, 'one major was counted, not three');
    await s.say([major('Sister Temiwa')]);
    assert.equal(s.npc('Sister Temiwa').meters.trust, 3, 'Temiwa\'s major is her own');
});

test('an event down the chain keeps the story day it started on: a time line inside the reply does not bring the allowance back', async () => {
    const s = await suite();
    await s.setDay(2);
    const index = await s.say([major()]);
    await s.setDay(3);   // midnight passes inside the same reply, before Delta's own change for it arrives
    await s.adapter.adjust({ name: 'Oren', meters: { affection: 2 }, reply: index, impact: 'major' });   // (a meter the line moved is the line's: yieldToStory)
    assert.equal(s.day('oren').day, 2, 'the reply\'s day is the one it started on');
    assert.equal(s.day('oren').major, 1);
    assert.equal(s.day('oren').meaningful, 1, 'the forwarded major counted as meaningful');
});

test('time set before the first NPC line or a scanner-only event cannot refresh that reply', async () => {
    const s = await suite();
    await s.setDay(2);
    await s.say([major()]);
    const index = await s.say([`~ date ${3 * DAY}`, major(), major('Sister Temiwa')]);
    assert.equal(s.npc('Oren').meters.trust, 5);
    assert.equal(s.day('oren').day, 2);
    assert.equal(s.day('sister-temiwa').day, 2);
    assert.equal((await s.host.sdk.reread(index)).ok, true);
    assert.equal(s.day('oren').day, 2, 'Re-read also starts before the time line');
    assert.equal(s.npc('Oren').meters.trust, 5);

    const t = await suite();
    await t.setDay(2);
    await t.say([major()]);
    const scanReply = await t.say([`~ date ${3 * DAY}`]);
    await t.adapter.adjust({ name: 'Oren', meters: { affection: 3 }, reply: scanReply, impact: 'major' });
    assert.equal(t.npc('Oren').meters.affection, 2);
    assert.equal(t.day('oren').day, 2);
    await t.say([major()]);
    assert.equal(t.day('oren').day, 3, 'the following reply uses the advanced clock');
});

test('a forwarded scanner change shares the allowance with the story line, counts one event for all its meters, and is cut to the used tier', async () => {
    const s = await suite();
    await s.setDay(7);
    await s.say([major()]);   // today's major is used
    const index = await s.say();
    const out = await s.adapter.adjust({ name: 'Oren', meters: { trust: 3, affection: 3 }, start: { trust: 3, affection: 0, desire: 0, tension: 0 }, reply: index, impact: 'major' });
    assert.ok(out, 'the change was sent');
    const meters = s.npc('Oren').meters;
    assert.deepEqual([meters.trust, meters.affection], [5, 2], 'a major counted as meaningful: each meter at most 2');
    assert.equal(s.day('oren').meaningful, 1, 'one event, not one per meter');
    assert.match(JSON.stringify(s.host.store.receipts()), /major counted as meaningful/);
    // The same tier with room is applied as the scanner worked it out (no second weighing of the inertia).
    await s.setDay(8);
    const next = await s.say();
    await s.adapter.adjust({ name: 'Oren', meters: { desire: 1 }, reply: next, impact: 'ordinary' });
    assert.equal(s.npc('Oren').meters.desire, 1);
    const y = await suite(); await y.setDay(9); const reply = await y.say([major()]);
    await y.adapter.adjust({ name: 'Oren', meters: { trust: 3 }, reply, impact: 'major' });
    assert.equal(y.day('oren').meaningful, 0, 'a fully yielded event spends nothing');
    await y.adapter.adjust({ name: 'Oren', meters: { trust: 3, affection: 3 }, reply, impact: 'major' }); assert.equal(y.day('oren').meaningful, 1, 'the surviving meter spends one event');
});

test('an adjust with no tier, a reader\'s edit and an unknown tier are never held and never counted', async () => {
    const s = await suite();
    await s.setDay(1);
    await s.say([major()]);
    await s.say([major()]);
    const before = JSON.stringify(s.day('oren'));
    const index = await s.say();
    await s.adapter.adjust({ name: 'Oren', meters: { trust: 7 }, reply: index });
    assert.equal(s.npc('Oren').meters.trust, 12, 'no tier: as before (3 + 2 + 7)');
    await s.adapter.adjust({ name: 'Oren', meters: { trust: 2 }, reply: index, impact: 'sideways' });
    assert.equal(s.npc('Oren').meters.trust, 14, 'an unknown tier is no tier');
    await s.host.sdk.command('npc.set', { name: 'Oren', meters: { trust: 40 } });
    assert.equal(s.npc('Oren').meters.trust, 40, 'the reader\'s own value is not held');
    assert.equal(JSON.stringify(s.day('oren')), before, 'none of those counted');
});

test('a downgraded major cannot cross a gate that needs a major', async () => {
    const records = dossiers();
    records.npc_oren.relationship.trust = 49;
    const s = await suite({ records });
    await s.setDay(1);
    await s.say([major()]);
    assert.ok(s.npc('Oren').meters.trust >= 50, 'the first major crosses 50');
    const low = dossiers();
    low.npc_oren.relationship.trust = 49;
    const t = await suite({ records: low, allowance: { major: 0 } });
    await t.setDay(1);
    await t.say([major()]);
    assert.equal(t.npc('Oren').meters.trust, 50, 'with no major today the move counts as meaningful and stops on the gate');
});

test('no story clock, or the calendar kept in Delta: no limit and nothing counted', async () => {
    const free = await suite({ clock: false });
    for (let n = 0; n < 3; n += 1) await free.say([major()]);
    assert.equal(free.npc('Oren').meters.trust, 9);
    assert.equal(free.day('oren'), undefined);
    const own = await suite({ calendarOwn: true });
    await own.setDay(1);
    for (let n = 0; n < 3; n += 1) await own.say([major()]);
    assert.equal(own.npc('Oren').meters.trust, 9);
    assert.equal(own.day('oren'), undefined);
    const blank = await suite({ allowance: { major: null, ordinary: null } });
    await blank.setDay(1);
    for (let n = 0; n < 3; n += 1) await blank.say([major()]);
    assert.equal(blank.npc('Oren').meters.trust, 9, 'blank is no limit');
});

test('the prompt line gives each tier its meaning and the points, and the major allowance', async () => {
    const s = await suite();
    const line = s.host.registry.module(MODULE_ID).context.static();
    assert.match(line, /Add \| impact: ordinary \(a kind word, most moments\) \| meaningful \(a real favour, a shared secret\) \| major \(saved from danger, a betrayal\) \| extreme \(a life-changing turning point, very rare\)\. Most moments are ordinary; each person can have only one major a day\. The most a move can be: 1\/2\/3\/6; =N moves toward N; none given: ordinary\./);
});

test('swipe, regenerate and a rebuild give the same numbers and the same count; a swipe recounts instead of adding', async () => {
    const s = await suite();
    await s.setDay(2);
    await s.say([major()]);
    const shape = () => JSON.stringify([s.npc('Oren').meters, { ...s.day('oren'), reply: 'the reply' }]);
    const live = shape();
    await s.swipe([major()]);
    assert.equal(shape(), live, 'the swipe\'s major is again the day\'s first one');
    const head = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), head, 'replay equals live');
});

test('no drift: while hosted the numbers Delta shows are the slice\'s, also after a held event', async () => {
    const s = await suite();
    await s.setDay(1);
    await s.say([major()]);
    const index = await s.say();
    await s.adapter.adjust({ name: 'Oren', meters: { trust: 3 }, start: { trust: 3, affection: 0, desire: 0, tension: 0 }, reply: index, impact: 'major' });
    const stored = [{ id: 'npc_oren', name: 'Oren', aliases: [], relationship: { trust: 6, affection: 0, desire: 0, tension: 0 } }];   // what Delta's own scan stored (the full major)
    const shown = s.adapter.sliceView(stored)[0].relationship;
    assert.equal(shown.trust, s.npc('Oren').meters.trust, 'the view reads the slice (5), not the sidecar\'s 6');
    assert.equal(shown.trust, 5);
});

// ---- Delta alone: the pass counts on the dossier ----

test('the pass without a host counts on the dossier: the second major of a day counts as meaningful; no day, no limit', () => {
    const mira = () => normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', present: true, relationship: { trust: 0, affection: 0, desire: 0, tension: 0 } });
    const deeds = ['Ari pulled her out of the burning granary at dawn.', 'Mira handed Ari the key to the sealed cellar and told him where it leads.', 'Ari stood between Mira and the tax collector in the market square.'];
    let deed = 0;
    const decision = id => {
        const text = deeds[deed++ % deeds.length];
        return new Map([[id, {
            relationshipImpact: 'major', relationshipDelta: { trust: 9, affection: 0, desire: 0, tension: 0 },
            relationshipEvidence: { trust: text, affection: '', desire: '', tension: '' },
            relationshipChangeReason: text,
        }]]);
    };
    const pace = { allowance: normalizeAllowance(), day: 4 };
    const state = { turn: 1, npcs: [mira()] };
    applyFocusedRelationshipDecisions(state, decision('npc_mira'), undefined, 10, null, pace);
    assert.equal(state.npcs[0].relationship.trust, 3);
    assert.equal(state.npcs[0].impactDay.major, 1);
    applyFocusedRelationshipDecisions(state, decision('npc_mira'), undefined, 11, null, pace);
    assert.equal(state.npcs[0].relationship.trust, 5, 'the second major counts as meaningful');
    assert.deepEqual(impactDayProblems(state.npcs[0].impactDay), []);
    assert.deepEqual(impactDayProblems(normalizeNpcRecord(state.npcs[0]).impactDay), [], 'the dossier keeps the count through its normalizer');
    const free = { turn: 1, npcs: [mira()] };
    for (const at of [10, 11, 12]) applyFocusedRelationshipDecisions(free, decision('npc_mira'), undefined, at, null, { allowance: normalizeAllowance(), day: null });
    assert.equal(free.npcs[0].relationship.trust, 9, 'no story day: no limit');
    assert.equal(free.npcs[0].impactDay, undefined);
});

// ---- the owner's chat, as numbers: Sister Temiwa ----

// [reply, story day at the start of the reply, tier, asks] for each `~ npc Sister Temiwa` line of the owner's story.
const TEMIWA = [
    [3, 1, 'ordinary', { tension: 1 }], [5, 1, 'ordinary', { trust: 1 }], [7, 1, 'ordinary', { affection: 1, trust: 1 }],
    [9, 1, 'meaningful', { trust: 2, affection: 2, desire: 1 }], [11, 1, 'meaningful', { trust: 1, affection: 1, desire: 1 }],
    [19, 1, 'major', { trust: 5, affection: 2, desire: 1 }], [21, 1, 'meaningful', { trust: 2, affection: 2, desire: 2 }],
    [23, 1, 'meaningful', { trust: 5, affection: 4, desire: 6 }], [25, 1, 'meaningful', { trust: 1, affection: 1, desire: 2 }],
    [27, 1, 'ordinary', { trust: 1, affection: 1, desire: 2 }], [29, 1, 'major', { trust: 5, affection: 5, desire: 10 }],
    [31, 1, 'major', { trust: 5, affection: 10, desire: 10 }], [33, 1, 'meaningful', { trust: 2, affection: 3, desire: 2 }],
    [35, 1, 'meaningful', { trust: 2, affection: 2, desire: 2 }], [41, 2, 'ordinary', { trust: 1, affection: 1 }],
    [43, 2, 'meaningful', { affection: 2, desire: 2 }], [45, 2, 'ordinary', { trust: 1 }],
    [47, 2, 'major', { trust: 5, affection: 3, tension: 5 }], [49, 2, 'major', { trust: 5, affection: 5, desire: 2, tension: -2 }],
    [51, 2, 'meaningful', { trust: 2, affection: 2, desire: 2 }], [53, 2, 'meaningful', { affection: 2, desire: 5 }],
    [55, 2, 'meaningful', { desire: 3, affection: 2 }], [57, 2, 'meaningful', { affection: 2, desire: 4 }],
    [59, 2, 'meaningful', { trust: 1, affection: 2, desire: 1 }],
];

test('the recorded start-of-reply days pace Sister Temiwa to 13 / 12 / 5 (it was 41 / 43 / 35)', async () => {
    const s = await suite();
    let at = -1;
    for (const [, day, tier, asks] of TEMIWA) {
        if (day !== at) { await s.setDay(day); at = day; }
        const parts = Object.entries(asks).map(([meter, value]) => `${meter}: ${value >= 0 ? '+' : ''}${value}`);
        await s.say([`~ npc Sister Temiwa | ${parts.join(' | ')} | impact: ${tier}`]);
    }
    const { trust, affection, desire } = s.npc('Sister Temiwa').meters;
    // The recorded clock is on the same day at the start of the first 14 lines; the 14th advances it
    // to the next day, so the 15th is the first line to use a fresh allowance.
    assert.deepEqual([trust, affection, desire], [13, 12, 5]);
    assert.ok(Math.abs(trust - 15) <= 2 && Math.abs(affection - 13) <= 2 && Math.abs(desire - 6) <= 2);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

// ---- fuzz: middle deletes over several days; replay equals rebuild ----

function prng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), chance: p => next() < p, pick: list => list[Math.floor(next() * list.length)] };
}

// FUZZ_SEEDS="1-200" (or "3,11,29") runs those seeds; the default is the three below. FUZZ_STEPS sets the steps (default 16).
const fuzzSeeds = (spec, fallback) => (spec ? spec.split(',').flatMap(part => { const [a, b] = part.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; }) : fallback);
const PEOPLE = ['Astra', 'Sister Temiwa', 'Brann', 'Cole', 'Dova', 'Esk', 'Finn', 'Gale', 'Hobb', 'Ines', 'Jory', 'Kess', 'Lund', 'Mave'];   // 14: past the bond limit (8) and the ties limit (12)
// One random line of the notes kinds (lie, know, taste, tie), a gate `via:` meter line, or a plain meter line: every change-line kind NSD owns.
function fuzzLine(r, who) {
    const other = r.pick(PEOPLE);
    switch (r.int(0, 9)) {
        case 0: return `~ lie ${who} | to: ${other} | said: it was not me ${r.int(0, 3)}`;
        case 1: return `~ lie ${who} | to: ${other} | caught: yes`;
        case 2: return `~ know ${who} | about: ${other} | fact: keeps a ledger ${r.int(0, 3)} | how: ${r.pick(['saw', 'heard'])}${r.chance(0.4) ? ' | secret: yes' : ''}`;
        case 3: return `~ know ${who} | about: ${other} | fact: keeps a ledger ${r.int(0, 3)} | told: yes`;
        case 4: return `~ taste ${who} | ${r.pick(['likes', 'dislikes'])}: ${r.pick(['tea', 'toffee', 'rain', 'paperwork'])}${r.chance(0.3) ? ' | why: a change of heart' : ''}`;
        case 5: return `~ tie ${who} | with: ${other} | tag: ${r.pick(['+', '-'])}${r.pick(['ally', 'rival', 'owes'])}${r.chance(0.3) ? `, ${r.pick(['+', '-'])}${r.pick(['ally', 'rival', 'owes'])}` : ''}`;
        case 6: case 7: return `~ npc ${who} | affection: +${r.int(1, 9)} | trust: ${r.pick(['+', '-'])}${r.int(0, 6)} | via: ${r.pick(['praise', 'gift', 'help', 'flirt', 'threat', 'shared-danger'])} | impact: ${r.pick(['ordinary', 'meaningful', 'major', 'extreme'])}`;
        default: return `~ npc ${who} | trust: +${r.int(1, 9)} | affection: ${r.pick(['+', '-'])}${r.int(0, 6)} | impact: ${r.pick(['ordinary', 'meaningful', 'major', 'extreme'])}`;
    }
}

for (const seed of fuzzSeeds(process.env.FUZZ_SEEDS, [3, 11, 29])) {
    test(`pacing fuzz seed ${seed}: tiers, notes kinds, via gate, look stamp and mood/pull tick over several story days, middle deletes and swipes; the slice validates and replay equals rebuild`, async t => {
        t.mock.method(console, 'warn', () => {});
        // FUZZ_OFF=mood-pull,anti-lever,notes switches those features off for a run (to look past a failure of one).
        const s = await suite({ features: process.env.FUZZ_OFF ? Object.fromEntries(process.env.FUZZ_OFF.split(',').map(id => [`npc-state-delta.${id}`, false])) : null });
        const r = prng(seed);
        await s.say(['~ npc Oren | trust: +1', '~ npc Sister Temiwa | trust: +1']);   // the set-up reply makes both entries and is never deleted
        const setup = s.host.store.headIndex();
        let day = 1;
        for (let step = 0; step < (Number(process.env.FUZZ_STEPS) || 16); step += 1) {
            if (r.chance(0.4)) { day += r.int(1, 2); await s.setDay(day); }
            const lines = Array.from({ length: r.int(1, 3) }, () => fuzzLine(r, r.pick(['Oren', 'Sister Temiwa'])));
            const index = await s.say(lines);
            // The look stamp / flag (feature notes): first look set, or a refused contradiction; replayed with the reply.
            if (r.chance(0.2)) await s.adapter.flag(r.chance(0.5) ? { name: 'Oren', lock: true, reply: s.host.store.headIndex(), cue: 'Oren\'s look is fixed: grey hair.' } : { name: 'Oren', drift: { before: 'grey hair', incoming: 'red hair' }, reply: s.host.store.headIndex() });
            if (r.chance(0.15)) await s.host.sdk.command('npc.tick', {});   // from outside: refused (the step is Delta's own); must change nothing
            if (r.chance(0.2)) await s.swipe(lines);
            if (step > 3 && r.chance(0.35)) {
                assert.equal((await s.host.sdk.reread(s.host.store.headIndex())).ok, true);
    let again = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), again, 'after a Re-read: replay equals live');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(JSON.stringify(s.host.head()), again, 'a cold reload equals live');
    const replies = s.host.ctx.chat.map((message, at) => (!message.is_user && at > setup && at < s.host.store.headIndex() ? at : -1)).filter(at => at >= 0);
                if (replies.length) {
                    const gone = r.pick(replies);
                    await s.host.st.deleteMessage(gone);
                    await s.host.st.deleteMessage(gone - 1);
                }
            }
            const label = `seed ${seed} step ${step} (reply ${index})`;
            assert.deepEqual(s.host.store.problems(), [], `${label}: nothing was skipped`);
            const head = JSON.stringify(s.host.head());
            assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), [], `${label}: the slice validates`);
            s.host.store.rebuild();
            assert.equal(JSON.stringify(s.host.head()), head, `${label}: replay equals rebuild`);
            for (const record of Object.values(s.host.head().domains.npc.npcs)) {
                if (!record.impactDay) continue;
                const { ordinary, meaningful, major, extreme } = newestFlatDay(record.impactDay);
                assert.ok(major <= 1 && meaningful <= 1 && extreme <= 1 && ordinary <= 3, `${label}: counts stay within the allowance: ${JSON.stringify(record.impactDay)}`);
            }
        }
    });
}

// ---- the anti-lever gate (npc-meters-gate.js; feature npc-state-delta.anti-lever, off by default) ----

const shape = s => JSON.stringify(s.host.head());
const gateOn = { [FEATURE_GATE]: true };
const praise = (who = 'Oren', by = 3, via = 'praise') => `~ npc ${who} | affection: +${by} | via: ${via} | impact: major`;
const record = (s, key = 'oren') => s.host.head().domains.npc.npcs[key];
const gateOf = (s, key = 'oren') => eventSummary(readEvent(record(s, key).lastEvent))?.gate;
const tailOf = s => s.host.registry.module(MODULE_ID).context.tail({ state: s.host.head(), chat: { length: s.host.ctx.chat.length } });
const lowTrust = () => { const records = dossiers(); records.npc_oren.relationship.trust = -50; return records; };

test('gate: the same approach to the same person gives less, the third time backfires (tension up, trust down), with the receipt words and the cue', async () => {
    const s = await suite({ allowance: null, features: gateOn });
    await s.setDay(1);
    await s.say([praise()]);
    assert.equal(s.npc('Oren').meters.affection, 3, 'the first approach gives what it asked');
    assert.equal(gateOf(s), 'via praise');
    await s.say([praise()]);
    assert.equal(s.npc('Oren').meters.affection, 4, 'the second gives half (3 → 1)');
    assert.equal(gateOf(s), 'via praise · 2nd in 1 day · less');
    await s.say([praise()]);
    assert.deepEqual(s.npc('Oren').meters, { trust: -1, affection: 4, desire: 0, tension: 1 }, 'the third: no affection, tension +1, trust −1');
    assert.equal(gateOf(s), 'via praise · 3rd in 1 day · backfired');
    assert.ok(tailOf(s).optional.includes('Oren has noticed the repeated praise; it backfires.'), JSON.stringify(tailOf(s)));
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('gate: another approach, another person and a day outside the window are not repeats', async () => {
    const s = await suite({ allowance: null, features: gateOn });
    await s.setDay(1);
    await s.say([praise(), praise('Sister Temiwa'), praise('Oren', 3, 'gift')]);
    assert.equal(s.npc('Oren').meters.affection, 6, 'a gift after praise is its own approach');
    assert.equal(s.npc('Sister Temiwa').meters.affection, 3);
    await s.setDay(4);
    await s.say([praise()]);
    assert.equal(s.npc('Oren').meters.affection, 9, 'day 1 is 3 days back: outside the window of 3 days (4, 3, 2)');
    assert.equal(gateOf(s), 'via praise');
});

test('gate: praise or a gift from low trust reads as pressure (tension instead of affection); help does not', async () => {
    const s = await suite({ allowance: null, features: gateOn, records: lowTrust() });
    await s.setDay(1);
    await s.say([praise()]);
    assert.deepEqual(s.npc('Oren').meters, { trust: -50, affection: 0, desire: 0, tension: 3 });
    assert.equal(gateOf(s), 'via praise · suspicion');
    await s.say([praise('Oren', 3, 'help')]);
    assert.equal(s.npc('Oren').meters.affection, 3, 'help from low trust is help');
    assert.ok(tailOf(s).optional.every(line => !/pressure/.test(line)), 'the cue is only for the reply that fired it');
});

test('gate: settings: strength strong backfires the second time; a one-day window makes the next day a first', async () => {
    const strong = await suite({ allowance: null, features: gateOn, settings: { gateStrength: 'strong' } });
    await strong.setDay(1);
    await strong.say([praise()]);
    await strong.say([praise()]);
    assert.equal(gateOf(strong), 'via praise · 2nd in 1 day · backfired');
    const short = await suite({ allowance: null, features: gateOn, settings: { gateDays: 1 } });
    await short.setDay(1);
    await short.say([praise()]);
    await short.setDay(2);
    await short.say([praise()]);
    assert.equal(short.npc('Oren').meters.affection, 6);
    assert.equal(gateOf(short), 'via praise');
});

test('gate: only the story\'s own lines are gated: a scan\'s change passes through and writes no ring; no clock, no gate', async () => {
    const scan = gateApproach({ source: 'scan', via: 'praise', day: 1, reply: 'sw_a', name: 'Oren', trust: 0, delta: { affection: 3 }, ring: [{ d: 1, r: 'sw_b', v: 'praise' }, { d: 1, r: 'sw_c', v: 'praise' }], settings: {} });
    assert.equal(scan.mode, 'none');
    assert.deepEqual(scan.delta, { affection: 3 });
    assert.equal(scan.ring.length, 2, 'the ring is as it was');
    const s = await suite({ allowance: null, features: gateOn, clock: false });
    await s.say([praise(), praise(), praise()]);
    assert.equal(s.npc('Oren').meters.affection, 9, 'no day: no gate, every line lands in full');
    assert.equal(record(s).via, undefined, 'no story day: no ring');
    assert.equal(s.npc('Oren').meters.tension, 0);
});

test('gate: feature off and old lines: byte-identical state, no ring, and the static line is unchanged', async () => {
    const lines = [['~ npc Oren | affection: +2 | impact: meaningful'], ['~ npc Oren | trust: +1']];
    const off = await suite({ allowance: null, features: { [FEATURE_GATE]: false } });
    const on = await suite({ allowance: null, features: gateOn });
    for (const s of [off, on]) { await s.setDay(1); for (const set of lines) await s.say(set); }
    const bare = x => JSON.stringify(x.host.head().domains.npc).replace(/sw_[a-z0-9]+/g, 'sw');
    assert.equal(bare(on), bare(off), 'lines without via: the feature on changes nothing');
    assert.equal(record(on).via, undefined);
    const withVia = await suite({ allowance: null, features: { [FEATURE_GATE]: false } });
    await withVia.setDay(1);
    await withVia.say([praise(), praise(), praise()]);
    assert.equal(record(withVia).via, undefined, 'off: no ring');
    assert.equal(withVia.npc('Oren').meters.affection, 9, 'off: the label gives nothing, every line lands in full (as before)');
    const text = s => s.host.registry.module(MODULE_ID).context.static();
    assert.doesNotMatch(text(off), /via:/);
    assert.match(text(on), /Add \| via: praise, gift, help, flirt, threat, shared-danger/);
    assert.equal(text(on).replace(/ Add \| via:[^.]*\./, ''), text(off), 'the only difference is the one gated sentence');
});

test('gate: replay equals live: rebuild, a swipe, a Re-read, a middle delete and a cold reload; the stored shapes validate', async () => {
    const s = await suite({ allowance: null, features: gateOn });
    await s.setDay(1);
    await s.say([praise()]);
    const middle = await s.say([praise()]);
    await s.say([praise()]);
    await s.swipe([praise()]);
    await s.setDay(2);
    const index = await s.say([praise()]);
    assert.equal((await s.host.sdk.reread(index)).ok, true);
    let live = shape(s);
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(shape(s), live, 'a cold reload equals live');
    assert.ok(readApproachRing(record(s).via), 'the ring is stored whole as one text leaf');
    await s.host.st.deleteMessage(middle);
    await s.host.st.deleteMessage(middle - 1);
    live = shape(s);
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live after the delete');
    assert.deepEqual(s.host.store.problems(), []);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('gate: the swipe and the Re-read count a reply once (a repeat is another reply, never the same one again)', async () => {
    const s = await suite({ allowance: null, features: gateOn });
    await s.setDay(1);
    const first = await s.say([praise()]);
    await s.host.sdk.reread(first);
    await s.host.sdk.reread(first);
    assert.equal(s.npc('Oren').meters.affection, 3, 're-reading the same reply is still its first approach');
    assert.equal(JSON.parse(record(s).via).length, 1);
    await s.swipe([praise()]);
    assert.equal(s.npc('Oren').meters.affection, 3, 'a swipe replaces the reply\'s approach');
});

test('gate: stored shapes: a bad ring, a bad kind or a gate without its approach is refused', () => {
    const slice = via => ({ npcs: { mira: { name: 'Mira', meters: { trust: 0, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [], ...via } }, problems: [] });
    assert.deepEqual(validateNpcSlice(slice({ via: JSON.stringify([{ d: 1, r: 'sw_a', v: 'praise' }]) })), []);
    assert.ok(validateNpcSlice(slice({ via: 'not json' })).length);
    assert.ok(validateNpcSlice(slice({ via: JSON.stringify([{ d: 1, r: 'sw_a', v: 'bribe' }]) })).length);
    const event = extra => JSON.stringify({ at: 1, date: '', events: [{ src: 'story', ask: { affection: 3 }, tier: 'major', held: false, note: '', ...extra }] });
    assert.ok(readEvent(event({ via: 'praise', gate: { mode: 'back', n: 3, span: 2 } })));
    assert.equal(readEvent(event({ gate: { mode: 'back', n: 3, span: 2 } })), null, 'a gate needs its approach');
    assert.equal(readEvent(event({ via: 'praise', gate: { mode: 'sulk', n: 3, span: 2 } })), null);
    assert.equal(readEvent(event({ via: 'flattery' })), null);
});

// ---- mood and pull (feature npc-state-delta.mood-pull; npc-mood.js, npc-instincts.js) ----

const MOOD_ON = { 'npc-state-delta.mood-pull': true };
// A stand-in for Story Director's threads and key people and Story Block's party: one domain, queries read it as of the reply.
const worldModule = {
    id: 'zz-world', name: 'World',
    // One text leaf (the host checks every field called `id`): { party, threads, away } as JSON.
    domains: { world: { initial: () => ({ data: '{}' }) } },
    commands: { 'zz.world': (ctx, patch) => { const slice = ctx.draft('world'); slice.data = JSON.stringify({ ...JSON.parse(slice.data), ...patch }); return { summary: 'the world moves' }; } },
    queries: {
        'party.actors': state => JSON.parse(state?.domains?.world?.data ?? '{}').party ?? null,
        'director.threads': state => JSON.parse(state?.domains?.world?.data ?? '{}').threads ?? [],
        'director.keyPeople': state => JSON.parse(state?.domains?.world?.data ?? '{}').away ?? [],
    },
};
const moodSuite = (extra = {}) => suite({ allowance: null, features: MOOD_ON, modules: [worldModule], ...extra });
const world = async (s, patch) => { const out = await s.host.sdk.command('zz.world', patch); assert.equal(out.ok, true, JSON.stringify(out)); };
const recordOf = (s, key = 'oren') => s.host.head().domains.npc.npcs[key];
const plain = ({ v, a, d, day, cause }) => ({ v, a, d, day, cause });
const clockTo = (s, minutes) => s.host.sdk.command('zz.clock', { minutes });
const axes = s => { const m = recordOf(s).mood; return [m.v, m.a, m.d]; };
const moodTailOf = s => JSON.stringify(s.host.sdk.context ? s.host.sdk.context() : null);

test('mood: a trust drop and a betrayal move the axes by the rules and keep the reason as the cause; a rise does nothing', async () => {
    const s = await moodSuite();
    await s.setDay(2);
    await s.say(['~ npc Oren | trust: +3']);
    assert.equal(recordOf(s).mood, undefined, 'a rise moves no mood');
    await s.say(['~ npc Oren | trust: -2 | impact: meaningful | reason: Astra lied']);
    assert.deepEqual(plain(recordOf(s).mood), { v: -1, a: 1, d: -1, day: 2, cause: 'trust dropped: Astra lied' });
    await s.say(['~ npc Oren | trust: -3 | impact: major | why: the vault']);
    assert.deepEqual(plain(recordOf(s).mood), { v: -3, a: 3, d: -2, day: 2, cause: 'betrayed: the vault' });
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const row = (await s.host.sdk.query('npc.cast', {})).find(item => item.key === 'oren');
    assert.equal(row.mood.word, 'Alarmed');
    assert.deepEqual(row.mood.bars, { energy: 6, control: 1, max: 6 });
    assert.equal(row.mood.cause, 'betrayed: the vault');
    const shown = s.adapter.dossierMeters([{ id: 'npc_oren', name: 'Oren' }]);
    assert.equal(shown.npc_oren.mood.word, 'Alarmed', 'the dossier view model carries the mood');
});

test('mood eases toward rest over story time: per-axis speed, proportional, same minute = no extra easing, always all three fields', async () => {
    const s = await moodSuite();
    await s.setDay(2);
    await s.say(['~ npc Oren | trust: -3 | impact: major']);
    assert.deepEqual(axes(s), [-2, 2, -1]);
    const at = recordOf(s).mood.at;
    await clockTo(s, at + 5);
    await s.say([]);
    assert.deepEqual(axes(s), [-2, 2, -1], 'five minutes later: nothing moves yet');
    await clockTo(s, at + 5);
    await s.say([]);
    assert.deepEqual(axes(s), [-2, 2, -1], 'a Continue or swipe in the same minute: no extra easing');
    await clockTo(s, at + 240);
    await s.say([]);
    assert.deepEqual(axes(s), [-2, 1, -1], 'about 4 hours: arousal about halved, valence and dominance barely moved');
    await clockTo(s, at + 600);
    await s.say([]);
    assert.deepEqual(axes(s), [-1, 0, -1], 'ten hours: arousal gone, valence about half, dominance slowest');
    await clockTo(s, at + DAY + 120);
    await s.say([]);
    assert.deepEqual(axes(s), [0, 0, -1], 'a day and a bit: valence gone, dominance still there');
    await clockTo(s, at + 5 * DAY);
    await s.say([]);
    assert.deepEqual(axes(s), [0, 0, 0], 'days later: at rest, and the three fields are still on the record');
    assert.deepEqual(Object.keys(recordOf(s).mood).filter(key => ['v', 'a', 'd'].includes(key)), ['v', 'a', 'd']);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('mood: new events add on top of what is left; ongoing stress keeps it raised', async () => {
    const s = await moodSuite();
    await s.setDay(2);
    await s.say(['~ npc Oren | trust: -2 | impact: meaningful']);
    const at = recordOf(s).mood.at;
    await clockTo(s, at + 120);
    await s.say(['~ npc Oren | trust: -2 | impact: meaningful']);
    assert.equal(recordOf(s).mood.a, 2, 'arousal 1 eased to 1 after two hours, plus the new drop');
    assert.equal(recordOf(s).mood.v, -2);
    await clockTo(s, at + 180);
    await s.say(['~ npc Oren | trust: -2 | impact: meaningful']);
    assert.equal(recordOf(s).mood.a, 3, 'stacks under ongoing stress');
});

test('mood: a person with a temperament settles there, not at 0, and the record is stored with it', async () => {
    const rest = restingMood('A calm, confident old sailor.');
    assert.deepEqual(rest, { v: 0, a: -1, d: 1 });
    assert.deepEqual(restingMood('plain person', null), { v: 0, a: 0, d: 0 });
    assert.deepEqual(restingMood('cheerful warm kind gentle joyful'), { v: 2, a: 0, d: 0 }, 'at most 2 either way');
    const m = restMood(rest, 5000);
    assert.deepEqual([m.v, m.a, m.d, m.rest, m.at], [0, -1, 1, rest, 5000]);
    const hit = applyEvents(m, 5000, [{ kind: 'betrayal' }]);
    assert.deepEqual([hit.v, hit.a, hit.d], [-2, 1, 0]);
    const later = applyEvents(hit, 5000 + 20 * DAY, []);
    assert.deepEqual([later.v, later.a, later.d], [0, -1, 1], 'after many days: back at the temperament, not at 0,0,0');
    assert.deepEqual(validateNpcSlice({ ...JSON.parse(JSON.stringify({ npcs: {} })) }).filter(line => /mood/.test(line)), []);
});

test('mood easing core: proportional, integer, never overshooting, per-axis speed, replay == rebuild', () => {
    const steps = [0, 30, 60, 120, 240, 480, 960, 1920, 5000, 50000];
    for (const half of [210, 720, 1620]) {
        for (const [from, rest] of [[3, 0], [-3, 0], [3, -1], [-3, 2], [1, 1], [0, 2]]) {
            let last = Math.abs(from - rest);
            for (const m of steps) {
                const v = easeAxis(from, rest, m, half);
                assert.ok(Number.isInteger(v));
                const mag = Math.abs(v - rest);
                assert.ok(mag <= last, 'never moves away');
                assert.ok(Math.sign(v - rest) === 0 || Math.sign(v - rest) === Math.sign(from - rest), 'never overshoots rest');
                last = mag;
            }
            assert.equal(easeAxis(from, rest, 5000000, half), rest);
        }
    }
    const far = 3 - easeAxis(3, 0, 300, 210), near = 1 - easeAxis(1, 0, 300, 210);
    assert.ok(far >= near, 'the further away, the bigger the step');
    assert.equal(easeAxis(3, 0, 210, 210), 2, 'about half after one half-life (3 -> 1.5 -> 2)');
    assert.ok(easeAxis(3, 0, 720, 210) <= 0, 'arousal is gone in 12 hours');
    assert.ok(easeAxis(3, 0, 1440, 1620) > easeAxis(3, 0, 1440, 720), 'dominance is slower than valence');
    const mood = applyEvents(null, 1000, [{ kind: 'betrayal', reason: 'x' }]);
    const once = applyEvents(mood, 1000 + 400, []);
    assert.deepEqual(applyEvents(once, 1000 + 400, []), once, 'reading twice at one minute is the same');
    assert.deepEqual(applyEvents(applyEvents(mood, 1100, []), 1400, []), applyEvents(mood, 1400, []), 'any read cadence gives the same axes');
});

test('pull: closure from an open thread that names them, after the days it waited; belonging when benched', async () => {
    const s = await moodSuite();
    await s.setDay(1);
    await world(s, { party: [{ id: 'a', name: 'Oren' }], threads: [{ id: 'th_aaaaaaaa', key: 'The stolen letter', status: 'active', fields: { people: 'Oren, Astra' } }] });
    await s.say(['~ npc Oren | trust: +1']);
    assert.equal(recordOf(s).pull, undefined, 'a thread seen today has waited no days');
    await s.setDay(4);
    await s.say([]);
    assert.deepEqual(recordOf(s).pull, { kind: 'closure', cause: 'The stolen letter', since: 1 });
    assert.deepEqual(recordOf(s).inst, { belo: 0, clos: 1, awe: 0 });
    const pulled = s.adapter.dossierMeters([{ id: 'npc_oren', name: 'Oren' }]).npc_oren.pull;
    assert.deepEqual([pulled.kind, pulled.level, pulled.days], ['closure', 1, 3], 'the dossier view model carries the pull, its level and days');
    await s.setDay(5);
    await world(s, { party: [{ id: 'it_aaaaaaaa', name: 'Astra' }] });
    await s.say([]);
    assert.deepEqual(recordOf(s).pull, { kind: 'belonging', cause: 'benched from the party', since: 5 });
    assert.equal(recordOf(s).inst.belo, 3);
    await world(s, { party: [{ id: 'a', name: 'Oren' }], threads: [] });
    await s.say([]);
    assert.equal(recordOf(s).pull?.cause === 'benched from the party', false, 'back in the party: no longer benched');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('pull: awe at the first arrival at a place they were not at before (the first place seen is only remembered)', async () => {
    const s = await moodSuite();
    await s.setDay(1);
    await s.say(['~ place Market | street | Dunmere', '~ npc Oren | trust: +1']);
    assert.equal(recordOf(s).pull, undefined, 'the first place is the baseline, not an arrival');
    await s.say(['~ place Harbor | docks | Dunmere']);
    assert.deepEqual(recordOf(s).pull, { kind: 'awe', cause: 'first time at Harbor', since: 1 });
    assert.deepEqual(recordOf(s).track.places, ['Market', 'Harbor']);
    await s.say(['~ place Market | street | Dunmere']);
    assert.equal(recordOf(s).pull, undefined, 'a place they have seen is no awe');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('pull: a person away (key people) feels left behind; a failing or missing query is no signal', async () => {
    const s = await moodSuite();
    await s.setDay(3);
    await world(s, { away: [{ name: 'Oren', aliases: [], here: false, away: { doing: 'abroad', since: 2 * DAY, back: null, steps: [] } }] });
    await s.say(['~ npc Oren | trust: +1']);
    assert.deepEqual(recordOf(s).pull, { kind: 'belonging', cause: 'left behind while the group moved on', since: 2 });
    // A query that throws is no signal too: the tick still runs and the record is clean.
    const broken = await suite({ allowance: null, features: MOOD_ON, modules: [{ id: 'zz-broken', name: 'Broken', queries: { 'party.actors': () => { throw new Error('down'); }, 'director.threads': () => { throw new Error('down'); }, 'director.keyPeople': () => { throw new Error('down'); } } }] });
    await broken.setDay(3);
    await broken.say(['~ npc Oren | trust: -3 | impact: major']);
    await broken.setDay(6);
    await broken.say([]);
    assert.equal(recordOf(broken).pull, undefined);
    assert.equal(recordOf(broken).mood.day, 6, 'the tick ran (the mood settled to day 6)');
    assert.deepEqual(validateNpcSlice(broken.host.head().domains.npc), []);
    const bare = await suite({ allowance: null, features: MOOD_ON });
    await bare.setDay(3);
    await bare.say(['~ npc Oren | trust: -3 | impact: major']);
    assert.equal(recordOf(bare).pull, undefined, 'no party, threads or key people: no pull');
    assert.deepEqual(validateNpcSlice(bare.host.head().domains.npc), []);
});

test('the tail tells mood and pull for present people only; feature off: the tail and the static line are byte-identical to before', () => {
    const record = (name, extra) => ({ name, meters: { trust: 5, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [], turn: { reply: 2, from: {} }, day: 5, ...extra });
    const state = { domains: { npc: { problems: [], npcs: {
        mira: record('Mira', { mood: { v: -2, a: 2, d: -2, day: 5, cause: 'betrayed: Astra lied' }, pull: { kind: 'closure', cause: 'the stolen letter', since: 2 }, inst: { belo: 0, clos: 2, awe: 0 } }),
        oren: record('Oren', { mood: { v: 2, a: 0, d: 0, day: 5, cause: '' } }),
        tomas: record('Tomas', { mood: { v: -3, a: 3, d: 0, day: 5, cause: 'x' }, pull: { kind: 'awe', cause: 'first time at the harbor', since: 5 } }),
    } } } };
    const make = on => createNpcPart({ settings: () => ({}), present: () => ['Mira', 'Oren'], feature: id => (id === FEATURE_MOOD_PULL ? on : undefined) });
    const view = { state, chat: { length: 3 } };
    const off = make(false);
    const base = off.context.tail(view);
    assert.deepEqual(base.optional, [], 'off: no mood or pull line at all');
    const bare = JSON.parse(JSON.stringify(view));
    for (const person of Object.values(bare.state.domains.npc.npcs)) { delete person.mood; delete person.pull; delete person.inst; }
    assert.equal(JSON.stringify(base), JSON.stringify(off.context.tail(bare)), 'off: the tail does not read mood or pull at all');
    const on = make(true);
    assert.equal(on.context.static(), off.context.static(), 'the static prompt never changes');
    const told = on.context.tail(view);
    assert.deepEqual(told.lines, base.lines, 'the meter lines are untouched');
    assert.deepEqual(told.optional, ['Mood: Mira alarmed, cornered; Oren content.', 'Pull: Mira: closure (the stolen letter, 3 days).'], 'present people only: Tomas is not here');
    const tokens = text => Math.ceil(text.length / 4);
    assert.ok(tokens(told.optional.join('\n')) <= 30, `the two lines stay small (${tokens(told.optional.join('\n'))} tokens, budget ${CONTEXT_BUDGET})`);
    assert.ok(told.optional.every(line => !/[<>]/.test(line)));
});

test('mood and pull: replay equals rebuild through swipes, a Re-read, a middle delete and a cold reload; the slice validates; a feature-off chat gets no new field', async t => {
    t.mock.method(console, 'warn', () => {});
    const s = await moodSuite();
    await s.setDay(1);
    await world(s, { party: [{ id: 'a', name: 'Oren' }], threads: [{ id: 'th_cccccccc', key: 'Old debt', status: 'active', fields: { people: 'Oren' } }] });
    await s.say(['~ npc Oren | trust: +1', '~ npc Sister Temiwa | trust: +1']);
    const setup = s.host.store.headIndex();
    for (const [day, line] of [[2, '~ npc Oren | trust: -2 | impact: meaningful | reason: a broken oath'], [4, '~ npc Sister Temiwa | trust: -6 | impact: extreme'], [6, '~ npc Oren | trust: +4']]) {
        await s.setDay(day);
        await s.say([line]);
        await s.swipe([line]);
        assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
        const head = JSON.stringify(s.host.head());
        s.host.store.rebuild();
        assert.equal(JSON.stringify(s.host.head()), head, `day ${day}: replay equals rebuild`);
    }
    const replies = s.host.ctx.chat.map((message, at) => (!message.is_user && at > setup && at < s.host.store.headIndex() ? at : -1)).filter(at => at >= 0);
    await s.host.st.deleteMessage(replies[0]);
    await s.host.st.deleteMessage(replies[0] - 1);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const head = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), head, 'after the middle delete: replay equals rebuild');
    const off = await suite({ allowance: null, modules: [worldModule], features: { [FEATURE_MOOD_PULL]: false } });
    await off.setDay(2);
    await world(off, { threads: [{ id: 'th_dddddddd', key: 'Old debt', status: 'active', fields: { people: 'Oren' } }] });
    await off.say(['~ npc Oren | trust: -3 | impact: major']);
    await off.setDay(6);
    await off.say([]);
    assert.deepEqual(Object.keys(recordOf(off)).filter(key => ['mood', 'inst', 'pull', 'track'].includes(key)), [], 'feature off: no mood, pull or memory on a record');
});

test('validator: a malformed mood, instinct, pull or memory is refused; every old record shape stays valid', () => {
    const base = { name: 'Mira', meters: { trust: 0, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [] };
    const check = extra => validateNpcSlice({ npcs: { mira: { ...base, ...extra } }, problems: [] });
    assert.deepEqual(check({}), []);
    assert.deepEqual(check({ mood: { v: 1, a: -3, d: 0, day: 4, cause: 'rested' }, inst: { belo: 1, clos: 0, awe: 3 }, pull: { kind: 'closure', cause: 'a letter', since: 2 }, track: { party: 1, join: 3, threads: { th_aaaaaaaa: 2 }, places: ['Harbor'] } }), []);
    for (const bad of [{ mood: { v: 9, a: 0, d: 0, day: 0, cause: '' } }, { mood: { v: 1, a: 0, d: 0 } }, { mood: 'sad' }, { inst: { belo: 4 } }, { inst: { fear: 1 } }, { pull: { kind: 'fear', cause: 'x', since: 1 } },
        { pull: { kind: 'awe', cause: 'x', since: -1 } }, { pull: { kind: 'awe', cause: 'x', since: 1, extra: 1 } }, { track: { party: 2 } }, { track: { places: new Array(7).fill('p') } }, { track: { other: 1 } }]) {
        assert.notDeepEqual(check(bad), [], JSON.stringify(bad));
    }
});

test('mood and pull cores: the 3x3 word table, the bars, decay that never passes 0, bad input is no signal', () => {
    assert.deepEqual([moodWord({ v: -3, a: 3, d: 0, day: 0, cause: '' }), moodWord({ v: 0, a: 0, d: 0, day: 0, cause: '' }), moodWord({ v: 3, a: -3, d: 0, day: 0, cause: '' })], ['Alarmed', 'Steady', 'Calm']);
    assert.deepEqual(moodBars({ v: 0, a: 3, d: -3, day: 0, cause: '' }), { energy: 6, control: 0, max: 6 });
    assert.deepEqual(plain(applyEvents({ v: -1, a: 1, d: 0, day: 2, cause: 'x' }, 9 * DAY, [])), { v: 0, a: 0, d: 0, day: 9, cause: 'x' });
    assert.deepEqual(plain(applyEvents(null, DAY, [{ kind: 'nonsense' }])), { v: 0, a: 0, d: 0, day: 1, cause: '' });
    assert.deepEqual(eventsFromMoves([{ meter: 'trust', change: -1 }]), [], 'one point is no drop');
    assert.equal(eventsFromMoves([{ meter: 'trust', change: -3 }], { impact: 'major' })[0].kind, 'betrayal');
    assert.equal(eventsFromMoves([{ meter: 'trust', change: -3 }], { impact: 'meaningful' })[0].kind, 'trust-drop');
    assert.deepEqual(stepPull({}, { day: null, threads: [{ id: 'x', title: 't' }] }).pull, null, 'no story day: no signal');
    assert.deepEqual(stepPull(undefined, { day: 3, party: null, here: '', present: true, threads: [] }), { track: {}, inst: { belo: 0, clos: 0, awe: 0 }, pull: null });
    const joined = stepPull({ party: 0 }, { day: 4, party: true, threads: [] });
    assert.deepEqual(joined.pull, { kind: 'belonging', cause: 'new to the party', since: 4 });
});

// ---- the new defaults (anti-lever gate, mood and pull, notes are on) against replies already written ----

test('defaults on: a chat written with the three features off (a ladder ticking every reply) replays unchanged after they are switched on, and every old reply, a trust drop included, is read again identically', async () => {
    const off = { [FEATURE_GATE]: false, [FEATURE_MOOD_PULL]: false, 'npc-state-delta.notes': false };
    const s = await suite({ allowance: null, features: off, settings: { ladder: [{ name: 'Friend', needs: 'trust 2' }] } });
    const bare = x => JSON.stringify(x.host.head().domains.npc).replace(/sw_[a-z0-9]+/g, 'sw');
    await s.setDay(1);
    const first = await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
    const dropAt = await s.say(['~ npc Oren | trust: -3 | impact: major | reason: a broken oath']);
    const calmAt = await s.say(['~ npc Sister Temiwa | affection: +1']);
    const last = await s.say(['~ npc Oren | trust: +4 | impact: major']);
    const written = bare(s);
    assert.ok(JSON.parse(written).npcs.oren.rank, 'the old chat has a ladder rank (its ticks ran)');
    for (const id of Object.keys(off)) s.host.features.set(id, true);
    s.host.store.rebuild();
    assert.equal(bare(s), written, 'rebuild under the new defaults: the stored ops give the same state');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(bare(s), written, 'a cold reload under the new defaults: the same state');
    for (const index of [first, dropAt, calmAt, last]) {
        assert.equal((await s.host.sdk.reread(index)).ok, true);
        assert.equal(bare(s), written, `a Re-read of old reply ${index}: byte-identical`);
    }
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    // A reply written with the feature on keeps its mood on a Re-read (the reply as it stood had one).
    await s.say(['~ npc Oren | trust: -3 | impact: major | reason: a second oath']);
    const fresh = await s.say(['~ npc Oren | trust: -3 | impact: major | reason: a third oath']);
    assert.ok(JSON.parse(bare(s)).npcs.oren.mood, 'a new reply gets its mood');
    const moody = bare(s);
    assert.equal((await s.host.sdk.reread(fresh)).ok, true);
    assert.equal(bare(s), moody, 'and a Re-read of that reply keeps it, as it was');
});
