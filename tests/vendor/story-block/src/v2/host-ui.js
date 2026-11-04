// Story Suite v2's two hosts for module UI (docs/v2/SPEC.md §6):
//
// - the settings host: one centred column of folds: the modules' own folds (Story Block's Packs), Features, one fold per module
//   with settings, Versions. Inside a module's fold: one line saying how many of its
//   features are on (it opens the Features fold there), its custom `section` right there (no sub-fold of
//   its own), then a sub-fold per settings group (a field's `group`, else its label's "Group: …" prefix,
//   else General). Versions is last. (Diagnostics, the report and what a module places there with `settings.place: 'diagnostics'`, is the
//   settings window's page now: view/settings/diagnostics-page.js.) Fields are rows (bool, int,
//   choice, text, list of {…}; a list one compact line per item, or, when its fields are text and whole
//   numbers, a textarea with one item per line: `form: 'lines'` starts there); values are read and
//   written through createSettings() (extension_settings.storySuite.modules[id]). Open folds stay open
//   across redraws. The settings window (view/settings/window.js, UI step 3a) shows it in sections: `renderSettingsHost`
//   with `sections` ({ ids, place(id), route(piece), defaultOpen(key), show(id), open(foldKey),
//   afterRefresh() }) draws each fold, and for Story Block's own fold each of its parts (Money, Assist), into the page of
//   the section it belongs to (view/settings/sections.js), and lists what a search can find (`entries()`). A section
//   with no pane (one the form engine draws: Look, Features, Money, Assist, Tabs & Packs) is not drawn here. The Story Suite
//   fold (the budgets, the prompt size, Tabs) is gone: the Tabs & Packs page draws them (view/settings/tabs-packs.js).
//   Features (MODULES §F100): the Features fold has a filter box and one sub-fold per module (by name,
//   "N of M on"), a switch per feature with its label and description; a feature that changes the
//   static prompt part says so (PROMPT_HINT). A settings field (`{ …, feature }`) or custom panel (a
//   function with `feature`) of a feature that is off is not drawn; a switch redraws. A feature whose
//   `needs` no installed module meets is drawn off and disabled, with its reason. The choices are the
//   reader's (createFeatureStore, extension_settings.storySuite.features), not the chat's.
// - the tab host: a tab bar with every module tab, each rendered from the head state's view.
//
// Every node is built with textContent; module names, labels and values are never markup.
// `doc` is the document to build in (tests pass a fake one).

import { FIELD_TYPES, normalizeField } from './registry.js';
import { PROMPT_HINT, featureOf } from './features.js';
import { compatReport, renderCompat } from './compat.js';
import { contextNotice } from './prompt.js';
import { fill } from './strings.js';
import { cutAt } from '../text.js';
import { focusNode, revealIn } from './view/scroll.js';
import { el, fold, button, fieldRow, rowValue, fieldReadOnly, groupFields, humanize } from './host-ui/controls.js';
import { FEATURES_FOLD, FEATURE_TEXT, featuresFoldOf, SETTINGS_TEXT, SUB_FOLD, VERSIONS_FOLD } from './host-ui/text.js';
export { OPEN_CLASS, HOST_FOLD, FEATURES_FOLD, VERSIONS_FOLD, DIAGNOSTICS_FOLD, SENT_FOLD, TABS_FOLD, PACKS_FOLD, EVENTS_FOLD, SUB_FOLD, featuresFoldOf, SETTINGS_TEXT, TABS_TEXT, DIAGNOSTICS_TEXT, FEATURE_TEXT } from './host-ui/text.js';
export { emptyValue, readInt, listTextFields, listToLines, linesToList, fieldReadOnly, rowValue, groupFields } from './host-ui/controls.js';
export { promptSize, sentText, redactSentOf } from './host-ui/sent.js';
export { createTabHost } from './host-ui/tab-host.js';

// One feature's row: its switch, label, description and (when it changes the static prompt) the hint.
// A feature is drawn twice, so each switch's id is its place (`overview` or `module`) plus the feature id
// encoded whole (encodeURIComponent never makes two ids one, as flattening "a.b_c" and "a.b.c" would);
// its row labels that switch.
export const featureInputId = (place, id) => `story_suite_feature_${place}_${encodeURIComponent(String(id))}`;
function featureRow(doc, feature, onChange, place) {
    const id = featureInputId(place, feature.id);
    const row = el(doc, 'label', 'story-suite-row story-suite-feature');
    row.dataset.feature = feature.id;
    row.dataset.type = 'bool';
    row.setAttribute('for', id);
    const text = el(doc, 'span', 'story-suite-row-label');
    text.appendChild(el(doc, 'b', '', feature.label));
    if (feature.describe) text.appendChild(el(doc, 'small', '', feature.describe));
    if (feature.prompt) text.appendChild(el(doc, 'small', 'story-suite-feature-hint', PROMPT_HINT));
    // A feature whose `needs` no module meets: shown off, not switchable, with the reason.
    const unavailable = feature.available === false;
    if (unavailable) {
        row.classList.add('story-suite-feature-unavailable');
        text.appendChild(el(doc, 'small', 'story-suite-feature-why', feature.why));
    }
    row.appendChild(text);
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.checked = feature.on === true && !unavailable;
    input.disabled = unavailable;
    input.setAttribute('aria-checked', String(input.checked));
    if (unavailable) input.setAttribute('aria-disabled', 'true');
    input.addEventListener('change', () => onChange(Boolean(input.checked)));
    row.appendChild(input);
    return row;
}

const FOLD_SELECTOR = 'details.story-suite-fold, details.story-suite-subfold';

/**
 * Renders the settings into `root` (emptied first), as one centred column of folds: the modules' own folds (Story Block's
 * Packs), Features (a sub-fold per module), one fold per module with settings (a line to its features, its custom panel, then a
 * sub-fold per settings group) and Versions. Story Suite's own
 * fold (the budgets, the prompt size, Tabs) is gone: the settings window's Tabs & Packs page draws them (view/settings/).
 *
 * `options`: { registry, settings (createSettings), doc?, sdk?, features? (createFeatureStore; without
 * it no Features are shown), openState? (a Map of fold key → open, kept across redraws; a new one by default),
 *  * sections? (the settings window's placing, above) }.
 * A module's `section(el, api)` gets api = { get(key), set(key, value), values(), sdk } (a section
 * given as a title plus render(el, api) is the same panel). Returns { refresh(), entries() }.
 */
export function renderSettingsHost(root, { registry, settings, doc = globalThis.document, sdk = null, features = null, openState = new Map(), sections = null }) {
    // What a search can find: every settings row, feature and panel drawn, `{ kind, key, field: { label, help }, group,
    // node }` (`node` is where it is now: a row drawn again replaces it). Rebuilt with each draw; `entries()` gives it.
    let found = [];
    const note = (kind, key, field, group, node) => {
        const entry = { kind, key, field, group, node };
        found.push(entry);
        return entry;
    };
    const featureList = () => (features && typeof features.list === 'function' ? features.list() : []);
    // A settings field or panel under a feature that is off is not drawn (its stored value is kept).
    const hiddenByFeature = item => {
        const id = featureOf(item);
        return id !== null && typeof registry.featureOn === 'function' && !registry.featureOn(id);
    };
    // A fold opens as the reader left it (this redraw or an earlier one), else as `open` says.
    function remember(details, open = false) {
        const key = details.dataset.fold;
        details.open = openState.has(key) ? openState.get(key) === true : open || sections?.defaultOpen?.(key) === true;
        details.addEventListener('toggle', () => { if (!details.dataset.filtered) openState.set(key, details.open === true); });
        return details;
    }
    // The Features fold's filter text, kept across redraws.
    let featureFilter = '';
    let clearFilter = () => { featureFilter = ''; };
    const panelApi = moduleId => Object.freeze({
        get: key => settings(moduleId)[key],
        set: (key, value) => settings.set(moduleId, key, value),
        values: () => settings(moduleId),
        sdk,
    });
    // A switch changed: stored, then everything is drawn again (the fields of that feature come or go, both
    // rows of it show the choice, the prompt size follows), open folds stay open and the switch keeps the focus.
    function setFeature(id, on, inputId) {
        features.set(id, on);
        refresh();
        const again = [...root.querySelectorAll('.story-suite-feature input')].find(input => input.id === inputId);
        again?.focus?.();
    }
    // The Features fold: a filter box, then one sub-fold per module (by name), its summary "N of M on".
    // The filter (by name and description, across modules) hides the rows and sub-folds that do not match
    // and opens the ones that do while it holds text; cleared, they are as the reader left them. It is
    // kept across redraws (a switch redraws everything).
    function featuresFold(list) {
        const { details, body } = fold(doc, FEATURES_FOLD, FEATURE_TEXT.title, FEATURE_TEXT.overviewHint);
        body.appendChild(el(doc, 'p', 'story-suite-muted', FEATURE_TEXT.overviewHelp));
        const find = el(doc, 'label', 'story-suite-row story-suite-feature-filter');
        find.dataset.type = 'text';
        const findId = 'story_suite_feature_filter';
        find.setAttribute('for', findId);
        const findText = el(doc, 'span', 'story-suite-row-label');
        findText.appendChild(el(doc, 'b', '', FEATURE_TEXT.filter));
        find.appendChild(findText);
        const input = el(doc, 'input', 'text_pole');
        input.type = 'search';
        input.id = findId;
        input.placeholder = FEATURE_TEXT.filterPlaceholder;
        input.autocomplete = 'off';
        input.value = featureFilter;
        find.appendChild(input);
        body.appendChild(find);
        const byModule = new Map();
        for (const feature of list) {
            if (!byModule.has(feature.moduleId)) byModule.set(feature.moduleId, []);
            byModule.get(feature.moduleId).push(feature);
        }
        const groups = [...byModule].map(([moduleId, own]) => ({ moduleId, own, name: String(own[0].moduleName ?? moduleId) }))
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
        const subs = groups.map(({ moduleId, own, name }) => {
            const on = own.filter(feature => feature.on === true && feature.available !== false).length;
            const inner = fold(doc, featuresFoldOf(moduleId), name, fill(SETTINGS_TEXT.featuresOn, { on, n: own.length }), 'story-suite-subfold');
            inner.details.dataset.module = moduleId;
            inner.details.classList.add('story-suite-feature-group');
            for (const feature of own) {
                const row = featureRow(doc, feature, next => setFeature(feature.id, next, featureInputId('overview', feature.id)), 'overview');
                note('feature', feature.id, { label: feature.label, help: feature.describe }, `${name} Features`, row);
                inner.body.appendChild(row);
            }
            body.appendChild(remember(inner.details, groups.length === 1));
            return { details: inner.details, rows: [...inner.body.querySelectorAll('.story-suite-feature')], own };
        });
        const none = el(doc, 'p', 'story-suite-muted story-suite-feature-none');
        none.setAttribute('role', 'status');
        none.hidden = true;
        body.appendChild(none);
        const apply = () => {
            const query = featureFilter.trim().toLowerCase();
            let shown = 0;
            for (const sub of subs) {
                let matches = 0;
                sub.rows.forEach((row, at) => {
                    const feature = sub.own[at];
                    const hit = !query || `${feature.label ?? ''}\n${feature.describe ?? ''}`.toLowerCase().includes(query);
                    row.hidden = !hit;
                    if (hit) matches += 1;
                });
                shown += matches;
                sub.details.hidden = Boolean(query) && matches === 0;
                if (query) {
                    // Opened for the filter only: how the reader left it is kept first, and the filter's
                    // opening is not remembered (remember() and refresh() skip a filtered fold).
                    if (!sub.details.dataset.filtered) openState.set(sub.details.dataset.fold, sub.details.open === true);
                    sub.details.dataset.filtered = 'true';
                    sub.details.open = matches > 0;
                } else if (sub.details.dataset.filtered) {
                    delete sub.details.dataset.filtered;
                    const key = sub.details.dataset.fold;
                    sub.details.open = openState.has(key) ? openState.get(key) === true : subs.length === 1;
                }
            }
            none.hidden = !query || shown > 0;
            none.textContent = none.hidden ? '' : fill(FEATURE_TEXT.filterNone, { text: cutAt(featureFilter.trim(), 40) });
        };
        const update = () => { featureFilter = String(input.value ?? ''); apply(); };
        input.addEventListener('input', update);
        input.addEventListener('change', update);
        clearFilter = () => { input.value = ''; update(); };
        apply();
        return remember(details);
    }
    // A module's fold says how many of its features are on, with a button to the Features fold at its sub-fold.
    function openFeaturesAt(moduleId) {
        const key = featuresFoldOf(moduleId);
        const nodes = [...root.querySelectorAll(FOLD_SELECTOR)];
        const sub = nodes.find(node => node.dataset.fold === key);
        if (!sub) return;
        // A filter hiding that module goes, so its sub-fold shows.
        if (sub.hidden) clearFilter();
        for (const node of [nodes.find(item => item.dataset.fold === FEATURES_FOLD), sub]) {
            if (!node) continue;
            node.open = true;
            if (!node.dataset.filtered) openState.set(node.dataset.fold, true);
        }
        revealIn(null, sub, 'start');
        focusNode(sub.querySelector('summary'));
    }
    function featureLink(def, own) {
        const on = own.filter(feature => feature.on === true && feature.available !== false).length;
        const line = el(doc, 'p', 'story-suite-feature-line');
        const go = button(doc, 'story-suite-feature-link', fill(FEATURE_TEXT.link, { on, n: own.length }), fill(FEATURE_TEXT.linkTitle, { name: def.name, on, n: own.length }));
        // In the settings window the Features page is the form engine's: the window opens that module's group there.
        go.addEventListener('click', () => (sections?.open ? sections.open(featuresFoldOf(def.moduleId)) : openFeaturesAt(def.moduleId)));
        line.appendChild(go);
        return line;
    }
    const settingsCount = n => fill(n === 1 ? SETTINGS_TEXT.oneSetting : SETTINGS_TEXT.settings, { n });
    // A module's settings drawn in parts, not yet placed: its features line, its custom panel and one sub-fold
    // per settings group. `moduleFold` puts them in a fold of the module's own; the settings window (`sections`) may
    // send a part to another section (Story Block's money and Assist settings) and keep the rest in the fold.
    function moduleParts(def, own = []) {
        const values = settings(def.moduleId);
        const subs = [];
        // The rows whose `readOnly` is a function of the values: drawn again (value, help, disabled) after
        // any other field of this module changes, so switching Calendar to Custom makes its fields editable.
        const follows = [];
        const rowOf = (key, field, now) => fieldRow(doc, key, field, rowValue(key, field, now), next => {
            settings.set(def.moduleId, key, next);
            if (!follows.length) return;
            const fresh = settings(def.moduleId);
            for (const item of follows) {
                if (item.key === key || !item.row.parentNode) continue;
                const row = rowOf(item.key, item.field, fresh);
                item.row.before(row);
                item.row.remove();
                item.row = row;
            }
        }, `story_suite_${def.moduleId}`, openState, fieldReadOnly(field, now));
        // Its features are switched in the Features fold; here one line says how many are on and goes there.
        const link = own.length ? featureLink(def, own) : null;
        const shown = Object.fromEntries(Object.entries(def.schema).filter(([, field]) => !hiddenByFeature(field)));
        for (const group of groupFields(shown)) {
            const visible = group.fields.filter(({ field }) => FIELD_TYPES.includes(normalizeField(field)?.type));
            if (!visible.length) continue;
            subs.push({
                group: group.name,
                key: `group:${group.name}`,
                title: group.name,
                hint: settingsCount(visible.length),
                draw: into => {
                    for (const { key, field } of group.fields) {
                        const item = { key, field, row: rowOf(key, field, values) };
                        if (typeof normalizeField(field)?.readOnly === 'function' || typeof normalizeField(field)?.shows === 'function') follows.push(item);
                        const f = normalizeField(field);
                        if (FIELD_TYPES.includes(f?.type)) {
                            const entry = note('row', key, { label: f.label ?? humanize(key), help: f.help }, `${def.name} ${group.name}`, item.row);
                            Object.defineProperty(entry, 'node', { get: () => item.row, enumerable: true });
                        }
                        into.appendChild(item.row);
                    }
                },
            });
        }
        // Its custom panel sits in the module's fold itself, right under the features line (never in a
        // sub-fold: a module's own panel may have folds of its own, and three levels is too deep). A
        // titled section ("Assist") gets its title as a heading.
        let panel = null;
        if (def.section && !hiddenByFeature(def.section)) {
            const section = el(doc, 'div', 'story-suite-section');
            section.dataset.module = def.moduleId;
            panel = [...(def.title !== def.name ? [el(doc, 'h4', 'story-suite-section-title', def.title)] : []), section];
            try { def.section(section, panelApi(def.moduleId)); } catch (error) {
                section.replaceChildren(el(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            note('panel', `${def.moduleId}${SUB_FOLD}panel`, { label: def.title, help: '' }, def.name, section);
        }
        // The schema's groups below it, each in a sub-fold of its own; one alone opens with its module.
        const lone = subs.length === 1 && !panel;
        const details = subs.map(sub => {
            const inner = fold(doc, `${def.moduleId}${SUB_FOLD}${sub.key}`, sub.title, sub.hint, 'story-suite-subfold');
            sub.draw(inner.body);
            return remember(inner.details, lone);
        });
        return { link, panel, subs: subs.map((sub, at) => ({ group: sub.group, details: details[at] })) };
    }
    // The module's fold: the parts given (all of them by default) under its title.
    function moduleFold(def, own = [], className = 'story-suite-fold', parts = moduleParts(def, own)) {
        const { details, body } = fold(doc, def.moduleId, def.name, def.title !== def.name ? def.title : def.moduleId, className);
        body.append(...[parts.link, ...(parts.panel ?? []), ...parts.subs.map(sub => sub.details)].filter(Boolean));
        return remember(details);
    }
    // A module's own top-level folds (`settings.folds`: Story Block's Packs), drawn even with nothing in them.
    function ownFolds(def, folds = def.folds, className = 'story-suite-fold') {
        return folds.map(item => {
            const { details, body } = fold(doc, `${def.moduleId}/${item.id}`, item.title, item.hint, className);
            details.classList.add(`story-suite-fold-${item.id}`);
            try { item.render(body, panelApi(def.moduleId)); } catch (error) {
                body.replaceChildren(el(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            note('panel', `${def.moduleId}/${item.id}`, { label: item.title, help: item.hint }, def.name, details);
            return remember(details);
        });
    }

    // Versions (compat.js): each module, its version, the Story Block it needs, and what is out of step.
    function versionsFold() {
        const report = compatReport({ hostVersion: registry.hostVersion?.() ?? '', modules: registry.modules(), refusals: registry.refusals?.() ?? [], lifecycle: id => registry.lifecycle?.(id) ?? null });
        const { details, body } = fold(doc, VERSIONS_FOLD, 'Versions', report.outOfStep ? `${report.outOfStep} out of step` : 'all in step');
        if (report.outOfStep) details.classList.add('story-suite-fold-warn');
        note('panel', VERSIONS_FOLD, { label: 'Versions', help: report.outOfStep ? `${report.outOfStep} out of step` : 'all in step' }, 'Modules', details);
        renderCompat(body, report, { doc });
        return remember(details);
    }
    function refresh() {
        for (const node of root.querySelectorAll(FOLD_SELECTOR)) if (!node.dataset.filtered) openState.set(node.dataset.fold, node.open === true);
        found = [];
        const all = featureList();
        const ownOf = moduleId => all.filter(feature => feature.moduleId === moduleId);
        // A module with features and no settings has no fold of its own: its features are in the Features fold.
        const defs = registry.settingsDefs().map(def => ({ ...def, folds: Array.isArray(def.folds) ? def.folds : [] }));
        const byId = (a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0);
        // A module fold or own fold placed in Diagnostics (`place: 'diagnostics'`, debug information like Story Block's Events)
        // is not drawn here: the settings window's Diagnostics page draws it (view/settings/diagnostics-page.js).
        const inDiagnostics = item => item.place === 'diagnostics';
        // Where each piece goes: one column of folds (the default), or the settings window's sections
        // (`sections.route(piece)` → a section id; the nodes of each are put in `sections.place(id)`).
        const placed = new Map();
        const put = (piece, ...nodes) => {
            const id = sections ? sections.route(piece) : '';
            if (!placed.has(id)) placed.set(id, []);
            placed.get(id).push(...nodes.filter(Boolean));
        };
        // A piece whose section a body of its own draws (Story Block's Packs: the Tabs & Packs page; every module's settings: the
        // Modules page; Versions) is not drawn here, and not even built.
        const hasPane = piece => !sections || Boolean(sections.place(sections.route(piece)));
        const wantsModule = def => !sections || [{ type: 'module' }, { type: 'panel' }, ...groupFields(def.schema).map(group => ({ type: 'group', group: group.name }))].some(piece => hasPane({ ...piece, moduleId: def.moduleId }));
        const shown = [...defs].filter(def => Object.keys(def.schema).length || def.section).sort(byId);
        const modules = shown.filter(def => !inDiagnostics(def) && wantsModule(def)).map(def => ({ def, parts: moduleParts(def, ownOf(def.moduleId)) }));
        const own = [...defs].sort(byId).flatMap(def => (hasPane({ type: 'own-fold', moduleId: def.moduleId }) ? ownFolds(def, def.folds.filter(item => !inDiagnostics(item))) : []).map(node => ({ def, node })));
        for (const { def, node } of own) put({ type: 'own-fold', moduleId: def.moduleId }, node);
        // The settings window draws Features itself (the form engine) when its page is not given to this host.
        if (all.length && (!sections || sections.place(sections.route({ type: 'features' })))) put({ type: 'features' }, featuresFold(all));
        for (const { def, parts } of modules) {
            if (!sections) {
                put({ type: 'module', moduleId: def.moduleId }, moduleFold(def, ownOf(def.moduleId), 'story-suite-fold', parts));
                continue;
            }
            // A module's custom panel or settings group may belong to a section of its own (Story Block's
            // Money and Assist); what stays goes in the module's fold in its home section.
            const home = sections.route({ type: 'module', moduleId: def.moduleId });
            const panelAt = parts.panel ? sections.route({ type: 'panel', moduleId: def.moduleId }) : home;
            const kept = { link: parts.link, panel: panelAt === home ? parts.panel : null, subs: [] };
            if (panelAt !== home) put({ type: 'panel', moduleId: def.moduleId }, ...parts.panel);
            for (const sub of parts.subs) {
                const at = sections.route({ type: 'group', moduleId: def.moduleId, group: sub.group });
                if (at === home) kept.subs.push(sub);
                else put({ type: 'group', moduleId: def.moduleId, group: sub.group }, sub.details);
            }
            if (kept.link || kept.panel || kept.subs.length) put({ type: 'module', moduleId: def.moduleId }, moduleFold(def, ownOf(def.moduleId), 'story-suite-fold', kept));
        }
        if (hasPane({ type: 'versions' })) put({ type: 'versions' }, versionsFold());
        if (!sections) {
            root.replaceChildren(...(placed.get('') ?? []));
            root.classList.add('story-suite-folds');
            return;
        }
        for (const id of sections.ids) sections.place(id)?.replaceChildren(...(placed.get(id) ?? []));
        sections.afterRefresh?.();
    }
    refresh();
    return { refresh, entries: () => found.slice() };
}

/** The fold keys a module placed in Settings → Diagnostics (`place: 'diagnostics'`): "story-block/events". */
export function diagnosticsKeys(registry) {
    const defs = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs() : [];
    return defs.flatMap(def => [
        ...(def.place === 'diagnostics' ? [def.moduleId] : []),
        ...(Array.isArray(def.folds) ? def.folds : []).filter(item => item.place === 'diagnostics').map(item => `${def.moduleId}/${item.id}`),
    ]);
}
