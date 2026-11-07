// After the host's head selection falls back to an earlier checkpoint, Delta reads the replies after that checkpoint (its saved scan marker)
// before new play: through its existing catch-up (the automatic scan's skipped-replies window), oldest first, each reply once, and without
// writing the old replies onto the current head's present-tense state (a window that stops before the latest reply is earlier context only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { replyScanned, settleScan } from '../scan-context.js';
import { skippedExchangesWindow, useTranscriptSource } from '../src/transcript.js';
import { createPublicApiStatePart } from '../runtime-entry-public-write.js';
import { adapterRig } from './helpers/participant-rig.js';

const chatOf = replies => {
    const chat = [{ is_user: false, name: 'Nar', mes: 'R0 opening.' }];
    for (let k = 1; k <= replies; k += 1) { chat.push({ is_user: true, name: 'User', mes: `U${k}` }); chat.push({ is_user: false, name: 'Nar', mes: `R${k} She sighs.` }); }
    return chat;
};
const useChat = chat => useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => 6 });
const ids = [0, 2, 4, 6, 8, 10, 12];

test('the missed replies after the restored marker are read once, oldest first, and the marker then reaches the newest reply', () => {
    useChat(chatOf(6));
    let state = { lastScannedMessageId: 4, readAhead: [] };   // the marker the earlier checkpoint carried
    const read = [];
    for (let guard = 0; guard < 5; guard += 1) {
        const window = skippedExchangesWindow(12, { afterId: state.lastScannedMessageId, replies: 3, limit: 6 });
        if (!window) break;
        read.push(...window.readIds.filter(id => id % 2 === 0));
        const settled = settleScan({ marker: state.lastScannedMessageId, readAhead: state.readAhead, readIds: window.readIds, target: window.readThrough ?? 12, replyIds: ids });
        state = { lastScannedMessageId: settled.marker, readAhead: settled.readAhead };
    }
    assert.deepEqual(read, [6, 8, 10, 12], 'in order, each once');
    assert.equal(replyScanned(state, 12), true);
});

test('replay equals live: reading the missed replies after a restore leaves the marker where reading each reply as it came does', () => {
    useChat(chatOf(6));
    let live = { marker: -1, readAhead: [] };
    for (const id of ids) live = { ...live, marker: settleScan({ marker: live.marker, readAhead: [], readIds: [id], target: id, replyIds: ids }).marker };
    const window = skippedExchangesWindow(12, { afterId: 4, replies: 3, limit: 6 });
    const replayed = settleScan({ marker: 4, readIds: window.readIds, target: 12, replyIds: ids });
    assert.equal(replayed.marker, live.marker);
    assert.deepEqual(replayed.readAhead, []);
});

test('catchUpAfterRestore queues the newest reply once when the marker is behind, and nothing when it is not', async () => {
    const chat = chatOf(3);
    const queued = [];
    const drained = [];
    let marker = 2;
    const part = createPublicApiStatePart(new Proxy({
        getChatKey: () => 'chat:k',
        getChatState: () => ({ lastScannedMessageId: marker }),
        latestMessageId: () => chat.length - 1,
        queuePendingAutoScan: (...args) => { queued.push(args); return true; },
        drainPendingAutoScan: key => { drained.push(key); },
    }, { get: (target, name) => (name in target ? target[name] : () => ({})) }));
    assert.equal(part.catchUpAfterRestore(), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(queued, [['chat:k', 6, 'restore-catch-up']]);
    assert.deepEqual(drained, ['chat:k']);
    marker = 6;
    assert.equal(part.catchUpAfterRestore(), false);
    assert.equal(queued.length, 1);
});

test('the adapter tells Delta\'s runtime after a fallback restore installs the earlier checkpoint, and only then', async t => {
    const r = await adapterRig(t);
    const calls = [];
    r.api.catchUpAfterRestore = () => { calls.push(r.live.installs); return true; };
    const { host } = r;
    await host.send('Hello.', 'One.');
    await host.sdk.timeline.make({ kind: 'manual', name: 'Start' });
    await r.published(state => { state.npcs[0].trust = 5; });
    await host.send('Two.', 'Two reply.');
    await r.published(state => { state.npcs[0].trust = 7; });
    assert.deepEqual(calls, [], 'a normal publish is not a restore');
    const chat = host.ctx.chat;
    while (chat.length && chat.at(-1).is_user) await host.st.deleteMessage(chat.length - 1);
    await host.st.deleteMessage(chat.length - 1);
    assert.equal(await r.api.gate.settled(), true);
    assert.equal(r.live.state.npcs[0].trust, 5);
    assert.equal(calls.length, 1, 'told once, after the install');
    assert.ok(calls[0] >= 1);
});
