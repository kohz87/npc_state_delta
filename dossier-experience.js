/* NPC State Delta cohesive dossier experience refinement.
 * Keeps canonical state/runtime owners while refining dossier actions, cast carousel,
 * adaptive editing, extension settings presentation, and explicit manual life-state correction.
 */
import { isTerminalNpcDeath } from './core.js';
import { activeChatKey, api, flushDurably, stage1Refresh, uiRoot } from './dossier-tools-core.js';
import { exportNativeTools, openDiagnostics, openImportTools } from './dossier-tools.js';
import { openPortraitTools } from './portrait-tools.js';

const STYLE_ID = 'npc_state_delta_dossier_experience_styles';
const ROOT_OBSERVER_GUARD = '__npcStateDeltaDossierExperienceRootObserver';
const EDITOR_OBSERVER_GUARD = '__npcStateDeltaDossierExperienceEditorObserver';
const DOSSIER_GUARD = '__npcStateDeltaDossierExperienceEvents';
const DOCUMENT_GUARD = '__npcStateDeltaDossierExperienceDocumentEvents';
const SETTINGS_ID = 'npc_state_delta_settings';
const diagnosticVisibleNpcIds = new Set();
let normalizeQueued = false;

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

export function setNodeTextIfChanged(node, value) {
    const text = String(value ?? '');
    if (!node || node.textContent === text) return false;
    node.textContent = text;
    return true;
}

function setNodeValueIfChanged(node, value) {
    const next = String(value ?? '');
    if (!node || node.value === next) return false;
    node.value = next;
    return true;
}

export function lifeStateChoice(npc = {}) {
    if (isTerminalNpcDeath(npc)) return 'deceased';
    const value = plain(npc?.lifeState).toLowerCase();
    const certainty = plain(npc?.lifeStateCertainty).toLowerCase();
    // Recover the short-lived Stage 8 UI shape without weakening automatic death rules.
    if (value === 'dead' && (certainty === 'confirmed' || certainty === 'explicit')) return 'deceased';
    if (value === 'deceased' && certainty === 'explicit') return 'deceased';
    if (value === 'alive' || value === 'living') return 'alive';
    return 'unknown';
}


function selectedNpcId(root = uiRoot()) {
    return plain(root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || root?.querySelector?.('.delta-cast-card.selected')?.dataset?.npcId);
}

function currentNpc(npcId = selectedNpcId()) {
    try { return api()?.getNpc?.(npcId) || null; }
    catch { return null; }
}

function lifecycleLabel(npc = {}) {
    if (lifeStateChoice(npc) === 'deceased') return 'Confirmed deceased';
    if (npc?.archived) return plain(npc?.archiveReason).toLowerCase() === 'stale' ? 'Archived · stale' : 'Archived';
    if (npc?.present) return 'Active · Present';
    if (npc?.worldActive) return 'Active · Off-screen';
    return lifeStateChoice(npc) === 'alive' ? 'Alive · Off-screen' : 'Active · life state unknown';
}

async function applyManualLifeState(npcId, requested, editor) {
    const runtime = api();
    const chatKey = activeChatKey();
    const control = editor?.querySelector('.delta-editor-life-control');
    if (!runtime || !chatKey || chatKey === 'no-chat' || !editor?.isConnected || control?.dataset.chatKey !== chatKey) throw new Error('The life-state editor no longer belongs to this chat.');
    const npc = currentNpc(npcId);
    if (!npc) throw new Error('The selected NPC no longer exists.');
    const choice = ['alive', 'unknown', 'deceased'].includes(requested) ? requested : 'unknown';
    if (lifeStateChoice(npc) === choice) return npc;
    if (choice === 'deceased' && globalThis.confirm?.(`Mark ${npc.name || 'this NPC'} as deceased? This is terminal until you explicitly correct it.`) === false) return null;
    if (!runtime.updateLifeState?.(npcId, choice, { chatKey })) throw new Error('The canonical life-state edit rejected its stale target.');
    const saved = await flushDurably(chatKey, 'manual life state');
    if (!saved.persisted) throw new Error('Life-state change applied locally, but durable save failed. The change is retained for recovery.');
    if (activeChatKey() !== chatKey || !editor.isConnected) return null;
    stage1Refresh();
    return currentNpc(npcId);
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
    const total = root.__npcStateDeltaStage1Ui?.projection?.npcs?.length || 0;
    setNodeTextIfChanged(heading, `DOSSIER LIBRARY · ${total} NPC${total === 1 ? '' : 's'}`);

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
    return npc ? `${npc.id}:${Boolean(npc.archived)}:${lifeStateChoice(npc)}:${diagnosticVisibleNpcIds.has(String(npc.id))}` : '';
}

function renderNpcDiagnostics(root) {
    const hero = root?.querySelector?.('.delta-hero');
    if (!hero) return;
    hero.querySelectorAll(':scope > .delta-npc-diagnostics').forEach(node => node.remove());
    const npcId = selectedNpcId(root);
    if (!npcId || !diagnosticVisibleNpcIds.has(npcId)) return;
    const records = api()?.diagnosticsForNpc?.(npcId) || [];
    const recent = records.slice(-8).reverse();
    const section = document.createElement('section');
    section.className = 'delta-npc-diagnostics';
    section.innerHTML = `<header><b>Diagnostics</b><small>${recent.length} recent operation${recent.length === 1 ? '' : 's'}</small></header>
      ${recent.length ? recent.map(row => `<details><summary>${escapeHtml(row.type || 'scan')} · ${escapeHtml(String(row.sourceMessageId ?? 'no source'))}</summary><pre>${escapeHtml(JSON.stringify({ profile: row.profile || [], birthdays: row.birthdays || [], accounting: row.accounting || {} }, null, 2))}</pre></details>`).join('') : '<p>No retained diagnostic operations for this NPC yet.</p>'}`;
    const actions = hero.querySelector('.delta-hero-actions');
    if (actions) actions.insertAdjacentElement('afterend', section);
    else hero.appendChild(section);
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

    const dead = lifeStateChoice(npc) === 'deceased';
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
            <button type="button" class="delta-btn delta-experience-diagnostics" data-npc-id="${escapeHtml(npcId)}">${diagnosticVisibleNpcIds.has(npcId) ? 'Hide diagnostics' : 'Show diagnostics'}</button>
            ${lifecycleAction}
          </div>
        </details>
      </div>`;
}

function editorNpcId(editor) {
    return plain(editor?.querySelector?.('[data-npc-id]')?.dataset?.npcId);
}

function syncEditorLifecycle(editor, npc, { preserveChoice = false } = {}) {
    if (!editor || !npc) return;
    if (!preserveChoice) setNodeValueIfChanged(editor.querySelector('[data-delta-life-state]'), lifeStateChoice(npc));
    setNodeTextIfChanged(editor.querySelector('.npc-state-delta-editor-lifecycle span'), lifecycleLabel(npc));
    setNodeTextIfChanged(editor.querySelector('[data-delta-life-status]'), lifeStateChoice(npc) === 'deceased'
        ? 'Deceased is terminal for automatic writers until you explicitly correct it.'
        : 'Life state is separate from archive status and current presence.');
}

function editorSection(title, className = '') {
    const section = document.createElement('section');
    section.className = `delta-editor-section ${className}`.trim();
    const heading = document.createElement('h4');
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'delta-editor-section-grid';
    section.append(heading, body);
    return { section, body };
}

function moveEditorLabel(editor, id, destination, { wide = false } = {}) {
    const label = editor.querySelector(`#${id}`)?.closest?.('label');
    if (!label || !destination) return null;
    if (wide) label.classList.add('delta-editor-wide');
    else label.classList.remove('delta-editor-wide');
    destination.appendChild(label);
    return label;
}

function ensureEditorStructure(editor) {
    const content = editor?.querySelector?.('#npc_state_delta_editor_content');
    if (!content || content.dataset.deltaExperienceStructured === '1') return;

    const portraitOverrides = content.querySelector('.npc-state-delta-editor-portrait-overrides');
    if (portraitOverrides) {
        // Keep these legacy inputs mounted so the canonical editor save path preserves existing
        // per-NPC overrides, but Portrait is now the only maintained prompt-editing surface.
        portraitOverrides.hidden = true;
        portraitOverrides.setAttribute('aria-hidden', 'true');
    }
    const legacyTools = content.querySelector('.npc-state-delta-editor-tools');
    if (legacyTools) legacyTools.hidden = true;

    const identity = editorSection('Identity & profile', 'delta-editor-identity');
    for (const [id, wide] of [
        ['npc_state_delta_edit_name', false], ['npc_state_delta_edit_species', false],
        ['npc_state_delta_edit_role', false], ['npc_state_delta_edit_home_base', false],
        ['npc_state_delta_edit_age', false], ['npc_state_delta_edit_birthday', false],
        ['npc_state_delta_edit_apparent_age', false], ['npc_state_delta_edit_personality', false],
        ['npc_state_delta_edit_behavior_profile', true], ['npc_state_delta_edit_speech', false],
        ['npc_state_delta_edit_background', true],
    ]) moveEditorLabel(content, id, identity.body, { wide });

    const current = editorSection('Current state', 'delta-editor-current');
    for (const id of ['npc_state_delta_edit_mood', 'npc_state_delta_edit_location', 'npc_state_delta_edit_goal', 'npc_state_delta_edit_status']) {
        moveEditorLabel(content, id, current.body);
    }

    const relationships = editorSection('Relationships', 'delta-editor-relationships');
    moveEditorLabel(content, 'npc_state_delta_edit_relationship_summary', relationships.body, { wide: true });
    moveEditorLabel(content, 'npc_state_delta_edit_key_relationships', relationships.body, { wide: true });
    const stats = content.querySelector('.npc-state-delta-editor-stats');
    if (stats) relationships.body.appendChild(stats);

    const continuity = editorSection('Continuity', 'delta-editor-continuity');
    moveEditorLabel(content, 'npc_state_delta_edit_mannerisms', continuity.body, { wide: true });
    moveEditorLabel(content, 'npc_state_delta_edit_memories', continuity.body, { wide: true });

    const advanced = document.createElement('details');
    advanced.className = 'delta-editor-advanced';
    const summary = document.createElement('summary');
    summary.innerHTML = '<b>Advanced NPC options</b><small>Life state, profile protection, stale cleanup and present-card visibility</small>';
    const advancedBody = document.createElement('div');
    advancedBody.className = 'delta-editor-advanced-body';
    advanced.append(summary, advancedBody);

    const lifecycle = content.querySelector('.npc-state-delta-editor-lifecycle');
    const lifeControl = content.querySelector('.delta-editor-life-control');
    if (lifecycle) advancedBody.appendChild(lifecycle);
    if (lifeControl) advancedBody.appendChild(lifeControl);
    for (const lock of [...content.querySelectorAll(':scope > .npc-state-delta-editor-lock')]) advancedBody.appendChild(lock);
    const protectedText = [...content.querySelectorAll(':scope > p.npc-state-delta-muted')]
        .find(node => /^Currently protected:/i.test(plain(node.textContent)));
    if (protectedText) advancedBody.appendChild(protectedText);

    for (const oldGrid of [...content.querySelectorAll(':scope > .npc-state-delta-editor-grid')]) {
        if (!oldGrid.children.length) oldGrid.remove();
    }

    // Keep the editor's own heading/intro at the top, then present a predictable form hierarchy.
    content.append(identity.section, current.section, relationships.section, continuity.section, advanced);
    if (portraitOverrides) content.appendChild(portraitOverrides);
    content.dataset.deltaExperienceStructured = '1';
    content.dispatchEvent?.(new CustomEvent('npc-state-delta:editor-mounted', { bubbles: true }));
}

function ensureEditorLifeState(editor) {
    if (!editor?.isConnected) return;
    editor.querySelectorAll('.npc-state-delta-copy-image-prompt').forEach(node => node.remove());
    const lifecycle = editor.querySelector('.npc-state-delta-editor-lifecycle');
    const npcId = editorNpcId(editor);
    const existing = editor.querySelector('.delta-editor-life-control');
    if (existing?.dataset.npcId === npcId && existing.dataset.chatKey === activeChatKey()) return;
    const npc = currentNpc(npcId);
    if (!lifecycle || !npcId || !npc) return;

    let control = editor.querySelector('.delta-editor-life-control');
    if (!control) {
        control = document.createElement('div');
        control.className = 'delta-editor-life-control';
        control.innerHTML = `<label><span>Life state</span><select class="text_pole" data-delta-life-state>
            <option value="unknown">Unknown</option><option value="alive">Alive</option><option value="deceased">Deceased</option>
          </select></label>
          <button type="button" class="menu_button" data-delta-apply-life>Apply life state</button>
          <small data-delta-life-status></small>`;
        lifecycle.insertAdjacentElement('afterend', control);
    }
    const apply = control.querySelector('[data-delta-apply-life]');
    if (apply && apply.dataset.npcId !== npcId) apply.dataset.npcId = npcId;
    control.dataset.npcId = npcId;
    control.dataset.chatKey = activeChatKey();
    syncEditorLifecycle(editor, npc);
    ensureEditorStructure(editor);
}

function settingsDetails(title, hint = '', open = false) {
    const details = document.createElement('details');
    details.className = 'delta-settings-group';
    details.open = Boolean(open);
    const summary = document.createElement('summary');
    summary.innerHTML = `<b>${escapeHtml(title)}</b>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}`;
    const body = document.createElement('div');
    body.className = 'delta-settings-group-body';
    details.append(summary, body);
    return { details, body };
}

function settingsRow(root, id) {
    return root?.querySelector?.(`.npc-state-delta-setting-row[for="${id}"]`) || null;
}

function moveSettingsRows(root, ids, destination) {
    for (const id of ids) {
        const row = settingsRow(root, id);
        if (row) destination.appendChild(row);
    }
}

function ensureSettingsExperience() {
    const settings = document.getElementById(SETTINGS_ID);
    const drawer = settings?.querySelector?.('.npc-state-delta-drawer');
    if (!settings || !drawer || settings.dataset.deltaExperienceStructured === '1') return Boolean(settings && drawer);

    const intro = drawer.querySelector('.npc-state-delta-intro');
    if (intro) setNodeTextIfChanged(intro, 'Scanner, continuity, roster, portrait-prompt and maintenance settings for NPC State Delta. The floating launcher opens Dossiers directly.');

    const layout = document.createElement('div');
    layout.className = 'delta-settings-experience';
    if (intro) intro.insertAdjacentElement('afterend', layout);
    else drawer.prepend(layout);

    const general = settingsDetails('General', '', true);
    moveSettingsRows(settings, ['npc_state_delta_enabled'], general.body);
    layout.appendChild(general.details);

    const scanning = settingsDetails('Scanning', 'Connection, cadence and admission', true);
    moveSettingsRows(settings, [
        'npc_state_delta_auto', 'npc_state_delta_scanner_connection_profile', 'npc_state_delta_full_scan_every_turn',
        'npc_state_delta_scan_every', 'npc_state_delta_scan_depth', 'npc_state_delta_admission_mode',
    ], scanning.body);
    const scanNow = drawer.querySelector('#npc_state_delta_scan_now');
    if (scanNow) {
        const scanningActions = document.createElement('div');
        scanningActions.className = 'npc-state-delta-actions delta-settings-scanning-actions';
        scanningActions.appendChild(scanNow);
        scanning.body.appendChild(scanningActions);
    }
    layout.appendChild(scanning.details);

    const continuity = settingsDetails('Continuity & injection', 'Generation context and branch behavior');
    moveSettingsRows(settings, [
        'npc_state_delta_inject', 'npc_state_delta_inject_budget', 'npc_state_delta_branch_rescan',
        'npc_state_delta_archive_deaths', 'npc_state_delta_reactivate_archived',
    ], continuity.body);
    layout.appendChild(continuity.details);

    const roster = settingsDetails('Roster & cleanup', 'Capacity and stale lifecycle');
    moveSettingsRows(settings, [
        'npc_state_delta_max', 'npc_state_delta_auto_prune_stale',
        'npc_state_delta_stale_archive_after', 'npc_state_delta_stale_delete_after',
    ], roster.body);
    const addNpc = drawer.querySelector('#npc_state_delta_add_manual');
    if (addNpc) {
        const rosterActions = document.createElement('div');
        rosterActions.className = 'npc-state-delta-actions delta-settings-roster-actions';
        rosterActions.appendChild(addNpc);
        roster.body.appendChild(rosterActions);
    }
    layout.appendChild(roster.details);

    const portrait = drawer.querySelector('.npc-state-delta-portrait-generation-settings');
    if (portrait) {
        portrait.classList.add('delta-settings-group', 'delta-settings-portrait-prompts');
        const summary = portrait.querySelector(':scope > summary');
        if (summary) summary.innerHTML = '<b>Portrait generation</b><small>SillyTavern Image Generation + prompt construction</small>';
        const copy = portrait.querySelector('.npc-state-delta-portrait-settings-body > p.npc-state-delta-muted');
        if (copy) setNodeTextIfChanged(copy, 'Configure dossier-derived portrait prompts and the native SillyTavern Image Generation handoff. The active SillyTavern backend, including ComfyUI when selected there, remains host-owned.');
        const generationRow = settingsRow(settings, 'npc_state_delta_portrait_generation_enabled');
        const galleryRow = settingsRow(settings, 'npc_state_delta_portrait_save_gallery');
        if (generationRow) generationRow.hidden = false;
        if (galleryRow) galleryRow.hidden = false;
        const reset = portrait.querySelector('#npc_state_delta_reset_portrait_theme');
        if (reset) reset.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Reset Fantasy Anime prompt style';
        const save = portrait.querySelector('#npc_state_delta_save_portrait_settings');
        if (save) save.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save prompt settings';
        layout.appendChild(portrait);
    }

    const relationship = drawer.querySelector('.npc-state-delta-relationship-tuning:not(.npc-state-delta-memory-tuning):not(.npc-state-delta-behavior-tuning)');
    if (relationship) {
        relationship.classList.add('delta-settings-group');
        const summary = relationship.querySelector(':scope > summary');
        if (summary) summary.innerHTML = '<b>Relationship tuning</b><small>Advanced</small>';
        layout.appendChild(relationship);
    }

    const memory = drawer.querySelector('.npc-state-delta-memory-tuning');
    const behavior = drawer.querySelector('.npc-state-delta-behavior-tuning');
    if (memory || behavior) {
        const rules = settingsDetails('Memory & behavior rules', 'Advanced');
        if (memory) {
            const block = document.createElement('section');
            block.className = 'delta-settings-subsection';
            block.innerHTML = '<h4>Important memory tuning</h4>';
            const body = memory.querySelector('.npc-state-delta-tuning-body');
            if (body) block.appendChild(body);
            rules.body.appendChild(block);
            memory.remove();
        }
        if (behavior) {
            const block = document.createElement('section');
            block.className = 'delta-settings-subsection';
            block.innerHTML = '<h4>Behavior expression</h4>';
            const body = behavior.querySelector('.npc-state-delta-tuning-body');
            if (body) block.appendChild(body);
            rules.body.appendChild(block);
            behavior.remove();
        }
        layout.appendChild(rules.details);
    }

    const maintenance = settingsDetails('Data & maintenance', 'Backup, diagnostics and current-chat tools');
    const maintenanceActions = document.createElement('div');
    maintenanceActions.className = 'npc-state-delta-actions delta-settings-maintenance-actions';
    maintenanceActions.innerHTML = `
      <button type="button" class="menu_button" data-delta-settings-backup><i class="fa-solid fa-file-export"></i> Backup / Export</button>
      <button type="button" class="menu_button" data-delta-settings-restore><i class="fa-solid fa-file-import"></i> Restore / Import</button>
      <button type="button" class="menu_button" data-delta-settings-diagnostics><i class="fa-solid fa-stethoscope"></i> Diagnostics</button>`;
    maintenance.body.appendChild(maintenanceActions);

    const clearChat = drawer.querySelector('#npc_state_delta_clear_chat');
    if (clearChat) maintenanceActions.appendChild(clearChat);

    // The legacy action wrapper may be nested inside the original settings grid.
    // Remove it only after each action has been placed in its task-specific group.
    for (const legacyActions of drawer.querySelectorAll('.npc-state-delta-actions')) {
        if (legacyActions === maintenanceActions || legacyActions.children.length) continue;
        legacyActions.remove();
    }

    const rosterSummary = drawer.querySelector('#npc_state_delta_roster_summary');
    if (rosterSummary) {
        const currentRoster = document.createElement('details');
        currentRoster.className = 'delta-settings-current-roster';
        currentRoster.innerHTML = '<summary><b>Current chat roster</b><small>Edit, scan, archive or remove individual records</small></summary>';
        currentRoster.appendChild(rosterSummary);
        maintenance.body.appendChild(currentRoster);
    }
    layout.appendChild(maintenance.details);

    const oldGrid = drawer.querySelector(':scope > .npc-state-delta-settings-grid');
    if (oldGrid && !oldGrid.children.length) oldGrid.remove();
    settings.dataset.deltaExperienceStructured = '1';
    settings.dispatchEvent?.(new CustomEvent('npc-state-delta:settings-mounted', { bubbles: true }));
    return true;
}

function normalizeRoot(root = uiRoot()) {
    if (!root?.isConnected) return;
    ensureLibraryChrome(root);
    ensureDossierActions(root);
    renderNpcDiagnostics(root);
}

function scheduleNormalize(root = uiRoot()) {
    if (!root || normalizeQueued) return;
    normalizeQueued = true;
    queueMicrotask(() => {
        normalizeQueued = false;
        normalizeRoot(root);
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
        const diagnostics = event.target.closest?.('.delta-experience-diagnostics');
        if (diagnostics) {
            event.preventDefault();
            event.stopPropagation();
            const npcId = plain(diagnostics.dataset.npcId);
            if (diagnosticVisibleNpcIds.has(npcId)) diagnosticVisibleNpcIds.delete(npcId);
            else diagnosticVisibleNpcIds.add(npcId);
            const actions = root.querySelector('.delta-hero-actions');
            if (actions) actions.dataset.deltaExperienceActions = '';
            normalizeRoot(root);
            return;
        }
        const arrow = event.target.closest?.('[data-rail-direction]');
        if (arrow) {
            event.preventDefault();
            const list = root.querySelector('.delta-cast-list');
            const direction = Number(arrow.dataset.railDirection) || 1;
            list?.scrollBy?.({ left: direction * Math.max(240, Math.round((list.clientWidth || 360) * .72)), behavior: 'smooth' });
        }
    });
}

function bindDocumentEvents() {
    if (document[DOCUMENT_GUARD]) return;
    document[DOCUMENT_GUARD] = true;
    document.addEventListener('click', event => {
        const apply = event.target.closest?.('[data-delta-apply-life]');
        if (apply) {
            event.preventDefault();
            const editor = apply.closest('.npc-state-delta-editor-popup');
            const npcId = plain(apply.dataset.npcId || editorNpcId(editor));
            const requested = plain(editor?.querySelector?.('[data-delta-life-state]')?.value || 'unknown');
            apply.disabled = true;
            void applyManualLifeState(npcId, requested, editor)
                .then(npc => {
                    if (!npc) return;
                    const preserveChoice = editor.querySelector('[data-delta-life-state]')?.value !== requested;
                    syncEditorLifecycle(editor, npc, { preserveChoice });
                    toast('success', `NPC State Delta: ${npc.name || 'NPC'} life state set to ${lifeStateChoice(npc)}.`);
                })
                .catch(error => toast('error', `NPC State Delta life-state update failed: ${error?.message || error}`))
                .finally(() => { if (apply.isConnected) apply.disabled = false; });
            return;
        }
        if (event.target.closest?.('[data-delta-settings-backup]')) {
            event.preventDefault();
            exportNativeTools();
            return;
        }
        if (event.target.closest?.('[data-delta-settings-restore]')) {
            event.preventDefault();
            void openImportTools();
            return;
        }
        if (event.target.closest?.('[data-delta-settings-diagnostics]')) {
            event.preventDefault();
            openDiagnostics();
        }
    });
}

function installRootObserver(root) {
    if (!root || root[ROOT_OBSERVER_GUARD]) return;
    root.addEventListener('npc-state-delta:dossier-rendered', () => scheduleNormalize(root));
    root[ROOT_OBSERVER_GUARD] = true;
}

function installEditorObserver() {
    if (document[EDITOR_OBSERVER_GUARD] || typeof MutationObserver === 'undefined' || !document.body) return;
    const observer = new MutationObserver(records => {
        const editors = new Set();
        for (const record of records) {
            const targetEditor = record.target?.closest?.('.npc-state-delta-editor-popup');
            if (targetEditor) editors.add(targetEditor);
            for (const node of record.addedNodes || []) {
                if (node?.nodeType !== 1) continue;
                if (node.matches?.('.npc-state-delta-editor-popup')) editors.add(node);
                node.querySelectorAll?.('.npc-state-delta-editor-popup').forEach(editor => editors.add(editor));
            }
        }
        for (const editor of editors) ensureEditorLifeState(editor);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document[EDITOR_OBSERVER_GUARD] = observer;
    document.querySelectorAll('.npc-state-delta-editor-popup').forEach(ensureEditorLifeState);
}

function scheduleSettingsExperience(attempt = 0) {
    if (ensureSettingsExperience()) return;
    if (attempt < 80) setTimeout(() => scheduleSettingsExperience(attempt + 1), 100);
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Settings stays in SillyTavern's Extensions tab. Extension-wide tools live there too. */
#npc_state_delta_dossier_root .delta-open-settings,
#npc_state_delta_dossier_root .delta-tools-data,
#npc_state_delta_dossier_root .delta-tools-diagnostics-button{display:none!important}

/* Floating launcher: keep the 48px drag/touch target, but present it as a circular FAB. */
#npc_state_delta_dossier_launcher{border-radius:50%!important}
#npc_state_delta_dossier_launcher .delta-launcher-mark{border-radius:50%!important}

/* Cast carousel: the portrait is the card; metadata floats over a bottom gradient. */
#npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 188px!important}
#npc_state_delta_dossier_root .delta-cast{grid-template-rows:auto minmax(0,1fr)!important}
#npc_state_delta_dossier_root .delta-cast-tools{display:grid!important;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:10px;padding:7px 10px!important}
#npc_state_delta_dossier_root .delta-library-heading{font-size:.68rem;letter-spacing:.12em;color:var(--delta-muted);white-space:nowrap}
#npc_state_delta_dossier_root .delta-search-label{max-width:none!important;min-width:0!important}
#npc_state_delta_dossier_root .delta-filters{justify-self:end;flex-wrap:nowrap!important}
#npc_state_delta_dossier_root .delta-cast-rail-wrap{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) 30px;align-items:stretch;min-height:0;overflow:hidden;padding:7px 6px 9px;gap:4px}
#npc_state_delta_dossier_root .delta-cast-list{display:flex!important;gap:8px!important;overflow-x:auto!important;overflow-y:hidden!important;min-width:0!important;min-height:0!important;padding:0 2px!important;scrollbar-width:none!important;scroll-snap-type:x proximity;overscroll-behavior-x:contain}
#npc_state_delta_dossier_root .delta-cast-list::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
#npc_state_delta_dossier_root .delta-cast-card{position:relative!important;isolation:isolate;flex:0 0 118px!important;width:118px!important;min-width:118px!important;height:132px!important;display:block!important;padding:0!important;overflow:hidden!important;text-align:left!important;border-radius:10px!important;scroll-snap-align:start;background:rgba(0,0,0,.28)!important}
#npc_state_delta_dossier_root .delta-cast-card.selected{box-shadow:inset 0 0 0 1px var(--delta-accent),0 0 0 1px var(--delta-accent)!important}
#npc_state_delta_dossier_root .delta-cast-portrait{position:absolute!important;z-index:0;inset:0!important;display:block!important;width:100%!important;height:100%!important;min-width:0!important;max-width:none!important;border:0!important;border-radius:0!important;object-fit:cover!important;object-position:center 18%!important}
#npc_state_delta_dossier_root .delta-cast-portrait.delta-portrait-placeholder{display:grid!important;place-items:center!important;background:radial-gradient(circle at 50% 24%,rgba(216,188,120,.16),rgba(0,0,0,.48))!important}
#npc_state_delta_dossier_root .delta-cast-portrait.delta-portrait-placeholder span{font-size:2.4rem!important;opacity:.8}
#npc_state_delta_dossier_root .delta-cast-copy{position:absolute!important;z-index:2;left:0;right:0;bottom:0;display:grid!important;align-content:end!important;gap:1px!important;min-width:0!important;padding:28px 7px 7px!important;color:#f6f1e7!important;background:linear-gradient(to bottom,transparent,rgba(5,6,8,.76) 44%,rgba(5,6,8,.96) 100%)}
#npc_state_delta_dossier_root .delta-cast-copy b{font-size:.76rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff7e3!important;text-shadow:0 1px 2px rgba(0,0,0,.9)}
#npc_state_delta_dossier_root .delta-cast-copy small{font-size:.61rem!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.72)!important}
#npc_state_delta_dossier_root .delta-cast-copy .delta-status{font-size:.57rem!important;padding:1px 4px!important;margin-top:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;background:rgba(15,20,20,.74)!important;backdrop-filter:blur(3px)}
#npc_state_delta_dossier_root .delta-rail-arrow{appearance:none;border:0;background:transparent;color:var(--delta-muted);font-size:1.9rem;line-height:1;cursor:pointer;border-radius:7px;padding:0}
#npc_state_delta_dossier_root .delta-rail-arrow:hover{color:var(--delta-accent-soft);background:rgba(255,255,255,.05)}

#npc_state_delta_dossier_root .delta-hero-actions{display:block!important;padding:9px!important}
#npc_state_delta_dossier_root .delta-dossier-actions-primary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:stretch}
#npc_state_delta_dossier_root .delta-dossier-more{position:relative;min-width:116px}
#npc_state_delta_dossier_root .delta-dossier-more>summary{list-style:none;display:grid;place-items:center;height:100%;cursor:pointer;user-select:none}
#npc_state_delta_dossier_root .delta-dossier-more>summary::-webkit-details-marker{display:none}
#npc_state_delta_dossier_root .delta-dossier-more-menu{position:absolute;right:0;bottom:calc(100% + 7px);z-index:30;width:210px;display:grid;gap:6px;padding:8px;border:1px solid var(--delta-line);border-radius:10px;background:color-mix(in srgb,var(--delta-bg) 96%,black 4%);box-shadow:0 12px 34px rgba(0,0,0,.46)}
#npc_state_delta_dossier_root .delta-dossier-more-menu .delta-btn{text-align:left;width:100%}
#npc_state_delta_dossier_root .delta-npc-diagnostics{margin:0 9px 9px;padding:9px;border:1px solid var(--delta-line);border-radius:9px;background:rgba(0,0,0,.16);max-height:330px;overflow:auto}
#npc_state_delta_dossier_root .delta-npc-diagnostics>header{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:7px;color:var(--delta-accent-soft)}
#npc_state_delta_dossier_root .delta-npc-diagnostics>header small{color:var(--delta-muted)}
#npc_state_delta_dossier_root .delta-npc-diagnostics details{border-top:1px solid rgba(255,255,255,.07);padding:5px 0}
#npc_state_delta_dossier_root .delta-npc-diagnostics summary{cursor:pointer;font-size:.76rem}
#npc_state_delta_dossier_root .delta-npc-diagnostics pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.68rem;max-height:220px;overflow:auto;margin:5px 0 0;padding:7px;background:rgba(0,0,0,.2);border-radius:6px}

/* One editor viewport, one scrollbar. SillyTavern keeps Save/Cancel outside this body. */
.npc-state-delta-editor-popup{--delta-editor-height:min(940px,96dvh);width:min(1320px,97vw)!important;max-width:none!important;height:var(--delta-editor-height)!important;max-height:96dvh!important;margin:auto!important;overflow:hidden!important}
.npc-state-delta-editor-popup .popup-content{display:flex!important;flex-direction:column!important;min-height:0!important;max-height:none!important;overflow:hidden!important}
.npc-state-delta-editor-popup #npc_state_delta_editor_content{flex:1 1 auto!important;min-height:0!important;max-height:calc(var(--delta-editor-height) - 112px)!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;padding-right:8px;scrollbar-gutter:stable}
.npc-state-delta-editor-popup .npc-state-delta-editor-head{position:sticky;top:0;z-index:4;margin:-1px -1px 12px;padding:10px 2px 9px;background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#18191d) 96%,black 4%);border-bottom:1px solid rgba(218,193,148,.14)}
.npc-state-delta-editor-popup .npc-state-delta-editor-tools,.npc-state-delta-editor-popup .npc-state-delta-editor-portrait-overrides{display:none!important}
.npc-state-delta-editor-popup .delta-editor-section{margin:12px 0;padding:13px;border:1px solid rgba(218,193,148,.16);border-radius:10px;background:rgba(255,255,255,.025)}
.npc-state-delta-editor-popup .delta-editor-section>h4{margin:0 0 11px;color:#e3c985;font-size:.84rem;letter-spacing:.08em;text-transform:uppercase}
.npc-state-delta-editor-popup .delta-editor-section-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.npc-state-delta-editor-popup .delta-editor-section-grid>label{display:grid;gap:5px;margin:0;min-width:0}
.npc-state-delta-editor-popup .delta-editor-section-grid>.delta-editor-wide{grid-column:1/-1}
.npc-state-delta-editor-popup .delta-editor-section-grid textarea{resize:vertical;max-width:100%}
.npc-state-delta-editor-popup .npc-state-delta-editor-stats{grid-column:1/-1;margin:2px 0 0}
.npc-state-delta-editor-popup .delta-editor-advanced{margin:12px 0;border:1px solid rgba(218,193,148,.19);border-radius:10px;overflow:hidden}
.npc-state-delta-editor-popup .delta-editor-advanced>summary{display:flex;align-items:baseline;gap:9px;padding:11px 13px;cursor:pointer;color:#e3c985;background:rgba(216,188,120,.045)}
.npc-state-delta-editor-popup .delta-editor-advanced>summary small{color:var(--SmartThemeBodyColor,#ddd);opacity:.55;font-weight:400}
.npc-state-delta-editor-popup .delta-editor-advanced-body{display:grid;gap:10px;padding:12px 13px}
.npc-state-delta-editor-popup .delta-editor-life-control{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:8px 10px;align-items:end;margin:0;padding:11px;border:1px solid rgba(218,193,148,.14);border-radius:9px;background:rgba(255,255,255,.035)}
.npc-state-delta-editor-popup .delta-editor-life-control label{display:grid;gap:5px;margin:0}
.npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1/-1;opacity:.72}

/* Extension settings: same visual grammar, grouped by task instead of one long wall. */
#npc_state_delta_settings .npc-state-delta-intro{margin:0 0 10px;padding:10px 12px;border:1px solid rgba(218,193,148,.12);border-radius:9px;background:rgba(255,255,255,.025);opacity:.82}
#npc_state_delta_settings .delta-settings-experience{display:grid;gap:9px}
#npc_state_delta_settings .delta-settings-group{margin:0;border:1px solid rgba(218,193,148,.14);border-radius:9px;overflow:hidden;background:rgba(255,255,255,.018)}
#npc_state_delta_settings .delta-settings-group>summary{display:flex;align-items:baseline;gap:8px;padding:10px 12px;cursor:pointer;background:rgba(255,255,255,.028)}
#npc_state_delta_settings .delta-settings-group>summary b{font-size:.95rem}
#npc_state_delta_settings .delta-settings-group>summary small{opacity:.55;font-weight:400}
#npc_state_delta_settings .delta-settings-group-body,#npc_state_delta_settings .npc-state-delta-portrait-settings-body,#npc_state_delta_settings .npc-state-delta-tuning-body{padding:10px 12px}
#npc_state_delta_settings .delta-settings-group-body{display:grid;gap:7px}
#npc_state_delta_settings .npc-state-delta-setting-row{margin:0;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.055)}
#npc_state_delta_settings .npc-state-delta-setting-row:last-child{border-bottom:0}
#npc_state_delta_settings .delta-settings-subsection+ .delta-settings-subsection{margin-top:12px;padding-top:12px;border-top:1px solid rgba(218,193,148,.12)}
#npc_state_delta_settings .delta-settings-subsection>h4{margin:0 0 8px;color:#e3c985}
#npc_state_delta_settings .delta-settings-maintenance-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:0 0 8px}
#npc_state_delta_settings .delta-settings-maintenance-actions>.menu_button{display:flex;justify-content:center;align-items:center;gap:6px;min-height:40px;text-align:center}
#npc_state_delta_settings .delta-settings-current-roster{margin-top:5px;border-top:1px solid rgba(218,193,148,.12);padding-top:8px}
#npc_state_delta_settings .delta-settings-current-roster>summary{display:flex;gap:8px;align-items:baseline;cursor:pointer;padding:6px 0}
#npc_state_delta_settings .delta-settings-current-roster>summary small{opacity:.55}

@media(max-width:900px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 198px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr auto!important}
  #npc_state_delta_dossier_root .delta-library-heading{grid-column:1/-1}
  #npc_state_delta_dossier_root .delta-search-label{grid-column:1/2}
  #npc_state_delta_dossier_root .delta-filters{grid-column:2/3}
  .npc-state-delta-editor-popup .delta-editor-section-grid{grid-template-columns:1fr}
  .npc-state-delta-editor-popup .delta-editor-section-grid>.delta-editor-wide{grid-column:1}
}
@media(max-width:650px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 226px!important}
  #npc_state_delta_dossier_root .delta-cast-tools{grid-template-columns:1fr!important;gap:6px!important}
  #npc_state_delta_dossier_root .delta-library-heading,#npc_state_delta_dossier_root .delta-search-label,#npc_state_delta_dossier_root .delta-filters{grid-column:1!important;justify-self:stretch!important}
  #npc_state_delta_dossier_root .delta-filters{overflow-x:auto}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:106px!important;width:106px!important;min-width:106px!important;height:126px!important}
  #npc_state_delta_dossier_root .delta-dossier-actions-primary{grid-template-columns:1fr 1fr auto}
  #npc_state_delta_dossier_root .delta-dossier-more{min-width:92px}
  .npc-state-delta-editor-popup{--delta-editor-height:100dvh;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important}
  .npc-state-delta-editor-popup #npc_state_delta_editor_content{max-height:calc(100dvh - 96px)!important;padding-right:4px}
  .npc-state-delta-editor-popup .delta-editor-life-control{grid-template-columns:1fr}
  .npc-state-delta-editor-popup .delta-editor-life-control small{grid-column:1}
  #npc_state_delta_settings .delta-settings-maintenance-actions{grid-template-columns:1fr}
}
`;
    document.head.appendChild(style);
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    bindDocumentEvents();
    installEditorObserver();
    scheduleSettingsExperience();
    const root = uiRoot();
    if (!root) {
        if (attempt < 80) setTimeout(() => start(attempt + 1), 100);
        return;
    }
    bindDossierEvents(root);
    normalizeRoot(root);
    installRootObserver(root);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}
