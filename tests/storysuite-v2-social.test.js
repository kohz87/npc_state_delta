import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { makeView } from './vendor/story-block/src/v2/sdk.js';
import { MODULE_ID, QUERY_NAMES, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { BUILT_IN_METERS, BUILT_IN_RANGE, FEATURES, SETTINGS_DEFAULTS, SETTINGS_SCHEMA } from '../src/npc-meters.js';
import {
    DEFAULT_SOCIAL_CAP, DEFAULT_SOCIAL_SCALE, FEATURE_SOCIAL, MAX_SOCIAL_CAP, SKILL_WORDS, SOCIAL_QUERY, SOCIAL_SKILLS,
    meterPoints, socialModifier, socialSettings, socialSkill,
} from '../src/social-check.js';

// Social checks against an NPC (feature npc-state-delta.social, src/social-check.js): the read-only
// query npc.socialModifier({ name, skill }) that a dice module (RPG Battle) reads to change a social
// check's difficulty. Against Story Block's whole host from its testkit (tests/vendor/story-block),
// with Story Director and RPG Battle absent; Delta's runtime is a fake with two dossiers.

function dossiers() {
    return {
        npc_mira: { id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], present: true, archived: false, relationship: { trust: 10, affection: 0, desire: 0, tension: 0 } },
        npc_oren: { id: 'npc_oren', name: 'Oren', aliases: ['Brother Oren'], present: false, archived: false, relationship: { trust: 30, affection: 0, desire: 0, tension: 0 } },
    };
}

async function suite({ settings = { changeCap: 200 }, features = null, records = dossiers() } = {}) {
    const calls = [];
    const host = await createHost({
        settings: { modules: { [MODULE_ID]: structuredClone(settings) }, ...(features ? { features: { ...features } } : {}) },
        callModel: async prompt => { calls.push(prompt); return ''; },
    });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const delta = { records, enabled: true };
    const api = {
        isEnabled: () => delta.enabled,
        getNpc: id => (delta.records[id] ? structuredClone(delta.records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        presentCastHtml: () => '', castEmptyReason: () => ({ text: '' }), fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(delta.records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true, 'the adapter registers');
    const say = async (lines = [], text = 'The story goes on.') => {
        await host.send('And then?', `${text}${lines.length ? `\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : ''}`);
        await adapter.ticked();
        return host.store.headIndex();
    };
    const ask = (name, skill) => host.sdk.query(SOCIAL_QUERY, { name, skill });
    // The view RPG Battle is handed for a check (Story Block's makeView), over the state of reply `index`.
    const viewAt = index => makeView({ store: host.store, registry: host.registry, settings: host.settings, state: host.store.at(index) });
    const def = host.registry.module(MODULE_ID);
    return { host, adapter, delta, say, ask, viewAt, def, calls };
}

const sum = reasons => reasons.reduce((total, reason) => total + reason.value, 0);

// ---- the definition ----

test('declares the query, the feature (default on, no prompt) and two tunable settings', () => {
    assert.ok(QUERY_NAMES.includes('npc.socialModifier'));
    assert.equal(SOCIAL_QUERY, 'npc.socialModifier');
    const feature = FEATURES.find(item => item.id === FEATURE_SOCIAL);
    assert.equal(feature.id, 'npc-state-delta.social');
    assert.equal(feature.default, true);
    assert.notEqual(feature.prompt, true, 'the social feature never touches the prompt');
    assert.equal(SETTINGS_DEFAULTS.socialScale, DEFAULT_SOCIAL_SCALE);
    assert.equal(SETTINGS_DEFAULTS.socialCap, DEFAULT_SOCIAL_CAP);
    assert.equal(SETTINGS_SCHEMA.socialScale.feature, FEATURE_SOCIAL);
    assert.equal(SETTINGS_SCHEMA.socialCap.feature, FEATURE_SOCIAL);
    assert.deepEqual(SOCIAL_SKILLS, ['persuade', 'charm', 'intimidate', 'deceive', 'social']);
});

// ---- skills ----

test('skill words: the common words map to the five skills, whole words, any case; anything else is null', () => {
    const cases = {
        persuade: ['Persuade', 'persuasion', 'Persuasion (CHA)', 'convince', 'Diplomacy', 'haggle'],
        charm: ['charm', 'Seduce', 'seduction', 'flirt'],
        intimidate: ['Intimidation', 'threaten', 'coerce'],
        deceive: ['Deception', 'lie', 'Bluff'],
        social: ['social', 'Charisma', 'CHA', 'speechcraft'],
    };
    for (const [skill, list] of Object.entries(cases)) for (const word of list) assert.equal(socialSkill(word), skill, word);
    for (const word of ['Athletics', 'Stealth', 'sleight of hand', 'Constitution', 'con', 'Insight', 'charming-ish', 'persuader', '', null, undefined, 42, {}]) {
        assert.equal(socialSkill(word), null, String(word));
    }
    for (const list of Object.values(SKILL_WORDS)) for (const word of list) assert.match(word, /^[a-z]+$/, 'one lowercase word each');
});

test('each skill reads its own meters: persuade, charm, intimidate, deceive and social on the same NPC', async () => {
    const s = await suite({ settings: { changeCap: 200, stages: [{ meter: 'trust', at: 50, name: 'Close' }] } });
    await s.say(['~ npc Mira | trust: =60 | affection: =30 | desire: =-10 | tension: =-30']);
    assert.deepEqual(s.ask('Mira', 'persuade'), {
        mod: 3, name: 'Mira', skill: 'persuade',
        reasons: [{ text: 'Mira trusts you (Close)', value: 2 }, { text: 'Mira is at ease with you', value: 1 }],
    });
    assert.deepEqual(s.ask('Mira', 'seduce'), {
        mod: 2, name: 'Mira', skill: 'charm',
        reasons: [{ text: 'Mira is fond of you', value: 1 }, { text: 'Mira is at ease with you', value: 1 }],
    }, 'desire −10 is under the first step: no part');
    assert.deepEqual(s.ask('Mira', 'Intimidation'), {
        mod: -3, name: 'Mira', skill: 'intimidate',
        reasons: [{ text: 'Mira trusts you (Close)', value: -2 }, { text: 'Mira is at ease with you', value: -1 }],
    }, 'someone who trusts you and is at ease is hard to frighten');
    assert.deepEqual(s.ask('Mira', 'Deception'), {
        mod: 3, name: 'Mira', skill: 'deceive',
        reasons: [{ text: 'Mira trusts you (Close)', value: 2 }, { text: 'Mira is at ease with you', value: 1 }],
    });
    assert.deepEqual(s.ask('Mira', 'Charisma'), {
        mod: 4, name: 'Mira', skill: 'social',
        reasons: [{ text: 'Mira trusts you (Close)', value: 2 }, { text: 'Mira is fond of you', value: 1 }, { text: 'Mira is at ease with you', value: 1 }],
    });
    for (const skill of ['Athletics', 'Stealth', 'perception']) assert.equal(s.ask('Mira', skill), null, `${skill}: a non-social check is untouched`);
    assert.equal(s.calls.length, 0, 'never calls the model');
});

test('custom meters count when the reader has them: fear for intimidate, loyalty for persuade', async () => {
    const s = await suite({ settings: { changeCap: 200, customMeters: [{ name: 'Fear', min: 0, max: 10, start: 0 }], presets: ['companion'] } });
    await s.say(['~ npc Mira | fear: =8 | loyalty: =60']);
    assert.deepEqual(s.ask('Mira', 'intimidate').reasons, [{ text: 'Mira fears you', value: 3 }], 'fear 8 of 10 is 80% of its reach');
    assert.deepEqual(s.ask('Mira', 'persuade').reasons, [{ text: 'Mira is loyal to you', value: 2 }]);
});

test('the stage ladder and the disposition word add their parts; a story-only NPC is known by its entry', async () => {
    const s = await suite({ settings: { changeCap: 200, ladder: [{ name: 'Friend', needs: 'trust 20' }, { name: 'Ally', needs: 'trust 40' }, { name: 'Sworn', needs: 'trust 45' }] } });
    await s.say(['~ npc Mira | trust: =45 | disposition: friendly']);
    assert.deepEqual(s.ask('Mira', 'persuade').reasons, [
        { text: 'Mira trusts you', value: 1 }, { text: 'Mira: Sworn', value: 2 }, { text: 'Mira is friendly', value: 1 },
    ], 'the third rung gives the most, +2');
    assert.deepEqual(s.ask('Mira', 'intimidate').reasons, [{ text: 'Mira trusts you', value: -1 }], 'no ladder or warm word for intimidate');
    // "Old Hob" has no dossier, only the story's line about him.
    await s.say(['~ npc Old Hob | tension: =30 | disposition: wary']);
    assert.deepEqual(s.ask('old hob', 'persuade'), {
        mod: -2, name: 'Old Hob', skill: 'persuade',
        reasons: [{ text: 'Old Hob is wary of you', value: -1 }, { text: 'Old Hob is wary', value: -1 }],
    });
    await s.say(['~ npc Old Hob | disposition: terrified']);
    assert.deepEqual(s.ask('Old Hob', 'threaten').reasons, [{ text: 'Old Hob is wary of you', value: 1 }, { text: 'Old Hob is terrified', value: 1 }]);
});

// ---- bounds ----

test('bounds: the total is held to ±cap and the reasons still add up to it', async () => {
    const s = await suite({ settings: { changeCap: 200, ladder: [{ name: 'Friend', needs: 'trust 20' }] } });
    await s.say(['~ npc Mira | trust: =100 | affection: =100 | tension: =-100 | disposition: friendly']);
    const high = s.ask('Mira', 'social');
    assert.equal(high.mod, 5);
    assert.equal(sum(high.reasons), 5);
    assert.deepEqual(high.reasons.at(-1), { text: 'Held to the most a check moves (+5)', value: -6 });
    await s.say(['~ npc Mira | trust: =-100 | affection: =-100 | tension: =100 | disposition: hostile']);
    const low = s.ask('Mira', 'social');
    assert.equal(low.mod, -5);
    assert.equal(sum(low.reasons), -5);
    // −3 −3 −3 −1, and +1 from Friend: the ladder keeps a rung for a few low replies (demoteAfter).
    assert.deepEqual(low.reasons.at(-1), { text: 'Held to the most a check moves (−5)', value: 4 });
});

test('bounds: the scale and cap settings tune it, clamped to their ranges; scale 0 is no modifier at all', async () => {
    const s = await suite({ settings: { changeCap: 200, socialScale: 50, socialCap: 3 } });
    await s.say(['~ npc Mira | trust: =100 | tension: =-60']);
    assert.deepEqual(s.ask('Mira', 'persuade'), {
        mod: 3, name: 'Mira', skill: 'persuade',
        reasons: [{ text: 'Mira trusts you', value: 2 }, { text: 'Mira is at ease with you', value: 1 }],
    }, 'half: 3 → 1.5 → 2 and 2 → 1');
    s.host.ctx.extensionSettings.storySuite.modules[MODULE_ID] = { changeCap: 200, socialScale: 0 };
    assert.deepEqual(s.ask('Mira', 'persuade'), { mod: 0, name: 'Mira', skill: 'persuade', reasons: [] });
    assert.deepEqual(socialSettings({ socialScale: 999, socialCap: 99 }), { scale: 200, cap: MAX_SOCIAL_CAP });
    assert.deepEqual(socialSettings({ socialScale: -5, socialCap: 0 }), { scale: 0, cap: 1 });
    assert.deepEqual(socialSettings({ socialScale: '80', socialCap: 2.5 }), { scale: DEFAULT_SOCIAL_SCALE, cap: DEFAULT_SOCIAL_CAP });
});

test('bounds: over every meter value, scale and cap, |mod| ≤ cap, a whole number, and the reasons add up to it', () => {
    const defs = BUILT_IN_METERS.map(meter => ({ ...meter, ...BUILT_IN_RANGE }));
    const values = [-100, -80, -50, -26, -1, 0, 24, 25, 49, 75, 100];
    for (const skill of SOCIAL_SKILLS) {
        for (const scale of [0, 50, 100, 200]) {
            for (const cap of [1, 5, 10]) {
                for (const a of values) for (const b of values) {
                    const meters = defs.map((def, i) => ({ def, value: i % 2 ? b : a, stage: '' }));
                    const out = socialModifier({ name: 'Mira', skill, meters, rank: { name: 'Friend', index: 4 }, disposition: 'wary', settings: { scale, cap } });
                    assert.ok(Number.isInteger(out.mod) && Math.abs(out.mod) <= cap, `${skill} ${scale}% cap ${cap}: ${out.mod}`);
                    assert.equal(sum(out.reasons), out.mod);
                    assert.ok(out.reasons.every(reason => reason.value !== 0 && Number.isInteger(reason.value)));
                }
            }
        }
    }
    assert.equal(meterPoints(10, { min: 0, max: 10 }), 3, 'a 0..10 meter at 10 is at its far end');
    assert.equal(meterPoints(-25, { min: -100, max: 100 }), -1);
});

// ---- lookup ----

test('lookup: name or alias in any case finds the dossier; an unknown name, an archived one or no name is null', async () => {
    const s = await suite();
    await s.say(['~ npc Mira | trust: =60']);
    const expected = s.ask('Mira', 'persuade');
    assert.equal(expected.mod, 2);
    for (const name of ['mira', 'MIRA', ' Mira ', 'The Smith', 'the smith', 'npc_mira']) assert.deepEqual(s.ask(name, 'persuade'), expected, name);
    // Oren has a dossier (trust 30) but no meters yet: he stands where his entry would start.
    assert.deepEqual(s.ask('brother oren', 'persuade'), { mod: 1, name: 'Oren', skill: 'persuade', reasons: [{ text: 'Oren trusts you', value: 1 }] });
    for (const name of ['Nobody', 'Smith', '', undefined, 7]) assert.equal(s.ask(name, 'persuade'), null, String(name));
    s.delta.records.npc_oren.archived = true;
    assert.equal(s.ask('Oren', 'persuade'), null, 'an archived dossier with no entry is unknown');
});

// ---- the state at the check's reply ----

test('reads the state it is given: the check\'s reply, a swipe, a deleted reply; never writes or calls the model', async () => {
    const s = await suite();
    const first = await s.say(['~ npc Mira | trust: =60']);
    const second = await s.say(['~ npc Mira | trust: =-60']);
    const rev = s.host.store.receipts().length;
    assert.equal(s.viewAt(first).query(SOCIAL_QUERY, { name: 'Mira', skill: 'persuade' }).mod, 2, 'the earlier reply\'s state');
    assert.equal(s.viewAt(second).query(SOCIAL_QUERY, { name: 'Mira', skill: 'persuade' }).mod, -2);
    assert.equal(s.ask('Mira', 'persuade').mod, -2, 'the head');
    await s.host.swipe('Another way.\n\n<Changes>\n~ npc Mira | trust: =80\n</Changes>');
    await s.adapter.ticked();
    assert.equal(s.ask('Mira', 'persuade').mod, 3, 'the swipe\'s state');
    s.host.ctx.chat.splice(s.host.ctx.chat.length - 2, 2);
    s.host.store.rebuild();
    assert.equal(s.ask('Mira', 'persuade').mod, 2, 'after the delete, the reply before');
    const before = JSON.stringify(s.host.head());
    for (let i = 0; i < 3; i += 1) s.ask('Mira', 'persuade');
    assert.equal(JSON.stringify(s.host.head()), before, 'asking writes nothing');
    assert.ok(s.host.store.receipts().length <= rev, 'no receipts from asking');
    assert.equal(s.calls.length, 0, 'never calls the model');
});

// ---- the switches ----

test('the feature switched off: the host and the definition both answer null; Delta off too', async () => {
    const off = await suite({ features: { [FEATURE_SOCIAL]: false } });
    await off.say(['~ npc Mira | trust: =60']);
    assert.equal(off.ask('Mira', 'persuade'), null, 'the host answers null for a query of a feature that is off');
    assert.equal(off.def.queries[SOCIAL_QUERY](off.host.head(), { name: 'Mira', skill: 'persuade' }), null, 'and Delta checks too (an older host)');
    assert.equal(off.host.registry.featureOn(FEATURE_SOCIAL), false);
    assert.equal(off.ask('Mira', 'Athletics'), null);
    off.host.features.set(FEATURE_SOCIAL, true);
    assert.equal(off.ask('Mira', 'persuade').mod, 2, 'on again, the same answer');

    const on = await suite();
    await on.say(['~ npc Mira | trust: =60']);
    on.delta.enabled = false;
    assert.equal(on.ask('Mira', 'persuade'), null, 'nothing while Delta is off');
});

test('prompts stay byte-identical: the same story with the feature off and on (asked every reply) sends the same prompt text', async () => {
    const story = [['~ npc Mira | trust: =60 | disposition: friendly'], ['~ npc Old Hob | tension: =40'], [], ['~ npc Mira | affection: +10']];
    const run = async (features, asking) => {
        const s = await suite({ features });
        const statics = [];
        for (const lines of story) {
            await s.say(lines);
            if (asking) for (const skill of SOCIAL_SKILLS) { s.ask('Mira', skill); s.ask('Old Hob', skill); }
            statics.push(s.def.context.static());
        }
        return { log: s.host.st.promptLog.map(({ key, value, position, depth, role }) => ({ key, value, position, depth, role })), statics };
    };
    const off = await run({ [FEATURE_SOCIAL]: false }, false);
    const on = await run(null, true);
    assert.ok(off.log.length > 0, 'the host sent prompts');
    assert.deepEqual(on.log, off.log);
    assert.deepEqual(on.statics, off.statics);
    assert.ok(on.log.every(entry => !/social|persuade|intimidate/i.test(entry.value)), 'no social text reaches the prompt');
});
