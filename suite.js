// Story Suite handshake, v1. This file is identical in Story Block, Story Director, NPC State
// Delta and RPG Battle; change it in all four together (docs/STORY_SUITE.md).
//
// The extensions work alone and together. Together, each announces itself and the areas it can
// own, and asks who owns an area before sending something another extension already sends: the
// specialist for an area wins, and the reader can override that per extension. Nothing here
// imports anything or depends on another extension being installed; the first extension to load
// creates the registry on globalThis and the others join it, in any load order.

export const SUITE_VERSION = 1;

// The areas, and who owns each when several offer it (first listed that is present wins).
export const AREAS = Object.freeze({
    // Who is in the scene now: presence, outfit, mood, position, place, time as written.
    scene: ['story-block', 'npc-state-delta'],
    // Who an NPC is: identity, personality, voice, relationships, long-term goals.
    npc: ['npc-state-delta', 'story-director'],
    // The calendar and story time.
    calendar: ['story-director', 'npc-state-delta'],
    // The world's timeline: off-screen agendas, quests, clocks, arcs.
    timeline: ['story-director', 'story-block'],
    // Game numbers: HP, MP, stats, skills, fights.
    stats: ['rpg-battle', 'story-block', 'npc-state-delta'],
    // What the player carries.
    items: ['story-block', 'rpg-battle'],
    // Roll modifiers for checks outside fights.
    rolls: ['rpg-battle', 'story-block'],
});

function makeRegistry(previous = null) {
    const providers = new Map(previous?.snapshot?.() ?? []);
    const listeners = new Set(previous?.listenersSnapshot?.() ?? []);
    const notify = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                console.warn('[Story Suite] a listener failed', error);
            }
        }
    };
    const offers = (provider, area) => provider && provider.enabled !== false && provider.owns.includes(area);
    return Object.freeze({
        version: SUITE_VERSION,
        areas: AREAS,
        /** { id, name, version, owns: [areas], enabled?, api? }: announce, or update an earlier announcement. */
        announce(provider) {
            const id = String(provider?.id ?? '').trim();
            if (!id) return;
            providers.set(id, { ...provider, id, owns: [...new Set((provider.owns ?? []).map(String))], enabled: provider.enabled !== false });
            notify();
        },
        withdraw(id) {
            if (providers.delete(String(id))) notify();
        },
        /** The announced providers (copies). */
        providers: () => [...providers.values()].map(provider => ({ ...provider, owns: [...provider.owns] })),
        /** True when `id` is announced and enabled. */
        has: id => providers.get(String(id))?.enabled === true,
        /** A provider's api object (what it chose to share), or null. */
        api: id => (providers.get(String(id))?.enabled ? providers.get(String(id)).api ?? null : null),
        /** Who owns `area` now: the first in AREAS' order that offers it, else any that does, else null. */
        owner(area) {
            for (const id of AREAS[area] ?? []) if (offers(providers.get(id), area)) return id;
            for (const provider of providers.values()) if (offers(provider, area)) return provider.id;
            return null;
        },
        /** Everyone offering `area`, owner first. */
        offering(area) {
            const owner = this.owner(area);
            const rest = [...providers.values()].filter(provider => offers(provider, area) && provider.id !== owner).map(provider => provider.id);
            return owner ? [owner, ...rest] : rest;
        },
        /** Called whenever an announcement changes. Returns an unsubscribe function. */
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        // For a newer version taking over: what it needs to keep.
        snapshot: () => [...providers.entries()],
        listenersSnapshot: () => [...listeners],
    });
}

/** The shared registry, created (or upgraded from an older version) on first use. */
export function storySuite() {
    const current = globalThis.StorySuite;
    if (!current || !(Number(current.version) >= SUITE_VERSION)) globalThis.StorySuite = makeRegistry(current ?? null);
    return globalThis.StorySuite;
}

/**
 * Whether `myId` is the source of truth for `area`, given the reader's choice in this
 * extension's settings: 'mine' (always this one), 'theirs' (another one when any other offers
 * it, else this one), or 'auto' (the suite's owner; this one when nobody else offers it).
 */
export function isSourceOfTruth(myId, area, choice = 'auto', suite = storySuite()) {
    const others = suite.offering(area).filter(id => id !== myId);
    if (choice === 'mine') return true;
    if (choice === 'theirs') return others.length === 0;
    const owner = suite.owner(area);
    return owner === null || owner === myId;
}
