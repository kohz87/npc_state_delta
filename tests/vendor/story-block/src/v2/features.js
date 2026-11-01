// Features (MODULES §F100, SPEC §6): the optional mechanics a reader switches on and off, each in the
// Features subsection of its module's settings and on one overview of every module's features.
//
// A module declares them, `registerModule({ features: [{ id, label, describe, default, prompt? }] })`,
// ids namespaced by the module (`example-module.wear`), and marks what each one owns with
// `feature: '<id>'`: a capture kind, a command (`{ handler, feature }`, or a handler function with a
// `feature` property), a query or a hook (a function with a `feature` property, so an older host that
// only takes functions there still takes it), the module's context or one of its `context.parts`, a
// screen, a tab, a widget, a settings field (`{ type, …, feature }`) or the custom settings panel (a
// function with a `feature` property). Off means fully off (registry.js does the leaving out): no
// grammar, no context lines, commands refused with FEATURE_OFF, queries answer null, hooks skipped,
// screens, tabs, widgets, dialogs and settings fields hidden (their stored values kept). The state is never touched, so turning it back on brings everything back.
//
// The choice is the reader's, not the chat's: `extension_settings.storySuite.features[<id>] = true |
// false`; a feature with no choice stored takes its `default` (on when it gives none). Pure: no DOM,
// no SillyTavern.

export const FEATURE_OFF = 'FEATURE_OFF';
// The fields a feature entry has; any other is a newer module's, warned and ignored.
export const FEATURE_KEYS = Object.freeze(['id', 'label', 'describe', 'default', 'prompt', 'needs', 'presets']);
// "How much to track" (Settings → Features): a feature entry may carry `presets: { lean?: boolean, full?: boolean }`.
// Standard is the feature's own `default`; a preset key it leaves out is its `default` too; `presets: false` keeps the
// feature out of presets (a preset never changes it). A module with no `presets` follows `default` in all three.
export const PRESET_NAMES = Object.freeze(['lean', 'standard', 'full']);
export const PRESET_KEYS = Object.freeze(['lean', 'full']);
// `needs`: what another module must register for the feature to work at all.
export const NEEDS_KEYS = Object.freeze(['kinds', 'commands', 'queries', 'why']);
export const WHY_MAX = 120;
// The overlay's reason for an unavailable feature that gives none.
export const NEEDS_HINT = 'Needs a module that is not installed.';
// The overlay's hint on a feature that changes the static prompt part (SPEC §5).
export const PROMPT_HINT = 'Changes the fixed prompt once (one slower reply).';
// The part of an id after `<module-id>.`.
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const LABEL_MAX = 60;
export const DESCRIBE_MAX = 240;

// Story Block's own features (src/v2/domains/index.js declares them).
export const CORE_FEATURE = Object.freeze({
    hud: 'story-block.hud',
    cards: 'story-block.cards',
    preroll: 'story-block.preroll',
    extractor: 'story-block.extractor',
    inspector: 'story-block.inspector',
    savepoints: 'story-block.savepoints',
    // Display-only lines a reply may carry for the reader (src/v2/extras.js, MODULES §F115).
    choices: 'story-block.choices',
    chatter: 'story-block.chatter',
    // The scene's weather line (`~ weather`, src/v2/domains/scene.js, MODULES §F120).
    weather: 'story-block.weather',
    // What {{user}} wears and how they are (`~ you`, src/v2/domains/scene.js, MODULES §F126).
    you: 'story-block.you',
    // The party's mounts (`+ mount`, src/v2/domains/mounts.js): the pace they travel at.
    mounts: 'story-block.mounts',
    // The RPG (src/v2/lean-rpg/, SPEC_RPG.md): automatic rolls, the Party tab, the battle log.
    leanRpg: 'story-block.rpg',
});

// Where Story Block kept these switches before they were features: a reader who set one keeps that
// choice until they touch the feature itself. `storySuite` → true | false | undefined.
export const CORE_LEGACY = Object.freeze({
    [CORE_FEATURE.hud]: suite => (suite?.hud === false ? false : undefined),
    [CORE_FEATURE.preroll]: suite => (typeof suite?.modules?.['story-block']?.assistClassifier === 'boolean' ? suite.modules['story-block'].assistClassifier : undefined),
    [CORE_FEATURE.extractor]: suite => (typeof suite?.modules?.['story-block']?.assistExtractor === 'boolean' ? suite.modules['story-block'].assistExtractor : undefined),
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The feature an item names (`item.feature`, on an object or a function), or null. */
export const featureOf = item => (item && (typeof item === 'object' || typeof item === 'function') && typeof item.feature === 'string' ? item.feature : null);

/**
 * Every `feature:` a definition names: [{ where, feature }] (where: a plain description of the item).
 * A `feature` that is there but not text is listed with feature = that value, for definitionProblems.
 */
export function featureRefs(def) {
    if (!isObject(def)) return [];
    const out = [];
    const add = (item, where) => {
        if (!item || (typeof item !== 'object' && typeof item !== 'function') || !Object.hasOwn(item, 'feature')) return;
        out.push({ where, feature: item.feature });
    };
    for (const [kind, spec] of Object.entries(isObject(def.capture?.kinds) ? def.capture.kinds : {})) add(spec, `the capture kind "${kind}"`);
    for (const [type, handler] of Object.entries(isObject(def.commands) ? def.commands : {})) add(handler, `the command "${type}"`);
    for (const [name, query] of Object.entries(isObject(def.queries) ? def.queries : {})) add(query, `the query "${name}"`);
    for (const [name, hook] of Object.entries(isObject(def.hooks) ? def.hooks : {})) add(hook, `the hook "${name}"`);
    if (isObject(def.context)) {
        add(def.context, 'the context');
        (Array.isArray(def.context.parts) ? def.context.parts : []).forEach((part, index) => add(part, `context part ${index + 1}`));
    }
    (Array.isArray(def.screens) ? def.screens : []).forEach((screen, index) => add(screen, `the screen "${screen?.id ?? index + 1}"`));
    (Array.isArray(def.tabs) ? def.tabs : []).forEach((tab, index) => add(tab, `the tab "${tab?.id ?? index + 1}"`));
    for (const [name, widget] of Object.entries(isObject(def.widgets) ? def.widgets : {})) add(widget, `the widget "${name}"`);
    // Settings: a schema field ({ type, …, feature }), and the custom panel (a function with `feature`).
    if (isObject(def.settings)) {
        for (const [key, field] of Object.entries(isObject(def.settings.schema) ? def.settings.schema : {})) if (isObject(field)) add(field, `the settings field "${key}"`);
        if (typeof def.settings.section === 'function') add(def.settings.section, 'the settings section');
        if (typeof def.settings.render === 'function') add(def.settings.render, 'the settings section');
    }
    return out;
}

/** What is wrong with a definition's `features` list and the `feature:` it names: plain sentence parts. */
export function featureProblems(def) {
    if (!isObject(def)) return [];
    const problems = [];
    const ids = new Set();
    if (def.features !== undefined) {
        if (!Array.isArray(def.features)) problems.push('features is not a list (like [{ id: "my-module.wear", label: "Wear", default: false }])');
        else def.features.forEach((feature, index) => {
            const where = `feature ${index + 1}`;
            if (!isObject(feature)) { problems.push(`${where} is not an object`); return; }
            const id = feature.id;
            const prefix = `${def.id}.`;
            if (typeof id !== 'string' || !id.startsWith(prefix) || !NAME.test(id.slice(prefix.length))) {
                problems.push(`${where} needs an id made of the module id, a dot and a lowercase name (like "${def.id}.wear")`);
            } else if (ids.has(id)) problems.push(`the feature "${id}" is named twice`);
            else ids.add(id);
            const name = typeof id === 'string' ? `the feature "${id}"` : where;
            if (typeof feature.label !== 'string' || !feature.label.trim()) problems.push(`${name} has no label`);
            else if (feature.label.length > LABEL_MAX) problems.push(`${name} has a label longer than ${LABEL_MAX} characters`);
            if (feature.describe !== undefined && typeof feature.describe !== 'string') problems.push(`${name} describe is not text`);
            else if (typeof feature.describe === 'string' && feature.describe.length > DESCRIBE_MAX) problems.push(`${name} describe is longer than ${DESCRIBE_MAX} characters`);
            if (feature.default !== undefined && typeof feature.default !== 'boolean') problems.push(`${name} default is not true or false`);
            if (feature.prompt !== undefined && typeof feature.prompt !== 'boolean') problems.push(`${name} prompt is not true or false`);
            if (feature.presets !== undefined && feature.presets !== false) {
                const presets = feature.presets;
                if (!isObject(presets)) problems.push(`${name} presets is not false or an object (like { lean: false, full: true })`);
                else for (const key of PRESET_KEYS) if (presets[key] !== undefined && typeof presets[key] !== 'boolean') problems.push(`${name} presets.${key} is not true or false`);
            }
            if (feature.needs !== undefined) {
                const needs = feature.needs;
                const names = list => Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim());
                if (!isObject(needs)) problems.push(`${name} needs is not an object (like { kinds: ["check"], why: "…" })`);
                else {
                    for (const key of ['kinds', 'commands', 'queries']) if (needs[key] !== undefined && !names(needs[key])) problems.push(`${name} needs.${key} is not a list of names`);
                    if (needs.why !== undefined && (typeof needs.why !== 'string' || needs.why.length > WHY_MAX)) problems.push(`${name} needs.why is not text of at most ${WHY_MAX} characters`);
                }
            }
        });
    }
    for (const { where, feature } of featureRefs(def)) {
        if (typeof feature !== 'string') problems.push(`${where} has a feature that is not text`);
        else if (!ids.has(feature)) problems.push(`${where} names the feature "${feature}", which is not one of this module's features`);
    }
    return problems;
}

/** A newer module's fields on a feature entry: plain sentences (logged, ignored). */
export function featureWarnings(def) {
    if (!isObject(def) || !Array.isArray(def.features)) return [];
    return def.features.filter(isObject).flatMap(feature => [
        ...Object.keys(feature).filter(key => !FEATURE_KEYS.includes(key))
            .map(key => `"${key}" on feature "${feature.id}" is not a feature field this Story Block knows; it is ignored`),
        ...(isObject(feature.needs) ? Object.keys(feature.needs) : []).filter(key => !NEEDS_KEYS.includes(key))
            .map(key => `"needs.${key}" on feature "${feature.id}" is not a needs field this Story Block knows; it is ignored`),
        ...(isObject(feature.presets) ? Object.keys(feature.presets) : []).filter(key => !PRESET_KEYS.includes(key))
            .map(key => `"presets.${key}" on feature "${feature.id}" is not a preset this Story Block knows; it is ignored`),
    ]);
}

/**
 * A feature's `presets` as the registry keeps it: false (outside presets) or { lean?, full? } with only the booleans.
 * Anything else (a newer module's shape) is read as no keys: the feature follows its default.
 */
export function presetsOf(feature) {
    if (feature?.presets === false) return false;
    const given = isObject(feature?.presets) ? feature.presets : {};
    return Object.freeze(Object.fromEntries(PRESET_KEYS.filter(key => typeof given[key] === 'boolean').map(key => [key, given[key]])));
}

/**
 * Does this feature change the static prompt part? When it says so (`prompt: true`), or when it owns a
 * capture kind (its grammar line) or static text (the context's, or a context part's).
 */
export function affectsStatic(def, id) {
    const declared = (Array.isArray(def?.features) ? def.features : []).find(feature => feature?.id === id);
    if (declared?.prompt === true) return true;
    if (Object.values(isObject(def?.capture?.kinds) ? def.capture.kinds : {}).some(spec => featureOf(spec) === id)) return true;
    const parts = Array.isArray(def?.context?.parts) ? def.context.parts : [];
    // C3-1: a feature that owns the whole context turns all of it off, its parts' static text too.
    if (featureOf(def?.context) === id && (typeof def.context.static === 'function' || parts.some(part => typeof part?.static === 'function'))) return true;
    return parts.some(part => featureOf(part) === id && typeof part?.static === 'function');
}

// ---- "How much to track": the presets, derived from the switches, never stored -------------------------

/** Is this feature (a `list()` row or a declaration) part of the presets? Only `presets: false` leaves it out. */
export const inPresets = feature => feature?.presets !== false;

/**
 * What preset `name` says for a feature: true or false, or null for a feature outside presets. Standard is the feature's
 * `default`; lean and full are the feature's own key, else its `default`.
 */
export function presetValue(feature, name) {
    if (!inPresets(feature)) return null;
    const fallback = feature?.default !== false;
    if (name === 'standard') return fallback;
    const own = isObject(feature?.presets) ? feature.presets[name] : undefined;
    return typeof own === 'boolean' ? own : fallback;
}

// The features a preset speaks for: in presets and available. An unavailable feature (a module it needs is missing, or its
// module is held back) cannot be switched, so a preset neither sets nor compares it.
const members = list => (Array.isArray(list) ? list : []).filter(feature => isObject(feature) && inPresets(feature) && feature.available !== false);

/** What preset `name` sets: a Map of feature id → true | false for every feature it speaks for. */
export function presetSwitches(list, name) {
    return new Map(members(list).map(feature => [feature.id, presetValue(feature, name)]));
}

/**
 * The preset the switches match now: 'lean', 'standard' or 'full' when every feature a preset speaks for is in the state it
 * says (Standard first when more than one matches), else null (Custom). Derived on every read; nothing is stored. `list`: the
 * feature store's `list()`.
 */
export function selectedPreset(list) {
    const own = members(list);
    if (!own.length) return null;
    return PRESET_NAMES.find(name => own.every(feature => (feature.on === true) === presetValue(feature, name))) ?? null;
}

/**
 * Picks preset `name`: every feature it speaks for that is not in the state it says is set through `store.set` (the
 * ordinary setter: each change is told as any switch is, and stored choices of other features are left alone). A feature
 * already in the state it says is not written. → { name, changed: [id], prompt: boolean } (`prompt`: some changed feature
 * changes the fixed prompt, so the reader is told once about the one slower reply), or null for a name that is not a preset.
 */
export function applyPreset(store, name) {
    if (!PRESET_NAMES.includes(name) || typeof store?.list !== 'function' || typeof store?.set !== 'function') return null;
    const changed = [];
    let prompt = false;
    for (const feature of members(store.list())) {
        const want = presetValue(feature, name);
        if ((feature.on === true) === want) continue;
        if (store.set(feature.id, want) === undefined) continue;
        changed.push(feature.id);
        if (feature.prompt === true) prompt = true;
    }
    return { name, changed, prompt };
}

/**
 * The reader's feature choices under `root().storySuite.features` (`root`: () => extension_settings).
 * `registry` (createRegistry) knows the declared features; `legacy` ({ [id]: storySuite → bool |
 * undefined }) reads an older switch for a feature with no choice yet; `onChange({ id, on, prompt })`
 * runs after each change; `save` is saveSettingsDebounced.
 * → { stored(id) → bool | undefined, on(id), set(id, on) → bool | undefined, list() }.
 * A choice stored for an id no module declares (a module not installed now) is kept as it is.
 */
export function createFeatureStore({ root, registry, save = () => {}, legacy = CORE_LEGACY, onChange = null }) {
    const suite = () => {
        const es = root?.();
        if (!isObject(es)) return null;
        if (!isObject(es.storySuite)) es.storySuite = {};
        return es.storySuite;
    };
    const choices = () => {
        const all = suite();
        if (!all) return {};
        if (!isObject(all.features)) all.features = {};
        return all.features;
    };
    function stored(id) {
        const value = choices()[id];
        if (typeof value === 'boolean') return value;
        const old = typeof legacy?.[id] === 'function' ? legacy[id](suite()) : undefined;
        return typeof old === 'boolean' ? old : undefined;
    }
    function tell(id) {
        const on = registry.featureOn(id);
        try { onChange?.({ id, on, prompt: registry.feature(id)?.prompt === true }); } catch (error) { console.warn('[Story Suite] a feature listener failed', error); }
        return on;
    }
    const api = {
        stored,
        on: id => registry.featureOn(id),
        /**
         * Stores the reader's choice; undefined (nothing stored) for an id no module declares. A choice that is the feature's own
         * default is not kept (the stored choice is cleared), so a later change of the default still reaches the reader; the exception
         * is a feature an older setting still speaks for (`legacy`), which keeps the explicit value.
         */
        set(id, on) {
            const decl = registry.feature(id);
            if (!decl) return undefined;
            const before = registry.featureOn(id);
            const old = typeof legacy?.[id] === 'function' ? legacy[id](suite()) : undefined;
            if (Boolean(on) === (decl.default !== false) && typeof old !== 'boolean') delete choices()[id];
            else choices()[id] = Boolean(on);
            save();
            // Told only when it is on or off now as it was not before: a feature of a module held back stays off.
            if (before !== Boolean(on) && before !== registry.featureOn(id)) tell(id);
            return Boolean(on);
        },
        /** Picks a preset ("How much to track"): see applyPreset. */
        applyPreset: name => applyPreset(api, name),
        /** Every declared feature with its state: [{ id, moduleId, moduleName, label, describe, default, prompt, presets, needs, available, why, on }]. */
        list: () => registry.features().map(feature => ({ ...feature, on: registry.featureOn(feature.id) })),
    };
    return api;
}

/**
 * The feature store as the Settings window sees it: `list()` leaves out the features `hidden(feature)` says to hide. Nothing is
 * changed: a hidden feature keeps its stored choice and its effect, and `on`, `set` and `stored` are the store's own.
 */
export function withHiddenFeatures(store, hidden) {
    if (!store || typeof store.list !== 'function' || typeof hidden !== 'function') return store ?? null;
    return Object.freeze({
        ...store,
        list: () => store.list().filter(feature => { try { return !hidden(feature); } catch { return false; } }),
    });
}
