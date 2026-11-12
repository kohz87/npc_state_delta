import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_PREFIX, createRegistry } from './vendor/story-block/src/v2/registry.js';
import { createStore } from './vendor/story-block/src/v2/store.js';
import { createCommandBus } from './vendor/story-block/src/v2/commands.js';
import { parseChanges } from './vendor/story-block/src/v2/capture.js';
import { MODULE_ID, createStorySuiteV2Adapter, meterBarNode } from '../src/storysuite-v2.js';
import {
    DEFAULT_CHANGE_CAP, MAX_CUSTOM_METERS, MAX_GENERATED_SECRETS, MAX_NPCS, MAX_SECRETS, meterDefs, normalizeGeneratedSecrets, normalizeMeterSettings, normalizeSecrets, npcKey, parseMeterValue,
    secretId, secretsFromLines, secretsToLines, stageAt, validateNpcSlice,
} from '../src/npc-meters.js';
import { assemble } from './vendor/story-block/src/v2/prompt.js';
import { escapeHtml } from '../src/util/html.js';
import fs from 'node:fs';
import { projectDossierState, v2SecretsHtml, v2MetersProjection } from '../dossier-ui.js';
import { dossierUiSource } from './helpers/dossier-ui-source.js';
import { hiddenNotePromptRules } from '../core-mechanics.js';
import { METERS_CARD_ID, metersCardScreen } from '../src/npc-meters-screen.js';
import { buildInjection, buildNarrationCapturePrompt, buildProfileRefreshPrompt, buildScannerPrompt, normalizeNpcRecord } from '../core.js';
import { fakeRoot } from './helpers/fake-dom.js';
import { fakeDocument } from './helpers/fake-dom.js';
import { validatePack } from './vendor/story-block/src/v2/packs/validate.js';
import { contentOf } from './vendor/story-block/src/v2/packs/content.js';
import { castSecrets } from '../src/cast-dossier.js';

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

const plain = lines => lines.filter(line => typeof line === 'string'); // the kept Changes cue is an object in the lines: pinned in npc-notes-kinds.test.js
const noCue = lines => lines.filter(line => !/^Whenever anything changed, write the <Changes> block/.test(line)); // the flash-rare-lines cue: pinned in npc-notes-kinds.test.js
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
    // (The anti-lever sentence is on by default and tested in relationship-pacing.test.js; the line without it is what is pinned here.)
    assert.equal(h.def.context.static().replace(/ Add \| via:[^.]*\./, ''), 'NPC meters: trust, affection, desire, tension (-100..100), lust (0..100), respect-level (-50..50). When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most 15 a reply and sets the stages; never write a stage. Add | why: what caused it.');
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
    assert.deepEqual(plain(h.def.context.tail(h.view()).lines), []);
    h.reply('Warm.', '~ npc Mira | trust: +12\n~ npc Oren | tension: +3');
    assert.deepEqual(plain(h.def.context.tail(h.view()).lines), ['NPC meters now: Mira trust 22 (Friend), affection 0, desire 0, tension 0.'], 'Oren is not present');
    h.reply('Quiet.');
    h.reply('Quiet.');
    assert.deepEqual(plain(h.def.context.tail(h.view()).lines), [], 'not once the change is a few replies old');
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

test('secrets: unlocked at the threshold with a receipt; locked ones are sent only as hidden while present; kept unlocked after', async () => {
    const h = await host();
    // Where a locked note's text may never be: the static part, the state, the queries and the dossier. It IS in the tail (hidden wording).
    const leaks = () => {
        const statics = h.def.context.static();
        const state = JSON.stringify(h.store.head());
        const dossier = JSON.stringify(h.runQuery('npc.dossier', { name: 'Mira' }));
        const all = JSON.stringify(h.runQuery('npc.meters', {})) + JSON.stringify(h.runQuery('npc.cast'));
        return [statics, state, dossier, all].some(text => text.includes(SECRET) || text.includes(SECRET_TWO));
    };
    // (lean) Two or more locked notes: the wording once, on the nearest note; each note then reads "Mira (hidden): text".
    const ONCE = 'Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.';
    const hidden = (text, first = false) => `${first ? `${ONCE}\n` : ''}Mira (hidden): ${text}`;
    h.reply('Nice.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').meters.trust, 25);
    assert.deepEqual(h.npc('Mira').unlocked, []);
    assert.equal(leaks(), false, 'locked: nowhere in the static part, the state or the queries');
    const locked = h.def.context.tail(h.view());
    assert.deepEqual(noCue(locked.optional), [hidden(SECRET, true), hidden(SECRET_TWO)], 'present and locked: sent as hidden, the nearer to opening first (trust 25 of 30; tension 0 of -20)');
    assert.equal(plain(locked.lines).some(line => line.includes(SECRET) || line.includes(SECRET_TWO)), false, 'never as a known line');
    // Delta's own prompts never carry the hidden notes.
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
    const opened = h.def.context.tail(h.view());
    assert.deepEqual(plain(opened.lines).filter(line => line.includes(SECRET)), [`Mira, known to the player now; may come out: ${SECRET}`]);
    assert.deepEqual(noCue(opened.optional), [hidden(SECRET_TWO, true)], 'the other note is still locked: hidden wording');
    assert.equal(leaks(), false);
    // Not present: not told, locked or opened.
    h.delta.records.npc_mira.present = false;
    const away = JSON.stringify(h.def.context.tail(h.view()));
    assert.equal(away.includes(SECRET) || away.includes(SECRET_TWO), false);
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
    const again = h.def.context.tail(h.view());
    assert.equal(plain(again.lines).some(line => line.includes(SECRET)), false, 'locked again: no longer told as known');
    assert.ok(again.optional.some(line => line.endsWith(`Mira (hidden): ${SECRET}`)), 'only as hidden');
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

test('Delta\'s own scan forwards are background changes; the reader\'s sends are not', async () => {
    const h = await host();
    await h.adapter.adjust({ name: 'Oren', meters: { trust: 3 }, start: { trust: 0, affection: 0, desire: 0, tension: 0 }, reply: 0 });
    await h.adapter.setMeters({ name: 'Oren', meters: { trust: 1 } });
    await h.adapter.refresh('Oren');
    assert.deepEqual(h.sent.map(item => [item.type, item.options.background === true]), [['npc.adjust', true], ['npc.set', false], ['npc.refresh', false]]);
    assert.equal(h.sent[0].options.cause, undefined, 'still the reader-level cause: background only says when to save');
});

test('a Story Block that ignores the command options still takes the forwards', async () => {
    const h = await host();
    const seen = [];
    const original = h.box.host.sdk.command;
    // an older Story Block: command(type, payload) only, a third argument is never looked at
    h.box.host.sdk.command = async function (type, payload) { seen.push(arguments.length); return original(type, payload); };
    const out = await h.adapter.adjust({ name: 'Oren', meters: { trust: 3 }, start: { trust: 0, affection: 0, desire: 0, tension: 0 }, reply: 0 });
    assert.equal(out.ok, true);
    assert.deepEqual(h.npc('Oren').meters.trust, 3);
    assert.deepEqual(seen, [3], 'the option is passed; the old command ignores it and applies the change');
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

test('the definition asks for Story Block 2.31.1 or later', async () => {
    const h = await host();
    assert.deepEqual(h.def.requires, { storyBlock: '>=2.31.1' });
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
    assert.equal(h.npc('Mira').meters.trust, 16, 'the story\'s +5 and +1 only: the scan\'s +2 left trust to the story line (RT2)');
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


// ---- hidden notes for everyone: story events, layers, hand, injection, screens ----

const EVENT = 'The duke is exposed as a traitor';
const EVENT_SECRET = 'She has known about the duke all along.';
const HIDDEN = (text, first = false) => `${first ? 'Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.\n' : ''}Mira (hidden): ${text}`;
const KNOWN = text => `Mira, known to the player now; may come out: ${text}`;
const eventNote = () => ({ title: 'The duke', when: EVENT, text: EVENT_SECRET });

test('secrets: a note may open on a story event (when, up to 120 characters), by a meter, or by whichever comes first', () => {
    const pack = normalizeSecrets([
        { title: 'A', text: 'Meter only.', meter: 'trust', at: 40 },
        { title: 'B', text: 'Event only.', when: ` ${EVENT} ` },
        { title: 'C', text: 'Both.', meter: 'affection', at: 30, when: 'She is told the truth' },
        { text: 'No rule at all.' },
        { text: 'Half a meter rule.', meter: 'trust' },
        { when: 'No text.' },
    ]);
    assert.deepEqual(pack.map(note => [note.title ?? null, note.meter ?? null, note.at ?? null, note.when ?? null]), [
        ['A', 'trust', 40, null], ['B', null, null, EVENT], ['C', 'affection', 30, 'She is told the truth'],
    ]);
    assert.equal(pack[0].id, secretId('trust', 40, 'Meter only.'), 'a meter note keeps the id it always had');
    assert.equal(normalizeSecrets([{ text: 'x', when: 'e'.repeat(300) }])[0].when.length, 120);
    // The pack's and the reader's limit stays 8.
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `Note ${i}`, when: `Event ${i}` }));
    assert.equal(normalizeSecrets(many).length, MAX_SECRETS);
    assert.equal(MAX_SECRETS, 8);
});

test('secrets: editor lines carry event notes and "meter or when" notes, and round-trip with their ids', () => {
    const lines = ['trust 40: [Her past] The duke\'s daughter.', `when ${EVENT} => [The duke] ${EVENT_SECRET}`, 'affection 30 or when she is told => Both ways.', 'when => no event', 'when only words'].join('\n');
    const { secrets, problems } = secretsFromLines(lines);
    assert.deepEqual(secrets.map(note => [note.meter ?? null, note.at ?? null, note.when ?? null, note.title ?? null]), [
        ['trust', 40, null, 'Her past'], [null, null, EVENT, 'The duke'], ['affection', 30, 'she is told', null],
    ]);
    assert.deepEqual(problems, ['when => no event', 'when only words']);
    const written = secretsToLines(secrets);
    assert.match(written, new RegExp(`^when ${EVENT} => \\[The duke\\] `, 'm'));
    assert.match(written, /^affection 30 or when she is told => Both ways\.$/m);
    assert.deepEqual(secretsFromLines(written, secrets).secrets, secrets, 'ids and rules survive the round trip');
});

test('secrets: a scan writes up to 5 layers (light to deep); the pack and the reader keep 8; bad layers are dropped', () => {
    const layer = (i, extra = {}) => ({ title: `Layer ${i}`, text: `Secret ${i}.`, meter: 'trust', at: 10 * (i + 1), ...extra });
    const made = normalizeGeneratedSecrets([0, 1, 2, 3, 4, 5, 6].map(i => layer(i)));
    assert.equal(MAX_GENERATED_SECRETS, 5);
    assert.deepEqual(made.map(note => note.at), [10, 20, 30, 40, 50], 'five at most, in the order written (light to deep)');
    const mixed = normalizeGeneratedSecrets([
        layer(0, { id: 'sec_hacked01' }), layer(1, { meter: 'luck' }), layer(2, { at: 0 }), layer(3, { at: 500 }),
        layer(4, { meter: 'mood', at: 3, when: 'She is betrayed' }), { title: 'x', text: 'No rule.' }, 'junk', null,
    ]);
    assert.deepEqual(mixed.map(note => [note.meter ?? null, note.when ?? null]), [['trust', null], [null, 'She is betrayed']], 'only a built-in meter within range, else an event; the rest is dropped');
    assert.notEqual(mixed[0].id, 'sec_hacked01', 'the model never chooses an id');
    assert.deepEqual(normalizeGeneratedSecrets('nope'), []);
    assert.equal(normalizeSecrets(Array.from({ length: 12 }, (_, i) => layer(i))).length, 8);
});

test('secrets: a story event opens an event note; recorded on the reply, a swipe takes it back, replay and Re-read keep it', async () => {
    const h = await host();
    h.delta.records.npc_mira.secrets = [...h.delta.records.npc_mira.secrets, eventNote()];
    h.reply('Nice.', '~ npc Mira | trust: +5');
    const noteId = normalizeSecrets(h.delta.records.npc_mira.secrets).find(note => note.when).id;
    const watch = h.adapter.eventWatch(Object.values(h.delta.records));
    assert.deepEqual(watch.map(({ key, name, note, event }) => ({ key, name, note, event })), [{ key: 's1', name: 'Mira', note: noteId, event: EVENT }]);
    // Locked, an event note is sent as hidden while she is here; nothing is "known".
    assert.ok(h.def.context.tail(h.view()).optional.some(line => line.endsWith(HIDDEN(EVENT_SECRET))));

    const { index } = h.reply('The duke is dragged out in chains.', '');
    const out = await h.adapter.openByEvent({ name: 'Mira', ids: [noteId] });
    assert.equal(out.ok, true);
    assert.match(out.receipt.summary, /Mira: a hidden note opened \(the story\)/);
    assert.equal(out.receipt.narrate, false, 'the narrator is not told "a note opened"');
    assert.deepEqual(h.npc('Mira').unlocked, [noteId]);
    assert.deepEqual(h.sent.at(-1).payload, { name: 'Mira', open: [noteId], by: 'story' });
    assert.deepEqual(h.adapter.eventWatch(Object.values(h.delta.records)), [], 'opened: no longer watched');
    assert.ok(plain(h.def.context.tail(h.view()).lines).includes(KNOWN(EVENT_SECRET)));
    assert.equal(h.def.context.tail(h.view()).optional.some(line => line.endsWith(HIDDEN(EVENT_SECRET))), false);

    // Replay equals live; a Re-read of the reply's story lines keeps it (it is Delta's, not a story line).
    const live = JSON.stringify(h.store.head());
    h.store.rebuild();
    assert.equal(JSON.stringify(h.store.head()), live, 'rebuild == live');
    h.store.replaceStory(index, { ops: [], receipts: [] });
    assert.deepEqual(h.npc('Mira').unlocked, [noteId], 'a Re-read keeps it');
    // A swipe of the reply takes it back (the reply's own record goes with it).
    h.swipe(index, '');
    assert.deepEqual(h.npc('Mira').unlocked, [], 'swipe undoes');
    assert.equal(h.adapter.eventWatch(Object.values(h.delta.records)).length, 1, 'watched again');
    h.swipeTo(index, 0);
    assert.deepEqual(h.npc('Mira').unlocked, [noteId], 'back on the first swipe, it is open again');
});

test('secrets: only Delta\'s own scan may say a story event happened; the scan cannot open a note without an event', async () => {
    const h = await host();
    h.delta.records.npc_mira.secrets = [...h.delta.records.npc_mira.secrets, eventNote()];
    h.reply('Nice.', '~ npc Mira | trust: +5');
    const notes = normalizeSecrets(h.delta.records.npc_mira.secrets);
    const eventId = notes.find(note => note.when).id;
    const meterId = notes.find(note => !note.when).id;
    const before = JSON.stringify(h.store.head());
    const forged = await h.sdk.command('npc.open', { name: 'Mira', open: [eventId], by: 'story' });
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'REFUSED', 'a button or pack cannot claim the story event happened');
    const noEvent = await h.adapter.openByEvent({ name: 'Mira', ids: [meterId] });
    assert.equal(noEvent.ok, false, 'a meter note has no event for the scan to see');
    assert.equal((await h.sdk.command('npc.open', { name: 'Mira' })).ok, false, 'it names nothing');
    assert.equal(JSON.stringify(h.store.head()), before, 'nothing saved');
    // Only present people are watched.
    h.delta.records.npc_mira.present = false;
    assert.deepEqual(h.adapter.eventWatch(Object.values(h.delta.records)), []);
});

test('secrets: the reader opens or shuts a note by hand; a shut note stays shut while its meter is past it, until opened by hand', async () => {
    const h = await host();
    h.reply('Nice.', '~ npc Mira | trust: +25');
    const id = secretId('trust', 30, SECRET);
    h.reply('Trusted.', '~ npc Mira | trust: +10');
    assert.deepEqual(h.npc('Mira').unlocked, [id]);
    assert.equal((await h.sdk.command('npc.open', { name: 'Mira', close: [id] })).ok, true);
    assert.deepEqual(h.npc('Mira').unlocked, []);
    assert.deepEqual(h.npc('Mira').held, [id]);
    h.reply('More.', '~ npc Mira | trust: +5');
    assert.deepEqual(h.npc('Mira').unlocked, [], 'the meter is past 30 and the note stays shut');
    assert.ok(h.def.context.tail(h.view()).optional.some(line => line.endsWith(HIDDEN(SECRET))), 'shut: hidden wording again');
    assert.equal((await h.sdk.command('npc.open', { name: 'Mira', open: [id, 'sec_nonexistent'] })).ok, true);
    assert.deepEqual(h.npc('Mira').unlocked, [id]);
    assert.equal(h.npc('Mira').held, undefined);
    assert.equal((await h.sdk.command('npc.open', { name: 'Mira', open: [id] })).ok, false, 'already open: nothing to do');
    // Opening the tension note by hand, though its meter is nowhere near.
    const two = secretId('tension', -20, SECRET_TWO);
    await h.sdk.command('npc.open', { name: 'Mira', open: [two] });
    assert.deepEqual(h.npc('Mira').unlocked, [id, two]);
    assert.deepEqual(h.runQuery('npc.cast').find(entry => entry.key === 'mira').opened.map(note => note.text), ['Opened · Trust 30', 'Opened · by you'], 'a meter past its rule says so; a note opened by hand says "by you"');
    assert.deepEqual(validateNpcSlice(h.store.head().domains.npc), []);
    const live = JSON.stringify(h.store.head());
    h.store.rebuild();
    assert.equal(JSON.stringify(h.store.head()), live, 'rebuild == live');
});

test('secrets: five layers over a small budget: the nearest to opening are sent, the deep ones wait until the person gets close', async () => {
    const layers = [10, 25, 40, 60, 80].map((at, i) => ({ title: `Layer ${i + 1}`, meter: 'trust', at, text: `Layer ${i + 1} of her past, about ${at}: ${'x'.repeat(130)}` }));
    const delta = fakeDelta();
    delta.records.npc_mira.secrets = layers;
    delta.records.npc_mira.relationship.trust = 0;
    const h = await host({ delta });
    h.reply('Nice.', '~ npc Mira | trust: +12');
    assert.deepEqual(h.npc('Mira').unlocked, [secretId('trust', 10, layers[0].text)], 'the lightest layer opened at 10');
    const tail = h.def.context.tail(h.view());
    assert.equal(noCue(tail.optional).length, 4);
    assert.deepEqual(noCue(tail.optional).map(line => /Layer (\d)/.exec(line)[1]), ['2', '3', '4', '5'], 'nearest to opening first');
    const sentFor = () => assemble({ registry: h.registry, view: h.view(), settings: { tailBudget: 1500 } });
    let sent = sentFor();
    const part = () => sent.parts.find(item => item.module === MODULE_ID && item.place === 'tail');
    // 305 tokens for the module (250 and the kept Changes cue): the opened line and the nearest layers fit, the deepest is dropped first.
    assert.ok(part().text.includes('Layer 1 of her past'), 'the opened layer is told');
    assert.ok(part().text.includes('Layer 2 of her past'), 'the nearest locked layer is told');
    assert.equal(part().text.includes('Layer 5 of her past'), false, 'the deepest waits');
    assert.ok(part().dropped >= 1, 'the host says it dropped lines');
    assert.ok(part().tokens <= 305 + 10, `within the module's budget (${part().tokens})`);
    // Three layers in, the next locked one (60) is close and is sent; the deepest (80) still waits.
    for (let i = 0; i < 3; i += 1) h.reply('Closer.', '~ npc Mira | trust: +15');
    assert.equal(h.npc('Mira').meters.trust, 57);
    assert.equal(h.npc('Mira').unlocked.length, 3);
    assert.deepEqual(noCue(h.def.context.tail(h.view()).optional).map(line => /Layer (\d)/.exec(line)[1]), ['4', '5']);
    sent = sentFor();
    assert.ok(part().text.includes('Layer 4 of her past'), 'the layer about to open is told');
    assert.equal(part().text.includes('Layer 5 of her past'), false, 'the deepest still waits');
});

test('secrets: "What\'s sent" shows a locked note as "1 hidden note" (redactSent); an opened note and the rest are as sent', async () => {
    const h = await host();
    h.reply('Nice.', '~ npc Mira | trust: +25');
    const sent = assemble({ registry: h.registry, view: h.view(), settings: { tailBudget: 1500 } });
    const text = sent.parts.find(item => item.module === MODULE_ID && item.place === 'tail').text;
    assert.ok(text.includes(SECRET) && text.includes(SECRET_TWO), 'what is really sent has the locked texts (the narrator must know them)');
    const shown = h.def.hooks.redactSent(text);
    assert.equal(shown.includes(SECRET) || shown.includes(SECRET_TWO), false);
    assert.equal(shown.split('\n').filter(line => line === 'Mira: 1 hidden note').length, 2);
    assert.match(shown, /^NPC meters now: Mira /m, 'the meter line is untouched');
    h.reply('Trusted.', '~ npc Mira | trust: +10');
    const after = h.def.hooks.redactSent(assemble({ registry: h.registry, view: h.view(), settings: { tailBudget: 1500 } }).parts.find(item => item.module === MODULE_ID && item.place === 'tail').text);
    assert.ok(after.includes(KNOWN(SECRET)), 'an opened note is shown as sent');
    assert.equal(after.includes(SECRET_TWO), false);
    assert.equal(h.def.hooks.redactSent('Nothing hidden here.'), 'Nothing hidden here.');
    assert.equal(h.def.hooks.redactSent(undefined), '');
});

test('secrets: NPCs with no notes get exactly the tail they had before (no hidden or known lines)', async () => {
    const h = await host();
    h.reply('Warm.', '~ npc Oren | trust: +15');
    h.delta.records.npc_oren.present = true;
    h.delta.records.npc_mira.present = false;
    const tail = h.def.context.tail(h.view());
    assert.deepEqual(noCue(tail.optional), []);
    assert.match(plain(tail.lines)[0], /^NPC meters now: Oren /);
    assert.equal(plain(tail.lines).length, 1);
});

test('secrets: the Secrets view is the notes in order, opened with title, text and what opened them, hidden as a rule only', async () => {
    const delta = fakeDelta();
    delta.records.npc_mira.secrets = [{ title: 'Her past', meter: 'trust', at: 20, text: SECRET }, eventNote(), { title: 'The ledger', meter: 'trust', at: 60, text: SECRET_TWO }];
    const h = await host({ delta });
    // No meters yet: every note is hidden, and the view still exists.
    const bare = h.adapter.dossierMeters(Object.values(delta.records));
    assert.deepEqual(bare.npc_mira.secrets.map(note => [note.state, note.opens]), [['hidden', 'Opens at Trust 20'], ['hidden', 'Opens with the story'], ['hidden', 'Opens at Trust 60']]);
    assert.equal(bare.npc_oren, undefined, 'no notes and no meters: no view');
    h.reply('Nice.', '~ npc Mira | trust: +12');
    const mira = () => h.adapter.dossierMeters(Object.values(delta.records)).npc_mira;
    assert.deepEqual(mira().secrets.map(note => note.state), ['open', 'hidden', 'hidden']);
    assert.deepEqual(mira().secrets[0], { state: 'open', title: 'Her past', text: SECRET, pill: 'Opened · Trust 20' });
    const json = JSON.stringify(mira());
    assert.equal(json.includes(EVENT) || json.includes(EVENT_SECRET) || json.includes('The duke') || json.includes('The ledger') || json.includes(SECRET_TWO), false, 'a hidden note shows neither title, text nor event');
    const html = v2SecretsHtml(v2MetersProjection(mira()));
    assert.match(html, /Secrets <small class="delta-secrets-count">· 1 opened · 2 still hidden<\/small>/);
    assert.match(html, /Opened · Trust 20/);
    assert.match(html, /Opens at Trust 60/);
    assert.match(html, /Opens with the story/);
    assert.equal((html.match(/delta-secret-bar/g) || []).length, 2);
    assert.doesNotMatch(html, /🔒|🔓|The duke|ledger/);
    // An event note opens "with the story" too, whatever the meter.
    const eventId = normalizeSecrets(delta.records.npc_mira.secrets)[1].id;
    await h.adapter.openByEvent({ name: 'Mira', ids: [eventId] });
    assert.deepEqual(mira().secrets[1], { state: 'open', title: 'The duke', text: EVENT_SECRET, pill: 'Opened · with the story' });
});

test('secrets: the editor lists the notes with a Hidden/Opened choice; saving applies a changed choice (npc.open) and an edited line', async () => {
    const h = await host();
    h.reply('Nice.', '~ npc Mira | trust: +25');
    const html = h.adapter.editorHtml(h.delta.records.npc_mira);
    const id = secretId('trust', 30, SECRET);
    assert.match(html, new RegExp(`id="npc_state_delta_edit_secret_state_${id}"`));
    assert.match(html, /when the duke falls => \[title\] note/);
    const dossier = h.delta.records.npc_mira;
    const values = new Map([
        ['npc_state_delta_edit_secrets', secretsToLines(dossier.secrets)],
        [`npc_state_delta_edit_secret_state_${id}`, 'open'],
        [`npc_state_delta_edit_secret_state_${secretId('tension', -20, SECRET_TWO)}`, 'hidden'],
    ]);
    const edits = h.adapter.readEditor(key => values.get(key), dossier);
    assert.deepEqual(edits.noteStates, { open: [id], close: [] }, 'only a choice that changed counts');
    await h.adapter.applyEditor('Mira', edits);
    assert.deepEqual(h.npc('Mira').unlocked, [id]);
    assert.deepEqual(h.sent.map(item => item.type).slice(-2), ['npc.open', 'npc.refresh']);
    // A new line typed by the reader, with an event, is read back.
    values.set('npc_state_delta_edit_secrets', `${secretsToLines(dossier.secrets)}\nwhen the duke falls => A new note.`);
    const more = h.adapter.readEditor(key => values.get(key), dossier);
    assert.equal(more.secrets.length, 3);
    assert.equal(more.secrets[2].when, 'the duke falls');
});

test('secrets: the scanner prompt asks for layered notes and watches story events only when told; otherwise it is as before', () => {
    const base = { transcript: 'USER: hi\nASSISTANT: Mira laughs.', currentTranscript: 'Mira laughs.', existingNpcs: [], userName: 'Ari', charName: 'Narrator' };
    const plain = buildScannerPrompt(base);
    assert.equal(buildScannerPrompt({ ...base, layeredSecrets: false, eventWatch: [] }), plain, 'asked for nothing: byte-identical');
    assert.equal(plain.includes('HIDDEN NOTES'), false);
    const layered = buildScannerPrompt({ ...base, layeredSecrets: true });
    assert.match(layered, /\n16\. HIDDEN NOTES: for each NEW dossier-worthy NPC only/);
    assert.match(layered, /2 to 5 layered hidden notes, light to deep/);
    assert.equal(layered.startsWith(plain.slice(0, plain.indexOf('\n15. JSON only'))), true);
    const watched = buildScannerPrompt({ ...base, eventWatch: [{ key: 's1', name: 'Mira', event: EVENT }, { key: 's2', name: 'Oren', event: 'The bridge falls' }] });
    assert.match(watched, /\n16\. STORY EVENTS to look for[^\n]*s1 = Mira: The duke is exposed as a traitor \| s2 = Oren: The bridge falls\./);
    assert.match(watched, /"secretEvents"/);
    assert.match(watched, /CURRENT exchange/);
    assert.match(buildScannerPrompt({ ...base, layeredSecrets: true, eventWatch: [{ key: 's1', name: 'Mira', event: EVENT }] }), /\n16\. HIDDEN NOTES[^\n]*\n17\. STORY EVENTS/);
    assert.equal(hiddenNotePromptRules({ eventWatch: [{ name: 'x' }, null] }), '', 'an item with no key or event is no watch');
});

test('secrets: the dossier\'s Secrets section follows Background / History, with a Secrets chip, and only for a dossier with notes', () => {
    const ui = dossierUiSource();
    assert.match(ui, /SECTION_KEYS = Object\.freeze\(\['mood', 'now', 'with', 'ties', 'past', 'secrets'\]\)/, 'Secrets is the sixth and last section');
    assert.match(ui, /\['secrets', secretsSectionHtml\]/);
    assert.match(ui, /ring: \{ value: secrets\.total/, 'the board\'s Secrets tile shows opened / total');
    const notes = [{ state: 'open', title: 'Her past', text: SECRET, pill: 'Opened · Trust 20' }, { state: 'hidden', opens: 'Opens with the story', width: 61 }, { state: 'bogus' }, null];
    const state = { npcs: [{ id: 'npc_a', name: 'Ada' }, { id: 'npc_b', name: 'Bo' }], meterViews: { npc_a: { bars: [], secrets: notes }, npc_b: { bars: [] } } };
    const [ada, bo] = projectDossierState(state).npcs;
    assert.deepEqual(ada.v2Meters.secrets.map(note => note.state), ['open', 'hidden'], 'unreadable notes are dropped');
    assert.deepEqual(bo.v2Meters.secrets, []);
    assert.equal(v2SecretsHtml(bo.v2Meters), '', 'no notes, no section');
    assert.match(v2SecretsHtml(ada.v2Meters), /data-delta-section="secrets"/);
    const hostile = v2SecretsHtml(v2MetersProjection({ bars: [], secrets: [{ state: 'open', title: '<img src=x>', text: '<script>1</script>', pill: '<b>' }, { state: 'hidden', opens: '<i>', width: '50"><x' }] }));
    assert.doesNotMatch(hostile, /<img|<script|<i>|<x/);
});

// ---- hidden notes from the pack's cast (Story Director's `director.cast`, handed over by the cast dossier) ----
// The 12 real Ersveil entries (tests/fixtures/ersveil-cast.json, the same file the cast dossier's tests use): 51 notes, 39 by a
// meter (trust, approval, respect) and 12 only by a story event (`when`).

const ERSVEIL = JSON.parse(fs.readFileSync(new URL('./fixtures/ersveil-cast.json', import.meta.url), 'utf8'));
const allNotes = ERSVEIL.flatMap(entry => entry.secrets);
// What the cast dossier hands over: { id, title?, text, meter + at | when, from: 'pack' }, the id from the rule, the event and the text (FNV-1a, `sec_`).
const handedOver = raw => raw.map(note => {
    const meter = note.meter ?? '';
    let hash = 0x811c9dc5;
    for (const char of `${meter || 'story'}|${meter ? note.at : 0}|${note.title ?? ''}|${note.when ?? ''}|${note.text}`) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return { id: `sec_${hash.toString(36).padStart(8, '0').slice(-8)}`, ...note, from: 'pack' };
});

test('secrets from the cast: a when-only note survives a read, with its event words and its hand-over id', () => {
    assert.equal(allNotes.length, 51);
    assert.equal(allNotes.filter(note => note.when && !note.meter).length, 12, 'the fixture has twelve event-only notes');
    for (const entry of ERSVEIL) {
        const given = handedOver(entry.secrets);
        const read = normalizeSecrets(given);
        assert.equal(read.length, given.length, `${entry.id}: every note is kept, event-only ones included`);
        read.forEach((note, i) => {
            assert.equal(note.id, given[i].id, 'the cast dossier\'s id is kept');
            assert.equal(note.text, given[i].text);
            assert.equal(note.title, given[i].title);
            if (given[i].when) assert.equal(note.when, given[i].when, 'the event words are kept whole');
            if (given[i].meter) assert.deepEqual([note.meter, note.at], [given[i].meter, given[i].at]);
            else assert.deepEqual([note.meter, note.at], [undefined, undefined], 'an event-only note has no meter rule');
        });
        // The same notes as a pack gives them (no ids): kept too, with ids of their own that do not repeat.
        const raw = normalizeSecrets(entry.secrets);
        assert.equal(raw.length, entry.secrets.length);
        assert.equal(new Set(raw.map(note => note.id)).size, raw.length);
    }
    // The tail, the Secrets view and the scan's watch see the event-only notes as event notes.
    const only = normalizeSecrets(handedOver(allNotes.filter(note => note.when && !note.meter).slice(0, 1)))[0];
    assert.equal(only.meter, undefined);
    assert.match(only.when, /^after a night when/);
    // Delta's own record keeps the notes as handed over (the sidecar loses no `when`), so a reload reads the same notes.
    const kept = normalizeNpcRecord({ id: 'npc_x', name: 'Tansy', secrets: handedOver(ERSVEIL[0].secrets) });
    assert.deepEqual(normalizeSecrets(kept.secrets), normalizeSecrets(handedOver(ERSVEIL[0].secrets)));
    assert.ok(kept.secrets.some(note => note.when && !note.meter));
});

test('secrets from the cast: every real entry\'s notes round-trip through the dossier editor, event-only ones included', () => {
    for (const entry of ERSVEIL) {
        const notes = normalizeSecrets(handedOver(entry.secrets));
        const lines = secretsToLines(notes);
        assert.equal(lines.split('\n').length, notes.length, `${entry.id}: one line each`);
        const back = secretsFromLines(lines, notes);
        assert.deepEqual(back.problems, [], `${entry.id}: every line reads back`);
        assert.deepEqual(back.secrets, notes, `${entry.id}: same notes, same ids, same event words`);
        // Saved with no change from the editor (no `previous` to keep ids from), the notes keep their rules and words.
        const fresh = secretsFromLines(lines).secrets;
        // (typed again from the box, a note has no earlier note to say what it came from: it is the reader's)
        assert.deepEqual(fresh.map(({ id, ...rest }) => rest), notes.map(({ id, from, ...rest }) => rest));
        assert.equal(new Set(fresh.map(note => note.id)).size, fresh.length);
    }
    const eventLine = secretsToLines(normalizeSecrets(handedOver(allNotes.filter(note => note.when && !note.meter).slice(0, 1))));
    assert.match(eventLine, /^when after a night when the party and Tansy work through casualties together => \[The cellar guest\] /);
});

test('secrets from the cast: a mixed list (meter, event-only, both) is read, edited and kept; a long list is held to eight', async () => {
    const mixed = handedOver([
        ...ERSVEIL[0].secrets,
        { title: 'Either way', text: 'Opens by trust or by the story, whichever comes first.', meter: 'trust', at: 70, when: 'she is told the truth about the ferry' },
    ]);
    const notes = normalizeSecrets(mixed);
    assert.deepEqual(notes.map(note => [note.meter ?? null, note.at ?? null, Boolean(note.when)]), [['trust', 15, false], ['trust', 35, false], [null, null, true], ['trust', 60, false], ['trust', 70, true]]);
    const lines = secretsToLines(notes);
    assert.match(lines, /^trust 15: \[The eleven names\]/m);
    assert.match(lines, /^trust 70 or when she is told the truth about the ferry => \[Either way\]/m);
    assert.deepEqual(secretsFromLines(lines, notes).secrets, notes);
    // The reader changes one line (a new id for it), adds an event note, and the rest keeps what it had.
    const edited = secretsFromLines(`${lines.replace('trust 15:', 'trust 10:')}\nwhen the barge is found => A new note.`, notes);
    assert.deepEqual(edited.problems, []);
    assert.equal(edited.secrets.length, 6);
    assert.equal(edited.secrets[1].id, notes[1].id, 'an unchanged note keeps its id');
    assert.equal(edited.secrets[2].id, notes[2].id, 'so does an unchanged event note');
    assert.notEqual(edited.secrets[0].id, notes[0].id, 'a changed rule is a new note');
    // More than eight: the pack and the reader keep eight.
    assert.equal(normalizeSecrets(handedOver(ERSVEIL.flatMap(entry => entry.secrets))).length, MAX_SECRETS);
    assert.equal(secretsFromLines(secretsToLines(normalizeSecrets(handedOver(ERSVEIL.flatMap(entry => entry.secrets))))).secrets.length, MAX_SECRETS);

    // On the real host: a cast person with a mixed list. Meter notes open by meter, event-only ones wait for the story.
    const delta = fakeDelta();
    delta.records.npc_mira.secrets = normalizeSecrets(handedOver(ERSVEIL[3].secrets));
    const given = delta.records.npc_mira.secrets;
    assert.ok(given.some(note => !note.meter) && given.some(note => note.meter), 'a mixed person');
    const h = await host({ delta });
    h.reply('Nice.', '~ npc Mira | trust: +15');
    const meterNotes = given.filter(note => note.meter);
    const eventNotes = given.filter(note => !note.meter);
    const cast = h.runQuery('npc.cast').find(entry => entry.key === 'mira');
    assert.equal(cast.locked.length + cast.opened.length, given.length, 'every note is on the card, event-only ones too');
    assert.deepEqual(cast.locked.filter(note => note.event).map(note => note.opens), eventNotes.map(() => 'Opens with the story'));
    const tail = h.def.context.tail(h.view());
    const sentLines = [...plain(tail.lines), ...tail.optional];
    for (const note of given) assert.ok(sentLines.some(line => line.includes(note.text)), `sent while she is here: ${note.title}`);
    assert.equal(h.adapter.eventWatch(Object.values(delta.records)).length, Math.min(3, eventNotes.length), 'the scan watches the event-only notes (three at most)');
    assert.equal(meterNotes.length + eventNotes.length, given.length);
    // A story event opens an event-only note; a swipe takes it back.
    const target = eventNotes[0];
    const { index } = h.reply('It happens.', '');
    assert.equal((await h.adapter.openByEvent({ name: 'Mira', ids: [target.id] })).ok, true);
    assert.ok(h.npc('Mira').unlocked.includes(target.id));
    h.swipe(index, '');
    assert.equal(h.npc('Mira').unlocked.includes(target.id), false);
});

test('secrets: redactSent takes a part\'s whole multi-line text and redacts every locked line, leaving the rest as it is', async () => {
    const h = await host();
    const hide = h.def.hooks.redactSent;
    const secret = 'Trust me: she is the heir; hidden: never state or reveal'; // text that itself looks like the wording
    const text = [
        'NPC meters now: Mira trust 25, affection 0, desire 0, tension 0.',
        `Mira, known to the player now; may come out: ${SECRET}`,
        `Mira, hidden: never state or reveal; let it shape how they act: ${SECRET_TWO}`,
        '',
        `Oren, Duke of the Marches, hidden: never state or reveal; let it shape how they act: ${secret}`,
        `Mira, hidden: never state or reveal; let it shape how they act: ${SECRET}`,
        `Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.`,
        `Mira (hidden): ${SECRET_TWO}`,
        'A line that merely says hidden: never state or reveal.',
    ].join('\n');
    const shown = hide(text);
    assert.deepEqual(shown.split('\n'), [
        'NPC meters now: Mira trust 25, affection 0, desire 0, tension 0.',
        `Mira, known to the player now; may come out: ${SECRET}`,
        'Mira: 1 hidden note',
        '',
        'Oren, Duke of the Marches: 1 hidden note',
        'Mira: 1 hidden note',
        'Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.',
        'Mira: 1 hidden note',
        'A line that merely says hidden: never state or reveal.',
    ], 'four locked lines redacted wherever they stand; blank and other lines untouched');
    for (const locked of [SECRET_TWO, secret]) assert.equal(shown.includes(locked), false);
    assert.equal(hide(shown), shown, 'redacting again changes nothing');
    // Line breaks of either kind are kept.
    assert.equal(hide(`a\r\nMira, hidden: never state or reveal; let it shape how they act: ${SECRET}\r\nb`), 'a\r\nMira: 1 hidden note\r\nb');
    assert.equal(hide(`Mira, hidden: never state or reveal; let it shape how they act: ${SECRET}`), 'Mira: 1 hidden note', 'a single line');
    // A text with no locked line is returned as it is, whatever it is.
    for (const plain of ['', 'x', 'one\ntwo\n', h.def.context.static()]) assert.equal(hide(plain), plain);
    assert.equal(hide(null), '');
    // The very text the host builds, through the host's own assembler: nothing locked survives, everything else does.
    h.reply('Nice.', '~ npc Mira | trust: +25');
    const part = assemble({ registry: h.registry, view: h.view(), settings: { tailBudget: 1500 } }).parts.find(item => item.module === MODULE_ID && item.place === 'tail');
    const out = hide(part.text);
    const was = part.text.split('\n');
    const now = out.split('\n');
    assert.equal(now.length, was.length, 'same number of lines');
    was.forEach((line, i) => assert.equal(now[i], /^Mira \(hidden\): /.test(line) ? 'Mira: 1 hidden note' : line));
    assert.equal(now.filter(line => line === 'Mira: 1 hidden note').length, 2);
});

// ---- the dossier editor shows no locked note it did not write ----

const shownIn = (html, value) => html.includes(value) || html.includes(escapeHtml(value));

test('editor: every locked note of the 12 real entries is only "Hidden note n · opens …" (no title, text or event words anywhere in the form)', async () => {
    for (const entry of ERSVEIL) {
        const delta = fakeDelta();
        delta.records.npc_mira.secrets = normalizeSecrets(handedOver(entry.secrets));
        delta.records.npc_mira.relationship.trust = -50;
        const h = await host({ delta });
        h.reply('Nice.', '~ npc Mira | tension: +1');
        const html = h.adapter.editorHtml(delta.records.npc_mira);
        for (const note of entry.secrets) {
            for (const secret of [note.title, note.text, note.when].filter(Boolean)) assert.equal(shownIn(html, secret), false, `${entry.id}: "${secret.slice(0, 40)}" is not in the form`);
            // Not even the first words (a title or a text cut short).
            assert.equal(shownIn(html, note.text.slice(0, 24)), false);
        }
        const rows = [...html.matchAll(/<span>(Hidden note \d+ · opens [^<]*)<\/span><select[^>]*aria-label="(Hidden note \d+)"/g)];
        assert.equal(rows.length, entry.secrets.length, `${entry.id}: one row per hidden note`);
        rows.forEach((row, i) => {
            assert.match(row[1], new RegExp(`^Hidden note ${i + 1} · opens (?:at \\w+ -?\\d+|with the story)$`));
            assert.equal(row[2], `Hidden note ${i + 1}`);
        });
        assert.match(html, /<textarea id="npc_state_delta_edit_secrets"[^>]*><\/textarea>/, 'the box is empty: nothing of the reader\'s own and nothing opened');
        assert.equal((html.match(/data-delta-secret=/g) || []).length, entry.secrets.length, 'every note keeps its open/shut control');
    }
});

test('editor: pack and scan notes stay hidden while locked; an older note with no marker is the reader\'s, shown and editable', async () => {
    const delta = fakeDelta();
    const generated = normalizeGeneratedSecrets([
        { title: 'Generated layer', text: 'A generated secret text.', meter: 'trust', at: 50, from: 'reader' },
        { title: 'Generated event', text: 'A generated event text.', when: 'something happens in the story', from: '' },
    ]);
    assert.deepEqual(generated.map(note => note.from), ['scan', 'scan'], 'a model cannot choose what a note says it came from');
    const packed = normalizeSecrets([{ title: 'Packed', text: 'A pack\'s secret text.', meter: 'trust', at: 60, from: 'pack' }]);
    assert.equal(packed[0].from, 'pack');
    assert.equal(normalizeSecrets([{ text: 'x', meter: 'trust', at: 1, from: 'reader' }, { text: 'y', meter: 'trust', at: 2, from: { a: 1 } }]).some(note => 'from' in note), false, 'only "pack" and "scan" are kept');
    const old = normalizeSecrets([{ title: 'Mine', text: 'I wrote this one in an older version.', meter: 'trust', at: 70 }])[0];
    assert.equal('from' in old, false);
    const opened = normalizeSecrets([{ title: 'Known', text: 'Already open to the player.', meter: 'trust', at: 5, from: 'pack' }])[0];
    delta.records.npc_mira.secrets = [...generated, ...packed, old, opened];
    const h = await host({ delta });
    h.reply('Nice.', '~ npc Mira | tension: +1');
    assert.deepEqual(h.npc('Mira').unlocked, [opened.id]);
    const html = h.adapter.editorHtml(delta.records.npc_mira);
    for (const secret of ['Generated layer', 'A generated secret text.', 'Generated event', 'A generated event text.', 'something happens in the story', 'Packed', 'A pack\'s secret text.']) assert.equal(shownIn(html, secret), false, secret);
    for (const secret of ['I wrote this one in an older version.', 'Already open to the player.']) assert.equal(shownIn(html, secret), true, `${secret} is shown`);
    assert.match(html, /<span>Hidden note 1 · opens at Trust 50<\/span>/);
    assert.match(html, /<span>Hidden note 2 · opens with the story<\/span>/);
    assert.match(html, /<span>Hidden note 3 · opens at Trust 60<\/span>/);
    assert.equal((html.match(/Hidden note \d/g) || []).length, 6, 'three rows, each named twice (row and control)');
    // The older note is editable: its line is in the box; changing it saves the change, and the hidden ones are untouched.
    const values = new Map([['npc_state_delta_edit_secrets', secretsToLines([old, opened]).replace('older version', 'newer version')]]);
    const saved = h.adapter.readEditor(key => values.get(key), delta.records.npc_mira);
    const mine = saved.secrets.find(note => note.text.includes('newer version'));
    assert.ok(mine, 'the edited line is saved');
    assert.equal('from' in mine, false, 'still the reader\'s');
    assert.equal(saved.secrets.some(note => note.text.includes('older version')), false);
    for (const note of [...generated, ...packed]) assert.deepEqual(saved.secrets.find(item => item.id === note.id), note, 'hidden notes exactly as they were');
});

test('editor: saving keeps every hidden note exactly as it was (ids and raw words), adds the reader\'s own, and applies a Hidden/Opened choice', async () => {
    const delta = fakeDelta();
    const longWhen = 'after a night when the party and Tansy work through casualties together and the river rises again ok';
    const packed = handedOver([...ERSVEIL[0].secrets, { title: 'Long', text: 'T'.repeat(200), when: `${longWhen} ${'x'.repeat(70)}` }]);
    const opened = normalizeSecrets([{ title: 'Known', text: 'Already open to the player.', meter: 'trust', at: 5, from: 'pack' }])[0];
    delta.records.npc_mira.secrets = [packed[0], opened, ...packed.slice(1)];
    const h = await host({ delta });
    h.reply('Nice.', '~ npc Mira | tension: +1');
    const dossier = delta.records.npc_mira;
    const html = h.adapter.editorHtml(dossier);
    const box = escapeHtml('trust 5: [Known] Already open to the player.');
    assert.ok(html.includes(`>${box}</textarea>`), 'only the opened note is in the box');
    const values = new Map([['npc_state_delta_edit_secrets', 'trust 5: [Known] Already open to the player.\nwhen the barge is found => [Mine] A note I wrote.']]);
    const edits = h.adapter.readEditor(key => values.get(key), dossier);
    assert.deepEqual(edits.problems, []);
    const ids = edits.secrets.map(note => note.id);
    assert.deepEqual(ids.slice(0, 1), [packed[0].id], 'order kept');
    for (const note of packed) assert.deepEqual(edits.secrets.find(item => item.id === note.id), note, `${note.title}: exactly as it was, whatever its length`);
    assert.deepEqual(edits.secrets.find(item => item.id === opened.id), opened, 'an opened note left alone is the note it was (not the reader\'s)');
    const mine = edits.secrets.at(-1);
    assert.deepEqual([mine.when, mine.title, 'from' in mine], ['the barge is found', 'Mine', false], 'a line written here is the reader\'s: no marker');
    assert.equal(edits.secrets.length, packed.length + 2);
    // The reader deletes the opened line: it goes; the hidden ones stay.
    values.set('npc_state_delta_edit_secrets', '');
    const cleared = h.adapter.readEditor(key => values.get(key), dossier);
    assert.deepEqual(cleared.secrets.map(note => note.id), packed.map(note => note.id));
    // The hidden control: open the first hidden note by hand.
    values.set(`npc_state_delta_edit_secret_state_${packed[0].id}`, 'open');
    const moved = h.adapter.readEditor(key => values.get(key), dossier);
    assert.deepEqual(moved.noteStates, { open: [packed[0].id], close: [] });
    await h.adapter.applyEditor('Mira', moved);
    assert.ok(h.npc('Mira').unlocked.includes(packed[0].id));
    // Now it is open, so the next editor shows it (the player knows it) and it is the pack's note still.
    dossier.secrets = moved.secrets;
    assert.equal(shownIn(h.adapter.editorHtml(dossier), packed[0].title), true);
    // At most eight in all: the hidden ones are never pushed out by the reader's lines.
    values.set('npc_state_delta_edit_secrets', Array.from({ length: 6 }, (_, i) => `when event ${i} => note ${i}`).join('\n'));
    const crowded = h.adapter.readEditor(key => values.get(key), dossier);
    assert.equal(crowded.secrets.length, MAX_SECRETS, 'eight in all: five hidden, three of the six new lines');
    // (the opened one was in the box, and the reader's box no longer lists it, so it is gone; every hidden one stays)
    for (const note of packed.slice(1)) assert.ok(crowded.secrets.some(item => item.id === note.id));
    assert.equal(crowded.secrets.some(item => item.id === packed[0].id), false);
    assert.match(crowded.problems.join(' '), /not kept/);
});

test('secrets view: blank bars take their lengths from a fixed set in turn, never from a note\'s text or length', async () => {
    const widths = async text => {
        const delta = fakeDelta();
        delta.records.npc_mira.secrets = [10, 20, 30, 40, 50].map(at => ({ title: `T${at}`, meter: 'trust', at, text: text.repeat(at) }));
        delta.records.npc_mira.relationship.trust = -50;
        const h = await host({ delta });
        h.reply('Nice.', '~ npc Mira | tension: +1');
        return h.adapter.dossierMeters(Object.values(delta.records)).npc_mira.secrets.map(note => note.width);
    };
    const short = await widths('a');
    const long = await widths('Quite different words, much longer. ');
    assert.deepEqual(short, long, 'the same whatever the text');
    assert.deepEqual(short, [62, 48, 56, 70, 62]);
});

// ---- a pack secret with both rules ("meter OR story event, whichever comes first") ----

// A real pack, validated by the vendored Story Block (which allows both rules on one secret), its cast read the way Delta reads
// `packs.content`, and the note shaped by castSecrets / normalizeSecrets.
function eitherNotes() {
    const checked = validatePack(JSON.stringify({
        id: 'either-pack', name: 'Either', version: '1.0.0', requires: { storyBlock: '>=2.15.0' },
        content: { cast: [{
            id: 'mira', name: 'Mira', about: 'A smith.', look: 'Broad, soot-streaked.', start: { place: 'The forge', goal: 'Keep the fire lit.' },
            secrets: [{ title: 'Either way', text: 'She forged the duke\'s seal.', meter: 'trust', at: 90, when: 'the party asks her about the seal' }],
        }] },
    }));
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    const [entry] = contentOf([checked.pack], 'cast');
    return normalizeSecrets(castSecrets(entry.secrets));
}

test('secrets from a pack: a note with both rules arrives with both, keeps them, and is shaped like any other pack note', () => {
    const [note] = eitherNotes();
    assert.deepEqual([note.meter, note.at, note.when, note.title, note.from], ['trust', 90, 'the party asks her about the seal', 'Either way', 'pack']);
    assert.match(note.id, /^sec_/);
    assert.equal(note.id, secretId('trust', 90, "She forged the duke's seal."), 'a meter note keeps the id it always had; the event does not change it');
    // The editor line round-trips with the id and the pack mark.
    const line = secretsToLines([note]);
    assert.equal(line, "trust 90 or when the party asks her about the seal => [Either way] She forged the duke's seal.");
    assert.deepEqual(secretsFromLines(line, [note]).secrets, [note]);
    assert.deepEqual(secretsFromLines(line).problems, []);
    // Left out of one rule it is still a note (the other rule alone); with neither it is dropped.
    assert.deepEqual(castSecrets([{ text: 'x', meter: 'trust', at: 5, when: '' }]).map(item => [item.meter, item.when ?? null]), [['trust', null]]);
    assert.deepEqual(castSecrets([{ text: 'x', meter: '', at: 5, when: 'an event' }]).map(item => [item.meter ?? null, item.when]), [[null, 'an event']]);
    assert.deepEqual(castSecrets([{ text: 'x', meter: 'trust' }]), []);
});

test('secrets from a pack: a both-rules note shows one wording while hidden, opens on the meter OR the story event, and is sent locked like any note', async () => {
    const WORDING = 'Opens at Trust 90 or with the story';
    const make = async () => {
        const delta = fakeDelta();
        delta.records.npc_mira.secrets = eitherNotes();
        const h = await host({ delta });
        h.reply('Nice.', '~ npc Mira | trust: +5');
        return { h, note: delta.records.npc_mira.secrets[0] };
    };

    // Hidden: one wording on the card, the event's words not shown; the story is told it as a locked note; the scan watches the event.
    const { h, note } = await make();
    const hidden = h.runQuery('npc.cast').find(entry => entry.key === 'mira');
    assert.deepEqual(hidden.locked.map(item => [item.id, item.meter, item.at, item.event, item.opens]), [[note.id, 'trust', 90, true, WORDING]]);
    assert.equal(hidden.locked[0].text, 'Hidden note · opens at Trust 90 or with the story');
    assert.equal(JSON.stringify(hidden).includes('the party asks her about the seal'), false, 'the event wording never reaches the card');
    const tail = h.def.context.tail(h.view());
    const sent = [...plain(tail.lines), ...tail.optional].filter(line => line.includes(note.text));
    assert.equal(sent.length, 1, 'sent once while she is here');
    assert.match(sent[0], /Mira \(hidden\): /, 'as a locked note, not as something she may say');
    assert.equal(h.adapter.eventWatch(Object.values(h.delta.records)).length, 1, 'the scan watches for the event');
    assert.deepEqual(h.npc('Mira').unlocked, []);

    // The meter crossing opens it (trust 15 to 90 in capped steps); the card says what opened it.
    for (let i = 0; i < 4; i += 1) h.reply('Nice.', '~ npc Mira | trust: +15');
    assert.deepEqual(h.npc('Mira').unlocked, [], 'still hidden below 90');
    h.reply('Nice.', '~ npc Mira | trust: +15');
    assert.ok(h.npc('Mira').meters.trust >= 90);
    assert.deepEqual(h.npc('Mira').unlocked, [note.id], 'the meter opens it');
    const byMeter = h.runQuery('npc.cast').find(entry => entry.key === 'mira');
    assert.deepEqual([byMeter.locked.length, byMeter.opened.map(item => item.text)], [0, ['Opened · Trust 90']]);
    assert.equal(h.adapter.eventWatch(Object.values(h.delta.records)).length, 0, 'once open the scan stops watching');

    // The story event opens it with the meter far below 90; a swipe takes it back.
    const other = await make();
    const { index } = other.h.reply('It happens.', '');
    assert.ok(other.h.npc('Mira').meters.trust < 90);
    assert.equal((await other.h.adapter.openByEvent({ name: 'Mira', ids: [other.note.id] })).ok, true);
    assert.deepEqual(other.h.npc('Mira').unlocked, [other.note.id], 'the event opens it');
    assert.deepEqual(other.h.runQuery('npc.cast').find(entry => entry.key === 'mira').opened.map(item => item.text), ['Opened · with the story']);
    other.h.swipe(index, '');
    assert.deepEqual(other.h.npc('Mira').unlocked, []);
});
