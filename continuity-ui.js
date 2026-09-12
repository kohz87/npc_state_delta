/* NPC State Delta continuity UI adapter for calendar/birthday and appearance-form surfaces. */
import { encodeNpcStateBundle } from './bundle.js';
import {
    formatAppearanceForms,
    normalizeAppearanceModel,
    parseAppearanceFormsText,
    resolveNpcAppearance,
} from './appearance.js';
import { formatBirthDate } from './birthday.js';
import { activeChatKey, api, stage1Refresh, uiRoot } from './dossier-tools-core.js';

const CALENDAR_ROOT_ID = 'npc_state_delta_calendar_settings';
const CALENDAR_GROUP_ID = 'npc_state_delta_calendar_birthdays_group';
const STYLE_ID = 'npc_state_delta_continuity_ui_styles';
const UNKNOWN_FORM = '__unknown__';
const NO_FORM = '__none__';
let observer = null;
let normalizeQueued = false;

function plain(value) { return String(value ?? '').trim(); }
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}
function formKey(value) { return plain(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '); }
function currentNpc(npcId = '') {
    try { return api()?.getState?.()?.npcs?.find?.(npc => String(npc?.id || '') === String(npcId || '')) || null; }
    catch { return null; }
}
function selectedNpcId(root = uiRoot()) {
    return plain(root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || root?.querySelector?.('.delta-cast-card.selected')?.dataset?.npcId);
}
function editorNpcId(editor) {
    return plain(editor?.querySelector?.('[data-npc-id]')?.dataset?.npcId);
}

export function appearanceUiModel(npc = {}) {
    const locked = Array.isArray(npc?.manualProfileFields) && npc.manualProfileFields.includes('appearance');
    const model = normalizeAppearanceModel(npc, { locked });
    return {
        overallAppearance: model.overallAppearance,
        appearanceForms: model.appearanceForms.map(form => ({ ...form })),
        currentForm: model.currentForm,
        currentFormUnknown: Boolean(model.currentFormUnknown),
        unclassifiedAppearance: model.unclassifiedAppearance,
        resolvedAppearance: resolveNpcAppearance(npc),
    };
}

export function appearanceDraftRecord(npc = {}, draft = {}, { lockAppearance = false } = {}) {
    const forms = parseAppearanceFormsText(draft.formsText ?? formatAppearanceForms(npc?.appearanceForms));
    const selected = plain(draft.currentForm);
    const currentFormUnknown = selected === UNKNOWN_FORM || draft.currentFormUnknown === true;
    const currentForm = currentFormUnknown || selected === NO_FORM ? '' : selected;
    if (currentForm && !forms.some(form => formKey(form.name) === formKey(currentForm))) {
        throw new Error(`Current form is not in the appearance-form list: ${currentForm}`);
    }

    const nextInput = {
        ...npc,
        appearanceModelVersion: 1,
        overallAppearance: plain(draft.overallAppearance).slice(0, 1800),
        appearanceForms: forms,
        currentForm,
        currentFormUnknown,
    };
    if (currentFormUnknown) {
        nextInput.unclassifiedAppearance = plain(draft.unclassifiedAppearance ?? npc?.unclassifiedAppearance ?? npc?.appearance).slice(0, 1800);
    }

    const normalized = normalizeAppearanceModel(nextInput, { locked: false });
    const next = { ...npc, ...normalized };
    next.appearance = resolveNpcAppearance(next);
    next.manualProfileLocksExplicit = true;
    const locks = new Set(Array.isArray(npc?.manualProfileFields) ? npc.manualProfileFields : []);
    if (lockAppearance) locks.add('appearance');
    next.manualProfileFields = [...locks];
    return next;
}

function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CALENDAR_GROUP_ID} > summary { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
      #${CALENDAR_GROUP_ID} > summary small { opacity:.7; font-size:.8em; }
      #${CALENDAR_GROUP_ID} .npc-state-delta-calendar-dedicated-body { display:grid; grid-template-columns:minmax(0,1fr); gap:9px; }
      #${CALENDAR_GROUP_ID} .npc-state-delta-calendar-heading { margin:0; padding:0; border:0; }
      .delta-continuity-birthday-card .delta-continuity-source { display:block; opacity:.65; font-size:.78em; margin-top:2px; }
      .delta-appearance-form-summary { margin-top:10px; border:1px solid rgba(127,127,127,.22); border-radius:10px; padding:8px 10px; }
      .delta-appearance-form-summary > summary { cursor:pointer; display:flex; gap:8px; align-items:baseline; }
      .delta-appearance-form-summary > summary small { opacity:.7; }
      .delta-appearance-form-list { display:grid; gap:8px; margin-top:9px; }
      .delta-appearance-form-row { border-top:1px solid rgba(127,127,127,.18); padding-top:7px; }
      .delta-appearance-form-row:first-child { border-top:0; padding-top:0; }
      .delta-appearance-form-row b { display:flex; gap:7px; align-items:center; }
      .delta-appearance-current-badge { font-size:.72em; border:1px solid currentColor; border-radius:999px; padding:1px 6px; opacity:.72; }
      .delta-editor-appearance-forms .delta-editor-section-grid { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
      .delta-editor-appearance-forms label { display:flex; flex-direction:column; gap:4px; min-width:0; }
      .delta-editor-appearance-forms .delta-appearance-wide { grid-column:1 / -1; }
      .delta-editor-appearance-forms textarea { resize:vertical; }
      .delta-editor-appearance-actions { grid-column:1 / -1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .delta-editor-appearance-actions small { opacity:.72; }
      @media (max-width:700px) {
        .delta-editor-appearance-forms .delta-editor-section-grid { grid-template-columns:minmax(0,1fr); }
        .delta-editor-appearance-forms .delta-appearance-wide { grid-column:auto; }
        .delta-editor-appearance-actions button { min-height:44px; }
      }
    `;
    document.head.appendChild(style);
}

function ensureCalendarDedicatedSection() {
    const root = document.getElementById(CALENDAR_ROOT_ID);
    if (!root) return false;
    const settings = document.getElementById('npc_state_delta_settings');
    const drawer = settings?.querySelector?.('.npc-state-delta-drawer');
    if (!settings || !drawer) return false;

    let group = document.getElementById(CALENDAR_GROUP_ID);
    if (!group) {
        group = document.createElement('details');
        group.id = CALENDAR_GROUP_ID;
        group.className = 'delta-settings-group npc-state-delta-calendar-birthdays-group';
        const summary = document.createElement('summary');
        summary.innerHTML = '<b>Calendar & birthdays</b><small>Fantasy months, birthday generation and optional campaign clock</small>';
        const body = document.createElement('div');
        body.className = 'delta-settings-group-body npc-state-delta-calendar-dedicated-body';
        group.append(summary, body);
    }
    const body = group.querySelector('.npc-state-delta-calendar-dedicated-body');
    if (root.parentElement !== body) body.appendChild(root);

    const layout = settings.querySelector('.delta-settings-experience');
    const target = layout || drawer;
    if (group.parentElement !== target) {
        if (layout) {
            const continuity = [...layout.children].find(node => /Continuity\s*&\s*injection/i.test(node.querySelector?.(':scope > summary')?.textContent || ''));
            if (continuity?.nextSibling) layout.insertBefore(group, continuity.nextSibling);
            else if (continuity) layout.appendChild(group);
            else {
                const portrait = layout.querySelector('.delta-settings-portrait-prompts, .npc-state-delta-portrait-generation-settings');
                if (portrait) layout.insertBefore(group, portrait);
                else layout.appendChild(group);
            }
        } else {
            const portrait = drawer.querySelector('.npc-state-delta-portrait-generation-settings');
            if (portrait) drawer.insertBefore(group, portrait);
            else drawer.appendChild(group);
        }
    }
    return true;
}

function birthDisplay(npc = {}) {
    return plain(npc?.birthDateDisplay) || formatBirthDate(npc?.birthDate) || '';
}

function ensureDossierContinuitySurface() {
    const root = uiRoot();
    if (!root?.isConnected) return false;
    const npcId = selectedNpcId(root);
    const npc = currentNpc(npcId);
    if (!npcId || !npc) return false;

    const currentGrid = root.querySelector('.delta-document .delta-current-grid');
    if (currentGrid) {
        let card = currentGrid.querySelector('.delta-continuity-birthday-card');
        if (!card) {
            card = document.createElement('div');
            card.className = 'delta-current-card delta-continuity-birthday-card';
            currentGrid.appendChild(card);
        }
        const birthday = birthDisplay(npc);
        const source = plain(npc?.birthDateSource);
        const sourceLabel = source === 'generated' ? 'Deterministic fallback' : source === 'established' ? 'Story established' : '';
        const signature = `${birthday}|${sourceLabel}`;
        if (card.dataset.signature !== signature) {
            card.innerHTML = `<b>Birthday</b><span>${escapeHtml(birthday || 'Unknown')}</span>${sourceLabel ? `<small class="delta-continuity-source">${escapeHtml(sourceLabel)}</small>` : ''}`;
            card.dataset.signature = signature;
        }
    }

    const appearanceHeading = [...root.querySelectorAll('.delta-document .delta-prose-grid h4')]
        .find(node => /^Appearance$/i.test(plain(node.textContent)));
    const appearanceBlock = appearanceHeading?.parentElement;
    if (!appearanceBlock) return true;
    const model = appearanceUiModel(npc);
    const signature = JSON.stringify({
        currentForm: model.currentForm,
        currentFormUnknown: model.currentFormUnknown,
        overallAppearance: model.overallAppearance,
        forms: model.appearanceForms,
    });
    let details = appearanceBlock.querySelector('.delta-appearance-form-summary');
    if (!details) {
        details = document.createElement('details');
        details.className = 'delta-appearance-form-summary';
        appearanceBlock.appendChild(details);
    }
    if (details.dataset.signature !== signature) {
        const label = model.currentFormUnknown ? 'Unclassified / unknown' : (model.currentForm || 'No selected form');
        const rows = model.appearanceForms.length
            ? model.appearanceForms.map(form => {
                const current = !model.currentFormUnknown && formKey(form.name) === formKey(model.currentForm);
                return `<div class="delta-appearance-form-row"><b>${escapeHtml(form.name)}${current ? '<span class="delta-appearance-current-badge">Current</span>' : ''}</b><p>${escapeHtml(form.appearance)}</p></div>`;
            }).join('')
            : '<p class="delta-muted">No named forms established.</p>';
        details.innerHTML = `<summary><b>Appearance forms</b><small>Current: ${escapeHtml(label)}</small></summary><div class="delta-appearance-form-list">${model.overallAppearance ? `<div class="delta-appearance-form-row"><b>Shared across forms</b><p>${escapeHtml(model.overallAppearance)}</p></div>` : ''}${rows}</div>`;
        details.dataset.signature = signature;
    }
    return true;
}

function editorAppearanceSection(editor) {
    return editor?.querySelector?.('.delta-editor-appearance-forms') || null;
}

function appearanceFormOptions(model) {
    return [
        `<option value="${NO_FORM}">No selected form</option>`,
        ...model.appearanceForms.map(form => `<option value="${escapeHtml(form.name)}">${escapeHtml(form.name)}</option>`),
        `<option value="${UNKNOWN_FORM}">Unclassified / unknown current form</option>`,
    ].join('');
}

function syncAppearanceEditor(editor, npc = currentNpc(editorNpcId(editor))) {
    const section = editorAppearanceSection(editor);
    if (!section || !npc) return;
    const model = appearanceUiModel(npc);
    const overall = section.querySelector('[data-delta-overall-appearance]');
    const forms = section.querySelector('[data-delta-appearance-forms]');
    const current = section.querySelector('[data-delta-current-form]');
    const unclassified = section.querySelector('[data-delta-unclassified-appearance]');
    if (overall) overall.value = model.overallAppearance || '';
    if (forms) forms.value = formatAppearanceForms(model.appearanceForms);
    if (current) {
        current.innerHTML = appearanceFormOptions(model);
        current.value = model.currentFormUnknown ? UNKNOWN_FORM : (model.currentForm || NO_FORM);
    }
    if (unclassified) unclassified.value = model.unclassifiedAppearance || '';
    toggleUnclassifiedAppearance(section);
    section.dataset.npcId = String(npc.id || '');
    const status = section.querySelector('[data-delta-appearance-status]');
    if (status) status.textContent = `${model.appearanceForms.length} named form${model.appearanceForms.length === 1 ? '' : 's'} · current ${model.currentFormUnknown ? 'unclassified' : (model.currentForm || 'not selected')}`;
}

function toggleUnclassifiedAppearance(section) {
    const select = section?.querySelector?.('[data-delta-current-form]');
    const holder = section?.querySelector?.('[data-delta-unclassified-holder]');
    if (holder) holder.hidden = select?.value !== UNKNOWN_FORM;
}

function ensureAppearanceEditor(editor) {
    const content = editor?.querySelector?.('#npc_state_delta_editor_content');
    const npcId = editorNpcId(editor);
    const npc = currentNpc(npcId);
    if (!content || !npcId || !npc) return false;
    let section = editorAppearanceSection(editor);
    if (!section) {
        section = document.createElement('section');
        section.className = 'delta-editor-section delta-editor-appearance-forms';
        section.innerHTML = `<h4>Appearance forms</h4><div class="delta-editor-section-grid">
          <label class="delta-appearance-wide">Shared appearance <small>Visible in every form, such as a persistent scar or pendant.</small><textarea class="text_pole" rows="3" maxlength="1800" data-delta-overall-appearance></textarea></label>
          <label>Current form<select class="text_pole" data-delta-current-form></select></label>
          <label data-delta-unclassified-holder hidden>Unclassified current appearance<textarea class="text_pole" rows="3" maxlength="1800" data-delta-unclassified-appearance></textarea></label>
          <label class="delta-appearance-wide">Named forms <small>One per line: Form name | Description. Maximum 8.</small><textarea class="text_pole" rows="7" spellcheck="false" data-delta-appearance-forms placeholder="Human | ordinary human ears, no wings...&#10;Dragon | silver scales, horns, broad wings..."></textarea></label>
          <div class="delta-editor-appearance-actions"><button type="button" class="menu_button" data-delta-apply-appearance>Apply appearance forms</button><small data-delta-appearance-status></small></div>
        </div>`;
        const identity = content.querySelector('.delta-editor-identity');
        if (identity?.nextSibling) content.insertBefore(section, identity.nextSibling);
        else if (identity) content.appendChild(section);
        else {
            const appearanceLabel = content.querySelector('#npc_state_delta_edit_appearance')?.closest?.('label');
            if (appearanceLabel?.parentElement) appearanceLabel.parentElement.insertBefore(section, appearanceLabel.nextSibling);
            else content.appendChild(section);
        }
        section.querySelector('[data-delta-current-form]')?.addEventListener('change', () => toggleUnclassifiedAppearance(section));
        syncAppearanceEditor(editor, npc);
    } else if (section.dataset.npcId !== npcId) {
        syncAppearanceEditor(editor, npc);
    }
    return true;
}

async function applyAppearanceEditor(editor) {
    const runtime = api();
    const chatKey = activeChatKey();
    const npcId = editorNpcId(editor);
    const npc = currentNpc(npcId);
    const section = editorAppearanceSection(editor);
    if (!runtime || !chatKey || chatKey === 'no-chat') throw new Error('Open a chat before editing appearance forms.');
    if (!npc || !section) throw new Error('The selected NPC is no longer available.');

    const next = appearanceDraftRecord(npc, {
        overallAppearance: section.querySelector('[data-delta-overall-appearance]')?.value || '',
        currentForm: section.querySelector('[data-delta-current-form]')?.value || NO_FORM,
        unclassifiedAppearance: section.querySelector('[data-delta-unclassified-appearance]')?.value || '',
        formsText: section.querySelector('[data-delta-appearance-forms]')?.value || '',
    }, {
        lockAppearance: Boolean(editor.querySelector('#npc_state_delta_edit_lock_profile')?.checked),
    });

    const bytes = encodeNpcStateBundle({
        npcs: [next],
        socialGraph: { edges: [], unresolved: [] },
        dismissed: [],
    }, {
        appVersion: runtime.uiStatus?.()?.version || '0.1.0',
        chatKey,
    });
    const imported = await runtime.importBytes?.(bytes);
    if (!imported) throw new Error('The canonical dossier importer rejected the appearance-form edit.');
    await runtime.flush?.();
    stage1Refresh();
    const refreshed = currentNpc(npcId) || next;
    const compatibilityAppearance = editor.querySelector('#npc_state_delta_edit_appearance');
    if (compatibilityAppearance) compatibilityAppearance.value = refreshed.appearance || resolveNpcAppearance(refreshed) || '';
    syncAppearanceEditor(editor, refreshed);
    scheduleNormalize();
    return refreshed;
}

function scheduleNormalize() {
    if (normalizeQueued || typeof requestAnimationFrame !== 'function') return;
    normalizeQueued = true;
    requestAnimationFrame(() => {
        normalizeQueued = false;
        try {
            ensureCalendarDedicatedSection();
            ensureDossierContinuitySurface();
            document.querySelectorAll('.npc-state-delta-editor-popup').forEach(ensureAppearanceEditor);
        } catch (error) {
            console.debug('[NPC State Delta] continuity UI normalization skipped', error);
        }
    });
}

function bindEvents() {
    if (globalThis.__npcStateDeltaContinuityUiBound) return;
    globalThis.__npcStateDeltaContinuityUiBound = true;
    document.addEventListener('click', event => {
        const apply = event.target.closest?.('[data-delta-apply-appearance]');
        if (!apply) return;
        event.preventDefault();
        const editor = apply.closest('.npc-state-delta-editor-popup');
        if (!editor) return;
        apply.disabled = true;
        const status = editorAppearanceSection(editor)?.querySelector('[data-delta-appearance-status]');
        if (status) status.textContent = 'Applying…';
        void applyAppearanceEditor(editor)
            .then(() => globalThis.toastr?.success?.('NPC State Delta: appearance forms updated.'))
            .catch(error => {
                console.error('[NPC State Delta] appearance-form edit failed', error);
                if (status) status.textContent = error?.message || String(error);
                globalThis.toastr?.error?.(`NPC State Delta appearance forms were not updated: ${error?.message || error}`);
            })
            .finally(() => { apply.disabled = false; });
    });
}

function mount() {
    if (typeof document === 'undefined') return;
    injectStyles();
    bindEvents();
    scheduleNormalize();
    if (!observer && typeof MutationObserver === 'function' && document.documentElement) {
        observer = new MutationObserver(scheduleNormalize);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
}
