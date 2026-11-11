// NPC notes, ties (src/npc-notes-ties.js): the leaf reader and caps, the `~ tie` change (+/- tags, several per pair, owes one way,
// idempotent, self and people refusals), the canonical text, the read-time fallback from a relation word, the owed-by list and the
// dossier rows for the bond list. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TIES_MAX_PEOPLE, TIES_TEXT_MAX, readTies, applyTags, tiesText, tagsFromRelation, owedBy, tiesView,
} from '../src/npc-notes-ties.js';

const tie = (ties, tags, extra = {}) => applyTags(ties, { self: 'Mira', with: 'Astra', tags, ...extra });

test('readTies: absent, malformed and over-long text read as null; an empty object is a valid record', () => {
    assert.equal(readTies(null), null);
    assert.equal(readTies(''), null);
    assert.equal(readTies('not json'), null);
    assert.equal(readTies('[]'), null);
    assert.equal(readTies('x'.repeat(TIES_TEXT_MAX + 1)), null);
    assert.deepEqual(readTies('{}'), {});
});

test('readTies: a bad tag, an unsorted or repeated tag list, or a bad key makes the whole leaf unusable', () => {
    assert.deepEqual(readTies('{"astra":["ally","owes"]}'), { astra: ['ally', 'owes'] });
    assert.equal(readTies('{"astra":["friend"]}'), null);
    assert.equal(readTies('{"astra":["owes","ally"]}'), null);
    assert.equal(readTies('{"astra":["ally","ally"]}'), null);
    assert.equal(readTies('{"astra":[]}'), null);
    assert.equal(readTies('{"Astra Vale":["ally"]}'), null);
    assert.equal(readTies('{"astra":["ally","rival","owes","ally"]}'), null);
});

test('readTies: more than the twelve people are refused', () => {
    const full = Object.fromEntries(Array.from({ length: TIES_MAX_PEOPLE }, (_, i) => [`p${i}`, ['ally']]));
    assert.ok(readTies(JSON.stringify(full)));
    assert.equal(readTies(JSON.stringify({ ...full, extra: ['rival'] })), null);
});

test('applyTags: adds several tags to a pair, and "+" and "-" per tag', () => {
    const first = tie(null, ['+ally', '+owes']);
    assert.equal(first.changed, true);
    assert.deepEqual(first.ties, { astra: ['ally', 'owes'] });
    const second = tie(first.ties, ['-ally', '+rival']);
    assert.deepEqual(second.ties, { astra: ['rival', 'owes'] });
    assert.equal(second.changed, true);
});

test('applyTags: dropping every tag of a person removes that person from the record', () => {
    const made = tie(null, ['+rival']);
    const dropped = tie(made.ties, ['-rival']);
    assert.deepEqual(dropped.ties, {});
    assert.equal(dropped.changed, true);
    assert.equal(tiesText(dropped.ties), null);
});

test('applyTags: re-applying the same change is a no-op (replay and re-read safe) and never mutates its input', () => {
    const before = { astra: ['ally'] };
    const again = tie(before, ['+ally']);
    assert.equal(again.changed, false);
    assert.deepEqual(again.ties, { astra: ['ally'] });
    const removeMissing = tie(before, ['-rival']);
    assert.equal(removeMissing.changed, false);
    const changed = tie(before, ['+owes']);
    assert.deepEqual(before, { astra: ['ally'] });
    assert.deepEqual(changed.ties, { astra: ['ally', 'owes'] });
});

test('applyTags: owes is one way, stored only on the owing side (the other record is not touched)', () => {
    const mine = tie(null, ['+owes']);
    assert.deepEqual(mine.ties, { astra: ['owes'] });
    const theirs = applyTags(null, { self: 'Astra', with: 'Mira', tags: ['+ally'] });
    assert.deepEqual(theirs.ties, { mira: ['ally'] });
    assert.deepEqual(owedBy('astra', { mira: mine.ties }), ['mira']);
});

test('applyTags: the story may tie a person to the user (key "user")', () => {
    const toUser = applyTags(null, { self: 'Astra', with: '{{user}}', tags: ['+rival'] });
    assert.deepEqual(toUser.ties, { user: ['rival'] });
    assert.equal(toUser.changed, true);
    const named = applyTags(null, { self: 'Astra', with: 'user', tags: ['+rival'] });
    assert.deepEqual(named.ties, { user: ['rival'] });
});

test('applyTags: bad tag words are ignored and listed; a self tie and a nameless tie are refused', () => {
    const odd = tie(null, ['+ally', 'ally', '*rival', '+friend']);
    assert.deepEqual(odd.ties, { astra: ['ally'] });
    assert.deepEqual(odd.ignored, ['ally', '*rival', '+friend']);
    const self = applyTags(null, { self: 'Mira', with: 'mira', tags: ['+ally'] });
    assert.equal(self.refused, 'self');
    assert.equal(self.changed, false);
    const nameless = applyTags(null, { self: 'Mira', with: '  ', tags: ['+ally'] });
    assert.equal(nameless.refused, 'name');
});

test('applyTags: a thirteenth person is refused, but an existing person can still change', () => {
    const full = Object.fromEntries(Array.from({ length: TIES_MAX_PEOPLE }, (_, i) => [`p${i}`, ['ally']]));
    const refused = tie(full, ['+rival']);
    assert.equal(refused.refused, 'people');
    assert.equal(refused.changed, false);
    const existing = applyTags(full, { self: 'Mira', with: 'p0', tags: ['+rival'] });
    assert.deepEqual(existing.ties.p0, ['ally', 'rival']);
    assert.equal(existing.refused, null);
});

test('tiesText: canonical (keys sorted, tags in order) and null when empty, so a stored record is stable', () => {
    assert.equal(tiesText({ zed: ['owes', 'ally'], astra: ['rival'] }), '{"astra":["rival"],"zed":["ally","owes"]}');
    assert.equal(tiesText({}), null);
    const text = tiesText({ zed: ['owes', 'ally'], astra: ['rival'] });
    assert.deepEqual(readTies(text), { astra: ['rival'], zed: ['ally', 'owes'] });
});

test('tagsFromRelation: the fallback reads the relation family from this side and stores nothing', () => {
    assert.deepEqual(tagsFromRelation('friend'), ['ally']);
    assert.deepEqual(tagsFromRelation('enemy'), ['rival']);
    assert.deepEqual(tagsFromRelation('rival'), ['rival']);
    assert.deepEqual(tagsFromRelation('benefactor'), ['owes']);
    assert.deepEqual(tagsFromRelation('creditor'), ['owes']);
    assert.deepEqual(tagsFromRelation('debtor'), []);
    assert.deepEqual(tagsFromRelation('mother'), []);
    assert.deepEqual(tagsFromRelation(''), []);
});

test('owedBy: lists the owners whose record owes this person, sorted, never the person themself', () => {
    const others = {
        zed: { astra: ['owes'] },
        mira: { astra: ['ally', 'owes'] },
        bren: { astra: ['rival'] },
        astra: { astra: ['owes'] },
        none: null,
    };
    assert.deepEqual(owedBy('astra', others), ['mira', 'zed']);
    assert.deepEqual(owedBy('bren', others), []);
});

test('tiesView: rows only for people in the bond list, in bond order, with owed-by lines', () => {
    const ties = { mira: ['owes', 'rival'], zed: ['ally'], ghost: ['ally'] };
    const bonds = ['Mira — mother | cold', 'Zed - friend', 'Bren — cousin', 'Mira | again'];
    const rows = tiesView(ties, bonds, ['bren']);
    assert.deepEqual(rows, [
        { key: 'mira', name: 'Mira', tags: ['rival', 'owes'], owes: true, owedBy: false },
        { key: 'zed', name: 'Zed', tags: ['ally'], owes: false, owedBy: false },
        { key: 'bren', name: 'Bren', tags: [], owes: false, owedBy: true },
    ]);
    assert.equal(rows.some(row => row.key === 'ghost'), false);
});

test('tiesView: an empty or absent record shows only the owed-by lines', () => {
    assert.deepEqual(tiesView(null, ['Mira — mother'], []), []);
    assert.deepEqual(tiesView(null, ['Mira — mother'], ['mira']), [
        { key: 'mira', name: 'Mira', tags: [], owes: false, owedBy: true },
    ]);
});
