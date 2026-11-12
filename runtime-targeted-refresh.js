/* NPC State Delta targeted Refresh (role: targeted-refresh). The editor-field sync and the Refresh-from-chat pass
   for one existing NPC. Split from runtime-targeted.js; bodies are moved without change. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { recentTranscript, recentUserDevelopmentContext, currentExclusions, storyDayAt, storyDaysForTranscript, refreshMessageGate } from './src/transcript.js';
import { DEFAULT_RELATIONSHIP, relationshipSummaryConsistent, calibrateRelationshipSummary, npcMatchesLabel, buildProfileRefreshPrompt, extractExplicitKeyRelationshipEdges, normalizeCustomFields } from './core.js';
import { setNpcChatRefreshIndicator, relationshipNumber, latestMessageId } from './runtime-scan-helpers.js';
import { getSettings, effectiveCustomFieldNames } from './runtime-settings.js';
import { createTargetedScopePart } from './runtime-targeted-scope.js';
import { fillAllowed, FILL_MERGE_OPTION } from './appearance-fill.js';

const { profileRowBindsToTarget, rowContradictsTarget, soleRowMayBeTarget, edgeTouchesResolvedTarget } = createTargetedScopePart();

export function createTargetedRefreshPart(rt, deps, { prepareCanonicalScanBase, targetedRowFor, refreshChangedFields }) {
    const { editorIsMounted, ensureChatStateLoaded, flushStateFile, getChatKey, getChatState, hostedMeterView, hostedTargetNotes, isScanBusy, requireReadyChatMutation, runTargetedDossierPass, saveNpcEditor, targetNoteOptions } = deps;

    function syncOpenNpcEditorFields(stored) {
        if (!stored || !editorIsMounted()) return;
        const npc = hostedMeterView([stored])[0];   // hosted: the editor shows the slice's numbers
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
        set('npc_state_delta_edit_name', npc.name || '');
        set('npc_state_delta_edit_role', npc.role || '');
        set('npc_state_delta_edit_aliases', (npc.aliases || []).join('\n'));
        set('npc_state_delta_edit_species', npc.species || '');
        set('npc_state_delta_edit_gender', npc.gender || '');
        set('npc_state_delta_edit_home_base', npc.homeBase || '');
        const customFields = normalizeCustomFields(npc.customFields);
        for (const input of document.querySelectorAll?.('#npc_state_delta_editor_content [data-delta-custom-field]') || []) {
            const key = Object.keys(customFields).find(other => other.toLowerCase() === String(input.dataset.deltaCustomField || '').toLowerCase());
            input.value = key ? customFields[key] : '';
        }
        set('npc_state_delta_edit_age', npc.age || '');
        set('npc_state_delta_edit_birthday', npc.birthDateDisplay || '');
        set('npc_state_delta_edit_apparent_age', npc.apparentAge || '');
        set('npc_state_delta_edit_personality', npc.personality || '');
        set('npc_state_delta_edit_speech', npc.speech || '');
        set('npc_state_delta_edit_behavior_profile', (npc.behaviorProfile || []).join('\n'));
        set('npc_state_delta_edit_background', npc.background || '');
        set('npc_state_delta_edit_mannerisms', (npc.mannerisms || []).join('\n'));
        set('npc_state_delta_edit_key_relationships', (npc.keyRelationships || []).join('\n'));
        set('npc_state_delta_edit_relationship_summary', npc.relationshipSummary || '');
        set('npc_state_delta_edit_mood', npc.mood || '');
        set('npc_state_delta_edit_location', npc.location || '');
        set('npc_state_delta_edit_goal', npc.goal || '');
        set('npc_state_delta_edit_status', npc.status || '');
        set('npc_state_delta_edit_memories', (npc.memories || []).join('\n'));
        set('npc_state_delta_edit_trust', relationshipNumber(npc.relationship?.trust));
        set('npc_state_delta_edit_affection', relationshipNumber(npc.relationship?.affection));
        set('npc_state_delta_edit_desire', relationshipNumber(npc.relationship?.desire));
        set('npc_state_delta_edit_tension', relationshipNumber(npc.relationship?.tension));
        const lock = document.getElementById('npc_state_delta_edit_lock_profile');
        if (lock) lock.checked = Boolean((npc.manualProfileFields || []).length);
    }

    // (1.2.11) `automatic`: a one-pass catch-up, not the reader's click. It stays quiet unless it
    // changed something, and never touches a dossier open in the editor.
    async function refreshNpcFromChat(npcId, { automatic = false, fillLooks = false, retried = false } = {}) {
        const notify = automatic ? () => {} : (level, text) => globalThis.toastr?.[level]?.(text);
        const id = String(npcId || '').trim();
        const ctx = getContext();
        const chatKey = getChatKey();
        if (!id || chatKey === 'no-chat') return false;
        try { await ensureChatStateLoaded(chatKey); } catch (error) { notify('warning', `NPC State Delta: cannot refresh this dossier until the canonical server state is available. ${error?.message || error}`); return false; }
        if (getChatKey() !== chatKey || !requireReadyChatMutation('refresh a dossier', chatKey, automatic ? { notify: false } : undefined)) return false;
        if (isScanBusy(chatKey)) {
            notify('info', 'NPC State Delta: another dossier scan is already running in this chat.');
            return false;
        }
        // Preserve any edits currently visible in this dossier before reading history. Otherwise
        // the old popup values could overwrite a successful refresh when Save is clicked later.
        if (editorIsMounted()) {
            if (automatic) return false;
            const savedEditor = await saveNpcEditor(id, { close: false, silent: true });
            if (!savedEditor) return false;
            try { await flushStateFile(chatKey); } catch { return false; }
        }
        if (!await prepareCanonicalScanBase(chatKey, 'dossier refresh')) return false;
        // (timeline) The window and the story day are read from the messages the story stands on: the gate is asked first.
        await refreshMessageGate();
        if (getChatKey() !== chatKey) return false;
        const settings = getSettings();
        const state = getChatState(chatKey);
        const existing = state.npcs.find(npc => npc.id === id);
        if (!existing) return false;
        const transcript = recentTranscript(settings.scanDepth, { messageIds: true });
        const developmentSourceMessageIds = [...transcript.matchAll(/^\[m(\d+)\]/gm)]
            .map(match => Number(match[1])).filter(Number.isInteger);
        if (!transcript) {
            notify('info', `NPC State Delta: no recent story text is available to refresh ${existing.name}.`);
            return false;
        }
        const before = structuredClone(existing);
        // A new person's blank looks are filled by this one call (the catch-up asks for it); the reader's own Refresh click asks too.
        // Never the reader's own character, never a dead/archived record (appearance-fill.js). Nothing else changes in this call.
        const fillBlankLooks = (fillLooks || !automatic) && fillAllowed(existing, ctx.name1);
        // (v2 hidden notes) A Refresh looks for this person's story events (never writes layers: the dossier is not new).
        const notes = hostedTargetNotes(existing, { tastes: true });
        const prompt = buildProfileRefreshPrompt({
            transcript,
            targetNpc: hostedMeterView([existing])[0],   // hosted: its currentRelationship is the slice's
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || 'Character',
            memoryCriteria: settings.memoryCriteria,
            turn: Number.isInteger(state.turn) ? state.turn : null,
            storyDay: storyDayAt(latestMessageId(true)),
            customFieldNames: effectiveCustomFieldNames(settings),
            fillLooks: fillBlankLooks,
            ...targetNoteOptions(notes),
        });
        return runTargetedDossierPass({
            chatKey, ctx, id, prompt, notes, ...(automatic ? { captureMessageId: latestMessageId(true), captureKind: 'refreshes' } : {}),
            label: `chat refresh for ${existing.name}`,
            systemPrompt: "You are NPC State Delta's targeted dossier reconciliation scanner. Re-read the supplied recent-story window for exactly one existing NPC. Return only the requested JSON object.",
            indicator: 'refresh',
            // (REFRESHCANCEL) Only this person's record changed while it ran: read again once on the new record, then report.
            retry: () => retried ? (notify('info', 'NPC State Delta: this dossier kept changing during the refresh; stale result was discarded.'), false)
                : refreshNpcFromChat(id, { automatic, fillLooks, retried: true }),
            staleLabel: 'dossier refresh',
            checkpoint: 'chat-refresh',
            metricsLabel: 'targeted-refresh',
            reportsScanMetrics: true,
            setIndicator: busy => setNpcChatRefreshIndicator(id, busy),
            onBusy: () => notify('info', 'NPC State Delta: another dossier scan is already running in this chat.'),
            onStale: () => notify('info', 'NPC State Delta: chat or dossier state changed during dossier refresh; stale result was discarded.'),
            onLateStale: () => notify('info', 'NPC State Delta: another session updated this chat during the refresh; the stale result was discarded.'),
            scope: (parsed, { latest, liveBefore }) => {
                const roster = latest.npcs;
                const labels = [existing.name, ...(existing.aliases || [])];
                const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
                const match = targetedRowFor(returned, existing, roster, { labels });
                parsed.npcs = match ? [{
                    ...match,
                    id,
                    name: match.name || existing.name,
                    present: false,
                    worldActive: false,
                    relationshipImpact: 'none',
                    relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                    relationshipChangeReason: '',
                }] : [];
                const rawProfileUpdates = Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed.profile_updates) ? parsed.profile_updates : []);
                if (rawProfileUpdates.length) {
                    const profile = rawProfileUpdates.find(item => (String(item?.id || '') === id || (item?.name && npcMatchesLabel(existing, item.name))) && profileRowBindsToTarget(item, existing, roster))
                        || (rawProfileUpdates.length === 1 && soleRowMayBeTarget(rawProfileUpdates[0], { npcId: id, labels }, roster) ? rawProfileUpdates[0] : null);
                    parsed.profileUpdates = profile && !rowContradictsTarget(profile, existing, roster) ? [{ ...profile, id, name: existing.name }] : [];
                }
                const edgeTouchesTarget = edge => edgeTouchesResolvedTarget(edge, existing, roster);
                const localEdges = extractExplicitKeyRelationshipEdges(transcript, roster, currentExclusions()).filter(edgeTouchesTarget);
                const modelEdges = (Array.isArray(parsed.keyRelationshipEdges) ? parsed.keyRelationshipEdges : []).filter(edgeTouchesTarget);
                parsed.keyRelationshipEdges = [...modelEdges, ...localEdges];
                if (!parsed.npcs.length && !(parsed.profileUpdates || []).length && !parsed.keyRelationshipEdges.length) {
                    notify('info', `NPC State Delta: no grounded dossier changes found for ${existing.name} in the last ${settings.scanDepth} messages.`);
                    return { ok: false, noChange: true, result: true, localEdges };
                }
                if (!liveBefore) return { ok: false, result: false };
                return { ok: true, match, localEdges };
            },
            mergeOptions: {
                autoReactivateArchived: false,
                // (I-14) The Refresh prompt asks for at most three new memories (rule 14); its merge takes three.
                memoryInputLimit: 3,
                allowTargetedDurableSeed: true,
                ...(fillBlankLooks ? { [FILL_MERGE_OPTION]: true } : {}),
                developmentSourceMessageIds,
                storyDays: storyDaysForTranscript(transcript),
                developmentContext: transcript,
                userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
            },
            afterMerge: (refreshed, { liveBefore, scoped }) => {
                // Manual history reconciliation must never pretend the NPC was just seen or change
                // current presence merely because an older message in the window mentioned them.
                refreshed.present = Boolean(liveBefore.present);
                refreshed.worldActive = Boolean(liveBefore.worldActive);
                refreshed.lastSeenTurn = liveBefore.lastSeenTurn;
                refreshed.lastWorldActiveTurn = liveBefore.lastWorldActiveTurn;
                refreshed.seenCount = liveBefore.seenCount;
                refreshed.relationship = structuredClone(liveBefore.relationship || DEFAULT_RELATIONSHIP);
                refreshed.lastRelationshipChange = structuredClone(liveBefore.lastRelationshipChange || refreshed.lastRelationshipChange);
                const proposedSummary = String(scoped.match?.relationshipSummary ?? scoped.match?.relationship_summary ?? '').trim().slice(0, 900);
                // The reconciled summary must pass the same canonical consistency gate as every other path;
                // a proposal the merge rejected (for example an unsupported obligation) is not restored here.
                // Hosted, that gate and the wording read the slice's numbers and milestones (a read-time view; the record keeps its own).
                const shown = hostedMeterView([refreshed])[0];
                if (proposedSummary && !(liveBefore.manualProfileFields || []).includes('relationshipSummary')
                    && relationshipSummaryConsistent(proposedSummary, shown.relationship, transcript, shown.relationshipMilestones)) {
                    refreshed.relationshipSummary = calibrateRelationshipSummary(proposedSummary, shown.relationship);
                }
            },
            onDone: saved => {
                syncOpenNpcEditorFields(saved);
                const changed = refreshChangedFields(before, saved);
                if (automatic) {
                    if (changed.length) globalThis.toastr?.info?.(`NPC State Delta: caught up ${saved?.name || existing.name} from the last ${settings.scanDepth} messages (${changed.join(', ')}).`);
                } else {
                    globalThis.toastr?.success?.(changed.length
                        ? `NPC State Delta: refreshed ${saved?.name || existing.name} from the last ${settings.scanDepth} messages (${changed.join(', ')}).`
                        : `NPC State Delta: ${saved?.name || existing.name} is already consistent with the last ${settings.scanDepth} messages.`);
                }
                return true;
            },
            onError: error => {
                console.error('[NPC State Delta] targeted chat refresh failed', error);
                notify('warning', `NPC State Delta refresh failed for ${existing.name}: ${error?.message || error}`);
                return false;
            },
        });
    }

    return { syncOpenNpcEditorFields, refreshNpcFromChat };
}
