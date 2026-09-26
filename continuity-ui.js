/* NPC State Delta continuity UI adapter for the appearance-form editor surface.
 * Calendar settings mount through calendar-settings.js into the settings panel's calendar slot. */
import {
    formatAppearanceForms,
    normalizeAppearanceModel,
    parseAppearanceFormsText,
    resolveNpcAppearance,
} from './appearance.js';
import { activeChatKey, api, flushDurably, stage1Refresh } from './dossier-tools-core.js';

const STYLE_ID = 'npc_state_delta_continuity_ui_styles';
const UNKNOWN_FORM = '__unknown__';
const NO_FORM = '__none__';
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
    try { return api()?.getNpc?.(npcId) || null; }
    catch { return null; }
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

function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
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
      .delta-editor-appearance-forms [hidden] { display:none!important; }
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
    section.dataset.chatKey = activeChatKey();
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
    if (!content || !npcId) return false;
    let section = editorAppearanceSection(editor);
    if (section?.dataset.npcId === npcId && section.dataset.chatKey === activeChatKey()) return true;
    const npc = currentNpc(npcId);
    if (!npc) return false;
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
        else content.appendChild(section);
        section.addEventListener('input', () => { section.dataset.editRevision = String(Number(section.dataset.editRevision || 0) + 1); });
        section.querySelector('[data-delta-current-form]')?.addEventListener('change', () => toggleUnclassifiedAppearance(section));
        section.querySelector('[data-delta-appearance-forms]')?.addEventListener('input', () => {
            try {
                const forms = parseAppearanceFormsText(section.querySelector('[data-delta-appearance-forms]').value);
                const select = section.querySelector('[data-delta-current-form]');
                const selected = select.value;
                select.innerHTML = appearanceFormOptions({ appearanceForms: forms });
                if ([...select.options].some(option => option.value === selected)) select.value = selected;
                else {
                    const option = document.createElement('option');
                    option.value = selected;
                    option.textContent = `${selected} (removed; choose a current form)`;
                    select.appendChild(option);
                    select.value = selected;
                }
            } catch { /* Incomplete typing is validated on explicit Apply, never erased. */ }
        });
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
    if (!npc || !section || section.dataset.chatKey !== chatKey || !editor.isConnected) throw new Error('The selected NPC is no longer available in this chat.');
    const revision = section.dataset.editRevision || '0';

    const applied = await runtime.updateAppearance?.(npcId, {
        overallAppearance: section.querySelector('[data-delta-overall-appearance]')?.value || '',
        currentForm: section.querySelector('[data-delta-current-form]')?.value || NO_FORM,
        unclassifiedAppearance: section.querySelector('[data-delta-unclassified-appearance]')?.value || '',
        formsText: section.querySelector('[data-delta-appearance-forms]')?.value || '',
    }, { chatKey, lockAppearance: Boolean(editor.querySelector('#npc_state_delta_edit_lock_profile')?.checked) });
    if (!applied) throw new Error('The canonical appearance edit was rejected because its target changed.');
    const saved = await flushDurably(chatKey, 'appearance forms');
    if (!saved.persisted) throw new Error('Appearance forms applied locally, but durable save failed. Your edits are retained.');
    if (activeChatKey() !== chatKey || !editor.isConnected || section.dataset.chatKey !== chatKey) return null;
    stage1Refresh();
    const refreshed = currentNpc(npcId);
    if (!refreshed) return null;
    if ((section.dataset.editRevision || '0') === revision) syncAppearanceEditor(editor, refreshed);
    scheduleNormalize();
    return refreshed;
}

function scheduleNormalize() {
    if (normalizeQueued || typeof requestAnimationFrame !== 'function') return;
    normalizeQueued = true;
    requestAnimationFrame(() => {
        normalizeQueued = false;
        try {
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
            .then(npc => { if (npc) globalThis.toastr?.success?.('NPC State Delta: appearance forms updated and saved.'); })
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
    document.addEventListener('npc-state-delta:dossier-rendered', scheduleNormalize);
    document.addEventListener('npc-state-delta:editor-mounted', scheduleNormalize);
    document.addEventListener('npc-state-delta:settings-mounted', scheduleNormalize);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
}
