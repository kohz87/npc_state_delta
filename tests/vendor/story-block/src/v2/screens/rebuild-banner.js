// Home's "This branch's dossiers can't be restored" banner (screens/rebuild-banner.js) and the confirmation dialog
// that starts a branch's dossiers again from the chat. It is the `story-block.rebuild-banner` host widget: a banner
// only while the timeline holds a PERMANENT dossier failure, a two-choice dialog (the last 40 replies, the default,
// or the whole chat), progress while the participant reads, and a dismissible one-line note when it is done. A
// transient failure (still being retried) draws nothing. Text is set with textContent; the words are the approved
// Home mockup's.
//
// `props.inline` / `props.open`: the Inspector's Problem row mounts this widget with both, so its button opens the same confirmation.
//
// The catch-up states (mockup section D) come from the participant's synchronous `catchUp()` read (timeline `host.progress()`:
// { module, active, done, total, older, from, reason, outcome, message }): while it is reading, the working banner for a rebuild (section B,
// the real count) or the catch-up banner with Skip and its confirmation (`skip(module)`); when it ends, a one-line dismissible note (done,
// or stopped). `replyOf(messageIndex)` turns the scan marker into the reply number the reader counts. The banner polls `catchUp()` through
// `every(fn, ms)` (→ a stop function) only while something is reading.
//
// ui-host.js passes `blocked()` (the timeline's current block: { reason, code, blockedBy: { module, code } } or
// null), `rebuild(module, { read })`, `progress()` ({ reply, total } or null), `last()` (the last rebuilt result) and
// `dismiss(result)` (optional). It redraws on the host's head, committed, turn, feature and timeline events.

import { STRINGS, fill } from '../strings.js';

export const REBUILD_BANNER_WIDGET = 'story-block.rebuild-banner';

export const REBUILD_READ_LAST = 'last-40';
export const REBUILD_READ_ALL = 'all';
export const REBUILD_PERMANENT_CODES = Object.freeze(['SNAPSHOT_UNAVAILABLE', 'CONFLICT', 'DEPENDENCY_UNAVAILABLE']);

/** The approved mockup's words (strings/screens.js `rebuild`, one block so every surface shows the same). */
export const REBUILD_TEXT = STRINGS.rebuild;

let serial = 0;

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** The permanent block this banner acts on, or null (a transient failure and no block are both hidden). */
export function rebuildTarget(blocked) {
    if (!blocked || typeof blocked !== 'object') return null;
    const by = blocked.blockedBy && typeof blocked.blockedBy === 'object' ? blocked.blockedBy : blocked;
    const module = typeof by.module === 'string' ? by.module : '';
    if (!module || !REBUILD_PERMANENT_CODES.includes(by.code)) return null;
    return { module, code: by.code };
}

/**
 * The widget → `{ props, render(host, props, api) }`. The sources may answer synchronously or with a promise.
 * `rebuild(module, choice)` gets `{ read: 'last-40' | 'all' }` and answers `{ ok: true, module?, read?, reply? }`
 * or a failure envelope. `progress()` → `{ reply, total }` (total null while reading the whole chat).
 */
export function createRebuildBannerWidget({
    blocked = () => null, rebuild = async () => ({ ok: false, code: 'FAILED', message: REBUILD_TEXT.failed }),
    progress = () => null, last = () => null, dismiss = () => {}, scope = () => null,
    catchUp = () => null, skip = async () => ({ ok: false }), replyOf = index => index + 1,
    every = (fn, ms) => { const id = setInterval(fn, ms); id?.unref?.(); return () => clearInterval(id); },
} = {}) {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, props, api = {}) {
            // `inline` (the Inspector's Problem row): no banner of its own, only the confirmation, progress and result; `open` starts at the confirmation.
            const inline = props?.inline === true;
            const doc = host.ownerDocument ?? globalThis.document;
            let phase = 'idle';               // idle | dialog | working | failed | done
            let dialogTarget = null;
            let choice = REBUILD_READ_LAST;
            let working = null;               // { module, read }
            let done = null;
            let failure = null;
            let dismissed = null;
            let drawn = 0;
            let gone = false;
            let skipOpen = false;
            let sawActive = null;             // the reason of a catch-up seen reading in this chat (an ended note shows only for it)
            let seenNote = null;              // the dismissed ended note's key
            let stopPoll = null;
            let lastSig = '';
            let lastRead = REBUILD_READ_LAST;
            const currentScope = () => { try { return scope(); } catch { return null; } };
            let owner = currentScope();
            let scopeEpoch = 0;

            function resetForChat() {
                const current = currentScope();
                if (current === owner) return false;
                owner = current;
                scopeEpoch += 1;
                phase = 'idle'; dialogTarget = null; choice = REBUILD_READ_LAST;
                working = null; done = null; failure = null; dismissed = null;
                skipOpen = false; sawActive = null; seenNote = null;
                drawn += 1;
                return true;
            }

            const paint = nodes => {
                if (gone) return;
                host.replaceChildren(...nodes);
            };

            function enabled(target, message = '') {
                const root = el(doc, 'section', 'banner rebuild-banner');
                root.dataset.module = target.module;
                root.append(el(doc, 'p', 't rebuild-title', REBUILD_TEXT.title));
                root.append(el(doc, 'p', 'rebuild-body', message || REBUILD_TEXT.body));
                if (message) root.classList.add('rebuild-failed');
                const start = el(doc, 'button', 'btn primary rebuild-start', REBUILD_TEXT.start);
                start.type = 'button';
                start.setAttribute('type', 'button');
                start.addEventListener('click', () => openDialog(target));
                root.append(start, el(doc, 'p', 'muted rebuild-muted', REBUILD_TEXT.muted));
                return root;
            }

            function dialog() {
                const root = el(doc, 'div', 'dialog rebuild-dialog');
                root.setAttribute('role', 'dialog');
                root.setAttribute('aria-modal', 'true');
                root.setAttribute('aria-label', REBUILD_TEXT.dialogTitle);
                root.append(el(doc, 'h4', '', REBUILD_TEXT.dialogTitle));
                root.append(el(doc, 'p', '', REBUILD_TEXT.dialogBody));
                const name = `rebuild-read-${++serial}`;
                const choiceRow = (value, text) => {
                    const label = el(doc, 'label', 'choice rebuild-choice');
                    const input = el(doc, 'input');
                    input.type = 'radio';
                    input.name = name;
                    input.value = value;
                    input.checked = choice === value;
                    const pick = () => { choice = value; };
                    input.addEventListener('click', pick);
                    input.addEventListener('change', pick);
                    label.append(input, doc.createTextNode(` ${text}`));
                    return label;
                };
                root.append(choiceRow(REBUILD_READ_LAST, REBUILD_TEXT.last));
                root.append(choiceRow(REBUILD_READ_ALL, REBUILD_TEXT.all));
                root.append(el(doc, 'p', 'muted rebuild-muted', REBUILD_TEXT.dialogMuted));
                const buttons = el(doc, 'div', 'btns rebuild-buttons');
                const start = el(doc, 'button', 'btn primary rebuild-confirm', REBUILD_TEXT.confirm);
                start.type = 'button';
                start.addEventListener('click', () => { if (dialogTarget) begin(dialogTarget.module, choice); });
                const cancel = el(doc, 'button', 'btn rebuild-cancel', REBUILD_TEXT.cancel);
                cancel.type = 'button';
                cancel.addEventListener('click', () => {
                    phase = failure ? 'failed' : 'idle';
                    dialogTarget = null;
                    choice = REBUILD_READ_LAST;
                    if (inline && typeof props?.onCancel === 'function') { props.onCancel(); return; }
                    draw();
                });
                buttons.append(start, cancel);
                root.append(buttons);
                return root;
            }

            const catching = () => { try { const value = catchUp(); return value && typeof value === 'object' ? value : null; } catch { return null; } };
            function progressLine(read) {
                let value = null;
                const live = catching();
                if (live?.active && live.total > 0) value = { reply: Math.min(live.done + 1, live.total), total: live.total };
                else { try { value = progress(); } catch { value = null; } }
                const reply = Number.isInteger(value?.reply) ? value.reply : null;
                if (reply === null) return REBUILD_TEXT.reading;
                const total = Number.isInteger(value?.total) ? value.total : (read === REBUILD_READ_LAST ? 40 : null);
                return total === null ? fill(REBUILD_TEXT.readingReply, { reply }) : fill(REBUILD_TEXT.readingOf, { reply, total });
            }

            function workingView() {
                const root = el(doc, 'section', 'banner rebuild-banner rebuild-working');
                const title = el(doc, 'p', 't rebuild-title');
                const spin = el(doc, 'span', 'spin');
                spin.setAttribute('aria-hidden', 'true');
                title.append(spin, doc.createTextNode(REBUILD_TEXT.workingTitle));
                const line = el(doc, 'p', 'muted rebuild-progress', progressLine(working?.read));
                line.setAttribute('aria-live', 'polite');
                const button = el(doc, 'button', 'btn rebuild-working', REBUILD_TEXT.working);
                button.type = 'button';
                button.disabled = true;
                button.setAttribute('disabled', '');
                root.append(title, line, button);
                return root;
            }

            const nice = (text, values) => fill(text, values);
            function catchView(info) {
                const root = el(doc, 'section', 'banner rebuild-banner rebuild-catching');
                const title = el(doc, 'p', 't rebuild-title');
                const spin = el(doc, 'span', 'spin');
                spin.setAttribute('aria-hidden', 'true');
                title.append(spin, doc.createTextNode(REBUILD_TEXT.catchTitle));
                const total = info.total;
                const reply = Math.min(info.done + 1, Math.max(total, 1));
                const body = el(doc, 'p', 'rebuild-body');
                body.setAttribute('aria-live', 'polite');
                const bold = el(doc, 'b', '', nice(REBUILD_TEXT.catchReading, { reply, total }));
                if (info.older > 0) body.append(doc.createTextNode(nice(REBUILD_TEXT.catchCap, { total, all: total + info.older })), bold, doc.createTextNode(REBUILD_TEXT.catchAfter));
                else if (info.from !== null) body.append(doc.createTextNode(nice(REBUILD_TEXT.catchBefore, { from: replyOf(info.from) })), bold, doc.createTextNode(REBUILD_TEXT.catchAfter));
                else body.append(doc.createTextNode(REBUILD_TEXT.catchBeforeNoFrom), bold, doc.createTextNode(REBUILD_TEXT.catchAfter));
                root.append(title, body);
                if (info.older > 0) root.append(el(doc, 'p', 'muted rebuild-muted', nice(REBUILD_TEXT.catchOlder, { older: info.older })));
                else root.append(el(doc, 'p', 'muted rebuild-muted', REBUILD_TEXT.catchMuted));
                const button = el(doc, 'button', 'btn rebuild-skip', REBUILD_TEXT.skip);
                button.type = 'button';
                button.addEventListener('click', () => { skipOpen = true; draw(); });
                root.append(button);
                return root;
            }

            function skipDialog(info) {
                const root = el(doc, 'div', 'dialog rebuild-dialog rebuild-skip-dialog');
                root.setAttribute('role', 'dialog');
                root.setAttribute('aria-modal', 'true');
                root.setAttribute('aria-label', REBUILD_TEXT.skipTitle);
                root.append(el(doc, 'h4', '', REBUILD_TEXT.skipTitle));
                // The replies left unread, as the reader counts them: after the dossiers' reply to the end of what the catch-up covers.
                const first = info.from === null ? 1 : replyOf(info.from) + 1;
                const last = first - 1 + info.total + info.older;
                root.append(el(doc, 'p', '', info.from === null ? nice(REBUILD_TEXT.skipBodyNoFrom, { last }) : nice(REBUILD_TEXT.skipBody, { from: replyOf(info.from), first, last })));
                const buttons = el(doc, 'div', 'btns rebuild-buttons');
                const keep = el(doc, 'button', 'btn primary rebuild-keep', REBUILD_TEXT.keepReading);
                keep.type = 'button';
                keep.addEventListener('click', () => { skipOpen = false; draw(); });
                const go = el(doc, 'button', 'btn rebuild-skip-confirm', REBUILD_TEXT.skip);
                go.type = 'button';
                go.addEventListener('click', async () => {
                    skipOpen = false;
                    try { await skip(info.module); } catch { /* the next look shows what happened */ }
                    draw();
                });
                buttons.append(keep, go);
                root.append(buttons);
                return root;
            }

            /** The one-line note of a catch-up that ended (a rebuild's done note is the section B one); a skip says it was skipped (mockup v7). */
            function endedNote(info) {
                const key = `${info.reason}|${info.outcome}|${info.total}|${info.from}`;
                if (key === seenNote) return null;
                let text = '';
                if (info.outcome === 'done') text = info.reason === 'rebuild' ? (lastRead === REBUILD_READ_ALL ? REBUILD_TEXT.doneAll : REBUILD_TEXT.doneLast) : nice(REBUILD_TEXT.caughtUp, { count: info.total });
                else if (info.outcome === 'skipped') text = REBUILD_TEXT.skipped;
                else if (info.outcome === 'stale') text = REBUILD_TEXT.stopped;
                else text = REBUILD_TEXT.stoppedOther;
                const root = el(doc, 'div', 'note rebuild-note');
                root.setAttribute('role', 'status');
                root.append(el(doc, 'span', 'rebuild-note-text', text));
                const close = el(doc, 'button', 'rebuild-dismiss', '×');
                close.type = 'button';
                close.setAttribute('aria-label', REBUILD_TEXT.dismiss);
                close.setAttribute('title', REBUILD_TEXT.dismiss);
                close.addEventListener('click', () => { seenNote = key; working = null; phase = 'idle'; draw(); });
                root.append(close);
                return root;
            }

            function doneText(result) {
                return result?.read === REBUILD_READ_ALL ? REBUILD_TEXT.doneAll : REBUILD_TEXT.doneLast;
            }

            function doneView(result) {
                const root = el(doc, 'div', 'note rebuild-note');
                root.setAttribute('role', 'status');
                const text = el(doc, 'span', 'rebuild-note-text', doneText(result));
                const close = el(doc, 'button', 'rebuild-dismiss', '×');
                close.type = 'button';
                close.setAttribute('aria-label', REBUILD_TEXT.dismiss);
                close.setAttribute('title', REBUILD_TEXT.dismiss);
                close.addEventListener('click', () => {
                    dismissed = doneKey(result);
                    try { dismiss(result); } catch { /* the reader's note is optional */ }
                    done = null;
                    phase = 'idle';
                    draw();
                });
                root.append(text, close);
                return root;
            }

            const doneKey = value => `${value?.module ?? ''}|${value?.read ?? REBUILD_READ_LAST}|${value?.reply ?? ''}`;
            const normalize = value => (value && typeof value === 'object'
                ? { ...value, read: value.read === REBUILD_READ_ALL ? REBUILD_READ_ALL : REBUILD_READ_LAST }
                : null);

            function openDialog(target) {
                if (resetForChat()) { draw(); return; }
                dialogTarget = target;
                choice = REBUILD_READ_LAST;
                phase = 'dialog';
                drawn += 1;
                paint([dialog()]);
            }

            async function begin(module, read) {
                if (resetForChat()) { draw(); return; }
                const startedIn = owner;
                const startedEpoch = scopeEpoch;
                phase = 'working';
                dialogTarget = null;
                working = { module, read };
                failure = null;
                drawn += 1;
                paint([workingView()]);
                let result;
                try { result = await rebuild(module, { read }); } catch (error) { result = { ok: false, code: 'FAILED', message: error?.message ?? String(error) }; }
                if (gone) return;
                if (currentScope() !== startedIn || owner !== startedIn || scopeEpoch !== startedEpoch) { resetForChat(); draw(); return; }
                if (result?.ok !== false && result?.started === true) {
                    // The participant reads on after answering: the banner follows its progress() and ends with its note.
                    working = { module, read, started: true };
                    lastRead = read;
                    sawActive = 'rebuild';
                    drawn += 1;
                    draw();
                    return;
                }
                working = null;
                if (!result || result.ok === false) {
                    failure = { module, message: typeof result?.message === 'string' && result.message ? result.message : REBUILD_TEXT.failed };
                    phase = 'failed';
                    drawn += 1;
                    paint([enabled({ module, code: result?.code ?? 'FAILED' }, failure.message)]);
                    return;
                }
                done = normalize({ ...result, module, read: result.read ?? read });
                dismissed = null;
                phase = 'done';
                drawn += 1;
                paint([doneView(done)]);
            }

            async function draw() {
                resetForChat();
                const mine = ++drawn;
                if (gone) return;
                const info = catching();
                syncPoll(info);
                if (info?.active) {
                    sawActive = info.reason;
                    if (info.reason === 'rebuild') {
                        if (phase !== 'working') { phase = 'working'; working = { module: info.module, read: lastRead, started: true }; }
                        paint([workingView()]);
                        return;
                    }
                    if (!inline) { paint([skipOpen ? skipDialog(info) : catchView(info)]); return; }
                } else skipOpen = false;
                if (phase === 'working' && working?.started && !info?.active) {
                    // It ended (or the participant has no progress to tell): the note below, or the plain done note.
                    const read = working.read;
                    const module = working.module;
                    working = null;
                    phase = 'idle';
                    if (!info?.outcome) { done = normalize({ ok: true, module, read }); phase = 'done'; }
                }
                if (!inline && info && !info.active && info.outcome && sawActive === info.reason) {
                    const note = endedNote(info);
                    if (note) { paint([note]); return; }
                }
                if (phase === 'dialog') { paint([dialog()]); return; }
                if (phase === 'working') { paint([workingView()]); return; }
                if (phase === 'done' && done) { paint([doneView(done)]); return; }
                if (phase === 'failed' && failure) { paint([enabled({ module: failure.module, code: 'FAILED' }, failure.message)]); return; }
                let held = null;
                try { held = await blocked(); } catch { held = null; }
                if (gone || mine !== drawn) return;
                const target = rebuildTarget(held);
                if (target) { paint(inline ? [] : [enabled(target)]); return; }
                let previous = null;
                try { previous = await last(); } catch { previous = null; }
                if (gone || mine !== drawn) return;
                previous = normalize(previous);
                if (previous?.ok === false) previous = null;
                if (previous && doneKey(previous) !== dismissed) { done = previous; paint([doneView(previous)]); return; }
                paint([]);
            }

            // While something reads, look at its progress twice a second and redraw only when it moved.
            function syncPoll(info) {
                if (info?.active && !stopPoll) {
                    stopPoll = every(() => {
                        const now = catching();
                        const sig = JSON.stringify(now && [now.active, now.done, now.total, now.outcome]);
                        if (sig !== lastSig) { lastSig = sig; draw(); }
                    }, 500);
                } else if (!info?.active && stopPoll) { try { stopPoll(); } catch { /* gone already */ } stopPoll = null; lastSig = ''; }
            }

            const offs = [];
            if (typeof api?.on === 'function') {
                for (const name of ['head', 'committed', 'turn', 'feature', 'timeline', 'modules']) {
                    try {
                        const off = api.on(name, () => { draw(); });
                        if (typeof off === 'function') offs.push(off);
                    } catch { /* an older host without that event */ }
                }
            }
            if (inline && props?.open === true) {
                Promise.resolve().then(blocked).then(held => { const target = rebuildTarget(held); if (!gone && target) openDialog(target); else draw(); }, () => draw());
            } else draw();
            return {
                update: () => { draw(); },
                destroy: () => {
                    gone = true;
                    if (stopPoll) { try { stopPoll(); } catch { /* gone already */ } stopPoll = null; }
                    offs.splice(0).forEach(off => { try { off(); } catch { /* gone already */ } });
                    host.replaceChildren();
                },
            };
        },
    });
}
