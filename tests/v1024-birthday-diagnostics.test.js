import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mergeScanResult,
    normalizeNpcRecord,
    setActiveCalendarConfig,
} from '../core.js';

const CALENDAR = Object.freeze({
    era: 'CR',
    months: [
        { name: 'Redleaf', days: 30 },
        { name: 'Sunwane', days: 31 },
        { name: 'Frostwane', days: 30 },
    ],
});

test.afterEach(() => setActiveCalendarConfig(null));

test('v1.0.24 birthday diagnostics omit unrelated NPCs and retain chronology details for relevant rows', () => {
    setActiveCalendarConfig(CALENDAR);
    const ryu = normalizeNpcRecord({
        id: 'npc_ryu', name: 'Ryu', age: '13', apparentAge: '~13',
        birthDate: { era: 'CR', year: 809, month: 'Redleaf', day: 16 },
        birthDateSource: 'established', birthDateYearSource: 'established',
    });
    const other = normalizeNpcRecord({
        id: 'npc_other', name: 'Other', age: '20', apparentAge: '~20',
        birthDate: { era: 'CR', year: 801, month: 'Sunwane', day: 4 },
        birthDateSource: 'established', birthDateYearSource: 'established',
    });
    const context = '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu celebrates her nameday feast.';
    const result = mergeScanResult(
        { turn: 204, npcs: [ryu, other], candidates: [], socialGraph: { version: 1, edges: [], unresolved: [] } },
        { npcs: [{ id: ryu.id, name: ryu.name }, { id: other.id, name: other.name }] },
        { turn: 204, sourceMessageId: 204, developmentContext: context },
    );
    assert.deepEqual(result.report.birthdayDiagnostics?.map(row => row.npcId), ['npc_ryu']);
    const row = result.report.birthdayDiagnostics[0];
    assert.equal(row.birthdayMatched, true);
    assert.equal(row.birthDateYearSource, 'established');
    assert.equal(row.calendarAge, 13);
    assert.deepEqual(row.referenceDate, { era: 'CR', year: 822, month: 'Redleaf', day: 16 });
    assert.deepEqual(row.birthDate, { era: 'CR', year: 809, month: 'Redleaf', day: 16 });
});
