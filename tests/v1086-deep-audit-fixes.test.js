import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNpcRecord, mergeScanResult, npcNamedInText, normalizeNpcRecord, setActiveCalendarConfig } from '../core.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { narrativeLineage } from '../destructive-settlement-core.js';
import { applyManualKeyRelationshipEdit, reconcileSocialState } from '../social.js';
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

test('RB84-03: hiding a message is not a narrative change, and a stale event index cannot move recovery earlier', () => {
    const chat = [{ is_user: true, is_system: false, mes: 'a' }, { is_user: false, is_system: false, mes: 'b' }];
    const hidden = chat.map((message, i) => ({ ...message, is_system: i === 0 }));
    assert.deepEqual(narrativeLineage(hidden), narrativeLineage(chat));

    const mira = createNpcRecord('Mira');
    mira.mood = 'calm';
    mira.goal = 'wait';
    const state = branchState([mira]);
    const history = [];
    play(state, history, 5, (s, n) => {
        if (n === 3) s.npcs[0].mood = 'angry';   // retained message 5
        if (n === 4) s.npcs[0].goal = 'leave';   // retained message 7
    });
    const result = reconcileBranchState(state, history.slice(0, 9), { explicitDivergence: 2, operation: 'delete' });
    const after = result.state.npcs[0];
    assert.equal(after.mood, 'angry');
    assert.equal(after.goal, 'leave');
});

test('RB84-06: a birthday correction needs one sentence about the NPC that supports every date part', () => {
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
            'Mira keeps the books. Noela was born long ago.',
            'Mira keeps the books on Redleaf 2.',
            'Mira says she was born on Redleaf 2 in an unknown year.',
            'Mira was born on Redleaf 2 in CR801, not CR790.',
            'Admiral Noela was born on Redleaf 2 in CR790.',
        ]) {
            const npc = scan(text);
            assert.equal(npc.birthDate.year, 801, text);
            assert.equal(npc.age, '20', text);
        }
        assert.equal(scan('Mira was born on Redleaf 2 in CR790.').birthDate.year, 790);
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB84-07: another NPC\'s birthday does not age a yearless dossier', () => {
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
        assert.equal(run('Noela celebrates her birthday.').age, '20');
        assert.equal(run('Mira celebrates her birthday.').age, '21', 'her own birthday still rolls over');
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB84-09: a shared alias selects nobody; a full name selects only its NPC', () => {
    const make = (name, aliases = []) => Object.assign(createNpcRecord(name), { aliases });
    const roster = [make('Tomas Reed', ['Tomas']), make('Tomas Hale', ['Tomas']), make('Mira'), make('Lady Mira'), make('Wren Vale', ['Wren'])];
    const named = text => roster.filter(npc => npcNamedInText(npc, text, roster)).map(npc => npc.name);
    assert.deepEqual(named('I ask Tomas Hale to join me.'), ['Tomas Hale']);
    assert.deepEqual(named('Tomas, come here.'), []);
    assert.deepEqual(named('I ask Lady Mira to sit.'), ['Lady Mira']);
    assert.deepEqual(named('Wren, help me.'), ['Wren Vale'], 'a unique alias still counts');
});

test('RB84-10: a manually removed inferred sibling bond is not recreated from the same parents', () => {
    const npc = (name, gender, bonds) => normalizeNpcRecord({ id: `npc_${name.toLowerCase()}`, name, gender, species: 'human', keyRelationships: bonds });
    let state = reconcileSocialState({ npcs: [npc('Mira', 'female', ['Orson — father']), npc('Noela', 'female', ['Orson — father']), npc('Orson', 'male', [])], socialGraph: { edges: [], unresolved: [] } }, {}).state;
    const before = [...state.npcs[0].keyRelationships];
    assert.ok(before.some(entry => /^Noela — sibling/.test(entry)));
    state.npcs[0].keyRelationships = ['Orson — father'];
    applyManualKeyRelationshipEdit(state, 'npc_mira', before, state.npcs[0].keyRelationships, {});
    for (let i = 0; i < 3; i += 1) state = reconcileSocialState(state, { provenance: 'manual', confidence: 'manual' }).state;
    assert.deepEqual(state.npcs[0].keyRelationships, ['Orson — father']);
    assert.ok(!state.npcs[1].keyRelationships.some(entry => /^Mira/.test(entry)));
    // New parent evidence (a second shared parent) is genuinely new and may infer the pair again.
    state.npcs[0].keyRelationships.push('Ilse — mother');
    state.npcs[1].keyRelationships.push('Ilse — mother');
    state.npcs.push(npc('Ilse', 'female', []));
    state = reconcileSocialState(state, {}).state;
    assert.ok(state.npcs[0].keyRelationships.some(entry => /^Noela — sibling/.test(entry)));
});

test('RB84-11: later references match whole names and aliases, not substrings', () => {
    const run = (stranger, laterMemory) => {
        const mira = createNpcRecord('Mira');
        const state = branchState([mira]);
        const history = [];
        play(state, history, 6, (s, n) => {
            if (n === 3) {
                const npc = createNpcRecord(stranger.name);
                npc.aliases = stranger.aliases || [];
                npc.lifeState = 'deceased';
                npc.lifeStateCertainty = 'explicit';
                s.npcs.push(npc);
            }
            if (n === 5 && laterMemory) s.npcs[0].memories = [laterMemory];
        });
        return reconcileBranchState(state, history.filter((_, i) => i !== 5), { explicitDivergence: 5, operation: 'delete' }).state.npcs.map(npc => npc.name);
    };
    assert.ok(run({ name: 'Fallen Stranger', aliases: ['Wayfarer'] }, 'Mira buried the Wayfarer by the road.').includes('Fallen Stranger'));
    assert.ok(!run({ name: 'Dan' }, 'Mira crossed a dangerous road alone.').includes('Dan'));
});

test('RB84-01 (storage): a retirement whose verification fails after upload is marked uncertain', async () => {
    let uploaded = false;
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') { uploaded = true; return { ok: true, status: 200, json: async () => ({ path: '/user/files/x.json' }), text: async () => '' }; }
        if (uploaded) return { ok: false, status: 403, text: async () => 'forbidden' };
        return { ok: false, status: 404, text: async () => '' };
    };
    await assert.rejects(
        retireNpcStateDataFile({ chatKey: 'chat:a.png:x', pointer: { name: 'x.json', path: '/user/files/x.json', revision: 0 }, fetchFn }),
        error => error.retirementUncertain === true,
    );
});

async function deepAuditRuntimeChecks(mockState, eventSource, manualAddNpc, sleep, urls) {
    const runtime = globalThis.NPCStateDelta;
    const warnings = [];
    const successes = [];
    const previousToastr = { ...globalThis.toastr };
    globalThis.toastr.warning = message => warnings.push(String(message));
    globalThis.toastr.success = message => successes.push(String(message));
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
        return payload;
    };

    // RB84-02: the stale-chat mark survives a local metadata save and blocks scans.
    await open('deep-stale-host', ['Mira waits by the gate.', 'Mira watches the road.']);
    await manualAddNpc('Mira Deep');
    await runtime.flush();
    remoteAdvance(state => {
        state.lineage = [...state.lineage, 'remote-message-3', 'remote-message-4'];
        state.npcs.push({ id: 'npc_kora_deep', name: 'Kora Deep', present: true });
        state.npcs.find(npc => npc.name === 'Mira Deep').mood = 'delighted';
    });
    await runtime.ensureFresh({ reason: 'deep-remote-advance' });
    const miraId = runtime.getState().npcs.find(npc => npc.name === 'Mira Deep').id;
    await runtime.setPortraitSeed(miraId, 4242, { chatKey: runtime.uiStatus().chatKey });
    await runtime.flush();
    await runtime.reconcile({ reason: 'deep-stale-reconcile' });
    await sleep(300);
    if (!runtime.getState().npcs.some(npc => npc.name === 'Kora Deep')) fail('RB84-02: a local save let the stale chat roll back');
    if (runtime.getState().lineage.length !== 4) fail('RB84-02: lineage truncated after local save');
    const rawBefore = mockState.rawCalls.length;
    if (await runtime.scan() !== false) fail('RB84-02: a scan ran against the stale chat');
    if (mockState.rawCalls.length !== rawBefore) fail('RB84-02: the stale scan dispatched a request');
    if (runtime.getNpc(miraId).mood !== 'delighted') fail('RB84-02: the stale scan changed the dossier');

    // RB84-04: an appearance draft from an editor opened before a remote change is rejected.
    await open('deep-appearance', ['Sela arrives.', 'Sela waits in the hall.']);
    await manualAddNpc('Sela Deep');
    await runtime.flush();
    const sela = runtime.getState().npcs.find(npc => npc.name === 'Sela Deep');
    const key = runtime.uiStatus().chatKey;
    await runtime.updateAppearance(sela.id, { overallAppearance: 'long silver hair, violet eyes', currentAppearance: 'black cloak' }, { chatKey: key });
    await runtime.flush();
    const previousGetElementById = document.getElementById;
    document.getElementById = id => (id === 'npc_state_delta_edit_birthday' ? { value: '' } : null);
    await runtime.openEditor(sela.id);
    await sleep(30);
    remoteAdvance(state => {
        const target = state.npcs.find(npc => npc.id === sela.id);
        target.overallAppearance = 'short red hair, green eyes';
        target.appearance = 'blue gown';
    });
    await runtime.ensureFresh({ reason: 'deep-remote-appearance' });
    const appliedStale = await runtime.updateAppearance(sela.id, { overallAppearance: 'long silver hair, violet eyes, silver earring', currentAppearance: 'black cloak' }, { chatKey: key });
    document.getElementById = previousGetElementById;
    if (appliedStale !== false) fail('RB84-04: a stale appearance draft was applied');
    if (!/red hair/.test(runtime.getNpc(sela.id).overallAppearance || '')) fail('RB84-04: the newer remote appearance was overwritten');

    // RB84-12: Archive does not announce success before the server has it.
    successes.length = 0;
    warnings.length = 0;
    globalThis.fetch = async (url, options = {}) => (url === '/api/files/upload'
        ? { ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' }
        : baseFetch(url, options));
    await runtime.archive(sela.id);
    await waitUntil(() => warnings.some(message => /could not be saved to the server yet/.test(message)), 'archive pending warning');
    globalThis.fetch = baseFetch;
    if (successes.some(message => /archived Sela Deep/.test(message))) fail('RB84-12: archive reported success before the save');

    // RB84-08: an explicitly absent NPC is not repaired into presence from older history.
    await open('deep-absent', ['I enter the records office.', 'Tavi Deep sorts files at the counter.']);
    await manualAddNpc('Tavi Deep');
    await runtime.flush();
    mockState.quietResponder = async (...args) => (JSON.stringify(args).includes('targeted dossier backfill extractor')
        ? JSON.stringify({ npcs: [{ name: 'Tavi Deep', present: true, location: 'records office' }] })
        : '{"npcs":[]}');
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Where is Tavi Deep?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Narrator', mes: 'Tavi Deep remains at her distant home and is not here. The room is empty.', swipe_id: 0 });
    const rawBeforeAbsent = mockState.rawCalls.length;
    eventSource.emit('message_received', mockState.context.chat.length - 1);
    await waitUntil(() => mockState.rawCalls.length > rawBeforeAbsent && (runtime.getState().pendingBackfills || []).length === 0, 'absent repair');
    await sleep(150);
    if (runtime.getState().npcs.find(npc => npc.name === 'Tavi Deep')?.present === true) fail('RB84-08: an absent NPC was repaired into presence');
    mockState.quietResponder = null;

    // RB84-05: a freshness read that started before the chat was deleted cannot resurrect it.
    await open('deep-deleted-chat', ['Oda Deep sweeps.', 'Oda Deep leans on the broom.']);
    await manualAddNpc('Oda Deep');
    await runtime.flush();
    const deletedKey = runtime.uiStatus().chatKey;
    let releaseRead;
    let markEntered;
    const entered = new Promise(resolve => { markEntered = resolve; });
    mockState.readBarrier = { entered: markEntered, promise: new Promise(resolve => { releaseRead = resolve; }) };
    remoteAdvance(state => { state.npcs[0].status = 'remote before delete'; });
    const lateFresh = runtime.ensureFresh({ reason: 'deep-late-read' }).catch(() => false);
    await entered;
    eventSource.emit('chat_deleted', 'deep-deleted-chat');
    await sleep(400);
    releaseRead();
    await lateFresh;
    await sleep(100);
    const settings = mockState.extensionSettings.npc_state_delta;
    if (!settings.sidecarTombstones?.[deletedKey]) fail('RB84-05: the deletion tombstone was cleared by a late read');
    if (settings.dataFiles?.[deletedKey]?.path) fail('RB84-05: the deleted chat pointer was restored');

    // RB84-01: an uncertain rename retirement keeps the dossier recoverable.
    await open('deep-rename', ['Pell Deep counts coins.', 'Pell Deep smiles.']);
    await manualAddNpc('Pell Deep');
    await runtime.flush();
    const oldKey = runtime.uiStatus().chatKey;
    const oldOwner = oldKey.split(':')[1];
    const oldPath = runtime.dataFile().path;
    mockState.context.eventTypes.CHARACTER_RENAMED = 'character_renamed';
    const { prepareNpcStateHardening } = await import(urls.hardening);
    await prepareNpcStateHardening();
    let retiredUploaded = false;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body || '{}');
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            const response = await baseFetch(url, options);
            if (`/user/files/${body.name}` === oldPath && /"retired":\s*true/.test(text)) retiredUploaded = true;
            return response;
        }
        if (url === oldPath && retiredUploaded) return { ok: false, status: 403, text: async () => 'forbidden' };
        return baseFetch(url, options);
    };
    for (const listener of mockState.listeners.get('character_renamed') || []) {
        try { await listener(oldOwner, `renamed-${oldOwner}`); } catch { /* the partial rename reports failure */ }
    }
    globalThis.fetch = baseFetch;
    if (!retiredUploaded) fail('RB84-01: the scenario did not reach source retirement');
    const survivors = [...mockState.files.entries()].filter(([path, text]) => path !== oldPath && /Pell Deep/.test(text));
    if (!survivors.length) fail('RB84-01: every durable copy of the dossier was deleted');
    if (!settings.recoveryFiles?.[oldKey]?.path) fail('RB84-01: the recovery copy was not registered');

    Object.assign(globalThis.toastr, previousToastr);
    // The deliberately failed rename keeps its production background retry scheduled; end the
    // harness process once the smoke run has finished instead of waiting on that retry loop.
    setTimeout(() => process.exit(0), 1500);
}

test('RB84-01/02/04/05/08/12 run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${deepAuditRuntimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, { hardening: pathToFileURL(path.join(extRoot, 'hardening.js')).href });\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
    });
});
