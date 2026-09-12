/* NPC State Delta scanner-output setting and compact responsive polish. */
import { extension_settings, getContext } from '../../../extensions.js';
import {
    normalizeScannerMaxOutputTokens,
    SCANNER_MAX_OUTPUT_TOKENS_MAX,
} from './scanner-routing.js';

const EXTENSION_NAME = 'npc_state_delta';
const SETTINGS_ID = 'npc_state_delta_settings';
const CONTROL_ID = 'npc_state_delta_scanner_max_output_tokens';
const FULL_CAST_CONTROL_ID = 'npc_state_delta_full_cast_scan';
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
    row.innerHTML = `<span><b>Maximum output tokens</b><small>0 keeps Delta's built-in per-request limits. A value from 128 to ${SCANNER_MAX_OUTPUT_TOKENS_MAX} becomes the requested maximum output size for NPC scanner text calls, including retries and focused passes. This does not change roleplay or image-generation limits.</small></span><span class="delta-scanner-output-control"><input id="${CONTROL_ID}" type="number" min="0" max="${SCANNER_MAX_OUTPUT_TOKENS_MAX}" step="1" inputmode="numeric" class="text_pole npc-state-delta-number"><small>0 = built-in</small></span>`;
    return row;
}

function scanningGroup(root) {
    return [...(root?.querySelectorAll?.('.delta-settings-group') || [])]
        .find(group => group.querySelector(':scope > summary b')?.textContent?.trim() === 'Scanning') || null;
}

function moveFullCastIntoScanning(root) {
    const row = root?.querySelector?.(`.npc-state-delta-setting-row[for="${FULL_CAST_CONTROL_ID}"]`);
    const body = scanningGroup(root)?.querySelector?.('.delta-settings-group-body');
    if (!row || !body) return false;
    const anchor = body.querySelector('.npc-state-delta-setting-row[for="npc_state_delta_full_scan_every_turn"]');
    if (row.parentElement === body && anchor?.nextElementSibling === row) return true;
    if (anchor) body.insertBefore(row, anchor.nextElementSibling);
    else body.prepend(row);
    return true;
}

function syncControl(root) {
    const input = root?.querySelector?.(`#${CONTROL_ID}`);
    if (!input || document.activeElement === input) return;
    input.value = String(normalizeScannerMaxOutputTokens(settings().scannerMaxOutputTokens));
}

function mountControl() {
    const root = document.getElementById(SETTINGS_ID);
    if (!root) return false;
    moveFullCastIntoScanning(root);
    let input = root.querySelector(`#${CONTROL_ID}`);
    if (!input) {
        const row = settingRow();
        const group = scanningGroup(root);
        const body = group?.querySelector?.('.delta-settings-group-body');
        if (body) {
            const depth = body.querySelector('.npc-state-delta-setting-row[for="npc_state_delta_scan_depth"]');
            if (depth?.nextSibling) body.insertBefore(row, depth.nextSibling);
            else body.appendChild(row);
        } else {
            const grid = root.querySelector('.npc-state-delta-settings-grid');
            if (!grid) return false;
            const depth = grid.querySelector('.npc-state-delta-setting-row[for="npc_state_delta_scan_depth"]');
            if (depth?.nextSibling) grid.insertBefore(row, depth.nextSibling);
            else grid.appendChild(row);
        }
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
/* Keep the long scanner hint and its numeric control in their own bounded columns. */
#${SETTINGS_ID} .delta-scanner-output-row{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(150px,180px)!important;column-gap:12px!important;row-gap:7px!important;align-items:center!important;min-width:0}
#${SETTINGS_ID} .delta-scanner-output-row>span:first-child{display:block;min-width:0;max-width:100%}
#${SETTINGS_ID} .delta-scanner-output-row>span:first-child small{display:block;max-width:100%;white-space:normal;word-break:normal;overflow-wrap:break-word}
#${SETTINGS_ID} .delta-scanner-output-control{display:flex;align-items:center;justify-content:flex-end;gap:6px;width:100%;min-width:0;box-sizing:border-box}
#${SETTINGS_ID} .delta-scanner-output-control input{flex:1 1 auto;width:100%!important;min-width:0;box-sizing:border-box}
#${SETTINGS_ID} .delta-scanner-output-control small{flex:0 0 auto;opacity:.6;white-space:nowrap}

/* Ordinary action rows may wrap, but the maintenance grid owns its own layout. */
#${SETTINGS_ID} .npc-state-delta-actions:not(.delta-settings-maintenance-actions),
#${SETTINGS_ID} .npc-state-delta-tuning-actions{display:flex!important;flex-wrap:wrap!important;align-items:center;gap:7px;min-width:0}
#${SETTINGS_ID} .npc-state-delta-actions:not(.delta-settings-maintenance-actions)>.menu_button,
#${SETTINGS_ID} .npc-state-delta-tuning-actions>.menu_button{flex:1 1 170px;min-width:0;max-width:100%;white-space:normal;word-break:normal;overflow-wrap:break-word;text-align:center;justify-content:center}
#${SETTINGS_ID} .npc-state-delta-tuning-actions>#npc_state_delta_portrait_settings_status{flex:1 0 100%;min-width:0}

/* Data & maintenance is a real grid: buttons stretch to their cells instead of shrinking to min-content letters. */
#${SETTINGS_ID} .delta-settings-maintenance-actions{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
#${SETTINGS_ID} .delta-settings-maintenance-actions>.menu_button{display:flex!important;align-items:center;justify-content:center;width:100%!important;min-width:0!important;max-width:100%!important;min-height:42px;box-sizing:border-box;white-space:normal!important;word-break:normal!important;overflow-wrap:break-word!important;line-height:1.25;text-align:center}

/* Give portrait-led cast cards enough vertical room for face + metadata instead of cropping them into tiles. */
#npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 226px!important}
#npc_state_delta_dossier_root .delta-cast-card{flex-basis:132px!important;width:132px!important;min-width:132px!important;height:168px!important}
#npc_state_delta_dossier_root .delta-cast-copy{padding-top:34px!important;padding-bottom:8px!important}

@media(max-width:900px){
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 236px!important}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:124px!important;width:124px!important;min-width:124px!important;height:160px!important}
}
@media(max-width:760px){
  #${SETTINGS_ID} .delta-scanner-output-row{grid-template-columns:minmax(0,1fr)!important;align-items:start!important}
  #${SETTINGS_ID} .delta-scanner-output-control{width:min(220px,100%);justify-content:flex-start}
}
@media(max-width:620px){
  #${SETTINGS_ID} .delta-settings-maintenance-actions{grid-template-columns:repeat(2,minmax(0,1fr))!important}
  #${SETTINGS_ID} .npc-state-delta-setting-row{align-items:flex-start}
  #${SETTINGS_ID} .npc-state-delta-actions:not(.delta-settings-maintenance-actions)>.menu_button,
  #${SETTINGS_ID} .npc-state-delta-tuning-actions>.menu_button{flex-basis:100%}
  #npc_state_delta_dossier_root .delta-library{grid-template-rows:minmax(0,1fr) 258px!important}
  #npc_state_delta_dossier_root .delta-cast-card{flex-basis:116px!important;width:116px!important;min-width:116px!important;height:150px!important}
}
@media(max-width:420px){
  #${SETTINGS_ID} .delta-settings-maintenance-actions{grid-template-columns:minmax(0,1fr)!important}
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
    const observer = new MutationObserver(() => mountControl());
    observer.observe(document.documentElement, { subtree: true, childList: true });
    window.addEventListener?.('focus', () => syncControl(document.getElementById(SETTINGS_ID)));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else queueMicrotask(start);
}
