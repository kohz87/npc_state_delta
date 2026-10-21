import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeNpcRecord } from '../core.js';
import { EDITOR_FIELDS, EDITOR_LOCKABLE_FIELDS, editorShownValue, settleEditorSave, untouchedEditorFields } from '../src/dossier-edit.js';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 2: the editor keeps what the stored record keeps. Before, Save cut role and mood to
// 240 and status to 300 (the record keeps 300, 300 and 500), the inputs had no maxlength, and a
// Save re-cut and re-compacted fields the reader never touched.

const words = (count, stem) => Array.from({ length: count }, (_, i) => `${stem}${i}`).join(' ');

test('every editor cap is what the stored record keeps for that field', () => {
    for (const [key, field] of Object.entries(EDITOR_FIELDS)) {
        if (!field.max) continue;
        // One long clause (no ; or . separators), longer than the cap.
        const long = words(400, key.slice(0, 3)).slice(0, field.max + 40).trim();
        const lockable = EDITOR_LOCKABLE_FIELDS.includes(key);
        const stored = normalizeNpcRecord({ name: key === 'name' ? long : 'Mira', [key]: long, manualProfileFields: lockable ? [key] : [] });
        assert.ok(String(stored[key]).length <= field.max, `${key}: the record keeps at most ${field.max}`);
        const fits = long.slice(0, field.max).trim();
        const kept = normalizeNpcRecord({ name: key === 'name' ? fits : 'Mira', [key]: fits, manualProfileFields: lockable ? [key] : [] });
        if (key === 'age' || key === 'apparentAge') continue; // ages are parsed, not free text
        assert.ok(String(kept[key]).length >= fits.length - 2, `${key}: a ${fits.length}-character value is kept (${String(kept[key]).length})`);
    }
});

test('the editor reads a field as untouched only when its control still shows the stored value', () => {
    const npc = normalizeNpcRecord({ name: 'Mira', role: 'Archivist', mannerisms: ['Taps quill.', 'Hums.'], memories: [] });
    const controls = Object.fromEntries(Object.entries(EDITOR_FIELDS).map(([key, field]) => [`npc_state_delta_edit_${field.id}`, editorShownValue(npc, key)]));
    assert.equal(untouchedEditorFields(npc, id => controls[id]).size, Object.keys(EDITOR_FIELDS).length);
    controls.npc_state_delta_edit_role = 'Archivist ';
    controls.npc_state_delta_edit_mannerisms = 'Taps quill.';
    const untouched = untouchedEditorFields(npc, id => controls[id]);
    assert.equal(untouched.has('role'), false);
    assert.equal(untouched.has('mannerisms'), false);
    assert.equal(untouched.has('name'), true);

    // settleEditorSave puts untouched fields back verbatim and reports what the limits shortened.
    const current = { name: 'Mira', role: 'Archivist', personality: 'x'.repeat(700), manualProfileFields: ['personality'] };
    const typed = { ...current, role: 'A very long role', background: 'One; two; three.' };
    const saved = { ...typed, personality: 'compacted', role: 'A very long', background: 'One; two; three.', manualProfileFields: ['personality'] };
    const shortened = settleEditorSave(saved, current, typed, new Set(['name', 'personality']));
    assert.equal(saved.personality, current.personality, 'an untouched locked field is not re-cut');
    assert.deepEqual(shortened, ['Role']);
    const unlocked = { ...saved, personality: 'compacted', manualProfileFields: [] };
    assert.deepEqual(settleEditorSave(unlocked, current, typed, new Set(['personality'])), ['Role', 'Personality'],
        'a field whose protection the reader removed is compacted, and the warning says so');
    assert.equal(unlocked.personality, 'compacted');
});

test('the editor inputs carry maxlength from the same table the Save cuts with', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    for (const [key, field] of Object.entries(EDITOR_FIELDS)) {
        if (!field.max) continue;
        assert.match(index, new RegExp(`id="npc_state_delta_edit_${field.id}" class="text_pole"[^>]*maxlength="\\$\\{EDITOR_FIELDS\\.${key}\\.max\\}"`), key);
    }
    assert.doesNotMatch(index, /editorField\('npc_state_delta_edit_(?:role|mood|status)'\)\)\.trim\(\)\.slice\(0, \d+\)/, 'no hand-written editor caps remain');
});

test('editor caps through the synthetic host: long values are kept, untouched fields are byte-identical after Save', () => {
    runEditorHostScenario('caps', async () => {
        const runtime = globalThis.NPCStateDelta;
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun, the adventurer, waits at the gate.', swipe_id: 0, swipes: ['Yunyun, the adventurer, waits at the gate.'] });
        await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(2)));
        await sleep(200);
        const yunyun = () => runtime.getDossierState().npcs.find(npc => npc.name === 'Yunyun');
        const id = yunyun().id;
        const warnings = [];
        globalThis.toastr.warning = message => warnings.push(String(message));
        const text = (length, stem) => Array.from({ length: 200 }, (_, i) => `${stem}${i}`).join(' ').slice(0, length).trim();
        const role = text(290, 'role');
        const mood = text(280, 'mood');
        const status = text(480, 'status');
        const goal = text(490, 'goal');
        const location = text(290, 'place');
        const personality = text(850, 'trait');
        const speech = text(560, 'voice');
        const background = text(1100, 'past');
        const mannerisms = ['Taps her wand twice before speaking.', 'Counts coins aloud when nervous.', 'Hums an old village song.', 'Tugs her left braid.', 'Whistles at dawn.', 'Bows too deeply to elders.'];
        await editNpc(id, {
            role, mood, status, goal, location, personality, speech, background, mannerisms: mannerisms.join('\n'),
            lock_profile: { checked: true },
        });
        let npc = yunyun();
        assert.equal(npc.role, role, 'a 290-character role is kept (Save used to cut it to 240)');
        assert.equal(npc.mood, mood, 'a 280-character mood is kept (was cut to 240)');
        assert.equal(npc.status, status, 'a 480-character status is kept (was cut to 300)');
        assert.equal(npc.goal, goal);
        assert.equal(npc.location, location);
        assert.equal(npc.personality, personality, 'protected personality keeps 850 characters');
        assert.equal(npc.background, background);
        assert.deepEqual(npc.mannerisms, mannerisms, 'protected mannerisms keep six lines');
        assert.equal(warnings.length, 0, `nothing was shortened: ${warnings}`);

        // The inputs say how much the record keeps.
        const form = await openEditorForm(id);
        for (const [key, max] of Object.entries({ name: 120, species: 160, role: 300, home_base: 300, age: 80, apparent_age: 80, personality: 900, speech: 600, background: 1200, relationship_summary: 320, mood: 300, location: 300, goal: 500, status: 500 })) {
            assert.equal(form.controls.get(`npc_state_delta_edit_${key}`).maxLength, max, `${key} maxlength`);
        }

        // A Save that changes one field leaves every other field byte-identical.
        const before = structuredClone(yunyun());
        await saveEditorForm(form, { goal: 'Find the lost grimoire.' });
        npc = yunyun();
        assert.equal(npc.goal, 'Find the lost grimoire.');
        for (const key of ['name', 'identityKind', 'species', 'gender', 'role', 'aliases', 'homeBase', 'age', 'apparentAge', 'personality', 'speech', 'background',
            'behaviorProfile', 'mannerisms', 'keyRelationships', 'relationshipSummary', 'mood', 'location', 'status', 'memories', 'customFields', 'manualProfileFields']) {
            assert.deepEqual(npc[key], before[key], `${key} is untouched by the Save`);
        }

        // An unprotected edit longer than the record keeps is shortened, and the reader is told.
        await editNpc(id, { lock_profile: { checked: false }, speech: text(560, 'tone') + '; ' + text(200, 'cadence') });
        assert.ok(yunyun().speech.length <= 280, 'unprotected speech is compacted to the stored limit');
        assert.ok(warnings.some(message => /Speech/.test(message) && /Personality/.test(message) && /shortened or adjusted/.test(message)),
            `the warning names the edited speech and the now unprotected personality: ${warnings}`);
    });
});
