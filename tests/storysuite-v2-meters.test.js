import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_PREFIX, createRegistry } from './vendor/story-block/src/v2/registry.js';
import { createStore } from './vendor/story-block/src/v2/store.js';
import { createCommandBus } from './vendor/story-block/src/v2/commands.js';
import { parseChanges } from './vendor/story-block/src/v2/capture.js';
import { MODULE_ID, createStorySuiteV2Adapter, meterBarNode } from '../src/storysuite-v2.js';
import {
    DEFAULT_CHANGE_CAP, MAX_CUSTOM_METERS, MAX_NPCS, meterDefs, normalizeMeterSettings, npcKey, parseMeterValue,
    secretId, secretsFromLines, secretsToLines, stageAt, validateNpcSlice,
} from '../src/npc-meters.js';
import { METERS_CARD_ID, metersCardScreen } from '../src/npc-meters-screen.js';
import { buildInjection, buildNarrationCapturePrompt, buildProfileRefreshPrompt, buildScannerPrompt } from '../core.js';
import { fakeRoot } from './helpers/fake-dom.js';
import { fakeDocument } from './helpers/fake-dom.js';

// NPC meters in v2's per-reply state (F81, F90), against Story Block's real registry, store, command
// bus and change-line parser (tests/vendor/story-block, see its VERSION). The adapter registers
// with a small sdk over them; Delta's runtime is a fake with a few dossiers.

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

const fakeDoc = () => ({
    documentElement: { dataset: {} },
    getElementById: () => null,
    addEventListener() {},
    dispatchEvent() { return true; },
});

const timers = {
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
};

/** A Story Block host over a chat: real registry, store and bus; the adapter registered on it. */
async function host({ settings = {}, delta = fakeDelta(), headReply = () => null } = {}) {
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
    return { chat, registry, store, bus, sdk, sent, box, adapter, def, delta, warnings, problems, capture, reply, swipe, swipeTo, remove, npc, view, runQuery, setSettings };
}

const STAGES = [
    { meter: 'trust', at: 20, name: 'Friend' },
    { meter: 'trust', at: 60, name: 'Confidant' },
    { meter: 'trust', at: -30, name: 'Wary' },
];

// ---- the definition ----

test('the real registry accepts the definition: npc domain, npc kind, commands, queries, the NPC card screen', async () => {
    const h = await host();
    assert.equal(h.registry.domainOwner('npc'), MODULE_ID);
    assert.equal(h.registry.captureOwner('npc'), MODULE_ID);
    for (const type of ['npc.adjust', 'npc.set', 'npc.refresh']) assert.equal(h.registry.commandOwner(type), MODULE_ID);
    assert.deepEqual(h.store.head().domains.npc, { npcs: {}, problems: [] });
    assert.equal(h.def.screens[0].id, METERS_CARD_ID);
    assert.deepEqual(metersCardScreen.mounts, ['card']);
    assert.match(metersCardScreen.template, /<ss-widget name="ss\.meter" data-props='\{"bind":"b"\}'><\/ss-widget>/, 'one ss.meter per bar');
    assert.match(metersCardScreen.template, /changed\(state\.npc\.npcs\[n\.key\]\)/);
});

// ---- capture ----

test('capture: relative and absolute values, clamped to the range and to the per-reply cap', async () => {
    const h = await host();
    h.reply('Mira laughs.', '<Changes>\n~ npc Mira | trust: +5 | affection: =12\n</Changes>');
    assert.deepEqual(h.npc('Mira').meters, { trust: 15, affection: 12, desire: 0, tension: 0 }, 'a known NPC starts from her dossier (trust 10)');
    h.reply('Mira beams.', '~ npc Mira | trust: +90');
    assert.equal(h.npc('Mira').meters.trust, 15 + DEFAULT_CHANGE_CAP, 'held at the per-reply cap');
    h.reply('Mira beams.', '~ npc Mira | trust: 100');
    assert.equal(h.npc('Mira').meters.trust, 30 + DEFAULT_CHANGE_CAP, 'an absolute value is capped too');
    for (let i = 0; i < 6; i += 1) h.reply('Again.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').meters.trust, 100, 'never above the range');
    for (let i = 0; i < 20; i += 1) h.reply('Down.', '~ npc Mira | trust: -15');
    assert.equal(h.npc('Mira').meters.trust, -100, 'never below it');
});

test('capture: two lines in one reply share the cap; the next reply starts a new window', async () => {
    const h = await host();
    const { index } = h.reply('Twice.', '~ npc Oren | tension: +10\n~ npc Oren | tension: +10');
    assert.equal(h.npc('Oren').meters.tension, 1 + DEFAULT_CHANGE_CAP);
    // Delta's scanner on the same reply is held by the same window.
    await h.adapter.adjust({ name: 'Oren', meters: { tension: 8 }, reply: index });
    assert.equal(h.npc('Oren').meters.tension, 1 + DEFAULT_CHANGE_CAP);
    h.reply('Once more.', '~ npc Oren | tension: +10');
    assert.equal(h.npc('Oren').meters.tension, 26);
});

test('capture: huge and malformed values are problems, not numbers', async () => {
    const h = await host();
    const block = ['~ npc Mira | trust: +99999', '~ npc Mira | trust: 1e9', '~ npc Mira | trust: Infinity', '~ npc Mira | trust: NaN', '~ npc Mira | trust: 1.5', '~ npc Mira | trust: lots'].join('\n');
    const { results } = h.reply('Wild.', block);
    assert.ok(results.every(result => result.ok === false && result.code === 'REFUSED'), 'each line names no usable change');
    assert.equal(h.npc('Mira'), null, 'nothing was saved');
    assert.equal(h.store.head().meta.rev, 0);
    assert.equal(h.problems.length, 6);
    for (const raw of ['+99999', '1e9', 'Infinity', 'NaN', '1.5', 'lots', '', '+', '=']) assert.equal(parseMeterValue(raw), null, raw);
    // A huge number sent by a command is refused as a meter value, and the range holds anyway.
    const out = await h.sdk.command('npc.adjust', { name: 'Mira', meters: { trust: 1e12 } });
    assert.equal(out.ok, false);
    await h.sdk.command('npc.set', { name: 'Mira', meters: { trust: 1999 } });
    assert.equal(h.npc('Mira').meters.trust, 100);
    await h.sdk.command('npc.set', { name: 'Mira', meters: { trust: -1999 } });
    assert.equal(h.npc('Mira').meters.trust, -100);
});

test('capture: unknown meters are problems on the slice and the receipt; known ones still apply; a stage label is ignored', async () => {
    const h = await host();
    const { results } = h.reply('Hm.', '~ npc Mira | trust: +2 | charm: +4 | stage: Lover | reason: she was helped');
    assert.equal(results[0].ok, true);
    assert.equal(h.npc('Mira').meters.trust, 12);
    assert.deepEqual(h.npc('Mira').stages, {});
    const problems = h.store.head().domains.npc.problems.map(item => item.text);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /"charm" is not a meter/);
    assert.match(problems[1], /Stages are set by code/);
    assert.deepEqual(results[0].receipt.data.problems, problems);
    const only = h.reply('Hm.', '~ npc Mira | charm: +4');
    assert.equal(only.results[0].ok, false, 'a line with no usable meter is refused: a host Problem');
    assert.match(only.results[0].message, /"charm" is not a meter/);
});

test('capture: someone Delta does not know gets an entry keyed by name, from the base values', async () => {
    const delta = fakeDelta();
    delta.baseline = { trust: 5, affection: 0, desire: 0, tension: 0 };
    const h = await host({ delta });
    h.reply('A stranger.', '+ npc Captain Ilse Vorn | trust: +3');
    const entry = h.npc('Captain Ilse Vorn');
    assert.equal(entry.key, 'captain-ilse-vorn');
    assert.equal(entry.meters.trust, 8);
    assert.equal(delta.records.npc_ilse, undefined, 'Delta\'s own dossiers are not touched');
    h.reply('Again.', '~ npc captain ilse vorn | trust: +1');
    assert.equal(h.npc('Captain Ilse Vorn').meters.trust, 9, 'the same entry by name, whatever the case');
    // An alias of a dossier finds the dossier's entry.
    h.reply('Smith.', '~ npc The Smith | affection: +4');
    assert.deepEqual(Object.keys(h.store.head().domains.npc.npcs).sort(), ['captain-ilse-vorn', 'mira']);
    assert.equal(h.npc('Mira').meters.affection, 4);
});

test('hostile NPC and meter names never reach prototypes, keys or markup', async () => {
    const h = await host({ settings: { customMeters: [
        { name: '__proto__', min: 0, max: 10 }, { name: 'constructor' }, { name: 'prototype' }, { name: 'trust' }, { name: 'stage' },
        { name: '<img src=x onerror=alert(1)>', min: 0, max: 50 }, { name: 'Lust', min: 0, max: 100, start: 10 }, { name: 'lust' },
        { name: 'x'.repeat(500) }, { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' },
    ] } });
    const custom = normalizeMeterSettings(h.sdk.settings(MODULE_ID)).custom;
    assert.equal(custom.length, MAX_CUSTOM_METERS);
    // `__proto__` reads as the word "proto": a plain meter id, never a key of the prototype.
    assert.deepEqual(custom.map(def => def.id), ['proto', 'img-src-x-onerror-alert-1', 'lust', 'x'.repeat(40), 'a', 'b']);
    const block = [
        '~ npc __proto__ | trust: +1',
        '~ npc constructor | __proto__: +5 | constructor: =9 | trust: +1',
        // The shared grammar reads only word labels; the same meter written in words is found by its id.
        '~ npc <img src=x onerror=alert(1)> | img src x onerror alert 1: +7',
        '~ npc Mira | lust: +3',
    ].join('\n');
    const { results } = h.reply('Strange guests.', block);
    assert.ok(results.every(result => result.ok), JSON.stringify(results.map(result => result.message)));
    const npcs = h.store.head().domains.npc.npcs;
    assert.deepEqual(Object.keys(npcs).sort(), ['constructor-npc', 'img-src-x-onerror-alert-1', 'mira', 'proto']);
    assert.equal(Object.getPrototypeOf(npcs), Object.prototype);
    assert.equal({}.trust, undefined, 'no prototype pollution');
    assert.equal(Object.prototype.constructor, Object);
    assert.equal(npcs['img-src-x-onerror-alert-1'].meters['img-src-x-onerror-alert-1'], 7);
    assert.equal(npcs['constructor-npc'].meters.proto, 5);
    assert.deepEqual(h.store.head().domains.npc.problems.map(item => item.text), ['"constructor" is not a meter (meters: trust, affection, desire, tension, proto, img-src-x-onerror-alert-1, lust, xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, a, b).']);
    assert.equal(npcs.mira.meters.lust, 13, 'a custom meter starts at its own start');
    assert.deepEqual(validateNpcSlice(h.store.head().domains.npc), []);
    // Markup: names and labels are escaped in the Cast tab bars.
    const bar = meterBarNode(fakeDocument(), { id: '<b>', label: '<img src=x onerror=alert(1)>', min: 0, max: 50, tone: '"><script>' }, 7, '<i>stage</i>').serialize();
    assert.doesNotMatch(bar, /<img|<script|<i>|<b>/);
    assert.match(bar, /ss-w-tone-neutral/, 'a tone outside the list is neutral');
    assert.match(bar, /--ss-w-ratio: 0\.14/);
    assert.equal(npcKey('__proto__'), 'proto');
    assert.equal(npcKey('constructor'), 'constructor-npc');
    assert.equal(npcKey('   '), null);
});

test('custom meters: their own range and start, a bar each, kept in the static line', async () => {
    const h = await host({ settings: { customMeters: [{ name: 'Lust', min: 0, max: 100, start: 0, show: 'bar' }, { name: 'Respect Level', min: -50, max: 50, start: 5, show: 'hidden' }] } });
    h.reply('Heat.', '~ npc Mira | lust: +3 | respect level: -60');
    assert.equal(h.npc('Mira').meters.lust, 3);
    assert.equal(h.npc('Mira').meters['respect-level'], -10, 'the cap holds a custom meter too');
    const cast = h.runQuery('npc.cast');
    assert.deepEqual(cast[0].bars.map(bar => bar.id), ['trust', 'affection', 'desire', 'tension', 'lust'], 'a hidden meter has no bar');
    assert.deepEqual(cast[0].bars.find(bar => bar.id === 'lust'), { id: 'lust', label: 'Lust', value: 3, min: 0, max: 100, stage: '', tone: 'neutral', text: '3', delta: 3 });
    assert.deepEqual(cast[0].still.find(bar => bar.id === 'lust'), { id: 'lust', label: 'Lust', value: 3, min: 0, max: 100, stage: '', tone: 'neutral', text: '3' }, 'still: the same bar without the change');
    assert.equal(h.def.context.static(), 'NPC meters: trust, affection, desire, tension (-100..100), lust (0..100), respect-level (-50..50). When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most 15 a reply and sets the stages; never write a stage.');
    // A row just added in the overlay (empty name, zero range) is left out; an upside-down range reads 0..100.
    const odd = normalizeMeterSettings({ customMeters: [{ name: '', min: 0, max: 0 }, { name: 'Odd', min: 50, max: -50, start: 999 }] }).custom;
    assert.deepEqual(odd.map(({ id, min, max, start }) => ({ id, min, max, start })), [{ id: 'odd', min: 0, max: 100, start: 100 }]);
});

// ---- the prompt ----

test('the static part is byte-identical across replies and changes only with the settings', async () => {
    const h = await host({ settings: { stages: STAGES } });
    const first = h.def.context.static();
    h.reply('One.', '~ npc Mira | trust: +15');
    h.reply('Two.', '~ npc Oren | tension: +4');
    assert.equal(h.def.context.static(), first);
    assert.doesNotMatch(first, /Mira|Oren|Friend|\d{2,} a reply.*\d/, 'no names or stage names');
    h.setSettings({ stages: STAGES, changeCap: 10, customMeters: [{ name: 'Lust' }] });
    assert.notEqual(h.def.context.static(), first);
    assert.match(h.def.context.static(), /lust \(0\.\.100\)/);
    assert.match(h.def.context.static(), /at most 10 a reply/);
    h.delta.enabled = false;
    assert.equal(h.def.context.static(), '', 'nothing while Delta is off');
});

test('the tail: present NPCs\' meters only when they moved lately, compactly', async () => {
    const h = await host({ settings: { stages: STAGES } });
    assert.deepEqual(h.def.context.tail(h.view()).lines, []);
    h.reply('Warm.', '~ npc Mira | trust: +12\n~ npc Oren | tension: +3');
    assert.deepEqual(h.def.context.tail(h.view()).lines, ['NPC meters now: Mira trust 22 (Friend), affection 0, desire 0, tension 0.'], 'Oren is not present');
    h.reply('Quiet.');
    h.reply('Quiet.');
    assert.deepEqual(h.def.context.tail(h.view()).lines, [], 'not once the change is a few replies old');
});

// ---- stages ----

test('stages: code moves the stage when a meter crosses a threshold either way, with a receipt', async () => {
    const h = await host({ settings: { stages: STAGES } });
    let [result] = h.reply('Kind.', '~ npc Mira | trust: +12').results;
    assert.equal(h.npc('Mira').stages.trust, 'Friend');
    assert.equal(result.receipt.summary, 'Mira: trust reached Friend. Mira: trust 10 → 22.');
    assert.equal(result.receipt.narrate, true, 'the next reply is told');
    assert.deepEqual(result.receipt.data.stages, [{ meter: 'trust', from: null, to: 'Friend' }]);
    [result] = h.reply('Kind.', '~ npc Mira | trust: +2').results;
    assert.equal(result.receipt.narrate, false, 'no stage moved: the reply told it already');
    for (let i = 0; i < 3; i += 1) h.reply('Kinder.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').stages.trust, 'Confidant');
    [result] = h.reply('Cold.', '~ npc Mira | trust: -15').results;
    assert.equal(h.npc('Mira').meters.trust, 54);
    assert.match(result.receipt.summary, /^Mira: trust fell back to Friend\./);
    for (let i = 0; i < 3; i += 1) [result] = h.reply('Colder.', '~ npc Mira | trust: -15').results;
    assert.equal(h.npc('Mira').stages.trust, undefined);
    assert.match(result.receipt.summary, /^Mira: trust left Friend\./);
    for (let i = 0; i < 3; i += 1) [result] = h.reply('Betrayal.', '~ npc Mira | trust: -15').results;
    assert.equal(h.npc('Mira').stages.trust, 'Wary');
    assert.match(result.receipt.summary, /^Mira: trust reached Wary\./);
    assert.equal(stageAt([{ at: -30, name: 'Wary' }, { at: 0, name: 'Neutral' }], 0)?.name, 'Neutral', 'a threshold at 0 is reached at 0');
    assert.equal(stageAt([{ at: -30, name: 'Wary' }, { at: 0, name: 'Neutral' }], -5), null, 'between them: no stage');
    assert.equal(stageAt([{ at: -60, name: 'Enemy' }, { at: -30, name: 'Wary' }], -70)?.name, 'Enemy', 'the farthest negative one');
});

test('stages: the story cannot set one, and the reader\'s own set moves it too', async () => {
    const h = await host({ settings: { stages: STAGES } });
    h.reply('Hm.', '~ npc Mira | stage: Confidant | trust: +1');
    assert.deepEqual(h.npc('Mira').stages, {});
    const out = await h.adapter.setMeters({ name: 'Mira', meters: { trust: 70 } });
    assert.equal(out.ok, true);
    assert.equal(h.npc('Mira').stages.trust, 'Confidant');
    assert.match(out.receipt.summary, /trust reached Confidant/);
});

// ---- hidden notes ----

test('secrets: unlocked at the threshold with a receipt; never sent while locked; kept unlocked after', async () => {
    const h = await host();
    const leaks = () => {
        const tail = JSON.stringify(h.def.context.tail(h.view()));
        const statics = h.def.context.static();
        const state = JSON.stringify(h.store.head());
        const dossier = JSON.stringify(h.runQuery('npc.dossier', { name: 'Mira' }));
        const all = JSON.stringify(h.runQuery('npc.meters', {})) + JSON.stringify(h.runQuery('npc.cast'));
        return [tail, statics, state, dossier, all].some(text => text.includes(SECRET) || text.includes(SECRET_TWO));
    };
    h.reply('Nice.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').meters.trust, 25);
    assert.deepEqual(h.npc('Mira').unlocked, []);
    assert.equal(leaks(), false, 'locked: nowhere in the tail, the static part, the state or the queries');
    // Delta's own prompts never carry the hidden notes either.
    const record = h.delta.api.getNpc('npc_mira');
    const injection = buildInjection([record], 'Mira laughs.', 3, 3);
    assert.ok(injection.includes('Mira'), 'the injection has Mira');
    assert.equal(injection.includes(SECRET), false);
    const scan = buildScannerPrompt({ transcript: 'USER: hi\nASSISTANT: Mira laughs.', currentTranscript: 'Mira laughs.', existingNpcs: [record], userName: 'Ari', charName: 'Narrator' });
    assert.equal(scan.includes(SECRET) || scan.includes(SECRET_TWO), false);
    const refresh = buildProfileRefreshPrompt({ transcript: '[m1] Mira laughs.', userName: 'Ari', charName: 'Narrator', targetNpc: record });
    const oneShot = buildNarrationCapturePrompt({ transcript: 'Mira laughs.', existingNpcs: [record], userName: 'Ari', charName: 'Narrator' });
    for (const text of [refresh, JSON.stringify(oneShot)]) assert.equal(text.includes(SECRET) || text.includes(SECRET_TWO), false, 'not in Refresh or one-pass capture');

    const [result] = h.reply('Trusted.', '~ npc Mira | trust: +5').results;
    const id = secretId('trust', 30, SECRET);
    assert.deepEqual(h.npc('Mira').unlocked, [id]);
    assert.match(result.receipt.summary, /Mira: a hidden note opened \(trust 30\)/);
    assert.equal(JSON.stringify(h.store.head()).includes(SECRET), false, 'the text never enters the state');
    assert.deepEqual(h.def.context.tail(h.view()).lines.filter(line => line.includes(SECRET)), [`Mira, now known: ${SECRET}`]);
    assert.equal(JSON.stringify(h.def.context.tail(h.view())).includes(SECRET_TWO), false, 'the other note is still locked');
    // Not present: not told.
    h.delta.records.npc_mira.present = false;
    assert.equal(JSON.stringify(h.def.context.tail(h.view())).includes(SECRET), false);
    h.delta.records.npc_mira.present = true;
    // Falling back under the threshold keeps it unlocked on this line of history.
    h.reply('Doubt.', '~ npc Mira | trust: -15');
    assert.deepEqual(h.npc('Mira').unlocked, [id]);
    // A negative rule opens at or below its threshold.
    for (let i = 0; i < 2; i += 1) h.reply('Calm.', '~ npc Mira | tension: -15');
    assert.deepEqual(h.npc('Mira').unlocked, [id, secretId('tension', -20, SECRET_TWO)]);
});

test('secrets: a swipe of the unlocking reply locks it again, and nothing leaks', async () => {
    const h = await host();
    h.reply('Nice.', '~ npc Mira | trust: +15');
    const { index } = h.reply('Trusted.', '~ npc Mira | trust: +10');
    assert.equal(h.npc('Mira').unlocked.length, 1);
    h.swipe(index, '~ npc Mira | trust: +1');
    assert.deepEqual(h.npc('Mira').unlocked, []);
    assert.equal(JSON.stringify(h.def.context.tail(h.view())).includes(SECRET), false);
    h.swipeTo(index, 0);
    assert.equal(h.npc('Mira').unlocked.length, 1, 'back on the first swipe, its unlock is back');
});

test('secrets: editor lines read back with stable ids; notes added later open on refresh', async () => {
    const lines = 'trust 40: The duke\'s daughter.\ntension >= -20: Hates the river.\nnot a note\ntrust 40: The duke\'s daughter.';
    const { secrets, problems } = secretsFromLines(lines);
    assert.deepEqual(secrets.map(({ meter, at }) => [meter, at]), [['trust', 40], ['tension', -20]]);
    assert.deepEqual(problems, ['not a note']);
    assert.deepEqual(secretsFromLines(secretsToLines(secrets), secrets).secrets, secrets, 'the round trip keeps ids');
    const h = await host();
    h.reply('Warm.', '~ npc Oren | trust: +15');
    h.delta.records.npc_oren.secrets = [{ meter: 'trust', at: 5, text: 'Owes the guild.' }];
    assert.equal((await h.adapter.refresh('Oren')).ok, true);
    assert.equal(h.npc('Oren').unlocked.length, 1);
    assert.equal((await h.adapter.refresh('Oren')).ok, false, 'nothing more to open');
});

// ---- rollback ----

test('rollback via ops: swipes and deletes take meters back; replay equals rebuild', async () => {
    const h = await host({ settings: { stages: STAGES } });
    h.reply('One.', '~ npc Mira | trust: +10');
    const { index } = h.reply('Two.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').meters.trust, 35);
    assert.equal(h.npc('Mira').stages.trust, 'Friend');
    h.swipe(index, '~ npc Mira | trust: -5');
    assert.equal(h.npc('Mira').meters.trust, 15);
    assert.equal(h.npc('Mira').stages.trust, undefined, 'the stage went back with the swipe');
    const before = JSON.stringify(h.store.head());
    h.store.rebuild();
    assert.equal(JSON.stringify(h.store.head()), before, 'replaying the stored ops gives the same state');
    h.remove(index);
    h.remove(index - 1);
    assert.equal(h.npc('Mira').meters.trust, 20);
    h.remove(h.chat.length - 1);
    h.remove(h.chat.length - 1);
    assert.equal(h.npc('Mira'), null, 'deleting the first reply takes the entry away');
});

test('rapid swipes: each swipe keeps its own meters, the cap window included', async () => {
    const h = await host();
    h.reply('One.', '~ npc Mira | trust: +5');
    const { index } = h.reply('Two.', '~ npc Mira | trust: +15');
    const expected = [30];
    for (let n = 1; n <= 12; n += 1) {
        // Each swipe asks for more than the cap; it can only ever move 15 from where the reply started.
        h.swipe(index, `~ npc Mira | trust: +${n * 3}\n~ npc Mira | trust: +${n * 3}`);
        expected.push(15 + Math.min(DEFAULT_CHANGE_CAP, n * 6));
        assert.equal(h.npc('Mira').meters.trust, expected[n], `swipe ${n}`);
    }
    for (let n = 12; n >= 0; n -= 1) {
        h.swipeTo(index, n);
        assert.equal(h.npc('Mira').meters.trust, expected[n], `back to swipe ${n}`);
    }
    const head = JSON.stringify(h.store.head());
    h.store.rebuild();
    assert.equal(JSON.stringify(h.store.head()), head);
});

test('Delta\'s scanner path: npc.adjust from the adapter, seeded from the dossier, with the same clamps', async () => {
    const h = await host();
    const out = await h.adapter.adjust({ name: 'Oren', meters: { trust: 3, tension: 40 }, start: { trust: -5, affection: 2, desire: 0, tension: 1 }, reply: 0 });
    assert.equal(out.ok, true);
    assert.deepEqual(h.npc('Oren').meters, { trust: -2, affection: 2, desire: 0, tension: 16 });
    assert.equal(out.receipt.cause, 'ui', 'Delta\'s own action: the host keeps story and system causes for itself');
    assert.equal(out.receipt.narrate, false, 'the reply already told it');
    assert.deepEqual(h.sent.map(item => item.type), ['npc.adjust']);
    assert.equal(h.sent[0].options.cause, undefined);
});

// (NSD r2) npc.adjust is the scanner's and other modules': a button, screen or pack that names it at
// the top (cause ui, no calling module) is refused and nothing is saved, as the host's own steps are.
test('npc.adjust from a button is refused and saves nothing; another module\'s command may send it', async () => {
    const h = await host();
    const rev = h.store.head().meta?.rev;
    const before = structuredClone(h.store.head().domains.npc);
    const out = await h.sdk.command('npc.adjust', { name: 'Oren', meters: { trust: 50 }, reply: 7 });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'REFUSED');
    assert.deepEqual(h.store.head().domains.npc, before, 'nothing saved');
    assert.equal(h.store.head().meta?.rev, rev);
    // The same payload through another module's command (ctx.call sets ctx.caller).
    h.registry.register({
        id: 'zz-nudge', name: 'Nudge',
        commands: { 'zz.nudge': (ctx, payload) => { ctx.call('npc.adjust', payload); return { summary: 'nudged' }; } },
    });
    const called = await h.sdk.command('zz.nudge', { name: 'Oren', meters: { trust: 3 }, reply: 0 });
    assert.equal(called.ok, true, JSON.stringify(called));
    assert.equal(h.npc('Oren').meters.trust, -2);
    // Delta's own scanner (the adapter) still gets through; a copy sent after it has finished does not.
    const own = await h.adapter.adjust({ name: 'Oren', meters: { trust: 2 }, reply: 0 });
    assert.equal(own.ok, true);
    assert.equal(h.npc('Oren').meters.trust, 0);
    const replayed = await h.sdk.command('npc.adjust', { name: 'Oren', meters: { trust: 2 }, reply: 0 });
    assert.equal(replayed.code, 'REFUSED', 'the adapter\'s pass is for its own send only');
    assert.equal(h.npc('Oren').meters.trust, 0);
});

test('npc.set from the UI ignores a caller-chosen reply: the window starts at the latest reply', async () => {
    let latest = 0;
    const h = await host({ settings: { changeCap: 5 }, headReply: () => latest });
    h.reply('Warm.', '~ npc Mira | trust: +5');
    latest = 2;
    assert.equal(h.npc('Mira').reply, 2);
    // A pack button names an old reply to reopen its window; the editor's own value starts reply 2's.
    const set = await h.sdk.command('npc.set', { name: 'Mira', meters: { trust: 40 }, reply: 0 });
    assert.equal(set.ok, true);
    assert.equal(h.npc('Mira').reply, 2, 'the latest reply, not the payload\'s');
    assert.equal(h.npc('Mira').meters.trust, 40);
    // The scanner's change on reply 2 is held within the cap of the reader's value.
    await h.adapter.adjust({ name: 'Mira', meters: { trust: 30 }, reply: 2 });
    assert.equal(h.npc('Mira').meters.trust, 45);
    // Without a latest reply the reader's value ends the window instead.
    latest = null;
    await h.sdk.command('npc.set', { name: 'Mira', meters: { trust: 10 }, reply: 2 });
    assert.equal(h.npc('Mira').reply, undefined);
    // The adapter's editor path sends no reply of its own.
    latest = 2;
    await h.adapter.setMeters({ name: 'Mira', meters: { trust: 12 }, reply: 0 });
    assert.equal(h.sent.at(-1).type, 'npc.set');
    assert.equal('reply' in h.sent.at(-1).payload, false);
    assert.equal(h.npc('Mira').reply, 2);
});

test('the definition asks for Story Block 2.0.0-beta.2 or later', async () => {
    const h = await host();
    assert.deepEqual(h.def.requires, { storyBlock: '>=2.0.0-beta.2' });
});

test('the slice is the truth while hosted: npc.dossier, npc.present and sliceView read it', async () => {
    const h = await host();
    h.reply('Warm.', '~ npc Mira | trust: +15 | desire: +2');
    const dossier = h.runQuery('npc.dossier', { name: 'The Smith' });
    assert.deepEqual(dossier.relationship, { trust: 25, affection: 0, desire: 2, tension: 0 });
    assert.deepEqual(dossier.unlocked, []);
    assert.equal('secrets' in dossier, false);
    assert.deepEqual(h.runQuery('npc.present'), ['Mira'], 'names, as before');
    assert.deepEqual(h.runQuery('npc.present', { meters: true }), [{ name: 'Mira', meters: { trust: 25, affection: 0, desire: 2, tension: 0 }, stages: {} }]);
    const records = Object.values(h.delta.records);
    const view = h.adapter.sliceView(records);
    assert.notEqual(view, records);
    assert.deepEqual(view[0].relationship, { trust: 25, affection: 0, desire: 2, tension: 0 });
    assert.equal(records[0].relationship.trust, 10, 'Delta\'s own records are not changed');
    assert.equal(view[1], records[1], 'an NPC with no entry is passed through');
    assert.equal(h.adapter.meters('The Smith').meters.trust, 25);
});

test('validation: the 81st NPC is refused and nothing is saved; a bad slice is refused', async () => {
    const h = await host();
    const block = Array.from({ length: MAX_NPCS }, (_, i) => `+ npc Guard ${i + 1} | trust: +1`).join('\n');
    h.reply('A crowd.', block);
    assert.equal(Object.keys(h.store.head().domains.npc.npcs).length, MAX_NPCS);
    const rev = h.store.head().meta.rev;
    const { results } = h.reply('One more.', '+ npc Guard 81 | trust: +1');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].code, 'REFUSED');
    assert.equal(h.store.head().meta.rev, rev, 'nothing saved');
    assert.ok(validateNpcSlice({ npcs: { Bad: { name: 'x', meters: {}, stages: {}, unlocked: [] } }, problems: [] }).length > 0);
    assert.ok(validateNpcSlice({ npcs: { a: { name: 'A', meters: { trust: 1.5 }, stages: {}, unlocked: [] } }, problems: [] }).length > 0);
    assert.ok(validateNpcSlice({ npcs: { a: { name: 'A', meters: { trust: 5000 }, stages: {}, unlocked: [] } }, problems: [] }).length > 0);
    assert.ok(validateNpcSlice({ npcs: { a: { name: 'A', meters: {}, stages: {}, unlocked: ['x', 'x'] } }, problems: [] }).length > 0);
    assert.ok(validateNpcSlice({ npcs: { a: { name: 'A', meters: {}, stages: {}, unlocked: [], secret: 'no' } }, problems: [] }).length > 0, 'no stray fields (a note text could not hide here)');
});

// ---- the host goes away ----

test('host lost mid-reply: Delta stops sending, its views pass through, the host\'s own capture still finishes', async () => {
    const h = await host();
    const { index } = h.reply('Warm.', '~ npc Mira | trust: +5');
    const pending = h.adapter.adjust({ name: 'Mira', meters: { trust: 2 }, reply: index });
    h.box.host = undefined;
    assert.equal(h.adapter.check(), false, 'the host is gone');
    assert.equal(h.adapter.hosted(), false);
    await pending;
    assert.equal(await h.adapter.adjust({ name: 'Mira', meters: { trust: 2 }, reply: index }), null, 'nothing is sent without a host');
    assert.equal(await h.adapter.setMeters({ name: 'Mira', meters: { trust: 2 } }), null);
    assert.equal(await h.adapter.refresh('Mira'), null);
    assert.equal(h.adapter.meters('Mira'), null);
    const records = Object.values(h.delta.records);
    assert.equal(h.adapter.sliceView(records), records, 'the same array: v1 numbers');
    // The old host finishing that reply's capture does not throw (its definition still answers).
    const late = h.capture(index, '~ npc Mira | trust: +1 | charm: +2');
    assert.equal(late[0].ok, true);
    assert.equal(h.npc('Mira').meters.trust, 18);
    assert.deepEqual(h.sent.map(item => item.type), ['npc.adjust']);
    h.adapter.stop();
});

test('without a host the adapter changes nothing and sends nothing', async () => {
    const delta = fakeDelta();
    const calls = [];
    const adapter = createStorySuiteV2Adapter({
        suiteApi: delta.suiteApi, delta: () => delta.api, host: () => undefined, doc: fakeDoc(), timers,
        logger: { warn: (...args) => calls.push(args) },
    });
    adapter.start();
    const records = Object.values(delta.records);
    assert.equal(adapter.sliceView(records), records);
    assert.equal(await adapter.adjust({ name: 'Mira', meters: { trust: 1 } }), null);
    assert.equal(await adapter.setMeters({ name: 'Mira', meters: { trust: 1 } }), null);
    assert.equal(adapter.meters('Mira'), null);
    assert.deepEqual(calls, []);
    assert.deepEqual(meterDefs({}).map(def => def.id), ['trust', 'affection', 'desire', 'tension']);
    adapter.stop();
});

test('the Dossiers tab (once Cast) shows a meter bar per shown meter for the present NPCs, escaped', async () => {
    const h = await host({ settings: { stages: STAGES, customMeters: [{ name: 'Lust', show: 'bar' }, { name: 'Secretive', show: 'hidden' }] } });
    h.reply('Warm.', '~ npc Mira | trust: +12 | lust: +3\n~ npc Oren | trust: +1\n+ npc <b>Bold</b> | trust: +1');
    h.delta.records.npc_bold = { id: 'npc_bold', name: '<b>Bold</b>', aliases: [], present: true, archived: false, relationship: {} };
    const el = fakeRoot();
    h.def.tabs[0].render(el);
    // The present cast and its meters, before the dossier list (which names everyone, Oren too).
    const html = el.innerHTML.split('npc-state-delta-v2-dossiers')[0];
    assert.match(el.innerHTML, /npc-state-delta-v2-dossiers/, 'the dossier list under them');
    assert.match(html, /<section class="npc-state-delta-present-roster">cast<\/section>/, 'Delta\'s own cards first');
    const bars = html.match(/role="meter"/g) ?? [];
    assert.equal(bars.length, 10, 'five bars each for Mira and Bold; Oren is not present; the hidden meter has none');
    assert.match(html, /aria-label="Trust" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="22" aria-valuetext="22 · Friend"/);
    assert.match(html, /<h4>&lt;b&gt;Bold&lt;\/b&gt;<\/h4>/);
    assert.doesNotMatch(html, /<b>Bold/);
    assert.doesNotMatch(html, /Oren/);
    h.delta.enabled = false;
    h.def.tabs[0].render(el);
    assert.doesNotMatch(el.innerHTML, /role="meter"/, 'nothing while Delta is off');
});
