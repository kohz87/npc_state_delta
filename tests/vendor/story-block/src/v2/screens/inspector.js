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
.inspector { display: grid; gap: var(--sb-gap); }
.sb-insp { display: grid; gap: var(--sb-gap); min-width: 0; }
.sb-insp-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-insp-bar select { flex: 1 1 14em; min-width: 0; max-width: 100%; }
.sb-insp-bar input { flex: 1 1 12em; min-width: 0; }
.sb-insp-head { margin: 0; font-size: 1em; }
.sb-insp-count { font-size: 0.85em; }
.sb-insp-diff li, .sb-insp-ops li { display: flex; gap: 6px; align-items: baseline; font-family: var(--monoFontFamily, monospace); font-size: 0.85em; overflow-wrap: anywhere; }
.sb-insp-mark { flex: 0 0 1em; text-align: center; font-weight: bold; }
.sb-insp-add .sb-insp-mark { color: var(--sb-good); }
.sb-insp-remove .sb-insp-mark { color: var(--sb-bad); }
.sb-insp-change .sb-insp-mark { color: var(--sb-accent); }
.sb-insp-path { color: var(--sb-em); }
.sb-insp-receipts li, .sb-insp-problems li { padding: 3px 0; border-bottom: 1px solid var(--sb-border); }
.sb-insp-receipts li:last-child, .sb-insp-problems li:last-child { border-bottom: 0; }
.sb-insp-meta { display: block; font-size: 0.8em; }
.sb-insp-problems li { color: var(--sb-bad); }
.sb-insp-tree { font-family: var(--monoFontFamily, monospace); font-size: 0.85em; overflow-x: auto; }
.sb-insp-tree details > .sb-insp-kids { padding-left: 1.1em; border-left: 1px dashed var(--sb-border); margin-left: 0.3em; }
.sb-insp-tree summary { cursor: pointer; }
.sb-insp-leaf { padding-left: 1.1em; overflow-wrap: anywhere; }
.sb-insp-key { color: var(--sb-accent); }
.sb-insp-str { color: var(--sb-good); }
.sb-insp-num, .sb-insp-bool, .sb-insp-null { color: var(--sb-em); }
.sb-insp-hit > summary, .sb-insp-leaf.sb-insp-hit { background: color-mix(in srgb, var(--sb-accent) 22%, transparent); border-radius: 3px; }
.sb-insp-empty { font-style: italic; }
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
    const node = el(doc, 'button', `btn ${className}`, text);
    node.type = 'button';
    node.setAttribute('type', 'button');
    if (title) {
        node.setAttribute('title', title);
        node.setAttribute('aria-label', title);
    }
    return node;
}

function section(doc, className, title) {
    const box = el(doc, 'section', `panel ${className}`);
    box.appendChild(el(doc, 'h4', '', title));
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

function diffLine(doc, entry) {
    const row = el(doc, 'li', `sb-insp-${entry.kind}`);
    row.setAttribute('data-path', entry.path);
    const mark = el(doc, 'span', 'sb-insp-mark', MARKS[entry.kind] ?? '?');
    mark.setAttribute('aria-label', entry.kind);
    const text = entry.kind === 'add' ? preview(entry.after) : entry.kind === 'remove' ? `(was ${preview(entry.before)})` : `${preview(entry.before)} → ${preview(entry.after)}`;
    row.append(mark, el(doc, 'span', 'sb-insp-path', entry.path || '/'), el(doc, 'span', '', text));
    return row;
}

function opLine(doc, op) {
    const row = el(doc, 'li', `sb-insp-${op?.op === 'add' ? 'add' : op?.op === 'remove' ? 'remove' : 'change'}`);
    const parts = [op?.op ?? '?', String(op?.path ?? '')];
    if (op && 'value' in op) parts.push(`= ${preview(op.value)}`);
    if (op && 'was' in op) parts.push(`(was ${preview(op.was)}${op.count ? ` at ${op.count}` : ''})`);
    row.append(el(doc, 'span', 'sb-insp-mark', MARKS[op?.op === 'replace' ? 'change' : op?.op] ?? '?'), el(doc, 'span', '', parts.join(' ')));
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
            const picker = el(doc, 'select', 'text_pole sb-insp-pick');
            picker.setAttribute('aria-label', S.pick);
            const older = button(doc, 'sb-insp-older', '◀', S.older);
            const newer = button(doc, 'sb-insp-newer', '▶', S.newer);
            const latest = button(doc, 'sb-insp-latest', S.latest, S.latest);
            const search = el(doc, 'input', 'text_pole sb-insp-search');
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
                if (view.checkpoint) heading.appendChild(el(doc, 'span', 'chip muted', S.checkpoint));
                body.appendChild(heading);

                // What changed since the reply before.
                const changed = section(doc, 'sb-insp-changes', S.changed);
                if (!view.diff.entries.length) changed.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noChange));
                else {
                    const list = el(doc, 'ul', 'sb-insp-diff');
                    list.append(...view.diff.entries.map(entry => diffLine(doc, entry)));
                    if (view.diff.more) list.appendChild(el(doc, 'li', 'muted', fill(S.moreChanges, { n: view.diff.more })));
                    changed.appendChild(list);
                }
                const ops = el(doc, 'details', 'sb-insp-ops-box');
                ops.appendChild(el(doc, 'summary', 'muted', fill(S.ops, { n: view.ops.length })));
                const opList = el(doc, 'ul', 'sb-insp-ops');
                opList.append(...view.ops.slice(0, MAX_OPS).map(op => opLine(doc, op)));
                if (view.ops.length > MAX_OPS) opList.appendChild(el(doc, 'li', 'muted', fill(S.moreChanges, { n: view.ops.length - MAX_OPS })));
                ops.appendChild(opList);
                changed.appendChild(ops);
                body.appendChild(changed);

                // Receipts.
                const receipts = section(doc, 'sb-insp-receipts-box', `${S.receipts} (${view.receipts.length})`);
                if (!view.receipts.length) receipts.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noReceipts));
                else {
                    const list = el(doc, 'ul', 'sb-insp-receipts');
                    for (const receipt of view.receipts) {
                        const row = el(doc, 'li');
                        row.setAttribute('data-receipt', receipt.id);
                        row.appendChild(el(doc, 'span', '', receipt.summary || receipt.type));
                        const meta = [receipt.type, receipt.module, receipt.cause, receipt.rev !== null ? `rev ${receipt.rev}` : '', receipt.narrate ? '' : S.untold].filter(Boolean).join(' · ');
                        row.appendChild(el(doc, 'span', 'muted sb-insp-meta', meta));
                        list.appendChild(row);
                    }
                    receipts.appendChild(list);
                }
                body.appendChild(receipts);

                // Problems.
                const problems = section(doc, 'sb-insp-problems-box', `${S.problems} (${view.problems.length})`);
                if (!view.problems.length) problems.appendChild(el(doc, 'p', 'muted sb-insp-empty', S.noProblems));
                else {
                    const list = el(doc, 'ul', 'sb-insp-problems');
                    for (const problem of view.problems) list.appendChild(el(doc, 'li', '', problem.code ? `${problem.message} (${problem.code})` : problem.message));
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
