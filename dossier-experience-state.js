/* NPC State Delta dossier experience state: life-state projection, current selection, and DOM write guards. */
import { isTerminalNpcDeath } from './core.js';
import { api, plain, uiRoot } from './dossier-tools-core.js';

export function setNodeTextIfChanged(node, value) {
    const text = String(value ?? '');
    if (!node || node.textContent === text) return false;
    node.textContent = text;
    return true;
}

export function setNodeValueIfChanged(node, value) {
    const next = String(value ?? '');
    if (!node || node.value === next) return false;
    node.value = next;
    return true;
}

export function lifeStateChoice(npc = {}) {
    if (isTerminalNpcDeath(npc)) return 'deceased';
    const value = plain(npc?.lifeState).toLowerCase();
    const certainty = plain(npc?.lifeStateCertainty).toLowerCase();
    // Recover the short-lived Stage 8 UI shape without weakening automatic death rules.
    if (value === 'dead' && (certainty === 'confirmed' || certainty === 'explicit')) return 'deceased';
    if (value === 'deceased' && certainty === 'explicit') return 'deceased';
    if (value === 'alive' || value === 'living') return 'alive';
    return 'unknown';
}


// The dossier on screen, or '' on the library: the controller's own selection (the board, profile and sections all
// belong to one NPC). The library keeps a highlighted id but shows no dossier, so it counts as none.
export function screenNpcId(root = uiRoot()) {
    const ui = root?.__npcStateDeltaStage1Ui;
    if (!ui) return '';
    return ui.screen?.name && ui.screen.name !== 'library' ? plain(ui.selectedNpcId) : '';
}

export function selectedNpcId(root = uiRoot()) {
    return plain(root?.__npcStateDeltaStage1Ui?.selectedNpcId);
}

export function currentNpc(npcId = selectedNpcId()) {
    try { return api()?.getNpc?.(npcId) || null; }
    catch { return null; }
}
