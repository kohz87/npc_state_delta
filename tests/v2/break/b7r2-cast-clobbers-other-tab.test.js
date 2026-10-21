// R2-b7-combos-3: regression from the B-b7-combos-12 fix. The Cast tab now redraws whenever its
// last markup is no longer in the pane (src/storysuite-v2.js renderCast `stillShown`). But Story
// Block's tab host has ONE shared pane (host-ui.js createTabHost), and Delta re-renders that pane
// on its own page events (listen(): 'npc-state-delta:cast-rendered', sent after every in-chat cast
// render, i.e. after each message is drawn, and 'npc-state-delta:enabled-changed'). Once the reader
// has moved to another tab, castEl is the pane that now shows Party/Quests/..., so the next such
// event writes the Cast cards over that module's tab. Before the fix the unchanged-markup check
// usually hid this; now it always happens. Drop into npc_state_delta/tests/v2/break/.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorySuiteV2Adapter } from '../../../src/storysuite-v2.js';

function fakeDoc() {
    const listeners = new Map();
    return {
        documentElement: { dataset: {} },
        getElementById: () => null,
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); return true; },
        createElement: () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {} } }),
        fire(type) { for (const fn of listeners.get(type) ?? []) fn({ type }); },
    };
}

// The tab host's pane: children are what a tab rendered (a Cast card or another module's tab).
function pane() {
    const node = {
        children: [],
        dataset: {},
        isConnected: true,
        get firstElementChild() { return this.children[0] ?? null; },
        get innerHTML() { return this.children.map(child => child.html).join(''); },
        set innerHTML(value) { this.replaceChildren({ html: String(value) }); },
        replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = nodes; for (const child of nodes) child.parentNode = this; },
        addEventListener() {},
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    return node;
}

test('a Delta page event does not draw the Cast cards over another module\'s tab', async () => {
    const doc = fakeDoc();
    const sdk = { registerModule: async () => sdk, query: () => [], settings: () => ({}) };
    const host = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    const delta = {
        isEnabled: () => true,
        presentCastHtml: () => '<div class="npc-state-delta-present-card">Fenna</div>',
        fillPresentCast() {},
        castEmptyReason: () => ({ text: 'No NPC is present.' }),
    };
    const timers = { setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval: () => 2, clearInterval() {} };
    const adapter = createStorySuiteV2Adapter({ suiteApi: { npcs: () => [] }, delta: () => delta, host: () => host, doc, timers, loadEmptyCast: async () => null, logger: { warn() {} } });
    adapter.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    await adapter.settled();
    assert.equal(adapter.hosted(), true);

    const el = pane();
    adapter.definition.tabs[0].render(el, {}, {});
    assert.match(el.innerHTML, /Fenna/);
    // The reader opens RPG Battle's Party tab: the host empties the pane and Party draws into it.
    el.replaceChildren({ html: '<div class="rpg-party">Ren · HP 98/98</div>' });
    el.dataset.tabId = 'party';
    // SillyTavern draws a message; Delta's in-chat cast render sends its page event.
    doc.fire('npc-state-delta:cast-rendered');
    assert.match(el.innerHTML, /rpg-party/, 'the Party tab was overwritten with the Cast cards');
    adapter.stop();
});
