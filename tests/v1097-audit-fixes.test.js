import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNpcRecord, mergeScanResult, normalizeNpcRecord, setActiveCalendarConfig } from '../core.js';
import { appearanceFingerprint, resolveNpcAppearance } from '../appearance.js';
import { mergeImportedDossierState } from '../bundle.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { quarantineUnreadableNpcStateDataFile } from '../storage.js';

const CALENDAR = { era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }] };
const dated = (npc, date, id) => normalizeNpcRecord(mergeScanResult({ npcs: [npc], candidates: [], turn: 3, socialGraph: { version: 1, edges: [], unresolved: [] } }, { npcs: [] },
    { sourceMessageId: id, developmentContext: `<World_State>Time | ${date} | evening</World_State> She reads.` }).state.npcs[0]);
const person = (name, age, apparentAge, year, extra = {}) => normalizeNpcRecord({ id: `npc_${name.toLowerCase()}`, name, age, apparentAge,
    birthDate: { era: 'CR', year, month: 'Redleaf', day: 16 }, birthDateSource: 'established', birthDateYearSource: 'established', ...extra });

test('A: a wrong or flashback date does not ratchet apparent age', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        let mira = person('Mira', '20', '~18', 801);
        mira = dated(mira, 'CR921, Sunwane 4', 6);
        assert.equal(mira.age, '120');
        mira = dated(mira, 'CR821, Sunwane 5', 7);
        assert.deepEqual([mira.age, mira.apparentAge], ['20', '~18'], 'correcting the year restores the offset exactly');

        let bea = person('Bea', '30', '~30', 791);
        bea = dated(bea, 'CR811, Sunwane 3', 8);
        assert.deepEqual([bea.age, bea.apparentAge], ['20', '~20'], 'a flashback follows the same offset back');
        bea = dated(bea, 'CR821, Sunwane 3', 9);
        assert.deepEqual([bea.age, bea.apparentAge], ['30', '~30'], 'returning to the present does not add the gap again');

        // A long-lived NPC seen far in the past keeps her apparent age and gets it back unchanged.
        let elf = person('Ilya', '300', '~25', 521);
        elf = dated(elf, 'CR621, Sunwane 3', 10);
        assert.equal(elf.apparentAge, '~25');
        elf = dated(elf, 'CR821, Sunwane 3', 11);
        assert.equal(elf.apparentAge, '~25');

        // Any other change of apparent age restarts the reference there.
        let tess = person('Tess', '20', '~18', 801);
        tess = dated(tess, 'CR822, Redleaf 17', 12);
        assert.equal(tess.apparentAge, '~19');
        tess = normalizeNpcRecord({ ...tess, apparentAge: '~25' });
        tess = dated(tess, 'CR823, Redleaf 17', 13);
        assert.equal(tess.apparentAge, '~26', 'a manual ~25 carries forward from 25, not from the old reference');
        // The exact-birthday and lock controls still hold.
        assert.equal(dated(person('Ana', '20', '~18', 801), 'CR822, Redleaf 16', 14).apparentAge, '~19');
        assert.equal(dated(person('Lia', '20', '~18', 801, { manualProfileFields: ['apparentAge'] }), 'CR822, Redleaf 17', 15).apparentAge, '~18');
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('E: an automatic birthday carry does not mark the portrait outdated, a real change does', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        const mira = person('Mira', '20', '~18', 801, { appearance: 'Short silver hair, green coat.' });
        const older = dated(mira, 'CR822, Redleaf 17', 6);
        assert.equal(older.apparentAge, '~19');
        assert.equal(appearanceFingerprint(older), appearanceFingerprint(mira));
        assert.notEqual(appearanceFingerprint({ ...older, apparentAge: '~30' }), appearanceFingerprint(mira));
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('B: importing an older copy keeps one family group with the named twin', () => {
    const slot = n => ({ id: `slot_x_child_${n}`, ownerId: 'npc_x', relation: 'daughter', groupId: 'group_x_child', sharedDescriptor: 'twins', provenance: 'explicit', confidence: 'explicit' });
    const current = {
        npcs: [normalizeNpcRecord({ id: 'npc_x', name: 'Brina' }), normalizeNpcRecord({ id: 'npc_c1', name: 'Astra' })],
        socialGraph: { edges: [{ id: 'e1', aId: 'npc_x', bId: 'npc_c1', aToB: 'mother', bToA: 'daughter', groupId: 'group_x_child', sharedDescriptor: 'twins', provenance: 'explicit', confidence: 'explicit' }], unresolved: [slot(2)] },
    };
    const merged = mergeImportedDossierState(current, { npcs: [normalizeNpcRecord({ id: 'npc_x', name: 'Brina' })], socialGraph: { edges: [], unresolved: [slot(1), slot(2)] } }, {});
    assert.deepEqual([...new Set(merged.socialGraph.unresolved.map(item => item.groupId))], ['group_x_child']);
});

function branchState(npcs) {
    const state = {
        npcs, candidates: [], pendingBackfills: [], socialGraph: { edges: [], unresolved: [] }, dismissed: [],
        turn: 0, assistantSinceScan: 0, lastScanAt: 0, lastScannedMessageId: null, scanCount: 0, checkpoints: [], inlineCards: [],
        lineage: [], branchLineageVersion: BRANCH_LINEAGE_VERSION, portraitAssets: {}, userDismissedGroups: [],
    };
    ensureRollbackJournalBaseline(state, []);
    return state;
}

test('C: deleting the message that named a relative restores the unnamed slot it used', () => {
    const run = keepLater => {
        const state = branchState([Object.assign(createNpcRecord('Brina'), { id: 'npc_brina' })]);
        const chat = [];
        const slot = n => ({ id: `slot_brina_child_${n}`, ownerId: 'npc_brina', relation: 'daughter', groupId: 'group_brina_child', provenance: 'explicit', confidence: 'explicit' });
        for (let i = 1; i <= 6; i += 1) {
            chat.push({ is_user: true, is_system: false, name: 'User', mes: `user-${i}` }, { is_user: false, is_system: false, name: 'Narrator', mes: `assistant-${i}` });
            const id = chat.length - 1;
            ensureBranchParentAnchor(state, chat, id, 'assistant-parent');
            state.turn += 1;
            if (i === 1) state.socialGraph.unresolved.push(slot(1), slot(2));
            if (i === 2) state.npcs.push(Object.assign(createNpcRecord('Astra'), { id: 'npc_astra' }));
            if (i === 3) {
                state.socialGraph.unresolved = state.socialGraph.unresolved.filter(item => item.id !== 'slot_brina_child_1');
                state.socialGraph.edges.push({ id: 'edge_brina_astra', aId: 'npc_brina', bId: 'npc_astra', aToB: 'mother', bToA: 'daughter', groupId: 'group_brina_child', provenance: 'explicit', confidence: 'explicit' });
            }
            if (i === 5 && keepLater) state.socialGraph.edges[0].aDynamic = 'teaches her to sail';
            recordBranchCheckpoint(state, chat, id, 'scan');
        }
        return reconcileBranchState(state, chat.filter((_, index) => index !== 5), { explicitDivergence: 5, operation: 'delete' }).state.socialGraph;
    };
    const undone = run(false);
    assert.equal(undone.edges.length, 0, 'the naming bond is undone');
    assert.deepEqual(undone.unresolved.map(item => item.id).sort(), ['slot_brina_child_1', 'slot_brina_child_2'], 'Brina has two daughters again');
    const kept = run(true);
    assert.equal(kept.edges.length, 1, 'a bond a retained message changed stays');
    assert.deepEqual(kept.unresolved.map(item => item.id), ['slot_brina_child_2'], 'its slot stays consumed');
});

test('D: a form\'s own trait replaces a shared one joined by "and", and size words count as height', () => {
    const resolve = (overallAppearance, appearance) => resolveNpcAppearance({ overallAppearance, appearanceForms: [{ name: 'F', appearance }], currentForm: 'F' });
    assert.equal(resolve('Long silver hair and violet eyes', 'Crimson eyes, black horns'), 'Long silver hair; Crimson eyes, black horns');
    assert.equal(resolve('Tall and slender, long silver hair', 'Short and stocky, with a thick beard'), 'long silver hair; Short and stocky, with a thick beard');
    assert.equal(resolve('Tall and slender, long silver hair', 'Short silver hair, curved horns'), 'Tall and slender; Short silver hair, curved horns', '"short hair" is not a height and the shared wording is kept');
    assert.equal(resolve('Silver hair and blue eyes.', 'Silver hair and blue eyes are not visible beneath an opaque black veil.'), 'Silver hair and blue eyes are not visible beneath an opaque black veil.');
});

test('G (storage): a Detach marker names its backup, and a later session finds it', async () => {
    const files = new Map([['/user/files/broken.json', '{"format": not json']]);
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            files.set(`/user/files/${body.name}`, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }), text: async () => '' };
        }
        return files.has(url) ? { ok: true, status: 200, text: async () => files.get(url) } : { ok: false, status: 404, text: async () => '' };
    };
    const pointer = { name: 'broken.json', path: '/user/files/broken.json' };
    const first = await quarantineUnreadableNpcStateDataFile({ chatKey: 'chat:a.png:x', pointer, fetchFn });
    assert.equal(JSON.parse(files.get(pointer.path)).recoveryPath, first.path);
    const other = await quarantineUnreadableNpcStateDataFile({ chatKey: 'chat:a.png:x', pointer, fetchFn });
    assert.equal(other.alreadyDetached, true);
    assert.equal(other.path, first.path, 'another session is told where the original bytes are');
    assert.equal(files.get(other.path), '{"format": not json');
});

async function runtimeChecks(mockState, eventSource, manualAddNpc, sleep, uiHandlers) {
    const runtime = globalThis.NPCStateDelta;
    const baseFetch = globalThis.fetch;
    const fail = message => { throw new Error(message); };
    const settings = mockState.extensionSettings.npc_state_delta;
    const open = async (id, lines) => {
        mockState.context.groupId = null;
        mockState.context.chatId = id;
        mockState.context.getCurrentChatId = () => mockState.context.chatId;
        mockState.context.chat = lines.map((mes, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Kazuma' : 'Narrator', mes }));
        eventSource.emit('chat_changed');
        await sleep(150);
    };
    const remoteAdvance = mutate => {
        const path = runtime.dataFile().path;
        const payload = JSON.parse(mockState.files.get(path));
        mutate(payload.state);
        payload.revision += 1;
        payload.writerId = 'remote-other-session';
        mockState.files.set(path, JSON.stringify(payload));
    };
    const emit = async (name, ...args) => { for (const listener of mockState.listeners.get(name) || []) await listener(...args); };

    // F: generations without MESSAGE_SENT revalidate; an ordinary send still makes one read.
    await open('v1097-fresh', ['Mira Voice hums.', 'Mira Voice keeps humming.']);
    await manualAddNpc('Mira Voice');
    await runtime.flush();
    const path = runtime.dataFile().path;
    let reads = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (url === path && (options.method || 'GET') === 'GET') reads += 1;
        return baseFetch(url, options);
    };
    for (const [type, speech] of [[undefined, 'Speaks in clipped sailor slang.'], ['normal', 'Speaks in courtly riddles.'], ['impersonate', 'Speaks in hushed whispers.']]) {
        remoteAdvance(state => { Object.assign(state.npcs.find(npc => npc.name === 'Mira Voice'), { speech, present: true }); });
        await emit('generation_after_commands', type, {}, false);
        if (runtime.getNpc(runtime.getState().npcs.find(npc => npc.name === 'Mira Voice').id)?.speech !== speech) fail(`F (${type}): the newer dossier was not adopted before generation`);
    }
    reads = 0;
    await emit('generation_after_commands', 'normal', {}, false);
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'A local turn.' });
    await emit('message_sent', mockState.context.chat.length - 1);
    if (reads !== 1) fail(`F: an ordinary send made ${reads} sidecar reads instead of one`);
    reads = 0;
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'A /send without generation.' });
    await emit('message_sent', mockState.context.chat.length - 1);
    if (reads !== 1) fail('F: a MESSAGE_SENT without a preceding generation skipped its own freshness read');
    globalThis.fetch = baseFetch;

    // G: Detach after another session already detached registers that session's backup.
    await open('v1097-detach', ['Vessa Broken waits.', 'Vessa Broken sighs.']);
    await manualAddNpc('Vessa Broken');
    await runtime.flush();
    const key = runtime.uiStatus().chatKey;
    const detachPath = runtime.dataFile().path;
    mockState.files.set(detachPath, '{"format": not json');
    for (let i = 0; i < 8; i += 1) await open(`v1097-away-${i}`, ['Elsewhere.', 'Still elsewhere.']);
    await open('v1097-detach', ['Vessa Broken waits.', 'Vessa Broken sighs.']);
    await runtime.ensureFresh().catch(() => null);
    if (runtime.uiStatus().hydrationStatus !== 'error') fail('G: the corrupt sidecar did not block hydration');
    // Another session detaches first: its backup and the marker naming it.
    const backup = '/user/files/other-session-unreadable.json';
    mockState.files.set(backup, '{"format": not json');
    mockState.files.set(detachPath, JSON.stringify({ format: 'npc_state_delta_chat_data', formatVersion: 1, chatKey: key, revision: 1, writerId: 'other',
        retired: true, retiredAt: new Date().toISOString(), retireReason: 'manual-detach', recoveryPath: backup, recoveryName: 'other-session-unreadable.json', state: {} }));
    const previousConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    await uiHandlers.get('click.npcStateDelta|.npc-state-delta-detach-sidecar')();
    await sleep(100);
    globalThis.confirm = previousConfirm;
    if (settings.recoveryFiles?.[key]?.path !== backup) fail(`G: the other session's backup was not registered (${settings.recoveryFiles?.[key]?.path})`);
    if (runtime.uiStatus().hydrationStatus !== 'ready') fail('G: Detach did not start a fresh dossier');

    setTimeout(() => process.exit(0), 1500);
}

test('F/G run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const events = "        CHAT_RENAMED: 'chat_renamed',\n";
    if (!source.includes(events)) throw new Error('Runtime smoke event table changed');
    source = source.replace(events, `${events}        GENERATION_AFTER_COMMANDS: 'generation_after_commands',\n`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${runtimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, uiHandlers);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
    });
});
