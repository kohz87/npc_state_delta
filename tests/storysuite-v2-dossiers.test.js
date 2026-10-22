// The Cast tab is Dossiers (Story Block MODULES §F119, the user's beta live test: "Cast becomes redundant when
// present is already present character in world tab"; "Cast should become dossiers and go to the last tab").
// * Its id stays `cast` (the screen's `npc-state-delta/cast`), so a reader's saved tab order still finds it.
// * It is the dossier browser: every dossier (v1's Dossiers list, with search), each opening its dossier.
// * The present cast's cards move to Story Director's World screen; without Story Director (or with its World
//   view off) they stay at the top of Dossiers, so nothing is lost.
// * The page API Story Director draws them with (`globalThis.NPCStateDeltaCast`): render(el, { slot }), the
//   slot node inside each present card, and onChange(fn) after Delta's cast changes, so World follows a scan
//   that ends after the reply without a tab switch.
// UI only: no prompt, query answer or stored value changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CAST_SCREEN_ID, CAST_TAB_ID, CAST_WIDGET, DOSSIERS_TITLE, PAGE_API, PAGE_SLOT_CLASS, WORLD_FEATURE, createStorySuiteV2Adapter,
} from '../src/storysuite-v2.js';
import { dossierTabRowsHtml } from '../story-block-tabs.js';
import { dossierIndexProjection, filterDossierIndex } from '../dossier-ui.js';

// ---- a small element: innerHTML is kept as text; the present cells it holds are found by their data-npc-id ----
function node(owner, className = '') {
    const classes = new Set(String(className).split(/\s+/).filter(Boolean));
    return {
        nodeType: 1, ownerDocument: owner, children: [], parentNode: null, dataset: {}, listeners: {}, value: '', focused: false,
        classList: { add: name => classes.add(name), contains: name => classes.has(name) },
        append(child) { child.parentNode = this; this.children.push(child); },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; },
    };
}
function element(owner) {
    const el = node(owner);
    let html = '';
    let cells = [];
    let list = null;
    let search = null;
    el.isConnected = true;
    el.writes = 0;
    Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set(value) {
            html = String(value);
            el.writes += 1;
            el.firstElementChild = html ? { parentNode: el } : null;
            cells = [...html.matchAll(/class="npc-state-delta-present-cell[^"]*" data-npc-id="([^"]+)"/g)].map(([, id]) => {
                const cell = node(owner, 'npc-state-delta-present-cell');
                cell.dataset.npcId = id;
                const text = node(owner, 'npc-state-delta-present-card-text');
                cell.append(text);
                cell.querySelector = selector => (selector === '.npc-state-delta-present-card-text' ? text : null);
                return cell;
            });
            list = html.includes('npc-state-delta-story-list') ? Object.assign(node(owner, 'npc-state-delta-story-list'), { innerHTML: '' }) : null;
            search = html.includes('npc-state-delta-story-search') ? Object.assign(node(owner, 'npc-state-delta-story-search'), {
                value: /value="([^"]*)"/.exec(html)?.[1] ?? '', focus() { owner.activeElement = this; }, setSelectionRange() {},
            }) : null;
        },
    });
    el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
    el.fire = (type, event) => (el.listeners[type] ?? []).forEach(fn => fn(event));
    el.contains = other => other === search;
    el.querySelector = selector => (selector === '.npc-state-delta-story-list' ? list : selector === '.npc-state-delta-story-search' ? search : null);
    el.querySelectorAll = selector => {
        if (selector.startsWith('.npc-state-delta-present-cell')) return cells;
        if (selector === `.${PAGE_SLOT_CLASS}`) return cells.flatMap(cell => cell.children[0].children.filter(child => child.classList.contains(PAGE_SLOT_CLASS)));
        return [];
    };
    el.cells = () => cells;
    el.list = () => list;
    el.search = () => search;
    return el;
}
function fakePage() {
    const handlers = {};
    const doc = {
        documentElement: { dataset: {} },
        activeElement: null,
        getElementById: () => null,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
        dispatchEvent() { return true; },
        createElement: () => element(doc),
        fire(type) { for (const fn of handlers[type] ?? []) fn({ type }); },
    };
    return doc;
}

const NPCS = [
    { id: 'npc_mira', name: 'Mira', aliases: ['Captain'], present: true, archived: false, role: 'Guard' },
    { id: 'npc_oren', name: 'Oren', aliases: [], present: false, archived: false, role: 'Miller' },
    { id: 'npc_kael', name: 'Kael', aliases: [], present: false, archived: true, role: '' },
];
function fakeDelta() {
    const opened = [];
    let present = ['npc_mira'];
    let revision = 1;
    const api = {
        isEnabled: () => true,
        presentCastHtml: () => `<section class="npc-state-delta-present-roster">${present.map(id => `<div class="npc-state-delta-present-cell npc-state-delta-present-cell-now" data-npc-id="${id}"><button type="button" class="npc-state-delta-present-card">${id}</button></div>`).join('')}</section>`,
        fillPresentCast() {},
        castEmptyReason: () => ({ text: 'No NPC is present.' }),
        openDossier: id => { opened.push(id); return true; },
        dossierRevision: () => `chat|${revision}`,
        getDossierState: () => ({ npcs: NPCS.map(npc => ({ ...npc })), portraitAssets: {} }),
        getNpc: id => NPCS.find(npc => npc.id === id) ?? null,
    };
    return { api, opened, setPresent: ids => { present = ids; revision += 1; } };
}
function fakeSdk({ world = false } = {}) {
    return {
        registered: [],
        async registerModule(def) { this.registered.push(def); return true; },
        on: () => () => {},
        query: name => (name === 'npc.cast' ? [] : name === 'scene.present' ? null : []),
        feature: id => (id === WORLD_FEATURE ? world : false),
        settings: () => ({}),
    };
}
const v1List = async () => ({ rowsHtml: dossierTabRowsHtml, project: dossierIndexProjection, filter: filterDossierIndex });

async function setup({ world = false, hostValue = 'v2', loadDossierList = v1List } = {}) {
    const doc = fakePage();
    const delta = fakeDelta();
    const sdk = fakeSdk({ world });
    const host = hostValue === 'v2' ? { apiVersion: 2, sdk, ready: Promise.resolve(sdk) } : hostValue;
    const page = {};
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => NPCS.map(npc => ({ id: npc.id, name: npc.name, aliases: npc.aliases, present: npc.present, archived: npc.archived })) },
        delta: () => delta.api, host: () => host, doc, page, logger: { warn() {} }, retryMs: 1, attempts: 2, aliveMs: 1e9,
        loadEmptyCast: async () => reason => `<p class="npc-state-delta-story-empty">${reason?.text ?? ''}</p>`, loadDossierList,
    });
    adapter.start();
    await adapter.settled();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { doc, delta, sdk, page, adapter, def: adapter.definition };
}

test('the tab and the screen are titled Dossiers; their ids stay cast and npc-state-delta/cast', async () => {
    const { def, adapter } = await setup();
    assert.equal(DOSSIERS_TITLE, 'Dossiers');
    assert.deepEqual(def.tabs.map(tab => [tab.id, tab.title, tab.icon]), [[CAST_TAB_ID, 'Dossiers', 'fa-address-book']]);
    assert.equal(CAST_TAB_ID, 'cast', 'a saved tab order names npc-state-delta/cast');
    const screen = def.screens.find(item => item.id === CAST_SCREEN_ID);
    assert.equal(screen.title, 'Dossiers');
    assert.equal(screen.icon, def.tabs[0].icon);
    adapter.stop();
});

test('Dossiers lists every dossier with v1\'s rows; a row opens its dossier; search filters in place', async () => {
    const { doc, delta, def, adapter } = await setup({ world: true });
    const el = element(doc);
    el.dataset.tabId = CAST_TAB_ID;
    def.tabs[0].render(el, {}, {});
    assert.match(el.innerHTML, /npc-state-delta-v2-dossiers/);
    for (const id of ['npc_mira', 'npc_oren']) assert.match(el.innerHTML, new RegExp(`class="npc-state-delta-story-row" data-npc-id="${id}"`));
    assert.match(el.innerHTML, /Guard/, 'v1\'s row detail (role, status)');
    el.fire('click', { target: { closest: selector => (selector === '.npc-state-delta-story-row' ? { dataset: { npcId: 'npc_oren' } } : null) } });
    assert.deepEqual(delta.opened, ['npc_oren'], 'Delta\'s own dossier view');
    // Typing filters the list only (the box is not drawn again, so it keeps its focus).
    const writes = el.writes;
    const box = el.search();
    box.value = 'mil';
    el.fire('input', { target: box });
    assert.equal(el.writes, writes, 'the pane is not rewritten');
    assert.match(el.list().innerHTML, /Oren/);
    assert.doesNotMatch(el.list().innerHTML, /Mira/);
    // A redraw (Delta's state moved) keeps the search text and the focus in the box.
    doc.activeElement = box;
    delta.setPresent(['npc_mira', 'npc_oren']);
    doc.fire('npc-state-delta:cast-rendered');
    assert.match(el.innerHTML, /value="mil"/);
    assert.equal(doc.activeElement, el.search(), 'the new box has the focus');
    adapter.stop();
});

test('with Story Director\'s World on, Dossiers has no present cards (World has them); without it they stay on top', async () => {
    const withWorld = await setup({ world: true });
    const a = element(withWorld.doc);
    withWorld.def.tabs[0].render(a, {}, {});
    assert.doesNotMatch(a.innerHTML, /npc-state-delta-present-roster/, 'the cards are on the World screen');
    assert.match(a.innerHTML, /npc-state-delta-v2-dossiers/);
    withWorld.adapter.stop();
    const alone = await setup({ world: false });
    const b = element(alone.doc);
    alone.def.tabs[0].render(b, {}, {});
    assert.ok(b.innerHTML.indexOf('npc-state-delta-present-roster') < b.innerHTML.indexOf('npc-state-delta-v2-dossiers'), 'cards first, then the list');
    // The game view's Dossiers screen draws the same.
    const slot = element(alone.doc);
    slot.append = child => { slot.children.push(child); child.parentNode = slot; };
    alone.def.widgets[CAST_WIDGET].render(slot, {}, {});
    assert.equal(slot.children[0].innerHTML, b.innerHTML);
    alone.adapter.stop();
});

test('before v1\'s list has loaded (or if it cannot), Dossiers is a plain list of names that still opens each one', async () => {
    const { doc, delta, def, adapter } = await setup({ world: true, loadDossierList: () => Promise.reject(new Error('no list')) });
    const el = element(doc);
    def.tabs[0].render(el, {}, {});
    for (const name of ['Mira', 'Oren', 'Kael']) assert.match(el.innerHTML, new RegExp(`<b>${name}</b>`));
    el.fire('click', { target: { closest: selector => (selector === '.npc-state-delta-story-row' ? { dataset: { npcId: 'npc_mira' } } : null) } });
    assert.deepEqual(delta.opened, ['npc_mira']);
    adapter.stop();
});

test('the page API: on the page while the adapter runs; draws the present cards with a slot inside each; gone on stop', async () => {
    const { doc, page, adapter } = await setup({ world: true });
    const api = page[PAGE_API];
    assert.equal(api, adapter.pageApi);
    assert.equal(api.version, 1);
    assert.equal(api.available(), true);
    const el = element(doc);
    const asked = [];
    const count = api.render(el, { slot: (name, aliases) => { asked.push([name, aliases]); return name === 'Mira' ? node(doc, 'thought') : null; } });
    assert.equal(count, 1);
    assert.match(el.innerHTML, /npc-state-delta-present-roster/, 'Delta\'s own markup and classes');
    assert.doesNotMatch(el.innerHTML, /npc-state-delta-v2-dossiers/, 'no dossier list in the World screen');
    assert.deepEqual(asked, [['Mira', ['Captain']]], 'the dossier\'s name and aliases');
    const text = el.cells()[0].children[0];
    assert.equal(text.children.length, 1);
    assert.ok(text.children[0].classList.contains(PAGE_SLOT_CLASS), 'inside the card, marked');
    // Drawn again: the old slot goes, the new one comes (never two).
    api.render(el, { slot: () => node(doc, 'thought') });
    assert.equal(el.cells()[0].children[0].children.length, 1);
    api.render(el, {});
    assert.equal(el.cells()[0].children[0].children.length, 0, 'no slot asked: none left');
    adapter.stop();
    assert.equal(page[PAGE_API], undefined);
});

test('onChange: called when Delta draws its cast again (a scan that ends after the reply) and when it is hosted or not', async () => {
    const { doc, page, adapter } = await setup({ world: true });
    const api = page[PAGE_API];
    let calls = 0;
    const off = api.onChange(() => { calls += 1; });
    doc.fire('npc-state-delta:cast-rendered');
    assert.equal(calls, 1);
    doc.fire('npc-state-delta:enabled-changed');
    assert.equal(calls, 2);
    // A listener that throws does not stop the others.
    api.onChange(() => { throw new Error('boom'); });
    doc.fire('npc-state-delta:cast-rendered');
    assert.equal(calls, 3);
    off();
    doc.fire('npc-state-delta:cast-rendered');
    assert.equal(calls, 3, 'unsubscribed');
    assert.equal(typeof api.onChange(null), 'function', 'a bad listener is ignored');
    adapter.stop();
});

test('not hosted (no Story Block v2): the page API is there but draws nothing, and says so', async () => {
    const { doc, page, adapter } = await setup({ hostValue: null });
    const api = page[PAGE_API];
    assert.equal(api.available(), false);
    const el = element(doc);
    assert.equal(api.render(el, { slot: () => node(doc) }), 0);
    assert.equal(el.innerHTML, '');
    adapter.stop();
});
