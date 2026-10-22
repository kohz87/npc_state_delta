// Size limits and fixed word lists for packs (SPEC §9). One place, so the docs, the
// validator and the tests agree. Limits are generous for hand-made packs and small enough
// that a pack kept in settings.json (saved on every settings change) stays cheap.

export const LIMITS = Object.freeze({
    packBytes: 512 * 1024,          // one pack.json, as UTF-8
    installedBytes: 2 * 1024 * 1024, // every installed pack together
    installed: 32,                   // packs in the installed list
    depth: 16,                       // nesting of objects and arrays
    keys: 200,                       // keys in one object
    array: 1000,                     // entries in one array (records of one kind included)
    string: 4000,                    // characters in one string
    code: 64 * 1024,                 // characters in a screen's `template` or `css` (SPEC §13.3)
    name: 80,                        // a display name
    errors: 20,                      // problems reported for one pack before giving up
});

// Content kinds a pack may carry (SPEC §9). Each is a list of records.
// races and talents are choices for the character creation wizard (MODULES §F12); skills are
// RPG Battle skill templates and presets ready-made characters for that wizard; places and
// routes are the map Story Director's atlas reads; terms are the words a world uses for levels and XP
// (MODULES §F25), which RPG Battle reads under the reader's own; ranks are a ladder of quest ranks
// (Story Director's `quest.ranks`, RPG Battle's foe strength); crafts change which stats a craft rolls
// with (MODULES §F102); meterPresets are ready-made NPC meter sets for NPC State Delta (MODULES §F81, §F90);
// markets are the price factors of settlement types and environment tags RPG Battle's trade reads (PACKS.md
// "Markets").
export const CONTENT_KINDS = Object.freeze(['items', 'creatures', 'shops', 'recipes', 'events', 'quests', 'races', 'talents', 'skills', 'presets', 'places', 'routes', 'terms', 'ranks', 'crafts', 'meterPresets', 'markets']);
// Kinds added after the first pack format: a normalized pack has them only when the file gives
// them, so what older packs list (counts) stays as it was.
export const OPTIONAL_KINDS = Object.freeze(['skills', 'presets', 'places', 'routes', 'terms', 'ranks', 'crafts', 'meterPresets', 'markets']);

// Top-level fields of pack.json; anything else is refused so a typo is not silently ignored.
export const PACK_FIELDS = Object.freeze(['id', 'version', 'name', 'author', 'description', 'requires', 'currency', 'economy', 'calendar', 'content', 'start', 'layouts', 'screens', 'theme']);
// A pack's money scale (MODULES §F104): `{ scale?: 0.001–1000 (default 1), note? }`. `scale` multiplies the
// built-in money defaults (Story Block's coin budget by level, a module's default loot and prices) when
// this pack's currency is in use; numbers the pack writes itself (ranks, item values, prices) stay as written.
export const ECONOMY_FIELDS = Object.freeze(['scale', 'note']);
export const ECONOMY_LIMITS = Object.freeze({ min: 0.001, max: 1000, note: 500 });

// Item definitions follow Story Block's inventory def (SPEC §7).
export const ITEM_KINDS = Object.freeze(['goods', 'material', 'consumable', 'equipment', 'quest', 'money']);
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
export const ITEM_FIELDS = Object.freeze(['name', 'slug', 'aliases', 'kind', 'rarity', 'value', 'stack', 'slot', 'stats', 'effect', 'tags', 'note', 'carry']);
// `carry`: the carry capacity an item adds while it is owned (worn, when it is equipment), a whole number
// (PACKS.md "Carry capacity"). Only a pack (or the reader's settings in a carry module) sets it; the story never does.
export const ITEM_CARRY = Object.freeze({ min: 1, max: 1000 });
export const EVENT_FIELDS = Object.freeze(['id', 'when', 'cue', 'once', 'after', 'then']);
// The events part's own limits (src/v2/events), so a pack that passes here also runs there.
export const EVENT_LIMITS = Object.freeze({ when: 500, cue: 500, then: 8 });
export const CHOICE_FIELDS = Object.freeze(['id', 'name', 'note', 'stats', 'tags']);
// RPG Battle's skill template (v1 skillFromTemplate): the numbers come from its rules.
export const SKILL_FIELDS = Object.freeze(['name', 'slug', 'type', 'stat', 'target', 'element', 'note', 'tags']);
export const SKILL_TYPES = Object.freeze(['physical', 'magic', 'heal', 'buff', 'debuff']);
export const SKILL_TARGETS = Object.freeze(['one', 'all', 'self', 'ally', 'allies']);
export const PRESET_FIELDS = Object.freeze(['id', 'name', 'note', 'race', 'talents', 'points', 'skills']);
// A stat name as creation and items use it: STR, DEX … (short capital letters).
export const STAT_NAME = /^[A-Z]{2,12}$/;
// Map data for Story Director's atlas (coordinates in map units, distances in km).
// `hidden: true` (or its alias `secret: true`): the map keeps the place off until the story goes there.
// `market` and `tags` (PACKS.md "Markets"): the place's settlement type ('village', 'city') and environment
// tags ('river', 'port') that set its prices.
export const PLACE_FIELDS = Object.freeze(['name', 'slug', 'aliases', 'region', 'kind', 'layer', 'x', 'y', 'note', 'hidden', 'secret', 'market', 'tags']);
export const ROUTE_FIELDS = Object.freeze(['slug', 'from', 'to', 'kind', 'km', 'hours', 'corridor', 'note']);
// Display terms a pack suggests (MODULES §F25): `{ id?, name?, levelName?, xpName?, tiers? }`, `tiers`
// being `true` or `{ size?, numerals?, enabled? }`. A term is a label in RPG Battle's blocks
// (`Soul Class: III (Lv 24)`), so it may not hold what separates fields there.
export const TERMS_FIELDS = Object.freeze(['id', 'name', 'levelName', 'xpName', 'tiers']);
export const TERMS_TIER_FIELDS = Object.freeze(['size', 'numerals', 'enabled']);
export const TERMS_NUMERALS = Object.freeze(['roman', 'arabic']);
export const TERMS_LIMITS = Object.freeze({ records: 4, term: 30, tierSize: 999 });
export const TERM_SEPARATORS = /[|:#<>\r\n]/;
// A ladder of ranks, lowest first: `{ id: 'F', title?, levels?: [lo, hi], reward?: [lo, hi] }`, the
// reward in whole units of the chat's one currency.
export const RANK_FIELDS = Object.freeze(['id', 'title', 'levels', 'reward']);
export const RANK_ID = /^[\p{L}\p{N}+-]{1,8}$/u;
export const RANKS_LIMITS = Object.freeze({ records: 12, title: 30, level: 999 });
// Markets (PACKS.md "Markets"): price factors a pack adds or changes, each record one of
// `{ type: 'town', buy?, sell?, stock?: [least, most], note? }` (a settlement type) or
// `{ tag: 'coastal', prices: { fish: 0.8, all: 1.05 }, note? }` (an environment tag: a factor per item
// category, `all` for every thing). Factors are multipliers (1 = as usual). A place gets its type and tags
// from its `market` and `tags` (places), or a lorebook entry's `market:` line.
export const MARKET_FIELDS = Object.freeze(['type', 'tag', 'buy', 'sell', 'stock', 'prices', 'note']);
export const MARKET_LIMITS = Object.freeze({ records: 60, factorMin: 0.25, factorMax: 4, stock: 20, categories: 20, tags: 8, note: 200 });
// A settlement type, an environment tag or an item category: a lowercase word or two joined by dashes.
export const MARKET_WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/;

// Crafting (MODULES §F102). A recipe may say which craft it is, how hard (`dc`), where it is made
// (`station`), which stats it rolls with (`stat`, overriding the craft's), whether a character knows
// it from the start (`known`) and who teaches it. RPG Battle's craft part reads them; code sets every
// chance. Fields a recipe had before (fee, minutes, any other plain data) are kept as they were.
export const RECIPE_CRAFT_FIELDS = Object.freeze(['craft', 'dc', 'station', 'stat', 'known', 'teaches']);
export const RECIPE_LIMITS = Object.freeze({ dcMin: 5, dcMax: 40, teaches: 120, stats: 3 });
// Two or three stats joined by `+`, or one: `STR+DEX`, `INT`.
export const STAT_SUM = /^[A-Z]{2,12}(?:\+[A-Z]{2,12}){0,2}$/;
// The stations Story Suite names; a pack may name any other slug (`salt-yard`).
export const STATIONS = Object.freeze(['forge', 'alchemy-table', 'campfire', 'inn', 'workbench']);
// The default crafts: the stats a check rolls with and the stations it can be worked at (none
// listed: anywhere). A pack's `crafts` record with the same id replaces one; a new id adds a craft.
export const DEFAULT_CRAFTS = Object.freeze([
    Object.freeze({ craft: 'smithing', title: 'Smithing', stats: Object.freeze(['STR', 'DEX']), stations: Object.freeze(['forge']) }),
    Object.freeze({ craft: 'alchemy', title: 'Alchemy', stats: Object.freeze(['INT']), stations: Object.freeze(['alchemy-table']) }),
    Object.freeze({ craft: 'leather', title: 'Leatherwork', stats: Object.freeze(['DEX']), stations: Object.freeze(['workbench', 'campfire', 'inn']) }),
    Object.freeze({ craft: 'cooking', title: 'Cooking', stats: Object.freeze(['VIT']), stations: Object.freeze(['campfire', 'inn']) }),
    Object.freeze({ craft: 'enchanting', title: 'Enchanting', stats: Object.freeze(['INT', 'LUK']), stations: Object.freeze(['workbench', 'alchemy-table']) }),
]);
// A pack's craft: `{ id, title, stats: ['INT', 'DEX'], stations?: ['alchemy-table'], note? }`.
export const CRAFT_FIELDS = Object.freeze(['id', 'title', 'stats', 'stations', 'note']);
export const CRAFTS_LIMITS = Object.freeze({ records: 12, title: 30, stats: 3, stations: 8, note: 200 });
// Ready-made NPC meter sets for NPC State Delta (MODULES §F81, §F90):
// `{ id, title, meters: [{ id, name, min, max, start, describe?, bands?, drift? }], stages?: [{ id, name, needs, milestone? }] }`.
// The limits follow NPC State Delta's own (six custom meters from -1000 to 1000, eight stages, names of 40).
export const METER_PRESET_FIELDS = Object.freeze(['id', 'title', 'meters', 'stages']);
export const METER_FIELDS = Object.freeze(['id', 'name', 'min', 'max', 'start', 'describe', 'bands', 'drift']);
export const METER_STAGE_FIELDS = Object.freeze(['id', 'name', 'needs', 'milestone']);
export const METER_LIMITS = Object.freeze({ presets: 4, meters: 6, min: -1000, max: 1000, id: 40, name: 40, title: 40, describe: 200, bands: 8, word: 24, stages: 8, needs: 4, milestone: 200 });
// Words NPC State Delta keeps for itself (a stage line, a reason): never a meter id.
export const METER_RESERVED = Object.freeze(['stage', 'stages', 'disposition', 'name', 'meter', 'meters', 'reason', 'why', 'because', 'note', 'cause']);
// A calendar for the story clock: { era, months: [{ name, days }], start: { year, month, day, hour, minute },
// holidays: [{ name, month, day }] } (holidays: named days that come back every year, at most 60).
export const CALENDAR_FIELDS = Object.freeze(['era', 'months', 'start', 'holidays']);
export const CALENDAR_HOLIDAY_FIELDS = Object.freeze(['name', 'month', 'day']);
export const CALENDAR_START_FIELDS = Object.freeze(['year', 'month', 'day', 'hour', 'minute']);
export const CALENDAR_LIMITS = Object.freeze({ era: 24, months: 60, monthName: 40, days: 400, holidays: 60, holidayName: 60 });
export const START_FIELDS = Object.freeze(['scene', 'inventory']);
// Screens (SPEC §13.1) a pack adds or overrides by id.
export const SCREEN_FIELDS = Object.freeze(['id', 'title', 'icon', 'mounts', 'template', 'layout', 'css', 'theme', 'data', 'steps']);
export const MOUNTS = Object.freeze(['tab', 'screen', 'card', 'hud', 'dialog']);

// Slugs are lowercase words joined by single dashes, as Story Block's definition IDs need.
export const PACK_ID = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
// A command an event runs: `inventory.grant`, `wallet.receive`, `quest.take` …
export const COMMAND = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][A-Za-z0-9-]{0,39}){1,3}$/;
// A reference to a def outside the pack: `story/rope`, `pack.fantasy/iron-sword`.
export const DEF_ID = /^(?:story|pack\.[a-z0-9]+(?:-[a-z0-9]+)*)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A screen id: a module's (`rpg-battle/party`) to override, or the pack's own.
export const SCREEN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
