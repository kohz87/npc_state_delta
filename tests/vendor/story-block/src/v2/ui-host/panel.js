// Builds the Story panel and its tab host when the reader opens it.
// The tab host stays available to the page's navigation, refresh and teardown callbacks.

import { createTabHost } from '../host-ui.js';
import { isInBar, navKey } from '../view/tab-order.js';
import { IDS, el, iconButton, S } from './shared.js';

export function createUiPanel({ doc, sdk, tabSource, tabOrder, barDeclared, mounts, getTabHost, setTabHost }) {
    // ---- the panel ---------------------------------------------------------------------------
    const panel = el(doc, 'div', 'story-suite-sheet');
    panel.id = IDS.panel;
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', S.panel.title);
    const panelHead = el(doc, 'div', 'story-suite-sheet-head');
    panelHead.appendChild(el(doc, 'b', '', S.panel.title));
    const panelClose = iconButton(doc, 'story-suite-sheet-close', 'fa-xmark', '', S.panel.close);
    panelHead.appendChild(panelClose);
    const panelBody = el(doc, 'div', 'story-suite-sheet-body');
    // The card's offer (packs/card-offer.js): one notice per pack the open card brings, between the head and the tabs.
    const offerBox = el(doc, 'div', 'ss-card-offers');
    offerBox.hidden = true;
    panel.append(panelHead, offerBox, panelBody);
    doc.body.appendChild(panel);

    function openPanel() {
        panel.hidden = false;
        doc.body.classList.add('story-suite-sheet-open');
        if (!getTabHost()) setTabHost(createTabHost(panelBody, { registry: tabSource, view: () => sdk.view(), api: sdk, doc, barHost: panel,
            inBar: tab => isInBar(tabOrder.choice(), navKey(tab), barDeclared(navKey(tab))) }));
        else getTabHost().refresh();
    }
    function closePanel() {
        // The dialogs the panel opened go with it (their opener is in the panel, and it is about to be hidden).
        mounts.dialog?.closeOpenedIn?.(panel);
        panel.hidden = true;
        doc.body.classList.remove('story-suite-sheet-open');
    }
    panelClose.addEventListener('click', closePanel);

    return { panel, offerBox, openPanel, closePanel };
}
