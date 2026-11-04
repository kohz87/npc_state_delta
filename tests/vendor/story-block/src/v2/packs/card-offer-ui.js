// The card offer's notices at the top of the Story panel (card-offer.js draws nothing; this does).
//
// One notice per offered pack, built from classes the app already has: `.story-suite-notice` and its text, `.ss-button` primary and quiet in
// `.ss-packs-confirm-actions`, the Packs panel's `fa-book`, SillyTavern's `.checkbox_label`, and `.ss-card-help` for the muted lines.
// Everything a card wrote (names, versions) goes in through textContent only.

import { button, el } from '../../ui/dom.js';

/**
 * Draws the offers into `root` and again at each change. `offer`: card-offer.js's controller. → `{ refresh(), destroy() }`.
 */
export function renderCardOffers(root, offer, { doc = globalThis.document } = {}) {
    const make = (tag, className = '', text = '') => el(tag, className, text, doc);
    // The "Also apply" boxes, ticked until the player unticks one (kept across redraws).
    const ticked = new Map();

    function textOf(item) {
        const node = make('span', 'story-suite-notice-text');
        if (item.state === 'done' || item.state === 'failed') {
            node.textContent = item.result;
            return node;
        }
        if (item.update) {
            node.append('This card has a newer ', make('b', '', item.name), `: ${item.version} (installed ${item.installedVersion})`);
        } else {
            node.append('This card brings ', make('b', '', item.name), ` ${item.version}${item.brings ? ` — ${item.brings}` : ''}`);
        }
        return node;
    }

    function notice(item) {
        const box = make('div', 'story-suite-notice ss-card-offer');
        box.dataset.pack = item.packId;
        box.dataset.state = item.state;
        box.setAttribute('role', item.state === 'offer' ? 'group' : 'status');
        box.setAttribute('aria-label', `Card offer: ${item.name}`);
        const icon = make('i', 'fa-solid fa-book ss-card-offer-icon');
        icon.setAttribute('aria-hidden', 'true');
        box.append(icon, textOf(item));
        if (item.state === 'done' || item.state === 'failed') {
            const close = button('menu_button story-suite-notice-close ss-card-offer-close', { title: 'Dismiss', icon: 'fa-xmark' });
            close.addEventListener('click', () => offer.dismiss(item.id));
            box.append(close);
            return box;
        }
        const working = item.state === 'working';
        let check = null;
        if (item.settings.length) {
            const label = make('label', 'checkbox_label ss-card-offer-settings');
            check = make('input');
            check.type = 'checkbox';
            check.setAttribute('type', 'checkbox');
            check.checked = ticked.get(item.id) !== false;
            check.disabled = working;
            check.addEventListener('change', () => ticked.set(item.id, check.checked));
            label.append(check, make('span', '', `Also apply: ${item.settings.map(setting => setting.text).join(' · ')}`));
            box.append(label);
        }
        for (const note of item.notes) box.append(make('p', 'ss-card-help ss-card-offer-note', note));
        const actions = make('div', 'ss-packs-confirm-actions ss-card-offer-actions');
        const go = button('ss-button ss-button-primary ss-card-offer-install', { text: item.update ? 'Update' : 'Install' });
        go.disabled = working || item.blocked;
        if (item.blocked) go.title = item.notes[0] ?? '';
        go.addEventListener('click', () => { offer.install(item.id, { settings: check ? check.checked : false }); });
        const later = button('ss-button ss-button-quiet ss-card-offer-later', { text: 'Not now' });
        later.disabled = working;
        later.addEventListener('click', () => offer.notNow(item.id));
        actions.append(go, later);
        box.append(actions);
        return box;
    }

    function refresh() {
        const items = offer.offers();
        root.hidden = items.length === 0;
        root.replaceChildren(...items.map(notice));
    }
    const off = offer.subscribe(refresh);
    refresh();
    return { refresh, destroy: () => { off(); root.replaceChildren(); } };
}
