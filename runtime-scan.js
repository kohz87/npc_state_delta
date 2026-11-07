/* NPC State Delta reply scan (role: reply-scan). The scan of a reply: the handler of a new assistant message, the scan itself (one-pass capture or the
   scanner request, merge, stale lifecycle, backfill queue, checkpoint), the capture catch-up and the checks that a reply was rewritten in place. Built by
   index.js once per module instance with the shared runtime state. Bodies are moved from index.js without change. */

import { getContext } from '../../../extensions.js';
import { isScannerRoutingError } from './scanner-routing.js';
import { AUTOMATIC_BACKFILL_QUEUE_VERSION, AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT, autoScanDue as autoScanDueAfterReply, npcParticipatesInExchange, readAheadOf, replyMayChangeDossiers, replyScanned, settleScan } from './scan-context.js';
import { recentTranscript, recentUserDevelopmentContext, currentExchangeUserDevelopmentContext, currentExchangeTranscript, skippedExchangesWindow, recentReplyIds, activeReplyIds, currentExchangeProse, currentExchangeBodies, storyDayAt, currentExclusions, refreshMessageGate } from './src/transcript.js';
import { FULL_SCAN_RESPONSE_LENGTH, SCAN_RESPONSE_LENGTH, generateParsedNpcJson } from './src/scanner-request.js';
import { applyFocusedRelationshipDecisions, rawScanMatchesExisting, runFocusedRelationshipPass, suppressPrimaryRelationshipForFocusedDecisions } from './src/relationship-pass.js';
import { prepareFullWindowRelationshipPayload, buildScannerPrompt, mergeScanResult, tagScanEvidence, npcMatchesLabel, normalizeName, resolveInterimIdentityPromotions, hasCompactMeguminWorldState, extractExplicitKeyRelationshipEdges, applyStaleNpcLifecycle } from './core.js';
import { chatLineage, fingerprintMessage, lineageCheckpointKey, ensureBranchParentAnchor, migrateLegacyLineage } from './branch.js';
import { getSettings } from './runtime-settings.js';
import { narrationCaptureEnabled, lineageMoved, setScanIndicator, latestMessageId } from './runtime-scan-helpers.js';

import { createCatchUpPart } from './runtime-catchup.js';

export function createScanPart(rt, deps) {
    const { attachGeneratedSecrets, beginScanOperation, clearInlineCardsAtMessage, commitBranchCheckpoint, drainPendingAutoScan, endScanOperation, ensureChatStateLoaded, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedMeters, hostedNotePromptOptions, hostedOnePass, hostedScanState, isHostSwipeActive, isScanBusy, keyAwayScanOptions, narrationCaptureKey, narrationCaptureStats, noteScanFailure, persist, prepareCanonicalScanBase, processPendingBackfills, queuePendingAutoScan, queueSettledSwipeReconcile, recordInlineCardsInState, recordScanDiagnostics, refreshNpcFromChat, renderDossier, scanAfterEveryReply, scanCanonicalBaseCurrent, scanInlineNpcIds, scannerPromptOptions, scanNow, scanOperationCurrent, scanScenePresent, scenePresentAt, scheduleReplyBackfills, setChatState, staleHostActive, takeNarrationCapture, updateInjection } = deps;
    const { assistantReceipts, narrationCaptures, catchUpChats, stateVersions } = rt;
    const { noteCaptureCatchUp, runCaptureCatchUp } = createCatchUpPart(rt, { getChatKey, getChatState, hostedOnePass, isHostSwipeActive, isScanBusy, persist, processPendingBackfills, refreshNpcFromChat });

    function queueNpcBackfillInState(state, npcId, label, requestedMessageId = null, options = {}) {
        const reason = String(options?.reason || '').trim();
        if (!state || !npcId || !String(label || '').trim() || !['missed-participant', 'new-admission'].includes(reason)) return state;
        if (!Array.isArray(state.pendingBackfills)) state.pendingBackfills = [];
        const cleanLabel = String(label || '').trim().slice(0, 120);
        state.pendingBackfills = state.pendingBackfills.filter(item => item?.npcId !== npcId);
        state.pendingBackfills.push({
            queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
            reason,
            npcId: String(npcId).slice(0, 100),
            label: cleanLabel,
            requestedMessageId: Number.isInteger(requestedMessageId) ? requestedMessageId : null,
            preserveLiveState: options?.preserveLiveState === true,
            silent: options?.silent === true,
            requestedAt: Date.now(),
            attempts: 0,
            lastAttemptAt: 0,
        });
        if (state.pendingBackfills.length > 100) state.pendingBackfills.splice(0, state.pendingBackfills.length - 100);
        return state;
    }

    // (b6-soak-2) One capture block admits at most this many new people. A crowd scene (a block naming
    // forty dockhands) otherwise makes forty dossiers, each with its own backfill request later; the
    // people left out are admitted from a later reply that names them again.
    const CAPTURE_NEW_NPCS_PER_BLOCK = 4;
    function capCaptureAdmissions(parsed, npcs = []) {
        const rows = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
        let fresh = 0;
        const kept = rows.filter(raw => {
            if (npcs.some(npc => rawScanMatchesExisting(raw, npc))) return true;
            fresh += 1;
            return fresh <= CAPTURE_NEW_NPCS_PER_BLOCK;
        });
        if (kept.length === rows.length) return;
        console.info(`[NPC State Delta] a one-pass block named ${fresh} new people; ${CAPTURE_NEW_NPCS_PER_BLOCK} were admitted from it, the others wait for a later reply.`);
        parsed.npcs = kept;
    }

    function collectStaleCleanupProtectedIds(state, scanResult, transcript = '') {
        const ids = new Set();
        const npcs = Array.isArray(state?.npcs) ? state.npcs : [];
        const addReference = (id, label) => {
            const directId = String(id || '').trim();
            if (directId && npcs.some(npc => npc.id === directId)) ids.add(directId);
            const name = String(label || '').trim();
            if (!name) return;
            const matched = npcs.find(npc => npcMatchesLabel(npc, name));
            if (matched) ids.add(matched.id);
        };

        for (const raw of Array.isArray(scanResult?.npcs) ? scanResult.npcs : []) addReference(raw?.id, raw?.name);
        for (const raw of Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates : []) addReference(raw?.id, raw?.name);
        for (const edge of Array.isArray(scanResult?.keyRelationshipEdges) ? scanResult.keyRelationshipEdges : []) {
            addReference(edge?.aId, edge?.a);
            addReference(edge?.bId, edge?.b);
        }

        // Conservative local guard: if the current scan text explicitly names a stale NPC,
        // never prune that dossier even if the model omitted its delta object.
        const haystack = ` ${normalizeName(transcript)} `;
        if (haystack.trim()) {
            for (const npc of npcs) {
                const labels = [npc.name, ...(npc.aliases || [])]
                    .map(normalizeName)
                    .filter(label => label.length >= 3);
                if (labels.some(label => haystack.includes(` ${label} `))) ids.add(npc.id);
            }
        }
        return ids;
    }

    function applyStaleLifecycleAfterScan(state, scanResult, transcript, settings, { onlyWhenAtCap = false } = {}) {
        if (settings.autoPruneStale === false) return { state, archived: [], removed: [] };
        const activeCount = (state.npcs || []).filter(npc => !npc?.archived).length;
        if (onlyWhenAtCap && activeCount < Number(settings.maxNpcs || 40)) return { state, archived: [], removed: [] };
        return applyStaleNpcLifecycle(state, {
            turn: state.turn,
            archiveAfter: settings.staleArchiveAfter,
            deleteAfter: settings.staleDeleteAfter,
            protectedIds: [...collectStaleCleanupProtectedIds(state, scanResult, transcript)],
        });
    }

    // (1.2.9) Other extensions write into a reply just after it arrives: Story Block tidying its
    // blocks, RPG Battle its Party sheet, Story Director a closing line. That is the same reply
    // rewritten in place, not a new branch: its position and every message before it are unchanged.
    // Treating it as a different reply left the one-pass capture block waiting, never merged.
    function replyParentKey(messageId) {
        return messageId > 0 ? lineageCheckpointKey(chatLineage(getContext().chat || []), messageId - 1) : 'root';
    }
    function sameReplyRewritten(chatKey, messageId, parentKey) {
        if (getChatKey() !== chatKey || !Number.isInteger(messageId)) return false;
        const message = getContext().chat?.[messageId];
        return Boolean(message && !message.is_user && !message.is_system) && replyParentKey(messageId) === parentKey;
    }

    // Current presence, mood and location belong to the latest scene: an earlier-only window never sets them.
    function stripLiveSceneFields(parsed) {
        const rows = [...(Array.isArray(parsed?.npcs) ? parsed.npcs : []), ...(Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : [])];
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            for (const key of ['present', 'worldActive', 'world_active', 'activeOffscreen', 'active_offscreen', 'mood', 'moodState', 'mood_state', 'clearMood', 'clear_mood', 'location', 'locationState', 'location_state', 'clearLocation', 'clear_location']) delete row[key];
        }
    }

    // A chat counts as new (its first scan reads from the start) only when nothing was ever applied to it: no scan, no dossier
    // or candidate, and a history short enough for one window. An imported or cleared chat, or a long chat with no sidecar,
    // reads the latest reply only.
    const NEW_CHAT_MAX_REPLIES = 15;
    function chatNeverScanned(state, messageId) {
        if (Number(state?.scanCount || 0) > 0 || (state?.npcs || []).length || (state?.candidates || []).length) return false;
        const chat = getContext().chat || [];
        let replies = 0;
        for (let i = 0; i <= Math.min(messageId, chat.length - 1); i += 1) if (chat[i] && !chat[i].is_system && !chat[i].is_user) replies += 1;
        return replies <= NEW_CHAT_MAX_REPLIES;
    }

    async function scanNowInner({ manual = false, messageId = null, allowDuringSwipe = false } = {}) {
        const settings = getSettings();
        if (!settings.enabled) return false;
        if (!allowDuringSwipe && isHostSwipeActive()) {
            if (manual) globalThis.toastr?.info?.('NPC State Delta: wait for the current swipe to finish before scanning.');
            return false;
        }
        const ctx = getContext();
        const scanChatKey = getChatKey();
        if (scanChatKey === 'no-chat') return false;
        const sourceFingerprint = Number.isInteger(messageId) ? fingerprintMessage(ctx.chat?.[messageId] || {}) : null;
        const sourceParent = Number.isInteger(messageId) ? replyParentKey(messageId) : null;
        // The chat changed under the scan, unless only this reply was rewritten in place.
        const sourceMoved = () => getChatKey() !== scanChatKey || (sourceFingerprint !== null
            && sourceFingerprint !== fingerprintMessage(getContext().chat?.[messageId] || {})
            && !sameReplyRewritten(scanChatKey, messageId, sourceParent));
        await ensureChatStateLoaded(scanChatKey);
        await refreshMessageGate();
        if (sourceMoved()) return false;
        if (isScanBusy(scanChatKey)) {
            if (manual) globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
            else if (Number.isInteger(messageId)) queuePendingAutoScan(scanChatKey, messageId, 'busy-auto-scan');
            return false;
        }
        if (!await prepareCanonicalScanBase(scanChatKey, manual ? 'manual dossier scan' : 'automatic dossier scan')) return false;
        if (sourceMoved()) return false;
        const scanLineage = chatLineage(ctx.chat || []);
        let currentTranscript = currentExchangeTranscript(messageId);
        const currentProse = currentExchangeProse(messageId);
        const fullWindowScan = Boolean(!manual && settings.fullScanEveryTurn);
        // (lean) A scan reads every exchange since the last scan, not only this reply: the replies the local check skipped
        // are in it, up to 30 messages. More waiting than that: the oldest are read first and the next reply scans at once
        // (catch-up). Nothing skipped: the current exchange alone.
        const skippedWindow = !manual && !fullWindowScan && Number.isInteger(messageId) && !narrationCaptures.has(narrationCaptureKey(scanChatKey, messageId))
            ? skippedExchangesWindow(messageId, {
                afterId: getChatState(scanChatKey)?.lastScannedMessageId,
                fresh: chatNeverScanned(getChatState(scanChatKey), messageId),
                replies: getChatState(scanChatKey)?.assistantSinceScan,
                limit: settings.scanDepth,
                skip: readAheadOf(getChatState(scanChatKey)),
            })
            : null;
        // A catch-up window that stops before the chat's latest reply is earlier context only: no current presence, mood or meter deltas.
        const earlierOnly = Boolean(skippedWindow && !skippedWindow.latest);
        if (earlierOnly) currentTranscript = skippedWindow.lastExchange || currentTranscript;
        const transcript = (manual || fullWindowScan) ? recentTranscript(settings.scanDepth) : (skippedWindow?.transcript || currentTranscript);
        const userDevelopmentContext = (manual || fullWindowScan)
            ? recentUserDevelopmentContext(settings.scanDepth, { messageIds: true })
            : (skippedWindow?.userDevelopmentContext ?? currentExchangeUserDevelopmentContext(messageId));
        if (!transcript) {
            if (manual) globalThis.toastr?.warning?.('NPC State Delta: no story text to scan yet.');
            return false;
        }

        const operation = beginScanOperation(scanChatKey, manual ? 'manual dossier scan' : 'automatic dossier scan');
        if (operation) {
            operation.sourceLineage = scanLineage;
            // (1.2.9) The reply it reads: rewritten in place by another extension, it is still the source.
            operation.sourceMessageId = Number.isInteger(messageId) ? messageId : null;
        }
        if (!operation) return false;
        setScanIndicator(true);
        // (v2 meters) While hosted the slice is the truth: the scan shows, scores and forwards relationship
        // changes from the slice's numbers (the sidecar then follows them). Without a host it is the record.
        const state = hostedScanState(getChatState(scanChatKey));
        const newChatAtStart = chatNeverScanned(state, Number.isInteger(messageId) ? messageId : (ctx.chat || []).length - 1);
        const scanStateVersion = Number(stateVersions.get(scanChatKey) || 0);
        const capture = !manual && !fullWindowScan && Number.isInteger(messageId)
            ? takeNarrationCapture(scanChatKey, messageId)
            : null;
        const scanLabel = capture ? 'narration-capture' : (manual ? 'manual' : (fullWindowScan ? 'automatic-full' : 'automatic'));
        // (v2 hidden notes) Hosted: a new dossier's layered notes are asked for (setting) and the story events of present people's
        // locked notes are looked for in the current exchange. A scan sends both in its prompt; a one-pass block was asked
        // when its reply was generated, so its events are the ones that went out then (`capture.watch`). Neither is in a
        // prompt otherwise.
        const hostedNotes = hostedMeters();
        const noteOptions = hostedNotes && !capture ? hostedNotePromptOptions(state, settings, messageId) : {};
        const eventWatch = capture ? (Array.isArray(capture.watch) ? capture.watch : []) : (noteOptions.eventWatch || []);
        const prompt = capture ? '' : buildScannerPrompt(scannerPromptOptions(state, settings, transcript, {
            currentTranscript, earlierOnly, fullScanMode: fullWindowScan, sceneNames: scanScenePresent(messageId), ...noteOptions,
        }));

        let relationshipEdgeCount = 0;
        let relationshipEdgeFallbacks = 0;
        let profileUpdateCount = 0;
        let catchUpIds = [];
        try {
            const scanStartedAt = performance.now?.() ?? Date.now();
            const { parsed, raw, retried } = capture ? { ...capture, retried: false } : await generateParsedNpcJson(ctx, {
                systemPrompt: "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload. Return only the requested JSON object.",
                prompt,
                responseLength: fullWindowScan ? FULL_SCAN_RESPONSE_LENGTH : SCAN_RESPONSE_LENGTH,
                label: manual ? 'manual dossier scan' : (fullWindowScan ? 'automatic full dossier scan' : 'automatic dossier scan'),
                requestScope: operation.requestScope,
            });
            let currentLineage = chatLineage(getContext().chat || []);
            if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan')
                || !scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey
                || lineageMoved(scanLineage, currentLineage, messageId) || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
                const scanFinishedAt = performance.now?.() ?? Date.now();
                rt.lastScanMetrics = {
                    label: scanLabel,
                    durationMs: Math.max(0, Math.round(scanFinishedAt - scanStartedAt)),
                    promptChars: prompt.length,
                    responseChars: String(raw ?? '').length,
                    retried: Boolean(retried),
                    relationshipPass: false,
                    relationshipTargets: 0,
                    relationshipResponseChars: 0,
                    relationshipRetried: false,
                    relationshipEdges: relationshipEdgeCount,
                    relationshipEdgeFallbacks,
                    profileUpdates: profileUpdateCount,
                    profileApplied: 0,
                    profileEvidenceAdded: 0,
                    stale: true,
                    at: Date.now(),
                };
                console.info('[NPC State Delta] discarded stale dossier scan after chat or dossier state changed.');
                if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
                return false;
            }

            if (capture) narrationCaptureStats.used += 1;
            // (1.2.11) A scan of one reply tags its evidence with that reply, so a habit seen again in a
            // later reply counts as a second sighting (a manual or full-window scan reads many replies).
            const singleReply = !manual && !fullWindowScan && Number.isInteger(messageId);
            const resolvedParsed = resolveInterimIdentityPromotions(singleReply ? tagScanEvidence(parsed, skippedWindow?.readThrough ?? messageId) : parsed, state.npcs, state.candidates);
            if (capture) capCaptureAdmissions(resolvedParsed, state.npcs);
            profileUpdateCount = Array.isArray(resolvedParsed.profileUpdates) ? resolvedParsed.profileUpdates.length : (Array.isArray(resolvedParsed.profile_updates) ? resolvedParsed.profile_updates.length : 0);
            // Relationship-edge extraction is a separate channel from ordinary NPC delta admission.
            // Add a deterministic fallback for explicit binary statements so a missed lifecycle field
            // cannot silently discard facts such as "Elena is Marris's older sister".
            const explicitRelationshipEdges = extractExplicitKeyRelationshipEdges(transcript, state.npcs, currentExclusions());
            const modelEdges = Array.isArray(resolvedParsed.keyRelationshipEdges) ? resolvedParsed.keyRelationshipEdges : [];
            relationshipEdgeFallbacks = explicitRelationshipEdges.length;
            relationshipEdgeCount = modelEdges.length + explicitRelationshipEdges.length;
            if (explicitRelationshipEdges.length) resolvedParsed.keyRelationshipEdges = [...modelEdges, ...explicitRelationshipEdges];
            // Any scan that reads rolling history must scrub numeric relationship output from the
            // broad dossier scanner. Relationship movement is evaluated separately against the
            // current exchange only, so manual/full scans cannot replay older relationship events.
            // A catch-up window reads each reply once, so its relationship changes apply once (evidence is checked against the
            // window's own text); only current presence, mood and location are not taken from earlier replies.
            if (earlierOnly) stripLiveSceneFields(resolvedParsed);
            const fullWindowRelationship = (manual || fullWindowScan)
                ? prepareFullWindowRelationshipPayload(resolvedParsed, state.npcs)
                : { evaluation: resolvedParsed, mergeSafe: resolvedParsed };
            // (user decision 5) Hosted, a one-pass block's own rows are the reply's relationship decision.
            const relationshipPass = capture && hostedMeters() ? { decisions: new Map(), used: false, responseChars: 0, retried: false, targetCount: 0 } : await runFocusedRelationshipPass(
                ctx,
                fullWindowRelationship.evaluation,
                state.npcs,
                skippedWindow ? transcript : (currentTranscript || transcript),
                settings,
                {
                    currentExchangeOnly: manual || fullWindowScan,
                    requestScope: operation.requestScope,
                    prose: skippedWindow ? skippedWindow.prose : currentProse,
                    window: Boolean(skippedWindow),
                    // (1.2.12) Only a one-pass block speaks for its relationships this way.
                    ...(capture ? { covered: parsed?.relationshipsCovered === true, review: Array.isArray(parsed?.relationshipReview) ? parsed.relationshipReview : [] } : {}),
                },
            );
            const scanFinishedAt = performance.now?.() ?? Date.now();
            rt.lastScanMetrics = {
                label: scanLabel,
                durationMs: Math.max(0, Math.round(scanFinishedAt - scanStartedAt)),
                promptChars: prompt.length,
                responseChars: String(raw ?? '').length,
                retried: Boolean(retried),
                relationshipPass: relationshipPass.used,
                relationshipTargets: relationshipPass.targetCount,
                relationshipResponseChars: relationshipPass.responseChars,
                relationshipRetried: relationshipPass.retried,
                newNpcRelationshipTargets: 0,
                newNpcRelationshipResponseChars: 0,
                relationshipEdges: relationshipEdgeCount,
                relationshipEdgeFallbacks,
                profileUpdates: profileUpdateCount,
                profileApplied: 0,
                profileEvidenceAdded: 0,
                at: Date.now(),
            };
            currentLineage = chatLineage(getContext().chat || []);
            if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan relationship evaluation')
                || !scanOperationCurrent(scanChatKey, operation) || getChatKey() !== scanChatKey
                || lineageMoved(scanLineage, currentLineage, messageId) || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
                console.info('[NPC State Delta] discarded stale dossier scan after chat, dossier, or canonical state changed during relationship evaluation.');
                if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
                return false;
            }
            const targetMessageId = Number.isInteger(messageId) ? messageId : latestMessageId(true);
            const compactWorldStateTurn = hasCompactMeguminWorldState(ctx.chat?.[targetMessageId]?.mes || '');
            const parsedForMerge = suppressPrimaryRelationshipForFocusedDecisions(fullWindowRelationship.mergeSafe, relationshipPass.decisions, () => getChatState().npcs);
            // If the registry is already full, free truly stale slots before admission so a new
            // current NPC is not rejected just because a long-gone dossier still occupies the cap.
            const preCleanup = applyStaleLifecycleAfterScan(state, parsedForMerge, currentTranscript || transcript, settings, { onlyWhenAtCap: true });
            const mergeBaseState = structuredClone(preCleanup.state);
            for (const npc of mergeBaseState.npcs || []) {
                npc.present = false;
                if (!compactWorldStateTurn) npc.worldActive = false;
            }
            const merged = mergeScanResult(mergeBaseState, parsedForMerge, {
                maxNpcs: settings.maxNpcs,
                excludeNames: [...currentExclusions(), ...(state.dismissed || [])],
                turn: state.turn,
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
                preserveWorldActive: compactWorldStateTurn,
                developmentContext: transcript,
                userDevelopmentContext,
                // Key people who are away keep their stable profile and custom fields through the automatic scan (src/key-people.js);
                // the reader's own "Scan now" is deliberate and writes them.
                ...(manual ? {} : keyAwayScanOptions(mergeBaseState)),
            });
            if (earlierOnly) {
                // Presence is the latest scene's: an earlier-only window leaves each person as last confirmed.
                const before = new Map((state.npcs || []).map(npc => [npc.id, npc]));
                for (const npc of merged.state.npcs || []) {
                    const prev = before.get(npc.id);
                    npc.present = Boolean(prev?.present) && !npc.archived;
                    npc.worldActive = Boolean(prev?.worldActive) && !npc.present && !npc.archived;
                }
            }
            const newlyAdmittedIds = [...new Set([...(merged.report?.created || []), ...(merged.report?.promoted || [])])];
            let newNpcRelationshipPass = { decisions: new Map(), used: false, targetCount: 0, responseChars: 0, retried: false };
            // (user decision 5) Hosted, a new NPC starts at the base meter values: no evaluator request.
            if (fullWindowScan && newlyAdmittedIds.length && !hostedMeters()) {
                const newTargets = merged.state.npcs.filter(npc => newlyAdmittedIds.includes(npc.id) && !npc.archived);
                if (newTargets.length) {
                    const combinedDecisions = new Map();
                    let combinedTargetCount = 0;
                    let combinedResponseChars = 0;
                    let combinedRetried = false;
                    for (let offset = 0; offset < newTargets.length; offset += 4) {
                        const batch = newTargets.slice(offset, offset + 4);
                        const result = await runFocusedRelationshipPass(
                            ctx,
                            fullWindowRelationship.evaluation,
                            batch,
                            currentTranscript || transcript,
                            settings,
                            { currentExchangeOnly: true, requestScope: operation.requestScope, prose: currentProse },
                        );
                        for (const [id, decision] of result.decisions || []) combinedDecisions.set(id, decision);
                        combinedTargetCount += Number(result.targetCount || 0);
                        combinedResponseChars += Number(result.responseChars || 0);
                        combinedRetried ||= Boolean(result.retried);
                    }
                    newNpcRelationshipPass = {
                        decisions: combinedDecisions,
                        used: combinedTargetCount > 0,
                        targetCount: combinedTargetCount,
                        responseChars: combinedResponseChars,
                        retried: combinedRetried,
                    };
                    applyFocusedRelationshipDecisions(merged.state, combinedDecisions, settings.relationshipCaps, targetMessageId, merged.report);
                    if (rt.lastScanMetrics) {
                        rt.lastScanMetrics.newNpcRelationshipTargets = combinedTargetCount;
                        rt.lastScanMetrics.newNpcRelationshipResponseChars = combinedResponseChars;
                    }
                }
            }
            currentLineage = chatLineage(getContext().chat || []);
            if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan new-NPC relationship evaluation')
                || !scanOperationCurrent(scanChatKey, operation)
                || getChatKey() !== scanChatKey
                || lineageMoved(scanLineage, currentLineage, messageId)
                || Number(stateVersions.get(scanChatKey) || 0) !== scanStateVersion) {
                console.info('[NPC State Delta] discarded stale dossier scan after new-NPC relationship evaluation.');
                if (manual) globalThis.toastr?.info?.('NPC State Delta: chat changed during scan; stale result was discarded.');
                return false;
            }
            if (rt.lastScanMetrics) {
                rt.lastScanMetrics.profileApplied = Number(merged.report?.profileUpdateStats?.applied || 0);
                rt.lastScanMetrics.profileEvidenceAdded = Number(merged.report?.profileUpdateStats?.evidenceAdded || 0);
                rt.lastScanMetrics.profileDevelopment = Array.isArray(merged.report?.profileDevelopment) ? structuredClone(merged.report.profileDevelopment) : [];
                console.info('[NPC State Delta] dossier scan metrics', rt.lastScanMetrics);
            }
            applyFocusedRelationshipDecisions(merged.state, relationshipPass.decisions, settings.relationshipCaps, targetMessageId, merged.report);
            const postCleanup = applyStaleLifecycleAfterScan(merged.state, parsedForMerge, currentTranscript || transcript, settings);
            const staleArchived = [...preCleanup.archived, ...postCleanup.archived]
                .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
            const stalePruned = [...preCleanup.removed, ...postCleanup.removed]
                .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
            merged.state = postCleanup.state;
            merged.report.staleArchived = staleArchived;
            merged.report.stalePruned = stalePruned;
            if (rt.lastScanMetrics) {
                rt.lastScanMetrics.staleArchived = staleArchived.length;
                rt.lastScanMetrics.stalePruned = stalePruned.length;
            }
            recordScanDiagnostics(scanChatKey, rt.lastScanMetrics || {}, parsedForMerge, merged.report, {
                sourceMessageId: targetMessageId,
                targeted: false,
            });
            const chatKey = scanChatKey;
            // The newest reply this scan read: the chat's latest, or, in a catch-up, the newest of the oldest waiting ones.
            const scanTarget = Number.isInteger(skippedWindow?.readThrough) ? skippedWindow.readThrough : (Number.isInteger(messageId) ? messageId : ((ctx.chat || []).length - 1));
            // (1.10.0) The marker passes only replies that were all read: a manual scan, a Refresh or a narration capture that read the latest
            // reply while older ones still wait leaves the marker behind them and remembers what it read, so the next window reads the waiting
            // replies and skips exactly those (each reply read once).
            const currentReplyId = activeReplyIds().filter(id => id <= (Number.isInteger(messageId) ? messageId : (ctx.chat || []).length - 1)).at(-1);
            const readIds = skippedWindow
                ? skippedWindow.readIds
                : ((manual || fullWindowScan) ? recentReplyIds(settings.scanDepth) : (Number.isInteger(currentReplyId) ? [currentReplyId] : []));
            const settled = settleScan({
                marker: state.lastScannedMessageId, readAhead: state.readAhead, readIds, target: scanTarget, replyIds: activeReplyIds(), fresh: newChatAtStart,
            });
            const nextState = {
                ...merged.state,
                // The replies the marker was held back for count toward the next safety scan (Scan every); nothing is waiting otherwise.
                assistantSinceScan: settled.deferred ? settled.waiting : 0,
                lastScanAt: Date.now(),
                lastScannedMessageId: settled.marker,
                readAhead: settled.readAhead,
                scanCount: Number(state.scanCount || 0) + 1,
            };
            if (skippedWindow && !skippedWindow.latest) catchUpChats.add(scanChatKey); else catchUpChats.delete(scanChatKey);
            if (!manual) {
                // If the broad scanner omitted an NPC explicitly involved anywhere in the current
                // exchange, schedule a silent targeted continuity repair so memories/profile changes
                // get the same second chance as relationship scoring.
                const touchedIds = new Set(newlyAdmittedIds);
                const markBroadScanTarget = raw => {
                    const id = String(raw?.id || '').trim();
                    if (id && nextState.npcs.some(npc => npc.id === id)) {
                        touchedIds.add(id);
                        return;
                    }
                    const name = String(raw?.name || '').trim();
                    if (!name) return;
                    const matched = nextState.npcs.find(npc => npcMatchesLabel(npc, name));
                    if (matched) touchedIds.add(matched.id);
                };
                for (const raw of Array.isArray(resolvedParsed?.npcs) ? resolvedParsed.npcs : []) markBroadScanTarget(raw);
                for (const raw of Array.isArray(resolvedParsed?.profileUpdates) ? resolvedParsed.profileUpdates : []) markBroadScanTarget(raw);
                const missedParticipants = [];
                for (const npc of nextState.npcs || []) {
                    if (npc.archived || touchedIds.has(npc.id) || !npcParticipatesInExchange(npc, nextState.npcs || [], currentTranscript || '', { includeRole: false })) continue;
                    missedParticipants.push(npc);
                }
                if (missedParticipants.length <= AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT) {
                    for (const npc of missedParticipants) {
                        queueNpcBackfillInState(nextState, npc.id, npc.name, targetMessageId, {
                            reason: 'missed-participant',
                            preserveLiveState: true,
                            silent: true,
                        });
                    }
                } else {
                    console.warn('[NPC State Delta] suppressed automatic per-NPC continuity fan-out after broad scan omitted multiple apparent participants.', {
                        omittedParticipants: missedParticipants.length,
                        limit: AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT,
                    });
                }

                // Newly admitted dossiers may need richer recent-history enrichment than the broad
                // first pass provides. Repair only those new/promoted dossiers; admitting one NPC must
                // never fan out into targeted model calls for unrelated established cast members.
                for (const id of newlyAdmittedIds) {
                    const admitted = nextState.npcs.find(npc => npc.id === id && !npc.archived);
                    if (!admitted) continue;
                    queueNpcBackfillInState(nextState, admitted.id, admitted.name, targetMessageId, {
                        reason: 'new-admission',
                        preserveLiveState: true,
                        silent: true,
                    });
                }
            }
            // (v2 hidden notes) The layered notes for the dossiers this scan built.
            if (hostedNotes && settings.layeredSecrets !== false) attachGeneratedSecrets(nextState, newlyAdmittedIds, parsedForMerge, resolvedParsed, parsed);
            const inlineIds = scanInlineNpcIds(resolvedParsed, merged);
            if (targetMessageId >= 0) {
                clearInlineCardsAtMessage(nextState, targetMessageId);
                if (inlineIds.length) recordInlineCardsInState(nextState, targetMessageId, inlineIds, 'scan');
            }
            if (!await scanCanonicalBaseCurrent(scanChatKey, operation, 'dossier scan final commit')) {
                if (manual) globalThis.toastr?.info?.('NPC State Delta: another session updated this chat during the scan; the stale result was discarded.');
                return false;
            }
            if (targetMessageId >= 0) commitBranchCheckpoint(nextState, targetMessageId, 'scan');
            setChatState(chatKey, nextState);
            forwardRelationshipChangesToHost(state.npcs, nextState.npcs, targetMessageId, operation.chatHead);
            if (eventWatch.length) forwardSecretEventsToHost(eventWatch, resolvedParsed?.secretEvents ?? parsed?.secretEvents, operation.chatHead);
            persist();
            renderDossier();
            updateInjection();
            if (capture) catchUpIds = noteCaptureCatchUp(scanChatKey, inlineIds);
            if (manual) {
                const { created, updated, candidates, promoted, skipped, staleArchived = [], stalePruned = [] } = merged.report;
                globalThis.toastr?.success?.(`NPC State Delta scan complete: ${created.length} new, ${updated.length} updated${promoted.length ? `, ${promoted.length} promoted` : ''}${candidates.length ? `, ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} held` : ''}${staleArchived.length ? `, ${staleArchived.length} stale archived` : ''}${stalePruned.length ? `, ${stalePruned.length} stale deleted` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}.`);
            } else if ((merged.report.staleArchived || []).length || (merged.report.stalePruned || []).length) {
                const archivedCount = (merged.report.staleArchived || []).length;
                const removed = merged.report.stalePruned || [];
                const names = removed.slice(0, 3).map(item => item.name).join(', ');
                const extra = removed.length > 3 ? ` +${removed.length - 3} more` : '';
                const parts = [];
                if (archivedCount) parts.push(`${archivedCount} stale archived`);
                if (removed.length) parts.push(`${removed.length} stale deleted${names ? ` (${names}${extra})` : ''}`);
                globalThis.toastr?.info?.(`NPC State Delta: ${parts.join(', ')}. Deleted stale NPCs can be rediscovered if they return.`);
            }
            return true;
        } catch (error) {
            noteScanFailure('dossier scan', error, scanChatKey);
            if (manual || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) globalThis.toastr?.error?.(`NPC State Delta scan failed: ${error?.message || error}`);
            return false;
        } finally {
            endScanOperation(scanChatKey, operation);
            if (getChatKey() === scanChatKey) setScanIndicator(isScanBusy(scanChatKey));
            updateInjection();
            if (getChatKey() === scanChatKey) void drainPendingAutoScan(scanChatKey);
            if (catchUpIds.length) void runCaptureCatchUp(scanChatKey, catchUpIds);
        }
    }

    async function handleAssistantMessageReceivedInner(messageId, { bypassSwipeGuard = false, forceBranchRescan = false } = {}) {
        const settings = getSettings();
        if (!settings.enabled) return;
        const eventChatKey = getChatKey();
        if (eventChatKey === 'no-chat' || !Number.isInteger(messageId) || messageId < 0) return;
        const eventMessage = getContext().chat?.[messageId];
        if (!eventMessage || eventMessage.is_user || eventMessage.is_system || !String(eventMessage.mes || '').trim()) return;
        let eventSourceKey = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
        const eventParent = replyParentKey(messageId);
        // (1.2.9) The same reply rewritten in place by another extension keeps its receipt.
        const sourceStillHere = () => {
            if (getChatKey() !== eventChatKey) return false;
            const now = lineageCheckpointKey(chatLineage(getContext().chat || []), messageId);
            if (now === eventSourceKey) return true;
            if (!sameReplyRewritten(eventChatKey, messageId, eventParent)) return false;
            eventSourceKey = now;
            return true;
        };
        try { await ensureChatStateLoaded(eventChatKey); }
        catch (error) {
            console.error('[NPC State Delta] assistant event deferred because chat hydration failed.', error);
            globalThis.toastr?.error?.('NPC State Delta could not load this chat dossier. Existing sidecar data was preserved; retry after the server is available.');
            return;
        }
        if (!sourceStillHere()) return;

        // SillyTavern 1.18 emits MESSAGE_SWIPED before starting Generate('swipe'). Some
        // backends then emit MESSAGE_RECEIVED while swipeState is still SWIPING. Never run
        // dossier generation in that window; settlement will replay this message safely.
        if (!bypassSwipeGuard && isHostSwipeActive()) {
            if (Number.isInteger(messageId)) rt.deferredSwipeMessageId = messageId;
            queueSettledSwipeReconcile({
                explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                rescan: true,
                reason: 'message-swiped-received',
            });
            return;
        }

        const state = getChatState();
        migrateLegacyLineage(state, getContext().chat || []);
        const receipts = assistantReceipts.get(eventChatKey) || new Set();
        if (!forceBranchRescan && (receipts.has(eventSourceKey)
            || (replyScanned(state, messageId) && eventSourceKey === lineageCheckpointKey(state.lineage, messageId)))) return;
        // Receipt deduplication is separate from successful scan completion and cadence.
        // Store bounded source keys, never copies of narrative text or dossier state.
        receipts.add(eventSourceKey);
        while (receipts.size > 64) receipts.delete(receipts.values().next().value);
        assistantReceipts.set(eventChatKey, receipts);
        if (Number.isInteger(messageId) && !staleHostActive(eventChatKey)) ensureBranchParentAnchor(state, getContext().chat || [], messageId, 'assistant-parent');
        state.turn = Number(state.turn || 0) + 1;
        // Presence remains last-confirmed until a successful scanner observation replaces it.
        // A skipped, busy, failed, or timed-out scan must not make every NPC disappear.
        state.assistantSinceScan = Number(state.assistantSinceScan || 0) + 1;
        const shouldForceBranchScan = forceBranchRescan && settings.branchRescan !== false;
        const autoScanDue = autoScanDueAfterReply({
            autoScan: settings.autoScan,
            full: settings.fullScanEveryTurn,
            sinceScan: state.assistantSinceScan,
            scanEvery: settings.scanEvery,
            everyReply: scanAfterEveryReply(),
            catchUp: settings.autoScan && catchUpChats.has(eventChatKey),
            replyChanges: settings.autoScan && !settings.fullScanEveryTurn && replyNamesSomeone(state, messageId),
        });
        // A complete capture block is a scan already paid for, so it merges whatever Scan every says.
        const captureDue = narrationCaptureEnabled(settings) && narrationCaptures.has(narrationCaptureKey(eventChatKey, messageId));
        const scanExpected = shouldForceBranchScan || autoScanDue || captureDue;
        // Receipt state belongs to this assistant even if scanning fails, skips or is busy.
        // A successful scan coalesces its changes into this same owned boundary.
        commitBranchCheckpoint(state, messageId, 'turn');
        persist();
        renderDossier();
        updateInjection();

        if (scanExpected) {
            if (await scanNow({ manual: false, messageId, allowDuringSwipe: bypassSwipeGuard }) === false) return;
        }
        if (getChatKey() !== eventChatKey || latestMessageId(true) !== messageId || !sourceStillHere()) return;
        scheduleReplyBackfills(eventChatKey, messageId);
    }

    // (lean) The cheap local check before an automatic scan: a quiet reply (no new name, no tracked NPC, no NPC State line) waits
    // for the safety scan every "Scan every" replies. The same text and roster give the same answer when a reply is replayed.
    function replyNamesSomeone(state, messageId) {
        try {
            const ctx = getContext();
            return replyMayChangeDossiers({
                texts: currentExchangeBodies(messageId),
                roster: [...(state?.npcs || []), ...(state?.candidates || [])],
                ignore: [ctx.name1, ctx.name2],
            });
        } catch { return true; }
    }

    return { scanNowInner, handleAssistantMessageReceivedInner };
}
