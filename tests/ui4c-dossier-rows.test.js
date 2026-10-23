// UI 4c: a dossier row is a Story Block listcard row (portrait, name, role and status, the stage as a pill, the
// meters as thin ss.bar bars). These tests read the markup the rows produce, the structure a reader and a screen
// reader get, not the stylesheet text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DOSSIER_BAR_MAX, dossierTabRowsHtml } from '../story-block-tabs.js';

const parts = html => {
    const doc = html.replace(/\s+/g, ' ');
    return {
        items: [...doc.matchAll(/<li class="ss-listcard-row"><button type="button" class="ss-listcard-item npc-state-delta-story-row"([^>]*)>/g)].map(match => match[1]),
        bars: [...doc.matchAll(/<span class="ss-bar">[\s\S]*?<span class="ss-bar-fill" style="--ss-fill: ([0-9.]+)">/g)].map(match => Number(match[1])),
        bundle: doc,
    };
};

const bar = (id, value, extra = {}) => ({ id, label: id[0].toUpperCase() + id.slice(1), value, min: -100, max: 100, text: String(value), ...extra });

test('a dossier row is one listcard row: the open button, the portrait, the name, the detail and no stage when there is none', () => {
    const { items, bundle } = parts(dossierTabRowsHtml([{ id: 'npc_mira', name: 'Mira', role: 'Guard', statusLabel: 'Here', portrait: '' }]));
    assert.equal(items.length, 1);
    assert.match(items[0], /data-npc-id="npc_mira" aria-label="Open Mira dossier"/);
    assert.match(bundle, /<b class="ss-listcard-title">Mira<\/b><small class="ss-listcard-sub">Guard · Here<\/small>/);
    assert.doesNotMatch(bundle, /npc-state-delta-story-stage/, 'no stage pill without a stage');
    assert.doesNotMatch(bundle, /ss-bar/, 'no meters without meters');
});

test('the stage is a pill in the row, and a row shows at most DOSSIER_BAR_MAX meters as thin bars', () => {
    assert.equal(DOSSIER_BAR_MAX, 6, 'ss.hero BAR_MAX in Story Block view/widgets/hero.js');
    const bars = Array.from({ length: 8 }, (_, i) => bar(`meter${i}`, i * 10));
    const { bundle, bars: fills } = parts(dossierTabRowsHtml([{ id: 'npc_elula', name: 'Elula', role: 'Clerk', statusLabel: 'Here', stage: 'Close', bars }]));
    assert.match(bundle, /<span class="ss-pill ss-listcard-value npc-state-delta-story-stage">Close<\/span>/);
    assert.equal(fills.length, DOSSIER_BAR_MAX, 'the cap, not all eight');
    assert.match(bundle, /<span class="npc-state-delta-story-bars" aria-hidden="true">/, 'the bars are decoration; the row\'s name is what is read');
});

test('a bar fills by where its value sits between its min and max, clamped to 0..1', () => {
    const { bars: fills } = parts(dossierTabRowsHtml([{
        id: 'npc_oren', name: 'Oren', role: '', statusLabel: '', bars: [
            bar('trust', 50), bar('affection', -100), bar('desire', 100), bar('tension', 300), { id: 'x', label: 'Broken', value: 'nope', min: 0, max: 10 },
        ],
    }]));
    assert.deepEqual(fills, [0.75, 0, 1, 1, 0]);
});

test('a long unbroken name and a long stage stay inside the row markup (escaped text, no raw markup)', () => {
    const name = `${'Maximiliana'.repeat(7)}<img src=x onerror=1>`;
    const stage = `Stage ${'x'.repeat(70)}`;
    const { items, bundle } = parts(dossierTabRowsHtml([{ id: 'npc_long', name, role: 'Keeper', statusLabel: 'Here', stage, bars: [bar('trust', 1)] }]));
    assert.equal(items.length, 1, 'one row, not split by the name');
    assert.doesNotMatch(bundle, /<img src=x/, 'the name is escaped');
    assert.match(bundle, /&lt;img src=x onerror=1&gt;/);
    assert.match(bundle, new RegExp(`<span class="ss-pill ss-listcard-value npc-state-delta-story-stage">Stage x{70}</span>`));
});

test('the empty states stay as they were (no list rows, the same actions)', () => {
    assert.match(dossierTabRowsHtml([], { total: 0 }), /data-npc-state-delta-action="add"/);
    assert.doesNotMatch(dossierTabRowsHtml([], { query: 'zzz', total: 3 }), /ss-listcard-row/);
});
