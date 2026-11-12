import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LOOK_TEXT_MAX,
    isLookLocked,
    lookDrift,
    lookFlagKey,
    lookFlagWording,
    lookStamp,
    lookText,
    readLookStamp,
    stampLook,
} from '../src/npc-notes-look.js';

const LOCK = 'white hair, yellow-green eyes';

test('lookDrift is empty without a lock, without incoming text, or for the same look', () => {
    assert.equal(lookDrift('', 'black hair'), '');
    assert.equal(lookDrift(LOCK, ''), '');
    assert.equal(lookDrift(LOCK, { incoming: '   ' }), '');
    assert.equal(lookDrift(LOCK, LOCK), '');
    assert.equal(lookDrift(LOCK, '  White Hair, Yellow-Green Eyes.  '), '');
});

test('lookDrift names the refused text and the fixed look', () => {
    assert.equal(
        lookDrift(LOCK, 'black hair, green eyes'),
        'Look drift refused: "black hair, green eyes" does not match the fixed look "white hair, yellow-green eyes".',
    );
    assert.equal(
        lookDrift(LOCK, { incoming: 'black hair' }),
        'Look drift refused: "black hair" does not match the fixed look "white hair, yellow-green eyes".',
    );
});

test('lookDrift caps long text to LOOK_TEXT_MAX on each side', () => {
    const long = 'x'.repeat(500);
    const out = lookDrift(long, long.replace(/x/g, 'y'));
    const quoted = out.match(/"([^"]*)"/g).map(part => part.slice(1, -1));
    assert.equal(quoted.length, 2);
    for (const part of quoted) assert.equal(part.length, LOOK_TEXT_MAX);
});

test('lookText strips control characters and collapses spacing', () => {
    assert.equal(lookText('  white\u0007  hair\n eyes '), 'white hair eyes');
    assert.equal(lookText(undefined), '');
});

test('lookFlagWording gives the one-reply cue with the name and the lock', () => {
    assert.equal(
        lookFlagWording('Rika', LOCK),
        "Rika's look is fixed: white hair, yellow-green eyes. Keep it unless the story shows why it changed.",
    );
    assert.equal(
        lookFlagWording('Doris', LOCK),
        "Doris' look is fixed: white hair, yellow-green eyes. Keep it unless the story shows why it changed.",
    );
    assert.match(lookFlagWording('', LOCK), /^The NPC's look is fixed: /);
    assert.equal(lookFlagWording('Rika', ''), '');
});

test('lookFlagKey is the same for the same reply and text, and differs by reply', () => {
    assert.equal(lookFlagKey('r1', 'a'), lookFlagKey('r1', 'a'));
    assert.notEqual(lookFlagKey('r1', 'a'), lookFlagKey('r2', 'a'));
    assert.notEqual(lookFlagKey('r1', 'a'), lookFlagKey('r1', 'b'));
});

test('lookStamp keeps a whole day and a reply id, and refuses bad input', () => {
    assert.deepEqual(lookStamp(4.9, ' r7 '), { day: 4, r: 'r7' });
    assert.deepEqual(lookStamp(0, 'r0'), { day: 0, r: 'r0' });
    assert.equal(lookStamp(-1, 'r1'), null);
    assert.equal(lookStamp('x', 'r1'), null);
    assert.equal(lookStamp(3, '   '), null);
    assert.equal(lookStamp(undefined, 'r1'), null);
});

test('readLookStamp reads only a well-formed stamp object', () => {
    assert.deepEqual(readLookStamp({ day: 2, r: 'r2' }), { day: 2, r: 'r2' });
    assert.equal(readLookStamp('{"day":2,"r":"r2"}'), null);
    assert.equal(readLookStamp({ day: -2, r: 'r2' }), null);
    assert.equal(readLookStamp(null), null);
});

test('stampLook sets the stamp when the look goes from empty to set', () => {
    assert.deepEqual(stampLook('', LOCK, null, 5, 'r5'), { day: 5, r: 'r5' });
});

test('stampLook keeps the stamp on refinements and when the look is empty on both sides', () => {
    const stamp = { day: 2, r: 'r2' };
    assert.deepEqual(stampLook(LOCK, 'white hair, yellow-green eyes, freckles', stamp, 9, 'r9'), stamp);
    assert.deepEqual(stampLook('', '', stamp, 9, 'r9'), stamp);
    assert.equal(stampLook('', '', null, 9, 'r9'), null);
});

test('stampLook does not set a stamp without a usable reply id', () => {
    assert.equal(stampLook('', LOCK, null, 5, ''), null);
    assert.deepEqual(stampLook('', LOCK, { day: 1, r: 'r1' }, 5, ''), { day: 1, r: 'r1' });
});

test('isLookLocked needs both the look text and a readable stamp', () => {
    assert.equal(isLookLocked(LOCK, { day: 1, r: 'r1' }), true);
    assert.equal(isLookLocked(LOCK, null), false);
    assert.equal(isLookLocked('', { day: 1, r: 'r1' }), false);
    assert.equal(isLookLocked(LOCK, { day: 1, r: '' }), false);
});

test('lookDrift names a trait the scan kept (card traits win): the story said one value, the record keeps another', () => {
    assert.equal(
        lookDrift('Brown eyes ringed dark.', { incoming: 'Pale eyes ringed dark.', name: 'Sister Temiwa', swaps: [{ trait: 'eyes', said: 'pale', kept: 'brown' }] }),
        'Look drift refused: the story called Sister Temiwa\'s eyes pale; the record keeps brown.',
    );
    assert.equal(
        lookDrift(LOCK, { incoming: 'black hair, green eyes', name: 'Rika', swaps: [{ trait: 'hair', said: 'black', kept: 'white' }, { trait: 'eyes', said: 'green', kept: 'yellow green' }] }),
        'Look drift refused: the story called Rika\'s hair black; the record keeps white. The story called Rika\'s eyes green; the record keeps yellow green.',
    );
    assert.equal(lookDrift(LOCK, { incoming: 'black hair', swaps: [{ trait: '', said: 'x', kept: 'y' }] }), 'Look drift refused: "black hair" does not match the fixed look "white hair, yellow-green eyes".', 'a malformed swap falls back');
});
