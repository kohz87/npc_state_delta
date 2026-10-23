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
import { dossierRowNodes } from '../story-block-tabs.js';
import { dossierIndexProjection, filterDossierIndex } from '../dossier-ui.js';
import { fakeRoot } from './helpers/fake-dom.js';

// ---- a small DOM: elements keep their children, classes, attributes and text. A root's innerHTML is the markup it was
// given plus its children serialised, so a test reads what a reader sees; the present cells it was given are found by
// their data-npc-id, as before. Text is escaped when serialised, so a name with markup is shown as text. ----
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function matches(n, selector) {
    const parts = selector.split('.').map(part => part.trim()).filter(Boolean);
    const tag = selector.startsWith('.') ? null : selector.split('.')[0];
    if (tag && n.tagName?.toLowerCase() !== tag) return false;
    return parts.every(part => n.classList.contains(part.replace(/\[.*$/, '')));
}
function find(root, selector, first) {
    const out = [];
    const walk = list => { for (const child of list) { if (child.nodeType === 1 && matches(child, selector)) { out.push(child); if (first) return true; } if (walk(child.children)) return true; } return false; };
    walk(root.children);
    return out;
}
function node(owner, tag = 'div', className = '') {
    const classes = new Set(String(className).split(/\s+/).filter(Boolean));
    const attrs = {};
    const n = {
        nodeType: 1, tagName: String(tag).toUpperCase(), ownerDocument: owner, children: [], parentNode: null, dataset: {}, listeners: {}, value: '', focused: false, text: '',
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
        setAttribute(key, value) { attrs[key] = String(value); },
        getAttribute(key) { return key in attrs ? attrs[key] : null; },
        get textContent() { return this.text + this.children.map(child => child.textContent ?? '').join(''); },
        set textContent(value) { this.text = String(value); this.children = []; },
        append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } },
        appendChild(item) { this.append(item); return item; },
        replaceChildren(...items) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items); },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        querySelector(selector) { return find(this, selector, true)[0] ?? null; },
        querySelectorAll(selector) { return find(this, selector, false); },
        focus() { owner.activeElement = this; },
        setSelectionRange() {},
        serialize() {
            const data = Object.entries(this.dataset).map(([key, value]) => ` data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${esc(value)}"`).join('');
            const extra = Object.entries(attrs).map(([key, value]) => ` ${key}="${esc(value)}"`).join('') + (this.tagName === 'INPUT' ? ` value="${esc(this.value)}"` : '');
            const cls = classes.size ? ` class="${esc([...classes].join(' '))}"` : '';
            return `<${this.tagName.toLowerCase()}${cls}${data}${extra}>${esc(this.text)}${this.children.map(child => child.serialize()).join('')}</${this.tagName.toLowerCase()}>`;
        },
    };
    n.contains = other => other === n || n.children.some(child => child.contains?.(other));
    return n;
}
function element(owner) {
    const el = node(owner, 'div');
    let html = '';
    let cells = [];
    el.isConnected = true;
    el.writes = 0;
    Object.defineProperty(el, 'innerHTML', {
        get: () => html + el.children.map(child => child.serialize()).join(''),
        set(value) {
            html = String(value);
            el.children = [];
            el.writes += 1;
            el.firstElementChild = html ? { parentNode: el } : null;
            cells = [...html.matchAll(/class="npc-state-delta-present-cell[^"]*" data-npc-id="([^"]+)"/g)].map(([, id]) => {
                const cell = node(owner, 'div', 'npc-state-delta-present-cell');
                cell.dataset.npcId = id;
                const text = node(owner, 'div', 'npc-state-delta-present-card-text');
                text.append(node(owner, 'span', 'npc-state-delta-present-card-stage'));
                cell.append(text);
                return cell;
            });
        },
    });
    el.querySelectorAll = selector => {
        if (selector.startsWith('.npc-state-delta-present-cell')) return cells;
        if (selector === `.${PAGE_SLOT_CLASS}`) return cells.flatMap(cell => cell.children[0].children.filter(child => child.classList.contains(PAGE_SLOT_CLASS)));
        return find(el, selector, false);
    };
    el.fire = (type, event) => (el.listeners[type] ?? []).forEach(fn => fn(event));
    el.cells = () => cells;
    el.list = () => el.querySelector('.npc-state-delta-story-list');
    el.search = () => el.querySelector('.npc-state-delta-story-search');
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
        createElement: tag => (tag === 'div' ? element(doc) : node(doc, tag)),
        createTextNode: text => Object.assign(node(doc, '#text'), { nodeType: 3, text: String(text), serialize() { return esc(this.text); } }),
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
const v1List = async () => ({ rowNodes: dossierRowNodes, project: dossierIndexProjection, filter: filterDossierIndex });

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
    for (const id of ['npc_mira', 'npc_oren']) assert.match(el.innerHTML, new RegExp(`class="ss-listcard-item npc-state-delta-story-row" data-npc-id="${id}"`));
    assert.match(el.innerHTML, /Guard/, 'v1\'s row detail (role, status)');
    el.fire('click', { target: { closest: selector => (selector === '.npc-state-delta-story-row' ? { dataset: { npcId: 'npc_oren' } } : null) } });
    assert.deepEqual(delta.opened, ['npc_oren'], 'Delta\'s own dossier view');
    // Typing filters the list only (the box is not drawn again, so it keeps its focus).
    const writes = el.writes;
    const box = el.search();
    box.value = 'mil';
    el.fire('input', { target: box });
    assert.equal(el.writes, writes, 'the pane is not rewritten');
    assert.match(el.list().serialize(), /Oren/);
    assert.doesNotMatch(el.list().serialize(), /Mira/);
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
    for (const name of ['Mira', 'Oren', 'Kael']) assert.match(el.innerHTML, new RegExp(`<b class="ss-listcard-title">${name}</b>`));
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
    const slots = text.children.filter(child => child.classList.contains(PAGE_SLOT_CLASS));
    assert.equal(slots.length, 1);
    assert.ok(text.children.includes(slots[0]), 'inside the card, marked');
    // Drawn again: the old slot goes, the new one comes (never two).
    api.render(el, { slot: () => node(doc, 'thought') });
    assert.equal(el.cells()[0].children[0].children.filter(child => child.classList.contains(PAGE_SLOT_CLASS)).length, 1);
    api.render(el, {});
    assert.equal(el.cells()[0].children[0].children.filter(child => child.classList.contains(PAGE_SLOT_CLASS)).length, 0, 'no slot asked: none left');
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

test('a present card: the stage is set on its name line, the NPC\'s meters are inside its card, and the text is never markup', async () => {
    const { def, sdk, doc } = await setup();
    const cast = [{ key: 'mira', name: 'Mira <i>x</i>', present: true, rank: 'Close <b>now</b>', next: '', bars: [{ id: 'trust', label: 'Trust', value: 40, min: -100, max: 100, text: '40', tone: 'info' }], still: [], opened: [], locked: [] }];
    const query = sdk.query;
    sdk.query = name => (name === 'npc.cast' ? cast : query(name));
    const el = element(doc);
    def.tabs[0].render(el, {}, {});
    const cell = el.cells()[0];
    assert.ok(cell, 'Mira has a present card');
    const text = cell.children[0];
    const stage = text.querySelector('.npc-state-delta-present-card-stage');
    assert.equal(stage.textContent, 'Close <b>now</b>', 'the stage is the NPC\'s rank, as text');
    assert.equal(stage.parentNode, text, 'on the card\'s name line, in the card');
    const bars = text.querySelector('.npc-state-delta-present-card-bars');
    assert.ok(bars, 'the meters sit in the card');
    assert.match(bars.serialize(), /role="meter"[^>]*aria-valuenow="40"/);
    assert.doesNotMatch(bars.serialize(), /<b>|<i>/, 'no markup from the rank or the name');
});
