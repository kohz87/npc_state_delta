// The Story Block card: one tab strip + one panel under the latest assistant message.
//
// The card can also wear Megumin Suite's class names (compatMarkup). Extensions that
// already know how to add a tab to Megumin's card — NPC State Delta's "Present NPCs" —
// then find our card, put their tab before our collapse button and their pane in our
// panel, and switch between their pane and ours by toggling `active`, inline
// `style.display` and `meg-blocks-shut`. Everything below keeps to those three levers
// so both sides read the same DOM state; nothing is kept only in a closure.
//
// Mounting/scheduling (which message, when) belongs to the runtime. This module only
// builds and reconciles the card it is handed a message for.

import { button, el, normalizeTabs, stop } from './dom.js';

const CLASS = {
    card: 'story-block-card',
    tabs: 'story-block-tabs',
    tab: 'story-block-tab',
    panel: 'story-block-panel',
    pane: 'story-block-pane',
    collapse: 'story-block-collapse',
    shut: 'story-block-shut',
    icon: 'story-block-tab-icon',
    label: 'story-block-tab-label',
};

const COMPAT = {
    card: 'meg-blocks',
    tabs: 'meg-blocks-tabs',
    tab: 'meg-blocks-tab',
    panel: 'meg-blocks-panel',
    pane: 'meg-block-body',
    collapse: 'meg-blocks-collapse',
    shut: 'meg-blocks-shut',
    icon: 'meg-blocks-tab-emoji',
    label: 'meg-blocks-tab-label',
};

// Selected tab and collapsed state per uiKey. The live DOM wins whenever a card
// exists (another extension may have changed it); this map carries the state over
// to the card built for the next message.
const viewByKey = new Map();

function viewFor(uiKey) {
    const key = String(uiKey ?? 'default');
    if (!viewByKey.has(key)) viewByKey.set(key, { selected: null, collapsed: false });
    return viewByKey.get(key);
}

function isCompat(card) {
    return card.classList.contains(COMPAT.card);
}

// A compat card is collapsed by `meg-blocks-shut` alone, because that is the class
// NPC State Delta adds and removes. A plain card uses our own class.
function shutClass(card) {
    return isCompat(card) ? COMPAT.shut : CLASS.shut;
}

function isShut(card) {
    return card.classList.contains(shutClass(card));
}

function classes(compat, key) {
    return compat ? `${CLASS[key]} ${COMPAT[key]}` : CLASS[key];
}

function childrenOf(node) {
    return [...(node?.children ?? [])];
}

function partsOf(card) {
    const strip = childrenOf(card).find(node => node.classList.contains(CLASS.tabs)) ?? null;
    const panel = childrenOf(card).find(node => node.classList.contains(CLASS.panel)) ?? null;
    const collapse = childrenOf(strip).find(node => node.classList.contains(CLASS.collapse)) ?? null;
    return { strip, panel, collapse };
}

const ownTabs = strip => childrenOf(strip).filter(node => node.classList.contains(CLASS.tab));
const ownPanes = panel => childrenOf(panel).filter(node => node.classList.contains(CLASS.pane));
// Anything another extension put in our strip/panel.
const foreignTabs = strip => childrenOf(strip).filter(node => !node.classList.contains(CLASS.tab) && !node.classList.contains(CLASS.collapse));
const foreignPanes = panel => childrenOf(panel).filter(node => !node.classList.contains(CLASS.pane));

function domId(id) {
    return `story-block-pane-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function hostOf(messageElement) {
    return messageElement.querySelector?.('.mes_block') ?? messageElement;
}

/** Record what the card on screen shows right now (it may have been changed by others). */
function syncView(card) {
    const view = viewFor(card.dataset.uiKey);
    view.collapsed = isShut(card);
    const { strip } = partsOf(card);
    const active = ownTabs(strip).find(tab => tab.classList.contains('active'));
    if (active) view.selected = active.dataset.tabId;
    return view;
}

/**
 * Show one of our panes, or leave a foreign one showing.
 * `forceOwn` is set when the reader picked one of our controls: then a foreign tab
 * that is still marked active loses, exactly as clicking a native Megumin tab would.
 */
function applySelection(card, { forceOwn = false } = {}) {
    const view = viewFor(card.dataset.uiKey);
    const { strip, panel, collapse } = partsOf(card);
    const tabs = ownTabs(strip);
    const panes = ownPanes(panel);
    if (!tabs.some(tab => tab.dataset.tabId === view.selected)) view.selected = tabs[0]?.dataset.tabId ?? null;

    card.classList.toggle(shutClass(card), view.collapsed);
    const open = !view.collapsed;
    const foreignActive = !forceOwn && foreignTabs(strip).some(tab => tab.classList.contains('active'));

    for (const tab of tabs) {
        const active = !foreignActive && tab.dataset.tabId === view.selected;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-expanded', String(active && open));
    }
    for (const pane of panes) {
        pane.style.display = !foreignActive && pane.dataset.tabId === view.selected ? '' : 'none';
    }
    if (!foreignActive) {
        for (const pane of foreignPanes(panel)) pane.style.display = 'none';
        for (const tab of foreignTabs(strip)) {
            tab.classList.remove('active');
            if (tab.hasAttribute?.('aria-expanded')) tab.setAttribute('aria-expanded', 'false');
        }
    }
    if (collapse) {
        collapse.setAttribute('aria-expanded', String(open));
        collapse.title = open ? 'Collapse' : 'Expand';
        collapse.setAttribute('aria-label', collapse.title);
    }
}

function setCollapsed(card, collapsed) {
    const view = viewFor(card.dataset.uiKey);
    view.collapsed = collapsed;
    if (collapsed) {
        card.classList.add(shutClass(card));
        const { strip, collapse } = partsOf(card);
        ownTabs(strip).forEach(tab => tab.setAttribute('aria-expanded', 'false'));
        if (collapse) {
            collapse.setAttribute('aria-expanded', 'false');
            collapse.title = 'Expand';
            collapse.setAttribute('aria-label', 'Expand');
        }
    } else {
        applySelection(card, { forceOwn: true });
    }
}

function createCard(compat, uiKey) {
    const card = el('div', classes(compat, 'card'));
    card.dataset.uiKey = String(uiKey);
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Story Block');
    const strip = el('div', classes(compat, 'tabs'));
    const panel = el('div', classes(compat, 'panel'));
    // Not `meg-blocks-tab`: NPC State Delta deactivates every `.meg-blocks-tab` but its own
    // and must never treat the collapse control as a tab.
    const collapse = button(classes(compat, 'collapse'), { title: 'Collapse', icon: 'fa-chevron-down' });
    collapse.setAttribute('aria-expanded', 'true');
    // NPC State Delta clicks this control to drive the card to its shut state before it
    // opens its own pane (once, or twice when the first click re-opened the card), so a
    // click must be a plain toggle of the shut class.
    collapse.addEventListener('click', stop(() => setCollapsed(card, !isShut(card))));
    strip.appendChild(collapse);
    card.append(strip, panel);
    return card;
}

function createTab(card, compat, id) {
    const tab = el('button', classes(compat, 'tab'));
    tab.type = 'button';
    tab.dataset.tabId = id;
    tab.setAttribute('aria-controls', domId(id));
    tab.append(el('span', classes(compat, 'icon')), el('span', classes(compat, 'label')));
    tab.addEventListener('click', stop(() => {
        const { panel } = partsOf(card);
        const pane = ownPanes(panel).find(node => node.dataset.tabId === tab.dataset.tabId);
        const open = tab.classList.contains('active') && !isShut(card) && pane?.style.display !== 'none';
        // Clicking the open tab folds the card, as Megumin's and NPC State Delta's tabs do.
        if (open) return setCollapsed(card, true);
        viewFor(card.dataset.uiKey).selected = tab.dataset.tabId;
        setCollapsed(card, false);
    }));
    return tab;
}

function updateTab(tab, { label, icon }) {
    const text = String(label ?? '').trim() || tab.dataset.tabId;
    const [iconNode, labelNode] = childrenOf(tab);
    // Only touch what changed: hosts observe the chat for mutations.
    if (iconNode && iconNode.textContent !== String(icon ?? '')) iconNode.textContent = String(icon ?? '');
    if (labelNode && labelNode.textContent !== text) labelNode.textContent = text;
    if (tab.title !== text) {
        tab.title = text;
        tab.setAttribute('aria-label', text);
    }
}

function createPane(compat, id) {
    const pane = el('div', classes(compat, 'pane'));
    pane.dataset.tabId = id;
    pane.id = domId(id);
    pane.style.display = 'none';
    return pane;
}

function renderPane(pane, tab) {
    const key = typeof tab.key === 'string' ? tab.key : null;
    if (key !== null && pane.dataset.contentKey === key) return;
    try {
        // render() owns the pane's content and replaces it itself; clearing it here first
        // would detach a focused filter input before the display could restore it.
        tab.render(pane);
        if (key !== null) pane.dataset.contentKey = key;
        else delete pane.dataset.contentKey;
    } catch (error) {
        delete pane.dataset.contentKey;
        pane.replaceChildren(el('div', 'story-block-notice is-error', `${tab.label || tab.id} could not be shown: ${error?.message ?? error}`));
        console.error('[Story Block] tab render failed', tab.id, error);
    }
}

// Reorder our tabs in place, moving a node only when it is out of order, so focus
// and observers are left alone on an ordinary re-render.
function placeTabs(strip, ordered) {
    let cursor = strip.firstElementChild ?? childrenOf(strip)[0] ?? null;
    for (const tab of ordered) {
        if (cursor === tab) cursor = tab.nextElementSibling ?? null;
        else strip.insertBefore(tab, cursor);
    }
}

/**
 * Mount (or update) the card at the end of the message's `.mes_block`.
 * Re-mounting keeps the selected tab and collapsed state, and leaves panes whose
 * `key` is unchanged untouched (their scroll position and focus survive).
 * Returns the card, or null when there is nothing to show.
 */
export function mountCard(messageElement, tabs, { uiKey = 'default', compatMarkup = true } = {}) {
    if (!messageElement) return null;
    const key = String(uiKey ?? 'default');
    const compat = Boolean(compatMarkup);
    const list = normalizeTabs(tabs);
    const host = hostOf(messageElement);
    const doc = messageElement.ownerDocument ?? globalThis.document;

    let card = childrenOf(host).find(node => node.classList.contains(CLASS.card)) ?? null;
    if (card && (card.dataset.uiKey !== key || isCompat(card) !== compat)) {
        if (card.dataset.uiKey === key) syncView(card);
        card.remove();
        card = null;
    }
    // One card in the chat: cards under older messages go, after handing over their state.
    const others = [...(doc?.querySelectorAll?.(`.${CLASS.card}`) ?? [])].filter(node => node !== card);
    for (const other of others) {
        if (other.dataset.uiKey === key) syncView(other);
        other.remove();
    }

    if (!list.length) {
        if (card) {
            syncView(card);
            card.remove();
        }
        return null;
    }

    const fresh = !card;
    if (card) syncView(card);
    else card = createCard(compat, key);

    const { strip, panel } = partsOf(card);
    const wanted = new Set(list.map(tab => tab.id));
    for (const node of [...ownTabs(strip), ...ownPanes(panel)]) {
        if (!wanted.has(node.dataset.tabId)) node.remove();
    }
    const tabById = new Map(ownTabs(strip).map(node => [node.dataset.tabId, node]));
    const paneById = new Map(ownPanes(panel).map(node => [node.dataset.tabId, node]));

    const ordered = [];
    for (const tab of list) {
        const tabButton = tabById.get(tab.id) ?? createTab(card, compat, tab.id);
        updateTab(tabButton, tab);
        ordered.push(tabButton);
        let pane = paneById.get(tab.id);
        if (!pane) {
            pane = createPane(compat, tab.id);
            panel.appendChild(pane);
        }
        renderPane(pane, tab);
    }
    placeTabs(strip, ordered);
    applySelection(card);
    if (fresh) host.appendChild(card);
    return card;
}

/** Remove every Story Block card under `root`, keeping its state for the next mount. */
export function unmountCard(root = globalThis.document) {
    for (const card of [...(root?.querySelectorAll?.(`.${CLASS.card}`) ?? [])]) {
        syncView(card);
        card.remove();
    }
}

/**
 * External tabs other extensions register through the runtime's API. The runtime
 * merges `list(ctx)` with the block tabs and wraps each `render(pane, ctx)`.
 * Order: ascending `order` (default 100), then registration order.
 */
export function createTabRegistry({ onChange } = {}) {
    const tabs = new Map();
    let sequence = 0;
    const changed = () => {
        try { onChange?.(); } catch (error) { console.error('[Story Block] tab registry listener failed', error); }
    };

    function unregister(id) {
        const removed = tabs.delete(String(id ?? '').trim());
        if (removed) changed();
        return removed;
    }

    function register(tab) {
        const id = String(tab?.id ?? '').trim();
        if (!id) throw new TypeError('A Story Block tab needs an id.');
        if (typeof tab.render !== 'function') throw new TypeError(`Story Block tab "${id}" needs a render(pane, ctx) function.`);
        const order = Number.isFinite(Number(tab.order)) && tab.order !== null && tab.order !== '' ? Number(tab.order) : 100;
        const previous = tabs.get(id);
        tabs.set(id, {
            ...tab,
            id,
            label: String(tab.label ?? '').trim() || id,
            // (0.9.18) The rail's label, when the full one is long ("Present NPCs" → "Cast").
            short: String(tab.short ?? '').trim().slice(0, 12),
            icon: String(tab.icon ?? ''),
            order,
            sequence: previous?.sequence ?? sequence++,
        });
        changed();
        return () => unregister(id);
    }

    /** Registered tabs in order; with `ctx`, only those whose isAvailable(ctx) is true. */
    function list(ctx) {
        const all = [...tabs.values()].sort((a, b) => a.order - b.order || a.sequence - b.sequence);
        if (ctx === undefined) return all;
        return all.filter(tab => {
            if (typeof tab.isAvailable !== 'function') return true;
            try { return Boolean(tab.isAvailable(ctx)); } catch (error) {
                console.error('[Story Block] isAvailable failed', tab.id, error);
                return false;
            }
        });
    }

    return { register, unregister, list };
}
