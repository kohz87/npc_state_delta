/* Appearance editor draft: reading/writing the form list and selected/current presentation while
   preserving scanner locks around a manual form edit. A pure part of appearance.js (same owner,
   moved without change); appearance.js keeps the public facade and re-exports every public name.
   Never imports appearance.js. */
import { APPEARANCE_MODEL_VERSION, clean, formKey, stripOverallPrefix } from './text.js';
import { currentPresentationText, formatAppearanceForms, normalizeAppearanceModel, parseAppearanceFormsText, resolveNpcAppearance } from './model.js';

export function appearanceDraftRecord(npc = {}, draft = {}, { lockAppearance = false } = {}) {
    const forms = parseAppearanceFormsText(draft.formsText ?? formatAppearanceForms(npc?.appearanceForms));
    const selected = clean(draft.currentForm);
    const currentFormUnknown = selected === '__unknown__' || draft.currentFormUnknown === true;
    const currentForm = currentFormUnknown || selected === '__none__' ? '' : selected;
    if (currentForm && !forms.some(form => formKey(form.name) === formKey(currentForm))) {
        throw new Error(`Current form is not in the appearance-form list: ${currentForm}`);
    }

    const overallAppearance = clean(draft.overallAppearance).slice(0, 1800);
    // With no form selected, the current outfit/presentation is the NPC's own appearance slot.
    // Keep it (from the editor, or the existing record) instead of blanking the NPC's appearance.
    const currentAppearance = currentForm || currentFormUnknown
        ? ''
        : stripOverallPrefix(clean(draft.currentAppearance ?? currentPresentationText(npc)).slice(0, 1800), overallAppearance);
    const nextInput = {
        ...npc,
        appearanceModelVersion: APPEARANCE_MODEL_VERSION,
        appearance: currentAppearance,
        overallAppearance,
        appearanceForms: forms,
        currentForm,
        currentFormUnknown,
    };
    if (currentFormUnknown) {
        nextInput.unclassifiedAppearance = clean(draft.unclassifiedAppearance ?? npc?.unclassifiedAppearance ?? npc?.appearance).slice(0, 1800);
    }

    const normalized = normalizeAppearanceModel(nextInput, { locked: false });
    const next = { ...npc, ...normalized, appearance: currentAppearance };
    const locks = new Set(Array.isArray(npc?.manualProfileFields) ? npc.manualProfileFields : []);
    // A lock prevents scanner changes; it must not replay old anatomy over a manual form edit.
    next.manualProfileFields = [...locks].filter(key => key !== 'appearance');
    next.appearance = resolveNpcAppearance(next);
    if (lockAppearance) locks.add('appearance');
    else locks.delete('appearance');
    next.manualProfileFields = [...locks];
    return next;
}
