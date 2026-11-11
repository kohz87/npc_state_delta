// Story Suite v2: the tab host (moved out of host-ui.js unchanged; host-ui.js re-exports createTabHost): the story panel's tab bar
// with every module tab, each rendered from the head state's view.

import { createScreenBar } from '../view/screen-bar.js';
import { iconFor } from '../view/icons/index.js';
import { dispose } from '../view/mounts/common.js';
import { el } from './controls.js';
import { S } from './text.js';

/**
 * The story panel's tab host, drawn into `root`: one pane, the chosen tab's, rendered with `tab.render(pane, view(), api)`,
 * and the screen bar (view/screen-bar.js) at the foot of the panel, in `barHost` (the panel itself; `root` if none): every tab in one
 * row that scrolls sideways, no More. The tabs are `registry.tabs()`, in its order (Story Block's
 * panel gives the module tabs and the tab screens in the reader's order, without the hidden ones). A tab that is gone falls
 * back to the first. The pane scrolls inside `root`; the bar stays where it is.
 * `options`: { registry, view: () => view, api (the sdk), doc?, active?, barHost?, inBar? (tab → in the bar; the others follow
 * the ones that are, in the same strip) }. Tabs read the head state's view only,
 * never message text. Returns { refresh(), select(id), active(), bar }.
 */
export function createTabHost(root, { registry, view, api = null, doc = globalThis.document, active = null, barHost = null, inBar = null }) {
    let current = active;
    let release = null;       // what the last drawing of the pane left behind (a dispose function or { destroy }), taken down on the next draw
    const pane = el(doc, 'div', 'story-suite-pane');
    root.replaceChildren(pane);
    // The panel's own names on each tab's button: `story-suite-tab` and `data-tab-id` (the tests and the
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

    // The strip: every tab in one row that scrolls sideways, the ones in the bar first (the reader's order), the rest after them.
    function drawBar(tabs) {
        bar.update({ items: tabs.map(tab => ({ id: tab.id, label: tab.title, icon: iconFor(tab.id, tab.icon), alert: tab.alert === true,
            alertText: tab.alertText ?? '', moreOnly: typeof inBar === 'function' && !inBar(tab) })), current: current ?? '' });
    }

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
            dispose(pane);
            if (typeof release === 'function') { try { release(); } catch { /* a tab's cleanup failing must not block teardown */ } }
            release = null;
        },
    };
}
