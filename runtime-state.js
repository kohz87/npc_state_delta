// Runtime state holder (role: runtime-state-holder). Everything the controller and the parts split out of
// index.js share through the enclosing scope lives here as properties of ONE object, built by
// createRuntimeState(). index.js calls it once per module instance, so a fresh import of index.js (the
// `?t=` re-imports in the tests, a reloaded extension) starts from fresh state exactly as the former
// module-level variables did; nothing in this file is a module singleton. Parts receive the object (or
// the collections taken from it) from index.js; none of them imports it for its own copy.
// This file holds initial values only: no behaviour, no host imports.

export function createRuntimeState() {
    return {
        eventsRegistered: false,
        initialized: false,
        inlineObserver: null,
        inlineObserverChat: null,
        activeEditorPopup: null,
        activeEditorChatKey: '',
        activeEditorBaseRevision: null,
        activePortraitGeneratorOverlay: null,
        activePortraitGeneratorChatKey: '',
        activePortraitGeneratorNpcId: '',
        portraitGenerationBusy: false,
        portraitSettingsDirty: false,
        portraitSettingsSaveBusy: false,
        lastScanMetrics: null,
        branchReconcileTimer: null,
        branchReconcilePending: null,
        swipeSettlementTimer: null,
        swipeSettlementPending: null,
        deferredSwipeMessageId: null,
        swipeSettlementSequence: 0,
        // The size of the last accepted one-pass capture block this session (0 until one arrives).
        lastCaptureBlockChars: 0,
        captureRulesWithheld: false,
        narrationCaptureArmed: '',
        // (v2 hidden notes) The story events the armed reply's instruction asked about, kept until its block arrives.
        narrationCaptureWatch: [],
        storySuiteV2: null,
        // (key people) A swipe or a regenerate replaces the latest reply, and SillyTavern's chat still holds that reply while the new
        // one is being written; the story it continues from is the reply before it. `replacingReply` is set when such a generation
        // starts (with that reply's message) and cleared when the reply arrives, the generation stops, the next message is sent or
        // the chat changes.
        replacingReply: null,
        generationFreshness: { key: '', at: 0 },
        // The text last handed to the host for roleplay generation, with the reason when it is empty, so
        // Diagnostics can show what the roleplay model actually receives. Runtime-only; never persisted.
        lastInjection: { text: '', reason: 'Not built yet in this session.', at: 0, chatKey: '' },
        // (1.2.16) A chat-completion preset whose prompt order has no Main Prompt drops in-prompt extension
        // text, so the capture's rules would vanish while its context still asks for the block. At
        // prompt-ready they go back in, once, after the leading system messages (still early, so still
        // cacheable). Only for the reply's own generation: the rules are held from its arming until the
        // reply arrives or is stopped (sentCaptureRules, '' otherwise), never on a dry run, never in a
        // prompt without the chat's replies (another extension's call), never in Delta's own requests.
        sentCaptureRules: '',
        branchReconciliationEvents: [],
        chatStateCache: new Map(),
        hydratedChatKeys: new Set(),
        hydratedStateMeta: new Map(),
        workingCopyAdoptions: new Map(),
        freshnessChecks: new Map(),
        // Chats whose deterministic sidecar this session looked for and did not find: "no sidecar yet" is
        // an empty dossier. While a Story Block v2 host carries Delta, automatic boundaries (chat events,
        // scan start and commit) trust that miss instead of asking the server again each time
        // (sidecarMissTrusted). The reader's own actions, page resume and the first save still look, and
        // that save never overwrites a file another session created. Without a v2 host nothing changes.
        missingSidecarChats: new Set(),
        // Chats whose branch inheritance (maybeInheritKnownBranch) has decided in this session (inherited, or nothing to inherit).
        branchInheritanceChecked: new Set(),
        freshnessEvents: [],
        loadingChatStates: new Map(),
        hydrationErrors: new Map(),
        pendingAutoScans: new Map(),
        assistantReceipts: new Map(),
        // One-pass narration capture: armed for each roleplay reply, stripped from the stored message on
        // receipt and consumed once by that message's automatic scan in place of the scanner request.
        // Kept in memory only; an edit, reload or broken block falls back to the ordinary scan.
        narrationCaptures: new Map(),
        // Chats whose last scan stopped before the latest reply (more waiting than one window holds): the next reply scans at once.
        catchUpChats: new Set(),
        // (b6-soak-5) Replies whose capture block was removed at MESSAGE_RECEIVED, re-rendered once the host
        // has drawn them (CHARACTER_MESSAGE_RENDERED): at MESSAGE_RECEIVED the reply is not fully drawn.
        captureRerenderPending: new Set(),
        stateWriteTimers: new Map(),
        stateWritePromises: new Map(),
        stateVersions: new Map(),
        persistedVersions: new Map(),
        ownershipEpochs: new Map(),
        chatCacheTouches: new Map(),
        lifecycleEventOperations: new Map(),
        lifecycleRetryTimers: new Map(),
        castPortraitMisses: new Set(),
        // Chats whose canonical sidecar this session watched another session retire. The tombstone makes a
        // later hydration start an empty dossier (intentional reuse of a retired name), but the same open
        // chat must stay blocked: retrying Scan would otherwise revive the retired dossier from the stale
        // host narration. Reopening the chat (CHAT_CHANGED) is the host lifecycle that releases it.
        retiredInSessionChats: new Map(),
        // (timeline participant, src/storysuite-participant/) Every durable write of a chat's state ends in markStateDirty (persist, persistCritical,
        // persistCriticalDurable), whatever made it: a scan, a targeted pass, a branch reconcile, a manual add or delete or edit, an import, the
        // canonical server state, a rename, the v2 meter sync. The participant is told, and publishes the change to the timeline as a native mutation.
        // The participant's own writes (an install, its block) are not changes: they carry a count **per chat**, so one chat's install never hides another's change.
        nativeChangeListeners: new Set(),
        participantWrites: new Map(),
        // Scan **intent**: work that is going to change the dossiers but is not yet (or no longer) in the scan registry. `isScanBusy` is the registry's active set,
        // so it is false for the moment between one scan ending and a queued one beginning (scanNow awaits the server before it begins an operation), and
        // for a reply whose scan is due but not started. A save point taken then would miss what the scan writes a moment later. Counted per chat from the
        // reply arriving (handleAssistantMessageReceived) and from every scan, queued drain, backfill pass and targeted pass until it ends.
        scanIntents: new Map(),
        deferredWork: new Map(),
        // Chats whose local message history is an older prefix of the adopted dossier's history: another
        // session wrote messages this browser has not loaded yet. The mark survives local saves (a metadata
        // save proves nothing about the chat) and clears once the local chat catches up with or diverges
        // from the dossier, or once the host reloads the chat.
        staleHostChats: new Set(),
        // SillyTavern emits CHAT_CHANGED after reading the chat from the server, so the history it opens is
        // current. A dossier it only prefixes lost those messages to a deletion (for example one whose
        // truncation was not saved before a reload), not to a session this browser is behind.
        openingHostChats: new Set(),
        // (beta) A scanner call that came back with no text at all (SillyTavern's "No message generated") is a
        // quiet note, once per chat: nothing was changed and the next reply scans again, so it is not a red
        // console error with a stack on every reply. Every other failure is logged as before.
        emptyAnswerChats: new Set(),
        // Running targeted passes. An explicit edit or swipe of the reply a pass tolerates being rewritten in
        // place ends that tolerance: from then on any change to the history makes the result stale.
        runningTargetedPasses: new Set(),
        captureCatchUp: new Map(),
        portraitActions: new Map(),
    };
}
