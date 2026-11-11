import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHost } from './vendor/story-block/testkit/index.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { dossierUiSource } from './helpers/dossier-ui-source.js';
import { buildInjection, createNpcRecord } from '../core.js';
import { normalizeNpcRecord } from '../core-mechanics.js';
import { mergeScanResult, normalizeNpcRecord as normalizeProduction } from '../core.js';
import { currentPresentationText, normalizeAppearanceModel, resolveNpcAppearance } from '../appearance.js';
import { castFromHtml, castProjection, projectDossierState } from '../dossier-ui.js';
import { FEATURE_STAGES, normalizeSecrets, observeCast, validateNpcSlice } from '../src/npc-meters.js';
import {
    applyCastEntry, applyCastPortrait, castBadge, castPortraitWanted, castSecrets, castView, dossierFor, findCastPerson, markCastPortraitRemoved, metWithEntry, normalizeCast, normalizeEntry, parsePeople, shortPackName,
} from '../src/cast-dossier.js';
import { preserveUserNpcMetadata } from '../branch-core.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { runHostScenario } from './helpers/host-scenario.js';
import { adapterSource } from './helpers/adapter-source.js';

// The living cast (the user's decision, 1 Nov): Story Director owns who has been met (`director.cast`, read only); at the first
// meeting Delta makes the dossier at once from the pack entry: profile, portrait, starting numbers, stages, fields and hidden
// notes, with the "Ersveil cast" badge and the "From the Ersveil cast" block. The meeting is recorded in the saved `npc` slice
// at that reply (replay-safe); a swipe takes the dossier back with the reply. Without a Story Director nothing changes.

const DAY = 1440;
const FENNA_ENTRY = {
    id: 'fenna', name: 'Fenna', aliases: ['the ferrywoman'],
    about: 'Runs the night ferry at Bluewatch docks.',
    look: 'Tall and weathered, rope-scarred hands, a grey oilskin coat.',
    voice: 'Dry and unhurried; says "aye" for yes.',
    personality: 'Stubborn, watchful, quietly kind.',
    history: 'Lost her husband to the weir in 598; has run the night ferry alone since.',
    portrait: 'fenna.webp',
    start: { place: 'Bluewatch docks', goal: 'Find out who opened the weir', routine: 'evenings at the ferry' },
    drawnTo: ['whoever fought at the weir'],
    meters: { preset: 'companion', trust: 10, loyalty: 30, nonsense: 5 },
    stages: [{ name: 'Wary', needs: 'trust 5' }, { name: 'Ally', needs: 'trust 40, loyalty 50' }],
    fields: { Allegiance: 'Ferry guild' },
    secrets: [
        { title: "Her husband's debt", text: 'He owed the smugglers; she still pays it off.', meter: 'trust', at: 60 },
        { title: 'The weir', text: 'She saw who opened the gates.', when: 'the party learns of the toll-gang' },
    ],
};
const person = (extra = {}) => ({
    key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: ['the ferrywoman'],
    met: { on: 11 * DAY, where: 'Bluewatch docks' }, where: 'upriver', doing: 'on the ferry to Ashford',
    lastHeard: { text: 'took the ferry upriver to Ashford', on: 14 * DAY }, alive: true, entry: structuredClone(FENNA_ENTRY), ...extra,
});
const unmet = () => person({ met: null, entry: undefined, lastHeard: undefined });
const calendar = { era: 'CY', months: [{ name: 'Goldwane', days: 30 }], leapYears: false };
const dateText = minutes => `Gw ${Math.floor(minutes / DAY) + 1}`;

// ---- Story Director's answer, cleaned ----

test('the answer is cleaned; an unmet person never carries an entry, a met one does; dates are written on the calendar', () => {
    const list = normalizeCast([person(), { ...unmet(), key: 'ersveil:sera', id: 'sera', name: 'Sera', entry: structuredClone(FENNA_ENTRY) }, { name: 'no key' }, 'junk', null], dateText);
    assert.deepEqual(list.map(item => item.key), ['ersveil:fenna', 'ersveil:sera'], 'unusable rows and duplicates are left out');
    const [fenna, sera] = list;
    assert.equal(fenna.met.on, 'Gw 12');
    assert.equal(fenna.met.where, 'Bluewatch docks');
    assert.deepEqual(fenna.lastHeard, { text: 'took the ferry upriver to Ashford', on: 'Gw 15' });
    assert.equal(fenna.entry.start.goal, 'Find out who opened the weir');
    assert.equal(sera.entry, null, 'an entry that came with an unmet person is dropped');
    assert.equal(sera.lastHeard, null);
    assert.deepEqual(metWithEntry(list).map(item => item.key), ['ersveil:fenna']);
    assert.equal(findCastPerson(list, 'ersveil:sera').name, 'Sera');
    assert.deepEqual(normalizeCast('nope'), [], 'no array, no cast');
    assert.equal(normalizeCast([person()])[0].met.on, '', 'without a calendar a story minute has no text');
    assert.equal(normalizeCast([person({ met: { on: 'Gw 3', where: 'x' } })])[0].met.on, 'Gw 3', 'words are kept as given');
});

test('the entry is bounded plain text: lists and texts cut, the pack\'s hidden notes keep a meter rule or a story event', () => {
    const long = 'word '.repeat(700);
    const entry = normalizeEntry({ ...FENNA_ENTRY, look: long, aliases: Array.from({ length: 20 }, (_, i) => `alias ${i}`), fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`F${i}`, `v${i}`])) });
    assert.ok(entry.look.length <= 1800 && entry.aliases.length === 8 && Object.keys(entry.fields).length === 12);
    assert.equal(normalizeEntry({ about: 'no name' }), null);
    assert.deepEqual(entry.stages.map(stage => stage.name), ['Wary', 'Ally']);
    assert.deepEqual(normalizeEntry({ ...FENNA_ENTRY, stages: [{ meter: 'trust', at: 30, name: 'Friend' }] }).stages, [{ name: 'Friend', needs: [{ meter: 'trust', at: 30 }] }], 'a threshold row reads as a need');
    const secrets = castSecrets(FENNA_ENTRY.secrets.concat([{ title: 'no rule', text: 'dropped' }, { title: 'no text', meter: 'trust', at: 5 }]));
    assert.equal(secrets.length, 2);
    assert.deepEqual(secrets[0], { title: "Her husband's debt", text: 'He owed the smugglers; she still pays it off.', meter: 'trust', at: 60, from: 'pack' }, 'a pack\'s note says it came from the pack (the dossier editor keeps it hidden while locked)');
    assert.deepEqual([secrets[1].title, secrets[1].when, secrets[1].meter], ['The weir', 'the party learns of the toll-gang', undefined]);
    assert.deepEqual(normalizeSecrets(secrets).map(note => [note.id.startsWith('sec_'), note.when ?? null]), [[true, null], [true, 'the party learns of the toll-gang']], 'the hidden-notes code reads them (ids, story-event rule)');
    assert.equal(castSecrets(Array.from({ length: 12 }, (_, i) => ({ text: `n${i}`, meter: 'trust', at: i }))).length, 8, 'at most eight');
});

// ---- the dossier ----

test('a pack secret with both rules (trust 90 or a story event) goes through the answer, castSecrets and the made dossier with both', () => {
    const either = { title: 'Either way', text: 'She forged the seal.', meter: 'trust', at: 90, when: 'the party asks about the seal' };
    const entry = { ...FENNA_ENTRY, secrets: [either] };
    const [p] = normalizeCast([person({ entry })], dateText);
    assert.deepEqual(p.entry.secrets, [{ ...either, from: 'pack' }], 'the answer keeps the note whole, marked as the pack\'s');
    assert.deepEqual(castSecrets(entry.secrets), [{ ...either, from: 'pack' }]);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.deepEqual(made.secrets.map(note => [note.meter, note.at, note.when, note.from]), [['trust', 90, 'the party asks about the seal', 'pack']]);
    assert.deepEqual(normalizeSecrets(made.secrets).map(note => [note.meter, note.at, note.when]), [['trust', 90, 'the party asks about the seal']]);
});

test('the dossier is made from the entry: profile, numbers, fields, notes, portrait, the way back to the pack', () => {
    const [p] = normalizeCast([person()], dateText);
    const portrait = { dataUrl: 'data:image/webp;base64,AAAA', mime: 'image/webp', sourceName: 'fenna.webp', updatedAt: 1 };
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil', portrait }));
    assert.equal(made.role, 'Runs the night ferry at Bluewatch docks.');
    // Changed with the wears rule: the pack's look is the physical appearance (this entry has no `wears`: the current slot stays empty).
    assert.equal(made.overallAppearance, FENNA_ENTRY.look);
    assert.equal(made.appearance, '');
    assert.equal(made.speech, FENNA_ENTRY.voice);
    assert.equal(made.personality, FENNA_ENTRY.personality);
    assert.equal(made.background, FENNA_ENTRY.history);
    assert.equal(made.homeBase, 'Bluewatch docks');
    assert.equal(made.goal, 'Find out who opened the weir');
    assert.equal(made.location, 'Bluewatch docks', 'where they were met');
    assert.deepEqual(made.aliases, ['the ferrywoman']);
    assert.deepEqual(made.customFields, { Allegiance: 'Ferry guild' });
    assert.equal(made.relationship.trust, 10, 'the built-in numbers start where the pack put them');
    assert.deepEqual(made.meterSetup, { track: 'companion', limits: {} });
    assert.equal(made.secrets.length, 2, 'the hidden notes are handed over');
    assert.equal(made.portrait.dataUrl, portrait.dataUrl);
    assert.deepEqual(made.castFrom, {
        key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', packName: 'Ersveil', met: { on: 'Gw 12', where: 'Bluewatch docks' },
        goal: 'Find out who opened the weir', routine: 'evenings at the ferry', stages: FENNA_ENTRY.stages.map(({ name, needs }) => ({ name, needs })),
        first: { overallAppearance: FENNA_ENTRY.look, speech: FENNA_ENTRY.voice, personality: FENNA_ENTRY.personality, background: FENNA_ENTRY.history },
    });
    // The narrator hears the pack's words like any dossier's.
    const injection = buildInjection([{ ...made, present: true }], 'Fenna is here.', 1);
    assert.match(injection, /oilskin coat/);
    assert.match(injection, /says "aye"/);
    assert.equal(applyCastEntry(createNpcRecord('Fenna', []), { ...p, entry: null }), null, 'without an entry (an unmet person) there is nothing to make');
});

test('the badge says the pack\'s short name: a bracketed note or a subtitle is left off', () => {
    assert.equal(shortPackName('Ersveil (open world)'), 'Ersveil');
    assert.equal(shortPackName('Moonveil — the long night'), 'Moonveil');
    assert.equal(shortPackName('Lean: a small RPG'), 'Lean');
    assert.equal(shortPackName('  Ersveil '), 'Ersveil');
    assert.equal(shortPackName(''), '');
    const [p] = normalizeCast([person()], dateText);
    assert.equal(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil (open world)' }).castFrom.packName, 'Ersveil');
    assert.equal(castBadge(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: '(x)' }).castFrom), 'Cast', 'nothing left of the name: just Cast');
});

test('the pack\'s words stay exactly as written until the field is changed; then it is compacted like any other', () => {
    const [p] = normalizeCast([person({ entry: { ...FENNA_ENTRY, voice: 'Dry and slow. Never raises her voice; goes quieter when angry. Calls everyone love or sailor. Asks about food first. Hums when worried. Says aye.' } })], dateText);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.equal(made.speech, p.entry.voice, 'the whole voice, nothing dropped');
    assert.equal(normalizeNpcRecord(structuredClone(made)).speech, p.entry.voice, 'and again on the next load');
    const changed = normalizeNpcRecord({ ...made, speech: `${p.entry.voice} Whistles at the weir.` });
    assert.notEqual(changed.speech, `${p.entry.voice} Whistles at the weir.`, 'a changed field is compacted as for anyone');
});

// ---- `wears`: the body in look, the outfit in wears (5 Nov, the user's decision, option 1) ----

const TEMIWA_ENTRY = {
    id: 'temiwa', name: 'Temiwa', about: 'A fox-woman courier.',
    look: 'Slender fox-woman, amber eyes, russet fur, a white-tipped tail.',
    wears: 'Veil of grey gauze, a grey sash binding the tail, flame-cross pendants.',
    start: { place: 'The north gate', goal: 'Deliver the letter' },
};
const temiwaPerson = (entry = TEMIWA_ENTRY) => normalizeCast([{
    key: 'ersveil:temiwa', pack: 'ersveil', id: 'temiwa', name: 'Temiwa', met: { on: 0, where: 'The north gate' }, alive: true, entry,
}], dateText)[0];
const madeTemiwa = entry => normalizeProduction(applyCastEntry(createNpcRecord('Temiwa', []), temiwaPerson(entry), { packName: 'Ersveil' }));
const TEMIWA_SCENE = 'Temiwa stood slender, amber eyes bright, russet fur damp, white-tipped tail showing: the veil pinned back and the tail in a grey linen wrap.';
const temiwaScan = npc => mergeScanResult({ npcs: [npc], turn: 2 }, { profileUpdates: [{
    id: npc.id, evidence: { appearance: [TEMIWA_SCENE] },
    overallAppearance: 'Slender fox-woman, amber eyes, russet fur, white-tipped tail',
    appearance: 'Veil pinned back, tail in a grey linen wrap', appearanceState: 'change',
    appearanceReason: 'The veil is pinned back and the tail is in a grey linen wrap.',
}] }, { turn: 3, sourceMessageId: 9, developmentContext: TEMIWA_SCENE }).state.npcs[0];
const BODY = /fox-woman|amber eyes|russet fur|white-tipped tail/i;
const OUTFIT = /veil|sash|pendant|linen|gauze/i;

test('wears is read like look: cut to 1800 characters and flattened; absent it is empty', () => {
    const entry = normalizeEntry({ ...TEMIWA_ENTRY, wears: `a\n\n${'word '.repeat(700)}` });
    assert.ok(entry.wears.length <= 1800 && !/\n/.test(entry.wears));
    assert.equal(normalizeEntry({ ...TEMIWA_ENTRY, wears: undefined }).wears, '');
    assert.equal(normalizeEntry({ ...TEMIWA_ENTRY, wears: 42 }).wears, '42', 'any value is read as text like look');
    assert.equal(temiwaPerson().entry.wears, TEMIWA_ENTRY.wears, 'it comes through the answer for a met person');
});

test('a cast entry with wears: look is the physical appearance, wears the current one, each in the pack\'s exact words', () => {
    const made = madeTemiwa();
    assert.equal(made.overallAppearance, TEMIWA_ENTRY.look, 'look → physical');
    assert.equal(currentPresentationText(made), TEMIWA_ENTRY.wears, 'wears → current appearance');
    assert.doesNotMatch(made.overallAppearance, OUTFIT, 'no clothing in the physical text');
    assert.doesNotMatch(currentPresentationText(made), BODY, 'no body in the current text');
    assert.equal(made.currentForm, '');
    assert.deepEqual(made.appearanceForms, []);
    assert.deepEqual(made.castFrom.first, { overallAppearance: TEMIWA_ENTRY.look, appearance: TEMIWA_ENTRY.wears }, 'the pack\'s words per field');
    const raw = applyCastEntry(createNpcRecord('Temiwa', []), temiwaPerson(), { packName: 'Ersveil' });
    assert.equal(raw.overallAppearance, TEMIWA_ENTRY.look);
    assert.equal(raw.appearance, TEMIWA_ENTRY.wears, 'the record before normalization: current = wears alone');
    // What the narrator hears: the body and the outfit, each once.
    const shown = resolveNpcAppearance(made);
    assert.equal(shown.split('white-tipped tail').length - 1, 1, 'the body words once, not restated by the outfit');
    assert.match(buildInjection([{ ...made, present: true }], 'Temiwa is here.', 1), /flame-cross pendants/);
    // Idempotent: normalizing again changes nothing.
    const again = normalizeProduction(structuredClone(made));
    assert.deepEqual([again.overallAppearance, again.appearance, currentPresentationText(again)], [made.overallAppearance, made.appearance, currentPresentationText(made)]);
});

test('an older entry without wears: look is the physical appearance whole, the current appearance is left empty for the scanner', () => {
    const made = madeTemiwa({ ...TEMIWA_ENTRY, wears: undefined });
    assert.equal(made.overallAppearance, TEMIWA_ENTRY.look);
    assert.equal(currentPresentationText(made), '', 'nothing in the current slot');
    assert.equal(normalizeAppearanceModel(made).appearance, made.appearance);
    assert.equal(resolveNpcAppearance(made), TEMIWA_ENTRY.look, 'the narrator still hears the pack\'s look');
    assert.deepEqual(made.castFrom.first, { overallAppearance: TEMIWA_ENTRY.look }, 'no pack words are recorded for the current appearance');
    assert.ok(!applyCastEntry(createNpcRecord('Temiwa', []), temiwaPerson({ ...TEMIWA_ENTRY, wears: undefined }), {}).appearance, 'the raw record leaves appearance empty');
    // An entry with neither sets neither.
    const bare = applyCastEntry(createNpcRecord('Temiwa', []), temiwaPerson({ ...TEMIWA_ENTRY, look: '', wears: '' }), {});
    assert.ok(!bare.overallAppearance && !bare.appearance);
    assert.deepEqual(bare.castFrom.first, {});
    // Only wears (no look): the outfit is the current appearance and the physical slot is left for the scanner.
    const onlyWears = madeTemiwa({ ...TEMIWA_ENTRY, look: '' });
    assert.equal(onlyWears.overallAppearance, '');
    assert.equal(onlyWears.appearance, TEMIWA_ENTRY.wears);
});

test('the pack\'s words per field are kept while unchanged and follow the new keys (normalizeNpcRecord)', () => {
    const long = `Veil of grey gauze. ${Array.from({ length: 30 }, (_, i) => `Pendant number ${i} of carved bone on a thin cord`).join('. ')}.`;
    assert.ok(long.length > 1000);
    const made = madeTemiwa({ ...TEMIWA_ENTRY, wears: long });
    // The mechanics layer (before the appearance model resolves) keeps the pack's exact words for a field that still is them…
    const kept = normalizeNpcRecord({ ...createNpcRecord('Temiwa', []), appearance: long, castFrom: { key: 'k', first: { appearance: long } } });
    assert.equal(kept.appearance, long);
    // …and compacts a field that no longer is, or one with no pack words recorded under that key.
    const changed = normalizeNpcRecord({ ...createNpcRecord('Temiwa', []), appearance: `${long} Also a bell.`, castFrom: { key: 'k', first: { appearance: long } } });
    assert.notEqual(changed.appearance, `${long} Also a bell.`);
    const oldKey = normalizeNpcRecord({ ...createNpcRecord('Temiwa', []), appearance: long, castFrom: { key: 'k', first: { overallAppearance: long } } });
    assert.notEqual(oldKey.appearance, long, 'a pack word kept under overallAppearance does not hold current appearance');
});

test('the user\'s case: a scanner result on a dossier made from the entry keeps the body out of the outfit and the outfit out of the body, the tail once', () => {
    const made = madeTemiwa();
    const scanned = temiwaScan(made);
    assert.equal(scanned.overallAppearance, TEMIWA_ENTRY.look, 'the scene\'s physical words equal the pack\'s: unchanged');
    assert.doesNotMatch(scanned.overallAppearance, OUTFIT, 'physical has no clothing');
    const current = currentPresentationText(scanned);
    assert.equal(current, 'Veil pinned back, tail in a grey linen wrap', 'current has the outfit');
    assert.doesNotMatch(current, BODY);
    assert.equal(resolveNpcAppearance(scanned).match(/tail/gi).length, 2, 'one tail in the body words, one in the outfit: not the same tail described in two ways');
    assert.doesNotMatch(scanned.appearance, /sash|pendants/, 'the old outfit is replaced, not stacked');
    assert.ok(!/;\s*\d+\.\s*;/.test(scanned.appearance) && !/\b21\b/.test(scanned.appearance));
    assert.equal(scanned.appearanceForms.length, 0, 'no form was invented');
    assert.equal(scanned.unclassifiedAppearance, '');
    assert.equal(scanned.castFrom.first.appearance, TEMIWA_ENTRY.wears, 'the pack\'s words stay recorded as given');
    assert.equal(scanned.castFrom.first.overallAppearance, TEMIWA_ENTRY.look);
    // …and the same on the next normalization.
    const again = normalizeProduction(structuredClone(scanned));
    assert.deepEqual([again.overallAppearance, currentPresentationText(again)], [scanned.overallAppearance, current]);
});

test('the user\'s case on an older entry (no wears): the scanner fills the current appearance, the physical text stays the pack\'s look', () => {
    const made = madeTemiwa({ ...TEMIWA_ENTRY, wears: undefined });
    const scanned = temiwaScan(made);
    assert.equal(scanned.overallAppearance, TEMIWA_ENTRY.look);
    assert.doesNotMatch(scanned.overallAppearance, OUTFIT);
    assert.equal(currentPresentationText(scanned), 'Veil pinned back, tail in a grey linen wrap');
    assert.equal(scanned.appearance.match(/white-tipped tail/gi).length, 1, 'the body words once');
});

// Round 2 (review B1/F2): the pack's words stay whole while unchanged, whatever their size within the pack's limits.
// The model shows the current part with its sentences joined by "; " (existing, F1): compare the words.
const sameWords = text => String(text).replace(/\.;\s/g, '. ');
// Whole sentences, each different, joined up to `max` characters.
const sentences = (label, max) => {
    const out = [];
    for (let i = 1; ; i += 1) {
        const next = [...out, `${label} ${i} of oiled leather with brass buckles and a stitched hem`].join('. ');
        if (next.length + 1 > max) break;
        out.push(`${label} ${i} of oiled leather with brass buckles and a stitched hem`);
    }
    return `${out.join('. ')}.`;
};
const LONG_LOOK = sentences('Body trait', 600);
const LONG_WEARS = sentences('Outfit piece', 300);

test('B1: a long look (600) and a long wears (300) are kept whole at creation and after every normalization; all outfit sentences stay', () => {
    assert.ok(LONG_LOOK.length > 500 && LONG_WEARS.length > 250 && LONG_LOOK.length <= 600 && LONG_WEARS.length <= 300 && (LONG_LOOK.match(/\./g) || []).length > 6 && (LONG_WEARS.match(/\./g) || []).length >= 4, 'a fixture beyond the old canon (10 sentences, 800 characters in all)');
    const entry = { ...TEMIWA_ENTRY, look: LONG_LOOK, wears: LONG_WEARS };
    const made = madeTemiwa(entry);
    assert.ok(`${LONG_LOOK}; ${LONG_WEARS}`.length > 800, 'together over the old 800');
    assert.equal(made.overallAppearance, LONG_LOOK);
    assert.equal(sameWords(currentPresentationText(made)), LONG_WEARS, 'every outfit sentence, whole');
    assert.equal(made.appearance, `${LONG_LOOK.replace(/[\s.;,]+$/, '')}; ${LONG_WEARS}`, 'the resolved text is body then outfit, unclipped');
    let again = made;
    for (let i = 0; i < 3; i += 1) again = normalizeProduction(structuredClone(again));
    assert.deepEqual([again.overallAppearance, again.appearance], [made.overallAppearance, made.appearance], 'normalized again and again: identical');
    assert.equal(sameWords(currentPresentationText(again)), LONG_WEARS);
    // The mechanics layer alone (a save/load of the stored record) keeps it too.
    const stored = normalizeNpcRecord(structuredClone(made));
    assert.equal(stored.appearance, made.appearance);
    assert.match(resolveNpcAppearance(again), /Outfit piece 4/);
});

test('F2: a look beyond 800 characters is kept whole (physical and resolved), with or without wears', () => {
    const look = sentences('Body trait', 1500);
    assert.ok(look.length > 1000);
    const noWears = madeTemiwa({ ...TEMIWA_ENTRY, look, wears: undefined });
    assert.equal(noWears.overallAppearance, look);
    assert.equal(noWears.appearance, look, 'the narrator and portrait get the whole look');
    assert.equal(normalizeProduction(structuredClone(noWears)).appearance, look, 'and after the next load');
    const withWears = madeTemiwa({ ...TEMIWA_ENTRY, look, wears: LONG_WEARS });
    assert.equal(withWears.overallAppearance, look);
    assert.equal(sameWords(currentPresentationText(normalizeProduction(structuredClone(withWears)))), LONG_WEARS);
});

test('B1: after a scanner changes the outfit the normal canon applies to the outfit alone; the pack\'s physical words stay in front', () => {
    const made = madeTemiwa({ ...TEMIWA_ENTRY, look: LONG_LOOK, wears: LONG_WEARS });
    const longOutfit = sentences('New garment', 1200);
    const edited = normalizeProduction({ ...made, appearance: `${LONG_LOOK.replace(/[\s.;,]+$/, '')}; ${longOutfit}` });
    assert.equal(edited.overallAppearance, LONG_LOOK, 'the physical words untouched');
    const part = currentPresentationText(edited);
    assert.ok((part.match(/\./g) || []).length <= 10 && part.length <= 800, 'the outfit is compacted by the usual canon (10 sentences, 800 characters)');
    assert.ok(part.startsWith('New garment 1'), 'and starts as given');
    assert.deepEqual(normalizeProduction(structuredClone(edited)).appearance, edited.appearance, 'and is stable');
    // A scanner-style change in the Temiwa case (short entry): as before.
    const scanned = temiwaScan(madeTemiwa());
    assert.equal(currentPresentationText(scanned), 'Veil pinned back, tail in a grey linen wrap');
    // Body changed by a scan, outfit still the pack's: the outfit stays whole.
    const bodyChanged = normalizeProduction({ ...made, overallAppearance: 'Slender fox-woman with a notched ear.', appearance: `Slender fox-woman with a notched ear; ${LONG_WEARS}` });
    assert.equal(sameWords(currentPresentationText(bodyChanged)), LONG_WEARS);
});

test('a dossier made before this change is read as stored: no migration', () => {
    // The old shape: look in appearance, castFrom.first.appearance = look, no overallAppearance.
    const old = normalizeProduction({
        ...createNpcRecord('Temiwa', []), appearance: 'Slender fox-woman, amber eyes; veil of grey gauze, grey sash.',
        castFrom: { key: 'ersveil:temiwa', pack: 'ersveil', id: 'temiwa', first: { appearance: 'Slender fox-woman, amber eyes; veil of grey gauze, grey sash.' } },
    });
    assert.equal(old.overallAppearance, '', 'physical stays empty');
    assert.equal(old.appearance, 'Slender fox-woman, amber eyes; veil of grey gauze, grey sash.', 'current stays as it was');
    assert.deepEqual(old.castFrom.first, { appearance: 'Slender fox-woman, amber eyes; veil of grey gauze, grey sash.' });
});

test('a dossier already standing for the person is found by the cast key, name or alias, and is never replaced', () => {
    const [p] = normalizeCast([person()], dateText);
    const mine = normalizeNpcRecord({ ...createNpcRecord('Fenna', []), id: 'npc_fenna', castFrom: { key: 'ersveil:fenna' } });
    const byName = createNpcRecord('The Ferrywoman', []);
    assert.equal(dossierFor([createNpcRecord('Mira', []), mine], p), mine);
    assert.equal(dossierFor([createNpcRecord('Mira', []), createNpcRecord('FENNA', [])], p)?.name, 'FENNA', 'a dossier a scan made, by name');
    assert.equal(dossierFor([byName], p), byName, 'by an alias');
    assert.equal(dossierFor([createNpcRecord('Mira', [])], p), null);
});

test('what the dossier shows: the badge, first met, their own path, last heard (words escaped); Story Director gone, the pack\'s words stand', () => {
    const [p] = normalizeCast([person()], dateText);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.equal(castBadge(made.castFrom), 'Ersveil cast');
    assert.equal(castBadge({}), 'Cast');
    const view = castProjection(castView(made, p));
    assert.deepEqual([view.badge, view.firstMet, view.goal, view.routine], ['Ersveil cast', 'Gw 12 at Bluewatch docks', 'Find out who opened the weir', 'evenings at the ferry']);
    const html = castFromHtml(view);
    assert.match(html, /From the Ersveil cast · first met Gw 12 at Bluewatch docks/);
    assert.match(html, /<b>Their own path:<\/b> Find out who opened the weir/);
    assert.match(html, /<b>Last heard:<\/b> took the ferry upriver to Ashford \(Gw 15\)/);
    assert.match(castFromHtml(castProjection({ ...view, goal: '<img src=x onerror=1>', lastHeard: { text: '<b>x</b>', on: '' } })), /&lt;img src=x onerror=1&gt;[\s\S]*&lt;b&gt;x&lt;\/b&gt;/);
    const alone = castProjection(castView(made, null));
    assert.equal(alone.lastHeard, null);
    assert.equal(alone.goal, 'Find out who opened the weir', 'the starting words the pack gave');
    assert.doesNotMatch(castFromHtml(alone), /Last heard/);
    assert.match(castFromHtml(castProjection({ ...view, lastHeard: null, doing: 'Walks the road. ', where: 'Hollin\'s Reach' })), /<b>Now:<\/b> Walks the road · at Hollin&#039;s Reach|<b>Now:<\/b> Walks the road · at Hollin's Reach/, 'no lastHeard: what they do now and where, no stray full stop');
    assert.equal(castView(createNpcRecord('Mira', []), p), null, 'any other dossier shows none of it');
    assert.equal(castFromHtml(null), '');
    // The projection carries it to the view by dossier id.
    const state = projectDossierState({ npcs: [{ ...made, id: 'npc_fenna' }, { ...createNpcRecord('Mira', []), id: 'npc_mira' }], castViews: { npc_fenna: castView(made, p) } });
    assert.equal(state.npcs.find(npc => npc.id === 'npc_fenna').cast.badge, 'Ersveil cast');
    assert.equal(state.npcs.find(npc => npc.id === 'npc_mira').cast, undefined);
});

// ---- "Pin as Key people" on the From-the-cast block ----

test('the Pin button is drawn only when the view says it is offered: it carries the dossier id; none otherwise', () => {
    const [p] = normalizeCast([person()], dateText);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.equal(castView(made, p).pin, false, 'not offered by default');
    assert.equal(castView(made, p, { pin: true }).pin, true);
    const on = castFromHtml(castProjection(castView(made, p, { pin: true })), 'npc_fenna');
    assert.match(on, /<button type="button" class="delta-btn delta-cast-pin" data-delta-cast-pin="npc_fenna">★ Pin as Key people<\/button>/);
    assert.match(on, /the narrator hears about them/);
    assert.doesNotMatch(castFromHtml(castProjection(castView(made, p))), /delta-cast-pin/, 'not offered, or already pinned: no button');
});

// Story Director's pin as a stand-in: its own command writes its own state; Delta only asks.
const keyDirector = ({ withPin = true, feature = true } = {}) => ({
    id: 'story-director', name: 'Story Director (stand-in)', version: '0.0.0-test',
    domains: { keys: { initial: () => ({ pins: [], causes: [] }) } },
    commands: withPin ? {
        'keypeople.pin': (ctx, payload) => {
            const slice = ctx.draft('keys');
            slice.pins.push(JSON.stringify(payload));
            slice.causes.push(String(ctx.cause));
            return { summary: `${payload.name} is now a key person.` };
        },
    } : {},
    queries: { 'director.keyPeople': state => (state?.domains?.keys?.pins ?? []).map(text => ({ name: JSON.parse(text).name, aliases: JSON.parse(text).aliases ?? [], here: true, away: null })) },
    ...(feature ? { features: [{ id: 'story-director.key-people', label: 'Key people', describe: 'x', default: true }] } : {}),
});

test('the adapter offers the pin only while Story Director registers keypeople.pin (feature on); pinning asks its command as the reader, with the name, aliases and nsd', async () => {
    const s = await suite({ modules: [director(), keyDirector()] });
    assert.equal(s.adapter.keyPinOffered(), true);
    const out = await s.adapter.pinKeyPerson({ name: 'Fenna', aliases: ['the ferrywoman'] });
    assert.deepEqual([out.ok, out.message], [true, 'Fenna is now a key person.']);
    const slice = s.host.head().domains.keys;
    assert.deepEqual(JSON.parse(slice.pins[0]), { name: 'Fenna', aliases: ['the ferrywoman'], nsd: true });
    assert.deepEqual(slice.causes, ['ui'], 'as the reader\'s action');
    assert.deepEqual(s.adapter.keyPeople().map(entry => entry.name), ['Fenna'], 'and Delta reads the result back from director.keyPeople');

    const none = await suite({ modules: [director()] });
    assert.equal(none.adapter.keyPinOffered(), false, 'no Story Director that offers it: no button');
    assert.equal((await none.adapter.pinKeyPerson({ name: 'Fenna' })).ok, false);
    const noCommand = await suite({ modules: [director(), keyDirector({ withPin: false })] });
    assert.equal(noCommand.adapter.keyPinOffered(), false, 'an older Story Director without the command');
    const off = await suite({ modules: [director(), keyDirector()], features: { 'story-director.key-people': false } });
    assert.equal(off.adapter.keyPinOffered(), false, 'Key people switched off');
    assert.equal((await off.adapter.pinKeyPerson({ name: 'Fenna' })).ok, false);
    assert.deepEqual(off.host.head().domains.keys.pins, [], 'and nothing is asked of it');
});

// ---- the Ersveil writing: twelve real entries ----

const ERSVEIL = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/ersveil-cast.json', import.meta.url)), 'utf8'));

test('the twelve Ersveil entries all make a dossier: profile whole, fields, three to five notes, stages in the pack\'s shape with their cue', () => {
    assert.equal(ERSVEIL.length, 12);
    for (const raw of ERSVEIL) {
        const [p] = normalizeCast([{ key: `ersveil:${raw.id}`, pack: 'ersveil', id: raw.id, name: raw.name, aliases: raw.aliases, met: { on: 0, where: raw.start.place }, alive: true, entry: raw }], dateText);
        assert.ok(p?.entry, raw.id);
        const made = normalizeNpcRecord(applyCastEntry(createNpcRecord(raw.name, []), p, { packName: 'Ersveil (open world)' }));
        for (const field of ['look', 'voice', 'personality', 'history']) assert.ok(raw[field].length < 600 && p.entry[field] === raw[field], `${raw.id} ${field} kept whole`);
        assert.equal(made.overallAppearance, raw.look, raw.id);
        assert.equal(resolveNpcAppearance(made), raw.look, raw.id);
        assert.equal(made.speech, raw.voice, raw.id);
        assert.equal(made.personality, raw.personality, raw.id);
        assert.equal(made.background, raw.history, raw.id);
        assert.deepEqual(made.customFields, raw.fields, `${raw.id}: Soul Class and the other fields`);
        assert.ok(made.secrets.length >= 3 && made.secrets.length <= 5, `${raw.id}: ${made.secrets.length} notes`);
        assert.equal(made.secrets.filter(note => note.when && !note.meter).length, raw.secrets.filter(note => note.when).length, 'the story-event notes keep their words');
        assert.equal(made.secrets.map(note => note.text).join('|'), raw.secrets.map(note => note.text).join('|'), 'the texts whole, in order');
        assert.deepEqual(made.meterSetup, { track: raw.meters.preset, limits: {} });
        assert.deepEqual(made.castFrom.stages.map(stage => stage.name), raw.stages.map(stage => stage.name));
        assert.deepEqual(made.castFrom.stages.map(stage => stage.cue), raw.stages.map(stage => stage.milestone), 'the pack\'s milestone line is the stage\'s cue');
        assert.ok(made.castFrom.stages.every(stage => stage.milestone === undefined), 'and is never a milestone the stage needs');
        for (const meter of ['trust', 'affection', 'tension']) assert.equal(made.relationship[meter], raw.meters[meter], `${raw.id} ${meter}`);
    }
});

test('a person\'s pack stages are reached by the numbers alone, in order, with the preset\'s meters from the first meeting', async () => {
    const tansy = ERSVEIL.find(entry => entry.id === 'tansy-millrace');
    const records = { npc_tansy: { id: 'npc_tansy', name: 'Tansy Millrace', aliases: [], present: true, archived: false, castFrom: { key: 'ersveil:tansy-millrace', stages: normalizeEntry(tansy).stages } } };
    const host = await createHost({ settings: { modules: { [MODULE_ID]: { presets: ['companion'] } }, features: { [FEATURE_STAGES]: true } }, modules: [director()] });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        isEnabled: () => true, getNpc: id => (records[id] ? structuredClone(records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }), presentCastHtml: () => '', castEmptyReason: () => ({ text: '' }), fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    await adapter.settled();
    const rank = () => host.sdk.query('npc.meters', { name: 'Tansy Millrace' })?.rank;
    await host.send('Hi', 'Tansy binds a wound.\n\n<Changes>\n~ npc Tansy Millrace | trust: +15\n</Changes>');
    await adapter.ticked();
    assert.equal(rank(), undefined, 'trust 15 is short of the first stage (20)');
    await host.send('Hi', 'She stitches you.\n\n<Changes>\n~ npc Tansy Millrace | trust: +10\n</Changes>');
    await adapter.ticked();
    assert.equal(rank(), 'Known patient', 'reached on the numbers: no story milestone is needed for it');
    assert.match(host.sdk.query('npc.next', { name: 'Tansy Millrace' }).text, /Night-shift friend/);
});

// ---- the saved slice: the meeting is recorded at the reply ----

test('observeCast records each met person with an entry once; nobody is taken out; no answer changes nothing', () => {
    const [p] = normalizeCast([person()], dateText);
    const first = observeCast(undefined, [p, ...normalizeCast([unmet()])]);
    assert.deepEqual(first.fresh.map(item => item.key), ['ersveil:fenna']);
    assert.deepEqual(first.cast, { 'ersveil:fenna': { name: 'Fenna', rungs: 2 } });
    assert.deepEqual(validateNpcSlice({ npcs: {}, problems: [], cast: first.cast }), []);
    const again = observeCast(first.cast, [p]);
    assert.deepEqual(again.fresh, []);
    assert.equal(again.cast, first.cast, 'the same record');
    assert.equal(observeCast(first.cast, []).cast, first.cast, 'a person Story Director no longer lists stays recorded');
    assert.equal(observeCast(first.cast, null).cast, first.cast);
    assert.ok(validateNpcSlice({ npcs: {}, problems: [], cast: { 'bad key!': { name: 'x' } } }).length, 'an unusable key is refused');
    assert.ok(validateNpcSlice({ npcs: {}, problems: [], cast: { 'a:b': { name: 'x', extra: 1 } } }).length, 'and an unknown field');
});

// ---- on Story Block's whole host: a stand-in for Story Director ----

// Story Director's `director.cast` as a stand-in: the capture line "~ meet Fenna" records the meeting on the reply (as its own step
// does), a command sets who exists; the query answers with the entry for met people only.
// (The rows are kept as JSON text in its state: the host's rules reserve the field name `id`.)
const director = () => ({
    id: 'zz-director', name: 'Director (stand-in)', version: '0.0.0-test',
    domains: { director: { initial: () => ({ time: { minutes: 0 }, cast: [] }) } },
    commands: {
        'zz.cast': (ctx, { list }) => { ctx.draft('director').cast = list.map(row => JSON.stringify(row)); return { summary: 'cast' }; },
    },
    capture: {
        kinds: { meet: { grammar: '~ meet Name' } },
        apply: (ctx, line) => {
            const slice = ctx.draft('director');
            const at = slice.cast.findIndex(text => JSON.parse(text).name.toLowerCase() === String(line.name).toLowerCase());
            if (at < 0) ctx.fail('NOT_FOUND', 'Nobody by that name.');
            const found = JSON.parse(slice.cast[at]);
            found.met = { on: 11 * DAY, where: 'Bluewatch docks' };
            slice.cast[at] = JSON.stringify(found);
            return { summary: `met ${found.name}` };
        },
    },
    queries: {
        'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }),
        'director.calendar': () => calendar,
        'director.cast': state => (state?.domains?.director?.cast ?? []).map(text => JSON.parse(text)).map(item => (item.met ? item : { ...item, entry: undefined })),
    },
});
const castRow = (extra = {}) => ({ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: null, alive: true, entry: structuredClone(FENNA_ENTRY), ...extra });

async function suite({ settings = {}, features = null, modules = [director()], castSync, castPortraitDue } = {}) {
    const records = {};
    const host = await createHost({ settings: { modules: { [MODULE_ID]: structuredClone(settings) }, ...(features ? { features: { ...features } } : {}) }, modules });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        isEnabled: () => true,
        getNpc: id => (records[id] ? structuredClone(records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        presentCastHtml: () => '', castEmptyReason: () => ({ text: '' }), fillPresentCast: () => {},
    };
    const synced = [];
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        castSync: castSync ?? (async () => { synced.push(host.store.headIndex()); }),
        ...(castPortraitDue ? { castPortraitDue } : {}),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true);
    const say = async (lines = []) => {
        await host.send('And then?', `The story goes on.${lines.length ? `\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : ''}`);
        await adapter.ticked();
    };
    const swipe = async lines => { await host.swipe(`Another way.${lines?.length ? `\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : ''}`); await adapter.ticked(); };
    const world = async list => { await host.sdk.command('zz.cast', { list }); };
    const made = () => host.sdk.query('npc.castMade', {});
    const meters = name => host.sdk.query('npc.meters', { name });
    return { host, adapter, say, swipe, world, made, meters, synced };
}

test('Story Director\'s cast is read through the adapter: cleaned, entry for the met only; with none to ask (or no such query) it answers null', async () => {
    const s = await suite();
    assert.deepEqual(s.adapter.castPeople(), [], 'an empty world');
    await s.world([castRow(), castRow({ key: 'ersveil:sera', id: 'sera', name: 'Sera' })]);
    assert.deepEqual(s.adapter.castPeople().map(item => [item.key, item.met, item.entry]), [['ersveil:fenna', null, null], ['ersveil:sera', null, null]]);
    const plain = await suite({ modules: [] });
    assert.equal(plain.adapter.castPeople(), null, 'Story Block alone: no cast anywhere');
    assert.deepEqual(plain.adapter.castMade(), {});
    const old = await suite({ modules: [{ id: 'zz-old', name: 'Older director', domains: {}, commands: {}, queries: { 'director.time': () => ({ minutes: 0 }) } }] });
    assert.equal(old.adapter.castPeople(), null, 'an older Story Director without the query');
});

test('the meeting is recorded in the slice at the reply it is first seen: the first numbers, the problem line, the stage; unmet people leave no trace', async () => {
    const settings = { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 20 }], ladder: [] };
    const s = await suite({ settings, features: { [FEATURE_STAGES]: true } });
    await s.world([castRow(), castRow({ key: 'ersveil:sera', id: 'sera', name: 'Sera' })]);
    await s.say();
    assert.deepEqual(s.made(), {}, 'nobody met: nothing recorded, nobody synced');
    assert.deepEqual(s.synced, []);
    assert.equal(s.meters('Fenna'), null);

    await s.say(['~ meet Fenna']);
    assert.deepEqual(s.made(), { 'ersveil:fenna': { name: 'Fenna', rungs: 2 } });
    assert.equal(s.made()['ersveil:sera'], undefined, 'the other is still hidden');
    const fenna = s.meters('Fenna');
    assert.equal(fenna.meters.trust, 10);
    assert.equal(fenna.meters.loyalty, 30, 'a meter this chat has takes the pack\'s first value');
    assert.equal(s.meters('Sera'), null);
    const slice = s.host.head().domains.npc;
    assert.deepEqual(validateNpcSlice(slice), []);
    assert.ok(slice.problems.some(problem => /nonsense/.test(problem.text)), 'a meter this chat does not have is a problem line, not an error');
    assert.deepEqual(s.synced.length, 1, 'and the dossier is made (once)');

    // Later replies change nothing about it.
    await s.say();
    assert.deepEqual(Object.keys(s.made()), ['ersveil:fenna']);
    assert.equal(s.meters('Fenna').meters.loyalty, 30);
});

test('a swipe of the meeting\'s reply takes the record with it, a re-meeting on the new swipe records it again, a reload keeps it; the first numbers are never overwritten', async () => {
    const s = await suite({ settings: { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 20 }] } });
    await s.world([castRow()]);
    await s.say(['~ meet Fenna']);
    assert.deepEqual(Object.keys(s.made()), ['ersveil:fenna']);
    await s.say(['~ npc Fenna | trust: +5']);
    assert.equal(s.meters('Fenna').meters.trust, 15);

    // Swipe the later reply: the meeting stays (it belongs to the earlier reply), the story's +5 is gone.
    await s.swipe();
    assert.deepEqual(Object.keys(s.made()), ['ersveil:fenna']);
    assert.equal(s.meters('Fenna').meters.trust, 10);

    // Swipe the meeting's own reply: it never happened on this swipe.
    await s.say();
    const head = s.host.store.headIndex();
    assert.ok(head >= 2);
    await s.host.turn.onChatChanged();
    assert.deepEqual(Object.keys(s.made()), ['ersveil:fenna'], 'a reload keeps it (the host rebuilds its state from the chat)');

    const t = await suite({ settings: { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 20 }] } });
    await t.world([castRow()]);
    await t.say(['~ meet Fenna']);
    assert.deepEqual(Object.keys(t.made()), ['ersveil:fenna']);
    await t.swipe();
    assert.deepEqual(t.made(), {}, 'the swipe did not carry the meeting line: unrecorded');
    assert.equal(t.meters('Fenna'), null, 'and the entry that came with it');
    await t.swipe(['~ meet Fenna']);
    assert.deepEqual(Object.keys(t.made()), ['ersveil:fenna'], 'met again on the new swipe: recorded again');
    assert.equal(t.meters('Fenna').meters.trust, 10);
});

test('the person\'s own stages work like a ladder: reached by the numbers, only while stage ladders are on', async () => {
    const own = [{ name: 'Wary', needs: 'trust 5' }, { name: 'Ally', needs: 'trust 40' }];
    const records = { npc_fenna: { id: 'npc_fenna', name: 'Fenna', aliases: [], present: true, archived: false, castFrom: { key: 'ersveil:fenna', stages: own } } };
    const host = await createHost({ settings: { modules: { [MODULE_ID]: {} }, features: { [FEATURE_STAGES]: true } }, modules: [director()] });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        isEnabled: () => true, getNpc: id => (records[id] ? structuredClone(records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }), presentCastHtml: () => '', castEmptyReason: () => ({ text: '' }), fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    await adapter.settled();
    await host.send('Hi', 'Fenna smiles.\n\n<Changes>\n~ npc Fenna | trust: +10\n</Changes>');
    await adapter.ticked();
    assert.equal(host.sdk.query('npc.meters', { name: 'Fenna' }).rank, 'Wary');
    assert.match(host.sdk.query('npc.next', { name: 'Fenna' }).text, /Ally/);
    await host.send('Hi', 'Fenna nods.\n\n<Changes>\n~ npc Fenna | trust: +15\n</Changes>');
    await host.send('Hi', 'Fenna nods.\n\n<Changes>\n~ npc Fenna | trust: +15\n</Changes>');
    assert.equal(host.sdk.query('npc.meters', { name: 'Fenna' }).rank, 'Ally');
});

test('with no Story Director the per-reply step and the slice are exactly as before', async () => {
    const s = await suite({ modules: [] });
    await s.say(['~ npc Ren | trust: +5']);
    assert.equal(s.host.head().domains.npc.cast, undefined);
    assert.deepEqual(s.synced, []);
    assert.equal(s.meters('Ren').meters.trust, 5);
});

// ---- Delta's real runtime beside a fake host whose Story Director answers director.cast ----

const scenarioOutput = output => JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));

test('runtime: the dossier is made at the first meeting from the pack entry, with portrait and badge; swipe undoes it; delete is final; a standing dossier is left alone', () => {
    const entry = { ...FENNA_ENTRY, wears: 'A sou\'wester hat and a coil of rope over one shoulder.' };
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const sdk = mockState.sdk;
        const say = async text => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
            return id;
        };
        const turn = async () => { await sdk.turn({ type: 'normal' }); await sleep(250); };
        mockState.quietResponder = async () => JSON.stringify({ npcs: [] });
        const out = {};
        const fenna = () => api.getState().npcs.find(npc => npc.name === 'Fenna');
        // SillyTavern's file routes the way the server answers them: verify says what exists (so a present file is not written again).
        const plainFetch = globalThis.fetch;
        let portraitUploads = 0;
        globalThis.fetch = async (url, options = {}) => {
            if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => Object.fromEntries(JSON.parse(options.body).urls.map(path => [path, mockState.files.has(path)])) };
            if (url === '/api/files/upload' && JSON.parse(options.body).name.startsWith('npc-state-delta-portrait-')) portraitUploads += 1;
            return plainFetch(url, options);
        };

        // Nobody met: Story Director lists her unmet (no entry).
        sdk.people = [{ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: null, alive: true }];
        await say('The docks are quiet at dusk.');
        await turn();
        out.unmet = { npcs: api.getState().npcs.length, ticks: sdk.ticks };

        // The first meeting: the step records it, then the dossier is made at once.
        sdk.people = [{ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: { on: 11 * 1440, where: 'Bluewatch docks' }, where: 'Bluewatch docks', doing: 'running the ferry', lastHeard: { text: 'took the ferry upriver to Ashford', on: 14 * 1440 }, alive: true, entry: __ENTRY__ }];
        sdk.present = ['Fenna'];
        const metAt = await say('Fenna looks up from her rope as you reach the ferry.');
        await turn();
        await sleep(300);
        const made = fenna();
        out.made = made ? {
            role: made.role, appearance: made.appearance, overallAppearance: made.overallAppearance, speech: made.speech, personality: made.personality, background: made.background,
            homeBase: made.homeBase, goal: made.goal, location: made.location, aliases: made.aliases, customFields: made.customFields,
            trust: made.relationship.trust, meterSetup: made.meterSetup, secrets: made.secrets.length, portrait: made.portrait ?? null, files: [...mockState.files.keys()].filter(path => path.includes('npc-state-delta-portrait-')),
            fingerprint: Boolean(made.portrait?.appearanceFingerprint), castFrom: made.castFrom, assets: Boolean(api.getState().portraitAssets?.[made.id]),
        } : null;
        out.count = api.getState().npcs.length;
        out.view = api.getDossierState().castViews?.[made?.id] ?? null;
        out.injection = api.injectionPreview().text;
        await turn();
        await sleep(200);
        out.again = api.getState().npcs.length;

        // A swipe of the reply she was made at (the head reply) takes the dossier back with it; Story Director's meeting is undone too.
        const chat = mockState.context.chat;
        const people = sdk.people;
        const swipeHead = async (text, list, present) => {
            chat[metAt] = { is_user: false, is_system: false, name: 'Megumin', swipe_id: (chat[metAt].swipe_id || 0) + 1, mes: text, swipes: [...(chat[metAt].swipes || []), text] };
            sdk.people = list; sdk.present = present;
            if (!list.some(person => person.met)) sdk.made = {};
            mockState.swipeState = 'swiping';
            eventSource.emit('message_swiped', metAt);
            await sleep(200);
            eventSource.emit('message_received', metAt);
            await sleep(300);
            mockState.swipeState = 'none';
            await sleep(300);
            await turn();
        };
        await swipeHead('The ferry is empty tonight.', [{ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: null, alive: true }], []);
        out.afterSwipe = api.getState().npcs.filter(npc => npc.name === 'Fenna').length;
        // Met again on the new swipe: the dossier is made again.
        await swipeHead('Fenna is back at the ferry, coiling rope.', people, ['Fenna']);
        out.remade = api.getState().npcs.filter(npc => npc.name === 'Fenna').length;

        // A later scan adds to the dossier as for anyone: a keep row leaves what the pack gave.
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Fenna', present: true, role: 'ferrywoman', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipReason: '' }] });
        await say('Fenna hands you a rope. "Hold this," she says.');
        await sleep(300);
        out.afterScan = { personality: fenna().personality, speech: fenna().speech, castFrom: Boolean(fenna().castFrom) };
        // The picture was written once, through the swipe and the second meeting; the chat's saved state never held it.
        out.portraitUploads = portraitUploads;
        out.portraitFiles = [...mockState.files.keys()].filter(path => path.includes('npc-state-delta-portrait-')).length;
        const sidecars = [...mockState.files.entries()].filter(([path]) => /\/npc-state-delta-[a-z0-9]+\.json$/.test(path));
        out.sidecarHoldsImage = sidecars.some(([, text]) => text.includes('data:image'));
        out.sidecarsSaved = sidecars.length;
        out.remadePortrait = fenna()?.portrait ?? null;
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], people: [], made: {}, ticks: 0, handlers: {}, present: [],
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.handlers[name] = fn; return () => {}; },
            turn: async turn => { await sdk.handlers.turn?.(turn); },
            command: async type => {
                if (type === 'npc.tick') {
                    sdk.ticks += 1;
                    for (const person of sdk.people) if (person.met && person.entry) sdk.made[person.key] = { name: person.name };
                }
                return { ok: true, receipt: { summary: '' } };
            },
            query: (name, args) => (name === 'director.cast' ? structuredClone(sdk.people)
                : name === 'npc.castMade' ? structuredClone(sdk.made)
                : name === 'packs.list' ? [{ id: 'ersveil', name: 'Ersveil', version: '1.0.0' }]
                : name === 'packs.portrait' ? (args?.pack === 'ersveil' && args?.file === 'fenna.webp' ? 'PORTRAIT' : null)
                : name === 'director.calendar' ? { era: 'CY', months: [{ name: 'Goldwane', days: 30 }], leapYears: false }
                : name === 'scene.present' ? structuredClone(sdk.present) : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    // The scenario runs in a child process: the entry and the portrait are written into its source.
    const source = scenario.toString().replace('__ENTRY__', JSON.stringify(entry));
    const preludeSource = prelude.toString().replace("'PORTRAIT'", JSON.stringify(png));
    const hosted = scenarioOutput(runHostScenario('cast-dossier-hosted', { toString: () => preludeSource }, { toString: () => source }));
    assert.equal(hosted.unmet.npcs, 0, 'nobody met: no dossier');
    assert.equal(hosted.count, 1, 'one dossier at the first meeting, without a scan');
    assert.equal(hosted.made.role, 'Runs the night ferry at Bluewatch docks.');
    // The host path (production runtime): look → physical, wears → current, each in the pack's exact words.
    assert.equal(hosted.made.overallAppearance, FENNA_ENTRY.look);
    assert.equal(hosted.made.appearance, `${FENNA_ENTRY.look.replace(/\.$/, '')}; ${entry.wears}`, 'the resolved appearance: body, then the outfit once');
    assert.deepEqual([hosted.made.castFrom.first.overallAppearance, hosted.made.castFrom.first.appearance], [FENNA_ENTRY.look, entry.wears]);
    assert.equal(hosted.made.speech, FENNA_ENTRY.voice);
    assert.equal(hosted.made.personality, FENNA_ENTRY.personality);
    assert.equal(hosted.made.background, FENNA_ENTRY.history);
    assert.equal(hosted.made.goal, 'Find out who opened the weir');
    assert.equal(hosted.made.location, 'Bluewatch docks');
    assert.equal(hosted.made.trust, 10);
    assert.equal(hosted.made.secrets, 2);
    assert.deepEqual(hosted.made.customFields, { Allegiance: 'Ferry guild' });
    // The pack's portrait is saved once as its own user file named by its content; the dossier keeps only the record that names it (no data URL).
    const bytes = Buffer.from(png.split(',')[1], 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(hosted.made.files, [`/user/files/npc-state-delta-portrait-${hash.slice(0, 40)}.png`], 'the picture is one user file named by its content');
    assert.equal(hosted.made.portrait.path, hosted.made.files[0]);
    assert.equal(hosted.made.portrait.hash, hash);
    assert.equal(hosted.made.portrait.type, 'image/png');
    assert.equal(hosted.made.portrait.dataUrl, undefined, 'no picture in the dossier');
    assert.equal(hosted.made.portrait.sourceName, 'fenna.webp');
    assert.equal(hosted.made.fingerprint, true);
    assert.equal(hosted.made.assets, false, 'and no second copy in the chat\'s portrait assets');
    assert.equal(hosted.portraitUploads, 1, 'the picture is written once: not again for the swipe, the second meeting or a scan');
    assert.equal(hosted.portraitFiles, 1);
    assert.equal(hosted.sidecarsSaved, 1);
    assert.equal(hosted.sidecarHoldsImage, false, 'the chat\'s saved state holds no picture');
    assert.equal(hosted.remadePortrait.path, hosted.made.portrait.path, 'met again after the swipe: the same file');
    assert.equal(hosted.made.castFrom.packName, 'Ersveil');
    assert.equal(hosted.made.castFrom.met.on, 'Goldwane 12', 'the meeting date is written on Story Director\'s calendar');
    assert.equal(hosted.view.badge, 'Ersveil cast');
    assert.equal(hosted.view.lastHeard.text, 'took the ferry upriver to Ashford');
    assert.match(hosted.injection, /oilskin coat/, 'the narrator hears the look at once');
    assert.equal(hosted.again, 1, 'a later step does not make it twice');
    assert.equal(hosted.afterScan.personality, FENNA_ENTRY.personality, 'a later scan leaves what the pack gave unless the story says otherwise');
    assert.equal(hosted.afterScan.speech, FENNA_ENTRY.voice);
    assert.equal(hosted.afterScan.castFrom, true);
    assert.equal(hosted.afterSwipe, 0, 'a swipe of the reply she was made at takes her back');
    assert.equal(hosted.remade, 1, 'and she is made again when the new swipe meets her');
});

test('runtime: removing the cast dossier is final; a dossier a scan made earlier is not replaced; Delta alone makes none', () => {
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const sdk = mockState.sdk;
        const say = async text => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
            return id;
        };
        const turn = async () => { await sdk.turn({ type: 'normal' }); await sleep(300); };
        const row = (name, extra = {}) => ({ name, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipReason: '', ...extra });
        const out = {};
        // Yunyun already has a dossier (a scan made it); Fenna is the cast person.
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row('Yunyun', { personality: 'Shy and loud at once.', role: 'sorceress' })] });
        await say('Yunyun waves from the gate.');
        await sleep(300);
        const meet = (name, key) => ({ key, pack: 'ersveil', id: key.split(':')[1], name, aliases: [], met: { on: 0, where: 'the gate' }, alive: true, entry: { id: key.split(':')[1], name, about: 'From the pack.', look: 'Pack look.', personality: 'Pack personality.', start: { place: 'gate', goal: 'pack goal' } } });
        sdk.people = [meet('Yunyun', 'ersveil:yunyun'), meet('Fenna', 'ersveil:fenna')];
        await say('Both are at the gate.');
        await turn();
        await sleep(300);
        const names = () => api.getState().npcs.map(npc => npc.name).sort();
        out.first = { names: names(), yunyun: api.getState().npcs.find(npc => npc.name === 'Yunyun').personality, yunyunCast: Boolean(api.getState().npcs.find(npc => npc.name === 'Yunyun').castFrom), fennaCast: Boolean(api.getState().npcs.find(npc => npc.name === 'Fenna')?.castFrom) };
        out.views = Object.keys(api.getDossierState().castViews ?? {});

        // The reader removes Fenna: she is not made again at the next step.
        const fennaId = api.getState().npcs.find(npc => npc.name === 'Fenna').id;
        await api.deleteNpc(fennaId);
        await sleep(200);
        await turn();
        await sleep(300);
        out.afterDelete = names();
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], people: [], made: {}, handlers: {},
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.handlers[name] = fn; return () => {}; },
            turn: async turn => { await sdk.handlers.turn?.(turn); },
            command: async type => {
                if (type === 'npc.tick') for (const person of sdk.people) if (person.met && person.entry) sdk.made[person.key] = { name: person.name };
                return { ok: true, receipt: { summary: '' } };
            },
            query: name => (name === 'director.cast' ? structuredClone(sdk.people) : name === 'npc.castMade' ? structuredClone(sdk.made)
                : name === 'packs.list' ? [{ id: 'ersveil', name: 'Ersveil' }] : name === 'scene.present' ? [] : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const hosted = scenarioOutput(runHostScenario('cast-dossier-standing', prelude, scenario));
    assert.deepEqual(hosted.first.names, ['Fenna', 'Yunyun'], 'one new dossier: the standing one is not made again');
    assert.equal(hosted.first.yunyun, 'Shy and loud at once.', 'a dossier that was already there keeps its words (the pack never overwrites a dossier)');
    assert.equal(hosted.first.yunyunCast, false);
    assert.equal(hosted.first.fennaCast, true);
    assert.equal(hosted.views.length, 1);
    assert.deepEqual(hosted.afterDelete, ['Yunyun'], 'removed by the reader: not made again');

    const alone = scenarioOutput(runHostScenario('cast-dossier-none', async () => {
        const sdk = { registered: [], handlers: {}, registerModule(def) { sdk.registered.push(def); }, on(name, fn) { sdk.handlers[name] = fn; return () => {}; }, command: async () => ({ ok: true }), query: name => (name === 'scene.present' ? [] : null), settings: () => ({}) };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Nobody here.', swipe_id: 0, swipes: ['Nobody here.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await mockState.sdk.handlers.turn?.({ type: 'normal' });
        await sleep(300);
        console.log('RESULT ' + JSON.stringify({ npcs: api.getState().npcs.length, views: api.getDossierState().castViews ?? null }));
    }));
    assert.equal(alone.npcs, 0);
    assert.equal(alone.views, null);
});

test('runtime: the dossier view offers the Pin button while Story Director offers it and the person is not pinned; pinning calls its command and the button goes', () => {
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const sdk = mockState.sdk;
        const say = async text => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
        };
        mockState.quietResponder = async () => JSON.stringify({ npcs: [] });
        sdk.people = [{ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: { on: 0, where: 'the docks' }, alive: true, entry: { id: 'fenna', name: 'Fenna', aliases: ['the ferrywoman'], about: 'Ferry.', look: 'Tall.', start: { place: 'docks', goal: 'g' } } }];
        await say('Fenna looks up.');
        await sdk.turn({ type: 'normal' });
        await sleep(300);
        const id = api.getState().npcs.find(npc => npc.name === 'Fenna').id;
        const pin = () => api.getDossierState().castViews[id].pin;
        const out = {};
        out.offered = pin();
        out.result = await api.pinKeyPerson(id);
        out.asked = sdk.asked;
        // Pinned: Story Director now lists her; the button is gone.
        sdk.keys = [{ name: 'Fenna', aliases: [], here: true, away: null }];
        out.pinned = pin();
        sdk.keys = [];
        sdk.modulesList = [{ id: 'story-director', status: 'ready', commands: [] }];
        out.noCommand = pin();
        sdk.modulesList = [];
        out.noDirector = pin();
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], people: [], made: {}, handlers: {}, keys: [], asked: [],
            modulesList: [{ id: 'story-director', status: 'ready', commands: ['keypeople.pin', 'keypeople.unpin'] }],
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.handlers[name] = fn; return () => {}; },
            modules: () => structuredClone(sdk.modulesList),
            turn: async turn => { await sdk.handlers.turn?.(turn); },
            command: async (type, payload) => {
                if (type === 'npc.tick') for (const person of sdk.people) if (person.met && person.entry) sdk.made[person.key] = { name: person.name };
                if (type === 'keypeople.pin') { sdk.asked.push({ type, payload }); return { ok: true, receipt: { summary: payload.name + ' is now a key person.' } }; }
                return { ok: true, receipt: { summary: '' } };
            },
            query: name => (name === 'director.cast' ? structuredClone(sdk.people) : name === 'npc.castMade' ? structuredClone(sdk.made)
                : name === 'director.keyPeople' ? structuredClone(sdk.keys) : name === 'packs.list' ? [{ id: 'ersveil', name: 'Ersveil' }] : name === 'scene.present' ? [] : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const out = scenarioOutput(runHostScenario('cast-pin', prelude, scenario));
    assert.equal(out.offered, true, 'offered: Story Director has the command and she is not pinned');
    assert.deepEqual(out.result, { ok: true, message: 'Fenna is now a key person.' });
    assert.deepEqual(out.asked, [{ type: 'keypeople.pin', payload: { name: 'Fenna', aliases: ['the ferrywoman'], nsd: true } }]);
    assert.equal(out.pinned, false, 'already pinned (director.keyPeople lists her): no button');
    assert.equal(out.noCommand, false, 'Story Director without the command: no button');
    assert.equal(out.noDirector, false, 'no Story Director: no button');
});

test('the section bar after the cast box starts where the box ends, and the "Next:" line has its own space under the meters', () => {
    const ui = dossierUiSource();
    // The bar's -26px margin collapsed with the box's 10px: it pulled its opaque padding over the box's bottom edge.
    assert.match(ui, /\.delta-cast-from \+ \.delta-section-nav \{ margin-top:-10px; \}/, 'on the desktop the box margin and this one cancel: the bar starts at the box end');
    assert.match(ui, /@media \(max-width: 650px\)[\s\S]*\.delta-cast-from \+ \.delta-section-nav \{ margin-top:-4px; \}/, 'on a phone the same, with that layout\'s -4px');
    // `.delta-section p { margin:0 }` outranks a bare class: the 6px of the rank, next and milestones lines never applied.
    assert.match(ui, /\.delta-section p\.delta-v2-next, [^\n]*\.delta-section p\.delta-v2-note \{ margin:6px 0 0;/);
    assert.doesNotMatch(ui, /#\$\{ROOT_ID\} \.delta-v2-next/, 'no bare-class rule for the lines (it loses to .delta-section p)');
    assert.match(ui, /\.delta-section \.delta-rel-grid \+ p \{ margin-top:12px; \}/, 'the first line under the meter grid gets 12px');
});

// ---- the opaque panel and section bar (a follow-up from the mockup) ----

test('the dossier panel and its sticky section bar are opaque: a floor under the tint, the tint over it', () => {
    const ui = dossierUiSource();
    assert.match(ui, /\.delta-panel \{[^}]*background-color:var\(--delta-floor\); background-image:linear-gradient\(var\(--delta-bg\),var\(--delta-bg\)\);/s);
    assert.match(ui, /\.delta-section-nav \{[^}]*background-color:var\(--delta-floor\); background-image:linear-gradient\(var\(--delta-bg\),var\(--delta-bg\)\);/s);
    // The bar reaches up over the panel's 22px top padding, so nothing scrolls into view above it (the chips stay where they were).
    assert.match(ui, /\.delta-section-nav \{ position:sticky; top:-22px;[^}]*margin:-26px 0 12px; padding:30px 0 8px;/);
    assert.match(ui, /@media \(max-width: 650px\)[\s\S]*\.delta-section-nav \{ top:0; margin-top:-4px; padding-top:8px; \}/, 'on a phone the scrolling parent has no padding: as before');
    assert.doesNotMatch(ui, /\.delta-panel \{[^}]*background:var\(--delta-bg\)/s, 'the translucent tint alone is gone');
    assert.match(ui, /--delta-floor: var\(--ss-sheet-floor, #18191d\)/, 'a fixed floor where the host gives none');
    assert.match(ui, /@supports \(color: rgb\(from red r g b\)\)[\s\S]*--delta-floor: var\(--ss-sheet-floor, rgb\(from var\(--delta-bg\) r g b \/ 1\)\)/, 'the tint with its alpha dropped where relative colours exist');
});

test('index.js wiring: the cast reader, the checkpoint, the dismissal check, the views (source)', () => {
    const index = runtimeSource();
    assert.match(index, /commitBranchCheckpoint\(working, messageId, 'cast-dossier'\)/, 'a swipe takes the dossier back with its reply');
    assert.match(index, /castPersonDismissed\(state, person\)/, 'a dossier the reader removed is not made again');
    assert.match(index, /v2\.startStorySuiteV2\(\{[^}]*castSync/, 'the adapter calls the sync after the step');
    assert.match(index, /const castViews = dossierCastViews\(state\);/);
    const adapter = adapterSource();
    assert.doesNotMatch(adapter, /sdkRef\.command\(['"]director\./, 'Delta never writes to Story Director');
});

// ---- the picture that comes later (a cast dossier made while its picture was missing) ----

const FILE_PORTRAIT = (hash = 'a'.repeat(64)) => ({ path: `/user/files/npc-state-delta-portrait-${hash.slice(0, 40)}.png`, type: 'image/png', hash, sourceName: 'fenna.webp', updatedAt: 1 });

test('a cast dossier may be given the pack\'s picture only while it has none of its own and the reader has not removed one; the removal is recorded in castFrom', () => {
    const [p] = normalizeCast([person()], dateText);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.equal(made.portrait, null, 'made without a picture');
    assert.equal(castPortraitWanted(made), true, 'a cast dossier with an empty portrait');
    const given = applyCastPortrait(made, FILE_PORTRAIT());
    assert.deepEqual(given.portrait, FILE_PORTRAIT());
    assert.equal(made.portrait, null, 'the dossier it was given to is not changed in place');
    assert.deepEqual({ ...given, portrait: null }, made, 'only the portrait differs');
    assert.equal(castPortraitWanted(given), false, 'once it has one it is not asked for again');
    assert.equal(applyCastPortrait(given, FILE_PORTRAIT('b'.repeat(64))), given, 'and one it has is never replaced');
    // An upload or a generated picture (held in the record) is the reader\'s own picture.
    const mine = { ...made, portrait: { dataUrl: 'data:image/png;base64,AAAA', mime: 'image/png' } };
    assert.equal(castPortraitWanted(mine), false);
    assert.equal(applyCastPortrait(mine, FILE_PORTRAIT()), mine);
    // Removed on purpose: nothing puts it back.
    const removed = markCastPortraitRemoved(made);
    assert.equal(removed.castFrom.portraitRemoved, true);
    assert.deepEqual({ ...removed.castFrom, portraitRemoved: undefined }, { ...made.castFrom, portraitRemoved: undefined }, 'the rest of castFrom is as it was');
    assert.equal(made.castFrom.portraitRemoved, undefined, 'not changed in place');
    assert.equal(castPortraitWanted(removed), false);
    assert.equal(applyCastPortrait(removed, FILE_PORTRAIT()), removed);
    // Not a cast dossier: never.
    const plain = createNpcRecord('Yunyun', []);
    assert.equal(castPortraitWanted(plain), false, 'a dossier a scan or the reader made');
    assert.equal(applyCastPortrait(plain, FILE_PORTRAIT()), plain);
    assert.equal(markCastPortraitRemoved(plain), plain, 'and a removal there records nothing');
    assert.equal(applyCastPortrait(made, { dataUrl: '' }), made, 'a record without a picture gives nothing');
    assert.equal(castPortraitWanted(null), false);
});

test('a restore from a checkpoint keeps the mark that the reader removed a cast dossier\'s picture, and adds none to anyone else', () => {
    const [p] = normalizeCast([person()], dateText);
    const made = normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    const removed = markCastPortraitRemoved(made);
    const [restored] = preserveUserNpcMetadata([made], [removed]);
    assert.equal(restored.castFrom.portraitRemoved, true, 'the checkpoint was taken before the removal; the reader\'s removal stands');
    assert.equal(restored.portrait, null);
    const [other] = preserveUserNpcMetadata([made], [made]);
    assert.equal(other.castFrom.portraitRemoved, undefined, 'no mark where there was none');
    const stranger = { ...removed, castFrom: { ...removed.castFrom, key: 'ersveil:someone-else' } };
    assert.equal(preserveUserNpcMetadata([made], [stranger])[0].castFrom.portraitRemoved, undefined, 'only for the same person');
    const withPicture = { ...made, portrait: FILE_PORTRAIT() };
    assert.deepEqual(preserveUserNpcMetadata([made], [withPicture])[0].portrait, FILE_PORTRAIT(), 'a picture the dossier has now is kept, as before');
});

test('the adapter asks for the picture sync when the step has nothing to do, only when there is a picture to give', async () => {
    let due = false;
    const s = await suite({ castPortraitDue: () => due });
    await s.world([castRow({ entry: { ...structuredClone(FENNA_ENTRY), stages: [] } })]);
    await s.say(['~ meet Fenna']);
    assert.equal(s.synced.length, 1, 'the meeting: the sync runs for the new dossier, once');
    await s.say();
    await s.say();
    assert.equal(s.synced.length, 1, 'no picture to give: later replies leave the sync alone');
    due = true;
    await s.say();
    assert.ok(s.synced.length >= 2, 'a picture to give: the next reply runs the sync');
    const before = s.synced.length;
    due = false;
    await s.say();
    assert.equal(s.synced.length, before, 'and it stops when there is none');
    // Without the option (older callers) nothing is asked.
    const plain = await suite();
    await plain.world([castRow({ entry: { ...structuredClone(FENNA_ENTRY), stages: [] } })]);
    await plain.say(['~ meet Fenna']);
    await plain.say();
    await plain.say();
    assert.equal(plain.synced.length, 1);
});

test('runtime: a cast dossier made without its picture gets it when Story Block has it; a reader\'s own or removed picture, a dossier a scan made and a second pass are left alone; a swipe keeps it exact', () => {
    const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const png2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const mine = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const sdk = mockState.sdk;
        const say = async text => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
            return id;
        };
        const turn = async () => { await sdk.turn({ type: 'normal' }); await sleep(300); };
        const row = (name, extra = {}) => ({ name, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipReason: '', ...extra });
        const plainFetch = globalThis.fetch;
        const uploads = [];
        globalThis.fetch = async (url, options = {}) => {
            if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => Object.fromEntries(JSON.parse(options.body).urls.map(path => [path, mockState.files.has(path)])) };
            if (url === '/api/files/upload' && JSON.parse(options.body).name.startsWith('npc-state-delta-portrait-')) uploads.push(JSON.parse(options.body).name);
            return plainFetch(url, options);
        };
        const byName = name => api.getState().npcs.find(npc => npc.name === name);
        const shape = name => { const npc = byName(name); return npc ? { has: Boolean(npc.portrait), path: npc.portrait?.path ?? null, dataUrl: Boolean(npc.portrait?.dataUrl), sourceName: npc.portrait?.sourceName ?? null, fingerprint: Boolean(npc.portrait?.appearanceFingerprint), removed: npc.castFrom?.portraitRemoved === true, cast: Boolean(npc.castFrom) } : null; };
        const out = {};

        // Yunyun has a dossier a scan made; the pack lists her too (and will have her picture).
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row('Yunyun', { personality: 'Shy and loud at once.', role: 'sorceress' })] });
        await say('Yunyun waves from the gate.');
        await sleep(300);
        const meet = (name, id) => ({ key: `ersveil:${id}`, pack: 'ersveil', id, name, aliases: [], met: { on: 0, where: 'the gate' }, alive: true, entry: { id, name, about: 'From the pack.', look: `${name} pack look.`, personality: 'Pack personality.', portrait: `${id}.webp`, start: { place: 'gate', goal: 'pack goal' } } });
        sdk.people = [meet('Yunyun', 'yunyun'), meet('Fenna', 'fenna'), meet('Tansy', 'tansy'), meet('Orrin', 'orrin'), meet('Maro', 'maro')];
        // Only Tansy's picture is there at the meeting: the pack was imported without the others.
        sdk.pics = { 'tansy.webp': 'PNG1' };
        const metAt = await say('They are all at the gate.');
        await turn();
        await sleep(300);
        out.afterMeeting = Object.fromEntries(['Yunyun', 'Fenna', 'Tansy', 'Orrin', 'Maro'].map(name => [name, shape(name)]));
        out.uploadsAtMeeting = uploads.length;

        // The reader sets Orrin's own picture and removes Tansy's.
        const state = api.getState();
        const orrin = state.npcs.find(npc => npc.name === 'Orrin');
        orrin.portrait = { dataUrl: 'MINE', mime: 'image/png', sourceName: 'mine.png', updatedAt: 5 };
        state.portraitAssets = { ...state.portraitAssets, [orrin.id]: structuredClone(orrin.portrait) };
        await api.installState(state);
        await sleep(200);
        out.removeTansy = await api.removePortrait(byName('Tansy').id, { chatKey: api.uiStatus().chatKey });
        await sleep(200);

        // Nothing has changed in the pack: a later reply fills nobody (and does not try).
        await say('The gate is quiet.');
        await turn();
        out.beforePictures = Object.fromEntries(['Fenna', 'Orrin', 'Tansy'].map(name => [name, shape(name)]));
        out.uploadsBefore = uploads.length;

        // The pictures are imported into the pack (Story Block now answers), no new chat: the next reply gives them.
        sdk.pics = { 'tansy.webp': 'PNG1', 'fenna.webp': 'PNG2', 'orrin.webp': 'PNG2', 'yunyun.webp': 'PNG2' };
        const fillAt = await say('Fenna nods at the gate.');
        await turn();
        await sleep(300);
        out.afterPictures = Object.fromEntries(['Yunyun', 'Fenna', 'Tansy', 'Orrin', 'Maro'].map(name => [name, shape(name)]));
        out.fillUploads = uploads.slice();
        out.checkpointReasons = (api.getState().checkpoints || []).map(item => item.reason);
        out.sidecarHoldsImage = [...mockState.files.entries()].some(([path, text]) => /\/npc-state-delta-[a-z0-9]+\.json$/.test(path) && text.includes('ChwGA60e6kg') || text.includes('EhQGAhKmMIQ'));
        out.fennaFilled = byName('Fenna').portrait;
        out.countAfterFill = api.getState().npcs.length;

        // A swipe of the very reply the picture was given at leaves it exact: the same record, nothing written again.
        const stamp = JSON.stringify(byName('Fenna').portrait);
        const chat = mockState.context.chat;
        const head = chat.length - 1;
        chat[head] = { is_user: false, is_system: false, name: 'Megumin', swipe_id: 1, mes: 'Fenna looks away.', swipes: [chat[head].mes, 'Fenna looks away.'] };
        mockState.swipeState = 'swiping';
        eventSource.emit('message_swiped', head);
        await sleep(200);
        eventSource.emit('message_received', head);
        await sleep(300);
        mockState.swipeState = 'none';
        await sleep(300);
        await turn();
        out.afterSwipe = { Fenna: shape('Fenna'), Tansy: shape('Tansy'), Orrin: shape('Orrin'), count: api.getState().npcs.length, uploads: uploads.length, same: JSON.stringify(byName('Fenna').portrait) === stamp };

        // Once only: another reply neither reads nor writes anything.
        await say('Nothing happens.');
        await turn();
        out.again = { uploads: uploads.length, same: JSON.stringify(byName('Fenna').portrait) === stamp };

        // Maro's picture is imported while nothing is said: the host's head event (a chat reopened, the head moving) is enough.
        out.maroBefore = shape('Maro');
        sdk.pics = { ...sdk.pics, 'maro.webp': 'PNG1' };
        out.maroStill = shape('Maro');
        await sdk.handlers.head?.({ index: head });
        await sleep(400);
        out.maroAfter = shape('Maro');
        out.uploadsEnd = uploads.length;
        out.fillAt = fillAt; out.metAt = metAt;
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], people: [], made: {}, handlers: {}, present: [], pics: {},
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.handlers[name] = fn; return () => {}; },
            turn: async turn => { await sdk.handlers.turn?.(turn); },
            command: async type => {
                if (type === 'npc.tick') for (const person of sdk.people) if (person.met && person.entry) sdk.made[person.key] = { name: person.name };
                return { ok: true, receipt: { summary: '' } };
            },
            query: (name, args) => (name === 'director.cast' ? structuredClone(sdk.people)
                : name === 'npc.castMade' ? structuredClone(sdk.made)
                : name === 'packs.list' ? [{ id: 'ersveil', name: 'Ersveil', version: '1.0.0' }]
                : name === 'packs.portrait' ? (args?.pack === 'ersveil' ? ({ PNG1: 'PNG1DATA', PNG2: 'PNG2DATA' }[sdk.pics[args.file]] ?? null) : null)
                : name === 'scene.present' ? [] : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const source = scenario.toString().replace("'MINE'", JSON.stringify(mine).replaceAll('"', "'"));
    const preludeSource = prelude.toString().replace("'PNG1DATA'", JSON.stringify(png1)).replace("'PNG2DATA'", JSON.stringify(png2));
    const hosted = scenarioOutput(runHostScenario('cast-portrait-backfill', { toString: () => preludeSource }, { toString: () => source }));
    const none = { has: false, path: null, dataUrl: false, sourceName: null, fingerprint: false, removed: false, cast: true };
    // At the meeting: only the person whose picture was there has it; the others are made without.
    assert.equal(hosted.afterMeeting.Tansy.has, true, 'Tansy was made with her picture');
    assert.deepEqual(hosted.afterMeeting.Fenna, none, 'Fenna was made while her picture was missing');
    assert.deepEqual(hosted.afterMeeting.Maro, none);
    assert.deepEqual(hosted.afterMeeting.Yunyun, { ...none, cast: false }, 'a dossier a scan made is not a cast dossier');
    assert.equal(hosted.uploadsAtMeeting, 1);
    // The reader's own and removed pictures.
    assert.equal(hosted.removeTansy, true);
    assert.deepEqual(hosted.beforePictures.Fenna, none, 'nothing in the pack yet: nothing is filled');
    assert.equal(hosted.uploadsBefore, 1);
    assert.deepEqual(hosted.beforePictures.Tansy, { ...none, removed: true }, 'Tansy\'s removal is recorded');
    // The pictures arrive.
    const fenna = hosted.afterPictures.Fenna;
    assert.match(fenna.path, /^\/user\/files\/npc-state-delta-portrait-[a-f0-9]{40}\.png$/, 'Fenna now has her picture, as a file named by its content');
    assert.deepEqual([fenna.dataUrl, fenna.sourceName, fenna.fingerprint], [false, 'fenna.webp', true]);
    assert.deepEqual(hosted.afterPictures.Maro, none, 'Maro\'s picture is still not in the pack');
    assert.equal(hosted.afterPictures.Orrin.dataUrl, true, 'Orrin keeps the picture the reader set');
    assert.equal(hosted.afterPictures.Orrin.sourceName, 'mine.png');
    assert.equal(hosted.afterPictures.Orrin.path, null);
    assert.deepEqual(hosted.afterPictures.Tansy, { ...none, removed: true }, 'Tansy\'s removed picture is not put back');
    assert.deepEqual(hosted.afterPictures.Yunyun, { ...none, cast: false }, 'Yunyun\'s dossier is not a cast dossier: no picture, though the pack has one for her');
    assert.equal(hosted.fillUploads.length, 2, 'the first picture was written at the meeting; Fenna\'s is the second file');
    assert.equal(hosted.sidecarHoldsImage, false, 'the chat\'s saved state holds none of the pack\'s pictures (the reader\'s own stays as it always was)');
    assert.equal(hosted.countAfterFill, 5, 'no dossier was made or lost');
    assert.ok(hosted.checkpointReasons.includes('cast-portrait'), 'the change is checkpointed at its reply like any dossier change');
    // Once only; a swipe is exact.
    assert.equal(hosted.afterSwipe.Fenna.path, fenna.path, 'a swipe of its reply keeps the picture');
    assert.equal(hosted.afterSwipe.same, true, 'the very same record');
    assert.equal(hosted.afterSwipe.uploads, 2, 'and nothing is written again');
    assert.equal(hosted.afterSwipe.count, 5);
    assert.equal(hosted.afterSwipe.Orrin.dataUrl, true);
    assert.equal(hosted.afterSwipe.Tansy.removed, true, 'the removal is still recorded after the swipe');
    assert.deepEqual(hosted.again, { uploads: 2, same: true }, 'a later reply reads and writes nothing');
    // The head event gives a picture imported later without a reply.
    assert.deepEqual(hosted.maroBefore, none);
    assert.deepEqual(hosted.maroStill, none, 'the pack alone changes nothing until the host says something happened');
    assert.equal(hosted.maroAfter.sourceName, 'maro.webp');
    assert.equal(hosted.maroAfter.has, true);
    assert.equal(hosted.uploadsEnd, 2, 'Maro\'s picture is the first one again: its file already stands');
});

test('index.js wiring: the picture sync is asked for by the adapter, runs when a chat opens, and a removal is recorded (source)', () => {
    const index = runtimeSource();
    assert.match(index, /v2\.startStorySuiteV2\(\{[^}]*castSync, castPortraitDue/, 'the adapter can ask whether there is a picture to give');
    assert.match(index, /commitBranchCheckpoint\(working, messageId, 'cast-portrait'\)/, 'the picture is checkpointed at its reply');
    assert.match(index, /castPortraitDue\(\)\) castSync\(\)/, 'a chat opened gives the picture too');
    assert.match(index, /markCastPortraitRemoved\(npc\)/, 'the reader\'s removal is recorded');
    const adapter = adapterSource();
    assert.match(adapter, /sdk\.on\('head', portraitFill\)/, 'and so does the host\'s head event');
    assert.doesNotMatch(adapter, /sdkRef\.command\(['"]director\./, 'Delta never writes to Story Director');
});

// ---- `behaviour`, `mannerisms`, `withYou` (5 Nov, the user's decision: the cast form's "How they behave") ----

const LEVER_LABELS = ['Disposition', 'Care', 'Expression', 'Independence', 'Conflict', 'Threat', 'Analytical', 'Presentation', 'Mercy', 'Loyalty', 'Drive', 'Honesty'];
const TEMIWA_BEHAVIOUR = [
    'Mercy: low - stitches those who annoy her slower than she must, and enjoys it',
    'Care: high - fiercely protective of the dead',
    'Loyalty: high - once someone matters she cannot let go',
    'Independence: high - refuses to be used; balks at being anyone\'s tool',
    'Presentation: high - knows how people look at her and plays on it',
];
const TEMIWA_MANNERISMS = ['A weary smirk when she catches someone looking', 'Laughs a little too easily at pain'];
const TEMIWA_WITH_YOU = 'Jealous once you matter: cold cruelty to rivals, sudden sweetness to you (the sweetness is scarier). Tension rises when you\'re with other companions; losing you would be losing a body to the Veil.';
const BEHAVED = { ...TEMIWA_ENTRY, behaviour: TEMIWA_BEHAVIOUR, mannerisms: TEMIWA_MANNERISMS, withYou: TEMIWA_WITH_YOU };
const applyTemiwa = entry => applyCastEntry(createNpcRecord('Temiwa', []), temiwaPerson(entry), { packName: 'Ersveil' });

test('behaviour, mannerisms and withYou are read: levers in Delta\'s form, lists bounded, texts cut; absent they are empty', () => {
    const entry = normalizeEntry(BEHAVED);
    assert.deepEqual(entry.behaviour, TEMIWA_BEHAVIOUR);
    assert.deepEqual(entry.mannerisms, TEMIWA_MANNERISMS);
    assert.equal(entry.withYou, TEMIWA_WITH_YOU);
    const none = normalizeEntry(TEMIWA_ENTRY);
    assert.deepEqual([none.behaviour, none.mannerisms, none.withYou], [[], [], '']);
    assert.equal(normalizeEntry({ ...TEMIWA_ENTRY, withYou: 'w'.repeat(500) }).withYou.length, 400);
    assert.deepEqual(normalizeEntry({ ...TEMIWA_ENTRY, behaviour: 'Care: high - kind', mannerisms: { a: 1 } }).behaviour, [], 'not a list: nothing');
    // The level is read in any case and written low|medium|high; a dash of any kind separates the effect.
    assert.deepEqual(normalizeEntry({ ...TEMIWA_ENTRY, behaviour: ['care : HIGH – kind to the sick', 'Mercy: Medium — spares the beaten'] }).behaviour,
        ['care: high - kind to the sick', 'Mercy: medium - spares the beaten']);
});

test('bad items are skipped, the good ones stay in order: no level, an unknown label, a habit, about the player or a named person, a repeat of a kind, a non-string', () => {
    const behaviour = normalizeEntry({ ...TEMIWA_ENTRY, behaviour: [
        'Care: high - protective of the dead',
        'Care: extreme - too much', 'Care - no level at all', 'Weather: low - gloomy', 'Habits: high - sharpens knives',
        'Conflict: high - cold with the player', 'Loyalty: high - devoted toward Marris',
        'Care: low - a second care lever merges with the first', 42, null, { lever: 'Drive' },
        'Drive: medium - keeps going',
    ] }).behaviour;
    assert.deepEqual(behaviour, ['Care: high - protective of the dead', 'Drive: medium - keeps going']);
    const many = LEVER_LABELS.map(label => `${label}: low - an effect`);
    assert.equal(normalizeEntry({ ...TEMIWA_ENTRY, behaviour: many }).behaviour.length, 6, 'at most six');
    assert.ok(normalizeEntry({ ...TEMIWA_ENTRY, behaviour: [`Care: high - ${'long '.repeat(80)}`] }).behaviour[0].length <= 180, 'a lever is cut at Delta\'s 180');
    const habits = normalizeEntry({ ...TEMIWA_ENTRY, mannerisms: ['Taps her pendant', 42, '', 'Taps her pendant', 'Hums a river song', 'Chews willow bark', 'Folds her sash', 'Counts the exits', `${'x '.repeat(120)}`] }).mannerisms;
    assert.deepEqual(habits, ['Taps her pendant', 'Hums a river song', 'Chews willow bark', 'Folds her sash'], 'a repeat is skipped, at most four');
    assert.ok(normalizeEntry({ ...TEMIWA_ENTRY, mannerisms: ['y '.repeat(200)] }).mannerisms[0].length <= 160, 'a mannerism is cut at Delta\'s 160');
});

test('every lever form survives normalizeNpcRecord unchanged: each of the 12 labels at each level, and the six together', () => {
    for (const label of LEVER_LABELS) {
        for (const level of ['low', 'medium', 'high']) {
            const line = `${label}: ${level} - holds a thought, "quoted"; a second clause, with commas (and brackets) — and a dash`;
            const entry = normalizeEntry({ ...TEMIWA_ENTRY, behaviour: [line] });
            assert.deepEqual(entry.behaviour, [line], `${label} ${level} is read as written`);
            const made = normalizeNpcRecord(applyTemiwa({ ...TEMIWA_ENTRY, behaviour: [line] }));
            assert.deepEqual(made.behaviorProfile, [line], `${label} ${level} is stored as written`);
            assert.deepEqual(normalizeNpcRecord(structuredClone(made)).behaviorProfile, [line], `${label} ${level} on the next load`);
        }
    }
    const six = LEVER_LABELS.slice(0, 6).map((label, index) => `${label}: ${['low', 'medium', 'high'][index % 3]} - the ${label.toLowerCase()} effect`);
    assert.deepEqual(normalizeNpcRecord(applyTemiwa({ ...TEMIWA_ENTRY, behaviour: six })).behaviorProfile, six);
    const other = LEVER_LABELS.slice(6).map((label, index) => `${label}: ${['high', 'medium', 'low'][index % 3]} - the ${label.toLowerCase()} effect`);
    assert.deepEqual(normalizeNpcRecord(applyTemiwa({ ...TEMIWA_ENTRY, behaviour: other })).behaviorProfile, other);
    assert.deepEqual(normalizeNpcRecord(applyTemiwa(BEHAVED)).behaviorProfile, TEMIWA_BEHAVIOUR);
    assert.deepEqual(normalizeNpcRecord(applyTemiwa(BEHAVED)).mannerisms, TEMIWA_MANNERISMS);
});

test('the made dossier: levers to the behavioral profile, mannerisms to mannerisms, withYou to the relationship summary; castFrom.first keeps them', () => {
    const made = applyTemiwa(BEHAVED);
    assert.deepEqual(made.behaviorProfile, TEMIWA_BEHAVIOUR);
    assert.deepEqual(made.mannerisms, TEMIWA_MANNERISMS);
    assert.equal(made.relationshipSummary, TEMIWA_WITH_YOU);
    assert.deepEqual(made.castFrom.first.behaviorProfile, TEMIWA_BEHAVIOUR);
    assert.deepEqual(made.castFrom.first.mannerisms, TEMIWA_MANNERISMS);
    assert.equal(made.castFrom.first.relationshipSummary, undefined, 'the summary is not a kept pack word: it is compacted and calibrated like any summary');
    assert.equal(made.personality, '', 'the personality is the personality field alone');
    const stored = normalizeProduction(made);
    assert.ok(stored.relationshipSummary.length <= 320 && /^Jealous once you matter/.test(stored.relationshipSummary), 'withYou is stored as any summary is (at most 320)');
});

test('an entry without the fields makes the dossier it made before: nothing set, no new castFrom.first keys', () => {
    const made = applyTemiwa(TEMIWA_ENTRY);
    const base = createNpcRecord('Temiwa', []);
    assert.deepEqual([made.behaviorProfile, made.mannerisms, made.relationshipSummary], [base.behaviorProfile, base.mannerisms, base.relationshipSummary]);
    assert.deepEqual(Object.keys(made.castFrom.first).sort(), ['appearance', 'overallAppearance']);
    const partial = applyTemiwa({ ...TEMIWA_ENTRY, withYou: 'Wary of you.' });
    assert.deepEqual([partial.behaviorProfile, partial.mannerisms], [base.behaviorProfile, base.mannerisms]);
    assert.deepEqual(Object.keys(partial.castFrom.first).sort(), ['appearance', 'overallAppearance']);
    // Fenna's entry (no wears, no new fields) is as it was.
    const [p] = normalizeCast([person()], dateText);
    assert.deepEqual(Object.keys(applyCastEntry(createNpcRecord('Fenna', []), p).castFrom.first).sort(), ['background', 'overallAppearance', 'personality', 'speech']);
});

const LEAK = 'Jealous once you matter: cold cruelty to rivals, sudden sweetness to you. She would do anything for you and cannot live without you.';
const away = npc => ({ ...npc, present: false });
const referenceLine = npc => buildInjection([away(npc)], 'People talk about Temiwa at the inn.', 3, 3).split('\n').find(line => line.includes('mentioned, not present')) ?? '';

test('round 2: the pack\'s withYou is stored calibrated and compacted like any summary, once and for good (no uncalibrated exception)', () => {
    const made = normalizeProduction(applyTemiwa({ ...TEMIWA_ENTRY, withYou: LEAK }));
    assert.doesNotMatch(made.relationshipSummary, /would do anything for|cannot live without/i, 'calibrated against the 0 numbers');
    assert.match(made.relationshipSummary, /cares deeply for you/);
    assert.equal(normalizeProduction(structuredClone(made)).relationshipSummary, made.relationshipSummary, 'the same on the next load');
    const long = normalizeProduction(applyTemiwa({ ...TEMIWA_ENTRY, withYou: `${'She keeps a ledger of every kindness you have shown her. '.repeat(8)}`.trim().slice(0, 400) }));
    assert.ok(long.relationshipSummary.length <= 320, 'a long withYou is compacted to the stored limit, as any summary');
    // The first scanner merge (a mood-only update) leaves the stored summary exactly as it was stored at the first meeting.
    const merged = mergeScanResult({ npcs: [made], turn: 2 }, { npcs: [{ id: made.id, name: made.name, mood: 'calm' }] }, { turn: 3, sourceMessageId: 9 }).state.npcs[0];
    assert.equal(merged.relationshipSummary, made.relationshipSummary, 'the first merge changes nothing in the summary');
});

test('round 2 (reviewer\'s leak): a named-but-away cast person never shows an unsupported claim; present shows the neutral line; a supported summary shows in both', () => {
    const made = normalizeProduction(applyTemiwa({ ...TEMIWA_ENTRY, withYou: LEAK }));
    const scene = 'Temiwa stands at the north gate.';
    assert.match(buildInjection([{ ...made, present: true }], scene, 3, 3), /TOWARD PLAYER \(secondary\): relationship remains mostly neutral/);
    const line = referenceLine(made);
    assert.match(line, /Temiwa \(mentioned, not present/);
    assert.doesNotMatch(line, /toward the player|Jealous|anything for|live without/i);
    const mild = normalizeProduction(applyTemiwa({ ...TEMIWA_ENTRY, withYou: 'Wary of you, but curious; tests your patience before she trusts.' }));
    assert.match(buildInjection([{ ...mild, present: true }], scene, 3, 3), /TOWARD PLAYER \(secondary\): Wary of you, but curious/);
    assert.match(referenceLine(mild), /toward the player: Wary of you, but curious/);
});

test('round 2: a dossier that is not from the cast keeps its reference line exactly as stored (no calibration, no gate)', () => {
    const plain = normalizeProduction({ ...createNpcRecord('Temiwa', []), role: 'courier', homeBase: 'gate', relationshipSummary: 'Jealous once you matter: cold cruelty to rivals.' });
    assert.match(referenceLine(plain), /toward the player: Jealous once you matter: cold cruelty to rivals\./);
});

test('the pack\'s levers and mannerisms are kept whole while the stored list is the pack\'s list; a changed list is normalized like any other', () => {
    const made = normalizeProduction(applyTemiwa(BEHAVED));
    // A list that Delta's normalizer would shorten stays when it is the recorded pack list.
    const odd = { ...made, behaviorProfile: ['Care: high - kind', 'Care: low - merges into the first'], mannerisms: ['Taps her pendant twice', 'Taps her pendant twice, again'], castFrom: { ...made.castFrom, first: { behaviorProfile: ['Care: high - kind', 'Care: low - merges into the first'], mannerisms: ['Taps her pendant twice', 'Taps her pendant twice, again'] } } };
    assert.equal(normalizeProduction(odd).behaviorProfile.length, 2);
    assert.equal(normalizeProduction(odd).mannerisms.length, 2);
    // After the scanner or the reader changes a list the normal rules apply again.
    const changed = normalizeProduction({ ...odd, behaviorProfile: [...odd.behaviorProfile, 'Drive: high - keeps going'], mannerisms: [...odd.mannerisms, 'Hums'] });
    assert.equal(changed.behaviorProfile.length, 2, 'the two Care levers merge: normal compaction');
    assert.equal(changed.mannerisms.length < 3, true);
    // Recorded pack words under another key do not hold a list.
    const wrongKey = normalizeProduction({ ...odd, castFrom: { ...odd.castFrom, first: { mannerisms: ['Taps her pendant twice', 'Taps her pendant twice, again'] } } });
    assert.equal(wrongKey.behaviorProfile.length, 1);
});

test('a scanner refinement of the cast levers and mannerisms applies as for any dossier (no new rule)', () => {
    const made = normalizeProduction(applyTemiwa(BEHAVED));
    const scene = 'Temiwa hummed over the stitches, tapping her pendant, then laughed too easily when the boy cried out; she waits until the dead are covered before she eats.';
    const out = mergeScanResult({ npcs: [made], turn: 2 }, { profileUpdates: [{
        id: made.id, evidence: { mannerisms: [scene] }, mannerisms: [...TEMIWA_MANNERISMS, 'Hums over her stitches'], mannerismState: 'evolve',
        developmentReason: 'She hums while stitching.',
    }] }, { turn: 3, sourceMessageId: 9, developmentContext: scene }).state.npcs[0];
    assert.deepEqual(out.behaviorProfile, TEMIWA_BEHAVIOUR, 'untouched fields stay');
    assert.ok(out.mannerisms.length >= 2);
});

test('dossiers made before are read as stored: no migration', () => {
    const before = { ...createNpcRecord('Fenna', []), personality: 'Stubborn.', behaviorProfile: ['Care: practical - helps through actions'], mannerisms: ['Coils rope'], relationshipSummary: 'She trusts you a little.', castFrom: { key: 'ersveil:fenna', first: { personality: 'Stubborn.' } } };
    const stored = normalizeProduction(before);
    assert.deepEqual([stored.behaviorProfile, stored.mannerisms, stored.relationshipSummary], [before.behaviorProfile, before.mannerisms, before.relationshipSummary]);
    assert.deepEqual(stored.castFrom, before.castFrom);
});

test('the narrator hears a cast person\'s levers, mannerisms and summary: injection already prints these fields, so the block only has more to print', () => {
    const plain = normalizeProduction({ ...applyTemiwa(TEMIWA_ENTRY), present: true });
    const behaved = normalizeProduction({ ...applyTemiwa(BEHAVED), present: true });
    const scene = 'Temiwa stands at the north gate.';
    const a = buildInjection([plain], scene, 3, 3);
    const b = buildInjection([behaved], scene, 3, 3);
    assert.doesNotMatch(a, /behavioral profile|mannerisms:/);
    assert.match(b, /mannerisms: A weary smirk when she catches someone looking, Laughs a little too easily at pain/);
    assert.match(b, /behavioral profile: /);
    assert.match(b, /Care: high/);
    // The summary is stored whole, but injection is unchanged: it prints the summary only while it agrees with the numbers (a
    // "jealous once you matter" claim at the starting 0s does not), and otherwise the numbers' own guidance, as for any dossier.
    assert.match(b, /TOWARD PLAYER \(secondary\): relationship remains mostly neutral/);
    const mild = normalizeProduction({ ...applyTemiwa({ ...BEHAVED, withYou: 'Wary of you, but curious; tests your patience before she trusts.' }), present: true });
    assert.match(buildInjection([mild], scene, 3, 3), /TOWARD PLAYER \(secondary\): Wary of you, but curious; tests your patience before she trusts\./);
    process.stdout.write(`\n[injection with the fields]\n${b}\n`);
});

// ---- the People field fills species, gender and ages ----

test('parsePeople reads each People form into the shapes the dossier stores', () => {
    const empty = { species: '', gender: '', age: '', apparentAge: '' };
    assert.deepEqual(parsePeople('Dogfolk woman, 21'), { ...empty, species: 'Dogfolk', gender: 'female', age: '21' });
    assert.deepEqual(parsePeople('Dwelf, 58 (looks about 25)'), { ...empty, species: 'Dwelf', age: '58', apparentAge: '~25' });
    assert.deepEqual(parsePeople('Elf, about 240 (looks about 35)'), { ...empty, species: 'Elf', age: 'about 240', apparentAge: '~35' });
    assert.deepEqual(parsePeople('Fairy, about 160'), { ...empty, species: 'Fairy', age: 'about 160' });
    assert.deepEqual(parsePeople('Spiritfolk, formed about 300 years ago (looks about 30)'), { ...empty, species: 'Spiritfolk', age: 'about 300', apparentAge: '~30' });
    assert.deepEqual(parsePeople('Human man, 40'), { ...empty, species: 'Human', gender: 'male', age: '40' });
    assert.equal(parsePeople('Orc, 30').gender, '', 'gender is never inferred');
});

test('parsePeople leaves unparsable text alone: nothing is guessed', () => {
    const none = { species: '', gender: '', age: '', apparentAge: '' };
    for (const text of ['', 'Wanders the marsh at night', 'Elf, ancient', 'Elf, young (looks about 20 or so)', '12, 21', 'Elf']) assert.deepEqual(parsePeople(text), none, text);
});

test('a made dossier takes species, gender and age from People, and keeps People as a custom field', () => {
    const [p] = normalizeCast([person({ entry: { ...FENNA_ENTRY, fields: { People: 'Elf woman, about 240 (looks about 35)' } } })], dateText);
    const made = normalizeProduction(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    assert.deepEqual([made.species, made.gender, made.age, made.apparentAge], ['Elf', 'female', 'about 240', '~35']);
    assert.equal(made.customFields.People, 'Elf woman, about 240 (looks about 35)');
    const again = normalizeProduction(applyCastEntry(createNpcRecord('Fenna', []), p, { packName: 'Ersveil' }));
    const { createdAt, updatedAt, ...sameAgain } = again, { createdAt: c0, updatedAt: u0, ...sameMade } = made;
    assert.deepEqual(sameAgain, sameMade, 'the same entry gives the same dossier (replay and import)');
});

test('People never overwrites a value the record already has, and unparsable People changes nothing', () => {
    const [p] = normalizeCast([person({ entry: { ...FENNA_ENTRY, fields: { People: 'Elf woman, 30' } } })], dateText);
    const base = { ...createNpcRecord('Fenna', []), species: 'Human', age: '41' };
    const made = applyCastEntry(base, p, { packName: 'Ersveil' });
    assert.deepEqual([made.species, made.gender, made.age], ['Human', 'female', '41']);
    const [q] = normalizeCast([person({ entry: { ...FENNA_ENTRY, fields: { People: 'Roams the hills' } } })], dateText);
    const plain = applyCastEntry(createNpcRecord('Fenna', []), q, { packName: 'Ersveil' });
    assert.deepEqual([plain.species, plain.gender, plain.age, plain.apparentAge], ['', '', '', '']);
    assert.equal(plain.customFields.People, 'Roams the hills');
});

test('the adapter reads Story Block\'s party.levels as it answers, and null when the query is not there or answers null', async () => {
    const party = answer => ({ id: 'zz-party', name: 'Party (stand-in)', version: '0.0.0-test', queries: { 'party.levels': () => answer } });
    const rows = [{ id: 'a', name: 'Mira', level: 5, left: false }, { id: 'b', name: 'Bo', level: 3, left: true }];
    assert.deepEqual((await suite({ modules: [party(rows)] })).adapter.partyLevelsAnswer(), rows, 'members who left are in the answer; the hosted part drops them');
    assert.equal((await suite({ modules: [party(null)] })).adapter.partyLevelsAnswer(), null, 'RPG off: null');
    assert.equal((await suite({ modules: [director()] })).adapter.partyLevelsAnswer(), null, 'no such query: as today');
});

test('mood: a person met from the cast starts at the resting mood their pack personality gives (temperament, not 0), stored with the record', async () => {
    const calm = await suite({ features: { 'npc-state-delta.mood-pull': true } });
    await calm.world([castRow({ entry: { ...structuredClone(FENNA_ENTRY), personality: 'Calm, confident and unhurried.' } })]);
    await calm.say(['~ meet Fenna']);
    const mood = Object.values(calm.host.head().domains.npc.npcs).find(record => record.name === 'Fenna')?.mood;
    assert.deepEqual([mood?.v, mood?.a, mood?.d, mood?.rest], [0, -2, 1, { v: 0, a: -2, d: 1 }]);
    assert.deepEqual(validateNpcSlice(calm.host.head().domains.npc), []);
    const plain = await suite({ features: { 'npc-state-delta.mood-pull': true } });
    await plain.world([castRow({ entry: { ...structuredClone(FENNA_ENTRY), personality: 'Likes ferries.' } })]);
    await plain.say(['~ meet Fenna']);
    assert.equal(Object.values(plain.host.head().domains.npc.npcs).find(record => record.name === 'Fenna')?.mood, undefined, 'no temperament words: no mood until an event');
});
