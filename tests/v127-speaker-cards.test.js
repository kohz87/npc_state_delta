import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { othersSlotsHtml, presentSceneModel, speakerChatterHtml, speakerGroups } from '../present-scene.js';

// Present NPCs (1.2.7): someone who speaks in the chatter without a present card gets a card of
// their own, in the same card-and-bubble cell; only lines with no speaker stay under Others.

const cards = [{ id: 'yun', name: 'Yunyun' }];

test('v1.2.7 named speakers without a card are grouped, in the order they first speak', () => {
    const model = presentSceneModel({ cards, chatterText: 'Lieke: One silver won\'t stop the Captain.\nYunyun: Is he looking?\nPalisade Sentry: Another river rat.\nlieke: Noon, then.' });
    const groups = speakerGroups(model);
    assert.deepEqual(groups.map(group => [group.name, model.texts[group.speaker], group.lines.map(line => [line.order, model.texts[line.text]])]), [
        ['Lieke', 'Lieke', [[1, 'One silver won\'t stop the Captain.'], [4, 'Noon, then.']]],
        ['Palisade Sentry', 'Palisade Sentry', [[3, 'Another river rat.']]],
    ]);
    const bubbles = speakerChatterHtml(model, groups[0]);
    assert.match(bubbles, /class="npc-state-delta-chatter npc-state-delta-chatter-speech"/);
    assert.match(bubbles, /bubble-order" aria-hidden="true">1<[\s\S]*bubble-order" aria-hidden="true">4</);
    assert.doesNotMatch(bubbles, /Captain/, 'text arrives through slots');
    assert.equal(othersSlotsHtml(model, { speakerless: true }), '', 'no line without a speaker');
    assert.match(othersSlotsHtml(model), />Others</, 'the old line is still available');
});

test('v1.2.7 one speaker alone thinks; a line with no speaker stays under Others', () => {
    const model = presentSceneModel({ cards: [], chatterText: 'Lieke: Keep the fee.' });
    assert.equal(model.kind, 'thought');
    assert.match(speakerChatterHtml(model, speakerGroups(model)[0]), /npc-state-delta-chatter-thought/);
    const loose = presentSceneModel({ cards, chatterText: 'Somebody mutters in the crowd.\nYunyun: What?' });
    assert.deepEqual(speakerGroups(loose), []);
    assert.match(othersSlotsHtml(loose, { speakerless: true }), />Others</);
    assert.deepEqual(speakerGroups({}), []);
    assert.equal(speakerChatterHtml({}, null), '');
});

test('v1.2.7 the roster renders speaker cards after the present ones: a dossier\'s portrait, else the initial', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /const speakerCells = speakerGroups\(scene\)\.map\(group => speakerCellHtml\(group, scene, messageId\)\)\.filter\(Boolean\);/);
    assert.match(index, /<small>\$\{visible\.length \+ speakerCells\.length\} shown<\/small>/, 'the count covers every card shown');
    assert.match(index, /othersSlotsHtml\(scene, \{ speakerless: true \}\)/);
    assert.match(index, /visible\.map\(npc => inlineCardHtml\(npc, messageId, scene\)\)\.join\(''\)\}\$\{speakers\}/);
    assert.match(index, /function speakerCellHtml[\s\S]*matchPresentCard\(group\.name,[\s\S]*portraitMarkup\(npc, displayName[\s\S]*data-npc-id="\$\{escapeHtml\(npc\.id\)\}"/, 'a tracked NPC opens their dossier');
    assert.match(index, /npc-state-delta-present-card-untracked[\s\S]*data-delta-text="\$\{Number\(group\.speaker\)\}"[\s\S]*Not in the dossiers yet/, 'an unknown name arrives through a text slot');
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.npc-state-delta-present-card-untracked,\n\.npc-state-delta-present-cell-untracked \.npc-state-delta-chatter \{ cursor: default; \}/);
});
