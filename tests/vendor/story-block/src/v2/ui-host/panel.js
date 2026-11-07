// Builds the Story panel and its tab host when the reader opens it.
// The tab host stays available to the page's navigation, refresh and teardown callbacks.

import { createTabHost } from '../host-ui.js';
import { slotsForWidth } from '../view/screen-bar.js';
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

    // The strip's slots before More: four on a phone's bottom sheet; on the side sheet (from 760px, the game view's line) as many as its width holds.
    const panelSlots = () => slotsForWidth(Number(panel.clientWidth), { wide: doc.defaultView?.matchMedia?.('(min-width: 760px)')?.matches === true });
    function openPanel() {
        panel.hidden = false;
        doc.body.classList.add('story-suite-sheet-open');
        if (!getTabHost()) setTabHost(createTabHost(panelBody, { registry: tabSource, view: () => sdk.view(), api: sdk, doc, barHost: panel, slots: panelSlots,
            inBar: tab => isInBar(tabOrder.choice(), navKey(tab), barDeclared(navKey(tab))) }));
        else getTabHost().refresh();
    }
    function closePanel() {
        // More's sheet, if it is open, goes with the panel: its scrim and its keys (the focus does not go to a hidden tile). The
        // dialogs the panel opened go too (their opener is in the panel, and it is about to be hidden).
        getTabHost()?.bar?.closeMore({ focus: false });
        mounts.dialog?.closeOpenedIn?.(panel);
        panel.hidden = true;
        doc.body.classList.remove('story-suite-sheet-open');
    }
    panelClose.addEventListener('click', closePanel);

    return { panel, offerBox, openPanel, closePanel };
}
