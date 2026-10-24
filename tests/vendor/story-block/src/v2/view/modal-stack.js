// Story Suite v2: one stack of modal layers (SPEC §13.6), shared by the game view (mounts/screen.js), the dialogs (mounts/dialog.js),
// the More sheet (screen-bar.js), the settings window (settings/window.js) and the glass dialog (widgets/dialog.js). Only the topmost
// layer takes the keys: Escape goes to its `onEscape(event)` (true: taken, and the key stops there), and Tab stays inside its `root`.
// A focus that lands outside the topmost layer (a click on the page behind, a script) is brought back in. A layer that closes hands
// the focus back to what was focused when it opened (`opener`), when that is still on the page.
//
// The document listeners exist only while a layer is open. Escape is taken in the bubble phase: a control that handles its own
// Escape first (a field that clears its text, a packs question that cancels) stops it there, and the layer does not close.
//
// stackOf(doc) → { push(layer), pop(layer, { focus = true }), top(), has(layer), layers() }
// layer: { name, root (an element), onEscape(event) → boolean, reveal?(node) (a Tab moved the focus to `node`: scroll it into view) };
// push() sets `layer.opener`.

import { focusNode } from './scroll.js';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], summary';

/** The controls in `root` Tab can reach, in document order (hidden and disabled ones left out). */
export function focusablesIn(root) {
    return Array.from(root?.querySelectorAll?.(FOCUSABLE) ?? []).filter(node => !node.disabled && !node.hidden && !node.closest?.('[hidden]') && node.getAttribute?.('tabindex') !== '-1'
        // a closed fold shows its summary only: what is inside it is not reachable
        && (node.tagName === 'SUMMARY' || !closedFold(node)));
}

/** Whether `node` sits in a <details> that is closed (its summary, the one line it shows, is the exception). */
const closedFold = node => {
    const fold = node.closest?.('details');
    return Boolean(fold) && !fold.open;
};

// The z-index of the first layer; each layer pushed after it is one above the last, so the keys and the paint agree (the game view
// over Settings, Settings over the game view, a dialog over both).
const Z_BASE = 3020;

/** Whether `node` is `root` or inside it (no `contains` needed: a test's fake DOM has none). */
const within = (node, root) => {
    for (let at = node; at; at = at.parentNode) if (at === root) return true;
    return false;
};

// SillyTavern's keyboard handler clicks a focused element of these classes on Enter (public/scripts/keyboard.js); the browser's
// own Enter activation would click it a second time, so it is cancelled for them (the bar's buttons do the same, ui-host.js).
const SILLY_CLICKS = ['menu_button', 'right_menu_button', 'interactable', 'custom_interactable'];

const stacks = new WeakMap();

/** The one stack of layers of `doc` (made on first use). */
export function stackOf(doc) {
    let stack = stacks.get(doc);
    if (!stack) {
        stack = createStack(doc);
        stacks.set(doc, stack);
    }
    return stack;
}

function createStack(doc) {
    const list = [];
    let attached = false;
    let z = Z_BASE;
    const top = () => list[list.length - 1] ?? null;
    // A layer whose element has left the page is dropped (its owner forgot to close it): it takes no key and holds no focus.
    const stageOf = layer => layer.el ?? layer.root;
    const prune = () => {
        for (let at = list.length - 1; at >= 0; at -= 1) if (stageOf(list[at])?.isConnected === false) list.splice(at, 1);
        if (!list.length) {
            detach();
            z = Z_BASE;
        }
    };

    // One keydown listener (bubble phase): Escape goes to the topmost layer; Tab goes round it, past its last control to its first, and back.
    const onKeyDown = event => {
        prune();
        const layer = top();
        if (!layer) return;
        // An Enter on a SillyTavern-clickable button: its keydown is cancelled, so the browser's own activation (the keypress that
        // would click it) does not follow; SillyTavern's handler clicks it once.
        if (event.key === 'Enter') {
            if (list.some(item => within(event.target, item.root)) && SILLY_CLICKS.some(name => event.target?.classList?.contains?.(name))) event.preventDefault?.();
            return;
        }
        if (event.key === 'Escape') {
            if (layer.onEscape?.(event) === true) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
            return;
        }
        if (event.key !== 'Tab') return;
        const nodes = focusablesIn(layer.root);
        if (!nodes.length) {
            event.preventDefault?.();
            focusNode(layer.root);
            return;
        }
        const at = nodes.indexOf(doc.activeElement);
        const next = event.shiftKey ? (at <= 0 ? nodes.at(-1) : null) : (at === -1 || at === nodes.length - 1 ? nodes[0] : null);
        if (next) {
            event.preventDefault?.();
            focusNode(next);
            layer.reveal?.(next);
        }
    };
    const onFocus = event => {
        const layer = top();
        if (!layer || !event.target || within(event.target, layer.root)) return;
        focusNode(focusablesIn(layer.root)[0] ?? layer.root);
    };

    function attach() {
        if (attached) return;
        attached = true;
        doc.addEventListener?.('keydown', onKeyDown);
        doc.addEventListener?.('focusin', onFocus, true);
    }
    function detach() {
        if (!attached) return;
        attached = false;
        doc.removeEventListener?.('keydown', onKeyDown);
        doc.removeEventListener?.('focusin', onFocus, true);
    }

    return {
        push(layer) {
            if (!layer?.root) throw new TypeError('A modal layer needs a root element.');
            prune();
            if (list.includes(layer)) return layer;
            const active = doc.activeElement;
            layer.opener = active && active !== doc.body && !within(active, layer.root) ? active : null;
            list.push(layer);
            // one above the layer under it: the top of the stack is the one painted on top
            z += 1;
            const stage = stageOf(layer);
            if (stage?.style) stage.style.zIndex = String(z);
            attach();
            return layer;
        },
        pop(layer, { focus = true } = {}) {
            prune();
            const at = list.indexOf(layer);
            if (at < 0) return false;
            const wasTop = at === list.length - 1;
            list.splice(at, 1);
            if (!list.length) detach();
            if (focus && wasTop) {
                const back = layer.opener && layer.opener.isConnected !== false ? layer.opener : null;
                const next = top();
                focusNode(back ?? (next ? focusablesIn(next.root)[0] ?? next.root : null));
            }
            layer.opener = null;
            return true;
        },
        top,
        has: layer => list.includes(layer),
        layers: () => list.slice(),
    };
}
