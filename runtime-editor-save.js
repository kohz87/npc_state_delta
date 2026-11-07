/* NPC State Delta dossier editor save: applies one editor draft to the canonical chat state, social
   graph, branch checkpoint and persistence path. Split unchanged from runtime-editor.js with the
   same rt/deps closure state and live helper references supplied by createEditorPart. */
import { getContext } from '../../../extensions.js';
import { EDITOR_FIELDS, editorManualMemories, editorProfileLocks, settleEditorSave, untouchedEditorFields } from './src/dossier-edit.js';
import { DEFAULT_RELATIONSHIP, IMPORTANT_MEMORY_LIMIT, KEY_RELATIONSHIP_LIMIT, BEHAVIOR_PROFILE_LIMIT, inferNpcIdentityKind, normalizeRelationshipProgress, inferManualRelationshipMilestones, normalizeRelationshipEvidence, relationshipEventMessage, npcMatchesLabel, normalizeName, normalizeGender, normalizeNpcRecord, PORTRAIT_NPC_PROMPT_LIMIT } from './core.js';
import { applyNpcBirthdayUpdate, normalizeBirthDate } from './birthday.js';
import { reconcileSocialState, applyManualKeyRelationshipEdit } from './social.js';

export function createEditorSave(rt, deps, helpers) {
    const { commitBranchCheckpoint, ensureFreshMutationBoundary, getChatKey, getChatState, hostedMeterView, latestMessageId, latestReplyIndex, persistCriticalDurable, stampManualEdit, storySuiteV2Meters, updateInjection, workingCopyAdoption } = deps;
    const { clampEditorRelationshipStat, cleanEditorList, closeNpcEditor, customFieldEditorValues, editorField, renderDossier } = helpers;

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

    return { saveNpcEditor };
}
