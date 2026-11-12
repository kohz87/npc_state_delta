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

// ---- Tie types, full list, fading (core-keyrel.js; owner decisions 12 Nov) ----
import {
    mergeKeyRelationshipUpdates, tieType, readTieRows, narratorTies, recordTieMentions, TIE_FADE_DAYS,
} from '../core-keyrel.js';
import { buildInjection, mergeScanResult } from '../core.js';
import { projectDossierState } from '../dossier-ui-catalog.js';
import { tiesSectionHtml } from '../dossier-ui-sections.js';

test('tieType: the keyword table, first matching row wins (rival, owes, ally, interest), else Passing; a set tag wins', () => {
    assert.equal(tieType('rival at the annex'), 'rival');
    assert.equal(tieType('owes her a debt'), 'owes');
    assert.equal(tieType('childhood friend'), 'ally');
    assert.equal(tieType('older sister'), 'ally');
    assert.equal(tieType('ferrywoman she is curious about'), 'interest');
    assert.equal(tieType('questioned her once at the toll gate'), 'passing');
    assert.equal(tieType(''), 'passing');
    assert.equal(tieType('debtor to the guild; owed by Vane'), 'passing', 'owed-by is the other side: not Owes');
    assert.equal(tieType('stranger', ['rival']), 'rival', 'a pack or player tag wins over the words');
    assert.equal(tieType('friend', ['ally', 'owes']), 'owes');
});

const ties = (...entries) => entries;
const full = ties('A — passing acquaintance', 'B — friend', 'C — rival', 'D — curious about her', 'E — owes her', 'F — mentor', 'G — passing stranger', 'H — neighbour');

test('full list: the new tie replaces the weakest, least recently mentioned (Passing first, then Interest, then high); never dropped when there is a victim', () => {
    const seen = { a: 5, b: 9, c: 9, d: 9, e: 9, f: 9, g: 2, h: 9 };
    const out = mergeKeyRelationshipUpdates(full, ['Z — new friend'], { seen });
    assert.equal(out.length, 8);
    assert.ok(!out.some(entry => entry.startsWith('G')), 'G (Passing, oldest) went first');
    assert.ok(out.some(entry => entry.startsWith('Z')));
    const again = mergeKeyRelationshipUpdates(out, ['Y — rival at the dock'], { seen: { ...seen, z: 9 } });
    assert.ok(!again.some(entry => entry.startsWith('A')), 'next Passing tie goes');
    const noPassing = ties('B — friend', 'C — rival', 'D — curious about her', 'E — owes her', 'F — mentor', 'I — sister', 'J — brother', 'K — crush');
    const third = mergeKeyRelationshipUpdates(noPassing, ['Z — friend'], { seen: { d: 4, k: 1 } });
    assert.ok(!third.some(entry => entry.startsWith('K')), 'with no Passing left, the least recent Interest goes');
    assert.ok(!mergeKeyRelationshipUpdates(noPassing, ['Z — friend'], { seen: {}, manual: true }).some(entry => entry.startsWith('Z')), 'a hand-edited list is never touched');
    assert.ok(!mergeKeyRelationshipUpdates(full, ['Z — new friend']).some(entry => entry.startsWith('Z')), 'untracked: dropped as before');
});

const npcOf = (bonds, seen, extra = {}) => ({ id: 'n1', name: 'Rika', keyRelationships: bonds, ...(seen ? { tieSeen: seen } : {}), ...extra });
const stateOf = (rows, key) => rows.find(row => row.key === key)?.state;

test('fading: Passing 7, Interest 14, high 30 story days without a mention; died and left; a mention brings it back; untracked chats never fade', () => {
    assert.deepEqual({ ...TIE_FADE_DAYS }, { passing: 7, interest: 14, high: 30 });
    const bonds = ['Joren — carter', 'Odda — curious about her', 'Bregje — rival', 'Derk — friend; deceased', 'Mara — friend', 'Hale — friend'];
    const seen = { joren: 10, odda: 10, bregje: 10, derk: 10, mara: 10, hale: 10 };
    const others = [{ name: 'Mara', archived: true }, { name: 'Hale', lifeState: 'deceased' }];
    const at = day => readTieRows(npcOf(bonds, seen), { npcs: others, day });
    assert.equal(stateOf(at(16), 'joren'), 'active');
    assert.equal(stateOf(at(17), 'joren'), 'faded');
    assert.equal(stateOf(at(23), 'odda'), 'active');
    assert.equal(stateOf(at(24), 'odda'), 'faded');
    assert.equal(stateOf(at(39), 'bregje'), 'active');
    assert.equal(stateOf(at(40), 'bregje'), 'faded');
    assert.equal(stateOf(at(11), 'derk'), 'died');
    assert.equal(stateOf(at(11), 'hale'), 'died');
    assert.equal(stateOf(at(11), 'mara'), 'left');
    const back = recordTieMentions(npcOf(bonds, seen), { day: 40, text: 'Joren waved from the cart.' });
    assert.equal(stateOf(readTieRows(npcOf(bonds, back), { npcs: others, day: 40 }), 'joren'), 'active', 'a mention brings it back');
    assert.equal(stateOf(readTieRows(npcOf(bonds), { npcs: others, day: 400 }), 'joren'), 'active', 'untracked: today\'s behaviour');
    assert.deepEqual(readTieRows(npcOf(bonds, seen), { npcs: others, day: 11 }).map(row => row.rank), [0, 0, 0, 0, 1, 2], 'priority order: high, Interest, Passing');
});

test('recordTieMentions: reply prose or an added tie marks the day; first mention starts the record; same reply twice is the same (replay)', () => {
    const npc = npcOf(['Joren — carter', 'Odda — ferrywoman']);
    assert.equal(recordTieMentions(npc, { day: 5, text: 'Nothing here.' }), undefined, 'no mention: no record yet');
    const one = recordTieMentions(npc, { day: 5, text: 'Joren hauled crates.' });
    assert.deepEqual(one, { joren: 5 });
    assert.deepEqual(recordTieMentions({ ...npc, tieSeen: one }, { day: 5, text: 'Joren hauled crates.' }), one);
    assert.deepEqual(recordTieMentions({ ...npc, tieSeen: one }, { day: 9, named: ['Odda — ferrywoman'] }), { joren: 5, odda: 9 });
    assert.equal(recordTieMentions(npc, { day: null, text: 'Joren' }), undefined, 'no story clock: nothing recorded');
});

test('mergeScanResult: live == replay, the day of the reply is recorded with the NPC', () => {
    const base = { turn: 1, npcs: [{ ...npcOf(['Joren — carter']), id: 'npc_rika', present: true }], candidates: [] };
    const scan = { npcs: [{ name: 'Rika', present: true }] };
    const run = () => mergeScanResult(structuredClone(base), scan, { turn: 2, storyDay: 12, calendarSource: 'Joren grumbled at Rika.' }).state.npcs[0].tieSeen;
    assert.deepEqual(run(), { joren: 12 });
    assert.deepEqual(run(), run());
});

test('narrator: faded, left and dead ties are not sent (a dead one only when the scene names them); high types come first', () => {
    const rika = { ...npcOf(['Joren — carter', 'Derk — friend; deceased', 'Bregje — rival', 'Odda — curious about her'], { joren: 1, derk: 1, bregje: 20, odda: 20 }), present: true };
    const rows = narratorTies(rika, { npcs: [], day: 22, scene: 'Rika walks on.' });
    assert.deepEqual(rows.map(row => row.name), ['Bregje', 'Odda']);
    assert.deepEqual(narratorTies(rika, { npcs: [], day: 22, scene: 'They talk about Derk.' }).map(row => row.name), ['Bregje', 'Derk', 'Odda']);
    const text = buildInjection([rika], 'Rika walks on.', 2, 3, undefined, undefined, null, { storyDay: 22 });
    assert.match(text, /Bregje/);
    assert.doesNotMatch(text, /Joren|Derk/);
    const old = buildInjection([{ ...rika, tieSeen: undefined }], 'Rika walks on.', 2, 3);
    assert.match(old, /Joren/, 'an untracked chat is injected as before');
});

test('dossier Ties section: type headings in priority order, every entry its divider, faded and dead ones in Older ties', () => {
    const rika = { ...npcOf(['Joren — carter who hauled crates', 'Derk — friend; deceased', 'Bregje — rival | clashes at the annex', 'Odda — curious about her'], { joren: 1, derk: 1, bregje: 20, odda: 20 }), present: true };
    const shown = projectDossierState({ npcs: [rika], storyDay: 22 }, { chatKey: 'c1' }).npcs[0];
    const html = tiesSectionHtml(shown);
    assert.ok(html.indexOf('data-tie-type="rival"') < html.indexOf('data-tie-type="interest"'), 'high types first');
    assert.match(html, /<details class="delta-older-ties"><summary>Older ties · 2<\/summary>/);
    assert.match(html, /† died/);
    assert.match(html, /not mentioned for 21 days/);
    assert.ok(html.indexOf('delta-older-ties') > html.indexOf('Bregje'), 'Older ties last');
    assert.doesNotMatch(tiesSectionHtml({ ...shown, tieRows: undefined, tieSeen: undefined, keyRelationships: ['Joren — carter'] }), /Older ties/);
});

// ---- Fix round 2 (review probes): stray digit, hosted story day, cap 8 live, whole-name mentions, one roster map ----
import { setStoryDayAtSource } from '../core.js';
import { tieDayAt, useTranscriptSource } from '../src/transcript.js';
import { tieRoster } from '../core-keyrel.js';

test('Ties section: a tie with no dynamic shows no stray digit, and a relation equal to its type shows no description', () => {
    const html = tiesSectionHtml({ keyRelationships: ['Hale — mentor', 'Bregje — rival', 'Ann — stranger | met once'] });
    assert.match(html, /<p>mentor<\/p>/);
    assert.doesNotMatch(html, /<p>[^<]*\b[01]\b[^<]*<\/p>/);
    assert.doesNotMatch(html.slice(html.indexOf('Bregje')), /^[^]*?<p>1<\/p>/);
    assert.match(html, /<p>stranger — met once<\/p>/);
});

test('story day of ties: the hosted clock at the reply when there is one (the reply\'s own day, not now), else the dated text', () => {
    useTranscriptSource({ context: () => ({ chat: [{ mes: 'one' }, { mes: 'two' }, { mes: 'three' }] }) });
    try {
        assert.equal(tieDayAt(1), null, 'no clock and no dated block: no day');
        setStoryDayAtSource(index => 100 + index);
        assert.equal(tieDayAt(1), 101);
        assert.equal(tieDayAt(0), 100, 'a Re-read of an older reply gets that reply\'s day');
        assert.equal(tieDayAt(), 102, 'now: the last message');
        setStoryDayAtSource(() => { throw new Error('host gone'); });
        assert.equal(tieDayAt(1), null);
    } finally { setStoryDayAtSource(null); }
});

test('mergeScanResult records the hosted day (tieDay) and reads it back the same on replay; a plain storyDay still works', () => {
    const base = { turn: 1, npcs: [{ ...npcOf(['Joren — carter']), id: 'npc_rika', present: true }], candidates: [] };
    const scan = { npcs: [{ name: 'Rika', present: true }] };
    const run = opts => mergeScanResult(structuredClone(base), scan, { turn: 2, calendarSource: 'Joren grumbled at Rika.', ...opts }).state.npcs[0].tieSeen;
    assert.deepEqual(run({ tieDay: 4000 }), { joren: 4000 });
    assert.deepEqual(run({ tieDay: 4000, storyDay: 12 }), { joren: 4000 }, 'the hosted day wins');
    assert.deepEqual(run({ storyDay: 12 }), { joren: 12 });
});

const EIGHT = ['Joren — carter', 'Odda — ferrywoman', 'Bregje — rival | clashes', 'Derk — friend', 'Hale — mentor', 'Mara — sister', 'Pim — neighbour', 'Lise — client'];
const SEEN8 = { joren: 1, odda: 2, bregje: 3, derk: 4, hale: 5, mara: 6, pim: 7, lise: 8 };
const rikaWith = (bonds, seen) => ({ id: 'npc_rika', name: 'Rika', present: true, keyRelationships: bonds, tieSeen: seen });
const mergeTie = (bonds, seen, scanNpc, withRecords = false) => {
    const others = withRecords ? ['Joren', 'Odda', 'Bregje', 'Derk', 'Hale', 'Mara', 'Pim', 'Lise', 'Tobin'].map(n => ({ id: `npc_${n.toLowerCase()}`, name: n, present: false })) : [];
    const base = { turn: 1, npcs: [rikaWith(bonds, seen), ...others], candidates: [] };
    return mergeScanResult(base, { npcs: [{ name: 'Rika', present: true, ...scanNpc }] }, { turn: 2, tieDay: 12, calendarSource: 'Rika read the letter from Tobin.' }).state.npcs.find(n => n.id === 'npc_rika');
};
const TOBIN = { keyRelationships: ['Tobin — courier | brings letters'], keyRelationshipsState: 'update' };

test('cap 8 live (through mergeScanResult): eight ties stay eight; five plus a new one make six', () => {
    for (const records of [false, true]) {
        assert.equal(mergeTie(EIGHT, SEEN8, {}, records).keyRelationships.length, 8, `eight kept (records ${records})`);
        const five = mergeTie(EIGHT.slice(0, 5), SEEN8, TOBIN, records);
        assert.equal(five.keyRelationships.length, 6, 'the new tie is not dropped');
        assert.ok(five.keyRelationships.some(e => /^Tobin/.test(e)));
        assert.equal(five.tieSeen.tobin, 12);
    }
});

test('cap 8 live: a full list takes the new tie in and drops the weakest, least recently mentioned; the Ally survives', () => {
    for (const records of [false, true]) {
        const out = mergeTie(EIGHT, SEEN8, TOBIN, records);
        assert.equal(out.keyRelationships.length, 8, `still eight (records ${records})`);
        assert.ok(out.keyRelationships.some(e => /^Tobin/.test(e)), 'new tie in');
        assert.ok(!out.keyRelationships.some(e => /^Joren/.test(e)), 'the oldest Passing tie out');
        assert.ok(out.keyRelationships.some(e => /^Mara/.test(e)), 'the Ally is kept');
        assert.ok(out.keyRelationships.some(e => /^Odda/.test(e)), 'only one is replaced');
    }
});

test('a chat that records no mentions keeps its list at five, as before', () => {
    const out = mergeScanResult({ turn: 1, npcs: [{ id: 'npc_rika', name: 'Rika', present: true, keyRelationships: EIGHT }], candidates: [] }, { npcs: [{ name: 'Rika', present: true }] }, { turn: 2 }).state.npcs[0];
    assert.equal(out.keyRelationships.length, 5);
});

test('mentions: the whole name or a known alias; no first word, no title ("the harbour captain" is not Captain Vane)', () => {
    const npc = npcOf(['Grey Ledger Inspector — questioned her once', 'Captain Vane — owes a debt', 'Sister Temiwa — friend', 'Odda — ferrywoman'], { 'grey ledger inspector': 1, 'captain vane': 1, 'sister temiwa': 1, odda: 1 });
    const text = 'Mist lay low in the grey half-light; the harbour captain waved; her sister wrote.';
    assert.deepEqual(recordTieMentions(npc, { day: 30, text }), npc.tieSeen, 'nothing marked');
    assert.equal(recordTieMentions(npc, { day: 30, text: 'Captain Vane nodded.' })['captain vane'], 30);
    const roster = tieRoster([{ id: 'v', name: 'Captain Vane', aliases: ['the Skipper'] }, { id: 'o', name: 'Odda', aliases: [] }]);
    assert.equal(recordTieMentions(npc, { day: 31, text: 'The Skipper waved.', roster })['captain vane'], 31, 'a known alias counts');
    assert.equal(recordTieMentions(npc, { day: 31, text: 'The Skipper waved.' })['captain vane'], 1, 'an alias is not known without the roster');
    assert.equal(recordTieMentions(npc, { day: 31, text: 'Oddarin spoke.', roster }).odda, 1, 'a longer word is not the name');
});

test('one roster map per projection: readTieRows reads the map it is given, and tieRoster keys names and aliases once', () => {
    const roster = tieRoster([{ id: 'd', name: 'Derk', aliases: ['Old D'], lifeState: 'deceased' }]);
    assert.equal(roster.get('derk'), roster.get('old d'));
    assert.deepEqual(roster.labels.get(roster.get('derk')), ['derk', 'old d']);
    const rows = readTieRows(npcOf(['Old D — friend'], { 'old d': 1 }), { roster, day: 2 });
    assert.equal(rows[0].state, 'died', 'the other person is read from the given map');
    const names = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, name: `Person ${i}`, keyRelationships: ['Person 1 — friend'] }));
    const shown = projectDossierState({ npcs: names, storyDay: 3 }, { chatKey: 'c1' }).npcs;
    assert.equal(shown.length, 50);
});
