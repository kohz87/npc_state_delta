// NPC notes, lies told (src/npc-notes-lies.js): the leaf reader, adding a lie (re-read, no-op, caps), catching one (match, trust change
// at a tier, drop), the hidden tail line, the dossier rows with and without redaction, and the caught receipt. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LIES_MAX, LIE_SAID_MAX, LIE_TO_MAX, LIES_TEXT_MAX, readLies, addLie, catchLie, caughtChange, lieTail, lieRows, caughtSummary,
} from '../src/npc-notes-lies.js';

const said = "I didn't sell a spell.";
const one = (over = {}) => addLie(null, { to: 'Astra', said, day: 3, r: 'r1', ...over });

test('readLies: absent, empty, malformed and over-long text read as null or an empty list', () => {
    assert.equal(readLies(null), null);
    assert.equal(readLies(''), null);
    assert.equal(readLies('not json'), null);
    assert.equal(readLies('{}'), null);
    assert.deepEqual(readLies('[]'), []);
    assert.equal(readLies('x'.repeat(LIES_TEXT_MAX + 1)), null);
});

test('readLies: an entry with a missing or over-long part makes the whole leaf unusable', () => {
    const good = { id: 'r1:Astra:x', to: 'Astra', said: 'x', day: 1, r: 'r1' };
    assert.ok(readLies(JSON.stringify([good])));
    assert.equal(readLies(JSON.stringify([{ ...good, said: 'x'.repeat(LIE_SAID_MAX + 1) }])), null);
    assert.equal(readLies(JSON.stringify([{ ...good, to: 'x'.repeat(LIE_TO_MAX + 1) }])), null);
    assert.equal(readLies(JSON.stringify([{ ...good, caught: { day: 2 } }])), null);
    assert.equal(readLies(JSON.stringify([{ ...good, day: -1 }])), null);
    assert.equal(readLies(JSON.stringify([good, good, good, good, good, good, good])), null);
});

test('addLie: writes one entry with the reply key and clips the words to their limits', () => {
    const res = one({ said: '  ' + 'a'.repeat(300) + '  ', to: 'B'.repeat(80) });
    assert.equal(res.changed, true);
    const list = readLies(res.text);
    assert.equal(list.length, 1);
    assert.equal(list[0].said.length, LIE_SAID_MAX);
    assert.equal(list[0].to.length, LIE_TO_MAX);
    assert.equal(list[0].r, 'r1');
    assert.equal(list[0].caught, undefined);
});

test('addLie: refuses a lie without a person, words, or a usable day and reply', () => {
    assert.equal(addLie(null, { to: '', said, day: 1, r: 'r' }).changed, false);
    assert.match(addLie(null, { to: 'Astra', said: '   ', day: 1, r: 'r' }).problem, /what was said/);
    assert.match(addLie(null, { to: 'Astra', said, day: -2, r: 'r' }).problem, /story day/);
    assert.match(addLie(null, { to: 'Astra', said, day: 1 }).problem, /reply/);
});

test('addLie: a null story day (no clock) is kept as null', () => {
    const list = readLies(one({ day: null }).text);
    assert.equal(list[0].day, null);
});

test('addLie: a re-read of the same reply replaces its own entry instead of duplicating it', () => {
    const first = one().text;
    const again = addLie(first, { to: 'Astra', said, day: 3, r: 'r1' });
    assert.equal(again.changed, true);
    assert.equal(readLies(again.text).length, 1);
});

test('addLie: a re-read keeps the caught stamp of the entry it replaces', () => {
    const lied = one().text;
    const caught = catchLie(lied, { to: 'Astra', day: 4, r: 'r9' }).text;
    const reread = addLie(caught, { to: 'Astra', said, day: 3, r: 'r1' });
    assert.deepEqual(readLies(reread.text)[0].caught, { day: 4, r: 'r9' });
});

test('addLie: the same words to the same person on the same day from another reply is a no-op', () => {
    const first = one().text;
    const res = addLie(first, { to: 'astra', said, day: 3, r: 'r2' });
    assert.equal(res.changed, false);
    assert.equal(res.text, first);
    assert.equal(res.problem, '');
});

test('addLie: the same words on a later day are recorded again', () => {
    const res = addLie(one().text, { to: 'Astra', said, day: 4, r: 'r2' });
    assert.equal(res.changed, true);
    assert.equal(readLies(res.text).length, 2);
});

test('addLie: over the cap, the oldest caught lie goes first, else the oldest lie', () => {
    let text = null;
    for (let i = 0; i < LIES_MAX; i += 1) text = addLie(text, { to: 'Astra', said: `lie ${i}`, day: 1, r: `r${i}` }).text;
    text = catchLie(text, { said: 'lie 2', day: 2, r: 'c2' }).text;
    const next = readLies(addLie(text, { to: 'Mira', said: 'new', day: 2, r: 'n' }).text);
    assert.equal(next.length, LIES_MAX);
    assert.equal(next.some(item => item.said === 'lie 2'), false);
    assert.equal(next[0].said, 'lie 0');

    const plain = readLies(addLie(
        (() => { let t = null; for (let i = 0; i < LIES_MAX; i += 1) t = addLie(t, { to: 'Astra', said: `p ${i}`, day: 1, r: `q${i}` }).text; return t; })(),
        { to: 'Mira', said: 'new', day: 1, r: 'z' },
    ).text);
    assert.equal(plain.length, LIES_MAX);
    assert.equal(plain[0].said, 'p 1');
});

test('catchLie: stamps the latest uncaught lie to the person and returns the trust change at the default tier', () => {
    let text = one({ said: 'first', r: 'r1' }).text;
    text = addLie(text, { to: 'Astra', said: 'second', day: 3, r: 'r2' }).text;
    const res = catchLie(text, { to: 'Astra', day: 5, r: 'r7' });
    const list = readLies(res.text);
    assert.deepEqual(list[1].caught, { day: 5, r: 'r7' });
    assert.equal(list[0].caught, undefined);
    assert.deepEqual(res.change, { changes: [{ meter: 'trust', mode: 'add', value: -6 }], impact: { tier: 'extreme' } });
});

test('the caught-lie tier is one source: the kinds file re-exports the lies file\'s extreme tier', async () => {
    const kinds = await import('../src/npc-notes-kinds.js');
    const lies = await import('../src/npc-notes-lies.js');
    assert.equal(lies.CAUGHT_TIER, 'extreme');
    assert.equal(kinds.CAUGHT_TIER, lies.CAUGHT_TIER);
    assert.equal(kinds.CAUGHT_DROP, lies.CAUGHT_DROP);
});

test('catchLie: matches by the words said, ignoring case, and skips lies already caught', () => {
    let text = one({ said: 'I was at the docks', r: 'r1' }).text;
    text = catchLie(text, { said: 'docks', day: 2, r: 'c1' }).text;
    assert.equal(catchLie(text, { said: 'docks', day: 3, r: 'c2' }), null);
    text = addLie(text, { to: 'Astra', said: 'I was at the DOCKS too', day: 3, r: 'r2' }).text;
    const res = catchLie(text, { said: 'docks' , day: 4, r: 'c3' });
    assert.equal(readLies(res.text)[1].said, 'I was at the DOCKS too');
});

test('catchLie: no match, no key, or an unusable tier or drop gives null', () => {
    const text = one().text;
    assert.equal(catchLie(text, { to: 'Mira', day: 2, r: 'c' }), null);
    assert.equal(catchLie(text, { day: 2, r: 'c' }), null);
    assert.equal(catchLie(text, { to: 'Astra', day: 2, r: 'c', tier: 'huge' }), null);
    assert.equal(catchLie(text, { to: 'Astra', day: 2, r: 'c', drop: 0 }), null);
    assert.equal(catchLie(null, { to: 'Astra', day: 2, r: 'c' }), null);
});

test('catchLie: the tier and the drop are parameters', () => {
    const res = catchLie(one().text, { to: 'Astra', day: 2, r: 'c', tier: 'major', drop: 9 });
    assert.deepEqual(res.change, { changes: [{ meter: 'trust', mode: 'add', value: -9 }], impact: { tier: 'major' } });
    assert.deepEqual(caughtChange(), { changes: [{ meter: 'trust', mode: 'add', value: -6 }], impact: { tier: 'extreme' } });
});

test('lieTail: the latest uncaught lie as one hidden line, or empty', () => {
    assert.equal(lieTail('Rika', null), '');
    assert.equal(lieTail('Rika', one().text), 'Rika (hidden): told Astra "I didn\'t sell a spell."; stay consistent unless caught.');
    const caught = catchLie(one().text, { to: 'Astra', day: 2, r: 'c' }).text;
    assert.equal(lieTail('Rika', caught), '');
    const two = addLie(one().text, { to: 'Mira', said: 'the bell rang', day: 3, r: 'r2' }).text;
    assert.match(lieTail('Rika', two), /told Mira "the bell rang"/);
});

test('lieRows: uncaught rows are hidden and their words are redacted by default', () => {
    const rows = lieRows(one().text);
    assert.deepEqual(rows, [{ id: 'lie-0', to: 'Astra', said: null, day: 3, hidden: true, caught: null }]);
});

test('lieRows: a redacted row carries neither the words nor an id that embeds them', () => {
    const [row] = lieRows(one().text);
    assert.equal(row.said, null);
    assert.doesNotMatch(JSON.stringify(row), /sell a spell/);
    assert.match(row.id, /^lie-\d+$/);
});

test('lieRows: redact false shows the words of uncaught rows too', () => {
    const rows = lieRows(one().text, { redact: false });
    assert.equal(rows[0].said, said);
    assert.equal(rows[0].hidden, true);
});

test('lieRows: a caught row is not hidden and keeps its words and stamp', () => {
    const text = catchLie(one().text, { to: 'Astra', day: 4, r: 'c' }).text;
    const [row] = lieRows(text);
    assert.equal(row.hidden, false);
    assert.equal(row.said, said);
    assert.deepEqual(row.caught, { day: 4, r: 'c' });
});

test('lieRows: no leaf gives no rows', () => {
    assert.deepEqual(lieRows(null), []);
});

test('caughtSummary: the receipt with and without trust numbers', () => {
    assert.equal(caughtSummary('Rika', 'Astra', 11, 5), 'Rika: caught in a lie to Astra; trust 11 → 5.');
    assert.equal(caughtSummary('Rika', 'Astra'), 'Rika: caught in a lie to Astra.');
});
