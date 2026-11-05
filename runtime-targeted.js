/* NPC State Delta targeted passes (role: targeted-passes). The scans aimed at one person or a few: the targeted dossier pass, Scan dossier, Refresh from
   chat, the history backfill and the queue of pending backfills, with the rules that scope a pass's rows and edges to its target. Built by index.js
   once per module instance with the shared runtime state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { isScannerRoutingError } from './scanner-routing.js';
import { automaticBackfillStillRelevant, backfillNeedsRequest } from './scan-context.js';
import { REFRESH_CHANGED_FIELDS } from './src/fields/registry.js';
import { recentTranscript, recentUserDevelopmentContext, currentExchangeTranscript, storyDayAt, storyDaysForTranscript, currentExclusions, refreshMessageGate, activeChat } from './src/transcript.js';
import { BACKFILL_RESPONSE_LENGTH, generateParsedNpcJson } from './src/scanner-request.js';
import { DEFAULT_RELATIONSHIP, IMPORTANT_MEMORY_LIMIT, inferNpcIdentityKind, relationshipSummaryConsistent, calibrateRelationshipSummary, npcCurrentlyAbsentInText, buildBackfillPrompt, buildDossierImportPrompt, buildProfileRefreshPrompt, mergeScanResult, protectTerminalNpc, npcMatchesLabel, normalizeName, extractExplicitKeyRelationshipEdges, normalizeCustomFields } from './core.js';
import { chatLineage } from './branch.js';
import { resolveNpcReference } from './social.js';
import { getSettings } from './runtime-settings.js';
import { setNpcDossierScanIndicator, setNpcChatRefreshIndicator, lineageMoved, setScanIndicator, relationshipNumber, latestMessageId } from './runtime-scan-helpers.js';

export function createTargetedPart(rt, deps) {
    const { attachGeneratedSecrets, BACKFILL_MAX_ATTEMPTS, beginScanOperation, chatHydrationStatus, commitBranchCheckpoint, editorIsMounted, endScanOperation, ensureChatStateLoaded, ensureHydratedStateFresh, findMeguminDossierSources, flushStateFile, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedTargetNotes, isHostSwipeActive, isScanBusy, noteScanFailure, persist, recordInlineCardsInState, recordScanDiagnostics, removeNpcInlineCardAtMessage, renderDossier, requireReadyChatMutation, runTargetedDossierPass, saveNpcEditor, scanCanonicalBaseCurrent, scanOperationCurrent, scenePresentAt, setChatState, settleStateFileWrite, staleHostActive, targetNoteOptions, updateInjection } = deps;
    const { stateVersions, runningTargetedPasses } = rt;

    function backfillScanMatchesTarget(npc, request) {
        if (!npc || !request) return false;
        if (npc.id && request.npcId && String(npc.id) === String(request.npcId)) return true;
        if (npcMatchesLabel(npc, request.label)) return true;
        const target = normalizeName(request.label);
        if (!target) return false;
        const labels = [npc.name, ...(npc.aliases || [])].map(normalizeName).filter(Boolean);
        if (labels.some(label => label === target || label.startsWith(`${target} `) || target.startsWith(`${label} `))) return true;
        // A role names its owner only for a role-labelled target ("clerk" for "Gate Clerk"); a role that
        // merely mentions the target ("Assistant to Mira Deep") belongs to someone else.
        const role = normalizeName(npc.role);
        return Boolean(role && role !== target && target.includes(role));
    }

    // A returned row is admissible for a single-target request only if no explicit identity field
    // contradicts the target: another roster member's id or name, or (for a proper-named target) a name
    // that is neither the target's label nor an expansion of it. Interim (role-labelled) targets may be
    // renamed by a revealed proper name.
    function rowContradictsTarget(row, target, roster = []) {
        if (!row || !target) return true;
        const others = (Array.isArray(roster) ? roster : []).filter(npc => npc && npc.id !== target.id);
        const rowId = String(row.id || '').trim();
        if (rowId && rowId !== String(target.id) && others.some(npc => String(npc.id) === rowId)) return true;
        const rowName = String(row.name || '').trim();
        if (!rowName) return false;
        if (npcMatchesLabel(target, rowName)) return false;
        if (others.some(npc => npcMatchesLabel(npc, rowName))) return true;
        const key = normalizeName(rowName);
        const expansion = [target.name, ...(target.aliases || [])].map(normalizeName).filter(Boolean)
            .some(label => key.startsWith(`${label} `) || label.startsWith(`${key} `));
        if (expansion) return false;
        return String(target.identityKind || 'proper_name') === 'proper_name';
    }

    // Single-target channel scope must agree with what the merge will mutate. A profile row binds to the
    // target only when no explicit identity field contradicts it (an exact id with another NPC's name is
    // a contradiction); it is rewritten to the target's id and name so later name-based matching cannot
    // reach the other NPC. An edge endpoint resolves like social.parseScanEdges (explicit id first, then
    // label); an endpoint whose id and label name different people rejects the edge.
    function profileRowBindsToTarget(row, target, roster = []) {
        if (!row || typeof row !== 'object' || !target) return false;
        const rowId = String(row.id || '').trim();
        if (rowId && rowId !== String(target.id)) return false;
        if (!rowId && !String(row.name || '').trim()) return false;
        return !rowContradictsTarget(row, target, roster);
    }

    function edgeTouchesResolvedTarget(edge, target, roster = []) {
        if (!edge || typeof edge !== 'object' || !target) return false;
        const npcs = (Array.isArray(roster) ? roster : []).some(npc => String(npc?.id || '') === String(target.id)) ? roster : [...(roster || []), target];
        const endpoint = (idValue, labelValue) => {
            const id = String(idValue || '').trim();
            const label = String(labelValue || '').trim();
            const resolved = resolveNpcReference(npcs, id || label);
            if (resolved && id && label && String(resolved.id) === id && rowContradictsTarget({ name: label }, resolved, npcs)) return { contradiction: true };
            return { npc: resolved };
        };
        const a = endpoint(edge.aId ?? edge.a_id, edge.a ?? edge.from ?? edge.source);
        const b = endpoint(edge.bId ?? edge.b_id, edge.b ?? edge.to ?? edge.target);
        if (a.contradiction || b.contradiction) return false;
        return String(a.npc?.id || '') === String(target.id) || String(b.npc?.id || '') === String(target.id);
    }

    function scopeProfileUpdatesToTarget(parsed, target, roster = []) {
        const rawProfiles = Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed?.profile_updates) ? parsed.profile_updates : []);
        parsed.profileUpdates = rawProfiles.filter(row => profileRowBindsToTarget(row, target, roster)).map(row => ({ ...row, id: target.id, name: target.name }));
        delete parsed.profile_updates;
        return parsed.profileUpdates;
    }

    // A single-target request may accept its only returned row even when the model changed the label
    // (e.g. expanded a short name), but never a row that explicitly identifies someone else: that
    // would write another NPC's lifecycle and profile into the requested dossier.
    function soleRowMayBeTarget(row, { npcId = '', labels = [] } = {}, roster = []) {
        if (!row || typeof row !== 'object') return false;
        const rowName = String(row.name || '').trim();
        const targetLabels = labels.map(label => String(label || '').trim()).filter(Boolean);
        if (rowName) {
            const rowRecord = { name: rowName, aliases: Array.isArray(row.aliases) ? row.aliases : [] };
            return targetLabels.some(label => backfillScanMatchesTarget(rowRecord, { npcId: '', label }));
        }
        const rowId = String(row.id || '').trim();
        return !(rowId && rowId !== String(npcId) && roster.some(npc => String(npc?.id || '') === rowId));
    }

    function transcriptMentionsBackfillTarget(transcript, label) {
        const target = normalizeName(label);
        const haystack = normalizeName(transcript);
        if (!target || !haystack) return false;
        return (` ${haystack} `).includes(` ${target} `);
    }

    async function prepareCanonicalScanBase(key, label = 'scan') {
        try {
            await settleStateFileWrite(key, { flush: true });
            await ensureHydratedStateFresh(key, { reason: `${label}-start` });
            if (staleHostActive(key)) {
                globalThis.toastr?.warning?.('NPC State Delta: this chat has not loaded the newest messages another session added, so scanning it would roll the dossier back. Reload the chat first.');
                return false;
            }
            return getChatKey() === key && chatHydrationStatus(key) === 'ready';
        } catch (error) {
            console.info(`[NPC State Delta] ${label} did not start because its canonical server base could not be established.`, error);
            return false;
        }
    }

    // ---- The targeted dossier pass (cleanup step 8) ----
    // The Megumin dossier import (scanNpcDossier), Refresh (refreshNpcFromChat) and backfill
    // (backfillNpcFromHistory) each read one source for one NPC and may change only that NPC. They share
    // one runner: the scan's stale rule (a reply another extension rewrote in place is still the source),
    // the same isolation (every other dossier is put back verbatim after the merge), terminal-death
    // protection, a diagnostics receipt and, while hosted, the relationship forward to Story Block's slice.
    // Each kind keeps its own source, prompt, row scoping, merge options and messages.
    function targetedPassMetrics(label, { startedAt, prompt, raw, retried, parsed, merged = null, localEdges = [] }) {
        return {
            label,
            durationMs: Math.max(0, Math.round((performance.now?.() ?? Date.now()) - startedAt)),
            promptChars: prompt.length,
            responseChars: String(raw ?? '').length,
            retried: Boolean(retried),
            relationshipPass: false,
            relationshipTargets: 0,
            relationshipResponseChars: 0,
            relationshipRetried: false,
            relationshipEdges: merged ? (parsed.keyRelationshipEdges || []).length : 0,
            relationshipEdgeFallbacks: localEdges.length,
            profileUpdates: merged ? (parsed.profileUpdates || []).length : 0,
            profileApplied: Number(merged?.report?.profileUpdateStats?.applied || 0),
            profileEvidenceAdded: Number(merged?.report?.profileUpdateStats?.evidenceAdded || 0),
            profileDevelopment: Array.isArray(merged?.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [],
            at: Date.now(),
        };
    }

    // The single returned row a targeted pass may take for its target: one that names it, else the only
    // row when it may be the target (`soleRowAllowed`), never one that explicitly identifies someone else.
    function targetedRowFor(returned, target, roster, { npcId = target?.id, label = target?.name, labels = [], soleRowAllowed = true } = {}) {
        let match = returned.find(npc => backfillScanMatchesTarget(npc, { npcId, label }));
        if (!match && returned.length === 1 && soleRowAllowed && soleRowMayBeTarget(returned[0], { npcId, labels }, roster)) match = returned[0];
        return match && !rowContradictsTarget(match, target, roster) ? match : null;
    }

    function endTargetedRewriteTolerance(messageId) {
        for (const operation of runningTargetedPasses) {
            if (!Number.isInteger(messageId) || operation.sourceMessageId === messageId) operation.sourceMessageId = null;
        }
    }

    async function runTargetedDossierPassInner(job) {
        const { chatKey, ctx, id, label, prompt, systemPrompt, metricsLabel } = job;
        await refreshMessageGate();
        const lineage = chatLineage(ctx.chat || []);
        const boundMessageId = latestMessageId(true);
        const startedAt = performance.now?.() ?? Date.now();
        const scanStateVersion = Number(stateVersions.get(chatKey) || 0);
        const operation = beginScanOperation(chatKey, label, { npcId: id, indicator: job.indicator });
        if (!operation) {
            job.onBusy?.();
            return false;
        }
        operation.sourceLineage = lineage;
        // (1.2.9, as the scan) The latest reply rewritten in place by another extension is still the source.
        operation.sourceMessageId = boundMessageId >= 0 ? boundMessageId : null;
        runningTargetedPasses.add(operation);
        setScanIndicator(true);
        job.setIndicator?.(true);
        try {
            const { parsed, raw, retried } = await generateParsedNpcJson(ctx, {
                systemPrompt, prompt, responseLength: BACKFILL_RESPONSE_LENGTH, label, requestScope: operation.requestScope,
            });
            if (!scanOperationCurrent(chatKey, operation) || !await scanCanonicalBaseCurrent(chatKey, operation, job.staleLabel)) {
                console.info(`[NPC State Delta] discarded expired, superseded, or stale-canonical ${job.staleLabel}.`);
                return false;
            }
            if (getChatKey() !== chatKey || lineageMoved(lineage, chatLineage(getContext().chat || []), operation.sourceMessageId)
                || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
                job.onStale();
                return false;
            }
            // (v2 hidden notes) Story events the pass was told to look for: sent whatever else the answer holds.
            if (job.notes?.watch?.length) forwardSecretEventsToHost(job.notes.watch, parsed?.secretEvents, operation.chatHead);
            const latest = getChatState(chatKey);
            const liveBefore = latest.npcs.find(npc => npc.id === id) || null;
            const scoped = job.scope(parsed, { latest, liveBefore });
            if (!scoped.ok) {
                if (scoped.noChange) {
                    const metrics = targetedPassMetrics(metricsLabel, { startedAt, prompt, raw, retried, parsed, localEdges: scoped.localEdges });
                    if (job.reportsScanMetrics) rt.lastScanMetrics = metrics;
                    recordScanDiagnostics(chatKey, metrics, parsed, null, { targeted: true, npcIds: [id], sourceMessageId: latestMessageId(true) });
                }
                return scoped.result;
            }
            const settings = getSettings();
            const targetMessageId = Number.isInteger(job.messageId) ? job.messageId : latestMessageId(true);
            const merged = mergeScanResult(latest, parsed, {
                maxNpcs: settings.maxNpcs,
                excludeNames: [...currentExclusions(), ...(latest.dismissed || [])],
                turn: latest.turn,
                sourceMessageId: targetMessageId,
                scenePresent: scenePresentAt(targetMessageId),
                calendarSource: getContext().chat?.[targetMessageId]?.mes || '',
                storyDay: storyDayAt(targetMessageId),
                customFieldNames: settings.customFieldNames,
                relationshipBaseline: settings.relationshipBaseline,
                relationshipCaps: settings.relationshipCaps,
                autoArchiveDeaths: settings.autoArchiveDeaths !== false,
                autoReactivateArchived: settings.autoReactivateArchived !== false,
                admissionMode: settings.admissionMode,
                preservePresence: true,
                skipRelationshipUpdate: true,
                ...job.mergeOptions,
            });
            // (I-17) One NPC only: social-edge and alias machinery may run inside the merge, but every other
            // dossier is put back exactly as it was.
            const latestById = new Map((latest.npcs || []).map(npc => [npc.id, structuredClone(npc)]));
            merged.state.npcs = (merged.state.npcs || []).map(npc => (npc.id === id ? npc : (latestById.get(npc.id) || npc)));
            const result = merged.state.npcs.find(npc => npc.id === id);
            if (!result) return false;
            // (v2 hidden notes) A backfill of a dossier that is new: the layered notes the model wrote for it.
            if (job.notes?.layered) attachGeneratedSecrets(merged.state, [id], parsed);
            job.afterMerge?.(result, { liveBefore, scoped, merged });
            if (liveBefore) Object.assign(result, protectTerminalNpc(liveBefore, result));
            if (!await scanCanonicalBaseCurrent(chatKey, operation, `${job.staleLabel} final commit`)) {
                job.onLateStale?.();
                return false;
            }
            if (targetMessageId >= 0) {
                job.beforeCheckpoint?.(merged.state, result, targetMessageId);
                commitBranchCheckpoint(merged.state, targetMessageId, job.checkpoint);
            }
            setChatState(chatKey, merged.state);
            forwardRelationshipChangesToHost(latest.npcs, merged.state.npcs, targetMessageId, operation.chatHead);
            persist();
            renderDossier();
            updateInjection();
            // (I-19) Every kind leaves a diagnostics receipt; only Refresh reports as the last scan's metrics.
            const metrics = targetedPassMetrics(metricsLabel, { startedAt, prompt, raw, retried, parsed, merged, localEdges: scoped.localEdges });
            if (job.reportsScanMetrics) rt.lastScanMetrics = metrics;
            recordScanDiagnostics(chatKey, metrics, parsed, merged.report, { targeted: true, npcIds: [id], sourceMessageId: targetMessageId });
            console.info(`[NPC State Delta] ${metricsLabel} metrics`, metrics);
            return job.onDone(getChatState(chatKey).npcs.find(npc => npc.id === id));
        } catch (error) {
            return job.onError(error);
        } finally {
            runningTargetedPasses.delete(operation);
            const owned = scanOperationCurrent(chatKey, operation);
            endScanOperation(chatKey, operation);
            if (getChatKey() === chatKey) setScanIndicator(isScanBusy(chatKey));
            if (owned) job.setIndicator?.(false);
            updateInjection();
        }
    }

    // The single-target channels besides the NPC row: profile updates bound to the target, and social
    // edges touching it.
    function scopeTargetedChannels(parsed, target, roster) {
        scopeProfileUpdatesToTarget(parsed, target, roster);
        parsed.keyRelationshipEdges = (Array.isArray(parsed.keyRelationshipEdges) ? parsed.keyRelationshipEdges : (Array.isArray(parsed.key_relationship_edges) ? parsed.key_relationship_edges : []))
            .filter(edge => edgeTouchesResolvedTarget(edge, target, roster));
        delete parsed.key_relationship_edges;
    }

    async function scanNpcDossier(npcId) {
        const id = String(npcId || '').trim();
        const ctx = getContext();
        const chatKey = getChatKey();
        if (!id || chatKey === 'no-chat') return false;
        try { await ensureChatStateLoaded(chatKey); } catch (error) { globalThis.toastr?.warning?.(`NPC State Delta: cannot scan this dossier until the canonical server state is available. ${error?.message || error}`); return false; }
        if (getChatKey() !== chatKey || !requireReadyChatMutation('scan a dossier', chatKey)) return false;
        if (isScanBusy(chatKey)) {
            globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
            return false;
        }
        if (!await prepareCanonicalScanBase(chatKey, 'dossier import')) return false;
        // (timeline) The import reads only the messages the story stands on: the gate is asked before the chat is read, and a faded one reads as hidden.
        await refreshMessageGate();
        if (getChatKey() !== chatKey) return false;
        const state = getChatState(chatKey);
        const existing = state.npcs.find(npc => npc.id === id);
        if (!existing) return false;
        const sources = findMeguminDossierSources(existing, activeChat(ctx.chat || []));
        if (!sources.length) {
            globalThis.toastr?.info?.(`NPC State Delta: no matching Megumin dossier block found for ${existing.name}; scanning recent story context instead.`);
            return backfillNpcFromHistory({ npcId: existing.id, label: existing.name, requestedAt: Date.now() }, latestMessageId(true));
        }
        const sourceText = sources.map(item => `[message ${item.messageId + 1} · ${item.kind}]\n${item.text}`).join('\n\n');
        const prompt = buildDossierImportPrompt({
            dossierText: sourceText,
            targetName: existing.name,
            existingNpc: existing,
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || 'Character',
            // (I-13) The configured custom fields, as the merge already accepts them from the import.
            customFieldNames: getSettings().customFieldNames,
        });
        return runTargetedDossierPass({
            chatKey, ctx, id, prompt,
            label: `dossier import for ${existing.name}`,
            systemPrompt: "You are NPC State Delta's isolated structured dossier importer. Use only the supplied dossier payload. Return only the requested JSON object.",
            indicator: 'dossier',
            staleLabel: 'dossier import',
            checkpoint: 'dossier-import',
            metricsLabel: 'dossier-import',
            setIndicator: busy => setNpcDossierScanIndicator(id, busy),
            onBusy: () => globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.'),
            onStale: () => globalThis.toastr?.info?.('NPC State Delta: chat changed during dossier import; stale result was discarded.'),
            scope: (parsed, { latest }) => {
                const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
                const match = targetedRowFor(returned, existing, latest.npcs, { labels: [existing.name, ...(existing.aliases || [])] });
                if (!match) {
                    globalThis.toastr?.warning?.(`NPC State Delta: the dossier importer did not return ${existing.name}.`);
                    return { ok: false, result: false };
                }
                parsed.npcs = [{
                    ...match,
                    id,
                    present: Boolean(existing.present),
                    worldActive: Boolean(existing.worldActive) && !Boolean(existing.present),
                    relationshipImpact: 'none',
                    relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                    relationshipChangeReason: '',
                }];
                scopeTargetedChannels(parsed, existing, latest.npcs);
                return { ok: true };
            },
            mergeOptions: { developmentContext: sourceText, userDevelopmentContext: sourceText },
            onDone: saved => {
                globalThis.toastr?.success?.(`NPC State Delta: imported ${saved?.name || existing.name} from ${sources.length} Megumin dossier block${sources.length === 1 ? '' : 's'}.`);
                return true;
            },
            onError: error => {
                console.error('[NPC State Delta] structured dossier import failed', error);
                globalThis.toastr?.warning?.(`NPC State Delta dossier import failed for ${existing.name}: ${error?.message || error}`);
                return false;
            },
        });
    }

    function syncOpenNpcEditorFields(npc) {
        if (!npc || !editorIsMounted()) return;
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

    function refreshChangedFields(before, after) {
        return REFRESH_CHANGED_FIELDS.filter(field => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
    }

    // (1.2.11) `automatic`: a one-pass catch-up, not the reader's click. It stays quiet unless it
    // changed something, and never touches a dossier open in the editor.
    async function refreshNpcFromChat(npcId, { automatic = false } = {}) {
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
        // (v2 hidden notes) A Refresh looks for this person's story events (never writes layers: the dossier is not new).
        const notes = hostedTargetNotes(existing);
        const prompt = buildProfileRefreshPrompt({
            transcript,
            targetNpc: existing,
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || 'Character',
            memoryCriteria: settings.memoryCriteria,
            turn: Number.isInteger(state.turn) ? state.turn : null,
            storyDay: storyDayAt(latestMessageId(true)),
            customFieldNames: settings.customFieldNames,
            ...targetNoteOptions(notes),
        });
        return runTargetedDossierPass({
            chatKey, ctx, id, prompt, notes,
            label: `chat refresh for ${existing.name}`,
            systemPrompt: "You are NPC State Delta's targeted dossier reconciliation scanner. Re-read the supplied recent-story window for exactly one existing NPC. Return only the requested JSON object.",
            indicator: 'refresh',
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
                if (proposedSummary && !(liveBefore.manualProfileFields || []).includes('relationshipSummary')
                    && relationshipSummaryConsistent(proposedSummary, refreshed.relationship, transcript, refreshed.relationshipMilestones)) {
                    refreshed.relationshipSummary = calibrateRelationshipSummary(proposedSummary, refreshed.relationship);
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

    const BACKFILL_RETRY_COOLDOWN_MS = 60 * 1000;

    // The live state a backfill that preserves it keeps: the record's own, whatever the model returned.
    function backfillLiveState(liveBefore, keptPresent) {
        return {
            present: keptPresent,
            worldActive: Boolean(liveBefore.worldActive) && !keptPresent,
            mood: liveBefore.mood || '',
            location: liveBefore.location || '',
            goal: liveBefore.goal || '',
            status: liveBefore.status || '',
        };
    }

    async function backfillNpcFromHistory(request, messageId = null, { automatic = false } = {}) {
        const settings = getSettings();
        const ctx = getContext();
        const chatKey = getChatKey();
        if (!request?.npcId || !request?.label || chatKey === 'no-chat') return false;
        try { await ensureChatStateLoaded(chatKey); } catch { return false; }
        if (getChatKey() !== chatKey || !requireReadyChatMutation('backfill a dossier', chatKey, { notify: false })) return false;
        if (isScanBusy(chatKey)) return false;
        if (!await prepareCanonicalScanBase(chatKey, 'dossier backfill')) return false;
        // (timeline) The window is read from the messages the story stands on: the gate is asked first.
        await refreshMessageGate();
        if (getChatKey() !== chatKey) return false;
        const state = getChatState(chatKey);
        const existing = state.npcs.find(npc => npc.id === request.npcId);
        if (!existing) return false;
        const transcript = recentTranscript(settings.scanDepth);
        if (!transcript) return false;
        if (automatic) {
            if (!automaticBackfillStillRelevant(request, existing, state.npcs, currentExchangeTranscript(request.requestedMessageId))) return true;
        } else if (!backfillNeedsRequest(existing, state.npcs)) {
            return true;
        }
        const notes = hostedTargetNotes(existing, { newDossier: request.reason === 'new-admission', messageId });
        const prompt = buildBackfillPrompt({
            transcript,
            targetName: request.label,
            existingNpc: existing,
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || 'Character',
            memoryCriteria: settings.memoryCriteria,
            customFieldNames: settings.customFieldNames,
            ...targetNoteOptions(notes),
        });
        return runTargetedDossierPass({
            chatKey, ctx, prompt, messageId, notes,
            id: request.npcId,
            label: `backfill for ${request.label}`,
            systemPrompt: "You are NPC State Delta's isolated dossier backfill scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
            indicator: 'backfill',
            staleLabel: 'dossier backfill',
            checkpoint: 'dossier-backfill',
            metricsLabel: 'dossier-backfill',
            onStale: () => console.info('[NPC State Delta] discarded stale dossier backfill after chat or dossier state changed.'),
            scope: (parsed, { latest, liveBefore }) => {
                const roster = latest.npcs;
                const target = liveBefore || { id: request.npcId, name: request.label, aliases: [], identityKind: inferNpcIdentityKind(request.label) };
                const returned = Array.isArray(parsed.npcs) ? parsed.npcs : [];
                // The backfill prompt is single-target by construction. If the model expands a short
                // label (e.g. Toris -> Toris Vale) without repeating the alias, accept the sole result
                // when the requested target is actually present in the supplied history.
                const labels = [request.label, ...(liveBefore ? [liveBefore.name, ...(liveBefore.aliases || [])] : [])];
                let matches = returned.filter(npc => backfillScanMatchesTarget(npc, request));
                if (!matches.length && returned.length === 1 && transcriptMentionsBackfillTarget(transcript, request.label)
                    && soleRowMayBeTarget(returned[0], { npcId: request.npcId, labels }, roster)) matches = returned;
                matches = matches.filter(row => !rowContradictsTarget(row, target, roster));
                const preserved = request.preserveLiveState === true ? liveBefore : null;
                // A missed-participant repair exists because the NPC takes part in the current exchange;
                // the broad scan's omission is not evidence of absence, so a grounded present=true stands.
                // Other repairs keep the live presence (older history must not make an NPC present).
                const repairedPresence = request.reason === 'missed-participant' && matches[0]?.present === true
                    && !npcCurrentlyAbsentInText(existing, currentExchangeTranscript(request.requestedMessageId));
                const keptPresent = preserved ? (repairedPresence || Boolean(preserved.present)) : false;
                parsed.npcs = matches.slice(0, 1).map(npc => ({
                    ...npc,
                    id: request.npcId,
                    // (C-3) The same live state the merge result keeps below, so the merge sees no change.
                    ...(preserved ? backfillLiveState(preserved, keptPresent) : {}),
                    relationshipImpact: 'none',
                    relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 },
                    relationshipChangeReason: '',
                }));
                if (!parsed.npcs.length) {
                    const literalMention = transcriptMentionsBackfillTarget(transcript, request.label);
                    console.warn('[NPC State Delta] targeted backfill returned no accepted NPC', { target: request.label, literalMention, returnedCount: returned.length });
                    if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: ${request.label} was added, but the backfill model returned no matching dossier details from the last ${settings.scanDepth} messages.`);
                    return { ok: false, result: false };
                }
                // A single-target backfill may change only its target, in every result channel: profile
                // updates and social edges for other dossiers are dropped like their npc rows.
                scopeTargetedChannels(parsed, target, roster);
                return { ok: true, preserved, keptPresent, repairedPresence };
            },
            mergeOptions: {
                // The backfill prompt asks for up to five memories (a first, whole dossier).
                memoryInputLimit: IMPORTANT_MEMORY_LIMIT,
                allowTargetedDurableSeed: true,
                developmentContext: transcript,
                userDevelopmentContext: recentUserDevelopmentContext(settings.scanDepth, { messageIds: true }),
            },
            afterMerge: (finalNpc, { scoped }) => {
                const { preserved, keptPresent, repairedPresence } = scoped;
                if (!preserved) return;
                Object.assign(finalNpc, backfillLiveState(preserved, keptPresent));
                finalNpc.seenCount = Number(preserved.seenCount || 0);
                finalNpc.lastSeenTurn = repairedPresence
                    ? Math.max(Number(preserved.lastSeenTurn || 0), Number(state.turn || 0))
                    : Number(preserved.lastSeenTurn || 0);
                finalNpc.lastWorldActiveTurn = Number(preserved.lastWorldActiveTurn || 0);
            },
            beforeCheckpoint: (nextState, finalNpc, targetMessageId) => {
                if (!finalNpc.archived && finalNpc.present) recordInlineCardsInState(nextState, targetMessageId, [finalNpc.id], 'dossier-backfill');
                else removeNpcInlineCardAtMessage(nextState, targetMessageId, finalNpc.id);
            },
            onDone: savedNpc => {
                if (!request.silent) globalThis.toastr?.success?.(`NPC State Delta: backfilled ${savedNpc?.name || request.label} from recent story context.`);
                return true;
            },
            onError: error => {
                noteScanFailure('dossier backfill', error, getChatKey());
                if (error?.code === 'NPC_SCANNER_ROUTE_CANCELLED' || error?.code === 'NPC_SCANNER_ROUTE_TIMEOUT') return null;
                if (!request.silent || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.warning?.(`NPC State Delta backfill failed for ${request.label}: ${error?.message || error}`);
                return false;
            },
        });
    }

    async function processPendingBackfillsInner(messageId = null, { limit = Infinity } = {}) {
        const chatKey = getChatKey();
        if (chatKey === 'no-chat' || !requireReadyChatMutation('process queued dossier backfills', chatKey, { notify: false }) || isScanBusy(chatKey) || isHostSwipeActive()) return 0;
        let processed = 0;
        // Model calls made (each backfill is one request, plus a compact retry at most).
        let calls = 0;
        const attemptedNpcIds = new Set();
        while (getChatKey() === chatKey && !isScanBusy(chatKey) && calls < limit) {
            const state = getChatState(chatKey);
            if (!Array.isArray(state.pendingBackfills) || !state.pendingBackfills.length) break;
            const request = state.pendingBackfills.find(item => item?.npcId && !attemptedNpcIds.has(item.npcId));
            if (!request) break;
            attemptedNpcIds.add(request.npcId);
            const target = state.npcs.find(npc => npc.id === request.npcId);
            const owningExchange = Number.isInteger(request.requestedMessageId) ? currentExchangeTranscript(request.requestedMessageId) : '';
            if (!automaticBackfillStillRelevant(request, target, state.npcs, owningExchange)) {
                state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
                persist();
                continue;
            }
            const attempts = Math.max(0, Math.round(Number(request.attempts) || 0));
            if (attempts >= BACKFILL_MAX_ATTEMPTS) {
                state.pendingBackfills = state.pendingBackfills.filter(item => item.npcId !== request.npcId);
                persist();
                if (!request.silent) globalThis.toastr?.warning?.(`NPC State Delta: stopped automatic backfill retries for ${request.label} after ${BACKFILL_MAX_ATTEMPTS} failed attempts. The bare dossier is preserved; use Scan dossier to retry manually.`);
                continue;
            }
            const lastAttemptAt = Math.max(0, Number(request.lastAttemptAt || 0) || 0);
            if (attempts > 0 && lastAttemptAt && Date.now() - lastAttemptAt < BACKFILL_RETRY_COOLDOWN_MS) continue;

            calls += 1;
            const succeeded = await backfillNpcFromHistory(request, messageId, { automatic: true });
            if (succeeded === null) break;
            if (getChatKey() !== chatKey || !requireReadyChatMutation('settle queued dossier backfill', chatKey, { notify: false })) break;
            // (1.10.1) A scan that began while this backfill was getting ready holds the chat: the backfill made no request (it found the chat
            // busy). Writing the queue now would change the dossier state under that scan, which then discards its result; the request stays
            // queued, uncounted, for the next run.
            if (isScanBusy(chatKey)) break;
            const latest = getChatState(chatKey);
            const currentRequest = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
            if (!currentRequest || currentRequest.requestedAt !== request.requestedAt || currentRequest.requestedMessageId !== request.requestedMessageId) continue;
            if (!succeeded) {
                const queued = (latest.pendingBackfills || []).find(item => item.npcId === request.npcId);
                if (queued) {
                    queued.attempts = attempts + 1;
                    queued.lastAttemptAt = Date.now();
                    if (queued.attempts >= BACKFILL_MAX_ATTEMPTS) {
                        latest.pendingBackfills = latest.pendingBackfills.filter(item => item.npcId !== request.npcId);
                        if (!queued.silent) globalThis.toastr?.warning?.(`NPC State Delta: automatic backfill for ${queued.label} failed ${BACKFILL_MAX_ATTEMPTS} times and was removed from the retry queue. The dossier itself was not deleted.`);
                    }
                }
                persist();
                // One failed dossier must not starve other queued targeted repairs.
                continue;
            }
            latest.pendingBackfills = (latest.pendingBackfills || []).filter(item => item.npcId !== request.npcId);
            persist();
            processed += 1;
        }
        return processed;
    }

    return { prepareCanonicalScanBase, endTargetedRewriteTolerance, runTargetedDossierPassInner, scanNpcDossier, refreshNpcFromChat, processPendingBackfillsInner };
}
