import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    CAST_TAB_ID,
    DOSSIER_FIELDS,
    HOSTED_FLAG,
    HOST_RETRY_ATTEMPTS,
    MODULE_ID,
    QUERY_NAMES,
    V2_HOST_EVENT,
    createStorySuiteV2Adapter,
    dossierFields,
    isV2Host,
    portraitUrl,
    safeImageUrl,
} from '../src/storysuite-v2.js';
import { connectStoryBlock, V2_HOST_EVENT as TABS_V2_HOST_EVENT } from '../story-block-tabs.js';
import { announceNpcStateDelta, openSuiteOverlay, storyBlockIsV2, suiteManageAvailable } from '../suite-handshake.js';

// Story Suite v2 adapter (src/storysuite-v2.js): Delta registers with a Story Block v2 host when one
// is on the page, and does nothing otherwise. A fake sdk, a fake Delta runtime, fake timers and a
// small fake DOM stand in for Story Block, index.js, the browser and SillyTavern's drawer.

// ---- a small DOM: just what the adapter touches ----
class FakeNode {
    constructor(doc, tag = 'div') {
        this.ownerDocument = doc;
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.hidden = false;
        this.id = '';
        this.listeners = {};
        this.writes = 0;
        this.html = '';
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
        };
    }
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name)); }
    get innerHTML() { return this.html; }
    set innerHTML(value) { this.html = String(value); this.writes += 1; }
    set textContent(value) { this.replaceChildren(); this.html = String(value); }
    get textContent() { return this.html; }
    get isConnected() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node === this.ownerDocument.documentElement;
    }
    detach() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentNode = null;
    }
    appendChild(child) {
        child.detach();
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    insertBefore(child, ref) {
        child.detach();
        const at = this.children.indexOf(ref);
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        child.parentNode = this;
        return child;
    }
    before(node) { this.parentNode.insertBefore(node, this); }
    remove() { this.detach(); }
    replaceChildren(...nodes) {
        for (const child of [...this.children]) child.detach();
        this.html = '';
        for (const node of nodes) this.appendChild(node);
    }
    contains(node) {
        for (let at = node; at; at = at.parentNode) if (at === this) return true;
        return false;
    }
    *walk() {
        for (const child of this.children) {
            yield child;
            yield* child.walk();
        }
    }
    querySelector(selector) {
        const name = selector.replace(/^\./, '');
        for (const node of this.walk()) if (node.classList.contains(name)) return node;
        return null;
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
}

function fakeDocument() {
    const doc = { listeners: {} };
    doc.createElement = tag => new FakeNode(doc, tag);
    doc.documentElement = new FakeNode(doc, 'html');
    doc.body = doc.documentElement.appendChild(new FakeNode(doc, 'body'));
    doc.getElementById = id => {
        for (const node of doc.documentElement.walk()) if (node.id === id) return node;
        return null;
    };
    doc.addEventListener = (name, fn) => { (doc.listeners[name] ||= []).push(fn); };
    doc.dispatch = name => { for (const fn of doc.listeners[name] || []) fn({ type: name }); };
    doc.sent = [];
    doc.dispatchEvent = event => {
        doc.sent.push({ type: event.type, detail: event.detail });
        for (const fn of doc.listeners[event.type] || []) fn(event);
        return true;
    };
    return doc;
}

// SillyTavern's extensions drawer with Delta's panel (an extension_container holding an inline-drawer).
function drawerWithPanel(doc, { display = 'block' } = {}) {
    const drawer = doc.body.appendChild(doc.createElement('div'));
    drawer.id = 'extensions_settings2';
    const before = drawer.appendChild(doc.createElement('div'));
    const panel = drawer.appendChild(doc.createElement('div'));
    panel.id = 'npc_state_delta_settings';
    panel.style.display = display;
    const inline = panel.appendChild(doc.createElement('div'));
    inline.className = 'inline-drawer';
    const after = drawer.appendChild(doc.createElement('div'));
    return { drawer, panel, inline, before, after };
}

function fakeTimers() {
    let next = 1;
    const timeouts = new Map();
    const intervals = new Map();
    return {
        timeouts, intervals,
        setTimeout(fn) { const id = next++; timeouts.set(id, fn); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval(fn) { const id = next++; intervals.set(id, fn); return id; },
        clearInterval(id) { intervals.delete(id); },
        /** Run every pending timeout once (the ones they schedule wait for the next call). */
        runTimeouts() {
            const due = [...timeouts.entries()];
            timeouts.clear();
            for (const [, fn] of due) fn();
            return due.length;
        },
        runIntervals() { for (const fn of [...intervals.values()]) fn(); },
    };
}

function fakeSdk({ fail = false } = {}) {
    const sdk = {
        registered: [],
        registerModule(def) {
            if (fail) throw new Error('clash');
            sdk.registered.push(def);
        },
    };
    return sdk;
}

const NPCS = [
    { id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], present: true, archived: false },
    { id: 'npc_oren', name: 'Oren', aliases: [], present: false, archived: false },
    { id: 'npc_kael', name: 'Kael', aliases: [], present: false, archived: true },
];
const RECORDS = {
    npc_mira: {
        id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], role: 'Blacksmith', species: 'Human', personality: 'Blunt',
        memories: ['Forged the gate'], customFields: { Rank: 'Master' }, relationship: { trust: 12, affection: 3, desire: 0, tension: -4 },
        present: true, archived: false, lifeState: 'alive',
        portraitPromptPositive: 'secret prompt', profileEvidence: { role: ['x'] }, updatedAt: 99, manualProfileFields: ['role'],
    },
    npc_oren: { id: 'npc_oren', name: 'Oren', aliases: [], role: 'Guard', present: false, archived: false },
};
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBP = 'data:image/webp;base64,UklGRg==';
const FORM_PORTRAITS = {};

function fakeDelta() {
    const delta = {
        enabled: true, cast: '<section class="npc-state-delta-present-roster">Mira</section>', filled: [], scans: 0, adds: 0,
        npcs: structuredClone(NPCS),
        suiteApi: { npcs: () => structuredClone(delta.npcs) },
        api: {
            isEnabled: () => delta.enabled,
            presentCastHtml: () => delta.cast,
            castEmptyReason: () => ({ text: 'The latest scan found no NPC in the scene.', scan: true }),
            fillPresentCast: root => delta.filled.push(root),
            getNpc: id => (RECORDS[id] ? structuredClone(RECORDS[id]) : null),
            formPortraits: id => structuredClone(FORM_PORTRAITS[id] || {}),
            scan: () => { delta.scans += 1; },
            addNpc: () => { delta.adds += 1; },
        },
    };
    return delta;
}

function setup({ hostValue, delta = fakeDelta(), loadEmptyCast } = {}) {
    const doc = fakeDocument();
    const dom = drawerWithPanel(doc);
    const timers = fakeTimers();
    const warnings = [];
    const box = { host: hostValue };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: delta.suiteApi,
        delta: () => delta.api,
        version: '1.2.20',
        host: () => box.host,
        doc,
        timers,
        logger: { warn: (...args) => warnings.push(args) },
        ...(loadEmptyCast ? { loadEmptyCast } : {}),
    });
    return { doc, dom, timers, warnings, box, adapter, delta };
}

const v2Host = sdk => ({ ready: Promise.resolve(sdk) });

async function hosted(options = {}) {
    const sdk = options.sdk || fakeSdk();
    const env = setup({ hostValue: v2Host(sdk), ...options });
    env.adapter.start();
    assert.equal(await env.adapter.settled(), true);
    return { ...env, sdk, def: sdk.registered[0] };
}

// ---- without a host ----

test('without Story Block the adapter looks a bounded number of times, then stops, touching nothing', async () => {
    const { adapter, timers, dom } = setup({ hostValue: undefined });
    adapter.start();
    let rounds = 0;
    while (timers.runTimeouts()) rounds += 1;
    assert.equal(rounds, HOST_RETRY_ATTEMPTS);
    assert.equal(timers.intervals.size, 0);
    assert.equal(adapter.hosted(), false);
    assert.equal(await adapter.settled(), false);
    assert.equal(dom.panel.style.display, 'block');
    assert.equal(dom.panel.parentNode, dom.drawer);
    assert.equal(dom.panel.dataset.npcStateDeltaHosted, undefined);
});

test('a v1 Story Block (registerTab, no ready or sdk) is not a v2 host and is left to the v1 tabs', async () => {
    const v1 = { apiVersion: 1, registerTab() {}, unregisterTab() {}, refresh() {} };
    assert.equal(isV2Host(v1), false);
    assert.equal(isV2Host(undefined), false);
    assert.equal(isV2Host({ ready: Promise.resolve({}) }), true);
    assert.equal(isV2Host({ sdk: { registerModule() {} } }), true);
    const { adapter, timers, dom } = setup({ hostValue: v1 });
    adapter.start();
    while (timers.runTimeouts());
    assert.equal(adapter.hosted(), false);
    assert.equal(dom.panel.style.display, 'block');
});

// ---- registration ----

test('registers module npc-state-delta once, with the npc domain, its queries and commands, a Cast tab and a settings section', async () => {
    const { adapter, sdk, def, timers } = await hosted();
    assert.equal(sdk.registered.length, 1);
    assert.equal(def.id, MODULE_ID);
    assert.equal(def.name, 'NPC State Delta');
    assert.equal(def.version, '1.2.20');
    assert.deepEqual(Object.keys(def.domains), ['npc'], 'one small domain: the NPC meters (F81, F90)');
    assert.deepEqual(Object.keys(def.queries).sort(), ['npc.cast', 'npc.dossier', 'npc.known', 'npc.meters', 'npc.next', 'npc.portrait', 'npc.present', 'npc.socialModifier']);
    assert.deepEqual([...QUERY_NAMES].sort(), Object.keys(def.queries).sort());
    assert.deepEqual(Object.keys(def.commands).sort(), ['npc.adjust', 'npc.milestone', 'npc.refresh', 'npc.set', 'npc.tick']);
    assert.deepEqual(Object.keys(def.capture.kinds), ['npc', 'milestone']);
    assert.equal(def.capture.kinds.milestone.feature, 'npc-state-delta.stages', 'the milestone kind belongs to the stages feature');
    assert.deepEqual(def.features.map(feature => [feature.id, feature.default]), [['npc-state-delta.stages', true], ['npc-state-delta.drift', false], ['npc-state-delta.presets', true], ['npc-state-delta.social', true]]);
    assert.equal(typeof def.context.static, 'function', 'one static line for the npc kind; Delta keeps its own prompt keys besides');
    assert.equal(typeof def.settings.section, 'function');
    assert.deepEqual(Object.keys(def.settings.schema), ['changeCap', 'customMeters', 'stages', 'ladder', 'conflictAt', 'demoteAfter', 'socialScale', 'socialCap']);
    assert.deepEqual(def.tabs.map(tab => [tab.id, tab.title]), [[CAST_TAB_ID, 'Dossiers']], 'the Cast tab is Dossiers now; its id stays `cast`');
    adapter.start();
    adapter.check();
    timers.runIntervals();
    timers.runTimeouts();
    await adapter.settled();
    assert.equal(sdk.registered.length, 1, 'never registered twice');
    assert.equal(adapter.hosted(), true);
});

test('a host that appears after Delta loads is found by the bounded retry; `sdk` without `ready` works too', async () => {
    const sdk = fakeSdk();
    const { adapter, timers, box } = setup({ hostValue: { apiVersion: 1 } });
    adapter.start();
    timers.runTimeouts();
    timers.runTimeouts();
    assert.equal(sdk.registered.length, 0);
    box.host = { sdk };
    timers.runTimeouts();
    assert.equal(await adapter.settled(), true);
    assert.equal(sdk.registered.length, 1);
    assert.equal(timers.timeouts.size, 0, 'polling stopped once found');
});

test('a registration the host refuses leaves Delta standalone and is not retried', async () => {
    const sdk = fakeSdk({ fail: true });
    const { adapter, warnings, dom, timers } = setup({ hostValue: v2Host(sdk) });
    adapter.start();
    assert.equal(await adapter.settled(), false);
    assert.equal(adapter.hosted(), false);
    assert.equal(warnings.length, 1);
    assert.equal(dom.panel.style.display, 'block');
    assert.equal(timers.timeouts.size + timers.intervals.size, 0);
});

test('a ready promise that rejects leaves Delta standalone', async () => {
    const ready = Promise.reject(new Error('host failed'));
    ready.catch(() => {});
    const { adapter, warnings, dom } = setup({ hostValue: { ready } });
    adapter.start();
    assert.equal(await adapter.settled(), false);
    assert.equal(adapter.hosted(), false);
    assert.equal(warnings.length, 1);
    assert.equal(dom.panel.style.display, 'block');
});

test('a host replaced while it gets ready is looked for again, within the same bound', async () => {
    const timers = fakeTimers();
    const fresh = () => v2Host(fakeSdk());
    const looping = createStorySuiteV2Adapter({ host: fresh, doc: fakeDocument(), timers, logger: { warn() {} }, loadEmptyCast: async () => null });
    looping.start();
    let rounds = 0;
    for (;;) {
        await looping.settled();
        if (!timers.runTimeouts()) break;
        rounds += 1;
    }
    assert.equal(rounds, HOST_RETRY_ATTEMPTS);
    assert.equal(looping.hosted(), false);
});

// ---- queries ----

test('npc.present and npc.known return names from Delta\'s own data, as fresh copies', async () => {
    const { def, delta } = await hosted();
    const present = def.queries['npc.present']({}, {});
    const known = def.queries['npc.known']({}, {});
    assert.deepEqual(present, ['Mira']);
    assert.deepEqual(known, ['Mira', 'Oren'], 'archived NPCs are not listed');
    present.push('Intruder');
    known.length = 0;
    assert.deepEqual(def.queries['npc.present']({}, {}), ['Mira']);
    assert.deepEqual(def.queries['npc.known']({}, {}), ['Mira', 'Oren']);
    assert.notEqual(def.queries['npc.present'](), def.queries['npc.present']());
    delta.npcs[1].present = true;
    assert.deepEqual(def.queries['npc.present'](), ['Mira', 'Oren'], 'follows Delta, nothing cached');
});

test('npc.dossier returns the dossier fields as a plain copy, by name or alias; unknown and archived give null', async () => {
    const { def } = await hosted();
    const dossier = def.queries['npc.dossier']({}, { name: 'mira' });
    assert.equal(dossier.id, 'npc_mira');
    assert.equal(dossier.role, 'Blacksmith');
    assert.deepEqual(dossier.relationship, { trust: 12, affection: 3, desire: 0, tension: -4 });
    assert.deepEqual(dossier.customFields, { Rank: 'Master' });
    for (const hidden of ['portraitPromptPositive', 'profileEvidence', 'updatedAt', 'manualProfileFields']) {
        assert.equal(hidden in dossier, false, `${hidden} stays inside Delta`);
    }
    assert.ok(Object.keys(dossier).every(key => DOSSIER_FIELDS.includes(key)));
    assert.deepEqual(JSON.parse(JSON.stringify(dossier)), dossier, 'plain JSON only');
    assert.deepEqual(def.queries['npc.dossier']({}, { name: 'The Smith' }).id, 'npc_mira');
    dossier.memories.push('changed');
    dossier.relationship.trust = 100;
    const again = def.queries['npc.dossier']({}, { name: 'Mira' });
    assert.deepEqual(again.memories, ['Forged the gate']);
    assert.equal(again.relationship.trust, 12);
    assert.equal(def.queries['npc.dossier']({}, { name: 'Nobody' }), null);
    assert.equal(def.queries['npc.dossier']({}, { name: 'Kael' }), null);
    assert.equal(def.queries['npc.dossier']({}, {}), null);
    assert.equal(def.queries['npc.dossier']({}, undefined), null);
});

test('queries give nothing while Delta is off, and never throw when Delta fails', async () => {
    const { def, delta } = await hosted();
    delta.enabled = false;
    assert.deepEqual(def.queries['npc.present'](), []);
    assert.deepEqual(def.queries['npc.known'](), []);
    assert.equal(def.queries['npc.dossier']({}, { name: 'Mira' }), null);
    delta.enabled = true;
    delta.suiteApi.npcs = () => { throw new Error('not loaded'); };
    assert.deepEqual(def.queries['npc.present'](), []);
    assert.equal(def.queries['npc.dossier']({}, { name: 'Mira' }), null);
});

test('dossierFields copies only the listed fields', () => {
    assert.equal(dossierFields(null), null);
    const out = dossierFields({ name: 'A', relationship: { trust: '5', extra: 1 }, portrait: { dataUrl: 'data:x' }, aliases: ['B'] });
    assert.deepEqual(out, { name: 'A', aliases: ['B'], relationship: { trust: 5, affection: 0, desire: 0, tension: 0 } });
});

// ---- npc.portrait (MODULES §F11) ----

// A Delta whose records carry portraits: Mira has a main portrait and a Raven form image, Oren none.
function portraitDelta({ mira = {}, forms = { Raven: { form: 'Raven', dataUrl: WEBP } } } = {}) {
    const delta = fakeDelta();
    const records = {
        npc_mira: { ...structuredClone(RECORDS.npc_mira), portrait: { dataUrl: PNG, sourceName: 'mira.png' }, ...mira },
        npc_oren: structuredClone(RECORDS.npc_oren),
        npc_kael: { id: 'npc_kael', name: 'Kael', archived: true, portrait: { dataUrl: PNG } },
    };
    delta.records = records;
    delta.formReads = [];
    delta.api.getNpc = id => (records[id] ? structuredClone(records[id]) : null);
    delta.api.formPortraits = id => { delta.formReads.push(id); return id === 'npc_mira' ? structuredClone(forms) : {}; };
    return delta;
}

test('npc.portrait gives the portrait Delta shows, by name, alias or id; none, unknown or archived give null', async () => {
    const delta = portraitDelta();
    const { def } = await hosted({ delta });
    const portrait = def.queries['npc.portrait'];
    assert.equal(portrait({}, { name: 'Mira' }), PNG);
    assert.equal(portrait({}, { name: 'the smith' }), PNG, 'by alias, case-insensitive');
    assert.equal(portrait({}, { name: 'npc_mira' }), PNG, 'by id');
    assert.deepEqual(delta.formReads.at(-1), 'npc_mira', 'form images are read by the resolved id');
    assert.equal(portrait({}, { name: 'Oren' }), null, 'no portrait');
    assert.equal(portrait({}, { name: 'Kael' }), null, 'archived NPCs are not offered (as npc.dossier)');
    assert.equal(portrait({}, { name: 'Nobody' }), null);
    assert.equal(portrait({}, {}), null);
    assert.equal(portrait({}, undefined), null);
    assert.equal(portrait({}, { name: 42 }), null);
});

test('npc.portrait follows the current appearance form when that form has its own image', async () => {
    const delta = portraitDelta({ mira: { currentForm: 'raven' } });
    const { def } = await hosted({ delta });
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), WEBP, 'form names match case-insensitively');
    delta.records.npc_mira.currentForm = 'Human';
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), PNG, 'a form without its own image shows the main portrait');
    delta.api.formPortraits = () => { throw new Error('not loaded'); };
    delta.records.npc_mira.currentForm = 'Raven';
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), PNG, 'form images failing falls back to the main portrait');
});

test('npc.portrait never hands out an unsafe URL', async () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=',
        'data:text/html;base64,PGI+', 'data:image/png,<svg onload=x>', 'http://example.com/a.png', '//evil.example/a.png',
        '/\\evil.example/a.png', 'blob:https://example.com/1', 'vbscript:x', 'https:evil.example', '?a', '#a', '', '   ']) {
        const delta = portraitDelta({ mira: { portrait: { dataUrl: bad, url: bad, src: bad } }, forms: { Raven: { dataUrl: bad } } });
        delta.records.npc_mira.currentForm = 'Raven';
        const { def } = await hosted({ delta });
        assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), null, `${JSON.stringify(bad)} is refused`);
    }
    // An unsafe image gives way to the next safe one: form image, then dataUrl, url, src.
    const delta = portraitDelta({ mira: { currentForm: 'Raven', portrait: { dataUrl: 'javascript:x', url: '/user/images/Mira.png' } }, forms: { Raven: { dataUrl: 'javascript:y' } } });
    const { def } = await hosted({ delta });
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), '/user/images/Mira.png');
});

test('safeImageUrl keeps data: images, https: and same-origin paths only; portraitUrl reads Delta\'s fields', () => {
    for (const good of [PNG, WEBP, 'data:image/jpeg;base64,/9j/4AAQ', 'https://cdn.example.com/m.png', '/user/images/Mira.png', 'user/images/Mira.png', '../img/a.png']) {
        assert.equal(safeImageUrl(good), good, good);
    }
    assert.equal(safeImageUrl('  /user/images/Mira.png \n'), '/user/images/Mira.png', 'trimmed');
    for (const bad of [null, undefined, 3, {}, 'javascript:alert(1)', 'data:image/svg+xml;base64,AA', 'http://x/a.png', '//x/a.png', 'file:///etc/passwd', 'a\u0000b.png']) {
        assert.equal(safeImageUrl(bad), null, String(bad));
    }
    assert.equal(portraitUrl(null), null);
    assert.equal(portraitUrl({}), null);
    assert.equal(portraitUrl({ portrait: { dataUrl: PNG } }), PNG);
    assert.equal(portraitUrl({ portrait: { url: 'https://cdn.example.com/m.png' } }), 'https://cdn.example.com/m.png');
    assert.equal(portraitUrl({ portrait: { src: '/user/images/m.png' } }), '/user/images/m.png');
    assert.equal(portraitUrl({ currentForm: ' Raven ', portrait: { dataUrl: PNG } }, { raven: { dataUrl: WEBP } }), WEBP);
    assert.equal(portraitUrl({ currentForm: 'Raven', portrait: 'not-an-object' }, null), null);
});

test('npc.portrait gives nothing while Delta is off, and never throws when Delta fails', async () => {
    const delta = portraitDelta();
    const { def, warnings } = await hosted({ delta });
    delta.enabled = false;
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), null);
    delta.enabled = true;
    delta.api.getNpc = () => { throw new Error('broken'); };
    assert.equal(def.queries['npc.portrait']({}, { name: 'Mira' }), null);
    assert.ok(warnings.some(args => /portrait query failed/.test(args[0])));
});

// ---- the drawer copy and the settings section ----

test('while hosted the drawer copy is hidden; the section moves the same panel into the overlay and back', async () => {
    const { def, dom, doc, timers } = await hosted();
    assert.equal(dom.panel.style.display, 'none', 'drawer copy hidden as soon as hosted');
    const el = doc.body.appendChild(doc.createElement('section'));
    const cleanup = def.settings.section(el, {});
    assert.equal(dom.panel.parentNode, el, 'the panel itself is moved (one copy, listeners kept)');
    assert.equal(dom.panel.style.display, 'block', 'shown inside the overlay');
    assert.equal(dom.inline.classList.contains('story-suite-drawer'), true);
    const placeholder = dom.drawer.children[1];
    assert.equal(placeholder.dataset.npcStateDeltaPlaceholder, '1');
    assert.equal(placeholder.hidden, true);
    assert.equal(doc.getElementById('npc_state_delta_settings'), dom.panel);

    cleanup();
    assert.deepEqual(dom.drawer.children, [dom.before, dom.panel, dom.after], 'back exactly where it was');
    assert.equal(dom.panel.style.display, 'none', 'still hosted: hidden again');
    assert.equal(dom.inline.classList.contains('story-suite-drawer'), false);

    // The overlay drops the section without calling back: the panel goes home at the next watch.
    const el2 = doc.body.appendChild(doc.createElement('section'));
    def.settings.section(el2, {});
    assert.equal(dom.panel.parentNode, el2);
    el2.remove();
    timers.runIntervals();
    assert.equal(dom.panel.parentNode, dom.drawer);
    assert.equal(dom.panel.isConnected, true);
    assert.equal(dom.panel.style.display, 'none');
    assert.equal(dom.drawer.children.length, 3, 'no placeholder left behind');
});

test('a second section element takes the panel from the first; the first one\'s cleanup then does nothing', async () => {
    const { def, dom, doc } = await hosted();
    const first = doc.body.appendChild(doc.createElement('section'));
    const second = doc.body.appendChild(doc.createElement('section'));
    const cleanupFirst = def.settings.section(first, {});
    def.settings.section(second, {});
    assert.equal(dom.panel.parentNode, second);
    cleanupFirst();
    assert.equal(dom.panel.parentNode, second);
    assert.equal(dom.drawer.children.filter(node => node.dataset.npcStateDeltaPlaceholder).length, 1);
});

test('when the host goes away the drawer copy comes back as it was, and the adapter looks again', async () => {
    const { adapter, def, dom, doc, box, timers } = await hosted();
    const el = doc.body.appendChild(doc.createElement('section'));
    def.settings.section(el, {});
    box.host = undefined;
    timers.runIntervals();
    assert.equal(adapter.hosted(), false);
    assert.deepEqual(dom.drawer.children, [dom.before, dom.panel, dom.after]);
    assert.equal(dom.panel.style.display, 'block', 'its own display value restored');
    assert.equal(dom.panel.dataset.npcStateDeltaHosted, undefined);
    assert.equal(timers.timeouts.size, 1, 'looking for a host again');

    const sdk2 = fakeSdk();
    box.host = v2Host(sdk2);
    timers.runTimeouts();
    assert.equal(await adapter.settled(), true);
    assert.equal(sdk2.registered.length, 1, 'a new host gets its own registration');
    assert.equal(dom.panel.style.display, 'none');
});

test('stop() gives everything back', async () => {
    const { adapter, dom, timers } = await hosted();
    adapter.stop();
    assert.equal(adapter.hosted(), false);
    assert.equal(dom.panel.style.display, 'block');
    assert.equal(timers.timeouts.size + timers.intervals.size, 0);
});

test('a panel that mounts after hosting is hidden; a section opened before it waits for it', async () => {
    const sdk = fakeSdk();
    const doc = fakeDocument();
    const timers = fakeTimers();
    const delta = fakeDelta();
    const sb = v2Host(sdk);
    const adapter = createStorySuiteV2Adapter({
        suiteApi: delta.suiteApi, delta: () => delta.api, host: () => sb, doc, timers, logger: { warn() {} },
    });
    adapter.start();
    await adapter.settled();
    const el = doc.body.appendChild(doc.createElement('section'));
    sdk.registered[0].settings.section(el, {});
    // The meter presets block shows at once; Delta's panel is still on its way.
    assert.match(el.children.map(child => child.textContent).join(' '), /still loading/);
    const { panel } = drawerWithPanel(doc);
    doc.dispatch('npc-state-delta:settings-mounted');
    assert.equal(panel.parentNode, el);
    assert.equal(panel.style.display, 'block');
    el.remove();
    timers.runIntervals();
    assert.equal(panel.style.display, 'none');
});

test('a panel that mounts after hosting, with no section waiting, is hidden at once', async () => {
    const sdk = fakeSdk();
    const doc = fakeDocument();
    const delta = fakeDelta();
    const sb = v2Host(sdk);
    const adapter = createStorySuiteV2Adapter({
        suiteApi: delta.suiteApi, delta: () => delta.api, host: () => sb, doc, timers: fakeTimers(), logger: { warn() {} },
    });
    adapter.start();
    await adapter.settled();
    const { panel } = drawerWithPanel(doc);
    assert.equal(panel.style.display, 'block');
    doc.dispatch('npc-state-delta:settings-mounted');
    assert.equal(panel.style.display, 'none');
});

// ---- the Cast tab ----

test('the Cast tab renders Delta\'s own present-cast markup and fills its text', async () => {
    const { def, delta, doc } = await hosted();
    const el = doc.body.appendChild(doc.createElement('div'));
    el.dataset.tabId = CAST_TAB_ID;   // Story Block's tab host marks its pane with the shown tab
    def.tabs[0].render(el, { state: {} }, {});
    // Without Story Director the present cast stays at the top of Dossiers, the dossier list under it.
    assert.match(el.innerHTML, /^<div class="npc-state-delta-story-pane"><section class="npc-state-delta-present-roster">Mira<\/section><div class="npc-state-delta-story-dossiers npc-state-delta-v2-dossiers">.*<\/div><\/div>$/);
    assert.deepEqual(delta.filled, [el]);
    def.tabs[0].render(el, { state: {} }, {});
    assert.equal(el.writes, 1, 'unchanged cast is not rewritten');
    delta.cast = '<section class="npc-state-delta-present-roster">Mira, Oren</section>';
    doc.dispatch('npc-state-delta:cast-rendered');
    assert.match(el.innerHTML, /Mira, Oren/);
    assert.equal(el.writes, 2, 'follows Delta\'s own redraws');
});

test('an empty Cast tab uses the v1 tab\'s empty line and Scan button; Delta off says so', async () => {
    const { def, delta, doc } = await hosted();
    delta.cast = '';
    const el = doc.body.appendChild(doc.createElement('div'));
    el.dataset.tabId = CAST_TAB_ID;
    def.tabs[0].render(el, {}, {});
    assert.match(el.innerHTML, /The latest scan found no NPC in the scene\./);
    assert.match(el.innerHTML, /data-npc-state-delta-action="scan"/, 'emptyCastHtml from story-block-tabs.js');
    const scan = { dataset: { npcStateDeltaAction: 'scan' } };
    el.listeners.click[0]({ target: { closest: () => scan } });
    assert.equal(delta.scans, 1);
    delta.enabled = false;
    doc.dispatch('npc-state-delta:enabled-changed');
    assert.match(el.innerHTML, /NPC State Delta is off\./);
});

test('if the v1 empty-state markup cannot load, the Cast tab still shows a plain, escaped line', async () => {
    const delta = fakeDelta();
    delta.cast = '';
    delta.api.castEmptyReason = () => ({ text: '<b>nobody</b>', scan: true });
    const { def, doc } = await hosted({ delta, loadEmptyCast: () => Promise.reject(new Error('missing')) });
    const el = doc.body.appendChild(doc.createElement('div'));
    def.tabs[0].render(el, {}, {});
    assert.match(el.innerHTML, /&lt;b&gt;nobody&lt;\/b&gt;/);
});

// ---- with a v2 host, nothing of v1 is offered (MODULES §D; v1 hosts unchanged) ----

test('the adapter tells the page when it is hosted and when the host goes away; never without a host', async () => {
    const { doc, box, timers, adapter } = await hosted();
    assert.equal(V2_HOST_EVENT, TABS_V2_HOST_EVENT, 'story-block-tabs.js listens for the same event');
    assert.deepEqual(doc.sent, [{ type: V2_HOST_EVENT, detail: { hosted: true } }]);
    box.host = undefined;
    timers.runIntervals();
    assert.deepEqual(doc.sent.at(-1), { type: V2_HOST_EVENT, detail: { hosted: false } });
    adapter.stop();
    assert.equal(doc.sent.length, 2, 'stop() after the host left sends nothing more');

    const alone = setup({ hostValue: { apiVersion: 1, registerTab() {} } });
    alone.adapter.start();
    while (alone.timers.runTimeouts());
    alone.adapter.stop();
    assert.deepEqual(alone.doc.sent, [], 'a v1 host or none: no event');
});

test('the page flag (data-npc-state-delta-story-block-v2) is set while hosted, before the event, and removed when the host goes away or on stop()', async () => {
    assert.equal(HOSTED_FLAG, 'npcStateDeltaStoryBlockV2');
    const sdk = fakeSdk();
    const env = setup({ hostValue: v2Host(sdk) });
    const seen = [];
    env.doc.addEventListener(V2_HOST_EVENT, event => seen.push([event.detail.hosted, env.doc.documentElement.dataset[HOSTED_FLAG]]));
    env.adapter.start();
    assert.equal(await env.adapter.settled(), true);
    assert.equal(env.doc.documentElement.dataset[HOSTED_FLAG], '1');
    env.box.host = undefined;
    env.timers.runIntervals();
    assert.equal(env.doc.documentElement.dataset[HOSTED_FLAG], undefined);
    assert.deepEqual(seen, [[true, '1'], [false, undefined]], 'listeners see the flag already in its new state');

    const again = await hosted();
    assert.equal(again.doc.documentElement.dataset[HOSTED_FLAG], '1');
    again.adapter.stop();
    assert.equal(again.doc.documentElement.dataset[HOSTED_FLAG], undefined);

    for (const hostValue of [undefined, { apiVersion: 1, registerTab() {} }]) {
        const alone = setup({ hostValue });
        alone.adapter.start();
        while (alone.timers.runTimeouts());
        assert.equal(alone.doc.documentElement.dataset[HOSTED_FLAG], undefined, 'never without a v2 host');
        alone.adapter.stop();
        assert.deepEqual(alone.doc.documentElement.dataset, {});
    }

    const refused = setup({ hostValue: v2Host(fakeSdk({ fail: true })) });
    refused.adapter.start();
    assert.equal(await refused.adapter.settled(), false);
    assert.equal(refused.doc.documentElement.dataset[HOSTED_FLAG], undefined, 'a refused registration is not hosting');
});

test('storyBlockIsV2 is true only for apiVersion 2', () => {
    assert.equal(storyBlockIsV2({ apiVersion: 2, ready: Promise.resolve({}) }), true);
    assert.equal(storyBlockIsV2({ apiVersion: 1, registerTab() {} }), false);
    assert.equal(storyBlockIsV2({ apiVersion: '2' }), false);
    assert.equal(storyBlockIsV2({}), false);
    assert.equal(storyBlockIsV2(undefined), false);
    assert.equal(storyBlockIsV2(null), false);
    const throwing = { get apiVersion() { throw new Error('no'); } };
    assert.equal(storyBlockIsV2(throwing), false);
});

// A v1-style registry, as suite.js makes it, with Story Block v1's openSuite.
function fakeRegistry() {
    const providers = new Map();
    const opened = [];
    return {
        opened,
        announce(provider) { providers.set(provider.id, { ...provider }); },
        withdraw(id) { providers.delete(id); },
        providers: () => [...providers.values()],
        has: id => providers.has(id),
        api: id => providers.get(id)?.api ?? null,
    };
}

test('with a v2 Story Block, Delta withdraws from v1\'s Story Suite registry and offers no v1 overlay; v1 hosts are unchanged', () => {
    const registry = fakeRegistry();
    registry.announce({ id: 'story-block', api: { openSuite: id => registry.opened.push(id) } });
    const v1 = { apiVersion: 1, registerTab() {} };
    const v2 = { apiVersion: 2, ready: Promise.resolve({}) };

    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.20', settings: '#npc_state_delta_settings', storyBlock: v1 }, registry), true);
    assert.equal(registry.has('npc-state-delta'), true, 'v1: announced as before');
    assert.equal(suiteManageAvailable(registry, v1), true);
    assert.equal(openSuiteOverlay(registry, v1), true);
    assert.deepEqual(registry.opened, ['npc-state-delta']);

    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.20', settings: '#npc_state_delta_settings', storyBlock: v2 }, registry), false);
    assert.equal(registry.has('npc-state-delta'), false, 'v2: withdrawn, so v1\'s overlay cannot carry the panel too');
    registry.announce({ id: 'npc-state-delta' });
    assert.equal(suiteManageAvailable(registry, v2), false, 'no "Open Story Suite" button');
    assert.equal(openSuiteOverlay(registry, v2), false);
    assert.deepEqual(registry.opened, ['npc-state-delta'], 'nothing more opened');

    // The default reads the page's Story Block.
    const saved = globalThis.StoryBlock;
    try {
        globalThis.StoryBlock = v2;
        assert.equal(suiteManageAvailable(registry), false);
        assert.equal(announceNpcStateDelta({ enabled: true }, registry), false);
        globalThis.StoryBlock = v1;
        assert.equal(announceNpcStateDelta({ enabled: true }, registry), true);
        assert.equal(suiteManageAvailable(registry), true);
    } finally {
        if (saved === undefined) delete globalThis.StoryBlock; else globalThis.StoryBlock = saved;
    }
});

test('with a v2 Story Block, the v1 Present NPCs / Dossiers tabs are not registered even if it offers registerTab', () => {
    const tabs = [];
    const api = { presentCastHtml: () => '', isEnabled: () => true };
    assert.equal(connectStoryBlock(api, { apiVersion: 2, ready: Promise.resolve({}), registerTab: tab => tabs.push(tab) }), null);
    assert.deepEqual(tabs, []);

    // A v1 host still gets both, and a v2 host taking over later takes them back.
    const removed = [];
    const connection = connectStoryBlock(api, { apiVersion: 1, registerTab: tab => tabs.push(tab), unregisterTab: id => removed.push(id) });
    assert.deepEqual(tabs.map(tab => tab.id), ['npc-state-delta-cast', 'npc-state-delta-dossiers']);
    connection.disconnect();
    assert.deepEqual(removed, ['npc-state-delta-cast', 'npc-state-delta-dossiers']);
    connection.disconnect();
    assert.equal(removed.length, 2, 'once');
});

// ---- the hook in index.js ----

test('index.js starts the adapter once at startup through an optional import', () => {
    const index = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
    const calls = index.match(/import\('\.\/src\/storysuite-v2\.js'\)/g) || [];
    assert.equal(calls.length, 1);
    assert.match(index, /startStorySuiteV2\(\{ suiteApi: SUITE_API, panelId: UI_ID, version: NPC_STATE_VERSION, headReply: latestReplyIndex, calendarOwn: \(\) => normalizeSourceOfTruth\(getSettings\(\)\.sourceOfTruth\)\.calendar === 'mine' \}\)/);
    assert.equal(/from '\.\/src\/storysuite-v2\.js'/.test(index), false, 'no static import: a copy without src/ still loads');
});
