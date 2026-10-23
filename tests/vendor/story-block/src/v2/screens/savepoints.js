// Save points on the Home screen (MODULES §F93): the `story-block.savepoints` host widget. "Save point"
// keeps this moment as a named SillyTavern branch at the latest reply (src/v2/rewind.js
// createSavePoints); the list below names each one with its reply and date, and "Return here" opens its
// branch. "Forget" only takes an entry off the list; the branch stays in SillyTavern's chat list.
//
// This is chat management, not a story action (F95/F96): nothing here runs a command or changes the
// story. The widget belongs to the `story-block.savepoints` feature (MODULES §F100, on by default): while
// it is off the widget draws nothing at all. Names are the reader's own, flattened to one line and set
// with textContent.

import { STRINGS, fill } from '../strings.js';
import { SAVEPOINT_LIMITS } from '../rewind.js';
import { capToggle } from './show-more.js';

const S = STRINGS.savepoints;

export const SAVEPOINTS_WIDGET = 'story-block.savepoints';

function el(doc, tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}

function button(doc, className, icon, text, title = '') {
    const node = el(doc, 'button', `ss-button ${className}`);
    node.type = 'button';
    node.setAttribute('type', 'button');
    if (icon) {
        const glyph = el(doc, 'i', `fa-solid ${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        node.appendChild(glyph);
    }
    node.appendChild(el(doc, 'span', '', text));
    if (title) node.setAttribute('title', title);
    return node;
}

/** A save point's date as the reader's own locale writes it ('' when it has none). */
export function savedAt(iso, locale = undefined) {
    const time = Date.parse(String(iso ?? ''));
    if (!Number.isFinite(time)) return '';
    try {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
    } catch {
        return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
    }
}

/**
 * The widget over `points` (createSavePoints) → `{ props, render(el, props, api) }`. `enabled()`: the
 * feature's switch; `notify(text, kind)`: a toast for what went wrong (optional). It redraws on the
 * host's `head` event (another chat opened, a reply came) and `feature` event (a switch moved), through
 * `api.on`.
 */
export function createSavePointsWidget({ points, enabled = () => true, notify = null }) {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, _props, api = {}) {
            const doc = host.ownerDocument ?? globalThis.document;
            let root = null;
            let editing = false;
            let busy = false;
            let message = '';

            const tell = (text, kind = 'info') => {
                message = text;
                if (kind === 'error') notify?.(text, kind);
            };

            async function run(work) {
                if (busy) return;
                busy = true;
                draw();
                try { await work(); } finally {
                    busy = false;
                    draw();
                }
            }

            // The list's toggle (capToggle): its ResizeObserver is disconnected on each redraw and on destroy.
            let capOff = null;
            function draw() {
                capOff?.();
                capOff = null;
                if (!enabled()) {
                    root = null;
                    host.replaceChildren();
                    return;
                }
                const list = points.list();
                const here = points.chatId?.();
                root = el(doc, 'section', 'panel saves');
                root.setAttribute('aria-label', S.title);
                const head = el(doc, 'h4', 'ss-section-label');
                const glyph = el(doc, 'i', 'fa-solid fa-flag');
                glyph.setAttribute('aria-hidden', 'true');
                head.append(glyph, doc.createTextNode(` ${S.title}`));
                root.appendChild(head);

                const make = button(doc, 'sb-save-make', 'fa-floppy-disk', S.save, S.saveTitle);
                make.disabled = busy || editing;
                make.addEventListener('click', () => {
                    editing = true;
                    message = '';
                    draw();
                    root?.querySelector?.('.sb-save-name')?.focus?.();
                });
                root.appendChild(make);

                if (editing) {
                    const form = el(doc, 'div', 'sb-save-form');
                    const name = el(doc, 'input', 'text_pole sb-save-name');
                    name.setAttribute('type', 'text');
                    name.setAttribute('maxlength', String(SAVEPOINT_LIMITS.name));
                    name.setAttribute('aria-label', S.name);
                    name.setAttribute('placeholder', fill(S.namePlaceholder, { n: list.length + 1 }));
                    const ok = button(doc, 'sb-save-ok', 'fa-check', S.create);
                    const cancel = button(doc, 'sb-save-cancel', '', S.cancel);
                    ok.disabled = busy;
                    const submit = () => run(async () => {
                        const result = await points.save({ name: name.value ?? '' });
                        if (result?.ok) {
                            editing = false;
                            tell(result.warning ?? fill(S.saved, { name: result.point.name }));
                        } else tell(fill(S.failed, { reason: result?.message ?? '?' }), 'error');
                    });
                    ok.addEventListener('click', submit);
                    cancel.addEventListener('click', () => {
                        editing = false;
                        draw();
                    });
                    name.addEventListener('keydown', event => {
                        if (event.key === 'Enter') {
                            event.preventDefault?.();
                            submit();
                        } else if (event.key === 'Escape') {
                            editing = false;
                            draw();
                        }
                    });
                    form.append(name, ok, cancel);
                    root.appendChild(form);
                }

                const status = el(doc, 'p', 'muted sb-save-status', message);
                status.setAttribute('role', 'status');
                status.hidden = !message;
                root.appendChild(status);

                if (!list.length) root.appendChild(el(doc, 'p', 'muted sb-save-none', S.none));
                else {
                    const rows = el(doc, 'ul', 'sb-save-list');
                    for (const point of list) {
                        const row = el(doc, 'li', 'sb-save-point');
                        row.setAttribute('data-id', point.id);
                        const info = el(doc, 'div', 'sb-save-info');
                        info.appendChild(el(doc, 'b', 'sb-save-label', point.name));
                        const when = [point.index !== null ? fill(S.at, { index: point.index }) : '', savedAt(point.at)].filter(Boolean).join(' · ');
                        info.appendChild(el(doc, 'span', 'muted sb-save-when', when));
                        row.appendChild(info);
                        const actions = el(doc, 'div', 'sb-save-actions');
                        if (here === point.branch) actions.appendChild(el(doc, 'span', 'chip sb-save-here', S.here));
                        else {
                            const back = button(doc, 'sb-save-return', 'fa-rotate-left', S.returnHere, S.returnTitle);
                            back.disabled = busy;
                            back.addEventListener('click', () => run(async () => {
                                const result = await points.returnTo(point.id);
                                if (!result?.ok) tell(fill(S.returnFailed, { reason: result?.message ?? '?' }), 'error');
                                else message = '';
                            }));
                            actions.appendChild(back);
                        }
                        const drop = button(doc, 'sb-save-forget danger', '', S.remove, S.removeTitle);
                        drop.disabled = busy;
                        drop.addEventListener('click', () => run(async () => {
                            const result = await points.forget(point.id);
                            if (!result?.ok) tell(result?.message ?? '?', 'error');
                            else message = result.warning ?? '';
                        }));
                        actions.appendChild(drop);
                        row.appendChild(actions);
                        rows.appendChild(row);
                    }
                    root.appendChild(rows);
                    // A long list is capped with "Show all" (no scrollbar), like the other long cards on Home.
                    const more = capToggle(doc, rows, { key: 'story-block/home:saves' });
                    capOff = more.destroy;
                    root.appendChild(more.button);
                    doc.defaultView?.requestAnimationFrame?.(() => more.refresh());
                    more.refresh();
                }
                host.replaceChildren(root);
            }

            const offs = [];
            if (typeof api?.on === 'function') {
                // Another chat or a new reply (head); the reader switching the feature (feature).
                for (const name of ['head', 'feature']) {
                    try {
                        const off = api.on(name, () => {
                            message = '';
                            draw();
                        });
                        if (typeof off === 'function') offs.push(off);
                    } catch { /* an older host without that event */ }
                }
            }
            draw();
            return {
                update: () => draw(),
                destroy() {
                    capOff?.();
                    capOff = null;
                    for (const off of offs.splice(0)) off();
                    host.replaceChildren();
                },
            };
        },
    });
}
