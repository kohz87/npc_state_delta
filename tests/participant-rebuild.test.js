// The rebuild callback in src/storysuite-participant/participant/rebuild.js: it clears this branch's native state, mints a fresh
// lineage, scans the chosen part of the chat through the normal scanner, and publishes that result through the participant's existing
// native-mutation path. The tests also hold the owner's rule that a rebuild deletes no vault file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckpoint, memoryVault, storedTimeline, timelineOf } from '../src/storysuite-participant/index.js';
import { createRebuild, REBUILD_REPLY_LIMIT } from '../src/storysuite-participant/participant/rebuild.js';
import { hashJson } from '../src/storysuite-participant/hash.js';

const OLD_LINEAGE = 'lg_oldold01';
const clone = value => JSON.parse(JSON.stringify(value));
const npc = (id, name) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive' });

const oldState = () => ({
    npcs: [npc('npc_mira', 'Mira'), npc('npc_tom', 'Old Tom')],
    candidates: [{ id: 'candidate_old' }],
    pendingBackfills: [{ id: 'backfill_old' }],
    socialGraph: { edges: [{ a: 'npc_mira', b: 'npc_tom', kind: 'friends' }] },
    turn: 7,
    assistantSinceScan: 2,
    lastScanAt: 10,
    lastScannedMessageId: 12,
    readAhead: [12],
    scanCount: 4,
    dismissed: ['old-note'],
    inlineCards: [{ messageId: 3, cards: [] }],
    portraitAssets: { npc_mira: { dataUrl: 'data:image/png;base64,AA' } },
    checkpoints: [{ messageId: 3, snapshot: { npcs: [] } }],
    lineage: [{ id: 'old-lineage-entry' }],
    branchLineageVersion: 3,
    branchParent: 'parent-chat',
    branchForkMessageId: 3,
    branchRootSnapshot: { npcs: [] },
    userDismissedGroups: [{ primary: 'mira', labels: ['mira'], ids: ['npc_mira'], createdAt: 1 }],
    branchFamilyId: 'family-old',
    timeline: {
        v: 1, lineage: OLD_LINEAGE,
        identity: { map: { np_old0001: { nativeKey: 'npc_mira', archived: false, since: 1 } } },
        reserved: ['np_old0001'], applied: { ev_old: { nativeKey: 'npc_tom', at: 2 } },
    },
});

function emptyState(raw = {}) {
    return {
        npcs: [], candidates: [], pendingBackfills: [], socialGraph: { edges: [] }, turn: 0,
        assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, readAhead: [], scanCount: 0,
        dismissed: [], inlineCards: [], portraitAssets: {}, checkpoints: [], lineage: [],
        branchLineageVersion: 3, branchParent: null, branchForkMessageId: null, branchRootSnapshot: null,
        userDismissedGroups: [],
        ...clone(raw),
    };
}

function seededRandom(seed = 7) {
    let value = seed;
    return () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
}

function setup({
    state = oldState(), scan = null, head = null, headSource = null, publish = null,
    normalize = emptyState, busy = false, extraPort = {},
} = {}) {
    const live = { state: clone(state), installs: 0 };
    const index = { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null };
    let session = { key: 'chat:one', lineage: OLD_LINEAGE, index };
    const calls = [];
    const port = {
        normalize: raw => normalize(raw),
        readState: () => clone(live.state),
        installState: async next => { live.installs += 1; calls.push(['install']); live.state = clone(next); },
        rebuildScan: scan ?? (async input => {
            calls.push(['scan', clone(input), clone(live.state)]);
            live.state.npcs = [npc('npc_ash', 'Ash'), npc('npc_briar', 'Briar')];
            live.state.socialGraph = { edges: [{ a: 'npc_ash', b: 'npc_briar', kind: 'friends' }] };
            live.state.turn = 2;
            live.state.scanCount = 1;
            return true;
        }),
        busy: () => busy,
        ...extraPort,
    };
    if (headSource !== null) port.headSource = () => headSource;
    const deps = {
        port,
        random: seededRandom(11),
        keyNow: () => 'chat:one',
        usable: key => key === 'chat:one',
        hydrate: async () => {
            calls.push(['hydrate']);
            session = { key: 'chat:one', lineage: timelineOf(live.state).lineage, index };
            return session;
        },
        setSession: value => { session = value; calls.push(['session', value === null ? null : value.lineage]); },
        getHandle: () => ({ head: async () => {
            calls.push(['head']);
            return head ?? { ok: true, headHash: 'a'.repeat(64), cursor: { sid: 'reply-2' }, source: { sid: 'reply-2', swipeKey: 'swipe-0' } };
        } }),
        publish: publish ?? (async input => {
            calls.push(['publish', clone(input), clone(live.state)]);
            return { ok: true, checkpoint: 'nk_newbase1', hash: hashJson({ rebuilt: true }) };
        }),
        exclusive: fn => Promise.resolve().then(fn),
        warn: () => {},
    };
    const { rebuild } = createRebuild(deps);
    return { live, calls, rebuild, session: () => session, port };
}

test('a rebuild clears the native state on a fresh lineage before one normal scan, then publishes its baseline', async () => {
    const r = setup();
    const out = await r.rebuild({ return: 'rt_rebuild001' });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(
        { rebuilt: out.rebuilt, replies: out.replies, checkpoint: out.checkpoint },
        { rebuilt: true, replies: REBUILD_REPLY_LIMIT, checkpoint: 'nk_newbase1' },
    );
    assert.notEqual(out.lineage, OLD_LINEAGE);
    assert.match(out.lineage, /^lg_[0-9a-z]{8}$/);

    const scan = r.calls.find(call => call[0] === 'scan');
    const atScan = scan[2];
    assert.deepEqual(scan[1], { replies: REBUILD_REPLY_LIMIT });
    assert.deepEqual(atScan.npcs, [], 'the old dossiers are gone before the scanner reads');
    assert.deepEqual(atScan.socialGraph, { edges: [] });
    assert.deepEqual(atScan.checkpoints, []);
    assert.deepEqual(atScan.lineage, []);
    assert.equal(atScan.branchFamilyId, undefined, 'the branch\'s old fallback family is not carried into the new line');
    assert.equal(timelineOf(atScan).lineage, out.lineage);
    assert.deepEqual(timelineOf(atScan).identity.map, {});
    assert.deepEqual(timelineOf(atScan).applied, {});
    assert.deepEqual(timelineOf(atScan).former, []);

    const publish = r.calls.find(call => call[0] === 'publish');
    assert.deepEqual(publish[1], { source: { sid: 'reply-2', swipeKey: 'swipe-0' } });
    assert.deepEqual(publish[2].npcs.map(person => person.name), ['Ash', 'Briar'], 'the publication carries the scan, not the empty state');
    assert.equal(timelineOf(publish[2]).lineage, out.lineage);
    assert.equal(r.calls.filter(call => call[0] === 'scan').length, 1);
    assert.equal(r.calls.filter(call => call[0] === 'publish').length, 1);
    assert.deepEqual(r.calls.filter(call => ['install', 'hydrate', 'scan', 'head', 'publish'].includes(call[0])).map(call => call[0]),
        ['hydrate', 'install', 'hydrate', 'scan', 'head', 'publish']);
});

test('the last 40 replies are the default; a positive reply count is used, and all means the whole chat', async () => {
    const limited = setup();
    assert.equal((await limited.rebuild({ return: 'rt_limited', replies: 12 })).ok, true);
    assert.deepEqual(limited.calls.find(call => call[0] === 'scan')[1], { replies: 12 });

    for (const choice of [{ all: true }, { replies: null }]) {
        const every = setup();
        const out = await every.rebuild({ return: 'rt_every', ...choice });
        assert.equal(out.ok, true, out.message);
        assert.equal(out.replies, null);
        assert.deepEqual(every.calls.find(call => call[0] === 'scan')[1], { replies: null });
    }
});

test('an invalid choice, a busy scanner or a missing scanner does not clear, scan or publish anything', async () => {
    for (const input of [{}, { return: '' }, { return: 'rt_bad', replies: 0 }, { return: 'rt_bad', replies: 1.5 }, { return: 'rt_bad', all: 'yes' }]) {
        const r = setup();
        const out = await r.rebuild(input);
        assert.deepEqual([out.ok, out.code], [false, 'INVALID']);
        assert.deepEqual(r.calls, []);
    }

    const busy = setup({ busy: true });
    assert.equal((await busy.rebuild({ return: 'rt_busy' })).code, 'STALE');
    assert.deepEqual(busy.calls.map(call => call[0]), ['hydrate']);

    const none = setup();
    delete none.port.rebuildScan;
    assert.equal((await none.rebuild({ return: 'rt_none' })).code, 'UNSUPPORTED');
    assert.deepEqual(none.calls, []);
});

test('a scanner failure before publication puts the previous native state and session back', async () => {
    const original = oldState();
    const scan = async () => { throw new Error('The scanner stopped.'); };
    const r = setup({ state: original, scan });
    const out = await r.rebuild({ return: 'rt_scan_failed' });
    assert.deepEqual([out.ok, out.code], [false, 'FAILED']);
    assert.match(out.message, /scanner stopped/);
    assert.deepEqual(r.live.state, original, 'the branch keeps the state it had');
    assert.equal(r.live.installs, 2, 'the fresh state, then the old one');
    assert.equal(r.session().lineage, OLD_LINEAGE);
    assert.deepEqual(r.calls.filter(call => call[0] === 'publish'), []);
});

test('a publication failure is returned as the host\'s failure and does not falsely report a rebuilt baseline', async () => {
    const publish = async () => ({ ok: false, code: 'REFUSED', message: 'The host refused the new baseline.' });
    const r = setup({ publish });
    const out = await r.rebuild({ return: 'rt_publish_failed' });
    assert.deepEqual([out.ok, out.code, out.message], [false, 'REFUSED', 'The host refused the new baseline.']);
    assert.deepEqual(r.live.state.npcs.map(person => person.name), ['Ash', 'Briar'], 'the completed scan is left in place for the host');
});

test('the head source is used for publication, with the port fallback when the host head has none', async () => {
    const source = { sid: 'reply-9', swipeKey: 'swipe-2' };
    const r = setup({ head: { ok: true, headHash: 'b'.repeat(64), cursor: { sid: 'reply-9' } }, headSource: source });
    assert.equal((await r.rebuild({ return: 'rt_source' })).ok, true);
    assert.deepEqual(r.calls.find(call => call[0] === 'publish')[1], { source });
});

test('a rebuild deletes no checkpoint or lineage-index file', async () => {
    const vault = memoryVault();
    const original = oldState();
    const old = buildCheckpoint({ lineage: OLD_LINEAGE, state: original });
    await vault.put(old.id, old.doc);
    const index = { v: 2, acks: {}, prepared: {}, returns: {}, selected: old.id, base: { checkpoint: old.id, hash: old.hash, stateHash: hashJson(original) } };
    await vault.putIndex(OLD_LINEAGE, index);
    const r = setup({ state: original });
    assert.equal((await r.rebuild({ return: 'rt_keep_files' })).ok, true);
    assert.equal(vault.docs.has(old.id), true);
    assert.equal(vault.indexes.has(OLD_LINEAGE), true);
    assert.deepEqual(JSON.parse(vault.indexes.get(OLD_LINEAGE)), index);
});
