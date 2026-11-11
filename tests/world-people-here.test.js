// World → Now → People here (the page API's render, storysuite-v2.js + style.css): each row is portrait, name, the
// standing as a chip and the description on one line (two on a phone); the whole row opens the dossier. The Look and
// field lines, the Next line and every note row (opened and hidden) are not drawn there. The in-chat present card, the
// dossier and the Dossiers screen keep them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAST_TAB_ID, PAGE_API, WORLD_FEATURE, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { styleSource } from './helpers/shipped-modules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = styleSource();
const indexSource = runtimeSource();

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const classesOf = n => n.className.split(/\s+/).filter(Boolean);
function matches(n, selector) {
    const wanted = selector.replace(/\[[^\]]*\]/g, '').split('.').map(part => part.trim()).filter(Boolean);
    return n.nodeType === 1 && wanted.every(name => n.classList.contains(name));
}
function find(rootNode, selector, first) {
    const out = [];
    const walk = list => { for (const child of list) { if (matches(child, selector)) { out.push(child); if (first) return true; } if (walk(child.children)) return true; } return false; };
    walk(rootNode.children);
    return out;
}
function node(owner, tag = 'div', className = '', text = '') {
    const classes = new Set(String(className).split(/\s+/).filter(Boolean));
    const attrs = {};
    const n = {
        nodeType: 1, tagName: String(tag).toUpperCase(), ownerDocument: owner, children: [], parentNode: null, dataset: {}, value: '', text,
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
        addEventListener() {},
        querySelector(selector) { return find(this, selector, true)[0] ?? null; },
        querySelectorAll(selector) { return find(this, selector, false); },
        closest(selector) { for (let at = this; at; at = at.parentNode) if (matches(at, selector)) return at; return null; },
        contains: other => other === n || n.children.some(child => child.contains?.(other)),
        focus() {},
        setSelectionRange() {},
        serialize() {
            const cls = classes.size ? ` class="${esc([...classes].join(' '))}"` : '';
            const data = Object.entries(this.dataset).map(([key, value]) => ` data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${esc(value)}"`).join('');
            const name = this.tagName.toLowerCase();
            return `<${name}${cls}${data}>${esc(this.text)}${this.children.map(child => child.serialize()).join('')}</${name}>`;
        },
    };
    return n;
}

// One present cell as Delta draws it (index.js inlineCardHtml): the card button with portrait, name line (name and the
// stage slot), the description and the Look/field now lines; then the side copy of the now lines.
function cellNode(owner, id) {
    const cell = node(owner, 'div', 'npc-state-delta-present-cell npc-state-delta-present-cell-now');
    cell.dataset.npcId = id;
    const card = node(owner, 'button', 'npc-state-delta-present-card');
    card.dataset.npcId = id;
    const text = node(owner, 'span', 'npc-state-delta-present-card-text');
    const head = node(owner, 'span', 'npc-state-delta-present-card-head');
    head.append(node(owner, 'b', 'npc-state-delta-present-card-name', 'Sister Temiwa'), node(owner, 'span', 'npc-state-delta-present-card-stage'));
    const now = node(owner, 'span', 'npc-state-delta-present-now');
    now.append(node(owner, 'span', 'npc-state-delta-present-now-part', 'Look: grey habit, mended sleeves'), node(owner, 'span', 'npc-state-delta-present-now-part', 'Faith: lapsed'));
    text.append(head, node(owner, 'small', 'npc-state-delta-present-card-role', 'Bluewatch healer who patches you without the sermon'), now);
    card.append(node(owner, 'span', 'npc-state-delta-present-card-portrait'), text);
    const side = node(owner, 'div', 'npc-state-delta-present-side npc-state-delta-present-side-now');
    side.append(node(owner, 'span', 'npc-state-delta-present-now', 'Look: grey habit, mended sleeves'));
    cell.append(card, side);
    return cell;
}
function element(owner) {
    const el = node(owner, 'div');
    let html = '';
    el.isConnected = true;
    el.listeners = {};
    Object.defineProperty(el, 'innerHTML', {
        get: () => html + el.children.map(child => child.serialize()).join(''),
        set(value) {
            html = String(value);
            el.children = [];
            el.firstElementChild = html ? { parentNode: el } : null;
            const ids = [...html.matchAll(/data-npc-id="([^"]+)"/g)].map(match => match[1]);
            for (const id of ids) el.append(cellNode(owner, id));
        },
    });
    // The cells are the element's own children here, so a plain walk finds everything the adapter asks for.
    el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
    el.fire = (type, event) => (el.listeners[type] ?? []).forEach(fn => fn(event));
    return el;
}
function fakePage() {
    const doc = {
        documentElement: { dataset: {} }, activeElement: null, getElementById: () => null,
        addEventListener() {}, dispatchEvent() { return true; },
        createElement: tag => (tag === 'div' ? element(doc) : node(doc, tag)),
        createTextNode: text => Object.assign(node(doc, '#text'), { nodeType: 3, text: String(text), serialize() { return esc(this.text); } }),
    };
    return doc;
}

const NPCS = [{ id: 'npc_temiwa', name: 'Sister Temiwa', aliases: [], present: true, archived: false, role: 'Healer' }];
const CAST = [{
    key: 'sister temiwa', name: 'Sister Temiwa', present: true, rank: 'Tolerates you',
    next: 'Next: Patches you without the sermon - trust 25/45',
    bars: [{ id: 'trust', label: 'Trust', value: 25, min: -100, max: 100, text: '25', tone: 'info' }], still: [],
    opened: [{ id: 'n1', title: 'Why Bluewatch' }], locked: [{ id: 'n2', text: 'Hidden note · opens at Trust 60' }],
}];

async function setup({ world }) {
    const doc = fakePage();
    const opened = [];
    const delta = {
        isEnabled: () => true,
        presentCastHtml: () => '<section class="npc-state-delta-present-roster"><div class="npc-state-delta-present-cell" data-npc-id="npc_temiwa"></div></section>',
        fillPresentCast() {},
        castEmptyReason: () => ({ text: 'No NPC is present.' }),
        openDossier: id => { opened.push(id); return true; },
        dossierRevision: () => 'chat|1',
        getDossierState: () => ({ npcs: NPCS.map(npc => ({ ...npc })), portraitAssets: {} }),
        getNpc: id => NPCS.find(npc => npc.id === id) ?? null,
    };
    const sdk = {
        registered: [], async registerModule(def) { this.registered.push(def); return true; }, on: () => () => {},
        query: name => (name === 'npc.cast' ? CAST : name === 'scene.present' ? null : []),
        feature: id => (id === WORLD_FEATURE ? world : false), settings: () => ({}),
    };
    const host = { apiVersion: 2, sdk, ready: Promise.resolve(sdk) };
    const page = {};
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => NPCS.map(npc => ({ id: npc.id, name: npc.name, aliases: npc.aliases, present: npc.present, archived: npc.archived })) },
        delta: () => delta, host: () => host, doc, page, logger: { warn() {} }, retryMs: 1, attempts: 2, aliveMs: 1e9,
        loadEmptyCast: async () => reason => `<p>${reason?.text ?? ''}</p>`,
        loadDossierList: async () => ({ rowNodes: () => [], project: () => [], filter: () => [] }),
    });
    adapter.start();
    await adapter.settled();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { doc, page, adapter, opened, def: adapter.definition };
}

const LOOK = /Look|grey habit|Faith|lapsed/;
const NEXT = /Next:|Patches you|trust 25\/45/;
const NOTES = /Why Bluewatch|Hidden note|opens at/;

test('World → People here: a person with Look, a field, Next, an opened and a hidden note shows none of them; portrait, name, chip and description stay', async () => {
    const { doc, page, adapter } = await setup({ world: true });
    const el = element(doc);
    assert.equal(page[PAGE_API].render(el, {}), 1);
    const cell = el.children[0];
    assert.ok(cell.classList.contains('npc-state-delta-world-people'));
    const html = el.innerHTML;
    assert.doesNotMatch(html, LOOK, 'no Look or field line');
    assert.doesNotMatch(html, NEXT, 'no Next line');
    assert.doesNotMatch(html, NOTES, 'no opened or hidden note');
    assert.equal(el.querySelectorAll('.npc-state-delta-present-now').length, 0);
    assert.equal(el.querySelectorAll('.npc-state-delta-v2-next, .npc-state-delta-v2-note').length, 0);
    assert.equal(el.querySelectorAll('.npc-state-delta-present-card-bars').length, 0, 'no meters, as before');
    assert.equal(cell.children.length, 1, 'the cell is the card, nothing under it');
    assert.equal(cell.querySelector('.npc-state-delta-present-card-name').textContent, 'Sister Temiwa');
    assert.equal(cell.querySelector('.npc-state-delta-present-card-stage').textContent, 'Tolerates you', 'the standing chip');
    assert.match(cell.querySelector('.npc-state-delta-present-card-role').textContent, /Bluewatch healer/);
    assert.ok(cell.querySelector('.npc-state-delta-present-card-portrait'));
    adapter.stop();
});

test('the Dossiers screen (World off) still draws the same person with Next, the notes and the meters', async () => {
    const { doc, def, adapter } = await setup({ world: false });
    const el = element(doc);
    el.dataset.tabId = CAST_TAB_ID;
    def.tabs[0].render(el, {}, {});
    const html = el.innerHTML;
    assert.match(html, NEXT);
    assert.match(html, /Why Bluewatch/);
    assert.match(html, /Hidden note · opens at Trust 60/);
    assert.ok(el.querySelector('.npc-state-delta-present-card-bars'), 'the tab keeps its meters');
    assert.ok(!el.querySelector('.npc-state-delta-world-people'), 'only the World view draws People here');
    assert.equal(el.querySelector('.npc-state-delta-present-card-stage').textContent, 'Tolerates you');
    adapter.stop();
});

test('the whole row opens the dossier: a click on the card, on the cell, or a keyboard-made click on the card button', async () => {
    const { doc, page, adapter, opened } = await setup({ world: true });
    const el = element(doc);
    page[PAGE_API].render(el, {});
    const cell = el.children[0];
    const card = cell.querySelector('.npc-state-delta-present-card');
    // Pointer on the cell itself (outside the card), on the name inside the card.
    el.fire('click', { target: cell });
    el.fire('click', { target: cell.querySelector('.npc-state-delta-present-card-name') });
    // Enter or Space on the focused card button: the browser turns it into a click on the button.
    el.fire('click', { target: card });
    assert.deepEqual(opened, ['npc_temiwa', 'npc_temiwa', 'npc_temiwa']);
    // The card is a real button, so it takes the keyboard (index.js inlineCardHtml, the markup World draws).
    assert.match(indexSource, /<button type="button" class="npc-state-delta-present-card" data-npc-id="\$\{escapeHtml\(npc\.id\)\}" data-message-id="\$\{messageId\}" aria-label="Open /);
    adapter.stop();
});

test('a click elsewhere on the pane opens nothing; the Dossiers rows still open theirs', async () => {
    const { doc, page, adapter, opened } = await setup({ world: true });
    const el = element(doc);
    page[PAGE_API].render(el, {});
    el.fire('click', { target: el });
    assert.deepEqual(opened, []);
    const row = { dataset: { npcId: 'npc_x' }, closest: selector => (selector === '.npc-state-delta-story-row' ? row : null) };
    el.fire('click', { target: row });
    assert.deepEqual(opened, ['npc_x']);
    adapter.stop();
});

test('the description is one line (two on a phone) in People here, the standing a chip; the in-chat card keeps its two lines', () => {
    assert.match(css, /\.npc-state-delta-world-people \.npc-state-delta-present-card-role \{ -webkit-line-clamp: 1; line-clamp: 1; \}/);
    assert.match(css, /@media \(max-width: 599px\) \{\s*\.npc-state-delta-world-people \.npc-state-delta-present-card-role \{ -webkit-line-clamp: 2; line-clamp: 2; \}/);
    assert.match(css, /\.npc-state-delta-world-people \.npc-state-delta-present-card-stage \{[^}]*border-radius: 999px;/);
    assert.match(css, /^\.npc-state-delta-present-card-role \{[^}]*-webkit-line-clamp: 2; line-clamp: 2;/m, 'everywhere else: two lines');
    assert.match(css, /\.npc-state-delta-world-people \{ cursor: pointer; \}/);
});
