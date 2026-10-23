// ss.dialog (view/glass.css, classes `ss-modal`): the glass dialog. A modal over the page: a titled glass
// panel with some text and up to four buttons. It is labelled by its title (`aria-labelledby`) and described
// by its text; the focus goes in when it opens (the main button, else the first control), Tab and Shift+Tab
// stay inside it, Escape and a click on the dimmed page behind close it, and the focus goes back to where it was
// when it closes or the widget is removed.
//
// The classes are `ss-modal*`, not `ss-dialog*`: those belong to the dialog mount (mounts/dialog.js, wizards),
// which keeps its own look until its screens move to this one. A button runs `onSelect` with `{ dialog: <action
// id> }` and the close paths run it with `{ dialog: 'close' }` (confirm a choice, close: never a story action,
// F95/F96); the dialog closes itself on any of them. The panel is `position: fixed`, so place the widget where no
// ancestor has a backdrop filter or a transform (not inside a `.ss-glass`), or it sits in that ancestor's box.
//
// Built with createElement and textContent only, like every standard widget (dom.js).

import { h, iconNode, runCommand, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';
import { cutAt } from '../../../text.js';
import { focusNode } from '../scroll.js';

export const ACTION_MAX = 4;
export const ACTION_KINDS = Object.freeze(['primary', 'plain', 'danger']);
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

const dialogProps = {
    open: { type: 'boolean', default: true },
    title: { type: 'string', required: true, default: '' },
    text: { type: 'string', default: '' },                 // paragraphs, split on blank lines
    actions: { type: 'array', default: Object.freeze([]) }, // [{ id, label, kind: primary|plain|danger, icon }]
    closable: { type: 'boolean', default: true },          // a × button, Escape and a click behind close it
    alert: { type: 'boolean', default: false },            // role alertdialog: a message that needs an answer
    onSelect: { type: 'string', default: '' },
    label: { type: 'string', default: 'Dialog' },          // the accessible name when there is no title
};

const short = (value, max) => cutAt(str(value).replace(/\s+/g, ' ').trim(), max);
let serial = 0;
// The dialogs that are open, the topmost last: only that one takes the keys.
const stack = [];

/** The actions as drawn: at most ACTION_MAX, each { id, label, kind, icon }; one without a label is left out. */
export function dialogActions(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const label = short(raw.label, 40);
        if (!label) continue;
        out.push({ id: short(raw.id, 64) || label, label, kind: ACTION_KINDS.includes(raw.kind) ? raw.kind : 'plain', icon: typeof raw.icon === 'string' ? raw.icon : '' });
        if (out.length >= ACTION_MAX) break;
    }
    return out;
}

/** The paragraphs of a text: blank-line separated, whitespace tidied, at most 8 of 600 characters. */
export function dialogParagraphs(text) {
    return str(text).split(/\n\s*\n/).map(part => short(part, 600)).filter(Boolean).slice(0, 8);
}

// Whether a node is in a hidden subtree of `root` (the fake and the real DOM both answer).
function hiddenWithin(node, root) {
    for (let n = node; n && n !== root; n = n.parentNode) if (n.hidden) return true;
    return false;
}
const focusablesIn = root => Array.from(root.querySelectorAll(FOCUSABLE)).filter(node => !node.disabled && !hiddenWithin(node, root) && node.getAttribute?.('tabindex') !== '-1');

function renderDialog(el, input, api) {
    let p = resolveProps(dialogProps, input);
    return shell(el, 'div', 'dialog', ({ doc, root, listen, cleanup }) => {
        const id = `ss-modal-${(serial += 1)}`;
        root.classList.add('ss-modal');
        const panel = h(doc, 'div', 'ss-modal-panel ss-glass-strong');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('tabindex', '-1');
        const head = h(doc, 'div', 'ss-modal-head');
        const title = h(doc, 'h2', 'ss-modal-title');
        title.setAttribute('id', `${id}-title`);
        const close = h(doc, 'button', 'ss-modal-close');
        close.setAttribute('type', 'button');
        close.setAttribute('aria-label', 'Close');
        const times = h(doc, 'span', '', '×');
        times.setAttribute('aria-hidden', 'true');
        close.appendChild(times);
        head.append(title, close);
        const text = h(doc, 'div', 'ss-modal-text');
        text.setAttribute('id', `${id}-text`);
        const foot = h(doc, 'div', 'ss-modal-foot');
        panel.append(head, text, foot);
        root.appendChild(panel);

        let isOpen = false;
        let lastProp = null;
        let before = null;
        let alive = true;
        const win = doc.defaultView;
        const later = fn => (typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame(() => alive && fn()) : fn());

        const top = () => stack[stack.length - 1] === token;
        const token = {};
        function onKey(event) {
            if (!isOpen || !top()) return;
            if (event.key === 'Escape') {
                if (!p.closable) return;
                event.preventDefault?.();
                event.stopPropagation?.();
                finish('close');
                return;
            }
            if (event.key !== 'Tab') return;
            const nodes = focusablesIn(panel);
            if (!nodes.length) {
                event.preventDefault?.();
                focusNode(panel);
                return;
            }
            const at = nodes.indexOf(doc.activeElement);
            const next = event.shiftKey ? (at <= 0 ? nodes.at(-1) : null) : (at === -1 || at === nodes.length - 1 ? nodes[0] : null);
            if (next) {
                event.preventDefault?.();
                focusNode(next);
            }
        }
        // A focus that lands outside the panel (a click on the page behind, a script) is brought back in.
        function onFocus(event) {
            if (!isOpen || !top() || !event.target || panel.contains?.(event.target)) return;
            focusNode(focusablesIn(panel)[0] ?? panel);
        }
        function release() {
            const at = stack.indexOf(token);
            if (at >= 0) stack.splice(at, 1);
            doc.removeEventListener?.('keydown', onKey, true);
            doc.removeEventListener?.('focusin', onFocus, true);
        }
        function show() {
            if (isOpen) return;
            isOpen = true;
            root.hidden = false;
            const active = doc.activeElement;
            before = active && active !== doc.body ? active : null;
            stack.push(token);
            doc.addEventListener?.('keydown', onKey, true);
            doc.addEventListener?.('focusin', onFocus, true);
            later(() => {
                if (!isOpen) return;
                const main = foot.querySelector('.ss-modal-primary');
                focusNode(main ?? focusablesIn(panel)[0] ?? panel);
            });
        }
        function hide() {
            if (!isOpen) return;
            isOpen = false;
            root.hidden = true;
            release();
            const back = before;
            before = null;
            if (back && back.isConnected !== false) focusNode(back);
        }
        // An answer: the command, then close.
        function finish(answer) {
            runCommand(api, p.onSelect, { dialog: answer });
            hide();
        }
        listen(close, 'click', () => finish('close'));
        listen(foot, 'click', event => {
            const button = [...foot.querySelectorAll('button')].find(node => node === event.target || node.contains?.(event.target));
            if (button) finish(button.getAttribute('data-id'));
        });
        // A click on the dimmed page behind (not on the panel) closes it.
        listen(root, 'click', event => {
            if (event.target === root && p.closable) finish('close');
        });
        cleanup(() => {
            alive = false;
            hide();
            release();
        });

        function update() {
            const label = short(p.title, 100);
            title.textContent = label;
            panel.setAttribute('role', p.alert ? 'alertdialog' : 'dialog');
            if (label) {
                panel.setAttribute('aria-labelledby', title.id);
                panel.removeAttribute('aria-label');
            } else {
                panel.removeAttribute('aria-labelledby');
                panel.setAttribute('aria-label', short(p.label, 60) || 'Dialog');
            }
            title.hidden = !label;
            const paragraphs = dialogParagraphs(p.text);
            text.replaceChildren(...paragraphs.map(part => h(doc, 'p', 'ss-modal-paragraph', part)));
            text.hidden = !paragraphs.length;
            if (paragraphs.length) panel.setAttribute('aria-describedby', text.id);
            else panel.removeAttribute('aria-describedby');
            close.hidden = !p.closable;
            const active = doc.activeElement;
            const keep = active && foot.contains?.(active) ? active.getAttribute?.('data-id') : null;
            foot.replaceChildren();
            const actions = dialogActions(p.actions);
            for (const action of actions) {
                const button = h(doc, 'button', `ss-modal-action ss-modal-${action.kind}`);
                button.setAttribute('type', 'button');
                button.setAttribute('data-id', action.id);
                const glyph = iconNode(doc, action.icon, 'ss-modal-icon');
                if (glyph) button.appendChild(glyph);
                button.appendChild(h(doc, 'span', '', action.label));
                foot.appendChild(button);
            }
            foot.hidden = !actions.length;
            if (keep) focusNode([...foot.querySelectorAll('button')].find(button => button.getAttribute('data-id') === keep));
        }
        update();
        lastProp = p.open;
        if (p.open) show();
        else root.hidden = true;
        return {
            update(next) {
                p = resolveProps(dialogProps, next);
                update();
                // Closed by the reader stays closed until the screen asks for it open again.
                if (p.open !== lastProp) {
                    lastProp = p.open;
                    if (p.open) show();
                    else hide();
                }
            },
        };
    });
}

export const dialog = defineWidget({ props: dialogProps, primary: 'title', render: renderDialog });
