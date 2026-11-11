// NPC notes, drives (src/npc-notes-drives.js): the stored strength leaf (readDrives, setDrives), the first-time seed from a cast
// pack entry or the first description (seedDrives), the strength multiplier the pull applies (applyStrength, scaledInst) and the
// dossier rows (driveRows). Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DRIVES, DRIVE_DEFAULT, DRIVES_TEXT_MAX, readDrives, setDrives, seedDrives, strengthMultiplier, applyStrength, scaledInst, driveRows,
} from '../src/npc-notes-drives.js';

const allDefault = () => Object.fromEntries(DRIVES.map(drive => [drive.key, DRIVE_DEFAULT]));

test('DRIVES: seven drives in a fixed order, the first three keyed like the mood-pull instincts', () => {
    assert.deepEqual(DRIVES.map(drive => drive.kind), ['belonging', 'closure', 'awe', 'preservation', 'comfort', 'conflict', 'honesty']);
    assert.deepEqual(DRIVES.slice(0, 3).map(drive => drive.key), ['belo', 'clos', 'awe']);
    assert.equal(DRIVE_DEFAULT, 2);
});

test('readDrives: absent leaf reads as the defaults; a partial object fills the rest with defaults', () => {
    assert.deepEqual(readDrives(undefined), allDefault());
    assert.deepEqual(readDrives(null), allDefault());
    assert.deepEqual(readDrives(''), allDefault());
    assert.deepEqual(readDrives('{"belo":3}'), { ...allDefault(), belo: 3 });
    assert.deepEqual(readDrives('{}'), allDefault());
});

test('readDrives: malformed, unknown, out-of-range or over-long leaves read as null', () => {
    assert.equal(readDrives('not json'), null);
    assert.equal(readDrives('[]'), null);
    assert.equal(readDrives('"belo"'), null);
    assert.equal(readDrives('{"belo":4}'), null);
    assert.equal(readDrives('{"belo":-1}'), null);
    assert.equal(readDrives('{"belo":1.5}'), null);
    assert.equal(readDrives('{"belo":"2"}'), null);
    assert.equal(readDrives('{"love":2}'), null);
    assert.equal(readDrives('{"belo":2,"love":2}'), null);
    assert.equal(readDrives(42), null);
    assert.equal(readDrives(`{"belo":${'1'.repeat(DRIVES_TEXT_MAX)}}`), null);
});

test('setDrives: writes the merged object in fixed key order, whatever order the changes arrive in', () => {
    const one = setDrives(undefined, { hone: 0, belo: 3 });
    const two = setDrives(undefined, { belo: 3, hone: 0 });
    assert.equal(one, two);
    assert.deepEqual(readDrives(one), { ...allDefault(), belo: 3, hone: 0 });
    assert.equal(one, JSON.stringify(Object.fromEntries(DRIVES.map(drive => [drive.key, readDrives(one)[drive.key]]))));
});

test('setDrives: a later write keeps the stored values and does not reseed', () => {
    const stored = setDrives(undefined, { belo: 1 });
    const again = setDrives(stored, { clos: 3 }, { pack: { drives: { honesty: 3 } } });
    assert.deepEqual(readDrives(again), { ...allDefault(), belo: 1, clos: 3 });
});

test('setDrives: rejects unknown keys, non-strengths, a non-object change and an unusable stored leaf', () => {
    assert.equal(setDrives(undefined, { love: 2 }), null);
    assert.equal(setDrives(undefined, { belo: 4 }), null);
    assert.equal(setDrives(undefined, { belo: 2.5 }), null);
    assert.equal(setDrives(undefined, { belo: 2, clos: 'x' }), null);
    assert.equal(setDrives(undefined, null), null);
    assert.equal(setDrives(undefined, ['belo']), null);
    assert.equal(setDrives('not json', { belo: 1 }), null);
});

test('seedDrives: a cast pack object wins, by kind name or short key', () => {
    assert.deepEqual(seedDrives({ drives: { belonging: 3, clos: 0 } }), { ...allDefault(), belo: 3, clos: 0 });
    assert.deepEqual(seedDrives({ drives: { honesty: 1 } }), { ...allDefault(), hone: 1 });
});

test('seedDrives: a pack list of kind names marks those drives high and the rest default', () => {
    assert.deepEqual(seedDrives({ drives: ['Awe', 'comfort', 'unknown'] }), { ...allDefault(), awe: 3, comf: 3 });
    assert.deepEqual(seedDrives({ drives: ['awe'] }), { ...allDefault(), awe: 3 });
});

test('seedDrives: with no usable pack drives, the first description is scanned for drive words', () => {
    const seeded = seedDrives({}, 'She is honest with everyone and wants to protect the village.');
    assert.deepEqual(seeded, { ...allDefault(), hone: 3, pres: 3 });
    assert.deepEqual(seedDrives(null, 'A quiet cook.'), allDefault());
    assert.deepEqual(seedDrives(undefined, undefined), allDefault());
});

test('seedDrives: a pack object with strengths does not also read the description', () => {
    assert.deepEqual(seedDrives({ drives: { belonging: 1 } }, 'Honest to a fault.'), { ...allDefault(), belo: 1 });
});

test('seedDrives: short words only match whole tokens (kin does not match kingdom)', () => {
    assert.deepEqual(seedDrives({}, 'From the kingdom of the east.'), allDefault());
});

test('setDrives: a first write uses the seed; with no leaf and no seed it is the defaults plus the change', () => {
    const seeded = setDrives(undefined, {}, { pack: { drives: { comfort: 3 } } });
    assert.deepEqual(readDrives(seeded), { ...allDefault(), comf: 3 });
    assert.deepEqual(readDrives(setDrives(undefined, { awe: 0 })), { ...allDefault(), awe: 0 });
});

test('strengthMultiplier: 0 mutes, 2 is one, other strengths step by a half', () => {
    assert.equal(strengthMultiplier(0), 0);
    assert.equal(strengthMultiplier(1), 0.5);
    assert.equal(strengthMultiplier(2), 1);
    assert.equal(strengthMultiplier(3), 1.5);
    assert.equal(strengthMultiplier(9), 1);
    assert.equal(strengthMultiplier(undefined), 1);
});

test('applyStrength: scores scale and stay in 0..3; default strength leaves a score as it is', () => {
    assert.equal(applyStrength(0, 3), 0);
    assert.equal(applyStrength(3, 0), 0);
    assert.equal(applyStrength(2, DRIVE_DEFAULT), 2);
    assert.equal(applyStrength(3, 1), 2);
    assert.equal(applyStrength(2, 1), 1);
    assert.equal(applyStrength(2, 3), 3);
    assert.equal(applyStrength(3, 3), 3);
    assert.equal(applyStrength(NaN, 2), 0);
    assert.equal(applyStrength(3, undefined), 3);
});

test('scaledInst: each instinct is scaled by its drive, unknown keys dropped, missing drives default', () => {
    const drives = { ...allDefault(), belo: 0, clos: 3 };
    assert.deepEqual(scaledInst({ belo: 3, clos: 1, awe: 2, love: 3 }, drives), { belo: 0, clos: 2, awe: 2 });
    assert.deepEqual(scaledInst({ belo: 3, awe: 1 }, null), { belo: 3, awe: 1 });
    assert.deepEqual(scaledInst(null, drives), {});
});

test('driveRows: seven rows in fixed order with labels and words; defaults read normal', () => {
    const rows = driveRows(null);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map(row => row.label), ['Belonging', 'Closure', 'Awe', 'Preservation', 'Comfort', 'Conflict', 'Honesty']);
    assert.ok(rows.every(row => row.strength === 2 && row.word === 'normal'));
});

test('driveRows: strengths map to off, low, normal and high', () => {
    const rows = driveRows({ ...allDefault(), belo: 0, clos: 1, awe: 3 });
    assert.deepEqual(rows.slice(0, 3).map(row => row.word), ['off', 'low', 'high']);
    assert.deepEqual(rows.slice(0, 3).map(row => row.strength), [0, 1, 3]);
});
