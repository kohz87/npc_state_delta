import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    mergeScanResult,
    normalizeNpcRecord,
    parseNarrationCapture,
    prepareFullWindowRelationshipPayload,
    tagScanEvidence,
} from '../core.js';
import { mergeImportedDossierState } from '../bundle.js';
import { preserveUserNpcMetadata } from '../branch-core.js';

// Cleanup step 3: characterisation ("golden") outputs for every dossier write path, frozen before
// the field logic is refactored. Each path is the real merge (core.js mergeScanResult) with the
// options index.js passes on that path, on one rich fixture and the same model reply, sent once in
// npcs[] and once in profileUpdates[]. A later step that changes a path on purpose updates the
// frozen file in the same PR (NSD_UPDATE_GOLDEN=1 npm test), so its diff shows exactly what moved.
// Timestamps (Date.now) are left out; everything else is compared.

const GOLDEN = new URL('./fixtures/field-paths-golden.json', import.meta.url);
const VOLATILE = new Set(['updatedAt', 'createdAt', 'archivedAt', 'correctedAt', 'at']);

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (VOLATILE.has(key) && (typeof value[key] === 'number' || value[key] === null)) continue;
        if (value[key] === undefined) continue;
        out[key] = stable(value[key]);
    }
    return out;
}

const settings = {
    maxNpcs: 40, relationshipBaseline: { trust: 0, affection: 0, desire: 0, tension: 0 },
    relationshipCaps: undefined, admissionMode: 'balanced', customFieldNames: ['Level', 'Class'],
};

function baseState() {
    const myla = normalizeNpcRecord({
        id: 'npc_myla', name: 'Myla Venn', aliases: ['The Archivist'], identityKind: 'proper_name', present: true,
        role: 'Archivist', species: 'Human', gender: 'female', age: '34', apparentAge: '~30',
        homeBase: 'The old archive tower', background: 'Raised in the river quarter; apprenticed to the archive at twelve; survived the flood year.',
        personality: 'Patient; dutiful; dry humour; protective of apprentices', speech: 'Measured and precise; quotes old ledgers',
        appearance: 'Tall woman with ink-stained fingers and a grey braid.',
        mood: 'Wary', location: 'Archive hall', goal: 'Find the forged ledger', status: 'Tired after a long night',
        mannerisms: ['Taps her quill twice before answering.'], behaviorProfile: ['Disposition: kind - helps strangers without fuss'],
        keyRelationships: ['Ilse Venn — sister | close, protective'],
        memories: ['Saved the miller from the spring flood.', 'Lost a sword duel to Captain Renn.'],
        relationship: { trust: 12, affection: 4, desire: 0, tension: 2 }, relationshipSummary: 'Cautious respect for Ari after the archive fire.',
        customFields: { Level: '3' }, manualProfileFields: ['speech'], manualProfileLocksExplicit: true,
        lastSeenTurn: 5, seenCount: 4,
    });
    const renn = normalizeNpcRecord({
        id: 'npc_renn', name: 'Captain Renn', identityKind: 'proper_name', present: true, role: 'Guard captain',
        personality: 'Gruff; loyal', mood: 'Impatient', location: 'Archive hall', lastSeenTurn: 5, seenCount: 2,
    });
    const ilse = normalizeNpcRecord({
        id: 'npc_ilse', name: 'Ilse Venn', identityKind: 'proper_name', present: false, role: 'Weaver',
        lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Died in the plague year.', archived: true, archiveReason: 'deceased',
        lastSeenTurn: 1, seenCount: 1,
    });
    return { turn: 5, npcs: [myla, renn, ilse], candidates: [], dismissed: [], socialGraph: { edges: [], unresolved: [] } };
}

const exchange = [
    'USER: Ari asks Myla where she will sleep now that the tower is closed.',
    'ASSISTANT: Myla Venn sets down the ledger. "Rooms above the bakery on Mill Street, for now." She served ten years as a royal archivist before the tower, she admits, and passed the guild trial this morning: she is Level 4 now.',
    'Myla laughs at Captain Renn\'s complaint, quick and dry, and trusts Ari enough to hand over the forged page. "Keep it safe." Her mood lifts to relieved.',
    'Captain Renn, gruff as ever, mutters that he will walk the night watch at the north gate. A young courier named Tobin Ash runs in with a sealed letter for Myla and waits at her side.',
].join('\n');

const durable = {
    background: 'Raised in the river quarter; served ten years as a royal archivist; apprenticed to the archive at twelve.',
    homeBase: 'Rooms above the bakery on Mill Street', homeBaseState: 'update', homeBaseReason: 'She says she is moving there now that the tower is closed.',
    role: 'Former royal archivist', species: 'Human',
    customFields: { Level: '4' }, customFieldsReason: 'Passed the guild trial this morning.',
    personalityState: 'refine', personality: 'Patient; dutiful; dry humour; protective of apprentices; quick to laugh at Renn',
    evidence: { personality: ['Myla laughs at Captain Renn\'s complaint, quick and dry'] },
    speechState: 'refine', speech: 'Measured and precise; quotes old ledgers; brisk when moving house',
    memories: ['Handed Ari the forged ledger page to keep safe.'],
    keyRelationships: ['Tobin Ash — courier | brings her letters'],
};

const rows = {
    myla: {
        id: 'npc_myla', name: 'Myla Venn', present: true, mood: 'Relieved', location: 'Archive hall', goal: 'Move to Mill Street',
        relationshipImpact: 'ordinary', relationshipDelta: { trust: 3, affection: 1, desire: 0, tension: 0 },
        relationshipEvidence: { trust: 'trusts Ari enough to hand over the forged page', affection: 'Keep it safe.', desire: '', tension: '' },
        relationshipChangeReason: 'She trusts Ari with the forged page.',
    },
    renn: { id: 'npc_renn', name: 'Captain Renn', present: true, mood: 'Gruff', goal: 'Walk the night watch at the north gate', statusState: 'clear' },
    tobin: { name: 'Tobin Ash', present: true, role: 'Courier', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named courier who waits at Myla\'s side', directInteraction: false, mood: 'Breathless' },
};

const replies = {
    // The durable facts inside the NPC's own entry.
    inRows: () => ({ npcs: [{ ...rows.myla, ...durable }, rows.renn, rows.tobin] }),
    // The same facts as a profile update, as the scanner rule asks for an existing NPC.
    inProfileUpdates: () => ({ npcs: [rows.myla, rows.renn, rows.tobin], profileUpdates: [{ id: 'npc_myla', name: 'Myla Venn', ...durable }] }),
};

const common = (extra = {}) => ({
    maxNpcs: settings.maxNpcs, excludeNames: [], turn: 5, sourceMessageId: 7, scenePresent: undefined, calendarSource: '', storyDay: null,
    relationshipBaseline: settings.relationshipBaseline, relationshipCaps: settings.relationshipCaps,
    autoArchiveDeaths: true, admissionMode: settings.admissionMode, ...extra,
});

// The options each index.js path passes to mergeScanResult (see the call sites in index.js).
const paths = {
    // P1 delta scan (scanNow, automatic): presence reset first, then the current exchange.
    scan: reply => mergeScanResult(resetPresence(baseState()), reply, common({
        customFieldNames: settings.customFieldNames, autoReactivateArchived: true,
        developmentContext: exchange, userDevelopmentContext: exchange.split('\n')[0],
    })),
    // P2 full / manual scan: the window's relationship numbers are scrubbed before the merge.
    fullScan: reply => {
        const base = resetPresence(baseState());
        const payload = prepareFullWindowRelationshipPayload(reply, base.npcs);
        return mergeScanResult(base, payload.mergeSafe ?? payload, common({
            customFieldNames: settings.customFieldNames, autoReactivateArchived: true,
            developmentContext: exchange, userDevelopmentContext: exchange.split('\n')[0],
        }));
    },
    // P3 one-pass capture: the block parsed from the reply, evidence tagged with its message.
    capture: reply => {
        const parsed = tagScanEvidence(parseNarrationCapture(JSON.stringify(reply)), 7);
        return mergeScanResult(resetPresence(baseState()), parsed, common({
            customFieldNames: settings.customFieldNames, autoReactivateArchived: true,
            developmentContext: exchange, userDevelopmentContext: exchange.split('\n')[0],
        }));
    },
    // P5 targeted Refresh (P4 catch-up uses the same call).
    refresh: reply => mergeScanResult(baseState(), targetOnly(reply), common({
        customFieldNames: settings.customFieldNames, autoReactivateArchived: false, preservePresence: true, skipRelationshipUpdate: true,
        memoryInputLimit: 5, allowTargetedDurableSeed: true, developmentSourceMessageIds: [7], storyDays: [],
        developmentContext: exchange, userDevelopmentContext: exchange.split('\n')[0],
    })),
    // P6 backfill.
    backfill: reply => mergeScanResult(baseState(), targetOnly(reply), common({
        customFieldNames: settings.customFieldNames, autoReactivateArchived: true, preservePresence: true, skipRelationshipUpdate: true,
        memoryInputLimit: 5, allowTargetedDurableSeed: true,
        developmentContext: exchange, userDevelopmentContext: exchange.split('\n')[0],
    })),
    // P7 Megumin dossier import: no custom-field names, no memory limit.
    dossierImport: reply => mergeScanResult(baseState(), targetOnly(reply), common({
        autoReactivateArchived: true, preservePresence: true, skipRelationshipUpdate: true,
        developmentContext: exchange, userDevelopmentContext: exchange,
    })),
};

function resetPresence(state) {
    for (const npc of state.npcs) { npc.present = false; npc.worldActive = false; }
    return state;
}
// The targeted paths scope every channel to their one NPC (scopeProfileUpdatesToTarget).
function targetOnly(reply) {
    return { ...reply, npcs: reply.npcs.filter(row => row.id === 'npc_myla'), profileUpdates: (reply.profileUpdates || []).filter(row => row.id === 'npc_myla') };
}

function summarize(result) {
    const report = result.report || {};
    return stable({
        npcs: result.state.npcs,
        candidates: result.state.candidates,
        socialGraph: result.state.socialGraph,
        turn: result.state.turn,
        report: {
            created: report.created, promoted: report.promoted, updated: report.updated,
            relationshipEvents: report.relationshipEvents, profileUpdateStats: report.profileUpdateStats,
            profileDevelopment: report.profileDevelopment,
        },
    });
}

function computeGolden() {
    const out = {};
    for (const [path, run] of Object.entries(paths)) {
        for (const [shape, reply] of Object.entries(replies)) out[`${path}/${shape}`] = summarize(run(reply()));
    }
    // P16 bundle import onto the same dossier (a foreign copy with newer text); P19 branch restore
    // of an older copy under the current locks; P9 editor normalisation of a hand-entered record.
    const current = baseState();
    const imported = structuredClone(current.npcs[0]);
    Object.assign(imported, { id: 'foreign_myla', mood: 'Calm', speech: 'Imported speech', memories: ['Imported memory.'], customFields: { Level: '9', Rank: 'Gold' } });
    out['bundleImport'] = stable(mergeImportedDossierState(current, { npcs: [imported] }, { foreignOwnership: true }).npcs);
    const older = structuredClone(baseState().npcs);
    older[0].speech = 'An older speech'; older[0].mood = 'Older mood';
    out['branchRestore'] = stable(preserveUserNpcMetadata(older, baseState().npcs));
    out['editorNormalize'] = stable(normalizeNpcRecord({
        ...baseState().npcs[0], personality: 'Kind; patient; dutiful; wry humour; protective of apprentices; distrusts nobles; loves rain; hates bells',
        mannerisms: ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'], memories: ['Promised Ari she would guard the gate.', 'Promised Ari she would guard the bridge.'],
    }));
    return out;
}

test('golden: every dossier write path still produces its frozen output', () => {
    const actual = computeGolden();
    if (process.env.NSD_UPDATE_GOLDEN === '1' || !fs.existsSync(GOLDEN)) {
        fs.mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
        fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'the same paths are covered');
    for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], `${key} moved`);
});

test('golden: the fixture exercises what it claims', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const myla = key => golden[key].npcs.find(npc => npc.id === 'npc_myla');
    // Today's behaviour, recorded so the later fixes show up as diffs here (audit I-3, I-4, I-5).
    assert.equal(myla('scan/inRows').homeBase, 'Rooms above the bakery on Mill Street', 'npcs[] applies a grounded homeBase update');
    assert.equal(myla('scan/inRows').customFields.Level, '4');
    assert.equal(myla('scan/inRows').speech, 'Measured and precise; quotes old ledgers', 'a locked field holds');
    assert.ok(golden['scan/inRows'].npcs.some(npc => npc.name === 'Tobin Ash') || golden['scan/inRows'].candidates.some(c => c.name === 'Tobin Ash'), 'a new NPC is admitted or held');
    assert.ok(golden['scan/inProfileUpdates'].npcs.length >= 3);
    assert.equal(golden['bundleImport'].length >= 1, true);
});
