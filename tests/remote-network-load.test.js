import test from 'node:test';
import assert from 'node:assert/strict';
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
