// What a manual dossier Save writes about field locks.
//
// "Protect edited stable profile fields" locks every stable field the reader changed, keeps the locks
// already on the dossier, and unticked clears them all. Either way the choice is the reader's own, so
// the record is marked explicit: a swipe or branch restore then re-applies the locked fields and the
// lock list itself (branch-core.js preserveUserNpcMetadata) instead of reverting to an older copy.
import { normalizeCustomFields } from '../core.js';
import { EDITOR_LOCKABLE_FIELDS, LOCKED_FIELD_KEYS } from './fields/registry.js';

// The fields the editor locks when the reader changes them, and the stored keys a lock covers (a lock
// on a field keeps everything that field is made of, so a restored or imported copy never pairs a kept
// value with another copy's parts). Both come from the field registry.
export { EDITOR_LOCKABLE_FIELDS, LOCKED_FIELD_KEYS };
const LIST_FIELDS = new Set(['mannerisms', 'behaviorProfile', 'keyRelationships', 'aliases', 'memories']);

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

// The editor's own controls for dossier fields: element id (after npc_state_delta_edit_), the label the
// reader sees, and for a text the most the stored record keeps (normalizeNpcRecord; for a lockable
// text the locked maximum, since an unlocked one is compacted further). A null maximum is a select or
// a one-per-line list, whose line count the Save caps instead.
export const EDITOR_FIELDS = Object.freeze({
    name: { id: 'name', label: 'Name', max: 120 },
    species: { id: 'species', label: 'Species', max: 160 },
    gender: { id: 'gender', label: 'Gender', max: null },
    role: { id: 'role', label: 'Role', max: 300 },
    aliases: { id: 'aliases', label: 'Aliases', max: null, list: true },
    homeBase: { id: 'home_base', label: 'Home Base', max: 300 },
    age: { id: 'age', label: 'Age', max: 80 },
    apparentAge: { id: 'apparent_age', label: 'Apparent age', max: 80 },
    personality: { id: 'personality', label: 'Personality', max: 900 },
    behaviorProfile: { id: 'behavior_profile', label: 'Behavioral Levers', max: null, list: true },
    speech: { id: 'speech', label: 'Speech', max: 600 },
    background: { id: 'background', label: 'Background', max: 1200 },
    mannerisms: { id: 'mannerisms', label: 'Mannerisms', max: null, list: true },
    keyRelationships: { id: 'key_relationships', label: 'Key relationships', max: null, list: true },
    relationshipSummary: { id: 'relationship_summary', label: 'Player Dynamic', max: 320 },
    mood: { id: 'mood', label: 'Mood', max: 300 },
    location: { id: 'location', label: 'Location', max: 300 },
    goal: { id: 'goal', label: 'Goal', max: 500 },
    status: { id: 'status', label: 'Condition / Activity', max: 500 },
    memories: { id: 'memories', label: 'Important memories', max: null, list: true },
});

// The text the editor shows for a field of this record.
export function editorShownValue(npc, key) {
    return EDITOR_FIELDS[key]?.list ? (Array.isArray(npc?.[key]) ? npc[key] : []).join('\n') : String(npc?.[key] ?? '');
}

// Fields whose control still holds exactly what the editor showed for the record (readControl(id)
// returns a control's raw value). A Save keeps these as they are stored, never re-cut or compacted.
export function untouchedEditorFields(current, readControl) {
    const untouched = new Set();
    for (const [key, field] of Object.entries(EDITOR_FIELDS)) {
        if (String(readControl(`npc_state_delta_edit_${field.id}`) ?? '') === editorShownValue(current, key)) untouched.add(key);
    }
    return untouched;
}

// After the saved record is normalized (typed is the edited record just before): put back, verbatim,
// every untouched field the Save did not otherwise change (a rename still adds the old name to the aliases; a field whose lock the reader
// removed is compacted like any unprotected one). Returns the labels of edited or newly unprotected
// fields the stored limits shortened or adjusted, for one warning.
export function settleEditorSave(saved, current, typed, untouched, { keepVerbatim = () => true } = {}) {
    const savedLocks = new Set(Array.isArray(saved?.manualProfileFields) ? saved.manualProfileFields : []);
    const unprotected = key => (current?.manualProfileFields || []).includes(key) && !savedLocks.has(key);
    const shortened = [];
    for (const [key, field] of Object.entries(EDITOR_FIELDS)) {
        if (untouched.has(key) && !unprotected(key) && keepVerbatim(key)
            && JSON.stringify(typed[key] ?? null) === JSON.stringify(current?.[key] ?? null)) {
            if (Object.prototype.hasOwnProperty.call(current || {}, key)) saved[key] = structuredClone(current[key]);
            else delete saved[key];
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(typed, key) || key === 'gender') continue;
        const plain = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        const wanted = typed[key];
        const kept = saved[key];
        const keptLines = new Set((Array.isArray(kept) ? kept : []).map(plain));
        const lost = field.list
            ? (Array.isArray(wanted) ? wanted : []).some(line => !keptLines.has(plain(line)))
            : plain(wanted) !== plain(kept);
        if (lost) shortened.push(field.label);
    }
    return shortened;
}

// The memories the reader entered by hand after a Save (a later scan never evicts them): the lines of
// an edited Memories field that were not already stored, plus the earlier hand-entered ones still kept.
export function editorManualMemories(current, saved, untouched) {
    const stored = new Set((Array.isArray(current?.memories) ? current.memories : []).map(plainLine));
    const before = (Array.isArray(current?.manualMemories) ? current.manualMemories : []).map(plainLine);
    const kept = Array.isArray(saved?.memories) ? saved.memories : [];
    if (untouched.has('memories')) return kept.filter(item => before.includes(plainLine(item)));
    return kept.filter(item => !stored.has(plainLine(item)) || before.includes(plainLine(item)));
}
function plainLine(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}
