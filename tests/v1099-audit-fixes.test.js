import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNpcRecord, mergeScanResult, normalizeNpcRecord } from '../core.js';
import { APPEARANCE_MODEL_VERSION, applyAppearanceUpdate, normalizeAppearanceModel, resolveNpcAppearance } from '../appearance.js';
import { buildScannerPrompt } from '../continuity-core.js';
import { appearanceFormsHtml } from '../dossier-ui.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';

const BODY = 'Tall and slender, long silver hair, violet eyes';

test('1: a scan that sends the body as Physical features writes it into outfit-only forms', () => {
    const result = mergeScanResult({ npcs: [], candidates: [], turn: 1 }, { npcs: [{
        name: 'Noela', role: 'dragon', overallAppearance: BODY, present: true, dossierSignal: 'persistent', currentForm: 'Dragon',
        appearanceForms: [{ name: 'Human', appearance: 'Wearing a grey cloak' }, { name: 'Dragon', appearance: 'A forty-foot silver dragon with pearl-white scales' }],
    }] }, { turn: 1, sourceMessageId: 1, developmentContext: 'Noela, tall and slender with long silver hair and violet eyes, wears a grey cloak. She becomes a forty-foot silver dragon with pearl-white scales.' });
    const forms = Object.fromEntries(result.state.npcs[0].appearanceForms.map(form => [form.name, form.appearance]));
    assert.equal(forms.Human, `${BODY}; Wearing a grey cloak`);
    assert.equal(forms.Dragon, 'A forty-foot silver dragon with pearl-white scales', 'a form that describes its own body is left alone');
    // An existing NPC gaining a new outfit-only form in a scan that also gives the body.
    const npc = normalizeAppearanceModel({ appearanceModelVersion: APPEARANCE_MODEL_VERSION, appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon' }], currentForm: 'Dragon' });
    const added = applyAppearanceUpdate(npc, { overallAppearance: BODY, appearanceForms: [{ name: 'Human', appearance: 'Wearing a grey cloak' }] });
    assert.equal(added.appearanceForms.find(form => form.name === 'Human').appearance, `${BODY}; Wearing a grey cloak`);
    assert.equal(added.appearanceForms.find(form => form.name === 'Dragon').appearance, 'A silver dragon');
});

test('2: the general Appearance rule no longer contradicts complete forms', () => {
    const prompt = buildScannerPrompt({ transcript: 'Noela shifts into her dragon form.', existingNpcs: [normalizeNpcRecord({ name: 'Noela', appearanceModelVersion: APPEARANCE_MODEL_VERSION, appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon' }], currentForm: 'Dragon' })] });
    assert.match(prompt, /overallAppearance=enduring body \(height\/build\/hair\/eyes\/ears\/skin\/marks\) if no named forms/);
    assert.doesNotMatch(prompt, /overallAppearance=enduring body \(height\/build\/hair\/eyes\/ears\/skin\/marks\);/);
});

test('3: an unknown transformed form of an NPC with named forms gets no human body', () => {
    const base = { overallAppearance: BODY, appearanceForms: [{ name: 'Human', appearance: `${BODY}; grey cloak` }], currentFormUnknown: true, unclassifiedAppearance: 'A huge shadowy wolf with glowing eyes' };
    assert.equal(resolveNpcAppearance({ ...base, appearanceModelVersion: APPEARANCE_MODEL_VERSION }), 'A huge shadowy wolf with glowing eyes');
    assert.equal(resolveNpcAppearance({ ...base, appearanceModelVersion: 1 }), `${BODY}; A huge shadowy wolf with glowing eyes`, 'a version-1 record keeps what it showed');
    assert.equal(resolveNpcAppearance({ overallAppearance: BODY, currentFormUnknown: true, unclassifiedAppearance: 'Wreathed in mist' }), `${BODY}; Wreathed in mist`, 'without named forms Physical features still apply');
});

test('4: the dossier hides Physical features while a named form is current', () => {
    const model = form => normalizeAppearanceModel({ appearanceModelVersion: APPEARANCE_MODEL_VERSION, overallAppearance: 'Long silver hair', appearanceForms: [{ name: 'Dragon', appearance: 'A silver dragon' }], currentForm: form });
    assert.doesNotMatch(appearanceFormsHtml({ id: 'n', appearanceModel: model('Dragon') }), /Physical features/);
    assert.match(appearanceFormsHtml({ id: 'n', appearanceModel: model('') }), /Physical features/);
});

test('5: deleting a message from before the upgrade still removes the NPC it introduced', () => {
    const state = {
        npcs: [Object.assign(createNpcRecord('Keeper'), { id: 'npc_keeper' })], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [],
        lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    const chat = [];
    for (let i = 1; i <= 6; i += 1) {
        chat.push({ is_user: true, is_system: false, name: 'User', mes: `user-${i}` }, { is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${i}` });
        const id = chat.length - 1;
        ensureBranchParentAnchor(state, chat, id, 'assistant-parent');
        state.turn += 1;
        if (i === 3) {
            state.npcs[0].mood = 'angry';
            state.npcs.push({ ...createNpcRecord('Noela'), id: 'npc_noela', appearanceModelVersion: 1, overallAppearance: 'Long silver hair',
                appearanceForms: [{ name: 'Human', appearance: 'Grey cloak' }, { name: 'Dragon', appearance: 'A silver dragon' }], currentForm: 'Human' });
        }
        recordBranchCheckpoint(state, chat, id, 'scan');
    }
    state.npcs = state.npcs.map(normalizeNpcRecord);    // 1.0.98+ converted the live records
    const result = reconcileBranchState(state, chat.filter((_, index) => index !== 5), { explicitDivergence: 5, operation: 'delete' }).state;
    assert.deepEqual(result.npcs.map(npc => npc.name), ['Keeper']);
    assert.notEqual(result.npcs[0].mood, 'angry');
});

test('7/8: unused Physical features do not reject a portrait, and other forms are bounded in scan context', () => {
    const portrait = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(portrait, /formsInUse \? '' : \(npc\.overallAppearance \|\| ''\)/);
    const long = `${'A towering silver dragon with pearl-white scales, '.repeat(12)}and vast wings`;
    const npc = normalizeNpcRecord({ name: 'Noela', present: true, appearanceModelVersion: APPEARANCE_MODEL_VERSION, currentForm: 'Human',
        appearanceForms: [{ name: 'Human', appearance: `${BODY}; grey cloak` }, { name: 'Dragon', appearance: long }] });
    const prompt = buildScannerPrompt({ transcript: 'Noela shifts into her dragon form.', existingNpcs: [npc] });
    const context = prompt.slice(prompt.indexOf('Established Stage 4 appearance forms'));
    assert.match(context, new RegExp(`${BODY}; grey cloak`), 'the current form is shown whole');
    assert.ok(!context.includes(long), 'another form is shortened');
    assert.match(context, /…"/);
});

test('11/12: dead code is gone', () => {
    const sources = JSON.parse(fs.readFileSync(new URL('../runtime-modules.json', import.meta.url), 'utf8')).modules
        .map(module => fs.readFileSync(new URL(`../${module.path}`, import.meta.url), 'utf8')).join('\n');
    for (const name of ['hostIsOlderPrefix', 'portraitCustomPresetOptionsHtml', 'mergeMannerismRefinements', 'behaviorAgencyPolarity', 'safeUnmarkedReplacement',
        'boundRootSnapshot', 'queueSettingsSave', 'destructiveSettlementStatus', 'calendarSettingsSnapshot', 'estimateLocalTokens', 'portraitSignature']) {
        assert.doesNotMatch(sources, new RegExp(`\\b${name}\\b`), name);
    }
});
