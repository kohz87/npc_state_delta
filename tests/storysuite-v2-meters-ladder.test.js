import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHost } from './vendor/story-block/testkit/index.js';
import { compileTemplate } from './vendor/story-block/src/v2/view/template/index.js';
import { validateScreen } from './vendor/story-block/src/v2/view/screens.js';
import { MODULE_ID, createStorySuiteV2Adapter, meterBarNode } from '../src/storysuite-v2.js';
import {
    DEFAULT_CHANGE_CAP, FEATURE_DRIFT, FEATURE_PRESETS, FEATURE_STAGES, bandWord, createNpcPart, limitsFromLines, limitsToLines, normalizeMeterSettings,
    parseBands, parseNeeds, secretId, secretsFromLines, secretsToLines, validateNpcSlice,
} from '../src/npc-meters.js';
import { BUILT_IN_PRESETS, presetCatalog } from '../src/npc-meters-presets.js';
import { metersCardScreen } from '../src/npc-meters-screen.js';
import { withSectionHtml } from '../dossier-ui-sections.js';
import { lastRelationshipChangeHtml, projectDossierState, v2MetersHtml, v2MetersProjection, v2SecretsHtml } from '../dossier-ui.js';
import { fakeRoot } from './helpers/fake-dom.js';
import { fakeDocument } from './helpers/fake-dom.js';
import { runtimeSource } from './helpers/runtime-source.js';
import { NO_REASON, recentChangeRowHtml, relationshipHistoryHtml } from '../dossier-ui-relationship.js';
import { storyMinuteText } from '../calendar.js';
import { cutWords, eventLog, eventSummary, movesOf, nextEvent, readEvent, withEvidence } from '../src/npc-meters-pacing.js';
import { logKept, reasonKept } from '../src/npc-meters-slice.js';

// TRS ideas 1-4 on the NPC meters (stage ladders with several needs and milestones, per-NPC ceilings
// and floors, fuller custom meters with presets and drift, locked-note teasers), against Story
// Block's whole host from its testkit (tests/vendor/story-block, see its VERSION): real capture, real
// turns and the host's 'turn' event that carries Delta's per-reply step. Delta's runtime is a fake.

const SECRET = 'She was the lost heir of House Venn.';
const LADDER = [
    { name: 'Friend', needs: 'trust 20' },
    { name: 'Confidant', needs: 'trust 60, affection 40', milestone: 'saved her brother' },
];

function dossiers() {
    return {
        npc_mira: {
            id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], present: true, archived: false,
            relationship: { trust: 10, affection: 0, desire: 0, tension: 0 },
            secrets: [{ id: secretId('trust', 30, SECRET), meter: 'trust', at: 30, text: SECRET, title: 'Her past' }],
        },
        npc_oren: { id: 'npc_oren', name: 'Oren', aliases: [], present: true, archived: false, relationship: { trust: 0, affection: 0, desire: 0, tension: 0 } },
    };
}

/**
 * A whole Story Block host with Delta's adapter registered on it. `features`: { id: bool }, the
 * reader's choices in Story Block's Features; `modules`: more module definitions.
 */
async function suite({ settings = {}, records = dossiers(), features = null, modules = [], doc = null, wrap = false, packs = [], apiExtra = {} } = {}) {
    // The reader's feature choices live in extension_settings.storySuite.features (Story Block's
    // Features), installed packs in extension_settings.storySuite.packs.
    const installed = packs.map(pack => ({ id: pack.id, version: pack.version, enabled: true, source: 'file', origin: `${pack.id}.json`, pack: structuredClone(pack) }));
    const host = await createHost({ settings: { modules: { [MODULE_ID]: structuredClone(settings) }, ...(features ? { features: { ...features } } : {}), ...(installed.length ? { packs: installed } : {}) }, modules });
    // `wrap`: an sdk copy a test may add to (the host's own is frozen).
    const sdk = wrap ? Object.assign(Object.create(Object.getPrototypeOf(host.sdk)), host.sdk) : host.sdk;
    const box = { ready: Promise.resolve(sdk), sdk };
    const delta = { records, enabled: true };
    const api = {
        isEnabled: () => delta.enabled,
        getNpc: id => (delta.records[id] ? structuredClone(delta.records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        presentCastHtml: () => '<section class="cast">cast</section>',
        castEmptyReason: () => ({ text: 'Nobody here.' }),
        fillPresentCast: () => {},
        ...apiExtra,
    };
    const warnings = [];
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(delta.records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box,
        headReply: () => host.store.headIndex(),
        doc: doc ?? { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn: (...args) => warnings.push(args.join(' ')) }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true, 'the adapter registers');
    const block = lines => (lines.length ? `\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : '');
    /** One reply with these change lines; waits for Delta's per-reply step. → the reply's index. */
    const say = async (lines = [], text = 'The story goes on.') => {
        await host.send('And then?', `${text}${block(lines)}`);
        await adapter.ticked();
        return host.store.headIndex();
    };
    const swipe = async (lines = []) => { await host.swipe(`Another way.${block(lines)}`); await adapter.ticked(); };
    const regenerate = async (lines = []) => { await host.regenerate(`Again.${block(lines)}`); await adapter.ticked(); };
    const npc = name => host.sdk.query('npc.meters', { name });
    const receipts = () => host.store.receipts().map(item => item.receipt);
    const setSettings = next => { host.ctx.extensionSettings.storySuite.modules[MODULE_ID] = structuredClone(next); };
    const def = host.registry.module(MODULE_ID);
    const view = () => ({ state: host.head(), chat: { length: host.ctx.chat.length } });
    return { host, sdk, adapter, delta, warnings, say, swipe, regenerate, npc, receipts, setSettings, def, view };
}

const lastReceipt = (s, type) => s.receipts().filter(receipt => receipt.type === type).at(-1);

// ---- 1. stages with several needs and a milestone ----

test('ladder: a rung needs every meter at once plus its milestone; code promotes and tells the next reply', async () => {
    const s = await suite({ settings: { ladder: LADDER } });
    await s.say(['~ npc Mira | trust: +12']);
    assert.equal(s.npc('Mira').rank, 'Friend', 'trust 22: the first rung');
    assert.equal(s.receipts().some(receipt => receipt.summary.includes('Mira: now Friend') && receipt.narrate), true);
    for (let i = 0; i < 3; i += 1) await s.say(['~ npc Mira | trust: +15 | affection: +15']);
    assert.deepEqual([s.npc('Mira').meters.trust, s.npc('Mira').meters.affection], [67, 45]);
    assert.equal(s.npc('Mira').rank, 'Friend', 'the numbers alone are not enough: Confidant needs its milestone');
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).text, 'Next: Confidant — milestone “saved her brother”');
    await s.say(['+ milestone Mira — saved her brother']);
    assert.equal(s.npc('Mira').rank, 'Confidant');
    assert.deepEqual(s.npc('Mira').milestones, { 'saved-her-brother': 'saved her brother' });
    const receipt = lastReceipt(s, 'capture.milestone');
    assert.match(receipt.summary, /^Mira: now Confidant\. Mira: milestone “saved her brother”\./);
    assert.equal(receipt.narrate, true);
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).next, null, 'the top of the ladder');
});

test('milestones: added once by key, never taken away by the story; the reader edits them; nothing in the prompt', async () => {
    const s = await suite({ settings: { ladder: LADDER } });
    const statics = s.def.context.static();
    await s.say(['+ milestone Mira — Saved her brother!']);
    await s.say(['+ milestone Mira — saved  her brother', '- milestone Mira — saved her brother', '+ milestone Mira']);
    const problems = s.host.turn.problems().map(problem => `${problem.code}: ${problem.message}`);
    assert.ok(problems.some(text => /REFUSED: .*Mira already has the milestone “Saved her brother!”/.test(text)), `the same words again are one milestone: ${problems.join(' | ')}`);
    assert.ok(problems.some(text => /REFUSED: .*A milestone is only ever added/.test(text)));
    assert.ok(problems.some(text => /INVALID: .*The line names no milestone/.test(text)));
    assert.deepEqual(s.npc('Mira').milestones, { 'saved-her-brother': 'Saved her brother!' });
    assert.equal(s.def.context.static(), statics, 'the static part does not move');
    assert.doesNotMatch(JSON.stringify(s.def.context.tail(s.view())), /brother/, 'a milestone writes nothing to the tail by itself');
    const added = await s.sdk.command('npc.milestone', { name: 'Mira', add: ['Kept the oath'], remove: ['saved her brother'] });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(s.npc('Mira').milestones, { 'kept-the-oath': 'Kept the oath' });
    const same = await s.sdk.command('npc.milestone', { name: 'Mira', add: ['kept the oath'] });
    assert.equal(same.code, 'REFUSED');
});

test('ladder: no promotion while a conflict is on (tension above the threshold); it comes once tension falls', async () => {
    const s = await suite({ settings: { ladder: LADDER, conflictAt: 30 } });
    await s.say(['~ npc Oren | tension: +15']);
    await s.say(['~ npc Oren | tension: +15 | trust: +15']);
    await s.say(['~ npc Oren | trust: +10']);
    assert.equal(s.npc('Oren').meters.tension, 30);
    assert.equal(s.npc('Oren').rank, 'Friend', 'tension 30 is not above 30');
    await s.say(['~ npc Oren | tension: +5']);
    for (let i = 0; i < 3; i += 1) await s.say(['~ npc Oren | trust: +15 | affection: +15']);
    await s.say(['+ milestone Oren — saved her brother']);
    assert.equal(s.npc('Oren').rank, 'Friend', 'the conflict holds Confidant back');
    assert.match(lastReceipt(s, 'capture.milestone').summary, /Confidant waits while tension is above 30/);
    assert.match(s.host.sdk.query('npc.next', { name: 'Oren' }).text, /^Next: Confidant — waits while tension is above 30/);
    await s.say(['~ npc Oren | tension: -10']);
    assert.equal(s.npc('Oren').rank, 'Confidant', 'tension 25: promoted on that line');
});

test('ladder: a rung is lost only after its needs failed N replies in a row; a recovery resets the count', async () => {
    const s = await suite({ settings: { ladder: LADDER, demoteAfter: 3 } });
    await s.say(['~ npc Mira | trust: +12']);
    assert.equal(s.npc('Mira').rank, 'Friend');
    await s.say(['~ npc Mira | trust: -5']);
    assert.equal(s.npc('Mira').rank, 'Friend', 'one reply low');
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk.replies, 1);
    await s.say();
    assert.match(s.host.sdk.query('npc.next', { name: 'Mira' }).text, /Friend slipping — trust 17\/20 \(2\/3 replies\)/);
    await s.say(['~ npc Mira | trust: +5']);
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk, null, 'recovered: the count is gone');
    await s.say(['~ npc Mira | trust: -5']);
    await s.say();
    assert.equal(s.npc('Mira').rank, 'Friend', 'two replies low after the recovery');
    await s.say();
    assert.equal(s.npc('Mira').rank, undefined, 'the third reply in a row takes it');
    const tick = lastReceipt(s, 'npc.tick');
    assert.match(tick.summary, /Mira: no longer Friend/);
    assert.equal(tick.narrate, true);
    assert.equal(tick.cause, 'ui', 'Delta\'s own step after the reply, on that reply');
});

test('the per-reply step rolls back with its reply: a swipe or a regenerate never counts a reply twice', async () => {
    const s = await suite({ settings: { ladder: LADDER, demoteAfter: 3 } });
    await s.say(['~ npc Mira | trust: +12']);
    await s.say(['~ npc Mira | trust: -5']);
    await s.say();
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk.replies, 2);
    for (let i = 0; i < 4; i += 1) await s.swipe();
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk.replies, 2, 'each swipe has its own step');
    await s.regenerate();
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk.replies, 2);
    assert.equal(s.npc('Mira').rank, 'Friend');
    await s.host.st.swipeTo(s.host.store.headIndex(), 0);
    assert.equal(s.host.sdk.query('npc.next', { name: 'Mira' }).risk.replies, 2);
    const head = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), head, 'replay equals the live state');
    // A button cannot take the step.
    const out = await s.host.sdk.command('npc.tick', {});
    assert.equal(out.code, 'REFUSED');
});

// ---- 2. per-NPC ceilings and floors ----

test('limits: growth stops at the ceiling, a fall at the floor; a change back always lands; the reader may go past', async () => {
    const records = dossiers();
    records.npc_mira.meterSetup = { limits: { affection: { ceiling: 30 }, trust: { floor: 0 } } };
    const s = await suite({ records });
    await s.say(['~ npc Mira | affection: +15']);
    await s.say(['~ npc Mira | affection: +15']);
    await s.say(['~ npc Mira | affection: +15 | trust: -15']);
    assert.deepEqual([s.npc('Mira').meters.affection, s.npc('Mira').meters.trust], [30, 0]);
    assert.match(lastReceipt(s, 'capture.npc').summary, /affection 30 → 30 \(held at 30, at the ceiling; \+15 asked\), trust 10 → 0 \(held at 0, at the floor; -15 asked\)/);
    await s.say(['~ npc Mira | affection: -12 | trust: +5']);
    assert.deepEqual([s.npc('Mira').meters.affection, s.npc('Mira').meters.trust], [18, 5], 'away from a limit, a change lands in full');
    await s.sdk.command('npc.set', { name: 'Mira', meters: { affection: 50 } });
    assert.equal(s.npc('Mira').meters.affection, 50, 'the reader\'s own value may pass the ceiling');
    await s.say(['~ npc Mira | affection: +5']);
    assert.equal(s.npc('Mira').meters.affection, 50, 'never pulled down to the ceiling, never raised past it');
    await s.say(['~ npc Mira | affection: -5']);
    assert.equal(s.npc('Mira').meters.affection, 45, 'a loss lands from where it is');
    // Delta's scanner is held the same way.
    await s.adapter.adjust({ name: 'Mira', meters: { affection: 9 }, reply: s.host.store.headIndex() });
    assert.equal(s.npc('Mira').meters.affection, 45);
});

test('limits from a preset: the Mentor keeps desire at 0; the NPC\'s own limit wins over the preset\'s', async () => {
    const records = dossiers();
    records.npc_mira.meterSetup = { track: 'mentor' };
    records.npc_oren.meterSetup = { track: 'mentor', limits: { desire: { ceiling: 10 } } };
    const s = await suite({ records, settings: { presets: ['mentor'] } });
    await s.say(['~ npc Mira | desire: +10 | approval: +15', '~ npc Oren | desire: +15']);
    assert.equal(s.npc('Mira').meters.desire, 0);
    assert.equal(s.npc('Oren').meters.desire, 10);
    assert.equal(s.npc('Mira').meters.approval, 25, 'the preset\'s meter, from its start');
    assert.equal(s.npc('Mira').rank, 'Student', 'the preset\'s ladder runs for the NPCs given it');
    assert.equal(s.host.sdk.query('npc.cast').find(entry => entry.key === 'mira').bars.find(bar => bar.id === 'desire').ceiling, 0);
});

test('limits as editor lines read back; bad lines are problems', () => {
    const { limits, problems } = limitsFromLines('trust: floor -20, ceiling 60\naffection: max 40\nnot a limit\ndesire: ceiling 5, floor 9');
    assert.deepEqual(limits, { trust: { ceiling: 60, floor: -20 }, affection: { ceiling: 40 } });
    assert.deepEqual(problems, ['not a limit', 'desire: ceiling 5, floor 9']);
    assert.equal(limitsToLines(limits), 'trust: floor -20, ceiling 60\naffection: ceiling 40');
    assert.deepEqual(limitsFromLines(limitsToLines(limits)).limits, limits);
});

// ---- 3. fuller custom meters ----

test('custom meters: the rule line goes in the static part only while presets and rules are on; band words go in the tail', () => {
    const settings = { customMeters: [{ name: 'Loyalty', min: 0, max: 100, describe: 'rises when you keep promises.', bands: 'doubtful 25, steady 60, devoted' }] };
    const make = presets => createNpcPart({ settings: () => settings, present: () => ['Mira'], feature: id => (id === FEATURE_PRESETS ? presets : id === 'npc-state-delta.anti-lever' ? false : undefined) });
    const on = make(true).context.static();
    const off = make(false).context.static();
    assert.match(on, / Meter rules: loyalty rises when you keep promises\.$/);
    assert.equal(off, 'NPC meters: trust, affection, desire, tension (-100..100), loyalty (0..100). When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most 15 a reply and sets the stages; never write a stage. Add | why: what caused it.');
    assert.equal(on.startsWith(off.slice(0, -1)), true, 'the rule line is added at the end');
    const state = { domains: { npc: { problems: [], npcs: { mira: { name: 'Mira', meters: { trust: 5, affection: 0, desire: 0, tension: 0, loyalty: 61 }, stages: {}, unlocked: [], turn: { reply: 2, from: {} } } } } } };
    assert.deepEqual(make(true).context.tail({ state, chat: { length: 3 } }).lines.filter(line => typeof line === 'string'), ['NPC meters now: Mira trust 5, affection 0, desire 0, tension 0, loyalty devoted.']);
    assert.deepEqual(parseBands('doubtful 25, steady <= 60, devoted, 2bad, steady 99').map(band => [band.upTo, band.word]), [[25, 'doubtful'], [60, 'steady'], [99, 'steady'], [null, 'devoted']]);
    assert.equal(bandWord(parseBands('low 10, high'), 10), 'low');
    assert.equal(bandWord(parseBands('low 10, high'), 11), 'high');
    assert.equal(bandWord([], 11), '');
});

test('the static part stays byte-identical reply to reply with presets, rules, a ladder and milestones in use', async () => {
    const s = await suite({ settings: { presets: ['rival', 'companion'], ladder: LADDER, customMeters: [{ name: 'Awe', describe: 'rises with wonders' }] } });
    const first = s.def.context.static();
    assert.match(first, /awe \(0\.\.100\), respect \(0\.\.100\), rivalry \(0\.\.100\), loyalty \(0\.\.100\)/);
    assert.match(first, /Meter rules: awe rises with wonders; respect rises when you beat/);
    await s.say(['~ npc Mira | respect: +10 | trust: +15', '+ milestone Mira — saved her brother']);
    await s.say(['~ npc Oren | rivalry: +5']);
    assert.equal(s.def.context.static(), first);
    assert.doesNotMatch(first, /Mira|Oren|brother|Friend/);
});

test('drift: off by default; on, a drifting meter moves toward its resting value each story day (Story Director\'s clock)', async () => {
    // A stand-in for Story Director: its domain holds the story minutes, its query answers director.time.
    const clock = {
        id: 'zz-clock', name: 'Clock',
        domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
        commands: { 'zz.clock': (ctx, { minutes }) => { ctx.draft('director').time.minutes = minutes; return { summary: 'time passes' }; } },
        queries: { 'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }) },
    };
    const settings = { customMeters: [{ name: 'Mood', min: -50, max: 50, start: 0, drift: 4, driftTo: 0 }] };
    const off = await suite({ settings, modules: [clock] });
    await off.say(['~ npc Mira | mood: +15']);
    await off.host.sdk.command('zz.clock', { minutes: 3 * 1440 });
    await off.say();
    assert.equal(off.npc('Mira').meters.mood, 15, 'the drift feature is off by default');

    const s = await suite({ settings, modules: [clock], features: { [FEATURE_DRIFT]: true } });
    await s.say(['~ npc Mira | mood: +15']);
    assert.equal(s.npc('Mira').meters.mood, 15, 'the first step only notes the day');
    await s.host.sdk.command('zz.clock', { minutes: 2 * 1440 + 60 });
    await s.say();
    assert.equal(s.npc('Mira').meters.mood, 7, 'two days: 4 a day toward 0');
    assert.match(lastReceipt(s, 'npc.tick').summary, /Mira: mood 15 → 7 \(story days passed\)/);
    await s.say();
    assert.equal(s.npc('Mira').meters.mood, 7, 'the same day: no more');
    await s.host.sdk.command('zz.clock', { minutes: 10 * 1440 });
    await s.say();
    assert.equal(s.npc('Mira').meters.mood, 0, 'never past its resting value');
});

test('presets: the built-in three are plain; packs add theirs; the settings block turns one on in a click', async () => {
    assert.deepEqual(BUILT_IN_PRESETS.map(preset => preset.name), ['Companion', 'Rival', 'Mentor']);
    for (const preset of BUILT_IN_PRESETS) assert.doesNotMatch(JSON.stringify(preset), /lust|arous|sex|nsfw|erot/i);
    const catalog = presetCatalog([
        { id: 'pack.ersveil/knight', slug: 'knight', pack: 'ersveil', name: 'Sworn knight', meters: [{ name: 'Honour', describe: 'rises with oaths kept' }], ladder: [{ name: 'Squire', needs: 'honour 10' }] },
        { id: 'pack.x/empty', name: 'Nothing in it' },
        { id: 'pack.x/rival', name: 'Rival' },
    ]);
    assert.deepEqual(catalog.map(preset => preset.id), ['companion', 'rival', 'mentor', 'pack.ersveil/knight']);
    const normalized = normalizeMeterSettings({ presets: ['pack.ersveil/knight', 'nope'] }, { presets: catalog });
    assert.deepEqual(normalized.custom.map(def => [def.id, def.preset]), [['honour', 'pack.ersveil/knight']]);
    assert.deepEqual(normalized.ladder['pack.ersveil/knight'].map(step => step.name), ['Squire']);

    // The settings section's block: Use writes only the `presets` setting.
    const stored = {};
    const doc = fakeDom();
    const s = await suite({ doc });
    const el = doc.createElement('div');
    s.def.settings.section(el, { set: (key, value) => { stored[key] = value; }, values: () => ({ ...stored }) });
    const block = el.children[0];
    assert.equal(block.className, 'npc-state-delta-v2-presets');
    const rows = block.children.filter(node => node.className === 'npc-state-delta-v2-preset');
    assert.deepEqual(rows.map(row => row.dataset.preset), ['companion', 'rival', 'mentor']);
    rows[1].children[2].click();
    assert.deepEqual(stored, { presets: ['rival'] });
    const again = block.children.filter(node => node.className === 'npc-state-delta-v2-preset')[1].children[2];
    assert.equal(again.textContent, 'Stop using');
    again.click();
    assert.deepEqual(stored, { presets: [] });
});

// ---- 4. locked-note teasers ----

test('teasers: a locked note shows only that it is hidden and its rule (no title, no text, no icon); opened, its title and text', async () => {
    const s = await suite({ settings: { ladder: LADDER } });
    await s.say(['~ npc Mira | trust: +5']);
    const leaks = () => [
        JSON.stringify(s.host.sdk.query('npc.cast')), JSON.stringify(s.host.head()), s.def.context.static(),
        JSON.stringify(s.adapter.dossierMeters(Object.values(s.delta.records))),
    ].some(text => text.includes('lost heir') || text.includes('Her past'));
    const mira = () => s.host.sdk.query('npc.cast').find(entry => entry.key === 'mira');
    assert.deepEqual(mira().locked, [{ id: secretId('trust', 30, SECRET), meter: 'trust', at: 30, event: false, opens: 'Opens at Trust 30', text: 'Hidden note · opens at Trust 30' }]);
    assert.equal(leaks(), false);
    const el = fakeRoot();
    s.def.tabs[0].render(el);
    assert.match(el.innerHTML, /Hidden note · opens at Trust 30/);
    assert.doesNotMatch(el.innerHTML, /lost heir|Her past|🔒|🔓/);
    await s.say(['~ npc Mira | trust: +15']);
    assert.deepEqual(mira().locked, []);
    assert.deepEqual(mira().opened, [{ id: secretId('trust', 30, SECRET), title: 'Her past', text: 'Opened · Trust 30' }]);
    s.def.tabs[0].render(el);
    assert.match(el.innerHTML, /<b>Her past<\/b>: She was the lost heir of House Venn\./, 'once unlocked, the Cast tab shows it');
    assert.doesNotMatch(el.innerHTML, /🔒|🔓/);
    assert.ok(s.def.context.tail(s.view()).lines.includes(`Mira, known to the player now; may come out: ${SECRET}`));
});

test('teasers: editor lines carry an optional [title]; the id does not depend on it', () => {
    const { secrets } = secretsFromLines('trust 60: [Her past] She was the heir.\ntension -20: Hates the river.');
    assert.deepEqual(secrets.map(({ meter, at, title, text }) => ({ meter, at, title, text })), [
        { meter: 'trust', at: 60, title: 'Her past', text: 'She was the heir.' },
        { meter: 'tension', at: -20, title: undefined, text: 'Hates the river.' },
    ]);
    assert.equal(secrets[0].id, secretId('trust', 60, 'She was the heir.'), 'a title never locks a note again');
    assert.equal(secretsToLines(secrets), 'trust 60: [Her past] She was the heir.\ntension -20: Hates the river.');
});

// ---- 5. custom meters in the dossier view ----

test('the dossier view shows custom meters, the ladder line, milestones and teasers (escaped); nothing without a host', async () => {
    const s = await suite({ settings: { ladder: LADDER, customMeters: [{ name: '<Awe>', min: 0, max: 50 }] } });
    await s.say(['~ npc Mira | awe: +7 | trust: +12', '+ milestone Mira — saved her brother']);
    const views = s.adapter.dossierMeters(Object.values(s.delta.records));
    assert.deepEqual(Object.keys(views), ['npc_mira']);
    const projection = v2MetersProjection(views.npc_mira);
    assert.deepEqual(projection.bars.map(bar => [bar.id, bar.value, bar.max]), [['awe', 7, 50]], 'only the meters beyond the four axes');
    assert.equal(projection.rank, 'Friend');
    assert.deepEqual(projection.milestones, ['saved her brother']);
    const html = v2MetersHtml(projection);
    assert.match(html, /&lt;Awe&gt;/);
    assert.doesNotMatch(html, /<Awe>/);
    assert.match(html, /Next: Confidant — trust 22\/60, affection 0\/40/);
    assert.doesNotMatch(html, /Her past|Hidden note|🔒/, 'the notes are in their own Secrets section, not among the meters');
    const secrets = v2SecretsHtml(projection);
    assert.match(secrets, /Secrets <small class="delta-secrets-count">· 0 opened · 1 still hidden<\/small>/);
    assert.match(secrets, /delta-secret-bar[^>]*><\/span><span class="delta-secret-when">Opens at Trust 30<\/span>/);
    assert.doesNotMatch(secrets, /Her past|lost heir|🔒/, 'a hidden note is a bar and its rule');
    assert.equal(v2MetersHtml(v2MetersProjection(null)), '');
    assert.equal(v2SecretsHtml(v2MetersProjection(null)), '');
    s.adapter.stop();
    assert.deepEqual(s.adapter.dossierMeters(Object.values(s.delta.records)), {});
});

// ---- 6. meter bars with ss.meter's newer props ----

test('bars carry ceiling, ticks and the latest reply\'s delta; a host whose ss.meter lacks them gets them in the text', async () => {
    const records = dossiers();
    records.npc_mira.meterSetup = { limits: { trust: { ceiling: 70 } } };
    const s = await suite({ records, settings: { ladder: LADDER, stages: [{ meter: 'trust', at: 50, name: 'Close' }] } });
    await s.say(['~ npc Mira | trust: +12']);
    const bar = s.host.sdk.query('npc.cast').find(entry => entry.key === 'mira').bars.find(item => item.id === 'trust');
    assert.deepEqual(bar.ticks, [{ at: 20, label: 'Friend' }, { at: 50, label: 'Close' }, { at: 60, label: 'Confidant' }]);
    assert.equal(bar.ceiling, 70);
    assert.equal(bar.delta, 12);
    const html = meterBarNode(fakeDocument(), { id: 'trust', label: 'Trust', min: -100, max: 100, tone: 'info' }, 22, '', bar).serialize();
    assert.match(html, /npc-state-delta-v2-ceiling" style="--npc-state-delta-at: 0\.85"/);
    assert.match(html, /▲12/);
    assert.equal((html.match(/npc-state-delta-v2-tick/g) ?? []).length, 3);
    // A host that lists ss.meter's props without the new ones: the ceiling and the change go in the text.
    const old = await suite({ records, settings: { ladder: LADDER }, wrap: true });
    old.sdk.widgets = () => ({ 'ss.meter': { props: { value: {}, max: {}, min: {}, label: {}, tone: {}, text: {} } } });
    await old.say(['~ npc Mira | trust: +12']);
    const sdkCast = old.adapter.definition.queries['npc.cast'](old.host.head(), {});
    const folded = sdkCast.find(entry => entry.key === 'mira').bars.find(item => item.id === 'trust');
    assert.equal(folded.text, '22 · max 70 ▲12');
    assert.equal('ceiling' in folded || 'delta' in folded || 'ticks' in folded, false);
});

test('the NPC card template compiles cleanly and passes the screen check', () => {
    assert.deepEqual(compileTemplate(metersCardScreen.template).warnings, []);
    assert.deepEqual(validateScreen(metersCardScreen), []);
    assert.match(metersCardScreen.template, /data-each="n\.still as b"/);
    assert.match(metersCardScreen.template, /data-each="n\.locked as l">\{\{ l\.text \}\}/);
});

// ---- 7. features ----

test('features: stages off — no milestone line, no ladder, no step; a host without the Features API uses the defaults', async () => {
    const s = await suite({ settings: { ladder: LADDER }, features: { [FEATURE_STAGES]: false } });
    await s.say(['~ npc Mira | trust: +15', '+ milestone Mira — saved her brother']);
    assert.equal(s.npc('Mira').rank, undefined);
    assert.equal(s.npc('Mira').milestones, undefined);
    assert.ok(s.host.turn.problems().some(problem => problem.code === 'FEATURE_OFF'));
    assert.equal((await s.sdk.command('npc.milestone', { name: 'Mira', add: ['x'] })).code, 'FEATURE_OFF');
    assert.equal(s.receipts().some(receipt => receipt.type === 'npc.tick'), false);
    const plain = createNpcPart({});
    assert.deepEqual([FEATURE_STAGES, FEATURE_DRIFT, FEATURE_PRESETS].map(id => plain.featureOn(id)), [true, false, true]);
    // An older host warns about the newer fields and keeps the module.
    const older = await suite();
    assert.ok(older.host.registry.module(MODULE_ID));
});

test('parsing: needs read several ways; bad parts are left out', () => {
    assert.deepEqual(parseNeeds('trust 60, affection >= 40 and tension <= -10 & nonsense'), [
        { meter: 'trust', at: 60, below: false }, { meter: 'affection', at: 40, below: false }, { meter: 'tension', at: -10, below: true },
    ]);
    assert.deepEqual(parseNeeds({ trust: 5, Respect: -3 }), [{ meter: 'trust', at: 5, below: false }, { meter: 'respect', at: -3, below: true }]);
    const settings = normalizeMeterSettings({ ladder: [{ name: 'A', needs: 'nonsense' }, { name: 'B', needs: 'trust 5', track: '__proto__' }, { name: 'C', milestone: 'met' }, ...Array.from({ length: 12 }, (_, i) => ({ name: `R${i}`, needs: `trust ${i}` }))] });
    assert.deepEqual(Object.keys(settings.ladder), ['']);
    assert.equal(settings.ladder[''].length, 8, 'at most eight rungs a track');
    assert.equal(settings.ladder[''][0].name, 'C', 'a rung with only a milestone is fine; one with nothing is left out');
    assert.equal(Object.getPrototypeOf(settings.ladder), Object.prototype);
});

test('validation: the new fields are checked', () => {
    const base = { name: 'A', meters: {}, stages: {}, unlocked: [] };
    const check = extra => validateNpcSlice({ npcs: { a: { ...base, ...extra } }, problems: [] });
    assert.deepEqual(check({ milestones: { 'saved-her': 'saved her' }, rank: 'friend', low: 2, day: 3 }), []);
    assert.ok(check({ milestones: ['x'] }).length);
    assert.ok(check({ milestones: { 'Bad Key': 'x' } }).length);
    assert.ok(check({ rank: 'Not a key' }).length);
    assert.ok(check({ low: 0 }).length);
    assert.ok(check({ day: 1.5 }).length);
    assert.ok(check({ milestones: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`m${i}`, 'x'])) }).length);
});

// ---- 8. delete fuzz with the new lines ----

// A tiny deterministic generator (no Math.random): mulberry32.
function prng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), chance: p => next() < p, pick: list => list[Math.floor(next() * list.length)] };
}

// FUZZ_SEEDS="1-200" (or "5,17") runs those seeds (default 5, 17, 41); FUZZ_STEPS the steps (default 18).
const fuzzSeeds = (spec, fallback) => (spec ? spec.split(',').flatMap(part => { const [a, b] = part.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; }) : fallback);
for (const seed of fuzzSeeds(process.env.FUZZ_SEEDS, [5, 17, 41])) {
    test(`delete fuzz seed ${seed}: meters, milestones, via gate, notes kinds and the per-reply step over middle deletes; replay equals rebuild`, async t => {
        t.mock.method(console, 'warn', () => {});
        const records = dossiers();
        records.npc_mira.meterSetup = { limits: { affection: { ceiling: 50 } } };
        const s = await suite({ records, settings: { ladder: LADDER, demoteAfter: 2, presets: ['rival'] } });
        const r = prng(seed);
        // The set-up reply makes both entries; it is never deleted.
        await s.say(['~ npc Mira | trust: +1', '~ npc Oren | trust: +1']);
        const setup = s.host.store.headIndex();
        const own = new Map();   // record sid → the milestones that reply added
        for (let step = 0; step < (Number(process.env.FUZZ_STEPS) || 18); step += 1) {
            const lines = [];
            const marks = [];
            for (let n = r.int(1, 3); n > 0; n -= 1) {
                const who = r.pick(['Mira', 'Oren']);
                switch (r.int(0, 9)) {
                    // The gate's `via:` (a repeat gives less, then backfires) and the notes kinds (lie, know, taste, tie), also under middle deletes.
                    case 5: lines.push(`~ npc ${who} | affection: +${r.int(1, 9)} | via: ${r.pick(['praise', 'gift', 'help', 'flirt', 'threat', 'shared-danger'])} | impact: ${r.pick(['ordinary', 'major'])}`); break;
                    case 6: lines.push(r.chance(0.5) ? `~ lie ${who} | to: ${r.pick(['Mira', 'Oren', 'Astra'])} | said: not me ${r.int(0, 3)}` : `~ lie ${who} | to: ${r.pick(['Mira', 'Oren', 'Astra'])} | caught: yes`); break;
                    case 7: lines.push(`~ know ${who} | about: ${r.pick(['Mira', 'Oren', 'Astra', 'Brann'])} | fact: keeps a ledger ${r.int(0, 3)} | ${r.pick(['how: saw | secret: yes', 'how: heard', 'told: yes'])}`); break;
                    case 8: lines.push(`~ taste ${who} | ${r.pick(['likes', 'dislikes'])}: ${r.pick(['tea', 'toffee', 'rain'])}`); break;
                    case 9: lines.push(`~ tie ${who} | with: ${r.pick(['Astra', 'Brann', 'Cole', 'Dova', 'Esk', 'Finn', 'Gale', 'Hobb', 'Ines'])} | tag: ${r.pick(['+', '-'])}${r.pick(['ally', 'rival', 'owes'])}`); break;
                    case 0: lines.push(`~ npc ${who} | trust: ${r.pick(['+', '-'])}${r.int(1, 15)} | affection: +${r.int(0, 9)}`); break;
                    // Past the change cap (B-a1-15): held to 15 a reply, also after a middle delete.
                    case 4: lines.push(`~ npc ${who} | trust: ${r.pick(['+', '-'])}${r.int(16, 40)}`); break;
                    case 1: lines.push(`~ npc ${who} | respect: +${r.int(1, 9)} | tension: ${r.pick(['+', '-'])}${r.int(1, 9)}`); break;
                    case 2: { const name = `deed ${step}-${n}`; lines.push(`+ milestone ${who} — ${name}`); marks.push(`${who}|${name}`); break; }
                    default: lines.push(`+ milestone ${who} — saved her brother`);
                }
            }
            const before = Object.fromEntries(['Mira', 'Oren'].map(who => [who, s.npc(who).meters]));
            const index = await s.say(lines, `Step ${step}.`);
            own.set(s.host.store.carrierSid(index), marks);
            // One reply moves each meter at most the change cap, whatever was deleted before it.
            for (const who of ['Mira', 'Oren']) {
                for (const [meter, value] of Object.entries(s.npc(who).meters)) {
                    assert.ok(Math.abs(value - before[who][meter]) <= DEFAULT_CHANGE_CAP, `seed ${seed} step ${step}: ${who}'s ${meter} moved ${value - before[who][meter]} in one reply`);
                }
            }
            if (step < 3 || !r.chance(0.4)) continue;
            const replies = s.host.ctx.chat.map((message, at) => (!message.is_user && at > setup && at < index ? at : -1)).filter(at => at >= 0);
            if (!replies.length) continue;
            const gone = r.pick(replies);
            own.delete(s.host.store.carrierSid(gone));
            await s.host.st.deleteMessage(gone);
            await s.host.st.deleteMessage(gone - 1);
            const label = `seed ${seed} step ${step} (deleted ${gone})`;
            assert.deepEqual(s.host.store.problems(), [], `${label}: nothing was skipped`);
            const head = JSON.stringify(s.host.head());
            assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), [], `${label}: the slice validates`);
            s.host.store.rebuild();
            assert.equal(JSON.stringify(s.host.head()), head, `${label}: replay equals rebuild`);
            // Each remaining reply's own milestones are there; the deleted reply's are gone.
            const kept = [...own.values()].flat();
            for (const mark of kept) {
                const [who, name] = mark.split('|');
                assert.equal(s.npc(who).milestones?.[name.replace(/ /g, '-')], name, `${label}: ${mark}`);
            }
            const deeds = ['Mira', 'Oren'].flatMap(who => Object.values(s.npc(who).milestones ?? {}).filter(name => name.startsWith('deed')).map(name => `${who}|${name}`));
            assert.deepEqual(deeds.sort(), [...kept].sort(), `${label}: no milestone of a deleted reply is left`);
        }
        assert.deepEqual(s.host.store.problems(), [], 'no replayed block was skipped');
    });
}

// A small DOM for the settings section (createElement, appendChild, replaceChildren, click).
function fakeDom() {
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; this.listeners = {}; this.parentNode = null; this.attributes = {}; }
        appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
        replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
        before(node) { const parent = this.parentNode; if (!parent) return; const at = parent.children.indexOf(this); node.parentNode = parent; parent.children.splice(at, 0, node); }
        remove() { const parent = this.parentNode; if (parent) parent.children = parent.children.filter(child => child !== this); this.parentNode = null; }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        click() { for (const fn of this.listeners.click ?? []) fn({ target: this }); }
        querySelector() { return null; }
        get isConnected() { return true; }
        get style() { return this._style ??= {}; }
    }
    return { createElement: tag => new Node(tag), documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } };
}

test('the meter setup is kept on the dossier and never reaches Delta\'s own prompts', async () => {
    const core = await import('../core.js');
    const npc = core.normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', present: true, role: 'Clerk', meterSetup: { track: 'rival-track-x', limits: { affection: { ceiling: 37 } } } });
    assert.deepEqual(npc.meterSetup, { track: 'rival-track-x', limits: { affection: { ceiling: 37 } } });
    const transcript = 'USER: Hello.\nASSISTANT: Mira smiles.';
    const options = { transcript, currentTranscript: transcript, existingNpcs: [npc], existingNpc: npc, targetNpc: npc, targets: [npc], targetName: 'Mira', dossierText: 'Name: Mira', userName: 'Ari', charName: 'C' };
    const texts = [
        core.buildScannerPrompt(options), core.buildNarrationCapturePrompt(options), core.buildProfileRefreshPrompt(options),
        core.buildRelationshipPassPrompt(options), core.buildInjection([npc], transcript, 1),
    ];
    for (const text of texts) assert.doesNotMatch(String(text), /rival-track-x|ceiling|meterSetup/);
});

// ---- standalone: Story Block alone (no RPG Battle, no Story Director), a dating sim from a pack ----

const DATING_PACK = {
    id: 'sweet-days', version: '1.0.0', requires: { storyBlock: '^2' }, name: 'Sweet Days',
    content: {
        meterPresets: [{
            id: 'sweetheart', title: 'Sweetheart',
            meters: [
                { id: 'regard', name: 'Regard', min: -100, max: 100, start: 0, describe: 'How much they think of you after a date: kindness and attention raise it, standing them up lowers it.',
                    bands: [{ at: -100, word: 'cold' }, { at: -20, word: 'unsure' }, { at: 20, word: 'fond' }, { at: 60, word: 'smitten' }] },
                { id: 'nerves', name: 'Nerves', min: 0, max: 100, start: 50, drift: { toward: 50, perDay: 5 } },
            ],
            stages: [
                { id: 'crush', name: 'Crush', needs: [{ meter: 'regard', at: 20 }] },
                { id: 'sweetheart', name: 'Sweetheart', needs: [{ meter: 'regard', at: 60 }, { meter: 'nerves', at: 30 }], milestone: 'They hold your hand on the way home.' },
            ],
        }],
    },
};

test('standalone: with Story Block alone, a pack\'s meter preset gives a dating sim its meters, words and stages', async () => {
    const records = dossiers();
    const s = await suite({ records, packs: [DATING_PACK] });
    assert.equal(s.host.sdk.modules().some(module => /battle|director/.test(module.id)), false, 'no RPG Battle and no Story Director');
    const presets = s.host.sdk.query('packs.content', { kind: 'meterPresets' });
    assert.equal(presets.length, 1, 'the pack is read through packs.content');
    // The reader turns the preset on (the settings block) and gives it to Mira (the dossier editor).
    s.setSettings({ presets: [presets[0].id] });
    records.npc_mira.meterSetup = { track: presets[0].id };
    assert.match(s.def.context.static(), /regard \(-100\.\.100\), nerves \(0\.\.100\)/);
    assert.match(s.def.context.static(), /Meter rules: regard How much they think of you after a date/);
    await s.say(['~ npc Mira | regard: +15 | trust: +15']);
    await s.say(['~ npc Mira | regard: +10']);
    assert.equal(s.npc('Mira').rank, 'Crush');
    assert.ok(s.def.context.tail(s.view()).lines[0].includes('Mira (Crush) trust 25, affection 0, desire 0, tension 0, regard fond, nerves 50'), JSON.stringify(s.def.context.tail(s.view())));
    for (let i = 0; i < 3; i += 1) await s.say(['~ npc Mira | regard: +15']);
    assert.equal(s.npc('Mira').rank, 'Sweetheart', 'a pack stage needs no milestone: its needs alone');
    assert.match(lastReceipt(s, 'capture.npc').summary, /Mira: now Sweetheart \(They hold your hand on the way home\)/, 'the pack stage\'s line is told');
    // No Story Director: no clock, so nothing drifts, and nothing fails.
    assert.equal(s.npc('Mira').meters.nerves, 50);
    assert.deepEqual(s.host.store.problems(), []);
    assert.deepEqual(s.host.turn.problems().filter(problem => problem.module === MODULE_ID), []);
});

// ---- 7. the dossier's "Last relationship change" is the meters' own net change (hosted; read time only) ----

const STORED = { impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: 0 }, reason: 'Old sidecar reason.', message: 1 };
function cardOf(s, record = s.delta.records.npc_mira) {
    const npc = { ...structuredClone(record), lastRelationshipChange: structuredClone(STORED) };
    const state = { npcs: [npc], meterViews: s.adapter.dossierMeters([npc]), reply: s.host.store.headIndex() };
    const shown = projectDossierState(state, { chatKey: 'c1' }).npcs[0].lastRelationshipChange;
    return { shown, html: lastRelationshipChangeHtml(shown), npc };
}

test('net change card: a story-line move without Delta\'s tier caps shows the net amounts and the reply (no source chip, no tier, no reason)', async () => {
    const s = await suite();
    const reply = await s.say(['~ npc Mira | trust: +5 | tension: +2']);
    const now = s.npc('Mira').meters;
    const { shown, html } = cardOf(s);
    assert.equal(shown.message, reply);
    assert.equal(shown.delta.trust, now.trust - 10);
    assert.equal(shown.delta.tension, now.tension);
    assert.ok(shown.delta.trust > 0 && shown.delta.tension > 0);
    assert.match(html, new RegExp(`Reply #${reply}`));
    assert.match(html, new RegExp(`Trust \\+${shown.delta.trust}`));
    assert.doesNotMatch(html, /Old sidecar|Ordinary|Meaningful|Asked|Held|From the s/);
});

test('net change card: a scanner-only move and a mixed reply show amounts and the reply, never a source chip', async () => {
    const s = await suite();
    const first = await s.say([]);
    await s.adapter.adjust({ name: 'Mira', meters: { trust: 3 }, start: { trust: 10, affection: 0, desire: 0, tension: 0 }, reply: first });
    let card = cardOf(s);
    assert.equal(card.shown.delta.trust, 3);
    assert.doesNotMatch(card.html, /From the s/);
    assert.match(card.html, new RegExp(`Reply #${first}`));
    const second = await s.say(['~ npc Mira | trust: +2']);
    await s.adapter.adjust({ name: 'Mira', meters: { affection: 2 }, reply: second });
    card = cardOf(s);
    assert.ok(card.shown.delta.trust > 0 && card.shown.delta.affection > 0, 'both axes moved on that reply');
    assert.match(card.html, /Trust \+/);
    assert.match(card.html, /Affection \+/);
    assert.doesNotMatch(card.html, /From the s/);
});

test('net change card: a latest window with no net built-in movement, or none at all, shows the stored card as today', async () => {
    const s = await suite({ settings: { customMeters: [{ name: 'Awe', min: 0, max: 50 }] } });
    assert.equal(cardOf(s).shown.reason, 'Old sidecar reason.', 'no window yet');
    await s.say(['~ npc Mira | awe: +4']);
    const card = cardOf(s);
    assert.equal(card.shown.reason, 'Old sidecar reason.', 'only a custom meter moved');
    assert.doesNotMatch(card.html, /From the s/);
    assert.match(card.html, /Old sidecar reason/);
});

test('net change card: a manual edit at or after the window keeps "Manual edit"', async () => {
    const s = await suite();
    const reply = await s.say(['~ npc Mira | trust: +5']);
    const npc = { ...structuredClone(s.delta.records.npc_mira), lastRelationshipChange: { impact: 'manual', delta: { trust: 4, affection: 0, desire: 0, tension: 0 }, reason: '', message: reply } };
    const shown = projectDossierState({ npcs: [npc], meterViews: s.adapter.dossierMeters([npc]) }, { chatKey: 'c1' }).npcs[0].lastRelationshipChange;
    assert.equal(shown.impact, 'manual');
    assert.match(lastRelationshipChangeHtml(shown), /Manual edit/);
});

test('net change card: the projection never reaches the scan view or stored dossier data; swipes and reloads recompute it; standalone is unchanged', async () => {
    const s = await suite();
    await s.say(['~ npc Mira | trust: +5']);
    const stored = JSON.stringify(s.delta.records);
    const { npc } = cardOf(s);
    assert.equal(JSON.stringify(s.delta.records), stored, 'the stored dossiers are untouched');
    assert.deepEqual(npc.lastRelationshipChange, STORED, 'the record the projection read keeps its own value');
    const scanView = s.adapter.sliceView(Object.values(s.delta.records));
    assert.ok(scanView.every(item => !item.lastRelationshipChange || JSON.stringify(item.lastRelationshipChange) === JSON.stringify(s.delta.records[item.id].lastRelationshipChange)), 'sliceView carries no projection');
    assert.doesNotMatch(JSON.stringify(s.host.head().domains), /relChange/, 'nothing of it is in Story Block\'s state');
    await s.swipe([]);
    assert.equal(cardOf(s).shown.reason, 'Old sidecar reason.', 'the swiped reply moved nothing: back to the stored card');
    await s.regenerate(['~ npc Mira | trust: +3']);
    assert.match(cardOf(s).html, /Trust \+3/);
    s.adapter.stop();
    assert.deepEqual(s.adapter.dossierMeters(Object.values(s.delta.records)), {});
    const alone = projectDossierState({ npcs: [{ ...structuredClone(s.delta.records.npc_mira), lastRelationshipChange: STORED }] }, { chatKey: 'c1' }).npcs[0].lastRelationshipChange;
    assert.equal(alone.reason, 'Old sidecar reason.');
    assert.equal(alone.hosted, undefined);
});

test('net change card: the open-panel token covers the host views, so a changed card refreshes the panel', async () => {
    const s = await suite();
    const before = JSON.stringify(s.adapter.dossierMeters(Object.values(s.delta.records)));
    await s.say(['~ npc Mira | trust: +5']);
    assert.notEqual(JSON.stringify(s.adapter.dossierMeters(Object.values(s.delta.records))), before);
    assert.match(runtimeSource(), /\.\.\.hostPart\(key, state\)\]\);/, 'dossierViewToken ends with the host part (the slice view, presence and host views)');
    assert.match(runtimeSource(), /dossierHostViews\(state\)\]/, 'which holds the host views');
});

test('net change card: the same reply\'s sidecar event is not listed again under "Earlier changes"; an older one still is', async () => {
    const s = await suite();
    const reply = await s.say(['~ npc Mira | trust: +5']);
    const same = { impact: 'meaningful', delta: { trust: 5, affection: 0, desire: 0, tension: 0 }, reason: 'Same reply event.', message: reply };
    const older = { impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: 0 }, reason: 'Older event.', message: reply - 1 };
    const npc = { ...structuredClone(s.delta.records.npc_mira), lastRelationshipChange: same, relationshipEventHistory: [older, same] };
    const shown = projectDossierState({ npcs: [npc], meterViews: s.adapter.dossierMeters([npc]) }, { chatKey: 'c1' }).npcs[0];
    assert.equal(shown.lastRelationshipChange.hosted, true);
    const html = relationshipHistoryHtml(shown.recentRelationshipChanges, shown.lastRelationshipChange);
    assert.doesNotMatch(html, /Same reply event/);
    assert.match(html, /Older event/);
});

test('relationship card: a Tension amount colours by meaning like the arrows (up bad, down good); the other axes by sign', () => {
    const html = lastRelationshipChangeHtml({ impact: 'ordinary', reason: 'x', message: 1, delta: { trust: 2, affection: 0, desire: -1, tension: 3 } });
    assert.match(html, /delta-rel-delta-down delta-rel-tension">Tension \+3/);
    assert.match(html, /delta-rel-delta-up delta-rel-trust">Trust \+2/);
    assert.match(html, /delta-rel-delta-down delta-rel-desire">Desire -1/);
    assert.match(lastRelationshipChangeHtml({ impact: 'ordinary', reason: 'x', message: 1, delta: { trust: 0, affection: 0, desire: 0, tension: -4 } }), /delta-rel-delta-up delta-rel-tension">Tension -4/);
});

test('hosted forward: an open dossier panel draws again when each delayed npc.adjust settles', async () => {
    const calls = [];
    let release = null;
    const refreshes = [];
    let cleanup = null;
    const prior = globalThis.document;
    globalThis.document = { documentElement: { dataset: { npcStateDeltaStoryBlockV2: '1' } }, getElementById: id => (id === 'npc_state_delta_dossier_root' ? { __npcStateDeltaStage1Ui: { scheduleRefresh: () => refreshes.push(calls.length) } } : null) };
    try {
        const rt = { storySuiteV2: { hosted: () => true, adjust: change => { calls.push(change.name); return new Promise(resolve => { release = resolve; }); } } };
        // runtime-hosted.js with its siblings copied beside it; only the SillyTavern-bound helper and settings files are stubs.
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-hosted-forward-'));
        const root = fileURLToPath(new URL('..', import.meta.url));
        fs.cpSync(root, temp, { recursive: true, filter: from => !/[\\/](tests|docs|scripts|\.git|node_modules|dist)([\\/]|$)/.test(path.relative(root, from)) });
        fs.writeFileSync(path.join(temp, 'runtime-scan-helpers.js'), [
            "import { normalizeName, normalizeRelationshipBaseline, npcMatchesLabel } from './core.js'; import { rejectedOverallLook } from './appearance-update.js'; import { physicalTraitSwaps } from './appearance-physical.js'; import { moodNumbers } from './npc-mood.js';",
            'export const chatContext = () => ({ chat: [] }); export const markStands = () => true; export const replayScope = () => null; export const scopedAdapter = a => a;',
            fs.readFileSync(path.join(root, 'runtime-scan-helpers.js'), 'utf8').split('// What a committed scan tells the slice')[1],   // the real pure readers moved out of runtime-hosted.js
        ].map((part, index) => (index === 2 ? '//' + part : part)).join('\n'));
        fs.writeFileSync(path.join(temp, 'runtime-settings.js'), 'export const getSettings = () => ({}); export const setRpgProbe = () => {};');
        cleanup = temp;
        const { createHostedPart } = await import(pathToFileURL(path.join(temp, 'runtime-hosted.js')).href);
        const part = createHostedPart(rt, { chatHydrationStatus: () => 'ready', getChatKey: () => 'c1', getChatState: () => ({ npcs: [] }), latestMessageId: () => 1, latestReplyIndex: () => 1 });
        const npc = (id, trust) => ({ id, name: id, relationship: { trust, affection: 0, desire: 0, tension: 0 } });
        part.forwardRelationshipChangesToHost([npc('a', 0), npc('b', 0)], [npc('a', 2), npc('b', 3)], 1);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, ['a'], 'sequential: the first is pending');
        assert.deepEqual(refreshes, [], 'nothing drawn before the host settles');
        release(); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(refreshes, [1]);
        release(); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, ['a', 'b']);
        assert.deepEqual(refreshes, [1, 2]);
    } finally {
        globalThis.document = prior;
        if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    }
});

// ---- 8. the card's event details: the tier, "Held" and "Asked", and the story date (the reply's own record, written whole) ----

const CLOCK = {
    id: 'zz-clock', name: 'Clock',
    domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
    commands: { 'zz.clock': (ctx, { minutes }) => { ctx.draft('director').time.minutes = minutes; return { summary: 'time passes' }; } },
    queries: { 'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }) },
};
const TIERS = { ordinary: 1, meaningful: 2, major: 5, extreme: 10 };
/** A hosted chat with Delta's tier caps and a per-day allowance (and a clock): the day's events are paced. */
const pacedSuite = async (allowance, extra = {}) => {
    const s = await suite({ modules: [CLOCK], apiExtra: { relationshipCaps: () => ({ ...TIERS }), relationshipAllowance: () => ({ ...allowance }) }, ...extra });
    await s.host.sdk.command('zz.clock', { minutes: 12 * 1440 });
    return s;
};
const LOOSE = { ordinary: 99, meaningful: 99, major: 99, extreme: 99 };
const SHUT = { ordinary: 0, meaningful: 0, major: 0, extreme: 0 };
const eventOf = (s, who = 'Mira') => JSON.parse(s.host.head().domains.npc.npcs[who.toLowerCase()].lastEvent);

test('event card: a story line that moved shows the tier chip, the amounts and the story date in the stamp', async () => {
    const s = await pacedSuite(LOOSE);
    const reply = await s.say(['~ npc Mira | trust: +1 | affection: +1 | tension: +1']);
    const { shown, html } = cardOf(s);
    const date = storyMinuteText(12 * 1440);
    assert.ok(date, 'the clock gives a date');
    assert.match(html, /delta-rel-impact-ordinary">Ordinary</);
    assert.match(html, new RegExp(`Reply #${reply} · ${date}`));
    assert.match(html, /Trust \+1/);
    assert.doesNotMatch(html, /Held|Asked|Old sidecar/);
    assert.equal(shown.event.held, false);
});

test('event card: the highest tier actually spent is shown (a meaningful line cut to ordinary by the day shows Ordinary)', async () => {
    const s = await pacedSuite({ ordinary: 9, meaningful: 0, major: 0, extreme: 0 });
    await s.say(['~ npc Mira | trust: +9 | impact: major']);
    assert.match(cardOf(s).html, /delta-rel-impact-ordinary">Ordinary</);
    assert.deepEqual(eventOf(s).events.map(item => [item.tier, item.held]), [['ordinary', false]]);
});

test('event card: a line the day held shows "Held: …. Nothing moved." and what was asked; the meters do not move', async () => {
    const s = await pacedSuite({ ordinary: 1, meaningful: 0, major: 0, extreme: 0 });
    await s.say(['~ npc Mira | trust: +1']);
    const before = JSON.stringify(s.npc('Mira').meters);
    const reply = await s.say(['~ npc Mira | trust: +1 | affection: +1']);
    assert.equal(JSON.stringify(s.npc('Mira').meters), before, 'nothing moved');
    const { html } = cardOf(s);
    assert.match(html, /delta-rel-impact-ordinary">Ordinary</);
    assert.match(html, new RegExp(`Reply #${reply} · ${storyMinuteText(12 * 1440)}`));
    assert.match(html, /Held: today&#039;s ordinary is used on [^.]*\. Nothing moved\./);
    assert.match(html, /Asked: Trust \+1, Affection \+1/);
    assert.doesNotMatch(html, /Progress only|Old sidecar/);
});

test('event card: two held story lines on one reply sum their asks per axis', async () => {
    const s = await pacedSuite(SHUT);
    await s.say(['~ npc Mira | trust: +1', '~ npc Mira | trust: +1 | desire: +2']);
    assert.equal(eventOf(s).events.length, 2);
    assert.match(cardOf(s).html, /Asked: Trust \+2, Desire \+2/);
});

test('event card: a scanner request for a story-named axis is not counted twice; its other axes are', async () => {
    const s = await pacedSuite(SHUT);
    const reply = await s.say(['~ npc Mira | trust: +1']);
    await s.adapter.adjust({ name: 'Mira', meters: { trust: 1, affection: 1 }, reply, impact: 'ordinary' });
    assert.deepEqual(eventOf(s).events.map(item => item.src), ['story', 'scan']);
    assert.match(cardOf(s).html, /Asked: Trust \+1, Affection \+1/);
    // A story line that moved leaves its axis to itself: the scan's request for it makes no event at all.
    const loose = await pacedSuite(LOOSE);
    const next = await loose.say(['~ npc Mira | trust: +1']);
    await loose.adapter.adjust({ name: 'Mira', meters: { trust: 1 }, reply: next, impact: 'ordinary' });
    assert.deepEqual(eventOf(loose).events.map(item => item.src), ['story']);
});

test('event card: a later reply replaces the record whole; a reply whose window moved on shows the plain card', async () => {
    const s = await pacedSuite(LOOSE);
    const first = await s.say(['~ npc Mira | trust: +1']);
    const second = await s.say(['~ npc Mira | affection: +1']);
    assert.equal(eventOf(s).at, s.host.store.carrierSid(second), 'only the newest reply is kept');
    assert.notEqual(first, second);
    const entry = s.npc('Mira');
    assert.equal(entry.event.events.length, 1);
    await s.say([]);   // a reply with no line for Mira: the window and the event stay the second reply's
    assert.match(cardOf(s).html, new RegExp(`Reply #${second}`));
});

test('event card: replay equals live, and the meters match a chat that never had the deleted reply (middle delete, rebuild)', async () => {
    const lines = [['~ npc Mira | trust: +3'], ['~ npc Mira | affection: +2'], ['~ npc Mira | trust: +1 | tension: +1']];
    const a = await pacedSuite(LOOSE);
    await a.say(['~ npc Mira | trust: +1']);
    for (const set of lines) await a.say(set);
    const gone = a.host.store.headIndex() - 2;   // the second of the three
    await a.host.st.deleteMessage(gone);
    await a.host.st.deleteMessage(gone - 1);
    assert.deepEqual(a.host.store.problems(), [], 'nothing was skipped');
    const b = await pacedSuite(LOOSE);
    await b.say(['~ npc Mira | trust: +1']);
    for (const set of [lines[0], lines[2]]) await b.say(set);
    assert.equal(JSON.stringify(a.npc('Mira').meters), JSON.stringify(b.npc('Mira').meters), 'the meters are the same');
    assert.deepEqual(validateNpcSlice(a.host.head().domains.npc), []);
    // The event is the surviving reply's own whole record (the net amounts and the stamp's number are the window's, as on main).
    assert.deepEqual(eventOf(a).events, eventOf(b).events, 'the surviving reply\'s event');
    assert.equal(eventOf(a).date, eventOf(b).date);
    // #295: the window's reply number is past the head now (the earlier message left), so the card is not drawn from it: the stored card
    // shows, not a net change under the wrong "Reply #N" or the old window's amounts.
    assert.ok(a.host.store.headIndex() < a.npc('Mira').reply, 'the window names a reply that is gone');
    assert.match(cardOf(a).html, /Old sidecar reason/);
    assert.doesNotMatch(cardOf(a).html, /January 13|Reply #(?!1<)/);
    assert.match(cardOf(b).html, /delta-rel-impact-ordinary">Ordinary<.*January 13/s, 'a chat that never had the reply keeps its card');
    const head = JSON.stringify(a.host.head());
    a.host.store.rebuild();
    assert.equal(JSON.stringify(a.host.head()), head, 'replay equals the live state');
});

test('event card: a swipe falls back to the earlier reply\'s card; a regenerate and a delete follow their own reply', async () => {
    const s = await pacedSuite(LOOSE);
    await s.say(['~ npc Mira | trust: +1']);
    const first = s.host.store.headIndex();
    await s.say(['~ npc Mira | affection: +1']);
    await s.swipe([]);
    const swiped = cardOf(s);
    assert.match(swiped.html, new RegExp(`Reply #${first}`), 'the swiped reply made no event: the earlier reply\'s card');
    assert.doesNotMatch(swiped.html, /Affection/);
    await s.regenerate(['~ npc Mira | trust: +2']);
    assert.match(cardOf(s).html, /delta-rel-impact-ordinary">Ordinary</);
    assert.match(cardOf(s).html, /Trust \+1/, 'asked +2, the ordinary tier moved +1');
    await s.host.st.deleteMessage(s.host.store.headIndex());
    await s.host.st.deleteMessage(s.host.store.headIndex());
    assert.deepEqual(s.host.store.problems(), []);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
});

test('event card: an older record without a last event (or an unusable one) shows exactly the net card', async () => {
    const s = await pacedSuite(LOOSE);
    await s.say(['~ npc Mira | trust: +2']);
    const withEvent = cardOf(s).html;
    const part = createNpcPart({});
    const slice = structuredClone(s.host.head().domains.npc);
    delete slice.npcs.mira.lastEvent;
    assert.deepEqual(validateNpcSlice(slice), [], 'an old record is valid');
    for (const bad of ['{', '{"at":1,"date":"","events":[]}', JSON.stringify({ at: 1, date: 'x'.repeat(41), events: [{ src: 'story', ask: { trust: 1 }, tier: 'ordinary', held: true, note: '' }] }),
        JSON.stringify({ at: 1, date: '', events: [{ src: 'story', ask: { luck: 1 }, tier: 'ordinary', held: true, note: '' }] }),
        JSON.stringify({ at: 1, date: '', events: [{ src: 'story', ask: { trust: 1.5 }, tier: 'ordinary', held: true, note: '' }] }),
        JSON.stringify({ at: 1, date: '', events: [{ src: 'story', ask: { trust: 1 }, tier: 'huge', held: true, note: '' }] }),
        JSON.stringify({ at: 1, date: '', events: Array.from({ length: 5 }, () => ({ src: 'scan', ask: {}, tier: 'ordinary', held: false, note: '' })) }), 7]) {
        const copy = structuredClone(slice);
        copy.npcs.mira.lastEvent = bad;
        assert.equal(validateNpcSlice(copy).length, 1, `unusable: ${String(bad).slice(0, 50)}`);
    }
    assert.ok(part && withEvent.includes('Ordinary'));
});

test('event card: a hosted manual edit keeps "Manual edit" with the edited amounts (the save writes the manual change; the slice window restarts)', async () => {
    assert.match(fs.readFileSync(fileURLToPath(new URL('../runtime-editor-save.js', import.meta.url)), 'utf8'), /else if \(meterEdits && shownRelationship\) \{[^}]*impact: 'manual',\s*delta: edited/s);
    const s = await pacedSuite(LOOSE);
    const reply = await s.say(['~ npc Mira | trust: +1']);
    await s.adapter.setMeters({ name: 'Mira', meters: { trust: 30 } });
    const npc = { ...structuredClone(s.delta.records.npc_mira), lastRelationshipChange: { impact: 'manual', delta: { trust: 19, affection: 0, desire: 0, tension: 0 }, reason: '', message: reply } };
    const shown = projectDossierState({ npcs: [npc], meterViews: s.adapter.dossierMeters([npc]) }, { chatKey: 'c1' }).npcs[0].lastRelationshipChange;
    const html = lastRelationshipChangeHtml(shown);
    assert.match(html, /Manual edit/);
    assert.match(html, /Trust \+19/);
});

test('event card: same-reply history is filtered before the display limit (older rows are not pushed out)', async () => {
    const s = await pacedSuite(LOOSE);
    const reply = await s.say(['~ npc Mira | trust: +1']);
    const mk = (n, message) => ({ impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: 0 }, reason: `Event ${n}.`, message });
    const history = [mk(1, reply - 3), mk(2, reply - 2), mk(3, reply - 1), mk(4, reply), mk(5, reply)];
    const npc = { ...structuredClone(s.delta.records.npc_mira), lastRelationshipChange: history.at(-1), relationshipEventHistory: history };
    const shown = projectDossierState({ npcs: [npc], meterViews: s.adapter.dossierMeters([npc]) }, { chatKey: 'c1' }).npcs[0];
    const html = relationshipHistoryHtml(shown.recentRelationshipChanges, shown.lastRelationshipChange);
    assert.doesNotMatch(html, /Event 4|Event 5/);
    for (const n of [1, 2, 3]) assert.match(html, new RegExp(`Event ${n}\\.`));
});

test('event card: a host capture or Re-read that settles after Delta\'s render asks an open panel to draw again', async () => {
    const draws = [];
    const doc = { documentElement: { dataset: {} }, getElementById: id => (id === 'npc_state_delta_dossier_root' ? { __npcStateDeltaStage1Ui: { scheduleRefresh: () => draws.push(1) } } : null), addEventListener() {}, dispatchEvent() { return true; } };
    const s = await suite({ doc });
    const before = draws.length;
    await s.say(['~ npc Mira | trust: +2']);
    assert.ok(draws.length > before, 'the host\'s turn event asked the panel to refresh');
});

test('event card: a held line that names only custom meters has no Asked, so it does not replace the older card', async () => {
    const s = await pacedSuite(SHUT, { settings: { customMeters: [{ name: 'Awe', min: 0, max: 50 }] } });
    await s.say(['~ npc Mira | awe: +3 | impact: major']);
    const { shown, html } = cardOf(s);
    assert.equal(shown.event, undefined);
    assert.doesNotMatch(html, /Held:/);
    assert.match(html, /Old sidecar/);
});

test('event summary: events naming only custom meters do not count toward the tier chip; the colour of Held comes from the theme', () => {
    const item = (tier, ask, held = false) => ({ src: 'scan', ask, tier, held, note: '' });
    const tier = events => eventSummary({ at: 1, date: '', events }).tier;
    assert.equal(tier([item('major', {}), item('ordinary', { trust: 1 })]), 'ordinary');
    assert.equal(tier([item('major', {}), item('meaningful', { trust: 1 }, true)]), 'meaningful', 'all that ask were held: the asked tier');
    assert.equal(tier([item('major', {})]), 'major', 'nothing asks anything: as before');
    assert.match(fs.readFileSync(new URL('../dossier-ui-styles.js', import.meta.url), 'utf8'), /\.delta-rel-held \{ color:var\(--ss-warn-text, var\(--ss-warn, #e8c46a\)\)/);
});

// ---- 9. a reply with both a '~ npc' line and a one-pass relationshipDelta for the same person (owner's run, 12 Nov: main-reply-1755) ----

const OWNER_LINES = ['~ npc Sieke | tension: +2 | trust: +1 | impact: ordinary', '~ npc Sister Temiwa | trust: +1 | impact: ordinary'];
const SIEKE_TRUST = 'Astra paid the fifty copper registration fee in silver coin without arguing.';
const SIEKE_TENSION = 'Her bodice button snapped while lunging for the coins, exposing her bare breasts in front of Astra before she threw contracts at him in mortification.';
const TEMIWA_TRUST = 'Astra greeted her politely and asked about the village\'s shortage of hands before registering.';
// The one-pass block's rows as the owner's reply sent them (relationship fields; no relationshipChangeReason, which the one-pass rules do not ask for).
const OWNER_ROWS = [
    { id: 'npc_sieke', relationshipImpact: 'ordinary', relationshipDelta: { trust: 1, affection: 0, desire: 0, tension: 2 }, relationshipEvidence: { trust: SIEKE_TRUST, affection: '', desire: '', tension: SIEKE_TENSION } },
    { id: 'npc_sister-temiwa', relationshipImpact: 'ordinary', relationshipDelta: { trust: 1, affection: 0, desire: 0, tension: 0 }, relationshipEvidence: { trust: TEMIWA_TRUST, affection: '', desire: '', tension: '' } },
];
const ownerRecords = () => {
    const blank = { trust: 0, affection: 0, desire: 0, tension: 0 };
    return {
        npc_sieke: { id: 'npc_sieke', name: 'Sieke', aliases: [], present: true, archived: false, relationship: { ...blank } },
        'npc_sister-temiwa': { id: 'npc_sister-temiwa', name: 'Sister Temiwa', aliases: [], present: true, archived: false, relationship: { ...blank } },
    };
};
// runtime-hosted.js and runtime-scan-helpers.js with their siblings copied beside them (as the hosted forward test above); only the
// SillyTavern-bound parts are stubs. → { relationshipChanges, forward(before, after, reply, rows, onePass) → the adjusts sent }.
async function hostedForwardParts() {
    const sent = [];
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-onepass-why-'));
    const root = fileURLToPath(new URL('..', import.meta.url));
    try {
        fs.cpSync(root, temp, { recursive: true, filter: from => !/[\\/](tests|docs|scripts|\.git|node_modules|dist)([\\/]|$)/.test(path.relative(root, from)) });
        fs.writeFileSync(path.join(temp, 'runtime-scan-helpers.js'), [
            "import { normalizeName, normalizeRelationshipBaseline, npcMatchesLabel } from './core.js'; import { rejectedOverallLook } from './appearance-update.js'; import { physicalTraitSwaps } from './appearance-physical.js'; import { moodNumbers } from './npc-mood.js';",
            'export const chatContext = () => ({ chat: [] }); export const markStands = () => true; export const replayScope = () => null; export const scopedAdapter = a => a;',
            fs.readFileSync(path.join(root, 'runtime-scan-helpers.js'), 'utf8').split('// What a committed scan tells the slice')[1],
        ].map((part, index) => (index === 2 ? '//' + part : part)).join('\n'));
        fs.writeFileSync(path.join(temp, 'runtime-settings.js'), 'export const getSettings = () => ({}); export const setRpgProbe = () => {};');
        const { relationshipChanges, refusedLooks } = await import(pathToFileURL(path.join(temp, 'runtime-scan-helpers.js')).href);
        const { createHostedPart } = await import(pathToFileURL(path.join(temp, 'runtime-hosted.js')).href);
        const rt = { storySuiteV2: { hosted: () => true, adjust: change => { sent.push(change); return Promise.resolve({ ok: true }); } } };
        const part = createHostedPart(rt, { chatHydrationStatus: () => 'ready', getChatKey: () => 'c1', getChatState: () => ({ npcs: [] }), latestMessageId: () => 1, latestReplyIndex: () => 1 });
        const forward = async (before, after, reply, rows, onePass) => {
            sent.length = 0;
            const prior = globalThis.document;
            globalThis.document = { documentElement: { dataset: { npcStateDeltaStoryBlockV2: '1' } }, getElementById: () => null };   // hosted
            try {
                part.forwardRelationshipChangesToHost(before, after, reply, null, [], rows, onePass);
                for (let n = 0; n < 5; n += 1) await new Promise(resolve => setImmediate(resolve));
            } finally { globalThis.document = prior; }
            return sent.map(({ guard, ...change }) => change);
        };
        return { relationshipChanges, refusedLooks, forward };
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
let forwardParts = null;
// What the scan forwards for that reply: the sidecar kept its numbers (a one-pass delta without relationshipChangeReason is dropped), so only the evidence goes.
const ownerForward = async (s, reply, rows = OWNER_ROWS) => {
    forwardParts ??= await hostedForwardParts();
    const after = Object.values(s.delta.records);
    return forwardParts.relationshipChanges(new Map(after.map(npc => [npc.id, npc])), after, { trust: 0, affection: 0, desire: 0, tension: 0 }, reply, rows);
};
const rowOf = (s, id) => {
    const npc = { ...structuredClone(s.delta.records[id]), lastRelationshipChange: structuredClone(STORED) };
    const shown = projectDossierState({ npcs: [npc], meterViews: s.adapter.dossierMeters([npc]), reply: s.host.store.headIndex() }, { chatKey: 'c1' }).npcs[0].lastRelationshipChange;
    return { shown, html: recentChangeRowHtml({ change: shown }) };
};

test('one-pass + line, same reply: the meters move once (the line\'s), and Recent changes carries the one-pass evidence of the meters the line moved', async () => {
    const s = await pacedSuite(LOOSE, { records: ownerRecords() });
    const reply = await s.say(OWNER_LINES);
    const moved = { sieke: structuredClone(s.npc('Sieke').meters), temiwa: structuredClone(s.npc('Sister Temiwa').meters) };
    assert.deepEqual([moved.sieke.trust, moved.sieke.tension, moved.temiwa.trust], [1, 1, 1], 'ordinary: each meter at most 1 (tension held at 1, +2 asked)');
    assert.equal(rowOf(s, 'npc_sieke').html.includes(NO_REASON), true, 'before the scan: no reason (the owner\'s Recent changes row)');
    const sent = await ownerForward(s, reply);
    assert.deepEqual(sent.map(item => [item.name, item.meters, Object.keys(item.why)]), [['Sieke', {}, ['trust', 'tension']], ['Sister Temiwa', {}, ['trust']]]);
    for (const change of sent) assert.notEqual((await s.adapter.adjust(change))?.ok, false);
    assert.deepEqual([s.npc('Sieke').meters, s.npc('Sister Temiwa').meters], [moved.sieke, moved.temiwa], 'the evidence moves nothing');
    const sieke = rowOf(s, 'npc_sieke');
    assert.equal(sieke.shown.reason, `${SIEKE_TRUST.replace(/\.$/, '')}; ${SIEKE_TENSION.replace(/\.$/, '')}`);
    assert.match(sieke.html, /Trust \+1/);
    assert.match(sieke.html, /Tension \+1/);
    assert.match(sieke.html, /Astra paid the fifty copper/);
    assert.doesNotMatch(sieke.html, new RegExp(NO_REASON));
    assert.equal(rowOf(s, 'npc_sister-temiwa').shown.reason, TEMIWA_TRUST.replace(/\.$/, ''));
    // A one-pass delta the sidecar did accept (it gave a reason) is still the line's: one move, not two.
    await s.adapter.adjust({ name: 'Sieke', meters: { trust: 1, tension: 2 }, start: { trust: 0, affection: 0, desire: 0, tension: 0 }, reply, impact: 'ordinary', why: { trust: 'other words' } });
    assert.deepEqual(s.npc('Sieke').meters, moved.sieke, 'the meters the line named move once per reply');
    assert.equal(rowOf(s, 'npc_sieke').shown.reason.startsWith('Astra paid'), true, 'a reason once given is kept');
    const live = JSON.stringify(s.host.head().domains.npc);
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head().domains.npc), live, 'replay is the live state');
});

test('one-pass reason: the line\'s own why wins; without a line, a zero axis, or a plain scan, nothing is written (never invented)', async () => {
    const s = await pacedSuite(LOOSE, { records: ownerRecords() });
    const reply = await s.say(['~ npc Sieke | tension: +2 | trust: +1 | impact: ordinary | why: the button snapped']);
    for (const change of await ownerForward(s, reply)) await s.adapter.adjust(change);
    assert.equal(rowOf(s, 'npc_sieke').shown.reason, 'the button snapped', 'the line\'s own reason stands');
    // Temiwa had no line on this reply: her evidence is refused, nothing of her is written.
    assert.equal(s.host.head().domains.npc.npcs['sister-temiwa'], undefined);
    const quiet = await s.say([]);
    const before = JSON.stringify(s.host.head().domains.npc);
    const out = await s.adapter.adjust({ name: 'Sieke', meters: {}, reply: quiet, why: { trust: SIEKE_TRUST } });
    assert.equal(out?.code, 'REFUSED');
    assert.equal(JSON.stringify(s.host.head().domains.npc), before, 'no line on the reply: no reason, no change');
    // Evidence only for an axis the row did not move, and a scan that is not a one-pass block, carry none.
    const zero = [{ id: 'npc_sieke', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, relationshipEvidence: { trust: 'words', affection: '', desire: '', tension: '' } }];
    assert.deepEqual(await ownerForward(s, quiet, zero), []);
    assert.deepEqual(await ownerForward(s, quiet, null), []);
    // An old reply (a line without why, no evidence sent) replays as it was: no reason appears.
    const old = await pacedSuite(LOOSE, { records: ownerRecords() });
    await old.say(OWNER_LINES);
    const stored = JSON.stringify(old.host.head().domains.npc);
    old.host.store.rebuild();
    assert.equal(JSON.stringify(old.host.head().domains.npc), stored);
    assert.equal(rowOf(old, 'npc_sieke').html.includes(NO_REASON), true);
});

test('withEvidence: only story events of the reply without a why, the axes each asked, cut at a word', () => {
    const text = JSON.stringify({ at: 'r1', date: '', events: [{ src: 'story', ask: { trust: 1 }, tier: 'ordinary', held: false, note: '' }, { src: 'scan', ask: { tension: 1 }, tier: 'ordinary', held: false, note: '' }, { src: 'story', ask: { tension: 2 }, tier: 'ordinary', held: false, note: '', why: 'own' }] });
    const out = JSON.parse(withEvidence(text, 'r1', { trust: 'kept the bargain.', tension: 'x' }));
    assert.deepEqual(out.events.map(item => item.why), ['kept the bargain', undefined, 'own']);
    assert.equal(withEvidence(text, 'r2', { trust: 'x' }), null, 'another reply');
    assert.equal(withEvidence(text, 'r1', { affection: 'x' }), null, 'no asked axis has evidence');
    const long = JSON.parse(withEvidence(text, 'r1', { trust: 'word '.repeat(80) })).events[0].why;
    assert.ok(long.length <= 240 && long.endsWith('…') && !/\s…$/.test(long));
});

test('hosted forward: a one-pass scan sends its evidence with npc.adjust (also with no move); any other scan sends none', async () => {
    forwardParts ??= await hostedForwardParts();
    const records = Object.values(ownerRecords());
    const onePass = await forwardParts.forward(records, records, 4, OWNER_ROWS, true);
    assert.deepEqual(onePass, [
        { name: 'Sieke', meters: {}, start: { trust: 0, affection: 0, desire: 0, tension: 0 }, reply: 4, why: { trust: SIEKE_TRUST, tension: SIEKE_TENSION } },
        { name: 'Sister Temiwa', meters: {}, start: { trust: 0, affection: 0, desire: 0, tension: 0 }, reply: 4, why: { trust: TEMIWA_TRUST } },
    ]);
    assert.deepEqual(await forwardParts.forward(records, records, 4, OWNER_ROWS, false), [], 'a scanner scan: nothing new is sent');
    const moved = records.map(npc => (npc.id === 'npc_sieke' ? { ...npc, relationship: { ...npc.relationship, trust: 1 } } : npc));
    assert.deepEqual((await forwardParts.forward(records, moved, 4, OWNER_ROWS, false)).map(item => [item.name, item.meters, item.why]), [['Sieke', { trust: 1 }, undefined]], 'as before');
});

// ---- 10. the reason's length: 240 characters for both sources, cut at a word with an ellipsis (owner, 12 Nov: "Recent changes got cut off") ----

test('reason length: cutWords keeps up to 240 whole, else cuts at a word with an ellipsis', () => {
    const fits = 'a'.repeat(240);
    assert.equal(cutWords(fits), fits);
    const long = `${'word '.repeat(60)}end`;
    const cut = cutWords(long);
    assert.ok(cut.length <= 240 && cut.endsWith('…') && !/\s…$/.test(cut) && long.startsWith(cut.slice(0, -1)));
    assert.ok(cutWords('😀 '.repeat(200)).length <= 240, 'counted in UTF-16 units, as the stored event is checked');
});

test('reason length: a line\'s own why is kept to 240 (whole when shorter, cut at a word when longer); the evidence is cut the same way', async () => {
    const two = `${'The courier slid the sealed letter under the door and left without a word. '.repeat(3)}`.trim();   // 230 characters
    assert.ok(two.length > 80 && two.length <= 240);
    const s = await pacedSuite(LOOSE, { records: ownerRecords() });
    await s.say([`~ npc Sieke | tension: +1 | impact: ordinary | why: ${two}`]);
    const whole = rowOf(s, 'npc_sieke');
    assert.equal(whole.shown.reason, two, 'a reason under 240 is shown whole (it was cut to 80)');
    assert.ok(whole.html.includes(two));
    const longer = `${two} ${two}`;
    await s.say([`~ npc Sieke | trust: +1 | impact: ordinary | why: ${longer}`]);
    const cut = rowOf(s, 'npc_sieke').shown.reason;
    assert.ok(cut.length <= 240 && cut.endsWith('…') && longer.startsWith(cut.slice(0, -1)) && !/\s…$/.test(cut), 'a longer one is cut at a word with an ellipsis');
    assert.ok(rowOf(s, 'npc_sieke').html.includes(cut.replace(/&/g, '&amp;')), 'the row carries all of it (no truncation in the markup)');
    // The one-pass evidence goes through the same cut.
    const e = await pacedSuite(LOOSE, { records: ownerRecords() });
    const reply = await e.say(['~ npc Sieke | tension: +1 | impact: ordinary']);
    await e.adapter.adjust({ name: 'Sieke', meters: {}, reply, why: { tension: longer } });
    assert.equal(rowOf(e, 'npc_sieke').shown.reason, cut);
    const live = JSON.stringify(e.host.head().domains.npc);
    e.host.store.rebuild();
    assert.equal(JSON.stringify(e.host.head().domains.npc), live, 'replay is the live state');
});

test('reason length (rule mark): a Re-read of a reply whose earlier read stored its reason cut to 80 keeps writing 80; a first read and a wide standing write 240', () => {
    const text = 'x '.repeat(100).trim();
    const standing = why => ({ domains: { npc: { npcs: { sieke: { lastEvent: JSON.stringify({ at: 'r1', date: '', events: [{ src: 'story', ask: { trust: 1 }, tier: 'ordinary', held: false, note: '', why }] }) } } } } });
    assert.equal(reasonKept({}, 'sieke', text), cutWords(text), 'live: 240');
    assert.equal(reasonKept({ standing: standing('x '.repeat(40).trim()) }, 'sieke', text), text.slice(0, 80).trim(), 'earlier read cut to 80: same again');
    assert.equal(reasonKept({ standing: standing(cutWords(text)) }, 'sieke', text), cutWords(text), 'earlier read already wide');
    assert.equal(reasonKept({ standing: { domains: { npc: { npcs: { sieke: { lastEvent: '{"events":[]}' } } } } } }, 'sieke', text), '', 'earlier read kept none: none (as before)');
    assert.deepEqual(reasonKept({}, 'sieke', { trust: 'words' }), { trust: 'words' }, 'the evidence map passes untouched');
});

test('reason length: the dossier row wraps the whole reason (no CSS truncation on the Recent changes rows or the With card)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const css = fs.readFileSync(path.join(root, 'dossier-ui-styles-sections.js'), 'utf8');
    for (const name of ['.delta-chg-via', '.delta-chg > div', '.delta-chg']) {
        const rule = css.split('\n').find(line => line.includes(`${name} {`)) || '';
        assert.ok(rule && !/text-overflow|line-clamp|white-space:\s*nowrap|max-height/.test(rule), `${name}: no truncation`);
    }
    assert.match(css.split('\n').find(line => line.includes('.delta-chg > div {')), /min-width:0/);
    assert.match(css.split('\n').find(line => line.includes('.delta-chg > div {')), /overflow-wrap:anywhere/);
    const view = fs.readFileSync(path.join(root, 'dossier-ui-view-model.js'), 'utf8');
    assert.doesNotMatch(view, /reason: plain\(source\.reason\)\.slice/, 'the With card reason is not sliced');
});

// (card traits win) What the scan reports as refused: a swapped card trait it kept (with the swaps, worded by lookDrift) and a role
// rewrite it kept (a Problem line, no cue), from the profile updates and the npcs rows; an accepted role or a first role is not reported.
test('refusedLooks: a kept card trait and a refused role rewrite are reported once per person; accepted ones are not', async () => {
    forwardParts ??= await hostedForwardParts();
    const was = { id: 'npc_sister-temiwa', name: 'Sister Temiwa', role: 'Church novice', overallAppearance: 'Long black hair. Brown eyes ringed dark.' };
    const now = { ...was, overallAppearance: 'Long black hair. Brown eyes ringed dark. A grey wool mantle.' };
    const row = { id: was.id, role: 'Exiled Saintess Candidate and Lay Sealer', overallAppearance: 'Long black hair. Pale eyes ringed dark. A grey wool mantle.' };
    const refused = forwardParts.refusedLooks(new Map([[was.id, was]]), [now], [row], [{ id: was.id, role: row.role }]);
    assert.deepEqual(refused, [
        { id: was.id, name: 'Sister Temiwa', before: was.overallAppearance, incoming: row.overallAppearance, swaps: [{ trait: 'eyes', said: 'pale', kept: 'brown' }] },
        { id: was.id, name: 'Sister Temiwa', text: 'Role change refused: the story called Sister Temiwa "Exiled Saintess Candidate and Lay Sealer"; the record keeps "Church novice".' },
    ]);
    assert.deepEqual(forwardParts.refusedLooks(new Map([[was.id, was]]), [{ ...now, role: 'Lay Sealer' }], [], [{ id: was.id, role: 'Lay Sealer' }]), [], 'an accepted role');
    assert.deepEqual(forwardParts.refusedLooks(new Map([[was.id, { ...was, role: '' }]]), [{ ...was, role: '' }], [], [{ id: was.id, role: 'Lay Sealer' }]), [], 'no role held');
    assert.deepEqual(forwardParts.refusedLooks(new Map([[was.id, { ...was, manualProfileFields: ['role'] }]]), [was], [], [{ id: was.id, role: 'Lay Sealer' }]), [], 'a locked role is the reader\'s');
});

// (card traits win, round 2) A refusal is reported from either row channel, from the flat appearance, a named form and the overall look,
// and a row without an id is matched by name or alias the way the merge matches it.
test('refusedLooks: flat and named-form swaps, a name-only row and an ordinary npcs row are reported once', async () => {
    forwardParts ??= await hostedForwardParts();
    const was = { id: 'npc_sister-temiwa', name: 'Sister Temiwa', aliases: ['Temiwa'], role: 'Church novice', overallAppearance: '', appearance: 'Brown eyes, a grey habit',
        appearanceForms: [{ name: 'Rite', appearance: 'Black hair, a white stole' }] };
    const prior = new Map([[was.id, was]]);
    const flat = forwardParts.refusedLooks(prior, [was], [], [{ name: 'Temiwa', appearance: 'Pale eyes, a grey habit' }]);
    assert.deepEqual(flat.map(item => [item.id, item.swaps]), [[was.id, [{ trait: 'eyes', said: 'pale', kept: 'brown' }]]], 'name-only ordinary npcs row, flat appearance');
    const formed = forwardParts.refusedLooks(prior, [was], [{ name: 'Sister Temiwa', appearanceForms: [{ name: 'Rite', appearance: 'Red hair, a white stole' }] }], []);
    assert.deepEqual(formed.map(item => [item.id, item.swaps?.[0]?.trait]), [[was.id, 'hair']], 'profile row by name, named form');
    const twice = forwardParts.refusedLooks(prior, [was], [{ id: was.id, appearance: 'Pale eyes, a grey habit' }], [{ id: was.id, appearance: 'Pale eyes, a grey habit' }]);
    assert.equal(twice.length, 1, 'the same person in both channels is reported once');
    assert.deepEqual(forwardParts.refusedLooks(prior, [{ ...was, appearance: 'Pale eyes, a grey habit' }], [], [{ id: was.id, appearance: 'Pale eyes, a grey habit' }]), [], 'an accepted look is not reported');
    const role = forwardParts.refusedLooks(prior, [was], [], [{ name: 'Temiwa', role: 'Prioress' }]);
    assert.equal(role.length, 1, 'a role rewrite sent by name only is reported');
});

// ---- 10. Recent changes keeps the meters' last three changes (the reply's event, and the two replies before it) ----

test('last three changes: each reply keeps its event; the list shows the newest three with amounts, date, reply and reason; older ones drop off', async () => {
    const s = await pacedSuite(LOOSE);
    const replies = [];
    for (const line of ['~ npc Mira | trust: +2 | why: she was thanked', '~ npc Mira | affection: +1 | tension: +1 | why: a sharp word', '~ npc Mira | desire: +1 | why: a long look', '~ npc Mira | trust: -1 | why: a broken promise']) replies.push(await s.say([line]));
    const recent = s.npc('Mira').recent;
    assert.equal(recent.length, 3, 'the current reply and two before it');
    assert.deepEqual(recent.map(row => row.mv), [{ trust: -1 }, { desire: 1 }, { affection: 1, tension: 1 }], 'newest first; the first reply dropped off');
    assert.deepEqual(recent.map(row => row.why), ['a broken promise', 'a long look', 'a sharp word']);
    assert.deepEqual(recent.map(row => row.n), [replies[3], replies[2], replies[1]]);
    assert.ok(recent.every(row => row.date && !row.held));
    assert.equal(eventOf(s).prev.length, 2, 'the stored text keeps two earlier rows');
    // The dossier lists them (the latest from the net card, the earlier two from the log), each with its date, reply and reason.
    const state = projectDossierState({ npcs: [{ id: 'npc_mira', name: 'Mira' }], reply: replies[3], meterViews: { npc_mira: { recent, bars: [] } } });
    const html = withSectionHtml(state.npcs[0]);
    assert.equal((html.match(/class="delta-chg"/g) || []).length, 3);
    assert.match(html, /a broken promise/); assert.match(html, /a long look/); assert.match(html, /a sharp word/);
    assert.doesNotMatch(html, /she was thanked/, 'a fourth change is not listed');
    assert.match(html, /Tension \+1/); assert.match(html, /Desire \+1/); assert.match(html, /Trust −1/);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    const head = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), head, 'replay equals live');
});

test('last three changes: two events of one reply make one row (the amounts moved, the reasons joined); a held reply says Held', async () => {
    const s = await pacedSuite({ ordinary: 1, meaningful: 99, major: 99, extreme: 99 });
    await s.say(['~ npc Mira | trust: +1 | why: first', '~ npc Mira | affection: +1 | why: second']);
    await s.say(['~ npc Mira | trust: +1 | why: third']);
    await s.say(['~ npc Mira | trust: +1 | why: fourth']);
    const rows = s.npc('Mira').recent;
    assert.ok(rows.length === 3 && rows[0].held && rows[1].held, 'the later same-day lines were held: nothing moved');
    assert.match(rows[0].note, /./);
    assert.match(recentChangeRowHtml({ entry: rows[0] }), /Held/);
    assert.match(rows[2].why, /first; second/, 'one row for the reply: the reasons joined');
    assert.deepEqual(rows[2].mv, { trust: 1 }, 'the second line of the day was held: only the first moved');
});

test('last three changes (rule mark): an older text without the log is written as it was, and starts a log only at its next reply; nothing is made up', () => {
    const old = JSON.stringify({ at: 5, date: 'May 1', events: [{ src: 'story', ask: { trust: 2 }, tier: 'ordinary', held: false, note: '', why: 'an old reason' }] });
    const base = { src: 'story', ask: { trust: 1 }, tier: 'ordinary', held: false, note: '', mv: { trust: 1 }, n: 6 };
    // Same reply (a Re-read, or a second line): no log, no amounts, exactly the older shape.
    const same = nextEvent(old, { ...base, reply: 5, date: 'May 1', log: logKept({ standing: { domains: { npc: { npcs: { a: { lastEvent: old } } } } } }, 'a', 5) });
    assert.equal(JSON.stringify(JSON.parse(same).events[1]), JSON.stringify({ src: 'story', ask: { trust: 1 }, tier: 'ordinary', held: false, note: '' }));
    assert.equal(readEvent(same).prev, undefined);
    assert.equal(logKept({ standing: { domains: { npc: { npcs: { a: { lastEvent: old } } } } } }, 'a', 6), true, 'a new reply may start the log');
    assert.equal(logKept({}, 'a', 5), true, 'a first read may');
    // The next reply: the old event becomes the first row (its own words; no amounts it never stored), and the new one has amounts.
    const next = readEvent(nextEvent(old, { ...base, reply: 6, date: 'May 2' }));
    assert.equal(next.prev.length, 1);
    assert.deepEqual(next.prev[0], { at: 5, n: 5, date: 'May 1', ask: { trust: 2 }, held: false, why: 'an old reason' });
    assert.deepEqual(next.events[0].mv, { trust: 1 });
    assert.equal(eventLog(next).length, 2);
    // A fresh chat's first event starts an empty log; five more replies keep only two earlier rows.
    let text = nextEvent('', { ...base, reply: 1, date: 'D' });
    assert.deepEqual(readEvent(text).prev, []);
    for (let reply = 2; reply <= 6; reply += 1) text = nextEvent(text, { ...base, reply, date: 'D', n: reply });
    assert.deepEqual(readEvent(text).prev.map(row => row.at), [5, 4]);
    assert.deepEqual(eventLog(readEvent(text)).map(row => row.at), [6, 5, 4]);
    assert.deepEqual(eventLog(null), []);
    assert.deepEqual(movesOf([{ meter: 'trust', before: 1, after: 3 }, { meter: 'tension', before: 4, after: 4 }, { meter: 'custom', before: 0, after: 2 }]), { trust: 2 });
    // A stored text with a bad log is unusable (the slice check reports it).
    assert.equal(readEvent(JSON.stringify({ ...JSON.parse(text), prev: [{ at: 1 }] })), null);
});

test('last three changes: a long reason on every row keeps the newest event and drops the oldest log row, never the new event', () => {
    const why = `${'word '.repeat(60)}`.trim();
    const base = { src: 'story', ask: { trust: 1, affection: 1, desire: 1, tension: 1 }, tier: 'ordinary', held: false, note: '', mv: { trust: 1 }, why };
    let text = '';
    for (let reply = 1; reply <= 5; reply += 1) text = nextEvent(text, { ...base, reply, date: 'January 12' });
    const out = readEvent(text);
    assert.ok(out && text.length <= 2600 && out.events[0].why);
    assert.equal(out.at, 5);
});

test('last three changes: Recent changes lists a chat from before the log by the stored history, without repeating a reply the log shows', () => {
    const npc = { relationship: {}, recentMeterChanges: [{ n: 9, date: 'May 2', mv: { trust: 2 }, ask: {}, held: false, note: '', why: 'kept' }], recentRelationshipChanges: [{ impact: 'ordinary', axes: ['trust'], reason: 'dup', message: 9 }, { impact: 'meaningful', axes: ['desire'], reason: 'earlier', message: 4 }] };
    const html = withSectionHtml(npc);
    assert.equal((html.match(/class="delta-chg"/g) || []).length, 2);
    assert.match(html, /kept/); assert.match(html, /earlier/); assert.doesNotMatch(html, /dup/);
    assert.match(withSectionHtml({ relationship: {} }), /No relationship change recorded yet/);
});

test('last three changes: the Recent changes rows wrap on phone, tablet and desktop (the shared row rule has no width or truncation clamp)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const css = fs.readFileSync(path.join(root, 'dossier-ui-styles-sections.js'), 'utf8');
    const row = css.split('\n').find(line => line.includes('.delta-chg {')) || '';
    assert.ok(row && !/text-overflow|line-clamp|nowrap|max-height/.test(row));
    const via = css.split('\n').find(line => line.includes('.delta-chg-via {')) || '';
    assert.ok(via && !/text-overflow|line-clamp|nowrap/.test(via));
    assert.match(css.split('\n').find(line => line.includes('.delta-chg > div {')), /min-width:0/);
});
