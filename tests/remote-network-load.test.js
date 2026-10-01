import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectNpcStateDataFile } from '../storage.js';

// On a slow remote/mobile link every full sidecar transfer is felt: boundary checks must revalidate
// (never read stale) but let an unchanged file come back as "304 Not Modified" without its body.
test('sidecar reads always revalidate with the server and may be answered 304 Not Modified', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
        calls.push(options);
        return { ok: true, status: 200, text: async () => JSON.stringify({ format: 'npc-state-delta-data-file', chatKey: 'chat:a.png:x', revision: 3, state: { npcs: [] } }) };
    };
    await inspectNpcStateDataFile({ path: '/user/files/x.json' }, { fetchFn, expectedChatKey: 'chat:a.png:x' }).catch(() => null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cache, 'no-cache', 'no-store would force a full download on every check');
});

async function sendWithoutServerRead(mockState, eventSource, manualAddNpc, sleep) {
    const runtime = globalThis.NPCStateDelta;
    mockState.context.groupId = null;
    mockState.context.chatId = 'remote-send';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    mockState.context.chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: 'Mira waits by the gate.' }];
    eventSource.emit('chat_changed');
    await sleep(150);
    await manualAddNpc('Mira Remote');
    await runtime.flush();
    const base = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async (url, options = {}) => {
        if ((options.method || 'GET') === 'GET' && String(url).startsWith('/user/files/')) reads += 1;
        return base(url, options);
    };
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Hello, Mira Remote.' });
    for (const listener of mockState.listeners.get('message_sent') || []) await listener(mockState.context.chat.length - 1);
    globalThis.fetch = base;
    if (reads !== 0) throw new Error(`sending a message waited on ${reads} sidecar read(s)`);
    if (runtime.getState().lineage.length !== mockState.context.chat.length) throw new Error('the sent turn did not update the lineage');
    setTimeout(() => process.exit(0), 300);
}

test('sending a message in a loaded chat does not wait on a sidecar read', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${sendWithoutServerRead.toString()})(mockState, eventSource, manualAddNpc, sleep);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
    });
});
