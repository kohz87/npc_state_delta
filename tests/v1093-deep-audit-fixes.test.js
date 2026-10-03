import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    speechSupportContext,
} from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { mergeImportedDossierState } from '../bundle.js';
import { applyManualKeyRelationshipEdit, normalizeSocialGraph, reconcileSocialState, remapSocialGraphNpcIds } from '../social.js';
import { quarantineUnreadableNpcStateDataFile } from '../storage.js';

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

const deleteMiddle = (state, chat, index) => reconcileBranchState(state, chat.filter((_, i) => i !== index), { explicitDivergence: index, operation: 'delete' });

test('RB92-06 (storage): detach preserves the unreadable bytes and leaves a replaceable retired marker', async () => {
    const files = new Map([['/user/files/broken.json', '{"format": not json']]);
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const filePath = `/user/files/${body.name}`;
            files.set(filePath, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: filePath }), text: async () => '' };
        }
        return files.has(url) ? { ok: true, status: 200, text: async () => files.get(url) } : { ok: false, status: 404, text: async () => '' };
    };
    const preserved = await quarantineUnreadableNpcStateDataFile({ chatKey: 'chat:a.png:x', pointer: { name: 'broken.json', path: '/user/files/broken.json' }, fetchFn });
    assert.ok(preserved?.path && preserved.path !== '/user/files/broken.json');
    assert.equal(files.get(preserved.path), '{"format": not json', 'the exact broken bytes are kept');
    assert.match(files.get('/user/files/broken.json'), /"retired":\s*true/, 'the canonical path now holds a retired marker a fresh write may replace');
});

test('RB92-07: deleting a middle message undoes its own effects on an NPC who died independently later', () => {
    const mira = createNpcRecord('Mira');
    mira.mood = 'calm';
    const state = branchState([mira]);
    const history = [];
    play(state, history, 6, (s, n) => {
        if (n === 3) { s.npcs[0].mood = 'angry'; s.npcs[0].memories = ['Saw the stolen locket']; }
        if (n === 4) Object.assign(s.npcs[0], { lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Died in the fire', archived: true, archiveReason: 'deceased' });
    });
    const after = deleteMiddle(state, history, 5).state.npcs[0];
    assert.equal(after.lifeState, 'deceased', 'the independent death stays');
    assert.equal(after.mood, 'calm', 'the deleted message\'s mood is undone');
    assert.deepEqual(after.memories, [], 'the deleted message\'s memory is undone');
});

test('RB92-08: a manually saved seed does not keep an NPC whose only introduction was deleted', () => {
    const run = change => {
        const keeper = createNpcRecord('Keeper');
        const state = branchState([keeper]);
        const history = [];
        play(state, history, 6, (s, n) => {
            if (n === 3) s.npcs.push(createNpcRecord('Mira Gone'));
            if (n === 4) change(s.npcs.find(npc => npc.name === 'Mira Gone'));
        });
        return deleteMiddle(state, history, 5).state.npcs.map(npc => npc.name);
    };
    assert.ok(!run(npc => { npc.portraitSeed = 123; }).includes('Mira Gone'));
    assert.ok(!run(npc => { npc.portraitPromptPositive = 'silver hair'; npc.retentionProtected = true; }).includes('Mira Gone'));
    assert.ok(run(npc => { npc.goal = 'find the keeper'; }).includes('Mira Gone'), 'genuine later story use keeps her');
});

test('RB92-09/10: Speech support keeps the target\'s own clauses and drops foreign, denied and hypothetical voice', () => {
    const binding = { npc: { name: 'Mira' }, otherLabels: ['Noela'] };
    const support = text => speechSupportContext(text, binding);
    assert.match(support('Mira, who always speaks warmly and gently, greets the child.'), /warmly and gently/);
    assert.match(support('Noela listens while Mira speaks quietly, warmly and gently.'), /warmly and gently/);
    assert.match(support('**Voice:** Clipped, formal, and precise.'), /clipped formal and precise/);
    for (const text of [
        'Mira listens to Noela, who always speaks warmly and gently.',
        'Mira is reserved. Noela always speaks warmly and gently.',
        'Mira speaks neither warmly nor gently.',
        'Mira denies speaking warmly or gently.',
        'Her mother speaks warmly and gently to Mira.',
        'If Mira spoke warmly and gently, they would listen.',
    ]) assert.doesNotMatch(support(text), /warmly/, text);

    const refine = context => {
        const mira = Object.assign(createNpcRecord('Mira'), { id: 'npc_mira', speech: 'Speaks quietly.' });
        const noela = Object.assign(createNpcRecord('Noela'), { id: 'npc_noela' });
        return mergeScanResult({ npcs: [mira, noela], candidates: [], turn: 3 }, {
            npcs: [{ id: 'npc_mira', name: 'Mira', speech: 'Speaks quietly, warmly and gently.', speechState: 'refine' }],
        }, { developmentContext: context }).state.npcs[0].speech;
    };
    assert.match(refine('Mira, who always speaks warmly and gently, greets the child.'), /warmly and gently/, 'a valid target relative clause refines (RB92-10)');
    for (const text of ['Mira speaks neither warmly nor gently.', 'Mira denies speaking warmly or gently.', 'If Mira spoke warmly and gently, they would listen.']) {
        assert.equal(refine(text), 'Speaks quietly.', text);
    }
    const seed = () => {
        const mira = Object.assign(createNpcRecord('Mira'), { id: 'npc_mira', speech: '' });
        const noela = Object.assign(createNpcRecord('Noela'), { id: 'npc_noela' });
        return mergeScanResult({ npcs: [mira, noela], candidates: [], turn: 3 }, {
            npcs: [],
            profileUpdates: [{ id: 'npc_mira', speechState: 'refine', speech: 'Speaks warmly and gently.', evidence: { speech: [] } }],
        }, { developmentContext: 'Mira is reserved. Noela always speaks warmly and gently.' }).state.npcs[0].speech;
    };
    assert.equal(seed(), '', 'the profileUpdates channel does not seed another person\'s voice');
});

test('RB92-11/12: birth corrections and yearless rollover need the NPC\'s own affirmative, current claim', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        const correct = text => {
            const npc = Object.assign(createNpcRecord('Mira'), { id: 'npc_mira', age: '20', birthDate: { era: 'CR', year: 801, month: 'Redleaf', day: 1 }, birthDateSource: 'established', birthDateYearSource: 'established' });
            return mergeScanResult({ npcs: [npc, Object.assign(createNpcRecord('Noela'), { id: 'npc_noela' })], candidates: [], turn: 3 }, {
                npcs: [{ id: 'npc_mira', name: 'Mira', birthDate: { era: 'CR', year: 790, month: 'Redleaf', day: 2 }, birthDateState: 'correct' }],
            }, { developmentContext: text }).state.npcs[0];
        };
        for (const text of [
            'Noela was born on Redleaf 2 in CR790, according to Mira.',
            'Mira denies that she was born on Redleaf 2 in CR790.',
            'Mira asks whether she was born on Redleaf 2 in CR790.',
            'The record saying Mira was born on Redleaf 2 in CR790 is a forgery.',
        ]) assert.equal(correct(text).birthDate.year, 801, text);
        assert.equal(correct('Mira was born in CR790. Her birthday is Redleaf 2.').birthDate.year, 790);
    } finally {
        setActiveCalendarConfig(null);
    }
    setActiveCalendarConfig({ era: CALENDAR.era, months: CALENDAR.months });
    try {
        const roll = text => {
            const npc = normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', age: '20', apparentAge: '~20', birthDate: { era: '', year: null, month: 'Redleaf', day: 16 }, birthDateSource: 'established' });
            return mergeScanResult({ npcs: [npc], candidates: [], turn: 3, socialGraph: { version: 1, edges: [], unresolved: [] } }, { npcs: [] },
                { sourceMessageId: 9, developmentContext: `<World_State>Time | CR822, Redleaf 16 | evening</World_State> ${text}` }).state.npcs[0].age;
        };
        for (const text of [
            'Noela celebrates her birthday in front of Mira.',
            'Mira denies that today is her birthday.',
            'Mira wonders whether today is her birthday.',
            'Mira talks about her next birthday tomorrow.',
            'Mira recounts a birthday from five years earlier.',
        ]) assert.equal(roll(text), '20', text);
        assert.equal(roll('Mira celebrates her birthday.'), '21');
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB92-13: a denied or future return is not a current arrival; another person\'s absence does not remove her', () => {
    const mira = { name: 'Mira Deep' };
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep is away. She will return tomorrow.'), true);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep does not return.'), true);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep is away. She might return if the storm passes.'), true);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep greets you, but Noela Far is not here.'), false);
    assert.equal(npcCurrentlyAbsentInText(mira, 'Mira Deep was not here an hour ago, but now steps inside.'), false);
});

test('RB92-16: a titled full name does not select an unrelated NPC by first name', () => {
    const deep = Object.assign(createNpcRecord('Mira Deep'), { id: 'npc_deep' });
    const valen = Object.assign(createNpcRecord('Lady Mira Valen'), { id: 'npc_valen' });
    const hale = Object.assign(createNpcRecord('Tomas Hale'), { id: 'npc_hale' });
    const reed = Object.assign(createNpcRecord('Lord Reed'), { id: 'npc_reed', aliases: ['Captain Tomas Reed'] });
    const roster = [deep, valen, hale, reed];
    const named = text => roster.filter(npc => npcNamedInText(npc, text, roster)).map(npc => npc.name);
    assert.deepEqual(named('I ask Lady Mira Valen to sit.'), ['Lady Mira Valen']);
    assert.deepEqual(named('Captain Tomas Reed salutes.'), ['Lord Reed']);
    assert.deepEqual(named('Mira, come here.'), ['Mira Deep'], 'an independent first name still selects its owner');
});

test('RB92-17: an unrelated negation does not exempt an affirmative obligation', () => {
    const rel = { trust: 15, affection: 11, desire: 0, tension: 0 };
    for (const text of [
        'She is not angry but believes she must repay him for everything.',
        'She never doubts that only he can save her.',
        'She refuses to leave because she must serve him.',
        'She does not resent him and views him as her chosen partner.',
    ]) assert.equal(relationshipSummaryConsistent(text, rel, '', []), false, text);
    assert.equal(relationshipSummaryConsistent('Does not feel she must repay him and maintains firm boundaries.', rel, '', []), true);
});

test('RB92-18: swapped import ids are remapped atomically', () => {
    const graph = normalizeSocialGraph({ edges: [
        { id: 'e_hidden', aId: 'npc_a', bId: 'npc_b', aToB: 'rival', bToA: 'rival', aDynamic: 'codex debt', provenance: 'explicit' },
        { id: 'e_a_f1', aId: 'npc_a', bId: 'npc_f1', aToB: 'friend', bToA: 'friend', provenance: 'explicit' },
        { id: 'e_b_f2', aId: 'npc_b', bId: 'npc_f2', aToB: 'friend', bToA: 'friend', provenance: 'explicit' },
    ], unresolved: [] });
    const swapped = remapSocialGraphNpcIds(graph, new Map([['npc_a', 'npc_b'], ['npc_b', 'npc_a']]));
    assert.equal(swapped.edges.length, 3);
    assert.ok(swapped.edges.some(edge => /codex debt/.test(JSON.stringify(edge))), 'the hidden bond survives');
    assert.ok(swapped.edges.some(edge => [edge.aId, edge.bId].includes('npc_b') && [edge.aId, edge.bId].includes('npc_f1')));
    assert.ok(swapped.edges.some(edge => [edge.aId, edge.bId].includes('npc_a') && [edge.aId, edge.bId].includes('npc_f2')));
    const imported = mergeImportedDossierState({ npcs: [], socialGraph: { edges: [], unresolved: [] } }, {
        npcs: [Object.assign(createNpcRecord('Mira'), { id: 'npc_x' })], socialGraph: { edges: [], unresolved: [] },
    });
    assert.ok(Array.isArray(imported.socialGraph.edges));
});

test('RB92-19: the newest manual sibling removal holds past sixty removals', () => {
    const npc = (name, bonds) => normalizeNpcRecord({ id: `npc_${name.toLowerCase()}`, name, gender: 'female', species: 'human', keyRelationships: bonds });
    const children = Array.from({ length: 13 }, (_, i) => npc(`Child${i + 1}`, ['Orson — father']));
    let state = reconcileSocialState({ npcs: [...children, npc('Orson', [])], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    let removals = 0;
    outer: for (let i = 0; i < 13; i += 1) {
        for (let j = i + 1; j < 13; j += 1) {
            const owner = state.npcs[i];
            const before = [...owner.keyRelationships];
            const after = before.filter(entry => !entry.startsWith(`Child${j + 1} —`));
            if (after.length === before.length) continue;
            owner.keyRelationships = after;
            applyManualKeyRelationshipEdit(state, owner.id, before, after, {});
            state = reconcileSocialState(state, {}).state;
            removals += 1;
            assert.ok(!state.npcs[i].keyRelationships.some(entry => entry.startsWith(`Child${j + 1} —`)), `removal ${removals} came back`);
            if (removals >= 61) break outer;
        }
    }
    assert.ok(removals >= 61);
});

test('RB92-20/21/22/23: workflow guards are in place', () => {
    const portrait = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(portrait, /session\.generationBase = portraitGenerationBase\(session\.npcId, session\.form\)/);
    assert.match(portrait, /session\.generationBase !== portraitGenerationBase\(session\.npcId, session\.form\)/);
    assert.match(portrait, /setPortraitSeed\?\.\(session\.npcId, seed, \{ chatKey: session\.chatKey, isCurrent: \(\) => currentSessionIs\(session\) \}\)/);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /function setNpcPortraitSeed\(npcId, seed, \{ chatKey, isCurrent = \(\) => true \} = \{\}\) \{\n[^\n]*\n    if \(!isCurrent\(\)\) return false;/);
    assert.match(index, /!popup && editorAtStart && editorAtStart\.result !== undefined && editorAtStart\.result !== affirmative/);
    const fullCast = fs.readFileSync(new URL('../full-cast.js', import.meta.url), 'utf8');
    assert.match(fullCast, /marker === null \|\| marker === undefined \|\| marker === '' \? null : Number\(marker\)/);
});

async function deepAuditRuntimeChecks(mockState, eventSource, manualAddNpc, sleep, urls) {
    const runtime = globalThis.NPCStateDelta;
    const warnings = [];
    const previousToastr = { ...globalThis.toastr };
    globalThis.toastr.warning = message => warnings.push(String(message));
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
    const remoteAdvance = mutate => {
        const pointer = runtime.dataFile();
        const payload = JSON.parse(mockState.files.get(pointer.path));
        mutate(payload.state, payload);
        payload.revision += 1;
        payload.writerId = 'remote-other-session';
        mockState.files.set(pointer.path, JSON.stringify(payload));
    };
    const settings = mockState.extensionSettings.npc_state_delta;

    // RB92-01: sending re-checks the server, so a newer dossier is adopted before the local turn.
    await open('rb92-send', ['Mira waits by the gate.', 'Mira watches the road.']);
    await manualAddNpc('Mira Send');
    await runtime.flush();
    remoteAdvance(state => {
        state.lineage = [...state.lineage, 'remote-message-3', 'remote-message-4'];
        state.npcs.find(npc => npc.name === 'Mira Send').mood = 'delighted';
    });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'A local turn.' });
    for (const listener of mockState.listeners.get('message_sent') || []) await listener(mockState.context.chat.length - 1);
    if (runtime.getState().npcs.find(npc => npc.name === 'Mira Send')?.mood !== 'delighted') fail('RB92-01: the newer dossier was not adopted before generation');
    if (runtime.getState().lineage.length !== 4) fail('RB92-01: the local turn replaced the adopted lineage');
    eventSource.emit('chat_changed');
    await sleep(300);

    // RB92-02: a retirement observed by this session keeps the open chat blocked on retry.
    await open('rb92-retired', ['Mara Valen counts coins.', 'Mara Valen smiles.']);
    await manualAddNpc('Mara Valen');
    await runtime.flush();
    remoteAdvance((state, payload) => { payload.retired = true; payload.retiredAt = new Date().toISOString(); payload.retireReason = 'chat-deleted'; payload.state = {}; });
    const rawBeforeRetired = mockState.rawCalls.length;
    // Both attempts are refused (the first observes the retirement, the retry must not reuse it).
    await runtime.scan().catch(() => false);
    await runtime.scan().catch(() => false);
    await sleep(100);
    if (mockState.rawCalls.length !== rawBeforeRetired) fail('RB92-02: a retried scan dispatched on a retired chat');
    if (/Mara Valen/.test(mockState.files.get(runtime.dataFile()?.path || '') || '')) fail('RB92-02: the retired dossier was revived');

    // RB92-03: an earlier permissive match cannot give another NPC's death to the target.
    await open('rb92-target', ['Mira Deep greets you. Noela has died elsewhere.', 'Mira Deep nods.']);
    await manualAddNpc('Mira Deep');
    await manualAddNpc('Mira Vale');
    await runtime.flush();
    const miraId = runtime.getState().npcs.find(npc => npc.name === 'Mira Deep').id;
    for (const row of [
        { id: miraId, name: 'Noela', lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Noela has died elsewhere' },
        { name: 'Noela', role: 'Assistant to Mira Deep', lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Noela has died elsewhere' },
        { name: 'Mira Vale', lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Mira Vale fell' },
    ]) {
        mockState.quietResponder = async () => JSON.stringify({ npcs: [row] });
        await runtime.refreshFromChat(miraId);
        if (runtime.getNpc(miraId).lifeState === 'deceased') fail(`RB92-03: a contradicting row was applied (${row.name})`);
    }
    mockState.quietResponder = null;

    // RB92-04: an edit during Refresh's final freshness read discards the obsolete result.
    await open('rb92-final', ['What happened to Ilse Final?', 'Ilse Final died in the warehouse fire.']);
    await manualAddNpc('Ilse Final');
    await runtime.flush();
    const ilseId = runtime.getState().npcs.find(npc => npc.name === 'Ilse Final').id;
    const sidecarPath = runtime.dataFile().path;
    let armed = false;
    let reads = 0;
    let releaseFinal;
    let finalEntered;
    const finalGate = new Promise(resolve => { finalEntered = resolve; });
    globalThis.fetch = async (url, options = {}) => {
        if (armed && url === sidecarPath && (options.method || 'GET') === 'GET') {
            reads += 1;
            if (reads === 2) { finalEntered(); await new Promise(resolve => { releaseFinal = resolve; }); }
        }
        return baseFetch(url, options);
    };
    mockState.quietResponder = async () => {
        armed = true;
        return JSON.stringify({ npcs: [{ id: ilseId, name: 'Ilse Final', lifeState: 'deceased', lifeStateCertainty: 'explicit', lifeStateReason: 'Died in the warehouse fire' }] });
    };
    const finalRefresh = runtime.refreshFromChat(ilseId);
    await finalGate;
    // Later scans of the edited history see her alive.
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ id: ilseId, name: 'Ilse Final', lifeState: 'alive', present: false }] });
    mockState.context.chat[mockState.context.chat.length - 1].mes = 'Ilse Final survives the warehouse fire, alive and unharmed.';
    eventSource.emit('message_edited', mockState.context.chat.length - 1);
    await sleep(50);
    releaseFinal();
    if (await finalRefresh !== false) fail('RB92-04: Refresh committed after its source was edited during the final read');
    await sleep(300);
    globalThis.fetch = baseFetch;
    mockState.quietResponder = null;
    if (runtime.getNpc(ilseId).lifeState === 'deceased') fail('RB92-04: an obsolete death was saved against the edited survival history');

    // RB92-15: a single-target backfill changes only its target in every result channel.
    await open('rb92-backfill', ['Mira Scope and Noela Scope meet Kora Scope.', 'Mira Scope waves.']);
    await manualAddNpc('Mira Scope');
    await manualAddNpc('Noela Scope');
    await manualAddNpc('Kora Scope');
    await runtime.flush();
    const scope = name => runtime.getState().npcs.find(npc => npc.name === name);
    const noelaSpeechBefore = scope('Noela Scope').speech || '';
    mockState.quietResponder = async () => JSON.stringify({
        npcs: [{ id: scope('Mira Scope').id, name: 'Mira Scope', mood: 'cheerful' }],
        profileUpdates: [{ id: scope('Noela Scope').id, speechState: 'refine', speech: 'Speaks in grand rhymes.', evidence: { speech: [] } }],
        keyRelationshipEdges: [{ aId: scope('Noela Scope').id, a: 'Noela Scope', bId: scope('Kora Scope').id, b: 'Kora Scope', aToB: 'friend', bToA: 'friend', reason: 'they meet' }],
    });
    await runtime.scanDossier(scope('Mira Scope').id);
    await sleep(200);
    mockState.quietResponder = null;
    if ((scope('Noela Scope').speech || '') !== noelaSpeechBefore) fail('RB92-15: backfill changed another NPC\'s Speech');
    if ((runtime.getState().socialGraph?.edges || []).some(edge => [edge.aId, edge.bId].includes(scope('Noela Scope').id) && [edge.aId, edge.bId].includes(scope('Kora Scope').id))) fail('RB92-15: backfill created a bond between two other NPCs');

    // RB92-14: Refresh does not restore a summary the canonical gate rejected.
    await open('rb92-summary', ['Tess Ward keeps a professional distance.', 'Tess Ward nods.']);
    await manualAddNpc('Tess Ward');
    await runtime.flush();
    const tessId = runtime.getState().npcs.find(npc => npc.name === 'Tess Ward').id;
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ id: tessId, name: 'Tess Ward', relationshipSummary: 'Feels she must repay him and will follow him anywhere.', mood: 'quiet' }] });
    await runtime.refreshFromChat(tessId);
    mockState.quietResponder = null;
    if (/must repay|follow him anywhere/.test(runtime.getNpc(tessId).relationshipSummary || '')) fail('RB92-14: Refresh stored a rejected summary');

    // RB92-22: Refresh's implicit editor save honours a cancelled popup.
    await open('rb92-implicit', ['Sela Implicit tends herbs.', 'Sela Implicit hums.']);
    await manualAddNpc('Sela Implicit');
    await runtime.flush();
    const sela = runtime.getState().npcs.find(npc => npc.name === 'Sela Implicit');
    const originalRole = sela.role || '';
    const previousGetElementById = document.getElementById;
    await runtime.openEditor(sela.id);
    await sleep(30);
    const popup = mockState.popupCalls.at(-1);
    const editorHtml = String(popup.content?.innerHTML ?? popup.content ?? '');
    const values = new Map();
    for (const match of editorHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>/g)) {
        values.set(match[1], { value: (match[2].match(/value="([^"]*)"/) || [])[1] ?? '', checked: /\bchecked\b/.test(match[2]) });
    }
    for (const match of editorHtml.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"[^>]*>([^<]*)<\/textarea>/g)) values.set(match[1], { value: match[2], checked: false });
    values.set('npc_state_delta_edit_role', { value: 'Canceled Refresh alchemist draft', checked: false });
    document.getElementById = id => values.get(id) || null;
    let releaseRead;
    let markEntered;
    const entered = new Promise(resolve => { markEntered = resolve; });
    mockState.readBarrier = { entered: markEntered, promise: new Promise(resolve => { releaseRead = resolve; }) };
    mockState.quietResponder = async () => '{"npcs":[]}';
    const refreshing = runtime.refreshFromChat(sela.id);
    await entered;
    popup.result = null;   // host Popup sets the result before its closing animation; onClose comes later
    releaseRead();
    const refreshResult = await refreshing;
    await sleep(100);
    document.getElementById = previousGetElementById || (() => null);
    mockState.quietResponder = null;
    if (runtime.getNpc(sela.id).role !== originalRole) fail(`RB92-22: the cancelled implicit save applied (${runtime.getNpc(sela.id).role})`);
    if (refreshResult !== false) fail('RB92-22: Refresh continued after the editor was cancelled');
    await popup.complete(null);

    // RB92-23: Full Cast scans an unscanned greeting at message 0.
    mockState.context.groupId = null;
    mockState.context.chatId = 'rb92-greeting';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    mockState.context.chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: 'Mira Greet waves from the counter.' }];
    eventSource.emit('chat_changed');
    await sleep(150);
    const { runFullCastScan } = await import(urls.fullCast);
    const rawBeforeGreeting = mockState.rawCalls.length;
    mockState.quietResponder = async () => '{"npcs":[]}';
    await runFullCastScan(0, null, { manual: true });
    mockState.quietResponder = null;
    if (mockState.rawCalls.length === rawBeforeGreeting) fail('RB92-23: Full Cast skipped the unscanned greeting at message 0');

    // RB92-05: an uncertain rename retirement resumes on retry.
    await open('rb92-rename', ['Pell Resume counts coins.', 'Pell Resume smiles.']);
    await manualAddNpc('Pell Resume');
    await runtime.flush();
    const oldKey = runtime.uiStatus().chatKey;
    const oldOwner = oldKey.split(':')[1];
    const oldPath = runtime.dataFile().path;
    eventSource.emit('chat_changed');
    mockState.context.chatId = 'rb92-other';
    mockState.context.chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: 'Elsewhere.' }];
    eventSource.emit('chat_changed');
    await sleep(150);
    mockState.context.eventTypes.CHARACTER_RENAMED = 'character_renamed';
    const { prepareNpcStateHardening } = await import(urls.hardening);
    await prepareNpcStateHardening();
    let failOnce = true;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/upload' && failOnce) {
            const body = JSON.parse(options.body || '{}');
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            if (`/user/files/${body.name}` === oldPath && /"retired":\s*true/.test(text)) {
                failOnce = false;
                await baseFetch(url, options);
                throw new TypeError('network connection lost after the write');
            }
        }
        return baseFetch(url, options);
    };
    const renameTo = `renamed-${oldOwner}`;
    for (const listener of mockState.listeners.get('character_renamed') || []) {
        try { await listener(oldOwner, renameTo); } catch { /* the uncertain first attempt reports failure */ }
    }
    if (!settings.pendingRenames?.[oldKey]) fail('RB92-05: the uncertain rename left no resumable record');
    for (const listener of mockState.listeners.get('character_renamed') || []) {
        try { await listener(oldOwner, renameTo); } catch (error) { fail(`RB92-05: the retry failed: ${error?.message || error}`); }
    }
    globalThis.fetch = baseFetch;
    const newKey = oldKey.replace(`:${oldOwner}:`, `:${renameTo}:`);
    if (!settings.dataFiles?.[newKey]?.path) fail('RB92-05: the retry did not publish the renamed dossier');
    if (settings.pendingRenames?.[oldKey]) fail('RB92-05: the resumable record was not cleared');

    Object.assign(globalThis.toastr, previousToastr);
    setTimeout(() => process.exit(0), 1500);
}

test('RB92-01/02/03/04/05/14/15/22/23 run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    // Module URLs are built inside the harness, which copies the extension into its synthetic host tree.
    const urls = "{ hardening: pathToFileURL(path.join(extRoot, 'hardening.js')).href, fullCast: pathToFileURL(path.join(extRoot, 'full-cast.js')).href }";
    source = source.replace(marker, `    await (${deepAuditRuntimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, ${urls});\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
    });
});
