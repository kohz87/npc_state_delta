// What each section of the settings window holds (UI stage, step 3a; Look and Features in 3b, Money in 3c): a map of section id →
// body. A body is a function
//
//     (pane, ctx) → { filter(text) → number, refresh?(), destroy?(), has?(foldKey), open?(foldKey) }
//
// `pane` is the empty element the window made for the section's page (under its heading); the body draws into it.
// `filter(text)` shows what matches the reader's search and returns how many matches it shows (the form engine's
// `renderSettingsForm(...).filter` does exactly this, so a section that moves to the form engine passes it through);
// '' shows everything. `refresh()` reads the stores again (a value changed elsewhere). `has(key)` and `open(key)` are
// for a body that holds folds or groups `openSettings({ fold })` can ask for: does it have that key, and show it and take
// the focus. `ctx` is { doc, openState, label (the section's name), legacy, changed() (tell the window a setting
// changed that other pages draw: it redraws them), options (what the window was opened with: registry, settings, sdk,
// features, theme, …) }.
//
// Look, Features (3b), Money (3c, money.js), Assist (3d, assist.js), Tabs & Packs (3e, tabs-packs.js), Blocks (blocks.js) and Modules (3f, modules.js) are the
// form engine's (below). The last section, Diagnostics, is still today's settings (host-ui.js `renderSettingsHost`), drawn into the section
// it belongs to (sections.js `routeOf`) by one shared host. Step 3g replaces that entry:
//
//     SECTION_BODIES.diagnostics = (pane, ctx) => { const form = renderSettingsForm(pane, { … }); return { filter: t => form.filter(t), refresh: () => form.refresh(), destroy: () => form.destroy() }; };
//
// A section with its own body is not drawn by the shared host (it never gets a pane), so its old folds go away with
// the entry.

import { FEATURES_FOLD, SUB_FOLD, renderSettingsHost } from '../../host-ui.js';
import { HOST_SETTINGS_SCHEMA } from '../../sdk.js';
import { renderFeaturesForm } from '../form/features.js';
import { staticTextWith } from '../../prompt.js';
import { renderSettingsForm } from '../form/form.js';
import { assistBody } from './assist.js';
import { blocksBody } from './blocks.js';
import { diagnosticsBody } from './diagnostics-page.js';
import { modulesBody } from './modules.js';
import { moneyBody } from './money.js';
import { tabsPacksBody } from './tabs-packs.js';
import { LOOK_KEYS, SECTION_IDS, opensByDefault, routeOf } from './sections.js';
import { filterPane } from './search.js';

/**
 * The shared host of today's settings for the sections that still use it: `attach(id, pane, ctx)` is each such body,
 * `start(root, { afterRefresh, show, open })` draws them all once every pane is attached, `refresh()` draws them again.
 */
export function createLegacySettings(options) {
    const panes = new Map();
    let host = null;
    return {
        attach(id, pane, ctx) {
            panes.set(id, pane);
            return {
                filter: text => (host ? filterPane({ pane, entries: host.entries(), text, openState: ctx.openState }) : 0),
            };
        },
        start(root, { afterRefresh = null, show = null, open = null } = {}) {
            if (!panes.size) return;
            host = renderSettingsHost(root, {
                ...options,
                sections: {
                    ids: [...panes.keys()], place: id => panes.get(id) ?? null, route: routeOf, defaultOpen: opensByDefault, show, open, afterRefresh,
                },
            });
        },
        refresh: () => host?.refresh(),
    };
}

const legacyBody = id => (pane, ctx) => ctx.legacy.attach(id, pane, ctx);

/**
 * Look: Panel style, Glass strength and Font, from the host's own schema, through the settings store the Story Suite fold
 * wrote through. A change applies the look at once (the theme bridge) on every Story Suite screen.
 */
function lookBody(pane, ctx) {
    const { settings, theme } = ctx.options;
    const schema = Object.fromEntries(LOOK_KEYS.map(key => [key, HOST_SETTINGS_SCHEMA[key]]));
    const form = renderSettingsForm(pane, {
        moduleId: null, schema, settings, doc: ctx.doc, quiet: true,
        onChange: () => { try { theme?.apply?.(); } catch { /* the look follows on the next load */ } },
    });
    return { filter: text => form.filter(text), refresh: () => form.refresh(), destroy: () => form.destroy() };
}

// The group key of a module's features is `story-suite-features::<module id>` (what `openSettings({ fold })` has always
// taken); the bare `story-suite-features` is the whole page.
const moduleOf = key => (typeof key === 'string' && key.startsWith(`${FEATURES_FOLD}${SUB_FOLD}`) ? key.slice(FEATURES_FOLD.length + SUB_FOLD.length) : null);

/**
 * Features: one group of switch tiles per module with "N of M on", through the feature store (`options.features`), the
 * store the Features fold wrote through. A switch tells the window (`ctx.changed`) so the other pages draw what depends
 * on it (a module's settings that belong to a feature, the prompt size, the line to a module's features).
 */
function featuresBody(pane, ctx) {
    // Each module's group is a fold, closed until the reader (or a fold id, or a search) opens it; its state is the window's own.
    // "How much to track" counts the fixed prompt under each preset from the registry, as it would be built, without switching anything.
    const form = renderFeaturesForm(pane, {
        features: ctx.options.features, doc: ctx.doc, fold: { state: ctx.openState }, onChange: () => ctx.changed?.(),
        staticText: switches => staticTextWith(ctx.options.registry, switches), countTokens: ctx.options.countTokens,
    });
    return {
        filter: text => form.filter(text),
        refresh: () => form.refresh(),
        destroy: () => form.destroy(),
        has: key => key === FEATURES_FOLD || (moduleOf(key) !== null && form.group(moduleOf(key)) !== undefined),
        open(key) {
            const id = moduleOf(key);
            const first = id ?? form.keys().map(feature => form.field(feature)?.feature.moduleId).find(Boolean);
            return first ? form.focusGroup(first) : false;
        },
    };
}

/** Section id → body. Replace an entry to move that section to the form engine (see the top of this file). */
export const SECTION_BODIES = Object.freeze({
    ...Object.fromEntries(SECTION_IDS.map(id => [id, legacyBody(id)])),
    look: lookBody,
    features: featuresBody,
    money: moneyBody,
    assist: assistBody,
    tabs: tabsPacksBody,
    blocks: blocksBody,
    modules: modulesBody,
    diagnostics: diagnosticsBody,
});
