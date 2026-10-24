import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    cleanMessage, currentExchangeProse, currentExchangeTranscript, currentExchangeUserDevelopmentContext, currentExclusions,
    recentTranscript, recentUserDevelopmentContext, storyDayAt, storyDaysForTranscript, useTranscriptSource,
} from '../src/transcript.js';

// Cleanup step 10: the chat text helpers moved from index.js to src/transcript.js unchanged.

const chat = [
    { is_user: false, name: 'Narrator', mes: 'The guild hall is quiet.' },
    { is_user: true, name: 'Kazuma', mes: 'Who is at the gate?' },
    { is_system: true, mes: 'hidden' },
    { is_user: false, name: 'Narrator', mes: 'Yunyun waits at the gate.' },
];
useTranscriptSource({ context: () => ({ chat, name1: 'Kazuma', name2: 'Narrator' }), scanDepth: () => 6 });

test('the chat text helpers read the wired context', () => {
    assert.equal(cleanMessage(chat[1]), 'Kazuma: Who is at the gate?');
    assert.equal(cleanMessage(chat[2]), '', 'system messages are not story');
    assert.equal(recentTranscript(), 'Narrator: The guild hall is quiet.\nKazuma: Who is at the gate?\nNarrator: Yunyun waits at the gate.');
    assert.equal(recentTranscript(2, { messageIds: true }), '[m1] Kazuma: Who is at the gate?\n[m3] Narrator: Yunyun waits at the gate.');
    assert.equal(recentUserDevelopmentContext(), '[m1] Kazuma: Who is at the gate?');
    assert.equal(currentExchangeTranscript(), 'Kazuma: Who is at the gate?\nNarrator: Yunyun waits at the gate.');
    assert.equal(currentExchangeUserDevelopmentContext(), '[m1] Kazuma: Who is at the gate?');
    assert.equal(currentExchangeProse(), 'Kazuma: Who is at the gate?\nNarrator: Yunyun waits at the gate.');
    assert.deepEqual(currentExclusions(), ['Kazuma', 'Narrator']);
    assert.equal(storyDayAt(3), null);
    assert.deepEqual(storyDaysForTranscript('[m1] a\n[m3] b'), {});
});

test('index.js wires the helpers and keeps no copy', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /useTranscriptSource\(\{ context: \(\) => getContext\(\), scanDepth: \(\) => getSettings\(\)\.scanDepth \}\);/);
    assert.doesNotMatch(index, /^function (?:cleanMessage|recentTranscript|currentExchangeTranscript|storyDayAt)\(/m);
});
