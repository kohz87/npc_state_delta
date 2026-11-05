// The `inventory` domain (§7): item definitions, stacks, wallets and the alias index, with
// its validator, commands, capture kinds `item` and `coin`, queries and prompt view. Pure.
//
// Handlers follow §3.2: synchronous, everything through ctx (read/draft/call/claim/rng/fail).
// A stack whose count reaches 0 is removed, never kept at 0 (§2.5). Numbers are set by code:
// a change line proposes, these functions decide. Payloads, codes and money follow MODULES.md F:
// a rule refusal is REFUSED, a malformed payload INVALID; a wallet is { coin: n } in the smallest unit.

export { validateInventory } from './inventory/slice.js';
export { createInventoryQueries } from './inventory/answers.js';
export { TOLD, createInventoryCommands } from './inventory/commands.js';
export { USED_WORDS, GONE_WORDS, usedByLine, captureItem, captureCoin } from './inventory/story.js';
export { LOOT_ITEMS, LOOT_KEEP, LOOT_GUARD, LOOT_OFFER, LOOT_KINDS, captureLoot, lootTakeGuard } from './inventory/loot.js';
export { kitOpen, INVENTORY_EDIT_GUARD, inventoryEditGuard } from './inventory/edit.js';
export { ECONOMY_SCALE, economyOf, scaledDefault } from './inventory/stacks.js';
export { STORY_WEAR, wearWord } from './inventory/wear.js';
export { DEFINITIONS_MAX_IDS, carryBonuses, listItems, equipmentView, ENCUMBERED_PENALTY, defCarry, ENCUMBERED_STATS, encumbrance, encumbranceTail, definitionsOf } from './inventory/queries.js';
export { KINDS, RARITIES, KIND_ORDER, initialInventory, FEATURE, INVENTORY_FEATURES, gearOn, featureOn, COND_MAX, COND_LOG_MAX, condEvents, condOf, defaultDef, CARRY_MAX, packCarry } from './inventory/state.js';
export { itemText, legendEarned, MANY_SLOTS, MAX_MANY, baseSlot, slotLimits, canWear } from './inventory/validate.js';
export { promptNote, WALLET_NOTE, inventoryTail } from './inventory/prompt.js';
