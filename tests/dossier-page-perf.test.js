import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaDossierUi } from '../dossier-ui.js';
import { openNpc, showScreen } from '../dossier-ui-screens.js';
import { runHostScenario } from './helpers/host-scenario.js';
import { createInlineCardsMountPart } from '../runtime-inline-cards-mount.js';
import { createWatchers } from '../src/adapter/cast-ui/watchers.js';

// The dossier page at a long chat's scale: portraits reach the panel by reference (never escaped into its markup or copied by the
// runtime's read), and a focus or a settings-panel mutation draws again only when something the panel shows changed.

const picture = tag => `data:image/jpeg;base64,${Buffer.from(`${tag}:${'x'.repeat(3000)}`).toString('base64')}`;
const settle = () => new Promise(resolve => setTimeout(resolve, 320));   // past the refresh debounce
const flush = () => new Promise(resolve => setImmediate(resolve));

// Images in markup the stub DOM was given, as the browser would hold them: keyed ones with no src until the controller sets it.
function imagesIn(html) {
    return [...String(html).matchAll(/<img class="([^"]+)" (?:data-delta-portrait="(\d+)"|src="([^"]*)")/g)].map(([, className, key, src]) => {
        const img = { className, dataset: key ? { deltaPortrait: key } : {}, src: src ?? null };
        img.hasAttribute = name => name === 'src' && img.src !== null;
        return img;
    });
}
function stubNode(extra = {}) {
    const node = { html: '', images: [], scrollLeft: 0, scrollTop: 0, dataset: {}, children: [], lastElementChild: null, ...extra };
    Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: value => { node.html = String(value); node.images = imagesIn(value); } });
    node.querySelectorAll = selector => (selector === 'img[data-delta-portrait]' ? node.images.filter(img => img.dataset.deltaPortrait) : []);
    node.querySelector = () => null;
    return node;
}

test('the dossier panel draws portraits by reference: no data URL in its markup or signatures, src set on the inserted image, one key per picture, forgotten once no dossier shows it', async () => {
    const saved = { document: globalThis.document, CSS: globalThis.CSS };
    const list = stubNode();
    const documentPane = stubNode();
    // The library skeleton and its face list are two nodes in the stub; the board, profile and sections replace the pane's own markup.
    documentPane.querySelector = selector => (selector === '[data-delta-library-list]' ? list : null);
    globalThis.document = { activeElement: null, createElement: () => ({}) };
    globalThis.CSS = { escape: value => value };
    try {
        const npcs = [
            { id: 'a', name: 'Aster', present: true, portrait: { dataUrl: picture('aster') }, currentForm: 'Fox',
                appearanceForms: [{ name: 'Human', appearance: 'Copper hair' }, { name: 'Fox', appearance: 'Red fur' }] },
            { id: 'b', name: 'Bryn', present: true, portrait: { dataUrl: picture('bryn') } },
            { id: 'c', name: 'Cass', present: true, portrait: { url: '/portraits/cass.png' } },
            { id: 'd', name: 'Dov', present: true },
        ];
        const state = { npcs, formPortraits: { a: { Fox: { dataUrl: picture('aster-fox') }, Human: { dataUrl: picture('aster-human') } } } };
        const api = { dossierViewStatus: () => ({ chatKey: 'chat-1', hydrationStatus: 'ready' }), getDossierState: () => state, dossierViewToken: () => JSON.stringify(state.npcs.map(npc => npc.portrait)) };
        const ui = new DeltaDossierUi(api);
        const nodes = { '.delta-document': documentPane, '.delta-stage': stubNode(), '.delta-empty': stubNode(), '.delta-notice': stubNode(), '.delta-chat-state': stubNode() };
        ui.root = { querySelector: selector => nodes[selector] ?? null, querySelectorAll: () => [], dispatchEvent: () => {} };
        ui.panelOpen = true;
        await ui.refresh({ force: true });

        // Library: each face gets its picture (the current form's, as before); a plain URL stays a plain src.
        const libraryMarkup = `${documentPane.html}${list.html}`;
        assert.doesNotMatch(libraryMarkup, /data:image/, 'no picture is escaped into the markup');
        assert.doesNotMatch(ui.lastScreenSignature, /data:image/, 'nor into a render signature');
        assert.ok(ui.lastScreenSignature.length < 900, `the library signature stays small (${ui.lastScreenSignature.length})`);
        assert.deepEqual(list.images.map(img => img.src).sort(), [picture('aster-fox'), picture('bryn'), '/portraits/cass.png'].sort(),
            'each inserted library image gets its picture (the current form\'s); a plain URL stays a plain src');
        assert.equal(list.images.length, 3, 'a dossier with no portrait keeps its placeholder');
        assert.equal(ui.portraitRefs.size, 2, 'one key per distinct data-URL picture in the library (Aster\'s fox and Bryn)');

        // Board: the dial's portrait goes by reference too. Profile: the portrait and the form thumbnails.
        ui.setScreen(openNpc(ui.screen, 'a'));
        assert.doesNotMatch(documentPane.html, /data:image/);
        assert.equal(documentPane.images[0].src, picture('aster-fox'), 'the dial shows the current form picture');
        ui.setScreen(showScreen(ui.screen, 'profile'));
        assert.doesNotMatch(`${documentPane.html}${ui.lastScreenSignature}`, /data:image/);
        assert.equal(documentPane.images[0].src, picture('aster-fox'), 'the profile portrait');
        assert.deepEqual(documentPane.images.slice(1).map(img => img.src).sort(), [picture('aster-fox'), picture('aster-human')], 'the form thumbnails too');
        assert.equal(ui.portraitRefs.size, 3, 'one key per distinct picture shown (the two forms and Bryn)');

        // The same pictures drawn again keep their keys; a picture no dossier shows any more is forgotten.
        const firstKeys = documentPane.images.map(img => img.dataset.deltaPortrait);
        await ui.refresh({ force: true });
        assert.deepEqual(documentPane.images.map(img => img.dataset.deltaPortrait), firstKeys);
        state.npcs = npcs.map(npc => (npc.id === 'b' ? { ...npc, portrait: null } : npc));
        await ui.refresh({ force: true });
        assert.equal(ui.portraitRefs.size, 2, 'the removed picture was forgotten');

        // The board's tie faces come from the other dossiers' portraits: a new portrait there changes the board's signature.
        ui.setScreen(openNpc(ui.screen, 'a'));
        const boardSignature = ui.lastScreenSignature;
        state.npcs = state.npcs.map(npc => (npc.id === 'c' ? { ...npc, portrait: { url: '/portraits/cass-2.png' } } : npc));
        await ui.refresh();
        assert.notEqual(ui.lastScreenSignature, boardSignature, 'a tied person\'s new portrait redraws the open board');
    } finally {
        globalThis.document = saved.document;
        globalThis.CSS = saved.CSS;
    }
});

test('a focus or a settings-panel mutation draws the dossier panel again only when the view token moved; its own draw\'s mutations are dropped; refresh asks no diagnostics', async () => {
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
    const observers = [];
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.taken = 0; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
        takeRecords() { this.taken += 1; return []; }
        disconnect() {}
    };
    const settingsPanel = { id: 'npc_state_delta_settings' };
    globalThis.document = { getElementById: id => (id === 'npc_state_delta_settings' ? settingsPanel : null) };
    try {
        let token = 'chat-1|1';
        const counts = { reads: 0 };
        const api = {
            uiStatus: () => { throw new Error('refresh must not build the diagnostics'); },
            dossierViewStatus: () => ({ chatKey: 'chat-1', hydrationStatus: 'ready', hydrationError: null }),
            dossierViewToken: () => token,
            getDossierState: () => { counts.reads += 1; return { npcs: [{ id: 'a', name: 'Aster' }] }; },
        };
        const ui = new DeltaDossierUi(api);
        let draws = 0;
        ui.root = { querySelector: () => null };
        ui.renderFromProjection = () => { draws += 1; };
        assert.equal(ui.attachLegacyObserver(), true);
        const [observer] = observers;
        assert.equal(observer.target, settingsPanel);
        ui.panelOpen = true;
        await ui.refresh({ force: true });
        assert.equal(draws, 1);
        assert.equal(ui.projection.npcs[0].name, 'Aster');
        assert.equal(observer.taken, 1, 'the mutations queued up to the draw (its own included) are dropped');

        ui.boundFocus();
        await settle();
        observer.callback([{ type: 'childList' }]);
        await settle();
        observer.callback([{ type: 'attributes' }]);
        await settle();
        assert.deepEqual([draws, counts.reads], [1, 1], 'nothing changed: no state read, no draw');

        token = 'chat-1|2';
        ui.boundFocus();
        await settle();
        assert.deepEqual([draws, counts.reads], [2, 2], 'a focus after a change draws');
        token = 'chat-1|3';
        observer.callback([{ type: 'childList' }]);
        await settle();
        assert.deepEqual([draws, counts.reads], [3, 3], 'so does a settings mutation after a change');
        observer.callback([{ type: 'childList' }]);
        await settle();
        assert.equal(draws, 3);

        // A runtime without the token (an older one) draws on every request, as before.
        delete api.dossierViewToken;
        ui.boundFocus();
        await settle();
        ui.boundFocus();
        await settle();
        assert.equal(draws, 5);
    } finally {
        globalThis.document = saved.document;
        globalThis.MutationObserver = saved.MutationObserver;
    }
});

test('runtime: getDossierState copies no portrait picture; dossierViewToken holds still until something the panel shows changes; dossierViewStatus is the load state only', () => {
    const output = runHostScenario('dossier-page-perf', async () => {}, async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(300);
        const mechanics = await import(pathToFileURL(path.join(extRoot, 'core-mechanics.js')).href);
        const png = `data:image/png;base64,${Buffer.from('p'.repeat(60000)).toString('base64')}`;
        const state = api.getState();
        const mira = mechanics.createNpcRecord('Mira', []);
        mira.portrait = { dataUrl: png, mime: 'image/png', updatedAt: 1, appearanceFingerprint: 'a2:x' };
        const oren = mechanics.createNpcRecord('Oren', [mira.id]);
        state.npcs = [mira, oren];
        await api.installState(state);
        await api.flush();
        await sleep(200);
        const out = {};
        // Every structuredClone the read makes, by whether a picture went through it.
        const plainClone = globalThis.structuredClone;
        let picturesCloned = 0;
        globalThis.structuredClone = (value, options) => { if (JSON.stringify(value ?? null).includes('data:image')) picturesCloned += 1; return plainClone(value, options); };
        let view;
        try { view = api.getDossierState(); } finally { globalThis.structuredClone = plainClone; }
        out.picturesCloned = picturesCloned;
        const shown = view.npcs.find(npc => npc.name === 'Mira');
        out.pictureShown = shown.portrait.dataUrl === png;
        out.recordKept = { mime: shown.portrait.mime, fingerprint: shown.portrait.appearanceFingerprint };
        shown.portrait.mime = 'changed';
        shown.portrait.dataUrl = 'changed';
        shown.name = 'changed';
        const live = api.getState().npcs.find(npc => npc.id === mira.id);
        out.liveUntouched = live.portrait.mime === 'image/png' && live.portrait.dataUrl === png && live.name === 'Mira';

        out.status = api.dossierViewStatus();
        const first = api.dossierViewToken();
        out.tokenStable = api.dossierViewToken() === first && (api.getDossierState(), api.uiStatus(), api.dossierViewToken()) === first;
        globalThis.__npcMock.extensionSettings.npc_state_delta.customFieldNames = ['Level'];
        const afterSettings = api.dossierViewToken();
        out.tokenMovesOnSettings = afterSettings !== first;
        const next = api.getState();
        next.npcs.find(npc => npc.name === 'Oren').mood = 'Wary';
        await api.installState(next);
        await sleep(50);
        out.tokenMovesOnWrite = api.dossierViewToken() !== afterSettings;
        console.log('RESULT ' + JSON.stringify(out));
    });
    const out = JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.equal(out.picturesCloned, 0, 'no picture goes through structuredClone');
    assert.equal(out.pictureShown, true);
    assert.deepEqual(out.recordKept, { mime: 'image/png', fingerprint: 'a2:x' });
    assert.equal(out.liveUntouched, true, 'the view is still a copy: changing it changes nothing stored');
    assert.deepEqual(Object.keys(out.status).sort(), ['chatKey', 'hydrationError', 'hydrationStatus']);
    assert.equal(out.status.hydrationStatus, 'ready');
    assert.equal(out.tokenStable, true, 'reads do not move the token');
    assert.equal(out.tokenMovesOnSettings, true, 'the configured fields are part of it');
    assert.equal(out.tokenMovesOnWrite, true, 'a state write moves it');
});

test('refresh asks coalesce: a burst of mutations costs one token check, and none while a reply streams', async () => {
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
    globalThis.document = { getElementById: () => null };
    try {
        let tokenReads = 0;
        let streaming = true;
        const api = {
            dossierViewStatus: () => ({ chatKey: 'chat-1', hydrationStatus: 'ready' }),
            dossierViewToken: () => { tokenReads += 1; return `t${tokenReads}`; },
            generationActive: () => streaming,
            getDossierState: () => ({ npcs: [{ id: 'a', name: 'Aster' }] }),
        };
        const ui = new DeltaDossierUi(api);
        let draws = 0;
        ui.root = { querySelector: () => null };
        ui.renderFromProjection = () => { draws += 1; };
        ui.panelOpen = true;
        for (let i = 0; i < 200; i += 1) ui.scheduleRefresh();   // 200 streamed tokens / keystrokes
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.deepEqual([tokenReads, draws], [0, 0], 'streaming: no token check, no draw');
        streaming = false;
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(draws, 1, 'one draw once the stream ended');
        assert.ok(tokenReads <= 2, `one burst, about one token check (${tokenReads})`);
        clearTimeout(ui.refreshTimer);
    } finally {
        globalThis.document = saved.document;
        globalThis.MutationObserver = saved.MutationObserver;
    }
});

test('hosted: the view token reads the host\'s views once per host revision (head / turn events), not per call', () => {
    const output = runHostScenario('dossier-host-views-cache', async () => {
        const sdk = {
            registered: [], listeners: new Map(), queries: 0,
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.listeners.set(name, [...(sdk.listeners.get(name) || []), fn]); return () => {}; },
            command: async () => ({ ok: true }),
            query: () => { sdk.queries += 1; return []; },
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(400);
        const sdk = mockState.sdk;
        const out = {};
        out.hosted = sdk.registered.length > 0 && (sdk.listeners.get('head') || []).length > 0;
        api.dossierViewToken();   // first read computes the host views
        const base = sdk.queries;
        const first = api.dossierViewToken();
        for (let i = 0; i < 20; i += 1) api.dossierViewToken();
        out.queriesWhileStill = sdk.queries - base;
        out.stable = api.dossierViewToken() === first;
        for (const fn of sdk.listeners.get('head') || []) { try { fn({ index: 0 }); } catch { /* the adapter's own step */ } }
        const afterHead = sdk.queries;
        api.dossierViewToken();
        out.queriesAfterHead = sdk.queries - afterHead;
        console.log('RESULT ' + JSON.stringify(out));
    });
    const out = JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.equal(out.hosted, true);
    assert.equal(out.queriesWhileStill, 0, 'no host query while the revision holds still');
    assert.equal(out.stable, true);
    assert.ok(out.queriesAfterHead > 0, "a host head event makes the next token read the host again");
});

test('generationActive: true from a (non-quiet, non-dry-run) generation start to its end or stop, also without streaming', () => {
    const output = runHostScenario('dossier-generation-active', async () => {
        Object.assign(mockState.context.eventTypes, { GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped' });
    }, async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(300);
        const emit = async (name, ...args) => { await Promise.all((mockState.listeners.get(name) || []).map(fn => fn(...args))); };
        const out = { idle: api.generationActive() };
        await emit('generation_started', 'quiet', {}, false);
        out.quiet = api.generationActive();
        await emit('generation_started', 'normal', {}, true);
        out.dryRun = api.generationActive();
        await emit('generation_started', 'normal', {}, false);
        out.started = api.generationActive();
        await emit('generation_ended', 3);
        out.ended = api.generationActive();
        await emit('generation_started', 'swipe', {}, false);
        await emit('generation_stopped');
        out.stopped = api.generationActive();
        console.log('RESULT ' + JSON.stringify(out));
    });
    const out = JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    assert.deepEqual(out, { idle: false, quiet: false, dryRun: false, started: true, ended: false, stopped: false });
});

test('refresh asks do not wait forever on a generation that never ends: after the bound the check runs', async () => {
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
    globalThis.document = { getElementById: () => null };
    try {
        let tokenReads = 0;
        const api = {
            dossierViewStatus: () => ({ chatKey: 'chat-1', hydrationStatus: 'ready' }),
            dossierViewToken: () => { tokenReads += 1; return `t${tokenReads}`; },
            generationActive: () => true,   // an aborted stream left it set
            getDossierState: () => ({ npcs: [{ id: 'a', name: 'Aster' }] }),
        };
        const ui = new DeltaDossierUi(api);
        let draws = 0;
        ui.root = { querySelector: () => null };
        ui.renderFromProjection = () => { draws += 1; };
        ui.panelOpen = true;
        ui.scheduleRefresh();
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.deepEqual([tokenReads, draws], [0, 0], 'held back while the generation counts');
        ui.generationDeferSince = Date.now() - 400000;   // as if it had been held back past the bound
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(draws, 1, 'the bound ended the wait: one check and draw');
        clearTimeout(ui.refreshTimer);
    } finally {
        globalThis.document = saved.document;
        globalThis.MutationObserver = saved.MutationObserver;
    }
});

test('page-API change notifications coalesce: the first runs at once, a burst becomes one trailing call, none while a reply is being made, flush runs a waiting one', async () => {
    let generating = false;
    const { watchers, notifyChange, flush } = createWatchers({ warn: () => {}, delta: () => ({ generationActive: () => generating }) });
    let calls = 0;
    watchers.add(() => { calls += 1; });
    notifyChange();
    assert.equal(calls, 1, 'the first one runs at once');
    for (let i = 0; i < 50; i += 1) notifyChange();
    assert.equal(calls, 1, 'the burst waits');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(calls, 2, 'the burst became one trailing call');
    generating = true;
    for (let i = 0; i < 50; i += 1) notifyChange();
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(calls, 2, 'nothing runs while a reply is being made');
    generating = false;
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(calls, 3, 'one call after it ended');
    notifyChange();   // inside the quiet gap of the last run: waits
    flush();
    assert.equal(calls, 4, 'flush ran the waiting call and left nothing scheduled');
    flush();
    assert.equal(calls, 4);
});

test('inline cards: the chat observer asks for no render while a reply is being made (its text grows by child-list changes); a mutation after it does', async () => {
    const saved = globalThis.MutationObserver;
    let callback = null;
    globalThis.MutationObserver = class { constructor(fn) { callback = fn; } observe() {} disconnect() {} };
    const savedDocument = globalThis.document;
    globalThis.document = { dispatchEvent() {}, querySelectorAll: () => [] };
    let renders = 0;
    let generating = false;
    const chat = { querySelectorAll: () => [] };
    try {
        const rt = {};
        const part = createInlineCardsMountPart(rt, { chatHydrationStatus: () => 'ready', getChatKey: () => 'chat-1', getChatState: () => ({}), generationActive: () => generating }, {
            chatElementForInlineObserver: () => chat, messageElement: () => null, inlineRosterHtml: () => '', inChatCastMode: () => 'on',
            inlineEntriesForRender: () => { renders += 1; return []; }, meguminIntegrationMessageId: () => null, meguminBlockCardForMessage: () => null,
            cleanupStaleMeguminIntegrations: () => {}, inlineAnchorMessageId: () => null, mountNpcStateInsideMeguminBlock: () => false,
        });
        part.ensureInlineObserver();
        const mutation = [{ type: 'childList', target: { closest: () => null } }];
        generating = true;
        for (let i = 0; i < 100; i += 1) callback(mutation);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(renders, 0, 'no render per streamed token');
        generating = false;
        callback(mutation);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(renders, 1, 'one render once the generation is over');
    } finally {
        globalThis.MutationObserver = saved;
        globalThis.document = savedDocument;
    }
});
