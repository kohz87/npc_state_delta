import test from 'node:test';
import assert from 'node:assert/strict';
import { PACK_SCHEME, PackError, applyJson, diffJson, diffPlainJson, packCheckpoints, unpackCheckpoints } from '../checkpoint-pack.js';

const text = value => JSON.stringify(value);

// Deterministic synthetic chat: two checkpoints per reply (scan, then assistant-parent), a growing memories list,
// one NPC removed, one reordered, one key appended and one key inserted mid-object at fixed turns.
function makeChat(replies) {
    const checkpoints = [];
    let previousKey = null;
    for (let turn = 1; turn <= replies; turn++) {
        const npcs = [0, 1, 2].filter(n => !(turn >= 7 && n === 1)).map(n => ({
            id: `n${n}`,
            name: `NPC ${n}`,
            memories: Array.from({ length: (turn % 5) + n }, (_, m) => `memory ${m} of ${turn}`),
            relationship: { desire: (turn * 7 + n) % 100 },
        }));
        if (turn === 9) npcs.reverse();
        const base = { turn, npcs, meters: { trust: turn % 10 } };
        if (turn === 11) base.extra = 'appended';
        if (turn === 13) base.inserted = 'middle';
        for (const [suffix, parent] of [['a', previousKey], ['b', null]]) {
            const key = `L${turn}${suffix}`;
            const snapshot = { ...base, turn, marker: suffix };
            checkpoints.push({
                messageId: `msg-${turn}`,
                fingerprint: `fp-${turn}-${suffix}`,
                lineageKey: key,
                parentLineageKey: suffix === 'a' ? parent : `L${turn}a`,
                reason: suffix === 'a' ? 'scan' : 'assistant-parent',
                createdAt: `2026-11-12T00:${String(turn).padStart(2, '0')}:00Z`,
                rollbackSeq: turn * 2 + (suffix === 'b' ? 1 : 0),
                snapshot,
            });
        }
        previousKey = `L${turn}a`;
    }
    return checkpoints;
}

function roundTrip(packed) {
    return {
        entries: JSON.parse(text(packed.entries)),
        packing: JSON.parse(text(packed.packing)),
    };
}

function chainLength(entries, index) {
    let length = 0;
    let cursor = index;
    while (Object.hasOwn(entries[cursor], 'packed')) {
        length++;
        cursor = entries[cursor].packed.base;
    }
    return length;
}

test('diffJson and applyJson reproduce the target for hand-written cases', () => {
    const cases = [
        [{ a: 1, b: 'x' }, { a: 2, b: 'x' }],
        [{ a: 1 }, { a: 1, c: 3 }],
        [{ a: 1, b: 2 }, { b: 2 }],
        [{ a: 1, b: 2, c: 3 }, { c: 3, a: 1, b: 2 }],
        [{ a: 1, b: 2 }, { x: 0, a: 1, b: 2 }],
        [{ a: null }, { a: 0 }],
        [{ a: null }, {}],
        [{ 'a/b': 1, 'c~d': 2 }, { 'a/b': 3, 'c~d': 4 }],
        [{ 'ünï': '🙂' }, { 'ünï': 'ok', z: '🙂' }],
        [{ n: -1.5e300 }, { n: 0.1 }],
        [{ list: [1, 2, 3] }, { list: [1, 2, 3, 4, 5] }],
        [{ list: [1, 2, 3] }, { list: [1, 9, 3] }],
        [{ list: [1, 2, 3] }, { list: [1, 2] }],
        [{ list: [{ v: 1 }] }, { list: [{ v: 1 }, { v: 2 }] }],
        [{ list: [{ v: 1 }, { v: 2 }] }, { list: [{ v: 5 }, { v: 2 }] }],
        [{}, {}],
        [[], [1]],
        [{ deep: { deeper: { deepest: [{ k: 1 }] } } }, { deep: { deeper: { deepest: [{ k: 2 }] } } }],
        [{ a: 1 }, 'changed root'],
        [{ a: undefined, b: 1 }, { b: 1 }],
    ];
    for (const [base, target] of cases) {
        const ops = diffJson(base, target);
        const applied = applyJson(JSON.parse(text(base)), ops);
        assert.equal(text(applied), text(target), `case ${text(base)} -> ${text(target)}`);
    }
});

test('a key appended or removed is a patch, a key inserted mid-object is a whole-object replace', () => {
    assert.deepEqual(diffJson({ a: 1 }, { a: 1, c: 3 }), [{ op: 'add', path: '/c', value: 3 }]);
    assert.deepEqual(diffJson({ a: 1, b: 2 }, { a: 1 }), [{ op: 'remove', path: '/b' }]);
    assert.deepEqual(diffJson({ a: 1, b: 2 }, { x: 0, a: 1, b: 2 }), [{ op: 'replace', path: '', value: { x: 0, a: 1, b: 2 } }]);
    assert.deepEqual(diffJson({ a: 1, b: 2, c: 3 }, { c: 3, a: 1, b: 2 }), [{ op: 'replace', path: '', value: { c: 3, a: 1, b: 2 } }]);
});

test('an undefined-valued key counts as absent; array shrink replaces, growth appends with "-"', () => {
    assert.deepEqual(diffJson({ a: undefined, b: 1 }, { b: 1 }), []);
    assert.deepEqual(diffJson({ list: [1, 2, 3] }, { list: [1, 2] }), [{ op: 'replace', path: '/list', value: [1, 2] }]);
    assert.deepEqual(diffJson({ list: [1] }, { list: [1, 2] }), [{ op: 'add', path: '/list/-', value: 2 }]);
});

test('applyJson never mutates its base', () => {
    const base = { a: { b: [1, 2] }, c: 'x' };
    const before = text(base);
    const result = applyJson(base, diffJson(base, { a: { b: [1, 9, 3] }, c: 'y' }));
    assert.equal(text(base), before);
    assert.notEqual(result, base);
});

test('applyJson refuses operations and paths outside the restricted subset', () => {
    const base = { a: [1, 2], o: { k: 1 } };
    const bad = [
        [{ op: 'move', path: '/a', from: '/o' }],
        [{ op: 'copy', path: '/a', from: '/o' }],
        [{ op: 'test', path: '/a', value: 1 }],
        [{ op: 'remove', path: '/a/0' }],
        [{ op: 'add', path: '/a/1', value: 9 }],
        [{ op: 'add', path: '/a/-' }],
        [{ op: 'replace', path: '/a/5', value: 9 }],
        [{ op: 'replace', path: '/a/01', value: 9 }],
        [{ op: 'replace', path: '/a/-', value: 9 }],
        [{ op: 'replace', path: 'a', value: 9 }],
        [{ op: 'replace', path: '/~2', value: 9 }],
        [{ op: 'replace', path: '/missing', value: 9 }],
        [{ op: 'remove', path: '/missing' }],
        [{ op: 'add', path: '/o/k', value: 2 }],
        [{ op: 'replace', path: '/o/k/deeper', value: 2 }],
        [{ op: 'replace', path: '/constructor/x', value: 2 }],
        [{ op: 'replace', path: '/toString', value: 2 }],
        [{ op: 'add', path: '' , value: 1 }],
        [{ op: 'remove', path: '' }],
        [{ op: 'replace', path: '/o/k' }],
        ['not an op'],
    ];
    for (const ops of bad) {
        assert.throws(() => applyJson(base, ops), PackError, text(ops));
    }
    assert.throws(() => applyJson(undefined, []), PackError);
    assert.throws(() => applyJson(base, 'nope'), PackError);
});

test('prototype keys stay own data: __proto__ and constructor names never reach Object.prototype', () => {
    const base = JSON.parse('{"safe":1}');
    const result = applyJson(base, [{ op: 'add', path: '/__proto__', value: { polluted: true } }, { op: 'add', path: '/constructor', value: 'c' }]);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.constructor, 'c');
    const parsed = JSON.parse('{"__proto__":{"x":1}}');
    const copied = applyJson({}, diffJson({}, parsed));
    assert.equal(text(copied), text(parsed));
    assert.equal(({}).x, undefined);
});

test('every reply index of a synthetic chat round-trips through the JSON file form', () => {
    const chat = makeChat(40);
    for (let reply = 1; reply <= 40; reply++) {
        const prefix = chat.slice(0, reply * 2);
        const packed = packCheckpoints(prefix);
        const restored = unpackCheckpoints(roundTrip(packed).entries, roundTrip(packed).packing);
        assert.equal(text(restored), text(prefix), `reply ${reply}`);
        restored.forEach((entry, index) => assert.deepEqual(Object.keys(entry), Object.keys(prefix[index])));
    }
});

test('anchors, the newest four replies, and the second checkpoint of an anchor turn follow the rule', () => {
    const chat = makeChat(60);
    const { entries, stats } = packCheckpoints(chat);
    const otherFullReasons = (stats.reasons.size || 0) + (stats.reasons.verify || 0) + (stats.reasons.stall || 0);
    entries.forEach((entry, index) => {
        if (Object.hasOwn(entry, 'packed')) return;
        const turn = chat[index].snapshot.turn;
        const isTail = turn >= 60 - 3;
        const isAnchor = turn % 25 === 0 && index === chat.findIndex(c => c.snapshot.turn === turn);
        const isHead = index === 0;
        assert.ok(isTail || isAnchor || isHead || otherFullReasons > 0, `full entry ${index} turn ${turn}`);
    });
    for (const turn of [57, 58, 59, 60]) {
        const indices = chat.map((c, i) => (c.snapshot.turn === turn ? i : -1)).filter(i => i >= 0);
        for (const i of indices) assert.ok(!Object.hasOwn(entries[i], 'packed'), `tail turn ${turn} entry ${i}`);
    }
    for (const turn of [25, 50]) {
        const indices = chat.map((c, i) => (c.snapshot.turn === turn ? i : -1)).filter(i => i >= 0);
        assert.ok(!Object.hasOwn(entries[indices[0]], 'packed'), `anchor turn ${turn}`);
        assert.ok(Object.hasOwn(entries[indices[1]], 'packed'), `second entry of anchor turn ${turn} is a patch`);
    }
    assert.ok(stats.packed > 0 && stats.full + stats.packed + stats.verbatim === stats.entries);
});

test('a patch base is always an earlier entry, and the packed form is smaller than the full form', () => {
    const chat = makeChat(60);
    const packed = packCheckpoints(chat);
    packed.entries.forEach((entry, index) => {
        if (!Object.hasOwn(entry, 'packed')) return;
        assert.ok(Number.isInteger(entry.packed.base) && entry.packed.base < index);
        assert.ok(chainLength(packed.entries, index) <= 25 * 2, 'chain bounded by anchors');
    });
    assert.ok(text(packed.entries).length < text(chat).length);
});

test('a stalled chain is cut at maxChainEntries', () => {
    // Padding keeps each one-field patch smaller than its snapshot, so only the stall rule can make an entry full.
    const pad = 'p'.repeat(300);
    const chat = [];
    for (let i = 0; i < 10; i++) {
        chat.push({ lineageKey: `s${i}`, parentLineageKey: i ? `s${i - 1}` : null, snapshot: { turn: 1, pad, npcs: [{ id: 'n', v: i }] } });
    }
    chat.push({ lineageKey: 'top', parentLineageKey: 's9', snapshot: { turn: 100, pad, npcs: [{ id: 'n', v: 0 }] } });
    const { entries, stats } = packCheckpoints(chat, { maxChainEntries: 3 });
    assert.ok(stats.reasons.stall >= 1);
    entries.forEach((_, index) => assert.ok(chainLength(entries, index) <= 3, `entry ${index}`));
    assert.equal(text(unpackCheckpoints(JSON.parse(text(entries)), packCheckpoints(chat, { maxChainEntries: 3 }).packing)), text(chat));
});

test('a rollback: activeKeys decides the newest reply, so the active tail stays full', () => {
    const active = makeChat(12).map(entry => ({ ...entry }));
    const stale = makeChat(30).slice(24).map(entry => ({ ...entry, lineageKey: `stale-${entry.lineageKey}`, parentLineageKey: 'stale' }));
    const chat = [...active, ...stale];
    const activeKeys = active.map(entry => entry.lineageKey);
    const withActive = packCheckpoints(chat, { activeKeys });
    for (let i = active.length - 4; i < active.length; i++) {
        assert.ok(!Object.hasOwn(withActive.entries[i], 'packed'), `active tail ${i}`);
    }
    const withoutActive = packCheckpoints(chat);
    assert.equal(text(unpackCheckpoints(JSON.parse(text(withActive.entries)), withActive.packing)), text(chat));
    assert.equal(text(unpackCheckpoints(JSON.parse(text(withoutActive.entries)), withoutActive.packing)), text(chat));
});

test('entries without a plain snapshot are stored verbatim and never used as a base', () => {
    const chat = [
        { messageId: 9 },
        { messageId: 10, pad: 'x' },
        { messageId: 11, base: 3, patch: [] },
        { messageId: 12, lineageKey: 'k', snapshot: { turn: 1, npcs: [] } },
        { messageId: 13, lineageKey: 'j', parentLineageKey: 'k', snapshot: { turn: 1, npcs: [{ id: 'a' }] } },
    ];
    const packed = packCheckpoints(chat);
    assert.equal(packed.stats.verbatim, 3);
    assert.deepEqual(packed.entries.slice(0, 3), chat.slice(0, 3));
    assert.equal(packed.entries.some(entry => Object.hasOwn(entry, 'packed') && entry.packed.base < 3 && entry.messageId !== 11), false);
    assert.equal(text(unpackCheckpoints(JSON.parse(text(packed.entries)), packed.packing)), text(chat));
});

test('a snapshot with no finite turn is stored full, never packed by turn rule', () => {
    const chat = [{ lineageKey: 'a', snapshot: { npcs: [] } }, { lineageKey: 'b', parentLineageKey: 'a', snapshot: { npcs: [{ id: 'x' }] } }];
    const packed = packCheckpoints(chat);
    assert.equal(packed.stats.reasons['no-turn'], 2);
    assert.equal(text(unpackCheckpoints(JSON.parse(text(packed.entries)), packed.packing)), text(chat));
});

test('an entry that already uses the reserved "packed" key refuses the whole pack', () => {
    assert.throws(() => packCheckpoints([{ messageId: 1, packed: 'mine', snapshot: { turn: 1 } }]), PackError);
    assert.throws(() => packCheckpoints([{ messageId: 1, packed: {} }]), PackError);
});

test('a patch larger than its full snapshot is not used', () => {
    // Filler replies push the newest turn to 6, so turn 2 is outside the four-reply tail.
    const chat = [
        { lineageKey: 'a', snapshot: { turn: 1, v: 'x' } },
        { lineageKey: 'b', parentLineageKey: 'a', snapshot: { turn: 2, v: 'y' } },
        { lineageKey: 'c', parentLineageKey: 'b', snapshot: { turn: 3, v: 'x' } },
        { lineageKey: 'd', parentLineageKey: 'c', snapshot: { turn: 4, v: 'x' } },
        { lineageKey: 'e', parentLineageKey: 'd', snapshot: { turn: 5, v: 'x' } },
        { lineageKey: 'f', parentLineageKey: 'e', snapshot: { turn: 6, v: 'x' } },
    ];
    const packed = packCheckpoints(chat);
    assert.equal(packed.stats.reasons.size, 1);
    assert.equal(Object.hasOwn(packed.entries[1], 'packed'), false);
    assert.equal(text(unpackCheckpoints(JSON.parse(text(packed.entries)), packed.packing)), text(chat));
});

test('packing is pure: the same input gives the same bytes and the input is not changed', () => {
    const chat = makeChat(30);
    const before = text(chat);
    const first = text(packCheckpoints(chat).entries);
    const second = text(packCheckpoints(chat).entries);
    assert.equal(first, second);
    assert.equal(text(chat), before);
});

test('a reused lineageKey with different content is packed from its own content', () => {
    const chat = makeChat(10);
    chat.push({ ...chat[0], snapshot: { ...chat[0].snapshot, turn: 99, npcs: [] } });
    const packed = packCheckpoints(chat);
    assert.equal(text(unpackCheckpoints(JSON.parse(text(packed.entries)), packed.packing)), text(chat));
});

test('invalid pack inputs and options throw PackError', () => {
    assert.throws(() => packCheckpoints({}), PackError);
    assert.throws(() => packCheckpoints([], { anchorEvery: 0 }), PackError);
    assert.throws(() => packCheckpoints([], { fullTail: 1.5 }), PackError);
    assert.throws(() => packCheckpoints([], { activeKeys: 'L1' }), PackError);
});

test('unpack refuses malformed input and never returns a partial result', () => {
    const chat = makeChat(6);
    const good = JSON.parse(text(packCheckpoints(chat).entries));
    const packing = { scheme: PACK_SCHEME, anchorEvery: 25, fullTail: 4, maxChainEntries: 80 };
    const packedIndex = good.findIndex(entry => Object.hasOwn(entry, 'packed'));
    const withPacked = mutate => {
        const copy = JSON.parse(text(good));
        mutate(copy[packedIndex]);
        return copy;
    };
    const cases = [
        () => unpackCheckpoints({}, packing),
        () => unpackCheckpoints(good, { scheme: 'other' }),
        () => unpackCheckpoints(good, null),
        () => unpackCheckpoints(withPacked(e => (e.packed.base = e.packed.base + 100)), packing),
        () => unpackCheckpoints(withPacked(e => (e.packed.base = -1)), packing),
        () => unpackCheckpoints(withPacked(e => (e.packed.base = 1.5)), packing),
        () => unpackCheckpoints(withPacked(e => (e.packed.base = '0')), packing),
        () => unpackCheckpoints(withPacked(e => (e.packed.patch = 'nope')), packing),
        () => unpackCheckpoints(withPacked(e => e.packed.patch.push({ op: 'move', path: '/turn', from: '/x' })), packing),
        () => unpackCheckpoints(withPacked(e => e.packed.patch.push({ op: 'replace', path: '/nope/deep', value: 1 })), packing),
        () => unpackCheckpoints(withPacked(e => (e.snapshot = {})), packing),
        () => unpackCheckpoints(withPacked(e => (e.packed = 'x')), packing),
        () => unpackCheckpoints([{ messageId: 1, packed: { base: 0, patch: [] } }], packing),
    ];
    for (const run of cases) assert.throws(run, PackError);
    assert.doesNotThrow(() => unpackCheckpoints(good, packing));
});

test('stats report counts by reason and sum to the entry count', () => {
    const chat = makeChat(40);
    const { stats, entries } = packCheckpoints(chat);
    assert.equal(stats.entries, chat.length);
    assert.equal(stats.full + stats.packed + stats.verbatim, chat.length);
    assert.equal(stats.packed, entries.filter(entry => Object.hasOwn(entry, 'packed')).length);
    assert.equal(Object.values(stats.reasons).reduce((a, b) => a + b, 0), stats.full);
});

test('applyJson shares unchanged parts with its base but never mutates it; unpacked snapshots own their data', () => {
    const base = { a: { deep: [1, 2, { x: 1 }] }, b: { keep: [3] }, c: 'same' };
    const frozen = text(base);
    const result = applyJson(base, [{ op: 'replace', path: '/a/deep/2/x', value: 2 }, { op: 'add', path: '/a/deep/-', value: 9 }]);
    assert.equal(text(base), frozen);
    assert.equal(result.b, base.b, 'untouched branch is shared');
    assert.notEqual(result.a, base.a);
    assert.equal(text(result), text({ a: { deep: [1, 2, { x: 2 }, 9] }, b: { keep: [3] }, c: 'same' }));
    const chain = makeChat(30);
    const file = JSON.parse(text(packCheckpoints(chain).entries));
    const back = unpackCheckpoints(file, { scheme: PACK_SCHEME });
    assert.equal(text(back), text(chain));
    const seen = new Set();
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        assert.equal(seen.has(value), false, 'no object is shared between two unpacked entries');
        seen.add(value);
        for (const child of Object.values(value)) walk(child);
    };
    for (const entry of back) walk(entry.snapshot);
});

test('diffPlainJson (plain JSON in, no copies made) gives the patch diffJson gives and rebuilds the target', () => {
    const chat = makeChat(12);
    for (let i = 1; i < chat.length; i += 1) {
        const base = chat[i - 1].snapshot;
        const target = chat[i].snapshot;
        assert.deepEqual(diffPlainJson(base, target), diffJson(base, target));
        assert.deepEqual(applyJson(base, diffPlainJson(base, target)), target);
    }
});
