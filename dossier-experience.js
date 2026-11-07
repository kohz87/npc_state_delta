/* NPC State Delta cohesive dossier experience refinement.
 * Keeps canonical state/runtime owners while refining dossier actions, cast carousel,
 * adaptive editing, extension-wide settings actions, and explicit manual life-state correction.
 */
import { activeChatKey, api, escapeHtml, flushDurably, plain, stage1Refresh, uiRoot } from './dossier-tools-core.js';
import { exportNativeTools, openDiagnostics, openImportTools } from './dossier-tools.js';
import { openPortraitTools } from './portrait-tools.js';
import { currentNpc, lifeStateChoice, selectedNpcId, setNodeTextIfChanged, setNodeValueIfChanged } from './dossier-experience-state.js';
export { lifeStateChoice, setNodeTextIfChanged };
import { installStyles } from './dossier-experience-styles.js';

const ROOT_OBSERVER_GUARD = '__npcStateDeltaDossierExperienceRootObserver';
const EDITOR_OBSERVER_GUARD = '__npcStateDeltaDossierExperienceEditorObserver';
const DOSSIER_GUARD = '__npcStateDeltaDossierExperienceEvents';
const DOCUMENT_GUARD = '__npcStateDeltaDossierExperienceDocumentEvents';
const diagnosticVisibleNpcIds = new Set();
// The library starts collapsed each time the dossier panel opens, leaving the open dossier the
// room; expanding it lasts until the panel closes. This is presentation only, never dossier state.
let libraryCollapsed = true;
let normalizeQueued = false;

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }

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
    if (!await runtime.updateLifeState?.(npcId, choice, { chatKey })) throw new Error('The canonical life-state edit rejected its stale target.');
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
        heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'delta-library-heading';
        heading.dataset.deltaLibraryToggle = '1';
        tools.prepend(heading);
    }
    const total = root.__npcStateDeltaStage1Ui?.projection?.npcs?.length || 0;
    setNodeTextIfChanged(heading, `${libraryCollapsed ? '▸' : '▾'} DOSSIER LIBRARY · ${total} NPC${total === 1 ? '' : 's'}`);
    const expanded = libraryCollapsed ? 'false' : 'true';
    if (heading.getAttribute?.('aria-expanded') !== expanded) heading.setAttribute('aria-expanded', expanded);
    const title = libraryCollapsed ? 'Show the dossier library' : 'Hide the dossier library for more reading space';
    if (heading.title !== title) heading.title = title;
    root.querySelector?.('.delta-library')?.classList?.toggle?.('delta-library-collapsed', libraryCollapsed);

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

    const identity = editorSection('Identity & profile', 'delta-editor-identity');
    for (const [id, wide] of [
        ['npc_state_delta_edit_name', false], ['npc_state_delta_edit_species', false],
        ['npc_state_delta_edit_gender', false], ['npc_state_delta_edit_role', false], ['npc_state_delta_edit_home_base', false],
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
    content.dataset.deltaExperienceStructured = '1';
    content.dispatchEvent?.(new CustomEvent('npc-state-delta:editor-mounted', { bubbles: true }));
}

function ensureEditorLifeState(editor) {
    if (!editor?.isConnected) return;
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
            openPortraitTools(plain(portrait.dataset.npcId), { form: plain(portrait.dataset.form) });
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
        const libraryToggle = event.target.closest?.('[data-delta-library-toggle]');
        if (libraryToggle) {
            event.preventDefault();
            libraryCollapsed = !libraryCollapsed;
            ensureLibraryChrome(root);
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
            return;
        }
        if (event.target.closest?.('[data-delta-settings-open-dossiers]')) {
            event.preventDefault();
            const controller = uiRoot()?.__npcStateDeltaStage1Ui;
            if (typeof controller?.open === 'function') void controller.open();
            else toast('warning', 'NPC State Delta dossier UI is still mounting.');
        }
    });
}

function installRootObserver(root) {
    if (!root || root[ROOT_OBSERVER_GUARD]) return;
    root.addEventListener('npc-state-delta:dossier-rendered', () => scheduleNormalize(root));
    const panel = root.querySelector?.('.delta-panel');
    if (panel && typeof MutationObserver !== 'undefined') {
        new MutationObserver(() => {
            if (!panel.hidden || libraryCollapsed) return;
            libraryCollapsed = true;
            ensureLibraryChrome(root);
        }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    }
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

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    bindDocumentEvents();
    installEditorObserver();
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
