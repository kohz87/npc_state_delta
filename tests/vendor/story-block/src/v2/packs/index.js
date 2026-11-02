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
//   routes are the map Story Director's atlas reads; other content is available to modules).
// * query `packs.portrait({ pack, file })` → the safe image URL of a cast portrait the pack names (`/user/files/…`), or null: the pack
//   is not installed, does not name that file, no picture was imported with it, or the file is gone (portraits.js).
//   `packs.content({ kind: 'cast' })` gives each person with `pack` and `packVersion` (cast.js).
// * query `packs.calendar` → the first enabled pack's calendar for the story clock, or null.
// * query `packs.crafts` → the craft table (default crafts, enabled packs' `crafts` laid over them:
//   `[{ craft, title, stats, stations, note?, pack }]`) for modules that use recipes.
// * query `packs.weather` → the first enabled pack's weather table `{ pack, seasons, tables }`, or null
//   (MODULES §F122: Story Director's weather by rule).
// * query `packs.youRank` → `{ pack, label }` of the first enabled pack with `content.you.rank`, or null (MODULES §F126).
// * query `packs.economy` → the first enabled pack's money scale `{ pack, scale, note }`, or null. Modules
//   read the settled scale through Story Block's `inventory.economy` instead (MODULES §F104).
// * query `packs.markets` → what sets a place's prices (PACKS.md "Markets"): `{ types, tags, places }`,
//   the enabled packs' `markets` records (settlement types and environment tags, the first pack's per
//   name) and the places with a market: the character lorebook's `market:` lines first
//   (`from: 'lorebook'`), then the packs' places that name a `market` or `tags` (`from: 'pack'`).
//   A module may use these records to set prices. The lorebook is read when a chat opens
//   (`refreshLore()`) and from the Packs panel, never by a query.
// * query `packs.item({ name })` and hook `item.resolve(name)` → the pack item def a story
//   name means (`pack.<packId>/<slug>`, SPEC §7 shape) or null. Inventory capture calls it
//   after its own aliases and before it creates a `story/<slug>` def.
// * query `packs.start` and hook `start()` → the enabled packs' start, merged (SPEC §2.6);
//   `applyStart(state, start, { id })` writes it into an initial State.

import { createInstalled } from './installed.js';
import { createPortraits } from './portraits.js';
import { browserImageIo } from './portrait-fit.js';
import { calendarOf, contentOf, craftsOf, economyOf, itemDefsIn, mergeStart, resolveItemIn, applyStart, weatherOf, youRankOf } from './content.js';
import { renderPacksPanel } from './panel.js';
import { HOST_VERSION, validatePack, slugify } from './validate.js';
import { readCharacterLorebook, stCapabilities, stHostVersion, stPortraitFiles, stSettings } from './st-adapter.js';
import { marketEntries } from './lorebook.js';

export { validatePack, slugify, applyStart, mergeStart, resolveItemIn, contentOf, calendarOf, craftsOf, economyOf, weatherOf, youRankOf, createInstalled, renderPacksPanel };
export { LIMITS, CONTENT_KINDS, DEFAULT_CRAFTS, STATIONS } from './limits.js';
export { findPackEntries, marketEntries, readMarketLine, PACK_TAG } from './lorebook.js';
export { satisfies } from './version.js';
export { validateDataModules, validateDataMigration, dataModuleDefaults, dataModuleHash,
    DM_DESCRIPTORS, DM_LIMITS, DM_DIAGNOSTICS, DATA_MODULES_CAPABILITY } from '../data-modules/check.js';

/**
 * Builds the part over injected access, so tests (and the coordinator, if it prefers the
 * registry's own capability list) can bind it to anything.
 *
 * `settings`: `{ read(), save() }` over the storySuite settings object; `readLorebook()`:
 * `→ { character, entries, problem }`; `capabilities()`: names or null; `hostVersion`: a version or a function giving it;
 * `portraitFiles`: the file store for portraits (portraits.js) and `portraitIo`: the decoder and encoder that makes a large one smaller.
 * Returns `{ part, packs, resolveItem, startState, economy }`.
 */
export function createPacksPart({ settings, readLorebook = async () => ({ character: '', entries: [], problem: 'No lorebook reader.' }), capabilities = () => null, hostVersion = HOST_VERSION, portraitFiles = null, portraitIo = null } = {}) {
    const portraits = createPortraits({ settings, files: portraitFiles, imageIo: portraitIo });
    const packs = createInstalled({ settings, capabilities, hostVersion, portraits });

    /** The pack item def a story name means, or null (see content.js resolveItemIn). */
    const resolveItem = name => resolveItemIn(packs.packs(), name);
    /** The enabled packs' start, merged (see content.js mergeStart). */
    const startState = () => mergeStart(packs.packs());
    /** The enabled packs' money scale, or null (see content.js economyOf). */
    const economy = () => economyOf(packs.packs());

    // The character lorebook's market lines, read when a chat opens and from the Packs panel.
    const lore = { markets: [], character: '', problem: '' };
    let reading = null;
    /** Reads the open character's lorebook again for its `market:` lines; resolves to how many places it gave. */
    const refreshLore = () => {
        reading ??= (async () => {
            try {
                const got = await readLorebook();
                lore.markets = marketEntries(got?.entries);
                lore.character = String(got?.character ?? '');
                lore.problem = String(got?.problem ?? '');
            } catch (error) {
                lore.markets = [];
                lore.problem = `The lorebook could not be read: ${error?.message ?? error}`;
            } finally {
                reading = null;
            }
            return lore.markets.length;
        })();
        return reading;
    };
    /** What sets a place's prices: { types, tags, places } (see packs.markets above). */
    const markets = () => marketsOf(packs.packs(), lore.markets);

    const part = {
        domains: {},
        commands: {},
        queries: {
            'packs.list': () => packs.list(),
            'packs.content': (_state, { kind, pack = null } = {}) => contentOf(packs.packs(), kind, { pack }),
            'packs.item': (_state, { name } = {}) => resolveItem(name),
            // The enabled packs' items as inventory defs by definition ID, ID-sorted (content.js itemDefsIn): what a
            // rules module freezes with inventory.registerDefinition. `ids` narrows to those IDs.
            'packs.itemDefs': (_state, args) => itemDefsIn(packs.packs(), args && typeof args === 'object' && Array.isArray(args.ids) ? args.ids : null),
            'packs.start': () => startState(),
            'packs.calendar': () => calendarOf(packs.packs()),
            'packs.weather': () => weatherOf(packs.packs()),
            // The Rank the first enabled pack that declares one gives {{user}}'s look, `{ pack, label }`, or null (no Rank in this story).
            'packs.youRank': () => youRankOf(packs.packs()),
            'packs.crafts': () => craftsOf(packs.packs()),
            'packs.economy': () => economy(),
            'packs.markets': () => markets(),
            // The URL of a cast portrait (see above): a file name the installed pack names and has a stored picture for, else null.
            'packs.portrait': (_state, { pack, file } = {}) => portraits.url(pack, file),
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
            render: (el, api) => renderPacksPanel(el, { packs, readLorebook, notify: text => api?.notify?.(text), lore: { read: refreshLore, count: () => lore.markets.length } }),
        },
        tabs: [],
    };
    return { part, packs, portraits, resolveItem, startState, economy, refreshLore, markets };
}

const copy = value => JSON.parse(JSON.stringify(value));

/**
 * `packs.markets`' answer from the enabled packs (in list order) and the lorebook's market places
 * (lorebook.js marketEntries): `{ types: [{ type, buy?, sell?, stock?, note?, pack }], tags: [{ tag,
 * prices, note?, pack }], places: [{ place, aliases, type, tags, buy?, sell?, from, pack? }] }`. A type
 * or tag two packs define is the earlier pack's; a place the lorebook names comes before the packs' own.
 */
export function marketsOf(list, lorePlaces = []) {
    const types = [];
    const tags = [];
    const places = [];
    const known = place => places.some(other => [other.place, ...other.aliases].some(name => name.toLowerCase() === place.toLowerCase()));
    for (const entry of Array.isArray(lorePlaces) ? lorePlaces : []) {
        if (!entry?.place || known(entry.place)) continue;
        places.push({ ...copy(entry), from: 'lorebook' });
    }
    for (const pack of Array.isArray(list) ? list : []) {
        for (const record of pack.content.markets ?? []) {
            if (record.type && !types.some(other => other.type === record.type)) types.push(copy(record));
            if (record.tag && !tags.some(other => other.tag === record.tag)) tags.push(copy(record));
        }
        for (const place of pack.content.places ?? []) {
            if (!place.market && !place.tags?.length) continue;
            if (known(place.name)) continue;
            places.push({ place: place.name, aliases: [...(place.aliases ?? [])], type: place.market ?? null, tags: [...(place.tags ?? [])], from: 'pack', pack: pack.id });
        }
    }
    return { types, tags, places };
}

// The part as Story Block loads it: bound to SillyTavern through st-adapter.js, read lazily.
const live = createPacksPart({
    settings: stSettings(),
    readLorebook: readCharacterLorebook,
    capabilities: stCapabilities,
    hostVersion: () => stHostVersion() ?? HOST_VERSION,
    portraitFiles: stPortraitFiles(),
    // The browser's own decoder and encoder, where there is one (not in Node, where a large portrait is refused as it always was).
    portraitIo: typeof globalThis.createImageBitmap === 'function' ? browserImageIo(globalThis) : null,
});

export const part = live.part;
export const packs = live.packs;
export const portraits = live.portraits;
export const resolveItem = live.resolveItem;
export const startState = live.startState;
export const economy = live.economy;
export const refreshLore = live.refreshLore;
