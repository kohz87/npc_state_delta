import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildScannerPrompt,
    deriveBirthDateFromAge,
    deterministicBirthday,
    mergeScanResult,
    normalizeBirthDate,
    normalizeNpcRecord,
    normalizeScanNpc,
} from '../core.js';

test('deterministic birthday fallback is stable month/day only', () => {
    const first = deterministicBirthday('npc_sora');
    assert.match(first, /^\d{2}-\d{2}$/);
    assert.equal(deterministicBirthday('npc_sora'), first);

    const record = normalizeNpcRecord({ id: 'npc_sora', name: 'Sora', age: '6', apparentAge: '~6' });
    assert.equal(record.birthDate, first);
    assert.equal(record.birthDateSource, 'generated');
    assert.equal(record.birthDatePrecision, 'month-day');
});

test('birth-date normalization validates month/day and full dates', () => {
    assert.equal(normalizeBirthDate('9/7'), '09-07');
    assert.equal(normalizeBirthDate('1032/9/7'), '1032-09-07');
    assert.equal(normalizeBirthDate('2023-02-29'), '');
    assert.equal(normalizeBirthDate('2024-02-29'), '2024-02-29');
    assert.equal(normalizeBirthDate('13-01'), '');
});

test('full birth year can be derived only with exact age and grounded reference date', () => {
    assert.equal(deriveBirthDateFromAge('05-20', '6', '1032-09-12'), '1026-05-20');
    assert.equal(deriveBirthDateFromAge('11-20', '6', '1032-09-12'), '1025-11-20');
    assert.equal(deriveBirthDateFromAge('11-20', '~6', '1032-09-12'), '');
    assert.equal(deriveBirthDateFromAge('11-20', '6', ''), '');
});

test('scanner birthday fields are normalized without using apparent age', () => {
    const incoming = normalizeScanNpc({
        id: 'npc_sora',
        name: 'Sora',
        apparentAge: '~6',
        birthDate: '09/17',
        birthDateState: 'establish',
        birthDateReason: 'The story explicitly names September 17 as her birthday.',
    });
    assert.equal(incoming.birthDate, '09-17');
    assert.equal(incoming.birthDateState, 'establish');
    assert.match(incoming.birthDateReason, /explicitly names/);
});

test('explicit birthday replaces generated fallback and later overwrite requires correction', () => {
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
            birthDate: '09-17',
            birthDateState: 'establish',
            birthDateReason: 'Explicit birthday.',
        }],
    }, { sourceMessageId: 8 });
    let sora = established.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDate, '09-17');
    assert.equal(sora.birthDateSource, 'established');
    assert.equal(sora.birthDateSourceMessageId, 8);

    const ordinaryOverwrite = mergeScanResult(established.state, {
        npcs: [{ id: 'npc_sora', name: 'Sora', birthDate: '10-01', birthDateState: 'establish' }],
    }, { sourceMessageId: 9 });
    sora = ordinaryOverwrite.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDate, '09-17');

    const corrected = mergeScanResult(ordinaryOverwrite.state, {
        npcs: [{
            id: 'npc_sora',
            name: 'Sora',
            birthDate: '10-01',
            birthDateState: 'correct',
            birthDateReason: 'Explicit correction.',
        }],
    }, { sourceMessageId: 10 });
    sora = corrected.state.npcs.find(npc => npc.id === 'npc_sora');
    assert.equal(sora.birthDate, '10-01');
    assert.equal(sora.birthDateSourceMessageId, 10);
});

test('birthday prompt rule is conditional instead of bloating ordinary scans', () => {
    const ordinary = buildScannerPrompt({
        transcript: 'Sora crosses the room and sits beside the window.',
        existingNpcs: [],
        candidates: [],
    });
    assert.equal(ordinary.includes('BIRTHDAY:'), false);

    const birthday = buildScannerPrompt({
        transcript: "Today is Sora's sixth birthday, September 17.",
        existingNpcs: [],
        candidates: [],
    });
    assert.equal(birthday.includes('BIRTHDAY:'), true);
    assert.equal(birthday.includes('Never derive from apparentAge, species, or lifespan'), true);
    assert.equal(birthday.includes('Delta generates the fallback locally'), true);
});
