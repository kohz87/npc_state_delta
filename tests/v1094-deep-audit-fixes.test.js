import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    calendarDayNumber,
    createNpcRecord,
    mergeScanResult,
    normalizeNpcRecord,
    setActiveCalendarConfig,
} from '../core.js';
import * as calendar from '../calendar.js';
import {
    BRANCH_LINEAGE_VERSION,
    ensureBranchParentAnchor,
    ensureRollbackJournalBaseline,
    recordBranchCheckpoint,
    reconcileBranchState,
} from '../branch.js';
import { mergeImportedDossierState } from '../bundle.js';
import { normalizeSocialGraph } from '../social.js';
import { appearanceFingerprint } from '../appearance.js';
import { quarantineUnreadableNpcStateDataFile } from '../storage.js';

const CALENDAR = { era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }] };

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

const memoryFiles = () => {
    const files = new Map();
    const uploads = [];
    const fetchFn = async (url, options = {}) => {
        if (url === '/api/files/upload') {
            const body = JSON.parse(options.body);
            const filePath = `/user/files/${body.name}`;
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            uploads.push({ path: filePath, text });
            if (fetchFn.beforeUpload) await fetchFn.beforeUpload(filePath, text);
            files.set(filePath, text);
            if (fetchFn.afterUpload) await fetchFn.afterUpload(filePath, text);
            return { ok: true, status: 200, json: async () => ({ path: filePath }), text: async () => '' };
        }
        return files.has(url) ? { ok: true, status: 200, text: async () => files.get(url) } : { ok: false, status: 404, text: async () => '' };
    };
    return { files, uploads, fetchFn };
};

test('RB93-06 (storage): the verified Detach backup is registered before the canonical file is replaced, and a retry keeps it', async () => {
    const { files, uploads, fetchFn } = memoryFiles();
    const pointer = { name: 'broken.json', path: '/user/files/broken.json' };
    files.set(pointer.path, '{"format": not json');
    let registered = null;
    fetchFn.afterUpload = async filePath => {
        if (filePath === pointer.path) throw new TypeError('acknowledgement lost after the write');
    };
    await assert.rejects(quarantineUnreadableNpcStateDataFile({
        chatKey: 'chat:a.png:x', pointer, fetchFn,
        onPreserved: copy => {
            assert.equal(files.get(pointer.path), '{"format": not json', 'registered while the original is still canonical');
            registered = copy;
        },
    }));
    assert.ok(registered?.path, 'the backup was registered before the lost acknowledgement');
    assert.equal(files.get(registered.path), '{"format": not json');
    assert.match(files.get(pointer.path), /"retired":\s*true/);
    fetchFn.afterUpload = null;
    const uploadsBeforeRetry = uploads.length;
    const retry = await quarantineUnreadableNpcStateDataFile({ chatKey: 'chat:a.png:x', pointer, fetchFn, onPreserved: () => assert.fail('no second backup') });
    assert.equal(retry?.alreadyDetached, true, 'the retry recognises its own committed marker');
    assert.equal(uploads.length, uploadsBeforeRetry, 'the empty marker is not backed up as the old sidecar');
    // An unrelated retired marker (another reason) is still preserved like any unreadable file.
    files.set('/user/files/other.json', '{"format": not json either');
    const normal = await quarantineUnreadableNpcStateDataFile({ chatKey: 'chat:a.png:y', pointer: { name: 'other.json', path: '/user/files/other.json' }, fetchFn });
    assert.equal(files.get(normal.path), '{"format": not json either');
});

test('RB93-07: deleting a middle message removes the unresolved slots it alone added', () => {
    const brina = Object.assign(createNpcRecord('Brina'), { id: 'npc_brina', mood: 'calm' });
    const run = changeLater => {
        const state = branchState([structuredClone(brina)]);
        const history = [];
        play(state, history, 6, (s, n) => {
            if (n === 3) {
                s.npcs[0].mood = 'proud';
                s.socialGraph.unresolved.push(
                    { id: 'slot_brina_child_1', ownerId: 'npc_brina', relation: 'daughter', groupId: 'group_brina_child', sharedDescriptor: 'twins', provenance: 'explicit', confidence: 'explicit' },
                    { id: 'slot_brina_child_2', ownerId: 'npc_brina', relation: 'daughter', groupId: 'group_brina_child', sharedDescriptor: 'twins', provenance: 'explicit', confidence: 'explicit' },
                );
            }
            if (n === 5 && changeLater) s.socialGraph.unresolved[0].descriptor = 'elder';
        });
        return deleteMiddle(state, history, 5).state;
    };
    const after = run(false);
    assert.equal(after.npcs[0].mood, 'calm');
    assert.deepEqual(after.socialGraph.unresolved, [], 'the deleted twin-daughter slots are gone');
    const kept = run(true);
    assert.deepEqual(kept.socialGraph.unresolved.map(slot => slot.id), ['slot_brina_child_1'], 'a slot a retained message changed is preserved');
});

test('RB93-08: a later hidden graph edge keeps an NPC whose introduction was deleted', () => {
    const keeper = Object.assign(createNpcRecord('Keeper'), { id: 'npc_keeper' });
    const run = edgeLater => {
        const state = branchState([structuredClone(keeper)]);
        const history = [];
        play(state, history, 6, (s, n) => {
            if (n === 3) s.npcs.push(Object.assign(createNpcRecord('Gone Courier'), { id: 'npc_courier' }));
            if (n === 5 && edgeLater) s.socialGraph.edges.push({ id: 'edge_keeper_courier', aId: 'npc_keeper', bId: 'npc_courier', aToB: 'friend', bToA: 'friend', provenance: 'explicit', confidence: 'explicit' });
        });
        return deleteMiddle(state, history, 5).state;
    };
    const used = run(true);
    assert.ok(used.npcs.some(npc => npc.id === 'npc_courier'), 'the later friendship is independent use');
    assert.ok(used.socialGraph.edges.some(edge => edge.id === 'edge_keeper_courier'), 'the retained-message edge survives');
    assert.ok(!run(false).npcs.some(npc => npc.id === 'npc_courier'), 'with no later use the introduction still goes with its message');
});

test('RB93-09: a skipped duplicate-identity import donates no social state', () => {
    const current = { npcs: [normalizeNpcRecord({ id: 'npc_alia', name: 'Alia', aliases: ['The Captain'] })], socialGraph: { edges: [], unresolved: [] } };
    const incoming = {
        npcs: [
            normalizeNpcRecord({ id: 'src_alia', name: 'Alia', aliases: ['The Captain'] }),
            normalizeNpcRecord({ id: 'src_brina', name: 'Brina', aliases: ['The Captain'] }),
            normalizeNpcRecord({ id: 'src_keeper', name: 'Keeper' }),
        ],
        socialGraph: {
            edges: [{ id: 'brina_hidden', aId: 'src_brina', bId: 'src_keeper', aToB: 'friend', bToA: 'friend', aDynamic: 'entrusts her private sea-chart', provenance: 'explicit', confidence: 'explicit' }],
            unresolved: [{ id: 'brina_unresolved', ownerId: 'src_brina', relation: 'daughter', provenance: 'explicit', confidence: 'explicit' }],
        },
    };
    const report = {};
    const merged = mergeImportedDossierState(current, incoming, { report });
    assert.ok(report.skipped.some(item => item.sourceId === 'src_brina' && item.reason === 'duplicate-identity'));
    assert.ok(!JSON.stringify(merged.socialGraph).includes('sea-chart'), 'Brina\'s friendship is not grafted onto Alia');
    assert.ok(!merged.socialGraph.unresolved.some(slot => slot.ownerId === 'npc_alia'), 'Brina\'s unnamed daughter is not Alia\'s');
    // Control: without the shared alias Brina is admitted and keeps her own state.
    incoming.npcs[1].aliases = [];
    const admitted = mergeImportedDossierState(current, incoming, {});
    const brinaId = admitted.npcs.find(npc => npc.name === 'Brina').id;
    assert.ok(admitted.socialGraph.unresolved.some(slot => slot.ownerId === brinaId));
});

test('RB93-10: a reversed duplicate merges before the 240-edge capacity applies', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `node${i}`);
    const pairs = [];
    for (let i = 0; i < ids.length && pairs.length < 240; i += 1) {
        for (let j = i + 1; j < ids.length && pairs.length < 240; j += 1) pairs.push([ids[i], ids[j]]);
    }
    const edge = ([a, b], extra = {}) => ({ aId: a, bId: b, aToB: 'friend', bToA: 'friend', provenance: 'manual', confidence: 'manual', ...extra });
    const last = pairs.at(-1);
    const graph = normalizeSocialGraph({ edges: [
        { aId: pairs[0][1], bId: pairs[0][0], aToB: 'student', bToA: 'mentor', provenance: 'manual', confidence: 'manual' },
        edge(pairs[0], { aToB: 'mentor', bToA: 'student' }),
        ...pairs.slice(1).map(pair => edge(pair)),
    ], unresolved: [] });
    const key = item => [item.aId, item.bId].sort().join('|');
    assert.equal(new Set(graph.edges.map(key)).size, graph.edges.length, 'no pair is stored twice');
    assert.equal(graph.edges.length, 240);
    assert.ok(graph.edges.some(item => key(item) === [...last].sort().join('|')), 'the last unique hidden pair is kept');
    const mentor = graph.edges.find(item => key(item) === [...pairs[0]].sort().join('|'));
    const mentorOf = mentor.aId === pairs[0][0] ? mentor.aToB : mentor.bToA;
    assert.equal(mentorOf, 'mentor', 'directional relations stay with their endpoints');
});

test('RB93-11: swapped import ids keep both owners\' unresolved relatives', () => {
    const slots = owner => [1, 2].map(n => ({ id: `slot_group_npc-noela-child-${n}`, ownerId: owner, relation: 'daughter', groupId: 'group_npc-noela-child', descriptor: n === 1 ? 'older' : 'younger', provenance: 'explicit', confidence: 'explicit' }));
    const current = {
        npcs: [normalizeNpcRecord({ id: 'npc_mira', name: 'Mira' }), normalizeNpcRecord({ id: 'npc_noela', name: 'Noela' })],
        socialGraph: { edges: [], unresolved: slots('npc_noela') },
    };
    const incoming = {
        npcs: [normalizeNpcRecord({ id: 'npc_noela', name: 'Mira' }), normalizeNpcRecord({ id: 'npc_mira', name: 'Noela' })],
        socialGraph: { edges: [], unresolved: slots('npc_noela') },
    };
    const merged = mergeImportedDossierState(current, incoming, {});
    const owned = id => merged.socialGraph.unresolved.filter(slot => slot.ownerId === id);
    assert.equal(owned('npc_mira').length, 2, 'Mira keeps her two daughters');
    assert.equal(owned('npc_noela').length, 2, 'Noela keeps hers');
    assert.deepEqual(owned('npc_mira').map(slot => slot.descriptor).sort(), ['older', 'younger']);
    assert.notEqual(owned('npc_mira')[0].groupId, owned('npc_noela')[0].groupId, 'the two families are different groups');
    // Same ids with the same owner are still one slot.
    const same = mergeImportedDossierState(current, { npcs: [normalizeNpcRecord({ id: 'npc_noela', name: 'Noela' })], socialGraph: { edges: [], unresolved: slots('npc_noela') } }, {});
    assert.equal(same.socialGraph.unresolved.length, 2);
});

test('RB93-12: numeric fallback dates count consecutive days, and legacy stored days are converted', () => {
    const day = value => calendarDayNumber(value, null);
    assert.equal(day('2026-01-01') - day('2025-12-31'), 1);
    assert.equal(day('2025-03-01') - day('2025-02-28'), 1);
    assert.equal(day('2024-03-01') - day('2024-02-28'), 2);
    assert.equal(day('2026-01-01') - day('2025-12-25'), 7);
    // A ledger or change-day written before the fix used year*365 plus a 366-day ordinal.
    const legacy = (year, ordinal) => year * 365 + ordinal;
    assert.equal(calendar.migrateLegacyStoryDay(legacy(2025, 359), null), day('2025-12-25'));
    assert.equal(calendar.migrateLegacyStoryDay(legacy(2025, 60), null), day('2025-03-01'));
    const npc = normalizeNpcRecord({
        name: 'Elena', personality: 'Timid.',
        fieldChangeDays: { personality: legacy(2025, 359) },
        personalityDevelopment: { version: 2, baselinePersonality: 'Timid.', concepts: [{ concept: 'candid', observationCount: 1, sourceMessageIds: [60], days: [legacy(2025, 359)], latestEvidence: 'candid: objects openly' }] },
    });
    assert.equal(npc.fieldChangeDays.personality, day('2025-12-25'));
    assert.equal(npc.personalityDevelopment.concepts[0].days[0], day('2025-12-25'));
    assert.deepEqual(normalizeNpcRecord(npc).personalityDevelopment.concepts[0].days, npc.personalityDevelopment.concepts[0].days, 'conversion is idempotent');
    assert.equal(normalizeNpcRecord(npc).fieldChangeDays.personality, npc.fieldChangeDays.personality);
    // A configured calendar's numbering never changed.
    setActiveCalendarConfig(CALENDAR);
    try {
        assert.equal(normalizeNpcRecord({ name: 'Elena', fieldChangeDays: { personality: 12345 } }).fieldChangeDays.personality, 12345);
    } finally {
        setActiveCalendarConfig(null);
    }
});

const BEFORE = 'Timid and deferential; endures mistreatment silently.';
const CANDIDATE = 'Candid and self-assured; bargains openly and objects to unfair treatment.';
const SPEECH = 'Speaks softly in short sentences.';
const dated = date => `<details><summary>World State</summary>Time | ${date} | dusk\nLocation | The Grey Post</details>\nElena counts the coin.`;

function elenaScan(state, evidence, { turn, message, date, speechRow }) {
    const npc = state.npcs[0];
    const ordinary = { id: npc.id, name: 'Elena', evidence: { personality: [evidence] }, personalityState: 'refine', personality: CANDIDATE, developmentScale: 'gradual' };
    const result = speechRow
        ? { npcs: [ordinary], profileUpdates: [{ id: npc.id, name: 'Elena', speech: SPEECH, speechState: 'keep' }] }
        : { npcs: [ordinary] };
    return mergeScanResult(state, result, { turn, sourceMessageId: message, calendarSource: dated(date) }).state;
}

test('RB93-12/13: a true seven-day numeric trend promotes, and an unrelated Speech row does not hide it', () => {
    for (const speechRow of [false, true]) {
        let state = { npcs: [Object.assign(createNpcRecord('Elena'), { personality: BEFORE, speech: SPEECH })], candidates: [], turn: 10 };
        state = elenaScan(state, 'candid: openly objects that the rent is unfair and bargains self-assured', { turn: 11, message: 60, date: '2025-12-25', speechRow });
        state = elenaScan(state, 'candid: openly objects the factor price is unfair and bargains self-assured', { turn: 12, message: 62, date: '2026-01-01', speechRow });
        assert.equal(state.npcs[0].personality, CANDIDATE, `seven story days apart promotes (speech row: ${speechRow})`);
        assert.equal(state.npcs[0].speech, SPEECH);
    }
});

test('RB93-14: a scan after a skipped birthday carries the proven delta into apparent age', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        const roll = (date, extra = {}) => {
            const npc = normalizeNpcRecord({ id: 'npc_mira', name: 'Mira', age: '20', apparentAge: '~18', birthDate: { era: 'CR', year: 801, month: 'Redleaf', day: 16 }, birthDateSource: 'established', birthDateYearSource: 'established', ...extra });
            return mergeScanResult({ npcs: [npc], candidates: [], turn: 3, socialGraph: { version: 1, edges: [], unresolved: [] } }, { npcs: [] },
                { sourceMessageId: 9, developmentContext: `<World_State>Time | ${date} | evening</World_State> Mira reads.` }).state.npcs[0];
        };
        const later = roll('CR822, Redleaf 17');
        assert.equal(later.age, '21');
        assert.equal(later.apparentAge, '~19', 'the two-year offset is kept');
        const again = normalizeNpcRecord(later);
        assert.equal(mergeScanResult({ npcs: [again], candidates: [], turn: 4, socialGraph: { version: 1, edges: [], unresolved: [] } }, { npcs: [] },
            { sourceMessageId: 11, developmentContext: '<World_State>Time | CR822, Redleaf 18 | evening</World_State> Mira reads.' }).state.npcs[0].apparentAge, '~19', 'repeating does not add again');
        const exact = roll('CR822, Redleaf 16');
        assert.equal(exact.age, '21');
        assert.equal(exact.apparentAge, '~19');
        assert.equal(roll('CR822, Redleaf 17', { manualProfileFields: ['apparentAge'] }).apparentAge, '~18', 'a locked apparent age holds');
        assert.equal(roll('CR821, Redleaf 17').apparentAge, '~18', 'no birthday passed, nothing carries');
    } finally {
        setActiveCalendarConfig(null);
    }
});

test('RB93-15: apparent age owns portrait generation and the stale-portrait marker', () => {
    const portrait = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    const base = portrait.slice(portrait.indexOf('function portraitGenerationBase'), portrait.indexOf('async function generatePortrait'));
    assert.match(base, /npc\.apparentAge/);
    const npc = normalizeNpcRecord({ name: 'Mira', appearance: 'Short silver hair, green coat.', apparentAge: '~6' });
    const older = { ...npc, apparentAge: '~20' };
    assert.notEqual(appearanceFingerprint(npc), appearanceFingerprint(older), 'a changed apparent age is a changed presentation');
    assert.match(appearanceFingerprint(npc), /^a2:/);
    assert.equal(appearanceFingerprint(npc, { version: 1 }), appearanceFingerprint(older, { version: 1 }), 'portraits recorded before keep their identity');
    const ui = fs.readFileSync(new URL('../dossier-ui.js', import.meta.url), 'utf8');
    assert.match(ui, /appearanceFingerprint\(npc, \{ version: recorded\.startsWith\('a1:'\) \? 1 : 2 \}\)/);
});

test('RB93-13: with a configured calendar too, an unchanged Speech profile row leaves Personality development intact', () => {
    setActiveCalendarConfig(CALENDAR);
    try {
        const outcome = speechRow => {
            let state = { npcs: [Object.assign(createNpcRecord('Elena'), { personality: BEFORE, speech: SPEECH })], candidates: [], turn: 10 };
            state = elenaScan(state, 'candid: openly objects that the rent is unfair and bargains self-assured', { turn: 11, message: 60, date: 'CR822, Redleaf 2', speechRow });
            state = elenaScan(state, 'candid: openly objects the factor price is unfair and bargains self-assured', { turn: 12, message: 62, date: 'CR822, Redleaf 12', speechRow });
            return state.npcs[0];
        };
        assert.equal(outcome(false).personality, CANDIDATE, 'control: the ordinary row alone promotes');
        const mixed = outcome(true);
        assert.equal(mixed.personality, CANDIDATE, 'the Speech-only profile row does not hide the Personality row');
        assert.equal(mixed.speech, SPEECH);
    } finally {
        setActiveCalendarConfig(null);
    }
});

async function deepAuditRuntimeChecks(mockState, eventSource, manualAddNpc, sleep, urls) {
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
    const remoteAdvance = (mutate, path = runtime.dataFile().path) => {
        const payload = JSON.parse(mockState.files.get(path));
        mutate(payload.state, payload);
        payload.revision += 1;
        payload.writerId = 'remote-other-session';
        mockState.files.set(path, JSON.stringify(payload));
    };
    const retire = path => remoteAdvance((state, payload) => { payload.retired = true; payload.retiredAt = new Date().toISOString(); payload.retireReason = 'chat-deleted'; payload.state = {}; }, path);
    const named = name => runtime.getState().npcs.find(npc => npc.name === name);
    const liveFileMentions = text => [...mockState.files.values()].some(raw => {
        try { const payload = JSON.parse(raw); return payload?.retired !== true && JSON.stringify(payload).includes(text); } catch { return false; }
    });
    const { prepareNpcStateHardening } = await import(urls.hardening);
    mockState.context.eventTypes.CHARACTER_RENAMED = 'character_renamed';
    await prepareNpcStateHardening();

    // RB93-02: dirty local work never republishes a sidecar observed as retired (flush, owner rename).
    for (const route of ['flush', 'rename']) {
        await open(`rb93-retired-${route}`, ['Mara Valen counts coins.', 'Mara Valen smiles.']);
        await manualAddNpc('Mara Valen');
        await runtime.flush();
        const path = runtime.dataFile().path;
        const owner = runtime.uiStatus().chatKey.split(':')[1];
        globalThis.fetch = async (url, options = {}) => (url === '/api/files/upload'
            ? { ok: false, status: 400, json: async () => ({}), text: async () => 'bad request' }
            : baseFetch(url, options));
        await manualAddNpc(`Local Unsaved ${route}`);
        await runtime.flush().catch(() => null);
        await sleep(50);
        globalThis.fetch = baseFetch;
        retire(path);
        await runtime.ensureFresh().catch(() => null);
        if (runtime.uiStatus().hydrationStatus !== 'error') fail(`RB93-02 (${route}): the retirement was not observed`);
        if (route === 'flush') await runtime.flush().catch(() => null);
        else for (const listener of mockState.listeners.get('character_renamed') || []) await Promise.resolve(listener(owner, `${owner}-renamed`)).catch(() => null);
        await sleep(100);
        if (!/"retired":\s*true/.test(mockState.files.get(path) || '')) fail(`RB93-02 (${route}): the retired sidecar was overwritten`);
        if (liveFileMentions(`Local Unsaved ${route}`)) fail(`RB93-02 (${route}): retired local work was published`);
    }

    // RB93-03: regenerate/swipe/continue revalidate the dossier before the prompt is built.
    await open('rb93-generation', ['Mira Voice hums at the bar.', 'Mira Voice keeps humming.']);
    await manualAddNpc('Mira Voice');
    await runtime.flush();
    for (const [type, speech] of [['regenerate', 'Speaks in clipped sailor slang.'], ['swipe', 'Speaks in courtly riddles.'], ['continue', 'Speaks in hushed whispers.']]) {
        remoteAdvance(state => { Object.assign(state.npcs.find(npc => npc.name === 'Mira Voice'), { speech, present: true }); });
        const promptsBefore = mockState.prompts.length;
        for (const listener of mockState.listeners.get('generation_after_commands') || []) await listener(type, {}, false);
        if (named('Mira Voice')?.speech !== speech) fail(`RB93-03 (${type}): the newer canonical Speech was not adopted before generation`);
        const injected = mockState.prompts.slice(promptsBefore).map(args => String(args[1] || '')).join('\n');
        if (!injected.includes(speech)) fail(`RB93-03 (${type}): the rebuilt injection does not carry the current Speech`);
    }
    const quietReads = mockState.prompts.length;
    for (const listener of mockState.listeners.get('generation_after_commands') || []) await listener('quiet', {}, false);
    if (mockState.prompts.length !== quietReads) fail('RB93-03: a quiet generation rebuilt the roleplay injection');

    // RB93-04/05: every single-target channel binds to the target's resolved identity.
    await open('rb93-scope', ['Mira Deep, Noela Deep and Kora Deep meet.', '<New_NPC name="Mira Deep">Name: Mira Deep\nRole: guard</New_NPC>']);
    await manualAddNpc('Mira Deep');
    await manualAddNpc('Noela Deep');
    await manualAddNpc('Kora Deep');
    await runtime.flush();
    remoteAdvance(state => {
        for (const npc of state.npcs) {
            if (npc.name === 'Kora Deep') continue;
            npc.appearanceForms = [{ name: 'Human', appearance: 'A tall woman in grey.' }, { name: 'Dragon', appearance: 'A silver dragon.' }];
            npc.currentForm = 'Human';
        }
    });
    await runtime.ensureFresh();
    const ids = () => ({ mira: named('Mira Deep').id, noela: named('Noela Deep').id, kora: named('Kora Deep').id });
    const foreignBond = () => (runtime.getState().socialGraph?.edges || []).some(edge => [edge.aId, edge.bId].includes(ids().noela) && [edge.aId, edge.bId].includes(ids().kora));
    const respond = payload => { mockState.quietResponder = async () => JSON.stringify(payload); };
    // Structured import (a matching New_NPC block exists): foreign profile and edge channels are dropped.
    respond({
        npcs: [{ id: ids().mira, name: 'Mira Deep', role: 'guard' }],
        profileUpdates: [{ id: ids().noela, name: 'Noela Deep', currentForm: 'Dragon', currentFormState: 'change' }],
        keyRelationshipEdges: [{ aId: ids().noela, a: 'Noela Deep', bId: ids().kora, b: 'Kora Deep', aToB: 'friend', bToA: 'friend', reason: 'they meet' }],
    });
    await runtime.scanDossier(ids().mira);
    await sleep(100);
    if (named('Noela Deep').currentForm !== 'Human') fail('RB93-04: the structured import switched another NPC\'s form');
    if (foreignBond()) fail('RB93-04: the structured import created a bond between two other NPCs');
    // Contradictory identities: an exact target id carrying another NPC's name, and an endpoint
    // whose id and label disagree, are rejected in backfill and Refresh.
    mockState.context.chat[1].mes = 'Mira Deep nods to Noela Deep and Kora Deep.';
    const contradictory = {
        npcs: [{ id: ids().mira, name: 'Mira Deep', mood: 'calm' }],
        profileUpdates: [{ id: ids().mira, name: 'Noela Deep', currentForm: 'Dragon', currentFormState: 'change' }],
        keyRelationshipEdges: [{ aId: ids().noela, a: 'Mira Deep', bId: ids().kora, b: 'Kora Deep', aToB: 'friend', bToA: 'friend', reason: 'they meet' }],
    };
    respond(contradictory);
    await runtime.scanDossier(ids().mira);
    await sleep(100);
    respond(contradictory);
    await runtime.refreshFromChat(ids().mira);
    await sleep(100);
    if (named('Noela Deep').currentForm !== 'Human' || named('Mira Deep').currentForm !== 'Human') fail('RB93-05: a contradictory profile row switched a form');
    if (foreignBond()) fail('RB93-05: an endpoint whose id and label disagree created a foreign bond');
    // Control: the target's own profile and a target-touching edge still apply.
    respond({
        npcs: [{ id: ids().mira, name: 'Mira Deep', mood: 'calm' }],
        profileUpdates: [{ id: ids().mira, name: 'Mira Deep', currentForm: 'Dragon', currentFormState: 'change', currentFormReason: 'Mira Deep becomes a dragon' }],
        keyRelationshipEdges: [{ aId: ids().mira, a: 'Mira Deep', bId: ids().kora, b: 'Kora Deep', aToB: 'friend', bToA: 'friend', reason: 'Mira Deep and Kora Deep are friends' }],
    });
    mockState.context.chat[1].mes = 'Mira Deep becomes a dragon. Mira Deep and Kora Deep are friends.';
    await runtime.refreshFromChat(ids().mira);
    await sleep(100);
    mockState.quietResponder = null;
    if (!(runtime.getState().socialGraph?.edges || []).some(edge => [edge.aId, edge.bId].includes(ids().mira) && [edge.aId, edge.bId].includes(ids().kora))) fail('RB93-05 control: the target-touching edge was dropped');

    // RB93-06: a lost acknowledgement of Detach's canonical replacement keeps the original backup registered.
    await open('rb93-detach', ['Vessa Broken waits.', 'Vessa Broken sighs.']);
    await manualAddNpc('Vessa Broken');
    await runtime.flush();
    const detachKey = runtime.uiStatus().chatKey;
    const detachPath = runtime.dataFile().path;
    mockState.files.set(detachPath, '{"format": not json');
    // Visiting more chats than the working cache holds evicts the inactive copy, so returning
    // hydrates from the (now corrupt) sidecar.
    for (let i = 0; i < 8; i += 1) await open(`rb93-detach-away-${i}`, ['Elsewhere.', 'Still elsewhere.']);
    await open('rb93-detach', ['Vessa Broken waits.', 'Vessa Broken sighs.']);
    await runtime.ensureFresh().catch(() => null);
    if (runtime.uiStatus().hydrationStatus !== 'error') fail(`RB93-06: the corrupt sidecar did not block hydration (${runtime.uiStatus().hydrationStatus})`);
    const previousConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    let loseAck = true;
    globalThis.fetch = async (url, options = {}) => {
        const response = await baseFetch(url, options);
        if (url === '/api/files/upload' && loseAck) {
            const body = JSON.parse(options.body || '{}');
            if (`/user/files/${body.name}` === detachPath) { loseAck = false; throw new TypeError('acknowledgement lost'); }
        }
        return response;
    };
    const detach = uiHandlers.get('click.npcStateDelta|.npc-state-delta-detach-sidecar');
    await detach();
    await sleep(100);
    globalThis.fetch = baseFetch;
    const firstRecord = settings.recoveryFiles?.[detachKey];
    if (!firstRecord?.path || mockState.files.get(firstRecord.path) !== '{"format": not json') fail('RB93-06: the verified backup was not registered before the lost acknowledgement');
    await detach();
    await sleep(100);
    globalThis.confirm = previousConfirm;
    const record = settings.recoveryFiles?.[detachKey];
    if (mockState.files.get(record?.path) !== '{"format": not json') fail('RB93-06: the retry registered the empty marker as the preserved sidecar');
    if (runtime.uiStatus().hydrationStatus !== 'ready') fail('RB93-06: the retry did not start a fresh dossier');

    // RB93-01: a resumed rename whose destination read fails keeps its verified copies.
    await open('rb93-rename', ['Ina Resume counts coins.', 'Ina Resume smiles.']);
    await manualAddNpc('Ina Resume');
    await runtime.flush();
    const oldKey = runtime.uiStatus().chatKey;
    const oldOwner = oldKey.split(':')[1];
    const oldPath = runtime.dataFile().path;
    await open('rb93-rename-away', ['Elsewhere.', 'Still elsewhere.']);
    let uncertain = true;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/upload' && uncertain) {
            const body = JSON.parse(options.body || '{}');
            const text = Buffer.from(body.data, 'base64').toString('utf8');
            if (`/user/files/${body.name}` === oldPath && /"retired":\s*true/.test(text)) {
                uncertain = false;
                await baseFetch(url, options);
                throw new TypeError('network connection lost after the write');
            }
        }
        return baseFetch(url, options);
    };
    const renameTo = `${oldOwner}-renamed`;
    const rename = async () => { for (const listener of mockState.listeners.get('character_renamed') || []) await Promise.resolve(listener(oldOwner, renameTo)).catch(() => null); };
    await rename();
    const pending = settings.pendingRenames?.[oldKey];
    if (!pending?.newPointer?.path) fail('RB93-01: the uncertain rename left no resumable record');
    let failDestination = true;
    globalThis.fetch = async (url, options = {}) => {
        if (url === pending.newPointer.path && (options.method || 'GET') === 'GET' && failDestination) {
            failDestination = false;
            return { ok: false, status: 503, text: async () => 'unavailable' };
        }
        return baseFetch(url, options);
    };
    await rename();
    globalThis.fetch = baseFetch;
    if (!settings.pendingRenames?.[oldKey]) fail('RB93-01: the failed resume dropped its resumable record');
    if (!mockState.files.has(pending.newPointer.path)) fail('RB93-01: the failed resume deleted the verified destination');
    if (pending.recoveryPointer?.path && !mockState.files.has(pending.recoveryPointer.path)) fail('RB93-01: the failed resume deleted the verified recovery copy');
    await rename();
    const newKey = oldKey.replace(`:${oldOwner}:`, `:${renameTo}:`);
    const moved = settings.dataFiles?.[newKey]?.path;
    if (!moved || !(mockState.files.get(moved) || '').includes('Ina Resume')) fail('RB93-01: a healthy retry did not restore Ina under the new owner');

    setTimeout(() => process.exit(0), 1500);
}

test('RB93-01/02/03/04/05/06 run through the synthetic host', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    // The host emits GENERATION_AFTER_COMMANDS for every generation; the smoke host omits it.
    const events = "        CHAT_RENAMED: 'chat_renamed',\n";
    if (!source.includes(events)) throw new Error('Runtime smoke event table changed');
    source = source.replace(events, `${events}        GENERATION_AFTER_COMMANDS: 'generation_after_commands',\n`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    const urls = "{ hardening: pathToFileURL(path.join(extRoot, 'hardening.js')).href }";
    source = source.replace(marker, `    await (${deepAuditRuntimeChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, ${urls});\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
    });
});
