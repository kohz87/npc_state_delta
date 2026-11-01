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

// Shared authoring bounds for host records, also used by pack editors.
export const RECORD_LIMITS = Object.freeze({ slug: 64, note: 500, word: 40, element: 24 });

// Content kinds a pack may carry. Each is a list of records.
export const CONTENT_KINDS = Object.freeze(['items', 'creatures', 'shops', 'recipes', 'events', 'quests', 'races', 'talents', 'skills', 'presets', 'places', 'routes', 'terms', 'ranks', 'crafts', 'meterPresets', 'markets', 'dataModules', 'rpg', 'cast']);
// Kinds added after the first pack format: a normalized pack has them only when the file gives
// them, so what older packs list (counts) stays as it was.
export const OPTIONAL_KINDS = Object.freeze(['skills', 'presets', 'places', 'routes', 'terms', 'ranks', 'crafts', 'meterPresets', 'markets', 'dataModules', 'rpg', 'cast']);
// `content.you` (Your look, MODULES §F126): an object, not a list. A pack opts in to a Rank for {{user}} with
// `content.you.rank: { "label": "Guild rank" }` (the label is what Home and the Status card call it, 1 to 30 characters).
export const YOU_FIELDS = Object.freeze(['rank']);
export const YOU_RANK_FIELDS = Object.freeze(['label']);
export const YOU_RANK_LABEL_MAX = 30;
// Capabilities provided by the host in addition to installed modules.
export const HOST_CAPABILITIES = Object.freeze(['data-modules-v1']);

// Top-level fields of pack.json; anything else is refused so a typo is not silently ignored.
export const PACK_FIELDS = Object.freeze(['id', 'version', 'name', 'author', 'description', 'requires', 'currency', 'economy', 'calendar', 'weather', 'content', 'start', 'layouts', 'screens', 'theme']);
// A pack's money scale (MODULES §F104): `{ scale?: 0.001–1000 (default 1), note? }`. `scale` multiplies the
// built-in money defaults (a module's default loot and prices) when
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
// A skill template: numbers are supplied by the consuming module.
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
// being `true` or `{ size?, numerals?, enabled? }`. A term is a label in a module's blocks
// (`Soul Class: III (Lv 24)`), so it may not hold what separates fields there.
export const TERMS_FIELDS = Object.freeze(['id', 'name', 'levelName', 'xpName', 'tiers']);
export const TERMS_TIER_FIELDS = Object.freeze(['size', 'numerals', 'enabled']);
export const TERMS_NUMERALS = Object.freeze(['roman', 'arabic']);
export const TERMS_LIMITS = Object.freeze({ records: 4, term: 30, tierSize: 999 });
export const TERM_SEPARATORS = /[|:#<>\r\n]/;
// A ladder of ranks, lowest first: `{ id: 'F', title?, levels?: [lo, hi], reward?: [lo, hi], xp?: [lo, hi] }`, the
// reward in whole units of the chat's one currency and `xp` the experience a job of the rank may give (whole XP, 0 to
// RANKS_LIMITS.xp). Without `xp`, an open quest template's XP is held to `reward` as before (2.5.0 added `xp`).
export const RANK_FIELDS = Object.freeze(['id', 'title', 'levels', 'reward', 'xp']);
export const RANK_ID = /^[\p{L}\p{N}+-]{1,8}$/u;
export const RANKS_LIMITS = Object.freeze({ records: 12, title: 30, level: 999, xp: 1000000 });
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
// it from the start (`known`) and who teaches it. A crafting module may read them; code sets every
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
// Skill sets for the RPG's New character wizard, `content.rpg.skillSets` (normalized to a list of sets):
// `[{ name, slug?, about?, skills: [{ name, about, stat, uses? }] }]`. The limits follow the Skills block's fields; `stats` and `uses`
// are the words the block's `statN` and `usesN` take (src/v2/lean-rpg/names.js STATS and USES, kept apart so packs need nothing of it).
export const LEAN_RPG_FIELDS = Object.freeze(['skillSets', 'formula', 'numbers']);
// A pack may also say which stat formula its story plays on and the numbers of it (`content.rpg.formula`: 'standard' | 'classic'; `content.rpg.numbers`:
// whole numbers by name, the names of src/v2/lean-rpg/rules.js STANDARD_RULE_KEYS and RULE_KEYS, kept apart so packs need nothing of it). They are
// kept as one more record of the list, `{ id, slug: 'formula', pack, formula?, numbers? }`, which the skill-set readers pass over.
export const RPG_FORMULAS = Object.freeze(['standard', 'classic']);
export const RPG_NUMBER_KEYS = Object.freeze(['foeBase', 'foeClassWeight', 'classWeight', 'statDivisor', 'costMargin', 'decisiveMargin', 'roundCap', 'quickStartMargin',
    'startStat', 'createPoints', 'createMin', 'createMax', 'pointsPerSoul', 'statMax']);
export const SKILL_SET_FIELDS = Object.freeze(['name', 'slug', 'about', 'skills']);
export const SKILL_SET_SKILL_FIELDS = Object.freeze(['name', 'about', 'stat', 'uses']);
export const LEAN_RPG_LIMITS = Object.freeze({ sets: 12, skills: 5, name: 40, about: 160, skillName: 40, skillAbout: 120,
    stats: Object.freeze(['str', 'vit', 'agi', 'dex', 'int', 'luk', 'cha']), uses: Object.freeze(['stamina', 'mana']) });
// The cast (`content.cast`): a hand-written list of people who live off-screen until the party meets them (Story Director)
// and get a prepared dossier at the first meeting (NPC State Delta). One entry:
// `{ id, name, aliases?, about, look, voice?, personality?, history?, portrait?, start: { place, goal, routine? }, drawnTo?,
// meters?: { preset?, <meter>: n }, stages?, fields?, secrets?, canDieUnmet? }`. All text is plain: no < > { } (and no | in
// the short lines a change line may carry), line breaks become spaces. `stages` take the shape of a meter preset's stages.
export const CAST_FIELDS = Object.freeze(['id', 'name', 'aliases', 'about', 'look', 'voice', 'personality', 'history', 'portrait', 'start', 'drawnTo', 'meters', 'stages', 'fields', 'secrets', 'canDieUnmet']);
export const CAST_START_FIELDS = Object.freeze(['place', 'goal', 'routine']);
export const CAST_SECRET_FIELDS = Object.freeze(['title', 'text', 'meter', 'at', 'when']);
export const CAST_LIMITS = Object.freeze({ entries: 64, name: 80, aliases: 8, about: 300, look: 600, voice: 300, personality: 600, history: 1200,
    place: 80, goal: 200, routine: 200, drawnTo: 6, phrase: 80, fields: 6, fieldName: 40, fieldValue: 60, secrets: 8, secretTitle: 60, secretText: 300, secretWhen: 120, meters: 10 });
// The meters NPC State Delta has before any preset (a secret or a stage may name them without the entry listing them): its four
// own and the ones its built-in presets (companion, rival, mentor) add.
export const CAST_BUILT_IN_METERS = Object.freeze(['trust', 'affection', 'desire', 'tension', 'loyalty', 'respect', 'rivalry', 'approval']);
// Portraits: image files beside pack.json, named by an entry's `portrait`, imported with the pack (portraits.js).
export const PORTRAIT_LIMITS = Object.freeze({ bytes: 64 * 1024, perPack: 32, name: 64 });
// A pack zip (Story Studio's export: pack.json and a portraits/ folder, zip.js and bundle.js): the archive itself, everything in it
// unpacked, and the entries (folders count) it may hold.
export const ZIP_LIMITS = Object.freeze({ archive: 5 * 1024 * 1024, unpacked: 4 * 1024 * 1024, entries: 40 });
export const PORTRAIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,58}\.(?:webp|png|jpe?g)$/i;

// Words NPC State Delta keeps for itself (a stage line, a reason): never a meter id.
export const METER_RESERVED = Object.freeze(['stage', 'stages', 'disposition', 'name', 'meter', 'meters', 'reason', 'why', 'because', 'note', 'cause']);
// A calendar for the story clock: { era, months: [{ name, days }], start: { year, month, day, hour, minute },
// holidays: [{ name, month, day }] } (holidays: named days that come back every year, at most 60).
export const CALENDAR_FIELDS = Object.freeze(['era', 'months', 'start', 'holidays']);
export const CALENDAR_HOLIDAY_FIELDS = Object.freeze(['name', 'month', 'day']);
export const CALENDAR_START_FIELDS = Object.freeze(['year', 'month', 'day', 'hour', 'minute']);
export const CALENDAR_LIMITS = Object.freeze({ era: 24, months: 60, monthName: 40, days: 400, holidays: 60, holidayName: 60 });
// A pack's weather table (MODULES §F122), read by a module that sets the weather by rule (Story Director):
// `{ seasons?: [{ name, months }], tables: [{ season?, region?, weather: [text] }] }`.
export const WEATHER_FIELDS = Object.freeze(['seasons', 'tables']);
export const WEATHER_SEASON_FIELDS = Object.freeze(['name', 'months']);
export const WEATHER_TABLE_FIELDS = Object.freeze(['season', 'region', 'weather']);
export const WEATHER_LIMITS = Object.freeze({ seasons: 12, months: 60, season: 24, region: 80, tables: 120, kinds: 24, text: 60 });
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
// A screen id: a module's (`example-module/party`) to override, or the pack's own.
export const SCREEN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
