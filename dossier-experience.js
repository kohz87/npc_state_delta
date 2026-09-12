/* NPC State Delta cohesive dossier experience refinement.
 * Keeps canonical state/runtime owners while consolidating launcher tools, dossier actions,
 * cast rail presentation, adaptive editing, and explicit manual life-state correction.
 */
import { encodeNpcStateBundle } from './bundle.js';
import { isTerminalNpcDeath } from './core.js';
import {
    activeChatKey, api, closeOverlay, makeSession, mountOverlay, stage1Refresh, uiRoot,
} from './dossier-tools-core.js';
import { exportNativeTools, openDiagnostics, openImportTools } from './dossier-tools.js';
import { openPortraitTools } from './portrait-tools.js';

const STYLE_ID = 'npc_state_delta_dossier_experience_styles';
const LAUNCHER_ID = 'npc_state_delta_dossier_launcher';
const OBSERVER_GUARD = '__npcStateDeltaDossierExperienceObserver';
const DOSSIER_GUARD = '__npcStateDeltaDossierExperienceEvents';
const DOCUMENT_GUARD = '__npcStateDeltaDossierExperienceDocumentEvents';
let normalizeQueued = false;
let pointerGesture = null;

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }
function plain(value) { return String(value ?? '').trim(); }
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function lifeStateChoice(npc = {}) {
    if (isTerminalNpcDeath(npc)) return 'deceased';
    const value = plain(npc?.lifeState).toLowerCase();
    if (value === 'alive' || value === 'living') return 'alive';
    return 'unknown';
}

export function manualLifeStateRecord(npc = {}, requested = 'unknown', now = Date.now()) {
    const next = structuredClone(npc || {});
    const choice = ['alive', 'unknown', 'deceased'].includes(requested) ? requested : 'unknown';
    if (choice === 'deceased') {
        next.lifeState = 'dead';
        next.lifeStateCertainty = 'confirmed';
        next.lifeStateReason = 'Manually marked deceased by the user in the dossier editor.';
        next.present = false;
        next.worldActive = false;
        next.archived = true;
        next.archiveReason = 'deceased';
        next.archivedAt = Number(now) || Date.now();
        next.archiveSourceMessageId = null;
        return next;
    }

    next.lifeState = choice === 'alive' ? 'alive' : 'unknown';
    next.lifeStateCertainty = choice === 'alive' ? 'confirmed' : '';
    next.lifeStateReason = choice === 'alive'
        ? 'Manually confirmed alive by the user in the dossier editor.'
        : '';
    if (plain(next.archiveReason).toLowerCase() === 'deceased') {
        next.archived = false;
        next.archiveReason = '';
        next.archivedAt = null;
        next.archiveSourceMessageId = null;
    }
    return next;
}

function selectedNpcId(root = uiRoot()) {
    return plain(root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || root?.querySelector?.('.delta-cast-card.selected')?.dataset?.npcId);
}

function currentNpc(npcId = selectedNpcId()) {
    try { return api()?.getState?.()?.npcs?.find?.(npc => String(npc?.id || '') === String(npcId || '')) || null; }
    catch { return null; }
}

function lifecycleLabel(npc = {}) {
    if (isTerminalNpcDeath(npc)) return 'Confirmed deceased';
    if (npc?.archived) return plain(npc?.archiveReason).toLowerCase() === 'stale' ? 'Archived · stale' : 'Archived';
    if (npc?.present) return 'Active · Present';
    if (npc?.worldActive) return 'Active · Off-screen';
    return lifeStateChoice(npc) === 'alive' ? 'Alive · Off-screen' : 'Active · life state unknown';
}

async function applyManualLifeState(npcId, requested) {
    const runtime = api();
    const chatKey = activeChatKey();
    if (!runtime || !chatKey || chatKey === 'no-chat') throw new Error('Open a chat before changing life state.');
    let npc = currentNpc(npcId);
    if (!npc) throw new Error('The selected NPC no longer exists.');
    const choice = ['alive', 'unknown', 'deceased'].includes(requested) ? requested : 'unknown';
    if (lifeStateChoice(npc) === choice) return npc;

    if (choice === 'deceased') {
        const confirmed = globalThis.confirm?.(`Mark ${npc.name || 'this NPC'} as deceased? This is a terminal manual life-state decision until you explicitly correct it.`);
        if (confirmed === false) return null;
    }

    // A dead -> living/unknown transition is an explicit erroneous-death correction first.
    // Reuse the canonical Restore path so correction provenance remains owned by the runtime.
    if (isTerminalNpcDeath(npc) && choice !== 'deceased') {
        if (typeof runtime.restore !== 'function' || runtime.restore(npcId) === false) {
            throw new Error('The canonical death-correction action could not restore this dossier.');
        }
        await runtime.flush?.();
        npc = currentNpc(npcId);
        if (!npc) throw new Error('The dossier disappeared while correcting its death record.');
    }

    const next = manualLifeStateRecord(npc, choice);
    const bytes = encodeNpcStateBundle({ npcs: [next], socialGraph: { edges: [], unresolved: [] }, dismissed: [] }, {
        appVersion: runtime.uiStatus?.()?.version || '0.1.0',
        chatKey,
    });
    const imported = runtime.importBytes?.(bytes);
    if (!imported) throw new Error('The canonical dossier importer rejected the life-state correction.');
    await runtime.flush?.();
    stage1Refresh();
    return currentNpc(npcId) || next;
}

function hubHtml() {
    return `<section class="delta-tools-dialog delta-experience-hub" role="document" aria-label="NPC State Delta launcher menu">
      <header><div><span class="delta-tools-kicker">NPC STATE DELTA</span><h2>Open</h2><small>Dossiers and extension-level tools live here.</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body delta-experience-hub-grid">
        <button type="button" data-hub-action="dossiers"><b>Dossiers</b><span>Open the cast and selected NPC dossier.</span></button>
        <button type="button" data-hub-action="settings"><b>Settings</b><span>Scanner, continuity, portrait-prompt and extension settings.</span></button>
        <button type="button" data-hub-action="backup"><b>Backup / Restore</b><span>Export or import the native Delta bundle.</span></button>
        <button type="button" data-hub-action="diagnostics"><b>Diagnostics</b><span>Read-only request, persistence and relationship diagnostics.</span></button>
      </div>
    </section>`;
}

function backupHtml() {
    return `<section class="delta-tools-dialog delta-tools-small" role="document" aria-label="NPC State Delta backup and restore">
      <header><div><span class="delta-tools-kicker">BACKUP / RESTORE</span><h2>Native Delta data</h2><small>Versioned Delta bundles only. Target chat history ownership is preserved.</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body"><p>Export the active chat's dossiers, portraits, supported portrait-prompt settings and audit history, or import a previously exported native Delta bundle.</p></div>
      <footer><button type="button" data-backup-export>Export bundle</button><button type="button" data-backup-import>Import bundle</button></footer>
    </section>`;
}

function openBackupHub() {
    const session = makeSession('backup-hub');
    const overlay = mountOverlay(backupHtml(), session);
    overlay.addEventListener('click', event => {
        if (event.target.closest?.('[data-backup-export]')) {
            exportNativeTools();
            closeOverlay({ reason: 'backup-exported' });
        }
        if (event.target.closest?.('[data-backup-import]')) {
            closeOverlay({ reason: 'backup-import', restore: false });
            void openImportTools();
        }
    });
}

function openLauncherHub() {
    const session = makeSession('launcher-hub');
    const overlay = mountOverlay(hubHtml(), session);
    overlay.addEventListener('click', event => {
        const action = event.target.closest?.('[data-hub-action]')?.dataset?.hubAction;
        if (!action) return;
        const controller = uiRoot()?.__npcStateDeltaStage1Ui || null;
        if (action === 'dossiers') {
            closeOverlay({ reason: 'open-dossiers', restore: false });
            void controller?.open?.();
            return;
        }
        if (action === 'settings') {
            closeOverlay({ reason: 'open-settings', restore: false });
            controller?.openSettings?.();
            return;
        }
        if (action === 'backup') {
            closeOverlay({ reason: 'open-backup', restore: false });
            openBackupHub();
            return;
        }
        if (action === 'diagnostics') {
            closeOverlay({ reason: 'open-diagnostics', restore: false });
            openDiagnostics();
        }
    });
}

function ensureLibraryChrome(root) {
    const cast = root?.querySelector?.('.delta-cast');
    const tools = cast?.querySelector?.('.delta-cast-tools');
    const list = cast?.querySelector?.('.delta-cast-list');
    if (!cast || !tools || !list) return;

    let heading = tools.querySelector('.delta-library-heading');
    if (!heading) {
        heading = document.createElement('div');
        heading.className = 'delta-library-heading';
        tools.prepend(heading);
    }
    const total = api()?.getState?.()?.npcs?.length || 0;
    const text = `DOSSIER LIBRARY · ${total} NPC${total === 1 ? '' : 's'}`;
    if (heading.textContent !== text) heading.textContent = text;

    if (!list.parentElement?.classList?.contains('delta-cast-rail-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'delta-cast-rail-wrap';
        const left = document.createElement('button');
        left.type = 'button';
        left.className = 'delta-rail-arrow delta-rail-left';
        left.dataset.railDirection = '-1';
        left.setAttribute('aria-label', 'Scroll dossier library left');
        left.textContent = '‹';
        const right = document.createElement('button');
        right.type = 'button';
        right.className = 'delta-rail-arrow delta-rail-right';
        right.dataset.railDirection = '1';
        right.setAttribute('aria-label', 'Scroll dossier library right');
        right.textContent = '›';
        cast.insertBefore(wrap, list);
        wrap.append(left, list, right);
    }
}

function actionSignature(npc) {
    return npc ? `${npc.id}:${Boolean(npc.archived)}:${lifeStateChoice(npc)}` : '';
}

function ensureDossierActions(root) {
    const hero = root?.querySelector?.('.delta-hero');
    const actions = hero?.querySelector?.('.delta-hero-actions');
    const npcId = selectedNpcId(root);
    const npc = currentNpc(npcId);
    if (!actions || !npcId || !npc) return;
    const signature = actionSignature(npc);
    if (actions.dataset.deltaExperienceActions === signature) return;
    actions.dataset.deltaExperienceActions = signature;

    const dead = isTerminalNpcDeath(npc);
    const lifecycleAction = dead
        ? `<button type="button" class="delta-btn npc-state-delta-restore-npc" data-npc-id="${escapeHtml(npcId)}">Correct death record</button>`
        : npc.archived
            ? `<button type="button" class="delta-btn npc-state-delta-restore-npc" data-npc-id="${escapeHtml(npcId)}">Restore active</button>`
            : `<button type="button" class="delta-btn npc-state-delta-archive-npc" data-npc-id="${escapeHtml(npcId)}">Archive dossier</button>`;

    actions.innerHTML = `<div class="delta-dossier-actions-primary">
        <button type="button" class="delta-btn delta-primary delta-edit" data-npc-id="${escapeHtml(npcId)}">Edit</button>
        <button type="button" class="delta-btn npc-state-delta-refresh-chat" data-npc-id="${escapeHtml(npcId)}">Refresh</button>
        <details class="delta-dossier-more">
          <summary class="delta-btn">••• More</summary>
          <div class="delta-dossier-more-menu">
            <button type="button" class="delta-btn npc-state-delta-scan-dossier" data-npc-id="${escapeHtml(npcId)}">Scan dossier</button>
            <button type="button" class="delta-btn delta-experience-portrait" data-npc-id="${escapeHtml(npcId)}">Portrait</button>
            ${lifecycleAction}
          </div>
        </details>
      </div>
      <button type="button" class="delta-tools-portrait-button" data-npc-id="${escapeHtml(npcId)}" hidden aria-hidden="true" tabindex="-1"></button>`;
}

function editorNpcId(editor) {
    return plain(editor?.querySelector?.('[data-npc-id]')?.dataset?.npcId);
}

function syncEditorLifecycle(editor, npc) {
    if (!editor || !npc) return;
    const select = editor.querySelector('[data-delta-life-state]');
    if (select) select.value = lifeStateChoice(npc);
    const lifecycle = editor.querySelector('.npc-state-delta-editor-lifecycle');
    const label = lifecycle?.querySelector?.('span');
    if (label) label.textContent = lifecycleLabel(npc);
    const status = editor.querySelector('[data-delta-life-status]');
    if (status) status.textContent = lifeStateChoice(npc) === 'deceased'
        ? 'Deceased is terminal for automatic writers until you explicitly correct it.'
        : 'Life state is separate from archive status and current presence.';
}

function ensureEditorLifeState(editor) {
    if (!editor) return;
    editor.querySelectorAll('.npc-state-delta-copy-image-prompt').forEach(node => node.remove());
    const legacyTools = editor.querySelector('.npc-state-delta-editor-tools');
    if (legacyTools) legacyTools.hidden = true;
    const lifecycle = editor.querySelector('.npc-state-delta-editor-lifecycle');
    const npcId = editorNpcId(editor);
    const npc = currentNpc(npcId);
    if (!lifecycle || !npcId || !npc) return;
    if (!editor.querySelector('.delta-editor-life-control')) {
        const control = document.createElement('div');
        control.className = 'delta-editor-life-control';
        control.innerHTML = `<label><span>Life state</span><select class="text_pole" data-delta-life-state>
            <option value="unknown">Unknown</option><option value="alive">Alive</option><option value="deceased">Deceased</option>
          </select></label>
          <button type="button" class="menu_button" data-delta-apply-life data-npc-id="${escapeHtml(npcId)}">Apply life state</button>
          <small data-delta-life-status></small>`;
        lifecycle.insertAdjacentElement('afterend', control);
    }
    syncEditorLifecycle(editor, npc);
}

function normalizeUi() {
    const root = uiRoot();
    if (root) {
        ensureLibraryChrome(root);
        ensureDossierActions(root);
    }
    document.querySelectorAll?.('.npc-state-delta-editor-popup').forEach(ensureEditorLifeState);
}

function scheduleNormalize() {
    if (normalizeQueued) return;
    normalizeQueued = true;
    queueMicrotask(() => {
        normalizeQueued = false;
        normalizeUi();
    });
}

function bindDossierEvents(root) {
    if (!root || root[DOSSIER_GUARD]) return;
    root[DOSSIER_GUARD] = true;
    root.addEventListener('click', event => {
        const portrait = event.target.closest?.('.delta-experience-portrait');
        if (portrait) {
            event.preventDefault();
            event.stopPropagation();
            openPortraitTools(plain(portrait.dataset.npcId));
            return;
        }
        const arrow = event.target.closest?.('[data-rail-direction]');
        if (arrow) {
            event.preventDefault();
            const list = root.querySelector('.delta-cast-list');
            const direction = Number(arrow.dataset.railDirection) || 1;
            list?.scrollBy?.({ left: direction * Math.max(260, Math.round((list.clientWidth || 360) * .72)), behavior: 'smooth' });
        }
    });
}

function bindDocumentEvents() {
    if (document[DOCUMENT_GUARD]) return;
    document[DOCUMENT_GUARD] = true;

    document.addEventListener('pointerdown', event => {
        if (!event.target.closest?.(`#${LAUNCHER_ID}`)) return;
        pointerGesture = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, moved: false };
    }, true);
    document.addEventListener('pointermove', event => {
        if (!pointerGesture) return;
        const dx = (Number(event.clientX) || 0) - pointerGesture.x;
        const dy = (Number(event.clientY) || 0) - pointerGesture.y;
        if (Math.hypot(dx, dy) > 5) pointerGesture.moved = true;
    }, true);
    document.addEventListener('pointercancel', () => { pointerGesture = null; }, true);

    document.addEventListener('click', event => {
        const launcher = event.target.closest?.(`#${LAUNCHER_ID}`);
        if (launcher) {
            const moved = Boolean(pointerGesture?.moved);
            pointerGesture = null;
            if (moved) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            openLauncherHub();
            return;
        }

        const apply = event.target.closest?.('[data-delta-apply-life]');
        if (apply) {
            event.preventDefault();
            const editor = apply.closest('.npc-state-delta-editor-popup');
            const npcId = plain(apply.dataset.npcId || editorNpcId(editor));
            const requested = plain(editor?.querySelector?.('[data-delta-life-state]')?.value || 'unknown');
            apply.disabled = true;
            void applyManualLifeState(npcId, requested)
                .then(npc => {
                    if (!npc) return;
                    syncEditorLifecycle(editor, npc);
                    toast('success', `NPC State Delta: ${npc.name || 'NPC'} life state set to ${lifeStateChoice(npc)}.`);
                })
                .catch(error => toast('error', `NPC State Delta life-state update failed: ${error?.message || error}`))
                .finally(() => { if (apply.isConnected) apply.disabled = false; });
        }
    }, true);
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#npc_state_delta_dossier_root .delta-tools-data,
#npc_state_delta_dossier_root .delta-tools-diagnostics-button,
#npc_state_delta_dossier_root .delta-open-settings { display:none!important; }

.delta-experience-hub{width:min(720px,100%)}
.delta-experience-hub-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.delta-experience-hub-grid>button{display:grid!important;gap:4px;text-align:left;align-content:start;min-height:104px!important;padding:15px!important}
.delta-experience-hub-grid>button b{font-size:1rem}.delta-experience-hub-grid>button span{opacity:.72;font-size:.86rem;line-height:1.35}

#npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 188px!important}
#npc_state_delta_dossier_root .delta-cast{grid-template-rows:auto minmax(0,1fr)!important}
#npc_state_delta_dossier_root .delta-cast-tools{display:grid!important;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:10px;padding:7px 10px!important}
#npc_state_delta_dossier_root .delta-library-heading{font-size:.68rem;letter-spacing:.12em;color:var(--delta-muted);white-space:nowrap}
#npc_state_delta_dossier_root .delta-search-label{max-width:none!important;min-width:0!important}
#npc_state_delta_dossier_root .delta-filters{justify-self:end;flex-wrap:nowrap!important}
#npc_state_delta_dossier_root .delta-cast-rail-wrap{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) 30px;align-items:stretch;min-height:0;padding:7px 6px 9px;gap:4px}
#npc_state_delta_dossier_root .delta-cast-list{display:flex!important;gap:8px!important;overflow-x:auto!important;overflow-y:hidden!important;min-height:0!important;padding:0 2px!important;scrollbar-width:thin;scroll-snap-type:x proximity}
#npc_state_delta_dossier_root .delta-cast-card{flex:0 0 112px!important;width:112px!important;min-width:112px!important;height:128px!important;display:grid!important;grid-template-rows:76px minmax(0,1fr)!important;gap:0!important;padding:0!important;overflow:hidden!important;text-align:left!important;border-radius:9px!important;scroll-snap-align:start}
#npc_state_delta_dossier_root .delta-cast-portrait{width:100%!important;height:76px!important;min-width:0!important;border-radius:0!important;object-fit:cover!important;object-position:center 20%!important}
#npc_state_delta_dossier_root .delta-cast-copy{display:grid!important;align-content:center;gap:1px!important;min-width:0;padding:5px 7px 6px!important}
#npc_state_delta_dossier_root .delta-cast-copy b{font-size:.76rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#npc_state_delta_dossier_root .delta-cast-copy small{font-size:.64rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.68}
#npc_state_delta_dossier_root .delta-cast-copy .delta-status{font-size:.59rem!important;padding:1px 4px!important;margin-top:2px}
#npc_state_delta_dossier_root .delta-rail-arrow{appearance:none;border:0;background:transparent;color:var(--delta-muted);font-size:1.9rem;line-height:1;cursor:pointer;border-radius:7px;padding:0}
#npc_state_delta_dossier_root .delta-rail-arrow:hover{color:var(--delta-accent-soft);background:rgba(255,255,255,.05)}

#npc_state_delta_dossier_root .delta-hero-actions{display:block!important;padding:9px!important}
#npc_state_delta_dossier_root .delta-dossier-actions-primary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:stretch}
#npc_state_delta_dossier_root .delta-dossier-more{position:relative;min-width:116px}
#npc_state_delta_dossier_root .delta-dossier-more>summary{list-style:none;display:grid;place-items:center;height:100%;cursor:pointer;user-select:none}
#npc_state_delta_dossier_root .delta-dossier-more>summary::-webkit-details-marker{display:none}
#npc_state_delta_dossier_root .delta-dossier-more-menu{position:absolute;right:0;bottom:calc(100% + 7px);z-index:30;width:210px;display:grid;gap:6px;padding:8px;border:1px solid var(--delta-line);border-radius:10px;background:color-mix(in srgb,var(--delta-bg) 96%,black 4%);box-shadow:0 12px 34px rgba(0,0,0,.46)}
#npc_state_delta_dossier_root .delta-dossier-more-menu .delta-btn{text-align:left;width:100%}

.npc-state-delta-editor-popup{width:min(1320px,97vw)!important;max-width:none!important;height:min(940px,96dvh)!important;max-height:none!important;margin:auto!important}
.npc-state-delta-editor-popup .popup-content,.npc-state-delta-editor-popup #npc_state_delta_editor_content{max-height:100%!important;min-height:0!important;overflow:auto!important}
.npc-state-delta-editor-popup .npc-state-delta-editor-tools{display:none!important}
.npc-state-delta-editor-popup .delta-editor-life-control{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:8px 10px;align-items:end;margin:10px 0 14px;padding:11px;border:1px solid rgba(218,193,148,.18);border-radius:9px;background:rgba(255,255,255,.04)}
.npc-state-delta-editor-popup .delta-editor-life-control label{display:grid;gap:5px;margin:0}
.npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1/-1;opacity:.72}

@media(max-width:900px){
  .delta-experience-hub-grid{grid-template-columns:1fr}
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 202px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr auto!important}
  #npc_state_delta_dossier_root .delta-library-heading{grid-column:1/-1}
  #npc_state_delta_dossier_root .delta-search-label{grid-column:1/2}
  #npc_state_delta_dossier_root .delta-filters{grid-column:2/3}
}
@media(max-width:650px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 230px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr!important;gap:6px!important}
  #npc_state_delta_dossier_root .delta-library-heading,#npc_state_delta_dossier_root .delta-search-label,#npc_state_delta_dossier_root .delta-filters{grid-column:1!important;justify-self:stretch!important}
  #npc_state_delta_dossier_root .delta-filters{overflow-x:auto}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:104px!important;width:104px!important;min-width:104px!important}
  #npc_state_delta_dossier_root .delta-dossier-actions-primary{grid-template-columns:1fr 1fr auto}
  #npc_state_delta_dossier_root .delta-dossier-more{min-width:92px}
  .npc-state-delta-editor-popup{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important}
  .npc-state-delta-editor-popup .delta-editor-life-control{grid-template-columns:1fr}
  .npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1}
}
`;
    document.head.appendChild(style);
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    bindDocumentEvents();
    const root = uiRoot();
    if (!root) {
        if (attempt < 80) setTimeout(() => start(attempt + 1), 100);
        return;
    }
    bindDossierEvents(root);
    normalizeUi();
    if (!document[OBSERVER_GUARD] && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(() => scheduleNormalize());
        observer.observe(document.body, { childList: true, subtree: true });
        document[OBSERVER_GUARD] = observer;
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}
