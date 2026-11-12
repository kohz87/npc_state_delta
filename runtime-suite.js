/* NPC State Delta Story Suite connection (role: story-suite-connect). The API object Story Suite calls (SUITE_API),
   the announcement, the Enable and Source of truth actions, the "What's sent" fold and connectStorySuite. Built by
   index.js once per module instance with the shared runtime state and the controller functions it calls, so each
   instance keeps its own connection flags. Bodies are moved from index.js without change. */

import { extension_settings } from '../../../extensions.js';
import { recentTranscript } from './src/transcript.js';
import { NPC_STATE_VERSION, buildNarrationCapturePrompt, setExternalCalendarSource } from './core.js';
import { storySuite } from './suite.js';
import { SUITE_AREAS, SUITE_SHOWS, NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS, announceNpcStateDelta, areaOwner, buildManageApi, buildNpcProfiles, ensureSuiteStylesheet, replyTokenEstimate, resolveDossierTarget, externalCalendar, normalizeSourceOfTruth, statsOverlapWarning, suiteManageAvailable } from './suite-handshake.js';
import { EXTENSION_NAME, persistSettings, getSettings, effectiveCustomFieldNames } from './runtime-settings.js';

export function createSuitePart(rt, deps) {
    const { chatHydrationStatus, effectivePresentCastChoice, getChatKey, getChatState, hostedNotePromptOptions, liveInjectionText, narrationCaptureEnabled, openLauncherDossier, queueInlineRender, renderDossier, scannerPromptOptions, scenePresenceView, startInlineWatchdog, UI_ID, updateInjection } = deps;

    // Story Suite (docs/STORY_SUITE.md): Delta announces itself (with `enabled: false` while switched
    // off, so Story Suite's overlay can switch it back on) and asks who owns the scene, calendar and
    // stats. Alone it owns all four areas, so nothing below changes Delta.
    const SUITE_API = Object.freeze({
        /** The current chat's tracked NPCs (copies; empty until the chat's dossiers load). */
        npcs: () => {
            const key = getChatKey();
            if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return [];
            return scenePresenceView(getChatState(key).npcs || []).map(npc => ({
                id: String(npc?.id || ''),
                name: String(npc?.name || ''),
                aliases: [...(npc?.aliases || [])],
                present: Boolean(npc?.present && !npc?.archived),
                archived: Boolean(npc?.archived),
            }));
        },
        /** The tracked, non-archived, not-deceased NPCs' { id, name, aliases, present, role, summary } (frozen copies; empty until the chat's dossiers load). */
        npcProfiles: () => {
            try {
                const key = getChatKey();
                if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return Object.freeze([]);
                return buildNpcProfiles(scenePresenceView(getChatState(key).npcs || []), { customFieldNames: effectiveCustomFieldNames() });
            } catch (error) {
                console.warn('[NPC State Delta] Story Suite NPC profiles failed', error);
                return Object.freeze([]);
            }
        },
        /** Open Delta's dossier view on one NPC (id, or name/alias fallback), as the launcher and present cast do; false when archived, unknown or not opened. */
        openDossier: value => {
            try {
                const key = getChatKey();
                if (key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return false;
                const id = resolveDossierTarget(getChatState(key).npcs, value);
                return id ? openLauncherDossier(id) === true : false;
            } catch (error) {
                console.warn('[NPC State Delta] Story Suite openDossier failed', error);
                return false;
            }
        },
        /** For Story Suite's overlay: the same actions as Delta's own Source of truth selects and Enable checkbox. */
        manage: buildManageApi({
            sources: () => getSettings().sourceOfTruth,
            setSource: (area, choice) => applySourceOfTruth(area, choice),
            enabled: () => getSettings().enabled !== false,
            setEnabled: on => applyEnabled(on),
            tokens: () => nextReplyTokens(),
            preview: () => nextReplyTexts(),
        }),
    });
    let suiteConnected = false;
    let suiteRefreshQueued = false;

    // What Delta adds to the next ordinary reply, estimated at about four characters a token: the
    // live dossier injection and, with one-pass capture on, its instruction (input) and the block the
    // model is asked to write back (output). Scans and other quiet requests are not counted.
    // (1.2.13) The texts the next ordinary reply gets, for tokens() and preview(): { injection, capture }.
    function nextReplyTexts() {
        const settings = getSettings();
        const key = getChatKey();
        if (settings.enabled === false || key === 'no-chat' || chatHydrationStatus(key) !== 'ready') return { injection: '', capture: '' };
        const state = getChatState(key);
        const transcript = recentTranscript(4);
        const injection = settings.inject ? liveInjectionText(state, settings, { transcript }) : '';
        const capture = narrationCaptureEnabled(settings)
            ? buildNarrationCapturePrompt(scannerPromptOptions(state, settings, transcript, { dossierAbove: injection, ...hostedNotePromptOptions(state, settings) }))
            : '';
        return { injection, capture };
    }

    function nextReplyTokens() {
        const { injection, capture } = nextReplyTexts();
        if (!injection && !capture) return replyTokenEstimate();
        return replyTokenEstimate({
            injection,
            captureChars: capture.length,
            captureOutputChars: capture ? (rt.lastCaptureBlockChars || NARRATION_CAPTURE_OUTPUT_ESTIMATE_CHARS) : 0,
        });
    }

    // (1.2.13) The "What's sent" fold: each part the next ordinary reply gets, with its size, as text.
    function renderWhatsSent() {
        const root = globalThis.document?.querySelector?.('[data-delta-whats-sent]');
        if (!root) return;
        const { parts } = SUITE_API.manage.preview();
        root.replaceChildren();
        if (!parts.length) {
            const empty = document.createElement('small');
            empty.className = 'delta-whats-sent-empty';
            empty.textContent = 'Nothing is sent with the next reply (no present NPC, or injection and one-pass capture are off).';
            root.append(empty);
            return;
        }
        for (const part of parts) {
            const head = document.createElement('div');
            head.className = 'delta-whats-sent-head';
            head.textContent = `${part.label} · about ${part.tokens} tokens`;
            const body = document.createElement('pre');
            body.className = 'delta-whats-sent-text';
            body.textContent = part.text;
            root.append(head, body);
        }
    }

    function announceToSuite() {
        announceNpcStateDelta({ enabled: getSettings().enabled !== false, version: NPC_STATE_VERSION, api: SUITE_API, settings: `#${UI_ID}`, shows: SUITE_SHOWS });
    }

    // What the Enable checkbox does after saving; Story Suite's setEnabled does the same.
    function afterEnabledChange() {
        announceToSuite();
        updateInjection();
        renderDossier();
        // The in-chat cast leaves with Delta and comes back with it.
        try { globalThis.NPCStateDelta?.renderInline?.(); } catch { /* the cards follow at the next render */ }
        // (1.2.15) The enabled-changed event: Story Suite's own follow-ups listen for it.
        if (typeof CustomEvent === 'function') globalThis.document?.dispatchEvent?.(new CustomEvent('npc-state-delta:enabled-changed', { detail: { enabled: getSettings().enabled !== false } }));
    }

    function applyEnabled(on) {
        const settings = getSettings();
        const next = Boolean(on);
        $('#npc_state_delta_enabled').prop('checked', next);
        if ((settings.enabled !== false) === next) return;
        settings.enabled = next;
        persistSettings();
        afterEnabledChange();
    }

    // What a Source of truth select does; Story Suite's setSource does the same.
    function applySourceOfTruth(area, choice) {
        const settings = getSettings();
        settings.sourceOfTruth = normalizeSourceOfTruth({ ...settings.sourceOfTruth, [area]: choice });
        persistSettings();
        syncSuiteControls();
        updateInjection();
    }

    function syncSuiteControls() {
        const choices = normalizeSourceOfTruth(extension_settings[EXTENSION_NAME]?.sourceOfTruth);
        for (const area of SUITE_AREAS) {
            $(`#npc_state_delta_source_${area}`).val(choices[area]);
            const owner = areaOwner(area, choices);
            $(`[data-delta-source-status="${area}"]`).text(owner ? `Now: ${owner.name}` : 'Now: this extension');
        }
        const warning = statsOverlapWarning(extension_settings[EXTENSION_NAME]?.customFieldNames || [], choices);
        $('#npc_state_delta_custom_fields_stats_warning').text(warning).prop('hidden', !warning);
        $('#npc_state_delta_suite_manage').prop('hidden', !suiteManageAvailable());
    }

    function connectStorySuite() {
        if (suiteConnected) return;
        suiteConnected = true;
        ensureSuiteStylesheet();
        // Read straight from the settings object: the calendar is consulted per NPC projection.
        setExternalCalendarSource(() => externalCalendar(extension_settings[EXTENSION_NAME]?.sourceOfTruth));
        announceToSuite();
        try {
            storySuite().onChange(() => {
                if (suiteRefreshQueued) return;
                suiteRefreshQueued = true;
                queueMicrotask(() => {
                    suiteRefreshQueued = false;
                    syncSuiteControls();
                    updateInjection();
                });
            });
        } catch (error) {
            console.warn('[NPC State Delta] Story Suite is unavailable', error);
        }
        // Story Suite v2: when Delta registers with a Story Block v2 host, or that host goes away, the v1
        // announcement and the "Open Story Suite" button follow (suite-handshake.js, storyBlockIsV2), and
        // so do the in-chat cast's "Only in Story Block" default and the settings shown for it.
        globalThis.document?.addEventListener?.('npc-state-delta:v2-host', () => {
            announceToSuite();
            syncSuiteControls();
            try { $('#npc_state_delta_present_cast_display').val(effectivePresentCastChoice()); } catch { /* settings not mounted */ }
            startInlineWatchdog();
            queueInlineRender(0);
        });
    }

    return { SUITE_API, renderWhatsSent, afterEnabledChange, applySourceOfTruth, syncSuiteControls, connectStorySuite };
}
