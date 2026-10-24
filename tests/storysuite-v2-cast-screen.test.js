// The Cast in Story Block's game view (ux3, from the live test): the game view lists screens (mount
// `screen`), not module tabs, so Cast showed in the Story panel and not there. Delta now also gives a
// screen `npc-state-delta/cast` (mount `screen` only, so the panel keeps its one Cast tab) whose
// template is one widget drawing exactly what the Cast tab draws. UI only: nothing about the prompts,
// queries or state changes. Checked against the vendored Story Block (tests/vendor/story-block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreens, validateScreen } from './vendor/story-block/src/v2/view/screens.js';
import { compileTemplate } from './vendor/story-block/src/v2/view/template/index.js';
import { CAST_SCREEN_ID, CAST_SCREEN_ORDER, CAST_TAB_ID, CAST_WIDGET, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

// A minimal element: what renderCast and the widget use (innerHTML is Delta's own escaped markup, as in the tab).
function element(owner, tag = 'div') {
    const node = {
        tagName: tag.toUpperCase(), ownerDocument: owner, className: '', dataset: {}, children: [], parentNode: null, isConnected: true, html: '',
        get innerHTML() { return this.html; },
        set innerHTML(value) { this.html = String(value); this.firstElementChild = this.html ? { parentNode: this } : null; },
        firstElementChild: null,
        append(child) { child.parentNode = this; this.children.push(child); },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; this.isConnected = false; },
        replaceChildren() { this.html = ''; this.firstElementChild = null; },
        listeners: [],
        addEventListener(type, fn) { this.listeners.push({ type, fn }); },
        querySelectorAll: () => [],
        querySelector: () => null,
        classList: { add() {}, remove() {}, contains: () => false },
        setAttribute() {},
        getAttribute: () => null,
        textContent: '',
        value: '',
    };
    return node;
}

function fakePage() {
    const handlers = {};
    const doc = {
        documentElement: { dataset: {} },
        getElementById: () => null,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
        dispatchEvent() { return true; },
        createElement: tag => element(doc, tag),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        fire(type) { for (const fn of handlers[type] ?? []) fn({ type }); },
        handlers,
    };
    return doc;
}

function fakeDelta() {
    let who = 'Fenna';
    return {
        set: name => { who = name; },
        api: {
            isEnabled: () => true,
            presentCastHtml: () => `<div class="npc-state-delta-present-card">${who}</div>`,
            fillPresentCast() {},
            castEmptyReason: () => ({ text: 'No NPC is present.' }),
        },
    };
}

function adapter(doc = fakePage(), delta = fakeDelta()) {
    return { doc, delta, a: createStorySuiteV2Adapter({ suiteApi: { npcs: () => [] }, delta: () => delta.api, host: () => null, doc, logger: { warn() {} } }) };
}

test('Cast is a game-view screen (mount screen only) beside the one Cast tab', () => {
    const { a } = adapter();
    const def = a.definition;
    const screen = def.screens.find(entry => entry.id === CAST_SCREEN_ID);
    assert.ok(screen, 'the Cast screen is registered');
    assert.equal(CAST_SCREEN_ID, 'npc-state-delta/cast');
    assert.deepEqual([...screen.mounts], ['screen'], 'not a second Cast tab in the Story panel');
    assert.equal(screen.title, 'Dossiers');
    assert.equal(screen.icon, def.tabs[0].icon);
    assert.equal(screen.order, CAST_SCREEN_ORDER);
    assert.deepEqual(def.tabs.map(tab => tab.id), [CAST_TAB_ID]);
    assert.equal(typeof def.widgets[CAST_WIDGET].render, 'function');
    for (const binding of Object.values(screen.data)) assert.ok(def.queries[binding.query], binding.query);
    assert.deepEqual(validateScreen(JSON.parse(JSON.stringify(screen))), []);
    assert.deepEqual(compileTemplate(screen.template).warnings, []);
});

test('Story Block lists it in the game view and not among the panel\'s screen tabs', () => {
    const { a } = adapter();
    const screens = createScreens();
    screens.addModule('npc-state-delta', a.definition.screens);
    assert.ok(screens.list('screen').some(entry => entry.id === CAST_SCREEN_ID), 'in the game view');
    assert.ok(!screens.list('tab').some(entry => entry.id === CAST_SCREEN_ID), 'the panel keeps the module tab only');
});

test('the Cast screen\'s widget draws what the Cast tab draws, redraws, and lets go when removed', () => {
    const { doc, delta, a } = adapter();
    const tabPane = element(doc);
    a.definition.tabs[0].render(tabPane, {}, {});
    const slot = element(doc);
    const handle = a.definition.widgets[CAST_WIDGET].render(slot, {}, {});
    const box = slot.children[0];
    assert.equal(box.className, 'npc-state-delta-v2-cast-view');
    assert.equal(box.innerHTML, tabPane.innerHTML, 'the same Cast as the tab');
    assert.match(box.innerHTML, /Fenna/);
    delta.set('Oren');
    handle.update({ cast: [], present: ['Oren'] });
    assert.match(box.innerHTML, /Oren/, 'new data: drawn again');
    handle.destroy();
    assert.equal(slot.children.length, 0);
});

test('Delta\'s page events redraw a shown Cast screen, and the tab pane is still the tab\'s', async () => {
    const { doc, delta, a } = adapter();
    // Hosted: register with a host so the page listeners are on.
    const sdk = { registerModule: async () => true, on: () => () => {}, query: () => [] };
    const host = { apiVersion: 2, sdk, ready: Promise.resolve(sdk) };
    const hosted = createStorySuiteV2Adapter({ suiteApi: { npcs: () => [] }, delta: () => delta.api, host: () => host, doc, logger: { warn() {} }, retryMs: 1, aliveMs: 100000 });
    hosted.start?.();
    for (let i = 0; i < 20 && !doc.documentElement.dataset.npcStateDeltaStoryBlockV2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(doc.documentElement.dataset.npcStateDeltaStoryBlockV2, '1', 'hosted');
    const tabPane = element(doc);
    tabPane.dataset.tabId = CAST_TAB_ID;
    hosted.definition.tabs[0].render(tabPane, {}, {});
    const slot = element(doc);
    hosted.definition.widgets[CAST_WIDGET].render(slot, {}, {});
    const box = slot.children[0];
    delta.set('Mira');
    doc.fire('npc-state-delta:cast-rendered');
    assert.match(box.innerHTML, /Mira/, 'the game view follows Delta');
    assert.match(tabPane.innerHTML, /Mira/, 'the tab, still shown, too');
    // Removed from the page: let go, never drawn into again.
    box.isConnected = false;
    delta.set('Oren');
    doc.fire('npc-state-delta:cast-rendered');
    assert.match(box.innerHTML, /Mira/);
    hosted.stop?.();
    assert.ok(a.definition, 'a second adapter is unaffected');
});
