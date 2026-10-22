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
// mount(el, screenId, opts) adds the modal to `el` (open() uses document.body). opts:
//   draft      the starting draft (copied)
//   submit     the command the last step sends (default: the step's `[data-submit]` attribute)
//   random     a command type, or { type, payload }: shows Random (payload defaults to the draft)
//   onDone     (result) → called with the command or commit result after a success
//   onClose    (result | null) → called whenever the dialog closes
// → handle { el, draft, step(), stepCount(), next(), back(), submit(), random(), accept(), close(), closed }

import { button, documentOf, drawScreen, headIndexOf, headState, icon, make, plainCopy } from './common.js';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The controls in `root` Tab can reach, in document order (hidden and disabled ones left out). */
export function focusablesIn(root) {
    return Array.from(root?.querySelectorAll?.(FOCUSABLE) ?? []).filter(node => !node.disabled && !node.hidden && !node.closest?.('[hidden]'));
}

export function createDialogMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The dialog mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    const open = [];          // handles, the topmost last

    const onKey = event => {
        if (!open.length) return;
        const top = open[open.length - 1];
        if (event.key === 'Escape') {
            event.preventDefault?.();
            event.stopPropagation?.();
            top.close();
            return;
        }
        if (event.key !== 'Tab') return;
        // Tab stays inside the topmost dialog: past its last control to its first, and back.
        const nodes = focusablesIn(top.root);
        if (!nodes.length) return;
        const at = nodes.indexOf(doc.activeElement);
        const next = event.shiftKey ? (at <= 0 ? nodes.at(-1) : null) : (at === -1 || at === nodes.length - 1 ? nodes[0] : null);
        if (next) {
            event.preventDefault?.();
            next.focus?.();
        }
    };
    // Focus that lands outside the topmost dialog (a click on the page behind, a script) goes back in.
    const onFocus = event => {
        const top = open[open.length - 1];
        if (!top || !event.target || top.root.contains?.(event.target)) return;
        (focusablesIn(top.root)[0] ?? top.root).focus?.();
    };

    function mount(el, screenId, opts = {}) {
        const resolved = deps.screens.resolve(screenId);
        const screen = resolved?.screen ?? null;
        const steps = screen?.steps?.length ? screen.steps : [null];
        const draft = plainCopy(opts.draft ?? {});
        const randomSpec = typeof opts.random === 'string' ? { type: opts.random } : (opts.random ?? null);
        let at = 0;
        let busy = null;
        let token = null;
        let closed = false;
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
        const acceptButton = button(doc, 'ss-dialog-accept menu_button', 'Accept');
        receipt.append(receiptText, acceptButton);
        const error = make(doc, 'p', 'ss-dialog-error');
        error.setAttribute('role', 'alert');
        error.hidden = true;
        const foot = make(doc, 'footer', 'ss-dialog-foot');
        const backButton = button(doc, 'ss-dialog-back menu_button', 'Back');
        const randomButton = button(doc, 'ss-dialog-random menu_button', 'Random');
        randomButton.hidden = !randomSpec;
        const nextButton = button(doc, 'ss-dialog-next menu_button', 'Next');
        const submitButton = button(doc, 'ss-dialog-submit menu_button', opts.submitLabel ?? 'Done');
        foot.append(backButton, randomButton, nextButton, submitButton);
        root.append(head, stepList, body, receipt, error, foot);
        backdrop.appendChild(root);

        const showError = message => {
            error.textContent = message ?? '';
            error.hidden = !message;
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
            drawScreen(body, screenId, 'dialog', { deps: stepDeps, state: headState(deps), draft, index: headIndexOf(deps), screen: override });
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
            if (!open.length) {
                doc.removeEventListener?.('keydown', onKey, true);
                doc.removeEventListener?.('focusin', onFocus, true);
            }
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
        };

        (el ?? doc.body).appendChild(backdrop);
        open.push(handle);
        if (open.length === 1) {
            doc.addEventListener?.('keydown', onKey, true);
            doc.addEventListener?.('focusin', onFocus, true);
        }
        root.setAttribute('aria-label', screen?.title ?? screenId);
        drawStep();
        closer.focus?.();
        return handle;
    }

    return {
        mount,
        open: (screenId, opts = {}) => mount(deps.container?.() ?? doc.body, screenId, opts),
        current: () => open[open.length - 1] ?? null,
        closeAll() { [...open].reverse().forEach(handle => handle.close()); },
    };
}
