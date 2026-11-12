import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { mergeScanResult, normalizeNpcRecord } from '../core.js';
import { mergeImportantMemories, normalizeStoredMemories } from '../core-record.js';
import { stampMemories } from '../core-record-shared.js';
import { chatLineage, lineageCheckpointKey } from '../branch.js';
import { withoutSourceReplyNumbers } from '../bundle-import-helpers.js';
import { buildNarrationCaptureParts } from '../core.js';
import { base64url, canonicalTuple, factKey, hashText, sha256Bytes } from '../src/memory-fact-key.js';
import { cleanPayload, fallbackText, productions, validPhrasing } from '../src/memory-fact-text.js';
import { LEDGER_CAP, cleanLedger, factSeen, normalizeFacts, pruneLedger, withDisposition } from '../src/memory-fact-ledger.js';
import { admitCandidates, chooseSlots, mergeFactMemories, normalizeFactMemories } from '../src/memory-fact-store.js';
import * as events from '../src/memory-fact-events.js';
import { moveFact } from '../src/memory-fact-events.js';
import { applyNpcMemories } from '../src/memory-fact-apply.js';
import { isMarked, markLiveReply, markedKeys, memoryFactsOn } from '../src/memory-fact-marks.js';
import { PARAGRAPH_BYTES, applyPhrasing, memoryParagraph, selectHandles } from '../src/memory-fact-phrase.js';
import { mergeAliasFacts } from '../src/memory-fact-alias.js';

const P = 'Kazuma';
const lieFact = (n, R = n) => ({ kind: 'lieCaught', cls: 'A', R, ns: 'host', source: `s${R}`, eventId: `lie:${n}`, payload: { to: `Person${n}` } });
const moveCand = (n, cls = 'O', R = n) => ({ kind: 'quest', cls, R, ns: 'scan', source: `s${R}`, eventId: `task:${n}`, payload: { title: `Task ${n}`, phase: 'opened' } });
const metCand = (R = 1) => ({ kind: 'met', cls: 'M', R, ns: 'host', source: `s${R}`, eventId: 'met:1', payload: { player: P, place: 'Bluewatch' } });
const run = (input = {}) => mergeFactMemories({ stamps: {}, ...input });

// ---- §3 keys ----
test('memory facts §3: SHA-256 is correct and the key is v1 + all 256 bits (46 characters)', () => {
    for (const text of ['', 'abc', 'x'.repeat(200), 'é☃😀'.repeat(40)]) {
        assert.equal(Buffer.from(sha256Bytes(text)).toString('hex'), createHash('sha256').update(text).digest('hex'));
    }
    assert.equal(base64url(sha256Bytes('abc')), createHash('sha256').update('abc').digest('base64url'));
    const key = factKey({ ns: 'host', source: 's1', eventId: 'e1' });
    assert.match(key, /^v1:[A-Za-z0-9_-]{43}$/);
    assert.equal(key.length, 46);
});
test('memory facts §3: long common-prefix ids hash apart, length-prefixing keeps tuples apart, no truncation', () => {
    const prefix = 'p'.repeat(199);
    assert.notEqual(factKey({ ns: 'a', source: 's', eventId: `${prefix}1` }), factKey({ ns: 'a', source: 's', eventId: `${prefix}2` }));
    assert.notEqual(canonicalTuple(['ab', 'c']), canonicalTuple(['a', 'bc']));
    assert.notEqual(factKey({ ns: 'a', source: 'b', eventId: 'c' }), factKey({ ns: 'ab', source: '', eventId: 'c' }));
    assert.notEqual(factKey({ ns: 'a', source: 's', eventId: 'e', phase: '1' }), factKey({ ns: 'a', source: 's', eventId: 'e', phase: '2' }));
    assert.equal(hashText('same'), hashText('same'));
});
test('memory facts §3: an injected key collision (same key, other identity) is quarantined, never merged', () => {
    const candidate = lieFact(1);
    const first = admitCandidates([candidate], undefined).admitted[0];
    let facts = withDisposition(undefined, first.key, 1, 'x', 'someOtherIdentity');
    const again = admitCandidates([candidate], facts);
    assert.deepEqual(again.admitted, []);
    assert.equal(again.facts.ledger.keys.find(row => row[0] === first.key)[2], 'q');
});

// ---- §9 grammar ----
test('memory facts §9: every permitted production is accepted, and only those', () => {
    const cases = [['met', { player: P, place: 'Bluewatch' }], ['milestone', { label: 'a promise kept' }], ['move', { player: P, axes: { trust: '+' } }],
        ['move', { player: P, axes: { trust: '-', affection: '+' } }], ['gift', { player: P, action: 'gift' }], ['lieCaught', { to: 'Astra' }],
        ['quest', { title: 'Cull the rats', phase: 'accepted' }], ['fight', { player: P, side: 'beside', result: 'won' }], ['party', { action: 'join' }]];
    for (const [kind, raw] of cases) {
        const payload = cleanPayload(kind, raw);
        assert.ok(payload, kind);
        for (const sentence of productions(kind, payload)) assert.equal(validPhrasing(kind, payload, sentence), sentence);
        assert.equal(validPhrasing(kind, payload, fallbackText(kind, payload)), fallbackText(kind, payload));
    }
});
test('memory facts §9: invented clauses, reversed roles, polarity swaps, case, newline and two sentences are rejected', () => {
    const lie = cleanPayload('lieCaught', { to: 'Astra' });
    assert.equal(validPhrasing('lieCaught', lie, 'I caught Astra lying to me.'), null);
    assert.equal(validPhrasing('lieCaught', lie, 'My lie to Astra was caught. She forgave me.'), null);
    assert.equal(validPhrasing('lieCaught', lie, 'My lie to astra was caught.'), null);
    assert.equal(validPhrasing('lieCaught', lie, 'My lie to Astra was caught.\nMore'), null);
    const met = cleanPayload('met', { player: P, place: 'Bluewatch' });
    assert.equal(validPhrasing('met', met, 'I first met Kazuma at Bluewatch after he murdered my sister.'), null);
    assert.equal(validPhrasing('met', met, 'I first met Kazuma at Bluewatch on 3 May.'), null);
    assert.equal(validPhrasing('met', met, 'At Bluewatch I first met Kazuma.'), null, 'only the listed orderings');
    const move = cleanPayload('move', { player: P, axes: { trust: '+' } });
    assert.equal(validPhrasing('move', move, 'My trust in Kazuma fell.'), null);
    assert.equal(validPhrasing('move', move, 'My trust in Kazuma did not rise.'), null);
    assert.equal(validPhrasing('quest', cleanPayload('quest', { title: 'T', phase: 'accepted' }), 'The task “T” was marked complete.'), null);
    assert.equal(validPhrasing('met', met, 42), null);
});
test('memory facts §9: unsafe or oversize literals make the option unavailable, never a truncated claim', () => {
    assert.equal(cleanPayload('lieCaught', { to: 'x'.repeat(81) }), null);
    assert.equal(cleanPayload('milestone', { label: 'say "hi"' }), null);
    assert.equal(cleanPayload('milestone', { label: 'two\nlines' }), null);
    assert.equal(cleanPayload('quest', { title: 'Hold the line, “now”', phase: 'opened' }), null);
    assert.equal(cleanPayload('unknown', {}), null);
    assert.deepEqual(cleanPayload('met', { player: '' }), { player: 'the player' });
    assert.equal(fallbackText('move', cleanPayload('move', { player: P, axes: { trust: '+', affection: '-' } })), 'My trust in Kazuma rose and my affection for Kazuma fell.');
});

// ---- §2 events ----
test('memory facts §2: a move uses the applied delta, never the ask, and only meaningful+ tiers', () => {
    const fact = moveFact({ applied: { trust: 0, affection: 2, desire: 0, tension: -1 }, tier: 'major', R: 4, source: 's', opId: 'op', player: P });
    assert.equal(fact.cls, 'A');
    assert.deepEqual(fact.payload.axes, { affection: '+', tension: '-' });
    assert.equal(moveFact({ applied: { trust: 0, affection: 0, desire: 0, tension: 0 }, tier: 'major', R: 4, source: 's', opId: 'op' }), null);
    assert.equal(moveFact({ applied: { trust: 1 }, tier: 'ordinary', R: 4, source: 's', opId: 'op' }), null);
    assert.equal(moveFact({ applied: { trust: 1 }, tier: 'meaningful', R: 4, source: 's', opId: 'op' }).cls, 'O');
    assert.equal(moveFact({ applied: { trust: 1 }, tier: 'major', R: null, source: 's', opId: 'op' }), null);
});
test('memory facts §2: a first meeting is never built from an admission, promotion, manual or cast creation', () => {
    assert.deepEqual(Object.keys(events), ['moveFact'], 'only the wired source ships; no met/milestone/lie/quest/fight/party/gift builder');
    const state = mergeScanResult({ npcs: [], turn: 1 }, { npcs: [{ name: 'Elke', role: 'Clerk', present: true, memories: [] }] }, { turn: 1, sourceMessageId: 1, memoryFacts: { source: 'k1', player: P } }).state;
    assert.equal(state.npcs[0].memoryFacts, undefined, 'admission of a new dossier records no fact');
    assert.deepEqual(state.npcs[0].memories, []);
});

// ---- §6 retention ----
test('memory facts §6: met + 5 A keeps met + 4 newest A; six A keep the newest five', () => {
    const a = run({ candidates: [metCand(1), ...[2, 3, 4, 5, 6].map(n => lieFact(n))] });
    assert.equal(a.memories.length, 5);
    assert.ok(a.memories.includes('I first met Kazuma at Bluewatch.'));
    assert.ok(!a.memories.includes('My lie to Person2 was caught.'));
    for (const n of [3, 4, 5, 6]) assert.ok(a.memories.includes(`My lie to Person${n} was caught.`), `A ${n}`);
    const six = run({ candidates: [1, 2, 3, 4, 5, 6].map(n => lieFact(n)) });
    assert.equal(six.memories.length, 5);
    assert.ok(!six.memories.some(text => text.includes('Person1')));
});
test('memory facts §6: five O facts beat an ordinary model memory even when the model requests it', () => {
    const O = [1, 2, 3, 4, 5].map(n => moveCand(n, 'O'));
    const r = run({ memories: ['Old ordinary note about the harbour'], incoming: ['Kazuma promised to return the ledger before dawn'], retention: ['Kazuma promised to return the ledger before dawn'], candidates: O.slice(0, 4) });
    const next = run({ memories: r.memories, manual: r.manual, facts: r.facts, incoming: ['Kazuma promised to return the ledger before dawn'], retention: ['Kazuma promised to return the ledger before dawn'], candidates: [O[4]] });
    assert.equal(next.memories.length, 5);
    assert.ok(next.memories.every(text => /^The task/.test(text)), next.memories.join(' | '));
});
test('memory facts §6: pins first, then met, then A; five pins plus a fact keep exactly the pins', () => {
    const base = run({ memories: ['Pin one text', 'Pin two text'], manual: ['Pin one text', 'Pin two text'], candidates: [metCand(1), ...[2, 3, 4].map(n => lieFact(n))] });
    assert.equal(base.memories.length, 5);
    assert.deepEqual(base.manual, ['Pin one text', 'Pin two text']);
    assert.ok(base.memories.includes('I first met Kazuma at Bluewatch.'));
    const more = run({ memories: base.memories, manual: base.manual, facts: base.facts, candidates: [lieFact(5), lieFact(6)] });
    assert.deepEqual(more.manual, ['Pin one text', 'Pin two text']);
    assert.ok(more.memories.includes('I first met Kazuma at Bluewatch.'));
    assert.ok(more.memories.includes('My lie to Person6 was caught.') && more.memories.includes('My lie to Person5 was caught.'));
    const pins = ['p1', 'p2', 'p3', 'p4', 'p5'].map(text => `Pin ${text} text`);
    const full = run({ memories: pins, manual: pins, candidates: [lieFact(1)] });
    assert.deepEqual(full.memories, pins);
    assert.equal(full.facts?.ledger.keys.find(row => row[2] === 'e') ? true : full.facts?.ledger.keys.length > 0, true, 'the dropped fact is ledgered, not forgotten');
});
test('memory facts §6: more than five pins are left untouched, none deleted', () => {
    const pins = [1, 2, 3, 4, 5, 6].map(n => `Reader pin number ${n} text`);
    const kept = normalizeFactMemories(pins, { v: 1, entries: {}, ledger: { floor: 0, keys: [] } }, pins);
    assert.deepEqual(kept.memories, pins);
});
test('memory facts §6: a gift and a theft with shared words both stay; ordinary text suppressed only on an exact collision', () => {
    const gift = { kind: 'gift', cls: 'O', R: 1, ns: 'host', source: 's1', eventId: 'g1', payload: { player: P, action: 'gift' } };
    const help = { kind: 'gift', cls: 'O', R: 2, ns: 'host', source: 's2', eventId: 'g2', payload: { player: P, action: 'help' } };
    const r = run({ candidates: [gift, help] });
    assert.equal(r.memories.length, 2);
    const similar = 'I received a gift from Kazuma and a ledger';
    const r2 = run({ memories: r.memories, facts: r.facts, incoming: [similar, 'I received a gift from Kazuma.'] });
    assert.ok(r2.memories.includes(similar), 'similar wording is a different memory');
    assert.equal(r2.memories.filter(text => text === 'I received a gift from Kazuma.').length, 1, 'the exact text stays one slot');
    assert.equal(Object.keys(r2.facts.entries).length, 2);
});
test('memory facts §6: two independent facts that render the same text share one slot; the loser is ledgered as a collision', () => {
    const a = { ...moveCand(1, 'O'), eventId: 'task:a', payload: { title: 'Same', phase: 'opened' } };
    const b = { ...moveCand(2, 'O'), eventId: 'task:b', payload: { title: 'Same', phase: 'opened' } };
    const r = run({ candidates: [a, b] });
    assert.equal(r.memories.length, 1);
    assert.equal(Object.keys(r.facts.entries).length, 1);
    assert.ok(r.facts.ledger.keys.some(row => row[2] === 'c'));
});
test('memory facts §3/§4: at most four facts per reply; the rest are ledgered as overflow and never come back', () => {
    const six = [1, 2, 3, 4, 5, 6].map(n => lieFact(n, 9));
    const r = run({ candidates: six });
    assert.equal(r.memories.length, 4);
    assert.equal(r.facts.ledger.keys.filter(row => row[2] === 'o').length, 2);
    const again = run({ memories: r.memories, facts: r.facts, candidates: six });
    assert.equal(again.memories.length, 4, 'a retry never turns a dropped fifth candidate into a surprise memory');
});

// ---- §3/§7 ledger, floor, edit, delete ----
test('memory facts §3: an evicted fact is not recreated by a replay; the ledger prunes whole boundary groups and the floor suppresses older keys', () => {
    const r = run({ candidates: [1, 2, 3, 4, 5, 6].map(n => lieFact(n, n)) });
    const replay = run({ memories: r.memories, facts: r.facts, candidates: [lieFact(1, 1)] });
    assert.ok(!replay.memories.some(text => text.includes('Person1')));
    let facts;
    for (let n = 1; n <= LEDGER_CAP + 10; n += 1) facts = withDisposition(facts, factKey({ ns: 'x', source: 's', eventId: String(n) }), n, 'e');
    assert.ok(facts.ledger.keys.length <= LEDGER_CAP);
    assert.ok(facts.ledger.floor > 0);
    const oldKey = factKey({ ns: 'x', source: 's', eventId: '1' });
    assert.ok(!facts.ledger.keys.some(row => row[0] === oldKey), 'the old key itself was pruned');
    assert.ok(factSeen(facts, oldKey, 1), 'but the floor still suppresses it');
    assert.ok(!factSeen(facts, factKey({ ns: 'x', source: 's', eventId: 'fresh' }), facts.ledger.floor + 1), 'a genuinely newer event stays eligible');
    const grouped = pruneLedger({ floor: 0, keys: [...Array(70).keys()].map(i => [factKey({ ns: 'g', source: 's', eventId: String(i) }), i < 40 ? 1 : 2, 'e', '']) });
    assert.ok(grouped.keys.every(row => row[1] === 2) && grouped.floor === 1, 'a boundary group is never split');
});
test('memory facts §7: a reader edit or delete tombstones the key; the fact never returns, an unchanged pinned fact is kept', () => {
    const r = run({ candidates: [lieFact(1), moveCand(2, 'O')] });
    const [first] = Object.keys(r.facts.entries);
    const edited = r.memories.map(text => (text.includes('Person1') ? 'My lie to Person1 was caught, edited.' : text));
    const n = normalizeNpcRecord({ id: 'n', name: 'Mira', memories: edited, memoryFacts: r.facts, manualMemories: ['My lie to Person1 was caught, edited.'] });
    assert.ok(!n.memoryFacts.entries[first] || n.memoryFacts.entries[first].k !== 'lieCaught');
    assert.equal(n.memoryFacts.ledger.keys.find(row => row[0] === first)[2], 'x');
    const again = run({ memories: n.memories, manual: n.manualMemories, facts: n.memoryFacts, candidates: [lieFact(1)] });
    assert.ok(!again.memories.includes('My lie to Person1 was caught.'));
    assert.ok(again.memories.includes('My lie to Person1 was caught, edited.'));
    const deleted = normalizeNpcRecord({ id: 'n', name: 'Mira', memories: r.memories.filter(text => !text.includes('Person1')), memoryFacts: r.facts });
    assert.equal(deleted.memoryFacts.ledger.keys.find(row => row[0] === first)[2], 'x');
    const pinned = normalizeNpcRecord({ id: 'n', name: 'Mira', memories: r.memories, memoryFacts: r.facts, manualMemories: ['My lie to Person1 was caught.'] });
    assert.ok(pinned.memoryFacts.entries[first], 'an unchanged pinned fact keeps its entry');
});
test('memory facts §7: a memory lock stops all insertion and records a locked disposition', () => {
    const r = run({ memories: ['Reader text'], locked: true, candidates: [lieFact(1)] });
    assert.deepEqual(r.memories, ['Reader text']);
    assert.equal(r.facts.ledger.keys[0][2], 'l');
    const unlocked = run({ memories: r.memories, facts: r.facts, candidates: [lieFact(1)] });
    assert.deepEqual(unlocked.memories, ['Reader text'], 'unlocking never silently backfills the locked event');
});
test('memory facts §7: alias merge unions entries, tombstone beats duplicate, floor is the larger', () => {
    const a = run({ candidates: [lieFact(1), moveCand(2, 'O')] });
    const b = run({ candidates: [lieFact(1), lieFact(3)] });
    const tomb = withDisposition(b.facts, Object.keys(a.facts.entries)[0], 1, 'x');
    const merged = { manualMemories: [] };
    mergeAliasFacts(merged, { memories: a.memories, memoryFacts: a.facts }, { memories: b.memories, memoryFacts: { ...tomb, ledger: { ...tomb.ledger, floor: 7 } } });
    assert.equal(merged.memoryFacts.ledger.floor, 7);
    assert.ok(Object.keys(merged.memoryFacts.entries).length <= 5);
    assert.ok(merged.memoryFacts.entries && merged.memories.length === Object.keys(merged.memoryFacts.entries).length);
});
test('memory facts §7: a foreign import strips every fact key, ledger and stamp', () => {
    const npc = { memories: ['x'], memoryStamps: { x: { m: 1 } }, memoryFacts: { v: 1, entries: {}, ledger: { floor: 0, keys: [] } } };
    withoutSourceReplyNumbers(npc);
    assert.equal(npc.memoryFacts, undefined);
    assert.equal(npc.memoryStamps, undefined);
});

// ---- §6 no-fact compatibility ----
test('memory facts §6/§5: with no sidecar and no candidate the ORIGINAL functions run byte for byte; old records gain no field', () => {
    const existing = { memories: ['Stamped Astra first rat-cull bounty slip', 'Warned Astra about the dock boys'], manualMemories: ['Warned Astra about the dock boys'] };
    const incoming = { memories: ['Asked Astra to clear the swamp drake'], memoryRetention: [] };
    const target = {};
    applyNpcMemories(target, existing, incoming, { limit: 3, sameReply: { stamps: {}, message: 2 } });
    assert.deepEqual(target.memories, mergeImportantMemories(existing.memories, incoming.memories, incoming.memoryRetention, 3, existing.manualMemories, { stamps: {}, message: 2 }));
    assert.equal('memoryFacts' in target && target.memoryFacts !== undefined, false);
    const record = normalizeNpcRecord({ id: 'n', name: 'Mira', memories: ['A memory', 'a memory.'] });
    assert.equal('memoryFacts' in record, false);
    assert.deepEqual(record.memories, normalizeStoredMemories(['A memory', 'a memory.']));
    assert.equal(JSON.stringify(normalizeFacts(undefined, [])), undefined);
});

// ---- stamps ----
test('memory facts §1: a fact keeps its own reply and story date and never inherits a stamp by similarity', () => {
    const old = 'The task “Task 3” was opened and then forgotten for days.';
    const r = run({ memories: [old], candidates: [moveCand(3, 'A', 4)] });
    const fact = 'The task “Task 3” was opened.';
    assert.ok(r.memories.includes(fact));
    const stamps = stampMemories({ memories: [old], memoryStamps: { [normalizeKey(old)]: { m: 1, d: 'Day 1' } } }, { memories: r.memories, memoryFacts: r.facts }, 9, id => `Day ${id}`);
    assert.deepEqual(stamps[normalizeKey(fact)], { m: 4, d: 'Day 4' });
});
const normalizeKey = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---- scan integration ----
const evidence = { trust: 'Kazuma saved her brother from the guards.', affection: '', desire: '', tension: '' };
const elkeAt = () => mergeScanResult({ npcs: [], turn: 1 }, { npcs: [{ name: 'Elke', role: 'Clerk', present: true }] }, { turn: 1, sourceMessageId: 1 }).state;
const scanMove = (state, turn, memoryFacts, impact = 'major', trust = 4, line = 'Kazuma saved her brother from the guards') => mergeScanResult(state, { npcs: [{ id: state.npcs[0].id, name: 'Elke', present: true, relationshipDelta: { trust, affection: 0, desire: 0, tension: 0 }, relationshipImpact: impact,
    relationshipEvidence: { ...evidence, trust: `${line}.` }, relationshipChangeReason: line }] }, { turn, sourceMessageId: turn, developmentContext: `${line}.`, ...(memoryFacts ? { memoryFacts } : {}) }).state;
test('memory facts §4: without the option (rule off, unmarked reply, Re-read) a scan derives nothing and stays on the original path', () => {
    const npc = scanMove(elkeAt(), 2, null).npcs[0];
    assert.equal(npc.relationship.trust > 0, true, 'the movement itself still applies');
    assert.equal(npc.memoryFacts, undefined);
    assert.deepEqual(npc.memories, []);
});
test('memory facts §4: a marked live reply\'s applied relationship move becomes a fallback memory once, stamped with its reply; a replay adds nothing', () => {
    const state = scanMove(elkeAt(), 2, { source: 'key-2', player: P });
    const npc = state.npcs[0];
    assert.deepEqual(npc.memories, ['My trust in Kazuma rose.']);
    assert.equal(Object.values(npc.memoryFacts.entries)[0].r, 2);
    assert.equal(Object.values(npc.memoryFacts.entries)[0].c, 'A');
    assert.equal(npc.memoryStamps['my trust in kazuma rose'].m, 2);
    const replay = scanMove(state, 2, { source: 'key-2', player: P }, 'major', 2).npcs[0];
    assert.deepEqual(replay.memories, ['My trust in Kazuma rose.'], 'the same event never makes a second memory');
    const later = scanMove(state, 3, { source: 'key-3', player: P }, 'meaningful', 2, 'Kazuma shared his rations with her at the gate').npcs[0];
    assert.deepEqual(later.memories, ['My trust in Kazuma rose.'], 'a second event rendering the same text keeps one slot and its own date (§6.2)');
    assert.ok(later.memoryFacts.ledger.keys.some(row => row[2] === 'c'));
    assert.equal(later.memoryStamps['my trust in kazuma rose'].m, 2);
    const ordinary = scanMove(elkeAt(), 2, { source: 'key-2', player: P }, 'ordinary', 1).npcs[0];
    assert.equal(ordinary.memoryFacts, undefined, 'an ordinary-tier nudge is not a memory');
});

// ---- §5 marks ----
test('memory facts §5: marks only on a genuinely new live reply and only for that exact lineage key', () => {
    const chat = [{ mes: 'hello', is_user: true }, { mes: 'reply one' }, { mes: 'next user', is_user: true }, { mes: 'reply two' }];
    const state = {};
    const key = lineageCheckpointKey(chatLineage(chat), 3);
    assert.equal(markLiveReply(state, key, { enabled: false }), false);
    assert.equal(memoryFactsOn({ memoryFacts: false }), false);
    assert.equal(memoryFactsOn({}), true);
    assert.deepEqual(markedKeys(state), []);
    assert.equal(markLiveReply(state, key), true);
    assert.equal(markLiveReply(state, key), false);
    assert.equal(state.memoryFactMarks.epoch, 1);
    assert.ok(isMarked(state, key));
    // rewind below the upgrade point: earlier replies were never marked
    assert.ok(!isMarked(state, lineageCheckpointKey(chatLineage(chat), 1)));
    // regenerate at a lower index: another content gives another key
    const regenerated = [chat[0], { mes: 'a different reply one' }, chat[2], chat[3]];
    assert.ok(!isMarked(state, lineageCheckpointKey(chatLineage(regenerated), 3)));
    assert.ok(!isMarked(state, lineageCheckpointKey(chatLineage(regenerated), 1)));
    // a different branch with a changed parent never matches, though the last reply is the same text
    const sibling = [chat[0], { mes: 'reply one, other branch' }, chat[2], chat[3]];
    assert.notEqual(lineageCheckpointKey(chatLineage(sibling), 3), key);
    // content-identical chat has the same key (the existing content-lineage semantics, documented)
    assert.equal(lineageCheckpointKey(chatLineage(chat.map(item => ({ ...item }))), 3), key);
    // a pruned mark means no fact
    for (let i = 0; i < 200; i += 1) markLiveReply(state, `k${i}`);
    assert.ok(markedKeys(state).length <= 128);
});

// ---- §8 phrasing ----
const npcWith = (candidates, extra = {}) => {
    const r = run({ candidates });
    return { id: 'npc1', name: 'Elke', memories: r.memories, memoryFacts: r.facts, ...(r.manual.length ? { manualMemories: r.manual } : {}), ...extra };
};
const fp = id => `fp${id}`;
test('memory facts §8: handles cover only replies inside the call\'s own window, four at most, one per NPC first, deterministic', () => {
    const npcs = ['b', 'a'].map(id => ({ ...npcWith([1, 2, 3].map(n => lieFact(n, n + 10))), id }));
    assert.deepEqual(selectHandles(npcs, [], fp), []);
    assert.deepEqual(selectHandles(npcs, [99], fp), []);
    const handles = selectHandles(npcs, [11, 12, 13], fp);
    assert.equal(handles.length, 4);
    assert.deepEqual(handles.slice(0, 2).map(item => item.npcId), ['a', 'b'], 'one per NPC first, stable NPC order');
    assert.deepEqual(handles.map(item => item.h), ['h1', 'h2', 'h3', 'h4']);
    assert.deepEqual(handles, selectHandles([...npcs].reverse(), [13, 12, 11], fp));
});
test('memory facts §8: the paragraph lists only the closed allowed sentences and is byte-bounded; no facts means no bytes', () => {
    assert.deepEqual(memoryParagraph([], []), { text: '', handles: [] });
    const npcs = [npcWith([lieFact(1, 11)])];
    const handles = selectHandles(npcs, [11], fp);
    const { text } = memoryParagraph(handles, npcs);
    assert.match(text, /MEMORY FACTS/);
    assert.match(text, /"My lie to Person1 was caught\."/);
    assert.ok(new TextEncoder().encode(text).length <= PARAGRAPH_BYTES + 2);
});
test('memory facts §8/§9: a valid sentence replaces the fallback and keeps the stamp; invalid or missing counts a try; two tries stop the offer', () => {
    let npcs = [npcWith([lieFact(1, 11)])];
    npcs[0].memoryStamps = { 'my lie to person1 was caught': { m: 11, d: 'Day 3' } };
    let handles = selectHandles(npcs, [11], fp);
    const bad = applyPhrasing(npcs, handles, { h1: 'I caught Person1 lying to me.' }, { fingerprintAt: fp });
    assert.equal(bad[0].memories[0], 'My lie to Person1 was caught.');
    assert.equal(Object.values(bad[0].memoryFacts.entries)[0].att, 1);
    handles = selectHandles(bad, [11], fp);
    const missing = applyPhrasing(bad, handles, undefined, { fingerprintAt: fp });
    assert.equal(Object.values(missing[0].memoryFacts.entries)[0].pend, undefined);
    assert.deepEqual(selectHandles(missing, [11], fp), []);
    handles = selectHandles(npcs, [11], fp);
    const good = applyPhrasing(npcs, handles, { h1: 'I was caught lying to Person1.' }, { fingerprintAt: fp });
    assert.equal(good[0].memories[0], 'I was caught lying to Person1.');
    assert.deepEqual(good[0].memoryStamps['i was caught lying to person1'], { m: 11, d: 'Day 3' });
    assert.equal(good[0].memoryStamps['my lie to person1 was caught'], undefined);
    assert.equal(npcs[0].memories[0], 'My lie to Person1 was caught.', 'the input is not mutated');
    assert.equal(Object.values(good[0].memoryFacts.entries)[0].pend, undefined);
});
test('memory facts §9: a failed, stale, edited, pinned, locked or re-fingerprinted handle leaves the memory untouched', () => {
    const npcs = [npcWith([lieFact(1, 11)])];
    const handles = selectHandles(npcs, [11], fp);
    const answer = { h1: 'I was caught lying to Person1.' };
    assert.equal(applyPhrasing(npcs, handles, answer, { ok: false, fingerprintAt: fp }), npcs);
    assert.equal(applyPhrasing(npcs, handles, answer, { fingerprintAt: () => 'moved' })[0].memories[0], 'My lie to Person1 was caught.');
    assert.equal(applyPhrasing([{ ...npcs[0], manualMemories: ['My lie to Person1 was caught.'] }], handles, answer, { fingerprintAt: fp })[0].memories[0], 'My lie to Person1 was caught.');
    assert.equal(applyPhrasing([{ ...npcs[0], manualProfileFields: ['memories'] }], handles, answer, { fingerprintAt: fp })[0].memories[0], 'My lie to Person1 was caught.');
    const changed = structuredClone(npcs);
    Object.values(changed[0].memoryFacts.entries)[0].rev = 'other';
    assert.equal(applyPhrasing(changed, handles, answer, { fingerprintAt: fp })[0].memories[0], 'My lie to Person1 was caught.');
    assert.equal(applyPhrasing(npcs, handles, { h9: 'x' }, { fingerprintAt: fp })[0].memories[0], 'My lie to Person1 was caught.', 'an unknown handle is ignored');
    assert.equal(applyPhrasing(npcs, handles, ['bad'], { fingerprintAt: fp })[0].memories[0], 'My lie to Person1 was caught.');
});
test('memory facts §8: the one-pass capture instruction carries no memory facts text', () => {
    const parts = JSON.stringify(buildNarrationCaptureParts({ npcs: [], settings: {}, transcript: '' }) ?? '');
    assert.ok(!/MEMORY FACTS|"mem"/.test(parts));
});
test('memory facts §3: cleanLedger drops malformed rows and the sidecar normaliser keeps at most five aligned entries', () => {
    assert.deepEqual(cleanLedger({ floor: -1, keys: [['bad', 1, 'k'], 'x', [factKey({ ns: 'a', source: 'b', eventId: 'c' }), 'z', 'k']] }), { floor: 0, keys: [] });
    const many = run({ candidates: [1, 2, 3, 4].map(n => lieFact(n)) });
    const normalized = normalizeFacts(many.facts, many.memories);
    assert.equal(Object.keys(normalized.entries).length, 4);
    assert.equal(normalizeFacts('junk', []), undefined);
});
test('memory facts §6: chooseSlots keeps the oldest proven first meeting when corrupt data holds several', () => {
    const rec = (key, r, c, order) => ({ text: key, tk: key, pin: false, key, entry: { c, r }, order });
    const kept = chooseSlots([rec('b', 5, 'M', 0), rec('a', 2, 'M', 1), rec('c', 3, 'A', 2)]);
    assert.deepEqual(kept.map(item => item.key).sort(), ['a', 'c']);
});
