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
import { boardHtml } from '../dossier-ui-board.js';
import { createPortraitRefs } from '../dossier-ui-html.js';
import { dialArcs, dialSvg } from '../dossier-ui-dial.js';
import { dossierMenuHtml } from '../dossier-ui-header.js';
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
  assert.match(uiSource, /\['Condition', plain\(npc\.status\)\]/);
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
  assert.match(html, /human · female · mage/);
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
