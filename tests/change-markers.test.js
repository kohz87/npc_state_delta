import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNpcRecord, stampChangedFields } from '../core.js';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 9 (audit I-18): the per-field "changed at" markers (fieldChanges: Delta's turn;
// fieldChangeMessages: the reply number) were stamped only inside the merge, so the focused
// relationship pass (the main relationship writer on delta scans), editor saves, appearance-form and
// life-state edits left them stale, and Refresh's staleness hint flagged a field the reader had
// just rewritten by hand.

test('stampChangedFields stamps exactly the tracked fields that differ', () => {
    const before = normalizeNpcRecord({ id: 'n', name: 'Mira', mood: 'calm', personality: 'Kind.', fieldChanges: { mood: 2 }, fieldChangeMessages: { mood: 4 } });
    const after = { ...before, personality: 'Kind; wry.', relationship: { ...before.relationship, trust: 3 } };
    const stamped = stampChangedFields(before, after, { turn: 7, message: 12, storyDay: 30 });
    assert.deepEqual(stamped.fieldChanges, { mood: 2, personality: 7, relationship: 7 });
    assert.deepEqual(stamped.fieldChangeMessages, { mood: 4, personality: 12, relationship: 12 });
    assert.equal(stamped.fieldChangeDays.personality, 30);
    assert.deepEqual(stampChangedFields(before, { ...before }, { turn: 8, message: 13 }).fieldChanges, { mood: 2 }, 'no change, no stamp');
});

test('change markers through the synthetic host: the relationship pass, an editor Save and a life-state edit stamp their changes', () => {
    runEditorHostScenario('change-markers', async () => {
        const runtime = globalThis.NPCStateDelta;
        const row = { name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true };
        let scannerRow = { ...row, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } };
        const evaluated = [];
        mockState.quietResponder = async (args = {}) => {
            if (/isolated relationship evaluator/i.test(String(args.systemPrompt || ''))) {
                const id = runtime.getDossierState().npcs.find(npc => npc.name === 'Yunyun')?.id;
                evaluated.push(id);
                return JSON.stringify({ npcs: [{ id, name: 'Yunyun', relationshipImpact: 'meaningful',
                    relationshipDelta: { trust: 3, affection: 0, desire: 0, tension: 0 },
                    relationshipEvidence: { trust: 'Yunyun tells Kazuma she trusts him more.', affection: '', desire: '', tension: '' },
                    relationshipChangeReason: 'Yunyun tells Kazuma she trusts him more.' }] });
            }
            return JSON.stringify({ npcs: [scannerRow] });
        };
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await sleep(250);
            return id;
        };
        const yunyun = () => runtime.getDossierState().npcs.find(npc => npc.name === 'Yunyun');
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        await reply('Who is at the gate?', 'Yunyun, the calm adventurer, waits at the gate.');
        // The scanner row leaves the relationship undecided, so the focused pass decides it.
        scannerRow = { ...row };
        const second = await reply('Do you trust me?', 'Yunyun tells Kazuma she trusts him more.');
        let npc = yunyun();
        assert.ok(evaluated.length >= 1, 'the focused relationship pass ran');
        assert.ok(npc.relationship.trust > 0, 'the pass changed the relationship');
        const turn = runtime.getDossierState().turn;
        assert.equal(npc.fieldChanges?.relationship, turn, 'fieldChanges.relationship follows the pass');
        assert.equal(npc.fieldChangeMessages?.relationship, second, 'the change shows at this reply');

        // An editor Save stamps what it changed, at the latest reply.
        const moodStamp = npc.fieldChangeMessages?.mood;
        await editNpc(npc.id, { personality: 'Proud but earnest; secretly lonely.' });
        npc = yunyun();
        assert.equal(npc.fieldChanges?.personality, runtime.getDossierState().turn);
        assert.equal(npc.fieldChangeMessages?.personality, second);
        assert.equal(npc.fieldChangeMessages?.mood, moodStamp, 'an untouched field keeps its own stamp');

        // A life-state edit stamps lifeState.
        assert.equal(await runtime.updateLifeState(npc.id, 'deceased', { chatKey: runtime.uiStatus().chatKey }), true);
        npc = runtime.getNpc(npc.id);
        assert.equal(npc.fieldChangeMessages?.lifeState, second);
    });
});
