// UI 4c: a dossier row is a Story Block listcard row (portrait, name, role and status, the stage as a pill, the meters as
// thin ss.bar bars), built with DOM APIs and textContent. These tests read the markup the rows serialise to: what a reader
// and a screen reader get, not the stylesheet text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DOSSIER_BAR_MAX, dossierRowNodes } from '../story-block-tabs.js';
import { fakeDocument } from './helpers/fake-dom.js';

const markup = (rows, opts) => dossierRowNodes(rows, fakeDocument(), opts).map(node => node.serialize()).join('');
const fills = html => [...html.matchAll(/<span class="ss-bar-fill" style="--ss-fill: ([0-9.]+)"/g)].map(match => Number(match[1]));
const bar = (id, value, extra = {}) => ({ id, label: id[0].toUpperCase() + id.slice(1), value, min: -100, max: 100, text: String(value), ...extra });

test('a dossier row is one listcard row: the open button, the portrait, the name, the detail, and no stage or meters without them', () => {
    const html = markup([{ id: 'npc_mira', name: 'Mira', role: 'Guard', statusLabel: 'Here', portrait: '' }]);
    assert.match(html, /^<li class="ss-listcard-row"><button class="ss-listcard-item npc-state-delta-story-row" data-npc-id="npc_mira" aria-label="Open Mira dossier" type="button">/);
    assert.match(html, /<b class="ss-listcard-title">Mira<\/b><small class="ss-listcard-sub">Guard · Here<\/small>/);
    assert.doesNotMatch(html, /npc-state-delta-story-stage/, 'no stage pill without a stage');
    assert.doesNotMatch(html, /ss-bar/, 'no meters without meters');
});

test('the stage is a pill in the row, and a row shows at most DOSSIER_BAR_MAX meters as thin bars', () => {
    assert.equal(DOSSIER_BAR_MAX, 6, 'ss.hero BAR_MAX in Story Block view/widgets/hero.js');
    const bars = Array.from({ length: 8 }, (_, i) => bar(`meter${i}`, i * 10));
    const html = markup([{ id: 'npc_elula', name: 'Elula', role: 'Clerk', statusLabel: 'Here', stage: 'Close', bars }]);
    assert.match(html, /<span class="ss-pill ss-listcard-value npc-state-delta-story-stage">Close<\/span>/);
    assert.equal(fills(html).length, DOSSIER_BAR_MAX, 'the cap, not all eight');
    assert.match(html, /<span class="npc-state-delta-story-bars" aria-hidden="true">/, 'the bars are decoration; the row\'s name is what is read');
});

test('a bar fills by where its value sits between its min and max, clamped to 0..1', () => {
    const html = markup([{
        id: 'npc_oren', name: 'Oren', role: '', statusLabel: '', bars: [
            bar('trust', 50), bar('affection', -100), bar('desire', 100), bar('tension', 300), { id: 'x', label: 'Broken', value: 'nope', min: 0, max: 10 },
        ],
    }]);
    assert.deepEqual(fills(html), [0.75, 0, 1, 1, 0]);
});

test('a name, a role or a stage with markup in it is shown as text, not parsed (the row stays one row)', () => {
    const name = `${'Maximiliana'.repeat(7)}<b>x</b>`;
    const html = markup([{ id: 'npc_long', name, role: '<img src=x onerror=1>', statusLabel: 'Here', stage: `Stage ${'x'.repeat(70)}<i>y</i>`, bars: [bar('trust', 1)] }]);
    assert.equal((html.match(/<li /g) ?? []).length, 1, 'one row, not split by the name');
    assert.doesNotMatch(html, /<b>x<\/b>/, 'the name\'s marker is not markup');
    assert.match(html, /Maximiliana.*&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /&lt;img src=x onerror=1&gt;/);
    assert.doesNotMatch(html, /<i>y<\/i>/);
    assert.match(html, new RegExp(`<span class="ss-pill ss-listcard-value npc-state-delta-story-stage">Stage x{70}&lt;i&gt;y&lt;/i&gt;</span>`));
});

test('the empty states: no rows, the same words, and the Add and Scan actions where there are no dossiers', () => {
    assert.match(markup([], { total: 0 }), /No dossiers yet\. An NPC gets one[^<]*<\/p>.*data-npc-state-delta-action="add".*data-npc-state-delta-action="scan"/);
    assert.match(markup([], { query: 'zzz', total: 3 }), /No dossier matches “zzz”/);
    assert.doesNotMatch(markup([], { query: 'zzz', total: 3 }), /ss-listcard-row/);
});
