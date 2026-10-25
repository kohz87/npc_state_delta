// A rig for the timeline participant on the real Story Block host (the vendored testkit): Delta's chat state and its checkpoint vault are
// the rig's, the host is the real one, and `reload()` starts everything again over what was saved (the chat file and its metadata, Delta's
// state, the vault), the way a page reload does. Tests only; nothing here ships.
import { createHost } from '../vendor/story-block/testkit/index.js';
import { hashJson } from '../vendor/story-block/src/v2/replay.js';
import { crash } from '../vendor/story-block/src/v2/timeline/index.js';
import { MODULE_ID, createParticipant, memoryVault } from '../../src/storysuite-participant/index.js';

export const npc = (id, name, extra = {}) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive', trust: 3, ...extra });
export const BATCH = { id: 'br_batch001', hash: hashJson({ batch: 'br_batch001', outcome: 'dead' }) };
export const clone = value => JSON.parse(JSON.stringify(value));
export { MODULE_ID, crash, hashJson };

/** Who owns the sealed result of a death: the host asks `batchResults.resolve` for its bytes. */
export const sealer = () => ({
    id: 'tl-sealer', name: 'Sealer', version: '0.0.1', domains: { death: { initial: () => ({ batches: {} }) } },
    commands: { 'tl.seal'(ctx, { id }) { ctx.draft('death').batches[id] = { batch: id, outcome: 'dead' }; return { summary: 'Sealed.', narrate: false }; } },
    batchResults: { resolve: ({ id, state }) => { const bytes = state.domains.death?.batches?.[id]; return bytes === undefined ? null : { id, hash: hashJson(bytes), bytes }; } },
});

export const freshState = () => ({ npcs: [npc('npc_mira', 'Mira', { aliases: ['The Weaver'] }), npc('npc_tom', 'Old Tom')], socialGraph: { edges: [{ a: 'npc_mira', b: 'npc_tom', kind: 'friends' }] }, checkpoints: [], lineage: [], turn: 1 });

/**
 * rig(t, { state?, vault?, image?, quiet?, faults?, hydrate? }) → { host, live, delta, vault, warnings, disk, trust(), change(edit), reload(), ... }
 *   live: { chatKey, state, installs }  Delta's chat state (what the runtime would hold and save)
 *   disk: the chat file and its metadata as the last save wrote them
 */
export async function rig(t, { state = freshState(), vault = memoryVault(), image = null, quiet = {}, faults = null, hydrate = true, live = null, modules = [], withoutSource = false } = {}) {
    const mine = live ?? { chatKey: 'chat:avatar.png:one', state: structuredClone(state), installs: 0 };
    const warnings = [];
    const port = {
        chatKey: () => mine.chatKey,
        readState: () => structuredClone(mine.state),
        installState: async next => {
            if (mine.failInstall > 0) { mine.failInstall -= 1; throw new Error('The restored native state could not be saved yet.'); }
            mine.installs += 1;
            mine.state = structuredClone(next);
        },
        writeTimeline: async block => { mine.state = { ...mine.state, timeline: structuredClone(block) }; },
        warn: text => warnings.push(text),
        ...quiet,
    };
    const delta = createParticipant({ port, vault, debounceMs: 1, retryMs: 5 });
    if (hydrate) await delta.hydrate();
    const participant = withoutSource
        ? { ...delta.participant, attach: handle => delta.participant.attach({ ...handle, head: async () => { const { source, ...rest } = await handle.head(); void source; return rest; } }) }
        : delta.participant;
    const def = { id: MODULE_ID, name: 'NPC State Delta (test)', version: '0.0.1', domains: { marks: { initial: () => ({ n: 0 }) } }, participant, queries: delta.queries };
    const hook = { at: async () => {} };
    if (faults) hook.at = faults;
    const host = await createHost({ modules: [sealer(), def, ...modules], timelineFaults: hook, ...(image ? { st: { chat: image.chat } } : {}) });
    if (image) {
        host.ctx.chatMetadata = clone(image.metadata);
        await host.turn.onChatChanged();
    }
    t.after(() => host.close());
    // The chat file as the last save wrote it (a reload reads this).
    const disk = { image: { chat: clone(host.ctx.chat), metadata: clone(host.ctx.chatMetadata) } };
    const original = host.ctx.saveChat;
    host.ctx.saveChat = async (...args) => {
        const out = await original.apply(host.ctx, args);
        disk.image = { chat: clone(host.ctx.chat), metadata: clone(host.ctx.chatMetadata) };
        return out;
    };
    const rigOut = {
        host, live: mine, delta, vault, warnings, disk, hook, port,
        trust: () => mine.state.npcs[0].trust,
        /** Delta saves a change to its state and the participant publishes it at the head. */
        async change(edit) {
            edit(mine.state);
            delta.noteChange();
            const out = await delta.flush();
            if (!out?.ok) throw new Error(`the change was not published: ${out?.code} ${out?.message}`);
            return out;
        },
        /** The restore to `snapshot` at the head (the batch sealed in the story first). */
        async restoreTo(snapshot) {
            if (host.head().domains.death?.batches?.[BATCH.id] === undefined) {
                const done = await host.sdk.command('tl.seal', { id: BATCH.id });
                if (!done.ok) throw new Error(`could not seal: ${done.message}`);
            }
            const head = await host.sdk.timeline.head();
            const prepared = await host.timeline.host.prepare({ snapshot: snapshot.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
            if (!prepared.ok) return prepared;
            return host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash });
        },
        /** Starts everything again over what was saved: a new participant over the same state and vault, a new host over the chat file. */
        reload(options = {}) {
            return rig(t, { vault, image: clone(disk.image), live: mine, modules, withoutSource, hydrate: false, ...options });
        },
    };
    return rigOut;
}

/** The story up to a few replies, each with a native change published at it: trust 5 after the first, 7 after the second, 9 after the third. */
export async function played(t, options = {}) {
    const r = await rig(t, options);
    await r.host.send('Hello.', 'One.');
    await r.change(state => { state.npcs[0].trust = 5; });
    await r.host.send('Two.', 'Two reply.');
    await r.change(state => { state.npcs[0].trust = 7; });
    await r.host.send('Three.', 'Three reply.');
    await r.change(state => { state.npcs[0].trust = 9; });
    return r;
}

// ---- the adapter (src/storysuite-v2.js) on the real host, over a fake Delta runtime -------------------------------------------------------

/**
 * adapterRig(t, { state?, vault?, image?, live?, history? }) → { host, adapter, api, live, vault, delta (the participant's view through the host), ... }
 * The real adapter registers Delta's module (with its participant and npc.identity) on a real host; `api` is the fake runtime it talks to
 * (`window.NPCStateDelta`): the chat's state, an absolute install, the change announcements, the scan counters and the message gate.
 */
export async function adapterRig(t, { state = freshState(), vault = memoryVault(), image = null, live = null, modules = [], participantOptions = { debounceMs: 1, retryMs: 5 }, settle = {} } = {}) {
    const { createStorySuiteV2Adapter } = await import('../../src/storysuite-v2.js');
    t.mock.method(console, 'warn', () => {});
    const mine = live ?? { chatKey: 'chat:avatar.png:one', state: structuredClone(state), installs: 0, writes: 0, scans: 0, waiting: 0 };
    const host = await createHost({ modules: [sealer(), ...modules], ...(image ? { st: { chat: image.chat } } : {}) });
    if (image) {
        host.ctx.chatMetadata = clone(image.metadata);
        await host.turn.onChatChanged();
    }
    t.after(() => host.close());
    const listeners = new Set();
    const warnings = [];
    const box = { ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const api = {
        gate: null,
        isEnabled: () => true,
        getNpc: id => mine.state.npcs.find(item => item.id === id) ?? null,
        relationshipBaseline: () => ({ trust: 0, affection: 0, desire: 0, tension: 0 }),
        chatKey: () => mine.chatKey,
        getState: () => structuredClone(mine.state),
        timelineStarted: () => Boolean(mine.state.timeline?.lineage),
        installState: async next => {
            if (mine.holdInstall) await mine.holdInstall;
            mine.installs += 1;
            mine.state = structuredClone(next);
        },
        writeTimeline: async block => { mine.writes += 1; mine.state = { ...mine.state, timeline: structuredClone(block) }; },
        onNativeChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        scanActive: () => mine.scans > 0,
        scanIdle: async () => true,
        useMessageGate: gate => { api.gate = gate; },
        stateReady: () => true,
        requestHeaders: () => ({}),
    };
    const adapter = createStorySuiteV2Adapter({
        suiteApi: { npcs: () => mine.state.npcs.map(({ id, name, aliases, present, archived }) => ({ id, name, aliases, present, archived })) },
        delta: () => api, version: 'test', host: () => box, headReply: () => host.store.headIndex(),
        doc: { documentElement: { dataset: {} }, getElementById: () => null, addEventListener() {}, dispatchEvent() { return true; } },
        timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
        logger: { warn: (...args) => warnings.push(args.join(' ')) }, loadEmptyCast: async () => null,
        participantVault: vault, participantOptions, ...settle,
    });
    adapter.start();
    if (await adapter.settled() !== true) throw new Error(`the adapter did not register: ${warnings.join(' / ')}`);
    t.after(() => adapter.stop());
    const disk = { image: { chat: clone(host.ctx.chat), metadata: clone(host.ctx.chatMetadata) } };
    const original = host.ctx.saveChat;
    host.ctx.saveChat = async (...args) => {
        const out = await original.apply(host.ctx, args);
        disk.image = { chat: clone(host.ctx.chat), metadata: clone(host.ctx.chatMetadata) };
        return out;
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    return {
        host, adapter, api, live: mine, vault, warnings, disk, sleep,
        /** Delta saves a change to its state and announces it, as index.js does. */
        announce(edit = () => {}) {
            edit(mine.state);
            for (const fn of [...listeners]) fn({ key: mine.chatKey });
        },
        listeners,
        /** Delta saves a change at the head and the story records it: resolves when the participant's selected checkpoint has moved. */
        async published(edit) {
            const was = (await host.sdk.timeline.status()).participants[0]?.hash ?? null;
            this.announce(edit);
            for (let i = 0; i < 200; i += 1) {
                const now = (await host.sdk.timeline.status()).participants[0]?.hash ?? null;
                if (now !== was && host.registry.restore().state !== 'pending') return now;
                await sleep(5);
            }
            throw new Error('the change was not published');
        },
        reload(options = {}) {
            return adapterRig(t, { vault, image: clone(disk.image), live: mine, modules, participantOptions, settle, ...options });
        },
    };
}
