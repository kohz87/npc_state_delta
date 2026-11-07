// Builds the page's tab source and Settings navigation controls.
// The panel and its tab host are read when navigation changes, after they have been mounted.

import { TABS_TEXT } from '../host-ui.js';
import { HOME_ID } from '../view/screens.js';
import { activeNow } from '../view/mounts/common.js';
import { isDefaultChoice, isHiddenNav, isInBar, moveNav, navKey, orderNav, setNavHidden, setNavInBar, visibleNav } from '../view/tab-order.js';

export function createUiNavigation({ registry, extraTabs, store, queryAt, screens, tabOrder, navPresent, barDeclared, mounts, getPanel, getTabHost }) {
    // The tab host sees the module tabs and the tab screens as one list, in the reader's order (else the
    // default: screens.js screenOrder), without the ones the reader hid. A module tab goes by
    // "<module>/<id>" there, so NPC State Delta's Cast tab and its Cast screen are one entry.
    const panelTabs = () => [...registry.tabs(), ...extraTabs.map(tab => ({ ...tab, moduleId: 'screens' }))];
    // A module's tab that is active only sometimes is listed while its `active` says so (its alert is read at each draw).
    const headStateNow = () => { const index = store.headIndex(); return Number.isInteger(index) && index >= 0 ? store.at(index) : null; };
    const activeTabs = () => panelTabs()
        .filter(tab => typeof tab.active !== 'function' || activeNow(tab, headStateNow(), queryAt).on)
        .map(tab => {
            if (typeof tab.active !== 'function') return tab;
            const now = activeNow(tab, headStateNow(), queryAt);
            return { ...tab, alert: now.alert, alertText: now.badge ?? '' };
        });
    const tabSource = { tabs: () => visibleNav(activeTabs(), tabOrder.choice(), navKey, tab => tab.order, navPresent) };

    // Settings → Tabs & Packs → Tabs: every tab and screen once (by id), where it shows, in the reader's order.
    function tabRows() {
        const rows = new Map();
        const add = (id, screen, where) => {
            if (!id) return;
            const { title, icon, order } = screen ?? {};
            const row = rows.get(id) ?? { id, title: String(title || id), icon: icon || '', order, where: [] };
            if (!row.where.includes(where)) row.where.push(where);
            // A tab or screen that is shown only while active: Settings says so instead of a switch (its own note, if it gave one).
            if (typeof screen?.active === 'function') row.activeNote = typeof screen.activeNote === 'string' && screen.activeNote ? screen.activeNote : TABS_TEXT.activeNote;
            rows.set(id, row);
        };
        for (const mount of ['screen', 'tab']) for (const entry of screens.list(mount)) add(entry.id, entry.screen, mount);
        for (const tab of registry.tabs()) add(navKey(tab), tab, 'tab');
        const choice = tabOrder.choice();
        // Two tabs with the same name (two blocks, a pack's tab and a module's) are told apart: the later ones are numbered, "Notes (2)".
        const seen = new Map();
        const named = title => {
            const plain = title.replace(/\s+/g, ' ').trim();
            const count = (seen.get(plain.toLowerCase()) ?? 0) + 1;
            seen.set(plain.toLowerCase(), count);
            return count > 1 ? `${plain} (${count})` : title;
        };
        return orderNav([...rows.values()], choice).map(row => ({
            ...row,
            title: named(row.title),
            fixed: row.id === HOME_ID,
            hidden: isHiddenNav(choice, row.id, navPresent),
            inBar: isInBar(choice, row.id, barDeclared(row.id)),
        }));
    }
    // After a change: the tab strip and the game view's navigation follow at once.
    function refreshNav() {
        if (!getPanel().hidden) getTabHost()?.refresh();
        mounts.screen.update();
    }
    const tabsControl = Object.freeze({
        rows: tabRows,
        move(id, delta) {
            const ids = tabRows().filter(row => !row.fixed).map(row => row.id);
            tabOrder.set(moveNav(tabOrder.choice(), ids, id, delta));
            refreshNav();
        },
        setHidden(id, hidden) {
            tabOrder.set(setNavHidden(tabOrder.choice(), id, hidden));
            refreshNav();
        },
        setInBar(id, inBar) {
            tabOrder.set(setNavInBar(tabOrder.choice(), id, inBar, barDeclared(id)));
            refreshNav();
        },
        reset() {
            tabOrder.reset();
            refreshNav();
        },
        isDefault: () => isDefaultChoice(tabOrder.choice()),
    });

    return { headStateNow, tabSource, tabsControl };
}
