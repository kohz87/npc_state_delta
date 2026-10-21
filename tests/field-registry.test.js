import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as registry from '../src/fields/registry.js';
import { DOSSIER_FIELDS as V2_DOSSIER_FIELDS } from '../src/storysuite-v2.js';
import { EDITOR_LOCKABLE_FIELDS as EDITOR_LOCKS, LOCKED_FIELD_KEYS as EDITOR_LOCK_KEYS } from '../src/dossier-edit.js';
import * as core from '../core.js';

// Cleanup step 4: the field registry is read-only. Every list derived from it is exactly the hand-kept
// list it replaced; these are those lists as they stood (v2 @ 2b8a3ea), copied verbatim.

const TODAY = {
    TEXT_FIELDS: ['role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'appearance', 'personality', 'speech', 'background',
        'relationshipSummary', 'mood', 'location', 'goal', 'status'],
    PROFILE_EVIDENCE_FIELDS: ['personality', 'speech', 'appearance', 'mannerisms', 'behaviorProfile'],
    CHANGE_TRACKED_FIELDS: ['mood', 'location', 'goal', 'status', 'homeBase', 'age', 'apparentAge', 'lifeState',
        'personality', 'speech', 'behaviorProfile', 'mannerisms', 'appearance',
        'relationship', 'relationshipSummary', 'background', 'keyRelationships', 'memories', 'birthDate'],
    DAY_TRACKED_FIELDS: ['personality', 'speech', 'behaviorProfile', 'background', 'homeBase'],
    EDITOR_LOCKABLE_FIELDS: ['name', 'role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'personality', 'speech', 'behaviorProfile', 'background', 'mannerisms', 'keyRelationships', 'customFields', 'aliases'],
    LOCKED_FIELD_KEYS: {
        name: ['name', 'identityKind'], role: ['role'], species: ['species'], gender: ['gender'], homeBase: ['homeBase'], age: ['age'],
        apparentAge: ['apparentAge', 'apparentAgeAnchor'],
        appearance: ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion'],
        personality: ['personality'], speech: ['speech'], behaviorProfile: ['behaviorProfile'], background: ['background'], mannerisms: ['mannerisms'],
        keyRelationships: ['keyRelationships'], customFields: ['customFields'], aliases: ['aliases'],
    },
    NPC_REVERT_GROUPS: [
        ['relationship', 'relationshipProgress', 'relationshipMilestones', 'relationshipEventHistory', 'lastRelationshipChange'],
        ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion'],
        ['age', 'apparentAge', 'birthDate', 'birthDateSource', 'birthDatePrecision', 'birthDateYearSource', 'birthDateReason',
            'birthDateSourceMessageId', 'birthDateCalendarFingerprint', 'birthDateDisplay', 'calendarAge', 'apparentAgeAnchor'],
        ['lifeState', 'lifeStateCertainty', 'lifeStateReason', 'archived', 'archiveReason', 'archivedAt', 'archiveSourceMessageId'],
        ['personality', 'personalityDevelopment'],
        ['speech', 'speechDevelopment'],
    ],
    NPC_REVERT_LIST_FIELDS: ['memories', 'mannerisms', 'behaviorProfile', 'keyRelationships', 'aliases'],
    TERMINAL_FROZEN_FIELDS: ['mood', 'location', 'goal', 'status',
        'relationship', 'relationshipProgress', 'relationshipMilestones',
        'relationshipEventHistory', 'lastRelationshipChange', 'relationshipSummary',
        'seenCount', 'lastSeenTurn', 'lastWorldActiveTurn'],
    ALIAS_MERGE_TEXT_FIELDS: ['role', 'species', 'age', 'apparentAge', 'personality', 'speech', 'appearance', 'background', 'relationshipSummary', 'mood', 'location', 'goal', 'status', 'lifeStateReason'],
    BRANCH_USER_METADATA_FIELDS: ['portraitPromptPositive', 'portraitPromptNegative', 'portraitPromptReplace', 'portraitSeed', 'retentionProtected', 'minor'],
    REFRESH_CHANGED_FIELDS: ['name', 'role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'appearance', 'personality', 'speech', 'behaviorProfile', 'background', 'keyRelationships', 'relationshipSummary', 'mood', 'location', 'goal', 'status', 'lifeState', 'mannerisms', 'memories'],
    DOSSIER_FIELDS: [
        'id', 'name', 'aliases', 'role', 'species', 'gender', 'age', 'apparentAge', 'birthDate', 'homeBase',
        'appearance', 'appearanceForms', 'currentForm', 'personality', 'speech', 'mannerisms', 'behaviorProfile',
        'background', 'memories', 'keyRelationships', 'relationshipSummary', 'relationship',
        'mood', 'location', 'goal', 'status', 'customFields',
        'lifeState', 'present', 'worldActive', 'archived', 'minor',
    ],
};

// index.js snapshotNpc as it stood.
function todaySnapshotNpc(npc) {
    return {
        id: npc.id,
        name: npc.name || '',
        aliases: [...(npc.aliases || [])],
        role: npc.role || '',
        species: npc.species || '',
        gender: npc.gender || '',
        homeBase: npc.homeBase || '',
        age: npc.age || '',
        apparentAge: npc.apparentAge || '',
        appearance: npc.appearance || '',
        personality: npc.personality || '',
        speech: npc.speech || '',
        behaviorProfile: [...(npc.behaviorProfile || [])],
        background: npc.background || '',
        relationshipSummary: npc.relationshipSummary || '',
        mood: npc.mood || '',
        location: npc.location || '',
        goal: npc.goal || '',
        status: npc.status || '',
        memories: [...(npc.memories || [])],
        mannerisms: [...(npc.mannerisms || [])],
        keyRelationships: [...(npc.keyRelationships || [])],
        present: Boolean(npc.present),
        worldActive: Boolean(npc.worldActive),
        lifeState: npc.lifeState || 'unknown',
        lifeStateCertainty: npc.lifeStateCertainty || '',
        lifeStateReason: npc.lifeStateReason || '',
        archived: Boolean(npc.archived),
        archiveReason: npc.archiveReason || '',
        archivedAt: npc.archivedAt || null,
        archiveSourceMessageId: Number.isInteger(npc.archiveSourceMessageId) ? npc.archiveSourceMessageId : null,
        relationship: { ...(npc.relationship || {}) },
        lastRelationshipChange: structuredClone(npc.lastRelationshipChange || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, reason: '', sourceMessageId: null }),
        updatedAt: npc.updatedAt || Date.now(),
        seenCount: Number(npc.seenCount || 0),
        manualProfileFields: [...(npc.manualProfileFields || [])],
        retentionProtected: Boolean(npc.retentionProtected),
        minor: Boolean(npc.minor),
    };
}

test('every list derived from the registry is exactly today\'s list, order included', () => {
    for (const [name, expected] of Object.entries(TODAY)) {
        assert.ok(name in registry, `${name} is derived from the registry`);
        assert.deepEqual(registry[name], expected, name);
        if (!Array.isArray(expected)) assert.deepEqual(Object.keys(registry[name]), Object.keys(expected), `${name} key order`);
    }
    assert.equal(V2_DOSSIER_FIELDS, registry.DOSSIER_FIELDS, 'the v2 adapter uses the registry list');
    assert.equal(EDITOR_LOCKS, registry.EDITOR_LOCKABLE_FIELDS, 'the editor uses the registry list');
    assert.equal(EDITOR_LOCK_KEYS, registry.LOCKED_FIELD_KEYS);
    for (const list of Object.keys(TODAY)) assert.ok(Object.isFrozen(registry[list]), `${list} is read-only`);
    assert.ok(Object.isFrozen(registry.FIELDS));
});

test('the snapshot built from the registry is today\'s snapshotNpc, key order included', () => {
    const records = [
        core.normalizeNpcRecord({ id: 'npc_a', name: 'Mira', aliases: ['M'], role: 'Clerk', memories: ['One.'], mannerisms: ['Taps.'], relationship: { trust: 4, affection: 1, desire: 0, tension: 0 }, archiveSourceMessageId: 3, updatedAt: 99, seenCount: 2, minor: true }),
        { id: 'npc_b', updatedAt: 5 },
        { id: 'npc_c', name: 'Nobody', archived: true, archiveReason: 'stale', archivedAt: 7, lifeState: 'deceased', updatedAt: 1, lastRelationshipChange: { impact: 'manual', reason: 'x' } },
    ];
    for (const npc of records) {
        const ours = registry.snapshotNpc(npc);
        const theirs = todaySnapshotNpc(npc);
        assert.deepEqual(ours, theirs);
        assert.deepEqual(Object.keys(ours), Object.keys(theirs));
    }
});

test('the modules use the derived lists, not copies of their own', () => {
    const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(read('core-mechanics.js'), /import \{ ALIAS_MERGE_TEXT_FIELDS, PROFILE_EVIDENCE_FIELDS, TEXT_FIELDS \} from '\.\/src\/fields\/registry\.js';/);
    assert.match(read('core.js'), /import \{ CHANGE_TRACKED_FIELDS, DAY_TRACKED_FIELDS \} from '\.\/src\/fields\/registry\.js';/);
    assert.match(read('branch.js'), /import \{ NPC_REVERT_GROUPS, NPC_REVERT_LIST_FIELDS \} from '\.\/src\/fields\/registry\.js';/);
    assert.match(read('branch-core.js'), /const globallyPreserved = BRANCH_USER_METADATA_FIELDS;/);
    assert.match(read('terminal-lifecycle.js'), /for \(const field of TERMINAL_FROZEN_FIELDS\)/);
    assert.match(read('index.js'), /return REFRESH_CHANGED_FIELDS\.filter\(/);
    for (const path of ['core-mechanics.js', 'core.js', 'branch.js', 'index.js', 'src/storysuite-v2.js', 'src/dossier-edit.js', 'bundle.js']) {
        assert.doesNotMatch(read(path), /const (?:TEXT_FIELDS|CHANGE_TRACKED_FIELDS|DAY_TRACKED_FIELDS|NPC_REVERT_GROUPS|DOSSIER_FIELDS|IMPORT_LOCKED_FIELD_KEYS) = /, `${path} keeps no copy`);
    }
});

test('the hidden notes (secrets) never reach a model-facing text', () => {
    assert.equal(registry.FIELDS.secrets.prompt, 'unlocked');
    assert.equal(registry.DOSSIER_FIELDS.includes('secrets'), false, 'npc.dossier never returns them');
    const secret = 'She is the lost heir of House Venn';
    const npc = core.normalizeNpcRecord({
        id: 'npc_mira', name: 'Mira', present: true, role: 'Clerk', personality: 'Kind.', speech: 'Soft.',
        secrets: [{ id: 'sec_00000001', meter: 'trust', at: 40, text: secret }],
    });
    assert.equal(npc.secrets?.[0]?.text, secret, 'the record keeps them');
    const transcript = 'USER: Hello.\nASSISTANT: Mira smiles.';
    const options = { transcript, currentTranscript: transcript, existingNpcs: [npc], existingNpc: npc, targetNpc: npc, targets: [npc], targetName: 'Mira', dossierText: 'Name: Mira', userName: 'Ari', charName: 'C' };
    const texts = [
        core.buildScannerPrompt(options), core.buildScannerPrompt({ ...options, customFieldNames: ['Level'] }),
        core.buildNarrationCapturePrompt(options), core.buildNarrationCapturePrompt({ ...options, compactCapture: true }),
        JSON.stringify(core.buildNarrationCaptureParts(options)), core.buildBackfillPrompt(options), core.buildProfileRefreshPrompt(options),
        core.buildDossierImportPrompt(options), core.buildRelationshipPassPrompt(options), core.buildInjection([npc], transcript, 1),
        JSON.stringify(core.buildNpcPortraitPrompts(npc, {})), JSON.stringify(registry.snapshotNpc(npc)),
    ];
    for (const text of texts) assert.doesNotMatch(String(text), /lost heir|sec_00000001/);
});
