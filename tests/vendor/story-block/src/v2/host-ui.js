// Story Suite v2's two hosts for module UI (docs/v2/SPEC.md §6):
//
// - the settings host: one fold per module with settings, its schema fields rendered as rows
//   (bool, int, choice, text, list of {…}) and its custom `section` below them; values are read
//   and written through createSettings() (extension_settings.storySuite.modules[id]); plus the
//   host's own fold (the tail budget). `openSettingsOverlay` puts it in a full-screen dialog.
//   Features (MODULES §F100): each module's fold opens with a "Features" subsection, a switch per
//   feature with its label and description, and one "Features" fold lists every module's; a feature
//   that changes the static prompt part says so (PROMPT_HINT). The choices are the reader's
//   (createFeatureStore, extension_settings.storySuite.features), not the chat's.
// - the tab host: a tab bar with every module tab, each rendered from the head state's view.
//
// Every node is built with textContent; module names, labels and values are never markup.
// `doc` is the document to build in (tests pass a fake one).

import { FIELD_TYPES, normalizeField } from './registry.js';
import { HOST_SETTINGS_SCHEMA } from './sdk.js';
import { PROMPT_HINT } from './features.js';
import { scrollCue } from './view/scroll-cue.js';
import { cutAt } from '../text.js';

export const OPEN_CLASS = 'story-suite-open';
export const HOST_FOLD = 'story-suite';
export const FEATURES_FOLD = 'story-suite-features';
export const FEATURE_TEXT = Object.freeze({
    title: 'Features',
    overviewHint: 'every module',
    moduleHint: 'Turn a part of this module on or off. It applies to you, in every chat; what the story keeps for it stays.',
    overviewHelp: 'Every optional part of every module. It applies to you, in every chat; turning one off keeps what the story holds for it, so turning it on again brings it all back.',
});

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

function button(doc, className, text, title = '') {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    return node;
}

const humanize = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
const optionsOf = field => (field.options ?? []).map(option => (option && typeof option === 'object' ? { value: String(option.value), label: String(option.label ?? option.value) } : { value: String(option), label: String(option) }));

/** The value a field starts from when it has no default. */
export function emptyValue(field) {
    const f = normalizeField(field);
    if (f.type === 'bool') return false;
    if (f.type === 'int') return Number.isInteger(f.min) ? f.min : 0;
    if (f.type === 'choice') return optionsOf(f)[0]?.value ?? '';
    if (f.type === 'list') return [];
    return '';
}

/** A whole number from what was typed, kept inside min/max; null when it is not one. */
export function readInt(text, field) {
    const value = Number(String(text).trim());
    if (!String(text).trim() || !Number.isFinite(value)) return null;
    let out = Math.round(value);
    if (Number.isInteger(field.min)) out = Math.max(field.min, out);
    if (Number.isInteger(field.max)) out = Math.min(field.max, out);
    return out;
}

// One control for one field; `onChange(value)` gets the new value.
function control(doc, field, value, onChange, id) {
    const f = normalizeField(field);
    if (f.type === 'bool') {
        const input = el(doc, 'input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
        input.addEventListener('change', () => onChange(Boolean(input.checked)));
        return input;
    }
    if (f.type === 'choice') {
        const select = el(doc, 'select', 'text_pole');
        for (const option of optionsOf(f)) {
            const node = el(doc, 'option', '', option.label);
            node.value = option.value;
            select.appendChild(node);
        }
        select.value = String(value ?? '');
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }
    if (f.type === 'int') {
        const input = el(doc, 'input', 'text_pole');
        input.type = 'number';
        if (Number.isInteger(f.min)) input.min = String(f.min);
        if (Number.isInteger(f.max)) input.max = String(f.max);
        input.step = '1';
        input.value = String(value ?? '');
        input.addEventListener('change', () => {
            const next = readInt(input.value, f);
            // Not a number: the stored value stays, and is shown again.
            if (next === null) { input.value = String(value ?? ''); return; }
            input.value = String(next);
            value = next;
            onChange(next);
        });
        return input;
    }
    if (f.type === 'list') return listControl(doc, f, Array.isArray(value) ? value : [], onChange, id);
    const input = el(doc, f.multiline ? 'textarea' : 'input', 'text_pole');
    if (!f.multiline) input.type = 'text';
    // A text field's `max` holds for typing and pasting alike (settings.set cuts it there too).
    const max = Number.isInteger(f.max) && f.max >= 0 ? f.max : null;
    if (max !== null) input.maxLength = max;
    input.value = String(value ?? '');
    input.addEventListener('change', () => {
        if (max !== null && input.value.length > max) input.value = cutAt(input.value, max);
        onChange(input.value);
    });
    return input;
}

// A list of {…}: a row of sub-fields per item, with Remove, and Add at the end.
function listControl(doc, field, items, onChange, id) {
    const root = el(doc, 'div', 'story-suite-list');
    let list = structuredClone(items);
    const draw = () => {
        root.replaceChildren();
        list.forEach((item, index) => {
            const row = el(doc, 'div', 'story-suite-list-item');
            row.dataset.index = String(index);
            for (const [key, sub] of Object.entries(field.of)) {
                const value = item && Object.hasOwn(item, key) ? item[key] : emptyValue(sub);
                row.appendChild(fieldRow(doc, key, sub, value, next => {
                    list[index] = { ...list[index], [key]: next };
                    onChange(structuredClone(list));
                }, `${id}-${index}`));
            }
            const remove = button(doc, 'menu_button story-suite-list-remove', 'Remove', 'Remove this one');
            remove.addEventListener('click', () => {
                list = list.filter((_, at) => at !== index);
                onChange(structuredClone(list));
                draw();
            });
            row.appendChild(remove);
            root.appendChild(row);
        });
        const add = button(doc, 'menu_button story-suite-list-add', 'Add');
        add.addEventListener('click', () => {
            list = [...list, Object.fromEntries(Object.entries(field.of).map(([key, sub]) => [key, emptyValue(sub)]))];
            onChange(structuredClone(list));
            draw();
        });
        root.appendChild(add);
    };
    draw();
    return root;
}

// `label.story-suite-row`: the label and its help on the left, the control on the right.
function fieldRow(doc, key, field, value, onChange, prefix) {
    const f = normalizeField(field);
    // A type this Story Block does not know (a newer module's): hidden, its value left alone.
    if (!FIELD_TYPES.includes(f?.type)) {
        const hidden = el(doc, 'div', 'story-suite-row');
        hidden.dataset.field = key;
        hidden.hidden = true;
        return hidden;
    }
    const id = `${prefix}-${key}`.replace(/[^\w-]/g, '_');
    const row = el(doc, f.type === 'list' ? 'div' : 'label', 'story-suite-row');
    row.dataset.field = key;
    if (f.type !== 'list') row.setAttribute('for', id);
    const text = el(doc, 'span');
    text.appendChild(el(doc, 'b', '', f.label ?? humanize(key)));
    if (f.help) text.appendChild(el(doc, 'small', '', f.help));
    row.appendChild(text);
    const input = control(doc, f, value, onChange, id);
    input.id = id;
    row.appendChild(input);
    return row;
}

function fold(doc, key, title, hint = '') {
    const details = el(doc, 'details', 'story-suite-fold');
    details.dataset.fold = key;
    const summary = el(doc, 'summary');
    summary.appendChild(el(doc, 'b', '', title));
    if (hint) summary.appendChild(el(doc, 'small', '', hint));
    details.appendChild(summary);
    const body = el(doc, 'div', 'story-suite-fold-body');
    details.appendChild(body);
    return { details, body };
}

// One feature's row: its switch, label, description and (when it changes the static prompt) the hint.
function featureRow(doc, feature, onChange) {
    const id = `story_suite_feature_${feature.id}`.replace(/[^\w-]/g, '_');
    const row = el(doc, 'label', 'story-suite-row story-suite-feature');
    row.dataset.feature = feature.id;
    row.setAttribute('for', id);
    const text = el(doc, 'span');
    text.appendChild(el(doc, 'b', '', feature.label));
    if (feature.describe) text.appendChild(el(doc, 'small', '', feature.describe));
    if (feature.prompt) text.appendChild(el(doc, 'small', 'story-suite-feature-hint', PROMPT_HINT));
    row.appendChild(text);
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.checked = feature.on === true;
    input.setAttribute('aria-checked', String(input.checked));
    input.addEventListener('change', () => onChange(Boolean(input.checked)));
    row.appendChild(input);
    return row;
}

/**
 * Renders the settings into `root` (emptied first). `options`: { registry, settings
 * (createSettings), doc?, sdk?, features? (createFeatureStore; without it no Features are shown) }.
 * A module's `section(el, api)` gets api = { get(key), set(key, value), values(), sdk } (a section
 * given as a title plus render(el, api) is the same panel). Returns { refresh() }.
 */
export function renderSettingsHost(root, { registry, settings, doc = globalThis.document, sdk = null, features = null }) {
    const featureList = () => (features && typeof features.list === 'function' ? features.list() : []);
    // A switch changed: stored, then every row of that feature (its module's and the overview's) shows it.
    function setFeature(id, on) {
        const stored = features.set(id, on);
        const now = typeof stored === 'boolean' ? stored : features.on(id);
        for (const node of root.querySelectorAll('.story-suite-feature')) {
            if (node.dataset.feature !== id) continue;
            const input = node.querySelector('input');
            if (!input) continue;
            input.checked = now;
            input.setAttribute('aria-checked', String(now));
        }
    }
    function featureBlock(list, help) {
        const block = el(doc, 'div', 'story-suite-subsection story-suite-features');
        block.appendChild(el(doc, 'h4', '', FEATURE_TEXT.title));
        if (help) block.appendChild(el(doc, 'p', 'story-suite-muted', help));
        for (const feature of list) block.appendChild(featureRow(doc, feature, on => setFeature(feature.id, on)));
        return block;
    }
    function featuresFold(list) {
        const { details, body } = fold(doc, FEATURES_FOLD, FEATURE_TEXT.title, FEATURE_TEXT.overviewHint);
        body.appendChild(el(doc, 'p', 'story-suite-muted', FEATURE_TEXT.overviewHelp));
        const byModule = new Map();
        for (const feature of list) {
            if (!byModule.has(feature.moduleId)) byModule.set(feature.moduleId, []);
            byModule.get(feature.moduleId).push(feature);
        }
        for (const [moduleId, own] of byModule) {
            const group = el(doc, 'div', 'story-suite-subsection story-suite-feature-group');
            group.dataset.module = moduleId;
            group.appendChild(el(doc, 'h4', '', own[0].moduleName));
            for (const feature of own) group.appendChild(featureRow(doc, feature, on => setFeature(feature.id, on)));
            body.appendChild(group);
        }
        return details;
    }
    function moduleFold(def, own = []) {
        const { details, body } = fold(doc, def.moduleId, def.name, def.title !== def.name ? def.title : def.moduleId);
        if (own.length) body.appendChild(featureBlock(own, FEATURE_TEXT.moduleHint));
        const values = settings(def.moduleId);
        for (const [key, field] of Object.entries(def.schema)) {
            const value = Object.hasOwn(values, key) ? values[key] : emptyValue(field);
            body.appendChild(fieldRow(doc, key, field, value, next => settings.set(def.moduleId, key, next), `story_suite_${def.moduleId}`));
        }
        if (def.section) {
            const section = el(doc, 'div', 'story-suite-section');
            section.dataset.module = def.moduleId;
            const api = Object.freeze({
                get: key => settings(def.moduleId)[key],
                set: (key, value) => settings.set(def.moduleId, key, value),
                values: () => settings(def.moduleId),
                sdk,
            });
            try { def.section(section, api); } catch (error) {
                section.replaceChildren(el(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            body.appendChild(section);
        }
        return details;
    }
    function hostFold() {
        const { details, body } = fold(doc, HOST_FOLD, 'Story Suite', 'prompt');
        const values = settings();
        for (const [key, field] of Object.entries(HOST_SETTINGS_SCHEMA)) {
            body.appendChild(fieldRow(doc, key, field, values[key], next => settings.set(null, key, next), 'story_suite_host'));
        }
        return details;
    }
    function refresh() {
        const open = new Set([...root.querySelectorAll('details.story-suite-fold')].filter(node => node.open).map(node => node.dataset.fold));
        root.replaceChildren();
        root.classList.add('story-suite-folds');
        const all = featureList();
        const ownOf = moduleId => all.filter(feature => feature.moduleId === moduleId);
        // A module with features gets its fold even without settings of its own.
        const defs = registry.settingsDefs();
        const extra = [...new Set(all.map(feature => feature.moduleId))]
            .filter(moduleId => !defs.some(def => def.moduleId === moduleId))
            .map(moduleId => {
                const name = all.find(feature => feature.moduleId === moduleId).moduleName;
                return { moduleId, name, title: name, schema: {}, section: null };
            });
        const modules = [...defs, ...extra]
            .filter(def => Object.keys(def.schema).length || def.section || ownOf(def.moduleId).length)
            .sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0))
            .map(def => moduleFold(def, ownOf(def.moduleId)));
        const folds = [hostFold(), ...(all.length ? [featuresFold(all)] : []), ...modules];
        for (const node of folds) {
            if (open.has(node.dataset.fold)) node.open = true;
            root.appendChild(node);
        }
    }
    refresh();
    return { refresh };
}

/**
 * Opens the settings in a full-screen dialog on `doc.body`, with a Close button; `<body>`
 * carries `story-suite-open` while it is open. Returns { root, close(), refresh() }.
 */
export function openSettingsOverlay({ registry, settings, doc = globalThis.document, sdk = null, features = null }) {
    doc.querySelector?.('#story_suite_v2_overlay')?.remove();
    const overlay = el(doc, 'div', 'story-suite-overlay');
    overlay.id = 'story_suite_v2_overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Story Suite');
    const header = el(doc, 'div', 'story-suite-overlay-header');
    header.appendChild(el(doc, 'b', '', 'Story Suite'));
    const close = button(doc, 'menu_button story-suite-close', 'Close', 'Close Story Suite');
    header.appendChild(close);
    const body = el(doc, 'div', 'story-suite-panel');
    overlay.append(header, body);
    doc.body.appendChild(overlay);
    doc.body.classList.add(OPEN_CLASS);
    const host = renderSettingsHost(body, { registry, settings, doc, sdk, features });
    const api = {
        root: overlay,
        refresh: host.refresh,
        close() {
            overlay.remove();
            doc.body.classList.remove(OPEN_CLASS);
        },
    };
    close.addEventListener('click', () => api.close());
    return api;
}

/**
 * The tab bar in `root`: a button per module tab (registry.tabs(), module-id order) and one
 * pane, the chosen tab's, rendered with `tab.render(pane, view, api)`. `options`: { registry,
 * view: () => view, api (the sdk), doc?, active? }. Tabs read the head state's view only, never
 * message text. Returns { refresh(), select(id), active() }.
 */
export function createTabHost(root, { registry, view, api = null, doc = globalThis.document, active = null }) {
    let current = active;
    const bar = el(doc, 'div', 'story-suite-tabs');
    bar.setAttribute('role', 'tablist');
    const pane = el(doc, 'div', 'story-suite-pane');
    pane.setAttribute('role', 'tabpanel');
    root.replaceChildren(bar, pane);
    // Tabs that do not fit scroll sideways; the edge with more of them fades (scroll-cue.js).
    const cue = scrollCue(bar, { win: doc.defaultView ?? globalThis });

    function draw() {
        const tabs = registry.tabs();
        if (!tabs.some(tab => tab.id === current)) current = tabs[0]?.id ?? null;
        bar.replaceChildren();
        for (const tab of tabs) {
            const node = button(doc, `story-suite-tab${tab.id === current ? ' active' : ''}`, '', tab.title);
            node.dataset.tabId = tab.id;
            node.setAttribute('role', 'tab');
            node.setAttribute('aria-selected', String(tab.id === current));
            if (tab.icon) {
                const glyph = el(doc, 'i', `fa-solid ${tab.icon}`);
                glyph.setAttribute('aria-hidden', 'true');
                node.appendChild(glyph);
            }
            node.appendChild(el(doc, 'span', 'story-suite-tab-label', tab.title));
            node.addEventListener('click', () => select(tab.id));
            bar.appendChild(node);
        }
        cue.update();
        pane.replaceChildren();
        const tab = tabs.find(item => item.id === current);
        pane.dataset.tabId = tab?.id ?? '';
        if (!tab) {
            pane.appendChild(el(doc, 'p', 'story-suite-muted', 'No module has a tab yet.'));
            return;
        }
        try { tab.render(pane, view(), api); } catch (error) {
            pane.replaceChildren(el(doc, 'p', 'story-suite-muted', `${tab.title} could not be shown: ${error?.message ?? error}`));
        }
    }
    function select(id) {
        current = id;
        draw();
    }
    draw();
    return { refresh: draw, select, active: () => current };
}
