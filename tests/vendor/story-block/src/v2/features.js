// Features (MODULES §F100, SPEC §6): the optional mechanics a reader switches on and off, each in the
// Features subsection of its module's settings and on one overview of every module's features.
//
// A module declares them, `registerModule({ features: [{ id, label, describe, default, prompt? }] })`,
// ids namespaced by the module (`rpg-battle.wear`), and marks what each one owns with
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
export const FEATURE_KEYS = Object.freeze(['id', 'label', 'describe', 'default', 'prompt', 'needs']);
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
    ]);
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
    return {
        stored,
        on: id => registry.featureOn(id),
        /** Stores the reader's choice; undefined (nothing stored) for an id no module declares. */
        set(id, on) {
            if (!registry.feature(id)) return undefined;
            const before = registry.featureOn(id);
            choices()[id] = Boolean(on);
            save();
            if (before !== Boolean(on)) tell(id);
            return Boolean(on);
        },
        /** Every declared feature with its state: [{ id, moduleId, moduleName, label, describe, default, prompt, needs, available, why, on }]. */
        list: () => registry.features().map(feature => ({ ...feature, on: registry.featureOn(feature.id) })),
    };
}
