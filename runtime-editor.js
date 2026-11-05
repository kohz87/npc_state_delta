/* NPC State Delta dossier editor and roster (role: npc-editor). The settings roster, the dossier renderer, the NPC editor dialog
   (open, fields, save, close) and the click activation that opens it. Built by index.js once per module instance with the shared
   runtime state and the controller functions it calls, so each instance keeps its own activation memory. Bodies are moved from
   index.js without change. */

import { getContext } from '../../../extensions.js';
import { EDITOR_FIELDS, editorManualMemories, editorProfileLocks, settleEditorSave, untouchedEditorFields } from './src/dossier-edit.js';
import { DEFAULT_RELATIONSHIP, IMPORTANT_MEMORY_LIMIT, KEY_RELATIONSHIP_LIMIT, BEHAVIOR_PROFILE_LIMIT, inferNpcIdentityKind, normalizeRelationshipProgress, inferManualRelationshipMilestones, normalizeRelationshipEvidence, relationshipEventMessage, isTerminalNpcDeath, npcMatchesLabel, normalizeName, normalizeGender, normalizeNpcRecord, PORTRAIT_NPC_PROMPT_LIMIT, normalizeCustomFieldNames, normalizeCustomFields } from './core.js';
import { applyNpcBirthdayUpdate, normalizeBirthDate } from './birthday.js';
import { reconcileSocialState, applyManualKeyRelationshipEdit } from './social.js';
import { escapeHtml } from './src/util/html.js';
import { getSettings } from './runtime-settings.js';

export function createEditorPart(rt, deps) {
    const { chatHydrationStatus, commitBranchCheckpoint, currentNpcById, ensureFreshMutationBoundary, eventTargetClosest, getChatKey, getChatState, hostedMeterView, latestMessageId, latestReplyIndex, persistCriticalDurable, queueInlineRender, relationshipNumber, requireReadyChatMutation, stampManualEdit, startInlineWatchdog, storySuiteV2Meters, updateInjection, workingCopyAdoption } = deps;
    const { hydrationErrors } = rt;

    let lastEditorActivation = { npcId: '', at: 0 };

    function editorIsMounted() {
        if (rt.activeEditorPopup?.dlg) {
            return Boolean(rt.activeEditorPopup.dlg.open || rt.activeEditorPopup.dlg.isConnected || document.body?.contains?.(rt.activeEditorPopup.dlg));
        }
        return Boolean(document.querySelector?.('.popup.npc-state-delta-editor-popup'));
    }

    async function openNpcEditorSafely(npcId) {
        const id = String(npcId || '').trim();
        if (!id) return false;
        const chatKey = getChatKey();
        if (!await ensureFreshMutationBoundary('open a dossier editor', chatKey)) return false;
        try {
            const npc = currentNpcById(id);
            if (!npc) throw new Error(`NPC id ${id} is not in the active chat state.`);
            const editor = openNpcEditor(id);
            if (!editor) throw new Error('SillyTavern editor popup could not be created.');
            return true;
        } catch (error) {
            console.error('[NPC State Delta] dossier editor failed to open', error);
            globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
            return false;
        }
    }

    function activateNpcEditorFromEvent(event) {
        const editButton = eventTargetClosest(event, '.npc-state-delta-roster-edit');
        if (!editButton) return false;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false;
        const npcId = String(editButton.dataset?.npcId || '').trim();
        if (!npcId) return false;
        const now = Date.now();
        if (lastEditorActivation.npcId === npcId && now - lastEditorActivation.at < 650) {
            event.preventDefault?.();
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            return true;
        }
        lastEditorActivation = { npcId, at: now };
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        void openNpcEditorSafely(npcId);
        return true;
    }

    function wireSettingsRosterEditor() {
        const holder = document.querySelector?.('#npc_state_delta_roster_summary');
        if (!holder?.querySelectorAll) return;
        holder.querySelectorAll('.npc-state-delta-roster-edit').forEach(control => {
            if (control.dataset?.npcStateDeltaEditorBound === '1') return;
            if (control.dataset) control.dataset.npcStateDeltaEditorBound = '1';
            control.addEventListener?.('pointerup', activateNpcEditorFromEvent);
            control.addEventListener?.('click', activateNpcEditorFromEvent);
            control.addEventListener?.('keydown', activateNpcEditorFromEvent);
        });
    }

    function renderSettingsRoster() {
        const holder = $('#npc_state_delta_roster_summary');
        if (!holder.length) return;
        const key = getChatKey();
        const hydration = chatHydrationStatus(key);
        if (key === 'no-chat') {
            holder.html('<span class="npc-state-delta-muted">Open a chat to load its NPC State Delta dossier.</span>');
            return;
        }
        if (hydration !== 'ready') {
            const error = hydrationErrors.get(key);
            const message = hydration === 'error'
                ? `NPC State Delta could not load this chat dossier. Existing sidecar data is preserved and all dossier writes are locked.${error?.message ? ` ${escapeHtml(error.message)}` : ''}`
                : (hydration === 'pending' ? 'NPC State Delta is waiting for SillyTavern to assign a stable chat identity. No dossier writes will occur yet.' : 'NPC State Delta is loading this chat dossier. Dossier writes remain locked until loading succeeds.');
            const retry = hydration === 'error' ? '<div class="menu_button npc-state-delta-retry-hydration"><i class="fa-solid fa-rotate"></i> Retry Load</div>' : '';
            const detach = hydration === 'error' && getSettings().dataFiles?.[key]?.path ? '<div class="menu_button npc-state-delta-detach-sidecar"><i class="fa-solid fa-link-slash"></i> Detach Broken Sidecar</div>' : '';
            holder.html(`<div class="npc-state-delta-hydration-warning"><b>${hydration === 'error' ? 'Dossier load failed' : (hydration === 'pending' ? 'Waiting for chat identity...' : 'Loading dossier...')}</b><span>${message}</span>${retry}${detach}</div>`);
            return;
        }
        const state = getChatState(key);

        if (!state.npcs.length) {
            holder.html('<span class="npc-state-delta-muted">No tracked NPCs yet. Named NPCs are stored persistently; inline cards appear only when the latest scene marks them present.</span>');
            return;
        }
        const pointer = getSettings().dataFiles?.[getChatKey()] || null;
        const active = state.npcs.filter(npc => !npc.archived);
        const archived = state.npcs.filter(npc => npc.archived);
        const activeRows = active.length ? active.map(npc => `
      <div class="npc-state-delta-roster-entry" data-npc-id="${escapeHtml(npc.id)}">
        <div class="menu_button npc-state-delta-roster-edit" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Edit ${escapeHtml(npc.name)} dossier">${npc.present ? '● ' : (npc.worldActive ? '◌ ' : '')}${npc.retentionProtected ? '📌 ' : ''}${npc.minor ? '·minor ' : ''}${escapeHtml(npc.name)} <i class="fa-solid fa-pen"></i></div>
        <div class="menu_button npc-state-delta-roster-scan npc-state-delta-scan-dossier" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Scan matching Megumin dossier for ${escapeHtml(npc.name)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <div class="menu_button npc-state-delta-roster-archive npc-state-delta-archive-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Archive ${escapeHtml(npc.name)}"><i class="fa-solid fa-box-archive"></i></div>
        <div class="menu_button npc-state-delta-roster-delete npc-state-delta-delete-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Delete ${escapeHtml(npc.name)} dossier"><i class="fa-solid fa-trash-can"></i></div>
      </div>`).join('') : '<span class="npc-state-delta-muted">No active NPCs.</span>';
        const archivedRows = archived.length ? archived.map(npc => `
      <div class="npc-state-delta-roster-entry npc-state-delta-roster-entry-archived" data-npc-id="${escapeHtml(npc.id)}">
        <div class="menu_button npc-state-delta-roster-edit" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Edit archived ${escapeHtml(npc.name)} dossier">${npc.retentionProtected ? '📌 ' : ''}${npc.minor ? '·minor ' : ''}${escapeHtml(npc.name)}${npc.archiveReason === 'deceased' ? ' ☠' : (npc.archiveReason === 'stale' ? ' ⏳' : '')} <i class="fa-solid fa-pen"></i></div>
        <div class="menu_button npc-state-delta-roster-scan npc-state-delta-scan-dossier" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Scan matching Megumin dossier for ${escapeHtml(npc.name)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <div class="menu_button npc-state-delta-roster-restore npc-state-delta-restore-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Restore ${escapeHtml(npc.name)} to active roster"><i class="fa-solid fa-box-open"></i></div>
        <div class="menu_button npc-state-delta-roster-delete npc-state-delta-delete-npc" role="button" tabindex="0" data-npc-id="${escapeHtml(npc.id)}" title="Delete ${escapeHtml(npc.name)} dossier"><i class="fa-solid fa-trash-can"></i></div>
      </div>`).join('') : '<span class="npc-state-delta-muted">No archived NPCs.</span>';
        holder.html(`
      <span class="npc-state-delta-muted">Persistent NPC database:</span>
      <div class="npc-state-delta-roster-block"><b>Active (${active.length})</b><div class="npc-state-delta-roster-chips">${activeRows}</div></div>
      <details class="npc-state-delta-archived-roster" ${archived.length ? '' : ''}><summary><b>Archived (${archived.length})</b></summary><div class="npc-state-delta-roster-chips">${archivedRows}</div><small class="npc-state-delta-muted">Archived dossiers remain in the JSON database, branch history, exports, and portraits, but are excluded from portrait cards and generation injection. Stale auto-archives may be deleted at the configured delete threshold; manual/death archives are preserved.</small></details>
      <small class="npc-state-delta-muted">● present in the latest scanned scene · ◌ current off-screen activity from World State · 📌 protected from stale lifecycle · ·minor hidden from the portrait gallery. Present Minor NPCs still update and remain eligible for generation injection. Auto-archive is reversible; timed stale deletion does not suppress rediscovery, while manual trash does.</small>
      <small class="npc-state-delta-muted npc-state-delta-data-file">Data file: ${escapeHtml(pointer?.path || 'created on first save')}</small>`);
        wireSettingsRosterEditor();
    }

    function renderDossier() {
        renderSettingsRoster();
        startInlineWatchdog();
        queueInlineRender();
    }

    // Each list entry is one line in the editor. Entries themselves may contain semicolons (a bond's
    // "…; deceased", a memory's two clauses), so only line breaks separate them.
    function cleanEditorList(value, max = 12) {
        return [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean))].slice(0, max);
    }

    // Configured custom fields, plus any value stored under a name no longer configured so it can be cleared.
    function customFieldEditorNames(npc) {
        const names = [...normalizeCustomFieldNames(getSettings().customFieldNames)];
        for (const key of Object.keys(normalizeCustomFields(npc?.customFields))) {
            if (!names.some(name => name.toLowerCase() === key.toLowerCase())) names.push(key);
        }
        return names;
    }

    function customFieldEditorHtml(npc) {
        const stored = normalizeCustomFields(npc?.customFields);
        return customFieldEditorNames(npc).map(name => {
            const key = Object.keys(stored).find(other => other.toLowerCase() === name.toLowerCase());
            return `<label>${editorValue(name)} <small>Custom field</small><input class="text_pole" maxlength="60" data-delta-custom-field="${editorValue(name)}" value="${editorValue(key ? stored[key] : '')}"></label>`;
        }).join('');
    }

    function customFieldEditorValues(current) {
        const inputs = [...document.querySelectorAll('#npc_state_delta_editor_content [data-delta-custom-field]')];
        if (!inputs.length) return normalizeCustomFields(current?.customFields);
        return normalizeCustomFields(Object.fromEntries(inputs.map(input => [input.dataset.deltaCustomField, String(input.value || '').trim()])));
    }

    function editorValue(value) {
        return escapeHtml(String(value ?? ''));
    }

    // (v2 meters, F90, TRS 1-4) Hidden notes, the meter preset and limits, milestones and custom meters:
    // shown in the editor only while hosted (src/storysuite-v2.js editorHtml / readEditor).
    function hostedSecretsEditorHtml(npc) {
        const adapter = storySuiteV2Meters();
        if (!adapter) return '';
        try { return String(adapter.editorHtml(npc) || ''); } catch { return ''; }
    }

    function openNpcEditor(npcId) {
        const originChatKey = getChatKey();
        if (!requireReadyChatMutation('edit a dossier', originChatKey)) return null;
        const npc = currentNpcById(npcId);
        if (!npc) return null;
        closeNpcEditor();
        rt.activeEditorChatKey = originChatKey;
        rt.activeEditorBaseRevision = workingCopyAdoption(originChatKey);
        const ctx = getContext();
        const Popup = ctx.Popup;
        const POPUP_TYPE = ctx.POPUP_TYPE;
        const POPUP_RESULT = ctx.POPUP_RESULT;
        if (typeof Popup !== 'function' || !POPUP_TYPE?.TEXT || !POPUP_RESULT) {
            throw new Error('SillyTavern Popup API is unavailable. NPC State Delta requires SillyTavern 1.18+ for dossier editing.');
        }
        // While hosted the numbers shown (and edited) are the v2 slice's; without a host, the dossier's.
        const rel = hostedMeterView([npc])[0].relationship || DEFAULT_RELATIONSHIP;
        const locked = new Set(npc.manualProfileFields || []);
        const content = document.createElement('div');
        content.id = 'npc_state_delta_editor_content';
        content.className = 'npc-state-delta-editor-native';
        // Editor add-ons (appearance forms, life state, sections) identify their NPC from this.
        content.dataset.npcId = npc.id;
        content.innerHTML = `
      <div class="npc-state-delta-editor-head"><div><span class="npc-state-delta-kicker">LIVE DOSSIER</span><h3 id="npc_state_delta_editor_title">Edit ${editorValue(npc.name)}</h3></div></div>
      <p class="npc-state-delta-muted">Edits save to NPC State Delta's extension-owned JSON data. Relationship numbers are authoritative current values on a -100 to +100 scale where 0 is neutral; future story deltas continue from them.</p>
      <div class="npc-state-delta-editor-lifecycle"><b>Lifecycle</b><span>${isTerminalNpcDeath(npc) ? 'Confirmed deceased' : (npc.archived ? 'Archived' : (npc.present ? 'Active · Present' : (npc.worldActive ? 'Active · Off-screen' : 'Active')))}${npc.archiveReason === 'deceased' ? ' · Deceased' : (npc.archiveReason === 'stale' ? ' · Stale auto-archive' : '')}</span>${npc.lifeStateReason ? `<small>${editorValue(npc.lifeStateReason)}</small>` : ''}</div>
      <div class="npc-state-delta-editor-grid npc-state-delta-editor-profile">
        <label>Name<input id="npc_state_delta_edit_name" class="text_pole" maxlength="${EDITOR_FIELDS.name.max}" value="${editorValue(npc.name)}"></label>
        <label>Species / Race<input id="npc_state_delta_edit_species" class="text_pole" maxlength="${EDITOR_FIELDS.species.max}" placeholder="Half-elf, dwarf, dwelf, human, custom species..." value="${editorValue(npc.species)}"></label>
        <label>Gender<select id="npc_state_delta_edit_gender" class="text_pole"><option value="" ${!npc.gender ? 'selected' : ''}>Unknown / not established</option><option value="male" ${npc.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${npc.gender === 'female' ? 'selected' : ''}>Female</option></select></label>
        <label>Role<input id="npc_state_delta_edit_role" class="text_pole" maxlength="${EDITOR_FIELDS.role.max}" value="${editorValue(npc.role)}"></label>
        <label>Aliases / nicknames <small>One per line, max 8. Distinctive nicknames ("Red", "the Butcher of Vell") recall this NPC when mentioned; role descriptions ("the innkeeper") are kept for reference only.</small><textarea id="npc_state_delta_edit_aliases" class="text_pole" rows="2">${editorValue((npc.aliases || []).join('\n'))}</textarea></label>
        <label>Home Base / Usual Location<input id="npc_state_delta_edit_home_base" class="text_pole" maxlength="${EDITOR_FIELDS.homeBase.max}" placeholder="Home, workplace, headquarters, or regular haunt" value="${editorValue(npc.homeBase)}"></label>
        ${customFieldEditorHtml(npc)}
        <label>Chronological age<input id="npc_state_delta_edit_age" class="text_pole" maxlength="${EDITOR_FIELDS.age.max}" placeholder="Actual stated age; leave blank if unknown" value="${editorValue(npc.age)}"></label>
        <label>Birthday <small>${npc.birthDateSource === 'generated' ? 'Generated fallback; editing establishes a manual correction' : (npc.birthDateSource === 'established' ? 'Established date; editing records a manual correction' : 'Uses the active calendar')}</small><input id="npc_state_delta_edit_birthday" class="text_pole" maxlength="180" placeholder="MM-DD / YYYY-MM-DD or configured calendar date" value="${editorValue(npc.birthDateDisplay)}"></label>
        <label>Apparent age<input id="npc_state_delta_edit_apparent_age" class="text_pole" maxlength="${EDITOR_FIELDS.apparentAge.max}" placeholder="~25, young, middle-aged..." value="${editorValue(npc.apparentAge)}"></label>
        <label>Personality<textarea id="npc_state_delta_edit_personality" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.personality.max}">${editorValue(npc.personality)}</textarea></label>
        <label class="npc-state-delta-editor-wide">Behavioral Levers <small>Max ${BEHAVIOR_PROFILE_LIMIT} compact target-general response/decision rules, one per line</small><textarea id="npc_state_delta_edit_behavior_profile" class="text_pole" rows="6" placeholder="Disposition: kind - broadly considerate; avoids needless harm&#10;Expressiveness: low - strong feelings show subtly&#10;Independence: high - keeps own goals and boundaries&#10;Care: practical - helps through actions before reassurance&#10;Conflict: controlled - concise, firm, not gratuitously cruel">${editorValue((npc.behaviorProfile || []).join('\n'))}</textarea></label>
        <label>Speech<textarea id="npc_state_delta_edit_speech" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.speech.max}">${editorValue(npc.speech)}</textarea></label>
        <label>Background<textarea id="npc_state_delta_edit_background" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.background.max}">${editorValue(npc.background)}</textarea></label>
        <label class="npc-state-delta-editor-wide">Established mannerisms <small>One per line</small><textarea id="npc_state_delta_edit_mannerisms" class="text_pole" rows="4">${editorValue((npc.mannerisms || []).join('\n'))}</textarea></label>
        <label class="npc-state-delta-editor-wide">Key relationships <small>Max ${KEY_RELATIONSHIP_LIMIT} · family, friends, rivals, mentors, partners · one per line</small><textarea id="npc_state_delta_edit_key_relationships" class="text_pole" rows="5" placeholder="Yunyun — friend / rival | competitive but loyal">${editorValue((npc.keyRelationships || []).join('\n'))}</textarea></label>
      </div>
      <details class="npc-state-delta-editor-portrait-overrides">
        <summary><b>Portrait prompt overrides</b> <small>Optional per-NPC additions</small></summary>
        <div class="npc-state-delta-editor-portrait-overrides-body">
          <p class="npc-state-delta-muted">These are appended only when building image prompts. They are never injected into roleplay generation and never rewritten by the NPC scanner.</p>
          <label>Additional positive prompt<textarea id="npc_state_delta_edit_portrait_positive" class="text_pole" rows="4" maxlength="${PORTRAIT_NPC_PROMPT_LIMIT}" placeholder="black ceremonial ribbon, winter uniform, gold ear cuff...">${editorValue(npc.portraitPromptPositive)}</textarea></label>
          <label>Additional negative prompt<textarea id="npc_state_delta_edit_portrait_negative" class="text_pole" rows="4" maxlength="${PORTRAIT_NPC_PROMPT_LIMIT}" placeholder="helmet, hood, short hair...">${editorValue(npc.portraitPromptNegative)}</textarea></label>
          <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_portrait_replace" type="checkbox" ${npc.portraitPromptReplace ? 'checked' : ''}> Replace the automatic positive prompt entirely <small>Use only when this NPC needs a hand-authored model-specific prompt. The global negative prompt still applies.</small></label>
        </div>
      </details>
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_lock_profile" type="checkbox" ${locked.size ? 'checked' : ''}> Protect edited stable profile fields from future scanner rewrites <small>Leave off to use manual edits as an organic baseline. Existing locks stay protected until you uncheck and save. Also covers Player Dynamic, Mood, Location, Goal, Condition and Important memories. Memories you type are never pushed out by later scans, protected or not.</small></label>
      ${locked.size ? `<p class="npc-state-delta-muted">Currently protected: ${editorValue([...locked].join(', '))}</p>` : ''}
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_retention_protected" type="checkbox" ${npc.retentionProtected ? 'checked' : ''}> Keep this NPC from automatic stale cleanup <small>Use for recurring or major NPCs who may disappear for long arcs. This does not lock their profile fields.</small></label>
      <label class="npc-state-delta-editor-lock"><input id="npc_state_delta_edit_minor" type="checkbox" ${npc.minor ? 'checked' : ''}> Hide present-NPC card <small>The dossier still scans, updates, stores memories/relationships, and injects when present; only the present cast card is hidden.</small></label>
      <div class="npc-state-delta-editor-grid">
        <label>Player Dynamic<textarea id="npc_state_delta_edit_relationship_summary" class="text_pole" rows="3" maxlength="${EDITOR_FIELDS.relationshipSummary.max}">${editorValue(npc.relationshipSummary)}</textarea></label>
        <label>Mood<input id="npc_state_delta_edit_mood" class="text_pole" maxlength="${EDITOR_FIELDS.mood.max}" value="${editorValue(npc.mood)}"></label>
        <label>Location<input id="npc_state_delta_edit_location" class="text_pole" maxlength="${EDITOR_FIELDS.location.max}" value="${editorValue(npc.location)}"></label>
        <label>Goal<input id="npc_state_delta_edit_goal" class="text_pole" maxlength="${EDITOR_FIELDS.goal.max}" value="${editorValue(npc.goal)}"></label>
        <label>Condition / Activity<input id="npc_state_delta_edit_status" class="text_pole" maxlength="${EDITOR_FIELDS.status.max}" value="${editorValue(npc.status)}"></label>
        <label class="npc-state-delta-editor-wide">Important memories <small>Max 5 · one per line</small><textarea id="npc_state_delta_edit_memories" class="text_pole" rows="5">${editorValue((npc.memories || []).join('\n'))}</textarea></label>
      </div>
      <div class="npc-state-delta-editor-stats">
        <label>Trust<input id="npc_state_delta_edit_trust" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.trust)}"></label>
        <label>Affection<input id="npc_state_delta_edit_affection" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.affection)}"></label>
        <label>Desire<input id="npc_state_delta_edit_desire" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.desire)}"></label>
        <label>Tension<input id="npc_state_delta_edit_tension" class="text_pole" type="number" min="-100" max="100" value="${relationshipNumber(rel.tension)}"></label>
      </div>${hostedSecretsEditorHtml(npc)}`;

        let popup;
        popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: 'Save dossier',
            cancelButton: 'Cancel',
            large: true,
            allowVerticalScrolling: true,
            leftAlign: true,
            animation: 'fast',
            onClosing: async currentPopup => {
                if (currentPopup.result === POPUP_RESULT.AFFIRMATIVE) {
                    return saveNpcEditor(npc.id, { close: false, popup: currentPopup });
                }
                return true;
            },
            onClose: () => {
                if (rt.activeEditorPopup === popup) rt.activeEditorPopup = null;
            },
        });
        popup.dlg?.classList?.add?.('npc-state-delta-editor-popup');
        rt.activeEditorPopup = popup;
        Promise.resolve(popup.show()).catch(error => {
            if (rt.activeEditorPopup === popup) rt.activeEditorPopup = null;
            console.error('[NPC State Delta] native dossier popup failed', error);
            globalThis.toastr?.error?.(`NPC State Delta editor failed: ${error?.message || error}`);
        });
        return popup;
    }

    function closeNpcEditor() {
        const popup = rt.activeEditorPopup;
        rt.activeEditorPopup = null;
        rt.activeEditorChatKey = '';
        rt.activeEditorBaseRevision = null;
        if (popup?.completeCancelled) {
            Promise.resolve(popup.completeCancelled()).catch(error => console.debug('[NPC State Delta] editor popup close failed', error));
        }
    }

    function editorField(id) {
        return document.getElementById(id)?.value ?? '';
    }

    function clampEditorRelationshipStat(id) {
        const value = Number(editorField(id));
        return Number.isFinite(value) ? Math.max(-100, Math.min(100, Math.round(value))) : 0;
    }

    async function saveNpcEditor(npcId, { close = true, silent = false, popup = null } = {}) {
        const originChatKey = rt.activeEditorChatKey || getChatKey();
        const editorAtStart = rt.activeEditorPopup;
        if (getChatKey() !== originChatKey || !await ensureFreshMutationBoundary('save dossier edits', originChatKey)) {
            globalThis.toastr?.warning?.('NPC State Delta: this editor belongs to a different or unloaded chat. Reopen the dossier in the active chat.');
            return false;
        }
        // Cancel/Escape during the freshness wait (or a replaced editor) invalidates this Save: the
        // closing popup still holds the draft inputs, but the user abandoned them.
        // An implicit save (Refresh saving the open editor first) has no popup argument: the editor
        // popup it started under must not have been cancelled meanwhile either. Host Popup sets the
        // result before its closing animation, while the draft inputs and activeEditorPopup still exist.
        const affirmative = getContext().POPUP_RESULT?.AFFIRMATIVE;
        if ((editorAtStart && rt.activeEditorPopup !== editorAtStart)
            || (popup && popup.result !== affirmative)
            || (!popup && editorAtStart && editorAtStart.result !== undefined && editorAtStart.result !== affirmative)) return false;
        if (rt.activeEditorBaseRevision !== null && Number(rt.activeEditorBaseRevision) !== workingCopyAdoption(originChatKey)) {
            globalThis.toastr?.warning?.('NPC State Delta: this editor was opened on an older server revision. Your typed draft is still open, but it was not applied. Review the newly loaded dossier and reopen the editor before saving.');
            return false;
        }
        const state = getChatState(originChatKey);
        const index = state.npcs.findIndex(item => item.id === npcId);
        if (index < 0) { if (close) closeNpcEditor(); return false; }
        const current = state.npcs[index];
        const beforeKeyRelationships = [...(current.keyRelationships || [])];
        const next = structuredClone(current);
        const oldRelationship = { ...(current.relationship || DEFAULT_RELATIONSHIP) };
        // (v2 meters) While hosted the inputs showed the slice's numbers; edits to them go to the slice.
        const hostedMeters = storySuiteV2Meters();
        const shownRelationship = hostedMeters ? { ...hostedMeterView([current])[0].relationship } : null;
        // A field whose control still shows the stored value is kept as stored (never re-cut or compacted).
        const untouched = untouchedEditorFields(current, editorField);
        const editorControl = key => editorField(`npc_state_delta_edit_${EDITOR_FIELDS[key].id}`);
        const editorText = key => (untouched.has(key) ? String(current[key] ?? '') : String(editorControl(key)).trim().slice(0, EDITOR_FIELDS[key].max));
        const editorList = (key, max) => (untouched.has(key) ? structuredClone(current[key] || []) : cleanEditorList(editorControl(key), max));
        const stableInputs = {
            name: editorText('name') || current.name,
            role: editorText('role'),
            species: editorText('species'),
            gender: untouched.has('gender') ? current.gender : normalizeGender(editorControl('gender')),
            homeBase: editorText('homeBase'),
            age: editorText('age'),
            apparentAge: editorText('apparentAge'),
            personality: editorText('personality'),
            speech: editorText('speech'),
            behaviorProfile: editorList('behaviorProfile', BEHAVIOR_PROFILE_LIMIT),
            background: editorText('background'),
            mannerisms: editorList('mannerisms', 8),
            keyRelationships: editorList('keyRelationships', KEY_RELATIONSHIP_LIMIT),
            customFields: customFieldEditorValues(current),
            aliases: editorList('aliases', 8),
        };
        const nameCollision = state.npcs.some((item, i) => i !== index && npcMatchesLabel(item, stableInputs.name));
        if (nameCollision) {
            globalThis.toastr?.warning?.(`NPC State Delta: another dossier already matches ${stableInputs.name}.`);
            return false;
        }
        if (stableInputs.name !== current.name && current.name) {
            stableInputs.aliases = [...new Set([...stableInputs.aliases, current.name])].slice(0, 8);
        }
        stableInputs.aliases = stableInputs.aliases.filter(alias => normalizeName(alias) !== normalizeName(stableInputs.name));
        Object.assign(next, stableInputs);
        const birthdayInput = String(editorField('npc_state_delta_edit_birthday')).trim().slice(0, 180);
        const currentBirthdayDisplay = String(current.birthDateDisplay || '').trim();
        if (birthdayInput !== currentBirthdayDisplay) {
            if (!birthdayInput) {
                globalThis.toastr?.warning?.('NPC State Delta: birthday cannot be cleared here. Enter a valid date or cancel the edit.');
                return false;
            }
            const normalizedBirthday = normalizeBirthDate(birthdayInput);
            if (!normalizedBirthday) {
                globalThis.toastr?.warning?.('NPC State Delta: birthday is not valid for the active calendar.');
                return false;
            }
            const correctedBirthday = applyNpcBirthdayUpdate(next, {
                birthDate: normalizedBirthday,
                birthDateState: 'correct',
                birthDateReason: 'Manual dossier birthday correction.',
            });
            correctedBirthday.birthDateSourceMessageId = null;
            Object.assign(next, correctedBirthday);
        }
        next.portraitPromptPositive = String(editorField('npc_state_delta_edit_portrait_positive')).trim().slice(0, PORTRAIT_NPC_PROMPT_LIMIT);
        next.portraitPromptNegative = String(editorField('npc_state_delta_edit_portrait_negative')).trim().slice(0, PORTRAIT_NPC_PROMPT_LIMIT);
        next.portraitPromptReplace = Boolean(document.getElementById('npc_state_delta_edit_portrait_replace')?.checked);
        if (stableInputs.name !== current.name) next.identityKind = inferNpcIdentityKind(stableInputs.name);
        next.relationshipSummary = editorText('relationshipSummary');
        next.mood = editorText('mood');
        next.location = editorText('location');
        next.goal = editorText('goal');
        next.status = editorText('status');
        next.memories = editorList('memories', IMPORTANT_MEMORY_LIMIT);
        next.relationship = {
            trust: clampEditorRelationshipStat('npc_state_delta_edit_trust'),
            affection: clampEditorRelationshipStat('npc_state_delta_edit_affection'),
            desire: clampEditorRelationshipStat('npc_state_delta_edit_desire'),
            tension: clampEditorRelationshipStat('npc_state_delta_edit_tension'),
        };
        let meterEdits = null;
        if (shownRelationship) {
            const edited = Object.fromEntries(Object.keys(next.relationship).filter(key => next.relationship[key] !== Number(shownRelationship[key] || 0)).map(key => [key, next.relationship[key]]));
            meterEdits = Object.keys(edited).length ? edited : null;
            next.relationship = { ...oldRelationship };
        }
        const v2Edits = hostedMeters ? hostedMeters.readEditor(id => document.getElementById(id)?.value, current) : null;
        if (v2Edits?.secrets) next.secrets = v2Edits.secrets;
        if (v2Edits && v2Edits.meterSetup !== undefined) {
            if (v2Edits.meterSetup) next.meterSetup = v2Edits.meterSetup;
            else delete next.meterSetup;
        }
        if (v2Edits?.problems?.length && !silent) globalThis.toastr?.warning?.(`NPC State Delta: ${v2Edits.problems.join('; ').slice(0, 300)}`);
        const relationshipDelta = Object.fromEntries(['trust', 'affection', 'desire', 'tension'].map(key => [key, next.relationship[key] - Number(oldRelationship[key] || 0)]));
        if (Object.values(relationshipDelta).some(value => value !== 0)) {
            const progress = normalizeRelationshipProgress(current.relationshipProgress);
            for (const key of ['trust', 'affection', 'desire', 'tension']) if (relationshipDelta[key] !== 0) progress[key] = 0;
            next.relationshipProgress = progress;
            next.relationshipMilestones = inferManualRelationshipMilestones(
                current.relationshipMilestones,
                next.relationship,
                'Manual dossier adjustment established this relationship depth.',
                latestMessageId(false),
                Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
            );
            next.lastRelationshipChange = {
                impact: 'manual',
                delta: relationshipDelta,
                evidence: normalizeRelationshipEvidence(),
                reason: 'Manual dossier adjustment by player.',
                sourceMessageId: latestMessageId(false),
                turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
                ...relationshipEventMessage({ message: latestReplyIndex() }),
            };
        }
        Object.assign(next, editorProfileLocks(current, next, { protect: Boolean(document.getElementById('npc_state_delta_edit_lock_profile')?.checked) }));
        next.retentionProtected = Boolean(document.getElementById('npc_state_delta_edit_retention_protected')?.checked);
        next.minor = Boolean(document.getElementById('npc_state_delta_edit_minor')?.checked);
        next.updatedAt = Date.now();
        state.npcs[index] = normalizeNpcRecord(next);
        // A changed relationship recalibrates the Player Dynamic even when its text was not edited.
        const relationshipMoved = Object.values(relationshipDelta).some(value => value !== 0);
        const shortened = settleEditorSave(state.npcs[index], current, next, untouched, {
            keepVerbatim: key => key !== 'relationshipSummary' || !relationshipMoved,
        });
        const manualMemories = editorManualMemories(current, state.npcs[index], untouched);
        if (manualMemories.length) state.npcs[index].manualMemories = manualMemories;
        else delete state.npcs[index].manualMemories;
        stampManualEdit(state, state.npcs[index], current);
        if (next.lastRelationshipChange?.impact === 'manual') state.npcs[index].lastRelationshipChange = structuredClone(next.lastRelationshipChange);
        const targetMessageId = latestMessageId(false);
        applyManualKeyRelationshipEdit(state, npcId, beforeKeyRelationships, state.npcs[index].keyRelationships || [], {
            sourceMessageId: targetMessageId,
            turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
        });
        const reconciledSocial = reconcileSocialState(state, {
            provenance: 'manual', confidence: 'manual', sourceMessageId: targetMessageId,
            turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
        });
        state.socialGraph = reconciledSocial.socialGraph;
        state.npcs = reconciledSocial.state.npcs;
        if (targetMessageId >= 0) commitBranchCheckpoint(state, targetMessageId, 'manual-edit');
        renderDossier();
        updateInjection();
        // Report success only once the edit is on the server. A failed write keeps the editor open
        // with the draft; the edit stays applied in this browser and the pending write is retried.
        const savedName = state.npcs[index].name;
        if (!await persistCriticalDurable(originChatKey)) {
            if (!silent) globalThis.toastr?.warning?.(`NPC State Delta: the edits for ${savedName} are applied in this browser but could not be saved to the server yet. Save again to retry.`);
            return false;
        }
        if (hostedMeters && (meterEdits || v2Edits)) {
            if (meterEdits) await hostedMeters.setMeters({ name: current.name, meters: meterEdits });
            if (v2Edits) await hostedMeters.applyEditor(savedName, v2Edits);
            // The notes opened or shut by hand change the dossier's Secrets section: draw it from the slice as it now stands.
            renderDossier();
            updateInjection();
        }
        if (close) closeNpcEditor();
        if (!silent) globalThis.toastr?.success?.(`NPC State Delta: saved manual dossier edits for ${savedName}.`);
        if (!silent && shortened.length) globalThis.toastr?.warning?.(`NPC State Delta: ${shortened.join(', ')} ${shortened.length === 1 ? 'was' : 'were'} shortened or adjusted to fit the dossier's limits for unprotected fields. Tick "Protect edited stable profile fields" to keep a longer Personality, Speech, Background or Mannerisms.`);
        return true;
    }

    return { editorIsMounted, openNpcEditorSafely, activateNpcEditorFromEvent, renderDossier, closeNpcEditor, saveNpcEditor };
}
