// Group A restore (NSD side): a chat that is not ready answers in time. The gate's wait ends at once on a permanent block, a send waits once,
// the participant's prepare waits for the load, and a save point answers inside the host's bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig } from './helpers/participant-rig.js';
import { runHostScenario } from './helpers/host-scenario.js';
import { createParticipant, memoryVault } from '../src/storysuite-participant/index.js';

// ---- (8) the gate of the adapter ----

/** The host's head answers RESTORE_PENDING (with `extra`), counting the looks. */
async function pendingHost(t, extra) {
    const looks = { n: 0 };
    const head = async () => { looks.n += 1; return { ok: false, code: 'RESTORE_PENDING', message: 'A restore is in progress.', ...extra }; };
    const r = await adapterRig(t, { settle: { settleMs: 200, settlePollMs: 5 }, wrapSdk: sdk => ({ ...sdk, timeline: { ...sdk.timeline, head } }) });
    return { r, looks };
}

test('a permanent block the host names (CONFLICT, SNAPSHOT_UNAVAILABLE) ends the wait after one look', async t => {
    for (const code of ['CONFLICT', 'SNAPSHOT_UNAVAILABLE']) {
        const { r, looks } = await pendingHost(t, { blockedBy: { module: 'npc-state-delta', code } });
        const started = Date.now();
        assert.equal(await r.api.gate.settled(), false);
        assert.equal(looks.n, 1, `${code}: one look`);
        assert.ok(Date.now() - started < 100, `${code}: no waiting`);
    }
});

test('a transient block (FAILED, STALE) and a host that names no block are waited for in full, then reported not settled', async t => {
    for (const extra of [{ blockedBy: { module: 'npc-state-delta', code: 'FAILED' } }, { blockedBy: { module: 'npc-state-delta', code: 'STALE' } }, {}]) {
        const { r, looks } = await pendingHost(t, extra);
        const started = Date.now();
        assert.equal(await r.api.gate.settled(), false);
        assert.ok(looks.n > 5, `${JSON.stringify(extra)}: looked again and again (${looks.n})`);
        assert.ok(Date.now() - started >= 190, 'the whole bound');
    }
});

test('settled({ wait: false }) is one look, whatever the answer', async t => {
    const { r, looks } = await pendingHost(t, {});
    assert.equal(await r.api.gate.settled({ wait: false }), false);
    assert.equal(looks.n, 1);
});

// ---- (8) a send: AFTER_COMMANDS then MESSAGE_SENT ----

const prelude = async () => {
    const sdk = { registered: [], registerModule(def) { sdk.registered.push(def); } };
    mockState.sdk = sdk;
    mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
};

test('a send waits for the host once: the second handler of the same send only looks', () => {
    runHostScenario('send-waits-once', prelude, async () => {
        const api = globalThis.NPCStateDelta;
        const waitFor = async (check, ms = 3000) => { const until = Date.now() + ms; while (Date.now() < until) { if (check()) return true; await sleep(10); } return check(); };
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        assert.equal(await waitFor(() => api.stateReady()), true);
        let down = false;
        const asked = [];
        // A barrier that is up: a waiting look takes 300 ms (its bound), a single look answers at once.
        api.useMessageGate({ refresh: async () => null, settled: async options => { asked.push(options?.wait === false ? 'look' : 'wait'); if (down) return true; if (options?.wait !== false) await sleep(300); return false; } });
        Object.assign(mockState.extensionSettings.npc_state_delta, { enabled: true });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'I check the board.' });
        // The two handlers of one send run one after the other in the host.
        const timed = async event => {
            const started = Date.now();
            for (const fn of mockState.listeners.get(event) || []) await fn(...(event === 'message_sent' ? [mockState.context.chat.length - 1] : ['normal', {}, false]));
            return Date.now() - started;
        };
        const first = await timed('generation_after_commands');
        const second = await timed('message_sent');
        assert.ok(first >= 280, `the first handler waited its bound (${first} ms)`);
        assert.ok(second < 150, `the second only looked (${second} ms): one wait for the send, not two`);
        assert.ok(asked.includes('look'));
        // When the barrier is down the next send is not held.
        down = true;
        asked.length = 0;
        assert.ok(await timed('generation_after_commands') < 150);
    });
});

// ---- (7) and (9) the participant ----

const port = (extra = {}) => {
    const live = { loaded: false, state: { npcs: [] } };
    return { live, port: { chatKey: () => 'chat:a.png:one', readState: () => structuredClone(live.state), ready: () => live.loaded, load: () => new Promise(() => {}), writeTimeline: async block => { live.state = { ...live.state, timeline: structuredClone(block) }; }, ...extra } };
};
const PREPARE = { return: 'nm_r', checkpoint: 'nk_missing', hash: 'h' };
/** Runs the clock: timers and Date are the test's. */
const clock = t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
    return { advance: async ms => { for (let spent = 0; spent < ms; spent += 50) { t.mock.timers.tick(50); await flush(); } } };
};

test('prepare waits for the load inside its bound instead of failing "has not loaded"', async t => {
    const { live, port: p } = port();
    const time = clock(t);
    const participant = createParticipant({ port: p, vault: memoryVault(), boundMs: 4000 }).participant;
    const answer = participant.prepare(PREPARE);
    await time.advance(1500);
    live.loaded = true;   // Delta's load of the chat finishes meanwhile (another caller's load)
    live.state = { npcs: [{ id: 'npc_a', name: 'Mira' }] };
    await time.advance(200);
    const got = await answer;
    assert.equal(/has not loaded/.test(got.message ?? ''), false, `it got past the load (${got.code}: ${got.message})`);
    assert.equal(got.code, 'SNAPSHOT_UNAVAILABLE', 'and answered about the checkpoint');
});

test('prepare of a chat that does not load answers the retryable failure at the bound, not later', async t => {
    const { port: p } = port();
    const time = clock(t);
    const participant = createParticipant({ port: p, vault: memoryVault(), boundMs: 4000 }).participant;
    let got = null;
    void participant.prepare(PREPARE).then(value => { got = value; }, error => { got = { thrown: error.message }; });
    await time.advance(3900);
    assert.equal(got, null, 'still waiting inside the bound');
    await time.advance(300);
    assert.match(got?.thrown ?? got?.message ?? '', /not loaded this chat's dossiers yet/);
});

test('prepare of a chat whose load failed does not wait: the retryable failure comes at once', async t => {
    const { port: p } = port({ loadFailed: () => true });
    const time = clock(t);
    const participant = createParticipant({ port: p, vault: memoryVault(), boundMs: 4000 }).participant;
    let got = null;
    void participant.prepare(PREPARE).then(value => { got = value; }, error => { got = { thrown: error.message }; });
    await time.advance(100);
    assert.match(got?.thrown ?? got?.message ?? '', /not loaded this chat's dossiers yet/);
});

test('a save point waits for Delta to be idle at most the host\'s bound, then answers the retryable STALE', async t => {
    const seen = [];
    const { live, port: p } = port({ idle: async ms => { seen.push(ms); return false; } });
    live.loaded = true;
    const participant = createParticipant({ port: p, vault: memoryVault() }).participant;
    const out = await participant.checkpoint({});
    assert.equal(out.code, 'STALE');
    assert.deepEqual(seen, [8000], 'the idle wait is 8 s, inside the host\'s 10 s');
    assert.ok(seen[0] < 10000);
});

test('the idle wait gets only what is left of the bound', async t => {
    const seen = [];
    let clockNow = 5000;
    const { live, port: p } = port({ idle: async ms => { seen.push(ms); clockNow += 6000; return false; } });
    live.loaded = true;
    const participant = createParticipant({ port: p, vault: memoryVault(), now: () => clockNow }).participant;
    await participant.checkpoint({});
    assert.deepEqual(seen, [8000]);
    // A call that waited for its turn (the clock moved before it ran) has less: a second one asked while the first is still busy.
    seen.length = 0;
    clockNow = 5000;
    const first = participant.checkpoint({});
    const second = participant.checkpoint({});
    await Promise.all([first, second]);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], 2000, 'the second had 8 s from its own asking, and 6 s were spent before it ran');
});
