// Relationship pacing and replay: a middle delete, a cold reload and a chat with no story clock (so no `impactDay`).
// The count is on the slice record, written by the same change as the move it paces (src/npc-meters.js `run`); Story Block
// rebuilds by replaying stored ops only and never runs a handler again (Story_block docs/v2/SPEC.md §2.2, line 216).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNpcSlice } from '../src/npc-meters.js';
import { impactDayProblems } from '../src/relationship-pacing.js';
import { suite, major } from './helpers/pacing-suite.js';

const shape = s => JSON.stringify(s.host.head());

test('middle delete: a later reply keeps the numbers and the day count it recorded, like every other story-line move', async () => {
    const s = await suite();
    await s.setDay(1);
    await s.say([major()]);                 // major: +3
    const middle = await s.say([major()]);  // counted as meaningful: +2
    await s.say([major()]);                 // counted as ordinary: +1 (recorded: trust 6)
    assert.equal(s.npc('Oren').meters.trust, 6);
    await s.host.st.deleteMessage(middle);
    await s.host.st.deleteMessage(middle - 1);
    // Stored ops are replayed as they were recorded: the inertia and the per-reply cap of a story line are not worked out again after
    // a delete, and neither is the day's count. So the third reply still says trust 6 and the count it recorded.
    assert.equal(s.npc('Oren').meters.trust, 6, 'the surviving reply keeps its recorded result');
    const count = s.day('oren');
    assert.deepEqual(impactDayProblems(count), [], 'the count stays whole: never negative, never an unknown field');
    assert.deepEqual(['major', 'meaningful', 'ordinary'].map(tier => count[tier]), [1, 0, 1], 'only the fields the surviving reply changed are replayed: the deleted reply\'s meaningful is not in the count, but the points it gave stay in the recorded trust');
    assert.deepEqual(s.host.store.problems(), []);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const live = shape(s);
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live after the delete');
    // The count goes on from the record: the next major of the day is paced against it (the meaningful slot reads as free).
    await s.say([major()]);
    assert.equal(s.npc('Oren').meters.trust, 8);
    assert.equal(s.day('oren').meaningful, 1);
});

test('middle delete of the first event of a new day keeps the surviving event on that day', { todo: 'later ops omit the unchanged day and day-reset counts' }, async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        await s.setDay(2);
        const middle = await s.say([major()]);
        await s.say([major()]);
        await s.host.st.deleteMessage(middle);
        await s.host.st.deleteMessage(middle - 1);
        const live = shape(s);
        s.host.store.rebuild();
        assert.equal(shape(s), live);
        assert.equal(s.day('oren').day, 2, 'the surviving event belongs to day 2');
        assert.deepEqual(['ordinary', 'meaningful', 'major'].map(tier => s.day('oren')[tier]), [0, 1, 0]);
    } finally { s.host.close(); }
});

test('cold reload and rebuild equal live for impactDay, over days, swipes and a Re-read', async () => {
    const s = await suite();
    await s.setDay(1);
    await s.say([major(), major('Sister Temiwa')]);
    await s.say([major()]);
    await s.swipe([major()]);
    await s.setDay(2);
    const index = await s.say([major(), major('Sister Temiwa')]);
    assert.equal((await s.host.sdk.reread(index)).ok, true);
    const live = shape(s);
    const counts = JSON.stringify([s.day('oren'), s.day('sister-temiwa')]);
    assert.ok(s.day('oren') && s.day('sister-temiwa'), 'both people have a count');
    s.host.store.rebuild();
    assert.equal(shape(s), live, 'rebuild equals live');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(shape(s), live, 'a cold reload equals live');
    assert.equal(JSON.stringify([s.day('oren'), s.day('sister-temiwa')]), counts, 'the counts are the same after the reload');
});

test('a chat with no story clock has no impactDay anywhere, and replays and reloads byte-identical', async () => {
    const s = await suite({ clock: false });
    await s.say([major(), major('Sister Temiwa')]);
    await s.say([major()]);
    await s.say(['~ npc Oren | trust: -2 | impact: meaningful']);
    assert.equal(s.npc('Oren').meters.trust, 4, 'no clock: no limit, every event is worth its tier (3, 3, -2 +... as before)');
    assert.doesNotMatch(shape(s), /impactDay/, 'nothing new was written to the record');
    const live = shape(s);
    const chat = JSON.stringify(s.host.ctx.chat);
    s.host.store.rebuild();
    assert.equal(shape(s), live);
    assert.equal(JSON.stringify(s.host.ctx.chat), chat, 'rebuild does not rewrite the stored chat');
    await s.host.st.loadChat(s.host.ctx.chat);
    await s.adapter.ticked();
    assert.equal(shape(s), live, 'a cold reload of an old-style chat equals live');
    assert.equal(JSON.stringify(s.host.ctx.chat), chat, 'reload does not rewrite the stored chat');
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});
