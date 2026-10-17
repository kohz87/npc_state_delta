import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AREAS, SUITE_VERSION, isSourceOfTruth, storySuite } from '../suite.js';
import {
    SUITE_AREAS,
    SUITE_ID,
    announceNpcStateDelta,
    areaOwner,
    buildManageApi,
    defersArea,
    externalCalendar,
    normalizeSourceOfTruth,
    openSuiteOverlay,
    statLikeFieldNames,
    statsOverlapWarning,
    suiteManageAvailable,
} from '../suite-handshake.js';
import { buildInjection, getActiveCalendarConfig, setActiveCalendarConfig, setExternalCalendarSource, stripUiNoise } from '../core.js';
import { deterministicCalendarBirthday } from '../calendar.js';

// Story Suite handshake (docs/STORY_SUITE.md): the shared registry in suite.js, Delta's
// announcement and the three defers (scene, calendar, stats), plus World State read from inside
// Story Block's hidden envelope. Every test starts from an empty registry.

const fresh = () => {
    delete globalThis.StorySuite;
    return storySuite();
};
const provider = (id, owns, extra = {}) => ({ id, name: id, version: '1.0.0', owns, ...extra });

test('v1.2.0 suite.js and docs/STORY_SUITE.md are the shared copies', () => {
    const suite = fs.readFileSync(new URL('../suite.js', import.meta.url), 'utf8');
    assert.match(suite, /^\/\/ Story Suite handshake, v1\. This file is identical in Story Block, Story Director, NPC State\n/);
    const doc = fs.readFileSync(new URL('../docs/STORY_SUITE.md', import.meta.url), 'utf8');
    assert.match(doc, /^# Story Suite: working alone and together/);
    const runtime = JSON.parse(fs.readFileSync(new URL('../runtime-modules.json', import.meta.url), 'utf8'));
    assert.ok(runtime.modules.some(module => module.path === 'suite.js' && module.role === 'story-suite-registry'));
    assert.ok(runtime.modules.some(module => module.path === 'suite-handshake.js' && module.role === 'story-suite-handshake'));
    assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /docs\/STORY_SUITE\.md/);
});

test('v1.2.0 registry: announce, owner order, fallback and offering', () => {
    const suite = fresh();
    assert.equal(globalThis.StorySuite, suite);
    assert.equal(storySuite(), suite, 'the registry is created once and shared');
    assert.equal(suite.version, SUITE_VERSION);
    assert.equal(suite.owner('scene'), null);
    suite.announce({ id: '  ', owns: ['scene'] });
    assert.deepEqual(suite.providers(), [], 'an announcement without an id is ignored');

    suite.announce(provider('npc-state-delta', ['npc', 'calendar', 'scene', 'stats', 'npc']));
    assert.deepEqual(suite.providers()[0].owns, ['npc', 'calendar', 'scene', 'stats'], 'owns is de-duplicated');
    assert.equal(suite.owner('scene'), 'npc-state-delta', 'the fallback owns an area nobody else offers');
    suite.announce(provider('story-block', ['scene', 'items']));
    assert.equal(suite.owner('scene'), 'story-block', 'the specialist listed first wins');
    assert.deepEqual(suite.offering('scene'), ['story-block', 'npc-state-delta']);
    assert.equal(suite.owner('npc'), 'npc-state-delta');
    suite.announce(provider('story-director', ['npc', 'calendar']));
    assert.equal(suite.owner('npc'), 'npc-state-delta', 'Delta is first for npc');
    assert.equal(suite.owner('calendar'), 'story-director');
    suite.announce(provider('my-ext', ['weather']));
    assert.equal(suite.owner('weather'), 'my-ext', 'an area outside AREAS goes to whoever offers it');
    assert.equal(suite.owner('rolls'), null);

    suite.announce(provider('story-block', ['scene'], { enabled: false }));
    assert.equal(suite.owner('scene'), 'npc-state-delta', 'a disabled provider offers nothing');
    assert.equal(suite.has('story-block'), false);
    assert.equal(suite.has('story-director'), true);
    assert.deepEqual(Object.keys(AREAS), ['scene', 'npc', 'calendar', 'timeline', 'stats', 'items', 'rolls']);
    const copy = suite.providers()[0];
    copy.owns.push('rolls');
    assert.equal(suite.owner('rolls'), null, 'providers() returns copies');
});

test('v1.2.0 registry: api only while enabled, withdraw, onChange and unsubscribe', () => {
    const suite = fresh();
    const calls = [];
    const off = suite.onChange(() => calls.push('a'));
    suite.onChange(() => { throw new Error('a broken listener'); });
    const warn = console.warn;
    console.warn = () => {};
    try {
        suite.announce(provider('story-director', ['calendar'], { api: { calendar: () => ({ era: 'AR', months: [] }) } }));
        assert.deepEqual(calls, ['a'], 'a failing listener does not stop the others');
        assert.equal(typeof suite.api('story-director').calendar, 'function');
        assert.equal(suite.api('rpg-battle'), null);
        suite.announce(provider('story-director', ['calendar'], { enabled: false, api: { calendar: () => null } }));
        assert.equal(suite.api('story-director'), null, 'a disabled provider shares nothing');
        suite.withdraw('story-director');
        assert.equal(calls.length, 3);
        suite.withdraw('story-director');
        assert.equal(calls.length, 3, 'withdrawing an absent id does not notify');
        off();
        suite.announce(provider('rpg-battle', ['stats']));
        assert.equal(calls.length, 3, 'an unsubscribed listener is not called');
    } finally {
        console.warn = warn;
    }
});

test('v1.2.0 registry: a newer copy takes over an older registry with its providers and listeners', () => {
    delete globalThis.StorySuite;
    const heard = [];
    const older = {
        version: 0,
        snapshot: () => [['story-block', { id: 'story-block', name: 'Story Block', owns: ['scene'], enabled: true }]],
        listenersSnapshot: () => [() => heard.push('old listener')],
    };
    globalThis.StorySuite = older;
    const suite = storySuite();
    assert.notEqual(suite, older);
    assert.equal(suite.version, SUITE_VERSION);
    assert.equal(suite.owner('scene'), 'story-block', 'providers survive the upgrade');
    suite.announce(provider('npc-state-delta', ['scene']));
    assert.deepEqual(heard, ['old listener'], 'listeners survive the upgrade');
    const same = { version: SUITE_VERSION + 1, marker: true };
    globalThis.StorySuite = same;
    assert.equal(storySuite(), same, 'a newer registry is left alone');
    delete globalThis.StorySuite;
});

test('v1.2.0 isSourceOfTruth: auto, mine and theirs, alone and together', () => {
    const suite = fresh();
    for (const choice of ['auto', 'mine', 'theirs']) {
        assert.equal(isSourceOfTruth('npc-state-delta', 'scene', choice, suite), true, `alone, ${choice} behaves like Automatic`);
    }
    suite.announce(provider('npc-state-delta', ['npc', 'calendar', 'scene', 'stats']));
    for (const choice of ['auto', 'mine', 'theirs']) {
        assert.equal(isSourceOfTruth('npc-state-delta', 'scene', choice, suite), true, `announced alone, ${choice} keeps Delta`);
    }
    suite.announce(provider('story-block', ['scene']));
    assert.equal(isSourceOfTruth('npc-state-delta', 'scene', 'auto', suite), false);
    assert.equal(isSourceOfTruth('npc-state-delta', 'scene', 'mine', suite), true);
    assert.equal(isSourceOfTruth('npc-state-delta', 'scene', 'theirs', suite), false);
    assert.equal(isSourceOfTruth('story-block', 'scene', 'auto', suite), true);
    assert.equal(isSourceOfTruth('npc-state-delta', 'npc', 'theirs', suite), true, 'theirs with nobody else offering keeps this one');
    assert.equal(isSourceOfTruth('npc-state-delta', 'scene', undefined, suite), false, 'the default choice is auto');
    assert.equal(isSourceOfTruth('npc-state-delta', 'scene'), false, 'the default registry is the shared one');
});

test('v1.2.0 Delta announces its four areas while enabled; without a manage api it withdraws while disabled', () => {
    const suite = fresh();
    const api = { npcs: () => [] };
    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.0', api }), true);
    const [entry] = suite.providers();
    assert.deepEqual({ id: entry.id, name: entry.name, version: entry.version, owns: entry.owns }, { id: 'npc-state-delta', name: 'NPC State Delta', version: '1.2.0', owns: ['npc', 'calendar', 'scene', 'stats'] });
    assert.equal(suite.api(SUITE_ID), api);
    assert.deepEqual(SUITE_AREAS, ['npc', 'calendar', 'scene', 'stats']);
    for (const area of ['calendar', 'scene', 'stats']) assert.equal(suite.owner(area), SUITE_ID, `alone, Delta owns ${area}`);
    suite.announce(provider('story-block', ['scene', 'stats']));
    suite.announce(provider('story-director', ['calendar', 'npc']));
    suite.announce(provider('rpg-battle', ['stats']));
    assert.equal(suite.owner('scene'), 'story-block');
    assert.equal(suite.owner('calendar'), 'story-director');
    assert.equal(suite.owner('stats'), 'rpg-battle');
    assert.equal(suite.owner('npc'), SUITE_ID, 'others win only where they are the specialist');
    assert.equal(announceNpcStateDelta({ enabled: false, version: '1.2.0' }), false);
    assert.equal(suite.has(SUITE_ID), false);
    assert.equal(suite.providers().some(item => item.id === SUITE_ID), false, 'disable withdraws the announcement');
    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.0' }), true);
    assert.equal(suite.has(SUITE_ID), true, 'enable announces again');
    assert.equal(suite.api(SUITE_ID), null, 'without an api nothing is shared');
});

test('v1.2.1 disabled with api.manage, Delta stays announced as enabled: false with its panel and api', () => {
    const suite = fresh();
    const calls = [];
    const api = { npcs: () => [], manage: buildManageApi({ setEnabled: on => calls.push(on) }) };
    const settings = '#npc_state_delta_settings';
    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.1', api, settings }), true);
    assert.deepEqual(suite.providers().map(({ id, enabled, settings: root }) => [id, enabled, root]), [[SUITE_ID, true, settings]]);
    suite.announce({ id: 'story-block', name: 'Story Block', owns: ['scene'] });
    assert.equal(suite.owner('scene'), 'story-block');
    assert.equal(suite.owner('npc'), SUITE_ID);

    assert.equal(announceNpcStateDelta({ enabled: false, version: '1.2.1', api, settings }), false);
    const off = suite.providers().find(item => item.id === SUITE_ID);
    assert.ok(off, 'disabled is announced, not withdrawn');
    assert.deepEqual([off.enabled, off.settings, off.version, off.owns], [false, settings, '1.2.1', ['npc', 'calendar', 'scene', 'stats']]);
    assert.equal(off.api, api, 'the overlay reads the api from providers()');
    assert.equal(suite.has(SUITE_ID), false);
    assert.equal(suite.api(SUITE_ID), null, 'a disabled provider shares nothing through api()');
    assert.equal(suite.owner('npc'), null, 'a disabled Delta owns nothing');
    assert.equal(suite.owner('scene'), 'story-block');
    off.api.manage.setEnabled(1);
    assert.deepEqual(calls, [true], 'the overlay can switch it back on');

    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.1', api, settings }), true);
    assert.equal(suite.has(SUITE_ID), true);
    assert.equal(suite.owner('npc'), SUITE_ID);
    assert.equal(suite.providers().length, 2);
    assert.equal(announceNpcStateDelta({ enabled: true, version: '1.2.1' }), true);
    assert.equal('settings' in suite.providers().find(item => item.id === SUITE_ID), false, 'no panel, no settings field');
    assert.equal(announceNpcStateDelta({ enabled: true }, { announce() { throw new Error('broken'); } }), false, 'a broken registry is reported, not thrown');
});

test('v1.2.1 api.manage validates, copies and forwards to Delta\'s own settings actions', () => {
    let stored = { scene: 'mine', stats: 'bogus' };
    let enabled = true;
    const sets = [];
    const toggles = [];
    const manage = buildManageApi({
        sources: () => stored,
        setSource: (area, choice) => { sets.push([area, choice]); stored = { ...stored, [area]: choice }; },
        enabled: () => enabled,
        setEnabled: on => { toggles.push(on); enabled = on; },
    });
    assert.deepEqual(manage.areas, ['npc', 'calendar', 'scene', 'stats']);
    assert.deepEqual(manage.sources(), { npc: 'auto', calendar: 'auto', scene: 'mine', stats: 'auto' }, 'normalized');
    manage.sources().npc = 'theirs';
    assert.equal(manage.sources().npc, 'auto', 'sources() is a copy');
    assert.throws(() => manage.areas.push('items'), TypeError, 'areas cannot be changed by a reader');
    assert.throws(() => { manage.setSource = null; }, TypeError, 'nor can the api');
    assert.equal(manage.setSource('calendar', 'theirs'), true);
    assert.equal(manage.sources().calendar, 'theirs');
    for (const [area, choice] of [['items', 'mine'], ['scene', 'nonsense'], ['', 'auto'], [undefined, undefined]]) {
        assert.equal(manage.setSource(area, choice), false, `${area}/${choice} is refused`);
    }
    assert.deepEqual(sets, [['calendar', 'theirs']], 'refused choices never reach the settings');
    assert.equal(manage.enabled(), true);
    manage.setEnabled(0);
    assert.deepEqual(toggles, [false], 'setEnabled passes a boolean');
    assert.equal(manage.enabled(), false);
    const bare = buildManageApi();
    assert.deepEqual(bare.sources(), normalizeSourceOfTruth());
    assert.equal(bare.enabled(), true);
    assert.equal(bare.setSource('npc', 'mine'), true);
    assert.doesNotThrow(() => bare.setEnabled(true));
});

test('v1.2.1 "Manage all in Story Suite" needs two providers and Story Block\'s openSuite', () => {
    const suite = fresh();
    assert.equal(suiteManageAvailable(), false, 'alone there is no overlay');
    assert.equal(openSuiteOverlay(), false);
    announceNpcStateDelta({ enabled: true, version: '1.2.1' }, suite);
    assert.equal(suiteManageAvailable(), false);
    const opened = [];
    suite.announce({ id: 'story-block', name: 'Story Block', owns: ['scene'], api: { openSuite: tab => opened.push(tab) } });
    assert.equal(suiteManageAvailable(), true);
    assert.equal(openSuiteOverlay(), true);
    assert.deepEqual(opened, ['npc-state-delta'], 'opens on Delta\'s tab');
    suite.withdraw(SUITE_ID);
    assert.equal(suiteManageAvailable(), false, 'Story Block alone has no overlay');
    suite.announce({ id: SUITE_ID, name: 'NPC State Delta', owns: ['npc'], enabled: false });
    assert.equal(suiteManageAvailable(), true, 'a switched-off extension still counts');
    suite.announce({ id: 'story-block', name: 'Story Block', owns: ['scene'], api: {} });
    assert.equal(suiteManageAvailable(), false, 'an older Story Block without openSuite shows no line');
    suite.announce({ id: 'story-block', name: 'Story Block', owns: ['scene'], enabled: false, api: { openSuite: () => {} } });
    assert.equal(suiteManageAvailable(), false, 'a switched-off Story Block shares no overlay');
    suite.announce({ id: 'story-block', name: 'Story Block', owns: ['scene'], api: { openSuite: () => { throw new Error('boom'); } } });
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(openSuiteOverlay(), false, 'a failing overlay is reported, not thrown');
    } finally {
        console.warn = warn;
    }
    assert.equal(suiteManageAvailable({ providers() { throw new Error('broken'); } }), false);
    delete globalThis.StorySuite;
});

test('v1.2.0 source-of-truth choices normalize to auto and drive defersArea / areaOwner', () => {
    assert.deepEqual(normalizeSourceOfTruth(), { npc: 'auto', calendar: 'auto', scene: 'auto', stats: 'auto' });
    assert.deepEqual(normalizeSourceOfTruth({ scene: 'theirs', stats: 'bogus', calendar: 'mine', extra: 'x' }), { npc: 'auto', calendar: 'mine', scene: 'theirs', stats: 'auto' });
    assert.deepEqual(normalizeSourceOfTruth(['mine']), normalizeSourceOfTruth());
    const suite = fresh();
    announceNpcStateDelta({ enabled: true, version: '1.2.0' }, suite);
    for (const area of SUITE_AREAS) {
        for (const choice of ['auto', 'mine', 'theirs']) assert.equal(defersArea(area, { [area]: choice }), false, `alone: ${area}/${choice}`);
    }
    assert.equal(areaOwner('scene', {}), null);
    suite.announce({ id: 'story-block', name: 'Story Block', version: '0.8.0', owns: ['scene'] });
    assert.equal(defersArea('scene', {}), true);
    assert.deepEqual(areaOwner('scene', {}), { id: 'story-block', name: 'Story Block' });
    assert.equal(defersArea('scene', { scene: 'mine' }), false, 'This extension keeps Delta');
    assert.equal(defersArea('npc', { npc: 'theirs' }), false, 'nobody else offers npc');
    suite.announce({ id: 'story-director', name: 'Story Director', owns: ['npc'] });
    assert.deepEqual(areaOwner('npc', { npc: 'theirs' }), { id: 'story-director', name: 'Story Director' }, 'The other one names the other');
    assert.equal(defersArea('scene', {}, { offering: () => { throw new Error('broken'); } }), false, 'a broken registry never defers');
});

test('v1.2.0 stats: game-stat-like custom field names are detected as whole words', () => {
    assert.deepEqual(statLikeFieldNames(['Level', 'Faction', 'Max HP', 'class', 'Rank', 'Lv', 'STR', 'Interests', 'Classified', 'Home town', 'Exp.']), ['Level', 'Max HP', 'class', 'Rank', 'Lv', 'STR', 'Exp.']);
    assert.deepEqual(statLikeFieldNames(['Title', 'Hometown', 'Dexterous', 'Strengths']), [], 'only whole words count');
    assert.deepEqual(statLikeFieldNames(['luk', 'MP', 'xp', 'VIT', 'agi', 'DEX', 'INT', 'cha']), ['luk', 'MP', 'xp', 'VIT', 'agi', 'DEX', 'INT', 'cha']);
    assert.deepEqual(statLikeFieldNames(null), []);

    const suite = fresh();
    announceNpcStateDelta({ enabled: true, version: '1.2.0' }, suite);
    assert.equal(statsOverlapWarning(['Level', 'Faction'], {}), '', 'alone, Delta keeps its custom fields quietly');
    suite.announce({ id: 'rpg-battle', name: 'RPG Battle', owns: ['stats'] });
    assert.equal(statsOverlapWarning(['Level', 'Faction', 'HP'], {}), 'RPG Battle keeps game stats. Level, HP may duplicate or contradict it; consider removing those fields here.');
    assert.match(statsOverlapWarning(['Class'], {}), /Class may duplicate or contradict it; consider removing that field here\./);
    assert.equal(statsOverlapWarning(['Faction'], {}), '', 'no stat-like name, no warning');
    assert.equal(statsOverlapWarning(['Level'], { stats: 'mine' }), '', 'This extension silences the warning');
});

// Story Block writes its blocks into one hidden comment at the end of the reply (src/envelope.js);
// blocks kept by another extension carry a kept="Owner" stamp on their opening tag.
const WORLD_STATE = [
    '<World_State>',
    '**📅 Time:** 1022 AR, Redleaf 4, dusk | **🌤 Loc:** Harbor Gate | Saltmere | **🌡 Wx:** Fog, cold, lanterns',
    '---',
    '**👥 NPCs Present:**',
    '**Mira Vale:**',
    '* *Outfit:* Grey oilskin cloak over harbor-watch leathers',
    '* *Position:* Leaning on the gate winch',
    '* *Mood:* Wary, tired',
    '---',
    '**📡 Off-Screen:**',
    '* Old Brenn counts crates at the warehouse',
    '</World_State>',
].join('\n');
const ENVELOPE = [
    '<!-- STORY_BLOCKS_V1',
    '<Blocks>',
    '<Inventory>',
    'Coin Pouch | 1 | 85 Gold',
    '</Inventory>',
    '<Character kept="RPG Battle">',
    'HP: 62/62 | MP: 30/30',
    '</Character>',
    WORLD_STATE,
    '</Blocks>',
    '-->',
].join('\n');

test('v1.2.0 World State inside Story Block\'s hidden envelope reads like a plain <Blocks>', () => {
    const story = 'Mira lowers the lantern. "Gate closes at dark."';
    const plain = stripUiNoise(`${story}\n<Blocks>\n${WORLD_STATE}\n</Blocks>`);
    const enveloped = stripUiNoise(`${story}\n${ENVELOPE}`);
    assert.match(enveloped, /World State: \*\*📅 Time:\*\* 1022 AR, Redleaf 4, dusk/);
    assert.match(enveloped, /Mira Vale:\*\* \* \*Outfit:\* Grey oilskin cloak/);
    assert.match(enveloped, /Old Brenn counts crates/);
    assert.equal(enveloped, plain, 'the envelope is read exactly as the plain Megumin layout');
    assert.doesNotMatch(enveloped, /Coin Pouch|HP: 62|STORY_BLOCKS_V1|-->/, 'other blocks and the comment itself stay out');

    // A kept World State, Delta's own capture comment before it, and other comments.
    const kept = ENVELOPE.replace('<World_State>', '<World_State kept="Some Extension">');
    assert.equal(stripUiNoise(`${story}\n${kept}`), plain);
    const capture = '<!--npc_state_delta {"npcs":[]} -->';
    assert.equal(stripUiNoise(`${story}\n${capture}\n${ENVELOPE}`), plain);
    assert.equal(stripUiNoise(`${story}\n<!-- author note: Mira is a spy -->`), story, 'other comments are still stripped');
    assert.equal(stripUiNoise(`${story}\n<!-- STORY_BLOCKS_V1_CONTEXT_BEGIN -->`), story);

    // A reply cut off mid-envelope still yields what was written, as a cut plain <Blocks> does.
    const cut = ENVELOPE.split('\n').slice(0, -6).join('\n');
    assert.match(stripUiNoise(`${story}\n${cut}`), /World State: [\s\S]*Grey oilskin cloak/);
    // Without an envelope the reading is unchanged.
    assert.equal(stripUiNoise(story), story);
});

const MIRA = {
    id: 'npc_mira', name: 'Mira Vale', present: true, role: 'harbor watch captain', gender: 'female',
    personality: 'Dry, protective, slow to trust strangers.', speech: 'Clipped sentences, harbor slang.',
    goal: 'Keep the gate shut after dark', mood: 'wary, tired', status: 'favoring her left arm',
    keyRelationships: ['Old Brenn | mentor | gruff respect'], customFields: { Faction: 'Harbor Watch' },
    overallAppearance: 'Tall woman, weathered skin, a scar through the left eyebrow',
    appearance: 'Tall woman, weathered skin, a scar through the left eyebrow; grey oilskin cloak over watch leathers',
    lastSeenTurn: 3, seenCount: 3,
};

test('v1.2.0 scene deferred: present cards drop the live mood and the current outfit, nothing else', () => {
    const args = [[MIRA], 'Mira Vale waits at the gate.', 3, 3, undefined, 4000, null];
    const own = buildInjection(...args, { customFieldNames: ['Faction'] });
    assert.match(own, /mood: wary, tired/);
    assert.match(own, /grey oilskin cloak/);
    assert.equal(buildInjection(...args, { customFieldNames: ['Faction'], sceneDeferred: false }), own, 'off is the 1.1.12 injection');

    const deferred = buildInjection(...args, { customFieldNames: ['Faction'], sceneDeferred: true });
    assert.doesNotMatch(deferred, /mood: wary|grey oilskin|CURRENT VISIBLE APPEARANCE/);
    assert.match(deferred, /CURRENT STATE: status: favoring her left arm; live mood\/outfit: as in World State;/);
    assert.match(deferred, /ENDURING PHYSICAL FEATURES \(authoritative anatomy\): Tall woman, weathered skin, a scar through the left eyebrow/);
    for (const kept of [/personality: Dry, protective/, /established speech: Clipped sentences/, /current goal: Keep the gate shut/, /key relationships: Old Brenn/, /established details: Faction: Harbor Watch/, /role: harbor watch captain/]) {
        assert.match(deferred, kept);
    }

    // A selected form's appearance is its whole anatomy: kept, with World State named for the outfit.
    const formed = { ...MIRA, overallAppearance: '', appearance: '', appearanceForms: [{ name: 'Selkie', appearance: 'Sleek grey seal-woman, webbed hands, a seal-skin mantle' }], currentForm: 'Selkie' };
    const formDeferred = buildInjection([formed], ...args.slice(1), { sceneDeferred: true });
    assert.match(formDeferred, /CURRENT FORM ANATOMY \(authoritative; World State gives the outfit\): Sleek grey seal-woman/);
    // No mood, no status: the state still points at World State rather than claiming none.
    const quiet = buildInjection([{ ...MIRA, mood: '', status: '' }], ...args.slice(1), { sceneDeferred: true });
    assert.match(quiet, /CURRENT STATE: live mood\/outfit: as in World State;/);
});

test('v1.2.0 calendar deferred: Story Director\'s months and era replace Delta\'s own, with graceful fallback', () => {
    const local = { era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }], currentYear: 821, currentMonth: 'Sunwane', currentDay: 4 };
    const director = { era: 'AR', months: [{ name: 'Thaw', days: 20 }, { name: 'Sunwane', days: 40 }, { name: 'Ember', days: 25 }] };
    let shared = () => director;
    const suite = fresh();
    let choices = {};
    setActiveCalendarConfig(local);
    setExternalCalendarSource(() => externalCalendar(choices));
    try {
        assert.equal(getActiveCalendarConfig().era, 'CR', 'alone, Delta keeps its own calendar');
        announceNpcStateDelta({ enabled: true, version: '1.2.0' }, suite);
        assert.equal(getActiveCalendarConfig().era, 'CR');
        suite.announce({ id: 'story-director', name: 'Story Director', owns: ['calendar', 'npc'], api: { calendar: () => shared() } });
        const config = getActiveCalendarConfig();
        assert.equal(config.era, 'AR');
        assert.deepEqual(config.months.map(month => `${month.name}:${month.days}`), ['Thaw:20', 'Sunwane:40', 'Ember:25']);
        assert.deepEqual([config.currentYear, config.currentMonth, config.currentDay], [821, 'Sunwane', 4], 'the manual clock is kept when it fits');
        assert.equal(getActiveCalendarConfig(), config, 'an unchanged calendar is reused');
        assert.ok(['Thaw', 'Sunwane', 'Ember'].includes(deterministicCalendarBirthday('Mira Vale', getActiveCalendarConfig()).month), 'generated birthdays use the shared months');

        shared = () => ({ era: 'AR', months: [{ name: 'Thaw', days: 20 }] });
        assert.deepEqual([getActiveCalendarConfig().currentYear, getActiveCalendarConfig().months.length], [null, 1], 'a clock that does not fit is dropped, the shared months stay');

        choices = { calendar: 'mine' };
        assert.equal(getActiveCalendarConfig().era, 'CR', 'This extension keeps Delta\'s calendar');
        choices = {};
        for (const broken of [() => { throw new Error('boom'); }, () => null, () => ({ era: 'AR', months: [] }), () => ({ months: [{ name: 'Thaw', days: 0 }] }), () => 'AR']) {
            shared = broken;
            assert.equal(getActiveCalendarConfig().era, 'CR', 'a throwing, empty or invalid calendar falls back to Delta\'s own');
        }
        suite.announce({ id: 'story-director', name: 'Story Director', owns: ['calendar'] });
        assert.equal(getActiveCalendarConfig().era, 'CR', 'no calendar api, no change');
        suite.withdraw('story-director');
        assert.equal(getActiveCalendarConfig().era, 'CR');
    } finally {
        setExternalCalendarSource(null);
        setActiveCalendarConfig(null);
        delete globalThis.StorySuite;
    }
    assert.equal(getActiveCalendarConfig(), null);
});

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runHostScenario(name, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.readyState = 'loading';
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await (${scenario.toString()})();
    console.log('story suite scenario ${name} passed');
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

test('v1.2.0 the runtime announces itself, follows Enable and defers the scene to Story Block', () => {
    runHostScenario('announce-and-defer', async () => {
        const suite = globalThis.StorySuite;
        const settings = mockState.extensionSettings.npc_state_delta;
        assert.ok(suite, 'the runtime creates the shared registry');
        const own = suite.providers().find(item => item.id === 'npc-state-delta');
        assert.deepEqual(own.owns, ['npc', 'calendar', 'scene', 'stats']);
        assert.equal(own.version, globalThis.NPCStateDelta.version);
        assert.deepEqual(settings.sourceOfTruth, { npc: 'auto', calendar: 'auto', scene: 'auto', stats: 'auto' });
        assert.deepEqual(suite.api('npc-state-delta').npcs(), []);

        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'nervous, eager', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves nervously from the gate.', swipe_id: 0, swipes: ['Yunyun waves nervously from the gate.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);
        assert.deepEqual(suite.api('npc-state-delta').npcs().map(npc => [npc.name, npc.present]), [['Yunyun', true]]);
        const lastPrompt = () => mockState.prompts.filter(args => args[0] === 'npc_state_delta_live_dossier').at(-1)?.[1] || '';
        assert.match(lastPrompt(), /mood: nervous, eager/, 'alone, the live mood is sent');

        suite.announce({ id: 'story-block', name: 'Story Block', version: '0.8.0', owns: ['scene'] });
        await sleep(10);
        assert.doesNotMatch(lastPrompt(), /mood: nervous/, 'the suite change refreshes the injection');
        assert.match(lastPrompt(), /live mood\/outfit: as in World State/);
        assert.match(lastPrompt(), /Yunyun/);

        const choose = uiHandlers.get('change.npcStateDelta|[data-delta-source-area]');
        choose.call({ dataset: { deltaSourceArea: 'scene' }, value: 'mine' });
        assert.equal(settings.sourceOfTruth.scene, 'mine');
        assert.match(lastPrompt(), /mood: nervous, eager/, 'This extension keeps Delta\'s scene');
        choose.call({ dataset: { deltaSourceArea: 'scene' }, value: 'nonsense' });
        assert.equal(settings.sourceOfTruth.scene, 'auto');

        const enable = uiHandlers.get('change.npcStateDelta|#npc_state_delta_enabled');
        enable.call({ checked: false });
        assert.equal(suite.has('npc-state-delta'), false, 'disable leaves the areas');
        assert.equal(suite.providers().find(item => item.id === 'npc-state-delta')?.enabled, false, 'and stays announced as off');
        enable.call({ checked: true });
        assert.equal(suite.has('npc-state-delta'), true, 'enable announces again');
    });
});

test('v1.2.1 the runtime shares its panel and api.manage, and shows Manage all in Story Suite', () => {
    runHostScenario('overlay-manage', async () => {
        const suite = globalThis.StorySuite;
        const settings = mockState.extensionSettings.npc_state_delta;
        // Record what the runtime writes into its own controls.
        const baseQuery = globalThis.$;
        const writes = [];
        globalThis.$ = selector => {
            const q = baseQuery(selector);
            if (typeof selector !== 'string') return q;
            for (const method of ['prop', 'val']) {
                const original = q[method];
                q[method] = (...args) => { if (args.length) writes.push([selector, method, ...args]); return original.apply(q, args); };
            }
            return q;
        };
        const lastWrite = (selector, method, key) => writes.filter(([s, m, k]) => s === selector && m === method && (key === undefined || k === key)).at(-1);
        const own = () => suite.providers().find(item => item.id === 'npc-state-delta');
        assert.equal(own().settings, '#npc_state_delta_settings', 'the announcement names the settings panel root');
        const manage = own().api.manage;
        assert.deepEqual(manage.areas, ['npc', 'calendar', 'scene', 'stats']);
        assert.deepEqual(manage.sources(), { npc: 'auto', calendar: 'auto', scene: 'auto', stats: 'auto' });
        assert.equal(manage.enabled(), true);

        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'nervous, eager', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves nervously from the gate.', swipe_id: 0, swipes: ['Yunyun waves nervously from the gate.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);
        const lastPrompt = () => mockState.prompts.filter(args => args[0] === 'npc_state_delta_live_dossier').at(-1)?.[1] || '';
        const alone = lastPrompt();
        assert.match(alone, /mood: nervous, eager/);

        // Story Block arrives with its overlay: the line is shown in the next batched refresh.
        writes.length = 0;
        const opened = [];
        suite.announce({ id: 'story-block', name: 'Story Block', version: '0.9.0', owns: ['scene'], api: { openSuite: tab => opened.push(tab) } });
        assert.equal(lastWrite('#npc_state_delta_suite_manage', 'prop', 'hidden'), undefined, 'refreshed in the onChange microtask, not inline');
        await sleep(10);
        assert.deepEqual(lastWrite('#npc_state_delta_suite_manage', 'prop', 'hidden'), ['#npc_state_delta_suite_manage', 'prop', 'hidden', false]);
        assert.match(lastPrompt(), /live mood\/outfit: as in World State/);
        const click = uiHandlers.get('click.npcStateDelta|[data-delta-open-suite]');
        let prevented = false;
        click({ preventDefault: () => { prevented = true; } });
        assert.deepEqual(opened, ['npc-state-delta']);
        assert.equal(prevented, true);

        // setSource does what the select does, and updates the select.
        assert.equal(manage.setSource('scene', 'mine'), true);
        assert.equal(settings.sourceOfTruth.scene, 'mine');
        assert.deepEqual(manage.sources(), { npc: 'auto', calendar: 'auto', scene: 'mine', stats: 'auto' });
        assert.deepEqual(lastWrite('#npc_state_delta_source_scene', 'val'), ['#npc_state_delta_source_scene', 'val', 'mine']);
        assert.equal(lastPrompt(), alone, 'This extension restores the injection Delta sends alone');
        assert.equal(manage.setSource('scene', 'nonsense'), false);
        assert.equal(manage.setSource('items', 'mine'), false);
        assert.equal(settings.sourceOfTruth.scene, 'mine', 'refused choices change nothing');
        assert.deepEqual(Object.keys(settings.sourceOfTruth), ['npc', 'calendar', 'scene', 'stats']);
        assert.equal(manage.setSource('scene', 'auto'), true);
        assert.match(lastPrompt(), /live mood\/outfit: as in World State/);

        // setEnabled does what the Enable checkbox does, and updates the checkbox.
        manage.setEnabled(false);
        assert.equal(settings.enabled, false);
        assert.deepEqual(lastWrite('#npc_state_delta_enabled', 'prop', 'checked'), ['#npc_state_delta_enabled', 'prop', 'checked', false]);
        assert.equal(own().enabled, false, 'announced as off');
        assert.equal(own().settings, '#npc_state_delta_settings');
        assert.equal(own().api.manage.enabled(), false);
        assert.equal(suite.has('npc-state-delta'), false);
        assert.equal(suite.api('npc-state-delta'), null);
        assert.equal(lastPrompt(), '', 'disabled sends nothing, as from the checkbox');
        await sleep(10);
        assert.deepEqual(lastWrite('#npc_state_delta_suite_manage', 'prop', 'hidden'), ['#npc_state_delta_suite_manage', 'prop', 'hidden', false], 'two announced, on or off');
        const announcements = suite.providers().length;
        manage.setEnabled(false);
        assert.equal(suite.providers().length, announcements);
        own().api.manage.setEnabled(true);
        assert.equal(settings.enabled, true);
        assert.deepEqual(lastWrite('#npc_state_delta_enabled', 'prop', 'checked'), ['#npc_state_delta_enabled', 'prop', 'checked', true]);
        assert.equal(suite.has('npc-state-delta'), true);
        assert.match(lastPrompt(), /live mood\/outfit: as in World State/, 'enabled again, the injection returns');

        // Story Block leaves: the line hides again.
        suite.withdraw('story-block');
        await sleep(10);
        assert.deepEqual(lastWrite('#npc_state_delta_suite_manage', 'prop', 'hidden'), ['#npc_state_delta_suite_manage', 'prop', 'hidden', true]);
        assert.equal(lastPrompt(), alone, 'alone again, the injection is the one Delta sends alone');
        globalThis.$ = baseQuery;
    });
});

test('v1.2.1 the settings panel starts with a hidden Manage all in Story Suite line', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const html = index.slice(index.indexOf('function buildSettingsHtml()'), index.indexOf('function readOpenSettingsGroups()'));
    assert.match(html, /<div id="\$\{UI_ID\}" class="extension_container[\s\S]*npc-state-delta-drawer">\s*<div id="npc_state_delta_suite_manage" class="npc-state-delta-suite-manage" data-story-suite-link hidden>\s*<button type="button" class="menu_button" data-delta-open-suite>[^<]*<i [^>]*><\/i> Manage all in Story Suite<\/button>\s*<\/div>\s*<div class="delta-settings-quickbar">/);
    assert.match(index, /const UI_ID = 'npc_state_delta_settings';/);
    assert.equal((html.match(/data-story-suite-link/g) || []).length, 1, 'the line carries data-story-suite-link so the overlay can hide it while the panel is inside');
    assert.match(html, /<div [^>]*data-story-suite-link[^>]*>\s*<button [^>]*data-delta-open-suite>/, 'on the element that holds the link');
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.npc-state-delta-suite-manage\[hidden\] \{ display: none; \}/);
});
