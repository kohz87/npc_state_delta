// Shared synthetic host for the relationship pacing tests: the production adapter on Story Block's testkit, two dossiers
// and a stand-in for Story Director's clock (`director.time`). suite() returns say / swipe / setDay and readers.
import assert from 'node:assert/strict';
import { createHost } from '../vendor/story-block/testkit/index.js';
import { MODULE_ID, createStorySuiteV2Adapter } from '../../src/storysuite-v2.js';
import { DEFAULT_RELATIONSHIP_CAPS } from '../../core.js';
import { fromFlatDay, normalizeAllowance } from '../../src/relationship-pacing.js';

export const DAY = 1440;

// A reader for the TESTS only: the newest day a flat impactDay names, as { day, reply, counts } (production never picks a day this
// way: it reads the day in force only, relationship-pacing.js fromFlatDay).
export function newestFlatDay(value) {
    const days = Object.keys(value ?? {}).map(key => /^d(-?\d+):/.exec(key)).filter(Boolean).map(match => Number(match[1]));
    return days.length ? fromFlatDay(value, Math.max(...days)) : null;
}


export function dossiers() {
    const blank = { trust: 0, affection: 0, desire: 0, tension: 0 };
    return {
        npc_temiwa: { id: 'npc_temiwa', name: 'Sister Temiwa', aliases: [], present: true, archived: false, relationship: { ...blank } },
        npc_oren: { id: 'npc_oren', name: 'Oren', aliases: [], present: true, archived: false, relationship: { ...blank } },
    };
}

// A stand-in for Story Director: its domain holds the story minutes, its query answers director.time.
export const clockModule = {
    id: 'zz-clock', name: 'Clock',
    domains: { director: { initial: () => ({ time: { minutes: 0 } }) } },
    commands: { 'zz.clock': (ctx, { minutes }) => { ctx.draft('director').time.minutes = minutes; return { summary: 'time passes' }; } },
    capture: {
        kinds: { date: { grammar: '~ date MINUTES' } },
        apply: (ctx, line) => { ctx.draft('director').time.minutes = Number(line.name); return { summary: 'time passes' }; },
    },
    queries: { 'director.time': state => ({ minutes: state?.domains?.director?.time?.minutes ?? null }) },
};

export async function suite({ records = dossiers(), clock = true, allowance, calendarOwn = false, features = null, settings = {} } = {}) {
    const host = await createHost({ settings: { modules: { [MODULE_ID]: { ...settings } }, ...(features ? { features: { ...features } } : {}) }, modules: clock ? [clockModule] : [] });
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const delta = { records };
    const api = {
        isEnabled: () => true,
        getNpc: id => (delta.records[id] ? structuredClone(delta.records[id]) : null),
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        relationshipCaps: () => ({ ...DEFAULT_RELATIONSHIP_CAPS }),
        ...(allowance === null ? {} : { relationshipAllowance: () => normalizeAllowance(allowance) }),
        presentCastHtml: () => '<section class="cast">cast</section>',
        castEmptyReason: () => ({ text: 'Nobody here.' }),
        fillPresentCast: () => {},
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => Object.values(delta.records).map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        calendarOwn: () => calendarOwn,
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn() {} }, loadEmptyCast: async () => null,
    });
    adapter.start();
    assert.equal(await adapter.settled(), true);
    const block = lines => (lines.length ? `\n\n<Changes>\n${lines.join('\n')}\n</Changes>` : '');
    const say = async (lines = []) => { await host.send('And then?', `The story goes on.${block(lines)}`); await adapter.ticked(); return host.store.headIndex(); };
    const swipe = async (lines = []) => { await host.swipe(`Another way.${block(lines)}`); await adapter.ticked(); };
    const setDay = async day => { if (clock) await host.sdk.command('zz.clock', { minutes: day * DAY + 30 }); };
    const npc = name => host.sdk.query('npc.meters', { name });
    const lastSummary = () => host.store.receipts().map(item => item.receipt).filter(item => item.type === 'npc.line' || /^npc\./.test(item.type ?? '')).at(-1)?.summary
        ?? host.store.receipts().map(item => item.receipt).at(-1)?.summary;
    // The stored record is flat (day in every key); the tests read it as { day, reply, counts }.
    const day = name => newestFlatDay(host.head().domains.npc.npcs[name]?.impactDay) ?? undefined;
    return { host, adapter, delta, say, swipe, setDay, npc, lastSummary, day };
}

export const major = (who = 'Oren') => `~ npc ${who} | trust: +9 | impact: major`;
