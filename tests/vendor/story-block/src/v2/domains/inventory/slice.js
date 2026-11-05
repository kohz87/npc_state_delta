// The inventory domain's whole-slice validator (moved out of domains/inventory.js unchanged; inventory.js re-exports it). It sits above loot.js
// (it checks the loot offers), so it cannot live in validate.js, which loot.js imports.

import { isPlainObject, OWNER_RE } from '../common.js';
import { WALLET_KEY } from '../money.js';
import { isId } from '../../check.js';
import { defErrors, isCount, nonBlank, COND_MAX, condLogErrors, keptErrors } from './state.js';
import { lootErrors } from './loot.js';

export function validateInventory(slice) {
    if (!isPlainObject(slice)) return ['The inventory is not a record.'];
    const parts = ['defs', 'stacks', 'wallets', 'aliases'].filter(part => !isPlainObject(slice[part]));
    if (parts.length) return parts.map(part => `The inventory has no ${part} record.`);
    const { defs, stacks, wallets, aliases } = slice;
    const errors = [];
    for (const [key, def] of Object.entries(defs)) errors.push(...defErrors(key, def));
    const worn = new Set();
    for (const [key, stack] of Object.entries(stacks)) {
        if (!isPlainObject(stack)) {
            errors.push(`Item stack ${key} is not a record.`);
            continue;
        }
        const def = isPlainObject(defs[stack.def]) ? defs[stack.def] : null;
        const label = def?.name ?? key;
        if (stack.id !== key) errors.push(`Item stack ${key} is filed under the wrong ID.`);
        if (!isId(key, 'it')) errors.push(`"${key}" is not a well-formed item stack ID.`);
        if (!def) errors.push(`Item stack ${key} refers to an item definition that does not exist (${stack.def}).`);
        if (!isCount(stack.qty, 1)) errors.push(`${label} has quantity ${stack.qty}; a stack holds a whole number of at least 1 (an empty stack is removed).`);
        else if (def && def.stack === false && stack.qty !== 1) errors.push(`${label} does not stack, so each one is its own stack of 1.`);
        if (typeof stack.owner !== 'string' || !OWNER_RE.test(stack.owner)) errors.push(`${label} has an owner that is neither the party nor an actor ID.`);
        if (stack.equipped !== null) {
            if (!nonBlank(stack.equipped)) errors.push(`${label} has an equipped slot that is neither empty nor a name.`);
            else {
                if (def && def.kind !== 'equipment') errors.push(`${label} is worn in "${stack.equipped}" but is not equipment.`);
                const place = `${stack.owner}\u0000${stack.equipped}`;
                if (worn.has(place)) errors.push(`Two items are worn in the same slot "${stack.equipped}" by the same owner.`);
                worn.add(place);
            }
        }
        if (typeof stack.note !== 'string') errors.push(`${label} has a note that is not text.`);
        if (typeof stack.from !== 'string') errors.push(`${label} has an origin that is not a receipt ID.`);
        if (stack.cond !== undefined && !(Number.isSafeInteger(stack.cond) && stack.cond >= 0 && stack.cond <= COND_MAX)) {
            errors.push(`${label} has a condition of ${stack.cond}; it is a whole number from 0 to ${COND_MAX}.`);
        }
        if (stack.key !== undefined && stack.key !== true) errors.push(`${label} is marked as a key item with something other than true.`);
        if (stack.story !== undefined && stack.story !== true) errors.push(`${label} is marked as the story's with something other than true.`);
        if (stack.bound !== undefined && !(typeof stack.bound === 'string' && stack.bound !== 'party' && OWNER_RE.test(stack.bound))) errors.push(`${label} is bound to something that is not a party member's ID.`);
    }
    for (const [owner, wallet] of Object.entries(wallets)) {
        if (!OWNER_RE.test(owner)) errors.push(`A wallet belongs to "${owner}", who is neither the party nor an actor ID.`);
        if (!isPlainObject(wallet)) {
            errors.push(`The wallet of ${owner} is not a record.`);
            continue;
        }
        for (const [key, amount] of Object.entries(wallet)) {
            if (key !== WALLET_KEY) errors.push(`The wallet of ${owner} holds "${key}"; a wallet keeps one amount, under ${WALLET_KEY}.`);
            else if (!isCount(amount, 0)) errors.push(`The wallet of ${owner} holds ${amount}; money is a whole number of at least 0.`);
        }
    }
    for (const [key, id] of Object.entries(aliases)) {
        if (!key || key !== key.trim().toLowerCase()) errors.push(`The item name "${key}" is not written in lowercase.`);
        if (!isPlainObject(defs[id])) errors.push(`The item name "${key}" points to a definition that does not exist (${id}).`);
    }
    if (slice.loot !== undefined) errors.push(...lootErrors(slice.loot));
    if (slice.condLog !== undefined) errors.push(...condLogErrors(slice.condLog));
    if (slice.kept !== undefined) errors.push(...keptErrors(slice.kept));
    return errors;
}
