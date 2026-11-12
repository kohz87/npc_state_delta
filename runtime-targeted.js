/* NPC State Delta targeted passes (role: targeted-passes). The scans aimed at one person or a few: the targeted dossier pass, Scan dossier, Refresh from
   chat, the history backfill and the queue of pending backfills, with the rules that scope a pass's rows and edges to its target. Built by index.js
   once per module instance with the shared runtime state. Bodies are moved from index.js without change. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { REFRESH_CHANGED_FIELDS } from './src/fields/registry.js';
import { storyDayAt, tieDayAt, currentExclusions, refreshMessageGate, activeChat } from './src/transcript.js';
import { BACKFILL_RESPONSE_LENGTH, generateParsedNpcJson } from './src/scanner-request.js';
import { buildDossierImportPrompt, mergeScanResult, protectTerminalNpc } from './core.js';
import { chatLineage } from './branch.js';
import { getSettings, effectiveCustomFieldNames } from './runtime-settings.js';
import { replayScope, setNpcDossierScanIndicator, lineageMoved, setScanIndicator, latestMessageId } from './runtime-scan-helpers.js';
import { createTargetedScopePart } from './runtime-targeted-scope.js';
import { createTargetedRefreshPart } from './runtime-targeted-refresh.js';
import { createTargetedBackfillPart } from './runtime-targeted-backfill.js';
import { advanceCastAdmission } from './runtime-cast-sync.js';
import { captureJournalEntry, recordAcceptedFill } from './runtime-narration.js';

export function createTargetedPart(rt, deps) {
    const { attachGeneratedSecrets, BACKFILL_MAX_ATTEMPTS, beginScanOperation, chatHydrationStatus, commitBranchCheckpoint, editorIsMounted, endScanOperation, ensureChatStateLoaded, ensureHydratedStateFresh, findMeguminDossierSources, flushStateFile, forwardRelationshipChangesToHost, forwardSecretEventsToHost, forwardTastesToHost, getChatKey, getChatState, hostedMeterView, hostedTargetNotes, isHostSwipeActive, isScanBusy, noteScanFailure, partyLevelList, persist, recordInlineCardsInState, recordScanDiagnostics, removeNpcInlineCardAtMessage, renderDossier, requireReadyChatMutation, runTargetedDossierPass, saveNpcEditor, scanCanonicalBaseCurrent, scanOperationCurrent, scenePresentAt, setChatState, settleStateFileWrite, staleHostActive, targetNoteOptions, updateInjection } = deps;
    const { stateVersions, runningTargetedPasses } = rt;
    const { backfillScanMatchesTarget, rowContradictsTarget, soleRowMayBeTarget, scopeProfileUpdatesToTarget, edgeTouchesResolvedTarget } = createTargetedScopePart();

    async function prepareCanonicalScanBase(key, label = 'scan') {
        if (replayScope()?.key === key) return getChatKey() === key;
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
            const replayFill = replayScope() && captureJournalEntry(replayScope(), ctx.chat || [], job.captureMessageId)?.[job.captureKind || 'fills']?.[id];
            const { parsed, raw, retried } = replayFill ? { parsed: structuredClone(replayFill), raw: '', retried: false } : await generateParsedNpcJson(ctx, {
                systemPrompt, prompt, responseLength: BACKFILL_RESPONSE_LENGTH, label, requestScope: operation.requestScope,
            });
            const acceptedInput = !replayScope() && Number.isInteger(job.captureMessageId) ? structuredClone(parsed) : null;
            if (!scanOperationCurrent(chatKey, operation) || !await scanCanonicalBaseCurrent(chatKey, operation, job.staleLabel)) {
                console.info(`[NPC State Delta] discarded expired, superseded, or stale-canonical ${job.staleLabel}.`);
                return false;
            }
            if (getChatKey() !== chatKey || lineageMoved(lineage, chatLineage(getContext().chat || []), operation.sourceMessageId)
                || Number(stateVersions.get(chatKey) || 0) !== scanStateVersion) {
                job.onStale();
                return false;
            }
            const latest = getChatState(chatKey);
            const liveBefore = latest.npcs.find(npc => npc.id === id) || null;
            // (v2 hidden notes) Story events the pass was told to look for, sent whatever else the answer holds, and a Refresh's tastes for this
            // person, recorded on the head reply like a `~ taste` line: the rows as the model returned them (the scope below narrows parsed.npcs).
            // Sent only once the result is accepted (all or nothing): a pass discarded below tells the host nothing.
            const returnedRows = parsed?.npcs;
            const forwardNotes = () => {
                if (job.notes?.watch?.length) forwardSecretEventsToHost(job.notes.watch, parsed?.secretEvents, operation.chatHead);
                if (job.notes?.tastes && liveBefore) forwardTastesToHost(liveBefore, returnedRows, operation.chatHead);
            };
            const scoped = job.scope(parsed, { latest, liveBefore });
            if (!scoped.ok) {
                if (scoped.noChange) {
                    forwardNotes();
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
                tieDay: tieDayAt(targetMessageId),
                customFieldNames: effectiveCustomFieldNames(settings),
                relationshipBaseline: settings.relationshipBaseline,
                relationshipCaps: settings.relationshipCaps,
                autoArchiveDeaths: settings.autoArchiveDeaths !== false,
                autoReactivateArchived: settings.autoReactivateArchived !== false,
                admissionMode: settings.admissionMode,
                partyLevels: partyLevelList(),
                preservePresence: true,
                skipRelationshipUpdate: true,
                historicalRead: Boolean(replayScope() && !replayFill),
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
            if (liveBefore) advanceCastAdmission(merged.state, liveBefore, result); // (ONEPASSCAPR2-2) an automatic fill is still subordinate to the pack
            if (liveBefore) Object.assign(result, protectTerminalNpc(liveBefore, result));
            if (!await scanCanonicalBaseCurrent(chatKey, operation, `${job.staleLabel} final commit`)) {
                job.onLateStale?.();
                return false;
            }
            forwardNotes();
            if (acceptedInput) recordAcceptedFill(merged.state, ctx.chat || [], job.captureMessageId, id, acceptedInput, job.captureKind || 'fills');
            if (targetMessageId >= 0) {
                job.beforeCheckpoint?.(merged.state, result, targetMessageId);
                commitBranchCheckpoint(merged.state, targetMessageId, job.checkpoint);
            }
            setChatState(chatKey, merged.state);
            forwardRelationshipChangesToHost(latest.npcs, merged.state.npcs, targetMessageId, operation.chatHead, [], parsed?.npcs);
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
            customFieldNames: effectiveCustomFieldNames(),
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

    function refreshChangedFields(before, after) {
        return REFRESH_CHANGED_FIELDS.filter(field => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
    }

    const { refreshNpcFromChat } = createTargetedRefreshPart(rt, deps, { prepareCanonicalScanBase, targetedRowFor, refreshChangedFields });
    const { backfillNpcFromHistory, processPendingBackfillsInner } = createTargetedBackfillPart(rt, deps, { prepareCanonicalScanBase, scopeTargetedChannels });

    return { prepareCanonicalScanBase, endTargetedRewriteTolerance, runTargetedDossierPassInner, scanNpcDossier, refreshNpcFromChat, processPendingBackfillsInner };
}
