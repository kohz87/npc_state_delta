import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectStoryBlock, dossierTabRowsHtml, emptyCastHtml, STORY_BLOCK_TAB_IDS } from '../story-block-tabs.js';

// Story Block integration: Present NPCs and Dossiers tabs registered through Story Block's public
// registerTab API. Unit tests drive the adapter with fakes; the host scenario runs the real
// runtime with a fake Story Block to check the in-chat cast and the Megumin-compatible card.

function fakePane() {
    const listeners = {};
    const input = { value: '', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
    const list = { innerHTML: '', writes: 0 };
    let html = '';
    const pane = {
        writes: 0,
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; pane.writes += 1; },
        querySelector(selector) {
            if (!html.includes('npc-state-delta-story-dossiers')) return null;
            if (selector === '.npc-state-delta-story-search') return input;
            if (selector === '.npc-state-delta-story-list') return new Proxy(list, { set(target, key, value) { if (key === 'innerHTML') target.writes += 1; target[key] = value; return true; } });
            return null;
        },
        addEventListener(name, fn) { listeners[name] = fn; },
        listeners, input, list,
    };
    return pane;
}

function fakeRuntime(npcs) {
    const runtime = {
        revision: 1, dossierReads: 0, opened: [], cast: '<section class="npc-state-delta-present-roster">Mira</section>',
        presentCastHtml: () => runtime.cast,
        dossierRevision: () => `chat|${runtime.revision}`,
        getDossierState: () => { runtime.dossierReads += 1; return { npcs: structuredClone(npcs), portraitAssets: {} }; },
        openDossier: id => runtime.opened.push(id),
    };
    return runtime;
}

const cast = [
    { id: 'npc_mira', name: 'Mira Vale', role: 'innkeeper', present: true },
    { id: 'npc_odo', name: 'Odo', role: 'listener', archived: true, archiveReason: 'stale' },
    { id: 'npc_brenn', name: 'Old Brenn', role: "ship's mate", archived: true, archiveReason: 'deceased', lifeState: 'deceased' },
];

test('v1.1.11 the adapter registers Present NPCs and Dossiers tabs and nothing without Story Block', () => {
    const tabs = [];
    const runtime = fakeRuntime(cast);
    let refreshes = 0;
    const connection = connectStoryBlock(runtime, { registerTab: tab => tabs.push(tab), refresh: () => { refreshes += 1; } });
    // (1.2.15) 🎭, not 👥: RPG Battle's Party tab has 👥, and the tab row may show icons only.
    assert.deepEqual(tabs.map(tab => [tab.id, tab.label, tab.short, tab.icon]), [
        [STORY_BLOCK_TAB_IDS.cast, 'Present NPCs', 'Present', '🎭'],
        [STORY_BLOCK_TAB_IDS.dossiers, 'Dossiers', 'Dossiers', '📇'],
    ]);
    assert.ok(tabs.every(tab => typeof tab.render === 'function' && tab.order >= 200), 'after Story Block\'s own blocks');
    assert.equal(connectStoryBlock(runtime, null), null, 'no Story Block, no tabs');
    assert.equal(connectStoryBlock(runtime, {}), null, 'a Story Block without the tab API is left alone');

    assert.equal(connection.refresh(), true, 'the first redraw refreshes Story Block');
    assert.equal(connection.refresh(), false, 'an unchanged dossier state does not');
    runtime.revision += 1;
    assert.equal(connection.refresh(), true, 'a changed dossier state does');
    assert.equal(refreshes, 2);
});

test('v1.1.11 the Present NPCs tab shows the live cast and rewrites only on change', () => {
    const tabs = [];
    const runtime = fakeRuntime(cast);
    connectStoryBlock(runtime, { registerTab: tab => tabs.push(tab) });
    const pane = fakePane();
    tabs[0].render(pane, { messageId: 4 });
    assert.equal(pane.innerHTML, `<div class="npc-state-delta-story-pane">${runtime.cast}</div>`, 'wrapped in a padded pane: Story Block adds none');
    tabs[0].render(pane, { messageId: 4 });
    assert.equal(pane.writes, 1, 'an unchanged cast is not rewritten on Story Block refreshes');
    runtime.cast = '';
    tabs[0].render(pane, { messageId: 5 });
    assert.match(pane.innerHTML, /No NPC is present/);
});

test('v1.1.11 the Dossiers tab searches, keeps its box across refreshes, hides the dead until searched and opens dossiers', () => {
    const tabs = [];
    const runtime = fakeRuntime(cast);
    connectStoryBlock(runtime, { registerTab: tab => tabs.push(tab) });
    const pane = fakePane();
    tabs[1].render(pane, {});
    assert.equal(pane.writes, 1, 'the search box and list are built once');
    assert.match(pane.list.innerHTML, /Mira Vale/);
    assert.match(pane.list.innerHTML, /innkeeper · In chat/);
    assert.match(pane.list.innerHTML, /Odo/, 'a stale archive is listed');
    assert.doesNotMatch(pane.list.innerHTML, /Old Brenn/, 'the dead stay out of the list');

    for (let i = 0; i < 3; i += 1) tabs[1].render(pane, {});
    assert.equal(pane.writes, 1, 'refreshes never rebuild the search box, so it keeps focus and text');
    assert.equal(pane.list.writes, 1, 'nor the unchanged list');
    assert.equal(runtime.dossierReads, 1, 'the dossier state is read again only when it changed');

    pane.input.value = 'brenn';
    pane.input.listeners.input();
    assert.match(pane.list.innerHTML, /Old Brenn/, 'a search finds the dead');
    assert.doesNotMatch(pane.list.innerHTML, /Mira Vale/);
    tabs[1].render(pane, {});
    assert.match(pane.list.innerHTML, /Old Brenn/, 'the query survives a refresh');

    runtime.revision += 1;
    tabs[1].render(pane, {});
    assert.equal(runtime.dossierReads, 2, 'a new dossier state is read once');

    pane.listeners.click({ target: { closest: selector => selector === '.npc-state-delta-story-row' ? { dataset: { npcId: 'npc_brenn' } } : null } });
    assert.deepEqual(runtime.opened, ['npc_brenn'], 'tapping a row opens its dossier');
    pane.listeners.click({ target: { closest: () => null } });
    assert.deepEqual(runtime.opened, ['npc_brenn'], 'a tap outside a row opens nothing');
});

test('v1.1.11 dossier rows escape names and fall back to an initial without a portrait', () => {
    const html = dossierTabRowsHtml([{ id: 'x"1', name: '<Ilsa>', role: 'a & b', statusLabel: 'Off-screen', portrait: '' }]);
    assert.match(html, /data-npc-id="x&quot;1"/);
    assert.match(html, /&lt;Ilsa&gt;/);
    assert.match(html, /a &amp; b · Off-screen/);
    assert.match(html, /<span>&lt;<\/span>/);
    assert.match(dossierTabRowsHtml([]), /No dossier matches/);
    // (1.2.13) With no dossier at all: say so, and offer Add NPC and Scan now; a search says what it searched.
    assert.match(dossierTabRowsHtml([], { total: 0 }), /No dossiers yet\.[\s\S]*data-npc-state-delta-action="add"[\s\S]*data-npc-state-delta-action="scan"/);
    assert.match(dossierTabRowsHtml([], { query: 'Ly<ra', total: 3 }), /No dossier matches “Ly&lt;ra”/);
});

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runHostScenario(name, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.documentElement = { dataset: {} };
// The dossier panel (dossier-ui.js, loaded by the adapter) waits for a load the mock never fires.
globalThis.document.readyState = 'loading';
mockState.storyBlockTabs = [];
mockState.storyBlockRefreshes = 0;
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await (${scenario.toString()})();
    console.log('story block scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

test('v1.1.11 with Story Block, Only in Story Block clears the chat cast and the Megumin-compatible card gets no second tab', () => {
    runHostScenario('in-chat-cast', async () => {
        const settings = mockState.extensionSettings.npc_state_delta;
        const api = globalThis.NPCStateDelta;
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves from the gate.', swipe_id: 0, swipes: ['Yunyun waves from the gate.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);
        assert.ok(api.getState().npcs.some(npc => npc.name === 'Yunyun' && npc.present), 'Yunyun is present');
        assert.match(api.presentCastHtml(), /npc-state-delta-present-card[\s\S]*Yunyun/, 'the tab cast uses the full present cards');
        const before = api.dossierRevision();
        assert.match(before, /\|\d+$/);

        // Without Story Block the new choice falls back to full cards in the chat.
        settings.presentCastDisplay = 'storyblock';
        api.renderInline();
        assert.ok(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), 'no Story Block: full cards stay in the chat');

        globalThis.StoryBlock = { registerTab: tab => mockState.storyBlockTabs.push(tab), refresh: () => { mockState.storyBlockRefreshes += 1; } };
        await import(pathToFileURL(path.join(extRoot, 'story-block-tabs.js')).href);
        await sleep(30);
        assert.deepEqual(mockState.storyBlockTabs.map(tab => tab.label), ['Present NPCs', 'Dossiers']);
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlock, '1');
        assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), false, 'Only in Story Block clears the chat once the tabs exist');
        assert.ok(mockState.storyBlockRefreshes >= 1, 'Story Block is asked to redraw');

        const pane = { innerHTML: '' };
        mockState.storyBlockTabs[0].render(pane, { messageId: id });
        assert.match(pane.innerHTML, /Yunyun/);

        // Until the player picks a choice, the default Full cards stays out of the chat while Story
        // Block carries the cast; an explicit Full (or Compact) keeps the in-chat cast.
        settings.presentCastDisplay = 'full';
        settings.presentCastDisplayChosen = false;
        api.renderInline();
        assert.equal(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), false, 'the unchosen default is not shown twice');
        settings.presentCastDisplay = 'compact';
        api.renderInline();
        assert.ok(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), 'Compact is always a deliberate choice');

        // Story Block's compatible card carries Megumin's classes; Delta must not add its Megumin tab too.
        settings.presentCastDisplay = 'full';
        settings.presentCastDisplayChosen = true;
        const compat = createMockMeguminBlock();
        compat.card.className = 'story-block-card meg-blocks';
        meguminBlocks.set(id, compat);
        api.renderInline();
        assert.equal(compat.card.querySelector('.npc-state-delta-megumin-tab'), null, 'no duplicate tab in Story Block\'s card');
        assert.ok(inlineAnchors.some(anchor => anchor.dataset.npcStateDeltaMessageId === String(id)), 'Full cards keep the in-chat cast');

        // A real Megumin Suite card still gets the integrated tab.
        compat.card.className = 'meg-blocks';
        api.renderInline();
        assert.ok(compat.card.querySelector('.npc-state-delta-megumin-tab'), 'Megumin Suite cards keep the integrated tab');
    });
});

test('v1.1.12 a choice made in settings is remembered; the Story Block pane is padded and keeps cards small', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(index, /presentCastDisplayChosen: false,/);
    assert.match(index, /getSettings\(\)\.presentCastDisplayChosen = true;/, 'picking any choice marks it deliberate');
    assert.match(index, /\$\('#npc_state_delta_present_cast_display'\)\.val\(effectivePresentCastChoice\(\)\)/, 'the menu shows the choice in effect');
    assert.match(css, /\.npc-state-delta-story-pane \{ padding: 8px 12px 12px;/);
    assert.match(css, /\.npc-state-delta-story-pane \.npc-state-delta-present-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(104px, 1fr\)\); \}/);
});

test('1.2.13 an empty Present NPCs tab says why, and offers Scan now when a scan could help', () => {
    const html = emptyCastHtml({ text: 'No NPC has a dossier in this chat yet <b>', scan: true });
    assert.match(html, /No NPC has a dossier in this chat yet &lt;b&gt;/);
    assert.match(html, /data-npc-state-delta-action="scan"/);
    assert.doesNotMatch(emptyCastHtml({ text: 'No chat is open.', scan: false }), /data-npc-state-delta-action/);
    assert.match(emptyCastHtml(), /No NPC is present in the latest scene\./);
});

test('v1.2.15 switched off, Delta takes its tabs out of Story Block at once; switched on, they come back', () => {
    const tabs = new Map();
    const runtime = { ...fakeRuntime(cast), isEnabled: () => enabled };
    let enabled = true;
    const storyBlock = { registerTab: tab => tabs.set(tab.id, tab), unregisterTab: id => tabs.delete(id), refresh() {} };
    const connection = connectStoryBlock(runtime, storyBlock);
    assert.deepEqual([...tabs.keys()], [STORY_BLOCK_TAB_IDS.cast, STORY_BLOCK_TAB_IDS.dossiers]);
    enabled = false;
    assert.equal(connection.syncTabs(), true);
    assert.equal(tabs.size, 0, 'no tabs while Delta is off');
    assert.equal(connection.syncTabs(), false, 'nothing to do twice');
    enabled = true;
    assert.equal(connection.syncTabs(), true);
    assert.deepEqual([...tabs.keys()], [STORY_BLOCK_TAB_IDS.cast, STORY_BLOCK_TAB_IDS.dossiers]);
    // Connected while off: no tabs until it is switched on.
    const later = new Map();
    enabled = false;
    connectStoryBlock(runtime, { registerTab: tab => later.set(tab.id, tab), unregisterTab: id => later.delete(id) });
    assert.equal(later.size, 0);
});
