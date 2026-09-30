import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNpcRecord, mergeScanResult, npcNamedInText, setActiveCalendarConfig } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';

const user = turn => ({ is_user: true, is_system: false, name: 'User', mes: `user-${turn}` });
const bot = turn => ({ is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${turn}` });

function makeState() {
    const mira = createNpcRecord('Mira');
    mira.mood = 'calm';
    mira.goal = 'wait';
    const state = {
        npcs: [mira], candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [],
        lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

// Exchange n: user at 2n-2, assistant at 2n-1; `change` acts as that assistant's scan.
function play(state, chat, count, change = () => {}) {
    for (let i = 1; i <= count; i += 1) {
        chat.push(user(i), bot(i));
        const messageId = chat.length - 1;
        ensureBranchParentAnchor(state, chat, messageId, 'assistant-parent');
        state.turn += 1;
        change(state, i, messageId);
        recordBranchCheckpoint(state, chat, messageId, 'scan');
    }
}

const deleteAt = (state, chat, index) => reconcileBranchState(state, chat.filter((_, i) => i !== index), { explicitDivergence: index, operation: 'delete' });
const mira = result => result.state.npcs.find(npc => npc.name === 'Mira');

test('BUG-03: without the exact boundary before the deleted block, earlier accepted facts are kept', () => {
    const state = makeState();
    const chat = [];
    play(state, chat, 6, (s, n) => {
        if (n === 1) s.npcs[0].mood = 'angry';          // retained message 1
        if (n === 3) s.npcs[0].goal = 'leave';          // deleted message 5
        if (n === 5) s.npcs[0].location = 'harbor';     // retained later message
    });
    state.rollbackJournalFloorMessageId = chat.length;  // the journal no longer reaches back
    const sparse = structuredClone(state);
    sparse.checkpoints = sparse.checkpoints.filter(item => item.messageId === 0 || item.messageId === 5);
    const result = deleteAt(sparse, chat, 5);
    assert.equal(mira(result).mood, 'angry', 'the retained message 1 mood survives');
    assert.equal(mira(result).goal, 'leave', 'nothing is reverted without proof of the exact boundary');
    assert.deepEqual(result.deletedEffects.reverted, []);

    const exact = structuredClone(state);
    exact.checkpoints = exact.checkpoints.filter(item => item.messageId === 0 || item.messageId === 4 || item.messageId === 5);
    const proven = deleteAt(exact, chat, 5);
    assert.equal(mira(proven).goal, 'wait', 'with the exact boundary the deleted goal change is undone');
    assert.equal(mira(proven).mood, 'angry');
    assert.equal(mira(proven).location, 'harbor');
});

test('BUG-09: an NPC introduced and killed only in the deleted block is removed', () => {
    const run = laterMention => {
        const state = makeState();
        const chat = [];
        play(state, chat, 6, (s, n) => {
            if (n === 3) {
                const stranger = createNpcRecord('Fallen Stranger');
                stranger.lifeState = 'deceased';
                stranger.lifeStateCertainty = 'explicit';
                stranger.archived = true;
                s.npcs.push(stranger);
            }
            if (n === 5 && laterMention) s.npcs[0].memories = ['Buried the Fallen Stranger by the road.'];
        });
        return deleteAt(state, chat, 5);
    };
    const removed = run(false);
    assert.deepEqual(removed.deletedEffects.removed.map(item => item.name), ['Fallen Stranger']);
    assert.equal(removed.state.npcs.some(npc => npc.name === 'Fallen Stranger'), false);
    const kept = run(true);
    assert.ok(kept.state.npcs.some(npc => npc.name === 'Fallen Stranger'), 'a retained later message used the dead NPC');
});

test('BUG-08: a shared title or first name does not pull in other NPCs', () => {
    const roster = ['Lady Mira', 'Lady Noela', 'Lady Vera', 'Linnea Vael', 'Tomas Reed', 'Tomas Hale'].map(name => createNpcRecord(name));
    const named = text => roster.filter(npc => npcNamedInText(npc, text, roster)).map(npc => npc.name);
    assert.deepEqual(named('I ask Lady Mira to join me.'), ['Lady Mira']);
    assert.deepEqual(named('Lady, a word?'), []);
    assert.deepEqual(named('Linnea, come here.'), ['Linnea Vael'], 'a unique first name still counts');
    assert.deepEqual(named('Tomas, over here.'), [], 'an ambiguous first name selects nobody');
    assert.deepEqual(named('Tomas Hale waves.'), ['Tomas Hale']);
});

test('BUG-05: a scanned birthday correction needs support in the scanned text', () => {
    setActiveCalendarConfig({ era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }], currentYear: 821, currentMonth: 'Redleaf', currentDay: 16 });
    try {
        const npc = createNpcRecord('Mira');
        npc.id = 'npc_mira';
        npc.age = '20';
        npc.birthDate = { era: 'CR', year: 801, month: 'Redleaf', day: 1 };
        npc.birthDateSource = 'established';
        npc.birthDateYearSource = 'established';
        const state = { npcs: [npc], candidates: [], turn: 3 };
        const correction = { npcs: [{ id: 'npc_mira', name: 'Mira', birthDate: { era: 'CR', year: 790, month: 'Redleaf', day: 2 }, birthDateState: 'correct', birthDateReason: 'Invented.' }] };
        const rejected = mergeScanResult(state, correction, { sourceMessageId: 9, developmentContext: 'Mira silently checks the account book.' }).state.npcs[0];
        assert.equal(rejected.birthDate.year, 801);
        assert.equal(rejected.age, '20');
        const grounded = mergeScanResult(state, correction, { sourceMessageId: 9, developmentContext: 'Mira admits she was born on Redleaf 2 in CR790, not CR801.' }).state.npcs[0];
        assert.equal(grounded.birthDate.year, 790, 'a stated correction still applies');
    } finally {
        setActiveCalendarConfig(null);
    }
});

async function auditRuntimeChecks(mockState, eventSource, manualAddNpc, sleep, storageUrl) {
    const runtime = globalThis.NPCStateDelta;
    const { makeNpcStateDataFileName, encodeStateFilePayload } = await import(storageUrl);
    const warnings = [];
    const successes = [];
    const previousToastr = { ...globalThis.toastr };
    globalThis.toastr.warning = message => warnings.push(String(message));
    globalThis.toastr.success = message => successes.push(String(message));
    const baseFetch = globalThis.fetch;
    const open = async (id, lines) => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes }));
        eventSource.emit('chat_changed');
        await sleep(150);
    };
    const waitUntil = async (predicate, label) => {
        for (let i = 0; i < 400; i++) {
            if (predicate()) return;
            await sleep(5);
        }
        throw new Error(`audit runtime check did not settle: ${label}`);
    };

    // BUG-02: a newer dossier from another session must not be rolled back by this browser's stale chat.
    await open('audit-stale-host', ['Mira waits by the gate.', 'Mira watches the road.']);
    await manualAddNpc('Mira Stale');
    await runtime.flush();
    const pointer = runtime.dataFile();
    const remote = JSON.parse(mockState.files.get(pointer.path));
    remote.state.lineage = [...remote.state.lineage, 'remote-message-3', 'remote-message-4'];
    remote.state.npcs.push({ id: 'npc_kora_remote', name: 'Kora Remote', present: true, status: 'introduced on mobile' });
    remote.revision += 1;
    remote.writerId = 'remote-mobile-session';
    mockState.files.set(pointer.path, JSON.stringify(remote));
    await runtime.ensureFresh({ reason: 'audit-remote-advance' });
    const adoptedRevision = runtime.uiStatus().hydratedRevision;
    if (!runtime.getState().npcs.some(npc => npc.name === 'Kora Remote')) throw new Error('the newer remote dossier was not adopted');
    // An automatic reconciliation while this browser still holds the older chat (no host reload).
    await runtime.reconcile({ reason: 'audit-stale-reconcile' });
    await sleep(300);
    if (!runtime.getState().npcs.some(npc => npc.name === 'Kora Remote')) throw new Error('BUG-02: the stale chat rolled back the remote dossier');
    if (runtime.getState().lineage.length !== 4) throw new Error('BUG-02: stored lineage was truncated');
    if (runtime.uiStatus().hydratedRevision !== adoptedRevision) throw new Error('BUG-02: a rollback revision was written');
    if (runtime.uiStatus().branchReconciliations.at(-1)?.action !== 'deferred-stale-chat') throw new Error('BUG-02: the deferral was not recorded');

    // BUG-01: a same-revision overwrite by another session is always reported.
    warnings.length = 0;
    const fork = JSON.parse(mockState.files.get(pointer.path));
    fork.writerId = 'concurrent-other-session';
    fork.state.npcs.find(npc => npc.name === 'Mira Stale').mood = 'written concurrently elsewhere';
    mockState.files.set(pointer.path, JSON.stringify(fork));
    await runtime.ensureFresh({ reason: 'audit-background-fork' });
    if (!warnings.some(message => /replaced the same server revision/.test(message))) throw new Error('BUG-01: the overwritten save was not reported');
    if (runtime.persistenceStatus().recoverySnapshot !== true) throw new Error('BUG-01: the displaced copy is not recoverable');

    // BUG-07: the editor reports success only once the save is on the server.
    const mira = runtime.getState().npcs.find(npc => npc.name === 'Mira Stale');
    const previousGetElementById = document.getElementById;
    document.getElementById = id => (id === 'npc_state_delta_edit_birthday' ? { value: runtime.getNpc(mira.id)?.birthDateDisplay || '' } : null);
    globalThis.fetch = async (url, options = {}) => (url === '/api/files/upload'
        ? { ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' }
        : baseFetch(url, options));
    successes.length = 0;
    warnings.length = 0;
    await runtime.openEditor(mira.id);
    await sleep(30);
    const popup = mockState.popupCalls.at(-1);
    popup.result = 1;
    const accepted = await popup.options.onClosing(popup);
    globalThis.fetch = baseFetch;
    document.getElementById = previousGetElementById;
    if (accepted !== false) throw new Error('BUG-07: a failed save closed the editor');
    if (successes.some(message => /saved manual dossier edits/.test(message))) throw new Error('BUG-07: success was reported before the save');
    if (!warnings.some(message => /could not be saved to the server yet/.test(message))) throw new Error('BUG-07: the pending save was not explained');

    // BUG-06: repairing a participant the broad scan missed restores their presence.
    await open('audit-missed-participant', ['I sit down at the table.']);
    await manualAddNpc('Liora Vance');
    await runtime.flush();
    mockState.quietResponder = async (...args) => (JSON.stringify(args).includes('targeted dossier backfill extractor')
        ? JSON.stringify({ npcs: [{ name: 'Liora Vance', present: true, mood: 'focused', role: 'bookkeeper' }] })
        : '{"npcs":[]}');
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Narrator', mes: 'Liora Vance sits across from Kazuma and opens the ledger.', swipe_id: 0 });
    eventSource.emit('message_received', mockState.context.chat.length - 1);
    await waitUntil(() => mockState.rawCalls.some(args => JSON.stringify(args).includes('targeted dossier backfill extractor'))
        && (runtime.getState().pendingBackfills || []).length === 0, 'missed-participant backfill');
    await sleep(100);
    const liora = runtime.getState().npcs.find(npc => npc.name === 'Liora Vance');
    if (liora?.present !== true) throw new Error(`BUG-06: the repaired participant stayed absent (${liora?.present})`);
    mockState.quietResponder = null;

    // BUG-04: a sidecar that exists but cannot be read must not become an empty ready dossier.
    await open('audit-discovery-probe', ['A quiet morning.']);
    const probeKey = runtime.uiStatus().chatKey;
    const discoveryKey = probeKey.replace(/audit-discovery-probe$/, 'audit-discovery-failure');
    const discoveryPath = `/user/files/${makeNpcStateDataFileName(discoveryKey)}`;
    mockState.files.set(discoveryPath, encodeStateFilePayload(discoveryKey, { npcs: [{ id: 'npc-remote-keeper', name: 'Remote Keeper' }], turn: 4 }, '1.0.83', { revision: 8, writerId: 'other-session' }));
    globalThis.fetch = async (url, options = {}) => (url === discoveryPath
        ? { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({}) }
        : baseFetch(url, options));
    await open('audit-discovery-failure', ['A quiet morning.']);
    await waitUntil(() => runtime.uiStatus().hydrationStatus !== 'loading', 'discovery retries');
    globalThis.fetch = baseFetch;
    const status = runtime.uiStatus();
    if (status.chatKey !== discoveryKey) throw new Error('BUG-04: probe key format changed');
    if (status.hydrationStatus === 'ready' || !status.hydrationError) throw new Error(`BUG-04: unreadable sidecar became ready (${status.hydrationStatus})`);
    if (JSON.parse(mockState.files.get(discoveryPath)).revision !== 8) throw new Error('BUG-04: the existing sidecar was overwritten');

    Object.assign(globalThis.toastr, previousToastr);
}

test('BUG-01/02/04/06/07 run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    const storageUrl = new URL('../storage.js', import.meta.url).href;
    source = source.replace(marker, `    await (${auditRuntimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, ${JSON.stringify(storageUrl)});\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
    });
});
