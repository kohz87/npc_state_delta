import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EDITOR_LOCKABLE_FIELDS, LOCKED_FIELD_KEYS, editorProfileLocks } from '../src/dossier-edit.js';
import { preserveUserNpcMetadata } from '../branch-core.js';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 1: a lock the reader sets in the dossier editor stays set. Before, the protect
// checkbox was never pre-checked (a Set has no .length), so every later Save cleared every lock,
// and editor locks were not marked explicit, so a swipe or branch restore reverted the edit.

test('editor locks: the Save keeps existing locks, adds changed fields and is always explicit', () => {
    const current = { name: 'Yunyun', role: 'adventurer', personality: 'Proud.', aliases: [], customFields: { Level: '3' }, manualProfileFields: ['appearance'] };
    const next = { ...current, role: 'archmage', customFields: { Level: '4' } };
    assert.deepEqual(editorProfileLocks(current, next, { protect: true }),
        { manualProfileFields: ['appearance', 'role', 'customFields'], manualProfileLocksExplicit: true });
    assert.deepEqual(editorProfileLocks(current, { ...current }, { protect: true }),
        { manualProfileFields: ['appearance'], manualProfileLocksExplicit: true }, 'an unchanged Save keeps the locks');
    assert.deepEqual(editorProfileLocks(current, next, { protect: false }),
        { manualProfileFields: [], manualProfileLocksExplicit: true }, 'unticked clears them, explicitly');
    assert.equal(EDITOR_LOCKABLE_FIELDS.length, 15);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(index, /locked\.length/, 'the editor reads the Set size');
    assert.match(index, /editorProfileLocks\(current, next, \{ protect: Boolean\(document\.getElementById\('npc_state_delta_edit_lock_profile'\)\?\.checked\) \}\)/);
});

test('a branch restore keeps every key a lock covers, the same keys a bundle import keeps', () => {
    const current = {
        id: 'npc_y', name: 'Yunyun', identityKind: 'proper_name', appearance: 'Crimson eyes; a red scarf.', overallAppearance: 'Crimson eyes.',
        appearanceForms: [{ name: 'Cloaked', appearance: 'Black cloak.' }], currentForm: '', currentFormUnknown: false, appearanceModelVersion: 2,
        apparentAge: '~14', apparentAgeAnchor: { apparent: 14, result: 14 }, mood: 'calm',
        ...editorProfileLocks({ manualProfileFields: ['appearance', 'apparentAge'] }, {}, { protect: true }),
    };
    const restored = { id: 'npc_y', name: 'Yunyun', identityKind: 'proper_name', appearance: 'Plain.', overallAppearance: 'Brown eyes.', appearanceForms: [],
        unclassifiedAppearance: 'old leftover', apparentAge: '~13', apparentAgeAnchor: { apparent: 13, result: 13 }, mood: 'tired' };
    const [npc] = preserveUserNpcMetadata([restored], [current]);
    for (const key of [...LOCKED_FIELD_KEYS.appearance, ...LOCKED_FIELD_KEYS.apparentAge]) {
        assert.deepEqual(npc[key], current[key], `${key} follows the lock`);
    }
    assert.equal('unclassifiedAppearance' in npc, false, 'a part the current dossier does not have is not kept from the old copy');
    assert.equal(npc.mood, 'tired', 'an unlocked field is the restored one');
    assert.deepEqual(npc.manualProfileFields, ['appearance', 'apparentAge']);
    const bundle = fs.readFileSync(new URL('../bundle.js', import.meta.url), 'utf8');
    assert.match(bundle, /for \(const key of LOCKED_FIELD_KEYS\[field\] \|\| \[\]\)/, 'bundle import uses the same map');
});

test('editor locks through the synthetic host: a second Save, a later scan, a swipe and a branch restore keep them', () => {
    runEditorHostScenario('locks', async () => {
        const runtime = globalThis.NPCStateDelta;
        let role = 'adventurer';
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role, mood: 'calm', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await sleep(200);
            return id;
        };
        const yunyun = () => runtime.getDossierState().npcs.find(npc => npc.name === 'Yunyun');
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        await reply('Who is at the gate?', 'Yunyun, the adventurer, waits at the gate.');
        const id = yunyun().id;
        assert.equal(yunyun().role, 'adventurer');

        // Control: an unprotected edit is a baseline the next scan may rewrite.
        const unlocked = await openEditorForm(id);
        assert.equal(unlocked.controls.get('npc_state_delta_edit_lock_profile').checked, false, 'nothing is protected yet');
        assert.doesNotMatch(unlocked.html, /Currently protected/);
        await saveEditorForm(unlocked, { role: 'apprentice' });
        assert.equal(yunyun().role, 'apprentice');
        assert.deepEqual(yunyun().manualProfileFields, []);

        // A protected edit.
        await editNpc(id, { role: 'Crimson Demon archmage', lock_profile: { checked: true } });
        assert.equal(yunyun().role, 'Crimson Demon archmage');
        assert.deepEqual(yunyun().manualProfileFields, ['role']);

        // The editor shows the lock, and a second Save that leaves the checkbox as shown keeps it.
        const second = await openEditorForm(id);
        assert.equal(second.controls.get('npc_state_delta_edit_lock_profile').checked, true, 'the protect checkbox is pre-checked');
        assert.match(second.html, /Currently protected: role/);
        await saveEditorForm(second, { mood: 'curious' });
        assert.deepEqual(yunyun().manualProfileFields, ['role'], 'the second Save kept the lock');
        assert.equal(yunyun().mood, 'curious');

        // A later scan proposing another role leaves the locked one.
        const next = await reply('Say hello.', 'Yunyun the adventurer waves.');
        assert.equal(yunyun().role, 'Crimson Demon archmage', 'the scan did not rewrite a locked role');

        // Edits made after that reply: a new role and a newly locked background.
        await editNpc(id, { role: 'Crimson Demon chieftain', background: 'Raised in the Crimson Demon village.' });
        assert.equal(yunyun().role, 'Crimson Demon chieftain');
        assert.deepEqual(yunyun().manualProfileFields, ['role', 'background']);
        // The appearance editor's lock comes from the same checkbox.
        assert.equal(await runtime.updateAppearance(id, { overallAppearance: 'Crimson eyes and a black cloak.', currentForm: '__none__', currentAppearance: 'A red scarf.', formsText: '' },
            { chatKey: runtime.uiStatus().chatKey, lockAppearance: true }), true);
        const appearance = yunyun().appearance;
        assert.equal(yunyun().overallAppearance, 'Crimson eyes and a black cloak.');
        assert.deepEqual(yunyun().manualProfileFields, ['role', 'background', 'appearance']);

        // A swipe of that reply restores the boundary before it and rescans; the edits and their locks stay.
        mockState.context.chat[next] = { is_user: false, is_system: false, name: 'Megumin', swipe_id: 1,
            mes: 'On the other swipe, Yunyun the adventurer bows.', swipes: ['Yunyun the adventurer waves.', 'On the other swipe, Yunyun the adventurer bows.'] };
        mockState.swipeState = 'swiping';
        eventSource.emit('message_swiped', next);
        await sleep(150);
        eventSource.emit('message_received', next);
        await sleep(150);
        mockState.swipeState = 'none';
        await sleep(500);
        assert.equal(yunyun().role, 'Crimson Demon chieftain', 'the swipe kept the locked edit');
        assert.equal(yunyun().background, 'Raised in the Crimson Demon village.');
        assert.deepEqual(yunyun().manualProfileFields, ['role', 'background', 'appearance'], 'the swipe kept the locks');
        assert.equal(yunyun().appearance, appearance, 'the swipe kept the locked appearance');
        assert.equal(yunyun().overallAppearance, 'Crimson eyes and a black cloak.', 'and the appearance forms under it');

        // Deleting the reply rolls back to the boundary before it; the edits and their locks stay.
        mockState.context.chat.splice(next - 1, 2);
        eventSource.emit('message_deleted', next - 1);
        await sleep(500);
        assert.equal(yunyun().role, 'Crimson Demon chieftain', 'the branch restore kept the locked edit');
        assert.equal(yunyun().background, 'Raised in the Crimson Demon village.');
        assert.deepEqual(yunyun().manualProfileFields, ['role', 'background', 'appearance'], 'the branch restore kept the locks');
        assert.equal(yunyun().overallAppearance, 'Crimson eyes and a black cloak.');

        // Unticking and saving clears the locks; the next scan may then rewrite the role.
        await editNpc(id, { lock_profile: { checked: false } });
        assert.deepEqual(yunyun().manualProfileFields, []);
        role = 'wandering adventurer';
        await reply('Where to?', 'Yunyun, a wandering adventurer again, points north.');
        assert.equal(yunyun().role, 'wandering adventurer', 'an unlocked role follows the story again');
    });
});
