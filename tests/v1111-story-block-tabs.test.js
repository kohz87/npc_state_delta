import test from 'node:test';
import assert from 'node:assert/strict';
import { dossierRowNodes, emptyCastHtml } from '../story-block-tabs.js';
import { fakeDocument } from './helpers/fake-dom.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { styleSource } from './helpers/shipped-modules.js';

// Story Block list helpers: the dossier rows and the empty-cast line (the v1 tab registration was removed 12 Nov).

test('v1.1.11 dossier rows: names are text (never markup), and an initial stands in without a portrait', () => {
    const markup = (rows, opts) => dossierRowNodes(rows, fakeDocument(), opts).map(node => node.serialize()).join('');
    const html = markup([{ id: 'x"1', name: '<Ilsa>', role: 'a & b', statusLabel: 'Off-screen', portrait: '' }]);
    assert.match(html, /data-npc-id="x&quot;1"/);
    assert.match(html, /&lt;Ilsa&gt;/);
    assert.match(html, /a &amp; b · Off-screen/);
    assert.match(html, /<span class="npc-state-delta-story-thumb ss-listcard-icon"><span class="">&lt;<\/span><\/span>|<span>&lt;<\/span>/);
    assert.match(markup([]), /No dossier matches\./);
    // (1.2.13) With no dossier at all: say so, and offer Add NPC and Scan now; a search says what it searched.
    assert.match(markup([], { total: 0 }), /No dossiers yet\.[\s\S]*data-npc-state-delta-action="add"[\s\S]*data-npc-state-delta-action="scan"/);
    assert.match(markup([], { query: 'Ly<ra', total: 3 }), /No dossier matches “Ly&lt;ra”/);
});

test('v1.1.12 a choice made in settings is remembered; the Story Block pane is padded and keeps its cards to one column (UI 4c)', () => {
    const index = runtimeSource();
    const css = styleSource();
    assert.match(index, /presentCastDisplayChosen: false,/);
    assert.match(index, /getSettings\(\)\.presentCastDisplayChosen = true;/, 'picking any choice marks it deliberate');
    assert.match(index, /\$\('#npc_state_delta_present_cast_display'\)\.val\(effectivePresentCastChoice\(\)\)/, 'the menu shows the choice in effect');
    assert.match(css, /\.npc-state-delta-story-pane \{ padding: 8px 12px 12px;/);
    assert.match(css, /\.npc-state-delta-present-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/, 'the cards are one row each in the pane (UI 4c)');
});

test('1.2.13 an empty Present NPCs tab says why, and offers Scan now when a scan could help', () => {
    const html = emptyCastHtml({ text: 'No NPC has a dossier in this chat yet <b>', scan: true });
    assert.match(html, /No NPC has a dossier in this chat yet &lt;b&gt;/);
    assert.match(html, /data-npc-state-delta-action="scan"/);
    assert.doesNotMatch(emptyCastHtml({ text: 'No chat is open.', scan: false }), /data-npc-state-delta-action/);
    assert.match(emptyCastHtml(), /No NPC is present in the latest scene\./);
});
