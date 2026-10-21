// B-b7-combos-12: the hosted Cast tab goes blank. Story Block's tab host (host-ui.js createTabHost
// draw()) empties the one shared pane with pane.replaceChildren() before every tab.render(pane, …):
// on every tab switch, refresh, 'head' or 'committed' redraw. src/storysuite-v2.js renderCast() keeps
// the last markup on the element (el.__npcStateDeltaV2Cast) and returns early when it is unchanged,
// so after the first redraw the pane stays empty. Live: Cast tab active, Fenna known
// (npc.known = ["Fenna"]), pane innerHTML length 0. While hosted the drawer copy and the launcher are
// hidden and the in-chat cast defaults to off, so the reader has no NSD view at all.


import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

function pane() {
    const node = {
        html: '',
        dataset: {},
        isConnected: true,
        get innerHTML() { return this.html; },
        set innerHTML(value) { this.html = String(value); },
        // What Story Block's tab host does before each render.
        replaceChildren() { this.html = ''; },
        addEventListener() {},
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    return node;
}

test('the Cast tab draws its cards again after the host empties the pane', () => {
    const delta = {
        isEnabled: () => true,
        presentCastHtml: () => '<div class="npc-state-delta-present-card">Fenna</div>',
        fillPresentCast() {},
        castEmptyReason: () => ({ text: 'No NPC is present.' }),
    };
    const adapter = createStorySuiteV2Adapter({ suiteApi: { npcs: () => [] }, delta: () => delta, host: () => null, doc: null, logger: { warn() {} } });
    const cast = adapter.definition.tabs[0];
    const el = pane();
    cast.render(el, {}, {});
    assert.match(el.innerHTML, /Fenna/, 'first draw');
    // The reader switches to Party and back (or any commit redraws the panel).
    el.replaceChildren();
    cast.render(el, {}, {});
    assert.match(el.innerHTML, /Fenna/, 'the Cast tab is blank after a redraw');
});
