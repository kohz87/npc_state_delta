/* NPC State Delta dossier surface: singleton mounting and open-dossier request forwarding. */
import { DeltaDossierUi } from './dossier-ui-controller.js';
import { OPEN_REQUEST_GUARD, ROOT_ID } from './dossier-ui-constants.js';
import { plain } from './dossier-ui-model.js';

export function mountNpcStateDeltaDossierUi(api = globalThis.NPCStateDelta) {
    if (typeof document === 'undefined' || !api) return null;
    const existing = document.getElementById(ROOT_ID);
    if (existing?.__npcStateDeltaStage1Ui) return existing.__npcStateDeltaStage1Ui;
    const controller = new DeltaDossierUi(api).mount();
    if (controller?.root) controller.root.__npcStateDeltaStage1Ui = controller;
    if (!document[OPEN_REQUEST_GUARD]) {
        document[OPEN_REQUEST_GUARD] = true;
        document.addEventListener('npc-state-delta:open-dossier', event => {
            const ui = document.getElementById(ROOT_ID)?.__npcStateDeltaStage1Ui;
            const npcId = plain(event?.detail?.npcId);
            if (!ui || !npcId) return;
            event.detail.handled = true;
            void ui.openNpc(npcId);
        });
    }
    return controller;
}
