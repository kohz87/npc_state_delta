// What a manual dossier Save writes about field locks.
//
// "Protect edited stable profile fields" locks every stable field the reader changed, keeps the locks
// already on the dossier, and unticked clears them all. Either way the choice is the reader's own, so
// the record is marked explicit: a swipe or branch restore then re-applies the locked fields and the
// lock list itself (branch-core.js preserveUserNpcMetadata) instead of reverting to an older copy.
import { normalizeCustomFields } from '../core.js';

// The fields the editor locks when the reader changes them.
export const EDITOR_LOCKABLE_FIELDS = Object.freeze([
    'name', 'role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'personality', 'speech',
    'behaviorProfile', 'background', 'mannerisms', 'keyRelationships', 'customFields', 'aliases',
]);
const LIST_FIELDS = new Set(['mannerisms', 'behaviorProfile', 'keyRelationships', 'aliases']);

// The stored keys a lock covers: a lock on a field keeps everything that field is made of, so a
// restored or imported copy never pairs a kept value with another copy's parts.
export const LOCKED_FIELD_KEYS = Object.freeze({
    name: ['name', 'identityKind'],
    role: ['role'],
    species: ['species'],
    gender: ['gender'],
    homeBase: ['homeBase'],
    age: ['age'],
    apparentAge: ['apparentAge', 'apparentAgeAnchor'],
    appearance: ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion'],
    personality: ['personality'],
    speech: ['speech'],
    behaviorProfile: ['behaviorProfile'],
    background: ['background'],
    mannerisms: ['mannerisms'],
    keyRelationships: ['keyRelationships'],
    customFields: ['customFields'],
    aliases: ['aliases'],
});
export function lockedFieldKeys(field) {
    return LOCKED_FIELD_KEYS[field] || [field];
}

function comparable(npc, key) {
    if (key === 'customFields') return JSON.stringify(normalizeCustomFields(npc?.customFields));
    return LIST_FIELDS.has(key) ? JSON.stringify(npc?.[key] || []) : String(npc?.[key] || '');
}

// The lock fields of the saved record, from the dossier before the Save (current), the edited copy
// (next) and the state of the protect checkbox.
export function editorProfileLocks(current, next, { protect = false } = {}) {
    if (!protect) return { manualProfileFields: [], manualProfileLocksExplicit: true };
    const locks = new Set(Array.isArray(current?.manualProfileFields) ? current.manualProfileFields : []);
    for (const key of EDITOR_LOCKABLE_FIELDS) if (comparable(current, key) !== comparable(next, key)) locks.add(key);
    return { manualProfileFields: [...locks], manualProfileLocksExplicit: true };
}
