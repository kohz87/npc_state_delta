/* NPC State Delta dossier surface: import-compatible facade over the split dossier UI modules. */
import { mountNpcStateDeltaDossierUi } from './dossier-ui-mount.js';

export { DeltaDossierUi } from './dossier-ui-controller.js';
export { castFromHtml, castProjection, chooseDossierSelection, filterDossierIndex, keyAwayHtml, keyProjection, projectDossierState, sortDossierIndex } from './dossier-ui-catalog.js';
export { appearanceFormsHtml, changeSummaryHtml, createPortraitRefs } from './dossier-ui-html.js';
export { v2MetersHtml, v2MetersProjection, v2SecretsHtml } from './dossier-ui-meters.js';
export { changeStamp, dossierDetailProjection, dossierIndexProjection, dossierLifeBucket, dossierStatusLabel, replyHeaderLabel } from './dossier-ui-model.js';
export { lastRelationshipChangeHtml, relationshipStepHtml } from './dossier-ui-relationship.js';
export { mountNpcStateDeltaDossierUi };

function startBrowserUi(attempt = 0) {
    if (typeof document === 'undefined') return;
    const api = globalThis.NPCStateDelta;
    if (api) {
        mountNpcStateDeltaDossierUi(api);
        return;
    }
    if (attempt < 40) setTimeout(() => startBrowserUi(attempt + 1), 100);
    else console.error('[NPC State Delta] Stage 1 dossier UI could not find the runtime API.');
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startBrowserUi(), { once: true });
    else queueMicrotask(() => startBrowserUi());
}
