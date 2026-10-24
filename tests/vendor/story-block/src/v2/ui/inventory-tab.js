// Inventory tab: a minimal plain renderer (no styling) from the head state. One row per stack,
// grouped by kind, with its quantity, rarity, equipped slot and note; Equip/Unequip and Drop
// call sdk commands. Drop asks for a second click. Model text only ever goes in textContent.
//
// Interim: the tab layer is being redesigned (layouts of module widgets), so this stays small.

import { KIND_ORDER, listItems } from '../domains/inventory.js';
import { ownerName } from '../domains/common.js';
import { DEFAULT_CURRENCY, formatWallet } from '../domains/money.js';

const KIND_TITLES = {
    quest: 'Quest items', equipment: 'Equipment', consumable: 'Consumables',
    material: 'Materials', goods: 'Goods', money: 'Valuables',
};

function make(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function actionButton(doc, action, stack, text) {
    const node = make(doc, 'button', 'ss-inv-action', text);
    node.type = 'button';
    node.dataset.action = action;
    node.dataset.stack = stack;
    return node;
}

/** (el, view, api, { currency }): `api.command(type, payload, { cause })` as the sdk's. */
export function renderInventoryTab(el, view, api, { currency = DEFAULT_CURRENCY } = {}) {
    const doc = el.ownerDocument ?? globalThis.document;
    const state = view?.state;
    const inventory = state?.domains?.inventory;
    const items = listItems(inventory);
    const root = make(doc, 'div', 'ss-inv');
    root.append(make(doc, 'div', 'ss-inv-wallet', `Wallet: ${formatWallet(inventory?.wallets?.party, currency)}`));
    const status = make(doc, 'div', 'ss-inv-status');
    root.append(status);
    if (!items.length) root.append(make(doc, 'div', 'ss-inv-empty', 'Nothing carried.'));
    const kinds = [...KIND_ORDER, ...new Set(items.map(item => item.kind).filter(kind => !KIND_ORDER.includes(kind)))];
    for (const kind of kinds) {
        const group = items.filter(item => item.kind === kind);
        if (!group.length) continue;
        const section = make(doc, 'div', 'ss-inv-group');
        section.dataset.kind = kind;
        section.append(make(doc, 'div', 'ss-inv-group-title', KIND_TITLES[kind] ?? kind));
        for (const item of group) {
            const row = make(doc, 'div', `ss-inv-row ss-rarity-${item.rarity}${item.equipped ? ' is-equipped' : ''}`);
            row.dataset.stack = item.stack;
            row.append(make(doc, 'span', 'ss-inv-name', item.name));
            if (item.qty !== 1) row.append(make(doc, 'span', 'ss-inv-qty', `×${item.qty}`));
            row.append(make(doc, 'span', 'ss-inv-rarity', item.rarity));
            if (item.key) row.append(make(doc, 'span', 'ss-inv-key', 'key item'));
            if (item.equipped) row.append(make(doc, 'span', 'ss-inv-equipped', `equipped: ${item.equipped}`));
            if (item.owner !== 'party') row.append(make(doc, 'span', 'ss-inv-owner', ownerName(state, item.owner)));
            if (item.note) row.append(make(doc, 'div', 'ss-inv-note', item.note));
            const actions = make(doc, 'div', 'ss-inv-actions');
            if (item.equipped) actions.append(actionButton(doc, 'unequip', item.stack, 'Unequip'));
            else if (item.kind === 'equipment') actions.append(actionButton(doc, 'equip', item.stack, 'Equip'));
            actions.append(actionButton(doc, 'drop', item.stack, 'Drop'));
            row.append(actions);
            section.append(row);
        }
        root.append(section);
    }
    root.addEventListener('click', event => {
        const button = event.target?.closest?.('button[data-action]');
        if (!button || button.disabled) return;
        const { action, stack } = button.dataset;
        if (action === 'drop' && button.dataset.confirm !== 'yes') {
            button.dataset.confirm = 'yes';
            button.textContent = 'Drop?';
            return;
        }
        button.disabled = true;
        status.textContent = '';
        Promise.resolve(api?.command?.(`inventory.${action}`, { stack }, { cause: 'ui' }))
            .then(result => {
                if (result && result.ok === false) status.textContent = result.message ?? 'That did not work.';
            })
            .catch(error => {
                status.textContent = String(error?.message ?? error);
            })
            .finally(() => {
                button.disabled = false;
            });
    });
    el.replaceChildren(root);
    return root;
}
