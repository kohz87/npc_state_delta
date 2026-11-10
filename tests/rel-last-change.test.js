// "Last relationship change" on the dossier card while hosted: what the newest reply did to the four built-in meters (the slice's
// `sliceChange`, from npc-meters-pacing.js lastChangeOf), the scanner's sidecar record, and which one shows. Driven through the
// production adapter on the synthetic host (tests/helpers/pacing-suite.js); the card is dossierDetailProjection + the HTML/step helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dossierDetailProjection, lastRelationshipChangeHtml, relationshipStepHtml } from '../dossier-ui.js';
import { major, suite } from './helpers/pacing-suite.js';

const ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
// The card's view of Oren as the dossier reads her: the sidecar record, with the slice's numbers and last change (sliceView).
const cardOf = (s, id = 'npc_oren') => dossierDetailProjection(s.adapter.sliceView([s.delta.records[id]])[0]).lastRelationshipChange;
const htmlOf = change => lastRelationshipChangeHtml(change);
// The apostrophe in the held words is escaped in the markup (what the reader sees is the same words).
const HELD_TEXT = 'Held: today&#039;s ordinary and meaningful are used. Nothing moved.';

test('(1) a story "~ npc" line moved the meters: the card shows the moved amounts, From the story, and the step shows the same numbers on the latest reply', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +2 | affection: -1 | impact: meaningful']);
        const meters = s.npc('Oren').meters;
        assert.equal(meters.trust, 2, 'meaningful is 2 points');
        assert.equal(meters.affection, -1);
        const change = cardOf(s);
        assert.equal(change.impact, 'slice');
        assert.equal(change.origin, 'story');
        assert.equal(change.message, reply, 'stamped with the latest reply');
        assert.deepEqual(change.delta, { trust: meters.trust, affection: meters.affection, desire: 0, tension: 0 }, 'the moved amounts, the same as the meters');
        const html = htmlOf(change);
        assert.match(html, /<span class="delta-rel-origin">From the story<\/span>/);
        assert.match(html, /Trust \+2/);
        assert.match(html, /Affection -1/);
        assert.match(html, /delta-rel-impact-meaningful">Meaningful</, 'the tier the line spent, kept on the window');
        assert.match(html, new RegExp(`Reply #${reply}`));
        // The ▲/▼ on the meters, on the latest reply, uses the same numbers.
        assert.match(relationshipStepHtml('trust', 'Trust', change, s.host.store.headIndex()), />▲2<\/span>$/);
        assert.match(relationshipStepHtml('affection', 'Affection', change, s.host.store.headIndex()), />▼1<\/span>$/);
        // One reply later the change is history: no step beside the meters.
        const later = await s.say();
        assert.equal(relationshipStepHtml('trust', 'Trust', cardOf(s), later), '');
    } finally { s.host.close(); }
});

test('(2) the daily allowance held the change: "Held: ... Nothing moved." and no amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        for (let n = 0; n < 3; n += 1) await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        assert.deepEqual([s.day('oren').ordinary, s.day('oren').meaningful], [3, 1], 'today: ordinary and meaningful are used up');
        const before = s.npc('Oren').meters.trust;
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        assert.equal(s.npc('Oren').meters.trust, before, 'nothing moved');
        const change = cardOf(s);
        assert.equal(change.held, "today's ordinary and meaningful are used");
        assert.equal(change.message, reply);
        assert.deepEqual(change.delta, ZERO);
        const html = htmlOf(change);
        assert.match(html, new RegExp(HELD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(html, /delta-rel-delta-/, 'no amounts are listed');
        assert.doesNotMatch(html, /Progress only/, 'a held change is not progress');
        assert.equal(relationshipStepHtml('trust', 'Trust', change, reply), '', 'no step: nothing moved');
    } finally { s.host.close(); }
});

test('(3) a scanner change moved the meters: From the scanner, the sidecar\'s reason and impact, and the moved (not proposed) amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(3);
        await s.say([major()]);   // today's major is used: the scanner's major is cut to meaningful
        const reply = await s.say();
        // The scanner proposed trust +3 / affection +3 at a major; the slice moved what the used tier allowed (2).
        const start = { trust: 3, affection: 0, desire: 0, tension: 0 };
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 3, affection: 3 }, start, reply, impact: 'major' });
        const meters = s.npc('Oren').meters;
        assert.deepEqual([meters.trust, meters.affection], [5, 2], 'counted as meaningful: each meter at most 2');
        s.delta.records.npc_oren = {
            ...s.delta.records.npc_oren,
            lastRelationshipChange: { impact: 'major', delta: { trust: 3, affection: 3, desire: 0, tension: 0 }, reason: 'She trusted him with the key.', message: reply, turn: 4 },
        };
        const change = cardOf(s);
        assert.equal(change.origin, 'scanner');
        assert.equal(change.impact, 'major', 'the scanner\'s impact, from the sidecar');
        assert.equal(change.reason, 'She trusted him with the key.');
        assert.equal(change.message, reply);
        assert.deepEqual(change.delta, { trust: 2, affection: 2, desire: 0, tension: 0 }, 'moved amounts (net from the reply start), not the proposed 3');
        const html = htmlOf(change);
        assert.match(html, /<span class="delta-rel-origin">From the scanner<\/span>/);
        assert.match(html, /She trusted him with the key\./);
        assert.match(html, /delta-rel-impact-major/);
        assert.match(relationshipStepHtml('trust', 'Trust', change, reply), />▲2<\/span>$/);
    } finally { s.host.close(); }
});

test('(4a) newest wins: a newer story reply beats an older sidecar change, which is not shown', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        s.delta.records.npc_oren = { ...s.delta.records.npc_oren, lastRelationshipChange: { impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: 0 }, reason: 'An old kindness.', message: 1, turn: 1 } };
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: ordinary']);
        assert.ok(reply > 1);
        const change = cardOf(s);
        assert.equal(change.origin, 'story');
        assert.equal(change.reason, '', 'the older reason is not carried onto the newer change');
        assert.equal(change.message, reply);
        assert.doesNotMatch(htmlOf(change), /An old kindness/);
    } finally { s.host.close(); }
});

test('(4b) newest wins: the same reply keeps the sidecar\'s reason and impact with the slice\'s moved amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(3);
        const reply = await s.say();
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 5 }, start: ZERO, reply, impact: 'major' });
        const moved = s.npc('Oren').meters.trust;
        s.delta.records.npc_oren = { ...s.delta.records.npc_oren, lastRelationshipChange: { impact: 'major', delta: { trust: 5, affection: 0, desire: 0, tension: 0 }, reason: 'A scanner reason.', message: reply, turn: 4 } };
        const change = cardOf(s);
        assert.equal(change.origin, 'scanner');
        assert.equal(change.reason, 'A scanner reason.');
        assert.equal(change.impact, 'major');
        assert.equal(change.delta.trust, moved);
    } finally { s.host.close(); }
});

test('(4c) newest wins: a manual edit on the latest reply keeps "Manual edit" and its own amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: ordinary']);
        s.delta.records.npc_oren = { ...s.delta.records.npc_oren, lastRelationshipChange: { impact: 'manual', delta: { trust: 4, affection: 0, desire: 0, tension: 0 }, reason: 'Manual dossier adjustment by player.', message: reply, turn: 2 } };
        const change = cardOf(s);
        assert.equal(change.impact, 'manual');
        assert.equal(change.origin, undefined, 'no From chip on a manual edit');
        assert.equal(change.delta.trust, 4, 'the edit\'s own amounts, not the slice\'s');
        const html = htmlOf(change);
        assert.match(html, />Manual edit</);
        assert.doesNotMatch(html, /From the (story|scanner)/);
    } finally { s.host.close(); }
});

test('(4d) newest wins: a manual edit from an earlier reply gives way to a newer story change', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const first = await s.say();
        s.delta.records.npc_oren = { ...s.delta.records.npc_oren, lastRelationshipChange: { impact: 'manual', delta: { trust: 4, affection: 0, desire: 0, tension: 0 }, reason: 'Manual dossier adjustment by player.', message: first, turn: 2 } };
        const reply = await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        const change = cardOf(s);
        assert.equal(change.impact, 'slice');
        assert.equal(change.origin, 'story');
        assert.equal(change.message, reply);
        assert.doesNotMatch(htmlOf(change), /Manual edit/);
    } finally { s.host.close(); }
});

test('(5) standalone (not hosted): the card markup and projection are byte-identical to the released output', () => {
    const fixtures = {
        meaningful: { id: 'a', name: 'A', lastRelationshipChange: { impact: 'meaningful', delta: { trust: 3, affection: 0, desire: 0, tension: -1 }, reason: 'She trusted him with the key.', message: 14 } },
        manual: { id: 'b', name: 'B', lastRelationshipChange: { impact: 'manual', delta: { trust: 2 }, reason: 'Manual dossier adjustment by player.', message: 14, turn: 3 } },
        progress: { id: 'c', name: 'C', lastRelationshipChange: { impact: 'ordinary', delta: {}, reason: 'Small kindness.', turn: 3 } },
        none: { id: 'd', name: 'D' },
    };
    const got = {};
    for (const [key, npc] of Object.entries(fixtures)) {
        const change = dossierDetailProjection(npc).lastRelationshipChange;
        got[key] = { projection: JSON.stringify(change), html: lastRelationshipChangeHtml(change) };
    }
    got.step = relationshipStepHtml('trust', 'Trust', dossierDetailProjection(fixtures.meaningful).lastRelationshipChange, 14);
    assert.deepEqual(got, GOLDEN);
});

// Captured from origin/main (the released code) with the same fixtures; the hosted-only keys (origin, held, the slice's impact) are absent.
const GOLDEN = {
    "meaningful": {
        "projection": "{\"impact\":\"meaningful\",\"delta\":{\"trust\":3,\"affection\":0,\"desire\":0,\"tension\":-1},\"reason\":\"She trusted him with the key.\",\"turn\":null,\"message\":14,\"when\":\"Reply #14\"}",
        "html": "<div class=\"delta-rel-last\">\n        <div class=\"delta-rel-last-head\"><h4>Last relationship change</h4><span class=\"delta-rel-impact delta-rel-impact-meaningful\">Meaningful</span><small>Reply #14</small></div>\n        <div class=\"delta-rel-deltas\"><span class=\"delta-rel-delta delta-rel-delta-up delta-rel-trust\">Trust +3</span><span class=\"delta-rel-delta delta-rel-delta-down delta-rel-tension\">Tension -1</span></div>\n        <p>She trusted him with the key.</p>\n    </div>"
    },
    "manual": {
        "projection": "{\"impact\":\"manual\",\"delta\":{\"trust\":2,\"affection\":0,\"desire\":0,\"tension\":0},\"reason\":\"Manual dossier adjustment by player.\",\"turn\":3,\"message\":14,\"when\":\"Reply #14\"}",
        "html": "<div class=\"delta-rel-last\">\n        <div class=\"delta-rel-last-head\"><h4>Last relationship change</h4><span class=\"delta-rel-impact delta-rel-impact-manual\">Manual edit</span><small>Reply #14</small></div>\n        <div class=\"delta-rel-deltas\"><span class=\"delta-rel-delta delta-rel-delta-up delta-rel-trust\">Trust +2</span></div>\n        <p>Manual dossier adjustment by player.</p>\n    </div>"
    },
    "progress": {
        "projection": "{\"impact\":\"ordinary\",\"delta\":{\"trust\":0,\"affection\":0,\"desire\":0,\"tension\":0},\"reason\":\"Small kindness.\",\"turn\":3,\"message\":null,\"when\":\"Turn 3\"}",
        "html": "<div class=\"delta-rel-last\">\n        <div class=\"delta-rel-last-head\"><h4>Last relationship change</h4><span class=\"delta-rel-impact delta-rel-impact-ordinary\">Ordinary</span><small class=\"delta-legacy-turn\" title=\"Changed at turn 3 (Delta&#039;s own scan count, recorded before 1.2.3; it is not the reply number)\">Turn 3</small></div>\n        <div class=\"delta-rel-deltas\"><span class=\"delta-rel-delta delta-rel-delta-progress\">Progress only · no point change</span></div>\n        <p>Small kindness.</p>\n    </div>"
    },
    "none": {
        "projection": "{\"impact\":\"none\",\"delta\":{\"trust\":0,\"affection\":0,\"desire\":0,\"tension\":0},\"reason\":\"\",\"turn\":null,\"message\":null,\"when\":\"\"}",
        "html": "<div class=\"delta-rel-last\"><h4>Last relationship change</h4><p class=\"delta-muted\">No relationship change recorded yet.</p></div>"
    },
    "step": "<span class=\"delta-rel-step delta-rel-step-good\" title=\"Trust up 3 since the last reply (reply #14)\" aria-label=\"Trust up 3 since the last reply (reply #14)\">▲3</span>"
};

// ---- what was asked, its tier and the story date (turn.ask / turn.tier / turn.date on the slice record's reply window) ----
import { storyMinuteText } from '../calendar.js';
import { DAY } from './helpers/pacing-suite.js';
import { lastChangeOf } from '../src/npc-meters-pacing.js';
import { validateNpcSlice } from '../src/npc-meters-slice.js';

const dateOfDay = day => storyMinuteText(day * DAY + 30);
const windowOf = (s, name = 'oren') => s.host.head().domains.npc.npcs[name].turn;
// The window without its reply id (a swipe is a new reply with its own id).
const shown = s => JSON.stringify({ ...windowOf(s), reply: 0 });
// Fill the day so an ordinary and a meaningful event are both held.
const fillDay = async s => {
    await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
    for (let n = 0; n < 3; n += 1) await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
};

test('(6) a story line stores what it asked, the tier it spent and the date before the reply; the card shows the tier chip and "Reply #N · date"', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +2 | affection: +1 | impact: meaningful']);
        const turn = windowOf(s);
        assert.deepEqual(turn.ask, { trust: 2, affection: 1 });
        assert.equal(turn.tier, 'meaningful');
        assert.equal(turn.date, dateOfDay(1));
        assert.deepEqual([s.npc('Oren').meters.trust, s.npc('Oren').meters.affection], [2, 1], 'meter values as before');
        assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
        const change = cardOf(s);
        assert.equal(change.tier, 'meaningful');
        const html = htmlOf(change);
        assert.match(html, /delta-rel-impact-meaningful">Meaningful</, 'the chip for a story-line change');
        assert.match(html, new RegExp(`Reply #${reply} · ${dateOfDay(1)}`));
        assert.doesNotMatch(html, /Asked:/, 'Asked only on a held change');
    } finally { s.host.close(); }
});

test('(7) a forwarded scanner change stores asked amounts, the tier it spent (the cut one) and the date', async () => {
    const s = await suite();
    try {
        await s.setDay(3);
        await s.say([major()]);
        const reply = await s.say();
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 3, affection: 3 }, start: { trust: 3, affection: 0, desire: 0, tension: 0 }, reply, impact: 'major' });
        const turn = windowOf(s);
        assert.deepEqual(turn.ask, { trust: 3, affection: 3 }, 'before the cut');
        assert.equal(turn.tier, 'meaningful', 'the tier the event spent');
        assert.equal(turn.date, dateOfDay(3));
        assert.deepEqual([s.npc('Oren').meters.trust, s.npc('Oren').meters.affection], [5, 2], 'meter values as before');
    } finally { s.host.close(); }
});

test('(8) a held change shows "Asked: ..." and names the asked tier; an ordinary ask on a full day names only ordinary', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await fillDay(s);
        const reply = await s.say(['~ npc Oren | trust: +1 | affection: +1 | impact: ordinary']);
        const turn = windowOf(s);
        assert.deepEqual([turn.ask, turn.tier], [{ trust: 1, affection: 1 }, 'ordinary']);
        const change = cardOf(s);
        assert.equal(change.held, "today's ordinary is used", 'the asked tier, not every full tier');
        const html = htmlOf(change);
        assert.match(html, /Asked: Trust \+1, Affection \+1/);
        assert.match(html, /Held: today&#039;s ordinary is used\. Nothing moved\./);
        assert.match(html, /delta-rel-impact-ordinary">Ordinary</);
        assert.match(html, new RegExp(`Reply #${reply} · ${dateOfDay(1)}`));
        // A meaningful ask reads both tiers.
        await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        assert.equal(cardOf(s).held, "today's ordinary and meaningful are used");
        assert.match(htmlOf(cardOf(s)), /Asked: Trust \+2/);
    } finally { s.host.close(); }
});

test('(9) swipe, rebuild and reload keep ask, tier and date; a swipe replaces them with its own', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await fillDay(s);
        await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        const kept = shown(s);
        assert.match(kept, /"ask":\{"trust":2\}.*"tier":"meaningful"/);
        await s.swipe(['~ npc Oren | trust: +2 | impact: meaningful']);
        assert.equal(shown(s), kept, 'the same line again');
        await s.swipe(['~ npc Oren | affection: +1 | impact: ordinary']);
        assert.deepEqual([windowOf(s).ask, windowOf(s).tier], [{ affection: 1 }, 'ordinary'], 'the swipe is its own reply: nothing of the old one stays');
        await s.swipe(['~ npc Oren | trust: +2 | impact: meaningful']);
        assert.equal(shown(s), kept, 'back to the first');
        const head = JSON.stringify(s.host.head());
        s.host.store.rebuild();
        assert.equal(JSON.stringify(s.host.head()), head, 'rebuild equals live');
        await s.host.st.loadChat(s.host.ctx.chat);
        await s.adapter.ticked();
        assert.equal(shown(s), kept, 'a cold reload keeps them');
        assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    } finally { s.host.close(); }
});

test('(10) no clock: no date is stored; an old record without ask, tier or date renders without them and validates', async () => {
    const s = await suite({ clock: false });
    try {
        await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        assert.equal(windowOf(s).date, undefined);
        assert.deepEqual(windowOf(s).ask, { trust: 1 });
    } finally { s.host.close(); }
    const old = { meters: { trust: 2, affection: 0, desire: 0, tension: 0 }, turn: { reply: 5, from: { trust: 0, affection: 0, desire: 0, tension: 0 }, story: ['trust'] } };
    const last = lastChangeOf(old, null);
    assert.deepEqual(Object.keys(last).sort(), ['delta', 'held', 'reply', 'source']);
    assert.deepEqual(validateNpcSlice({ npcs: { oren: { name: 'Oren', ...old, stages: {}, unlocked: [], milestones: {} } }, problems: [] }), []);
    const html = lastRelationshipChangeHtml(dossierDetailProjection({ id: 'x', name: 'X', sliceChange: last }).lastRelationshipChange);
    assert.match(html, /Trust \+2/);
    assert.doesNotMatch(html, /Asked:|·|delta-rel-impact-/);
    assert.ok(validateNpcSlice({ npcs: { oren: { name: 'Oren', ...old, turn: { ...old.turn, tier: 'huge' }, stages: {}, unlocked: [], milestones: {} } }, problems: [] }).length, 'a bad tier is refused');
});
