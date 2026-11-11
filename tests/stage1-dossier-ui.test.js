import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseDossierSelection,
  dossierDetailProjection,
  dossierIndexProjection,
  dossierLifeBucket,
  dossierStatusLabel,
  filterDossierIndex,
  projectDossierState,
  sortDossierIndex,
} from '../dossier-ui.js';
import { dossierUiSource } from './helpers/dossier-ui-source.js';
import { DeltaDossierUi } from '../dossier-ui.js';
import { boardHtml, boardTiles } from '../dossier-ui-board.js';
import { libraryFaceHtml, libraryFootHtml, librarySearchHtml } from '../dossier-ui-library.js';
import { createPortraitRefs } from '../dossier-ui-html.js';
import { dialArcs, dialSvg } from '../dossier-ui-dial.js';
import { dossierMenuHtml } from '../dossier-ui-header.js';
import { v2MetersProjection } from '../dossier-ui-meters.js';
import { dossierProfileHtml } from '../dossier-ui-profile.js';
import { SECTION_KEYS, createScreenState, escapeAction, goBack, layoutFor, openNpc, openSection, parseScreen, screenSignature, setSection, showScreen, stepSection, swipeStep } from '../dossier-ui-screens.js';
import { sectionHeaderHtml, sectionScreenHtml } from '../dossier-ui-sections.js';
import { boardModel, bondTone, libraryTone } from '../dossier-ui-view-model.js';


const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const uiSource = dossierUiSource();
const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');

const cast = [
  { id: 'mira', name: 'Mira', role: 'Scout', species: 'Human', homeBase: 'Northwatch Lodge', present: false, worldActive: true, location: 'North road' },
  { id: 'sora', name: 'Sora', aliases: ['Stormcrown'], role: 'Ward', species: 'Chimera', present: true, worldActive: false, mood: 'Curious', relationship: { trust: 12 } },
  { id: 'old', name: 'Old Clerk', role: 'Clerk', archived: true, archiveReason: 'stale' },
  { id: 'fallen', name: 'Fallen Guard', role: 'Guard', archived: true, archiveReason: 'deceased', lifeState: 'dead' },
];

test('Stage 1 lifecycle buckets are presentation-only and expose active archived dead filters', () => {
  assert.equal(dossierLifeBucket(cast[0]), 'active');
  assert.equal(dossierLifeBucket(cast[2]), 'archived');
  assert.equal(dossierLifeBucket(cast[3]), 'dead');
  assert.equal(dossierStatusLabel(cast[1]), 'In chat');
  assert.equal(dossierStatusLabel(cast[0]), 'Active off-screen');
  assert.equal(dossierStatusLabel(cast[2]), 'Archived · stale');
  assert.equal(dossierStatusLabel(cast[3]), 'Deceased');
});

test('Stage 1 cast ordering keeps present and active dossiers first', () => {
  const rows = sortDossierIndex(cast.map(npc => dossierIndexProjection(npc)));
  assert.deepEqual(rows.map(row => row.id), ['sora', 'mira', 'old', 'fallen']);
});

test('Stage 1 cast search and lifecycle filters compose', () => {
  const rows = cast.map(npc => dossierIndexProjection(npc));
  assert.deepEqual(filterDossierIndex(rows, { query: 'stormcrown' }).map(row => row.id), ['sora']);
  assert.deepEqual(filterDossierIndex(rows, { query: 'north road', filter: 'active' }).map(row => row.id), ['mira']);
  assert.deepEqual(filterDossierIndex(rows, { query: 'northwatch lodge', filter: 'active' }).map(row => row.id), ['mira']);
  assert.deepEqual(filterDossierIndex(rows, { filter: 'archived' }).map(row => row.id), ['old']);
  // Since 1.1.4 the dead are left out of the list and found by search (see v114-hide-dead).
  assert.deepEqual(filterDossierIndex(rows, { query: 'fallen' }).map(row => row.id), ['fallen']);
});

test('Stage 1 selection survives updates while the selected dossier remains visible', () => {
  const rows = sortDossierIndex(cast.map(npc => dossierIndexProjection(npc)));
  const visible = filterDossierIndex(rows, { filter: 'active' });
  assert.equal(chooseDossierSelection('mira', visible, rows), 'mira');
  assert.equal(chooseDossierSelection('old', visible, rows), 'sora');
  assert.equal(chooseDossierSelection('', [], rows), 'sora');
  const updated = rows.map(row => row.id === 'mira' ? { ...row, status: 'Moving' } : row);
  assert.equal(chooseDossierSelection('mira', filterDossierIndex(updated, { filter: 'active' }), updated), 'mira');
});

test('Stage 1 projections stay read-only and discard heavy history fields', () => {
  const source = {
    turn: 9,
    portraitAssets: { sora: { dataUrl: 'data:image/png;base64,AA==' } },
    npcs: [{
      ...cast[1],
      appearance: 'Golden-blue hair.',
      behaviorProfile: ['Observant', 'Proud'],
      memories: ['First meeting'],
      relationshipHistory: [{ reason: 'heavy history should not reach the view projection' }],
      branchSnapshots: [{ huge: true }],
    }],
  };
  const before = structuredClone(source);
  const projected = projectDossierState(source, { chatKey: 'chat-1', hydrationStatus: 'ready' });
  assert.deepEqual(source, before);
  assert.equal(projected.turn, 9);
  assert.equal(projected.npcs[0].portrait, 'data:image/png;base64,AA==');
  assert.equal(projected.npcs[0].relationship.trust, 12);
  assert.equal('relationshipHistory' in projected.npcs[0], false);
  assert.equal('branchSnapshots' in projected.npcs[0], false);
});

test('Stage 1 no-chat projection does not create or mutate dossier state', () => {
  const projected = projectDossierState({}, { chatKey: 'no-chat', hydrationStatus: 'ready' });
  assert.equal(projected.chatKey, 'no-chat');
  assert.deepEqual(projected.npcs, []);
  assert.deepEqual(projected.index, []);
});

test('Detail projection preserves editable fields and leaves flat current appearance scalar-only', () => {
  const projected = dossierDetailProjection({
    id: 'ryu', name: 'Ryu', species: 'Chimera', homeBase: 'Towerhouse', age: '6 years', apparentAge: '~6',
    appearance: 'Long silver hair.', personality: 'Composed', speech: 'Precise',
    behaviorProfile: ['Analytical'], mannerisms: ['Studies details'], background: 'Unknown past',
    mood: 'Calm', location: 'Towerhouse', goal: 'Observe', status: 'Well',
    keyRelationships: ['Lucien - guardian'], memories: ['Learned to read'],
    relationshipSummary: 'Quiet trust', relationship: { trust: 9, affection: 4, desire: 0, tension: -2 },
  });
  assert.equal(projected.appearance, 'Long silver hair.');
  assert.equal(projected.homeBase, 'Towerhouse');
  assert.deepEqual(projected.behaviorProfile, ['Analytical']);
  assert.equal(projected.relationship.trust, 9);
  assert.deepEqual(projected.appearanceModel.appearanceForms, []);
  assert.equal(projected.appearanceModel.currentForm, '');
});

test('Stage 1 UI is a thin adapter over the existing runtime editor/settings owners', () => {
  assert.match(uiSource, /this\.api\.openEditor\(id\)/);
  assert.match(uiSource, /Behavioural levers/);
  assert.match(uiSource, /relationshipSummary/, 'the player dynamic reads in the With section');
  assert.match(uiSource, /\['Condition', escapeHtml\(plain\(npc\.status\)\)\]/);
  assert.match(uiSource, /currentCard\('Home base'/);
  assert.doesNotMatch(uiSource, /proseHtml\(selected\.appearance\)/, 'resolved flat appearance must not be rendered beside the form model');
  assert.match(uiSource, /npc_state_delta_settings/);
  assert.match(uiSource, /MutationObserver/);
  assert.doesNotMatch(uiSource, /persistCritical\s*\(/);
  assert.doesNotMatch(uiSource, /applyNpcStateCommand\s*\(/);
  assert.doesNotMatch(uiSource, /relationshipDelta\s*=/);
  assert.doesNotMatch(uiSource, /scanNow\s*\(/);
});

test('Stage 1 UI loads after the canonical legacy runtime and remains package-reachable', () => {
  const engine = bootstrap.indexOf("await import('./index.js')");
  const ui = bootstrap.indexOf("await import('./dossier-ui.js')");
  assert.ok(engine >= 0, 'canonical runtime import missing');
  assert.ok(ui > engine, 'Stage 1 UI must load after the canonical runtime API exists');
});

test('bond tone: close, hostile, duty and neutral relations', async () => {
  const { bondTone } = await import('../dossier-ui-bond-tone.js');
  assert.equal(bondTone('mother'), 'close');
  assert.equal(bondTone('rival'), 'hostile');
  assert.equal(bondTone('former friend turned enemy'), 'hostile');
  assert.equal(bondTone('owes him a debt'), 'duty');
  assert.equal(bondTone('colleague'), 'neutral');
  assert.equal(bondTone(''), 'neutral');
});

const rika = {
  id: 'rika', name: 'Rika', species: 'human', gender: 'female', role: 'mage', statusLabel: 'Active', mood: 'alarmed', key: { here: true },
  relationship: { trust: 11, affection: 10, desire: 6, tension: 13 }, relationshipSummary: 'Prickly but grateful.',
  lastRelationshipChange: { impact: 'meaningful', delta: { trust: 2, tension: -1 }, reason: 'shared a meal', message: 4 },
  recentRelationshipChanges: [{ impact: 'ordinary', reason: 'bickered', message: 3 }],
  keyRelationships: ['Temiwa — friend: shelters her', 'Vane — rival: old grudge', 'Guild — owes a debt: dues', 'a loose fragment'],
  memories: ['Fled by raft', 'Found by Temiwa'], background: 'Left half-dead at the gatehouse.', cast: { where: 'the docks', doing: 'mending a net', goal: 'register' },
  v2Meters: { secrets: [{ state: 'open', title: 'Her past', text: 'Winter Gate', pill: 'Opened' }, { state: 'hidden', opens: 'Opens at Trust 25', width: 44 }] },
};

test('bond tone: green for kin and friends, red for rivals and enemies, gold for debts and duties, grey otherwise', () => {
  for (const word of ['friend', 'mother', 'sister', 'partner', 'mentor', 'student', 'guardian', 'ward', 'cousin']) assert.equal(bondTone(word), 'good', word);
  for (const word of ['rival', 'sworn enemy', 'nemesis', 'hates']) assert.equal(bondTone(word), 'bad', word);
  for (const word of ['owes a debt', 'owes her life', 'duty-bound', 'sworn oath']) assert.equal(bondTone(word), 'gold', word);
  for (const word of ['employer', 'acquaintance', '', null, undefined]) assert.equal(bondTone(word), 'grey', String(word));
  assert.equal(libraryTone({ trust: 30 }), 'ally');
  assert.equal(libraryTone({ trust: -30 }), 'rival');
  assert.equal(libraryTone({ trust: 5, tension: 60 }), 'rival');
  assert.equal(libraryTone({ trust: 5, affection: 5 }), '');
  assert.equal(libraryTone(undefined), '');
});

test('the library index rows carry the ring tone from the meters', () => {
  const state = projectDossierState({ npcs: [{ id: 'a', name: 'A', relationship: { trust: 40 } }, { id: 'b', name: 'B', relationship: { trust: -40 } }, { id: 'c', name: 'C' }] }, { chatKey: 'c', hydrationStatus: 'ready' });
  assert.deepEqual(Object.fromEntries(state.index.map(row => [row.id, row.tone])), { a: 'ally', b: 'rival', c: undefined });
});

test('the board model reads only stored fields: dial, tiles, no Pull, and missing fields do not throw', () => {
  const model = boardModel(rika);
  assert.deepEqual(model.dial.map(item => [item.axis, item.value]), [['trust', 11], ['affection', 10], ['desire', 6], ['tension', 13]]);
  assert.equal(model.tiles.pull, null, 'Pull waits for phase-2 data');
  assert.deepEqual(model.tiles.lastChange.moved.map(item => item.value), [2, -1]);
  assert.equal(model.tiles.ties.count, 4);
  assert.equal(model.tiles.past.latest, 'Found by Temiwa');
  assert.deepEqual([model.tiles.secrets.total, model.tiles.secrets.open, model.tiles.secrets.next], [2, 1, 'Opens at Trust 25']);
  const empty = boardModel({});
  assert.equal(empty.name, 'Unnamed NPC');
  assert.equal(empty.tiles.ties.count, 0);
  assert.equal(boardModel(null).tiles.secrets.total, 0);
  assert.equal(boardModel({ relationship: { trust: 999 } }).dial[0].value, 100, 'clamped to the meter range');
});

test('the dial draws four arcs from the meters and escapes its labels', () => {
  const arcs = dialArcs({ trust: 50, affection: -100, desire: 0, tension: 100 });
  assert.deepEqual(arcs.map(arc => [arc.axis, arc.value, Boolean(arc.path), arc.negative]), [['trust', 50, true, false], ['affection', -100, true, true], ['desire', 0, false, false], ['tension', 100, true, false]]);
  const svg = dialSvg({ trust: 11 });
  assert.match(svg, /aria-label="Meter dial: trust \+11/);
  assert.match(svg, /dial-arc/);
  assert.doesNotMatch(svg, /<script/);
});

test('the board shows the tiles in order with the player\'s name, escapes text and never inlines a portrait', () => {
  const refs = createPortraitRefs();
  const html = boardHtml({ ...rika, name: '<img src=x>', mood: '<b>', portrait: 'data:image/png;base64,AAAA' }, { userName: 'Astra', refs });
  assert.doesNotMatch(html, /<img src=x>|<b>/);
  assert.match(html, /With Astra · Last change/);
  assert.doesNotMatch(html, /Pull/i);
  assert.doesNotMatch(html, /data:image/, 'the portrait goes through refs, not the markup');
  assert.match(html, /data-delta-portrait="\d+"/);
  assert.match(html, /data-delta-screen="profile"/);
  for (const section of ['with', 'now', 'ties', 'past', 'secrets']) assert.match(html, new RegExp(`data-delta-section="${section}"`), section);
  assert.match(html, /Human · Female · Mage/, 'each identity part keeps its words with the first letter capitalised');
  // Mood tile: the word plus both bars, also for a person with no hosted mood (a mid-step rest) and no scanner word (the resting word).
  assert.match(html, /Energy[\s\S]*Control/);
  const rest = boardHtml({ ...rika, mood: '', v2Meters: undefined }, {});
  assert.match(rest, /delta-tile-bar"><span>Energy<\/span><i><b style="width:50%">[\s\S]*Control<\/span><i><b style="width:50%">/);
  assert.match(boardHtml({ id: 'x', name: 'Marrit', gender: 'male', role: 'bargemaster' }, {}), /Male · Bargemaster/);
});

test('sections: five screens with arrows and dots; hidden secrets never show their words; bond tones', () => {
  assert.deepEqual([...SECTION_KEYS], ['now', 'with', 'ties', 'past', 'secrets']);
  const head = sectionHeaderHtml('now', { npcName: 'Rika', userName: 'Astra' });
  assert.match(head, /Rika · 1 of 5/);
  assert.match(head, /data-delta-section-step="-1"[^>]*disabled/, 'no previous before the first');
  assert.doesNotMatch(sectionHeaderHtml('secrets', {}), /data-delta-section-step="1"[^>]*aria-label="Next section"><|data-delta-section-step="1"[^>]*>(?!›)/);
  assert.match(sectionHeaderHtml('secrets', {}), /data-delta-section-step="1"[^>]*disabled/, 'no next after the last');
  assert.match(sectionHeaderHtml('with', { userName: 'Astra' }), /With Astra/);
  const now = sectionScreenHtml('now', rika, {});
  assert.match(now, /mending a net/);
  const ties = sectionScreenHtml('ties', rika, {});
  assert.match(ties, /data-tone="good"[^>]*>[\s\S]*Temiwa/);
  assert.match(ties, /data-tone="bad"/);
  assert.match(ties, /data-tone="gold"/);
  assert.match(ties, /a loose fragment/, 'an entry that does not parse is shown as written');
  assert.match(sectionScreenHtml('past', rika, {}), /Fled by raft/);
  const secrets = sectionScreenHtml('secrets', rika, {});
  assert.match(secrets, /Her past/);
  assert.match(secrets, /Opens at Trust 25/);
  const hidden = sectionScreenHtml('secrets', { v2Meters: { secrets: [{ state: 'hidden', title: 'LEAK', text: 'LEAK', opens: 'Opens at Trust 25', width: 40 }] } }, {});
  assert.doesNotMatch(hidden, /LEAK/);
  assert.match(sectionScreenHtml('with', rika, { userName: 'Astra' }), /Prickly but grateful/);
  assert.equal(sectionScreenHtml('nope', rika, {}), '');
  assert.match(sectionScreenHtml('past', {}, {}), /Nothing remembered yet/, 'a bare record still draws');
  assert.doesNotMatch(sectionScreenHtml('now', { ...rika, mood: '<script>' }, {}), /<script>/);
});

test('the profile: portrait first, identity and appearance, phone and desktop layouts, stale-portrait note', () => {
  const phone = dossierProfileHtml({ ...dossierDetailProjection({ id: 'rika', name: 'Rika', age: '19', homeBase: 'Bluewatch' }), portraitAppearanceChanged: true }, { layout: 'phone' });
  assert.match(phone, /delta-profile-phone/);
  assert.match(phone, /data-delta-screen="board"[^>]*>‹ Board/);
  assert.match(phone, /Appearance changed since portrait/);
  const desktop = dossierProfileHtml(rika, { layout: 'desktop' });
  assert.match(desktop, /delta-profile-desktop/);
  assert.match(desktop, /T \+11 · A \+10 · D \+6 · Te \+13/);
  assert.match(desktop, /delta-profile-cols/);
  assert.doesNotMatch(dossierProfileHtml({ name: '<i>x' }, {}), /<i>x/);
});

test('screens: back, section arrows, Esc order, swipe, layout and the signature a refresh keeps', () => {
  let state = createScreenState();
  assert.equal(escapeAction(state), 'close', 'the library closes the panel');
  state = openNpc(state, 'rika');
  assert.deepEqual([state.name, state.npcId], ['board', 'rika']);
  state = openSection(state, 2);
  assert.equal(screenSignature(state), 'rika|section:2');
  state = stepSection(stepSection(state, 1), 1);
  assert.equal(state.section, 4);
  assert.equal(stepSection(state, 1).section, 4, 'clamped at the last section');
  assert.equal(setSection(state, 0).section, 0);
  assert.equal(escapeAction(state, { blocked: true }), 'none', 'the editor or lightbox keeps Esc');
  assert.equal(escapeAction(state), 'back');
  state = goBack(state);
  assert.equal(state.name, 'board');
  state = goBack(goBack(showScreen(state, 'profile')));
  assert.equal(state.name, 'library');
  assert.equal(goBack(createScreenState()).name, 'library');
  assert.equal(showScreen(createScreenState(), 'board').name, 'library', 'a board needs an NPC');
  assert.deepEqual(parseScreen('section:9'), { name: 'section', section: 0 });
  assert.equal(parseScreen('nonsense').name, 'library');
  assert.equal(swipeStep(-80, 5), 1);
  assert.equal(swipeStep(80, 5), -1);
  assert.equal(swipeStep(60, 90), 0, 'a vertical swipe is a scroll');
  assert.deepEqual(layoutFor(openSection(openNpc(createScreenState(), 'a'), 1)).panes, ['dial', 'board', 'section']);
  assert.deepEqual(layoutFor(openSection(openNpc(createScreenState(), 'a'), 1), { phone: true }).panes, ['section']);
});

test('header menu keeps the classes and data-npc-id the global Edit, Refresh, Scan and Archive handlers find', () => {
  const html = dossierMenuHtml('npc_"x', { archived: false });
  for (const hook of ['delta-edit', 'npc-state-delta-refresh-chat', 'npc-state-delta-scan-dossier', 'delta-experience-portrait', 'delta-experience-diagnostics', 'npc-state-delta-archive-npc']) assert.match(html, new RegExp(hook), hook);
  assert.match(html, /data-npc-id="npc_&quot;x"/, 'the id is escaped');
  assert.match(html, /<summary class="delta-btn">More<\/summary>/);
  assert.match(dossierMenuHtml('a', { archived: true }), /npc-state-delta-restore-npc[^>]*>Restore active/);
  assert.match(dossierMenuHtml('a', { deceased: true }), /Correct death record/);
  assert.equal(dossierMenuHtml(''), '');
});

test('Dossier style: the skin tokens exist for all three looks and the panel root carries data-skin', () => {
  const styles = fs.readFileSync(path.join(root, 'dossier-ui-styles-board.js'), 'utf8');
  const skin = fs.readFileSync(path.join(root, 'dossier-skin.js'), 'utf8');
  assert.match(styles, /:not\(\[data-skin\]\), \$\{PANEL\}\[data-skin="neutral"\]/, 'Neutral is the default, with or without the attribute');
  assert.match(styles, /\[data-skin="fantasy"\]/);
  assert.match(styles, /\[data-skin="modern"\]/);
  assert.match(skin, /DOSSIER_SKIN_DEFAULT = 'neutral'/);
  assert.match(skin, /element\.dataset\.skin = value/);
  assert.doesNotMatch(styles + skin, /fonts\.googleapis|@import|@font-face/, 'no web font loading');
});

function stubNode() {
  const node = { html: '', dataset: {}, hidden: false, textContent: '', scrollTop: 0, images: [] };
  Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: value => { node.html = String(value); node.images = [...node.html.matchAll(/<img class="[^"]+" (?:data-delta-portrait="\d+"|src="[^"]*")/g)].map(() => ({ dataset: {}, hasAttribute: () => false })); } });
  node.querySelector = () => null;
  node.querySelectorAll = () => [];
  node.setAttribute = () => {};
  return node;
}

test('the panel walks library, board, section and profile from one projection; a refresh keeps the screen; Esc goes back before it closes', async () => {
  const saved = { document: globalThis.document, CSS: globalThis.CSS };
  globalThis.document = { activeElement: null, createElement: () => ({}), getElementById: () => null };
  globalThis.CSS = { escape: value => value };
  try {
    let token = 't1';
    const state = { npcs: [{ ...rika, key: undefined }, { id: 'b', name: 'Bo' }] };
    const api = { dossierViewStatus: () => ({ chatKey: 'c1', hydrationStatus: 'ready' }), getDossierState: () => state, dossierViewToken: () => token, uiStatus: () => ({}) };
    const ui = new DeltaDossierUi(api);
    const doc = stubNode();
    const list = stubNode();
    doc.querySelector = selector => (selector === '[data-delta-library-list]' ? list : null);
    const slot = stubNode();
    slot.html = '<button class="delta-edit" data-npc-id="rika">Edit</button>';
    const nodes = { '.delta-document': doc, '.delta-stage': stubNode(), '.delta-empty': stubNode(), '.delta-notice': stubNode(), '.delta-chat-state': stubNode(), '.delta-header-slot': slot };
    let rendered = 0;
    ui.root = { querySelector: selector => nodes[selector] ?? null, querySelectorAll: () => [], dispatchEvent: () => { rendered += 1; } };
    ui.panelOpen = true;
    await ui.refresh({ force: true });
    assert.equal(doc.dataset.screen, 'library');
    assert.match(list.html, /data-npc-id="rika"/);
    ui.setScreen(openNpc(ui.screen, 'rika'));
    assert.equal(ui.selectedNpcId, 'rika');
    assert.match(doc.html, /data-screen="board"/);
    ui.setScreen(openSection(ui.screen, 2));
    assert.match(doc.html, /data-delta-section-head="ties"/);
    assert.match(doc.html, /data-pane="board"[\s\S]*data-pane="section"/, 'desktop: the board beside the section');
    token = 't2';
    state.npcs[0] = { ...state.npcs[0], mood: 'calm' };
    await ui.refresh();
    assert.equal(ui.screen.name, 'section', 'a refresh does not reset the screen');
    assert.equal(ui.screen.section, 2);
    ui.setScreen(showScreen(ui.screen, 'profile'));
    assert.match(doc.html, /delta-profile-desktop/);
    assert.equal(ui.goBackOrClose(), 'back');
    assert.equal(ui.screen.name, 'section');
    ui.goBackOrClose();
    ui.goBackOrClose();
    assert.equal(ui.screen.name, 'library');
    ui.close = () => { ui.panelOpen = false; };
    assert.equal(ui.goBackOrClose(), 'close');
    assert.equal(ui.panelOpen, false);
    // A request from outside (a present-cast card) opens that dossier's board after the reset; a dossier that vanishes returns to the library.
    ui.panelOpen = true;
    ui.pendingNpcId = 'b';
    await ui.refresh({ force: true });
    assert.deepEqual([ui.screen.name, ui.selectedNpcId], ['board', 'b']);
    state.npcs = [state.npcs[0]];
    await ui.refresh({ force: true });
    assert.equal(ui.screen.name, 'library');
    assert.ok(rendered > 0);
    // The ⋯ menu is outside the redrawn pane: another chat, or one still loading, leaves none of the old buttons live.
    api.dossierViewStatus = () => ({ chatKey: 'no-chat', hydrationStatus: 'ready' });
    slot.innerHTML = '<button class="delta-edit" data-npc-id="rika">Edit</button>';
    await ui.refresh({ force: true });
    assert.equal(slot.html, '');
    api.dossierViewStatus = () => ({ chatKey: 'c2', hydrationStatus: 'loading' });
    slot.innerHTML = '<button class="delta-edit" data-npc-id="rika">Edit</button>';
    await ui.refresh({ force: true });
    assert.equal(slot.html, '');
  } finally {
    globalThis.document = saved.document;
    globalThis.CSS = saved.CSS;
  }
});

test('the board matches the approved tiles: lead move, place in the title, faces by bond tone, secrets ring with its note', () => {
  const npc = {
    id: 'rika', name: 'Rika', mood: 'alarmed', location: 'Northern Ridge', cast: { doing: 'Crouched at the lip' },
    relationship: { trust: 5, affection: 0, desire: 0, tension: 2 },
    lastRelationshipChange: { impact: 'meaningful', delta: { tension: 2, trust: 0, affection: 0, desire: 0 }, reason: 'praise backfired', turn: 3 },
    keyRelationships: ['Temiwa: friend | kind', 'Bregje: rival | loud'], memories: ['a', 'the basilisk fell'],
    v2Meters: { secrets: [{ state: 'open', title: 'Winter Gate Debt', text: 't', pill: 'Opened' }, { state: 'hidden', opens: 'Opens at Trust 25', width: 55 }] },
  };
  const tiles = boardTiles(boardModel(npc), { userName: 'Astra' });
  const by = title => tiles.find(tile => tile.title.startsWith(title));
  assert.equal(by('With Astra').lead, 'Tension +2');
  assert.equal(by('Right now').title, 'Right now · Northern Ridge', 'the place joins the title when the body is what she is doing');
  assert.equal(by('Past').title, 'Past · 2');
  assert.equal(by('Secrets').note, 'Winter Gate Debt opened · the next opens at Trust 25', 'no doubled "opens"');
  const html = boardHtml(npc, { userName: 'Astra', peers: new Map([['temiwa', 'data:image/png;base64,AAAA']]) });
  assert.match(html, /delta-tile-face-ring" style="--r:var\(--good\)"/);
  assert.match(html, /delta-tile-face-ring" style="--r:var\(--bad\)"/);
  assert.match(html, /delta-board-hero/);
});

test('the library face shows the mood (the dossier status when archived), the foot goes back to the library, the search counts people', () => {
  const face = libraryFaceHtml({ id: 'a', name: 'Aster', bucket: 'active', mood: 'steady', statusLabel: 'In chat', key: true });
  assert.match(face, /★ key · steady/);
  assert.match(libraryFaceHtml({ id: 'b', name: 'Bryn', bucket: 'archived', mood: 'calm', statusLabel: 'Archived' }), /Archived/);
  assert.match(libraryFootHtml(10), /data-delta-screen="library"[^>]*>▸ Dossier library · 10 NPCs/);
  assert.match(librarySearchHtml('', 10), /placeholder="Search 10 people…"/);
});

test('phase 2 UI: mood bars, pull ring, gate wording, tags, redacted lies and secrets, tastes, drives, look note; none without data', async () => {
  const { v2MetersProjection } = await import('../dossier-ui-meters.js');
  const { sectionScreenHtml } = await import('../dossier-ui-sections.js');
  const { dossierProfileHtml } = await import('../dossier-ui-profile.js');
  const meters = v2MetersProjection({
    bars: [], rank: '', next: '', milestones: [], secrets: [],
    mood: { word: 'alarmed · tense', bars: { energy: 5, control: 1, max: 6 }, cause: 'trust dropped: Astra lied' },
    pull: { kind: 'closure', level: 3, days: 2, cause: 'an open thread' },
    notes: {
      lies: [{ hidden: false, to: 'Astra', said: 'I sold nothing', day: 3, caught: { day: 4 } }, { hidden: true, said: 'SECRET WORDS', to: 'Astra', day: 5 }],
      knows: [{ about: 'X', how: 'saw', day: 2, secret: true, hidden: true, text: 'a secret about X · hidden' }, { about: 'Y', how: 'heard', day: 3, text: 'Y owes a debt', secret: false, hidden: false }],
      tastes: [{ sign: '+', item: 'toffee', from: 'barge crews' }, { sign: '-', item: 'paperwork', mirrored: true }],
      ties: [{ name: 'Temiwa', tags: ['ally'] }, { name: 'Vane', tags: ['owes'] }, { name: 'Bregje', tags: [], owedBy: true }],
      drives: [{ label: 'Conflict', strength: 3, word: 'high' }], look: { day: 3 },
    },
  });
  const npc = {
    id: 'r', name: 'Rika', mood: 'old', v2Meters: meters, memories: ['m1'],
    relationship: { trust: 1, affection: 0, desire: 0, tension: 0 },
    keyRelationships: ['Temiwa: friend | kind', 'Vane: colleague | covered her', 'Bregje: colleague | clerk'],
    lastRelationshipChange: { impact: 'net', delta: { trust: 0, affection: 0, desire: 0, tension: 2 }, reason: '', hosted: true, message: 3, event: { tier: 'meaningful', held: false, note: '', ask: {}, date: '', gate: 'via praise · 3rd in 2 days · backfired' } },
  };
  const tiles = boardTiles(boardModel(npc), { userName: 'Astra' });
  assert.equal(tiles.find(tile => tile.title === 'Mood').bars.length, 2);
  assert.equal(tiles.find(tile => tile.title === 'Mood').big, 'alarmed · tense');
  assert.equal(tiles.find(tile => tile.title === 'Pull').note, 'high · 2 days');
  assert.match(boardHtml(npc, { userName: 'Astra' }), /3rd in 2 days · backfired/);
  const ties = sectionScreenHtml('ties', npc);
  assert.match(ties, />ally</); assert.match(ties, />owes</); assert.match(ties, />owed by</);
  assert.match(ties, /a lie you have not caught/);
  assert.doesNotMatch(ties, /SECRET WORDS|a secret about/);
  assert.match(ties, /I sold nothing/); assert.match(ties, /Y owes a debt/);
  assert.match(sectionScreenHtml('now', npc), /trust dropped: Astra lied/);
  const profile = dossierProfileHtml({ ...dossierDetailProjection({ id: 'r', name: 'Rika' }, {}, {}), v2Meters: meters }, { layout: 'phone' });
  assert.match(profile, /toffee/); assert.match(profile, /Conflict/); assert.match(profile, /look was set on day 3/);
  const bare = { ...npc, v2Meters: v2MetersProjection({ bars: [], secrets: [] }) };
  const none = boardTiles(boardModel(bare), { userName: 'Astra' });
  assert.equal(none.find(tile => tile.title === 'Pull'), undefined, 'no pull tile without data');
  assert.doesNotMatch(sectionScreenHtml('ties', bare), /Lies told|Knows about/);
  assert.doesNotMatch(dossierProfileHtml({ ...dossierDetailProjection({ id: 'r', name: 'Rika' }, {}, {}), v2Meters: bare.v2Meters }, { layout: 'phone' }), /Tastes|Drives|look was set/);
});

// The dossier's stylesheets as the page gets them (the template numbers filled in), plus the source for the pins that read it.
async function builtCss() {
  const [a, b, c] = await Promise.all([import('../dossier-ui-styles.js'), import('../dossier-ui-styles-board.js'), import('../dossier-ui-styles-sections.js')]);
  return `${dossierUiSource()}\n${a.STYLES}\n${b.BOARD_STYLES}\n${c.SECTIONS_STYLES}`;
}

test('the dial\'s no-portrait fallback is small initials in the suite font stack, and the desktop layout fits a narrow panel and sizes to its content', async () => {
  const html = boardHtml({ id: 'm', name: 'Marrit' }, {});
  assert.match(html, /delta-portrait-placeholder[^>]*><span>M<\/span>/);
  const css = await builtCss();
  assert.doesNotMatch(css.match(/dossier-dial-portrait \.delta-portrait-placeholder \{[^}]*\}/)?.[0] || '', /Georgia|serif;|font-size:48px/);
  assert.match(css, /\.delta-board \{ grid-template-columns:clamp\(250px,32%,460px\)/);
  assert.match(css, /@media \(min-width: 1101px\) \{\s*#\$\{ROOT_ID\} \.delta-panel \{ height:auto;/);
});

test('the dossier layout follows its own container width: container queries, one switch line, no window query, bar in the flow', async () => {
  const css = await builtCss();
  const screens = await import('../dossier-ui-screens.js');
  assert.match(css, /container:dsr \/ inline-size/);
  assert.match(css, new RegExp(`@container dsr \\(min-width: ${screens.TWO_PANE_MIN}px\\)`));
  assert.match(css, new RegExp(`@container dsr \\(max-width: ${screens.TWO_PANE_MIN - 0.02}px\\)`));
  assert.equal(screens.THREE_PANE_MIN, screens.PANE_HERO_SLIM_MIN + screens.PANE_TILES_MIN + screens.PANE_SECTION_WIDE_MIN, 'the three-pane line is a sum of the pane minimums');
  assert.equal(screens.TWO_PANE_MIN, screens.PANE_HERO_MIN + screens.PANE_SECTION_MIN);
  assert.match(css, new RegExp(`@container dsr \\(min-width: ${screens.TWO_PANE_MIN}px\\) and \\(max-width: ${screens.THREE_PANE_MIN - 0.02}px\\)`));
  assert.doesNotMatch(css, /@media \((min|max)-width: 65[01]px\)\s*\{\s*#\$\{ROOT_ID\} \.delta-(board|panes|profile|brand|topbar)/);
  assert.doesNotMatch(css, /position:sticky; bottom:0; display:block;/, 'the library bar sits in the flow under the scroll area');
  // the switch reads the panel width, not the window: a 500 px panel in a 2000 px window is narrow, a 700 px one is not
  const panel = width => ({ clientWidth: width });
  assert.equal(screens.isNarrow(panel(500), { innerWidth: 2000 }), true);
  assert.equal(screens.isNarrow(panel(700), { innerWidth: 400 }), false);
  assert.equal(screens.isNarrow(null, { innerWidth: 400 }), true);
  // the name has its own class with resets, so a host theme's heading rules cannot restyle it
  assert.match(boardHtml({ id: 'm', name: 'Marrit' }, {}), /<h3 class="delta-board-title">Marrit<\/h3>/);
  assert.match(css, /\.delta-board-title \{[^}]*border-left:0 !important[^}]*text-align:center !important/);
  assert.match(dossierProfileHtml({ ...dossierDetailProjection({ id: 'r', name: 'Rika' }, {}, {}) }, { layout: 'phone' }), /<h2 class="delta-profile-title">Rika<\/h2>/);
  assert.match(css, /\.delta-header-menu > summary\.delta-btn \{ display:inline-flex; align-items:center; justify-content:center;/);
});

test('fix 3: two-letter initials, mood bars in Right now, flat profile rows in the mockup order, count bar on the library, no debug wording', async () => {
  const { initialsOf, portraitHtml } = await import('../dossier-ui-html.js');
  assert.equal(initialsOf('The inspector'), 'TI');
  assert.equal(initialsOf('Marrit'), 'M');
  assert.match(portraitHtml({ name: 'Sister Temiwa' }, 'x'), /<span>ST<\/span>/);
  const now = sectionScreenHtml('now', { id: 'n', name: 'Marrit', mood: 'Cautious' });
  assert.match(now, /<dt>Mood<\/dt><dd><b>Cautious<\/b><\/dd>[\s\S]*delta-now-bars[\s\S]*Feeling[\s\S]*Energy[\s\S]*Control/, 'Mood: the word and the three bars across the row, at rest as well');
  assert.match(sectionScreenHtml('now', { id: 'n', name: 'Marrit' }), /<dt>Mood<\/dt><dd><b>[^<]+<\/b><\/dd>[\s\S]*delta-now-bars/, 'also with no mood word at all');
  const npc = { ...dossierDetailProjection({ id: 'r', name: 'Rika' }, {}, {}), appearanceModel: { overallAppearance: 'Freckled', appearanceForms: [{ name: 'Mage', appearance: 'Singed coat' }], currentForm: 'Mage' }, mannerisms: ['Ties off bandages'], personality: 'Proud', background: 'Frostbite', birthdaySource: 'generated' };
  const html = dossierProfileHtml(npc, { layout: 'desktop' });
  assert.match(html, /<dt>Look<\/dt><dd>Freckled<\/dd><dt>Wearing<\/dt><dd>Singed coat<\/dd><dt>Habits<\/dt><dd>Ties off bandages<\/dd>/);
  assert.ok(html.indexOf('data-delta-profile="identity"') < html.indexOf('data-delta-profile="appearance"') && html.indexOf('data-delta-profile="appearance"') < html.indexOf('data-delta-profile="character"') && html.indexOf('data-delta-profile="character"') < html.indexOf('data-delta-profile="background"'), 'Identity, Appearance, Character, ..., Background');
  assert.doesNotMatch(html, /delta-profile-col"|Deterministic fallback|Physical features/);
  const { libraryCountHtml } = await import('../dossier-ui-library.js');
  assert.match(libraryCountHtml(10), /data-static="true">▸ Dossier library · 10 NPCs</);
  assert.doesNotMatch(libraryCountHtml(10), /data-delta-screen/, 'on the library the bar is a count, not a link');
  const header = await import('../dossier-ui-header.js');
  assert.match(header.dossierMenuHtml('a'), /delta-header-menu-toggle ss-tap-pill/);
  const css = await builtCss();
  assert.match(css, /--dt-meta:clamp\(/, 'type flows with the panel width');
  assert.doesNotMatch(css.match(/@media \(max-width: 900px\)/)?.[0] || '', /./, 'the sheet and the launcher agree on the full-screen line (1100)');
});

test('round 2 fix 2-4: Right now in groups with three bars and Pull last, Recent changes list, plain coloured tie words', async () => {
  const meters = { mood: { word: 'Alarmed', valence: -2, bars: { energy: 5, control: 2, max: 6 }, cause: 'trust dropped: Astra lied' }, pull: { kind: 'closure', level: 3, days: 0, cause: 'an open thread' },
    secrets: [], bars: [], notes: { ties: [{ name: 'Bregje', tags: ['rival'] }], lies: [{ hidden: true, day: 5 }], knows: [], tastes: [], drives: [] } };
  const base = { ...dossierDetailProjection({ id: 'r', name: 'Rika', location: 'Deck', goal: 'Pay the crew', status: 'Tense', keyRelationships: ['Bregje: rival | clashes'],
    fieldChanges: { mood: 3, location: 3 }, fieldChangeMessages: { mood: 3, location: 3 }, relationshipEventHistory: [{ impact: 'ordinary', reason: 'a gift', evidence: { desire: 'toffee' }, message: 1 }] }, {}, {}), v2Meters: v2MetersProjection(meters) };
  const now = sectionScreenHtml('now', base, { reply: 3 });
  assert.match(now, /<b>Alarmed<\/b> · unpleasant, keyed-up/, 'the word with the bars\' plain words');
  assert.equal((now.match(/delta-tile-bar"/g) || []).length, 3, 'Feeling, Energy, Control');
  assert.ok(now.indexOf('Moved by') < now.indexOf('Where and what') && now.indexOf('<dt>Goal</dt>') < now.indexOf('<dt>Pull'), 'groups in order, Pull last');
  assert.match(now, /trust dropped: Astra lied/);
  assert.match(now, /<dt>Pull <span class="delta-new-badge">New<\/span><\/dt><dd><b>Closure<\/b> · an open thread/);
  assert.match(now, /Updated this reply \(#3\): mood, where\./);
  assert.match(sectionScreenHtml('now', base, { reply: 5 }), /Updated at reply #3: mood, where\./);
  assert.doesNotMatch(sectionScreenHtml('now', { ...base, v2Meters: v2MetersProjection({ ...meters, mood: { ...meters.mood, cause: '' } }) }), /Moved by/, 'no cause, no group');
  const withHtml = sectionScreenHtml('with', { ...base, lastRelationshipChange: { impact: 'net', delta: { trust: 0, affection: 0, desire: 0, tension: 2 }, reason: '', turn: null, message: 3, hosted: true, event: { tier: 'meaningful', held: false, note: '', ask: [], date: 'Goldwane 21', gate: 'via praise · backfired' } } }, {});
  assert.match(withHtml, /Recent changes[\s\S]*delta-chg-when">Goldwane 21<br><small>#3<\/small>[\s\S]*data-good="no">Tension \+2[\s\S]*via praise · backfired[\s\S]*Desire/);
  assert.doesNotMatch(withHtml, /Last relationship change/);
  const ties = sectionScreenHtml('ties', base, {});
  assert.match(ties, /data-tone="bad"><span class="delta-bond-word">rival<\/span>/);
  assert.match(ties, /a lie you have not caught/, 'an uncaught lie never shows its words');
  const css = await builtCss();
  assert.doesNotMatch(css.match(/\.delta-bond-word \{[^}]*\}/g)?.join(' ') || '', /border:1px/, 'the relation word is plain coloured text, no pill');
});
