// What a pack is for, in words (the settings' Packs list tags each row with it): "World pack · Story Director", "Rules pack · RPG Battle",
// "Story Block pack", or "Pack" when the pack says neither. Read from the pack's own fields only (docs/v2/PACKS.md):
//
// * `requires.capabilities` names what it needs: a module id ("story-director", "rpg-battle") or a state area a module owns ("director",
//   "party", "combat"); "inventory" and "scene" are Story Block's own. That is the pack's declaration, so it decides first.
// * Without a declared module, what it holds decides: places, routes, markets, a calendar or weather are a World pack's (Story Director
//   reads them); races, talents, skills, presets, crafts, terms and meter presets are a Rules pack's (RPG Battle reads them). Creatures,
//   quests and ranks are read by both modules, so they say nothing here.
// * A rules manifest (`content.rules`, the rules pack format) makes it a Rules pack whatever else it declares: the manifest is RPG Battle's
//   alone, and such a pack lists Story Director too only because its quests and places are Story Director's. The capability
//   `rb-rules-v2` alone says nothing here (it is the host's, not a module's): only a manifest makes it a Rules pack.
// * A pack that declares several modules, or holds both World and Rules content, is not classified: "Pack".
//
// The tag is plain text; the panel writes it with textContent.

const AREA_KIND = Object.freeze({
    'story-block': 'core', inventory: 'core', scene: 'core',
    'story-director': 'world', director: 'world',
    'rpg-battle': 'rules', party: 'rules', combat: 'rules',
});
const WORLD_CONTENT = Object.freeze(['places', 'routes', 'markets']);
const SHARED = Object.freeze(['creatures', 'quests', 'ranks']);
const RULES_CONTENT = Object.freeze(['races', 'talents', 'skills', 'presets', 'crafts', 'terms', 'meterPresets', 'rules']);
const LABEL = Object.freeze({
    world: 'World pack · Story Director',
    rules: 'Rules pack · RPG Battle',
    core: 'Story Block pack',
    unknown: 'Pack',
});

const listOf = (content, kind) => (Array.isArray(content?.[kind]) ? content[kind] : []);

/** The tag for a pack (a validated pack object, or null for one that is not usable): "World pack · Story Director" and the rest. */
export function packTag(pack) {
    if (!pack || typeof pack !== 'object') return LABEL.unknown;
    if (listOf(pack.content, 'rules').length) return LABEL.rules;
    const declared = new Set((Array.isArray(pack.requires?.capabilities) ? pack.requires.capabilities : []).map(name => AREA_KIND[name]).filter(Boolean));
    const modules = [...declared].filter(kind => kind !== 'core');
    if (modules.length > 1) return LABEL.unknown;
    if (modules.length === 1) return LABEL[modules[0]];
    if (declared.has('core')) return LABEL.core;
    const content = pack.content ?? {};
    const world = Boolean(pack.calendar || pack.weather || WORLD_CONTENT.some(kind => listOf(content, kind).length));
    const rules = RULES_CONTENT.some(kind => listOf(content, kind).length);
    if (world && rules) return LABEL.unknown;
    if (world) return LABEL.world;
    if (rules) return LABEL.rules;
    const core = Object.entries(content).some(([kind, list]) => !SHARED.includes(kind) && Array.isArray(list) && list.length > 0) || Boolean(pack.start || pack.currency || pack.economy || Object.keys(pack.theme ?? {}).length > 0);
    // (a validated pack has `theme: {}` and nulls for what it does not hold: only what is there counts)
    return core ? LABEL.core : LABEL.unknown;
}
