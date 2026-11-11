import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './vendor/story-block/testkit/index.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';
import { validateNpcSlice } from '../src/npc-meters.js';
import { applyRelationshipDelta } from '../core-mechanics.js';

// RT2: the narrator's `~ npc` line goes through Delta's impact tiers (ordinary 1 / meaningful 2 / major 5 /
// extreme 10, the reader's relationshipCaps), against Story Block's whole host from its testkit.


function dossiers() {
    return {
        npc_mira: {
            id: 'npc_mira', name: 'Mira', aliases: ['The Smith'], present: true, archived: false,
            relationship: { trust: 10, affection: 0, desire: 0, tension: 0 },
        },
        npc_oren: { id: 'npc_oren', name: 'Oren', aliases: [], present: true, archived: false, relationship: { trust: 0, affection: 0, desire: 0, tension: 0 } },
    };
}

/**
 * A whole Story Block host with Delta's adapter registered on it. `features`: { id: bool }, the
 * reader's choices in Story Block's Features; `modules`: more module definitions.
 */
async function suite({ settings = {}, records = dossiers(), features = null, modules = [], doc = null, wrap = false, packs = [], allowance = null, caps = { ordinary: 1, meaningful: 2, major: 5, extreme: 10 } } = {}) {
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
        ...(caps ? { relationshipCaps: () => ({ ...caps }) } : {}),
        ...(allowance ? { relationshipAllowance: () => ({ ...allowance }) } : {}),
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


const trust = (s, name = 'Oren') => s.npc(name).meters;

test('tiers: no impact is ordinary, so +5 on two meters moves each by 1', async () => {
    const s = await suite({ settings: { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 50 }] } });
    await s.say(['~ npc Oren | trust: +5 | tension: +5']);
    assert.deepEqual([trust(s).trust, trust(s).tension], [1, 1]);
    await s.say(['~ npc Oren | trust: +5 | impact: nonsense']);
    assert.equal(trust(s).trust, 2, 'an unknown tier is ordinary');
});

test('tiers: major moves up to 5, extreme up to 10, a negative move the same; the built-ins move as the scanner moves them', async () => {
    const s = await suite();
    await s.say(['~ npc Oren | trust: +9 | impact: major']);
    assert.equal(trust(s).trust, 5);
    await s.say(['~ npc Oren | affection: -30 | impact: EXTREME']);
    assert.equal(trust(s).affection, -10);
    const scanner = applyRelationshipDelta({ trust: 0, affection: 0, desire: 0, tension: 0 }, { trust: 9 }, 'major', { ordinary: 1, meaningful: 2, major: 5, extreme: 10 }).relationship.trust;
    assert.equal(scanner, 5, 'the same function gives the same number');
});

test('tiers: a deep value resists and keeps its part-points; =N is a move toward N held to the tier', async () => {
    const s = await suite();
    s.delta.records.npc_oren.relationship = { trust: 40, affection: 0, desire: 0, tension: 0 };
    await s.say(['~ npc Oren | trust: =60 | impact: major']);
    const first = trust(s).trust;
    assert.ok(first > 40 && first <= 45, `toward 60, held to 5: ${first}`);
    assert.deepEqual(validateNpcSlice(s.host.head().domains.npc), []);
    assert.ok(s.host.head().domains.npc.npcs.oren.progress === undefined || typeof s.host.head().domains.npc.npcs.oren.progress.trust === 'number');
    await s.say(['~ npc Oren | trust: +1']);
    await s.say(['~ npc Oren | trust: +1']);
    assert.ok(trust(s).trust >= first, 'ordinary moves at a deep value still add up through the stored part-points');
});

test('tiers: a custom meter step is held to the tier, and to its own range', async () => {
    const s = await suite({ settings: { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 98 }] } });
    await s.say(['~ npc Oren | loyalty: +20']);
    assert.equal(trust(s).loyalty, 99);
    await s.say(['~ npc Oren | loyalty: -30 | impact: major']);
    assert.equal(trust(s).loyalty, 94);
});

test('a downgraded custom meter uses the new tier without relationship milestone gates', async () => {
    const clock = { id: 'clock', name: 'Clock', domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
        queries: { 'director.time': state => state?.domains?.director?.time } };
    const s = await suite({ settings: { customMeters: [{ name: 'Loyalty', min: 0, max: 100, start: 49 }] },
        modules: [clock], allowance: { ordinary: 3, meaningful: 1, major: 0, extreme: 1 },
        caps: { ordinary: 1, meaningful: 2, major: 3, extreme: 6 } });
    const reply = await s.say(['~ npc Oren | loyalty: +9 | impact: major']);
    assert.equal(trust(s).loyalty, 51, 'a story line counts as meaningful');
    await s.adapter.adjust({ name: 'Mira', meters: { loyalty: 9 }, reply, impact: 'major' });
    assert.equal(trust(s, 'Mira').loyalty, 51, 'a tiered adjust gets the same custom-meter rule');
});

test('tiers: the per-reply cap still applies on top', async () => {
    const s = await suite({ settings: { changeCap: 3 }, caps: { ordinary: 1, meaningful: 2, major: 5, extreme: 10 } });
    await s.say(['~ npc Oren | trust: +9 | impact: extreme']);
    assert.equal(trust(s).trust, 3);
});

test('tiers: swipe, regenerate and a rebuild give identical numbers', async () => {
    const s = await suite();
    const numbers = () => JSON.stringify(Object.values(s.host.head().domains.npc.npcs).map(item => [item.meters, item.progress ?? null]));
    await s.say(['~ npc Oren | trust: +5 | impact: major']);
    const live = numbers();
    await s.swipe(['~ npc Oren | trust: +5 | impact: major']);
    assert.equal(numbers(), live, 'a swipe with the same line lands on the same numbers (not on top of the first)');
    await s.regenerate(['~ npc Oren | trust: +5 | impact: major']);
    assert.equal(numbers(), live);
    const stored = JSON.stringify(s.host.head());
    s.host.store.rebuild();
    assert.equal(JSON.stringify(s.host.head()), stored, 'a rebuild is the live state');
    assert.equal(trust(s).trust, 5);
});

test('tiers: the prompt line names the tiers and their caps; without caps from the host it is as before', async () => {
    const s = await suite({ caps: { ordinary: 1, meaningful: 3, major: 6, extreme: 12 }, features: { 'npc-state-delta.anti-lever': false } });
    assert.match(s.def.context.static(), /Add \| impact: ordinary \(a kind word, most moments\) \| meaningful \(a real favour, a shared secret\) \| major \(saved from danger, a betrayal\) \| extreme \(a life-changing turning point, very rare\)\. Most moments are ordinary\. The most a move can be: 1\/3\/6\/12; =N moves toward N; none given: ordinary\.$/);
    const plain = await suite({ caps: null, features: { 'npc-state-delta.anti-lever': false } });
    assert.doesNotMatch(plain.def.context.static(), /impact/);
    await plain.say(['~ npc Oren | trust: +9']);
    assert.equal(trust(plain).trust, 9, 'no caps from the host: held by the per-reply cap alone');
});

test('double count: while hosted, Delta\'s scan of a reply leaves a meter the story line already moved; other meters it still moves', async () => {
    const s = await suite();
    const index = await s.say(['~ npc Oren | trust: +5 | impact: major']);
    const out = await s.adapter.adjust({ name: 'Oren', meters: { trust: 2, affection: 2 }, reply: index });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual([trust(s).trust, trust(s).affection], [5, 2], 'trust counted once (the story\'s 5); affection is the scan\'s');
    await s.swipe([]);
    const again = await s.adapter.adjust({ name: 'Oren', meters: { trust: 2 }, reply: s.host.store.headIndex() });
    assert.equal(again.ok, true);
    assert.equal(trust(s).trust, 2, 'a new swipe with no story line: the scan moves trust');
});
