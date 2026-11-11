// NPC notes, tastes: the record reader and its caps, the fixed rule (first mention wins; a change needs why:), the deterministic
// mirror check (flags, never blocks), the wording and the tail line. Pure functions from src/npc-notes-tastes.js, no host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    TASTE_LIMITS, addTaste, contentWords, mirrorCheck, mirrorWording, readTastes, tasteKey, tasteTail, tastesText,
} from '../src/npc-notes-tastes.js';

const row = (sign, item, extra = {}) => ({ sign, item, day: 1, r: 'r1', ...extra });

test('tasteKey joins the words so spacing and case do not make a new taste', () => {
    assert.equal(tasteKey('Burnt  Sugar Toffee'), 'burnt-sugar-toffee');
    assert.equal(tasteKey('burnt-sugar toffee'), 'burnt-sugar-toffee');
    assert.equal(tasteKey('   '), '');
});

test('readTastes accepts a JSON text leaf or an array and drops invalid rows', () => {
    const raw = [
        row('+', 'toffee'),
        { sign: '*', item: 'nope', day: 1 },
        { sign: '-', item: '', day: 1 },
        { sign: '-', item: 'paperwork', day: -2 },
        { sign: '-', item: 'paperwork', day: 2.5 },
        null,
        'text',
    ];
    assert.deepEqual(readTastes(raw), [row('+', 'toffee')]);
    assert.deepEqual(readTastes(JSON.stringify(raw)), [row('+', 'toffee')]);
});

test('readTastes returns [] for junk text, non-arrays and oversize text', () => {
    assert.deepEqual(readTastes('{not json'), []);
    assert.deepEqual(readTastes('{"sign":"+"}'), []);
    assert.deepEqual(readTastes(undefined), []);
    assert.deepEqual(readTastes('[' + ' '.repeat(TASTE_LIMITS.text) + ']'), []);
});

test('readTastes keeps the first mention of an item, whatever its sign', () => {
    const rows = readTastes([row('+', 'toffee'), row('-', 'Toffee'), row('+', 'tea')]);
    assert.deepEqual(rows.map(entry => [entry.sign, entry.item]), [['+', 'toffee'], ['+', 'tea']]);
});

test('readTastes caps each sign and keeps the newest rows', () => {
    const likes = Array.from({ length: TASTE_LIMITS.likes + 2 }, (_, i) => row('+', `like ${i}`));
    const dislikes = Array.from({ length: TASTE_LIMITS.dislikes + 1 }, (_, i) => row('-', `dislike ${i}`));
    const kept = readTastes([...likes, ...dislikes]);
    assert.equal(kept.filter(entry => entry.sign === '+').length, TASTE_LIMITS.likes);
    assert.equal(kept.filter(entry => entry.sign === '-').length, TASTE_LIMITS.dislikes);
    assert.equal(kept.find(entry => entry.sign === '+').item, 'like 2');
    assert.equal(kept.find(entry => entry.sign === '-').item, 'dislike 1');
});

test('readTastes cleans text, bounds the item and the from, and keeps mirrored and from', () => {
    const long = `${'x'.repeat(80)}\u0007`;
    const [entry] = readTastes([{ sign: '+', item: `  ${long}\n`, from: 'barge\tcrews', day: 3, r: 7, mirrored: true }]);
    assert.equal(entry.item.length, TASTE_LIMITS.item);
    assert.equal(entry.from, 'barge crews');
    assert.equal(entry.day, 3);
    assert.equal(entry.r, '7');
    assert.equal(entry.mirrored, true);
});

test('addTaste stores a new taste with its day, reply tag and from', () => {
    const out = addTaste([], { name: 'Mira', sign: '+', item: 'burnt-sugar toffee', from: 'barge crews', day: 4, r: 'r9', userText: 'Pass the bread.' });
    assert.equal(out.status, 'added');
    assert.equal(out.problem, '');
    assert.equal(out.cue, '');
    assert.deepEqual(out.tastes, [{ sign: '+', item: 'burnt-sugar toffee', from: 'barge crews', day: 4, r: 'r9' }]);
    assert.deepEqual(out.entry, out.tastes[0]);
});

test('addTaste: the same taste again is a no-op', () => {
    const first = addTaste([], { name: 'Mira', sign: '-', item: 'paperwork', from: 'the charter', day: 1, r: 'a' });
    const again = addTaste(first.tastes, { name: 'Mira', sign: '-', item: 'Paperwork', day: 2, r: 'b' });
    assert.equal(again.status, 'same');
    assert.deepEqual(again.tastes, first.tastes);
    assert.equal(again.entry, null);
});

test('addTaste: the opposite sign is refused without why:, and the list stays the same', () => {
    const first = addTaste([], { name: 'Mira', sign: '+', item: 'toffee', day: 1, r: 'a' });
    const out = addTaste(first.tastes, { name: 'Mira', sign: '-', item: 'toffee', day: 2, r: 'b' });
    assert.equal(out.status, 'refused');
    assert.equal(out.problem, 'Mira already likes toffee; a change needs a why: reason.');
    assert.deepEqual(out.tastes, first.tastes);
});

test('addTaste: the opposite sign with why: replaces the old taste', () => {
    const first = addTaste([], { name: 'Mira', sign: '+', item: 'toffee', day: 1, r: 'a' });
    const out = addTaste(first.tastes, { name: 'Mira', sign: '-', item: 'toffee', why: 'the sugar riot', day: 2, r: 'b' });
    assert.equal(out.status, 'changed');
    assert.deepEqual(out.tastes, [{ sign: '-', item: 'toffee', day: 2, r: 'b' }]);
});

test('addTaste refuses a missing item or a sign that is not + or -', () => {
    const a = addTaste([], { name: 'Mira', sign: '+', item: '  ' });
    const b = addTaste([], { name: 'Mira', sign: 'x', item: 'toffee' });
    assert.equal(a.status, 'refused');
    assert.equal(b.status, 'refused');
    assert.deepEqual(a.tastes, []);
    assert.deepEqual(b.tastes, []);
});

test('addTaste: a seventh like drops the oldest like and keeps the dislikes', () => {
    let list = addTaste([], { sign: '-', item: 'paperwork', day: 0, r: 'd' }).tastes;
    for (let i = 0; i < TASTE_LIMITS.likes; i += 1) list = addTaste(list, { sign: '+', item: `like ${i}`, day: i, r: `r${i}` }).tastes;
    const out = addTaste(list, { sign: '+', item: 'new like', day: 9, r: 'n' });
    const likes = out.tastes.filter(entry => entry.sign === '+').map(entry => entry.item);
    assert.equal(likes.length, TASTE_LIMITS.likes);
    assert.equal(likes[0], 'like 1');
    assert.equal(likes.at(-1), 'new like');
    assert.equal(out.tastes.filter(entry => entry.sign === '-').length, 1);
});

test('addTaste writes a day that is not a whole number of days as 0', () => {
    const out = addTaste([], { sign: '+', item: 'toffee', day: 'soon', r: null });
    assert.equal(out.tastes[0].day, 0);
    assert.equal(out.tastes[0].r, null);
});

test('contentWords lowercases, drops stop words and keeps Unicode letters', () => {
    assert.deepEqual(contentWords('The Burnt sugar, of TOFFEE!'), ['burnt', 'sugar', 'toffee']);
    assert.deepEqual(contentWords('Я люблю карамель'), ['я', 'люблю', 'карамель']);
    assert.deepEqual(contentWords(undefined), []);
});

test('mirrorCheck flags a taste whose words echo the last user message', () => {
    const out = mirrorCheck({ userText: 'I adore burnt sugar toffee.', item: 'burnt sugar toffee' });
    assert.deepEqual(out, { mirrored: true, matched: 3, total: 3 });
});

test('mirrorCheck needs at least half of the item words', () => {
    assert.equal(mirrorCheck({ userText: 'burnt', item: 'burnt sugar toffee' }).mirrored, false);
    assert.equal(mirrorCheck({ userText: 'burnt sugar', item: 'burnt sugar toffee' }).mirrored, true);
    assert.equal(mirrorCheck({ userText: 'burnt toffee', item: 'burnt sugar toffee' }).mirrored, true);
});

test('mirrorCheck does not flag when the user said nothing like it', () => {
    assert.equal(mirrorCheck({ userText: 'Tell me about the harbour.', item: 'toffee' }).mirrored, false);
    assert.equal(mirrorCheck({ userText: '', item: 'toffee' }).mirrored, false);
});

test('mirrorCheck ignores stop words, so an item of only stop words is never flagged', () => {
    assert.equal(mirrorCheck({ userText: 'the of a', item: 'the of a' }).mirrored, false);
    assert.deepEqual(mirrorCheck({ userText: 'the of a', item: 'the of a' }).total, 0);
});

test('mirrorCheck leaves a taste alone when why: or from: is given', () => {
    assert.equal(mirrorCheck({ userText: 'toffee', item: 'toffee', why: 'a bet lost' }).mirrored, false);
    assert.equal(mirrorCheck({ userText: 'toffee', item: 'toffee', from: 'the barge crews' }).mirrored, false);
});

test('mirrorCheck does not flag an area she already had a taste in', () => {
    const existing = readTastes([row('+', 'sugar biscuits')]);
    assert.equal(mirrorCheck({ userText: 'sugar', item: 'burnt sugar toffee', existing }).mirrored, false);
});

test('mirrorCheck works on other languages by the same word rule', () => {
    assert.equal(mirrorCheck({ userText: 'Я люблю карамель', item: 'карамель' }).mirrored, true);
    assert.equal(mirrorCheck({ userText: 'Я люблю карамель', item: 'бумажная волокита' }).mirrored, false);
});

test('mirrorCheck never throws without arguments', () => {
    assert.deepEqual(mirrorCheck(), { mirrored: false, matched: 0, total: 0 });
});

test('addTaste stores a mirrored taste, marks it, and returns its problem and cue (never refused)', () => {
    const out = addTaste([], { name: 'Mira', sign: '+', item: 'toffee', userText: 'Have some toffee!', day: 5, r: 'm' });
    assert.equal(out.status, 'added');
    assert.deepEqual(out.tastes, [{ sign: '+', item: 'toffee', day: 5, r: 'm', mirrored: true }]);
    assert.equal(out.problem, "Mira's liking for toffee echoes {{user}}'s words; kept and marked.");
    assert.equal(out.cue, "Mira's liking for toffee echoes {{user}}'s words; keep Mira's own taste unless the story gives a reason.");
});

test('mirrorWording words a dislike and falls back to a neutral name', () => {
    assert.equal(mirrorWording('Mira', '-', 'paperwork').problem, "Mira's dislike for paperwork echoes {{user}}'s words; kept and marked.");
    assert.match(mirrorWording('', '+', 'toffee').cue, /^The NPC's liking for toffee/);
});

test('tasteTail names the newest like and dislike, leaves out mirrored items, and is empty when none', () => {
    const tastes = [
        row('+', 'toffee'),
        row('-', 'paperwork'),
        row('+', 'tea'),
        row('-', 'echo of you', { mirrored: true }),
    ];
    assert.equal(tasteTail('Mira', tastes), 'Mira likes tea; dislikes paperwork.');
    assert.equal(tasteTail('Mira', [row('-', 'paperwork')]), 'Mira dislikes paperwork.');
    assert.equal(tasteTail('Mira', [row('+', 'toffee', { mirrored: true })]), '');
    assert.equal(tasteTail('Mira', []), '');
});

test('tastesText round-trips through readTastes', () => {
    const list = addTaste([], { sign: '+', item: 'toffee', from: 'barges', day: 2, r: 'x' }).tastes;
    assert.deepEqual(readTastes(tastesText(list)), list);
    assert.equal(tastesText([]), '[]');
});

test('the module does not import npc-meters.js', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../src/npc-notes-tastes.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]\.\/npc-meters\.js['"]/);
});
