// 1.2.10: the reply's World State puts presence right when the scan names someone the scene
// has already left ("Brecht lay in the mud" before the walk to the Guild).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScenePresence, createNpcRecord, mergeScanResult } from '../core.js';
import { worldStatePeople } from '../present-scene.js';

const WORLD_STATE = [
    '**📅 Time:** CY 611, Goldwane 12, 01:10 pm | **🌤 Loc:** Bluewatch Village, Adventurer Guild Branch',
    '',
    '---',
    '',
    '**🧍 Astra:**',
    '* *Outfit:* Torn oilcloth coat',
    '',
    '---',
    '',
    '**👥 NPCs Present:**',
    '**Verna:**',
    '* *Outfit:* Faded linen kirtle',
    '* *Mood:* Shocked',
    '',
    '---',
    '**📡 Off-Screen:**',
    '* Bond collector — now: Leaving Glassdock on a supply barge',
    '* Brecht — Beat Astra senseless, take his silver',
    '* Jor: crying in the granary alley',
    '',
    '---',
    '**🎬 Scene Phase:** Breather',
].join('\n');

const npc = (name, extra = {}) => ({ ...createNpcRecord(name), id: `npc_${name.toLowerCase()}`, ...extra });

test('worldStatePeople reads the present and off-screen sections, and an explicit (None)', () => {
    assert.deepEqual(worldStatePeople(WORLD_STATE), { present: ['Verna'], none: false, offscreen: ['Bond collector', 'Brecht', 'Jor'] });
    assert.deepEqual(worldStatePeople('**👥 NPCs Present:**\n*(None)*\n\n---\n**📡 Off-Screen:**\n* Marrit — unloading'), { present: [], none: true, offscreen: ['Marrit'] });
    assert.deepEqual(worldStatePeople('No sections here.'), { present: null, none: false, offscreen: null });
});

test('applyScenePresence: present when listed, gone when off-screen or nobody is, else the scan stands', () => {
    const npcs = [npc('Verna'), npc('Brecht', { present: true }), npc('Wiz', { present: true }), npc('Jor', { present: true, archived: true })];
    const result = applyScenePresence(npcs, worldStatePeople(WORLD_STATE));
    assert.deepEqual(npcs.map(entry => [entry.name, entry.present]), [['Verna', true], ['Brecht', false], ['Wiz', true], ['Jor', false]]);
    assert.deepEqual(result, { cleared: ['npc_brecht', 'npc_jor'], added: ['npc_verna'] }, 'Wiz is on neither list: the scan stands');
    const empty = [npc('Verna', { present: true })];
    applyScenePresence(empty, { present: [], none: true, offscreen: null });
    assert.equal(empty[0].present, false, '(None): nobody is present');
    const dead = [npc('Brecht', { lifeState: 'deceased', lifeStateCertainty: 'explicit' })];
    applyScenePresence(dead, { present: ['Brecht'], none: false, offscreen: null });
    assert.equal(dead[0].present, false, 'the dead are never made present');
});

test('mergeScanResult takes the scene\'s word over the scan\'s for presence, unless presence is preserved', () => {
    const state = { turn: 5, npcs: [npc('Brecht', { present: true, lastSeenTurn: 4 }), npc('Verna', { lastSeenTurn: 3 })] };
    const scan = { npcs: [{ id: 'npc_brecht', name: 'Brecht', present: true, mood: 'groaning in the mud' }, { id: 'npc_verna', name: 'Verna', present: true }] };
    const merged = mergeScanResult(structuredClone(state), scan, { turn: 6, scenePresent: worldStatePeople(WORLD_STATE) });
    const present = Object.fromEntries(merged.state.npcs.map(entry => [entry.name, entry.present]));
    assert.deepEqual(present, { Brecht: false, Verna: true });
    assert.deepEqual(merged.report.scenePresence.cleared, ['npc_brecht']);
    const plain = mergeScanResult(structuredClone(state), scan, { turn: 6 });
    assert.equal(plain.state.npcs.find(entry => entry.name === 'Brecht').present, true, 'without a World State, the scan decides as before');
    const kept = mergeScanResult(structuredClone(state), scan, { turn: 6, scenePresent: worldStatePeople(WORLD_STATE), preservePresence: true });
    assert.equal(kept.report.scenePresence, undefined, 'a merge that preserves presence is left alone');
});
