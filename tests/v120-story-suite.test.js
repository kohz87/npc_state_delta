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
    NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS,
    NPC_PROFILE_ROLE_MAX,
    NPC_PROFILE_SUMMARY_MAX,
    SUITE_SHOWS,
    copyTokenEstimate,
    injectionSections,
    replyTokenEstimate,
    buildManageApi,
    buildNpcProfile,
    buildNpcProfiles,
    defersArea,
    externalCalendar,
    normalizeSourceOfTruth,
    openSuiteOverlay,
    statLikeFieldNames,
    statsOverlapWarning,
    resolveDossierTarget,
    suiteManageAvailable,
    trimAtWord,
} from '../suite-handshake.js';
import { buildInjection, getActiveCalendarConfig, normalizeNpcRecord, setNpcArchived, setActiveCalendarConfig, setExternalCalendarSource, stripUiNoise } from '../core.js';
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
    assert.match(html, /<div id="\$\{UI_ID\}" class="extension_container[\s\S]*npc-state-delta-drawer story-suite-panel">\s*<div id="npc_state_delta_suite_manage" class="npc-state-delta-suite-manage story-suite-manage" data-story-suite-link hidden>\s*<button type="button" class="menu_button" data-delta-open-suite>[^<]*<i class="fa-solid fa-layer-group"><\/i> Manage all in Story Suite<\/button>\s*<\/div>\s*<div class="delta-settings-quickbar story-suite-quickbar">/);
    assert.match(index, /const UI_ID = 'npc_state_delta_settings';/);
    assert.equal((html.match(/data-story-suite-link/g) || []).length, 1, 'the line carries data-story-suite-link so the overlay can hide it while the panel is inside');
    assert.match(html, /<div [^>]*data-story-suite-link[^>]*>\s*<button [^>]*data-delta-open-suite>/, 'on the element that holds the link');
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.npc-state-delta-suite-manage\[hidden\] \{ display: none; \}/);
});

test('v1.2.2 trimAtWord keeps whole words and ends a shortened text in an ellipsis', () => {
    assert.equal(trimAtWord('  short   text ', 200), 'short text');
    assert.equal(trimAtWord('aaaa bbbb cccc', 10), 'aaaa bbbb…');
    assert.equal(trimAtWord('aaaa bbbb cccc', 12), 'aaaa bbbb…');
    assert.equal(trimAtWord('aaaa bbbb; cccc', 12), 'aaaa bbbb…', 'no dangling separator before the ellipsis');
    assert.equal(trimAtWord('unbrokenwordthatislong', 8), 'unbroke…', 'one long word is cut inside, still within the cap');
    assert.equal(trimAtWord(null, 10), '');
    assert.equal(trimAtWord({ toString: () => 'x' }, 10), '');
});

test('v1.2.2 npc profiles: tracked, non-archived NPCs with a short role and a <= 200-char summary', () => {
    const lyra = {
        id: 'npc-lyra', name: 'Lyra Vance', aliases: ['Lyra', 'the healer'], present: true,
        role: 'Temple healer; former field medic of the Third Legion', species: 'elf',
        personality: 'Calm, dry, protective of the young; slow to trust strangers.',
        background: 'Raised in the Silver Temple, she served a decade as a field medic before taking her vows and returning to tend the poor of Ironvale and its mines.',
        speech: 'Clipped and formal.', mood: 'tired', appearance: 'grey robes',
        customFields: { Abilities: 'healing magic, shortsword', Level: '5', Faction: 'Silver Temple' },
        relationship: { trust: 40 }, memories: ['healed Ren'],
    };
    const npcs = [
        lyra,
        { id: 'npc-guard', name: 'Gate guard', role: 'guard', archived: true, present: false },
        { id: 'npc-ren', name: 'Ren', role: '', customFields: { class: 'Ranger', Skills: 'tracking, archery' }, personality: 'Quiet.' },
        { id: 'npc-empty', name: 'Mira' },
        null,
        'not a dossier',
    ];
    const profiles = buildNpcProfiles(npcs, { customFieldNames: ['Class', 'Abilities', 'Skills', 'Level', 'Faction'] });
    assert.deepEqual(profiles.map(profile => profile.id), ['npc-lyra', 'npc-ren', 'npc-empty'], 'archived and malformed entries are left out, dossier order kept');
    assert.deepEqual(Object.keys(profiles[0]), ['id', 'name', 'aliases', 'present', 'role', 'summary']);
    assert.deepEqual({ ...profiles[0], aliases: [...profiles[0].aliases] }, {
        id: 'npc-lyra', name: 'Lyra Vance', aliases: ['Lyra', 'the healer'], present: true,
        role: 'Temple healer',
        summary: 'Temple healer; former field medic of the Third Legion (elf). Abilities: healing magic, shortsword. Calm, dry, protective of the young; slow to trust strangers. Raised in the Silver Temple, she served…',
    });
    assert.ok(profiles[0].summary.length <= NPC_PROFILE_SUMMARY_MAX);
    assert.doesNotMatch(profiles[0].summary, /Level|Faction|tired|grey robes|Clipped/, 'only identity, abilities, personality and background are used');
    assert.deepEqual([profiles[1].role, profiles[1].summary, profiles[1].present], ['Ranger', 'Ranger. Skills: tracking, archery. Quiet.', false], 'a Class custom field stands in for an empty role and is not repeated');
    assert.deepEqual([profiles[2].role, profiles[2].summary, [...profiles[2].aliases]], ['', '', []]);

    // Plain frozen copies: the dossier is not shared or changed.
    assert.ok(Object.isFrozen(profiles) && profiles.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.aliases)));
    assert.notEqual(profiles[0].aliases, lyra.aliases);
    assert.throws(() => { 'use strict'; profiles[0].aliases.push('x'); }, TypeError);
    lyra.aliases.push('Vance');
    assert.deepEqual([...profiles[0].aliases], ['Lyra', 'the healer']);
    assert.deepEqual(Object.keys(lyra.customFields), ['Abilities', 'Level', 'Faction']);

    // Unconfigured custom fields are not read; without a dossier role the summary starts from species.
    assert.equal(buildNpcProfile({ id: 'x', name: 'X', species: 'dwarf', customFields: { Class: 'Cleric' }, personality: 'Gruff' }).summary, 'dwarf. Gruff.');
    assert.equal(buildNpcProfile({ id: 'x', name: 'X', species: 'Elf', role: 'Elf archer' }).summary, 'Elf archer.', 'species already in the role is not repeated');
    const longRole = buildNpcProfile({ id: 'x', name: 'X', role: 'Keeper of the old northern lighthouse and the drowned archive beneath the harbour cliffs' }).role;
    assert.ok(longRole.length <= NPC_PROFILE_ROLE_MAX && longRole.endsWith('…'), longRole);
    assert.equal(buildNpcProfile({ id: 'x', name: 'X', role: 'Blacksmith — once a soldier' }).role, 'Blacksmith');
});

test('v1.2.2 npc profiles leave out the dead, archived or not, and keep the living and the restored', () => {
    const npcs = [
        { id: 'alive', name: 'Alive', lifeState: 'alive', lifeStateCertainty: 'explicit' },
        { id: 'unknown', name: 'Unknown', lifeState: 'unknown' },
        { id: 'dead-explicit', name: 'Dead', lifeState: 'deceased', lifeStateCertainty: 'explicit', archived: false },
        { id: 'dead-inferred', name: 'Probably dead', lifeState: 'deceased', lifeStateCertainty: 'inferred' },
        { id: 'dead-case', name: 'Dead case', lifeState: ' Deceased ' },
        { id: 'dead-archived', name: 'Archived dead', lifeState: 'deceased', archived: true, archiveReason: 'deceased' },
        { id: 'restored', name: 'Restored', lifeState: 'alive', lifeStateCertainty: 'explicit', archived: false, archiveReason: '' },
    ];
    assert.deepEqual(buildNpcProfiles(npcs).map(profile => profile.id), ['alive', 'unknown', 'restored']);
    // The same through the dossier owner's own records: a confirmed death kept unarchived
    // (Auto-archive deaths off) is left out; a manual Restore marks the NPC alive again.
    const dead = normalizeNpcRecord({ id: 'n1', name: 'Orrin', lifeState: 'deceased', lifeStateCertainty: 'explicit' });
    assert.equal(dead.archived, false);
    const restored = setNpcArchived(setNpcArchived(dead, true, { reason: 'deceased' }), false, { allowDeathCorrection: true });
    assert.deepEqual(buildNpcProfiles([dead]), []);
    assert.deepEqual(buildNpcProfiles([restored]).map(profile => profile.id), ['n1']);
});

test('v1.2.2 npc profiles never throw and read nothing but the dossiers given', () => {
    assert.deepEqual(buildNpcProfiles(undefined), []);
    assert.deepEqual(buildNpcProfiles({ npcs: [] }), []);
    const hostile = { id: 'h', name: 'H' };
    Object.defineProperty(hostile, 'role', { get() { throw new Error('boom'); } });
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.deepEqual(buildNpcProfiles([hostile]), []);
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(buildNpcProfiles([{ id: 'a', name: 'A', role: 7, aliases: 'Al', customFields: ['bad'] }], { customFieldNames: 'Class' }).map(p => [p.role, [...p.aliases], p.summary]), [['7', [], '7.']]);
});

test('v1.2.2 the runtime shares npcProfiles() beside the unchanged npcs(), with no request or prompt', () => {
    runHostScenario('npc-profiles', async () => {
        const suite = globalThis.StorySuite;
        const api = suite.api('npc-state-delta');
        assert.deepEqual(api.npcProfiles(), [], 'empty until the chat\'s dossiers load');
        mockState.extensionSettings.npc_state_delta.customFieldNames = ['Abilities'];
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', species: 'human', personality: 'Shy, earnest and fiercely loyal to her rival.', customFields: { Abilities: 'advanced magic' }, mood: 'nervous, eager', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun, the shy human adventurer who casts advanced magic, waves nervously from the gate.', swipe_id: 0, swipes: ['Yunyun, the shy human adventurer who casts advanced magic, waves nervously from the gate.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);

        const npcs = api.npcs();
        assert.deepEqual(npcs.map(npc => Object.keys(npc)), [['id', 'name', 'aliases', 'present', 'archived']], 'npcs() is unchanged');
        const requests = mockState.rawCalls.length;
        const prompts = mockState.prompts.length;
        const profiles = api.npcProfiles();
        assert.equal(profiles.length, 1);
        const [yunyun] = profiles;
        assert.deepEqual([yunyun.id, yunyun.name, yunyun.present, yunyun.role], [npcs[0].id, 'Yunyun', true, 'adventurer']);
        assert.match(yunyun.summary, /^adventurer \(human\)\./);
        assert.ok(yunyun.summary.length <= 200);
        assert.ok(Object.isFrozen(profiles) && Object.isFrozen(yunyun));
        assert.equal(mockState.rawCalls.length, requests, 'no model request');
        assert.equal(mockState.prompts.length, prompts, 'no prompt write');
        assert.notEqual(api.npcProfiles(), profiles, 'each call returns a fresh copy');
    });
});

test('v1.2.2 openDossier resolution: id first, then a unique name or alias among non-archived NPCs', () => {
    const npcs = [
        { id: 'npc-lyra', name: 'Lyra Vance', aliases: ['Lyra', 'the Healer'] },
        { id: 'npc-orrin', name: 'Orrin Hask', aliases: ['Capt. Hask'], archived: true, archiveReason: 'manual' },
        { id: 'npc-ren', name: 'Ren', aliases: ['Lyra Vance'] },
        { id: 'npc-twin-a', name: 'Twin', aliases: ['Sam'] },
        { id: 'npc-twin-b', name: 'twin', aliases: ['Sam'] },
        { id: 'npc-lyra-alias', name: 'Old Orrin', aliases: ['Orrin Hask'] },
        { name: 'No id' },
        null,
    ];
    assert.equal(resolveDossierTarget(npcs, 'npc-lyra'), 'npc-lyra');
    assert.equal(resolveDossierTarget(npcs, '  npc-ren '), 'npc-ren');
    assert.equal(resolveDossierTarget(npcs, 'npc-orrin'), '', 'an archived id opens nothing, with no name fallback');
    assert.equal(resolveDossierTarget(npcs, 'lyra vance'), 'npc-lyra', 'a name matches case-insensitively and wins over another NPC\'s alias');
    assert.equal(resolveDossierTarget(npcs, 'THE HEALER'), 'npc-lyra', 'an alias matches when no name does');
    assert.equal(resolveDossierTarget(npcs, 'Orrin Hask'), 'npc-lyra-alias', 'archived NPCs are not matched by name');
    assert.equal(resolveDossierTarget(npcs, 'Capt. Hask'), '', 'an archived NPC\'s alias matches nothing');
    assert.equal(resolveDossierTarget(npcs, 'Twin'), '', 'an ambiguous name opens nothing');
    assert.equal(resolveDossierTarget(npcs, 'Sam'), '', 'an ambiguous alias opens nothing');
    assert.equal(resolveDossierTarget(npcs, 'Lyr'), '', 'only exact matches');
    assert.equal(resolveDossierTarget(npcs, 'nobody'), '');
    assert.equal(resolveDossierTarget(npcs, ''), '');
    assert.equal(resolveDossierTarget(npcs, null), '');
    assert.equal(resolveDossierTarget(npcs, { id: 'npc-lyra' }), '');
    assert.equal(resolveDossierTarget(undefined, 'npc-lyra'), '');
    const hostile = [{ get id() { throw new Error('boom'); } }];
    assert.equal(resolveDossierTarget(hostile, 'x'), '', 'never throws');
});

test('v1.2.2 the runtime openDossier opens the launcher dossier path, and nothing for archived or unknown NPCs', () => {
    runHostScenario('open-dossier', async () => {
        const suite = globalThis.StorySuite;
        const api = suite.api('npc-state-delta');
        const opened = [];
        document.addEventListener('npc-state-delta:open-dossier', event => { opened.push(event.detail.npcId); event.detail.handled = true; });
        assert.equal(api.openDossier('Yunyun'), false, 'nothing before the dossiers exist');

        mockState.quietResponder = async () => JSON.stringify({ npcs: [
            { name: 'Yunyun', aliases: ['Yun'], present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
            { name: 'Wiz', present: true, role: 'shopkeeper', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named shopkeeper', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
        ] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is here?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun (Yun to friends) waves while Wiz minds her shop.', swipe_id: 0, swipes: ['Yunyun (Yun to friends) waves while Wiz minds her shop.'] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);
        const [yunyun, wiz] = ['Yunyun', 'Wiz'].map(name => api.npcs().find(npc => npc.name === name));
        assert.ok(yunyun && wiz);

        const requests = mockState.rawCalls.length;
        const prompts = mockState.prompts.length;
        const before = JSON.stringify(globalThis.NPCStateDelta.getState());
        assert.equal(api.openDossier(yunyun.id), true);
        assert.equal(api.openDossier('yunyun'), true, 'name fallback');
        assert.equal(api.openDossier('YUN'), true, 'alias fallback');
        assert.equal(api.openDossier('nobody'), false);
        assert.equal(api.openDossier(), false);
        assert.deepEqual(opened, [yunyun.id, yunyun.id, yunyun.id], 'the same open path as the launcher and present cast');
        assert.equal(mockState.rawCalls.length, requests, 'no model request');
        assert.equal(mockState.prompts.length, prompts, 'no prompt write');
        assert.equal(JSON.stringify(globalThis.NPCStateDelta.getState()), before, 'no data change');

        await globalThis.NPCStateDelta.archive(wiz.id);
        assert.equal(api.npcs().find(npc => npc.id === wiz.id)?.archived, true);
        assert.equal(api.openDossier(wiz.id), false, 'archived by id');
        assert.equal(api.openDossier('Wiz'), false, 'archived by name');
        assert.deepEqual(opened, [yunyun.id, yunyun.id, yunyun.id]);
    });
});

test('v1.2.2 Delta announces shows: [\'chatter\'] while enabled, never while off', () => {
    const suite = fresh();
    const api = { npcs: () => [], manage: buildManageApi({ setEnabled: () => {} }) };
    assert.deepEqual(SUITE_SHOWS, ['chatter']);
    announceNpcStateDelta({ enabled: true, version: '1.2.2', api, shows: SUITE_SHOWS }, suite);
    assert.deepEqual(suite.providers().find(item => item.id === SUITE_ID).shows, ['chatter']);
    announceNpcStateDelta({ enabled: false, version: '1.2.2', api, shows: SUITE_SHOWS }, suite);
    const off = suite.providers().find(item => item.id === SUITE_ID);
    assert.equal(off.enabled, false);
    assert.equal('shows' in off, false, 'the enabled: false announcement carries no shows');
    announceNpcStateDelta({ enabled: true, version: '1.2.2', api }, suite);
    assert.equal('shows' in suite.providers().find(item => item.id === SUITE_ID), false, 'without shows, none is announced');
});

test('v1.2.2 tokens(): the injection by section plus one-pass capture, about four characters a token', () => {
    const injection = [
        'NPC STATE DELTA DOSSIER. Only confirmed-present NPCs are included.', // 66
        'IDENTITY FIRST / DOMINATES: personality sets identity.', // 54
        '- Yunyun: personality: shy; speech: polite', // 42
        '- Wiz: personality: kind', // 24
        'MENTIONED, NOT PRESENT: NPCs the recent story names.', // 52
        '- Megumin (mentioned, not present; archwizard)', // 46
        'DECEASED, REFERENCED ONLY: these NPCs are dead.', // 47
        '- Old Brenn (deceased)', // 22
        'RELATIONSHIP-TO-BEHAVIOR RUBRIC: trust permits candor.', // 54
    ].join('\n');
    assert.deepEqual(injectionSections(injection), [
        { label: 'Dossier instructions', chars: 66 + 1 + 54 },
        { label: 'Present NPC cards', chars: 43 + 25 },
        { label: 'Mentioned NPCs', chars: 53 + 47 },
        { label: 'Deceased references', chars: 48 + 23 },
        { label: 'Relationship rubric', chars: 55 },
    ]);
    const estimate = replyTokenEstimate({ injection });
    assert.deepEqual(estimate.parts.map(part => [part.label, part.input, part.output]), [
        ['Dossier instructions', 31, 0], ['Present NPC cards', 17, 0], ['Mentioned NPCs', 25, 0], ['Deceased references', 18, 0], ['Relationship rubric', 14, 0],
    ]);
    assert.deepEqual([estimate.input, estimate.output], [105, 0], 'output stays 0: the injection asks for nothing in the reply');
    assert.ok(Math.abs(estimate.input - injection.length / 4) <= estimate.parts.length, 'about four characters a token');

    const capture = replyTokenEstimate({ injection, captureChars: 7998, captureOutputChars: NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS });
    assert.deepEqual(capture.parts.slice(-2), [
        { label: 'One-pass capture instruction', input: 2000, output: 0 },
        { label: 'One-pass capture block', input: 0, output: 300 },
    ]);
    assert.deepEqual([capture.input, capture.output], [2105, 300]);
    assert.deepEqual(replyTokenEstimate(), { input: 0, output: 0, parts: [] });
    assert.deepEqual(replyTokenEstimate({ injection: '', captureChars: 400, captureOutputChars: 80 }), { input: 100, output: 20, parts: [
        { label: 'One-pass capture instruction', input: 100, output: 0 }, { label: 'One-pass capture block', input: 0, output: 20 },
    ] });
    assert.deepEqual(copyTokenEstimate({ input: 999, parts: [{ label: 'x', input: '3.4', output: -2 }, null] }), { input: 3, output: 0, parts: [{ label: 'x', input: 3, output: 0 }] });
    const manage = buildManageApi({ tokens: () => { throw new Error('boom'); } });
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.deepEqual(manage.tokens(), { input: 0, output: 0, parts: [] }, 'never throws');
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(buildManageApi().tokens(), { input: 0, output: 0, parts: [] });
});

test('v1.2.2 the runtime: tokens() measures the live injection, shows: chatter, now lines and chatter bubbles', () => {
    runHostScenario('present-scene', async () => {
        const suite = globalThis.StorySuite;
        const own = () => suite.providers().find(item => item.id === 'npc-state-delta');
        assert.deepEqual(own().shows, ['chatter'], 'shows chatter while enabled');
        const manage = own().api.manage;
        assert.deepEqual(manage.tokens(), { input: 0, output: 0, parts: [] }, 'nothing before a scene');

        const worldState = '**👥 NPCs Present:**\n**Yunyun:**\n* *Outfit:* red ribbon\n* *Mood:* flustered';
        const chatter = '**Yunyun:** <i>Did he see?</i>\nWiz: Such a nice couple.\nMegumin: Boring.';
        const reply = `Yunyun waves from the gate while Wiz minds her shop.\n<World_State>${worldState}</World_State>\n<NPC_Inner_Chatter>${chatter}</NPC_Inner_Chatter>`;
        const reads = [];
        globalThis.StoryBlock = {
            listBlocks: () => [
                { tag: 'World_State', display: 'scene', enabled: true },
                { tag: 'NPC_Inner_Chatter', display: 'chatter', enabled: true },
            ],
            blockInText: (text, tag) => {
                reads.push(tag);
                const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(String(text));
                return found ? { tag, text: found[1], messageIndex: null } : null;
            },
        };
        mockState.quietResponder = async () => JSON.stringify({ npcs: [
            { name: 'Yunyun', present: true, role: 'adventurer', mood: 'nervous', status: 'healthy', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
            { name: 'Wiz', present: true, role: 'shopkeeper', mood: 'cheerful', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named shopkeeper', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } },
        ] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is here?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: reply, swipe_id: 0, swipes: [reply] });
        const id = mockState.context.chat.length - 1;
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        await sleep(200);

        // tokens(): the same injection Delta sends, split by section; no request is made for it.
        const requests = mockState.rawCalls.length;
        const sent = mockState.prompts.filter(args => args[0] === 'npc_state_delta_live_dossier').at(-1)?.[1] || '';
        assert.ok(sent.length > 0);
        const tokens = manage.tokens();
        assert.ok(tokens.parts.some(part => part.label === 'Present NPC cards' && part.input > 0));
        assert.equal(tokens.output, 0);
        assert.equal(tokens.input, tokens.parts.reduce((total, part) => total + part.input, 0));
        assert.ok(Math.abs(tokens.input - sent.length / 4) <= tokens.parts.length, `${tokens.input} ≈ ${sent.length} / 4`);
        assert.equal(mockState.rawCalls.length, requests, 'no model request');

        // Alone: the now line is Delta's own; chatter bubbles beside the speakers; Others for Megumin.
        const alone = globalThis.NPCStateDelta.presentCastHtml();
        assert.match(alone, /data-delta-scene="/);
        assert.match(alone, /class="npc-state-delta-present-now" data-delta-text/);
        assert.doesNotMatch(alone, /present-now-world/, 'without Story Block keeping the scene, Delta\'s own now line');
        assert.match(alone, /npc-state-delta-present-cell-chatter[\s\S]*npc-state-delta-chatter-speech/);
        assert.match(alone, /npc-state-delta-chatter-others/);
        assert.doesNotMatch(alone, /<i>Did he see|Such a nice couple|Boring|flustered/, 'story text never enters the markup');
        assert.ok(reads.includes('NPC_Inner_Chatter'));
        assert.match(inlineAnchors[0]?.innerHTML || '', /npc-state-delta-present-cell-chatter/, 'the in-chat cards show the bubbles too');

        // Story Block keeps the scene: the now line comes from its World State.
        suite.announce({ id: 'story-block', name: 'Story Block', version: '0.9.1', owns: ['scene'] });
        await sleep(10);
        assert.match(globalThis.NPCStateDelta.presentCastHtml(), /npc-state-delta-present-now npc-state-delta-present-now-world/);
        assert.equal(mockState.rawCalls.length, requests, 'display only: still no request');
        const state = JSON.stringify(globalThis.NPCStateDelta.getState());
        globalThis.NPCStateDelta.presentCastHtml();
        globalThis.NPCStateDelta.renderInline();
        assert.equal(JSON.stringify(globalThis.NPCStateDelta.getState()), state, 'no data change');

        const enable = uiHandlers.get('change.npcStateDelta|#npc_state_delta_enabled');
        enable.call({ checked: false });
        assert.equal(own().enabled, false);
        assert.equal('shows' in own(), false, 'off: no shows, so Story Block keeps its own Chatter tab');
        assert.deepEqual(own().api.manage.tokens(), { input: 0, output: 0, parts: [] }, 'off: Delta adds nothing');
        enable.call({ checked: true });
        assert.deepEqual(own().shows, ['chatter']);
        delete globalThis.StoryBlock;
    });
});
