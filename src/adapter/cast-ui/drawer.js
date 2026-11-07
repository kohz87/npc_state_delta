// The drawer copy of Delta's settings panel: hides the original panel while hosted in Story Suite and restores its own
// display and dataset marker when the host releases it. Keeps the saved display values in this part's weak map.

import { HIDDEN_FLAG } from './dom.js';

export function createDrawerPart(session, { panel }) {
    const savedDisplay = new WeakMap();

    // ---- the drawer copy ----

    function hidePanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] === '1') return;
        savedDisplay.set(node, node.style.display ?? '');
        node.style.display = 'none';
        if (node.dataset) node.dataset[HIDDEN_FLAG] = '1';
    }

    function showPanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] !== '1') return;
        node.style.display = savedDisplay.get(node) ?? '';
        savedDisplay.delete(node);
        delete node.dataset[HIDDEN_FLAG];
    }

    // While hosted, the panel is hidden wherever it is except inside the overlay.
    function syncDrawer() {
        const node = panel();
        if (!node || (session.mounted && session.mounted.node === node)) return;
        if (session.hosted) hidePanel(node);
        else showPanel(node);
    }

    return { syncDrawer, showPanel };
}
