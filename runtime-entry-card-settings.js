/* NPC State Delta - character-card settings bridge (role: runtime-entry-card-settings). The Story Block card-setting
   definition and its panel-equivalent saves split from index.js. Built by index.js with the Portrait panel bindings. */

export function createCardSettingsPart(deps) {
    const {
        rt, createCardSettingsDefinition, SCAN_EVERY_RANGE, portraitSettingsSnapshot, getSettings,
        savePortraitSettingsDraft, portraitSettingsDraftFromUi, writePortraitSettingsDraftToUi,
        updatePortraitSettingsSaveUi, persistSettings,
    } = deps;

    return function nsdCardSettings() {
        return createCardSettingsDefinition({
            readFormat: () => portraitSettingsSnapshot(getSettings()).portraitPromptFormat,
            // An unsaved draft in the Portrait panel is the reader's: only the format is saved, then the draft goes back into the
            // panel with the card's format in it, still marked unsaved.
            saveFormat: async format => {
                if (!rt.portraitSettingsDirty) return savePortraitSettingsDraft({ portraitPromptFormat: format });
                const draft = portraitSettingsDraftFromUi();
                const saved = await savePortraitSettingsDraft({ portraitPromptFormat: format });
                if (saved) {
                    writePortraitSettingsDraftToUi({ ...draft, portraitPromptFormat: format });
                    rt.portraitSettingsDirty = true;
                    updatePortraitSettingsSaveUi();
                }
                return saved;
            },
            readScanEvery: () => getSettings().scanEvery,
            saveScanEvery: value => {
                const next = Math.max(SCAN_EVERY_RANGE.min, Math.min(SCAN_EVERY_RANGE.max, Math.round(Number(value)) || 2));
                getSettings().scanEvery = next;
                $('#npc_state_delta_scan_every').val(next);
                persistSettings();
                return true;
            },
        });
    };
}
