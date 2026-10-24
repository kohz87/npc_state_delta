// The Modules section's body (UI stage, step 3f): one card per installed module on the form engine's look, in place of the module folds
// and the Versions fold. A card is
//
// * the module's name and version, a short line on what it does (its `description`), and the line to its features
//   ("Features: 2 of 3 on — change", which goes to that module's group on the Features page);
// * its custom settings panels (`settings.section` / `render`) and its own folds (`settings.folds`), embedded as they were drawn in
//   the old fold: a module's own code draws them;
// * its settings drawn by the form engine from the registry's schema, a settings group each: sub-sections of the card, or, in a module
//   with many settings and more than one group, folds, the first one open (`FOLD_ABOVE`). The settings Story Block's own pages
//   draw (its General group: Money; its Assist group and panel: Assist; its Packs fold: Tabs & Packs) are not here.
//
// Versions is a small card at the end: Story Block and each module, with what is out of step (compat.js).
//
// Fold keys keep working: `<module id>` (the card, its heading focused), `<module id>::group:<name>` (that group, opened),
// `<module id>/<fold id>` (an own fold of the module) and the Versions fold.
//
// Built with createElement and textContent only: module names, versions and descriptions come from other extensions.

import { FEATURE_TEXT, SUB_FOLD, VERSIONS_FOLD, featuresFoldOf, groupFields } from '../../host-ui.js';
import { compatReport, renderCompat } from '../../compat.js';
import { featureOf } from '../../features.js';
import { fill } from '../../strings.js';
import { cutAt } from '../../../text.js';
import { newId, sectionBlock } from '../form/fields.js';
import { renderModuleForm } from '../form/form.js';
import { matchesSearch } from '../form/schema.js';
import { routeOf } from './sections.js';
import { showAndFocus } from '../scroll.js';

/** A module with more settings than this and more than one group folds its groups. */
export const FOLD_ABOVE = 6;
export const MODULES_TEXT = Object.freeze({
    versionsTitle: 'Versions',
    inStep: 'all in step',
    outOfStep: '{n} out of step',
    noDescription: '',
    panelFailed: 'This part of {name}\'s settings could not be shown: {why}',
});

// A module that does not say what it does (its `description`) gets a line here when it is one of Story Suite's own.
export const KNOWN_DESCRIPTIONS = Object.freeze({
    'story-block': 'The story\'s memory: the scene, the inventory and money, packs, and the two optional helpers.',
    'story-director': 'The game master: story time, quests, the world and its map, the chronicle and the story\'s arcs.',
    'npc-state-delta': 'How each person in the story feels about you: meters, stages and dossiers.',
});

const h = (doc, tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
const clean = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
// What other extensions give is shown cut: a name, a version, a description.
const CUT = Object.freeze({ name: 60, version: 40, description: 300 });
const clip = (value, max) => cutAt(clean(value), max);

/** A settings schema without the groups another page draws (`routeOf`): { schema, count, groups }. */
export function moduleSchema(moduleId, schema) {
    const out = {};
    let count = 0;
    const groups = [];
    for (const group of groupFields(schema)) {
        if (routeOf({ type: 'group', moduleId, group: group.name }) !== 'modules') continue;
        groups.push(group.name);
        for (const { key } of group.fields) {
            out[key] = schema[key];
            count += 1;
        }
    }
    return { schema: out, count, groups };
}

const parseGroup = key => {
    const at = typeof key === 'string' ? key.indexOf(`${SUB_FOLD}group:`) : -1;
    return at > 0 ? { id: key.slice(0, at), group: key.slice(at + `${SUB_FOLD}group:`.length) } : null;
};

/**
 * One module's card (the Modules page's, and the Diagnostics page's for a module whose settings are placed there). `env` is
 * { doc, registry, settings, sdk, features, openState, changed(), open(key) } (what the page was given); `sdef` the module's registry
 * settings entry or null; `placed`: 'diagnostics' draws a module whose settings are placed in Diagnostics (a Modules card leaves those
 * out); `collapsible` makes the card a fold (closed until opened; its state in `openState` under the module's id).
 * → { id, el, card, form, filter(text) → count, refresh(), destroy(), has(key), open(key), groups, folds }.
 */
export function createModuleCard(env, mod, sdef = null, { placed = null, collapsible = false } = {}) {
    const { doc, registry, settings, sdk = null, features = null, openState = null } = env;
    const featureList = () => { try { return typeof features?.list === 'function' ? features.list() : []; } catch { return []; } };
    const hiddenByFeature = item => {
        const id = featureOf(item);
        return id !== null && typeof registry.featureOn === 'function' && !registry.featureOn(id);
    };
    const here = Boolean(sdef) && (placed === 'diagnostics' ? sdef.place === 'diagnostics' : sdef.place !== 'diagnostics');
    const title = clip(mod.name, CUT.name) || clip(mod.id, CUT.name);
    const hint = clip(mod.version, CUT.version) ? `v${clip(mod.version, CUT.version)}` : '';
    let searching = false;
    const wasOpen = collapsible && openState instanceof Map ? openState.get(mod.id) === true : false;
    const card = sectionBlock(doc, { title, hint, id: newId(`module-${mod.id}`), collapsible, open: wasOpen });
    card.el.classList.add('ss-module-card');
    card.el.dataset.fold = mod.id;
    card.el.dataset.module = mod.id;
    // A fold's heading is its summary; a card's is its title.
    const heading = collapsible ? card.el.querySelector('summary') : card.title;
    if (!collapsible) card.title.tabIndex = -1;
    if (collapsible) {
        card.el.classList.add('ss-section-fold');
        card.el.classList.toggle('ss-section-fold-open', wasOpen);
        card.el.addEventListener('toggle', () => {
            card.el.classList.toggle('ss-section-fold-open', card.el.open === true);
            // A search opens the cards with a match: that is not the reader's choice, which comes back when the search ends.
            if (!searching && openState instanceof Map) openState.set(mod.id, card.el.open === true);
        });
    }
    const entry = { id: mod.id, mod, panelTitle: '', card, form: null, panel: null, panelBox: null, link: null, folds: [], groups: [], description: clip(mod.description || KNOWN_DESCRIPTIONS[mod.id], CUT.description) };
    if (entry.description) card.body.appendChild(h(doc, 'p', 'ss-card-help ss-module-description', entry.description));
    // The line to this module's features (their switches are on the Features page).
    entry.link = h(doc, 'button', 'ss-button ss-button-quiet ss-module-features');
    entry.link.type = 'button';
    entry.link.addEventListener('click', () => env.open?.(featuresFoldOf(mod.id)));
    card.body.appendChild(entry.link);
    entry.paintLink = () => {
        const list = featureList().filter(feature => feature.moduleId === mod.id);
        entry.link.hidden = !list.length;
        if (!list.length) return;
        const on = list.filter(feature => feature.on === true && feature.available !== false).length;
        entry.link.textContent = fill(FEATURE_TEXT.link, { on, n: list.length });
        entry.link.title = fill(FEATURE_TEXT.linkTitle, { name: mod.name ?? mod.id, on, n: list.length });
        entry.link.setAttribute('aria-label', entry.link.title);
    };
    entry.paintLink();
    if (here) {
        // Its custom panel (not a schema field: the module draws it), embedded as it was drawn in the fold, with its title as a heading.
        const panelApi = Object.freeze({
            get: key => settings(mod.id)[key],
            set: (key, value) => settings.set(mod.id, key, value),
            values: () => settings(mod.id),
            sdk,
        });
        if (sdef.section && (placed === 'diagnostics' || routeOf({ type: 'panel', moduleId: mod.id }) === 'modules')) {
            const box = h(doc, 'div', 'ss-module-panel');
            const heading4 = sdef.title !== (mod.name ?? mod.id) ? h(doc, 'h4', 'story-suite-section-title', sdef.title) : null;
            const section = h(doc, 'div', 'story-suite-section');
            section.dataset.module = mod.id;
            box.append(...[heading4, section].filter(Boolean));
            entry.panelBox = box;
            entry.panelTitle = sdef.title;
            // What the module's section function returned is its unmount (NPC State Delta returns one): it takes the module's own nodes
            // back out of the section. It runs before the section is cleared and again when the card goes, so the module finds its panel
            // in the page on the next draw instead of a node this card has detached.
            let release = null;
            const unmount = () => {
                const done = release;
                release = null;
                try { done?.(); } catch { /* a module's unmount that fails does not keep the card from drawing */ }
            };
            entry.release = unmount;
            entry.panel = () => {
                unmount();
                section.replaceChildren();
                box.hidden = hiddenByFeature(sdef.section);
                if (box.hidden) return;
                try {
                    const back = sdef.section(section, panelApi);
                    release = typeof back === 'function' ? back : null;
                } catch (error) {
                    section.replaceChildren(h(doc, 'p', 'story-suite-muted', fill(MODULES_TEXT.panelFailed, { name: mod.name ?? mod.id, why: error?.message ?? error })));
                }
            };
            entry.panel();
            card.body.appendChild(box);
        }
        // Its own folds (Story Block's Packs and Events are other pages'), each a sub-card with its title.
        if (placed === 'diagnostics' || routeOf({ type: 'own-fold', moduleId: mod.id }) === 'modules') {
            for (const item of sdef.folds ?? []) {
                if (item.place === 'diagnostics') continue;
                const sub = sectionBlock(doc, { title: item.title, hint: item.hint, id: newId(`own-${mod.id}-${item.id}`), level: 4 });
                sub.el.classList.add('ss-module-own');
                sub.el.dataset.fold = `${mod.id}/${item.id}`;
                sub.title.tabIndex = -1;
                try { item.render(sub.body, panelApi); } catch (error) {
                    sub.body.replaceChildren(h(doc, 'p', 'story-suite-muted', fill(MODULES_TEXT.panelFailed, { name: mod.name ?? mod.id, why: error?.message ?? error })));
                }
                entry.folds.push({ id: item.id, key: `${mod.id}/${item.id}`, sub, title: item.title, hint: item.hint ?? '' });
                card.body.appendChild(sub.el);
            }
        }
        // Its settings: a group each, folded when there are many.
        const { schema, count, groups } = moduleSchema(mod.id, sdef.schema);
        entry.groups = groups;
        if (count) {
            const fold = groups.length > 1 && count > FOLD_ABOVE ? { prefix: `${mod.id}::group:`, state: openState, openFirst: true } : null;
            entry.form = renderModuleForm(card.body, { ...sdef, schema, title: '' }, {
                settings, doc, quiet: true, className: 'ss-module-form', fold, featureOn: id => (typeof registry.featureOn === 'function' ? registry.featureOn(id) : true),
                onChange: () => env.changed?.(),
            });
        }
    }
    const nameHit = text => matchesSearch(`module.${mod.id}`, { label: `${clean(mod.name)} ${mod.id}`, help: entry.description }, '', text);
    Object.assign(entry, {
        el: card.el,
        /** Shows what matches `text` (the module's own name shows everything of it); returns how many matches it shows, 0 hides the card. */
        filter(text) {
            const query = String(text ?? '').trim();
            searching = Boolean(query);
            if (!query) {
                entry.form?.filter('');
                card.setHidden(false);
                for (const own of entry.folds) own.sub.setHidden(false);
                return 0;
            }
            const byName = nameHit(text);
            const rows = entry.form ? entry.form.filter(byName ? '' : text) : 0;
            const folds = entry.folds.filter(own => matchesSearch(own.key, { label: own.title, help: own.hint }, mod.name ?? mod.id, text));
            for (const own of entry.folds) own.sub.setHidden(!byName && !folds.includes(own));
            const panel = Boolean(entry.panelBox) && !entry.panelBox.hidden && matchesSearch(`${mod.id}${SUB_FOLD}panel`, { label: entry.panelTitle, help: '' }, mod.name ?? mod.id, text);
            const hit = byName || rows > 0 || folds.length > 0 || panel;
            card.setHidden(!hit);
            // A match opens a card that is a fold; the reader's own choice comes back with an empty search.
            if (collapsible && hit) card.el.open = true;
            return hit ? (byName ? Math.max(rows, 1) : rows) + folds.length + (panel ? 1 : 0) : 0;
        },
        refresh() {
            entry.paintLink();
            entry.panel?.();
            entry.form?.refresh();
        },
        destroy() {
            entry.release?.();
            entry.form?.destroy();
        },
        has(key) {
            if (key === mod.id) return true;
            const group = parseGroup(key);
            if (group) return group.id === mod.id && entry.groups.includes(group.group);
            return entry.folds.some(own => own.key === key);
        },
        open(key) {
            const group = parseGroup(key);
            if (collapsible) {
                card.el.open = true;
                card.el.classList.add('ss-section-fold-open');
                if (openState instanceof Map) openState.set(mod.id, true);
            }
            if (group) {
                const el = entry.form?.openGroup(group.group) ?? null;
                if (!el) return false;
                return showAndFocus(el.querySelector('summary') ?? el.querySelector('.ss-section-title, input, select, textarea, button'));
            }
            const own = entry.folds.find(item => item.key === key);
            if (own) return showAndFocus(own.sub.title);
            return key === mod.id ? showAndFocus(heading) : false;
        },
    });
    if (collapsible) {
        // Closing the search gives the card back as the reader left it.
        const restore = () => { card.el.open = openState instanceof Map ? openState.get(mod.id) === true : false; card.el.classList.toggle('ss-section-fold-open', card.el.open === true); };
        entry.restore = restore;
    }
    return entry;
}

/** The Modules body: `(pane, ctx) → { filter, refresh, destroy, has, open }` (bodies.js). */
export function modulesBody(pane, ctx) {
    const { doc } = ctx;
    const { registry } = ctx.options;
    const root = h(doc, 'div', 'ss-modules');
    pane.appendChild(root);
    const settingsOf = new Map((typeof registry.settingsDefs === 'function' ? registry.settingsDefs() : []).map(def => [def.moduleId, def]));
    const env = { ...ctx.options, doc, openState: ctx.openState, changed: () => ctx.changed?.(), open: key => ctx.open?.(key) };
    const cards = [];
    const mods = typeof registry.modules === 'function' ? registry.modules() : [];
    for (const mod of mods) {
        const entry = createModuleCard(env, mod, settingsOf.get(mod.id) ?? null, { collapsible: true });
        cards.push(entry);
        root.appendChild(entry.el);
    }

    // Versions: a small card at the end.
    const versions = sectionBlock(doc, { title: MODULES_TEXT.versionsTitle, id: newId('versions') });
    versions.el.classList.add('ss-versions-card');
    versions.el.dataset.fold = VERSIONS_FOLD;
    versions.title.tabIndex = -1;
    function paintVersions() {
        const report = compatReport({ hostVersion: registry.hostVersion?.() ?? '', modules: registry.modules(), refusals: registry.refusals?.() ?? [] });
        const hint = report.outOfStep ? fill(MODULES_TEXT.outOfStep, { n: report.outOfStep }) : MODULES_TEXT.inStep;
        // The hint sits in the head: rebuilt with the card's body.
        let note = versions.el.querySelector('.ss-section-hint');
        if (!note) {
            note = h(doc, 'small', 'ss-section-hint');
            versions.el.querySelector('.ss-section-head').appendChild(note);
        }
        note.textContent = hint;
        versions.el.classList.toggle('ss-versions-warn', report.outOfStep > 0);
        renderCompat(versions.body, report, { doc });
    }
    paintVersions();
    root.appendChild(versions.el);

    // A module whose settings are placed in Diagnostics is that page's: its card here says nothing of them and is not a fold target.
    const mine = key => !settingsOf.get(key)?.place || settingsOf.get(key).place !== 'diagnostics';
    return {
        filter(text) {
            const query = String(text ?? '').trim();
            let shown = 0;
            for (const entry of cards) {
                shown += entry.filter(text);
                if (!query) entry.restore?.();
            }
            const versionsHit = matchesSearch('versions', { label: MODULES_TEXT.versionsTitle, help: '' }, 'Modules', text);
            versions.setHidden(Boolean(query) && !versionsHit);
            return shown + (query && versionsHit ? 1 : 0);
        },
        refresh() {
            for (const entry of cards) entry.refresh();
            paintVersions();
        },
        destroy() {
            for (const entry of cards) entry.destroy();
            root.remove();
        },
        has(key) {
            if (key === VERSIONS_FOLD) return true;
            const group = parseGroup(key);
            const id = group ? group.id : cards.find(entry => entry.id === key || entry.has(key))?.id;
            return Boolean(id) && cards.some(entry => entry.id === id && mine(id) && entry.has(key));
        },
        open(key) {
            if (key === VERSIONS_FOLD) return showAndFocus(versions.title);
            const entry = cards.find(item => item.has(key));
            return entry ? entry.open(key) : false;
        },
    };
}
