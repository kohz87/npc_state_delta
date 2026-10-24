// `story-block/inspector` (MODULES §F92): a read-only look inside the story's bookkeeping, one reply at a
// time, for beta testers and pack authors. Pick a reply; see what changed since the reply before it (the
// state compared path by path, and the ops as stored), its receipts and its problems, and its whole
// state as a tree that folds open, with a search over keys and values. Nothing here runs a command.
//
// The screen is a template around one host widget, `story-block.inspector`, which ui-host.js builds
// with createInspectorWidget(source) over the store (src/v2/inspect.js createInspectorSource): a widget
// is the one place code enters a screen (SPEC §13), and the inspector needs the store's replay of
// older replies, which no query (they read one state) can give. The screen and the widget belong to
// the `story-block.inspector` feature (MODULES §F100), off by default.
//
// Every text, key and value is set with textContent: a state holds what the model wrote.

import { STRINGS, fill } from '../strings.js';
import { CORE_FEATURE } from '../features.js';
import { LIMITS, matchPaths, pointer, preview } from '../inspect.js';
import { cutAt } from '../../text.js';
import { BASE_CSS } from './style.js';

const S = STRINGS.inspector;

export const INSPECTOR_SCREEN_ID = 'story-block/inspector';
export const INSPECTOR_WIDGET = 'story-block.inspector';
export const INSPECTOR_FEATURE = CORE_FEATURE.inspector;

const MAX_CHILDREN = 200;     // keys of one object drawn before "…and N more"
const MAX_TEXT = 300;         // characters of one string value drawn in the tree
const MAX_OPS = 300;          // ops listed for one reply

const TEMPLATE = `
<div class="inspector">
  <ss-widget name="${INSPECTOR_WIDGET}"></ss-widget>
</div>`;

const CSS = `${BASE_CSS}
.inspector { display: grid; gap: var(--ss-space-3, 12px); }
.sb-insp { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--ss-space-3, 12px); min-width: 0; color: var(--ss-text, inherit); font-family: var(--ss-font, inherit); }
.sb-insp-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--ss-space-3, 12px); min-width: 0; }
.sb-insp-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sb-insp-bar .sb-insp-pick { flex: 1 1 14em; min-width: 0; max-width: 100%; }
.sb-insp-bar .sb-insp-search { flex: 1 1 12em; min-width: 0; }
/* The bar's buttons are glass pills on the look's tokens. Hover and focus take the accent edge and a soft accent fill laid
   over the dense glass; the text stays the text colour (accent text on glass is hard to read). */
.sb-insp-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; min-height: 40px; padding: 0 12px; box-sizing: border-box; border: 1px solid var(--ss-border, currentColor); border-radius: var(--ss-radius-pill, 999px); background: var(--ss-tile, transparent); color: var(--ss-text, inherit); font: inherit; font-weight: 600; cursor: pointer; transition: border-color var(--ss-motion, 0.2s) ease, background-color var(--ss-motion, 0.2s) ease; }
.sb-insp-btn:hover:not(:disabled), .sb-insp-btn:focus-visible:not(:disabled) { border-color: var(--ss-accent, currentColor); background: linear-gradient(var(--ss-accent-soft, transparent), var(--ss-accent-soft, transparent)), var(--ss-glass-strong, var(--ss-tile, transparent)); }
.sb-insp-btn:focus-visible { outline: 2px solid var(--ss-accent, currentColor); outline-offset: 2px; }
.sb-insp-btn:active:not(:disabled) { border-color: var(--ss-accent, currentColor); background: linear-gradient(var(--ss-accent-soft, transparent), var(--ss-accent-soft, transparent)), var(--ss-glass-strong, var(--ss-tile, transparent)); }
.sb-insp-btn:disabled { opacity: 0.45; cursor: default; }
.sb-insp-head { margin: 0; font-size: 1.1em; font-weight: 700; overflow-wrap: anywhere; }
.sb-insp-card { margin: 0; }
.sb-insp-card-title { margin: 0; }
.sb-insp-count { font-size: 0.85em; }
.sb-insp-diff, .sb-insp-ops, .sb-insp-receipts, .sb-insp-problems { margin: 0; }
.sb-insp-diff li, .sb-insp-ops li, .sb-insp-receipts li, .sb-insp-problems li { min-width: 0; }
.sb-insp-diff .ss-listcard-title, .sb-insp-ops .ss-listcard-title, .sb-insp-receipts .ss-listcard-title, .sb-insp-problems .ss-listcard-title { font-weight: 600; overflow-wrap: anywhere; }
/* Raw values (paths, state values, operations) in monospace; the words around them in the look's own font. */
.sb-insp-path, .sb-insp-ops .ss-listcard-title, .sb-insp-diff .ss-listcard-sub, .sb-insp-problems .ss-listcard-sub { font-family: var(--monoFontFamily, monospace); font-size: 0.85em; }
.sb-insp-diff .ss-listcard-title, .sb-insp-ops .ss-listcard-title { font-family: var(--monoFontFamily, monospace); font-size: 0.85em; font-weight: 600; }
.sb-insp-mark { font-weight: 700; color: var(--ss-text, inherit); }
.sb-insp-add .sb-insp-mark { background: color-mix(in srgb, var(--ss-good, #2fbf71) 22%, transparent); }
.sb-insp-remove .sb-insp-mark { background: color-mix(in srgb, var(--ss-bad, #e5484d) 22%, transparent); }
.sb-insp-change .sb-insp-mark { background: color-mix(in srgb, var(--ss-accent, currentColor) 22%, transparent); }
.sb-insp-path { color: var(--ss-text, inherit); }
.sb-insp-receipts .ss-listcard-sub, .sb-insp-meta { display: block; font-size: 0.8em; color: var(--ss-muted, inherit); }
.sb-insp-problems li .ss-listcard-title { color: var(--ss-text, inherit); }
.sb-insp-problems .ss-listcard-tag { color: var(--ss-text, inherit); }
.sb-insp-tree { font-size: 0.9em; overflow-x: auto; }
.sb-insp-tree details > .sb-insp-kids { padding-left: 1.1em; border-left: 1px dashed var(--ss-border, currentColor); margin-left: 0.3em; }
.sb-insp-tree summary, .sb-insp-tree .sb-insp-leaf { border-radius: var(--ss-radius-s, 10px); }
.sb-insp-tree summary { cursor: pointer; padding: 2px 4px; overflow-wrap: anywhere; }
.sb-insp-tree summary:hover { background: var(--ss-tile, transparent); }
.sb-insp-tree summary:focus-visible { outline: 2px solid var(--ss-accent, currentColor); outline-offset: 1px; }
.sb-insp-leaf { padding: 2px 4px 2px 1.1em; overflow-wrap: anywhere; }
.sb-insp-key { color: var(--ss-text, inherit); font-weight: 600; }
.sb-insp-str, .sb-insp-num, .sb-insp-bool, .sb-insp-null { font-family: var(--monoFontFamily, monospace); color: var(--ss-text, inherit); }
.sb-insp-num, .sb-insp-bool, .sb-insp-null { color: var(--ss-muted, inherit); }
.sb-insp-hit > summary, .sb-insp-leaf.sb-insp-hit { background: color-mix(in srgb, var(--ss-accent, currentColor) 22%, transparent); border-radius: 6px; }
.sb-insp-empty { font-style: italic; }
.sb-insp .muted { color: var(--ss-muted, var(--sb-em, inherit)); }  /* the look's muted text on the glass, not SillyTavern's emphasis colour */
`;

export const inspectorScreen = Object.freeze({
    id: INSPECTOR_SCREEN_ID,
    title: S.title,
    icon: 'fa-magnifying-glass',
    mounts: Object.freeze(['screen', 'tab']),
    order: 900,
    feature: INSPECTOR_FEATURE,
    template: TEMPLATE,
    css: CSS,
});

function el(doc, tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}

function button(doc, className, text, title) {
    const node = el(doc, 'button', `sb-insp-btn ${className}`, text);
    node.type = 'button';
    node.setAttribute('type', 'button');
    if (title) {
        node.setAttribute('title', title);
        node.setAttribute('aria-label', title);
    }
    return node;
}

// A section is a glass card (the look's `ss-glass`); its title is the section label.
function section(doc, className, title) {
    const box = el(doc, 'section', `ss-glass sb-insp-card ${className}`);
    box.appendChild(el(doc, 'h4', 'ss-label sb-insp-card-title', title));
    return box;
}

const kindOf = value => (value === null ? 'null' : typeof value === 'string' ? 'str' : typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'other');
const isBranch = value => value !== null && typeof value === 'object';

function leafText(value) {
    if (typeof value === 'string') {
        const text = value.length > MAX_TEXT ? `${cutAt(value, MAX_TEXT)}…` : value;
        return JSON.stringify(text);
    }
    if (value === undefined) return '—';
    return String(value);
}

/**
 * Draws `value` as a tree into `parent`: objects and lists fold (`<details>`), their insides drawn when
 * first opened. `ctx` = { doc, open: Set of open paths (kept by the caller), search: matchPaths() result
 * or null }. While searching, only the hits and the nodes on the way to them are drawn.
 */
export function drawTree(parent, value, ctx, path = '') {
    const { doc, open, search } = ctx;
    const entries = Object.entries(value ?? {});
    const shown = search ? entries.filter(([key]) => search.keep.has(pointer(path, key))) : entries;
    const list = shown.slice(0, MAX_CHILDREN);
    for (const [key, child] of list) {
        const at = pointer(path, key);
        const hit = Boolean(search?.matches.has(at));
        if (isBranch(child)) {
            const box = el(doc, 'details', hit ? 'sb-insp-hit' : '');
            box.setAttribute('data-path', at);
            const head = el(doc, 'summary');
            head.append(el(doc, 'span', 'sb-insp-key', key), doc.createTextNode(' '), el(doc, 'span', 'muted', preview(child)));
            const kids = el(doc, 'div', 'sb-insp-kids');
            box.append(head, kids);
            let drawn = false;
            const fillKids = () => {
                if (drawn) return;
                drawn = true;
                drawTree(kids, child, ctx, at);
            };
            // Searching: a node on the way to a hit opens (drawing only the way); a hit itself stays shut
            // and shows all of itself when opened. Otherwise what the reader opened before is open again.
            if (search ? search.ways.has(at) : open.has(at)) {
                box.setAttribute('open', '');
                fillKids();
            }
            box.addEventListener('toggle', () => {
                const isOpen = box.hasAttribute('open');
                if (isOpen) {
                    if (!search) open.add(at);
                    // Opened while searching: everything inside, not only the hits.
                    if (!drawn && search) {
                        drawn = true;
                        drawTree(kids, child, { ...ctx, search: null }, at);
                    } else fillKids();
                } else if (!search) open.delete(at);
            });
            parent.appendChild(box);
        } else {
            const row = el(doc, 'div', `sb-insp-leaf${hit ? ' sb-insp-hit' : ''}`);
            row.setAttribute('data-path', at);
            row.append(el(doc, 'span', 'sb-insp-key', key), doc.createTextNode(': '), el(doc, 'span', `sb-insp-${kindOf(child)}`, leafText(child)));
            parent.appendChild(row);
        }
    }
    if (shown.length > list.length) parent.appendChild(el(doc, 'div', 'sb-insp-leaf muted', fill(S.moreKeys, { n: shown.length - list.length })));
    if (!entries.length) parent.appendChild(el(doc, 'div', 'sb-insp-leaf muted', Array.isArray(value) ? '[]' : '{}'));
}

const MARKS = { add: '+', remove: '−', change: '~' };

// A row of the look's list card: the mark in a tile, the path (raw, so monospace) and the values.
function diffLine(doc, entry) {
    const row = el(doc, 'li', `ss-listcard-row sb-insp-${entry.kind}`);
    row.setAttribute('data-path', entry.path);
    const item = el(doc, 'div', 'ss-listcard-item');
    const mark = el(doc, 'span', 'ss-listcard-icon sb-insp-mark', MARKS[entry.kind] ?? '?');
    mark.setAttribute('aria-label', entry.kind);
    const text = entry.kind === 'add' ? preview(entry.after) : entry.kind === 'remove' ? `(was ${preview(entry.before)})` : `${preview(entry.before)} → ${preview(entry.after)}`;
    const main = el(doc, 'span', 'ss-listcard-main');
    main.append(el(doc, 'span', 'ss-listcard-title sb-insp-path', entry.path || '/'), el(doc, 'span', 'ss-listcard-sub', text));
    item.append(mark, main);
    row.appendChild(item);
    return row;
}

function opLine(doc, op) {
    const row = el(doc, 'li', `ss-listcard-row sb-insp-${op?.op === 'add' ? 'add' : op?.op === 'remove' ? 'remove' : 'change'}`);
    const parts = [op?.op ?? '?', String(op?.path ?? '')];
    if (op && 'value' in op) parts.push(`= ${preview(op.value)}`);
    if (op && 'was' in op) parts.push(`(was ${preview(op.was)}${op.count ? ` at ${op.count}` : ''})`);
    const item = el(doc, 'div', 'ss-listcard-item');
    const main = el(doc, 'span', 'ss-listcard-main');
    main.appendChild(el(doc, 'span', 'ss-listcard-title', parts.join(' ')));
    item.append(el(doc, 'span', 'ss-listcard-icon sb-insp-mark', MARKS[op?.op === 'replace' ? 'change' : op?.op] ?? '?'), main);
    row.appendChild(item);
    return row;
}

/**
 * The `story-block.inspector` widget over `source` (inspect.js createInspectorSource): `{ replies(),
 * reply(index), headIndex(), memory: { index, search, open } }`. The reader's choices live in
 * `source.memory`, so a redraw of the screen keeps the reply picked, the search and what is open.
 * It redraws itself on the host's `head`, `committed` and `turn` events (api.on). `enabled()`: the
 * feature's switch; while it is off the widget draws nothing (B-rxui-11), wherever it is named.
 */
export function createInspectorWidget(source, { enabled = () => true } = {}) {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, _props, api = {}) {
            // Off (the feature `story-block.inspector`), it draws nothing in any screen that names it.
            if (!enabled()) {
                host.replaceChildren();
                host.hidden = true;
                return { update() {}, destroy() {} };
            }
            const doc = host.ownerDocument ?? globalThis.document;
            const memory = source.memory;
            const root = el(doc, 'div', 'sb-insp');
            root.setAttribute('role', 'region');
            root.setAttribute('aria-label', S.title);
            const bar = el(doc, 'div', 'sb-insp-bar');
            const picker = el(doc, 'select', 'ss-input ss-select sb-insp-pick');
            picker.setAttribute('aria-label', S.pick);
            const older = button(doc, 'sb-insp-older', '◀', S.older);
            const newer = button(doc, 'sb-insp-newer', '▶', S.newer);
            const latest = button(doc, 'sb-insp-latest', S.latest, S.latest);
            const search = el(doc, 'input', 'ss-input ss-text sb-insp-search');
            search.setAttribute('type', 'search');
            search.setAttribute('placeholder', S.searchHint);
            search.setAttribute('aria-label', S.search);
            search.value = memory.search ?? '';
            bar.append(picker, older, newer, latest, search);
            const body = el(doc, 'div', 'sb-insp-body');
            body.setAttribute('aria-live', 'polite');
            root.append(bar, body);
            host.replaceChildren(root);

            let replies = [];
            const chosen = () => {
                if (!replies.length) return null;
                const want = memory.index;
                return replies.find(reply => reply.index === want) ?? replies[0];
            };

            function drawPicker() {
                replies = source.replies();
                const current = chosen();
                picker.replaceChildren(...replies.map(reply => {
                    const option = el(doc, 'option', '', fill(S.option, {
                        index: reply.index,
                        name: reply.name ? ` · ${reply.name}` : '',
                        rev: reply.rev,
                        head: reply.head ? S.headMark : '',
                    }));
                    option.value = String(reply.index);
                    option.setAttribute('value', String(reply.index));
                    if (reply.snippet) option.setAttribute('title', reply.snippet);
                    return option;
                }));
                picker.value = current ? String(current.index) : '';
                picker.disabled = replies.length === 0;
                const at = current ? replies.indexOf(current) : -1;
                older.disabled = at < 0 || at >= replies.length - 1;
                newer.disabled = at <= 0;
                latest.disabled = at <= 0;
                return current;
            }

            function drawBody(current) {
                body.replaceChildren();
                if (!current) {
                    body.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.none));
                    return;
                }
                const view = source.reply(current.index);
                if (!view?.ok) {
                    body.appendChild(el(doc, 'p', 'muted sb-insp-empty', view?.message ?? S.none));
                    return;
                }
                const heading = el(doc, 'h3', 'sb-insp-head', fill(S.heading, { index: view.index, name: view.name ? ` · ${view.name}` : '', rev: view.rev ?? '—' }));
                if (view.checkpoint) heading.appendChild(el(doc, 'span', 'ss-pill ss-pill-soft', S.checkpoint));
                body.appendChild(heading);

                // What changed since the reply before.
                const changed = section(doc, 'sb-insp-changes', S.changed);
                if (!view.diff.entries.length) changed.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noChange));
                else {
                    const list = el(doc, 'ul', 'ss-listcard-rows sb-insp-diff');
                    list.append(...view.diff.entries.map(entry => diffLine(doc, entry)));
                    if (view.diff.more) list.appendChild(el(doc, 'li', 'muted', fill(S.moreChanges, { n: view.diff.more })));
                    changed.appendChild(list);
                }
                const ops = el(doc, 'details', 'sb-insp-ops-box');
                ops.appendChild(el(doc, 'summary', 'muted', fill(S.ops, { n: view.ops.length })));
                const opList = el(doc, 'ul', 'ss-listcard-rows sb-insp-ops');
                opList.append(...view.ops.slice(0, MAX_OPS).map(op => opLine(doc, op)));
                if (view.ops.length > MAX_OPS) opList.appendChild(el(doc, 'li', 'muted', fill(S.moreChanges, { n: view.ops.length - MAX_OPS })));
                ops.appendChild(opList);
                changed.appendChild(ops);
                body.appendChild(changed);

                // Receipts.
                const receipts = section(doc, 'sb-insp-receipts-box', `${S.receipts} (${view.receipts.length})`);
                if (!view.receipts.length) receipts.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noReceipts));
                else {
                    const list = el(doc, 'ul', 'ss-listcard-rows sb-insp-receipts');
                    for (const receipt of view.receipts) {
                        const row = el(doc, 'li', 'ss-listcard-row');
                        row.setAttribute('data-receipt', receipt.id);
                        const item = el(doc, 'div', 'ss-listcard-item');
                        const main = el(doc, 'span', 'ss-listcard-main');
                        main.appendChild(el(doc, 'span', 'ss-listcard-title', receipt.summary || receipt.type));
                        const meta = [receipt.type, receipt.module, receipt.cause, receipt.rev !== null ? `rev ${receipt.rev}` : '', receipt.narrate ? '' : S.untold].filter(Boolean).join(' · ');
                        main.appendChild(el(doc, 'span', 'ss-listcard-sub sb-insp-meta', meta));
                        item.appendChild(main);
                        row.appendChild(item);
                        list.appendChild(row);
                    }
                    receipts.appendChild(list);
                }
                body.appendChild(receipts);

                // Problems.
                const problems = section(doc, 'sb-insp-problems-box', `${S.problems} (${view.problems.length})`);
                if (!view.problems.length) problems.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noProblems));
                else {
                    const list = el(doc, 'ul', 'ss-listcard-rows sb-insp-problems');
                    for (const problem of view.problems) {
                        const row = el(doc, 'li', 'ss-listcard-row');
                        const item = el(doc, 'div', 'ss-listcard-item');
                        const main = el(doc, 'span', 'ss-listcard-main');
                        main.appendChild(el(doc, 'span', 'ss-listcard-title', problem.message));
                        if (problem.code) main.appendChild(el(doc, 'span', 'ss-listcard-sub', problem.code));
                        item.appendChild(main);
                        row.appendChild(item);
                        list.appendChild(row);
                    }
                    problems.appendChild(list);
                }
                body.appendChild(problems);

                // The whole state, folding, with the search.
                const state = section(doc, 'sb-insp-state', S.state);
                const query = String(memory.search ?? '').trim();
                const found = query ? matchPaths(view.state, query) : null;
                if (found) {
                    state.appendChild(el(doc, 'p', 'muted sb-insp-count', found.count === 0 ? S.notFound
                        : fill(found.capped ? S.foundCapped : S.found, { n: found.capped ? LIMITS.matches : found.count })));
                }
                const tree = el(doc, 'div', 'sb-insp-tree');
                if (!found || found.count > 0) drawTree(tree, view.state, { doc, open: memory.open, search: found });
                state.appendChild(tree);
                body.appendChild(state);
            }

            function redraw() {
                drawBody(drawPicker());
            }

            const pick = index => {
                // The newest reply means "follow the story": the picker moves on with new replies.
                memory.index = replies[0]?.index === index ? null : index;
                redraw();
            };
            const step = by => {
                const at = replies.indexOf(chosen());
                const next = replies[at + by];
                if (next) pick(next.index);
            };
            picker.addEventListener('change', () => pick(Number(picker.value)));
            older.addEventListener('click', () => step(1));
            newer.addEventListener('click', () => step(-1));
            latest.addEventListener('click', () => pick(replies[0]?.index ?? null));
            search.addEventListener('input', () => {
                memory.search = cutAt(String(search.value ?? ''), 200);
                drawBody(chosen());
            });

            const offs = [];
            if (typeof api?.on === 'function') {
                for (const name of ['head', 'committed', 'turn']) {
                    try {
                        const off = api.on(name, () => redraw());
                        if (typeof off === 'function') offs.push(off);
                    } catch { /* an older host without that event */ }
                }
            }
            redraw();
            return {
                update: () => redraw(),
                destroy() {
                    for (const off of offs.splice(0)) off();
                    root.remove?.();
                },
            };
        },
    });
}
