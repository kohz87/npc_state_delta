// Focused tests for the history-replay coordinator. The fakes exercise every injected boundary; no live state,
// Story Block operation, publication or model route exists here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryReplay, HISTORY_REPLAY_CAP, HISTORY_REPLAY_MAX_ATTEMPTS } from '../src/storysuite-participant/history-replay.js';

const repliesOf = count => Array.from({ length: count }, (_unused, index) => ({ index, text: `Reply ${index}` }));

function rig(options = {}) {
    const calls = {
        copy: [], views: [], replies: [], valid: [], installs: [], publications: [], persisted: [], progress: [], sinkWrites: [],
    };
    let persisted = options.persisted ?? null;
    let valid = options.valid ?? true;
    const base = options.base ?? { turn: 0, catchUp: persisted };

    const deps = {
        copyState(state) { calls.copy.push(state); return structuredClone(state); },
        viewFor(replyIndex) { calls.views.push(replyIndex); return { replyIndex, latest: true }; },
        async runReply(state, view, sink) {
            calls.replies.push(view.replyIndex);
            sink.adjust({ kind: 'relationship', index: view.replyIndex });
            sink.open({ kind: 'secret', index: view.replyIndex });
            sink.toast('hidden');
            sink.checkpoint('hidden');
            sink.inject('hidden');
            calls.sinkWrites.push(sink.calls.length);
            if (options.switchAt === view.replyIndex) valid = false;
            if (options.failAt === view.replyIndex) throw new Error(`reply ${view.replyIndex} failed`);
            state.turn += 1;
            if (options.onReply) await options.onReply({ state, view, sink, replay: options.replay?.() });
            if (options.skipAt === view.replyIndex) options.replay().skip();
            return { ok: true };
        },
        stillValid(start) { calls.valid.push(start); valid = options.validAfter?.(start) ?? valid; return valid; },
        install(state) { calls.installs.push(structuredClone(state)); },
        publishOnce() { calls.publications.push(true); },
        persistCatchUp(field) {
            persisted = field ? structuredClone(field) : null;
            calls.persisted.push(persisted);
        },
        progress(value) { calls.progress.push({ ...value }); },
        cap: options.cap,
    };
    return { deps, base, calls, current: () => persisted, setValid: value => { valid = value; } };
}

test('replays the supplied replies oldest first and installs/publishes once', async () => {
    const r = rig();
    const replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(7), reason: 'fallback' });

    assert.deepEqual(result.ok, true);
    assert.deepEqual(r.calls.views, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(r.calls.replies, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(r.calls.copy.length, 1);
    assert.equal(r.calls.installs.length, 1);
    assert.equal(r.calls.installs[0].turn, 7, 'turn advanced once per reply on the private copy');
    assert.equal(r.calls.publications.length, 1);
    assert.deepEqual(r.calls.persisted[0], { from: 0, to: 6, reason: 'fallback', attempt: 1 });
    assert.deepEqual(r.calls.persisted.at(-1), null, 'the catch-up field clears on success');
    assert.deepEqual(r.calls.progress[0], { done: 0, total: 7 });
    assert.deepEqual(r.calls.progress.at(-1), { done: 7, total: 7 });
    assert.equal(r.base.turn, 0, 'the live base was never mutated');
    assert.deepEqual(replay.status().state, 'done');
    assert.equal(replay.status().pending, false);
});

test('the cap keeps the newest 40 replies, passes their original indexes, and reports the older count', async () => {
    const r = rig();
    const replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(60), reason: 'fallback' });

    assert.equal(HISTORY_REPLAY_CAP, 40);
    assert.equal(r.calls.replies.length, 40);
    assert.equal(r.calls.replies[0], 20);
    assert.equal(r.calls.replies.at(-1), 59);
    assert.deepEqual(r.calls.views, Array.from({ length: 40 }, (_unused, index) => index + 20));
    assert.equal(result.older, 20);
    assert.equal(result.total, 40);
    assert.equal(replay.status().older, 20);
    assert.equal(r.calls.installs[0].turn, 40);
});

test('a reply failure is all-or-nothing and leaves a resumable attempt', async () => {
    const r = rig({ failAt: 3 });
    const replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(7), reason: 'fallback' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'REPLY_FAILED');
    assert.equal(result.installed, false);
    assert.equal(result.published, false);
    assert.equal(r.calls.installs.length, 0);
    assert.equal(r.calls.publications.length, 0);
    assert.deepEqual(r.calls.persisted.filter(Boolean).at(-1), { from: 0, to: 6, reason: 'fallback', attempt: 1 });
    assert.equal(replay.status().state, 'failed');
    assert.equal(replay.status().pending, true);
    assert.equal(replay.status().canRetry, true);
});

test('a chat switch or head change after the work began is discarded at the validity gate', async () => {
    const r = rig({ switchAt: 2 });
    const replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(7), reason: 'fallback' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'STALE');
    assert.equal(r.calls.valid.length, 1, 'the start marker is checked before install');
    assert.equal(r.calls.installs.length, 0);
    assert.equal(r.calls.publications.length, 0);
    assert.equal(r.base.turn, 0);
});

test('skip stops after the current reply, installs nothing, and persists to the end of the range', async () => {
    let replay;
    const r = rig({ skipAt: 1, replay: () => replay });
    replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(5), reason: 'fallback' });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(r.calls.replies, [0, 1], 'the reply already in progress finished');
    assert.equal(r.calls.installs.length, 0);
    assert.equal(r.calls.publications.length, 0);
    assert.deepEqual(r.calls.persisted.at(-1), { from: 0, to: 4, reason: 'fallback', attempt: 1, skipped: true });
    assert.deepEqual(replay.status().done, 2);
    assert.equal(replay.status().skipped, true);
    assert.equal(replay.status().pending, false, 'skipping releases the reading hold');
});

test('a failed run resumes from the persisted field after a reload and keeps the attempt count', async () => {
    const first = rig({ failAt: 2 });
    const one = createHistoryReplay(first.deps);
    const failed = await one.run({ base: first.base, replies: repliesOf(6), reason: 'fallback' });
    assert.equal(failed.code, 'REPLY_FAILED');
    const saved = first.current();
    assert.equal(saved.attempt, 1);

    const second = rig({ base: { turn: 0, catchUp: saved } });
    const two = createHistoryReplay(second.deps);
    const resumed = await two.run({ base: second.base, replies: repliesOf(6), reason: 'fallback' });
    assert.equal(resumed.ok, true);
    assert.deepEqual(second.calls.replies, [0, 1, 2, 3, 4, 5], 'the selected range is re-derived from the restored base');
    assert.deepEqual(second.calls.persisted[0], { from: 0, to: 5, reason: 'fallback', attempt: 2 });
    assert.equal(second.calls.installs.length, 1);
    assert.equal(second.calls.publications.length, 1);
});

test('retries stop at the cap across reloads', async () => {
    let persisted = null;
    const outcomes = [];
    for (let index = 0; index < HISTORY_REPLAY_MAX_ATTEMPTS; index += 1) {
        const base = { turn: 0, catchUp: persisted };
        const r = rig({ base, failAt: 0 });
        const replay = createHistoryReplay(r.deps);
        const result = await replay.run({ base, replies: repliesOf(3), reason: 'fallback' });
        outcomes.push(result.code);
        persisted = r.current();
    }
    assert.deepEqual(outcomes, ['REPLY_FAILED', 'REPLY_FAILED', 'REPLY_FAILED']);
    assert.equal(persisted.attempt, HISTORY_REPLAY_MAX_ATTEMPTS);

    const base = { turn: 0, catchUp: persisted };
    const blockedRig = rig({ base });
    const blocked = createHistoryReplay(blockedRig.deps);
    const result = await blocked.run({ base, replies: repliesOf(3), reason: 'fallback' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RETRY_CAP');
    assert.equal(blockedRig.calls.replies.length, 0, 'the blocked run makes no model/reply calls');
    assert.equal(blockedRig.calls.installs.length, 0);
    assert.equal(blockedRig.calls.publications.length, 0);
});

test('outward writes during replay reach only the recording sink', async () => {
    const r = rig();
    const replay = createHistoryReplay(r.deps);
    const result = await replay.run({ base: r.base, replies: repliesOf(3), reason: 'fallback' });

    assert.equal(result.ok, true);
    assert.deepEqual(r.calls.sinkWrites, [5, 10, 15], 'each reply wrote five operations into the sink');
    assert.equal(r.calls.installs.length, 1);
    assert.equal(r.calls.publications.length, 1, 'exactly one publication happens, at the end');
});

test('status is read-only and reports progress while a reply is in flight', async () => {
    let observed = null;
    let replay;
    const r = rig({ replay: () => replay });
    replay = createHistoryReplay(r.deps);
    const original = r.deps.runReply;
    r.deps.runReply = async (state, view, sink) => {
        observed = { ...replay.status() };
        return original(state, view, sink);
    };

    await replay.run({ base: r.base, replies: repliesOf(2), reason: 'fallback' });
    assert.equal(observed.state, 'running');
    assert.equal(observed.running, true);
    assert.equal(observed.pending, true);
    assert.equal(observed.total, 2);
    assert.equal(observed.done, 1, 'the second reply sees the first reply already counted');
});
