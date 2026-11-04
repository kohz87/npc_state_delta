// Story Suite v2: the tab host (moved out of host-ui.js unchanged; host-ui.js re-exports createTabHost): the story panel's tab bar
// with every module tab, each rendered from the head state's view.

import { createScreenBar, PINNED, pinAlerts } from '../view/screen-bar.js';
import { iconFor } from '../view/icons/index.js';
import { dispose } from '../view/mounts/common.js';
import { el } from './controls.js';
import { S } from './text.js';

/**
 * The story panel's tab host, drawn into `root`: one pane, the chosen tab's, rendered with `tab.render(pane, view(), api)`,
 * and the screen bar (view/screen-bar.js) at the foot of the panel, in `barHost` (the panel itself; `root` if none): four
 * tabs and More, as the game view's bar (More holds the rest). The tabs are `registry.tabs()`, in its order (Story Block's
 * panel gives the module tabs and the tab screens in the reader's order, without the hidden ones). A tab that is gone falls
 * back to the first. The pane scrolls inside `root`; the bar stays where it is.
 * `options`: { registry, view: () => view, api (the sdk), doc?, active?, barHost?, inBar? (tab → in the bar, not under More), slots? (→ how many
 * slots the strip has before More, four by default; the panel gives more on a wide window) }. A screen the reader put in the bar takes a slot
 * in the reader's order; when more are in the bar than there are slots, the ones past the last slot are under More as well (the game view's
 * phone bar does the same). Tabs read the head state's view only,
 * never message text. Returns { refresh(), select(id), active(), bar }.
 */
export function createTabHost(root, { registry, view, api = null, doc = globalThis.document, active = null, barHost = null, inBar = null, slots = null }) {
    let current = active;
    let release = null;       // what the last drawing of the pane left behind (a dispose function or { destroy }), taken down on the next draw
    const pane = el(doc, 'div', 'story-suite-pane');
    root.replaceChildren(pane);
    // The panel's own names on each tab's button and its More tile: `story-suite-tab` and `data-tab-id` (the tests and the
    // modules use them), and the full label as the title (the bar cuts a long one).
    const bar = createScreenBar(doc, barHost ?? root, {
        label: S.panel.tabs,
        className: 'story-suite-sheet-bar',
        onSelect: id => select(id),
        decorate(node, item) {
            node.classList.add('story-suite-tab');
            node.setAttribute('data-tab-id', item.id);
        },
    });

    // The strip: the tabs that are in the bar take the slots in the reader's order, the rest are under More.
    function drawBar(tabs) {
        let room = PINNED;
        try { room = typeof slots === 'function' ? Number(slots()) || PINNED : PINNED; } catch { room = PINNED; }
        room = Math.max(1, Math.floor(room));
        // An active tab's alert (a red dot) takes the last pinned slot while it has something to show (screen-bar.js pinAlerts).
        bar.update({ items: pinAlerts(tabs.map(tab => ({ id: tab.id, label: tab.title, icon: iconFor(tab.id, tab.icon), alert: tab.alert === true,
            alertText: tab.alertText ?? '', moreOnly: typeof inBar === 'function' && !inBar(tab) })), room), current: current ?? '', pinned: room });
    }
    // The panel's width changes with the window: the strip is laid out again (the open tab is left as it is).
    const win = doc.defaultView ?? null;
    const onResize = () => { if (typeof slots === 'function') drawBar(registry.tabs()); };
    win?.addEventListener?.('resize', onResize);

    function draw() {
        const tabs = registry.tabs();
        if (!tabs.some(tab => tab.id === current)) current = tabs[0]?.id ?? null;
        drawBar(tabs);
        // The pane's widgets go before the pane is drawn again (a redraw of the same tab too): their listeners and observers.
        dispose(pane);
        if (typeof release === 'function') { try { release(); } catch { /* a tab's cleanup failing must not block the redraw */ } }
        release = null;
        pane.replaceChildren();
        const tab = tabs.find(item => item.id === current);
        pane.dataset.tabId = tab?.id ?? '';
        if (!tab) {
            pane.appendChild(el(doc, 'p', 'story-suite-muted', 'No module has a tab yet.'));
            return;
        }
        try {
            const out = tab.render(pane, view(), api);
            if (typeof out === 'function') release = out;
            else if (out && typeof out.destroy === 'function') release = () => out.destroy();
        } catch (error) {
            pane.replaceChildren(el(doc, 'p', 'story-suite-muted', `${tab.title} could not be shown: ${error?.message ?? error}`));
        }
    }
    function select(id) {
        current = id;
        draw();
    }
    draw();
    return {
        refresh: draw,
        select,
        active: () => current,
        bar,
        /** Takes the open tab's widgets down (its pane disposed, and what its render returned). */
        destroy() {
            win?.removeEventListener?.('resize', onResize);
            dispose(pane);
            if (typeof release === 'function') { try { release(); } catch { /* a tab's cleanup failing must not block teardown */ } }
            release = null;
        },
    };
}
