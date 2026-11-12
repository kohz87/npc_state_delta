/* NPC State Delta relationship map: a read-only second view of the dossier panel. It draws the
   dossier panel's own projection (no extra state reads) and never writes dossier data. */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    buildMapModel,
    DESKTOP_NODE_CAP,
    MAP_CARD_BESIDE_MIN,
    MAP_CARD_MIN,
    MAP_DENSE_NODES,
    MAP_LABELS_SHORT_MAX,
    MAP_NAMES_MIN,
    MAP_LENSES,
    normalizeRelationshipMapSettings,
    PHONE_NODE_CAP,
    plain,
    ringWordSpot,
} from './relationship-map-core.js';
import { buildFocusModel, focusStyles, mapCardHtml, mapKeyLine, mapNodeHtml, mapSvgHtml } from './relationship-map-focus.js';
import { escapeHtml } from './src/util/html.js';
import { isNarrow, isNarrowWidth, observedWidth, showScreen, TWO_PANE_MIN } from './dossier-ui-screens.js';
import { libraryFootHtml } from './dossier-ui-library.js';

const EXTENSION_NAME = 'npc_state_delta';
const DOSSIER_ROOT_ID = 'npc_state_delta_dossier_root';
const SETTINGS_ID = 'npc_state_delta_settings';
const SETTINGS_ROOT_ID = 'npc_state_delta_relationship_map_settings';
const STYLE_ID = 'npc_state_delta_relationship_map_style';

// Session-only view state: the last mode and the map's own buttons last until the page reloads.
const view = { mode: 'dossier', lens: '', allBonds: true, focus: '', signature: '' };


function readMapSettings() {
    return normalizeRelationshipMapSettings(extension_settings?.[EXTENSION_NAME]?.relationshipMap);
}

function writeMapSettings(patch) {
    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') extension_settings[EXTENSION_NAME] = {};
    extension_settings[EXTENSION_NAME].relationshipMap = normalizeRelationshipMapSettings({ ...readMapSettings(), ...patch });
    const ctx = getContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function personaName() {
    try { return plain(getContext()?.name1) || 'You'; }
    catch { return 'You'; }
}

// The map's one-column layout follows the dossier's own width (its panel), not the window; a ResizeObserver redraws it when the width crosses the line.
let sizeObserver = null;
let observedPanel = null;
let lastNarrow = null;
function isPhone() {
    return isNarrow(document.getElementById(DOSSIER_ROOT_ID)?.querySelector('.delta-panel'));
}
function watchPanelWidth(ui) {
    const panel = ui?.root?.querySelector?.('.delta-panel');
    if (!panel || panel === observedPanel || typeof ResizeObserver !== 'function') return;
    sizeObserver?.disconnect();
    observedPanel = panel;
    lastNarrow = isNarrow(panel);
    sizeObserver = new ResizeObserver(entries => {
        const narrow = isNarrowWidth(observedWidth(entries[entries.length - 1], panel));
        if (narrow === lastNarrow) return;
        lastNarrow = narrow;
        renderMap(dossierUi(), { force: true });
    });
    sizeObserver.observe(panel);
}

function dossierUi() {
    return document.getElementById(DOSSIER_ROOT_ID)?.__npcStateDeltaStage1Ui || null;
}

function sessionLens(settings) { return view.lens || settings.defaultLens; }

function paneHtml(model, focus, { phone, persona, refs, count, npc }) {
    const lenses = MAP_LENSES.map(item => `<button type="button" class="delta-map-lens ss-tap-pill" data-map-lens="${item.key}" aria-pressed="${item.key === model.lens}">${item.label}</button>`).join('');
    const toggles = `<button type="button" class="delta-map-toggle ss-tap-pill" data-map-toggle="bonds" aria-pressed="${view.allBonds}">${phone ? 'Bonds' : 'All bonds'}</button>`;
    const chip = focus.active ? focus.chip.html : '';
    const hint = model.allZero
        ? `<div class="delta-map-hint">${model.reply >= 0 ? `Reply #${model.reply}: nobody` : 'Nobody'} has moved yet. Everyone starts on the neutral ring and drifts in or out as the story changes how they feel about ${escapeHtml(persona)}.</div>` : '';
    const more = model.total > model.shownCount ? ` · Showing ${model.shownCount} of ${model.total}; the rest are in the library` : '';
    const ties = new Map(focus.ties.map(tie => [tie.id, tie]));
    const map = model.nodes.length
        ? `<div class="delta-map"${model.nodes.length > MAP_DENSE_NODES ? ' data-dense' : ''}>${mapSvgHtml(model, focus)}<div class="delta-map-you" title="${escapeHtml(persona)}">${escapeHtml(persona)}</div>${model.nodes.map(node => mapNodeHtml(node, focus, { refs, ties })).join('')}${hint}</div>`
        : '<div class="delta-map delta-map-empty"><p>No NPCs to map yet.</p></div>';
    return `<div class="delta-map-head"><p class="delta-map-key-line">${mapKeyLine(model.lens, persona)}${escapeHtml(more)}</p>
        <div class="delta-map-toolbar">
            <div class="delta-map-lenses" role="group" aria-label="Distance shows">${lenses}</div>
            ${chip}<div class="delta-map-toggles">${toggles}</div>
        </div></div>
        <div class="delta-map-body">
            <div class="delta-map-stage"><div class="delta-map-frame">${map}</div></div>
            ${mapCardHtml(model, focus, persona, { refs, npc })}
        </div>
        ${libraryFootHtml(count)}`;
}

// The ring's word, placed against what is really drawn: the measured boxes of every face with its label and the You marker, in the
// map's own units. Runs after each draw and whenever the circle's size changes (the faces and labels scale differently from the ring).
let mapObserver = null;
function fitRingWord(map) {
    const text = map?.querySelector('.delta-map-outer-word');
    const svg = map?.querySelector('.delta-map-svg');
    if (!text || !svg) return;
    const frame = svg.getBoundingClientRect();
    if (!frame.width) return;
    const k = 780 / frame.width;
    const unit = r => ({ l: (r.left - frame.left) * k, r: (r.right - frame.left) * k, t: (r.top - frame.top) * k, b: (r.bottom - frame.top) * k });
    const boxes = [];
    for (const node of map.querySelectorAll('.delta-map-node')) {
        const parts = [node.querySelector('.delta-map-avatar'), ...[...(node.querySelector('.delta-map-label')?.children || [])].filter(kid => getComputedStyle(kid).display !== 'none')];
        const rects = parts.map(part => { const range = document.createRange(); range.selectNodeContents(part); return part.matches('.delta-map-avatar') ? part.getBoundingClientRect() : range.getBoundingClientRect(); }).filter(r => r.width);
        if (rects.length) boxes.push(unit({ left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) }));
    }
    const you = map.querySelector('.delta-map-you');
    if (you) boxes.push(unit(you.getBoundingClientRect()));
    const own = text.getBoundingClientRect();
    const spot = ringWordSpot(boxes, { w: own.width * k + 4, h: own.height * k }, 780);
    text.setAttribute('x', spot.x.toFixed(1));
    text.setAttribute('y', spot.y.toFixed(1));
    text.setAttribute('text-anchor', spot.anchor);
}
function watchMap(pane) {
    mapObserver?.disconnect();
    const map = pane.querySelector('.delta-map');
    if (!map || typeof ResizeObserver !== 'function') return;
    fitRingWord(map);
    mapObserver = new ResizeObserver(() => fitRingWord(map));
    mapObserver.observe(map);
}

function focusKey() {
    const active = document.activeElement?.closest?.('.delta-map-pane [data-npc-id], .delta-map-pane [data-map-lens], .delta-map-pane [data-map-toggle], .delta-map-pane [data-map-focus], .delta-map-pane [data-map-focus-clear]');
    if (!active) return '';
    if (active.dataset.mapLens) return `[data-map-lens="${CSS.escape(active.dataset.mapLens)}"]`;
    if (active.dataset.mapFocus !== undefined) return '[data-map-focus]';
    if (active.dataset.mapFocusClear !== undefined) return '[data-map-focus-clear]';
    if (active.dataset.mapToggle) return `[data-map-toggle="${CSS.escape(active.dataset.mapToggle)}"]`;
    return `.delta-map-node[data-npc-id="${CSS.escape(active.dataset.npcId)}"]`;
}

function renderMap(ui, { force = false } = {}) {
    const pane = ui?.root?.querySelector('.delta-map-pane');
    if (!pane || view.mode !== 'map') return;
    watchPanelWidth(ui);
    const settings = readMapSettings();
    const phone = isPhone();
    const persona = personaName();
    const model = buildMapModel(ui.projection || {}, {
        selectedId: ui.selectedNpcId,
        lens: sessionLens(settings),
        allBonds: view.allBonds,
        cap: phone ? PHONE_NODE_CAP : DESKTOP_NODE_CAP,
    });
    const focus = buildFocusModel(ui.projection || {}, model, view.focus);
    if (!focus.active) view.focus = '';
    const npc = (ui.projection?.npcs || []).find(item => item.id === model.selected?.id) || null;
    // the card draws more of the selected person than the model holds (key, mood, gender, the dial's numbers, portrait mark)
    const signature = JSON.stringify([model, phone, persona, view.allBonds, focus.focusId, npc && [npc.key, npc.mood, npc.v2Meters?.mood?.word, npc.relationship, npc.gender, !!npc.portrait]]);
    if (!force && signature === view.signature) return;
    view.signature = signature;
    const refocus = focusKey();
    const refs = ui.portraitRefs || null;
    pane.innerHTML = paneHtml(model, focus, { phone, persona, refs, count: (ui.projection?.index || []).length, npc });
    refs?.fill(pane);
    watchMap(pane);
    if (refocus) pane.querySelector(refocus)?.focus?.({ preventScroll: true });
}

function setMode(ui, mode) {
    view.mode = mode === 'map' && readMapSettings().enabled ? 'map' : 'dossier';
    const root = ui?.root;
    if (!root) return;
    const map = view.mode === 'map';
    root.querySelector('.delta-spread')?.classList.toggle('delta-map-mode', map);
    const pane = root.querySelector('.delta-map-pane');
    if (pane) pane.hidden = !map;
    for (const tab of root.querySelectorAll('.delta-map-switch [data-map-mode]')) tab.setAttribute('aria-selected', String(tab.dataset.mapMode === view.mode));
    if (map) renderMap(ui, { force: true });
    else root.querySelector('.delta-document')?.scrollTo?.({ top: 0 });
}

function onPaneClick(event) {
    const ui = dossierUi();
    if (!ui) return;
    // The "Dossier library" bar goes back to the library: leave the map first (the dossier root's own click handler then opens the library screen).
    if (event.target.closest('.delta-library-foot')) return void setMode(ui, 'dossier');
    const lens = event.target.closest('[data-map-lens]')?.dataset?.mapLens;
    if (lens) { view.lens = lens; return void renderMap(ui); }
    const toggle = event.target.closest('[data-map-toggle]')?.dataset?.mapToggle;
    if (toggle === 'bonds') { view.allBonds = !view.allBonds; return void renderMap(ui); }
    if (event.target.closest('[data-map-focus-clear]')) { view.focus = ''; return void renderMap(ui, { force: true }); }
    const focusId = event.target.closest('[data-map-focus]')?.dataset?.mapFocus;
    if (focusId) { view.focus = focusId; return void renderMap(ui, { force: true }); }
    if (event.target.closest('.delta-map-open')) return void setMode(ui, 'dossier');
    // The dial in the card ("Profile ›"): leave the map and open that person's profile.
    const profile = event.target.closest('[data-map-profile]')?.dataset?.mapProfile;
    if (profile) { setMode(ui, 'dossier'); return void ui.setScreen?.(showScreen(ui.screen, 'profile', profile)); }
    const node = event.target.closest('.delta-map-node')?.dataset?.npcId;
    // While focused, tapping another face moves the focus to them.
    if (node && view.focus) view.focus = node;
    if (node && typeof ui.select === 'function') ui.select(node);
    if (node && view.focus) renderMap(ui, { force: true });
}

// Double-tap a face = select and focus.
function onPaneDouble(event) {
    const ui = dossierUi();
    const node = event.target.closest?.('.delta-map-node')?.dataset?.npcId;
    if (!ui || !node) return;
    view.focus = node;
    if (typeof ui.select === 'function') ui.select(node);
    renderMap(ui, { force: true });
}

// Adds (or, when the map is turned off, removes) the header switch, the map pane and the
// "See on map" link. Everything here is presentation around the existing dossier panel.
function syncChrome(ui) {
    const root = ui?.root;
    if (!root) return;
    const enabled = readMapSettings().enabled;
    const actions = root.querySelector('.delta-top-actions');
    let tabs = root.querySelector('.delta-map-switch');
    if (enabled && actions && !tabs) {
        tabs = document.createElement('div');
        tabs.className = 'delta-map-switch';
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Dossier view');
        tabs.innerHTML = '<button type="button" role="tab" class="ss-tap-pill" data-map-mode="dossier">Dossier</button><button type="button" role="tab" class="ss-tap-pill" data-map-mode="map">Map</button>';
        tabs.addEventListener('click', event => {
            const mode = event.target.closest('[data-map-mode]')?.dataset?.mapMode;
            if (mode) setMode(dossierUi(), mode);
        });
        actions.insertBefore(tabs, actions.querySelector('.delta-close'));
    } else if (!enabled) tabs?.remove();
    const spread = root.querySelector('.delta-spread');
    let pane = root.querySelector('.delta-map-pane');
    if (enabled && spread && !pane) {
        pane = document.createElement('main');
        pane.className = 'delta-map-pane';
        pane.setAttribute('aria-label', 'Relationship map');
        pane.hidden = true;
        pane.addEventListener('click', onPaneClick);
        pane.addEventListener('dblclick', onPaneDouble);
        spread.appendChild(pane);
        view.signature = '';
    } else if (!enabled) pane?.remove();
    const card = root.querySelector('.delta-document [data-delta-section="player"]');
    const link = card?.querySelector('.delta-map-see');
    if (enabled && card && !link) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'delta-btn delta-map-see';
        button.textContent = 'See on map';
        button.addEventListener('click', () => setMode(dossierUi(), 'map'));
        card.querySelector('h3')?.before(button);
    } else if (!enabled) link?.remove();
    if (!enabled && view.mode === 'map') setMode(ui, 'dossier');
    else if (tabs) for (const tab of tabs.querySelectorAll('[data-map-mode]')) tab.setAttribute('aria-selected', String(tab.dataset.mapMode === view.mode));
}

function onDossierRendered() {
    const ui = dossierUi();
    if (!ui) return;
    syncChrome(ui);
    if (view.mode === 'map') {
        ui.root.querySelector('.delta-spread')?.classList.add('delta-map-mode');
        const pane = ui.root.querySelector('.delta-map-pane');
        if (pane) pane.hidden = false;
        renderMap(ui);
    }
}

function settingRow(id, label, control, hint) {
    return `<label class="npc-state-delta-setting-row story-suite-row" for="${id}"><span><b>${label}</b><small>${hint}</small></span>${control}</label>`;
}

export function mountRelationshipMapSettings() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById(SETTINGS_ROOT_ID)) return true;
    const slot = document.querySelector(`#${SETTINGS_ID} [data-delta-settings-slot="relationship-map"]`);
    if (!slot) return false;
    const settings = readMapSettings();
    const root = document.createElement('div');
    root.id = SETTINGS_ROOT_ID;
    root.innerHTML = `<h4 class="delta-settings-subhead story-suite-subhead">Relationship map</h4>
        ${settingRow('npc_state_delta_map_enabled', 'Relationship map', `<input id="npc_state_delta_map_enabled" type="checkbox"${settings.enabled ? ' checked' : ''}>`, 'Adds a Map view to the dossier panel. Read-only; turning it off removes the switch and the See on map link.')}
        ${settingRow('npc_state_delta_map_lens', 'Default distance', `<select id="npc_state_delta_map_lens" class="text_pole">${MAP_LENSES.map(lens => `<option value="${lens.key}"${lens.key === settings.defaultLens ? ' selected' : ''}>${lens.label}</option>`).join('')}</select>`, "What the map's distance shows when it opens. The buttons on the map change it for this session only.")}`;
    root.addEventListener('change', () => {
        writeMapSettings({
            enabled: root.querySelector('#npc_state_delta_map_enabled')?.checked === true,
            defaultLens: root.querySelector('#npc_state_delta_map_lens')?.value,
        });
        // A changed default applies the next time the map is drawn.
        view.lens = '';
        const ui = dossierUi();
        if (ui) { syncChrome(ui); renderMap(ui, { force: true }); }
    });
    slot.appendChild(root);
    return true;
}

const STYLES = `
#${DOSSIER_ROOT_ID} .delta-map-switch { display:flex; padding:3px; border:1px solid var(--delta-line); border-radius:9px; background:rgba(0,0,0,.18); }
#${DOSSIER_ROOT_ID} .delta-map-switch button { min-height:34px; padding:0 14px; border:0; border-radius:6px; color:var(--delta-muted); background:transparent; cursor:pointer; }
#${DOSSIER_ROOT_ID} .delta-map-switch button[aria-selected="true"] { color:var(--delta-accent-soft); background:rgba(216,188,120,.16); font-weight:600; }
#${DOSSIER_ROOT_ID} .delta-map-see { float:right; margin:-5px 0 0 8px; min-height:30px; padding:3px 10px; font-size:var(--dt-meta); }
#${DOSSIER_ROOT_ID} .delta-map-pane { min-width:0; min-height:0; display:flex; flex-direction:column; gap:10px; padding:0; overflow:hidden; }
#${DOSSIER_ROOT_ID} .delta-map-head { flex:none; display:grid; gap:10px; padding:14px 18px 0; }
#${DOSSIER_ROOT_ID} .delta-map-pane > .delta-library-foot { flex:none; margin-top:auto; }
#${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode > .delta-document, #${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode > .delta-hero { display:none; }
#${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); }
#${DOSSIER_ROOT_ID} .delta-map-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
#${DOSSIER_ROOT_ID} .delta-map-lenses { display:flex; gap:2px; padding:3px; min-width:0; max-width:100%; overflow-x:auto; border:1px solid var(--delta-line); border-radius:9px; background:rgba(0,0,0,.18); }
#${DOSSIER_ROOT_ID} .delta-map-toggles { display:flex; gap:6px; margin-left:auto; }
#${DOSSIER_ROOT_ID} .delta-map-lens, #${DOSSIER_ROOT_ID} .delta-map-toggle { flex:0 1 auto; min-width:0; min-height:34px; padding:0 clamp(3px,1.7cqw,11px); border:1px solid transparent; border-radius:7px; color:var(--delta-muted); background:transparent; font-size:var(--dt-meta); cursor:pointer; }
#${DOSSIER_ROOT_ID} .delta-map-toggle { border-color:var(--delta-line); }
#${DOSSIER_ROOT_ID} .delta-map-lens[aria-pressed="true"], #${DOSSIER_ROOT_ID} .delta-map-toggle[aria-pressed="true"] { color:var(--delta-accent-soft); background:rgba(216,188,120,.16); border-color:var(--delta-line-strong); font-weight:600; }
/* below the line the map and its ties block stack and scroll; the library bar stays under them */
#${DOSSIER_ROOT_ID} .delta-map-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:auto; overscroll-behavior:contain; }
#${DOSSIER_ROOT_ID} .delta-map-stage { flex:1 0 auto; min-width:0; display:grid; align-content:center; padding:0 18px; }
#${DOSSIER_ROOT_ID} .delta-map-frame { min-height:0; display:grid; place-items:center; }
#${DOSSIER_ROOT_ID} .delta-map { position:relative; width:100%; max-width:640px; aspect-ratio:1/1; container:dmap / inline-size; }
#${DOSSIER_ROOT_ID} .delta-map-empty { display:grid; place-items:center; color:var(--delta-muted); }
#${DOSSIER_ROOT_ID} .delta-map-svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
#${DOSSIER_ROOT_ID} .delta-map-outer { fill:none; stroke:var(--delta-line); stroke-dasharray:3 4; vector-effect:non-scaling-stroke; }
#${DOSSIER_ROOT_ID} .delta-map-ring { fill:none; stroke:var(--delta-line); vector-effect:non-scaling-stroke; }
#${DOSSIER_ROOT_ID} .delta-map-ring-zero { stroke:var(--delta-line-strong); }
#${DOSSIER_ROOT_ID} .delta-map-outer-word { fill:var(--delta-muted); font:italic 17px system-ui,sans-serif; letter-spacing:.08em; }
#${DOSSIER_ROOT_ID} .delta-map-bond-selected { stroke-width:2; }
#${DOSSIER_ROOT_ID} .delta-map-you { position:absolute; left:50%; top:50%; width:clamp(54px,11%,72px); aspect-ratio:1/1; transform:translate(-50%,-50%); display:grid; place-items:center; overflow:hidden; padding:4px; border:1.5px solid var(--delta-text); border-radius:50%; color:var(--delta-text); background:color-mix(in srgb, var(--delta-text) 16%, var(--delta-floor)); font:700 .82rem/1.1 system-ui,sans-serif; text-align:center; text-overflow:ellipsis; white-space:nowrap; }
#${DOSSIER_ROOT_ID} .delta-map-node { --node:8.6cqw; position:absolute; z-index:1; width:max(44px,var(--node)); height:max(44px,var(--node)); padding:0; transform:translate(-50%,-50%); display:grid; place-items:center; border:0; border-radius:50%; background:transparent; cursor:pointer; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="scene"] { --node:11.4cqw; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="active"] { --node:9.8cqw; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="archived"] { --node:7cqw; }
#${DOSSIER_ROOT_ID} .delta-map-avatar { width:var(--node); height:var(--node); display:grid; place-items:center; overflow:hidden; border:2px solid var(--tone,var(--map-grey)); border-radius:50%; background:var(--face-flat, #3a3740); }
#${DOSSIER_ROOT_ID} .delta-map-face { width:100%; height:100%; object-fit:cover; object-position:center 18%; }
#${DOSSIER_ROOT_ID} .delta-map-face.delta-portrait-placeholder { display:grid; place-items:center; color:var(--delta-text); font:700 calc(var(--node) * .42)/1 system-ui,sans-serif; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="archived"] .delta-map-avatar { opacity:.55; }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] { z-index:2; }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] .delta-map-avatar { border:3px solid var(--delta-accent); box-shadow:0 0 0 5px rgba(216,188,120,.2); opacity:1; }
#${DOSSIER_ROOT_ID} .delta-map-delta { position:absolute; top:calc(50% - var(--node) / 2 - 5px); left:calc(50% + var(--node) / 2 - 12px); padding:0 4px; border-radius:4px; color:#1a160e; background:var(--delta-accent); font:500 10px/1.5 ui-monospace,monospace; pointer-events:none; }
#${DOSSIER_ROOT_ID} .delta-map-label { position:absolute; top:calc(50% + var(--node) / 2 + 2px); left:50%; width:max(64px,20cqw); transform:translateX(-50%); display:grid; text-align:center; line-height:1.15; pointer-events:none; text-shadow:0 1px 3px #000,0 0 2px #000; }
#${DOSSIER_ROOT_ID} .delta-map-label b { color:var(--delta-text); font-size:clamp(10px,1.9cqw,12px); font-weight:500; white-space:normal; overflow-wrap:anywhere; }
#${DOSSIER_ROOT_ID} .delta-map-label .delta-map-short { display:none; }
#${DOSSIER_ROOT_ID} .delta-map-label small { color:var(--delta-muted); font:clamp(9px,1.7cqw,11px) ui-monospace,monospace; }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] .delta-map-label b { color:var(--delta-accent-soft); font-weight:700; }
#${DOSSIER_ROOT_ID} .delta-map-hint { position:absolute; z-index:3; top:4%; left:50%; width:min(420px,90%); transform:translateX(-50%); padding:9px 13px; border:1px solid var(--delta-line); border-radius:8px; color:var(--delta-text); background:rgba(30,30,30,.94); font-size:var(--dt-meta); text-align:center; }
/* a circle narrower than this draws smaller labels: the full name (cut with an ellipsis) and its number, in a narrower box; with many faces (data-dense)
   the short name alone, so the labels never meet */
@container dmap (max-width: ${MAP_LABELS_SHORT_MAX}px) {
  #${DOSSIER_ROOT_ID} .delta-map-label { width:clamp(52px,17cqw,76px); }
  #${DOSSIER_ROOT_ID} .delta-map-label b { font-size:clamp(8.5px,2.5cqw,11px); }
  #${DOSSIER_ROOT_ID} .delta-map-label small { font-size:clamp(8px,2.3cqw,10px); }
  #${DOSSIER_ROOT_ID} .delta-map[data-dense] .delta-map-label .delta-map-name, #${DOSSIER_ROOT_ID} .delta-map[data-dense] .delta-map-label small:not(.delta-map-word) { display:none; }
  #${DOSSIER_ROOT_ID} .delta-map[data-dense] .delta-map-label .delta-map-short { display:block; }
}
@container dmap (max-width: ${MAP_NAMES_MIN}px) {
  #${DOSSIER_ROOT_ID} .delta-map-label .delta-map-name, #${DOSSIER_ROOT_ID} .delta-map-label small:not(.delta-map-word) { display:none; }
  #${DOSSIER_ROOT_ID} .delta-map-label .delta-map-short { display:block; }
}
/* beside: the circle at its smallest readable size (MAP_CIRCLE_MIN) plus the card at its narrowest (MAP_CARD_MIN) and the room around them fit */
@container dsr (min-width: ${MAP_CARD_BESIDE_MIN}px) {
  #${DOSSIER_ROOT_ID} .delta-map-body { display:grid; grid-template-columns:minmax(0,1fr) clamp(${MAP_CARD_MIN}px,28cqw,360px); grid-template-rows:minmax(0,1fr); overflow:hidden; }
  #${DOSSIER_ROOT_ID} .delta-map-stage { min-height:0; display:grid; grid-template-rows:minmax(0,1fr); padding-bottom:14px; }
  #${DOSSIER_ROOT_ID} .delta-map-frame { container-type:size; }
  #${DOSSIER_ROOT_ID} .delta-map { width:min(100cqw,100cqh); max-width:none; }
}
@container dsr (max-width: ${TWO_PANE_MIN - 0.02}px) {
  #${DOSSIER_ROOT_ID} .delta-map-switch button { padding:0 10px; }
  #${DOSSIER_ROOT_ID} .delta-map-head { padding:10px 10px 0; }
  #${DOSSIER_ROOT_ID} .delta-map-stage { padding:0 10px; }
  #${DOSSIER_ROOT_ID} .delta-map-toggles { margin-left:0; }
}
`;

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES + focusStyles(`#${DOSSIER_ROOT_ID}`);
    document.head.appendChild(style);
}

function start() {
    if (typeof document === 'undefined') return;
    installStyles();
    document.addEventListener('npc-state-delta:dossier-rendered', onDossierRendered);
    document.addEventListener('npc-state-delta:settings-mounted', mountRelationshipMapSettings);
    // the browser's back gesture in Map mode leaves the map (the panel fires this) instead of stepping the hidden dossier screen
    document.addEventListener('npc-state-delta:leave-map', () => { if (view.mode === 'map') setMode(dossierUi(), 'dossier'); });
    mountRelationshipMapSettings();
    onDossierRendered();
}

start();
