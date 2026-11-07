/* NPC State Delta - SillyTavern event registration (role: runtime-entry-events). The one-time event listeners for
   generation, reply capture, branch reconciliation, chat lifecycle and deletion split from index.js. Built by
   index.js with the shared runtime state and controller functions, preserving listener order and the one-time guard. */

export function createEventRegistration(rt, deps) {
    const {
        getContext, extension_prompt_types, extension_prompt_roles, migrateLegacyLineage, chatLineage,
        setScanIndicator, narrationCaptureEnabled, syncScannerProfileControl, getChatKey, ensureChatStateLoaded,
        chatHydrationStatus, getChatState, staleHostActive, generationReady, updateInjection,
        noteNarrationCaptureVersion, GENERATION_FRESHNESS_REUSE_MS, NARRATION_CAPTURE_TYPES, CAPTURE_RULES_TYPES,
        disarmNarrationCapture, CAPTURE_RULES_KEY, CAPTURE_PROMPT_KEY, CAPTURE_PROMPT_DEPTH,
        holdCaptureRules, keepCaptureRules, receiveNarrationBlock, handleAssistantMessageReceived,
        renderCapturedReply, queueInlineRender, dropNarrationCaptures, queueBranchReconcile,
        endTargetedRewriteTolerance, stripSwipedNarrationBlock, queueSettledSwipeReconcile,
        flushPendingSettingsSave, castPortraitMisses, cancelScanOperation, closePortraitGenerator,
        closeNpcEditor, staleHostChats, retiredInSessionChats, openingHostChats, isCanonicalChatKey,
        maybeInheritKnownBranch, seedBranchTracking, persist, isScanBusy, renderDossier,
        ensureInlineObserver, drainPendingAutoScan, castPortraitDue, castSync, evictDormantChatStates,
        runBoundedLifecycleEvent, removeDeletedChatState, moveRenamedChatState, chatStateCache,
    } = deps;
    let lifecycleEventSequence = 0;

    return function registerEvents() {
        if (rt.eventsRegistered) return;
        const ctx = getContext();
        const events = ctx.eventTypes || ctx.event_types || {};
        const source = ctx.eventSource;
        if (!source?.on) return;
        rt.eventsRegistered = true;
        for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
            if (events[name]) source.on(events[name], syncScannerProfileControl);
        }

        if (events.MESSAGE_SENT) {
            source.on(events.MESSAGE_SENT, async (messageId) => {
                rt.replacingReply = null;
                const key = getChatKey();
                if (key === 'no-chat') return;
                // SillyTavern waits for this listener before generating. The freshness read must stay: a
                // newer dossier from another session has to be adopted (and an older local history
                // recognised) before this turn is certified or its prompt is built. It is a revalidating
                // read, so an unchanged sidecar costs a 304 rather than a full download. The generation
                // that sends this message already revalidated moments ago (GENERATION_AFTER_COMMANDS
                // runs first), so one read per send is enough.
                const recentlyChecked = rt.generationFreshness.key === key && Date.now() - rt.generationFreshness.at < GENERATION_FRESHNESS_REUSE_MS
                    && chatHydrationStatus(key) === 'ready';
                rt.generationFreshness = { key: '', at: 0 };
                if (!recentlyChecked) {
                    try { await ensureChatStateLoaded(key); } catch (error) { console.error('[NPC State Delta] user-turn lineage update skipped because chat hydration failed.', error); return; }
                }
                if (getChatKey() !== key) return;
                // This listener maintains branch lineage and refreshes the injection so an off-screen NPC
                // the player names reaches this generation; text never dispatches mutations.
                const sentState = getChatState();
                migrateLegacyLineage(sentState, getContext().chat || []);
                // A turn typed on a chat that is behind the adopted dossier must not replace its lineage.
                if (!staleHostActive(key)) sentState.lineage = chatLineage(getContext().chat || []);
                if (!await generationReady(key)) return;
                updateInjection();
                noteNarrationCaptureVersion(key);
            });
        }
        // Regenerate/swipe/continue answer an existing player turn without MESSAGE_SENT.
        if (events.GENERATION_AFTER_COMMANDS) {
            source.on(events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
                const key = getChatKey();
                if (dryRun || key === 'no-chat') return;
                // The capture block is asked for only in fresh replies and continues; quiet, impersonate,
                // swipe and regenerate generations never carry the instruction.
                const captureType = NARRATION_CAPTURE_TYPES.has(String(type ?? '')) && narrationCaptureEnabled();
                rt.captureRulesWithheld = !CAPTURE_RULES_TYPES.has(String(type ?? ''));
                if (type === 'quiet') {
                    rt.sentCaptureRules = '';
                    disarmNarrationCapture();
                    // Another extension's background request never carries the capture rules. Nothing else
                    // of the injection is rebuilt for it.
                    if (rt.lastInjection.captureRules || rt.lastInjection.captureContext) {
                        getContext().setExtensionPrompt?.(CAPTURE_RULES_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
                        getContext().setExtensionPrompt?.(CAPTURE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, CAPTURE_PROMPT_DEPTH, false, extension_prompt_roles.SYSTEM);
                        rt.lastInjection = { ...rt.lastInjection, captureChars: 0, captureRules: '', captureContext: '' };
                    }
                    return;
                }
                rt.narrationCaptureArmed = '';
                {
                    const chat = getContext().chat || [];
                    const last = chat[chat.length - 1];
                    rt.replacingReply = (type === 'swipe' || type === 'regenerate') && last && !last.is_user && !last.is_system ? { key, message: last } : null;
                }
                // Every roleplay generation revalidates the canonical dossier (a 304 when unchanged)
                // before its prompt is built: regenerate/swipe/continue, an empty Send, impersonate and
                // group member turns have no MESSAGE_SENT, and an ordinary send reuses this read there.
                try {
                    await ensureChatStateLoaded(key);
                    rt.generationFreshness = { key, at: Date.now() };
                } catch (error) { console.warn('[NPC State Delta] pre-generation freshness check failed; the injection keeps the last verified dossier.', error); }
                if (getChatKey() !== key) return;
                // (timeline) The prompt is built from the selected head: the barrier is down and the gate has been asked.
                if (!await generationReady(key)) return;
                rt.narrationCaptureArmed = captureType ? key : '';
                updateInjection();
                // Armed only when the instruction actually went out (hydration may have withheld it).
                if (!rt.lastInjection.captureContext) rt.narrationCaptureArmed = '';
                if (rt.lastInjection.captureRules) holdCaptureRules();
                else rt.sentCaptureRules = '';
                noteNarrationCaptureVersion(key);
                rt.narrationCaptureWatch = rt.narrationCaptureArmed ? structuredClone(rt.lastInjection.captureEventWatch || []) : [];
            });
        }
        if (events.GENERATION_STOPPED) source.on(events.GENERATION_STOPPED, () => { rt.sentCaptureRules = ''; rt.replacingReply = null; disarmNarrationCapture(); });
        if (events.CHAT_COMPLETION_PROMPT_READY) source.on(events.CHAT_COMPLETION_PROMPT_READY, eventData => keepCaptureRules(eventData));

        if (events.MESSAGE_RECEIVED) {
            // The capture block leaves the reply before any other listener (TTS, full cast, other
            // extensions) or lineage key reads it.
            const stripCapture = messageId => { rt.sentCaptureRules = ''; rt.replacingReply = null; return receiveNarrationBlock(messageId); };
            if (typeof source.makeFirst === 'function') source.makeFirst(events.MESSAGE_RECEIVED, stripCapture);
            else source.on(events.MESSAGE_RECEIVED, stripCapture);
            source.on(events.MESSAGE_RECEIVED, async (messageId) => {
                await handleAssistantMessageReceived(messageId);
            });
        }
        if (events.CHARACTER_MESSAGE_RENDERED) source.on(events.CHARACTER_MESSAGE_RENDERED, messageId => { renderCapturedReply(messageId); queueInlineRender(0); });
        if (events.MESSAGE_UPDATED) source.on(events.MESSAGE_UPDATED, () => queueInlineRender(30));
        if (events.MORE_MESSAGES_LOADED) source.on(events.MORE_MESSAGES_LOADED, () => queueInlineRender(30));
        if (events.CHAT_LOADED) source.on(events.CHAT_LOADED, async () => {
            const key = getChatKey();
            if (key === 'no-chat') return;
            try {
                await ensureChatStateLoaded(key);
                if (getChatKey() !== key) return;
                renderDossier(); ensureInlineObserver(); queueInlineRender(0);
            } catch (error) {
                if (getChatKey() === key) { renderDossier(); updateInjection(); }
                console.error('[NPC State Delta] post-load hydration/render failed; durable data was not overwritten.', error);
            }
        });

        if (events.MESSAGE_DELETED) {
            source.on(events.MESSAGE_DELETED, (messageId) => {
                dropNarrationCaptures();
                queueBranchReconcile({
                    explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                    operation: 'delete',
                    rescan: true,
                    reason: 'message-deleted',
                }, 70);
            });
        }
        if (events.MESSAGE_SWIPED) {
            if (typeof source.makeFirst === 'function') source.makeFirst(events.MESSAGE_SWIPED, stripSwipedNarrationBlock);
            else source.on(events.MESSAGE_SWIPED, stripSwipedNarrationBlock);
            source.on(events.MESSAGE_SWIPED, (messageId) => {
                endTargetedRewriteTolerance(messageId);
                queueSettledSwipeReconcile({
                    explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                    operation: 'swipe',
                    rescan: true,
                    reason: 'message-swiped',
                });
            });
        }
        if (events.MESSAGE_SWIPE_DELETED) {
            source.on(events.MESSAGE_SWIPE_DELETED, (messageId) => {
                dropNarrationCaptures();
                queueSettledSwipeReconcile({
                    explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                    operation: 'swipe',
                    rescan: true,
                    reason: 'swipe-deleted',
                });
            });
        }
        if (events.MESSAGE_EDITED) {
            source.on(events.MESSAGE_EDITED, (messageId) => {
                endTargetedRewriteTolerance(messageId);
                dropNarrationCaptures();
                queueBranchReconcile({
                    explicitDivergence: Number.isInteger(messageId) ? messageId : null,
                    operation: 'edit',
                    rescan: true,
                    reason: 'message-edited',
                }, 110);
            });
        }

        if (events.CHAT_CHANGED) {
            source.on(events.CHAT_CHANGED, async () => {
                flushPendingSettingsSave();
                rt.replacingReply = null;
                castPortraitMisses.clear();
                rt.narrationCaptureArmed = '';
                rt.sentCaptureRules = '';
                for (const cachedKey of chatStateCache.keys()) cancelScanOperation(cachedKey, 'chat changed');
                if (rt.branchReconcileTimer) clearTimeout(rt.branchReconcileTimer);
                rt.branchReconcileTimer = null;
                rt.branchReconcilePending = null;
                if (rt.swipeSettlementTimer) clearTimeout(rt.swipeSettlementTimer);
                rt.swipeSettlementTimer = null;
                rt.swipeSettlementPending = null;
                rt.deferredSwipeMessageId = null;
                rt.swipeSettlementSequence += 1;
                closePortraitGenerator();
                closeNpcEditor();
                let key = getChatKey();
                staleHostChats.delete(key);
                retiredInSessionChats.delete(key);
                openingHostChats.add(key);
                try {
                    if (isCanonicalChatKey(key)) await ensureChatStateLoaded(key);
                    if (getChatKey() !== key) return;
                    const inherited = isCanonicalChatKey(key) ? await maybeInheritKnownBranch() : false;
                    if (getChatKey() !== key) return;
                    const state = key === 'no-chat' ? null : getChatState(key);
                    if (state) seedBranchTracking(state);
                    if (inherited) persist();
                    setScanIndicator(key !== 'no-chat' && isScanBusy(key));
                    renderDossier();
                    ensureInlineObserver();
                    queueInlineRender(30);
                    updateInjection();
                    if (!inherited && state?.lineage?.length) queueBranchReconcile({ chatKey: key, rescan: false, reason: 'chat-changed' }, 80);
                    if (key !== 'no-chat') void drainPendingAutoScan(key);
                    // A cast dossier made while its picture was missing gets it now if Story Block has it (no new chat needed).
                    if (key !== 'no-chat' && castPortraitDue()) castSync().catch(error => console.debug('[NPC State Delta] cast portraits were not filled', error));
                    evictDormantChatStates(key);
                } catch (error) {
                    if (getChatKey() === key) { renderDossier(); updateInjection(); }
                    console.error('[NPC State Delta] chat change hydration failed; durable state was preserved.', error);
                } finally {
                    openingHostChats.delete(key);
                }
            });
        }

        // CHAT_DELETED carries only a filename in SillyTavern. Never borrow the currently active
        // owner as proof: bulk deletion can target a different character. Ambiguous equal filenames
        // fail closed and CHARACTER_DELETED later retires the exact owner-qualified states.
        if (events.CHAT_DELETED) source.on(events.CHAT_DELETED, (chatId) => {
            const eventId = ++lifecycleEventSequence;
            return runBoundedLifecycleEvent(
                `delete:chat:${String(chatId || '')}:${eventId}`,
                'chat deletion retirement',
                () => removeDeletedChatState(chatId, 'chat', ''),
            );
        });
        if (events.GROUP_CHAT_DELETED) source.on(events.GROUP_CHAT_DELETED, (chatId) => {
            const eventId = ++lifecycleEventSequence;
            return runBoundedLifecycleEvent(
                `delete:group:${String(chatId || '')}:${eventId}`,
                'group chat deletion retirement',
                () => removeDeletedChatState(chatId, 'group', ''),
            );
        });
        if (events.CHAT_RENAMED) source.on(events.CHAT_RENAMED, (eventData) => {
            const data = eventData || {};
            const owner = String(data.groupId || data.avatarId || '');
            const eventId = ++lifecycleEventSequence;
            return runBoundedLifecycleEvent(
                `rename:${owner}:${String(data.oldFileName || '')}->${String(data.newFileName || '')}:${eventId}`,
                'chat rename',
                () => moveRenamedChatState(data),
            );
        });
    };
}
