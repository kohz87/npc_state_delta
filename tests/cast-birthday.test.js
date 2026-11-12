// A birthday the pack's writer gave (cast entry `birthday`): the starting date of a cast dossier. The story is canon: a birthday it
// states later (scan 'establish' or 'correct') replaces it. Split from birthday-continuity.test.js (file size).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deterministicBirthday, mergeScanResult, normalizeNpcRecord, setActiveCalendarConfig, setStoryClockSource } from '../core.js';
import { applyCastEntry, normalizeEntry } from '../src/cast-dossier.js';
import { createNpcRecord } from '../core.js';
import { dossierDetailProjection } from '../dossier-ui.js';

const CALENDAR = Object.freeze({
    era: 'CR',
    months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }, { name: 'Frostwane', days: 30 }],
    currentYear: 821, currentMonth: 'Redleaf', currentDay: 16,
});

test.afterEach(() => { setStoryClockSource(null); setActiveCalendarConfig(null); });

const make = (extra, options = {}) => normalizeNpcRecord(applyCastEntry(createNpcRecord('Fenna', []), {
    key: 'p:fenna', pack: 'p', id: 'fenna', met: { on: 0, where: '' },
    entry: normalizeEntry({ id: 'fenna', name: 'Fenna', about: 'a', look: 'b', start: { place: 'x', goal: 'y' }, ...extra }),
}, options));

const scan = (state, row, id) => mergeScanResult({ turn: 3, npcs: [state], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } },
    { npcs: [{ id: state.id, name: 'Fenna', ...row }] }, { sourceMessageId: id }).state.npcs[0];

test('a pack birthday is the dossier\'s starting birthday; without one the deterministic date is the real one', () => {
    setActiveCalendarConfig(CALENDAR);
    const dated = make({ birthday: 'sunwane 27' });
    assert.deepEqual([dated.birthDate.month, dated.birthDate.day, dated.birthDate.year], ['Sunwane', 27, null]);
    assert.equal(dated.birthDateSource, 'established');     // the twins rule reads this as an established date
    assert.equal(dated.birthDateDisplay, 'Sunwane 27');
    const withYear = make({ birthday: 'Redleaf 3, 790' });
    assert.deepEqual([withYear.birthDate.month, withYear.birthDate.day, withYear.birthDate.year], ['Redleaf', 3, 790]);
    assert.equal(withYear.birthDatePrecision, 'full');
    // Not a day of the active calendar: ignored, the deterministic date stands as the real one.
    const bad = make({ birthday: 'Sunwane 40' });
    const none = make({});
    assert.deepEqual(bad.birthDate, none.birthDate);
    assert.deepEqual(none.birthDate, deterministicBirthday(none.id || none.name, CALENDAR));
    // The editor never says "generated" or "deterministic".
    assert.doesNotMatch(readFileSync(new URL('../runtime-editor.js', import.meta.url), 'utf8').match(/Birthday <small>[^\n]*/)[0], /generated|deterministic/i);
});

for (const state of ['establish', 'correct']) {
    test(`a birthday the story states (${state}) replaces the pack's birthday, through the scan merge`, () => {
        setActiveCalendarConfig(CALENDAR);
        const dated = make({ birthday: 'Sunwane 27' });
        const row = { birthDate: { era: 'CR', year: null, month: 'Frostwane', day: 2 }, birthDateState: state, birthDateReason: 'Said so.' };
        const told = scan(dated, row, 12);
        assert.deepEqual([told.birthDate.month, told.birthDate.day], ['Frostwane', 2]);
        assert.equal(told.birthDateSource, 'established');
        assert.equal(told.birthDateReason, 'Said so.');
        // From then on it is the story's: an ordinary 'establish' no longer moves it.
        const again = scan(told, { birthDate: { month: 'Redleaf', day: 5 }, birthDateState: 'establish' }, 13);
        assert.equal(again.birthDate.month, 'Frostwane');
    });
}

test('the story stating the same date as the pack makes it the story\'s own, and the pack mark goes', () => {
    setActiveCalendarConfig(CALENDAR);
    const told = scan(make({ birthday: 'Sunwane 27' }), { birthDate: { month: 'Sunwane', day: 27 }, birthDateState: 'establish' }, 12);
    assert.equal(told.birthDateReason, '');
    const again = scan(told, { birthDate: { month: 'Redleaf', day: 5 }, birthDateState: 'establish' }, 13);
    assert.equal(again.birthDate.month, 'Sunwane');
});

test('the card says "Story established" only for the story\'s birthday, not for the pack\'s', () => {
    setActiveCalendarConfig(CALENDAR);
    const dated = make({ birthday: 'Sunwane 27' });
    assert.equal(dossierDetailProjection(dated, {}, {}).birthdaySource, '');
    const told = scan(dated, { birthDate: { month: 'Frostwane', day: 2 }, birthDateState: 'correct' }, 12);
    assert.equal(dossierDetailProjection(told, {}, {}).birthdaySource, 'established');
});

test('with Delta on its own calendar the pack date (in the pack\'s calendar) is skipped; Delta\'s date stands', () => {
    setActiveCalendarConfig(CALENDAR);
    const own = make({ birthday: 'Sunwane 27' }, { calendarOwn: true });
    assert.deepEqual(own.birthDate, make({}).birthDate);
    assert.notEqual(own.birthDateSource, 'established');
});
