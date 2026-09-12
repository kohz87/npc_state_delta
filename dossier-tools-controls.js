/* Stable post-render controls for the Stage 8 dossier tools surface. */
import { selectedNpcId, uiRoot } from './dossier-tools-core.js';
import { openPortraitTools } from './portrait-tools.js';

const STYLE_ID = 'npc_state_delta_tools_controls_style';
const ROOT_GUARD = '__npcStateDeltaToolsControls';
const OBSERVER_GUARD = '__npcStateDeltaToolsControlsObserver';
let normalizeQueued = false;

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#npc_state_delta_dossier_root .delta-hero-actions { gap: 12px; }
#npc_state_delta_dossier_root .delta-tools-portrait-button { margin-top: 2px; }
/* Native modal dialogs enter the browser top layer, which is above every ordinary z-index
   stacking context used by SillyTavern and the dossier panel. */
dialog.npc-state-delta-tools-overlay { width:100vw; max-width:none; height:100dvh; max-height:none; margin:0; border:0; box-sizing:border-box; }
dialog.npc-state-delta-tools-overlay:not([open]) { display:none !important; }
dialog.npc-state-delta-tools-overlay[open] { display:grid !important; }
dialog.npc-state-delta-tools-overlay::backdrop { background:transparent; }
/* Delta's maintained portrait surface is prompt generation + explicit image management only. */
.npc-state-delta-generate-portrait, .npc-state-delta-portrait-run, .npc-state-delta-portrait-use { display:none !important; }
`;
    document.head.appendChild(style);
}

function currentHeroNpcId(root) {
    return String(root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || selectedNpcId()
        || '').trim();
}

function setTextIfChanged(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
}

function setAttributeIfChanged(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function normalizeButtons(root) {
    if (!root) return;

    const portrait = root.querySelector('.delta-tools-portrait-button');
    const portraitTitle = 'Manage portrait and prompts: generate prompts, copy/edit them, or upload, replace, and remove the portrait';
    if (portrait && portrait.dataset.deltaDelegated !== '1') {
        // Stage 8 originally attached a listener directly to a button that lives inside a
        // re-rendered hero action row. Replace it with a clean node and let the dossier root
        // own the interaction, so future detail refreshes cannot leave a visible inert button.
        const clean = portrait.cloneNode(true);
        clean.dataset.deltaDelegated = '1';
        clean.dataset.npcId = currentHeroNpcId(root);
        clean.title = portraitTitle;
        portrait.replaceWith(clean);
    } else if (portrait) {
        const npcId = currentHeroNpcId(root);
        if (portrait.dataset.npcId !== npcId) portrait.dataset.npcId = npcId;
        setAttributeIfChanged(portrait, 'title', portraitTitle);
    }

    const data = root.querySelector('.delta-tools-data');
    if (data) {
        // IMPORTANT: this must be idempotent. Unconditionally assigning textContent from a
        // MutationObserver creates another childList mutation and can starve the host UI.
        setTextIfChanged(data, 'Backup');
        setAttributeIfChanged(data, 'title', 'Import or export native NPC State Delta data');
        setAttributeIfChanged(data, 'aria-label', 'Backup and restore Delta data');
    }

    const diagnostics = root.querySelector('.delta-tools-diagnostics-button');
    if (diagnostics) {
        setAttributeIfChanged(diagnostics, 'title', 'Open troubleshooting diagnostics; this does not start a scan');
        setAttributeIfChanged(diagnostics, 'aria-label', 'Open NPC State Delta diagnostics');
    }
}

function scheduleNormalize(root) {
    if (!root || normalizeQueued) return;
    normalizeQueued = true;
    queueMicrotask(() => {
        normalizeQueued = false;
        if (root.isConnected) normalizeButtons(root);
    });
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
    if (!root[OBSERVER_GUARD]) {
        const observer = new MutationObserver(() => scheduleNormalize(root));
        observer.observe(root, { childList: true, subtree: true });
        root[OBSERVER_GUARD] = observer;
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}
