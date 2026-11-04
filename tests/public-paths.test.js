import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './vendor/story-block/src/v2/registry.js';
import { createStore } from './vendor/story-block/src/v2/store.js';
import { createCommandBus } from './vendor/story-block/src/v2/commands.js';
import { CAPTURE_PREFIX } from './vendor/story-block/src/v2/registry.js';
import { parseChanges } from './vendor/story-block/src/v2/capture.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { PUBLIC_PATHS_OWNER, PUBLIC_PATHS_PREFIX, createPublicPathsDefinition } from '../src/public-paths.js';
import { secretId } from '../src/npc-meters.js';

// NPC State Delta's public paths (src/public-paths.js; Story Block 2.22.0 sdk.registerPublicPaths), against Story Block's real registry,
// store and change-line parser (tests/vendor/story-block) with a small sdk that keeps the registration. The host's own side (api.get,
// paths(), {{sb::…}}, story:changed) is tested in Story Block (tests/v2/public-paths.test.js); here is what Delta offers it.

const SECRET = 'She is the lost heir of House Venn.';
const SECRET_TWO = 'She keeps a second ledger under the anvil.';

function dossiers() {
    return {
        npc_mira: {
            id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], present: true, archived: false,
            relationship: { trust: 10, affection: 0, desire: 0, tension: 0 },
            secrets: [
                { id: secretId('trust', 30, SECRET), meter: 'trust', at: 30, text: SECRET },
                { id: secretId('tension', -20, SECRET_TWO), meter: 'tension', at: -20, text: SECRET_TWO },
            ],
        },
        npc_oren: { id: 'npc_oren', name: 'Oren', aliases: [], present: false, archived: false, relationship: { trust: -5, affection: 2, desire: 0, tension: 1 } },
    };
}

function fakeDelta() {
    const delta = {
        enabled: true,
        baseline: { trust: 0, affection: 0, desire: 0, tension: 0 },
        records: dossiers(),
    };
    delta.suiteApi = { npcs: () => Object.values(delta.records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) };
    delta.api = {
        isEnabled: () => delta.enabled,
        getNpc: id => (delta.records[id] ? structuredClone(delta.records[id]) : null),
        relationshipBaseline: () => ({ ...delta.baseline }),
        presentCastHtml: () => '<section class="npc-state-delta-present-roster">cast</section>',
        castEmptyReason: () => ({ text: 'Nobody here.' }),
        fillPresentCast: () => {},
        formPortraits: () => ({}),
    };
    return delta;
}

const listeners = new Map();
const fakeDoc = () => ({
    documentElement: { dataset: {} },
    getElementById: () => null,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    dispatchEvent() { return true; },
});
const fire = type => { for (const fn of listeners.get(type) ?? []) fn({ type }); };

const timers = {
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
};

/** A Story Block host over a chat: real registry, store and bus; the adapter registered on it. */
async function host({ settings = {}, delta = fakeDelta(), headReply = () => null, publicPaths = 'with' } = {}) {
    listeners.clear();
    const registered = [];
    let changedCalls = 0;
    const chat = [{ is_user: false, name: 'Narrator', mes: 'The forge is warm.', swipe_id: 0, swipes: ['The forge is warm.'], swipe_info: [{ extra: {} }], extra: {} }];
    chat[0].swipe_info[0].extra = chat[0].extra;
    const registry = createRegistry();
    const store = createStore({ chat: () => chat, save: async () => {} });
    const moduleSettings = { [MODULE_ID]: structuredClone(settings) };
    const settingsOf = id => ({ ...(registry.module(id)?.settings?.defaults ?? {}), ...structuredClone(moduleSettings[id] ?? {}) });
    const bus = createCommandBus({ store, registry, settings: settingsOf });
    const runQuery = (name, args, state = store.head()) => {
        const fn = registry.query(name);
        if (!fn) throw new Error(`no query ${name}`);
        const tools = { query: (other, more) => runQuery(other, more, state), receipts: () => [] };
        return structuredClone(fn(state, args === undefined ? undefined : structuredClone(args), tools));
    };
    const sent = [];
    const sdk = {
        apiVersion: 2,
        registerModule(def) {
            registry.register(def);
            store.ensureInitial(registry.initialState());
        },
        command: async (type, payload, options = {}) => {
            sent.push({ type, payload: structuredClone(payload), options });
            return bus.command(type, payload, { cause: 'ui' });
        },
        query: (name, args) => runQuery(name, args),
        settings: id => settingsOf(id),
        ...(publicPaths === 'with' ? { registerPublicPaths: def => { registered.push(def); const off = () => { registered.splice(registered.indexOf(def), 1); }; off.changed = () => { changedCalls += 1; }; return off; } } : {}),
        ...(publicPaths === 'refusing' ? { registerPublicPaths: () => { throw new Error('prefix taken'); } } : {}),
    };
    const box = { host: { ready: Promise.resolve(sdk), sdk } };
    const warnings = [];
    const adapter = createStorySuiteV2Adapter({
        suiteApi: delta.suiteApi, delta: () => delta.api, version: 'test', host: () => box.host, headReply,
        doc: fakeDoc(), timers, logger: { warn: (...args) => warnings.push(args) }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true, 'the adapter registers with the host');
    const def = registry.module(MODULE_ID);
    const problems = [];

    /** A reply: user message, the reply, then its <Changes> lines captured as story commands (SPEC §4.2). */
    function capture(index, block) {
        const parsed = parseChanges(block);
        const out = [];
        for (const line of parsed.lines) {
            const entry = registry.capture(line.kind);
            if (!entry) { problems.push({ line: line.raw, code: 'UNKNOWN_KIND' }); continue; }
            const result = bus.run(`${CAPTURE_PREFIX}${entry.kind}`, { ...line, kind: entry.kind, word: line.kind }, {
                // The reply's record ID too, as Story Block's turn.js gives it (ctx.carrier.sid).
                cause: 'story', capture: entry, carrier: { index, swipe: chat[index].swipe_id ?? 0, sid: store.carrierSid(index) },
            });
            if (result.ok) store.append({ ops: result.ops, receipt: result.receipt });
            else problems.push({ line: line.raw, code: result.code, message: result.message });
            out.push(result);
        }
        return out;
    }
    function reply(text, block = '') {
        chat.push({ is_user: true, name: 'Ari', mes: 'And then?', extra: {} });
        const message = { is_user: false, name: 'Narrator', mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} };
        message.swipe_info[0].extra = message.extra;
        chat.push(message);
        const index = chat.length - 1;
        return { index, results: capture(index, block) };
    }
    /** A new swipe of reply `index` (SillyTavern gives it its own extra), captured with `block`. */
    function swipe(index, block = '') {
        const message = chat[index];
        const next = message.swipe_info.length;
        message.swipe_info.push({ extra: {} });
        message.swipes.push(`swipe ${next}`);
        message.swipe_id = next;
        message.extra = message.swipe_info[next].extra;
        store.rebuild();
        return capture(index, block);
    }
    /** Back to an earlier swipe of reply `index`. */
    function swipeTo(index, at) {
        const message = chat[index];
        message.swipe_id = at;
        message.extra = message.swipe_info[at].extra;
        store.rebuild();
    }
    function remove(index) {
        chat.splice(index, 1);
        store.rebuild();
    }
    const npc = name => runQuery('npc.meters', { name });
    const view = () => ({ state: store.head(), query: runQuery, settings: settingsOf, chat: { length: chat.length, lastUser: '' } });
    const setSettings = next => { moduleSettings[MODULE_ID] = structuredClone(next); };
    return { registered, changedCalls: () => changedCalls, chat, registry, store, bus, sdk, sent, box, adapter, def, delta, warnings, problems, capture, reply, swipe, swipeTo, remove, npc, view, runQuery, setSettings };
}


const live = h => h.registered[0];

test('the definition: owner, prefix npc, and the four functions', async () => {
    const h = await host();
    assert.equal(h.registered.length, 1);
    assert.equal(live(h).owner, 'npc-state-delta');
    assert.equal(live(h).owner, PUBLIC_PATHS_OWNER);
    assert.equal(live(h).prefix, 'npc');
    assert.equal(PUBLIC_PATHS_PREFIX, 'npc');
    for (const name of ['paths', 'get', 'hidden', 'values']) assert.equal(typeof live(h)[name], 'function', name);
});

test('get: every tracked NPC\'s shown meters by id, as numbers, from the head state', async () => {
    const h = await host();
    h.reply('Mira laughs.', '~ npc Mira | trust: +5 | affection: =12');
    const d = live(h);
    assert.equal(d.get('npc.Mira.trust'), 15);
    assert.equal(d.get('npc.Mira.affection'), 12);
    assert.equal(d.get('npc.Mira.desire'), 0);
    assert.equal(d.get('npc.Mira.tension'), 0);
    assert.equal(d.get('npc.Oren.trust'), -5, 'a person who has an entry from the dossier alone');
    assert.equal(d.get('npc.Nobody.trust'), undefined);
    assert.equal(d.get('npc.Mira.nonsense'), undefined);
    assert.equal(d.get('scene.place'), undefined);
    assert.equal(d.get(42), undefined);
});

test('get follows a meter change: the next read has the new value', async () => {
    const h = await host();
    h.reply('Mira laughs.', '~ npc Mira | trust: +5');
    assert.equal(live(h).get('npc.Mira.trust'), 15);
    h.reply('Mira beams.', '~ npc Mira | trust: +7');
    assert.equal(live(h).get('npc.Mira.trust'), 22);
});

test('names are matched whole and folded, never split at dots: a name with dots reads by its last segment', async () => {
    const delta = fakeDelta();
    delta.records.npc_fox = { id: 'npc_fox', name: 'Mr. Fox Jr.', aliases: [], present: false, archived: false, relationship: { trust: 3, affection: 0, desire: 0, tension: 0 } };
    const h = await host({ delta });
    h.reply('Mr. Fox Jr. bows.', '~ npc Mr. Fox Jr. | trust: +1');
    const d = live(h);
    assert.equal(d.get('npc.Mr. Fox Jr..trust'), 4);
    assert.equal(d.get('NPC.mr.  fox jr..TRUST'), 4, 'case and spaces are folded as Story Block folds them');
    assert.ok(d.paths().includes('npc.Mr. Fox Jr..trust'));
    assert.equal(d.get('npc.Mr.trust'), undefined, 'a prefix of the name is not the person');
});

test('paths: meters of every tracked NPC plus mood and present, no hidden meter, no notes; values() matches paths()', async () => {
    const h = await host({ settings: { customMeters: [{ name: 'Lust', min: 0, max: 100, start: 0, show: 'bar' }, { name: 'Secretive', min: 0, max: 100, start: 40, show: 'hidden' }] } });
    h.delta.records.npc_mira.mood = 'wary';
    h.reply('Mira nods.', '~ npc Mira | trust: +1');
    const d = live(h);
    const paths = d.paths();
    for (const path of ['npc.Mira.trust', 'npc.Mira.affection', 'npc.Mira.desire', 'npc.Mira.tension', 'npc.Mira.lust', 'npc.Mira.mood', 'npc.Mira.present', 'npc.Oren.trust', 'npc.Oren.present']) assert.ok(paths.includes(path), path);
    assert.ok(!paths.some(path => /secretive/i.test(path)), 'a hidden meter is not listed');
    assert.ok(!paths.includes('npc.Oren.mood'), 'no mood, no path');
    assert.ok(!paths.some(path => /secret(?!ive)|unlocked|note|stage/i.test(path)), 'no note, no stage in the paths');
    assert.deepEqual(Object.keys(d.values()).sort(), [...paths].sort());
    assert.equal(d.get('npc.Mira.mood'), 'wary');
    assert.equal(d.get('npc.Mira.present'), true);
    assert.equal(d.get('npc.Oren.present'), false);
});

test('a hidden meter reads undefined, is reported hidden, and is never in values()', async () => {
    const h = await host({ settings: { customMeters: [{ name: 'Secretive', min: 0, max: 100, start: 40, show: 'hidden' }] } });
    h.reply('Mira nods.', '~ npc Mira | secretive: +5');
    const d = live(h);
    assert.equal(h.npc('Mira').meters.secretive, 45, 'the meter exists in the slice');
    assert.equal(d.get('npc.Mira.secretive'), undefined);
    assert.equal(d.hidden('npc.Mira.secretive'), true);
    assert.equal(d.hidden('NPC.mira.Secretive'), true);
    assert.equal(d.hidden('npc.Mira.trust'), false);
    assert.equal(d.hidden('npc.Mira.nonsense'), false);
    assert.ok(!Object.keys(d.values()).some(path => /secretive/i.test(path)));
    assert.ok(!JSON.stringify(d.values()).includes('45'));
});

test('hidden notes are never returned: no path carries a note\'s text, title or id', async () => {
    const h = await host();
    h.reply('Mira nods.', '~ npc Mira | trust: +25');
    const everything = JSON.stringify({ values: live(h).values(), paths: live(h).paths() });
    assert.ok(!everything.includes('Venn') && !everything.includes(secretId('trust', 30, SECRET)));
});

test('an archived person has no paths', async () => {
    const h = await host();
    h.reply('Oren nods.', '~ npc Oren | trust: +1');
    assert.equal(live(h).get('npc.Oren.trust'), -4);
    h.delta.records.npc_oren.archived = true;
    assert.equal(live(h).get('npc.Oren.trust'), undefined);
    assert.ok(!live(h).paths().some(path => path.startsWith('npc.Oren.')));
});

test('Delta off: no paths', async () => {
    const h = await host();
    h.reply('Mira nods.', '~ npc Mira | trust: +1');
    h.delta.enabled = false;
    assert.deepEqual(live(h).paths(), []);
    assert.equal(live(h).get('npc.Mira.trust'), undefined);
});

test('the host is told when a scan finished late (the Cast was redrawn): changed() is called', async () => {
    const h = await host();
    const before = h.changedCalls();
    fire('npc-state-delta:cast-rendered');
    assert.equal(h.changedCalls(), before + 1);
    fire('npc-state-delta:enabled-changed');
    assert.equal(h.changedCalls(), before + 2);
});

test('unregistered when the host goes away', async () => {
    const h = await host();
    assert.equal(h.registered.length, 1);
    h.adapter.stop();
    assert.equal(h.registered.length, 0, 'unregistered on unload');
});

test('an older Story Block (no registerPublicPaths): Delta is hosted as before and registers nothing', async () => {
    const h = await host({ publicPaths: 'without' });
    assert.equal(h.adapter.hosted(), true);
    assert.deepEqual(h.registered, []);
    h.reply('Mira nods.', '~ npc Mira | trust: +1');
    assert.equal(h.npc('Mira').meters.trust, 11, 'meters work as before');
    fire('npc-state-delta:cast-rendered');
    assert.equal(h.changedCalls(), 0);
});

test('a refusal by the host is logged and Delta is still hosted', async () => {
    const h = await host({ publicPaths: 'refusing' });
    assert.equal(h.adapter.hosted(), true);
    assert.ok(h.warnings.some(args => /public paths were not registered/.test(String(args[0]))));
    fire('npc-state-delta:cast-rendered');
});

test('createPublicPathsDefinition on its own: duplicate names, non-finite values and a throwing source', () => {
    const d = createPublicPathsDefinition({ people: () => [
        { name: 'Ann', meters: { trust: 5, bad: NaN, text: 'x' } },
        { name: ' ann ', meters: { trust: 99 } },
        { name: '', meters: { trust: 1 } },
        { name: 'Bo', meters: { mood: 7 }, hiddenMeters: ['affection'], mood: 'calm', present: true },
    ] });
    assert.deepEqual(d.paths().sort(), ['npc.Ann.trust', 'npc.Bo.mood', 'npc.Bo.present']);
    assert.equal(d.get('npc.Bo.mood'), 7, 'a meter called mood wins over the mood');
    assert.equal(d.get('npc.Ann.trust'), 5, 'the first of two names that fold alike');
    assert.equal(d.hidden('npc.Bo.affection'), true);
    const broken = createPublicPathsDefinition({ people: () => { throw new Error('no'); } });
    assert.deepEqual(broken.paths(), []);
    assert.equal(broken.get('npc.Ann.trust'), undefined);
    assert.deepEqual(broken.values(), {});
});
