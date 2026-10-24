import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScanResult, normalizeNpcRecord } from '../core.js';
import { editorManualMemories } from '../src/dossier-edit.js';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 6 (audit I-4, I-5): background is keep-by-default like the home base; Player Dynamic,
// the live fields and memories can be locked and the merge keeps them; hand-entered memories are
// never evicted by a later scan.

const STORED = 'Raised in the river quarter; apprenticed to the archive at twelve; survived the flood year';
const context = 'Myla, raised in the river quarter and apprenticed to the archive at twelve, survived the flood year and later served ten years as a royal archivist. She smiles.';

function merge(fields, extra = {}, channel = 'npcs', ctx = context) {
    const npc = normalizeNpcRecord({ id: 'npc_myla', name: 'Myla', present: true, background: STORED, ...extra });
    const reply = channel === 'npcs'
        ? { npcs: [{ id: 'npc_myla', name: 'Myla', present: true, ...fields }] }
        : { npcs: [{ id: 'npc_myla', name: 'Myla', present: true }], profileUpdates: [{ id: 'npc_myla', name: 'Myla', ...fields }] };
    return mergeScanResult({ turn: 3, npcs: [npc], candidates: [] }, reply, { turn: 4, sourceMessageId: 5, developmentContext: ctx }).state.npcs[0];
}

for (const channel of ['npcs', 'profileUpdates']) {
    test(`background (${channel}): a shorter restatement no longer erases stored clauses`, () => {
        assert.equal(merge({ background: 'Raised in the river quarter.' }, {}, channel).background, STORED);
    });
    test(`background (${channel}): a grounded restatement that keeps every stored concept is accepted`, () => {
        const richer = `${STORED}; served ten years as a royal archivist`;
        assert.equal(merge({ background: richer }, {}, channel).background, richer);
    });
    test(`background (${channel}): backgroundState update with a reason and grounding may rewrite`, () => {
        const rewritten = 'Served ten years as a royal archivist after the flood year';
        assert.equal(merge({ background: rewritten }, {}, channel).background, STORED, 'not without the state');
        assert.equal(merge({ background: rewritten, backgroundState: 'update', backgroundReason: 'She tells her history.' }, {}, channel).background, rewritten);
        assert.equal(merge({ background: 'Born a princess of the sky kingdom', backgroundState: 'update', backgroundReason: 'x' }, {}, channel).background, STORED, 'not when the story does not say so');
    });
    test(`background (${channel}): a first background must be grounded; a lock holds`, () => {
        assert.equal(merge({ background: 'Served ten years as a royal archivist' }, { background: '' }, channel).background, 'Served ten years as a royal archivist');
        assert.equal(merge({ background: 'Born a princess of the sky kingdom' }, { background: '' }, channel).background, '');
        assert.equal(merge({ background: `${STORED}; served ten years as a royal archivist` }, { manualProfileFields: ['background'] }, channel).background, STORED);
    });
}

test('live fields and Player Dynamic: a lock keeps them through a scan, a clear and a relationship event', () => {
    const locked = { mood: 'Wary', location: 'Archive', goal: 'Find the ledger', status: 'Tired', relationshipSummary: 'Hand-written: trusts Ari with her life.',
        manualProfileFields: ['mood', 'location', 'goal', 'status', 'relationshipSummary'] };
    const npc = merge({ mood: 'Elated', location: 'Market', goalState: 'clear', statusState: 'clear',
        relationshipSummary: 'A model summary.', relationshipImpact: 'ordinary', relationshipDelta: { trust: 2, affection: 0, desire: 0, tension: 0 },
        relationshipEvidence: { trust: 'Myla smiles.', affection: '', desire: '', tension: '' }, relationshipChangeReason: 'She smiles at Ari.' }, locked);
    for (const key of ['mood', 'location', 'goal', 'status', 'relationshipSummary']) assert.equal(npc[key], locked[key], key);
    const free = merge({ mood: 'Elated', location: 'Market', goalState: 'clear' }, { mood: 'Wary', location: 'Archive', goal: 'Find the ledger' });
    assert.deepEqual([free.mood, free.location, free.goal], ['Elated', 'Market', ''], 'unlocked they follow the story, as before');
});

const five = ['Saved the miller from the spring flood.', 'Lost a sword duel to Captain Renn.', 'Swore an oath of silence to the abbess.', 'Escaped the granary fire with two orphans.', 'Danced at her sister Ilse\'s wedding.'];
const newOne = 'Burned the forged letter in the hearth.';

for (const channel of ['npcs', 'profileUpdates']) {
    test(`memories (${channel}): a memories lock keeps the list exactly`, () => {
        const npc = merge({ memories: [newOne] }, { memories: five, manualProfileFields: ['memories'] }, channel, `Myla burned the forged letter in the hearth.`);
        assert.deepEqual(npc.memories, five, 'audit probe: five locked memories plus one new used to evict the flood');
    });
    test(`memories (${channel}): hand-entered memories are never evicted, unlocked`, () => {
        const all = merge({ memories: [newOne] }, { memories: five, manualMemories: five }, channel, `Myla burned the forged letter in the hearth.`);
        assert.deepEqual(all.memories, five, 'five typed memories leave no slot');
        const mixed = merge({ memories: [newOne] }, { memories: five, manualMemories: [five[0], five[1]] }, channel, `Myla burned the forged letter in the hearth.`);
        assert.ok(mixed.memories.includes(five[0]) && mixed.memories.includes(five[1]), 'the typed ones stay');
        assert.ok(mixed.memories.includes(newOne), 'the new one takes a scan-made slot');
        assert.equal(mixed.memories.length, 5);
        assert.ok(!mixed.memories.includes(five[2]), 'the oldest scan-made memory goes');
        assert.deepEqual(mixed.manualMemories, [five[0], five[1]]);
        const none = merge({ memories: [newOne] }, { memories: five }, channel, `Myla burned the forged letter in the hearth.`);
        assert.ok(!none.memories.includes(five[0]), 'without typed memories the newest five win, as before');
    });
}

test('the editor records the memory lines the reader typed', () => {
    const current = { memories: ['A scan memory about the flood.'], manualMemories: [] };
    const saved = { memories: ['A scan memory about the flood.', 'I typed this one about the duel.'] };
    assert.deepEqual(editorManualMemories(current, saved, new Set()), ['I typed this one about the duel.']);
    assert.deepEqual(editorManualMemories({ ...current, manualMemories: ['A scan memory about the flood.'] }, current, new Set(['memories'])), ['A scan memory about the flood.'],
        'untouched: the earlier typed ones that are still stored');
    assert.deepEqual(normalizeNpcRecord({ name: 'M', memories: ['Kept.'], manualMemories: ['Kept.', 'Gone.'] }).manualMemories, ['Kept.'],
        'a typed memory the reader later deleted is no longer pinned');
});

test('editor through the synthetic host: Player Dynamic, mood and memories lock; typed memories survive a crowded scan', () => {
    runEditorHostScenario('step6-locks', async () => {
        const runtime = globalThis.NPCStateDelta;
        let memories = [];
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', memories, identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await sleep(200);
        };
        const yunyun = () => runtime.getDossierState().npcs.find(npc => npc.name === 'Yunyun');
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        await reply('Who is at the gate?', 'Yunyun, the calm adventurer, waits at the gate.');
        const id = yunyun().id;
        const typed = ['Yunyun swore to beat Megumin at the next duel.', 'Yunyun lost her lucky charm in the river.'];
        await editNpc(id, { relationship_summary: 'Hand-written: a rival who secretly admires Kazuma.', mood: 'determined', memories: typed.join('\n'), lock_profile: { checked: true } });
        let npc = yunyun();
        for (const key of ['relationshipSummary', 'mood', 'memories']) assert.ok(npc.manualProfileFields.includes(key), `${key} is locked`);
        assert.deepEqual(npc.manualMemories, typed, 'the typed memories are recorded');
        memories = ['Yunyun found a silver coin.', 'Yunyun bought a new wand.', 'Yunyun read a spellbook.', 'Yunyun climbed the bell tower.', 'Yunyun fed the stray cat.'];
        await reply('What did you do today?', 'Yunyun, the calm adventurer, found a silver coin, bought a new wand, read a spellbook, climbed the bell tower and fed the stray cat.');
        npc = yunyun();
        assert.equal(npc.mood, 'determined', 'a locked mood holds');
        assert.equal(npc.relationshipSummary, 'Hand-written: a rival who secretly admires Kazuma.');
        assert.deepEqual(npc.memories, typed, 'locked memories hold');
        // Unlocked, the typed memories still are never pushed out.
        await editNpc(id, { lock_profile: { checked: false } });
        await reply('And then?', 'Yunyun, the calm adventurer, found a silver coin, bought a new wand, read a spellbook, climbed the bell tower and fed the stray cat.');
        npc = yunyun();
        assert.equal(npc.memories.length, 5);
        for (const line of typed) assert.ok(npc.memories.includes(line), `kept: ${line}`);
    });
});
