// How many skill slots a Skills block can hold and how many a character has at a level: 5 to start, one more at Lv 20, 40 and 60, up to 8 (a level drop
// never takes a skill away). The `sig` field marks the slots a pack's cast gave (bit n - 1 for slot n). Kept outside lean-rpg/ so the page start stays small.
export const SKILL_SLOTS_MAX = 8;
export const SKILL_SLOTS_BASE = 5;
export const SKILL_SLOTS_EVERY = 20;
export const skillSlots = level => Math.min(SKILL_SLOTS_MAX, SKILL_SLOTS_BASE + Math.floor((Number.isFinite(level) ? Math.max(0, level) : 0) / SKILL_SLOTS_EVERY));
// A Skills block made with the types (templates-skills.js) has three more slots, 9 to 11, and a `type<n>` field on every slot: a skill is `combat` (the slots above) or
// `utility` (three of their own, for the story only). A block with no `type1` field is read as all combat and keeps its slots as they were.
export const UTILITY_SLOTS = 3;
export const SKILL_FIELDS_MAX = SKILL_SLOTS_MAX + UTILITY_SLOTS;
export const SKILL_TYPES = Object.freeze(['combat', 'utility']);
export const SLOT_NUMBER = '(?:[1-9]|1[01])';
export const isTypedSkills = fields => Boolean(fields) && Object.hasOwn(fields, 'type1');
export const skillFieldSlots = fields => (isTypedSkills(fields) ? SKILL_FIELDS_MAX : SKILL_SLOTS_MAX);
export const skillTypeOf = (fields, slot) => (isTypedSkills(fields) && fields[`type${slot}`] === 'utility' ? 'utility' : 'combat');
export const SIGNATURE_FIELD = 'sig';
export const signatureAt = (value, slot) => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(slot) && slot >= 1 && slot <= SKILL_FIELDS_MAX && (value >> (slot - 1)) % 2 === 1;
