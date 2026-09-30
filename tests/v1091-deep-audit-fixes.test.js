import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    createNpcRecord,
    mergeScanResult,
    normalizeNpcRecord,
    npcCurrentlyAbsentInText,
    npcNamedInText,
    relationshipSummaryConsistent,
    setActiveCalendarConfig,
} from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    applyRollbackUndo,
    buildRollbackUndo,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { preserveUserNpcMetadata } from '../branch-core.js';
import { mergeImportedDossierState } from '../bundle.js';
import { applyManualKeyRelationshipEdit, inverseSocialRelation, reconcileSocialState, socialRelationFamily } from '../social.js';
import { retireNpcStateDataFile } from '../storage.js';

const CALENDAR = { era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }], currentYear: 821, currentMonth: 'Redleaf', currentDay: 16 };

function branchState(npcs) {
    const state = {
        npcs, candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [],
        lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

function play(state, chat, count, change = () => {}) {
    for (let i = 1; i <= count; i += 1) {
        chat.push({ is_user: true, is_system: false, name: 'User', mes: `user-${i}` }, { is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${i}` });
        const messageId = chat.length - 1;
        ensureBranchParentAnchor(state, chat, messageId, 'assistant-parent');
        state.turn += 1;
        change(state, i, messageId);
        recordBranchCheckpoint(state, chat, messageId, 'scan');
    }
}

test('RB87-01 (storage): a lost or unreadable retirement acknowledgement is uncertain; a 4xx rejection is not', async () => {
    const pointer = { name: 'x.json', path: '/user/files/x.json', revision: 0 };
    const run = upload => retireNpcStateDataFile({
        chatKey: 'chat:a.png:x', pointer,
        fetchFn: async url => (url === '/api/files/upload' ? upload() : { ok: false, status: 404, text: async () => '' }),
    });
    await assert.rejects(run(() => { throw new TypeError('network connection lost'); }), error => error.retirementUncertain === true);
    await assert.rejects(run(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); }, text: async () => '' })), error => error.retirementUncertain === true);
    await assert.rejects(run(() => ({ ok: false, status: 502, text: async () => 'bad gateway' })), error => error.retirementUncertain === true);
    await assert.rejects(run(() => ({ ok: false, status: 403, text: async () => 'forbidden' })), error => error.retirementUncertain !== true);
});

test('RB87-05: an evolve label cannot carry a protected morality reversal, but still admits reworded development', () => {
    const run = (personality, reason = 'Her confidence has become a recurring habit.') => {
        const npc = createNpcRecord('Kessa');
        npc.id = 'npc_kessa';
        npc.personality = 'Kind and compassionate; avoids needless harm.';
        let state = { npcs: [npc], candidates: [], turn: 1 };
        const observations = [
            'confidence: speaks up first at the council table.',
            'confidence: takes charge of the caravan without being asked.',
            'confidence: argues her case plainly before the magistrate.',
        ];
        let report;
        observations.forEach((observation, index) => {
            const result = mergeScanResult(state, {
                npcs: [],
                profileUpdates: [{
                    id: npc.id,
                    evidence: { personality: [`[m${10 + index * 2}] ${observation}`] },
                    personalityState: 'evolve', personality, personalityReason: reason,
                    developmentScale: 'gradual', developmentReason: 'Recurring scenes show the change.',
                }],
            }, { turn: 2 + index * 2, sourceMessageId: 10 + index * 2 });
            state = result.state;
            report = result.report;
        });
        return { npc: state.npcs[0], report };
    };
    assert.equal(run('Cruel and sadistic; enjoys needless suffering.').npc.personality, 'Kind and compassionate; avoids needless harm.');
    const reworded = run('Self-assured and forthright; kind and compassionate.');
    assert.equal(reworded.npc.personality, 'Self-assured and forthright; kind and compassionate.', 'a reworded non-moral evolve still develops');
    const applied = JSON.stringify(reworded.report || {});
    assert.doesNotMatch(applied, /"authority":"model-evolve"[^}]*"candidateGrounded":true/, 'a label-only admission is not reported as grounded');
});

test('RB87-06: Speech ignores another person\'s voice and negated traits, and keeps plain attributed voice', () => {
    const scan = (speech, context, speechState = 'refine') => {
        const mira = createNpcRecord('Mira');
        mira.id = 'npc_mira';
        mira.speech = speech;
        const noela = createNpcRecord('Noela');
        noela.id = 'npc_noela';
        return mergeScanResult({ npcs: [mira, noela], candidates: [], turn: 3 }, {
            npcs: [{ id: 'npc_mira', name: 'Mira', speech: 'Speaks quietly, warmly and gently.', speechState }],
        }, { developmentContext: context }).state.npcs[0].speech;
    };
    assert.equal(scan('Speaks quietly.', 'Mira does not speak warmly or gently.'), 'Speaks quietly.');
    assert.equal(scan('Speaks quietly.', 'Mira listens to Noela, who always speaks warmly and gently.'), 'Speaks quietly.');
    assert.equal(scan('', 'Mira is reserved. Noela always speaks warmly and gently.'), '');
    assert.match(scan('', 'Mira speaks quietly, warmly and gently to the child.'), /warmly and gently/, 'her own voice still seeds');
    assert.match(scan('Speaks quietly.', '"Rest now," Mira says quietly, warmly and gently.'), /warmly and gently/, 'her own voice still refines');
});

test('RB87-07: a birth correction needs an affirmative birth fact about the NPC, which may span two sentences', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        const scan = text => {
            const npc = createNpcRecord('Mira');
            npc.id = 'npc_mira';
            npc.age = '20';
            npc.birthDate = { era: 'CR', year: 801, month: 'Redleaf', day: 1 };
            npc.birthDateSource = 'established';
            npc.birthDateYearSource = 'established';
            return mergeScanResult({ npcs: [npc], candidates: [], turn: 3 }, {
                npcs: [{ id: 'npc_mira', name: 'Mira', birthDate: { era: 'CR', year: 790, month: 'Redleaf', day: 2 }, birthDateState: 'correct' }],
            }, { developmentContext: text }).state.npcs[0];
        };
        for (const text of [
            'Mira visits Noela, who was born on Redleaf 2 in CR790.',
            'Mira signed a contract on Redleaf 2 in CR790.',
            'If Mira had been born on Redleaf 2 in CR790, she would be older.',
            'Mira shows a forged record saying she was born on Redleaf 2 in CR790.',
        ]) {
            assert.equal(scan(text).birthDate.year, 801, text);
            assert.equal(scan(text).age, '20', text);
        }
        assert.equal(scan('Mira was born in CR790. Her birthday is Redleaf 2.').birthDate.year, 790, 'split affirmative facts are supported');
        assert.equal(scan('Mira was born on Redleaf 2 in CR790.').birthDate.year, 790);
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB87-08: only an affirmative current birthday of the NPC rolls a yearless age over', () => {
    setActiveCalendarConfig({ era: CALENDAR.era, months: CALENDAR.months });
    try {
        const run = text => {
            const npc = normalizeNpcRecord({
                id: 'npc_mira', name: 'Mira', age: '20', apparentAge: '~20',
                birthDate: { era: '', year: null, month: 'Redleaf', day: 16 }, birthDateSource: 'established',
            });
            return mergeScanResult({ npcs: [npc], candidates: [], turn: 3, socialGraph: { version: 1, edges: [], unresolved: [] } }, { npcs: [] },
                { sourceMessageId: 9, developmentContext: `<World_State>Time | CR822, Redleaf 16 | evening</World_State> ${text}` }).state.npcs[0];
        };
        for (const text of [
            'Mira celebrates Noela\'s birthday.',
            'Mira says today is not her birthday.',
            'Is it Mira\'s birthday today?',
            'Mira remembers her birthday last year.',
            'Mira says Noela turns 18 today.',
        ]) assert.equal(run(text).age, '20', text);
        assert.equal(run('Mira celebrates her birthday.').age, '21');
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB87-09: another person\'s absence and a resolved absence do not keep a participating NPC away', () => {
    const mira = { name: 'Mira Deep' };
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep smiles because Noela is not here, then greets you at the records counter.'), false);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep was not here an hour ago, but now steps inside.'), false);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep has already left. Then she returns and sits beside you.'), false);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep remains at her distant home and is not here.'), true);
});

test('RB87-10: manual sibling suppression survives an unrelated import and an unrelated rollback', () => {
    const npc = (name, gender, bonds) => normalizeNpcRecord({ id: `npc_${name.toLowerCase()}`, name, gender, species: 'human', keyRelationships: bonds });
    let state = reconcileSocialState({ npcs: [npc('Mira', 'female', ['Orson — father']), npc('Noela', 'female', ['Orson — father']), npc('Orson', 'male', [])], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    const before = [...state.npcs[0].keyRelationships];
    state.npcs[0].keyRelationships = ['Orson — father'];
    applyManualKeyRelationshipEdit(state, 'npc_mira', before, state.npcs[0].keyRelationships, {});
    state = reconcileSocialState(state, {}).state;
    assert.ok(state.socialGraph.suppressed?.length, 'suppression recorded');

    const imported = mergeImportedDossierState(state, { npcs: [npc('Keeper', 'male', [])], socialGraph: { edges: [], unresolved: [] } });
    assert.ok(imported.socialGraph.suppressed?.length, 'an unrelated import keeps the suppression');
    const afterImport = reconcileSocialState(imported, {}).state;
    assert.ok(!afterImport.npcs.find(item => item.name === 'Mira').keyRelationships.some(entry => /^Noela/.test(entry)));

    const later = structuredClone(state);
    later.socialGraph.edges.push({ id: 'edge_keeper_orson', aId: 'npc_orson', bId: 'npc_keeper', aToB: 'friend', bToA: 'friend', provenance: 'explicit' });
    const undo = buildRollbackUndo(structuredClone(state), later);
    const rolledBack = applyRollbackUndo(structuredClone(later), undo).state;
    assert.ok(!rolledBack.socialGraph.edges.some(edge => edge.id === 'edge_keeper_orson'), 'the later edge is undone');
    assert.ok(rolledBack.socialGraph.suppressed?.length, 'an unrelated graph undo keeps the suppression');
});

test('RB87-11: in-law ties are not parenthood and do not infer siblings', () => {
    assert.equal(socialRelationFamily('father-in-law'), 'parent-in-law');
    assert.equal(inverseSocialRelation('father-in-law'), 'child-in-law');
    assert.equal(inverseSocialRelation('brother-in-law'), 'sibling-in-law');
    const npc = (name, gender, bonds) => normalizeNpcRecord({ id: `npc_${name.toLowerCase()}`, name, gender, species: 'human', keyRelationships: bonds });
    const state = reconcileSocialState({ npcs: [npc('Mira', 'female', ['Orson — father-in-law']), npc('Noela', 'female', ['Orson — father-in-law']), npc('Orson', 'male', [])], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    const [mira, noela, orson] = state.npcs;
    assert.ok(!mira.keyRelationships.some(entry => /^Noela/.test(entry)), mira.keyRelationships.join(' | '));
    assert.ok(!noela.keyRelationships.some(entry => /^Mira/.test(entry)));
    assert.ok(!orson.keyRelationships.some(entry => /— child(?!-in-law)\b/.test(entry)), orson.keyRelationships.join(' | '));
    const control = reconcileSocialState({ npcs: [npc('Mira', 'female', ['Orson — father']), npc('Noela', 'female', ['Orson — father']), npc('Orson', 'male', [])], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    assert.ok(control.npcs[0].keyRelationships.some(entry => /^Noela — sibling/.test(entry)), 'a shared father still infers siblings');
});

test('RB87-12: rollback keeps a manually saved portrait seed, including zero', () => {
    for (const seed of [999, 0]) {
        const restored = preserveUserNpcMetadata([{ id: 'npc_mira', name: 'Mira', portraitSeed: 417 }], [{ id: 'npc_mira', name: 'Mira', portraitSeed: seed }]);
        assert.equal(restored[0].portraitSeed, seed);
    }
});

test('RB87-13: a long alias does not hide a separately named short-name NPC', () => {
    const mira = Object.assign(createNpcRecord('Mira'), { id: 'npc_mira' });
    const valen = Object.assign(createNpcRecord('Mira Valen'), { id: 'npc_valen', aliases: ['Lady Mira Valen'] });
    const roster = [mira, valen];
    const named = text => roster.filter(npc => npcNamedInText(npc, text, roster)).map(npc => npc.name);
    assert.deepEqual(named('I ask Lady Mira Valen and Mira to join me.'), ['Mira', 'Mira Valen']);
    assert.deepEqual(named('I ask Lady Mira Valen to join me.'), ['Mira Valen']);
    assert.deepEqual(named('I ask Mira to join me.'), ['Mira']);
});

test('RB87-14: another NPC\'s full name does not keep a deleted NPC that shares its alias', () => {
    const run = laterMemory => {
        const mira = createNpcRecord('Mira');
        const hale = Object.assign(createNpcRecord('Tomas Hale'), { aliases: ['Tomas'] });
        const state = branchState([mira, hale]);
        const history = [];
        play(state, history, 6, (s, n) => {
            if (n === 3) {
                const reed = Object.assign(createNpcRecord('Tomas Reed'), { aliases: ['Tomas'], lifeState: 'deceased', lifeStateCertainty: 'explicit' });
                s.npcs.push(reed);
            }
            if (n === 5 && laterMemory) s.npcs[0].memories = [laterMemory];
        });
        return reconcileBranchState(state, history.filter((_, i) => i !== 5), { explicitDivergence: 5, operation: 'delete' }).state.npcs.map(npc => npc.name);
    };
    assert.ok(!run('Mira comforted Tomas Hale by the hearth.').includes('Tomas Reed'));
    assert.ok(run('Mira mourned Tomas Reed by the hearth.').includes('Tomas Reed'), 'naming Reed directly keeps him');
});

test('RB87-15: a refused obligation is a boundary, an affirmative one still needs standing', () => {
    const rel = { trust: 15, affection: 11, desire: 0, tension: 0 };
    assert.equal(relationshipSummaryConsistent('Does not feel she must repay him and maintains firm boundaries.', rel, '', []), true);
    assert.equal(relationshipSummaryConsistent('Feels no obligation to repay him and maintains firm boundaries.', rel, '', []), true);
    assert.equal(relationshipSummaryConsistent('Feels she must repay him for everything.', rel, '', []), false);
    assert.equal(relationshipSummaryConsistent('A loyal servant who must serve him.', rel, '', []), false, 'a word ending in "nt" is not a negation');
    assert.equal(relationshipSummaryConsistent("Doesn't think she must repay him.", rel, '', []), true);
});

test('RB87-17 (controller): native export checks the freshness result and its originating chat', () => {
    const source = fs.readFileSync(new URL('../dossier-tools.js', import.meta.url), 'utf8');
    const exporter = source.slice(source.indexOf('export async function exportNativeTools'), source.indexOf('// What the roleplay model receives'));
    assert.match(exporter, /if \(!await api\(\)\?\.ensureFresh\?\.\(\{ reason: 'dossier-export' \}\) \|\| !sameChat\(\)\)/);
    assert.match(exporter, /exportBytes\?\.\(\{ chatKey \}\)/);
});

async function deepAuditRuntimeChecks(mockState, eventSource, manualAddNpc, sleep, urls) {
    const runtime = globalThis.NPCStateDelta;
    const warnings = [];
    const successes = [];
    const errors = [];
    const previousToastr = { ...globalThis.toastr };
    globalThis.toastr.warning = message => warnings.push(String(message));
    globalThis.toastr.success = message => successes.push(String(message));
    globalThis.toastr.error = message => errors.push(String(message));
    const baseFetch = globalThis.fetch;
    const fail = message => { throw new Error(message); };
    const open = async (id, lines) => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes }));
        eventSource.emit('chat_changed');
        await sleep(150);
    };
    const waitUntil = async (predicate, label) => {
        for (let i = 0; i < 400; i++) { if (predicate()) return; await sleep(5); }
        fail(`deep audit runtime check did not settle: ${label}`);
    };
    const remoteAdvance = mutate => {
        const pointer = runtime.dataFile();
        const payload = JSON.parse(mockState.files.get(pointer.path));
        mutate(payload.state);
        payload.revision += 1;
        payload.writerId = 'remote-other-session';
        mockState.files.set(pointer.path, JSON.stringify(payload));
    };
    const settings = mockState.extensionSettings.npc_state_delta;

    // RB87-03: a new local turn on a stale chat does not certify the old history.
    await open('rb87-stale', ['Mira waits by the gate.', 'Mira watches the road.']);
    await manualAddNpc('Mira Stale');
    await runtime.flush();
    remoteAdvance(state => {
        state.lineage = [...state.lineage, 'remote-message-3', 'remote-message-4'];
        state.npcs.find(npc => npc.name === 'Mira Stale').mood = 'delighted';
    });
    await runtime.ensureFresh({ reason: 'rb87-remote-advance' });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'A different local turn.' });
    eventSource.emit('message_sent', mockState.context.chat.length - 1);
    await sleep(150);
    if (runtime.getState().lineage.length !== 4) fail(`RB87-03: a local turn replaced the adopted lineage (${runtime.getState().lineage.length})`);
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Narrator', mes: 'A local reply.', swipe_id: 0 });
    const rawBeforeStale = mockState.rawCalls.length;
    if (await runtime.scan() !== false) fail('RB87-03: a scan ran on the stale chat after a local turn');
    if (mockState.rawCalls.length !== rawBeforeStale) fail('RB87-03: the stale scan dispatched a request');
    if (runtime.getState().npcs.find(npc => npc.name === 'Mira Stale').mood !== 'delighted') fail('RB87-03: the adopted mood was overwritten');
    eventSource.emit('chat_changed');
    await sleep(300);

    // RB87-04: Refresh rejects a sole returned row that names someone else.
    await open('rb87-refresh', ['Mira Deep greets you. Noela has died elsewhere.', 'Mira Deep nods.']);
    await manualAddNpc('Mira Deep');
    await runtime.flush();
    const miraId = runtime.getState().npcs.find(npc => npc.name === 'Mira Deep').id;
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ id: 'npc_noela_wrong', name: 'Noela', lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Noela has died elsewhere', background: 'travelling merchant' }] });
    await runtime.refreshFromChat(miraId);
    if (runtime.getNpc(miraId).lifeState === 'deceased') fail('RB87-04: another NPC\'s death was applied to the Refresh target');
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Mira Deep Vale', background: 'records clerk of the old quarter' }] });
    await runtime.refreshFromChat(miraId);
    if (!/records clerk/.test(runtime.getNpc(miraId).background || '')) fail('RB87-04: an expanded target name was rejected');
    mockState.quietResponder = null;

    // RB87-16: Cancel during Save's freshness wait abandons the draft.
    await open('rb87-cancel', ['Sela Cancel tends herbs.', 'Sela Cancel hums.']);
    await manualAddNpc('Sela Cancel');
    await runtime.flush();
    const sela = runtime.getState().npcs.find(npc => npc.name === 'Sela Cancel');
    const originalRole = sela.role || '';
    const previousGetElementById = document.getElementById;
    await runtime.openEditor(sela.id);
    await sleep(30);
    const popup = mockState.popupCalls.at(-1);
    const values = new Map();
    const editorHtml = String(popup.content?.innerHTML ?? popup.content ?? '');
    for (const match of editorHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>/g)) {
        const attrs = match[2];
        values.set(match[1], { value: (attrs.match(/value="([^"]*)"/) || [])[1] ?? '', checked: /\bchecked\b/.test(attrs) });
    }
    for (const match of editorHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"[^>]*>([^<]*)<\/textarea>/g)) values.set(match[1], { value: match[2], checked: false });
    if (values.size < 10) fail(`RB87-16: the editor inputs were not found (${values.size})`);
    values.set('npc_state_delta_edit_role', { value: 'Canceled alchemist draft', checked: false });
    document.getElementById = id => values.get(id) || null;
    let releaseRead;
    let markEntered;
    const entered = new Promise(resolve => { markEntered = resolve; });
    mockState.readBarrier = { entered: markEntered, promise: new Promise(resolve => { releaseRead = resolve; }) };
    const saving = popup.complete(1);
    await entered;
    await popup.complete(null);
    releaseRead();
    await saving;
    await sleep(100);
    document.getElementById = previousGetElementById || (() => null);
    if (runtime.getNpc(sela.id).role !== originalRole) fail(`RB87-16: a cancelled Save applied its draft (${runtime.getNpc(sela.id).role})`);
    // Control: an uncancelled Save of the same kind of draft applies.
    await runtime.openEditor(sela.id);
    await sleep(30);
    const saved = mockState.popupCalls.at(-1);
    const savedValues = new Map();
    const savedHtml = String(saved.content?.innerHTML ?? saved.content ?? '');
    for (const match of savedHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>/g)) {
        savedValues.set(match[1], { value: (match[2].match(/value="([^"]*)"/) || [])[1] ?? '', checked: /\bchecked\b/.test(match[2]) });
    }
    for (const match of savedHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"[^>]*>([^<]*)<\/textarea>/g)) savedValues.set(match[1], { value: match[2], checked: false });
    savedValues.set('npc_state_delta_edit_role', { value: 'Kept herbalist draft', checked: false });
    document.getElementById = id => savedValues.get(id) || null;
    await saved.complete(1);
    await sleep(100);
    document.getElementById = previousGetElementById || (() => null);
    if (runtime.getNpc(sela.id).role !== 'Kept herbalist draft') fail(`RB87-16 control: an ordinary Save did not apply (${runtime.getNpc(sela.id).role}; ${warnings.slice(-1)})`);

    // RB87-17: an export requested in one chat does not download another.
    await open('rb87-export-a', ['Only A is here.', 'Only A waits.']);
    await manualAddNpc('Only A');
    await runtime.flush();
    // dossier-tools is normally loaded by the bootstrap; give its style/download DOM calls stubs.
    const previousHead = document.head;
    const previousBody = document.body;
    const previousCreateElement = document.createElement;
    document.head = previousHead || { appendChild() {} };
    document.body = previousBody || {};
    const previousBodyAppend = document.body.appendChild;
    document.body.appendChild = previousBodyAppend || (() => {});
    document.createElement = tag => ({ tagName: String(tag).toUpperCase(), style: {}, dataset: {}, click() {}, remove() {}, setAttribute() {}, append() {}, appendChild() {} });
    const { exportNativeTools } = await import(urls.dossierTools);
    const previousCreateObjectURL = URL.createObjectURL;
    let downloads = 0;
    URL.createObjectURL = () => { downloads += 1; return 'blob:synthetic-export'; };
    let releaseExport;
    let exportEntered;
    const exportGate = new Promise(resolve => { exportEntered = resolve; });
    mockState.readBarrier = { entered: exportEntered, promise: new Promise(resolve => { releaseExport = resolve; }) };
    const exporting = exportNativeTools();
    await exportGate;
    mockState.context.chatId = 'rb87-export-b';
    mockState.context.chat = [{ is_user: true, is_system: false, name: 'Kazuma', mes: 'Only B is here.' }];
    eventSource.emit('chat_changed');
    releaseExport();
    await exporting;
    await sleep(150);
    URL.createObjectURL = previousCreateObjectURL;
    document.createElement = previousCreateElement;
    document.body.appendChild = previousBodyAppend;
    if (!previousBody) delete document.body;
    if (!previousHead) delete document.head;
    if (downloads !== 0) fail('RB87-17: an export downloaded after the chat changed');

    // RB87-18: a full cast scan whose provider requests all fail does not report success.
    await open('rb87-fullcast', ['I look for Tarn Full.', 'Tarn Full waves from the counter.']);
    await manualAddNpc('Tarn Full');
    await runtime.flush();
    mockState.quietResponder = async () => { throw new Error('provider unavailable'); };
    const { runFullCastScan } = await import(urls.fullCast);
    successes.length = 0;
    const fullCast = await runFullCastScan(mockState.context.chat.length - 1, null, { manual: true });
    mockState.quietResponder = null;
    if (fullCast !== false) fail('RB87-18: a failed full cast scan returned success');
    if (successes.some(message => /full cast scan|full-scanned/i.test(message))) fail('RB87-18: a failed full cast scan announced success');

    // RB87-02: an uncertain chat-deletion retirement keeps and registers its recovery copy.
    await open('rb87-delete-chat', ['Oda Delete sweeps.', 'Oda Delete leans on the broom.']);
    await manualAddNpc('Oda Delete');
    await runtime.flush();
    const deleteKey = runtime.uiStatus().chatKey;
    const deletePath = runtime.dataFile().path;
    let retiredDelete = false;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body || '{}');
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            const response = await baseFetch(url, options);
            if (`/user/files/${body.name}` === deletePath && /"retired":\s*true/.test(text)) retiredDelete = true;
            return response;
        }
        if (url === deletePath && retiredDelete) return { ok: false, status: 403, text: async () => 'forbidden' };
        return baseFetch(url, options);
    };
    for (const listener of mockState.listeners.get('chat_deleted') || []) {
        try { await listener('rb87-delete-chat'); } catch { /* the uncertain deletion reports failure */ }
    }
    await sleep(300);
    globalThis.fetch = baseFetch;
    if (!retiredDelete) fail('RB87-02: the scenario did not reach source retirement');
    const recovery = settings.recoveryFiles?.[deleteKey];
    if (!recovery?.path || !mockState.files.has(recovery.path)) fail('RB87-02: the chat-deletion recovery copy was not kept and registered');

    // RB87-01: a lost retirement acknowledgement keeps the renamed dossier recoverable.
    await open('rb87-rename', ['Pell Lost counts coins.', 'Pell Lost smiles.']);
    await manualAddNpc('Pell Lost');
    await runtime.flush();
    const oldKey = runtime.uiStatus().chatKey;
    const oldOwner = oldKey.split(':')[1];
    const oldPath = runtime.dataFile().path;
    mockState.context.eventTypes.CHARACTER_RENAMED = 'character_renamed';
    const { prepareNpcStateHardening } = await import(urls.hardening);
    await prepareNpcStateHardening();
    let retiredRename = false;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body || '{}');
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            const response = await baseFetch(url, options);
            if (`/user/files/${body.name}` === oldPath && /"retired":\s*true/.test(text)) {
                retiredRename = true;
                throw new TypeError('network connection lost after the write');
            }
            return response;
        }
        return baseFetch(url, options);
    };
    for (const listener of mockState.listeners.get('character_renamed') || []) {
        try { await listener(oldOwner, `renamed-${oldOwner}`); } catch { /* the partial rename reports failure */ }
    }
    globalThis.fetch = baseFetch;
    if (!retiredRename) fail('RB87-01: the scenario did not reach source retirement');
    const survivors = [...mockState.files.entries()].filter(([filePath, text]) => filePath !== oldPath && /Pell Lost/.test(text));
    if (!survivors.length) fail('RB87-01: every durable copy of the dossier was deleted');
    if (!settings.recoveryFiles?.[oldKey]?.path) fail('RB87-01: the recovery copy was not registered');

    Object.assign(globalThis.toastr, previousToastr);
    setTimeout(() => process.exit(0), 1500);
}

test('RB87-01/02/03/04/16/17/18 run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    // Module URLs are built inside the harness, which copies the extension into its synthetic host tree.
    const urls = "{ hardening: pathToFileURL(path.join(extRoot, 'hardening.js')).href, fullCast: pathToFileURL(path.join(extRoot, 'full-cast.js')).href, dossierTools: pathToFileURL(path.join(extRoot, 'dossier-tools.js')).href }";
    source = source.replace(marker, `    await (${deepAuditRuntimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, ${urls});\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
    });
});
