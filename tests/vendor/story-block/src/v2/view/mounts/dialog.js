// Story Suite v2: the `dialog` mount (SPEC §13.4, §13.6), a modal over the chat drawn from the head state
// plus a draft. Inputs fill the draft the dialog holds, never the state; a wizard's steps share that one
// draft. Back and Next move between steps; the last step sends the draft as one command, and code (the
// command's handler) enforces every rule. A Random button asks for a `preview` and shows its receipt;
// Accept commits exactly that preview's token, so the roll shown is the roll kept.
//
// The backdrop dims and blurs the page and takes every click outside the dialog; Tab and Shift+Tab go
// round the topmost dialog's own controls, and focus that lands outside it is brought back.
//
// deps (see common.js); `api` must have command(type, payload, { cause }), preview(type, payload) and
// commit(token) (plain results or promises).
//
// deps.chatScope() → { chat, branch } (optional, ui-host.js): the chat the reader is in and the story's head. A window
// opened in one chat, or before the story moved on, sends nothing after either changed: a submit, a roll or an accept is
// refused with the reason, and the chat change itself closes the window (ui-host.js).
//
// mount(el, screenId, opts) adds the modal to `el` (open() uses document.body). opts:
//   draft      the starting draft (copied)
//   submit     the command the last step sends (default: the step's `[data-submit]` attribute)
//   random     a command type, or { type, payload }: shows Random (payload defaults to the draft)
//   onDone     (result) → called with the command or commit result after a success
//   onClose    (result | null) → called whenever the dialog closes
// → handle { el, draft, step(), stepCount(), next(), back(), submit(), random(), accept(), close(), closed },
//   or null when there is no such screen to show (no module, pack or card has it, or its feature is off,
//   MODULES §F100): nothing opens, as on a page with no dialogs. A screen that is there but cannot be
//   drawn still opens, with the reason in its body.
// The mount also has closeWhere(test): closes each open dialog whose screen id passes `test`.

import { button, dispose, documentOf, drawScreen, headIndexOf, headState, icon, make, plainCopy } from './common.js';
import { focusNode } from '../scroll.js';
import { focusablesIn, stackOf } from '../modal-stack.js';

export { focusablesIn };

const MOVED_ON = 'This window was opened in another chat or before the story moved on, so nothing was sent. Close it and open it again.';

const within = (node, root) => {
    for (let at = node; at; at = at.parentNode) if (at === root) return true;
    return false;
};

/**
 * Runs `draw` (which may build the body's controls again) and puts the focus back where it was: on the same field, found by its
 * draft key, with its caret and the body's scroll. A field that is still in the body is left alone.
 */
function keepFocus(body, draw) {
    const doc = body.ownerDocument ?? globalThis.document;
    const active = doc.activeElement;
    const was = active && within(active, body) ? active : null;
    const key = was?.getAttribute?.('data-draft') ?? null;
    const at = was ? focusablesIn(body).indexOf(was) : -1;
    const caret = was && typeof was.selectionStart === 'number' ? [was.selectionStart, was.selectionEnd ?? was.selectionStart] : null;
    const top = body.scrollTop ?? 0;
    const out = draw();
    if (!was || within(was, body)) return out;
    const same = key === null ? null : Array.from(body.querySelectorAll('[data-draft]')).find(node => node.getAttribute('data-draft') === key);
    const target = same ?? focusablesIn(body)[at] ?? null;
    if (!target) return out;
    focusNode(target);
    if (caret && typeof target.setSelectionRange === 'function') {
        try { target.setSelectionRange(caret[0], caret[1]); } catch { /* a control with no caret */ }
    }
    body.scrollTop = top;
    return out;
}

export function createDialogMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The dialog mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    const open = [];          // handles, the topmost last
    // The chat and the head now (deps.chatScope); null when the wiring gives none.
    const scopeNow = () => {
        try { return deps.chatScope?.() ?? null; } catch { return null; }
    };

    function mount(el, screenId, opts = {}) {
        const resolved = deps.screens.resolve(screenId);
        if (!resolved) return null;
        const screen = resolved?.screen ?? null;
        const steps = screen?.steps?.length ? screen.steps : [null];
        const draft = plainCopy(opts.draft ?? {});
        const randomSpec = typeof opts.random === 'string' ? { type: opts.random } : (opts.random ?? null);
        let at = 0;
        let busy = null;
        let token = null;
        let closed = false;
        let layer = null;         // the shared stack's entry for this window
        let drawnAt = -1;         // the step the body was last drawn for (a redraw of that step keeps its controls)
        let resolveClosed;
        const closedPromise = new Promise(resolve => { resolveClosed = resolve; });

        const backdrop = make(doc, 'div', 'ss-dialog-backdrop');
        const root = make(doc, 'div', 'ss-dialog');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('tabindex', '-1');
        const head = make(doc, 'header', 'ss-dialog-head');
        const title = make(doc, 'h2', 'ss-dialog-title', screen?.title ?? screenId);
        const closer = button(doc, 'ss-dialog-close', '', 'Close');
        closer.appendChild(icon(doc, 'fa-xmark'));
        head.append(title, closer);
        const stepList = make(doc, 'ol', 'ss-dialog-steps');
        stepList.hidden = steps.length < 2;
        const body = make(doc, 'div', 'ss-dialog-body');
        const receipt = make(doc, 'div', 'ss-dialog-receipt');
        receipt.hidden = true;
        receipt.setAttribute('role', 'status');
        const receiptText = make(doc, 'p', 'ss-dialog-receipt-text');
        const acceptButton = button(doc, 'ss-dialog-accept menu_button ss-modal-action ss-modal-primary', 'Accept');
        receipt.append(receiptText, acceptButton);
        const error = make(doc, 'p', 'ss-dialog-error');
        error.setAttribute('role', 'alert');
        error.hidden = true;
        const foot = make(doc, 'footer', 'ss-dialog-foot');
        const backButton = button(doc, 'ss-dialog-back menu_button ss-modal-action', 'Back');
        const randomButton = button(doc, 'ss-dialog-random menu_button ss-modal-action', 'Random');
        randomButton.hidden = !randomSpec;
        const nextButton = button(doc, 'ss-dialog-next menu_button ss-modal-action', 'Next');
        const submitButton = button(doc, 'ss-dialog-submit menu_button ss-modal-action ss-modal-primary', opts.submitLabel ?? 'Done');
        foot.append(backButton, randomButton, nextButton, submitButton);
        root.append(head, stepList, body, receipt, error, foot);
        backdrop.appendChild(root);

        const showError = message => {
            error.textContent = message ?? '';
            error.hidden = !message;
        };
        // The chat and the head the window was opened on; a change to either refuses what it would send.
        const openedOn = scopeNow();
        const movedOn = () => {
            const now = scopeNow();
            return !!(openedOn && now && (now.chat !== openedOn.chat || now.branch !== openedOn.branch));
        };
        const refuseMoved = () => {
            showError(MOVED_ON);
            return { ok: false, code: 'CHAT_CHANGED', message: MOVED_ON };
        };
        const isLast = () => at === steps.length - 1;
        const submitType = () => opts.submit ?? body.querySelector('[data-submit]')?.getAttribute('data-submit') ?? null;

        // Widgets that edit the draft (ss.stepper) call api.onDraft(name, value): the value goes into the
        // draft (a dotted name is a path) and the step is drawn again from it.
        const setDraft = (name, value) => {
            const keys = String(name ?? '').split('.').filter(Boolean);
            if (!keys.length || keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) return;
            let node = draft;
            for (const key of keys.slice(0, -1)) {
                if (!node[key] || typeof node[key] !== 'object') node[key] = {};
                node = node[key];
            }
            node[keys.at(-1)] = plainCopy({ value }).value ?? null;
            if (!closed) drawStep();
        };
        const stepDeps = { ...deps, api: { ...(deps.api ?? {}), onDraft: setDraft } };

        function drawStep() {
            const step = steps[at];
            stepList.replaceChildren(...steps.map((item, i) => {
                const li = make(doc, 'li', 'ss-dialog-step', item?.title ?? `Step ${i + 1}`);
                if (i === at) li.setAttribute('aria-current', 'step');
                return li;
            }));
            root.setAttribute('data-ss-step', step?.id ?? '');
            let override = null;
            if (step && screen) {
                // The step stands in for the screen's body: same id, css, theme and data; its own template.
                const { steps: _steps, template: _template, layout: _layout, ...rest } = screen;
                override = { ...rest, title: step.title ?? screen.title, ...(step.template !== undefined ? { template: step.template } : { layout: step.layout }) };
            }
            // A redraw of the same step updates its view in place; a field that is built again gets the focus, the caret and the
            // scroll back (keepFocus), so typing in a field never drops it.
            keepFocus(body, () => drawScreen(body, screenId, 'dialog', { deps: stepDeps, state: headState(deps), draft, index: headIndexOf(deps), screen: override, keep: drawnAt === at }));
            drawnAt = at;
            backButton.hidden = at === 0;
            nextButton.hidden = isLast();
            // The last step's own [data-submit] button sends the draft; the footer button only stands in
            // when the template has none and the caller named the command.
            submitButton.hidden = !isLast() || !!body.querySelector('[data-submit]') || !opts.submit;
        }

        function goTo(index) {
            if (closed || index < 0 || index >= steps.length || index === at) return at;
            at = index;
            showError('');
            drawStep();
            return at;
        }

        function close(result = null) {
            if (closed) return;
            closed = true;
            const i = open.indexOf(handle);
            if (i >= 0) open.splice(i, 1);
            stackOf(doc).pop(layer);
            // The body's widgets go with the window (their listeners, their observers): a closed window keeps nothing alive.
            dispose(body);
            body.replaceChildren();
            backdrop.remove();
            opts.onClose?.(result);
            resolveClosed(result);
        }

        function finish(result) {
            opts.onDone?.(result);
            close(result);
        }

        // One request at a time: a second click while one runs gets the same answer, never a second command.
        function once(work) {
            if (busy) return busy;
            for (const node of [backButton, randomButton, nextButton, submitButton, acceptButton]) node.disabled = true;
            busy = (async () => {
                try {
                    return await work();
                } catch (thrown) {
                    const result = { ok: false, code: 'FAILED', message: thrown?.message ?? String(thrown) };
                    showError(result.message);
                    return result;
                } finally {
                    busy = null;
                    for (const node of [backButton, randomButton, nextButton, submitButton, acceptButton]) node.disabled = false;
                }
            })();
            return busy;
        }

        function submit() {
            if (closed) return Promise.resolve({ ok: false, code: 'CLOSED', message: 'This window is closed.' });
            if (movedOn()) return Promise.resolve(refuseMoved());
            return once(async () => {
                const type = submitType();
                if (!type) {
                    const result = { ok: false, code: 'NO_COMMAND', message: 'This form has no command to send.' };
                    showError(result.message);
                    return result;
                }
                showError('');
                const result = await deps.api.command(type, plainCopy(draft), { cause: 'ui' });
                if (result?.ok) finish(result);
                else showError(result?.message ?? 'That did not work.');
                return result;
            });
        }

        function random() {
            if (closed || !randomSpec) return Promise.resolve({ ok: false, code: 'NO_COMMAND', message: 'There is nothing to roll here.' });
            if (movedOn()) return Promise.resolve(refuseMoved());
            return once(async () => {
                showError('');
                const result = await deps.api.preview(randomSpec.type, plainCopy(randomSpec.payload ?? draft));
                if (result?.ok) {
                    token = result.token;
                    receiptText.textContent = result.receipt?.summary ?? '';
                    receipt.hidden = false;
                } else {
                    token = null;
                    receipt.hidden = true;
                    showError(result?.message ?? 'That did not work.');
                }
                return result;
            });
        }

        function accept() {
            if (closed || !token) return Promise.resolve({ ok: false, code: 'NO_PREVIEW', message: 'Roll first, then accept.' });
            if (movedOn()) return Promise.resolve(refuseMoved());
            return once(async () => {
                const kept = token;
                token = null;
                const result = await deps.api.commit(kept);
                receipt.hidden = true;
                if (result?.ok) finish(result);
                else showError(result?.message ?? 'That did not work.');
                return result;
            });
        }

        closer.addEventListener('click', () => close());
        backButton.addEventListener('click', () => goTo(at - 1));
        nextButton.addEventListener('click', () => goTo(at + 1));
        submitButton.addEventListener('click', () => submit());
        randomButton.addEventListener('click', () => random());
        acceptButton.addEventListener('click', () => accept());
        // The dialog owns submitting: a template's [data-submit] button sends the draft on the last step and
        // moves on before it; a form's own submit (Enter) never reloads the page.
        root.addEventListener('click', event => {
            const target = event.target?.closest?.('[data-submit]');
            if (!target || !body.contains(target)) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            if (isLast()) submit();
            else goTo(at + 1);
        }, true);
        body.addEventListener('submit', event => event.preventDefault?.());

        const handle = {
            el: backdrop,
            root,
            screenId,
            draft,
            step: () => at,
            stepId: () => steps[at]?.id ?? null,
            stepCount: () => steps.length,
            next: () => goTo(at + 1),
            back: () => goTo(at - 1),
            goTo,
            submit,
            random,
            accept,
            close,
            closed: closedPromise,
            isOpen: () => !closed,
            /** The element that had the focus when the window opened (the one it gives the focus back to), or null. */
            opener: () => layer?.opener ?? null,
        };

        (el ?? doc.body).appendChild(backdrop);
        open.push(handle);
        // The dialog is a layer of the shared stack: Escape closes it (only while it is the topmost), Tab stays in it, and closing
        // it hands the focus back to what opened it.
        layer = { name: `dialog ${screenId}`, root, onEscape: () => { close(); return true; }, handle };
        stackOf(doc).push(layer);
        root.setAttribute('aria-label', screen?.title ?? screenId);
        drawStep();
        focusNode(root);
        return handle;
    }

    return {
        mount,
        open: (screenId, opts = {}) => mount(deps.container?.() ?? doc.body, screenId, opts),
        current: () => open[open.length - 1] ?? null,
        closeAll() { [...open].reverse().forEach(handle => handle.close()); },
        /** Closes each open dialog whose screen id passes `test(screenId)` (topmost first). */
        closeWhere(test) { [...open].reverse().filter(handle => test(handle.screenId)).forEach(handle => handle.close()); },
        /** Closes each open dialog that was opened from inside `node` (its opener is in `node`), topmost first. */
        closeOpenedIn(node) {
            [...open].reverse().filter(handle => { const at = handle.opener(); for (let n = at; n; n = n.parentNode) if (n === node) return true; return false; }).forEach(handle => handle.close());
        },
    };
}
