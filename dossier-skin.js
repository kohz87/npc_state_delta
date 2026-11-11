/* NPC State Delta dossier look: the "Dossier style" setting (Neutral, Fantasy, Modern). It only names the look:
   the dossier panel root carries data-skin, and the skin CSS (dossier-ui-styles-board.js) layers its tokens on
   --delta-* / --ss-* under [data-skin]. No fonts are loaded here and no dossier data is read or written. */
import { extension_settings, getContext } from '../../../extensions.js';
import { ROOT_ID, SETTINGS_ID } from './dossier-ui-constants.js';

const EXTENSION_NAME = 'npc_state_delta';
const SETTINGS_ROOT_ID = 'npc_state_delta_dossier_skin_settings';
const SELECT_ID = 'npc_state_delta_dossier_style';
const SLOT_ID = 'dossier-style';
// Until the settings panel has its own slot, the row sits in the relationship-map slot (same settings block).
const FALLBACK_SLOT_ID = 'relationship-map';

export const DOSSIER_SKIN_DEFAULT = 'neutral';
export const DOSSIER_SKINS = Object.freeze([
    Object.freeze({ key: 'neutral', label: 'Neutral', hint: 'Fine-line dial, muted ink, warm charcoal. The default.' }),
    Object.freeze({ key: 'fantasy', label: 'Fantasy', hint: 'Gilt edges, a bevelled dial and parchment-brown tiles.' }),
    Object.freeze({ key: 'modern', label: 'Modern', hint: 'Dark, flat tiles with bright meter colours and a soft glow.' }),
]);
const SKIN_KEYS = DOSSIER_SKINS.map(skin => skin.key);

// Any stored or typed value becomes one of the three looks; anything else is Neutral.
export function normalizeDossierSkin(value) {
    const key = String(value ?? '').trim().toLowerCase();
    return SKIN_KEYS.includes(key) ? key : DOSSIER_SKIN_DEFAULT;
}

export function readDossierSkin() {
    return normalizeDossierSkin(extension_settings?.[EXTENSION_NAME]?.dossierStyle);
}

export function writeDossierSkin(value) {
    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') extension_settings[EXTENSION_NAME] = {};
    const skin = normalizeDossierSkin(value);
    extension_settings[EXTENSION_NAME].dossierStyle = skin;
    const ctx = getContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    return skin;
}

// Sets data-skin on the dossier root (or the element given). Returns the skin applied, or '' when no root is drawn.
export function applyDossierSkin(element = typeof document === 'undefined' ? null : document.getElementById(ROOT_ID), skin = readDossierSkin()) {
    if (!element || typeof element !== 'object' || !element.dataset) return '';
    const value = normalizeDossierSkin(skin);
    element.dataset.skin = value;
    return value;
}

// Re-applies the stored look to the drawn panel; it runs after every draw (the panel announces each one) and after a change.
export function syncDossierSkin() {
    return applyDossierSkin();
}

function settingsSlot() {
    if (typeof document === 'undefined') return null;
    return document.querySelector(`#${SETTINGS_ID} [data-delta-settings-slot="${SLOT_ID}"]`)
        || document.querySelector(`#${SETTINGS_ID} [data-delta-settings-slot="${FALLBACK_SLOT_ID}"]`);
}

function settingRow(id, label, control, hint) {
    return `<label class="npc-state-delta-setting-row story-suite-row" for="${id}"><span><b>${label}</b><small>${hint}</small></span>${control}</label>`;
}

// Mounts the Dossier style row once. Returns false while the settings panel has no slot yet (the caller may retry).
export function mountDossierSkinSettings() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById(SETTINGS_ROOT_ID)) return true;
    const slot = settingsSlot();
    if (!slot) return false;
    const current = readDossierSkin();
    const root = document.createElement('div');
    root.id = SETTINGS_ROOT_ID;
    root.innerHTML = `<h4 class="delta-settings-subhead story-suite-subhead">Dossier look</h4>
        ${settingRow(SELECT_ID, 'Dossier style', `<select id="${SELECT_ID}" class="text_pole">${DOSSIER_SKINS.map(skin => `<option value="${skin.key}"${skin.key === current ? ' selected' : ''}>${skin.label}</option>`).join('')}</select>`, 'The look of the dossier window: Neutral (default), Fantasy or Modern. Only colours, edges and the dial change; what it shows does not.')}`;
    root.addEventListener('change', event => {
        if (event.target?.id !== SELECT_ID) return;
        const skin = writeDossierSkin(event.target.value);
        event.target.value = skin;
        applyDossierSkin(document.getElementById(ROOT_ID), skin);
    });
    slot.appendChild(root);
    return true;
}

// Like the relationship map: this module wires itself, so the panel never imports the host's settings module.
function start() {
    // Synthetic hosts offer a document with no queries: nothing to style there.
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || typeof document.addEventListener !== 'function') return;
    document.addEventListener('npc-state-delta:dossier-rendered', syncDossierSkin);
    document.addEventListener('npc-state-delta:settings-mounted', mountDossierSkinSettings);
    mountDossierSkinSettings();
    syncDossierSkin();
}

start();
