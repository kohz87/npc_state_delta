// Tree display for rows blocks: Inventory Block's browser (v0.6), generalised.
//
// Category tree with grouped item lists on wide panes, drill-down lists with
// breadcrumb, back button and sibling chips on narrow ones (style.css decides which
// via container queries; both are always in the DOM), a whole-tree filter, and a
// change strip against the previous state. Column labels, depth and wording come
// from the block definition instead of Inventory's hard-coded ones.

import { ROOT_CATEGORY, diff as diffRows, gainsOf, isEmpty as rowsEmpty, normalizeRows } from '../../formats/rows.js';
import {
    DEFAULT_MAX_DEPTH,
    ROOT_NODE_ID,
    ancestorIds,
    buildTree,
    clampDepth,
    groupItems,
    itemKeyFor,
    nodeIdForCategory,
    parentId,
    resolveNode,
    searchItems,
} from '../../formats/tree.js';
import { blockName, button, el, emptyText, noun, plural, renderEmpty, renderFrame, stop, unitWord } from '../dom.js';
import { render as renderPlain } from './plain.js';

const FALLBACK_COLUMNS = ['Item', 'Qty', 'Note'];
// (0.9.18) Up to this many rows, All lists them all instead of a row per section.
export const SHORT_LIST = 20;

// (0.9.18) The rarity a note names, as a class other extensions can use too: "story-block-rarity
// is-uncommon". The first word wins; "uncommon" is not read as "common".
const RARITY = /(?<![\p{L}])(uncommon|common|rare|epic|legendary)(?![\p{L}])/iu;
export function rarityClass(text) {
    const word = RARITY.exec(String(text ?? ''))?.[1]?.toLowerCase();
    return word ? `story-block-rarity is-${word}` : '';
}
const viewStateByKey = new Map();

function viewState(uiKey) {
    const key = String(uiKey ?? 'default');
    if (!viewStateByKey.has(key)) {
        viewStateByKey.set(key, { selected: ROOT_NODE_ID, expanded: new Set(), query: '', changesOpen: false });
    }
    return viewStateByKey.get(key);
}

function columnsOf(def) {
    const columns = Array.isArray(def?.columns) ? def.columns : [];
    return FALLBACK_COLUMNS.map((fallback, index) => String(columns[index] ?? '').trim() || fallback);
}

function itemCount(state) {
    return state.categories.reduce((sum, category) => sum + category.items.length, 0);
}

const crumbPath = path => String(path ?? '').replaceAll(' > ', ' › ');

export function formatQuantity(quantity) {
    const value = String(quantity ?? '').trim();
    return /^\d+(\.\d+)?$/.test(value) ? `×${value}` : value;
}

function describeValues(item) {
    return [formatQuantity(item?.quantity), item?.remark].filter(Boolean).join(' ') || '—';
}

/** One line per change, as Inventory Block wrote them. Uses the rows Change fields. */
export function describeChange(change) {
    const qty = value => (value?.quantity ? ` ${formatQuantity(value.quantity)}` : '');
    const name = change.label;
    switch (change.type) {
        case 'added': return `+ ${name}${qty(change.after)}`;
        case 'removed': return `− ${name}${qty(change.before)}`;
        case 'moved': return `↪ ${name} → ${crumbPath(change.path || ROOT_CATEGORY)}`;
        default: {
            const before = change.before ?? {};
            const after = change.after ?? {};
            const parts = [];
            if (change.before && change.after) {
                if (before.quantity !== after.quantity) parts.push(`${formatQuantity(before.quantity) || '—'} → ${formatQuantity(after.quantity) || '—'}`);
                if (before.remark !== after.remark) parts.push(`${before.remark || '—'} → ${after.remark || '—'}`);
            } else if (change.from !== undefined || change.to !== undefined) {
                parts.push(`${change.from || '—'} → ${change.to || '—'}`);
            }
            return `~ ${name}: ${parts.join(', ') || describeValues(after)}`;
        }
    }
}

function isRowsState(state) {
    return Boolean(state) && Array.isArray(state.categories);
}

export function render(pane, {
    def,
    state,
    previousState = null,
    changes = null,
    error = null,
    truncated = false,
    onEdit = null,
    uiKey = null,
    changesFromEarlierReply = false,
    onLeave = null,
} = {}) {
    // A non-rows state (display changed to Tree on a text/fields block) still reads.
    if (state && !isRowsState(state)) {
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }

    const name = blockName(def);
    const columns = columnsOf(def);
    const maxDepth = clampDepth(def?.maxDepth ?? DEFAULT_MAX_DEPTH);
    const rows = normalizeRows(state ?? { categories: [] });
    const view = viewState(uiKey ?? def?.id);

    // A refresh can land while the filter is being typed in; keep focus and caret.
    const active = document.activeElement;
    const typing = active?.classList?.contains('story-block-tree-search-input') && pane.contains(active)
        ? { start: active.selectionStart, end: active.selectionEnd }
        : null;
    // Content changes rebuild the pane; keep the reader's place in the lists.
    const scrolled = ['.story-block-tree-browser', '.story-block-tree-nav', '.story-block-tree-main']
        .map(selector => [selector, pane.querySelector(selector)?.scrollTop ?? 0]);

    const count = itemCount(rows);
    renderFrame(pane, {
        def, error, truncated, onEdit,
        display: 'tree',
        summary: state ? unitWord(columns[0], count) : '',
    });

    if (!state || rowsEmpty(rows)) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }

    const tree = buildTree(rows, { maxDepth });
    const changeList = Array.isArray(changes) ? changes : (previousState ? diffRows(previousState, rows) : []);
    const changedNodes = new Set();
    const changedItems = new Map();
    for (const change of changeList) {
        for (const category of [change.path, change.previousPath]) {
            if (category === undefined || category === null) continue;
            ancestorIds(nodeIdForCategory(category, maxDepth)).forEach(id => changedNodes.add(id));
        }
        if (change.type !== 'removed' && change.label) changedItems.set(itemKeyFor(change.path ?? ROOT_CATEGORY, change.label), change.type);
    }

    const search = el('div', 'story-block-tree-search');
    const input = el('input', 'text_pole story-block-tree-search-input');
    input.type = 'search';
    input.placeholder = `Filter ${noun(columns[0])}…`;
    input.setAttribute('aria-label', `Filter ${name}`);
    input.value = view.query;
    search.appendChild(input);
    pane.appendChild(search);

    const browser = el('div', 'story-block-tree-browser');

    const select = (id, { focus = false } = {}) => {
        view.selected = id;
        ancestorIds(id).forEach(ancestor => view.expanded.add(ancestor));
        if (view.query) {
            view.query = '';
            input.value = '';
        }
        renderBrowser(focus ? id : null);
    };

    // (0.9.18) What the latest reply found, kept unless the reader leaves it: one chip each.
    // (0.9.22) In the "Changed this turn" row itself, in place of its preview, so the two are one row.
    const gains = typeof onLeave === 'function' && !changesFromEarlierReply ? gainsOf(changeList) : [];
    if (changeList.length) {
        const strip = el('details', 'story-block-tree-changes');
        strip.open = view.changesOpen;
        const summary = el('summary', 'story-block-tree-changes-summary');
        summary.title = changesFromEarlierReply
            ? `The newest reply carried no ${name}; these changes come from an earlier reply.`
            : `Changes to ${name} since the previous state.`;
        summary.appendChild(el('span', 'story-block-tree-changes-label', `${changesFromEarlierReply ? 'Changed in an earlier reply' : 'Changed this turn'} · ${changeList.length}`));
        // (0.9.24) Folded, the row is one line: the finds are counted here and shown when it opens.
        if (gains.length) summary.appendChild(el('span', 'story-block-tree-changes-found', `${gains.length} found`));
        else summary.appendChild(el('span', 'story-block-tree-changes-preview', changeList.map(describeChange).join('   ')));
        strip.appendChild(summary);
        if (gains.length) {
            const found = el('div', 'story-block-found');
            found.title = 'Found this turn: kept unless you leave it.';
            for (const gain of gains) {
                const chip = el('span', `story-block-found-chip${rarityClass(gain.remark) ? ` ${rarityClass(gain.remark)}` : ''}`);
                const label = gain.gain === null ? gain.name : `${gain.name} ×${gain.gain}`;
                const text = el('span', 'story-block-found-name', label);
                text.title = label;
                chip.appendChild(text);
                const leave = button('story-block-found-leave', { text: 'Leave', title: `Leave ${gain.name} behind: it comes out of this reply's ${name}. Kept otherwise.` });
                leave.addEventListener('click', stop(event => { event.preventDefault?.(); onLeave(gain); }));
                chip.appendChild(leave);
                found.appendChild(chip);
            }
            strip.appendChild(found);
        }
        const list = el('ul', 'story-block-tree-changes-list');
        for (const change of changeList) {
            const li = el('li', `story-block-tree-change is-${change.type}`);
            const target = button('story-block-tree-change-link', { text: describeChange(change), title: `Show ${crumbPath(change.path || ROOT_CATEGORY)}` });
            target.addEventListener('click', stop(() => select(resolveNode(tree, nodeIdForCategory(change.path ?? ROOT_CATEGORY, maxDepth)).id)));
            li.appendChild(target);
            list.appendChild(li);
        }
        strip.appendChild(list);
        strip.addEventListener('toggle', () => { view.changesOpen = strip.open; });
        pane.appendChild(strip);
    }

    pane.appendChild(browser);

    function changeDot(node) {
        if (!changedNodes.has(node.id)) return null;
        const dot = el('span', 'story-block-tree-change-dot');
        dot.title = 'Changed since the previous state';
        return dot;
    }

    function nodeLabel(node, text = node.name) {
        const label = el('span', 'story-block-tree-node-name', text);
        label.title = node.path.join(' › ') || text;
        return label;
    }

    function renderTree(selected) {
        const nav = el('nav', 'story-block-tree-nav');
        nav.setAttribute('aria-label', `${name} sections`);
        const list = el('ul', 'story-block-tree-list');

        const renderRow = (node, depth, text = node.name) => {
            const li = el('li', 'story-block-tree-node');
            const row = el('div', 'story-block-tree-row');
            row.style.setProperty('--story-block-depth', String(depth));
            const expanded = view.expanded.has(node.id);
            if (node.children.length && node.id !== ROOT_NODE_ID) {
                const toggle = button('story-block-tree-toggle', { text: expanded ? '▾' : '▸', title: expanded ? `Collapse ${node.name}` : `Expand ${node.name}` });
                toggle.setAttribute('aria-expanded', String(expanded));
                toggle.addEventListener('click', stop(() => {
                    if (expanded) view.expanded.delete(node.id);
                    else view.expanded.add(node.id);
                    renderBrowser(node.id);
                }));
                row.appendChild(toggle);
            } else {
                row.appendChild(el('span', 'story-block-tree-spacer'));
            }
            const label = button(`story-block-tree-label${node === selected ? ' is-selected' : ''}`);
            label.dataset.nodeId = node.id;
            if (node === selected) label.setAttribute('aria-current', 'true');
            label.append(nodeLabel(node, text), el('span', 'story-block-tree-count', String(node.total)));
            const dot = changeDot(node);
            if (dot) label.appendChild(dot);
            label.addEventListener('click', stop(() => select(node.id, { focus: true })));
            row.appendChild(label);
            li.appendChild(row);
            if (node.children.length && expanded && node.id !== ROOT_NODE_ID) {
                const group = el('ul', 'story-block-tree-list');
                node.children.forEach(child => group.appendChild(renderRow(child, depth + 1)));
                li.appendChild(group);
            }
            return li;
        };

        list.appendChild(renderRow(tree, 0, 'All'));
        tree.children.forEach(child => list.appendChild(renderRow(child, 0)));
        nav.appendChild(list);
        nav.addEventListener('keydown', event => handleTreeKey(event, nav));
        return nav;
    }

    function focusNode(nav, id) {
        nav.querySelector(`.story-block-tree-label[data-node-id="${CSS.escape(id)}"]`)?.focus();
    }

    function handleTreeKey(event, nav) {
        const labels = [...nav.querySelectorAll('.story-block-tree-label')];
        const index = labels.indexOf(document.activeElement);
        if (index < 0) return;
        const node = resolveNode(tree, labels[index].dataset.nodeId);
        let handled = true;
        if (event.key === 'ArrowDown') labels[Math.min(labels.length - 1, index + 1)].focus();
        else if (event.key === 'ArrowUp') labels[Math.max(0, index - 1)].focus();
        else if (event.key === 'Home') labels[0].focus();
        else if (event.key === 'End') labels.at(-1).focus();
        else if (event.key === 'ArrowRight' && node.children.length && node.id && !view.expanded.has(node.id)) {
            view.expanded.add(node.id);
            renderBrowser(node.id);
        } else if (event.key === 'ArrowRight' && node.children.length && node.id) {
            focusNode(nav, node.children[0].id);
        } else if (event.key === 'ArrowLeft' && node.id && view.expanded.has(node.id)) {
            view.expanded.delete(node.id);
            renderBrowser(node.id);
        } else if (event.key === 'ArrowLeft' && node.id) {
            focusNode(nav, parentId(node.id));
        } else handled = false;
        if (handled) {
            // SillyTavern binds arrow keys to swipes at document level.
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function renderCrumbs(selected) {
        const bar = el('div', 'story-block-tree-location');
        if (selected !== tree) {
            const back = button('story-block-tree-back', { text: '‹', title: 'Back' });
            back.addEventListener('click', stop(() => select(parentId(selected.id))));
            bar.appendChild(back);
        }
        const crumbs = el('ol', 'story-block-tree-crumbs');
        const trail = [tree, ...ancestorIds(selected.id).map(id => resolveNode(tree, id))];
        const collapsible = trail.length > 3;
        trail.forEach((node, index) => {
            const last = index === trail.length - 1;
            if (collapsible && index === 1) {
                const more = el('li', 'story-block-tree-crumb story-block-tree-crumb-ellipsis');
                const up = button('story-block-tree-crumb-button', { text: '…', title: 'Up one level' });
                up.addEventListener('click', stop(() => select(parentId(selected.id))));
                more.appendChild(up);
                crumbs.appendChild(more);
            }
            const middle = collapsible && index > 0 && index < trail.length - 1;
            const crumb = el('li', `story-block-tree-crumb${middle ? ' is-middle' : ''}${last ? ' is-current' : ''}`);
            const text = node === tree ? 'All' : node.name;
            if (last) {
                crumb.appendChild(el('span', 'story-block-tree-crumb-current', text));
                crumb.setAttribute('aria-current', 'location');
            } else {
                const link = button('story-block-tree-crumb-button', { text });
                link.addEventListener('click', stop(() => select(node.id)));
                crumb.appendChild(link);
            }
            crumbs.appendChild(crumb);
        });
        bar.appendChild(crumbs);
        bar.appendChild(el('span', 'story-block-tree-location-count', unitWord(columns[0], selected.total)));
        return bar;
    }

    function renderSiblings(selected) {
        if (selected === tree) return null;
        const parent = resolveNode(tree, parentId(selected.id));
        if (parent.children.length < 2 || parent.children.length > 8) return null;
        const row = el('div', 'story-block-tree-siblings');
        for (const sibling of parent.children) {
            const chip = button(`story-block-tree-chip${sibling === selected ? ' is-selected' : ''}`);
            chip.append(nodeLabel(sibling), el('span', 'story-block-tree-count', String(sibling.total)));
            const dot = changeDot(sibling);
            if (dot) chip.appendChild(dot);
            if (sibling === selected) chip.setAttribute('aria-current', 'true');
            chip.addEventListener('click', stop(() => select(sibling.id)));
            row.appendChild(chip);
        }
        return row;
    }

    function renderChildren(selected) {
        if (!selected.children.length) return null;
        const list = el('div', 'story-block-tree-children');
        for (const child of selected.children) {
            const row = button('story-block-tree-child');
            row.append(nodeLabel(child), el('span', 'story-block-tree-count', String(child.total)));
            const dot = changeDot(child);
            if (dot) row.appendChild(dot);
            row.appendChild(el('span', 'story-block-tree-child-chevron', '›'));
            row.addEventListener('click', stop(() => select(child.id)));
            list.appendChild(row);
        }
        return list;
    }

    // Column labels from the definition; shown above the rows once they sit on one line.
    function renderColumns() {
        const head = el('div', 'story-block-tree-columns');
        head.setAttribute('aria-hidden', 'true');
        columns.forEach((label, index) => head.appendChild(el('span', `story-block-tree-column is-col-${index + 1}`, label)));
        return head;
    }

    function renderItem(item, { path = '' } = {}) {
        const change = changedItems.get(itemKeyFor(item.category, item.name));
        const row = el('div', `story-block-tree-item${change ? ` is-${change}` : ''}`);
        const itemName = el('div', 'story-block-tree-item-name');
        // (0.9.18) A rarity word in the note tints the name (story-block-rarity is-rare…).
        const rarity = rarityClass(item.remark);
        itemName.appendChild(el('span', `story-block-tree-item-label${rarity ? ` ${rarity}` : ''}`, item.name));
        if (path) itemName.appendChild(el('span', 'story-block-tree-item-path', path));
        const qty = el('div', 'story-block-tree-item-qty', formatQuantity(item.quantity));
        if (item.quantity) qty.title = `${columns[1]}: ${item.quantity}`;
        const remark = el('div', 'story-block-tree-item-remark', item.remark);
        if (item.remark) remark.title = columns[2];
        row.append(itemName, qty, remark);
        if (change) row.title = change === 'added' ? 'New since the previous state' : change === 'moved' ? 'Moved since the previous state' : 'Changed since the previous state';
        return row;
    }

    function renderItems(selected) {
        const container = el('div', 'story-block-tree-items');
        container.appendChild(renderColumns());
        for (const group of groupItems(selected)) {
            const section = el('section', `story-block-tree-group${group.own ? ' is-own' : ' is-descendant'}`);
            if (group.label) section.appendChild(el('h4', 'story-block-tree-group-title', group.label));
            if (!group.items.length) section.appendChild(el('div', 'story-block-empty', `No ${noun(columns[0])}`));
            group.items.forEach(item => section.appendChild(renderItem(item)));
            container.appendChild(section);
        }
        return container;
    }

    function renderResults() {
        const container = el('div', 'story-block-tree-items story-block-tree-results');
        const results = searchItems(tree, view.query);
        container.appendChild(el('div', 'story-block-tree-results-summary', `${plural(results.length, 'match')} for “${view.query.trim()}”`));
        if (results.length) container.appendChild(renderColumns());
        for (const { item, node } of results) container.appendChild(renderItem(item, { path: node.path.join(' › ') }));
        return container;
    }

    function renderBrowser(focusId = null) {
        const selected = resolveNode(tree, view.selected);
        view.selected = selected.id;
        const searching = Boolean(view.query.trim());
        browser.classList.toggle('is-searching', searching);
        // (0.9.18) A short list opens at All with every item under its section's title, rather
        // than behind a row per section (narrow panes drill down only when the list is long).
        browser.classList.toggle('is-short', selected === tree && count <= SHORT_LIST);
        browser.replaceChildren();
        browser.appendChild(renderTree(selected));

        const main = el('div', 'story-block-tree-main');
        if (searching) {
            main.appendChild(renderResults());
        } else {
            main.appendChild(renderCrumbs(selected));
            const siblings = renderSiblings(selected);
            if (siblings) main.appendChild(siblings);
            const children = renderChildren(selected);
            if (children) main.appendChild(children);
            main.appendChild(renderItems(selected));
        }
        browser.appendChild(main);

        const chips = main.querySelector('.story-block-tree-siblings');
        const current = chips?.querySelector('.story-block-tree-chip.is-selected');
        if (chips && current) chips.scrollLeft = Math.max(0, current.offsetLeft - chips.offsetLeft - 24);

        if (focusId !== null) {
            browser.querySelector(`.story-block-tree-label[data-node-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
        }
    }

    input.addEventListener('input', () => {
        view.query = input.value;
        renderBrowser();
    });
    input.addEventListener('keydown', event => {
        // Typing must not trigger SillyTavern's document-level hotkeys.
        event.stopPropagation();
        if (event.key === 'Escape' && input.value) {
            input.value = '';
            view.query = '';
            renderBrowser();
        }
    });
    search.addEventListener('click', event => event.stopPropagation());

    renderBrowser();
    for (const [selector, top] of scrolled) {
        const node = pane.querySelector(selector);
        if (node && top) node.scrollTop = top;
    }
    if (typing) {
        input.focus({ preventScroll: true });
        input.setSelectionRange?.(typing.start, typing.end);
    }
}
