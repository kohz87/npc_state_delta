// Packs (SPEC §9, MODULES §E): a part of Story Block's core module.
//
// A pack is a pack.json of plain data: items, creatures, shops, recipes, events, quests, a
// start state, screens, layouts and a theme. Packs are installed from a file or from a character's
// lorebook into `extension_settings.storySuite.packs` and read by other parts through the
// queries and hooks below. The part has no domain and no commands: installing a pack is a
// settings change, not a story event, and what a pack gives a chat is copied into the chat's
// state by its owner (inventory for item defs, the host for the start state).
//
// Interface for the other parts:
// * query `packs.list` → installed packs for display (`installed.js` list()).
// * query `packs.content({ kind, pack? })` → records of one kind from enabled packs (places and
//   routes are the map Story Director's atlas reads; `terms` the level and XP words RPG Battle reads; `ranks` a
//   ladder of quest ranks for Story Director's `quest.ranks` and RPG Battle's foe strength).
// * query `packs.calendar` → the first enabled pack's calendar for the story clock, or null.
// * query `packs.crafts` → the craft table (default crafts, enabled packs' `crafts` laid over them:
//   `[{ craft, title, stats, stations, note?, pack }]`) that RPG Battle's crafting reads with recipes.
// * query `packs.economy` → the first enabled pack's money scale `{ pack, scale, note }`, or null. Modules
//   read the settled scale through Story Block's `inventory.economy` instead (MODULES §F104).
// * query `packs.item({ name })` and hook `item.resolve(name)` → the pack item def a story
//   name means (`pack.<packId>/<slug>`, SPEC §7 shape) or null. Inventory capture calls it
//   after its own aliases and before it creates a `story/<slug>` def.
// * query `packs.start` and hook `start()` → the enabled packs' start, merged (SPEC §2.6);
//   `applyStart(state, start, { id })` writes it into an initial State.

import { createInstalled } from './installed.js';
import { calendarOf, contentOf, craftsOf, economyOf, mergeStart, resolveItemIn, applyStart } from './content.js';
import { renderPacksPanel } from './panel.js';
import { HOST_VERSION, validatePack, slugify } from './validate.js';
import { readCharacterLorebook, stCapabilities, stHostVersion, stSettings } from './st-adapter.js';

export { validatePack, slugify, applyStart, mergeStart, resolveItemIn, contentOf, calendarOf, craftsOf, economyOf, createInstalled, renderPacksPanel };
export { LIMITS, CONTENT_KINDS, DEFAULT_CRAFTS, STATIONS } from './limits.js';
export { findPackEntries, PACK_TAG } from './lorebook.js';
export { satisfies } from './version.js';

/**
 * Builds the part over injected access, so tests (and the coordinator, if it prefers the
 * registry's own capability list) can bind it to anything.
 *
 * `settings`: `{ read(), save() }` over the storySuite settings object; `readLorebook()`:
 * `→ { character, entries, problem }`; `capabilities()`: names or null; `hostVersion`: a version or a function giving it.
 * Returns `{ part, packs, resolveItem, startState, economy }`.
 */
export function createPacksPart({ settings, readLorebook = async () => ({ character: '', entries: [], problem: 'No lorebook reader.' }), capabilities = () => null, hostVersion = HOST_VERSION } = {}) {
    const packs = createInstalled({ settings, capabilities, hostVersion });

    /** The pack item def a story name means, or null (see content.js resolveItemIn). */
    const resolveItem = name => resolveItemIn(packs.packs(), name);
    /** The enabled packs' start, merged (see content.js mergeStart). */
    const startState = () => mergeStart(packs.packs());
    /** The enabled packs' money scale, or null (see content.js economyOf). */
    const economy = () => economyOf(packs.packs());

    const part = {
        domains: {},
        commands: {},
        queries: {
            'packs.list': () => packs.list(),
            'packs.content': (_state, { kind, pack = null } = {}) => contentOf(packs.packs(), kind, { pack }),
            'packs.item': (_state, { name } = {}) => resolveItem(name),
            'packs.start': () => startState(),
            'packs.calendar': () => calendarOf(packs.packs()),
            'packs.crafts': () => craftsOf(packs.packs()),
            'packs.economy': () => economy(),
        },
        kinds: {},
        context: { static: () => '', tail: () => ({ lines: [], optional: [] }), budget: 0 },
        hooks: {
            'item.resolve': name => resolveItem(name),
            start: () => startState(),
        },
        settings: {
            section: 'Packs',
            // Its own fold in the settings, right after Story Suite's (host-ui.js), shown with no pack installed too.
            fold: { id: 'packs', hint: 'import a pack' },
            defaults: {},
            schema: {},
            render: (el, api) => renderPacksPanel(el, { packs, readLorebook, notify: text => api?.notify?.(text) }),
        },
        tabs: [],
    };
    return { part, packs, resolveItem, startState, economy };
}

// The part as Story Block loads it: bound to SillyTavern through st-adapter.js, read lazily.
const live = createPacksPart({
    settings: stSettings(),
    readLorebook: readCharacterLorebook,
    capabilities: stCapabilities,
    hostVersion: () => stHostVersion() ?? HOST_VERSION,
});

export const part = live.part;
export const packs = live.packs;
export const resolveItem = live.resolveItem;
export const startState = live.startState;
export const economy = live.economy;
