import test from 'node:test';
import assert from 'node:assert/strict';
import { lastChangeOf } from '../src/npc-meters-pacing.js';
import { DEFAULT_ALLOWANCE } from '../src/relationship-pacing.js';
import { dossierDetailProjection, lastRelationshipChangeHtml, relationshipStepHtml } from '../dossier-ui.js';

const flat = (reply, day, counts) => ({ reply, ...Object.fromEntries(Object.entries(counts).map(([tier, n]) => [`d${day}:${tier}`, n])) });
const full = { ordinary: 3, meaningful: 1, major: 0, extreme: 0 };
const zero = { trust: 0, affection: 0, desire: 0, tension: 0 };
const detail = npc => dossierDetailProjection({ id: 'n', name: 'Nelje', relationship: { trust: 7, affection: 7, desire: 0, tension: 0 }, ...npc });

test('rel-last 1: a story line that moved the meters is read from the window, after pacing', () => {
    const record = { name: 'Nelje', meters: { trust: 7, affection: 7, desire: 1, tension: 1 }, turn: { reply: 22, from: { trust: 6, affection: 6, desire: 0, tension: 0 }, story: ['trust', 'affection', 'desire', 'tension'] }, impactDay: flat(22, 13, { ordinary: 1, meaningful: 0, major: 0, extreme: 0 }) };
    const last = lastChangeOf(record, DEFAULT_ALLOWANCE);
    assert.deepEqual(last, { reply: 22, delta: { trust: 1, affection: 1, desire: 1, tension: 1 }, source: 'story', held: '' });
    const shown = detail({ sliceChange: last, lastRelationshipChange: undefined }).lastRelationshipChange;
    const html = lastRelationshipChangeHtml(shown);
    assert.match(html, /From the story/);
    assert.match(html, /Reply #22/);
    assert.match(html, /Trust \+1/);
    assert.doesNotMatch(html, /Held:/);
    assert.match(relationshipStepHtml('trust', 'Trust', shown, 22), /▲1/);
});

test('rel-last 2: the daily limit held it: the pacing words, nothing moved', () => {
    const record = { name: 'Nelje', meters: { trust: 5, affection: 5, desire: 0, tension: 0 }, turn: { reply: 15, from: { trust: 5, affection: 5, desire: 0, tension: 0 }, story: [] }, impactDay: flat(15, 12, full) };
    const last = lastChangeOf(record, DEFAULT_ALLOWANCE);
    assert.equal(last.held, "today's ordinary and meaningful are used");
    assert.deepEqual(last.delta, zero);
    const shown = detail({ sliceChange: last }).lastRelationshipChange;
    const html = lastRelationshipChangeHtml(shown);
    assert.match(html, /Held: today&#039;s ordinary and meaningful are used\. Nothing moved\./);
    assert.match(html, /From the story/);
    assert.doesNotMatch(html, /Progress only/);
    assert.equal(relationshipStepHtml('trust', 'Trust', shown, 15), '');
    // No full tier, or no count for this reply: nothing to say.
    assert.equal(lastChangeOf({ ...record, impactDay: flat(15, 12, { ordinary: 1, meaningful: 0, major: 0, extreme: 0 }) }, DEFAULT_ALLOWANCE), null);
    assert.equal(lastChangeOf({ ...record, impactDay: flat(14, 12, full) }, DEFAULT_ALLOWANCE), null);
});

test('rel-last 3: a scanner change keeps its reason and says it came from the scanner; the amounts are the moved ones', () => {
    const record = { name: 'Marrit', meters: { trust: 3, affection: 0, desire: 0, tension: 0 }, turn: { reply: 14, from: { trust: 2, affection: 0, desire: 0, tension: 0 } } };
    const last = lastChangeOf(record, DEFAULT_ALLOWANCE);
    assert.equal(last.source, 'scanner');
    const side = { impact: 'ordinary', delta: { trust: 2, affection: 0, desire: 0, tension: 0 }, reason: 'Warned Astra about the Grey Ledger men.', message: 14 };
    const shown = detail({ sliceChange: last, lastRelationshipChange: side }).lastRelationshipChange;
    assert.deepEqual(shown.delta, { trust: 1, affection: 0, desire: 0, tension: 0 }, 'what actually moved, not what the scanner proposed');
    const html = lastRelationshipChangeHtml(shown);
    assert.match(html, /From the scanner/);
    assert.match(html, /Ordinary/);
    assert.match(html, /Warned Astra/);
});

test('rel-last: the newest reply wins between the slice and the sidecar; a manual edit stays', () => {
    const side = { impact: 'meaningful', delta: { trust: 3, affection: 0, desire: 0, tension: 0 }, reason: 'Earlier.', message: 10 };
    const newer = { reply: 12, delta: { ...zero, trust: 1 }, source: 'story', held: '' };
    assert.equal(detail({ sliceChange: newer, lastRelationshipChange: side }).lastRelationshipChange.message, 12);
    assert.equal(detail({ sliceChange: newer, lastRelationshipChange: side }).lastRelationshipChange.reason, '');
    const older = { ...newer, reply: 8 };
    const kept = detail({ sliceChange: older, lastRelationshipChange: side }).lastRelationshipChange;
    assert.equal(kept.message, 10);
    assert.equal(kept.reason, 'Earlier.');
    const manual = { ...side, impact: 'manual', message: 12 };
    const stays = detail({ sliceChange: newer, lastRelationshipChange: manual }).lastRelationshipChange;
    assert.equal(stays.impact, 'manual');
    assert.equal(stays.origin, undefined);
    assert.match(lastRelationshipChangeHtml(stays), /Manual edit/);
});

test('rel-last: standalone (no slice change) is unchanged: no chip, no held line', () => {
    const side = { impact: 'ordinary', delta: { trust: 2, affection: 0, desire: 0, tension: 0 }, reason: 'Said thanks.', message: 9 };
    const shown = detail({ lastRelationshipChange: side }).lastRelationshipChange;
    assert.equal(shown.origin, undefined);
    const html = lastRelationshipChangeHtml(shown);
    assert.doesNotMatch(html, /From the|Held:/);
    assert.match(html, /Said thanks\./);
    assert.match(lastRelationshipChangeHtml(detail({}).lastRelationshipChange), /No relationship change recorded yet/);
});
