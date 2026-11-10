// "Last relationship change" on the dossier card while hosted: what Story Block's own receipts say the newest reply did to the four
// built-in meters (src/npc-meters-pacing.js lastChangeOf, through adapter.dossierChanges), the scanner's sidecar record, and which one
// shows. Nothing is stored for it. Driven through the production adapter on the synthetic host (tests/helpers/pacing-suite.js); the
// card is dossierDetailProjection (with the host change) + the HTML/step helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dossierDetailProjection, lastRelationshipChangeHtml, relationshipStepHtml } from '../dossier-ui.js';
import { lastChangeOf } from '../src/npc-meters-pacing.js';
import { storyMinuteText } from '../calendar.js';
import { DAY, major, suite } from './helpers/pacing-suite.js';

const ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
const dateOfDay = day => storyMinuteText(day * DAY + 30);
// The card of Oren as the dossier view builds it: her record (with an optional scanner sidecar change), the host's change for her.
const npcOf = (s, side) => ({ ...s.delta.records.npc_oren, ...(side ? { lastRelationshipChange: side } : {}) });
const cardOf = (s, side) => {
    const npc = npcOf(s, side);
    return dossierDetailProjection(npc, {}, {}, { hostChange: s.adapter.dossierChanges([npc]).npc_oren ?? null }).lastRelationshipChange;
};
const side = (reply, extra = {}) => ({ impact: 'major', delta: { trust: 3, affection: 3, desire: 0, tension: 0 }, reason: 'She trusted him with the key.', message: reply, turn: 4, ...extra });
const htmlOf = change => lastRelationshipChangeHtml(change);
const HELD_TEXT = 'Held: today&#039;s ordinary and meaningful are used. Nothing moved.';
// What the slice keeps for a reply's window: nothing but what origin/main kept (no ask, tier or date).
const windowKeys = s => Object.keys(s.host.head().domains.npc.npcs.oren.turn).sort().join();
const sliceBytes = s => JSON.stringify(s.host.head().domains.npc);
const fillDay = async s => {
    await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
    for (let n = 0; n < 3; n += 1) await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
};

test('(1) mockup case 1: a story "~ npc" line moved the meters: the amounts from its receipt, From the story, "Reply #N · date", and the step shows the same numbers', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +1 | affection: +1 | desire: +1 | tension: +1']);
        const change = cardOf(s);
        assert.equal(change.origin, 'story');
        assert.equal(change.message, reply);
        assert.deepEqual(change.delta, { trust: 1, affection: 1, desire: 1, tension: 1 });
        assert.equal(change.date, dateOfDay(1), 'the story date before the reply');
        const html = htmlOf(change);
        assert.match(html, /<span class="delta-rel-origin">From the story<\/span>/);
        assert.match(html, new RegExp(`Reply #${reply} · ${dateOfDay(1)}`));
        assert.match(html, /Trust \+1.*Affection \+1.*Desire \+1.*Tension \+1/s);
        assert.match(relationshipStepHtml('trust', 'Trust', change, s.host.store.headIndex()), />▲1<\/span>$/);
        assert.equal(relationshipStepHtml('trust', 'Trust', cardOf(s), await s.say()), '', 'one reply later: history, no step');
        assert.equal(cardOf(s).message, reply, 'a reply that touched nobody leaves the last change as it was');
    } finally { s.host.close(); }
});

test('(2) mockup case 2: the daily allowance held the change: "Held: ... Nothing moved." before Asked; no amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await fillDay(s);
        const before = s.npc('Oren').meters.trust;
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        assert.equal(s.npc('Oren').meters.trust, before, 'nothing moved');
        const change = cardOf(s);
        assert.equal(change.held, "today's ordinary and meaningful are used");
        assert.equal(change.message, reply);
        assert.deepEqual(change.delta, ZERO);
        const html = htmlOf(change);
        assert.match(html, new RegExp(HELD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(html, /delta-rel-delta-|Progress only/);
        assert.equal(relationshipStepHtml('trust', 'Trust', change, reply), '');
        assert.deepEqual(change.ask, { trust: 2 }, 'the receipt of a fully held event names what was asked');
        assert.match(htmlOf(change), /Asked: Trust \+2/);
        assert.equal(change.tier, 'meaningful', 'the asked tier of a held event');
        // A meter held at its cap names what it asked, after Held (the receipt\'s "+N asked").
        await s.setDay(2);
        await s.say(['~ npc Oren | trust: +9 | impact: ordinary']);
        const capped = cardOf(s);
        assert.deepEqual(capped.ask, { trust: 9 }, 'what the line asked, held to the tier\'s cap');
        const capHtml = htmlOf(capped);
        assert.match(capHtml, /Asked: Trust \+9/);
        assert.ok(htmlOf({ ...change, ask: { trust: 1 } }).indexOf('delta-rel-held') < htmlOf({ ...change, ask: { trust: 1 } }).indexOf('delta-rel-asked'), 'Held comes before Asked');
    } finally { s.host.close(); }
});

test('(3) mockup case 3: the scanner moved it: From the scanner, its reason (its receipt moved a meter), the tier it was cut to, the moved amounts', async () => {
    const s = await suite();
    try {
        await s.setDay(3);
        await s.say([major()]);   // today's major is used: the scanner's major is cut to meaningful
        const reply = await s.say();
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 3, affection: 3 }, start: { trust: 3, affection: 0, desire: 0, tension: 0 }, reply, impact: 'major' });
        const change = cardOf(s, side(reply));
        assert.equal(change.origin, 'scanner');
        assert.equal(change.reason, 'She trusted him with the key.');
        assert.equal(change.tier, 'meaningful', 'the tier actually spent, not the major the scanner asked');
        assert.deepEqual(change.delta, { trust: 2, affection: 2, desire: 0, tension: 0 }, 'moved amounts, not the proposed 3');
        const html = htmlOf(change);
        assert.match(html, /From the scanner/);
        assert.match(html, /delta-rel-impact-meaningful">Meaningful</);
        assert.doesNotMatch(html, /delta-rel-impact-major/);
        assert.match(html, /She trusted him with the key\./);
        assert.match(relationshipStepHtml('trust', 'Trust', change, reply), />▲2<\/span>$/);
    } finally { s.host.close(); }
});

test('(4) the receipts are the authority: a scanner reason on a reply whose scanner change moved nothing is not shown (yielded to the story line, or never forwarded)', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: meaningful']);
        // Never forwarded: the sidecar holds a scanner proposal for the same reply, the receipts hold only the story line.
        let change = cardOf(s, side(reply, { delta: { trust: 9, affection: 9, desire: 0, tension: 0 } }));
        assert.equal(change.origin, 'story');
        assert.equal(change.reason, '', 'no reason without proof the scanner moved it');
        assert.equal(change.delta.trust, 2, 'the receipt\'s amounts, not the scanner\'s proposal');
        // Forwarded, but the story line already named trust: the scanner yielded, its receipt moved nothing.
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 3 }, start: ZERO, reply, impact: 'meaningful' });
        assert.equal(s.npc('Oren').meters.trust, 2);
        change = cardOf(s, side(reply));
        assert.equal(change.origin, 'story');
        assert.equal(change.reason, '');
        assert.doesNotMatch(htmlOf(change), /She trusted him/);
        // A scanner change on an axis the story did not name moved it: its reason shows.
        await s.adapter.adjust({ name: 'Oren', meters: { affection: 1 }, start: ZERO, reply, impact: 'ordinary' });
        change = cardOf(s, side(reply));
        assert.equal(change.reason, 'She trusted him with the key.');
        assert.deepEqual([change.delta.trust, change.delta.affection], [2, 1]);
    } finally { s.host.close(); }
});

test('(5) newest wins: a newer reply\'s receipts beat an older sidecar change; the same reply\'s manual edit stays; an older manual edit gives way', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const first = await s.say();
        const old = { impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: 0 }, reason: 'An old kindness.', message: first, turn: 1 };
        const reply = await s.say(['~ npc Oren | trust: +2 | impact: ordinary']);
        assert.equal(cardOf(s, old).reason, '');
        assert.doesNotMatch(htmlOf(cardOf(s, old)), /An old kindness/);
        const manual = { impact: 'manual', delta: { trust: 4, affection: 0, desire: 0, tension: 0 }, reason: 'Manual dossier adjustment by player.', message: reply, turn: 2 };
        const kept = cardOf(s, manual);
        assert.equal(kept.impact, 'manual');
        assert.equal(kept.origin, undefined);
        assert.match(htmlOf(kept), />Manual edit</);
        assert.equal(cardOf(s, { ...manual, message: first }).origin, 'story', 'an earlier manual edit gives way');
        assert.equal(cardOf(s, { ...manual, message: reply + 3 }).impact, 'manual', 'a newer sidecar record than any receipt stays');
    } finally { s.host.close(); }
});

test('(6) the last change survives replies that moved nothing and is the one that remains after a swipe, a middle deletion and a reload; the slice is untouched', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await s.say(['~ npc Oren | trust: +1', '~ npc Sister Temiwa | trust: +1']);
        const kept = await s.say(['~ npc Oren | affection: +1 | impact: ordinary']);
        const keep = await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        assert.equal(cardOf(s).message, keep);
        assert.match(windowKeys(s), /^at,from,reply(,story)?$/, 'the window keeps what it always kept: no ask, tier or date');
        // A swipe is its own reply: the card is the swipe\'s.
        await s.swipe(['~ npc Oren | desire: +1 | impact: ordinary']);
        assert.deepEqual(cardOf(s).delta, { trust: 0, affection: 0, desire: 1, tension: 0 });
        await s.swipe(['~ npc Oren | trust: +1 | impact: ordinary']);
        const head = sliceBytes(s);
        assert.deepEqual(cardOf(s).delta, { trust: 1, affection: 0, desire: 0, tension: 0 });
        // Deleting the newest reply leaves the earlier one\'s card; deleting a middle one leaves the newest.
        const cards = JSON.stringify(cardOf(s));
        s.host.store.rebuild();
        assert.equal(sliceBytes(s), head, 'rebuild: the same slice bytes');
        assert.equal(JSON.stringify(cardOf(s)), cards);
        await s.host.st.loadChat(s.host.ctx.chat);
        await s.adapter.ticked();
        assert.equal(sliceBytes(s), head, 'reload: the same slice bytes');
        assert.equal(JSON.stringify(cardOf(s)), cards, 'reload: the same card');
        await s.host.st.deleteMessage(kept);
        await s.host.st.deleteMessage(kept - 1);
        await s.adapter.ticked();
        assert.equal(cardOf(s).message, keep - 2, 'the reply that remains, at its new index');
        await s.host.st.deleteMessage(s.host.ctx.chat.length - 1);
        await s.host.st.deleteMessage(s.host.ctx.chat.length - 1);
        await s.adapter.ticked();
        assert.notEqual(cardOf(s).message, keep - 2, 'the deleted newest reply no longer gives the card');
        assert.deepEqual(s.host.store.problems(), []);
    } finally { s.host.close(); }
});

test('(7) nothing is persisted: reading the card leaves the dossiers, sliceView and the scan base without it; a standalone chat reads nothing', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const reply = await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        const stored = JSON.stringify(s.delta.records);
        const changes = s.adapter.dossierChanges(Object.values(s.delta.records));
        assert.equal(changes.npc_oren.reply, reply);
        assert.equal(JSON.stringify(s.delta.records), stored, 'the stored dossiers are untouched');
        const view = s.adapter.sliceView(Object.values(s.delta.records));
        assert.ok(view.every(npc => !('sliceChange' in npc) && !('hostChange' in npc)), 'the meter view the scan, checkpoints and injection read has no change');
        await s.swipe(['~ npc Oren | trust: +2 | impact: ordinary']);
        await s.host.st.loadChat(s.host.ctx.chat);
        await s.adapter.ticked();
        assert.equal(JSON.stringify(s.delta.records), stored);
        assert.ok(!JSON.stringify(s.host.head()).includes('sliceChange'));
        // No receipts to read (not hosted, or a host without them): no change, the sidecar alone as released.
        assert.deepEqual(s.adapter.dossierChanges([{ id: 'npc_nobody', name: 'Nobody' }]), {});
        const alone = dossierDetailProjection(npcOf(s, side(reply)), {}, {}, {}).lastRelationshipChange;
        assert.equal(alone.reason, 'She trusted him with the key.');
        assert.equal(alone.origin, undefined);
        assert.match(fs.readFileSync(new URL('../runtime-hosted.js', import.meta.url), 'utf8'), /dossierChanges\?\.\(state\.npcs\)/);
        assert.match(fs.readFileSync(new URL('../runtime-entry-public-write.js', import.meta.url), 'utf8'), /dossierHostViews\(state\)\]\)/, 'the open panel\'s refresh token includes the host views');
    } finally { s.host.close(); }
});

test('(8) an open panel refreshes on a held-only change: the displayed change moves while the meters do not', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        await fillDay(s);
        const meters = JSON.stringify(s.host.head().domains.npc.npcs.oren.meters);
        const was = JSON.stringify(s.adapter.dossierChanges(Object.values(s.delta.records)));
        await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        assert.equal(JSON.stringify(s.host.head().domains.npc.npcs.oren.meters), meters, 'no meter moved');
        assert.notEqual(JSON.stringify(s.adapter.dossierChanges(Object.values(s.delta.records))), was, 'the host view the token carries changed');
    } finally { s.host.close(); }
});

test('(9) no clock or the reader keeps the calendar here: "Reply #N" only; a receipt without data (trimmed) or another person\'s is skipped', async () => {
    const s = await suite({ clock: false });
    try {
        const reply = await s.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        const change = cardOf(s);
        assert.equal(change.date, undefined);
        assert.match(htmlOf(change), new RegExp(`Reply #${reply}</small>`));
    } finally { s.host.close(); }
    const owned = await suite({ calendarOwn: true });
    try {
        await owned.setDay(1);
        assert.equal(cardOf(owned).date, undefined, 'no date');
        await owned.say(['~ npc Oren | trust: +1 | impact: ordinary']);
        assert.equal(cardOf(owned).date, undefined);
    } finally { owned.host.close(); }
    const receipt = (type, data, summary = '') => ({ index: 4, receipt: { module: 'npc-state-delta', type, summary, data } });
    assert.equal(lastChangeOf([receipt('npc.adjust', { key: 'oren' })], 'oren'), null, 'trimmed data');
    assert.equal(lastChangeOf([receipt('npc.adjust', { key: 'other', changes: [{ meter: 'trust', before: 0, after: 1 }] })], 'oren'), null);
    assert.equal(lastChangeOf([receipt('npc.set', { key: 'oren', changes: [{ meter: 'trust', before: 0, after: 1 }] })], 'oren'), null, 'the reader\'s own set is not a story change');
});

test('(10) standalone (not hosted): the card markup and projection are byte-identical to the released output', () => {
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

// The receipts of Oren's meter changes, as [{ index, receipt }] (what Story Block's receipts() gives).
const oren = s => s.host.store.receipts().filter(({ receipt }) => receipt.module === 'npc-state-delta' && receipt.data?.key === 'oren' && Array.isArray(receipt.data.changes));

test('(11) the meter receipts carry ask and tier (display-only): a story line, a scanner change that yields an axis, a held change; the card shows Asked and the chip; slice bytes stay', async () => {
    const s = await suite();
    try {
        await s.setDay(1);
        const first = await s.say(['~ npc Oren | trust: +1 | affection: +1 | impact: ordinary']);
        const story = oren(s).filter(item => item.index === first).at(-1).receipt;
        assert.equal(story.type, 'capture.npc');
        assert.deepEqual(story.data.ask, { trust: 1, affection: 1 });
        assert.equal(story.data.tier, 'ordinary');
        const html = htmlOf(cardOf(s));
        assert.match(html, /delta-rel-impact-ordinary">Ordinary</, 'the chip for an uncut change');
        assert.doesNotMatch(html, /Asked:/, 'nothing was held: no Asked');
        // A scanner change on the reply: the axis the story named is left out of its ask; the tier is the one spent.
        await s.adapter.adjust({ name: 'Oren', meters: { trust: 3, desire: 2 }, start: ZERO, reply: first, impact: 'meaningful' });
        const scan = oren(s).filter(item => item.receipt.type === 'npc.adjust').at(-1).receipt;
        assert.deepEqual(scan.data.ask, { desire: 2 });
        assert.equal(scan.data.tier, 'meaningful');
        // A held change: the day's ordinary is used.
        await s.setDay(2);
        await fillDay(s);
        const held = await s.say(['~ npc Oren | trust: +2 | affection: +1 | impact: meaningful']);
        const receipt = oren(s).filter(item => item.index === held).at(-1).receipt;
        assert.deepEqual(receipt.data.changes, []);
        assert.deepEqual(receipt.data.ask, { trust: 2, affection: 1 });
        assert.equal(receipt.data.tier, 'meaningful');
        const change = cardOf(s);
        assert.deepEqual(change.ask, { trust: 2, affection: 1 });
        assert.equal(change.tier, 'meaningful');
        assert.match(htmlOf(change), /Asked: Trust \+2.*Affection \+1/s);
        assert.match(htmlOf(change), /delta-rel-impact-meaningful">Meaningful</);
        // Nothing that replays reads them: the slice holds neither, and keeps its bytes through rebuild, reload, swipe and deletion.
        assert.doesNotMatch(sliceBytes(s), /"ask"|"tier"/);
        const bytes = sliceBytes(s);
        s.host.store.rebuild();
        assert.equal(sliceBytes(s), bytes);
        await s.host.st.loadChat(s.host.ctx.chat);
        await s.adapter.ticked();
        assert.equal(sliceBytes(s), bytes);
        await s.swipe(['~ npc Oren | desire: +1 | impact: ordinary']);
        assert.deepEqual(oren(s).filter(item => item.index === s.host.store.headIndex()).at(-1).receipt.data.ask, { desire: 1 }, 'the swipe has its own receipt');
        assert.doesNotMatch(sliceBytes(s), /"ask"|"tier"/);
        await s.host.st.deleteMessage(s.host.ctx.chat.length - 1);
        await s.host.st.deleteMessage(s.host.ctx.chat.length - 1);
        await s.adapter.ticked();
        assert.doesNotMatch(sliceBytes(s), /"ask"|"tier"/);
        assert.deepEqual(s.host.store.problems(), []);
    } finally { s.host.close(); }
});

test('(12) older receipts without ask or tier read as before: the summary\'s "+N asked" and the cut note; a fully held one shows no Asked and no chip', () => {
    const at = (summary, data) => [{ index: 5, receipt: { module: 'npc-state-delta', type: 'capture.npc', summary, data: { key: 'oren', ...data } } }];
    const cut = lastChangeOf(at('Oren: trust 0 → 2 (major counted as meaningful: today\'s major is used)', { changes: [{ meter: 'trust', before: 0, after: 2, held: true }] }), 'oren');
    assert.equal(cut.tier, 'meaningful');
    assert.equal(cut.ask, undefined);
    const capped = lastChangeOf(at('Oren: trust 0 → 1 (held at 1; +9 asked)', { changes: [{ meter: 'trust', before: 0, after: 1, held: true }] }), 'oren');
    assert.deepEqual(capped.ask, { trust: 9 });
    const heldOld = lastChangeOf(at('Oren: nothing changed (today\'s ordinary is used)', { changes: [] }), 'oren');
    assert.equal(heldOld.held, 'today\'s ordinary is used');
    assert.equal(heldOld.ask, undefined);
    assert.equal(heldOld.tier, undefined);
    // Malformed ask and tier are ignored; only the four axes, whole numbers.
    const bad = lastChangeOf(at('Oren: nothing changed (today\'s ordinary is used)', { changes: [], ask: { trust: 1.5, mood: 2, desire: 3 }, tier: 'huge' }), 'oren');
    assert.deepEqual(bad.ask, { desire: 3 });
    assert.equal(bad.tier, undefined);
});
