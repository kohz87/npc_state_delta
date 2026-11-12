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
    refreshCalendarAges,
    setActiveCalendarConfig,
    setStoryClockSource,
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

test.afterEach(() => { setStoryClockSource(null); setActiveCalendarConfig(null); });

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

test('a live read re-derives calendarAge a scan left null (no hosted date then), as a reload does', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const sdCalendar = { months: CUSTOM_CALENDAR.months.map(month => ({ ...month })) };
    setStoryClockSource(() => null);   // hosted, but the story clock gave no date at scan time
    const existing = { id: 'npc_mira', name: 'Mira', age: '21', birthDate: { era: 'CR', year: 800, month: 'Frostwane', day: 4 }, birthDateSource: 'established', birthDateYearSource: 'established' };
    const merged = mergeScanResult({ turn: 1, npcs: [existing], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } },
        { npcs: [{ id: 'npc_mira', name: 'Mira' }] }, { sourceMessageId: 3 });
    const live = merged.state.npcs.find(npc => npc.id === 'npc_mira');
    assert.equal(live.calendarAge, null, 'stored null: the scan had no date');
    setStoryClockSource(() => ({ minutes: (821 * 91 + 15) * 1440, calendar: sdCalendar }));   // the clock now has one
    const read = refreshCalendarAges(merged.state.npcs).find(npc => npc.id === 'npc_mira');
    assert.equal(read.calendarAge, 20, 'live read is no longer null');
    assert.equal(read.calendarAge, normalizeNpcRecord(live).calendarAge, 'and equals the reload derivation');
    assert.equal(refreshCalendarAges([]).length, 0);
});

// ---- twins share a birthday ----
const twinNpc = (id, name, extra = {}) => normalizeNpcRecord({ id, name, ...extra });
const twinState = npcs => refreshCalendarAges(npcs);

test('twins by key relationship share one generated birthday, order-independent', () => {
    setActiveCalendarConfig(null);
    const mk = () => [
        twinNpc('npc_b', 'Brin', { keyRelationships: ['Arin — twin brother'] }),
        twinNpc('npc_a', 'Arin', { keyRelationships: ['Brin — twin brother'] }),
    ];
    const one = twinState(mk());
    const two = twinState(mk().reverse());
    const get = (list, id) => list.find(n => n.id === id).birthDate;
    assert.deepEqual(get(one, 'npc_a'), get(one, 'npc_b'));
    assert.deepEqual(get(one, 'npc_a'), deterministicBirthday('npc_a'));
    assert.deepEqual(get(two, 'npc_b'), get(one, 'npc_b'));
});

test('twins by pack cast entry share a birthday', () => {
    setActiveCalendarConfig(null);
    const list = twinState([
        twinNpc('npc_z', 'Zed', { castFrom: { key: 'k' }, role: 'Twin sister of Ana' }),
        twinNpc('npc_c', 'Ana'),
    ]);
    assert.deepEqual(list[0].birthDate, list[1].birthDate);
    assert.deepEqual(list[0].birthDate, deterministicBirthday('npc_c'));
});

test('an established twin birthday wins and is never replaced', () => {
    setActiveCalendarConfig(null);
    const est = { birthDate: { era: '', year: null, month: '03', day: 9 }, birthDateSource: 'established' };
    const list = twinState([
        twinNpc('npc_a', 'Arin', { keyRelationships: ['Brin — twin'] }),
        twinNpc('npc_b', 'Brin', { keyRelationships: ['Arin — twin'], ...est }),
    ]);
    assert.equal(list[1].birthDateSource, 'established');
    assert.deepEqual(list[0].birthDate, list[1].birthDate);
    assert.equal(list[0].birthDateSource, 'generated');
});

test('the story giving twins different dates wins', () => {
    setActiveCalendarConfig(null);
    const a = { birthDate: { era: '', year: null, month: '01', day: 5 }, birthDateSource: 'established' };
    const b = { birthDate: { era: '', year: null, month: '02', day: 6 }, birthDateSource: 'established' };
    const list = twinState([
        twinNpc('npc_a', 'Arin', { keyRelationships: ['Brin — twin'], ...a }),
        twinNpc('npc_b', 'Brin', { keyRelationships: ['Arin — twin'], ...b }),
    ]);
    assert.notDeepEqual(list[0].birthDate, list[1].birthDate);
    assert.equal(list[0].birthDate.day, 5);
    assert.equal(list[1].birthDate.day, 6);
});

test('non-twin siblings keep their own generated birthdays', () => {
    setActiveCalendarConfig(null);
    const list = twinState([
        twinNpc('npc_a', 'Arin', { keyRelationships: ['Brin — sister'] }),
        twinNpc('npc_b', 'Brin', { keyRelationships: ['Arin — sister'] }),
    ]);
    assert.deepEqual(list[0].birthDate, deterministicBirthday('npc_a'));
    assert.deepEqual(list[1].birthDate, deterministicBirthday('npc_b'));
});

test('"twin" that qualifies someone else, or is negated, links nobody (the review phrases)', () => {
    setActiveCalendarConfig(null);
    for (const relation of ['twin son', 'twin daughter', 'daughter, one of the twins', 'one of the twins', 'father of the twins', 'mother of the twins', 'twin flame', 'not her twin', 'sibling of the twins']) {
        const list = twinState([
            twinNpc('npc_a', 'Arin', { keyRelationships: [`Mira — ${relation}`] }),
            twinNpc('npc_m', 'Mira', { keyRelationships: [`Arin — ${relation}`] }),
        ]);
        assert.deepEqual(list[0].birthDate, deterministicBirthday('npc_a'), relation);
        assert.deepEqual(list[1].birthDate, deterministicBirthday('npc_m'), relation);
    }
    const roles = twinState([
        twinNpc('npc_z', 'Zed', { castFrom: { key: 'k' }, role: "Ana's twin son" }),
        twinNpc('npc_y', 'Yan', { castFrom: { key: 'k' }, role: 'Mother of the twin sister of Ana' }),
        twinNpc('npc_c', 'Ana'),
    ]);
    assert.deepEqual(roles[0].birthDate, deterministicBirthday('npc_z'));
    assert.deepEqual(roles[1].birthDate, deterministicBirthday('npc_y'));
});

test('the forms that mean "is the twin of" still link', () => {
    setActiveCalendarConfig(null);
    for (const relation of ['twin', 'twin sister', 'twin brother', 'twin sibling', 'her twin', 'older twin brother']) {
        const list = twinState([
            twinNpc('npc_a', 'Arin', { keyRelationships: [`Brin — ${relation}`] }),
            twinNpc('npc_b', 'Brin'),
        ]);
        assert.deepEqual(list[0].birthDate, list[1].birthDate, relation);
    }
});

test('twins with different stored ages keep their own ages and years through a dated merge', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR);
    const clock = { sourceMessageId: 1, calendarSource: WORLD_STATE_821 };
    const state = { turn: 1, npcs: [{ id: 'npc_a', name: 'Arin', age: '19' }, { id: 'npc_m', name: 'Mira', age: '45' }], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } };
    const first = mergeScanResult(state, { npcs: [
        { id: 'npc_m', name: 'Mira', keyRelationships: ['Arin — twin son'] }, { id: 'npc_a', name: 'Arin' }] }, clock);
    const second = mergeScanResult(first.state, { npcs: [{ id: 'npc_x', name: 'Xan' }] }, { ...clock, sourceMessageId: 2 });
    for (const result of [first, second]) {
        assert.equal(result.state.npcs.find(n => n.id === 'npc_m').age, '45');
        assert.equal(result.state.npcs.find(n => n.id === 'npc_a').age, '19');
    }
    const mira = second.state.npcs.find(n => n.id === 'npc_m');
    assert.equal(mira.calendarAge, 45);
    assert.equal(mira.fieldChanges?.age, undefined, 'no age change is stamped');
    assert.equal(mira.fieldChanges?.birthDate, first.state.npcs.find(n => n.id === 'npc_m').fieldChanges?.birthDate, 'a later merge stamps no new birthday change');
    // real twins with different ages: still their own ages, and a later merge stamps nothing
    const twins = { turn: 1, npcs: [{ id: 'npc_a', name: 'Arin', age: '19', keyRelationships: ['Brin — twin brother'] }, { id: 'npc_b', name: 'Brin', age: '20', keyRelationships: ['Arin — twin brother'] }], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } };
    const t1 = mergeScanResult(twins, { npcs: [{ id: 'npc_a', name: 'Arin' }] }, clock);
    const t2 = mergeScanResult(t1.state, { npcs: [{ id: 'npc_x', name: 'Xan' }] }, { ...clock, sourceMessageId: 2 });
    assert.equal(t2.state.npcs.find(n => n.id === 'npc_a').age, '19');
    assert.equal(t2.state.npcs.find(n => n.id === 'npc_b').age, '20');
    for (const n of t2.state.npcs.filter(o => o.name !== 'Xan')) {
        assert.equal(n.fieldChanges?.age, undefined, `${n.id} no age change stamped`);
        assert.equal(n.fieldChanges?.birthDate, t1.state.npcs.find(o => o.id === n.id).fieldChanges?.birthDate, `${n.id} no new birthday change`);
    }
});

test('twins copy month and day only: the receiver keeps its own year, and a stored age is never moved', () => {
    setActiveCalendarConfig(CUSTOM_CALENDAR_WITH_CLOCK);
    const est = { birthDate: { era: 'CR', year: 790, month: 'Sunwane', day: 9 }, birthDateSource: 'established' };
    const list = twinState([
        twinNpc('npc_a', 'Arin', { keyRelationships: ['Brin — twin'], age: '19' }),
        twinNpc('npc_b', 'Brin', { keyRelationships: ['Arin — twin'], ...est }),
    ]);
    assert.equal(list[1].birthDate.year, 790);
    assert.notEqual(list[0].birthDate.year, 790, 'the year is not copied');
    assert.equal(list[0].age, '19');
});
