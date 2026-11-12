// NPC notes, drives (src/npc-notes-drives.js): the stored strength leaf (readDrives, setDrives), the first-time seed from a cast
// pack entry or the first description (seedDrives), the strength multiplier the pull applies (applyStrength, scaledInst) and the
// dossier rows (driveRows). Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DRIVES, DRIVE_DEFAULT, DRIVE_RULE, growDrives, driveEvidence, DRIVES_TEXT_MAX, readDrives, setDrives, seedDrives, strengthMultiplier, applyStrength, scaledInst, driveRows,
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
    const seeded = seedDrives({}, 'She is honest and frank with everyone and wants to protect and guard the village.');
    assert.deepEqual(seeded, { ...allDefault(), hone: 3, pres: 3 });
    assert.deepEqual(seedDrives(null, 'A quiet cook.'), allDefault());
    assert.deepEqual(seedDrives(undefined, undefined), allDefault());
});

test('seedDrives: a pack object with strengths does not also read the description', () => {
    assert.deepEqual(seedDrives({ drives: { belonging: 1 } }, 'Honest and frank to a fault.'), { ...allDefault(), belo: 1 });
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

test('seeding: ONE cue word keeps a drive normal, TWO DIFFERENT cue words start it high, a repeated word is still one, the pack wins', () => {
    assert.deepEqual(seedDrives({}, 'A friend to all, quiet and plain.'), allDefault(), 'one cue: normal');
    assert.deepEqual(seedDrives({}, 'Friend, friend, friend.'), allDefault(), 'the same word three times is one cue');
    assert.deepEqual(seedDrives({}, 'A loyal friend who misses her family.'), { ...allDefault(), belo: 3 }, 'two different cues: high');
    assert.deepEqual(seedDrives({ drives: { honesty: 0 } }, 'A loyal friend who misses her family.'), { ...allDefault(), hone: 0 }, 'pack wins');
    assert.deepEqual(seedDrives({ drives: ['comfort'] }, 'A loyal friend who misses her family.'), { ...allDefault(), comf: 3 }, 'a pack list wins too');
});

test('driveRows: a note says where a non-normal drive came from (pack, description, growth); normal shows none', () => {
    const fromPack = setDrives(undefined, {}, { pack: { drives: { honesty: 3, belonging: 1 } } });
    const rows = driveRows(readDrives(fromPack), fromPack);
    assert.equal(rows.find(row => row.key === 'hone').note, 'set by the pack');
    assert.equal(rows.find(row => row.key === 'belo').note, 'set by the pack');
    assert.equal(rows.find(row => row.key === 'awe').note, '', 'normal: no note');
    const fromText = setDrives(undefined, {}, { description: 'protect and guard' });
    assert.equal(driveRows(readDrives(fromText), fromText).find(row => row.key === 'pres').note, 'from their description');
    const grew = growTwice('belo-cue: a friend', 'family came to visit');
    assert.match(driveRows(readDrives(grew), grew).find(row => row.key === 'belo').note, /^grew over 2 story moments/);
    assert.equal(driveRows(readDrives(setDrives(undefined, {}, {})), undefined).every(row => row.note === ''), true);
    const set = setDrives(fromPack, { hone: 2 });
    assert.equal(driveRows(readDrives(set), set).find(row => row.key === 'hone').note, '');
});

function growTwice(a, b, leaf) {
    const one = growDrives(leaf, [a], 'r1');
    return growDrives(one.leaf, [b], 'r2').leaf;
}

test('growth: a cue in ONE reply only remembers it; the same drive in a SECOND, different reply steps it one level', () => {
    const first = growDrives(undefined, ['She made a new friend'], 'r1');
    assert.deepEqual(readDrives(first.leaf), allDefault(), 'no step yet');
    assert.deepEqual(first.steps, []);
    assert.equal(growDrives(first.leaf, ['another friend'], 'r1'), null, 'the same reply again counts once');
    const second = growDrives(first.leaf, ['her family wrote'], 'r2');
    assert.equal(readDrives(second.leaf).belo, 3);
    assert.deepEqual(second.steps.map(step => [step.key, step.from, step.to]), [['belo', 2, 3]]);
    assert.equal(growDrives(second.leaf, ['yet another friend'], 'r3'), null, 'max 3: nothing more');
});

test('growth: opposite cues step a drive down, never below 0, and a cue the other way restarts the count', () => {
    const down = growTwice('she stays alone', 'an aloof loner');
    assert.equal(readDrives(down).belo, 1);
    assert.match(driveRows(readDrives(down), down).find(row => row.key === 'belo').note, /^eased over 2 story moments/);
    const lower = growTwice('alone again', 'distant as ever', down);
    assert.equal(readDrives(lower).belo, 0);
    assert.equal(growDrives(lower, ['alone'], 'r9'), null, 'min 0');
    const mixed = growDrives(growDrives(undefined, ['a friend'], 'r1').leaf, ['she is alone'], 'r2');
    assert.equal(readDrives(mixed.leaf).belo, 2, 'an opposite cue replaces the pending one');
    assert.equal(readDrives(growDrives(mixed.leaf, ['alone again'], 'r3').leaf).belo, 1);
});

test('growth: cues both ways in one reply, or none, count for nothing; one step per drive per reply; other drives are independent', () => {
    assert.equal(growDrives(undefined, ['a friend, but alone'], 'r1'), null);
    assert.equal(growDrives(undefined, ['nothing of note'], 'r1'), null);
    const a = growDrives(undefined, ['a friend, honest and frank, wants to protect'], 'r1');
    const b = growDrives(a.leaf, ['friend', 'family', 'kin'], 'r2');
    assert.deepEqual(b.steps.map(step => step.key), ['belo'], 'only the drive whose cues showed again');
    assert.equal(readDrives(b.leaf).belo, 3);
    assert.equal(readDrives(b.leaf).hone, 2);
});

test('growth: only a usable leaf and a reply id are accepted; the stored leaf stays valid and short', () => {
    assert.equal(growDrives('not json', ['friend'], 'r1'), null);
    assert.equal(growDrives(undefined, ['friend'], null), null);
    const full = DRIVES.reduce((leaf, drive) => growDrives(leaf, [drive.words[0]], 'r1')?.leaf ?? leaf, undefined);
    assert.notEqual(readDrives(full), null);
    assert.ok(full.length <= DRIVES_TEXT_MAX);
    assert.equal(DRIVE_RULE, 1);
});

test('driveEvidence: only what is new (memories, behavior, mannerisms, the changed reason)', () => {
    const before = { memories: ['old'], behaviorProfile: [], lastRelationshipChange: { reason: 'same' } };
    const after = { memories: ['old', { text: 'met a friend' }], behaviorProfile: ['keeps apart'], mannerisms: ['hums'], lastRelationshipChange: { reason: 'same' } };
    assert.deepEqual(driveEvidence(before, after), ['met a friend', 'keeps apart', 'hums']);
    assert.deepEqual(driveEvidence(after, after), []);
    assert.deepEqual(driveEvidence(undefined, { lastRelationshipChange: { reason: 'shared a meal' } }), ['shared a meal']);
});

test('negation: evidence that says a drive is weak never raises it, for every drive', () => {
    const twice = (a, b) => growDrives(growDrives(undefined, [a], 'r1')?.leaf, [b], 'r2');
    const liar = readDrives(twice('Honesty: low - lies to cover for her brother', 'Honesty: low - lies again').leaf);
    assert.equal(liar.hone, 1, 'a low Honesty lever lowers Honesty');
    assert.equal(readDrives(twice('Honesty: high - tells the truth', 'Honesty: high - speaks frankly').leaf).hone, 3);
    assert.equal(twice('Honesty: moderate - hedges', 'Honesty: moderate - hedges again'), null, 'a middle level counts for nothing');
    const cases = { belo: 'has no family and no friend', clos: 'never feels closure, no unresolved debt', awe: 'no wonder, not curious', pres: 'does not protect, will not defend', comf: 'no rest, never cozy', conf: 'no feud, no rival', hone: 'not honest, never candid' };
    for (const drive of DRIVES) {
        const text = cases[drive.key];
        const result = twice(text, `${text} again`);
        const after = result ? readDrives(result.leaf)[drive.key] : 2;
        assert.ok(after <= 2, `${drive.label}: "${text}" never raises it`);
    }
    assert.equal(readDrives(twice('dishonest and a liar', 'a dishonest man').leaf).hone, 1, 'dishonest counts down');
    assert.match(growDrives(undefined, ['not honest, no truth'], 'r1').leaf, /"e":"d:r1"/, 'negated cues count toward the opposite direction, never up');
    assert.equal(seedDrives(undefined, 'not honest and no truth at all')[DRIVES[6].key], 2, 'seeding reads negation too');
    assert.equal(seedDrives(undefined, 'honest and frank')[DRIVES[6].key], 3);
});

test('growth: a cue only in the NPC\'s name or role text is no evidence; a negator does not reach across lines', () => {
    const a = growDrives(undefined, ['Guard Rilke stood'], 'r1', 'Rilke Guard');
    assert.equal(a, null, 'guard is the role');
    const b = growDrives(undefined, ['she will protect Rilke'], 'r1', 'Rilke Guard');
    assert.ok(b, 'protect is not the role');
    assert.equal(readDrives(growDrives(b.leaf, ['a shield for the village'], 'r2', 'Rilke Guard').leaf).pres, 3);
    const lines = growDrives(growDrives(undefined, ['no luck', 'a friend'], 'r1').leaf, ['her family', 'not at all'], 'r2');
    assert.equal(readDrives(lines.leaf).belo, 3, 'a negator on one line leaves the next line\'s cue alone');
});

test('leaf size: the worst leaf the caps allow still reads (the limit holds it)', () => {
    const x = Object.fromEntries(DRIVES.map(drive => [drive.key, { s: 'u', n: 999, c: 'c'.repeat(24), e: `u:${'r'.repeat(40)}`.slice(0, 42) }]));
    const leaf = JSON.stringify({ ...Object.fromEntries(DRIVES.map(drive => [drive.key, 3])), x });
    assert.ok(leaf.length <= DRIVES_TEXT_MAX, `${leaf.length} characters`);
    assert.notEqual(readDrives(leaf), null);
});
