// Relationship pacing against the production mechanics and a synthetic Story Suite host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../src/storysuite-v2.js';
import { validateNpcSlice } from '../src/npc-meters.js';
import { DEFAULT_RELATIONSHIP_CAPS, normalizeNpcRecord } from '../core.js';
import { applyFocusedRelationshipDecisions } from '../src/relationship-pass.js';
import { DEFAULT_IMPACT_CRITERIA } from '../core-prompts-criteria.js';
import { DEFAULT_ALLOWANCE, flatDayProblems, fromFlatDay, impactDayProblems, toFlatDay, normalizeAllowance, pacingDefaults, spendEvent } from '../src/relationship-pacing.js';
import { cutToTier, pacingNote } from '../src/npc-meters-pacing.js';
import { DAY, dossiers, suite, major } from './helpers/pacing-suite.js';

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
    assert.deepEqual(fromFlatDay(flat), { day: 3, reply: 'a', ordinary: 1, meaningful: 0, major: 0, extreme: 0 });
    assert.deepEqual(fromFlatDay({ reply: 'b', 'd2:ordinary': 3, 'd4:meaningful': 1 }), { day: 4, reply: 'b', ordinary: 0, meaningful: 1, major: 0, extreme: 0 }, 'the newest day named is in force; a missing key is zero');
    assert.deepEqual(flatDayProblems(flat), []);
    assert.ok(flatDayProblems({ reply: 'a', 'd3:major': -1, day: 3 }).length >= 2);
    assert.equal(fromFlatDay({ reply: 'a' }), null);
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

for (const seed of [3, 11, 29]) {
    test(`pacing fuzz seed ${seed}: tiers over several story days, middle deletes and swipes; the slice validates and replay equals rebuild`, async t => {
        t.mock.method(console, 'warn', () => {});
        const s = await suite();
        const r = prng(seed);
        await s.say(['~ npc Oren | trust: +1', '~ npc Sister Temiwa | trust: +1']);   // the set-up reply makes both entries and is never deleted
        const setup = s.host.store.headIndex();
        let day = 1;
        for (let step = 0; step < 16; step += 1) {
            if (r.chance(0.4)) { day += r.int(1, 2); await s.setDay(day); }
            const lines = Array.from({ length: r.int(1, 2) }, () => `~ npc ${r.pick(['Oren', 'Sister Temiwa'])} | trust: +${r.int(1, 9)} | affection: ${r.pick(['+', '-'])}${r.int(0, 6)} | impact: ${r.pick(['ordinary', 'meaningful', 'major', 'extreme'])}`);
            const index = await s.say(lines);
            if (r.chance(0.2)) await s.swipe(lines);
            if (step > 3 && r.chance(0.35)) {
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
                const { ordinary, meaningful, major, extreme } = fromFlatDay(record.impactDay);
                assert.ok(major <= 1 && meaningful <= 1 && extreme <= 1 && ordinary <= 3, `${label}: counts stay within the allowance: ${JSON.stringify(record.impactDay)}`);
            }
        }
    });
}
