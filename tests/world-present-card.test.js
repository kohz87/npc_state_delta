// World → Here's present card (storysuite-v2.js): no meters on the card (they stay on the Dossiers screen),
// the side copy of the now lines goes, and the card's Mood, Condition and Look are one clamped line each with
// the chatter under the card (style.css). Checked on the source, as the other layout tests here are.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/storysuite-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

test('World → Here draws the present card without meters, and no side copy under it', () => {
    assert.match(source, /const world = track === false;/);
    assert.match(source, /if \(text && !world\) \{[\s\S]*npc-state-delta-present-card-bars/);
    assert.match(source, /const apart = world \? \[\] : meters\.shown\.filter/);
    assert.match(source, /node\.classList\?\.contains\?\.\('npc-state-delta-present-side'\)\) node\.remove/);
});

test('the card shows Mood, Condition and Look one clamped line each; the chatter sits 10px under the card', () => {
    assert.match(css, /\.npc-state-delta-world-cell \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 10px;/);
    assert.match(css, /present-now-part \{ display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;/);
});

test('the outfit line is labelled Look on the card, from the dossier or from World State', () => {
    const present = fs.readFileSync(path.join(root, 'present-scene.js'), 'utf8');
    assert.match(present, /label: part\.key === 'outfit' \? DOSSIER_LOOK_LABEL : part\.label/);
});
