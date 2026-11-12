import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildScannerPrompt,
    deriveAgeFromBirthDate,
    deriveBirthDateFromAge,
    deterministicBirthday,
    extractStructuredWorldDate,
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
    months: [
        { name: 'Redleaf', days: 30 },
        { name: 'Sunwane', days: 31 },
        { name: 'Frostwane', days: 30 },
    ],
});

const CUSTOM_CALENDAR_WITH_CLOCK = Object.freeze({
    ...CUSTOM_CALENDAR,
    currentYear: 821,
    currentMonth: 'Redleaf',
    currentDay: 16,
});

const WORLD_STATE_821 = '<World_State>Time | **CR821, Redleaf 16** | 7:42 pm\nLocation | Rimecross</World_State>';

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

test('custom calendar requires ordered months while era and current date are optional', () => {
    const monthsOnly = normalizeCalendarConfig({
        era: 'CR',
        monthsText: 'Redleaf:30\nSunwane:31\nFrostwane:30',
    });
    assert.equal(monthsOnly.valid, true);
    assert.equal(monthsOnly.calendarValid, true);
    assert.equal(monthsOnly.currentDateValid, false);
    assert.deepEqual(monthsOnly.config.months.map(month => month.name), ['Redleaf', 'Sunwane', 'Frostwane']);

    const noEra = normalizeCalendarConfig({ monthsText: 'Redleaf:30\nSunwane:31' });
    assert.equal(noEra.valid, true);
    assert.equal(noEra.config.era, '');

    const completeClock = normalizeCalendarConfig({
        era: 'CR', year: 821, month: 'Redleaf', day: 16,
        monthsText: 'Redleaf:30\nSunwane:31',
    });
    assert.equal(completeClock.valid, true);
    assert.equal(completeClock.currentDateValid, true);

    assert.equal(normalizeCalendarConfig({ monthsText: 'Redleaf:30', year: 821 }).valid, false);
    assert.equal(normalizeCalendarConfig({ monthsText: 'Redleaf:30', month: 'Redleaf', day: 16 }).valid, false);
    assert.equal(normalizeCalendarConfig({ year: 821, month: 'Redleaf', day: 31, monthsText: 'Redleaf:30' }).valid, false);
    assert.equal(normalizeCalendarConfig({ year: 821, month: 'Redleaf', day: 1, monthsText: 'Redleaf:30\nredleaf:20' }).valid, false);
});

test('custom generated birthdays map deterministically into named months without a year', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const first = deterministicBirthday('npc_sora');
    assert.ok(['Redleaf', 'Sunwane', 'Frostwane'].includes(first.month));
    assert.equal(first.year, null);
    assert.deepEqual(deterministicBirthday('npc_sora'), first);
    const month = CUSTOM_CALENDAR.months.find(item => item.name === first.month);
    assert.ok(first.day >= 1 && first.day <= month.days);

    const record = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    assert.equal(record.birthDatePrecision, 'month-day');
    assert.equal(record.birthDate.year, null);
    assert.equal(record.calendarAge, null);
});

test('birth year and chronological age require a grounded full current date', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    assert.equal(deriveBirthDateFromAge({ month: 'Redleaf', day: 16 }, '6'), null);
    assert.deepEqual(
        deriveBirthDateFromAge({ month: 'Redleaf', day: 16 }, '6', { era: 'CR', year: 821, month: 'Redleaf', day: 16 }),
        { era: 'CR', year: 815, month: 'Redleaf', day: 16 },
    );
    assert.deepEqual(
        deriveBirthDateFromAge({ month: 'Sunwane', day: 4 }, '6', { era: 'CR', year: 821, month: 'Redleaf', day: 16 }),
        { era: 'CR', year: 814, month: 'Sunwane', day: 4 },
    );
    assert.equal(deriveBirthDateFromAge({ month: 'Sunwane', day: 4 }, '~6', { era: 'CR', year: 821, month: 'Redleaf', day: 16 }), null);
    assert.equal(deriveAgeFromBirthDate({ era: 'CR', year: 815, month: 'Redleaf', day: 16 }, null, CUSTOM_CALENDAR), null);
    assert.equal(deriveAgeFromBirthDate(
        { era: 'CR', year: 815, month: 'Redleaf', day: 16 },
        { era: 'CR', year: 821, month: 'Redleaf', day: 16 },
        CUSTOM_CALENDAR,
    ), 6);
});

test('complete manual current date remains an optional fallback for year anchoring', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR_WITH_CLOCK);
    const record = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    assert.equal(record.birthDateSource, 'generated');
    assert.equal(record.birthDatePrecision, 'full');
    assert.equal(record.birthDateYearSource, 'derived');
    assert.equal(record.calendarAge, 6);
    assert.match(record.birthDateDisplay, /^CR-?\d+, (Redleaf|Sunwane|Frostwane) \d+$/);
});

test('structured World State extraction preserves the grounded date and chooses the latest block', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const first = extractStructuredWorldDate(WORLD_STATE_821, CUSTOM_CALENDAR);
    assert.deepEqual(first, {
        raw: 'CR821, Redleaf 16',
        date: { era: 'CR', year: 821, month: 'Redleaf', day: 16 },
        source: 'world-state',
    });

    const multiple = `${WORLD_STATE_821}\n<details><summary>World State</summary>Time | CR822, Sunwane 4 | dawn</details>`;
    const latest = extractStructuredWorldDate(multiple, CUSTOM_CALENDAR);
    assert.equal(latest.raw, 'CR822, Sunwane 4');
    assert.equal(latest.date.year, 822);
    assert.equal(latest.date.month, 'Sunwane');
    assert.equal(latest.date.day, 4);
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

test('explicit named-month birthday remains month/day when no current clock exists', () => {
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
            id: 'npc_sora', name: 'Sora',
            birthDate: { month: 'Redleaf', day: 16 },
            birthDateState: 'establish', birthDateReason: 'Explicit birthday.',
        }],
    }, { sourceMessageId: 8 });
    let sora = established.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.deepEqual(sora.birthDate, { era: '', year: null, month: 'Redleaf', day: 16 });
    assert.equal(sora.birthDateSource, 'established');
    assert.equal(sora.birthDateYearSource, '');
    assert.equal(sora.calendarAge, null);

    const ordinaryOverwrite = mergeScanResult(established.state, {
        npcs: [{ id: 'npc_sora', name: 'Sora', birthDate: { month: 'Sunwane', day: 4 }, birthDateState: 'establish' }],
    }, { sourceMessageId: 9 });
    sora = ordinaryOverwrite.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDate.month, 'Redleaf');

    const corrected = mergeScanResult(ordinaryOverwrite.state, {
        npcs: [{ id: 'npc_sora', name: 'Sora', birthDate: { month: 'Sunwane', day: 4 }, birthDateState: 'correct', birthDateReason: 'Explicit correction.' }],
    }, { sourceMessageId: 10 });
    sora = corrected.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.deepEqual(sora.birthDate, { era: '', year: null, month: 'Sunwane', day: 4 });
});

test('World State date can anchor a missing birth year and later advance chronological age locally', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const existing = normalizeNpcRecord({
        id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6',
        birthDate: { month: 'Redleaf', day: 16 }, birthDateSource: 'established',
    });
    assert.equal(existing.birthDate.year, null);

    const first = mergeScanResult({
        turn: 1, npcs: [existing], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, { npcs: [{ id: 'npc_sora', name: 'Sora' }] }, {
        sourceMessageId: 12,
        developmentContext: WORLD_STATE_821,
    });
    let sora = first.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.deepEqual(sora.birthDate, { era: 'CR', year: 815, month: 'Redleaf', day: 16 });
    assert.equal(sora.birthDateYearSource, 'derived');
    assert.equal(sora.age, '6');
    assert.equal(first.report.calendarReference.raw, 'CR821, Redleaf 16');

    const second = mergeScanResult(first.state, { npcs: [{ id: 'npc_sora', name: 'Sora' }] }, {
        sourceMessageId: 13,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State>',
    });
    sora = second.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.calendarAge, 7);
    assert.equal(sora.age, '7');
    assert.equal(sora.apparentAge, '~7');
});

test('an explicit full year can upgrade a previously derived year without changing the established birthday day', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR_WITH_CLOCK);
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
        id: 'npc_old', name: 'Old Record', age: '',
        birthDate: { era: '', year: null, month: '09', day: 17 },
        birthDateSource: 'established', birthDateCalendarFingerprint: 'legacy-numeric-v1',
    });
    assert.deepEqual(record.birthDate, { era: '', year: null, month: '09', day: 17 });
    assert.equal(record.birthDateSource, 'established');
    assert.equal(record.birthDateDisplay, '09-17');
    assert.equal(record.calendarAge, null);
});

test('birthday prompt stays conditional and takes structured World State date over an absent manual clock', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const ordinary = buildScannerPrompt({
        transcript: `${WORLD_STATE_821}\nSora crosses the room and sits beside the window.`,
        existingNpcs: [], candidates: [],
    });
    assert.equal(ordinary.includes('BIRTHDAY:'), false);

    const birthday = buildScannerPrompt({
        transcript: `${WORLD_STATE_821}\nToday is Sora's sixth birthday.`,
        existingNpcs: [], candidates: [],
    });
    assert.equal(birthday.includes('BIRTHDAY:'), true);
    assert.equal(birthday.includes('Current grounded world date=CR821, Redleaf 16'), true);
    assert.equal(birthday.includes('Redleaf:30'), false);
    assert.equal(birthday.includes('Never derive chronology from apparentAge, species, or lifespan'), true);
});

test('birthday prompt works without any current clock and does not invent a year', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const birthday = buildScannerPrompt({
        transcript: "Sora says her birthday is Redleaf 16.",
        existingNpcs: [], candidates: [],
    });
    assert.equal(birthday.includes('BIRTHDAY:'), true);
    assert.equal(birthday.includes('Current grounded world date='), false);
    assert.equal(birthday.includes('Never invent a missing year or birthday'), true);
});

test('v1.0.22 an existing yearless birthday rolls age and compact apparent age exactly once on a narrated nameday', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const existing = normalizeNpcRecord({
        id: 'npc_ryu', name: 'Ryu', age: '13', apparentAge: '~12',
        birthDate: { month: 'Redleaf', day: 16 }, birthDateSource: 'established',
    });
    assert.equal(existing.birthDate.year, null);

    const options = {
        sourceMessageId: 204,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu attends her formal nameday feast after months of growth and study.',
    };
    const payload = {
        npcs: [{
            id: 'npc_ryu', name: 'Ryu',
            age: '13', ageState: 'keep',
            apparentAge: '~12', apparentAgeState: 'keep',
        }],
    };
    const first = mergeScanResult({
        turn: 203, npcs: [existing], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, payload, options);
    let ryu = first.state.npcs.find(npc => npc.id === 'npc_ryu');
    assert.equal(ryu.age, '14');
    assert.equal(ryu.apparentAge, '~13');
    assert.equal(ryu.birthDateYearSource, 'derived');
    assert.equal(ryu.calendarAge, 14);
    assert.deepEqual(first.report.birthdayDiagnostics?.map(row => ({ npcId: row.npcId, outcome: row.outcome, reason: row.reason, delta: row.delta })), [
        { npcId: 'npc_ryu', outcome: 'advance', reason: 'calendar-rollover', delta: 1 },
    ]);

    const repeated = mergeScanResult(first.state, payload, { ...options, sourceMessageId: 205 });
    ryu = repeated.state.npcs.find(npc => npc.id === 'npc_ryu');
    assert.equal(ryu.age, '14', 'repeating Refresh on the same nameday must not age twice');
    assert.equal(ryu.apparentAge, '~13');
    assert.equal(ryu.calendarAge, 14);
    assert.equal(repeated.report.birthdayDiagnostics?.[0]?.outcome, 'hold');
    assert.equal(repeated.report.birthdayDiagnostics?.[0]?.reason, 'birthday-held');
});

test('v1.0.22 birthday rollover respects apparent-age authority and does not guess on newly established birthdays', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const base = normalizeNpcRecord({
        id: 'npc_ryu', name: 'Ryu', age: '13', apparentAge: '~12',
        birthDate: { month: 'Redleaf', day: 16 }, birthDateSource: 'established',
    });

    const explicitVisual = mergeScanResult({
        turn: 20, npcs: [structuredClone(base)], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, { npcs: [{
        id: 'npc_ryu', name: 'Ryu', age: '13', ageState: 'keep',
        apparentAge: '~15', apparentAgeState: 'evolve', apparentAgeReason: 'Visible maturation is explicitly established.',
    }] }, {
        sourceMessageId: 21,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu celebrates her nameday; the narration explicitly describes visible maturation.',
    });
    let ryu = explicitVisual.state.npcs[0];
    assert.equal(ryu.age, '14');
    assert.equal(ryu.apparentAge, '~15', 'explicit visual-age evolution must beat deterministic offset rollover');

    const locked = structuredClone(base);
    locked.manualProfileLocksExplicit = true;
    locked.manualProfileFields = ['apparentAge'];
    const lockedResult = mergeScanResult({
        turn: 20, npcs: [locked], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, { npcs: [{ id: 'npc_ryu', name: 'Ryu', age: '13', ageState: 'keep', apparentAge: '~12', apparentAgeState: 'keep' }] }, {
        sourceMessageId: 21,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu celebrates her nameday.',
    });
    ryu = lockedResult.state.npcs[0];
    assert.equal(ryu.age, '14');
    assert.equal(ryu.apparentAge, '~12');

    const corrected = mergeScanResult({
        turn: 20, npcs: [structuredClone(base)], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, { npcs: [{
        id: 'npc_ryu', name: 'Ryu', age: '13', ageState: 'correct', ageReason: 'The prior chronological age was mistaken.',
        apparentAge: '~12', apparentAgeState: 'keep',
    }] }, {
        sourceMessageId: 21,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu celebrates her nameday.',
    });
    ryu = corrected.state.npcs[0];
    assert.equal(ryu.age, '13', 'an explicit chronological correction must not be second-guessed by yearless birthday compatibility');
    assert.equal(ryu.apparentAge, '~12');

    const unknownBirthday = normalizeNpcRecord({ id: 'npc_new', name: 'New', age: '13', apparentAge: '~12' });
    const establishedNow = mergeScanResult({
        turn: 20, npcs: [unknownBirthday], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] },
    }, { npcs: [{
        id: 'npc_new', name: 'New', age: '13', ageState: 'keep', apparentAge: '~12', apparentAgeState: 'keep',
        birthDate: { month: 'Redleaf', day: 16 }, birthDateState: 'establish', birthDateReason: 'The nameday establishes the birthday.',
    }] }, {
        sourceMessageId: 21,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Today is New\'s nameday.',
    });
    const newlyEstablished = establishedNow.state.npcs[0];
    assert.equal(newlyEstablished.age, '13', 'a birthday first established today must not assume the stored age is pre-birthday');
    assert.equal(newlyEstablished.apparentAge, '~12');
    assert.equal(establishedNow.report.birthdayDiagnostics?.[0]?.outcome, 'hold');
    assert.equal(establishedNow.report.birthdayDiagnostics?.[0]?.reason, 'first-establishment-guard');
});

test('v1.0.22 nameday language activates the birthday scanner rule', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const prompt = buildScannerPrompt({
        transcript: `${WORLD_STATE_821}\nToday is Sora's nameday feast.`,
        existingNpcs: [], candidates: [],
    });
    assert.equal(prompt.includes('BIRTHDAY:'), true);
    assert.equal(prompt.includes('Current grounded world date=CR821, Redleaf 16'), true);
});

test('custom calendar date validation rejects unknown months and impossible days', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    assert.deepEqual(normalizeBirthDate('CR815, Redleaf 16'), { era: 'CR', year: 815, month: 'Redleaf', day: 16 });
    assert.deepEqual(normalizeBirthDate('Sunwane 4'), { era: '', year: null, month: 'Sunwane', day: 4 });
    assert.equal(normalizeBirthDate('Moonfall 4'), null);
    assert.equal(normalizeBirthDate('Redleaf 31'), null);
});
