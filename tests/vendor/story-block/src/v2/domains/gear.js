// Gear in fights, the inventory side (`story-block.gear`, docs/v2/GEAR.md). This path keeps every public export;
// the rules live in gear/stats.js (slots, rarity and stat budgets), gear/carry.js (capacity and mounts),
// gear/views.js (the gear query answers) and gear/conditions.js (wear words and prices). Pure.

export { GEAR } from './gear/stats.js';
export { slotWordOf, placeOf, gearSlotOf, gearRarityOf, statsOf, withinBudget, defaultStat, gearDefine, handDef, packBonus, gearBudget, statsFor } from './gear/stats.js';
export { KIND_CARRY, OTHER_CARRY, kindCarry, itemCarryOf, travelsWith, capacityFor, carryPicture, carryAnswer, atLimit, loadLevel } from './gear/carry.js';
export { statBonus, gearAnswer, bonusText, gearView, createGearQueries } from './gear/views.js';
export { CONDITION, condWord, stepDown, stepUp, condMark, valueByCond } from './gear/conditions.js';
