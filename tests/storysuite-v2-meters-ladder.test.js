import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { compileTemplate } from './vendor/story-block/src/v2/view/template/index.js';
import { validateScreen } from './vendor/story-block/src/v2/view/screens.js';
import { MODULE_ID, createStorySuiteV2Adapter, meterBarHtml } from '../src/storysuite-v2.js';
import {
    DEFAULT_CHANGE_CAP, FEATURE_DRIFT, FEATURE_PRESETS, FEATURE_STAGES, bandWord, createNpcPart, limitsFromLines, limitsToLines, normalizeMeterSettings,
    parseBands, parseNeeds, secretId, secretsFromLines, secretsToLines, validateNpcSlice,
} from '../src/npc-meters.js';
import { BUILT_IN_PRESETS, presetCatalog } from '../src/npc-meters-presets.js';
import { metersCardScreen } from '../src/npc-meters-screen.js';
import { v2MetersHtml, v2MetersProjection } from '../dossier-ui.js';

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
async function suite({ settings = {}, records = dossiers(), features = null, modules = [], doc = null, wrap = false, packs = [] } = {}) {
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
    const make = presets => createNpcPart({ settings: () => settings, present: () => ['Mira'], feature: id => (id === FEATURE_PRESETS ? presets : undefined) });
    const on = make(true).context.static();
    const off = make(false).context.static();
    assert.match(on, / Meter rules: loyalty rises when you keep promises\.$/);
    assert.equal(off, 'NPC meters: trust, affection, desire, tension (-100..100), loyalty (0..100). When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most 15 a reply and sets the stages; never write a stage.');
    assert.equal(on.startsWith(off.slice(0, -1)), true, 'the rule line is added at the end');
    const state = { domains: { npc: { problems: [], npcs: { mira: { name: 'Mira', meters: { trust: 5, affection: 0, desire: 0, tension: 0, loyalty: 61 }, stages: {}, unlocked: [], turn: { reply: 2, from: {} } } } } } };
    assert.deepEqual(make(true).context.tail({ state, chat: { length: 3 } }).lines, ['NPC meters now: Mira trust 5, affection 0, desire 0, tension 0, loyalty devoted.']);
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

test('teasers: a locked note shows its title and rule on the card and in the Cast tab, never its text', async () => {
    const s = await suite({ settings: { ladder: LADDER } });
    await s.say(['~ npc Mira | trust: +5']);
    const leaks = () => [
        JSON.stringify(s.host.sdk.query('npc.cast')), JSON.stringify(s.host.head()), s.def.context.static(),
        JSON.stringify(s.def.context.tail(s.view())), JSON.stringify(s.adapter.dossierMeters(Object.values(s.delta.records))),
    ].some(text => text.includes('lost heir'));
    const mira = () => s.host.sdk.query('npc.cast').find(entry => entry.key === 'mira');
    assert.deepEqual(mira().locked, [{ title: 'Her past', meter: 'trust', at: 30, text: '🔒 Her past — unlocks at Trust 30' }]);
    assert.equal(leaks(), false);
    const el = { innerHTML: '', addEventListener() {}, isConnected: true };
    s.def.tabs[0].render(el);
    assert.match(el.innerHTML, /🔒 Her past — unlocks at Trust 30/);
    assert.doesNotMatch(el.innerHTML, /lost heir/);
    await s.say(['~ npc Mira | trust: +15']);
    assert.deepEqual(mira().locked, []);
    assert.deepEqual(mira().opened, [{ id: secretId('trust', 30, SECRET), title: 'Her past' }]);
    s.def.tabs[0].render(el);
    assert.match(el.innerHTML, /🔓 <b>Her past<\/b>: She was the lost heir of House Venn\./, 'once unlocked, the Cast tab shows it');
    assert.ok(s.def.context.tail(s.view()).lines.includes(`Mira, now known: ${SECRET}`));
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
    assert.match(html, /🔒 Her past — unlocks at Trust 30/);
    assert.equal(v2MetersHtml(v2MetersProjection(null)), '');
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
    const html = meterBarHtml({ id: 'trust', label: 'Trust', min: -100, max: 100, tone: 'info' }, 22, '', bar);
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

for (const seed of [5, 17, 41]) {
    test(`delete fuzz seed ${seed}: meters, milestones and the per-reply step over middle deletes; replay equals rebuild`, async t => {
        t.mock.method(console, 'warn', () => {});
        const records = dossiers();
        records.npc_mira.meterSetup = { limits: { affection: { ceiling: 50 } } };
        const s = await suite({ records, settings: { ladder: LADDER, demoteAfter: 2, presets: ['rival'] } });
        const r = prng(seed);
        // The set-up reply makes both entries; it is never deleted.
        await s.say(['~ npc Mira | trust: +1', '~ npc Oren | trust: +1']);
        const setup = s.host.store.headIndex();
        const own = new Map();   // record sid → the milestones that reply added
        for (let step = 0; step < 18; step += 1) {
            const lines = [];
            const marks = [];
            for (let n = r.int(1, 3); n > 0; n -= 1) {
                const who = r.pick(['Mira', 'Oren']);
                switch (r.int(0, 4)) {
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
