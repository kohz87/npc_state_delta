import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from './vendor/story-block/testkit/index.js';
import { buildInjection, createNpcRecord, mergeScanResult } from '../core.js';
import { keyAwayHtml, keyProjection, projectDossierState } from '../dossier-ui.js';
import { dossierRowNodes } from '../story-block-tabs.js';
import { storyMinuteText } from '../calendar.js';
import { FEATURE_DRIFT, FEATURE_STAGES, KEY_PEOPLE_QUERY } from '../src/npc-meters.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import {
    AWAY_LOCKED_FIELDS, RECENT_REPLIES, awayNpcIds, awayRange, findKeyEntry, isAway, isKey, keyView,
    lockAwayNpcs, normalizeKeyPeople, observeKeyAway, returnNote,
} from '../src/key-people.js';
import { fakeDocument } from './helpers/fake-dom.js';
import { runHostScenario } from './helpers/host-scenario.js';

// Key people (the user's decision, 1 Nov): Story Director owns who is a key person and where they are; Delta reads
// its query `director.keyPeople` and shows it (badge, "While away", ★ on cards and in the library), tells the narrator
// the summary once when the person comes back, and holds a key person's stable fields still while they are away.
// Without Story Director (or one without the query) nothing changes anywhere.

const REN_AWAY = { doing: 'scouting the north road', since: 'Gw 12', back: 'Gw 18', steps: [{ date: 'Gw 14', text: 'reached Wolfmere Outpost' }, { date: 'Gw 16', text: 'met the toll-gang at the weir' }] };
const key = (name, extra = {}) => ({ name, aliases: [], here: true, away: null, ...extra });
const npc = (name, extra = {}) => ({ ...createNpcRecord(name, []), id: `npc_${name.toLowerCase()}`, ...extra });

// ---- the query's answer ----

test('the answer is cleaned: names, aliases, dates and steps are text of a bounded size; a removed person has no absence', () => {
    assert.equal(KEY_PEOPLE_QUERY, 'director.keyPeople');
    assert.deepEqual(normalizeKeyPeople(null), []);
    assert.deepEqual(normalizeKeyPeople({ name: 'Ren' }), []);
    const list = normalizeKeyPeople([
        { name: '  Ren \n', aliases: ['The Scout', '', 5], here: false, away: { doing: ' scouting ', since: 'Gw 12', back: 12, steps: [{ date: 'Gw 14', text: 'reached Wolfmere' }, { date: 'x', text: '' }, 'junk'] } },
        { name: 'ren' },
        { name: 'Odda', here: true, away: null },
        { name: 'Mara', away: { doing: 'x' }, removed: { reason: 'died', on: 'Gw 18' } },
        null, { name: '' },
    ]);
    assert.deepEqual(list.map(entry => entry.name), ['Ren', 'Odda', 'Mara'], 'a repeated name and junk rows are dropped');
    assert.deepEqual(list[0].aliases, ['The Scout', '5']);
    assert.deepEqual(list[0].away, { doing: 'scouting', since: 'Gw 12', back: '', steps: [{ date: 'Gw 14', text: 'reached Wolfmere' }] });
    assert.equal(list[1].away, null);
    assert.equal(list[2].away, null, 'a removed person is not away');
    assert.deepEqual(list[2].removed, { reason: 'died', on: 'Gw 18' });
    assert.equal(isKey(list[2]), false);
    assert.equal(isAway(list[0]), true);
    assert.equal(isAway(list[1]), false);
    const long = normalizeKeyPeople([{ name: 'Ren', away: { doing: 'x'.repeat(900), steps: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, text: `step ${i}` })) } }])[0];
    assert.equal(long.away.doing.length, 200);
    assert.equal(long.away.steps.length, 12);
    assert.equal(long.away.steps.at(-1).text, 'step 29', 'the newest steps are kept');
    assert.equal(normalizeKeyPeople(Array.from({ length: 80 }, (_, i) => ({ name: `P${i}` }))).length, 50);
});

test('Story Director sends story minutes: they are written as dates on its calendar; no calendar means no text, words are kept', () => {
    const DAY = 1440;
    const calendar = { era: 'CY', months: [{ name: 'Goldwane', days: 30 }, { name: 'Bluewatch', days: 30 }], leapYears: false };
    const text = minutes => storyMinuteText(minutes, calendar);
    assert.equal(text(11 * DAY), 'Goldwane 12');
    assert.equal(text(30 * DAY + 3 * DAY + 600), 'Bluewatch 4', 'the clock time is dropped; the month rolls over');
    assert.equal(text(null), '');
    assert.equal(text(1.5), '');
    assert.equal(storyMinuteText(0), 'January 1', 'no calendar: Gregorian, as Story Director falls back');
    assert.equal(storyMinuteText(60 * DAY, { months: [] }), 'March 1', 'year 0 is a leap year');
    assert.equal(storyMinuteText(5, { months: [{ name: '', days: 30 }] }), '');

    const away = { doing: 'scouting', since: 11 * DAY, back: 17 * DAY, steps: [{ date: 13 * DAY, text: 'reached Wolfmere' }, { date: null, text: 'a step with no date' }] };
    const [ren] = normalizeKeyPeople([{ name: 'Ren', here: false, away }], text);
    assert.deepEqual(ren.away, { doing: 'scouting', since: 'Goldwane 12', back: 'Goldwane 18', steps: [{ date: 'Goldwane 14', text: 'reached Wolfmere' }, { date: '', text: 'a step with no date' }] });
    assert.equal(returnNote(ren.away), 'WHILE AWAY, NOW BACK (Goldwane 12 – Goldwane 18): scouting; Goldwane 14: reached Wolfmere; a step with no date');
    const [bare] = normalizeKeyPeople([{ name: 'Ren', away }]);
    assert.deepEqual([bare.away.since, bare.away.back, bare.away.steps[0].date], ['', '', ''], 'no way to write a minute: no text, never a bare number');
    assert.equal(normalizeKeyPeople([{ name: 'Mara', removed: { reason: 'died', on: 18 * DAY } }], text)[0].removed.on, 'Goldwane 19');
    assert.equal(normalizeKeyPeople([{ name: 'Ren', away: { doing: 'x', since: 'Gw 12', back: null } }])[0].away.since, 'Gw 12', 'a date already in words is kept');
});

test('a dossier is matched to a key person by name or alias, either side, any case', () => {
    const list = normalizeKeyPeople([key('Ren', { aliases: ['The Scout'] }), key('Odda')]);
    assert.equal(findKeyEntry(list, { name: 'ren' })?.name, 'Ren');
    assert.equal(findKeyEntry(list, { name: 'Renato', aliases: ['the scout'] })?.name, 'Ren');
    assert.equal(findKeyEntry(list, { name: 'Oddy', aliases: ['ODDA'] })?.name, 'Odda');
    assert.equal(findKeyEntry(list, { name: 'Mira' }), null);
    assert.equal(findKeyEntry([], { name: 'Ren' }), null);
    assert.equal(findKeyEntry(null, { name: 'Ren' }), null);
    const away = normalizeKeyPeople([key('Ren', { here: false, away: REN_AWAY }), key('Odda')]);
    assert.deepEqual([...awayNpcIds(away, [npc('Ren'), npc('Odda'), npc('Mira')])], ['npc_ren']);
});

// ---- the memory of the last absence ----

test('away, back, present for a few replies: the absence is kept, then dropped; a swipe back undoes the return', () => {
    const ren = npc('Ren');
    const awayList = normalizeKeyPeople([key('Ren', { here: false, away: REN_AWAY })]);
    const backList = normalizeKeyPeople([key('Ren', { here: true })]);
    let memory = {};
    const note = (list, head) => { const out = observeKeyAway(memory, list, [ren], head); memory = out.memory; return out; };

    assert.equal(note(backList, 3).changed, false, 'a key person never seen away leaves nothing');
    assert.deepEqual(memory, {});
    assert.equal(note(awayList, 4).changed, true);
    assert.equal(memory.npc_ren.returnedAt, null);
    assert.equal(keyView(awayList, memory, ren, 4).away.doing, 'scouting the north road');
    assert.equal(keyView(awayList, memory, ren, 4).recent, null);

    note(backList, 6);
    assert.equal(memory.npc_ren.returnedAt, 6, 'noticed back at reply 6');
    let view = keyView(backList, memory, ren, 6);
    assert.equal(view.away, null);
    assert.equal(view.recent.justReturned, true);
    assert.equal(view.recent.away.steps.length, 2);
    assert.equal(note(backList, 6).changed, false, 'the same reply again changes nothing');

    note(backList, 7);
    view = keyView(backList, memory, ren, 7);
    assert.equal(view.recent.justReturned, false, 'one reply later it is no longer the return');
    assert.equal(memory.npc_ren.presentReplies, 1);
    note(backList, 8);
    assert.equal(memory.npc_ren.presentReplies, 2);
    note(backList, 9);
    assert.equal(RECENT_REPLIES, 3);
    assert.deepEqual(memory, {}, 'present for three replies: the absence is dropped');
    assert.equal(keyView(backList, memory, ren, 9).recent, null);

    // Not present after the return: it waits (the section stays) until they are.
    memory = {};
    note(awayList, 4);
    note(backList.map(entry => ({ ...entry, here: false })), 5);
    note(backList.map(entry => ({ ...entry, here: false })), 6);
    note(backList.map(entry => ({ ...entry, here: false })), 7);
    assert.equal(memory.npc_ren.presentReplies, 0);
    assert.ok(keyView(backList, memory, ren, 7).recent);

    // A swipe of the return reply that no longer returns them: the answer decides again.
    memory = {};
    note(awayList, 4);
    note(backList, 6);
    note(awayList, 6);
    assert.equal(memory.npc_ren.returnedAt, null);
    assert.equal(keyView(awayList, memory, ren, 6).recent, null);
    // The head moved back before the return and the answer is "back": noticed again there.
    note(backList, 6);
    note(backList, 5);
    assert.equal(memory.npc_ren.returnedAt, 5);
    // Unpinned (not in the answer any more) or no answer at all.
    assert.deepEqual(observeKeyAway(memory, [], [ren], 8).memory, {});
    assert.equal(observeKeyAway(memory, null, [ren], 8).changed, false, 'no answer: nothing is touched');
    assert.equal(observeKeyAway(memory, backList, [ren], null).changed, false, 'no head: nothing is touched');
});

test('the summary for the narrator is one short line: where, the newest steps, within its limit', () => {
    assert.equal(awayRange(REN_AWAY), 'Gw 12 – Gw 18');
    assert.equal(awayRange({ since: 'Gw 12' }), 'since Gw 12');
    assert.equal(awayRange({ back: 'Gw 18' }), 'until Gw 18');
    assert.equal(awayRange({}), '');
    assert.equal(awayRange(null), '');
    assert.equal(returnNote(normalizeKeyPeople([key('Ren', { away: REN_AWAY })])[0].away),
        'WHILE AWAY, NOW BACK (Gw 12 – Gw 18): scouting the north road; Gw 14: reached Wolfmere Outpost; Gw 16: met the toll-gang at the weir');
    assert.equal(returnNote(null), '');
    const many = normalizeKeyPeople([key('Ren', { away: { doing: 'scouting', since: 'A', back: 'B', steps: Array.from({ length: 9 }, (_, i) => ({ date: `D${i}`, text: 'a long step that goes on and on '.repeat(3).trim() })) } })])[0].away;
    const long = returnNote(many);
    assert.ok(long.length <= 360, `within the limit (${long.length})`);
    assert.match(long, /^WHILE AWAY, NOW BACK \(A – B\): scouting; /);
    assert.match(long, /D8:/, 'the newest step is the one kept');
    assert.ok(returnNote(many, 80).length <= 80);
    assert.match(returnNote(many, 80), /^WHILE AWAY, NOW BACK \(A – B\): scouting$/, 'too short for any step: the head alone');
    assert.match(returnNote(many, 30), /…$/);
    assert.ok(returnNote(many, 30).length <= 30);
});

// ---- the narrator: once, with the dossier, within the budget ----

test('the injection gives a returned key person the summary with their block; without it the text is byte-identical', () => {
    const ren = npc('Ren', { present: true, personality: 'Dry and watchful.', role: 'Scout' });
    const mira = npc('Mira', { present: true, personality: 'Warm.', role: 'Smith' });
    const plain = buildInjection([ren, mira], 'Ren and Mira stand at the gate.', 3, 3);
    const none = buildInjection([ren, mira], 'Ren and Mira stand at the gate.', 3, 3, undefined, undefined, null, { awayNotes: null });
    assert.equal(none, plain, 'no note: exactly as before');
    assert.equal(buildInjection([ren, mira], 'Ren and Mira stand at the gate.', 3, 3, undefined, undefined, null, { awayNotes: {} }), plain);
    const note = returnNote(normalizeKeyPeople([key('Ren', { away: REN_AWAY })])[0].away);
    const text = buildInjection([ren, mira], 'Ren and Mira stand at the gate.', 3, 3, undefined, undefined, null, { awayNotes: { npc_ren: note } });
    const renLine = text.split('\n').find(line => line.startsWith('- Ren: IDENTITY'));
    const miraLine = text.split('\n').find(line => line.startsWith('- Mira: IDENTITY'));
    assert.ok(renLine.endsWith(`; ${note}`), 'the summary closes Ren\'s own block');
    assert.equal(text.split('WHILE AWAY').length - 1, 1, 'once, and only for Ren');
    assert.ok(!miraLine.includes('WHILE AWAY'));
    assert.equal(text.replace(`; ${note}`, ''), plain, 'nothing else moves');
    // It counts in the budget like the block: a tight budget still ends within it.
    const tight = buildInjection([ren, mira], 'Ren and Mira stand at the gate.', 3, 3, undefined, 512, null, { awayNotes: { npc_ren: note } });
    assert.ok(tight.length <= 512 * 4, `within the budget (${tight.length})`);
});

// ---- a scan leaves an away key person's stable fields alone ----

test('a scan leaves an away key person\'s custom fields and stable profile as they are; present people change as usual', () => {
    const fields = { personality: 'Dry and watchful.', background: 'Raised on the river docks.', mannerisms: ['taps the hilt'], customFields: { Rank: 'Scout' } };
    const ren = npc('Ren', { ...fields, manualProfileFields: ['role'] });
    const odda = npc('Odda', { ...fields });
    const state = { npcs: [ren, odda], candidates: [], turn: 1 };
    const scan = {
        npcs: ['Ren', 'Odda'].map(name => ({
            id: `npc_${name.toLowerCase()}`, name, present: true,
            personality: 'Dry and watchful, with a sudden warmth toward people who feed him.', personalityState: 'refine',
            customFields: { Rank: 'Captain' }, customFieldsReason: 'promoted to captain',
        })),
    };
    const options = { turn: 2, customFieldNames: ['Rank'], developmentContext: 'Ren and Odda were promoted to captain, and a sudden warmth showed toward people who feed him.' };

    const free = mergeScanResult(state, scan, options).state.npcs;
    assert.equal(free.find(item => item.id === 'npc_ren').customFields.Rank, 'Captain', 'without the hold the scan changes a custom field (the test is a fair one)');
    assert.match(free.find(item => item.id === 'npc_ren').personality, /sudden warmth/);

    const held = mergeScanResult(state, scan, { ...options, awayNpcIds: ['npc_ren'] }).state.npcs;
    const heldRen = held.find(item => item.id === 'npc_ren');
    const heldOdda = held.find(item => item.id === 'npc_odda');
    assert.deepEqual(heldRen.customFields, { Rank: 'Scout' }, 'custom fields held');
    assert.equal(heldRen.personality, 'Dry and watchful.', 'a stable profile field held');
    assert.equal(heldRen.background, 'Raised on the river docks.');
    assert.deepEqual(heldRen.mannerisms, ['taps the hilt']);
    assert.equal(heldOdda.customFields.Rank, 'Captain', 'someone who is present is scanned as usual');
    assert.match(heldOdda.personality, /sudden warmth/);
    assert.deepEqual(heldRen.manualProfileFields, ['role'], 'their own locks are put back: the hold is never stored');
    assert.deepEqual(heldOdda.manualProfileFields, []);

    // Back (not in the set any more): scanned as usual again.
    const back = mergeScanResult({ ...state, npcs: [heldRen, heldOdda] }, scan, { ...options, awayNpcIds: [] }).state.npcs.find(item => item.id === 'npc_ren');
    assert.equal(back.customFields.Rank, 'Captain', 'scans resume when they are present');
    assert.match(back.personality, /sudden warmth/);
});

test('the hold: only the stable profile fields and custom fields, nothing stored, nobody away means the state itself', () => {
    assert.deepEqual(AWAY_LOCKED_FIELDS, ['personality', 'speech', 'appearance', 'mannerisms', 'behaviorProfile', 'background', 'customFields']);
    const state = { npcs: [npc('Ren', { manualProfileFields: ['role'] }), npc('Odda')], turn: 1 };
    assert.equal(lockAwayNpcs(state, new Set()), null);
    assert.equal(lockAwayNpcs(state, ['npc_nobody']), null);
    const hold = lockAwayNpcs(state, ['npc_ren']);
    assert.deepEqual(hold.state.npcs[0].manualProfileFields, ['role', ...AWAY_LOCKED_FIELDS]);
    assert.deepEqual(hold.state.npcs[1], state.npcs[1]);
    assert.deepEqual(state.npcs[0].manualProfileFields, ['role'], 'the real state is untouched');
    assert.deepEqual(hold.restore(hold.state.npcs)[0].manualProfileFields, ['role']);
});

// ---- the dossier, the library, the cards ----

test('the dossier shows the badge and "While away" (live and after the return); a library row carries the ★', () => {
    const view = { name: 'Ren', here: false, away: REN_AWAY, recent: null };
    const projected = keyProjection(view);
    assert.equal(projected.away.range, 'Gw 12 – Gw 18');
    const html = keyAwayHtml(projected);
    assert.match(html, /While away · Gw 12 – Gw 18/);
    assert.match(html, /<li><b>Gw 14<\/b>: reached Wolfmere Outpost<\/li>/);
    assert.match(html, /held while they are away/);
    const back = keyAwayHtml(keyProjection({ name: 'Ren', here: true, away: null, recent: { away: REN_AWAY, justReturned: false } }));
    assert.match(back, /While away · Gw 12 – Gw 18/);
    assert.match(back, /They are back\./);
    assert.equal(keyAwayHtml(keyProjection({ name: 'Ren', here: true, away: null, recent: null })), '', 'a key person who is here has no section');
    assert.equal(keyProjection(null), null);
    // Markup in the story's words is text.
    const hostile = keyAwayHtml(keyProjection({ here: false, away: { doing: '<img src=x>', steps: [{ date: '<b>', text: '<script>' }] } }));
    assert.doesNotMatch(hostile, /<img|<script/);
    assert.match(hostile, /&lt;img src=x&gt;/);
    assert.match(hostile, /<li><b>&lt;b&gt;<\/b>: &lt;script&gt;<\/li>/);

    const state = { npcs: [npc('Ren', { present: false }), npc('Odda', { present: true })], keyViews: { npc_ren: view } };
    const projection = projectDossierState(state);
    assert.equal(projection.npcs.find(item => item.id === 'npc_ren').key.away.doing, 'scouting the north road');
    assert.equal(projection.npcs.find(item => item.id === 'npc_odda').key, undefined);
    assert.deepEqual(projection.index.map(row => [row.id, row.key === true]).sort(), [['npc_odda', false], ['npc_ren', true]]);
    assert.equal(projectDossierState({ npcs: [npc('Ren')] }).npcs[0].key, undefined, 'no key people: the projection is as before');

    const rows = dossierRowNodes([{ id: 'npc_ren', name: 'Ren', role: 'Scout', statusLabel: 'Off-screen', key: true }, { id: 'npc_odda', name: 'Odda', role: '', statusLabel: '' }], fakeDocument())
        .map(node => node.serialize());
    assert.match(rows[0], /<b class="ss-listcard-title">Ren<span class="npc-state-delta-key-star" title="Key person" aria-label="Key person"> ★<\/span><\/b>/);
    assert.doesNotMatch(rows[1], /key-star/);
});

test('index.js wiring: the card tag, the badge data, the one-time note, the scan hold and the memory (source)', () => {
    const index = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
    assert.match(index, /\$\{isKeyNpc\(npc\) \? '<span class="npc-state-delta-key-tag" title="Key person \(Story Director\)">★ Key<\/span>' : ''\}/);
    assert.match(index, /\.\.\.keyAwayScanOptions\(mergeBaseState\)/);
    assert.match(index, /\.\.\.\(awayNotes \? \{ awayNotes \} : \{\}\)/);
    assert.match(index, /const keyViews = dossierKeyViews\(state\);/);
    const observe = index.slice(index.indexOf('function observeKeyPeople'), index.indexOf('// What the narrator is told once'));
    assert.doesNotMatch(observe, /persist|setChatState/, 'noticing a return never writes the sidecar by itself');
    const targeted = index.slice(index.indexOf('const scoped = job.scope'), index.indexOf('const result = merged.state.npcs.find'));
    assert.doesNotMatch(targeted, /awayNpcIds|keyAwayScanOptions/, 'a reader\'s own Refresh or backfill is not held');
});

// ---- on Story Block's whole host: a stand-in for Story Director ----

// Story Director's key-people answer as a stand-in: a command sets the list (and the story clock), the query answers it.
const director = () => ({
    id: 'zz-director', name: 'Director (stand-in)', version: '0.0.0-test',
    domains: { director: { initial: () => ({ time: { minutes: 0 }, keyPeople: [] }) } },
    commands: {
        'zz.keys': (ctx, { list, minutes }) => {
            const slice = ctx.draft('director');
            if (Array.isArray(list)) slice.keyPeople = list;
            if (Number.isInteger(minutes)) slice.time.minutes = minutes;
            return { summary: 'key people' };
        },
    },
    queries: {
        'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }),
        'director.keyPeople': state => state?.domains?.director?.keyPeople ?? [],
    },
});

async function suite({ settings = {}, features = null, modules = [director()] } = {}) {
    const records = {
        npc_ren: { id: 'npc_ren', name: 'Ren', aliases: [], present: true, archived: false, relationship: { trust: 0, affection: 0, desire: 0, tension: 0 } },
        npc_mira: { id: 'npc_mira', name: 'Mira', aliases: [], present: true, archived: false, relationship: { trust: 0, affection: 0, desire: 0, tension: 0 } },
    };
    const host = await createHost({ settings: { modules: { [MODULE_ID]: structuredClone(settings) }, ...(features ? { features: { ...features } } : {}) }, modules });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        isEnabled: () => true,
        getNpc: id => (records[id] ? structuredClone(records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        presentCastHtml: () => '', castEmptyReason: () => ({ text: '' }), fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
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
    const keys = async (list, minutes) => { await host.sdk.command('zz.keys', { list, ...(minutes === undefined ? {} : { minutes }) }); };
    const meters = name => host.sdk.query('npc.meters', { name });
    return { host, adapter, say, keys, meters };
}

test('the adapter reads the key people from Story Director; with none to ask (or no such query) it answers null', async () => {
    const s = await suite();
    assert.deepEqual(s.adapter.keyPeople(), [], 'Story Director answers an empty list');
    await s.keys([key('Ren', { here: false, away: REN_AWAY }), key('Odda')]);
    assert.deepEqual(s.adapter.keyPeople().map(entry => [entry.name, isAway(entry)]), [['Ren', true], ['Odda', false]]);
    const plain = await suite({ modules: [] });
    assert.equal(plain.adapter.keyPeople(), null, 'Story Block alone: no key people anywhere');
    const old = await suite({ modules: [{ id: 'zz-old', name: 'Older director', domains: {}, commands: {}, queries: { 'director.time': () => ({ minutes: 0 }) } }] });
    assert.equal(old.adapter.keyPeople(), null, 'an older Story Director without the query');
});

test('while a key person is away their meters do not drift and their stage is not lost; both resume when they are back', async () => {
    const settings = {
        customMeters: [{ name: 'Mood', min: -50, max: 50, start: 0, drift: 4, driftTo: 0 }],
        ladder: [{ name: 'Friend', needs: 'trust 20' }], demoteAfter: 2,
    };
    const s = await suite({ settings, features: { [FEATURE_DRIFT]: true, [FEATURE_STAGES]: true } });
    await s.say(['~ npc Ren | mood: +15 | trust: +15', '~ npc Mira | mood: +15 | trust: +15']);
    await s.say(['~ npc Ren | trust: +15', '~ npc Mira | trust: +15']);
    assert.deepEqual([s.meters('Ren').rank, s.meters('Mira').rank], ['Friend', 'Friend']);
    assert.deepEqual([s.meters('Ren').meters.mood, s.meters('Mira').meters.mood], [15, 15]);

    // Three story days pass and trust falls below the stage; Ren is away, Mira is here.
    await s.keys([key('Ren', { here: false, away: REN_AWAY })], 3 * 1440);
    await s.say(['~ npc Ren | trust: -15', '~ npc Mira | trust: -15']);
    await s.say();
    assert.equal(s.meters('Mira').meters.mood, 3, 'Mira (here) drifted toward rest: 4 a day for 3 days');
    assert.equal(s.meters('Mira').rank, undefined, 'and lost her stage after the replies below it');
    assert.equal(s.meters('Ren').meters.mood, 15, 'Ren (away) stays exactly as set');
    assert.equal(s.meters('Ren').rank, 'Friend', 'and keeps his stage');
    assert.equal(s.meters('Ren').meters.trust, 15, 'a change the story writes is still the story\'s');
    await s.keys(undefined, 20 * 1440);
    await s.say();
    assert.equal(s.meters('Mira').meters.mood, 0);
    assert.equal(s.meters('Ren').meters.mood, 15, 'seventeen more days away: still as set');

    await s.keys([key('Ren', { here: true })]);
    await s.say();
    assert.equal(s.meters('Ren').meters.mood, 15, 'the days he was away are not caught up');
    await s.keys(undefined, 21 * 1440);
    await s.say();
    assert.equal(s.meters('Ren').meters.mood, 11, 'once back, the drift resumes with the next story day');
});

test('with no Story Director the per-reply step is exactly as before (nobody is held)', async () => {
    const settings = { customMeters: [{ name: 'Mood', min: -50, max: 50, start: 0, drift: 4, driftTo: 0 }] };
    const clock = { id: 'zz-clock', name: 'Clock', domains: { director: { initial: () => ({ time: { minutes: 0 } }) } }, commands: { 'zz.clock': (ctx, { minutes }) => { ctx.draft('director').time.minutes = minutes; return { summary: 'time' }; } }, queries: { 'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }) } };
    const s = await suite({ settings, modules: [clock], features: { [FEATURE_DRIFT]: true } });
    await s.say(['~ npc Ren | mood: +15']);
    await s.host.sdk.command('zz.clock', { minutes: 2 * 1440 + 60 });
    await s.say();
    assert.equal(s.meters('Ren').meters.mood, 7);
});

// ---- Delta's real runtime beside a fake host whose Story Director answers director.keyPeople ----

const scenarioOutput = output => JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));

test('runtime: the Key tag on the card, the badge data, the summary once at the return, the scan hold; Delta alone has none of it', () => {
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        // A turn in two halves: the player's message (the prompt for the generation is built then), and the reply
        // (Story Director's state for it is set `between`, as its capture does when the reply arrives).
        const send = async () => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
        };
        const receive = async text => {
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
            return id;
        };
        const turn = async (text, between = () => {}) => { await send(); await between(); return receive(text); };
        const row = (name, extra = {}) => ({ name, present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, ...extra });
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row('Yunyun')] });
        await turn('Yunyun waves from the gate.');
        await sleep(200);
        const yunyun = () => api.getState().npcs.find(npc => npc.name === 'Yunyun');
        // Story Director's dates are story minutes (Goldwane 12 is day 11 of a 30-day month).
        const away = { doing: 'scouting the north road', since: 11 * 1440, back: 17 * 1440, steps: [{ date: 13 * 1440, text: 'reached Wolfmere Outpost' }] };
        const out = {};

        out.cardPlain = api.presentCastHtml();
        out.viewsPlain = api.getDossierState().keyViews ?? null;
        mockState.sdk.keys = [{ name: 'Yunyun', here: true, away: null }];
        out.cardKey = api.presentCastHtml();
        out.viewsKey = api.getDossierState().keyViews;

        // Not away: the same scan writes her background (so the hold below is what stops it).
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row('Yunyun', { id: yunyun().id, background: 'Grew up on the docks of Axel.', backgroundState: 'update', backgroundReason: 'she told the story of her childhood' })] });
        await turn('Yunyun tells the story of her childhood on the docks of Axel.');
        await sleep(300);
        out.backgroundHere = yunyun().background ?? '';

        // Away: a scan that would rewrite it changes nothing.
        mockState.sdk.keys = [{ name: 'Yunyun', here: false, away }];
        out.viewsAway = api.getDossierState().keyViews;
        const rewrite = text => async () => JSON.stringify({ npcs: [row('Yunyun', { id: yunyun().id, background: text, backgroundState: 'update', backgroundReason: 'she told a different story of her childhood' })] });
        mockState.quietResponder = rewrite('Born in the mountains of Vale.');
        await turn('Yunyun says she was born in the mountains of Vale, not on the docks.');
        await sleep(300);
        out.backgroundAway = yunyun().background ?? '';
        out.injectionAway = api.injectionPreview().text;

        // Back: the reply that brings her back; the next generation is told once, and not the one after.
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row('Yunyun')] });
        await turn('Yunyun walks back through the gate, dusty and tired.', () => { mockState.sdk.keys = [{ name: 'Yunyun', here: true, away: null }]; });
        await sleep(300);
        out.injectionBack = api.injectionPreview().text;
        out.viewsBack = api.getDossierState().keyViews;
        await send();
        out.injectionNext = api.injectionPreview().text;
        await receive('Yunyun sits by the fire.');
        await sleep(300);
        out.injectionLater = api.injectionPreview().text;
        out.viewsLater = api.getDossierState().keyViews;
        // Present again: scans resume.
        mockState.quietResponder = rewrite('Born in the mountains of Vale.');
        await turn('Yunyun says again that she was born in the mountains of Vale, not on the docks.');
        await sleep(300);
        out.backgroundBack = yunyun().background ?? '';
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], keys: [],
            registerModule(def) { sdk.registered.push(def); },
            command: async () => ({ ok: true, receipt: { summary: '' } }),
            query: name => (name === 'director.keyPeople' ? structuredClone(sdk.keys)
                : (name === 'director.calendar' ? { era: 'CY', months: [{ name: 'Goldwane', days: 30 }, { name: 'Bluewatch', days: 30 }], leapYears: false }
                    : (name === 'scene.present' ? ['Yunyun'] : null))),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const hosted = scenarioOutput(runHostScenario('key-people-hosted', prelude, scenario));
    assert.doesNotMatch(hosted.cardPlain, /key-tag/, 'an empty answer: no tag');
    assert.equal(hosted.viewsPlain, null, 'and no key data');
    assert.match(hosted.cardKey, /<span class="npc-state-delta-key-tag" title="Key person \(Story Director\)">★ Key<\/span>/);
    assert.equal(hosted.viewsKey.npc_yunyun === undefined ? Object.values(hosted.viewsKey)[0].name : hosted.viewsKey.npc_yunyun.name, 'Yunyun');
    assert.equal(Object.values(hosted.viewsAway)[0].away.doing, 'scouting the north road');
    assert.deepEqual([Object.values(hosted.viewsAway)[0].away.since, Object.values(hosted.viewsAway)[0].away.back], ['Goldwane 12', 'Goldwane 18'], 'the dates are written on the calendar, not shown as minutes');
    assert.match(hosted.backgroundHere, /docks of Axel/, 'the same scan writes her background when she is here');
    assert.equal(hosted.backgroundAway, hosted.backgroundHere, 'and does not while she is away');
    assert.match(hosted.backgroundBack, /mountains of Vale/, 'scans resume when she is present again');
    assert.doesNotMatch(hosted.injectionAway, /WHILE AWAY/, 'nothing about the absence is sent while she is away');
    assert.match(hosted.injectionBack, /Yunyun: IDENTITY[^\n]*; WHILE AWAY, NOW BACK \(Goldwane 12 – Goldwane 18\): scouting the north road; Goldwane 14: reached Wolfmere Outpost/);
    assert.equal(hosted.injectionBack.split('WHILE AWAY').length - 1, 1, 'once');
    assert.equal(hosted.injectionNext, hosted.injectionBack, 'the generation that follows is told too (a swipe of it repeats it)');
    assert.equal(Object.values(hosted.viewsBack)[0].recent.away.doing, 'scouting the north road', 'the dossier still shows the absence');
    assert.doesNotMatch(hosted.injectionLater, /WHILE AWAY/, 'one reply later it is not sent again');
    assert.equal(Object.values(hosted.viewsLater)[0].recent.justReturned, false, 'but the dossier still shows the absence for a few replies');

    // The same turns with a Story Director that has no such query (and Delta alone): nothing of it anywhere.
    const alone = scenarioOutput(runHostScenario('key-people-none', async () => {
        const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); }, command: async () => ({ ok: true }), query: name => (name === 'scene.present' ? ['Yunyun'] : null), settings: () => ({}) };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves from the gate.', swipe_id: 0, swipes: ['Yunyun waves from the gate.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
        await sleep(400);
        console.log('RESULT ' + JSON.stringify({ card: api.presentCastHtml(), views: api.getDossierState().keyViews ?? null, keyAway: api.getState().keyAway ?? null }));
    }));
    assert.doesNotMatch(alone.card, /key-tag/);
    assert.equal(alone.views, null);
    assert.equal(alone.keyAway, null, 'nothing is added to the saved state');
});
