// A rebuild through the adapter's real participant port reads exactly the asked replies: the port forwards `{ replies }` to the runtime's
// `rebuildScan` (runtime-scan-ops.js), which makes one normal scanNow per reply, oldest first, over the replies the story stands on.
// The fake runtime here uses the production rebuildScan with a recording scanNow; the host is the real Story Block testkit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig } from './helpers/participant-rig.js';
import { register } from 'node:module';
import { useTranscriptSource } from '../src/transcript.js';

// runtime-scan-ops.js imports SillyTavern's extensions.js, which a test has no copy of: a resolve hook answers it with a stub.
const hooks = `export async function resolve(specifier, context, next) {
    if (specifier.endsWith('/extensions.js')) return { url: 'data:text/javascript,export const getContext=()=>({chat:[]});export const extension_settings={};', shortCircuit: true };
    return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { createScanOpsPart } = await import(`../runtime-scan-ops.js?rebuild-scan`);

async function rebuilding(t, { scanNow } = {}) {
    const r = await adapterRig(t);
    for (let i = 1; i <= 5; i += 1) await r.host.send(`Question ${i}.`, `Answer ${i}.`);
    useTranscriptSource({ context: () => ({ chat: r.host.ctx.chat }) });
    t.after(() => useTranscriptSource({ context: () => ({ chat: [] }) }));
    const calls = [];
    const map = () => new Map();
    const part = createScanOpsPart({
        hydratedStateMeta: map(), pendingAutoScans: map(), stateVersions: map(), scanIntents: map(), deferredWork: map(), emptyAnswerChats: map(),
    }, {
        getChatKey: () => r.live.chatKey, scanNow: scanNow ?? (async options => { calls.push(options); return true; }),
        isScanBusy: () => false, scanOperations: {}, diagnosticStore: {},
    });
    r.api.normalizeState = state => structuredClone({ npcs: [], ...state });
    r.api.rebuildScan = input => part.rebuildScan(input);
    r.api.headSource = undefined;
    return { ...r, calls };
}
const replyIds = r => r.host.ctx.chat.flatMap((message, at) => (message && !message.is_user && !message.is_system ? [at] : []));

test('a rebuild through the real port scans exactly the last N replies, oldest first, by the normal scan call', async t => {
    const r = await rebuilding(t);
    const ids = replyIds(r);
    assert.equal(ids.length >= 5, true);
    const out = await r.adapter.definition.participant.rebuild({ return: 'rt_scan00001', replies: 3 });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.calls.map(call => call.messageId), ids.slice(-3));
    assert.equal(r.calls.every(call => call.manual === false), true);
});

test('replies: null reads every reply the story stands on', async t => {
    const r = await rebuilding(t);
    const out = await r.adapter.definition.participant.rebuild({ return: 'rt_scan00002', all: true });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.calls.map(call => call.messageId), replyIds(r));
});

test('the default window is the participant\'s default (40), so a short chat is read whole', async t => {
    const r = await rebuilding(t);
    const out = await r.adapter.definition.participant.rebuild({ return: 'rt_scan00003' });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.calls.map(call => call.messageId), replyIds(r));
});

test('a scan that does not complete stops the read and fails the rebuild, with the earlier replies already read', async t => {
    const seen = [];
    const r = await rebuilding(t, { scanNow: async options => { seen.push(options.messageId); return seen.length < 2; } });
    const out = await r.adapter.definition.participant.rebuild({ return: 'rt_scan00004', replies: 4 });
    assert.equal(out.ok, false);
    assert.equal(seen.length, 2);
});
