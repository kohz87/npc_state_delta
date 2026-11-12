/* NPC State Delta reply scan (role: reply-scan). The scan itself (one-pass capture or the scanner request, merge, stale
   lifecycle, backfill queue, checkpoint) and the capture catch-up; its backfill, stale, reply identity and assistant-handler
   parts are split beside this file, and this factory keeps the public scan part. Built by index.js once per module instance. */
import { chatContext as getContext } from './runtime-scan-helpers.js';
import { isScannerRoutingError } from './scanner-routing.js';
import { readAheadOf, replyScanned, settleScan, storyTextsForAdmission } from './scan-context.js';
import { recentTranscript, recentUserDevelopmentContext, currentExchangeUserDevelopmentContext, currentExchangeTranscript, skippedExchangesWindow, recentReplyIds, activeReplyIds, activeChat, currentExchangeProse, storyDayAt, tieDayAt, currentExclusions, refreshMessageGate } from './src/transcript.js';
import { FULL_SCAN_RESPONSE_LENGTH, SCAN_RESPONSE_LENGTH, generateParsedNpcJson } from './src/scanner-request.js';
import { applyFocusedRelationshipDecisions, runFocusedRelationshipPass, suppressPrimaryRelationshipForFocusedDecisions } from './src/relationship-pass.js';
import { prepareFullWindowRelationshipPayload, buildScannerPrompt, mergeScanResult, tagScanEvidence, resolveInterimIdentityPromotions, hasCompactMeguminWorldState, extractExplicitKeyRelationshipEdges } from './core.js';
import { chatLineage, fingerprintMessage, lineageCheckpointKey } from './branch.js';
import { getSettings, effectiveCustomFieldNames } from './runtime-settings.js';
import { clockNow, lineageMoved, notify, replayScope, setScanIndicator, latestMessageId } from './runtime-scan-helpers.js';
import { createCatchUpPart } from './runtime-catchup.js';
import { capCaptureAdmissions, queueScanFollowUps } from './runtime-scan-backfill.js';
import { applyStaleLifecycleAfterScan } from './runtime-scan-stale.js';
import { createScanReplyPart } from './runtime-scan-reply.js';
import { createAssistantHandlerPart } from './runtime-scan-handler.js';
import { normalizeAllowance } from './src/relationship-pacing.js';
import { rememberCastAdmissions, seedCastAdmission } from './runtime-cast-sync.js';
import { dossierFor, metWithEntry } from './src/cast-dossier.js';
import { normalizeSourceOfTruth } from './suite-handshake.js';
import { captureJournalEntry, recordAcceptedCapture } from './runtime-narration.js';
export function createScanPart(rt, deps) {
    const { attachGeneratedSecrets, beginScanOperation, castList, clearInlineCardsAtMessage, commitBranchCheckpoint, drainPendingAutoScan, endScanOperation, ensureChatStateLoaded, forwardRelationshipChangesToHost, forwardSecretEventsToHost, getChatKey, getChatState, hostedMeters, hostedNotePromptOptions, hostedOnePass, hostedScanState, isHostSwipeActive, isScanBusy, keyAwayScanOptions, partyLevelList, keyKeepIds, hostedReadsFailed, narrationCaptureKey, narrationCaptureStats, noteScanFailure, persist, prepareCanonicalScanBase, processPendingBackfills, queuePendingAutoScan, recordInlineCardsInState, recordScanDiagnostics, refreshNpcFromChat, renderDossier, scanCanonicalBaseCurrent, scanInlineNpcIds, scannerPromptOptions, scanOperationCurrent, scanScenePresent, scenePresentAt, setChatState, storySuiteV2Meters, takeNarrationCapture, updateInjection } = deps;
    // Events per story day while Delta works alone (the pass counts them on the dossier). The day is Story Director's clock, which
    // there is not without a host: no day, no limit (relationship-pacing.js). Hosted, the slice counts them when the change is forwarded
    // and Delta's numbers are set from the slice afterwards (runtime-hosted.js), so the pass does not count (null).
    const scanPace = settings => (hostedMeters() ? null : { allowance: normalizeAllowance(settings.relationshipAllowance), day: null });
    const { narrationCaptures, stateVersions } = rt;
    // (live run 4) A scan cancelled because the saved state moved on under it (Delta's own native-change publication advances the sidecar revision) is asked for
    // again once per reply and chat, like one whose state version moved; a cancel by the reader or a chat change is not (reasons: runtime-scan-ops cancelScanOperation).
    const rerunOnce = new Set();
    const { noteCaptureCatchUp, runCaptureCatchUp } = createCatchUpPart(rt, { getChatKey, getChatState, hostedOnePass, isHostSwipeActive, isScanBusy, persist, processPendingBackfills, refreshNpcFromChat });
    const { replyParentKey, sameReplyRewritten, stripLiveSceneFields, chatNeverScanned } = createScanReplyPart({ getChatKey });
    const { handleAssistantMessageReceivedInner } = createAssistantHandlerPart(rt, deps, { replyParentKey, sameReplyRewritten, scanInner: options => scanNowInner(options) });
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
        // (ONEPASSCAPR2-8) A deferred full scan must not reread a reply an automatic scan already covered.
        const scanned = getChatState(scanChatKey);
        if (!manual && settings.fullScanEveryTurn && Number.isInteger(messageId) && replyScanned(scanned, messageId)
            && lineageCheckpointKey(scanned.lineage, messageId) === lineageCheckpointKey(chatLineage(ctx.chat || []), messageId)) return true;
        if (!replayScope()) await refreshMessageGate();   // the host's fade flags are for the whole chat, not a replay's prefix
        if (sourceMoved()) return false;
        if (isScanBusy(scanChatKey)) {
            if (manual) globalThis.toastr?.info?.('NPC State Delta: another dossier scan is already running in this chat.');
            else if (Number.isInteger(messageId) && !replayScope()) queuePendingAutoScan(scanChatKey, messageId, 'busy-auto-scan');
            return false;
        }
        if (!await prepareCanonicalScanBase(scanChatKey, manual ? 'manual dossier scan' : 'automatic dossier scan')) return false;
        if (sourceMoved()) return false;
        const scanLineage = chatLineage(ctx.chat || []);
        let currentTranscript = currentExchangeTranscript(messageId);
        const currentProse = currentExchangeProse(messageId);
        const savedCapture = replayScope() && !manual ? captureJournalEntry(replayScope(), ctx.chat || [], messageId) : null;
        const fullWindowScan = Boolean(!savedCapture && !manual && settings.fullScanEveryTurn);
        // (lean) A scan reads every exchange since the last scan, not only this reply: the replies the local check skipped
        // are in it, up to 30 messages. More waiting than that: the oldest are read first and the next reply scans at once
        // (catch-up). Nothing skipped: the current exchange alone.
        const skippedWindow = !manual && !fullWindowScan && Number.isInteger(messageId) && !savedCapture && !(!replayScope() && narrationCaptures.has(narrationCaptureKey(scanChatKey, messageId)))
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
        const capture = savedCapture ? { parsed: structuredClone(savedCapture.parsed), watch: savedCapture.watch, raw: '' }
            : (!replayScope() && !manual && !fullWindowScan && Number.isInteger(messageId) ? takeNarrationCapture(scanChatKey, messageId) : null);
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
        let replayRefreshIds = [];
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
            const preCleanup = applyStaleLifecycleAfterScan(state, parsedForMerge, currentTranscript || transcript, settings, { onlyWhenAtCap: true, keepIds: keyKeepIds(state), noDelete: hostedReadsFailed(), now: clockNow() });
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
                tieDay: tieDayAt(targetMessageId),
                customFieldNames: effectiveCustomFieldNames(settings),
                relationshipBaseline: settings.relationshipBaseline,
                relationshipCaps: settings.relationshipCaps,
                autoArchiveDeaths: settings.autoArchiveDeaths !== false,
                autoReactivateArchived: settings.autoReactivateArchived !== false,
                admissionMode: settings.admissionMode,
                storyTexts: storyTextsForAdmission(activeChat(getContext().chat || []), targetMessageId),
                preserveWorldActive: compactWorldStateTurn,
                developmentContext: transcript,
                userDevelopmentContext,
                // Key people who are away keep their stable profile and custom fields through the automatic scan (src/key-people.js);
                // the reader's own "Scan now" is deliberate and writes them.
                ...(manual ? {} : keyAwayScanOptions(mergeBaseState)),
                partyLevels: partyLevelList(),
                historicalRead: Boolean(replayScope() && !savedCapture),
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
                    applyFocusedRelationshipDecisions(merged.state, combinedDecisions, settings.relationshipCaps, targetMessageId, merged.report, scanPace(settings));
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
            applyFocusedRelationshipDecisions(merged.state, relationshipPass.decisions, settings.relationshipCaps, targetMessageId, merged.report, scanPace(settings));
            const postCleanup = applyStaleLifecycleAfterScan(merged.state, parsedForMerge, currentTranscript || transcript, settings, { keepIds: keyKeepIds(merged.state), noDelete: hostedReadsFailed(), now: clockNow() });
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
                lastScanAt: clockNow(),
                lastScannedMessageId: settled.marker,
                readAhead: settled.readAhead,
                scanCount: Number(state.scanCount || 0) + 1,
            };
            if (capture && !replayScope()) recordAcceptedCapture(nextState, ctx.chat || [], targetMessageId, capture);
            const catchUpChats = replayScope()?.catchUp ?? rt.catchUpChats;
            if (skippedWindow && !skippedWindow.latest) catchUpChats.add(scanChatKey); else catchUpChats.delete(scanChatKey);
            if (!manual) queueScanFollowUps(nextState, { newlyAdmittedIds, resolvedParsed, targetMessageId, currentTranscript });
            // (v2 hidden notes) The layered notes for the dossiers this scan built.
            if (hostedNotes && settings.layeredSecrets !== false) attachGeneratedSecrets(nextState, newlyAdmittedIds, parsedForMerge, resolvedParsed, parsed);
            if (hostedNotes && newlyAdmittedIds.length) {
                rememberCastAdmissions(nextState, newlyAdmittedIds, targetMessageId, currentLineage);
                const people = metWithEntry(castList?.());
                const names = storySuiteV2Meters?.()?.packNames?.() ?? {};
                for (const npc of nextState.npcs.filter(item => newlyAdmittedIds.includes(item.id))) {
                    const matches = people.filter(person => dossierFor([npc], person));
                    if (matches.length !== 1 || nextState.npcs.filter(other => dossierFor([other], matches[0])).length !== 1) continue;
                    const person = matches[0];
                    const seeded = seedCastAdmission(nextState, npc, person, { packName: names[person.pack] ?? '', calendarOwn: normalizeSourceOfTruth(settings.sourceOfTruth).calendar === 'mine' });
                    if (seeded) nextState.npcs = nextState.npcs.map(item => item.id === npc.id ? seeded : item);
                }
            }
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
            forwardRelationshipChangesToHost(state.npcs, nextState.npcs, targetMessageId, operation.chatHead, resolvedParsed?.profileUpdates, resolvedParsed?.npcs, Boolean(capture));
            if (eventWatch.length) forwardSecretEventsToHost(eventWatch, resolvedParsed?.secretEvents ?? parsed?.secretEvents, operation.chatHead);
            persist();
            renderDossier();
            updateInjection();
            if (capture && replayScope()) replayRefreshIds = Object.keys(savedCapture.refreshes || {});
            else if (capture) catchUpIds = noteCaptureCatchUp(scanChatKey, inlineIds);
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
                notify('info', `NPC State Delta: ${parts.join(', ')}. Deleted stale NPCs can be rediscovered if they return.`);
            }
            return true;
        } catch (error) {
            noteScanFailure('dossier scan', error, scanChatKey);
            // Thrown away because the state moved on under it (an edit during a scan the reply no longer waits for), not cancelled by the
            // reader or a chat change: asked for again, and the drain below runs it. Only while nothing was appended after this reply: a Send
            // or the next reply means that reply's own scan reads the window, and re-asking would be one more paid call than before.
            if (!manual && !replayScope() && (!operation?.cancelled || (operation.cancelReason === 'server revision advanced' && !rerunOnce.has(`${scanChatKey}|${messageId}`) && rerunOnce.add(`${scanChatKey}|${messageId}`))) && Number.isInteger(messageId) && latestMessageId() === messageId && isScannerRoutingError(error) && error.code === 'NPC_SCANNER_ROUTE_CANCELLED') queuePendingAutoScan(scanChatKey, messageId, 'stale-auto-scan');
            if (replayScope()) replayScope().failed = `The scan failed: ${error?.message || error}`;
            if (manual || (isScannerRoutingError(error) && error.code !== 'NPC_SCANNER_ROUTE_CANCELLED')) notify('error', `NPC State Delta scan failed: ${error?.message || error}`);
            return false;
        } finally {
            endScanOperation(scanChatKey, operation);
            if (getChatKey() === scanChatKey) setScanIndicator(isScanBusy(scanChatKey));
            updateInjection();
            if (getChatKey() === scanChatKey && !replayScope()) void drainPendingAutoScan(scanChatKey);
            if (catchUpIds.length) void runCaptureCatchUp(scanChatKey, catchUpIds);
            for (const id of replayRefreshIds) await refreshNpcFromChat(id, { automatic: true, fillLooks: false }); // (ONEPASSCAPR2-1) replay accepted catch-up work in order
        }
    }

    return { scanNowInner, handleAssistantMessageReceivedInner };
}
