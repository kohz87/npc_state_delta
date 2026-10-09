/* NPC State Delta relationship map: a read-only second view of the dossier panel. It draws the
   dossier panel's own projection (no extra state reads) and never writes dossier data. */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    buildMapModel,
    DESKTOP_NODE_CAP,
    MAP_CENTER,
    MAP_LENSES,
    MAP_SPAN,
    mapRadius,
    normalizeRelationshipMapSettings,
    PHONE_NODE_CAP,
    plain,
    signed,
} from './relationship-map-core.js';

const EXTENSION_NAME = 'npc_state_delta';
const DOSSIER_ROOT_ID = 'npc_state_delta_dossier_root';
const SETTINGS_ID = 'npc_state_delta_settings';
const SETTINGS_ROOT_ID = 'npc_state_delta_relationship_map_settings';
const STYLE_ID = 'npc_state_delta_relationship_map_style';
const PHONE_QUERY = '(max-width: 650px)';
const RING_VALUES = Object.freeze([75, 25, 0, -50]);

// Session-only view state: the last mode and the map's own buttons last until the page reloads.
const view = { mode: 'dossier', lens: '', showPast: null, allBonds: true, signature: '' };

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

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

function isPhone() {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(PHONE_QUERY).matches;
}

function dossierUi() {
    return document.getElementById(DOSSIER_ROOT_ID)?.__npcStateDeltaStage1Ui || null;
}

function sessionLens(settings) { return view.lens || settings.defaultLens; }
function sessionPast(settings) { return view.showPast === null ? settings.showPast : view.showPast; }

function nodeHtml(node) {
    const avatar = node.portrait
        ? `<img src="${escapeHtml(node.portrait)}" alt="" loading="lazy">`
        : `<span class="delta-map-initial" aria-hidden="true">${escapeHtml(node.initial)}</span>`;
    const delta = node.delta ? `<span class="delta-map-delta" aria-hidden="true">${escapeHtml(signed(node.delta))}</span>` : '';
    // Both names are rendered; a narrow map shows first names only (see the container query).
    const label = `<span class="delta-map-label"><b class="delta-map-name">${escapeHtml(node.name)}</b><b class="delta-map-short">${escapeHtml(node.short)}</b><small>${escapeHtml(signed(node.value))}</small></span>`;
    return `<button type="button" class="delta-map-node" data-npc-id="${escapeHtml(node.id)}" data-status="${node.status}" aria-pressed="${node.selected}" aria-label="${escapeHtml(`${node.name}, ${signed(node.value)}`)}" style="left:${node.x.toFixed(2)}%;top:${node.y.toFixed(2)}%"><span class="delta-map-avatar">${avatar}</span>${delta}${label}</button>`;
}

function svgHtml(model) {
    const lens = MAP_LENSES.find(item => item.key === model.lens) || MAP_LENSES[0];
    const circle = (r, cls) => `<circle class="${cls}" cx="${MAP_CENTER}" cy="${MAP_CENTER}" r="${r.toFixed(1)}"></circle>`;
    const rings = RING_VALUES.map(value => {
        const r = mapRadius(value);
        const label = `<text class="delta-map-ring-label" x="${MAP_CENTER}" y="${(MAP_CENTER - r + 6).toFixed(1)}">${value === 0 ? '0 · neutral' : signed(value)}</text>`;
        return `${circle(r, value === 0 ? 'delta-map-ring delta-map-ring-zero' : 'delta-map-ring')}${label}`;
    }).join('');
    const lines = model.lines.map(line => `<line class="delta-map-bond${line.touches ? ' delta-map-bond-selected' : ''}" x1="${line.from.x.toFixed(1)}" y1="${line.from.y.toFixed(1)}" x2="${line.to.x.toFixed(1)}" y2="${line.to.y.toFixed(1)}"></line>`).join('');
    return `<svg class="delta-map-svg" viewBox="0 0 ${MAP_SPAN} ${MAP_SPAN}" aria-hidden="true" focusable="false">
        ${circle(mapRadius(-100), 'delta-map-outer')}${circle(mapRadius(0), 'delta-map-inner')}${rings}
        <text class="delta-map-outer-word" x="${MAP_CENTER}" y="${(MAP_CENTER + mapRadius(-80)).toFixed(1)}">${escapeHtml(lens.negative)}</text>
        ${lines}</svg>`;
}

function stripHtml(model, persona) {
    const selected = model.selected;
    if (!selected) return '<section class="delta-map-strip"><p class="delta-map-last">Pick an NPC on the map.</p></section>';
    const axes = selected.axes.map(axis => {
        const width = Math.abs(axis.value) / 2;
        const left = axis.value >= 0 ? 50 : 50 - width;
        return `<div class="delta-map-bar" data-axis="${axis.key}"${axis.on ? ' data-on="true"' : ''}>
            <div class="delta-map-bar-label"><span>${axis.label}</span><span class="delta-map-bar-value">${axis.value > 0 ? '+' : ''}${axis.value}${axis.delta ? ` <em>${escapeHtml(signed(axis.delta))}</em>` : ''}</span></div>
            <div class="delta-map-bar-track"><i style="left:${left}%;width:${width}%"></i></div>
        </div>`;
    }).join('');
    const last = selected.lastReason
        ? `${selected.lastTurn ? `<b>${escapeHtml(selected.lastTurn)}</b> ` : ''}${escapeHtml(selected.lastReason)}`
        : 'No relationship change recorded yet.';
    return `<section class="delta-map-strip" aria-label="${escapeHtml(`${selected.name} toward ${persona}`)}">
        <div class="delta-map-strip-head"><b>${escapeHtml(selected.name)}</b><small>toward ${escapeHtml(persona)}</small></div>
        <div class="delta-map-bars">${axes}</div>
        <p class="delta-map-last">${last}</p>
        <button type="button" class="delta-btn delta-primary delta-map-open" data-npc-id="${escapeHtml(selected.id)}">Open dossier</button>
    </section>`;
}

function paneHtml(model, { phone, persona, showPast }) {
    const lens = MAP_LENSES.find(item => item.key === model.lens) || MAP_LENSES[0];
    const lenses = MAP_LENSES.map(item => `<button type="button" class="delta-map-lens" data-map-lens="${item.key}" aria-pressed="${item.key === model.lens}">${item.label}</button>`).join('');
    const toggles = `<button type="button" class="delta-map-toggle" data-map-toggle="bonds" aria-pressed="${view.allBonds}">${phone ? 'Bonds' : 'All bonds'}</button>`
        + `<button type="button" class="delta-map-toggle" data-map-toggle="past" aria-pressed="${showPast}">${phone ? 'Past' : 'Past NPCs'}</button>`;
    const hint = model.allZero
        ? `<div class="delta-map-hint">Turn ${model.turn}: nobody has moved yet. Everyone starts on the neutral ring and drifts in or out as the story changes how they feel about ${escapeHtml(persona)}.</div>` : '';
    const more = model.total > model.shownCount ? ` · Showing ${model.shownCount} of ${model.total}; the rest are in the library` : '';
    const map = model.nodes.length
        ? `<div class="delta-map">${svgHtml(model)}<div class="delta-map-you" title="${escapeHtml(persona)}">${escapeHtml(persona)}</div>${model.nodes.map(nodeHtml).join('')}${hint}</div>`
        : '<div class="delta-map delta-map-empty"><p>No NPCs to map yet.</p></div>';
    return `<div class="delta-map-toolbar">
            <div class="delta-map-lenses" role="group" aria-label="Distance shows">${lenses}</div>
            <div class="delta-map-toggles">${toggles}</div>
        </div>
        <div class="delta-map-body">
            <div class="delta-map-stage">
                <div class="delta-map-frame">${map}</div>
                <p class="delta-map-legend">Closer to ${escapeHtml(persona)} = higher <b>${lens.label.toLocaleLowerCase()}</b> · <i class="delta-map-key" data-status="scene"></i>In chat · <i class="delta-map-key" data-status="active"></i>Active off-screen${more}</p>
            </div>
            ${stripHtml(model, persona)}
        </div>`;
}

function focusKey() {
    const active = document.activeElement?.closest?.('.delta-map-pane [data-npc-id], .delta-map-pane [data-map-lens], .delta-map-pane [data-map-toggle]');
    if (!active) return '';
    if (active.dataset.mapLens) return `[data-map-lens="${CSS.escape(active.dataset.mapLens)}"]`;
    if (active.dataset.mapToggle) return `[data-map-toggle="${CSS.escape(active.dataset.mapToggle)}"]`;
    return `.delta-map-node[data-npc-id="${CSS.escape(active.dataset.npcId)}"]`;
}

function renderMap(ui, { force = false } = {}) {
    const pane = ui?.root?.querySelector('.delta-map-pane');
    if (!pane || view.mode !== 'map') return;
    const settings = readMapSettings();
    const phone = isPhone();
    const persona = personaName();
    const showPast = sessionPast(settings);
    const model = buildMapModel(ui.projection || {}, {
        selectedId: ui.selectedNpcId,
        lens: sessionLens(settings),
        showPast,
        allBonds: view.allBonds,
        cap: phone ? PHONE_NODE_CAP : DESKTOP_NODE_CAP,
    });
    const signature = JSON.stringify([model, phone, persona, showPast, view.allBonds]);
    if (!force && signature === view.signature) return;
    view.signature = signature;
    const refocus = focusKey();
    pane.innerHTML = paneHtml(model, { phone, persona, showPast });
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
    const settings = readMapSettings();
    const lens = event.target.closest('[data-map-lens]')?.dataset?.mapLens;
    if (lens) { view.lens = lens; return void renderMap(ui); }
    const toggle = event.target.closest('[data-map-toggle]')?.dataset?.mapToggle;
    if (toggle === 'bonds') { view.allBonds = !view.allBonds; return void renderMap(ui); }
    if (toggle === 'past') { view.showPast = !sessionPast(settings); return void renderMap(ui); }
    if (event.target.closest('.delta-map-open')) return void setMode(ui, 'dossier');
    const node = event.target.closest('.delta-map-node')?.dataset?.npcId;
    if (node && typeof ui.select === 'function') ui.select(node);
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
        tabs.innerHTML = '<button type="button" role="tab" data-map-mode="dossier">Dossier</button><button type="button" role="tab" data-map-mode="map">Map</button>';
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
    return `<label class="npc-state-delta-setting-row" for="${id}"><span><b>${label}</b><small>${hint}</small></span>${control}</label>`;
}

export function mountRelationshipMapSettings() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById(SETTINGS_ROOT_ID)) return true;
    const slot = document.querySelector(`#${SETTINGS_ID} [data-delta-settings-slot="relationship-map"]`);
    if (!slot) return false;
    const settings = readMapSettings();
    const root = document.createElement('div');
    root.id = SETTINGS_ROOT_ID;
    root.innerHTML = `<h4 class="delta-settings-subhead">Relationship map</h4>
        ${settingRow('npc_state_delta_map_enabled', 'Relationship map', `<input id="npc_state_delta_map_enabled" type="checkbox"${settings.enabled ? ' checked' : ''}>`, 'Adds a Map view to the dossier panel. Read-only; turning it off removes the switch and the See on map link.')}
        ${settingRow('npc_state_delta_map_lens', 'Default distance', `<select id="npc_state_delta_map_lens" class="text_pole">${MAP_LENSES.map(lens => `<option value="${lens.key}"${lens.key === settings.defaultLens ? ' selected' : ''}>${lens.label}</option>`).join('')}</select>`, "What the map's distance shows when it opens. The buttons on the map change it for this session only.")}
        ${settingRow('npc_state_delta_map_past', 'Show past NPCs by default', `<input id="npc_state_delta_map_past" type="checkbox"${settings.showPast ? ' checked' : ''}>`, 'Include archived and deceased NPCs when the map opens.')}`;
    root.addEventListener('change', () => {
        writeMapSettings({
            enabled: root.querySelector('#npc_state_delta_map_enabled')?.checked === true,
            defaultLens: root.querySelector('#npc_state_delta_map_lens')?.value,
            showPast: root.querySelector('#npc_state_delta_map_past')?.checked === true,
        });
        // A changed default applies the next time the map is drawn.
        view.lens = '';
        view.showPast = null;
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
#${DOSSIER_ROOT_ID} .delta-map-see { float:right; margin:-5px 0 0 8px; min-height:30px; padding:3px 10px; font-size:.78rem; }
#${DOSSIER_ROOT_ID} .delta-map-pane { min-width:0; min-height:0; display:flex; flex-direction:column; gap:10px; padding:14px 18px; overflow:hidden; }
#${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode > .delta-document { display:none; }
#${DOSSIER_ROOT_ID} .delta-map-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
#${DOSSIER_ROOT_ID} .delta-map-lenses { display:flex; gap:2px; padding:3px; max-width:100%; overflow-x:auto; border:1px solid var(--delta-line); border-radius:9px; background:rgba(0,0,0,.18); }
#${DOSSIER_ROOT_ID} .delta-map-toggles { display:flex; gap:6px; margin-left:auto; }
#${DOSSIER_ROOT_ID} .delta-map-lens, #${DOSSIER_ROOT_ID} .delta-map-toggle { flex:0 0 auto; min-height:34px; padding:0 11px; border:1px solid transparent; border-radius:7px; color:var(--delta-muted); background:transparent; font-size:.8rem; cursor:pointer; }
#${DOSSIER_ROOT_ID} .delta-map-toggle { border-color:var(--delta-line); }
#${DOSSIER_ROOT_ID} .delta-map-lens[aria-pressed="true"], #${DOSSIER_ROOT_ID} .delta-map-toggle[aria-pressed="true"] { color:var(--delta-accent-soft); background:rgba(216,188,120,.16); border-color:var(--delta-line-strong); font-weight:600; }
#${DOSSIER_ROOT_ID} .delta-map-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:10px; }
#${DOSSIER_ROOT_ID} .delta-map-stage { flex:1 1 auto; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) auto; gap:6px; }
#${DOSSIER_ROOT_ID} .delta-map-frame { min-height:0; display:grid; place-items:center; container-type:size; }
#${DOSSIER_ROOT_ID} .delta-map { position:relative; width:min(100cqw,100cqh); aspect-ratio:1/1; container-type:inline-size; }
#${DOSSIER_ROOT_ID} .delta-map-empty { display:grid; place-items:center; color:var(--delta-muted); }
#${DOSSIER_ROOT_ID} .delta-map-svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
#${DOSSIER_ROOT_ID} .delta-map-outer { fill:rgba(140,90,60,.1); }
#${DOSSIER_ROOT_ID} .delta-map-inner { fill:var(--delta-bg); }
#${DOSSIER_ROOT_ID} .delta-map-ring { fill:none; stroke:rgba(255,255,255,.12); stroke-dasharray:5 6; vector-effect:non-scaling-stroke; }
#${DOSSIER_ROOT_ID} .delta-map-ring-zero { stroke:rgba(255,255,255,.3); stroke-dasharray:none; }
#${DOSSIER_ROOT_ID} .delta-map-ring-label { fill:var(--delta-muted); font:15px ui-monospace,monospace; text-anchor:middle; }
#${DOSSIER_ROOT_ID} .delta-map-outer-word { fill:rgba(200,150,120,.7); font:italic 17px system-ui,sans-serif; letter-spacing:.08em; text-anchor:middle; }
#${DOSSIER_ROOT_ID} .delta-map-bond { stroke:rgba(255,255,255,.16); stroke-width:1; vector-effect:non-scaling-stroke; }
#${DOSSIER_ROOT_ID} .delta-map-bond-selected { stroke:var(--delta-accent); stroke-width:2; }
#${DOSSIER_ROOT_ID} .delta-map-you { position:absolute; left:50%; top:50%; width:clamp(44px,10%,68px); aspect-ratio:1/1; transform:translate(-50%,-50%); display:grid; place-items:center; overflow:hidden; padding:4px; border:2px solid var(--delta-accent); border-radius:50%; color:var(--delta-accent-soft); background:#3a3322; font:700 .82rem/1.1 Georgia,serif; text-align:center; text-overflow:ellipsis; white-space:nowrap; }
#${DOSSIER_ROOT_ID} .delta-map-node { --node:8.6cqw; position:absolute; z-index:1; width:max(44px,var(--node)); height:max(44px,var(--node)); padding:0; transform:translate(-50%,-50%); display:grid; place-items:center; border:0; border-radius:50%; background:transparent; cursor:pointer; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="scene"] { --node:11.4cqw; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="active"] { --node:9.8cqw; }
#${DOSSIER_ROOT_ID} .delta-map-node:is([data-status="archived"],[data-status="dead"]) { --node:7cqw; }
#${DOSSIER_ROOT_ID} .delta-map-avatar { width:var(--node); height:var(--node); display:grid; place-items:center; overflow:hidden; border:1px solid rgba(255,255,255,.28); border-radius:50%; background:radial-gradient(circle at 50% 38%,rgba(216,188,120,.3),#111 95%); }
#${DOSSIER_ROOT_ID} .delta-map-avatar img { width:100%; height:100%; object-fit:cover; object-position:center 18%; }
#${DOSSIER_ROOT_ID} .delta-map-initial { color:var(--delta-accent); font:700 calc(var(--node) * .42)/1 Georgia,serif; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="scene"] .delta-map-avatar { border:2px solid #8fd19e; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="active"] .delta-map-avatar { border:2px solid #8fb4e8; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="archived"] .delta-map-avatar { opacity:.55; }
#${DOSSIER_ROOT_ID} .delta-map-node[data-status="dead"] .delta-map-avatar { opacity:.6; filter:grayscale(1); }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] { z-index:2; }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] .delta-map-avatar { border:3px solid var(--delta-accent); box-shadow:0 0 0 5px rgba(216,188,120,.2); opacity:1; }
#${DOSSIER_ROOT_ID} .delta-map-delta { position:absolute; top:calc(50% - var(--node) / 2 - 5px); left:calc(50% + var(--node) / 2 - 12px); padding:0 4px; border-radius:4px; color:#1a160e; background:var(--delta-accent); font:500 10px/1.5 ui-monospace,monospace; pointer-events:none; }
#${DOSSIER_ROOT_ID} .delta-map-label { position:absolute; top:calc(50% + var(--node) / 2 + 2px); left:50%; width:max(64px,20cqw); transform:translateX(-50%); display:grid; text-align:center; line-height:1.15; pointer-events:none; text-shadow:0 1px 3px #000,0 0 2px #000; }
#${DOSSIER_ROOT_ID} .delta-map-label b { overflow:hidden; color:var(--delta-text); font-size:clamp(10px,1.9cqw,12px); font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
#${DOSSIER_ROOT_ID} .delta-map-label .delta-map-short { display:none; }
#${DOSSIER_ROOT_ID} .delta-map-label small { color:var(--delta-muted); font:clamp(9px,1.7cqw,11px) ui-monospace,monospace; }
#${DOSSIER_ROOT_ID} .delta-map-node[aria-pressed="true"] .delta-map-label b { color:var(--delta-accent-soft); font-weight:700; }
#${DOSSIER_ROOT_ID} .delta-map-hint { position:absolute; z-index:3; top:4%; left:50%; width:min(420px,90%); transform:translateX(-50%); padding:9px 13px; border:1px solid var(--delta-line); border-radius:8px; color:var(--delta-text); background:rgba(30,30,30,.94); font-size:.8rem; text-align:center; }
#${DOSSIER_ROOT_ID} .delta-map-legend { margin:0; color:var(--delta-muted); font-size:.74rem; text-align:center; }
#${DOSSIER_ROOT_ID} .delta-map-legend b { color:var(--delta-text); font-weight:500; }
#${DOSSIER_ROOT_ID} .delta-map-key { display:inline-block; width:10px; height:10px; margin:0 4px -1px 2px; border:2px solid #8fd19e; border-radius:50%; }
#${DOSSIER_ROOT_ID} .delta-map-key[data-status="active"] { border-color:#8fb4e8; }
#${DOSSIER_ROOT_ID} .delta-map-strip { flex:0 0 auto; display:grid; grid-template-columns:minmax(120px,170px) minmax(0,1fr) auto; align-items:center; gap:8px 18px; padding:12px 14px; border:1px solid var(--delta-line); border-radius:10px; background:var(--delta-surface); }
#${DOSSIER_ROOT_ID} .delta-map-strip-head { display:grid; min-width:0; }
#${DOSSIER_ROOT_ID} .delta-map-strip-head b { overflow:hidden; color:var(--delta-accent-soft); font:700 1.1rem/1.15 Georgia,serif; text-overflow:ellipsis; white-space:nowrap; }
#${DOSSIER_ROOT_ID} .delta-map-strip-head small { color:var(--delta-muted); }
#${DOSSIER_ROOT_ID} .delta-map-bars { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px 14px; }
#${DOSSIER_ROOT_ID} .delta-map-bar-label { display:flex; justify-content:space-between; gap:6px; font-size:.75rem; color:var(--delta-muted); }
#${DOSSIER_ROOT_ID} .delta-map-bar[data-on] .delta-map-bar-label span:first-child { color:var(--delta-text); font-weight:600; }
#${DOSSIER_ROOT_ID} .delta-map-bar-value { font-family:ui-monospace,monospace; color:var(--delta-text); }
#${DOSSIER_ROOT_ID} .delta-map-bar-value em { font-style:normal; color:var(--delta-accent); }
#${DOSSIER_ROOT_ID} .delta-map-bar-track { position:relative; height:8px; margin-top:3px; border-radius:4px; background:rgba(0,0,0,.34); }
#${DOSSIER_ROOT_ID} .delta-map-bar-track::before { content:""; position:absolute; left:50%; top:-1px; bottom:-1px; width:1px; background:rgba(255,255,255,.35); }
#${DOSSIER_ROOT_ID} .delta-map-bar-track i { position:absolute; top:1px; height:6px; border-radius:3px; background:var(--delta-accent); opacity:.55; }
#${DOSSIER_ROOT_ID} .delta-map-bar[data-on] .delta-map-bar-track i { opacity:1; }
#${DOSSIER_ROOT_ID} .delta-map-last { grid-column:1/-1; margin:0; color:var(--delta-muted); font-size:.8rem; }
#${DOSSIER_ROOT_ID} .delta-map-last b { color:var(--delta-accent); font-family:ui-monospace,monospace; font-weight:500; }
#${DOSSIER_ROOT_ID} .delta-map-open { grid-row:1; grid-column:3; }
@container (max-width: 520px) {
  #${DOSSIER_ROOT_ID} .delta-map-label .delta-map-name, #${DOSSIER_ROOT_ID} .delta-map-label small, #${DOSSIER_ROOT_ID} .delta-map-ring-label { display:none; }
  #${DOSSIER_ROOT_ID} .delta-map-label .delta-map-short { display:block; }
}
@media (max-width: 900px) {
  #${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode { display:block; overflow:auto; }
  #${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode > .delta-hero { border-right:0; border-bottom:1px solid var(--delta-line); }
  #${DOSSIER_ROOT_ID} .delta-spread.delta-map-mode .delta-hero-media { height:380px; min-height:380px; }
  #${DOSSIER_ROOT_ID} .delta-map-pane { overflow:visible; }
  #${DOSSIER_ROOT_ID} .delta-map-body { display:grid; grid-template-columns:minmax(0,520px) minmax(0,1fr); align-items:start; gap:14px; }
  #${DOSSIER_ROOT_ID} .delta-map-frame { container-type:normal; }
  #${DOSSIER_ROOT_ID} .delta-map { width:100%; }
  #${DOSSIER_ROOT_ID} .delta-map-strip { grid-template-columns:1fr; align-self:start; }
  #${DOSSIER_ROOT_ID} .delta-map-bars { grid-template-columns:1fr; }
  #${DOSSIER_ROOT_ID} .delta-map-open { grid-row:auto; grid-column:auto; }
}
@media (max-width: 650px) {
  #${DOSSIER_ROOT_ID} .delta-map-switch button { padding:0 10px; }
  #${DOSSIER_ROOT_ID} .delta-map-pane { padding:10px; }
  #${DOSSIER_ROOT_ID} .delta-map-toggles { margin-left:0; }
  #${DOSSIER_ROOT_ID} .delta-map-body { display:flex; }
  #${DOSSIER_ROOT_ID} .delta-map-bars { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
`;

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
}

function start() {
    if (typeof document === 'undefined') return;
    installStyles();
    document.addEventListener('npc-state-delta:dossier-rendered', onDossierRendered);
    document.addEventListener('npc-state-delta:settings-mounted', mountRelationshipMapSettings);
    mountRelationshipMapSettings();
    globalThis.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', () => renderMap(dossierUi(), { force: true }));
    onDossierRendered();
}

start();
