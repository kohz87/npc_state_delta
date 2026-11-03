import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjection, createNpcRecord } from '../core.js';
import { createHost } from './vendor/story-block/testkit/index.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { runHostScenario } from './helpers/host-scenario.js';

// Story Block 2.18.0's `packs.castGear { name }` → { name, line: "Gear: A, B", items } or null. The narrator's entry for a pack cast member
// (the dossier injection) carries that one line when the host answers it, and is byte-identical to before when the query is missing or null.
// The testkit host does not answer the query yet: it is stubbed here, as other host queries are.

const GEAR = 'Gear: Cane Sword, Oak Buckler';
const fenna = () => ({ ...createNpcRecord({ name: 'Fenna', personality: 'Stubborn and watchful.', speech: 'Dry; says "aye".' }), id: 'npc_fenna', present: true });

test('buildInjection: the gear line ends the cast member\'s entry as given; none, or an empty one, leaves the text byte-identical', () => {
    const npc = fenna();
    const plain = buildInjection([npc], 'Fenna is here.', 1);
    const withGear = buildInjection([npc], 'Fenna is here.', 1, undefined, undefined, undefined, null, { gearLines: { [npc.id]: GEAR } });
    assert.ok(withGear.includes(`; ${GEAR}`), 'the line is in the entry');
    assert.equal(withGear.split('\n').filter(line => line.includes(GEAR)).length, 1, 'once, on the entry\'s own line');
    assert.equal(withGear.replace(`; ${GEAR}`, ''), plain, 'nothing else changes');
    for (const none of [undefined, null, {}, { [npc.id]: '' }, { other: GEAR }]) {
        assert.equal(buildInjection([npc], 'Fenna is here.', 1, undefined, undefined, undefined, null, none === undefined ? {} : { gearLines: none }), plain);
    }
    assert.equal(buildInjection([npc], 'Fenna is here.', 1, undefined, undefined, undefined, null, { gearLines: { [npc.id]: GEAR } }), withGear, 'stable from call to call');
});

test('adapter: castGearLine asks packs.castGear by name; a missing query, a null answer, a throw and no host are all ""', async () => {
    const host = await createHost({ settings: { modules: { [MODULE_ID]: {} } } });
    const asked = [];
    let mode = 'line';
    const query = (name, args) => {
        if (name !== 'packs.castGear') return host.sdk.query(name, args);
        asked.push([name, args]);
        if (mode === 'throw') throw new Error('unknown query');
        if (mode === 'null') return null;
        if (mode === 'odd') return { name: 'Fenna', line: 7 };
        return { name: 'Fenna', line: 'Gear:  Cane Sword,\nOak Buckler ', items: [] };
    };
    const sdk = { ...host.sdk, query };
    const box = { ready: Promise.resolve(sdk), sdk };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => [] }, delta: () => ({ isEnabled: () => true }), version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    assert.equal(adapter.castGearLine('Fenna'), '', 'not hosted yet: nothing asked');
    assert.deepEqual(asked, []);
    adapter.start();
    await adapter.settled();
    assert.equal(adapter.castGearLine('Fenna'), GEAR, 'the line, on one line');
    assert.deepEqual(asked, [['packs.castGear', { name: 'Fenna' }]]);
    assert.equal(adapter.castGearLine(''), '');
    for (mode of ['null', 'throw', 'odd']) assert.equal(adapter.castGearLine('Fenna'), '', mode);
});

test('runtime: the line joins the entry of a pack cast dossier, stays the same across replies, and is gone (byte-identical) when the query is missing or null', () => {
    const scenario = async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const sdk = mockState.sdk;
        const say = async text => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
            const userId = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
            await sleep(150);
            return id;
        };
        const turn = async () => { await sdk.turn({ type: 'normal' }); await sleep(300); };
        mockState.quietResponder = async () => JSON.stringify({ npcs: [] });
        const out = {};
        sdk.people = [{ key: 'ersveil:fenna', pack: 'ersveil', id: 'fenna', name: 'Fenna', aliases: [], met: { on: 0, where: 'the docks' }, alive: true, entry: { id: 'fenna', name: 'Fenna', about: 'Runs the ferry.', look: 'Tall, in a grey oilskin coat.', personality: 'Stubborn.', start: { place: 'docks', goal: 'find the weir-opener' } } }];
        sdk.present = ['Fenna'];
        await say('Fenna looks up from her rope.');
        await turn();
        await say('Fenna hands you a rope.');
        await turn();
        // The gear is answered (by name).
        sdk.mode = 'line';
        await say('Fenna checks the knot.');
        await turn();
        out.first = api.injectionPreview().text;
        await say('Fenna ties off the boat.');
        await turn();
        out.second = api.injectionPreview().text;
        // The host answers null (gear off, no gear, or she is in the party).
        sdk.mode = 'null';
        await say('Fenna coils the line.');
        await turn();
        out.nulled = api.injectionPreview().text;
        // An older Story Block: the query is unknown (the host throws).
        sdk.mode = 'missing';
        await say('Fenna looks at the sky.');
        await turn();
        out.missing = api.injectionPreview().text;
        out.asked = sdk.asked;
        console.log('RESULT ' + JSON.stringify(out));
    };
    const prelude = async () => {
        const sdk = {
            registered: [], people: [], made: {}, handlers: {}, present: [], mode: 'missing', asked: [],
            registerModule(def) { sdk.registered.push(def); },
            on(name, fn) { sdk.handlers[name] = fn; return () => {}; },
            turn: async turn => { await sdk.handlers.turn?.(turn); },
            command: async type => {
                if (type === 'npc.tick') for (const person of sdk.people) if (person.met && person.entry) sdk.made[person.key] = { name: person.name };
                return { ok: true, receipt: { summary: '' } };
            },
            query: (name, args) => {
                if (name === 'packs.castGear') {
                    sdk.asked.push(args);
                    if (sdk.mode === 'missing') throw new Error('unknown query');
                    return sdk.mode === 'line' ? { name: args.name, line: 'Gear: Cane Sword, Oak Buckler', items: [] } : null;
                }
                return name === 'director.cast' ? structuredClone(sdk.people)
                    : name === 'npc.castMade' ? structuredClone(sdk.made)
                    : name === 'packs.list' ? [{ id: 'ersveil', name: 'Ersveil' }]
                    : name === 'director.calendar' ? { era: 'CY', months: [{ name: 'Goldwane', days: 30 }], leapYears: false }
                    : name === 'scene.present' ? structuredClone(sdk.present) : null;
            },
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    };
    const output = runHostScenario('cast-gear-line', prelude, scenario);
    const result = JSON.parse(String(output).split('\n').find(line => line.startsWith('RESULT ')).slice(7));
    const gear = '; Gear: Cane Sword, Oak Buckler';
    assert.ok(result.first.includes(gear), 'the line is in her entry when the host answers');
    assert.equal(result.first.split(gear).length, 2, 'once');
    assert.equal(result.second, result.first, 'stable across replies');
    assert.ok(!result.nulled.includes('Gear:'), 'null: no line');
    assert.equal(result.nulled, result.first.replace(gear, ''), 'null: otherwise the same text');
    assert.equal(result.missing, result.nulled, 'a missing query reads the same as null: byte-identical');
    assert.ok(result.asked.every(args => args.name === 'Fenna'), 'asked by her name');
});
