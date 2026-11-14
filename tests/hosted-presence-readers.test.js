// Hosted, who is present comes from Story Block's scene at read time and is never written into the saved dossier. Each reader below is run with the
// scene and the stored `present` disagreeing (stored: here; scene: nobody), and again standalone, where the stored value stands.
// Runtime part: Delta's real index.js on the synthetic host (helpers/host-scenario.js), a fake Story Block whose `scene.present` the scenario moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostScenario } from './helpers/host-scenario.js';
import { projectDossierState } from '../dossier-ui-catalog.js';
import { mapStatus } from '../relationship-map-core.js';
import fs from 'node:fs';

const scenario = async () => {
    const api = globalThis.NPCStateDelta;
    const suiteApi = globalThis.StorySuite?.api?.('npc-state-delta');
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves from the gate.', swipe_id: 0, swipes: ['Yunyun waves from the gate.'] });
    const id = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
    await sleep(400);
    const read = () => ({
        stored: api.getState().npcs[0].present,
        dossier: api.getDossierState(),
        token: api.dossierViewToken(),
        profile: suiteApi ? suiteApi.npcProfiles()[0]?.present : null,
    });
    // Story Block tells its listeners (head) whenever its scene moves; the panel's view token keeps the host's views until it does.
    const sceneMoved = () => { for (const fn of mockState.sdkOn?.get('head') || []) fn({ index: 0 }); };
    mockState.scene = ['Yunyun'];
    sceneMoved();
    const here = read();
    mockState.scene = [];
    sceneMoved();
    const away = read();
    // The player's pending message names her: with the scene saying she is away, she is "called in" and her dossier is in the prompt.
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Yunyun, come here.' });
    const named = api.injectionPreview().text;
    console.log('RESULT ' + JSON.stringify({ here, away, named, hosted: globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2 ?? null }));
};
const hostedPrelude = async () => {
    const sdk = { registered: [], sent: [], registerModule(def) { sdk.registered.push(def); }, on(name, fn) { (mockState.sdkOn ??= new Map()).set(name, [...(mockState.sdkOn.get(name) || []), fn]); return () => {}; }, command: async (type, payload) => { sdk.sent.push({ type, payload }); return { ok: true }; }, query: name => (name === 'scene.present' ? mockState.scene : []), settings: () => ({}) };
    mockState.sdk = sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
};
const resultOf = output => JSON.parse(output.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
const shown = state => projectDossierState(state, { chatKey: 'k', hydrationStatus: 'ready' }).details?.[0] ?? projectDossierState(state, { chatKey: 'k', hydrationStatus: 'ready' }).npcs?.[0];

test('hosted: the panel\'s "In chat" label, the relationship map, the token and npcProfiles follow the scene; the stored dossier is untouched', () => {
    const { here, away, hosted } = resultOf(runHostScenario('presence-hosted', hostedPrelude, scenario));
    assert.equal(hosted, '1');
    assert.equal(here.dossier.npcs[0].present, true);
    assert.equal(away.stored, true, 'the saved dossier still says present');
    assert.equal(away.dossier.npcs[0].present, false, 'the panel\'s state follows the scene');
    assert.equal(shown(here.dossier).statusLabel, 'In chat');
    assert.equal(shown(away.dossier).statusLabel, 'Off-screen');
    assert.equal(mapStatus(shown(here.dossier)), 'scene');
    assert.notEqual(mapStatus(shown(away.dossier)), 'scene', 'the map');
    assert.notEqual(away.token, here.token, 'the panel redraws when only the scene moved');
    assert.equal(away.profile, null, 'the v1 handshake offers nothing to a v2 host, so npcProfiles is not reachable here (its reader is pinned below)');
});

test('hosted: the person the reader names, whom the scene leaves out, keeps her dossier in the prompt; standalone the same text', () => {
    const hosted = resultOf(runHostScenario('presence-named-hosted', hostedPrelude, scenario));
    const alone = resultOf(runHostScenario('presence-named-alone', async () => {}, scenario));
    assert.match(hosted.named, /Yunyun: IDENTITY[^\n]*role: adventurer/);
    assert.equal(hosted.named, alone.named, 'the prompt is the same text either way here (the check itself is pinned below)');
});

test('npcProfiles and the called-in check read the scene\'s presence through scenePresenceView (the v1 handshake does not run hosted)', () => {
    const suite = fs.readFileSync(new URL('../runtime-suite.js', import.meta.url), 'utf8');
    assert.match(suite, /buildNpcProfiles\(scenePresenceView\(getChatState\(key\)\.npcs \|\| \[\]\)/);
    const injection = fs.readFileSync(new URL('../runtime-injection.js', import.meta.url), 'utf8');
    assert.match(injection, /return \(scenePresenceView\(state\?\.npcs \|\| \[\]\)\)\n\s*\.filter\(npc => npc && !npc\.present/);
});

test('standalone: the stored presence stands for every reader', () => {
    const alone = resultOf(runHostScenario('presence-alone', async () => {}, scenario));
    assert.equal(alone.hosted, null);
    assert.equal(alone.here.dossier.npcs[0].present, true);
    assert.equal(alone.away.dossier.npcs[0].present, true, 'no scene to ask');
    assert.equal(alone.away.profile, true);
    assert.equal(alone.away.token, alone.here.token, 'the token is unchanged standalone');
    assert.equal(shown(alone.away.dossier).statusLabel, 'In chat');
});

test('full cast reads the people through the dossier panel\'s view (full-cast.js cannot be imported here: it needs SillyTavern\'s modules)', () => {
    const source = fs.readFileSync(new URL('../full-cast.js', import.meta.url), 'utf8');
    assert.match(source, /function shownState\(runtime\) \{\n    const raw = runtime\?\.getState\?\.\(\);\n    try \{\n        const shown = runtime\?\.getDossierState\?\.\(\)\?\.npcs;\n        return raw && Array\.isArray\(shown\) \? \{ \.\.\.raw, npcs: shown \} : raw;\n    \} catch \{ return raw; \}/);
    assert.equal((source.match(/npcApi\.getState\(\)|api\(\)\?\.getState/g) || []).length, 0, 'no raw reader left');
    assert.equal((source.match(/shownState\(/g) || []).length, 4);
});

// World → Here: a person the scene lists gets their card even when Delta's own stored flag says away, and the other way round.
const castScenario = async () => {
    const api = globalThis.NPCStateDelta;
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high' }], profileUpdates: [], keyRelationshipEdges: [] });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Who is at the gate?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun waves from the gate.', swipe_id: 0, swipes: ['Yunyun waves from the gate.'] });
    const id = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
    await sleep(400);
    const cards = () => (String(api.presentCastHtml?.() || '').match(/npc-state-delta-present-cell/g) || []).length;
    const storedHere = api.getState().npcs[0].present;
    mockState.scene = ['Yunyun'];
    const sceneHereStoredHere = cards();
    mockState.scene = [];
    const sceneAwayStoredHere = cards();
    // A later scan of a reply she has left: Delta's own stored flag goes to away, while the scene (the story's list) still has her.
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ id: api.getState().npcs[0].id, name: 'Yunyun', present: false, presenceConfidence: 1 }], profileUpdates: [], keyRelationshipEdges: [] });
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Where did she go?' });
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Yunyun has left for the city, far away. The gate is empty.', swipe_id: 0, swipes: ['Yunyun has left for the city, far away. The gate is empty.'] });
    await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(mockState.context.chat.length - 1)));
    await sleep(400);
    const injected = api.getState().npcs[0].present;
    mockState.scene = ['Yunyun'];
    const sceneHereStoredAway = cards();
    console.log('RESULT ' + JSON.stringify({ storedHere, sceneHereStoredHere, sceneAwayStoredHere, sceneHereStoredAway, injected }));
};

test('hosted: the present cards follow the scene, not the stored flag (World → Here drew chips while the stored flag said away)', () => {
    const out = resultOf(runHostScenario('presence-cards-hosted', hostedPrelude, castScenario));
    assert.equal(out.storedHere, true);
    assert.ok(out.sceneHereStoredHere > 0, 'scene and flag agree: a card');
    assert.equal(out.sceneAwayStoredHere, 0, 'the scene says away: no card');
    assert.ok(out.sceneHereStoredAway > 0, 'the scene says here and the stored flag says away: still a card');
    assert.equal(out.injected, false, 'the stored dossier is not written');
});
