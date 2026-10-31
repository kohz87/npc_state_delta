// The settings window (UI stage, steps 3a and 3b): Story Suite's settings in a glass window. A side column (the title, a
// search box over every section under it, and a rail of sections: the `ss.tabs` block with icon and label, one Tab stop,
// arrow keys along it, the current one `aria-current="page"`), Close at the window's top right, and the page of the chosen
// section. On a phone the side is stacked above the page and the rail is a row that scrolls sideways. What a page holds is
// its body (bodies.js): Look and Features are the form engine's; the others are still the folds and rows the old overlay
// drew, each in the section it belongs to, until the form engine takes them over one by one.
//
//   const win = openSettingsWindow({ registry, settings, doc, sdk, features, promptParts, countTokens, diagnostics,
//                                     tabs, theme, fold: PACKS_FOLD, onClose });
//   win.select('money');  win.refresh();  win.refreshSize();  win.close();  win.isOpen();  win.root;
//
// `fold` opens the window on the section that holds that fold, the fold open and its summary focused (Home's "Import a
// pack" asks for PACKS_FOLD); a module's group of features (`story-suite-features::<id>`, or the old `<id>::features`) is
// on the Features page, its heading focused. `bodies` replaces the section → body map (tests, and a section moved to the form
// engine). `extraSections` adds sections of a module that is on only sometimes (the RPG's page): each is a section record plus
// `after` (the id it follows in the rail), `body` (as a body above) and `visible()` (false: it is left out of the rail, the search
// and the pages until it says true again, which `refresh()` re-reads). The window is a modal dialog: `<body>` carries `story-suite-open`, Tab stays inside it, a click or the
// focus going to the page behind brings the focus back, Escape closes it (while the search box holds text, Escape
// empties it first), and the focus goes back to where it was. Search: typing filters every section at once, a page
// with no match is left out, the rail shows how many each page has, and the count is said in a polite live region
// (the form engine's words: "3 settings shown", "No settings match …"). Choosing a section ends the search.
//
// Every node is built with createElement and textContent (security tests forbid markup APIs in view code).

import { DIAGNOSTICS_FOLD, OPEN_CLASS, SUB_FOLD, diagnosticsKeys, featuresFoldOf } from '../../host-ui.js';
import { fill } from '../../strings.js';
import { createFooter } from './footer.js';
import { PROMPT_FOLD, createPromptReader } from './prompt.js';
import { FORM_TEXT } from '../form/schema.js';
import { searchField } from '../form/fields.js';
import { followViewport, holdPage, revealIn } from '../scroll.js';
import { stackOf } from '../modal-stack.js';
import { tabs as tabsBlock } from '../widgets/nav.js';
import { SECTION_BODIES, createLegacySettings } from './bodies.js';
import { DEFAULT_SECTION, SETTINGS_SECTIONS, WINDOW_TEXT } from './sections.js';

export const WINDOW_ID = 'story_suite_v2_overlay';
const TITLE_ID = `${WINDOW_ID}_title`;
const FOCUSABLE = 'button, input, select, textarea, a[href], summary, [tabindex]';

const h = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};

// A node the reader can reach now: not hidden, not behind a closed fold, not taken out of the Tab order.
function reachable(node, root) {
    if (node.disabled || node.getAttribute?.('tabindex') === '-1') return false;
    for (let n = node; n && n !== root; n = n.parentNode) {
        if (n.hidden) return false;
        const parent = n.parentNode;
        if (parent?.tagName === 'DETAILS' && !parent.open && n.tagName !== 'SUMMARY') return false;
    }
    return true;
}
const focusablesIn = root => Array.from(root.querySelectorAll(FOCUSABLE)).filter(node => reachable(node, root));

// One window at a time; the folds stay as the reader left them when it is opened again (this page load).
let current = null;
const windowOpenState = new Map();

/** Opens the settings window on `doc.body` (closing one already open). `profiles()` is the Connection Manager's list for the profile selects (default: read from SillyTavern). Returns { root, window, refresh, refreshSize, select, section, isOpen, close }. */
export function openSettingsWindow({ registry, settings, doc = globalThis.document, sdk = null, features = null, promptParts = null, countTokens = null, diagnostics = null, tabs = null, theme = null, profiles = null, blockTemplates = null, fold: target = null, openState = windowOpenState, onClose = null, bodies = SECTION_BODIES, extraSections = [] }) {
    if (current?.root?.ownerDocument === doc) current.close();
    doc.querySelector?.(`#${WINDOW_ID}`)?.remove();

    // ---- the frame
    const layer = h(doc, 'div', 'story-suite-overlay');
    layer.id = WINDOW_ID;
    const win = h(doc, 'div', 'ss-settings');
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-labelledby', TITLE_ID);
    // Close sits at the window's top right on every width; the side column holds the title, the search and the rail.
    const close = h(doc, 'button', 'ss-settings-close story-suite-close');
    close.type = 'button';
    close.setAttribute('aria-label', WINDOW_TEXT.close);
    close.title = WINDOW_TEXT.close;
    const times = h(doc, 'span', '', '×');
    times.setAttribute('aria-hidden', 'true');
    close.appendChild(times);
    const side = h(doc, 'div', 'ss-settings-side');
    const title = h(doc, 'h2', 'ss-settings-title', WINDOW_TEXT.title);
    title.id = TITLE_ID;
    const searchBox = searchField(doc, { label: WINDOW_TEXT.searchLabel, placeholder: WINDOW_TEXT.searchPlaceholder, onInput: text => applySearch(text) });
    searchBox.el.classList.add('ss-settings-search');
    const rail = h(doc, 'div', 'ss-settings-rail');
    side.append(title, searchBox.el, rail);
    const content = h(doc, 'div', 'ss-settings-content');
    const status = h(doc, 'p', 'ss-form-status ss-settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const empty = h(doc, 'p', 'ss-form-empty');
    empty.hidden = true;
    content.append(status, empty);
    win.append(close, side, content);
    layer.appendChild(win);
    doc.body.appendChild(layer);
    doc.body.classList.add(OPEN_CLASS);
    // Nothing behind or around the page may scroll (a phone's browser scrolls the fixed layer, the document and its visual viewport to
    // show a focused box): the document is held, a script's scroll on the layer or window is undone, and on a phone the layer follows
    // the visible area (the on-screen keyboard shrinks it). Only the page scroller moves (scroll.js).
    const releasePage = holdPage(doc);
    const stopViewport = followViewport(doc, layer);
    const pin = node => () => { if (node.scrollTop) node.scrollTop = 0; if (node.scrollLeft) node.scrollLeft = 0; };
    const pinLayer = pin(layer);
    const pinWindow = pin(win);
    layer.addEventListener('scroll', pinLayer);
    win.addEventListener('scroll', pinWindow);

    // ---- the pages: a heading, then the body's pane
    // The sections in rail order: the fixed ones, with each extra section after the one it names.
    const sections = [...SETTINGS_SECTIONS];
    for (const extra of extraSections) sections.splice(Math.max(0, sections.findIndex(item => item.id === extra.after) + 1) || sections.length, 0, extra);
    const sectionIds = sections.map(section => section.id);
    const shown = section => typeof section.visible !== 'function' || section.visible() !== false;
    const pages = new Map();
    for (const section of sections) {
        const page = h(doc, 'section', 'ss-settings-page');
        page.dataset.ssSection = section.id;
        page.hidden = true;
        const heading = h(doc, 'div', 'ss-settings-page-head');
        const name = h(doc, 'h3', 'ss-settings-page-title', section.title);
        name.id = `${WINDOW_ID}_${section.id}_title`;
        page.setAttribute('aria-labelledby', name.id);
        heading.append(name, h(doc, 'p', 'ss-settings-page-sub', section.sub));
        const pane = h(doc, 'div', 'ss-settings-pane story-suite-folds');
        page.append(heading, pane);
        content.appendChild(page);
        pages.set(section.id, { section, page, pane, body: null, count: 0 });
    }

    // ---- the rail
    let chosen = DEFAULT_SECTION;
    let searchText = '';
    let railBlock = null;
    const railItems = () => sections.filter(shown).map(section => ({ id: section.id, label: section.label, icon: section.icon, count: searchText.trim() && pages.get(section.id).count ? String(pages.get(section.id).count) : '' }));
    const railProps = () => ({ items: railItems(), current: chosen, label: WINDOW_TEXT.railLabel, onSelect: 'settings.section' });
    railBlock = tabsBlock.render(rail, railProps(), { command: (type, payload) => { if (type === 'settings.section') select(payload?.tabs); } });

    // ---- the bodies
    // One reader of the prompt's size for the Prompt card and the footer bar, so both always say the same.
    const reader = createPromptReader({ registry, settings, promptParts, countTokens });
    const options = { registry, settings, doc, sdk, features, promptParts, countTokens, openState, diagnostics, tabs, theme, profiles, blockTemplates, reader };
    const legacy = createLegacySettings(options);
    // The footer bar: what is sent each reply against its budget; pressing it opens the Prompt card. Declared before the bodies (their
    // `changed()` refreshes it) and shown after them.
    let footer = null;
    for (const id of sectionIds) {
        const entry = pages.get(id);
        const make = bodies[id] ?? sections.find(section => section.id === id)?.body;
        if (typeof make !== 'function') continue;
        // `changed()`: a setting this page drew changed and other pages draw what depends on it, so they are drawn again.
        const changed = () => {
            legacy.refresh();
            for (const other of pages.values()) if (other !== entry) other.body?.refresh?.();
            footer?.refresh();
        };
        entry.body = make(entry.pane, { doc, openState, label: entry.section.label, legacy, options, changed, open: key => { if (open) openFold(key); } });
    }

    footer = createFooter(doc, { reader, onOpen: () => openFold(PROMPT_FOLD) });
    win.appendChild(footer.el);

    // ---- showing a page
    function paint() {
        const searching = searchText.trim() !== '';
        if (!shown(pages.get(chosen).section)) chosen = DEFAULT_SECTION;
        for (const entry of pages.values()) entry.page.hidden = !shown(entry.section) || (searching ? !entry.count : entry.section.id !== chosen);
        railBlock.update(railProps());
        // A page that is shown tells its body (Diagnostics builds its report the first time).
        for (const entry of pages.values()) if (!entry.page.hidden) entry.body?.show?.();
    }
    function select(id) {
        chosen = sectionIds.includes(id) && shown(pages.get(id).section) ? id : DEFAULT_SECTION;
        if (searchText !== '') searchBox.clear();   // choosing a section ends the search (its onInput repaints)
        else paint();
        content.scrollTop = 0;
        return chosen;
    }

    // ---- search
    function applySearch(text) {
        searchText = String(text ?? '');
        const query = searchText.trim();
        let total = 0;
        for (const entry of pages.values()) {
            const found = entry.body?.filter?.(searchText);
            entry.count = Number.isFinite(found) && shown(entry.section) ? found : 0;
            total += query ? entry.count : 0;
        }
        status.hidden = !query;
        status.textContent = query && total ? (total === 1 ? FORM_TEXT.shownOne : fill(FORM_TEXT.shown, { n: total })) : '';
        empty.hidden = !(query && total === 0);
        empty.textContent = query && total === 0 ? fill(FORM_TEXT.none, { text: query }) : '';
        paint();
        content.scrollTop = 0;
    }

    // ---- Escape, Tab and the focus: the window is a layer of the shared stack (modal-stack.js). Escape closes it unless a field
    // in it takes the key first (the search box empties itself); Tab stays in it; a focus that lands on the page comes back in.
    let open = true;
    const modal = stackOf(doc).push({ name: 'settings', root: win, onEscape: () => { api.close(); return true; } });
    // A click on the dimmed page beside the window closes it, but a drag that starts inside (selecting text) and ends
    // outside does not.
    let pressedOnLayer = false;
    layer.addEventListener('mousedown', event => { pressedOnLayer = event.target === layer; });
    layer.addEventListener('click', event => { if (event.target === layer && pressedOnLayer) api.close(); });
    close.addEventListener('click', () => api.close());

    const api = {
        root: layer,
        window: win,
        refresh() {
            legacy.refresh();
            for (const entry of pages.values()) entry.body?.refresh?.();
            footer.refresh();
            // A section that came or went (the RPG's page, with its feature): the rail and the page shown follow.
            paint();
        },
        // The story moved (a new head, a commit, a turn): the prompt's size is read again, nothing else.
        refreshSize() {
            for (const entry of pages.values()) entry.body?.refreshSize?.();
            footer.refresh();
        },
        footer: () => footer,
        select,
        section: () => chosen,
        isOpen: () => open,
        close() {
            if (!open) return;
            open = false;
            if (current === api) current = null;
            stackOf(doc).pop(modal);
            releasePage();
            stopViewport();
            layer.removeEventListener('scroll', pinLayer);
            win.removeEventListener('scroll', pinWindow);
            for (const entry of pages.values()) { try { entry.body?.destroy?.(); } catch { /* closed either way */ } }
            railBlock.destroy();
            footer.destroy();
            layer.remove();
            doc.body.classList.remove(OPEN_CLASS);
            try { onClose?.(); } catch { /* the window is closed either way */ }
        },
    };
    current = api;

    // ---- opening on a fold
    // A module's old "<id>::features" sub-fold is its sub-fold of the Features fold now.
    let wanted = typeof target === 'string' && target ? target : null;
    if (wanted?.endsWith(`${SUB_FOLD}features`)) wanted = featuresFoldOf(wanted.slice(0, -`${SUB_FOLD}features`.length));
    if (wanted) {
        openState.set(wanted, true);
        // A sub-fold opens its module's fold too, and one placed in Diagnostics opens Diagnostics.
        if (wanted.includes(SUB_FOLD)) openState.set(wanted.split(SUB_FOLD)[0], true);
        if (diagnosticsKeys(registry).includes(wanted)) openState.set(DIAGNOSTICS_FOLD, true);
    }
    // Shows the page that holds a fold (a body's own group, or one of today's folds) and takes the focus to it. False when
    // no page has it, or the page could not take the focus.
    const legacyFold = key => [...content.querySelectorAll('details.story-suite-fold, details.story-suite-subfold')].find(node => node.dataset.fold === key) ?? null;
    function openFold(key) {
        const own = [...pages.values()].find(entry => entry.body?.has?.(key));
        if (own) {
            select(own.section.id);
            return own.body.open?.(key) === true;
        }
        const node = legacyFold(key);
        const owner = node ? [...pages.values()].find(entry => entry.pane.contains(node)) : null;
        if (!node || !owner) return false;
        select(owner.section.id);
        revealIn(content, node, 'start');
        node.querySelector('summary')?.focus?.({ preventScroll: true });
        return true;
    }
    legacy.start(content, {
        show: id => { if (open) select(id); },
        open: key => { if (open) openFold(key); },
        afterRefresh: () => { if (searchText !== '') applySearch(searchText); },
    });
    select(DEFAULT_SECTION);
    if (!(wanted && openFold(wanted))) (rail.querySelector('[aria-current="page"]') ?? focusablesIn(win)[0])?.focus?.({ preventScroll: true });
    return api;
}
