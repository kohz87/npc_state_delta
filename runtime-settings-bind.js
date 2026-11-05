/* NPC State Delta settings panel bindings (role: settings-panel-bind). bindUi and the control binders, attaching the
   panel to the extensions drawer and its mount retries. Built by index.js once per module instance with the shared
   runtime state and the controller functions it calls, so each instance keeps its own retry timer. Bodies are moved from
   index.js without change. */

import { getContext } from '../../../extensions.js';
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DEFAULT_RELATIONSHIP_CRITERIA, DEFAULT_IMPACT_CRITERIA, DEFAULT_MEMORY_CRITERIA, DEFAULT_BEHAVIOR_CRITERIA, normalizeRelationshipBaseline, normalizeRelationshipCaps, normalizeNpcAdmissionMode, DEFAULT_PORTRAIT_STYLE_POSITIVE, DEFAULT_PORTRAIT_STYLE_NEGATIVE, DEFAULT_PORTRAIT_COMPOSITION, normalizeCustomFieldNames } from './core.js';
import { chatLineage } from './branch.js';
import { openSuiteOverlay } from './suite-handshake.js';
import { PORTRAIT_THEME_PRESETS, PORTRAIT_CUSTOM_PRESET_LIMIT, portraitCustomPreset, portraitCustomPresetLibrary, portraitCustomPresetFor, nextPortraitCustomPresetId, portraitCustomPresetNameTaken, uniquePortraitCustomPresetName, persistSettings, getSettings, normalizePresentCastDisplay } from './runtime-settings.js';

export function createSettingsBindPart(rt, deps) {
    const { addNpcManually, afterEnabledChange, applyLauncherFlag, applySourceOfTruth, bindSettingsGroupMemory, buildSettingsHtml, closePortraitGenerator, confirmDiscardPortraitDraft, deleteNpcById, detachBrokenSidecar, ensureFreshMutationBoundary, freshChatState, generatePortraitFromDialog, getChatKey, getChatState, hostedOnePass, latestMessageId, markPortraitSettingsDirty, openNpcEditorSafely, persistCritical, persistPortraitCustomPresetLibrary, portraitFileFailed, portraitSettingsDraftFromUi, portraitSettingsSnapshot, processPendingBackfills, queueInlineRender, refreshNpcFromChat, renderDossier, renderWhatsSent, resetPortraitGeneratorFromDossier, retryCurrentChatHydration, savePortraitSettingsDraft, scanNow, scanNpcDossier, setChatState, setNpcArchiveStateById, startInlineWatchdog, syncSettingsControls, syncSuiteControls, UI_ID, updateInjection, useGeneratedPortrait, writePortraitCustomPresetOptions, writePortraitSettingsDraftToUi } = deps;

    let mountRetryTimer = null;

    let portraitFileListening = false;

    function bindSettingsCheckbox(selector, key, after = null) {
        $(document).on('change.npcStateDelta', selector, function () {
            getSettings()[key] = Boolean(this.checked);
            persistSettings();
            after?.();
        });
    }

    function bindCustomFieldSettings() {
        $(document).on('change.npcStateDelta', '#npc_state_delta_custom_fields', function () {
            const names = normalizeCustomFieldNames(this.value);
            getSettings().customFieldNames = names;
            this.value = names.join(', ');
            persistSettings();
            syncSuiteControls();
            updateInjection();
        });
    }

    function bindSourceOfTruthSettings() {
        $(document).on('change.npcStateDelta', '[data-delta-source-area]', function () {
            applySourceOfTruth(this.dataset.deltaSourceArea, this.value);
        });
        $(document).on('click.npcStateDelta', '[data-delta-open-suite]', event => {
            event?.preventDefault?.();
            openSuiteOverlay();
        });
    }

    function bindSettingsNumber(selector, key, min, max, fallback, after = null) {
        $(document).on('change.npcStateDelta', selector, function () {
            const value = Math.max(min, Math.min(max, Math.round(Number(this.value) || fallback)));
            getSettings()[key] = value;
            this.value = value;
            persistSettings();
            after?.();
        });
    }

    function bindSettingsText(selector, key, after = null) {
        $(document).on('change.npcStateDelta', selector, function () {
            getSettings()[key] = String(this.value || '');
            persistSettings();
            after?.();
        });
    }

    function bindUi() {
        $(document).off('.npcStateDelta');
        bindSettingsCheckbox('#npc_state_delta_enabled', 'enabled', afterEnabledChange);
        bindSettingsCheckbox('#npc_state_delta_auto', 'autoScan');
        $(document).on('change.npcStateDelta', '#npc_state_delta_scanner_connection_profile', function () {
            getSettings().scannerConnectionProfile = String(this.value || '').trim();
            persistSettings();
        });
        bindSettingsCheckbox('#npc_state_delta_full_scan_every_turn', 'fullScanEveryTurn');
        bindSettingsCheckbox('#npc_state_delta_narration_capture', 'narrationCapture');
        bindSettingsCheckbox('#npc_state_delta_narration_capture_compact', 'narrationCaptureCompact');
        bindSettingsCheckbox('#npc_state_delta_inject', 'inject', updateInjection);
        bindSettingsNumber('#npc_state_delta_inject_budget', 'injectBudgetTokens', 512, 6000, 4000, updateInjection);
        bindSettingsNumber('#npc_state_delta_inject_limit', 'injectLimit', 1, 12, 3, updateInjection);
        bindSettingsCheckbox('#npc_state_delta_archive_deaths', 'autoArchiveDeaths');
        bindCustomFieldSettings();
        bindSourceOfTruthSettings();
        bindSettingsCheckbox('#npc_state_delta_reactivate_archived', 'autoReactivateArchived');
        bindSettingsCheckbox('#npc_state_delta_layered_secrets', 'layeredSecrets');
        bindSettingsCheckbox('#npc_state_delta_branch_rescan', 'branchRescan');
        bindSettingsCheckbox('#npc_state_delta_mid_delete_rewind', 'midDeleteRewind');
        $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_theme_preset', function () {
            const settings = getSettings();
            const saved = portraitSettingsSnapshot(settings);
            const key = PORTRAIT_THEME_PRESETS[this.value] ? this.value : 'custom';
            if (rt.portraitSettingsDirty && key !== saved.portraitThemePreset && !confirmDiscardPortraitDraft()) {
                this.value = saved.portraitThemePreset;
                return;
            }
            rt.portraitSettingsDirty = false;
            if (key === 'custom') {
                const custom = portraitCustomPresetFor(settings);
                writePortraitSettingsDraftToUi({
                    ...saved,
                    portraitThemePreset: 'custom',
                    portraitCustomPresetId: custom.id,
                    portraitStylePositive: custom.positive,
                    portraitStyleNegative: custom.negative,
                    portraitComposition: custom.composition,
                    portraitPromptFormat: custom.promptFormat,
                    portraitUseMood: custom.useMood,
                    portraitUseLocation: custom.useLocation,
                });
            } else {
                const preset = PORTRAIT_THEME_PRESETS[key];
                writePortraitSettingsDraftToUi({
                    ...saved,
                    portraitThemePreset: key,
                    portraitStylePositive: preset.positive,
                    portraitStyleNegative: preset.negative,
                });
            }
            markPortraitSettingsDirty();
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_custom_preset', function () {
            const settings = getSettings();
            const saved = portraitSettingsSnapshot(settings);
            const target = saved.portraitCustomPresets.find(item => item.id === String(this.value || ''));
            if (!target) return writePortraitCustomPresetOptions(saved);
            if (rt.portraitSettingsDirty && target.id !== saved.portraitCustomPresetId && !confirmDiscardPortraitDraft()) {
                this.value = saved.portraitCustomPresetId;
                return;
            }
            rt.portraitSettingsDirty = false;
            writePortraitSettingsDraftToUi({
                ...saved,
                portraitThemePreset: 'custom',
                portraitCustomPresetId: target.id,
                portraitStylePositive: target.positive,
                portraitStyleNegative: target.negative,
                portraitComposition: target.composition,
                portraitPromptFormat: target.promptFormat,
                portraitUseMood: target.useMood,
                portraitUseLocation: target.useLocation,
            });
            markPortraitSettingsDirty();
        });
        $(document).on('input.npcStateDelta', '#npc_state_delta_portrait_style_positive, #npc_state_delta_portrait_style_negative, #npc_state_delta_portrait_composition', function () {
            if (this.id === 'npc_state_delta_portrait_style_positive' || this.id === 'npc_state_delta_portrait_style_negative') {
                $('#npc_state_delta_portrait_theme_preset').val('custom');
                $('.npc-state-delta-custom-preset-library').addClass('delta-custom-active');
            }
            markPortraitSettingsDirty();
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_portrait_generation_enabled, #npc_state_delta_portrait_prompt_format, #npc_state_delta_portrait_use_mood, #npc_state_delta_portrait_use_location, #npc_state_delta_portrait_save_gallery', () => {
            markPortraitSettingsDirty();
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_add, #npc_state_delta_portrait_custom_duplicate', async function () {
            if (rt.portraitSettingsSaveBusy) return;
            const settings = getSettings();
            const snapshot = portraitSettingsDraftFromUi();
            const presets = portraitCustomPresetLibrary(settings.portraitCustomPresets);
            if (presets.length >= PORTRAIT_CUSTOM_PRESET_LIMIT) {
                globalThis.toastr?.warning?.(`NPC State Delta: custom portrait preset limit is ${PORTRAIT_CUSTOM_PRESET_LIMIT}.`);
                return;
            }
            const duplicate = this.id.endsWith('_duplicate');
            const selected = presets.find(item => item.id === String($('#npc_state_delta_portrait_custom_preset').val() || ''))
                || portraitCustomPresetFor(settings);
            const base = portraitCustomPreset({
                ...(duplicate ? selected : {}),
                positive: snapshot.portraitStylePositive,
                negative: snapshot.portraitStyleNegative,
                composition: snapshot.portraitComposition,
                promptFormat: snapshot.portraitPromptFormat,
                useMood: snapshot.portraitUseMood,
                useLocation: snapshot.portraitUseLocation,
            });
            const suggestedRoot = duplicate ? `${selected.name} Copy` : `Custom ${presets.length + 1}`;
            const suggested = uniquePortraitCustomPresetName(presets, suggestedRoot);
            const name = String(globalThis.window?.prompt?.('Custom portrait preset name:', suggested) || '').trim().slice(0, 80);
            if (!name) return;
            if (portraitCustomPresetNameTaken(presets, name)) {
                globalThis.toastr?.warning?.(`NPC State Delta: a custom portrait preset named "${name}" already exists.`);
                return;
            }
            const id = nextPortraitCustomPresetId(presets);
            const created = portraitCustomPreset({ ...base, id, name }, presets.length);
            const saved = await persistPortraitCustomPresetLibrary(settings, [...presets, created], id, {
                operational: snapshot,
            });
            if (saved) globalThis.toastr?.success?.(`NPC State Delta: saved custom portrait preset ${created.name}.`);
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_rename', async function () {
            if (rt.portraitSettingsSaveBusy) return;
            let settings = getSettings();
            let snapshot = portraitSettingsSnapshot(settings);
            const id = String($('#npc_state_delta_portrait_custom_preset').val() || snapshot.portraitCustomPresetId);
            let index = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
            if (index < 0) return;
            let current = snapshot.portraitCustomPresets[index];
            const name = String(globalThis.window?.prompt?.('Rename custom portrait preset:', current.name) || '').trim().slice(0, 80);
            if (!name || name === current.name) return;
            if (portraitCustomPresetNameTaken(snapshot.portraitCustomPresets, name, id)) {
                globalThis.toastr?.warning?.(`NPC State Delta: a custom portrait preset named "${name}" already exists.`);
                return;
            }
            if (rt.portraitSettingsDirty && !(await savePortraitSettingsDraft())) return;
            settings = getSettings();
            snapshot = portraitSettingsSnapshot(settings);
            index = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
            if (index < 0) return;
            current = snapshot.portraitCustomPresets[index];
            const presets = structuredClone(snapshot.portraitCustomPresets);
            presets[index] = { ...current, name };
            const saved = await persistPortraitCustomPresetLibrary(settings, presets, id, { theme: snapshot.portraitThemePreset });
            if (saved) globalThis.toastr?.success?.(`NPC State Delta: renamed portrait preset to ${name}.`);
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_portrait_custom_delete', async function () {
            if (rt.portraitSettingsSaveBusy) return;
            const settings = getSettings();
            let snapshot = portraitSettingsSnapshot(settings);
            if (snapshot.portraitCustomPresets.length <= 1) {
                globalThis.toastr?.warning?.('NPC State Delta: keep at least one custom portrait preset.');
                return;
            }
            let id = String($('#npc_state_delta_portrait_custom_preset').val() || snapshot.portraitCustomPresetId);
            let targetIndex = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
            let target = snapshot.portraitCustomPresets[targetIndex];
            if (!target) return;
            if (globalThis.window?.confirm?.(`Delete custom portrait preset "${target.name}"?`) === false) return;
            if (rt.portraitSettingsDirty && !(await savePortraitSettingsDraft())) return;
            snapshot = portraitSettingsSnapshot(getSettings());
            id = String($('#npc_state_delta_portrait_custom_preset').val() || id);
            targetIndex = snapshot.portraitCustomPresets.findIndex(item => item.id === id);
            target = snapshot.portraitCustomPresets[targetIndex];
            if (!target || snapshot.portraitCustomPresets.length <= 1) return;
            const presets = snapshot.portraitCustomPresets.filter(item => item.id !== id);
            const nextIndex = Math.min(Math.max(0, targetIndex), presets.length - 1);
            const nextId = presets[nextIndex].id;
            const saved = await persistPortraitCustomPresetLibrary(getSettings(), presets, nextId, {
                theme: snapshot.portraitThemePreset === 'custom' ? 'custom' : snapshot.portraitThemePreset,
            });
            if (saved) globalThis.toastr?.success?.(`NPC State Delta: deleted custom portrait preset ${target.name}.`);
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_reset_portrait_theme', () => {
            writePortraitSettingsDraftToUi({
                ...portraitSettingsSnapshot(getSettings()),
                portraitGenerationEnabled: true,
                portraitThemePreset: 'fantasy_anime',
                portraitStylePositive: DEFAULT_PORTRAIT_STYLE_POSITIVE,
                portraitStyleNegative: DEFAULT_PORTRAIT_STYLE_NEGATIVE,
                portraitComposition: DEFAULT_PORTRAIT_COMPOSITION,
                portraitPromptFormat: 'hybrid',
                portraitUseMood: true,
                portraitUseLocation: false,
                portraitSaveToGallery: false,
            });
            markPortraitSettingsDirty();
            globalThis.toastr?.info?.('NPC State Delta: Fantasy Anime defaults loaded as an unsaved portrait-settings draft.');
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_save_portrait_settings', () => { void savePortraitSettingsDraft(); });
        bindSettingsCheckbox('#npc_state_delta_launcher_with_story_block', 'launcherWithStoryBlock', applyLauncherFlag);
        bindSettingsCheckbox('#npc_state_delta_launcher_with_story_block_v2', 'launcherWithStoryBlockV2', applyLauncherFlag);
        bindSettingsNumber('#npc_state_delta_scan_every', 'scanEvery', 1, 20, 2);
        bindSettingsNumber('#npc_state_delta_scan_depth', 'scanDepth', 2, 30, 6);
        bindSettingsNumber('#npc_state_delta_narration_capture_catch_up', 'narrationCaptureCatchUp', 0, 50, 8);
        $(document).on('change.npcStateDelta', '#npc_state_delta_present_cast_display', function () {
            getSettings().presentCastDisplay = normalizePresentCastDisplay(this.value); this.value = getSettings().presentCastDisplay;
            getSettings().presentCastDisplayChosen = true;
            persistSettings();
            startInlineWatchdog();
            queueInlineRender(0);
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_admission_mode', function () {
            getSettings().admissionMode = normalizeNpcAdmissionMode(this.value); this.value = getSettings().admissionMode; persistSettings();
        });
        bindSettingsNumber('#npc_state_delta_max', 'maxNpcs', 1, 100, 40);
        bindSettingsCheckbox('#npc_state_delta_auto_prune_stale', 'autoPruneStale');
        $(document).on('change.npcStateDelta', '#npc_state_delta_stale_archive_after', function () {
            const settings = getSettings();
            settings.staleArchiveAfter = Math.max(10, Math.min(999, Math.round(Number(this.value) || 30)));
            if (settings.staleDeleteAfter <= settings.staleArchiveAfter) settings.staleDeleteAfter = Math.min(1000, settings.staleArchiveAfter + 1);
            syncSettingsControls(); persistSettings();
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_stale_delete_after', function () {
            const settings = getSettings();
            settings.staleDeleteAfter = Math.max(settings.staleArchiveAfter + 1, Math.min(1000, Math.round(Number(this.value) || 50)));
            syncSettingsControls(); persistSettings();
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_base_trust, #npc_state_delta_base_affection, #npc_state_delta_base_desire, #npc_state_delta_base_tension', function () {
            const settings = getSettings();
            const key = this.id.replace('npc_state_delta_base_', '');
            settings.relationshipBaseline[key] = Math.max(-100, Math.min(100, Math.round(Number(this.value) || 0)));
            settings.relationshipBaseline = normalizeRelationshipBaseline(settings.relationshipBaseline);
            syncSettingsControls(); persistSettings();
        });
        $(document).on('change.npcStateDelta', '#npc_state_delta_cap_ordinary, #npc_state_delta_cap_meaningful, #npc_state_delta_cap_major, #npc_state_delta_cap_extreme', function () {
            const settings = getSettings();
            const key = this.id.replace('npc_state_delta_cap_', '');
            settings.relationshipCaps[key] = Math.max(0, Math.round(Number(this.value) || 0));
            settings.relationshipCaps = normalizeRelationshipCaps(settings.relationshipCaps);
            syncSettingsControls(); persistSettings();
        });
        bindSettingsText('#npc_state_delta_relationship_criteria', 'relationshipCriteria');
        bindSettingsText('#npc_state_delta_impact_criteria', 'relationshipImpactCriteria');
        bindSettingsText('#npc_state_delta_memory_criteria', 'memoryCriteria');
        bindSettingsText('#npc_state_delta_behavior_criteria', 'behaviorCriteria', updateInjection);
        $(document).on('click.npcStateDelta', '#npc_state_delta_reset_relationship_rules', () => {
            const settings = getSettings();
            settings.relationshipBaseline = { ...DEFAULT_RELATIONSHIP };
            settings.relationshipCaps = { ...DEFAULT_RELATIONSHIP_CAPS };
            settings.relationshipCriteria = DEFAULT_RELATIONSHIP_CRITERIA;
            settings.relationshipImpactCriteria = DEFAULT_IMPACT_CRITERIA;
            syncSettingsControls(); persistSettings();
            globalThis.toastr?.success?.('NPC State Delta: relationship tuning reset to defaults.');
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_reset_memory_rules', () => {
            getSettings().memoryCriteria = DEFAULT_MEMORY_CRITERIA;
            syncSettingsControls(); persistSettings();
            globalThis.toastr?.success?.('NPC State Delta: important memory criteria reset to default.');
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_reset_behavior_rules', () => {
            getSettings().behaviorCriteria = DEFAULT_BEHAVIOR_CRITERIA;
            syncSettingsControls(); persistSettings(); updateInjection();
            globalThis.toastr?.success?.('NPC State Delta: behavior rubric reset to default.');
        });
        $(document).on('click.npcStateDelta', '.npc-state-delta-retry-hydration', () => { void retryCurrentChatHydration(); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-detach-sidecar', () => { void detachBrokenSidecar(); });
        $(document).on('click.npcStateDelta', '#npc_state_delta_scan_now', async () => {
            const scanned = await scanNow({ manual: true, messageId: latestMessageId(true) });
            // (user decision 5) The reader's own Scan also runs the backfill queue hosted one-pass mode holds.
            if (scanned && hostedOnePass()) await processPendingBackfills(latestMessageId(true));
        });
        // (1.2.13) What's sent: filled when opened and on Refresh, never while closed.
        $(document).on('click.npcStateDelta', '#npc_state_delta_sent_refresh', () => renderWhatsSent());
        globalThis.document?.addEventListener?.('toggle', event => {
            if (event.target?.matches?.('[data-delta-settings-group="sent"]') && event.target.open) renderWhatsSent();
        }, true);
        $(document).on('click.npcStateDelta', '#npc_state_delta_add_manual', () => addNpcManually());
        $(document).on('click.npcStateDelta', '.npc-state-delta-roster-edit', function (event) { event.preventDefault?.(); event.stopPropagation?.(); openNpcEditorSafely(this.dataset.npcId); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-scan-dossier', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void scanNpcDossier(String(this.dataset.npcId || '')); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-refresh-chat', function (event) { event.preventDefault?.(); event.stopPropagation?.(); void refreshNpcFromChat(String(this.dataset.npcId || '')); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-reset', function (event) { event.preventDefault?.(); resetPortraitGeneratorFromDossier(); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-run', function (event) { event.preventDefault?.(); void generatePortraitFromDialog(); });
        if (!portraitFileListening) { portraitFileListening = true; document.addEventListener?.('error', portraitFileFailed, true); }
        $(document).on('click.npcStateDelta', '.npc-state-delta-portrait-use', function (event) { event.preventDefault?.(); void useGeneratedPortrait(); });
        $(document).on('click.npcStateDelta', '.npc-state-delta-archive-npc', async function () {
            const key = getChatKey();
            if (!await ensureFreshMutationBoundary('archive a dossier', key)) return;
            setNpcArchiveStateById(this.dataset.npcId, true, { reason: 'manual' });
        });
        $(document).on('click.npcStateDelta', '.npc-state-delta-restore-npc', async function () {
            const key = getChatKey();
            if (!await ensureFreshMutationBoundary('restore a dossier', key)) return;
            setNpcArchiveStateById(this.dataset.npcId, false);
        });
        $(document).on('click.npcStateDelta', '.npc-state-delta-delete-npc', async function () {
            const key = getChatKey();
            if (!await ensureFreshMutationBoundary('delete a dossier', key)) return;
            deleteNpcById(this.dataset.npcId);
        });
        $(document).on('keydown.npcStateDelta', '.npc-state-delta-delete-npc', async function (event) {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault?.();
            const key = getChatKey();
            if (!await ensureFreshMutationBoundary('delete a dossier', key)) return;
            deleteNpcById(this.dataset.npcId);
        });
        $(document).on('click.npcStateDelta', '#npc_state_delta_clear_chat', async () => {
            if (!await ensureFreshMutationBoundary('clear this chat dossier')) return;
            if (!window.confirm('Clear every NPC State Delta dossier for this chat? Portraits and inline dossier cards will also be removed.')) return;
            closePortraitGenerator();
            const previousScanCount = Number(getChatState()?.scanCount || 0);
            const cleared = freshChatState();
            // A cleared chat is never "new" again: a swipe or a fail-closed restore on a short chat must not read the older replies back in.
            cleared.scanCount = Math.max(1, Math.round(previousScanCount) || 0);
            cleared.lineage = chatLineage(getContext().chat || []);
            // Cleared, the chat is caught up: only replies from now on are read, not the whole history again.
            cleared.lastScannedMessageId = latestMessageId(true) >= 0 ? latestMessageId(true) : null;
            cleared.readAhead = [];
            setChatState(getChatKey(), cleared);
            persistCritical(); renderDossier(); updateInjection();
        });
    }

    function attachSettingsPanel() {
        if ($(`#${UI_ID}`).length) return true;
        let host = $('#extensions_settings2');
        if (!host.length) host = $('#extensions_settings');
        if (!host.length) host = $('#extensionsMenu');
        if (!host.length) {
            console.warn('[NPC State Delta] Could not find SillyTavern extensions settings host yet.');
            return false;
        }
        host.append(buildSettingsHtml());
        const panel = document.getElementById?.(UI_ID);
        bindSettingsGroupMemory(panel);
        syncSettingsControls();
        renderDossier();
        panel?.dispatchEvent?.(new CustomEvent('npc-state-delta:settings-mounted', { bubbles: true }));
        return true;
    }

    function scheduleSettingsMountRetries() {
        if (attachSettingsPanel()) return;
        if (mountRetryTimer) clearInterval(mountRetryTimer);
        let attempts = 0;
        mountRetryTimer = setInterval(() => {
            attempts += 1;
            if (attachSettingsPanel() || attempts >= 40) {
                clearInterval(mountRetryTimer);
                mountRetryTimer = null;
                if (attempts >= 40 && !$(`#${UI_ID}`).length) {
                    console.error('[NPC State Delta] Settings panel host never appeared; extension logic is loaded but UI could not mount.');
                }
            }
        }, 250);
    }

    return { bindUi, scheduleSettingsMountRetries };
}
