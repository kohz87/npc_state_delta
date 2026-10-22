// (v2 World view) The scanner knows who the story's scene lists as present now: Story Director's
// `director.world.here` (its `present`) when it answers, else Story Block's `scene.present`. The scan's
// prompt then names them in one dynamic line, sends their dossiers' live context (after the mentioned
// ones, within the same limit) and their `present` as the scene's, so someone absent is not marked
// present from Delta's last scan. No list (Delta alone, Story Block keeping no scene, a scan of an older
// reply): the prompt is byte-identical to before; the static rules never change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScannerPrompt, createNpcRecord } from '../core.js';
import { scenePresentFocus, withScenePresent } from '../core-mechanics.js';
import { createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { createHost } from './vendor/story-block/testkit/index.js';

function npc(name, extra = {}) {
    return { ...createNpcRecord(name, []), ...extra };
}

const MIRA = npc('Mira', { id: 'npc_mira', present: false, lastSeenTurn: 2, role: 'Smith' });
const BRECHT = npc('Brecht', { id: 'npc_brecht', present: true, lastSeenTurn: 5, role: 'Thug' });
const OLD = npc('Kael', { id: 'npc_kael', archived: true, present: false });
const base = extra => ({
    transcript: 'User: I ask Brecht about the debt.\nNarrator: Brecht shrugs.',
    existingNpcs: [MIRA, BRECHT, OLD], candidates: [], userName: 'Astra', charName: 'Narrator', ...extra,
});
const live = prompt => JSON.parse(prompt.split('Relevant live context (dynamic fields only):\n')[1].split('\n')[0]);
const rules = prompt => prompt.split('Identity index (matching only):')[0];

test('no scene list: the scanner prompt is exactly as before (null, empty, or names no one)', () => {
    const before = buildScannerPrompt(base());
    assert.equal(buildScannerPrompt(base({ sceneNames: null })), before);
    assert.equal(buildScannerPrompt(base({ sceneNames: [] })), before);
    assert.equal(buildScannerPrompt(base({ sceneNames: ['  ', ''] })), before);
    assert.doesNotMatch(before, /In the scene now/);
});

test('a scene list: one dynamic line, the present dossiers in the live context with the scene\'s presence; the rules unchanged', () => {
    const before = buildScannerPrompt(base());
    const prompt = buildScannerPrompt(base({ sceneNames: ['Mira', 'A Stranger', 'mira'] }));
    assert.equal(rules(prompt), rules(before), 'the static rules are byte-identical');
    assert.match(prompt, /\nIn the scene now \(the story's scene list\): Mira, A Stranger\.\n/);
    const context = live(prompt);
    // Brecht is mentioned (first, as before); Mira is not mentioned but present, so she joins the context.
    assert.deepEqual(context.map(entry => [entry.name, entry.present]), [['Brecht', false], ['Mira', true]]);
    // Before: Mira was not in the context and Brecht carried Delta's stale present=true.
    assert.deepEqual(live(before).map(entry => [entry.name, entry.present]), [['Brecht', true]]);
    // The line goes after the identity index (the dynamic part), before the live context.
    assert.ok(prompt.indexOf('In the scene now') > prompt.indexOf('Identity index (matching only):'));
    assert.ok(prompt.indexOf('In the scene now') < prompt.indexOf('Relevant live context'));
});

test('the scene list: names cleaned and capped; archived dossiers never join; the context limit holds', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Person ${i}\n`);
    const focus = scenePresentFocus([MIRA, OLD], ['Kael', 'Mira', ...many]);
    assert.equal(focus.names.length, 12);
    assert.equal(focus.names[2], 'Person 0');
    assert.deepEqual(focus.npcs.map(entry => entry.id), ['npc_mira'], 'Kael is archived');
    const crowd = Array.from({ length: 6 }, (_, i) => npc(`Guard ${i}`, { id: `npc_g${i}` }));
    assert.equal(withScenePresent([BRECHT], crowd, 4).length, 4);
    assert.deepEqual(withScenePresent([BRECHT], [BRECHT, MIRA], 4).map(entry => entry.id), ['npc_brecht', 'npc_mira']);
    assert.equal(scenePresentFocus([MIRA], null), null);
});

// ---- the adapter: Story Director's World view, else Story Block's scene ----

function fakeDoc() {
    const node = () => ({ style: {}, dataset: {}, children: [], append() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
    return { createElement: node, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: node(), head: node() };
}

async function hostedAdapter(answers) {
    const sdk = {
        registered: [],
        registerModule(def) { sdk.registered.push(def); },
        query(name) {
            if (!Object.hasOwn(answers, name)) throw new Error(`no module answers ${name}`);
            return typeof answers[name] === 'function' ? answers[name]() : answers[name];
        },
    };
    const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
    const sb = { ready: Promise.resolve(sdk) };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [] }, delta: () => ({ isEnabled: () => true }), version: 'test',
        host: () => sb, doc: fakeDoc(), timers, logger: { warn() {} },
    });
    adapter.start();
    await adapter.settled();
    return adapter;
}

test('presentNow: Story Director\'s World view first, else Story Block\'s scene; nothing without a host', async () => {
    const both = await hostedAdapter({ 'director.world.here': { present: ['Mira', ' Brecht '] }, 'scene.present': ['Someone else'] });
    assert.equal(both.hosted(), true);
    assert.deepEqual(both.presentNow(), ['Mira', 'Brecht']);
    const sbOnly = await hostedAdapter({ 'scene.present': ['Wynn'] });
    assert.deepEqual(sbOnly.presentNow(), ['Wynn'], 'Story Block only (no Story Director)');
    const off = await hostedAdapter({ 'director.world.here': null, 'scene.present': ['Wynn'] });
    assert.deepEqual(off.presentNow(), ['Wynn'], 'the World view turned off answers null');
    const none = await hostedAdapter({});
    assert.equal(none.presentNow(), null);
    const alone = createStorySuiteV2Adapter({ suiteApi: { npcs: () => [] }, delta: () => ({}), host: () => undefined, doc: fakeDoc(), timers: { setTimeout: () => 0, clearTimeout() {} }, logger: { warn() {} } });
    assert.equal(alone.presentNow(), null, 'Delta alone');
});

test('index.js: the scan passes the scene list only for the head reply while Story Block keeps the scene', () => {
    const index = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
    assert.match(index, /buildScannerPrompt\(scannerPromptOptions\(state, settings, transcript, \{ currentTranscript, fullScanMode: fullWindowScan, sceneNames: scanScenePresent\(messageId\) \}\)\)/);
    const fn = index.slice(index.indexOf('function scanScenePresent'), index.indexOf('// The chat state a scan works from'));
    assert.match(fn, /storySuiteV2Meters\(\)/);
    assert.match(fn, /defersArea\('scene', getSettings\(\)\.sourceOfTruth\)/);
    assert.match(fn, /messageId !== latestMessageId\(true\)/);
    assert.match(fn, /adapter\.presentNow/);
});

// ---- on Story Block's whole host (tests/vendor/story-block), with and without Story Director ----


async function onHost({ modules = [] } = {}) {
    const host = await createHost({ modules });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [] }, delta: () => ({ isEnabled: () => true, getNpc: () => null, relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }) }),
        version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true);
    const say = async (lines, text = 'The story goes on.') => {
        await host.send('And then?', `${text}\n\n<Changes>\n${lines.join('\n')}\n</Changes>`);
        await adapter.ticked();
    };
    return { host, adapter, say };
}

// Story Director's World view as a stand-in: who is here, from the same scene.
const fakeDirector = () => ({
    id: 'story-director', name: 'Story Director (stand-in)', version: '0.0.0-test', domains: {}, commands: {},
    queries: { 'director.world.here': state => ({ place: null, present: [...(state?.domains?.scene?.present ?? [])].reverse(), people: [], nsd: true }) },
});

test('Story Block only: the scene\'s present list, following swipes', async () => {
    const { host, adapter, say } = await onHost();
    await say(['+ present Mira, Brecht']);
    assert.deepEqual(adapter.presentNow(), ['Mira', 'Brecht']);
    await host.swipe('Another way.\n\n<Changes>\n+ present Wynn\n</Changes>');
    assert.deepEqual(adapter.presentNow(), ['Wynn']);
    const prompt = buildScannerPrompt(base({ sceneNames: adapter.presentNow() }));
    assert.match(prompt, /In the scene now \(the story's scene list\): Wynn\./);
    host.close();
});

test('with Story Director: its World view answers who is here', async () => {
    const { host, adapter, say } = await onHost({ modules: [fakeDirector()] });
    await say(['+ present Mira, Brecht']);
    assert.deepEqual(adapter.presentNow(), ['Brecht', 'Mira'], 'director.world.here, not scene.present');
    host.close();
});
