// A minimal fake Delta runtime port for createParticipant tests that need no synthetic host: a state held in memory with write counters.
import { createParticipant, buildCheckpoint, memoryVault, storedTimeline, timelineOf } from '../../src/storysuite-participant/index.js';

export const npc = (id, name) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive' });
export const clone = value => JSON.parse(JSON.stringify(value));

export function seeded(seed = 5) {
    let value = seed;
    return () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
}

/** { delta, vault, live, writes, port }: `live.state` is the chat state; `writes` counts every state write. */
export function makeDelta({ state = { npcs: [] }, vault = memoryVault(), extra = {}, options = {} } = {}) {
    const live = { state: clone(state) };
    const writes = { install: 0, timeline: 0 };
    const port = {
        chatKey: () => 'chat:one',
        readState: () => clone(live.state),
        installState: async next => { writes.install += 1; live.state = clone(next); },
        writeTimeline: async block => { writes.timeline += 1; live.state = { ...live.state, timeline: clone(block) }; },
        ...extra,
    };
    const delta = createParticipant({ port, vault, random: seeded(), ...options });
    return { delta, vault, live, writes, port };
}

/** Puts a checkpoint of `lineage` holding `state` into the vault → { id, hash }. */
export async function keep(vault, lineage, state) {
    const withLine = { ...state, timeline: storedTimeline({ ...timelineOf(null), lineage }) };
    const built = buildCheckpoint({ lineage, state: withLine });
    await vault.put(built.id, built.doc);
    return { id: built.id, hash: built.hash };
}
