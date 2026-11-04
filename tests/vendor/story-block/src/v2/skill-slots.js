// How many skill slots a Skills block can hold and how many a character has at a level: 5 to start, one more at Lv 20, 40 and 60, up to 8 (a level drop
// never takes a skill away). The `sig` field marks the slots a pack's cast gave (bit n - 1 for slot n). Kept outside lean-rpg/ so the page start stays small.
export const SKILL_SLOTS_MAX = 8;
export const SKILL_SLOTS_BASE = 5;
export const SKILL_SLOTS_EVERY = 20;
export const skillSlots = level => Math.min(SKILL_SLOTS_MAX, SKILL_SLOTS_BASE + Math.floor((Number.isFinite(level) ? Math.max(0, level) : 0) / SKILL_SLOTS_EVERY));
export const SIGNATURE_FIELD = 'sig';
export const signatureAt = (value, slot) => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(slot) && slot >= 1 && slot <= SKILL_SLOTS_MAX && (value >> (slot - 1)) % 2 === 1;
