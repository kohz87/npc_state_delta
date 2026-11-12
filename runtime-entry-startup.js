/* NPC State Delta - runtime startup (role: runtime-entry-startup). The idempotent init/safeInit functions split from
   index.js. Built by index.js with the controller closure; the DOM-ready and lifecycle registrations stay in index.js.
   The optional adapter import keeps its root-relative ./src/ path and its position in initialization. */

export function createStartup(rt, deps) {
    const {
        getSettings, clearLegacyPromptKeys, connectStorySuite, SUITE_API, UI_ID, NPC_STATE_VERSION,
        latestReplyIndex, castSync, castPortraitDue, normalizeSourceOfTruth, nsdCardSettings, setStoryClockSource, setStoryDateAtSource, setStoryDayAtSource, hostedStoryDateAt, hostedStoryDayAt,
        hostedStoryClock, bindUi, installUiCaptureBridge, registerEvents, startInlineWatchdog,
        flushCurrentChatOnPageHide, refreshCurrentChatFromServer, scheduleSettingsMountRetries, getChatKey,
        isCanonicalChatKey, ensureChatStateLoaded, maybeInheritKnownBranch, seedBranchTracking, getChatState,
        renderDossier, updateInjection, evictDormantChatStates,
    } = deps;

    async function init() {
        if (rt.initialized) {
            scheduleSettingsMountRetries();
            return;
        }
        rt.initialized = true;
        getSettings();
        clearLegacyPromptKeys();
        connectStorySuite();
        // Story Suite v2 (Story Block 2): optional; without a v2 host the adapter does nothing.
        import('./src/storysuite-v2.js').then(v2 => { rt.storySuiteV2 = v2.startStorySuiteV2({ suiteApi: SUITE_API, panelId: UI_ID, version: NPC_STATE_VERSION, headReply: latestReplyIndex, castSync, castPortraitDue, calendarOwn: () => normalizeSourceOfTruth(getSettings().sourceOfTruth).calendar === 'mine', cardSettings: nsdCardSettings() }); }).catch(error => console.debug('[NPC State Delta] Story Suite v2 adapter is not available', error));
        // (v2) Hosted with Story Director, the story's date follows its clock (calendar.js hostedStoryDate)
        // unless the reader keeps the calendar here (Source of truth: calendar "mine"). No host: none.
        setStoryClockSource(hostedStoryClock);
        setStoryDateAtSource(hostedStoryDateAt);
        setStoryDayAtSource(hostedStoryDayAt);
        bindUi();
        installUiCaptureBridge();
        registerEvents();
        startInlineWatchdog();
        globalThis.addEventListener?.('pagehide', flushCurrentChatOnPageHide);
        globalThis.addEventListener?.('pageshow', () => { void refreshCurrentChatFromServer('pageshow'); });
        globalThis.document?.addEventListener?.('visibilitychange', () => {
            if (globalThis.document?.visibilityState === 'hidden') flushCurrentChatOnPageHide();
            else if (globalThis.document?.visibilityState === 'visible') void refreshCurrentChatFromServer('visibility-resume');
        });
        scheduleSettingsMountRetries();

        let key = getChatKey();
        try {
            if (isCanonicalChatKey(key)) {
                await ensureChatStateLoaded(key);
                if (getChatKey() !== key) return;
                await maybeInheritKnownBranch();
                if (getChatKey() !== key) return;
                seedBranchTracking(getChatState(key));
            }
        } catch (error) {
            console.error('[NPC State Delta] startup hydration failed; extension remains mounted in read-only recovery mode.', error);
            if (getChatKey() === key) renderDossier();
        }
        updateInjection();
        evictDormantChatStates(getChatKey());
        console.log(`[NPC State Delta] v${NPC_STATE_VERSION} loaded`);
    }

    async function safeInit() {
        try {
            await init();
        } catch (error) {
            rt.initialized = false;
            console.error('[NPC State Delta] initialization failed', error);
        }
    }

    return { init, safeInit };
}
