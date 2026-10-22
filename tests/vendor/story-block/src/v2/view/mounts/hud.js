// Story Suite v2: the `hud` mount (SPEC §13.4), a thin strip above the message box showing every usable
// screen that allows 'hud', from the head state. It sits right before SillyTavern's `#send_form` (or the
// injected anchor) and redraws when the head changes.
//
// deps (see common.js) plus:
//   anchor   () → the element the strip goes above (optional, default #send_form)
//
// → { mount(el, screenId, opts) → handle, show() → strip | null, hide(), update(), element(), destroy() }

import { documentOf, make, mountHead, onHead, screensFor } from './common.js';

export function createHudMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The hud mount needs a render(el, screen, scope) function.');
    const doc = documentOf(deps);
    let strip = null;
    let handles = [];
    let off = () => {};

    function mount(el, screenId, opts = {}) {
        return mountHead(deps, 'hud', el, screenId, opts);
    }

    function fill() {
        handles.forEach(handle => handle.unmount());
        handles = [];
        strip.replaceChildren();
        for (const entry of screensFor(deps, 'hud')) {
            const item = make(doc, 'div', 'ss-hud-item');
            strip.appendChild(item);
            handles.push(mount(item, entry.id));
        }
        strip.hidden = handles.length === 0;
        strip.classList.toggle('ss-hud-empty', handles.length === 0);
    }

    /** Puts the strip above the message box (once) and fills it. Null when there is no message box. */
    function show() {
        const anchor = deps.anchor ? deps.anchor() : doc.querySelector('#send_form');
        if (!anchor?.parentNode) return null;
        if (!strip) {
            strip = make(doc, 'div', 'ss-hud');
            strip.setAttribute('role', 'region');
            strip.setAttribute('aria-label', 'Story status');
            off = onHead(deps, update);
        }
        if (strip.parentNode !== anchor.parentNode || strip.nextElementSibling !== anchor) anchor.parentNode.insertBefore(strip, anchor);
        fill();
        return strip;
    }

    function hide() {
        if (!strip) return;
        off();
        off = () => {};
        handles.forEach(handle => handle.unmount());
        handles = [];
        strip.remove();
        strip = null;
    }

    /** Redraws each item; refills when the set of hud screens changed. */
    function update() {
        if (!strip) return;
        const ids = screensFor(deps, 'hud').map(entry => entry.id);
        if (ids.length !== handles.length || ids.some((id, i) => handles[i].screenId !== id)) fill();
        else handles.forEach(handle => handle.update());
    }

    return { mount, show, hide, update, element: () => strip, destroy: hide };
}
