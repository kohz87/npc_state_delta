/* Stable post-render controls for the Stage 8 dossier tools surface. */
import { selectedNpcId, uiRoot } from './dossier-tools-core.js';
import { openPortraitTools } from './dossier-tools.js';

const STYLE_ID = 'npc_state_delta_tools_controls_style';
const ROOT_GUARD = '__npcStateDeltaToolsControls';

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#npc_state_delta_dossier_root .delta-hero-actions { gap: 12px; }
#npc_state_delta_dossier_root .delta-tools-portrait-button { margin-top: 2px; }
`;
    document.head.appendChild(style);
}

function currentHeroNpcId(root) {
    return String(root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || selectedNpcId()
        || '').trim();
}

function normalizeButtons(root) {
    if (!root) return;

    const portrait = root.querySelector('.delta-tools-portrait-button');
    if (portrait && portrait.dataset.deltaDelegated !== '1') {
        // Stage 8 originally attached a listener directly to a button that lives inside a
        // re-rendered hero action row. Replace it with a clean node and let the dossier root
        // own the interaction, so future detail refreshes cannot leave a visible inert button.
        const clean = portrait.cloneNode(true);
        clean.dataset.deltaDelegated = '1';
        clean.dataset.npcId = currentHeroNpcId(root);
        clean.title = 'Manage portrait, prompts, upload, replacement, removal, and image preview';
        portrait.replaceWith(clean);
    } else if (portrait) {
        portrait.dataset.npcId = currentHeroNpcId(root);
    }

    const data = root.querySelector('.delta-tools-data');
    if (data) {
        data.textContent = 'Backup';
        data.title = 'Import or export native NPC State Delta data';
        data.setAttribute('aria-label', 'Backup and restore Delta data');
    }

    const diagnostics = root.querySelector('.delta-tools-diagnostics-button');
    if (diagnostics) {
        diagnostics.title = 'Open troubleshooting diagnostics; this does not start a scan';
        diagnostics.setAttribute('aria-label', 'Open NPC State Delta diagnostics');
    }
}

function installDelegatedPortraitHandler(root) {
    if (!root || root[ROOT_GUARD]) return;
    root[ROOT_GUARD] = true;
    root.addEventListener('click', event => {
        const button = event.target.closest?.('.delta-tools-portrait-button');
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const npcId = String(button.dataset.npcId || currentHeroNpcId(root)).trim();
        try {
            const opened = openPortraitTools(npcId);
            if (!opened) toast('warning', 'NPC State Delta: the portrait manager could not open for the selected dossier.');
        } catch (error) {
            console.error('[NPC State Delta] portrait manager open failed', error);
            toast('error', `NPC State Delta portrait manager failed to open: ${error?.message || error}`);
        }
    }, true);
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    const root = uiRoot();
    if (!root) {
        if (attempt < 60) setTimeout(() => start(attempt + 1), 100);
        return;
    }
    installDelegatedPortraitHandler(root);
    normalizeButtons(root);
    if (!root.__npcStateDeltaToolsControlsObserver) {
        const observer = new MutationObserver(() => normalizeButtons(root));
        observer.observe(root, { childList: true, subtree: true });
        root.__npcStateDeltaToolsControlsObserver = observer;
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}
