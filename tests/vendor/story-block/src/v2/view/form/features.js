// The form engine's features form (UI stage, step 3b): Features (MODULES §F100) drawn as switch tiles, one group per
// module with how many of its features are on ("6 of 11 on"), in the concept's layout (two columns where there is
// room, one on a phone). It reads and writes the reader's choices through the feature store (features.js
// `createFeatureStore`: `list()` and `set(id, on)`), the same store the old Features fold wrote through; it does
// not touch the settings store.
//
//   const form = renderFeaturesForm(parent, { features, doc, onChange: ({ id, on }) => {} });
//   form.filter('weather');   // → how many tiles are shown (name, description, module and id are searched)
//   form.refresh();           // read the store again: states, counts, a feature that came or went
//   form.focusGroup('rpg-battle');  form.field('rpg-battle.wear');  form.destroy();
//
// A tile is the feature's name (a `label` for its switch), its description, a quiet line when it changes the fixed
// prompt (PROMPT_HINT) and, for a feature whose `needs` no installed module meets, the reason: that switch is off
// and disabled. The switch is the engine's own (`switchField`: a button with role="switch" and aria-checked), named
// by its tile and described by what is under the name. A group is a labelled section (`ss-section`, an h3 with the
// count beside it); its `data-fold` is `story-suite-features::<module id>`, the key `openSettings({ fold })` has always
// used for a module's features, and its heading takes the focus (`focusGroup`). Built with createElement and
// textContent only: module and feature names come from modules, never from markup.
//
// With the `fold` option ({ state: Map }) each group is a fold (a `details` with a chevron, the module's name and "6 of 11 on" in its
// summary), closed until opened: its open state is kept in `fold.state` under the group's `data-fold` key (the same map the window
// keeps for its other folds, so a redraw or another page does not lose it), a search opens the groups that have a match and gives the
// reader's choice back when it ends, and `focusGroup` opens the group it takes the focus to.

import { FORM_TEXT, SETTINGS_TEXT, fill, matchesSearch } from './schema.js';
import { newId, sectionBlock, switchField } from './fields.js';
import { PROMPT_HINT } from '../../features.js';
import { featuresFoldOf } from '../../host-ui.js';
import { focusNode, showAndFocus } from '../scroll.js';

const h = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};
const isOn = feature => feature.on === true && feature.available !== false;
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0);

/** The features as groups, one per module, by name: [{ moduleId, name, own }]. */
export function featureGroups(list) {
    const byModule = new Map();
    for (const feature of Array.isArray(list) ? list : []) {
        if (!byModule.has(feature.moduleId)) byModule.set(feature.moduleId, []);
        byModule.get(feature.moduleId).push(feature);
    }
    return [...byModule].map(([moduleId, own]) => ({ moduleId, own, name: String(own[0].moduleName ?? moduleId) })).sort(byName);
}

/** "6 of 11 on" for a group. */
export const countText = own => fill(SETTINGS_TEXT.featuresOn, { on: own.filter(isOn).length, n: own.length });

/**
 * Draws the features into `parent`. Options: `features` (the feature store: `list()` → [{ id, moduleId, moduleName, label,
 * describe, prompt, available, why, on }], `set(id, on)`; none: an empty form), `doc`, `onChange({ id, on })` (after a
 * switch was stored), `disabled`, `fold` ({ state: Map }: each group a fold). → { el, filter(text), refresh(), field(id), group(moduleId), focusGroup(moduleId),
 * setDisabled(on), keys(), destroy() }.
 */
export function renderFeaturesForm(parent, options) {
    const { features = null, doc = parent?.ownerDocument ?? globalThis.document, onChange = null } = options ?? {};
    let disabled = Boolean(options?.disabled);
    const root = h(doc, 'div', 'ss-form ss-features');
    root.setAttribute('data-form', 'features');
    const empty = h(doc, 'p', 'ss-form-empty');
    empty.hidden = true;
    let tiles = new Map();           // feature id → { tile, handle, feature, group }
    let groups = new Map();          // module id → { section, hint, own, ids }
    let signature = null;
    let filterText = '';
    const fold = options?.fold && typeof options.fold === 'object' ? options.fold : null;
    const foldState = fold?.state instanceof Map ? fold.state : new Map();

    const listNow = () => {
        try { return typeof features?.list === 'function' ? features.list() : []; } catch { return []; }
    };

    // One tile: the name, what it does, what it costs, why it is not available, and the switch.
    function buildTile(feature, group) {
        const id = newId(`feature-${feature.id}`);
        const unavailable = feature.available === false;
        const tile = h(doc, 'div', `ss-feature${unavailable ? ' ss-feature-unavailable' : ''}`);
        tile.setAttribute('data-feature', feature.id);
        const text = h(doc, 'div', 'ss-feature-text');
        const name = h(doc, 'label', 'ss-feature-name', feature.label);
        name.id = `${id}-label`;
        name.setAttribute('for', `${id}-control`);
        text.appendChild(name);
        const described = [];
        const line = (className, value) => {
            const node = h(doc, 'small', className, value);
            node.id = `${id}-${className.replace('ss-feature-', '')}`;
            text.appendChild(node);
            described.push(node.id);
        };
        if (feature.describe) line('ss-feature-help', feature.describe);
        if (feature.prompt) line('ss-feature-cost', PROMPT_HINT);
        if (unavailable && feature.why) line('ss-feature-why', feature.why);
        const handle = switchField({
            doc, id, key: feature.id, field: { type: 'bool' }, value: feature.on === true && !unavailable, labelledBy: name.id, disabled: disabled || unavailable,
            onChange: on => commit(feature.id, on),
        });
        handle.input.id = `${id}-control`;
        if (described.length) handle.input.setAttribute('aria-describedby', described.join(' '));
        tile.append(text, handle.el);
        return { tile, handle, feature, group, id };
    }

    // The reader flipped a switch: stored; what the store says is shown (a feature it did not know goes back).
    function commit(id, on) {
        let stored;
        try { stored = features?.set?.(id, on); } catch { stored = undefined; }
        paint();
        if (stored !== undefined) { try { onChange?.({ id, on: Boolean(stored) }); } catch { /* the switch is stored either way */ } }
    }

    // Everything drawn from the store's list: rebuilt when the set of features (or what they need) changed, else only the states.
    function build(list) {
        const focusId = tiles.size ? [...tiles.values()].find(entry => entry.handle.input === doc.activeElement)?.feature.id ?? null : null;
        root.replaceChildren(empty);
        tiles = new Map();
        groups = new Map();
        for (const group of featureGroups(list)) {
            const key = featuresFoldOf(group.moduleId);
            const wasOpen = fold ? foldState.get(key) === true : true;
            const section = sectionBlock(doc, { title: group.name, hint: countText(group.own), id: newId(`features-${group.moduleId}`), level: 4, collapsible: Boolean(fold), open: wasOpen });
            section.el.classList.add('ss-features-group');
            section.el.setAttribute('data-fold', key);
            section.el.setAttribute('data-module', group.moduleId);
            // A fold's heading is its summary (it takes the focus); a plain group's is its title.
            section.heading = fold ? section.el.querySelector('summary') : section.title;
            if (!fold) section.title.setAttribute('tabindex', '-1');
            else {
                section.el.classList.add('ss-section-fold');
                section.el.classList.toggle('ss-section-fold-open', wasOpen);
                section.el.addEventListener('toggle', () => {
                    if (filterText.trim() !== '') return;
                    section.el.classList.toggle('ss-section-fold-open', section.el.open === true);
                    foldState.set(key, section.el.open === true);
                });
            }
            const grid = h(doc, 'div', 'ss-features-grid');
            section.body.appendChild(grid);
            const hint = section.el.querySelector('.ss-section-hint');
            const ids = [];
            for (const feature of group.own) {
                const entry = buildTile(feature, group.moduleId);
                tiles.set(feature.id, entry);
                ids.push(feature.id);
                grid.appendChild(entry.tile);
            }
            groups.set(group.moduleId, { section, hint, own: group.own, ids, name: group.name, key });
            root.appendChild(section.el);
        }
        if (focusId) focusNode(tiles.get(focusId)?.handle.input);
    }
    const signatureOf = list => list.map(feature => `${feature.id}|${feature.moduleId}|${feature.moduleName ?? ''}|${feature.label}|${feature.describe ?? ''}|${feature.available === false ? 'x' : ''}|${feature.why ?? ''}|${feature.prompt ? 'p' : ''}`).join('\n');

    function paint() {
        const list = listNow();
        const next = signatureOf(list);
        if (next !== signature) {
            signature = next;
            build(list);
        } else {
            const byId = new Map(list.map(feature => [feature.id, feature]));
            for (const [id, entry] of tiles) {
                const now = byId.get(id);
                entry.feature = now;
                entry.handle.set(now.on === true && now.available !== false);
            }
            for (const [moduleId, group] of groups) {
                group.own = list.filter(feature => feature.moduleId === moduleId);
                if (group.hint) group.hint.textContent = countText(group.own);
            }
        }
        return paintVisibility();
    }

    // The search: a tile shows when its name, description, module's name or id has every word; a module with none is left out.
    function paintVisibility() {
        let shown = 0;
        for (const group of groups.values()) {
            let here = 0;
            for (const id of group.ids) {
                const entry = tiles.get(id);
                const visible = matchesSearch(id, { label: entry.feature.label, help: entry.feature.describe }, group.name, filterText);
                entry.tile.hidden = !visible;
                if (visible) here += 1;
            }
            group.section.setHidden(here === 0);
            shown += here;
            // A group with a match is open while the search is on; the reader's own choice comes back after it.
            if (fold) {
                group.section.el.open = filterText.trim() !== '' ? here > 0 : foldState.get(group.key) === true;
                group.section.el.classList.toggle('ss-section-fold-open', group.section.el.open === true);
            }
        }
        const searching = filterText.trim() !== '';
        const message = searching && shown === 0 ? fill(FORM_TEXT.none, { text: filterText.trim() }) : !searching && groups.size === 0 ? FORM_TEXT.noRows : '';
        empty.hidden = !message;
        empty.textContent = message;
        return shown;
    }

    const api = {
        el: root,
        /** Shows the tiles that match `text`; '' shows all. Returns how many are shown. */
        filter(text) {
            filterText = String(text ?? '');
            return paintVisibility();
        },
        /** Reads the store again (a switch flipped elsewhere, a module that came or went). Returns how many tiles are shown. */
        refresh: paint,
        /** The tile and switch of a feature, or undefined. */
        field: id => (tiles.has(id) ? { tile: tiles.get(id).tile, handle: tiles.get(id).handle, feature: tiles.get(id).feature } : undefined),
        group: moduleId => groups.get(moduleId)?.section.el,
        /** The focus to a module's group (its heading); false when there is none (or it is left out by a search). */
        focusGroup(moduleId) {
            const group = groups.get(moduleId);
            if (!group) return false;
            if (group.section.el.hidden) return false;
            if (fold) {
                group.section.el.open = true;
                group.section.el.classList.add('ss-section-fold-open');
                foldState.set(group.key, true);
            }
            return showAndFocus(group.section.heading);
        },
        setDisabled(on) {
            disabled = Boolean(on);
            for (const entry of tiles.values()) entry.handle.setDisabled(disabled || entry.feature.available === false);
        },
        keys: () => [...tiles.keys()],
        destroy() {
            for (const entry of tiles.values()) entry.handle.destroy();
            root.remove();
        },
    };
    paint();
    parent?.appendChild?.(root);
    return api;
}
