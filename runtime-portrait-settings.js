/* NPC State Delta portrait settings save (role: portrait-settings-save). Saving the portrait settings draft and the custom preset
   library, which refresh the settings panel afterwards, so it is built after the panel's markup part. Built by index.js once
   per module instance with the shared runtime state and the controller functions it calls. Bodies are moved from index.js
   without change. */

import { saveSettings as saveHostSettings } from '../../../../script.js';
import { portraitCustomPresetLibrary, portraitCustomPresetFor, getSettings } from './runtime-settings.js';

export function createPortraitSettingsPart(rt, deps) {
    const { normalizePortraitSettingsDraft, portraitSettingsDraftFromUi, portraitSettingsSnapshot, syncSettingsControls, updatePortraitSettingsSaveUi } = deps;

    async function savePortraitSettingsDraft(explicitDraft = null) {
        if (rt.portraitSettingsSaveBusy) return false;
        const settings = getSettings();
        const before = portraitSettingsSnapshot(settings);
        const next = normalizePortraitSettingsDraft(explicitDraft || portraitSettingsDraftFromUi());
        Object.assign(settings, next);
        rt.portraitSettingsSaveBusy = true;
        updatePortraitSettingsSaveUi();
        try {
            await saveHostSettings();
            rt.portraitSettingsDirty = false;
            rt.portraitSettingsSaveBusy = false;
            syncSettingsControls();
            globalThis.toastr?.success?.(next.portraitThemePreset === 'custom'
                ? `NPC State Delta: saved custom portrait preset ${portraitCustomPresetFor(next).name}.`
                : 'NPC State Delta: portrait settings saved.');
            return true;
        } catch (error) {
            Object.assign(settings, before);
            rt.portraitSettingsSaveBusy = false;
            rt.portraitSettingsDirty = true;
            updatePortraitSettingsSaveUi();
            console.error('[NPC State Delta] portrait settings save failed', error);
            globalThis.toastr?.error?.(`NPC State Delta portrait settings were not saved: ${error?.message || error}`);
            return false;
        }
    }

    async function persistPortraitCustomPresetLibrary(settings, presets, selectedId, { theme = 'custom', operational = null } = {}) {
        if (rt.portraitSettingsSaveBusy) return null;
        const before = {
            portraitGenerationEnabled: settings.portraitGenerationEnabled,
            portraitThemePreset: settings.portraitThemePreset,
            portraitCustomPresetId: settings.portraitCustomPresetId,
            portraitCustomPresets: structuredClone(settings.portraitCustomPresets),
            portraitStylePositive: settings.portraitStylePositive,
            portraitStyleNegative: settings.portraitStyleNegative,
            portraitComposition: settings.portraitComposition,
            portraitPromptFormat: settings.portraitPromptFormat,
            portraitUseMood: settings.portraitUseMood,
            portraitUseLocation: settings.portraitUseLocation,
            portraitSaveToGallery: settings.portraitSaveToGallery,
        };
        const normalized = portraitCustomPresetLibrary(presets, settings);
        const id = normalized.some(item => item.id === selectedId) ? selectedId : normalized[0].id;
        settings.portraitCustomPresets = normalized;
        settings.portraitCustomPresetId = id;
        settings.portraitThemePreset = theme;
        if (theme === 'custom') {
            const active = normalized.find(item => item.id === id) || normalized[0];
            settings.portraitStylePositive = active.positive;
            settings.portraitStyleNegative = active.negative;
            settings.portraitComposition = active.composition;
            settings.portraitPromptFormat = active.promptFormat;
            settings.portraitUseMood = active.useMood;
            settings.portraitUseLocation = active.useLocation;
        }
        if (operational) {
            settings.portraitGenerationEnabled = operational.portraitGenerationEnabled !== false;
            settings.portraitSaveToGallery = operational.portraitSaveToGallery === true;
        }
        rt.portraitSettingsSaveBusy = true;
        updatePortraitSettingsSaveUi();
        try {
            await saveHostSettings();
            rt.portraitSettingsDirty = false;
            rt.portraitSettingsSaveBusy = false;
            syncSettingsControls();
            return portraitSettingsSnapshot(settings);
        } catch (error) {
            Object.assign(settings, before);
            rt.portraitSettingsSaveBusy = false;
            rt.portraitSettingsDirty = true;
            updatePortraitSettingsSaveUi();
            console.error('[NPC State Delta] custom portrait preset save failed', error);
            globalThis.toastr?.error?.(`NPC State Delta custom portrait preset was not saved: ${error?.message || error}`);
            return null;
        }
    }

    return { savePortraitSettingsDraft, persistPortraitCustomPresetLibrary };
}
