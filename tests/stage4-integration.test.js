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

test('Stage 4 prompts describe forms, preserve established form context, and enforce terminal death', () => {
    const prompt = buildScannerPrompt({ transcript: 'Sora remains nearby.', existingNpcs: [formNpc()] });
    assert.match(prompt, /appearanceForms/);
    assert.match(prompt, /currentFormState:"unknown"/);
    assert.match(prompt, /Established Stage 4 appearance forms/);
    assert.match(prompt, /\"currentForm\":\"Human\"/);
    assert.match(prompt, /explicit death is terminal|terminal to automatic writers/i);
    assert.doesNotMatch(prompt, /explicit alive=reactivate/);
});

test('Stage 4 new form-aware dossier does not fabricate a Base anatomy record', () => {
    const result = mergeScanResult({ npcs: [], turn: 1 }, { npcs: [{
        id: 'npc_new_form',
        name: 'Asha',
        identityKind: 'proper_name',
        dossierSignal: 'meaningful',
        dossierReason: 'Named interacting NPC.',
        directInteraction: true,
        present: true,
        appearance: 'Blue travel coat and leather boots.',
        appearanceForms: [{ name: 'Human', appearance: 'Black hair and ordinary human ears.' }],
        currentForm: 'Human',
        currentFormState: 'select',
    }] }, { turn: 1, admissionMode: 'balanced', developmentContext: 'Asha, wearing a blue travel coat, has black hair and ordinary human ears.' });
    const npc = result.state.npcs.find(item => item.name === 'Asha');
    assert.ok(npc);
    assert.equal(npc.currentForm, 'Human');
    assert.deepEqual(npc.appearanceForms, [{ name: 'Human', appearance: 'Black hair and ordinary human ears.' }]);
});

test('Stage 4 first-pass form details must be grounded in the supplied development context', () => {
    const result = mergeScanResult({ npcs: [], turn: 1 }, { npcs: [{
        id: 'npc_grounding',
        name: 'Asha',
        identityKind: 'proper_name',
        dossierSignal: 'meaningful',
        dossierReason: 'Named interacting NPC.',
        directInteraction: true,
        present: true,
        appearance: 'Blue travel coat and leather boots.',
        appearanceForms: [{ name: 'Human', appearance: 'Black hair, curved horns, red eyes.' }],
        currentForm: 'Human',
        currentFormState: 'select',
    }] }, { turn: 1, admissionMode: 'balanced', developmentContext: 'Asha arrives wearing a blue travel coat and leather boots.' });
    const npc = result.state.npcs.find(item => item.name === 'Asha');
    assert.ok(npc);
    assert.equal(npc.appearanceForms.length, 0);
    assert.equal(npc.currentForm, 'Human');
    assert.equal(resolveNpcAppearance(npc), 'Blue travel coat and leather boots.');
});

test('Stage 4 clothing-only form change leaves unrelated form anatomy untouched', () => {
    const base = formNpc('Ryu');
    const result = mergeScanResult({ npcs: [base], turn: 5 }, { npcs: [{
        id: base.id,
        name: base.name,
        appearanceForms: [{
            name: 'Human',
            appearance: 'Golden-blue hair, ordinary human ears, no wings, tail, feathers, scales, or horns; black travel coat and winter boots.',
            state: 'change',
            reason: 'Ryu changed into a black travel coat and winter boots.',
        }],
        present: true,
    }] }, { turn: 5, developmentContext: 'Ryu changed into a black travel coat and winter boots while keeping her golden-blue hair and ordinary human ears.' });
    const npc = result.state.npcs[0];
    assert.equal(npc.currentForm, 'Human');
    assert.match(resolveNpcAppearance(npc), /black travel coat and winter boots/i);
    assert.match(npc.appearanceForms.find(form => form.name === 'Human').appearance, /ordinary human ears/i);
    assert.match(npc.appearanceForms.find(form => form.name === 'Stormcrown').appearance, /Storm-blue plumage/i);
});

test('Stage 4 archiving preserves death semantics and an explicit user restore is recorded as correction', () => {
    const dead = normalizeNpcRecord({
        ...createNpcRecord('Marris'),
        archived: false,
        lifeState: 'deceased',
        lifeStateCertainty: 'explicit',
        lifeStateReason: 'Death was explicitly confirmed.',
    });
    const archived = setNpcArchived(dead, true, { reason: 'manual', sourceMessageId: 7 });
    assert.equal(archived.archived, true);
    assert.equal(archived.archiveReason, 'deceased');
    assert.equal(archived.lifeState, 'deceased');
    const corrected = setNpcArchived(archived, false, { sourceMessageId: 8 });
    assert.equal(corrected.archived, false);
    assert.equal(corrected.lifeState, 'alive');
    assert.equal(corrected.present, false);
    assert.equal(corrected.worldActive, false);
    assert.equal(corrected.deathCorrection.previousDeathSourceMessageId, 7);
});

test('Stage 4 alias consolidation preserves named forms and lets terminal death dominate a live duplicate', () => {
    const older = normalizeNpcRecord({
        ...createNpcRecord('Gate Clerk'),
        id: 'npc_gate_clerk',
        aliases: ['Karenna Thael'],
        createdAt: 1,
        updatedAt: 2,
        appearanceModelVersion: 1,
        appearanceForms: [{ name: 'Human', appearance: 'Copper hair and ordinary elven ears.' }],
        currentForm: 'Human',
        lifeState: 'deceased',
        lifeStateCertainty: 'explicit',
        lifeStateReason: 'Death was explicitly confirmed.',
        present: false,
    });
    const newer = normalizeNpcRecord({
        ...createNpcRecord('Karenna Thael'),
        id: 'npc_karenna',
        aliases: ['Gate Clerk'],
        createdAt: 2,
        updatedAt: 10,
        appearanceModelVersion: 1,
        appearanceForms: [{ name: 'Spirit', appearance: 'Translucent outline with pale blue light.' }],
        currentForm: 'Spirit',
        lifeState: 'alive',
        lifeStateCertainty: 'explicit',
        present: true,
    });
    const merged = mergeScanResult({ npcs: [older, newer], turn: 10 }, { npcs: [] }, { turn: 10, sourceMessageId: 10 }).state.npcs;
    assert.equal(merged.length, 1);
    assert.equal(isTerminalNpcDeath(merged[0]), true);
    assert.equal(merged[0].present, false);
    assert.ok(merged[0].appearanceForms.some(form => form.name === 'Human'));
    assert.ok(merged[0].appearanceForms.some(form => form.name === 'Spirit'));
});

test('Stage 4 native bundle merge cannot implicitly revive an existing terminal death', () => {
    const dead = setNpcArchived({
        ...createNpcRecord('Marris'),
        relationship: { trust: 12, affection: 4, desire: 0, tension: 1 },
        mood: 'Still',
        location: 'Old shrine',
    }, true, { reason: 'deceased', sourceMessageId: 7 });
    const imported = normalizeNpcRecord({
        ...dead,
        archived: false,
        archiveReason: '',
        lifeState: 'alive',
        lifeStateCertainty: 'explicit',
        present: true,
        worldActive: true,
        mood: 'Cheerful',
        location: 'Market',
        relationship: { trust: 99, affection: 99, desire: 99, tension: -99 },
    });
    const merged = mergeImportedDossierState({ npcs: [dead] }, { npcs: [imported] });
    const npc = merged.npcs[0];
    assert.equal(isTerminalNpcDeath(npc), true);
    assert.equal(npc.present, false);
    assert.equal(npc.worldActive, false);
    assert.equal(npc.mood, dead.mood);
    assert.equal(npc.location, dead.location);
    assert.deepEqual(npc.relationship, dead.relationship);
});

test('Stage 4 canonical state gives the retained dossier the same resolved current appearance as portrait/injection', () => {
    const npc = formNpc();
    const projected = dossierDetailProjection(npc);
    assert.equal(projected.appearance, resolveNpcAppearance(npc));
    assert.match(projected.appearance, /ordinary human ears/i);
    assert.doesNotMatch(projected.appearance, /Storm-blue plumage/i);
});

test('Stage 4 branch rollback restores the owned pre-switch appearance form snapshot', () => {
    const user = text => ({ is_user: true, is_system: false, name: 'Lucien', mes: text });
    const assistant = text => ({ is_user: false, is_system: false, name: 'Eos', mes: text });
    const chat = [user('Stay human.'), assistant('Sora remains human.'), user('Transform.'), assistant('Sora becomes Stormcrown.')];
    const state = {
        npcs: [formNpc()], dismissed: [], inlineCards: [], checkpoints: [], lineage: [],
        branchLineageVersion: BRANCH_LINEAGE_VERSION,
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null,
        scanCount: 0,
    };
    recordBranchCheckpoint(state, chat, 1, 'scan');
    state.npcs[0].currentForm = 'Stormcrown';
    recordBranchCheckpoint(state, chat, 3, 'scan');
    const rollback = reconcileBranchState(state, chat.slice(0, 3), { explicitDivergence: 3 });
    assert.equal(rollback.state.npcs[0].currentForm, 'Human');
    assert.equal(rollback.state.npcs[0].appearanceForms.length, 2);
    assert.match(rollback.state.npcs[0].appearanceForms.find(form => form.name === 'Stormcrown').appearance, /plumage/i);
});
