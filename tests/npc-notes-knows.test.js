// NPC notes, "knows about others": the stored list, the input check, the reply re-read, secret redaction until opened, the tail lines
// and the dossier rows. Pure functions only (src/npc-notes-knows.js); no host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOW_RULE, KNOWS_MAX, KNOWS_TAIL_MAX, addKnow, knowRuleFor, markKnowResult, readHow, knowFact, knowsTail, knowsView, openKnow, readKnows } from '../src/npc-notes-knows.js';

const gate = { about: 'Oren', fact: 'copies the gate-logs', how: 'saw', secret: true };
const weather = { about: 'Mira', fact: 'is afraid of rain', how: 'heard' };

test('addKnow writes one reply and readKnows reads it back, cleaned and in order', () => {
    const { text, problem } = addKnow('', 'r1', [gate, weather]);
    assert.equal(problem, null);
    const list = readKnows(text);
    assert.deepEqual(list.map(item => item.fact), ['copies the gate-logs', 'is afraid of rain']);
    assert.deepEqual(list[0], { about: 'Oren', fact: 'copies the gate-logs', how: 'saw', day: null, r: 'r1', secret: true });
    assert.equal(list[1].secret, undefined, 'a plain fact has no secret key');
});

test('the input is cleaned: control characters and runs of space go, over-long text is cut', () => {
    const { text } = addKnow('', 1, [{ about: '  Oren\u0007  ', fact: `a\n\tb ${'x'.repeat(300)}`, how: 'saw', day: 3 }]);
    const [item] = readKnows(text);
    assert.equal(item.about, 'Oren');
    assert.ok(item.fact.startsWith('a b x'));
    assert.equal([...item.fact].length, 140);
    assert.equal(item.day, 3);
});

test('a bad line refuses the whole reply: no text, a problem, nothing written', () => {
    for (const bad of [
        { about: 'Oren', fact: 'x', how: 'read' },
        { about: '', fact: 'x', how: 'saw' },
        { about: 'Oren', fact: '   ', how: 'saw' },
        { about: 'Oren', fact: 'x', how: 'saw', day: -1 },
    ]) {
        const result = addKnow('', 'r1', [weather, bad]);
        assert.equal(result.text, null);
        assert.match(result.problem, /know needs/);
    }
    assert.equal(addKnow('', null, [weather]).text, null, 'no reply key, no write');
});

test('a Re-read of the same reply replaces its own entries and does not duplicate them', () => {
    const first = addKnow('', 'r1', [gate]).text;
    const kept = addKnow(first, 'r2', [weather]).text;
    const again = addKnow(kept, 'r1', [{ ...gate, fact: 'copies the gate-logs twice' }]).text;
    assert.deepEqual(readKnows(again).map(item => item.r), ['r2', 'r1']);
    assert.equal(readKnows(again)[1].fact, 'copies the gate-logs twice');
});

test('the same about and fact from a later reply refreshes the entry rather than repeating it', () => {
    const first = addKnow('', 'r1', [{ ...weather, how: 'heard' }]).text;
    const later = addKnow(first, 'r2', [{ ...weather, about: 'MIRA', fact: 'Is afraid of rain', how: 'saw' }]).text;
    const list = readKnows(later);
    assert.equal(list.length, 1);
    assert.equal(list[0].how, 'saw');
    assert.equal(list[0].r, 'r2');
});

test('the list keeps the newest KNOWS_MAX entries', () => {
    let text = '';
    for (let i = 0; i < KNOWS_MAX + 2; i += 1) text = addKnow(text, `r${i}`, [{ about: `N${i}`, fact: `fact ${i}`, how: 'saw' }]).text;
    const list = readKnows(text);
    assert.equal(list.length, KNOWS_MAX);
    assert.equal(list[0].fact, 'fact 2');
    assert.equal(list.at(-1).fact, `fact ${KNOWS_MAX + 1}`);
});

test('readKnows gives nothing for absent, oversized, or malformed text, and drops bad stored entries', () => {
    assert.deepEqual(readKnows(undefined), []);
    assert.deepEqual(readKnows(''), []);
    assert.deepEqual(readKnows('{not json'), []);
    assert.deepEqual(readKnows('{"a":1}'), []);
    assert.deepEqual(readKnows('x'.repeat(2001)), []);
    const mixed = JSON.stringify([{ about: 'Oren', fact: 'ok', how: 'saw', r: 'r1' }, { about: 'Oren', fact: 'bad how', how: 'read', r: 'r1' }, 7]);
    assert.deepEqual(readKnows(mixed).map(item => item.fact), ['ok']);
});

test('openKnow clears the secret on the matching entry only, and gives null when nothing matches', () => {
    const text = addKnow('', 'r1', [gate, weather]).text;
    const opened = openKnow(text, 'oren', 'Copies the gate-logs');
    const list = readKnows(opened);
    assert.equal(list[0].secret, undefined);
    assert.equal(list[1].fact, 'is afraid of rain');
    assert.equal(openKnow(opened, 'Oren', 'copies the gate-logs'), null, 'already open: nothing to write');
    assert.equal(openKnow(text, 'Nobody', 'nothing'), null);
});

test('a secret fact is redacted until opened or shown; a plain fact is never redacted', () => {
    const [secret, plain] = readKnows(addKnow('', 'r1', [gate, weather]).text);
    assert.equal(knowFact(secret), 'a secret about Oren · hidden');
    assert.equal(knowFact(secret, true), 'copies the gate-logs');
    assert.equal(knowFact(plain), 'is afraid of rain');
});

test('dossier rows are newest first, and a hidden row never carries the fact', () => {
    const text = addKnow('', 'r1', [gate]).text;
    const rows = knowsView(addKnow(text, 'r2', [weather]).text);
    assert.deepEqual(rows.map(row => row.about), ['Mira', 'Oren']);
    const hidden = rows[1];
    assert.equal(hidden.secret, true);
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.text, 'a secret about Oren · hidden');
    assert.ok(!JSON.stringify(hidden).includes('gate-logs'), 'the row must not contain the secret fact');
    const shown = knowsView(text, { show: true })[0];
    assert.equal(shown.hidden, false);
    assert.equal(shown.text, 'copies the gate-logs');
});

test('the tail gives each present person one line: the newest secret first, else the newest fact', () => {
    const astra = addKnow('', 'r1', [gate, { about: 'Mira', fact: 'owes a debt', how: 'saw', secret: true }]).text;
    const oren = addKnow('', 'r1', [weather]).text;
    const lines = knowsTail([{ name: 'Astra', knows: astra }, { name: 'Oren', knows: oren }]);
    assert.deepEqual(lines, [
        'Astra (hidden): knows Mira\'s owes a debt; never reveal it unless the story shows them telling.',
        'Oren knows: Mira\'s is afraid of rain',
    ]);
});

test('a secret never goes into another person\'s tail line', () => {
    const astra = addKnow('', 'r1', [gate]).text;
    const lines = knowsTail([{ name: 'Mira', knows: '' }, { name: 'Oren', knows: '' }, { name: 'Astra', knows: astra }]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('Astra (hidden)'));
    assert.ok(!lines.some(line => line.startsWith('Mira') || line.startsWith('Oren')));
});

test('the tail is capped at KNOWS_TAIL_MAX lines in all, in the order given', () => {
    const people = Array.from({ length: KNOWS_TAIL_MAX + 3 }, (_, i) => ({ name: `P${i}`, knows: addKnow('', 'r1', [{ about: 'X', fact: `f${i}`, how: 'saw' }]).text }));
    const lines = knowsTail(people);
    assert.equal(lines.length, KNOWS_TAIL_MAX);
    assert.match(lines[0], /^P0 knows: /);
});

test('the tail gives nothing for people who know nothing, and a bad name is skipped', () => {
    assert.deepEqual(knowsTail([{ name: 'Mira', knows: '' }, { name: '  ', knows: addKnow('', 'r1', [weather]).text }, null]), []);
    assert.deepEqual(knowsTail(undefined), []);
});

test('how: is read by its words: seeing words give saw, hearing words heard, both give saw', () => {
    for (const how of ['seen and verified', 'shown in Guild folio', 'told and shown', 'saw', 'Witnessed it', 'checked']) assert.equal(readHow(how), 'saw', how);
    for (const how of ['heard', 'told', 'overheard', 'a rumour', 'gossip at the dock', 'reported by Klaas']) assert.equal(readHow(how), 'heard', how);
    for (const how of ['', 'guessed', 'dreamed', undefined]) assert.equal(readHow(how), null, String(how));
});

test('the owner lines (14 Nov) are kept with a canonical how when read by the rule, and still refused when how names neither', () => {
    const hows = ['seen and verified', 'seen and verified', 'shown in Guild folio', 'told and shown'];
    const lines = hows.map((how, i) => ({ about: 'Astra', fact: `fact ${i}`, how }));
    const out = addKnow('', 'r1', lines, { tolerant: true });
    assert.equal(out.problem, null);
    assert.deepEqual(readKnows(out.text).map(e => e.how), ['saw', 'saw', 'saw', 'saw']);
    assert.equal(addKnow('', 'r1', [{ about: 'Astra', fact: 'x', how: 'guessed' }], { tolerant: true }).problem, 'know needs about, fact and how (saw or heard)');
    assert.equal(addKnow('', 'r1', [lines[0]]).problem, 'know needs about, fact and how (saw or heard)', 'strict reading (a stored reply) still refuses it');
    assert.equal(readKnows(addKnow('', 'r1', [{ about: 'A', fact: 'f', how: 'rumour' }], { tolerant: true }).text)[0].how, 'heard');
});

test('knowRuleFor: a new line reads by the rule; a Re-read keeps a refused line refused', () => {
    const labels = { about: 'Astra', fact: 'fact 0', how: 'seen and verified' };
    const standing = text => ({ domains: { npc: { npcs: { roeland: { knows: text } } } } });
    assert.equal(knowRuleFor(null, 'roeland', 'r1', labels), KNOW_RULE);
    assert.equal(knowRuleFor(standing(''), 'roeland', 'r1', labels), 0, 'nothing stored: the old read refused it');
    const kept = addKnow('', 'r1', [labels], { tolerant: true }).text;
    assert.equal(knowRuleFor(standing(kept), 'roeland', 'r1', labels), KNOW_RULE);
    assert.equal(knowRuleFor(standing(kept), 'roeland', 'r2', labels), 0);
    const receipt = { type: 'capture.know', data: { key: 'roeland', knowRule: KNOW_RULE, knowId: 'astra|fact 0' } };
    assert.equal(knowRuleFor(standing(''), 'roeland', 'r1', labels, [receipt]), KNOW_RULE);
    assert.equal(markKnowResult({ data: {} }, labels, KNOW_RULE).data.knowId, 'astra|fact 0');
    assert.deepEqual(markKnowResult({ data: {} }, labels, 0), { data: {} });
});
