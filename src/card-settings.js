/*
 * NPC State Delta card settings (Story Block 2.21.0 sdk.registerCardSettings, SDK-CARD-CONTRACT addendum D).
 *
 * A character card may recommend two of Delta's settings: the portrait prompt format and Scan every. Story Block
 * lists the ones that differ from the player's own, and applies the ticked ones with the player's click, by calling
 * `apply` here. Delta persists them exactly as its own controls do (the "Save prompt settings" button, the Scan
 * every box), so a reload keeps them. An older Story Block has no registerCardSettings: nothing is registered.
 */
import { PORTRAIT_PROMPT_FORMATS, normalizePortraitPromptFormat } from '../core-mechanics.js';

export const CARD_SETTINGS_OWNER = 'npc-state-delta';
export const CARD_SETTINGS_LABEL = 'NSD';
export const SCAN_EVERY_RANGE = Object.freeze({ min: 1, max: 20 });

// The names the prompt format has in Delta's own settings select.
const FORMAT_NAMES = Object.freeze({ hybrid: 'Structured hybrid', tags: 'Comma tags', natural: 'Natural' });

/** True only for the exact lowercase value of a format Delta has (no case or spacing variants). */
export function validPortraitPromptFormat(value) {
    return typeof value === 'string' && PORTRAIT_PROMPT_FORMATS.includes(value);
}

export function validScanEvery(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= SCAN_EVERY_RANGE.min && value <= SCAN_EVERY_RANGE.max;
}

/**
 * The definition handed to sdk.registerCardSettings.
 *   readFormat()         the current prompt format
 *   saveFormat(format)   persists it like "Save prompt settings" (resolves true when saved)
 *   readScanEvery()      the current Scan every
 *   saveScanEvery(n)     persists it like the Scan every box
 */
export function createCardSettingsDefinition({ readFormat, saveFormat, readScanEvery, saveScanEvery } = {}) {
    return {
        owner: CARD_SETTINGS_OWNER,
        label: CARD_SETTINGS_LABEL,
        keys: {
            portraitPromptFormat: {
                label: 'NSD portraits',
                valueText: value => FORMAT_NAMES[normalizePortraitPromptFormat(value)],
                valid: validPortraitPromptFormat,
            },
            scanEvery: {
                label: 'NSD scan every',
                valueText: value => `${value} ${Number(value) === 1 ? 'reply' : 'replies'}`,
                valid: validScanEvery,
            },
        },
        read(key) {
            if (key === 'portraitPromptFormat') return normalizePortraitPromptFormat(readFormat?.());
            if (key === 'scanEvery') return readScanEvery?.();
            return undefined;
        },
        async apply(values = {}) {
            const applied = [];
            if (Object.prototype.hasOwnProperty.call(values, 'portraitPromptFormat') && validPortraitPromptFormat(values.portraitPromptFormat)) {
                if (await saveFormat?.(values.portraitPromptFormat) !== false) applied.push('portraitPromptFormat');
            }
            if (Object.prototype.hasOwnProperty.call(values, 'scanEvery') && validScanEvery(values.scanEvery)) {
                if (await saveScanEvery?.(values.scanEvery) !== false) applied.push('scanEvery');
            }
            return { applied };
        },
    };
}
