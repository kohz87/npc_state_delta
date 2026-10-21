// B-b7-combos-4: src/storysuite-v2.js register() calls the v2 sdk's registerModule() without awaiting
// it. Story Block's registerModule is async (sdk.js), so a refusal (a query or tab id another module
// already holds, a re-register after the host flapped, a stricter host) is an unhandled promise
// rejection, and the adapter marks itself hosted anyway: Delta's drawer panel and launcher are
// hidden and <html> says hosted, although no Cast tab and no settings section exist, so Delta's
// settings cannot be reached at all. Drop into npc_state_delta/tests/v2/break/.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HOSTED_FLAG, createStorySuiteV2Adapter } from '../src/storysuite-v2.js';

function fakeDoc() {
    const dataset = {};
    return {
        documentElement: { dataset },
        getElementById: () => null,
        addEventListener() {},
        dispatchEvent() { return true; },
        createElement: () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {} } }),
    };
}
const manualTimers = () => ({ setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval: () => 2, clearInterval() {} });

test('a refused v2 registration is handled and leaves Delta unhosted', async () => {
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        // The real sdk.registerModule is `async`: a refusal is a rejected promise, not a throw.
        const sdk = { registerModule: async def => { throw new Error(`Story Suite: the module "${def.id}" cannot be registered: the query "npc.present" already belongs to "other"`); } };
        const host = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
        const doc = fakeDoc();
        const adapter = createStorySuiteV2Adapter({
            suiteApi: { npcs: () => [] }, delta: () => null, host: () => host, doc, timers: manualTimers(),
            loadEmptyCast: async () => null, logger: { warn() {} },
        });
        adapter.start();
        await new Promise(resolve => setTimeout(resolve, 20));
        await adapter.settled();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(adapter.hosted(), false, 'Delta says it is hosted although the host refused it');
        assert.notEqual(doc.documentElement.dataset[HOSTED_FLAG], '1', 'the page flag hides the launcher and drawer copy of a module that is not registered');
        assert.deepEqual(unhandled.map(String), [], 'the refusal escaped as an unhandled rejection');
        adapter.stop();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});
