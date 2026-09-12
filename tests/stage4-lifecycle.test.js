import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyNpcStateCommand,
    buildInjection,
    buildNpcPortraitPrompts,
    buildScannerPrompt,
    createNpcRecord,
    isTerminalNpcDeath,
    mergeScanResult,
    normalizeNpcRecord,
    parseAppearanceFormsText,
    resolveNpcAppearance,
    setNpcArchived,
} from '../core.js';
import { BRANCH_LINEAGE_VERSION, recordBranchCheckpoint, reconcileBranchState } from '../branch.js';
import { mergeImportedDossierState } from '../bundle.js';
import { dossierDetailProjection } from '../dossier-ui.js';

function formNpc(name = 'Sora') {
    return normalizeNpcRecord({
        ...createNpcRecord(name),
        appearanceModelVersion: 1,
        overallAppearance: 'Small silver pendant worn in every form.',
        appearanceForms: [
            { name: 'Human', appearance: 'Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns; cobalt tailored wool dress and calfskin boots.' },
            { name: 'Stormcrown', appearance: 'Storm-blue plumage, hooked beak, talons, and broad lightning-marked wings.' },
        ],
        currentForm: 'Human',
    });
}

test('Stage 4 confirmed death is terminal to automatic scanner writes', () => {
    const npc = createNpcRecord('Luna');
    npc.present = true;
    const death = mergeScanResult({ npcs: [npc], turn: 4 }, { npcs: [{
        id: npc.id,
        name: npc.name,
        present: true,
        lifeState: 'deceased',
        lifeStateCertainty: 'explicit',
        lifeStateReason: 'The healer confirmed there was no pulse.',
    }] }, { turn: 4, sourceMessageId: 4, autoArchiveDeaths: true });
    const dead = death.state.npcs[0];
    assert.equal(isTerminalNpcDeath(dead), true);
    assert.equal(dead.archived, true);
    assert.equal(dead.present, false);

    const claimedRevival = mergeScanResult(death.state, { npcs: [{
        id: dead.id,
        name: dead.name,
        present: true,
        worldActive: true,
        lifeState: 'alive',
        lifeStateCertainty: 'explicit',
        lifeStateReason: 'Narration claims resurrection.',
    }] }, { turn: 5, sourceMessageId: 5, autoReactivateArchived: true }).state.npcs[0];
    assert.equal(claimedRevival.lifeState, 'deceased');
    assert.equal(claimedRevival.archived, true);
    assert.equal(claimedRevival.present, false);
    assert.equal(claimedRevival.worldActive, false);
});

test('Stage 4 terminal death remains non-active even when automatic death archiving is disabled', () => {
    const npc = createNpcRecord('Vale');
    const death = mergeScanResult({ npcs: [npc], turn: 3 }, { npcs: [{
        id: npc.id,
        name: npc.name,
        present: true,
        lifeState: 'deceased',
        lifeStateCertainty: 'explicit',
        lifeStateReason: 'Death was explicitly confirmed.',
    }] }, { turn: 3, sourceMessageId: 3, autoArchiveDeaths: false }).state.npcs[0];
    assert.equal(death.archived, false);
    assert.equal(isTerminalNpcDeath(death), true);
    assert.equal(death.present, false);

    const later = mergeScanResult({ npcs: [death], turn: 4 }, { npcs: [{
        id: death.id,
        name: death.name,
        present: true,
        lifeState: 'alive',
        lifeStateCertainty: 'explicit',
    }] }, { turn: 4, sourceMessageId: 4, autoArchiveDeaths: false, autoReactivateArchived: true }).state.npcs[0];
    assert.equal(later.archived, false);
    assert.equal(later.lifeState, 'deceased');
    assert.equal(later.present, false);
    assert.equal(later.worldActive, false);
});

test('Stage 4 post-death narrative cannot advance live state or relationship history', () => {
    const dead = setNpcArchived({
        ...createNpcRecord('Luna'),
        relationship: { trust: 10, affection: 3, desire: 0, tension: 1 },
        relationshipSummary: 'She trusted Lucien cautiously before her death.',
        mood: 'Calm',
        location: 'Old shrine',
        goal: 'Protect the shrine',
        status: 'Mortally wounded',
        seenCount: 4,
        lastSeenTurn: 8,
    }, true, { reason: 'deceased', sourceMessageId: 8 });
    const before = structuredClone(dead);
    const after = mergeScanResult({ npcs: [dead], turn: 12 }, { npcs: [{
        id: dead.id,
        name: dead.name,
        present: true,
        lifeState: 'alive',
        lifeStateCertainty: 'explicit',
        mood: 'Joyful',
        location: 'Market',
        goal: 'Go shopping',
        status: 'Healthy',
        relationshipImpact: 'meaningful',
        relationshipDelta: { trust: 2, affection: 2, desire: 0, tension: 0 },
        relationshipEvidence: { trust: 'Luna relied on Lucien again.', affection: 'Luna warmly embraced Lucien.', desire: '', tension: '' },
        relationshipChangeReason: 'Luna returned and embraced Lucien.',
        relationshipSummary: 'She is warmly reunited with Lucien.',
    }] }, { turn: 12, sourceMessageId: 12, developmentContext: 'Luna returned and embraced Lucien, relying on him again.' }).state.npcs[0];
    assert.deepEqual(after.relationship, before.relationship);
    assert.equal(after.relationshipSummary, before.relationshipSummary);
    assert.equal(after.mood, before.mood);
    assert.equal(after.location, before.location);
    assert.equal(after.goal, before.goal);
    assert.equal(after.status, before.status);
    assert.equal(after.seenCount, before.seenCount);
    assert.equal(after.lastSeenTurn, before.lastSeenTurn);
    assert.equal(after.present, false);
    assert.equal(after.lifeState, 'deceased');
});

test('Stage 4 explicit correction can repair an erroneous death while generic add cannot', () => {
    const dead = setNpcArchived(createNpcRecord('Luna'), true, { reason: 'deceased', sourceMessageId: 8 });
    const generic = applyNpcStateCommand({ npcs: [dead], turn: 9, dismissed: [] }, { action: 'add', name: 'Luna' }, { turn: 9 });
    assert.equal(generic.report.status, 'terminal-death');
    assert.equal(generic.state.npcs[0].archived, true);

    const corrected = setNpcArchived(dead, false, {
        allowDeathCorrection: true,
        lifeState: 'alive',
        lifeStateReason: 'Manual correction: prior death record was erroneous.',
    });
    assert.equal(corrected.archived, false);
    assert.equal(corrected.lifeState, 'alive');
    assert.equal(corrected.lifeStateCertainty, 'explicit');
    assert.equal(corrected.deathCorrection.previousDeathSourceMessageId, 8);
    assert.match(corrected.deathCorrection.reason, /prior death record was erroneous/i);
});

test('Stage 4 inferred death does not become terminal', () => {
    const npc = createNpcRecord('Dust');
    const result = mergeScanResult({ npcs: [npc], turn: 2 }, { npcs: [{
        id: npc.id,
        name: npc.name,
        present: true,
        lifeState: 'deceased',
        lifeStateCertainty: 'inferred',
        lifeStateReason: 'He was left for dead.',
    }] }, { turn: 2, autoArchiveDeaths: true });
    assert.equal(result.state.npcs[0].archived, false);
    assert.equal(result.state.npcs[0].present, true);
});

