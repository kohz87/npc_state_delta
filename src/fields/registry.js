// The dossier's field registry: one read-only table of every stored NPC field that a hand-kept list
// used to name, and what each list is. The lists Delta's modules use are derived from it below.
//
// It describes; it decides nothing (the one function here only copies the snapshot fields). A number in an entry is the field's position in that list,
// so every derived list is exactly the list it replaces, order included (some orders are visible: the
// v2 dossier's key order, the revert groups' indexes, the sidecar's key order).
// tests/field-registry.test.js holds today's lists and checks each derived one against them.
//
// Entry keys:
//   kind          'identity' | 'text' | 'list' | 'map' | 'meter' | 'life' | 'part' (a stored part of
//                 another field) | 'meta' (book-keeping) | 'secret'
//   text          TEXT_FIELDS: the free-text fields a scan row can replace (core-mechanics applyIncoming)
//   evidence      PROFILE_EVIDENCE_FIELDS: the fields with a profile-evidence bucket
//   tracked       CHANGE_TRACKED_FIELDS: the fields with a "changed at" stamp (core.js)
//   dayTracked    DAY_TRACKED_FIELDS: the fields that also record the story day of a change
//   editorLock    EDITOR_LOCKABLE_FIELDS: the fields the editor's protect checkbox locks when changed
//   lock          [position, keys]: LOCKED_FIELD_KEYS, the stored keys a lock on this field keeps
//   revertGroup   [position, keys]: NPC_REVERT_GROUPS, keys reverted or kept together (branch.js)
//   revertList    NPC_REVERT_LIST_FIELDS: list fields reverted item by item
//   terminalFrozen  the fields a terminal death freezes at their last living value
//   aliasMerge    the text fields an alias merge takes from the longer copy
//   userMeta      the user metadata every branch restore keeps from the current dossier
//   refreshChanged  the fields a targeted Refresh reports as changed
//   snapshot      [position, how]: the inline-card snapshot (index.js snapshotNpc)
//   v2            DOSSIER_FIELDS: what the v2 npc.dossier query returns
//   prompt        'never' when the field must never reach a model-facing text; 'unlocked' when only
//                 its unlocked items may (the v2 hidden notes)

const APPEARANCE_PARTS = Object.freeze(['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion']);

export const FIELDS = Object.freeze({
    id: { kind: 'identity', snapshot: [0, 'raw'], v2: 0 },
    name: { kind: 'identity', editorLock: 0, lock: [0, ['name', 'identityKind']], refreshChanged: 0, snapshot: [1, 'text'], v2: 1 },
    identityKind: { kind: 'part' },
    aliases: { kind: 'list', editorLock: 14, lock: [15, ['aliases']], revertList: 4, snapshot: [2, 'list'], v2: 2 },
    role: { kind: 'text', text: 0, editorLock: 1, lock: [1, ['role']], aliasMerge: 0, refreshChanged: 1, snapshot: [3, 'text'], v2: 3 },
    species: { kind: 'text', text: 1, editorLock: 2, lock: [2, ['species']], aliasMerge: 1, refreshChanged: 2, snapshot: [4, 'text'], v2: 4 },
    gender: { kind: 'text', text: 2, editorLock: 3, lock: [3, ['gender']], refreshChanged: 3, snapshot: [5, 'text'], v2: 5 },
    homeBase: { kind: 'text', text: 3, tracked: 4, dayTracked: 4, editorLock: 4, lock: [4, ['homeBase']], refreshChanged: 4, snapshot: [6, 'text'], v2: 9 },
    age: {
        kind: 'text', text: 4, tracked: 5, editorLock: 5, lock: [5, ['age']], aliasMerge: 2, refreshChanged: 5, snapshot: [7, 'text'], v2: 6,
        revertGroup: [2, ['age', 'apparentAge', 'birthDate', 'birthDateSource', 'birthDatePrecision', 'birthDateYearSource', 'birthDateReason',
            'birthDateSourceMessageId', 'birthDateCalendarFingerprint', 'birthDateDisplay', 'calendarAge', 'apparentAgeAnchor']],
    },
    apparentAge: { kind: 'text', text: 5, tracked: 6, editorLock: 6, lock: [6, ['apparentAge', 'apparentAgeAnchor']], aliasMerge: 3, refreshChanged: 6, snapshot: [8, 'text'], v2: 7 },
    birthDate: { kind: 'part', tracked: 18, v2: 8 },
    appearance: {
        kind: 'text', text: 6, evidence: 2, tracked: 12, lock: [7, APPEARANCE_PARTS], revertGroup: [1, APPEARANCE_PARTS],
        aliasMerge: 6, refreshChanged: 7, snapshot: [9, 'text'], v2: 10,
    },
    appearanceForms: { kind: 'part', v2: 11 },
    currentForm: { kind: 'part', v2: 12 },
    personality: {
        kind: 'text', text: 7, evidence: 0, tracked: 8, dayTracked: 0, editorLock: 7, lock: [8, ['personality']], revertGroup: [4, ['personality', 'personalityDevelopment']],
        aliasMerge: 4, refreshChanged: 8, snapshot: [10, 'text'], v2: 13,
    },
    speech: {
        kind: 'text', text: 8, evidence: 1, tracked: 9, dayTracked: 1, editorLock: 8, lock: [9, ['speech']], revertGroup: [5, ['speech', 'speechDevelopment']],
        aliasMerge: 5, refreshChanged: 9, snapshot: [11, 'text'], v2: 14,
    },
    mannerisms: { kind: 'list', evidence: 3, tracked: 11, editorLock: 11, lock: [12, ['mannerisms']], revertList: 1, refreshChanged: 19, snapshot: [21, 'list'], v2: 15 },
    behaviorProfile: { kind: 'list', evidence: 4, tracked: 10, dayTracked: 2, editorLock: 9, lock: [10, ['behaviorProfile']], revertList: 2, refreshChanged: 10, snapshot: [12, 'list'], v2: 16 },
    background: { kind: 'text', text: 9, tracked: 15, dayTracked: 3, editorLock: 10, lock: [11, ['background']], aliasMerge: 7, refreshChanged: 11, snapshot: [13, 'text'], v2: 17 },
    memories: { kind: 'list', tracked: 17, editorLock: 20, lock: [21, ['memories', 'manualMemories']], revertList: 0, refreshChanged: 20, snapshot: [20, 'list'], v2: 18 },
    // The memories the reader entered by hand: a later scan never evicts them (core-mechanics mergeImportantMemories).
    manualMemories: { kind: 'part', userMeta: 6 },
    keyRelationships: { kind: 'list', tracked: 16, editorLock: 12, lock: [13, ['keyRelationships']], revertList: 3, refreshChanged: 12, snapshot: [22, 'list'], v2: 19 },
    relationshipSummary: { kind: 'text', text: 10, tracked: 14, editorLock: 15, lock: [16, ['relationshipSummary']], terminalFrozen: 9, aliasMerge: 8, refreshChanged: 13, snapshot: [14, 'text'], v2: 20 },
    relationship: {
        kind: 'meter', tracked: 13, terminalFrozen: 4, snapshot: [32, 'shallow'], v2: 21,
        revertGroup: [0, ['relationship', 'relationshipProgress', 'relationshipMilestones', 'relationshipEventHistory', 'lastRelationshipChange']],
    },
    relationshipProgress: { kind: 'part', terminalFrozen: 5 },
    relationshipMilestones: { kind: 'part', terminalFrozen: 6 },
    relationshipEventHistory: { kind: 'part', terminalFrozen: 7 },
    lastRelationshipChange: { kind: 'part', terminalFrozen: 8, snapshot: [33, 'relationshipChange'] },
    mood: { kind: 'text', text: 11, tracked: 0, editorLock: 16, lock: [17, ['mood']], terminalFrozen: 0, aliasMerge: 9, refreshChanged: 14, snapshot: [15, 'text'], v2: 22 },
    location: { kind: 'text', text: 12, tracked: 1, editorLock: 17, lock: [18, ['location']], terminalFrozen: 1, aliasMerge: 10, refreshChanged: 15, snapshot: [16, 'text'], v2: 23 },
    goal: { kind: 'text', text: 13, tracked: 2, editorLock: 18, lock: [19, ['goal']], terminalFrozen: 2, aliasMerge: 11, refreshChanged: 16, snapshot: [17, 'text'], v2: 24 },
    status: { kind: 'text', text: 14, tracked: 3, editorLock: 19, lock: [20, ['status']], terminalFrozen: 3, aliasMerge: 12, refreshChanged: 17, snapshot: [18, 'text'], v2: 25 },
    customFields: { kind: 'map', editorLock: 13, lock: [14, ['customFields']], v2: 26 },
    lifeState: {
        kind: 'life', tracked: 7, refreshChanged: 18, snapshot: [25, 'lifeState'], v2: 27,
        revertGroup: [3, ['lifeState', 'lifeStateCertainty', 'lifeStateReason', 'archived', 'archiveReason', 'archivedAt', 'archiveSourceMessageId']],
    },
    lifeStateCertainty: { kind: 'life', snapshot: [26, 'text'] },
    lifeStateReason: { kind: 'life', aliasMerge: 13, snapshot: [27, 'text'] },
    present: { kind: 'meta', snapshot: [23, 'bool'], v2: 28 },
    worldActive: { kind: 'meta', snapshot: [24, 'bool'], v2: 29 },
    archived: { kind: 'life', snapshot: [28, 'bool'], v2: 30 },
    archiveReason: { kind: 'life', snapshot: [29, 'text'] },
    archivedAt: { kind: 'life', snapshot: [30, 'nullable'] },
    archiveSourceMessageId: { kind: 'life', snapshot: [31, 'messageId'] },
    minor: { kind: 'meta', userMeta: 5, snapshot: [38, 'bool'], v2: 31 },
    retentionProtected: { kind: 'meta', userMeta: 4, snapshot: [37, 'bool'] },
    portraitPromptPositive: { kind: 'meta', userMeta: 0, prompt: 'never' },
    portraitPromptNegative: { kind: 'meta', userMeta: 1, prompt: 'never' },
    portraitPromptReplace: { kind: 'meta', userMeta: 2, prompt: 'never' },
    portraitSeed: { kind: 'meta', userMeta: 3, prompt: 'never' },
    updatedAt: { kind: 'meta', snapshot: [34, 'now'] },
    seenCount: { kind: 'meta', terminalFrozen: 10, snapshot: [35, 'count'] },
    lastSeenTurn: { kind: 'meta', terminalFrozen: 11 },
    lastWorldActiveTurn: { kind: 'meta', terminalFrozen: 12 },
    manualProfileFields: { kind: 'meta', snapshot: [36, 'list'] },
    // (v2 meters) The hidden notes: [{ id, meter, at, text }]. A note reaches a model-facing text
    // only once its meter has unlocked it, and only through the v2 slice (src/npc-meters.js).
    secrets: { kind: 'secret', prompt: 'unlocked' },
});

// The fields with `property`, in that list's order.
function listOf(property) {
    return Object.freeze(Object.entries(FIELDS)
        .filter(([, field]) => Number.isInteger(field[property]))
        .sort((a, b) => a[1][property] - b[1][property])
        .map(([key]) => key));
}
// The [position, value] entries of `property`, in order.
function pairsOf(property) {
    return Object.entries(FIELDS)
        .filter(([, field]) => Array.isArray(field[property]))
        .sort((a, b) => a[1][property][0] - b[1][property][0])
        .map(([key, field]) => [key, field[property][1]]);
}

export const TEXT_FIELDS = listOf('text');
export const PROFILE_EVIDENCE_FIELDS = listOf('evidence');
export const CHANGE_TRACKED_FIELDS = listOf('tracked');
export const DAY_TRACKED_FIELDS = listOf('dayTracked');
export const EDITOR_LOCKABLE_FIELDS = listOf('editorLock');
export const NPC_REVERT_LIST_FIELDS = listOf('revertList');
export const TERMINAL_FROZEN_FIELDS = listOf('terminalFrozen');
export const ALIAS_MERGE_TEXT_FIELDS = listOf('aliasMerge');
export const BRANCH_USER_METADATA_FIELDS = listOf('userMeta');
export const REFRESH_CHANGED_FIELDS = listOf('refreshChanged');
export const DOSSIER_FIELDS = listOf('v2');
export const LOCKED_FIELD_KEYS = Object.freeze(Object.fromEntries(pairsOf('lock').map(([key, keys]) => [key, Object.freeze([...keys])])));
export const NPC_REVERT_GROUPS = Object.freeze(pairsOf('revertGroup').map(([, keys]) => Object.freeze([...keys])));
export const SNAPSHOT_FIELDS = Object.freeze(pairsOf('snapshot').map(([key, how]) => Object.freeze([key, how])));

// The inline card's copy of an NPC: the registry's snapshot fields, in its order (SNAPSHOT_FIELDS).
const SNAPSHOT_COPY = Object.freeze({
    raw: value => value,
    text: value => value || '',
    list: value => [...(value || [])],
    bool: value => Boolean(value),
    lifeState: value => value || 'unknown',
    nullable: value => value || null,
    messageId: value => (Number.isInteger(value) ? value : null),
    shallow: value => ({ ...(value || {}) }),
    relationshipChange: value => structuredClone(value || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, reason: '', sourceMessageId: null }),
    now: value => value || Date.now(),
    count: value => Number(value || 0),
});
export function snapshotNpc(npc) {
    return Object.fromEntries(SNAPSHOT_FIELDS.map(([key, how]) => [key, SNAPSHOT_COPY[how](npc[key])]));
}
