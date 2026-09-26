/* NPC State Delta scanner-output setting and compact cast-card polish. */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    normalizeScannerMaxOutputTokens,
    SCANNER_MAX_OUTPUT_TOKENS_MAX,
} from './scanner-routing.js';

const EXTENSION_NAME = 'npc_state_delta';
const SETTINGS_ID = 'npc_state_delta_settings';
const CONTROL_ID = 'npc_state_delta_scanner_max_output_tokens';
const STYLE_ID = 'npc_state_delta_scanner_output_ui_styles';
const GUARD = '__npcStateDeltaScannerOutputUi';

function settings() {
    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') {
        extension_settings[EXTENSION_NAME] = {};
    }
    return extension_settings[EXTENSION_NAME];
}

function persistSettings() {
    const ctx = getContext?.();
    if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function settingRow() {
    const row = document.createElement('label');
    row.className = 'npc-state-delta-setting-row delta-scanner-output-row';
    row.htmlFor = CONTROL_ID;
    row.innerHTML = `<span><b>Maximum output tokens</b><small>0 keeps Delta's built-in per-request limits. 128-${SCANNER_MAX_OUTPUT_TOKENS_MAX} sets the maximum output for every NPC scanner text call, including retries and focused passes. It does not change roleplay or image-generation limits.</small></span><span class="delta-setting-number"><input id="${CONTROL_ID}" type="number" min="0" max="${SCANNER_MAX_OUTPUT_TOKENS_MAX}" step="1" inputmode="numeric" class="text_pole npc-state-delta-number"><small>tokens</small></span>`;
    return row;
}

function syncControl(root) {
    const input = root?.querySelector?.(`#${CONTROL_ID}`);
    if (!input || document.activeElement === input) return;
    input.value = String(normalizeScannerMaxOutputTokens(settings().scannerMaxOutputTokens));
}

function mountControl() {
    const root = document.getElementById(SETTINGS_ID);
    const slot = root?.querySelector?.('[data-delta-settings-slot="scanner-output"]');
    if (!slot) return false;
    let input = root.querySelector(`#${CONTROL_ID}`);
    if (!input) {
        const row = settingRow();
        slot.appendChild(row);
        input = row.querySelector(`#${CONTROL_ID}`);
    }
    syncControl(root);
    if (input && !input.dataset.deltaBound) {
        input.dataset.deltaBound = '1';
        input.addEventListener('change', () => {
            const raw = Number(input.value);
            const normalized = raw > 0 ? normalizeScannerMaxOutputTokens(raw) : 0;
            settings().scannerMaxOutputTokens = normalized;
            input.value = String(normalized);
            persistSettings();
            globalThis.toastr?.success?.(normalized
                ? `NPC State Delta: scanner maximum output set to ${normalized} tokens.`
                : 'NPC State Delta: scanner output returned to built-in per-request limits.');
        });
    }
    return true;
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Fixed card targets must fit the actual remaining rail after controls and safe areas. */
#npc_state_delta_dossier_root .delta-cast-card{max-height:100%!important}

/* Give portrait-led cast cards enough vertical room for face + metadata instead of cropping them into tiles. */
#npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 226px!important}
#npc_state_delta_dossier_root .delta-cast-card{flex-basis:132px!important;width:132px!important;min-width:132px!important;height:168px!important}
#npc_state_delta_dossier_root .delta-cast-copy{padding-top:34px!important;padding-bottom:8px!important}

@media(max-width:900px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 236px!important}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:124px!important;width:124px!important;min-width:124px!important;height:160px!important}
}
@media(max-width:620px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 258px!important}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:116px!important;width:116px!important;min-width:116px!important;height:150px!important}
}
`;
    document.head.appendChild(style);
}

function start() {
    if (typeof document === 'undefined') return;
    injectStyles();
    mountControl();
    if (document[GUARD]) return;
    document[GUARD] = true;
    document.addEventListener('npc-state-delta:settings-mounted', mountControl);
    const retryMount = (attempt = 0) => {
        if (!mountControl() && attempt < 40) setTimeout(() => retryMount(attempt + 1), 100);
    };
    retryMount();
    window.addEventListener?.('focus', () => syncControl(document.getElementById(SETTINGS_ID)));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else queueMicrotask(start);
}
