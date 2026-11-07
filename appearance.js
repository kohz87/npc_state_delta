/* NPC State Delta appearance model: the shared resolver for named forms/current form plus the
   unnamed current presentation, scanner updates, per-form portraits and the editor draft. The
   implementation lives in appearance-*.js (same owner, moved without change); this root path keeps
   every public export. Never imports core.js. */
export { APPEARANCE_FORM_LIMIT, APPEARANCE_MODEL_VERSION } from './appearance-text.js';
export {
    normalizeAppearanceForms,
    formatAppearanceForms,
    parseAppearanceFormsText,
    appearanceFormByName,
    normalizeAppearanceModel,
    completeFormWithShared,
    resolveNpcAppearance,
    currentPresentationText,
} from './appearance-model.js';
export { carryOmittedPhysicalTraits, applyAppearanceUpdate } from './appearance-update.js';
export {
    formPortraitKey,
    normalizeFormPortraitAssets,
    formPortraitFor,
    appearanceFingerprint,
} from './appearance-portrait.js';
export { appearanceDraftRecord } from './appearance-draft.js';
