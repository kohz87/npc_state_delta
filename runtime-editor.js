/* NPC State Delta dossier editor and roster (role: npc-editor). The settings roster, the dossier renderer, the NPC editor
   dialog and the click activation that opens it. The save path lives in runtime-editor-save.js. Built by index.js once
   per module instance with the shared runtime state and the controller functions it calls, so each instance keeps its
   own activation memory. Bodies are moved from index.js without change. */
import { replayScope } from './runtime-scan-helpers.js';
import { getContext } from '../../../extensions.js';
import { EDITOR_FIELDS } from './src/dossier-edit.js';
import { DEFAULT_RELATIONSHIP, KEY_RELATIONSHIP_LIMIT, BEHAVIOR_PROFILE_LIMIT, isTerminalNpcDeath, PORTRAIT_NPC_PROMPT_LIMIT, normalizeCustomFields } from './core.js';
import { escapeHtml } from './src/util/html.js';
import { getSettings, effectiveCustomFieldNames } from './runtime-settings.js';
import { createEditorSave } from './runtime-editor-save.js';

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
        if (replayScope()) return;   // nothing is drawn during a history replay
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
        const names = [...effectiveCustomFieldNames()];
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
        <label>Birthday <small>${npc.birthDateSource ? 'Editing records a manual correction' : 'Uses the active calendar'}</small><input id="npc_state_delta_edit_birthday" class="text_pole" maxlength="180" placeholder="MM-DD / YYYY-MM-DD or configured calendar date" value="${editorValue(npc.birthDateDisplay)}"></label>
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

    const { saveNpcEditor } = createEditorSave(rt, deps, {
        clampEditorRelationshipStat,
        cleanEditorList,
        closeNpcEditor,
        customFieldEditorValues,
        editorField,
        renderDossier,
    });


    return { editorIsMounted, openNpcEditorSafely, activateNpcEditorFromEvent, renderDossier, closeNpcEditor, saveNpcEditor };
}
