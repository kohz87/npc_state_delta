import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMessageCitations } from '../core-text.js';
import { buildInjection, createNpcRecord, mergeScanResult, normalizeNpcRecord } from '../core.js';
import { tagScanEvidence } from '../core-evidence.js';
import { stripRecordCitations } from '../core-record.js';

const USER_SENTENCE = 'Young woman with a slight frame and an easily distressed demeanor';

test('the USER\'s sentence: a trailing citation list is removed', () => {
    assert.equal(stripMessageCitations(`${USER_SENTENCE} [m1, m2]`), USER_SENTENCE);
});

test('each citation pattern goes, with no stray space or punctuation left', () => {
    const cases = [
        ['calm [m1] and', 'calm and'], ['calm [m1, m2] and', 'calm and'], ['calm [m1,m2,m14] and', 'calm and'],
        ['calm [m3-m5] and', 'calm and'], ['calm [m3–5] and', 'calm and'], ['calm [m3–m5] and', 'calm and'],
        ['calm (m1, m2) and', 'calm and'], ['calm [message 12] and', 'calm and'], ['calm [messages 3, 4] and', 'calm and'],
        ['calm [message 12 · user] and', 'calm and'], ['calm [M7] and', 'calm [M7] and'],
        ['calm [m1]. Next', 'calm. Next'], ['calm [m1], then', 'calm, then'], ['calm, [m1]', 'calm'],
        ['calm [m1] [m2] and', 'calm and'], ['[m1] calm', 'calm'], ['calm.[m1]', 'calm.'],
    ];
    for (const [input, expected] of cases) assert.equal(stripMessageCitations(input), expected, input);
});

test('other brackets, parentheses and an "m" inside words survive untouched', () => {
    for (const text of ['[Rank F] swordswoman', 'ears (the left notched)', 'a tomato m1 mark', 'made of [m] iron', 'ages (12, 14)', 'room [4]',
        'mm1 [mm1]', '[m1 and a half]', '(message to the guild)', 'item [message board]']) {
        assert.equal(stripMessageCitations(text), text);
    }
    assert.equal(stripMessageCitations(''), '');
    assert.equal(stripMessageCitations(undefined), undefined);
    const once = stripMessageCitations('a [m1, m2] b [m3].');
    assert.equal(stripMessageCitations(once), once);
});

const dirty = () => ({
    ...createNpcRecord('Mira'),
    role: 'Apprentice cook [m3]', appearance: `${USER_SENTENCE} [m1, m2]`, overallAppearance: `${USER_SENTENCE} [m1, m2]`,
    personality: 'Guarded, quietly proud [m4].', speech: 'Short, clipped sentences [m5, m6]', background: 'Fled a burning village [m2-m4]',
    mood: 'Wary [m9]', location: 'Mill yard (m9)', goal: 'Earn coin [message 9]', status: 'Hauling water [m9]',
    relationshipSummary: 'Distrustful [m7]',
    mannerisms: ['Tucks hair behind an ear [m2]'], behaviorProfile: ['Threat Sensitivity: high - scans strangers [m3, m4]'],
    memories: ['Was cheated of wages [m8]'], keyRelationships: ['Old Tam — employer | stern [m2]'],
    profileEvidence: { personality: ['[m12] She flinched [m12, m13]'], speech: [], appearance: [], mannerisms: [], behaviorProfile: [] },
});

test('normalizeNpcRecord strips citations from every stored text field and list item; evidence keeps its leading tag', () => {
    const npc = normalizeNpcRecord(dirty());
    for (const key of ['role', 'appearance', 'overallAppearance', 'personality', 'speech', 'background', 'mood', 'location', 'goal', 'status', 'relationshipSummary']) {
        assert.doesNotMatch(npc[key], /\[m\d|\(m\d|\[message/i, key);
    }
    for (const key of ['mannerisms', 'behaviorProfile', 'memories', 'keyRelationships']) {
        for (const item of npc[key]) assert.doesNotMatch(item, /\[m\d/i, key);
    }
    assert.equal(npc.appearance, USER_SENTENCE);
    assert.equal(npc.role, 'Apprentice cook');
    assert.deepEqual(npc.profileEvidence.personality, ['[m12] She flinched']);
});

test('a stored old dossier is cleaned on load, and normalizing again changes nothing', () => {
    const once = normalizeNpcRecord(dirty());
    assert.deepEqual(normalizeNpcRecord(once), once);
    assert.deepEqual(normalizeNpcRecord(JSON.parse(JSON.stringify(once))), once);
});

test('named appearance forms are cleaned too', () => {
    const npc = normalizeNpcRecord({ ...dirty(), appearanceForms: [{ name: 'Wolf', appearance: 'Gray wolf with a notched ear [m5, m6]' }] });
    assert.match(npc.appearanceForms[0].appearance, /Gray wolf with a notched ear$/);
    assert.doesNotMatch(JSON.stringify(npc.appearanceForms), /\[m\d/);
});

test('a scan that carries citations stores clean fields; evidence is tagged once with its own message', () => {
    const scan = tagScanEvidence({ npcs: [{ name: 'Mira', role: 'Cook [m3]', appearance: `${USER_SENTENCE} [m1, m2]`, present: true, mood: 'Wary [m9]' }],
        profileUpdates: [{ name: 'Mira', evidence: { personality: ['She flinched [m3]'] } }] }, 12);
    assert.equal(scan.profileUpdates[0].evidence.personality[0], '[m12] She flinched [m3]');
    const merged = mergeScanResult({ npcs: [] }, scan, { sourceMessageId: 12 });
    const mira = merged.state.npcs.find(npc => npc.name === 'Mira');
    assert.ok(mira);
    const normalized = normalizeNpcRecord(mira);
    for (const text of [mira.role, mira.mood, mira.appearance, normalized.role, normalized.appearance]) assert.doesNotMatch(String(text), /\[m\d/);
});

test('the narrator injection of a cleaned dossier shows no citation tags', () => {
    const npc = normalizeNpcRecord({ ...dirty(), present: true, lastSeenTurn: 10, seenCount: 5 });
    const text = buildInjection([npc], 'Mira hauls the tub.', 10, 3, undefined, 1800, null);
    assert.match(text, /easily distressed demeanor/);
    assert.doesNotMatch(text, /\[m\d|\(m\d|\[message/i);
});

test('review follow-ups: uppercase look-alikes stay; locked fields and unchanged pack words are not touched', () => {
    assert.equal(stripMessageCitations('Room [M3] is cold'), 'Room [M3] is cold');
    assert.equal(stripMessageCitations('Message [Message 4]'), 'Message [Message 4]');
    assert.equal(stripMessageCitations('Gentle [m1, m2]'), 'Gentle');
    const locked = stripRecordCitations({ personality: 'Lives in room (m2) by choice', manualProfileFields: ['personality'], speech: 'Soft [m3]' });
    assert.equal(locked.personality, 'Lives in room (m2) by choice');
    assert.equal(locked.speech, 'Soft');
    const cast = stripRecordCitations({ overallAppearance: 'Wears the (m2) badge', castFrom: { first: { overallAppearance: 'Wears the (m2) badge' } }, mood: 'Calm [m4]' });
    assert.equal(cast.overallAppearance, 'Wears the (m2) badge');
    assert.equal(cast.mood, 'Calm');
});
