import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildScannerPrompt,
    deriveAgeFromBirthDate,
    deriveBirthDateFromAge,
    deterministicBirthday,
    formatBirthDate,
    mergeScanResult,
    normalizeBirthDate,
    normalizeCalendarConfig,
    normalizeNpcRecord,
    normalizeScanNpc,
    setActiveCalendarConfig,
} from '../core.js';

const CUSTOM_CALENDAR = Object.freeze({
    era: 'CR',
    currentYear: 821,
    currentMonth: 'Redleaf',
    currentDay: 16,
    months: [
        { name: 'Redleaf', days: 30 },
        { name: 'Sunwane', days: 31 },
        { name: 'Frostwane', days: 30 },
    ],
});

test.afterEach(() => setActiveCalendarConfig(null));

test('legacy numeric birthday fallback remains deterministic before custom calendar setup', () => {
    setActiveCalendarConfig(null);
    const first = deterministicBirthday('npc_sora');
    assert.match(formatBirthDate(first), /^\d{2}-\d{2}$/);
    assert.deepEqual(deterministicBirthday('npc_sora'), first);

    const record = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    assert.equal(record.birthDateSource, 'generated');
    assert.equal(record.birthDatePrecision, 'month-day');
    assert.match(record.birthDateDisplay, /^\d{2}-\d{2}$/);
    assert.equal(record.calendarAge, null);
});

test('custom calendar requires ordered months plus a complete current date while era is optional', () => {
    const valid = normalizeCalendarConfig({
        era: 'CR',
        year: 821,
        month: 'Redleaf',
        day: 16,
        monthsText: 'Redleaf:30\nSunwane:31\nFrostwane:30',
    });
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.config.months.map(month => month.name), ['Redleaf', 'Sunwane', 'Frostwane']);

    const noEra = normalizeCalendarConfig({
        year: 821,
        month: 'Redleaf',
        day: 16,
        monthsText: 'Redleaf:30\nSunwane:31',
    });
    assert.equal(noEra.valid, true);
    assert.equal(noEra.config.era, '');

    assert.equal(normalizeCalendarConfig({ monthsText: 'Redleaf:30' }).valid, false);
    assert.equal(normalizeCalendarConfig({ year: 821, month: 'Redleaf', day: 31, monthsText: 'Redleaf:30' }).valid, false);
    assert.equal(normalizeCalendarConfig({ year: 821, month: 'Redleaf', day: 1, monthsText: 'Redleaf:30\nredleaf:20' }).valid, false);
});

test('custom generated birthdays map deterministically into named months', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const first = deterministicBirthday('npc_sora');
    assert.ok(['Redleaf', 'Sunwane', 'Frostwane'].includes(first.month));
    assert.equal(first.year, null);
    assert.deepEqual(deterministicBirthday('npc_sora'), first);
    const month = CUSTOM_CALENDAR.months.find(item => item.name === first.month);
    assert.ok(first.day >= 1 && first.day <= month.days);
});

test('custom calendar derives birth year and age using month order rather than fantasy lifespan', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    assert.deepEqual(
        deriveBirthDateFromAge({ month: 'Redleaf', day: 16 }, '6'),
        { era: 'CR', year: 815, month: 'Redleaf', day: 16 },
    );
    assert.deepEqual(
        deriveBirthDateFromAge({ month: 'Sunwane', day: 4 }, '6'),
        { era: 'CR', year: 814, month: 'Sunwane', day: 4 },
    );
    assert.equal(deriveBirthDateFromAge({ month: 'Sunwane', day: 4 }, '~6'), null);
    assert.equal(deriveAgeFromBirthDate({ era: 'CR', year: 815, month: 'Redleaf', day: 16 }, null, CUSTOM_CALENDAR), 6);
    assert.equal(deriveAgeFromBirthDate({ era: 'CR', year: 814, month: 'Sunwane', day: 4 }, null, CUSTOM_CALENDAR), 6);
});

test('exact chronological age anchors a generated birthday year and exposes deterministic calendarAge', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const record = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    assert.equal(record.birthDateSource, 'generated');
    assert.equal(record.birthDatePrecision, 'full');
    assert.equal(record.birthDateYearSource, 'derived');
    assert.equal(record.calendarAge, 6);
    assert.match(record.birthDateDisplay, /^CR-?\d+, (Redleaf|Sunwane|Frostwane) \d+$/);
});

test('scanner custom birthday fields are normalized without using apparent age', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const incoming = normalizeScanNpc({
        id: 'npc_sora',
        name: 'Sora',
        apparentAge: '~6',
        birthDate: { month: 'Redleaf', day: 16 },
        birthDateState: 'establish',
        birthDateReason: 'The story explicitly establishes Redleaf 16 as her birthday.',
    });
    assert.deepEqual(incoming.birthDate, { era: '', year: null, month: 'Redleaf', day: 16 });
    assert.equal(incoming.birthDateState, 'establish');
    assert.match(incoming.birthDateReason, /explicitly establishes/);
});

test('explicit named-month birthday replaces generated fallback and later overwrite requires correction', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const existing = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    const base = {
        turn: 3,
        npcs: [existing],
        candidates: [],
        socialGraph: { version: 1, edges: [], unresolved: [] },
    };

    const established = mergeScanResult(base, {
        npcs: [{
            id: 'npc_sora',
            name: 'Sora',
            birthDate: { month: 'Redleaf', day: 16 },
            birthDateState: 'establish',
            birthDateReason: 'Explicit birthday.',
        }],
    }, { sourceMessageId: 8 });
    let sora = established.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.deepEqual(sora.birthDate, { era: 'CR', year: 815, month: 'Redleaf', day: 16 });
    assert.equal(sora.birthDateSource, 'established');
    assert.equal(sora.birthDateYearSource, 'derived');
    assert.equal(sora.calendarAge, 6);
    assert.equal(sora.birthDateSourceMessageId, 8);

    const ordinaryOverwrite = mergeScanResult(established.state, {
        npcs: [{ id: 'npc_sora', name: 'Sora', birthDate: { month: 'Sunwane', day: 4 }, birthDateState: 'establish' }],
    }, { sourceMessageId: 9 });
    sora = ordinaryOverwrite.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDate.month, 'Redleaf');
    assert.equal(sora.birthDate.day, 16);

    const corrected = mergeScanResult(ordinaryOverwrite.state, {
        npcs: [{
            id: 'npc_sora',
            name: 'Sora',
            birthDate: { month: 'Sunwane', day: 4 },
            birthDateState: 'correct',
            birthDateReason: 'Explicit correction.',
        }],
    }, { sourceMessageId: 10 });
    sora = corrected.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.deepEqual(sora.birthDate, { era: 'CR', year: 814, month: 'Sunwane', day: 4 });
    assert.equal(sora.birthDateSourceMessageId, 10);
});

test('an explicit full year can upgrade a previously derived year without changing the established birthday day', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const base = normalizeNpcRecord({
        id: 'npc_sora', name: 'Sora', age: '6',
        birthDate: { month: 'Redleaf', day: 16 }, birthDateSource: 'established',
    });
    assert.equal(base.birthDateYearSource, 'derived');

    const result = mergeScanResult({ turn: 1, npcs: [base], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } }, {
        npcs: [{
            id: 'npc_sora', name: 'Sora',
            birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 },
            birthDateState: 'establish', birthDateReason: 'The birth year is explicitly stated.',
        }],
    }, { sourceMessageId: 11 });
    const sora = result.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDateYearSource, 'established');
    assert.equal(sora.birthDate.year, 815);
});

test('established numeric birthday is preserved when a custom fantasy calendar is enabled', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const record = normalizeNpcRecord({
        id: 'npc_old',
        name: 'Old Record',
        age: '',
        birthDate: { era: '', year: null, month: '09', day: 17 },
        birthDateSource: 'established',
        birthDateCalendarFingerprint: 'legacy-numeric-v1',
    });
    assert.deepEqual(record.birthDate, { era: '', year: null, month: '09', day: 17 });
    assert.equal(record.birthDateSource, 'established');
    assert.equal(record.birthDateDisplay, '09-17');
    assert.equal(record.calendarAge, null);
});

test('birthday prompt remains conditional and includes configured fantasy calendar only when needed', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const ordinary = buildScannerPrompt({
        transcript: 'Sora crosses the room and sits beside the window.',
        existingNpcs: [],
        candidates: [],
    });
    assert.equal(ordinary.includes('BIRTHDAY:'), false);

    const birthday = buildScannerPrompt({
        transcript: "Today is Sora's sixth birthday.",
        existingNpcs: [],
        candidates: [],
    });
    assert.equal(birthday.includes('BIRTHDAY:'), true);
    assert.equal(birthday.includes('current world date=CR821, Redleaf 16'), true);
    assert.equal(birthday.includes('Never derive chronology from apparentAge, species, or lifespan'), true);
    assert.equal(birthday.includes('calendar arithmetic locally'), true);
});

test('custom calendar date validation rejects unknown months and impossible days', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    assert.deepEqual(normalizeBirthDate('CR815, Redleaf 16'), { era: 'CR', year: 815, month: 'Redleaf', day: 16 });
    assert.deepEqual(normalizeBirthDate('Sunwane 4'), { era: '', year: null, month: 'Sunwane', day: 4 });
    assert.equal(normalizeBirthDate('Moonfall 4'), null);
    assert.equal(normalizeBirthDate('Redleaf 31'), null);
});
