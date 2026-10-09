import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildMapModel,
    DESKTOP_NODE_CAP,
    lensValue,
    mapAngles,
    mapRadius,
    mapStatus,
    normalizeRelationshipMapSettings,
    PHONE_NODE_CAP,
    relationshipDelta,
    resolveMapBonds,
    selectMapNpcs,
} from '../relationship-map-core.js';

const npc = (id, extra = {}) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), bucket: 'active', relationship: {}, keyRelationships: [], ...extra });

test('the radius follows the design curve, clamps and scales with the map', () => {
    assert.equal(mapRadius(0), 245);
    assert.equal(mapRadius(100), 60);
    assert.equal(mapRadius(-100), 360);
    assert.equal(mapRadius(250), 60, 'values clamp to +100');
    assert.equal(mapRadius(-250), 360, 'values clamp to -100');
    assert.equal(mapRadius(50), 245 - 50 * 1.85);
    assert.equal(mapRadius(-50), 245 + 50 * 1.15);
    assert.equal(mapRadius(0, 390), 122.5, 'a half-size map halves the radius');
    assert.ok(mapRadius(10) < mapRadius(0) && mapRadius(-10) > mapRadius(0), 'closer to the centre is higher');
});

test('lenses read the four relationship values, Warmth averaging trust and affection', () => {
    const rel = { trust: 38, affection: 22, desire: 6, tension: 14 };
    assert.equal(lensValue(rel, 'warmth'), 30);
    assert.equal(lensValue(rel, 'trust'), 38);
    assert.equal(lensValue(rel, 'affection'), 22);
    assert.equal(lensValue(rel, 'desire'), 6);
    assert.equal(lensValue(rel, 'tension'), 14);
    assert.equal(lensValue({ trust: 'x', affection: 900 }, 'warmth'), 50, 'non-numbers count as 0 and values clamp');
    assert.equal(lensValue(null, 'trust'), 0);
});

test('angles group NPCs by home base and never depend on relationship values', () => {
    const cast = [npc('a', { homeBase: 'Docks' }), npc('b', { homeBase: 'Heron' }), npc('c', { homeBase: 'docks' }), npc('d'), npc('e', { homeBase: 'Heron' })];
    const angles = mapAngles(cast);
    const order = [...angles.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    const groups = order.map(id => (cast.find(item => item.id === id).homeBase || '').toLowerCase());
    assert.deepEqual(groups.slice(0, 2), ['docks', 'docks'], 'same home base side by side, case-insensitive');
    assert.deepEqual(groups.slice(2, 4), ['heron', 'heron']);
    assert.equal(groups[4], '', 'NPCs without a home base come last');
    const moved = cast.map(item => ({ ...item, relationship: { trust: 90, affection: -40 } }));
    assert.deepEqual([...mapAngles(moved)], [...angles], 'changing values does not move anyone around the circle');
    assert.deepEqual([...mapAngles([...cast].reverse())], [...angles], 'input order does not matter');
    assert.equal(new Set(angles.values()).size, cast.length);
});

test('statuses follow the dossier buckets and scene flags', () => {
    assert.equal(mapStatus({ bucket: 'active', present: true }), 'scene');
    assert.equal(mapStatus({ bucket: 'active', worldActive: true }), 'active');
    assert.equal(mapStatus({ bucket: 'active' }), 'away');
    assert.equal(mapStatus({ bucket: 'archived', present: true }), 'archived');
    assert.equal(mapStatus({ bucket: 'dead' }), 'dead');
});

test('bonds resolve through social.js names and aliases; unresolved names draw nothing', () => {
    const cast = [
        npc('maelis', { name: 'Maelis Varn', keyRelationships: ['Ferrin Dole — cellar hand | trusted', 'Nobody Known — stranger', 'Kazuma — patron'] }),
        npc('ferrin', { name: 'Ferrin Dole', aliases: ['Ferr'], keyRelationships: ['Maelis Varn — employer'] }),
        npc('brenn', { name: 'Old Brenn', bucket: 'dead', keyRelationships: ['Ferr — old dock mate'] }),
    ];
    const all = new Set(cast.map(item => item.id));
    const bonds = resolveMapBonds(cast, all);
    assert.equal(bonds.length, 2, 'Maelis–Ferrin once, Brenn–Ferrin by alias; the player and unknown names draw nothing');
    const pair = bonds.find(bond => bond.a === 'ferrin' && bond.b === 'maelis');
    assert.deepEqual(pair.relation, { maelis: 'cellar hand', ferrin: 'employer' });
    assert.ok(bonds.some(bond => bond.a === 'brenn' && bond.b === 'ferrin'), 'a deceased counterpart is drawn when it is on the map');
    assert.equal(resolveMapBonds(cast, new Set(['maelis', 'ferrin'])).length, 1, 'a counterpart off the map draws nothing');
});

test('the delta badge shows only a change recorded on this turn', () => {
    const change = { turn: 58, delta: { trust: 4, affection: 2, desire: 0, tension: -3 } };
    assert.equal(relationshipDelta(change, 'warmth', 58), 3);
    assert.equal(relationshipDelta(change, 'tension', 58), -3);
    assert.equal(relationshipDelta(change, 'desire', 58), 0);
    assert.equal(relationshipDelta(change, 'trust', 59), 0, 'an older change shows no badge');
    assert.equal(relationshipDelta({ turn: null, delta: { trust: 4 } }, 'trust', 0), 0);
    const model = buildMapModel({ turn: 58, npcs: [npc('maelis', { lastRelationshipChange: change }), npc('ferrin', { lastRelationshipChange: { ...change, turn: 41 } })] }, { lens: 'trust' });
    assert.deepEqual(Object.fromEntries(model.nodes.map(node => [node.id, node.delta])), { maelis: 4, ferrin: 0 });
});

test('the map always shows the scene, caps the rest by strength, and keeps the selection', () => {
    const cast = [
        npc('here', { present: true }), npc('busy', { worldActive: true }),
        ...Array.from({ length: 40 }, (_, i) => npc(`n${i}`, { relationship: { trust: i - 20 } })),
        npc('gone', { bucket: 'archived', relationship: { trust: 99 } }),
        npc('dead', { bucket: 'dead', relationship: { trust: -99 } }),
    ];
    const desktop = selectMapNpcs(cast, { lens: 'trust', cap: DESKTOP_NODE_CAP });
    assert.equal(desktop.shown.length, 24);
    assert.equal(desktop.total, 42, 'past NPCs are not counted while Past is off');
    assert.ok(desktop.shown.some(item => item.id === 'here') && desktop.shown.some(item => item.id === 'busy'));
    assert.ok(desktop.shown.some(item => item.id === 'n0') && !desktop.shown.some(item => item.id === 'n20'), 'the strongest by the lens fill the cap');
    assert.equal(selectMapNpcs(cast, { lens: 'trust', cap: PHONE_NODE_CAP }).shown.length, 16, 'phones show 16');
    assert.ok(!desktop.shown.some(item => item.id === 'gone' || item.id === 'dead'), 'Past is off by default');
    const past = selectMapNpcs(cast, { lens: 'trust', showPast: true });
    assert.ok(past.shown.some(item => item.id === 'gone') && past.shown.some(item => item.id === 'dead'), 'Past adds archived and deceased NPCs under the same cap');
    assert.equal(past.total, 44);
    const kept = selectMapNpcs(cast, { lens: 'trust', selectedId: 'n20' });
    assert.equal(kept.shown.length, 25);
    assert.ok(kept.shown.some(item => item.id === 'n20'), 'the selected dossier is always on the map');
    assert.ok(selectMapNpcs(cast, { lens: 'trust', selectedId: 'dead' }).shown.some(item => item.id === 'dead'), 'a selected dead dossier shows even with Past off');
    const crowd = Array.from({ length: 30 }, (_, i) => npc(`p${i}`, { present: true }));
    assert.equal(selectMapNpcs(crowd, { cap: PHONE_NODE_CAP }).shown.length, 30, 'everyone in the scene is shown even past the cap');
});

test('the model lists every shown node with a position inside the map, and flags an all-neutral start', () => {
    const model = buildMapModel({ turn: 1, npcs: [npc('a', { present: true }), npc('b'), npc('c', { bucket: 'dead' })] }, { selectedId: 'a' });
    assert.deepEqual(model.nodes.map(node => node.id).sort(), ['a', 'b']);
    assert.ok(model.nodes.every(node => node.x > 0 && node.x < 100 && node.y > 0 && node.y < 100));
    assert.equal(model.allZero, true);
    assert.equal(model.selected.id, 'a');
    assert.deepEqual(model.selected.axes.map(axis => axis.on), [true, true, false, false], 'Warmth highlights trust and affection');
    assert.equal(model.selected.lastReason, '');
    const moved = buildMapModel({ turn: 1, npcs: [npc('a', { relationship: { tension: 30 } })] }, { lens: 'tension' });
    assert.equal(moved.allZero, false);
    assert.equal(buildMapModel({}, {}).nodes.length, 0);
    const lines = buildMapModel({ turn: 1, npcs: [npc('a', { keyRelationships: ['B — friend'] }), npc('b', { keyRelationships: ['C — rival'] }), npc('c')] }, { selectedId: 'a', allBonds: false }).lines;
    assert.deepEqual(lines.map(line => line.touches), [true], 'with All bonds off only the selected NPC\'s bonds are drawn');
});

test('settings normalize on read and fall back to defaults', () => {
    assert.deepEqual(normalizeRelationshipMapSettings(undefined), { enabled: true, defaultLens: 'warmth', showPast: false });
    assert.deepEqual(normalizeRelationshipMapSettings({ enabled: false, defaultLens: 'tension', showPast: true }), { enabled: false, defaultLens: 'tension', showPast: true });
    assert.deepEqual(normalizeRelationshipMapSettings({ enabled: 'no', defaultLens: 'love', showPast: 1, bondLines: 'all' }), { enabled: true, defaultLens: 'warmth', showPast: false });
});

test('the map is a read-only adapter wired through the existing owners', () => {
    const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const adapter = read('relationship-map.js');
    const core = read('relationship-map-core.js');
    assert.doesNotMatch(`${adapter}\n${core}`, /getDossierState|getState\(|setPortrait|update[A-Z]\w*\(|flush\(|generateRaw/, 'no state reads or writes');
    assert.match(adapter, /ui\.select\(node\)/, 'map selection goes through the dossier panel');
    assert.match(read('dossier-ui.js'), /\n    select\(npcId\) \{/);
    assert.match(read('index.js'), /settingsSlot\('relationship-map'\)/);
    assert.match(read('bootstrap.js'), /await import\('\.\/dossier-experience\.js'\);[\s\S]*await import\('\.\/relationship-map\.js'\);/);
    assert.match(adapter, /readMapSettings\(\)\.enabled/, 'turning the map off removes its switch, pane and link');
});
