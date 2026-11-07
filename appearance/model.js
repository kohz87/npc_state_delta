/* Appearance forms and resolution: named-form parsing, legacy-form conversion, the canonical model,
   complete-form/current-presentation resolution and the shared-feature bridge. A pure part of
   appearance.js (same owner, moved without change); appearance.js keeps the public facade and
   re-exports every public name. Never imports appearance.js. */
import { CAST_APPEARANCE_WIDE, castAppearanceKept } from '../core-mechanics.js';
import { APPEARANCE_FORM_LIMIT, APPEARANCE_MODEL_VERSION, appearanceText, clean, combineAppearance, formKey, formState, stripOverallPrefix, truthy } from './text.js';
import { CHANGEABLE_PRESENTATION, CONCEALED_MENTION, MIXED_CLAUSE_SPLIT, physicalPieces, physicalTraitKeys, presentationSegments, traitParts, withoutSharedPieces } from './physical.js';

export function normalizeAppearanceForms(value, { updates = false } = {}) {
    const source = Array.isArray(value)
        ? value
        : (value && typeof value === 'object'
            ? Object.entries(value).map(([name, form]) => form && typeof form === 'object' ? { name, ...form } : { name, appearance: form })
            : []);
    const forms = [];
    for (const raw of source) {
        if (!raw || typeof raw !== 'object') continue;
        const name = clean(raw.name ?? raw.form ?? raw.formName ?? raw.form_name, 120);
        const appearance = appearanceText(raw.appearance ?? raw.description ?? raw.visual ?? raw.value);
        if (!name || !appearance) continue;
        const entry = { name, appearance };
        if (updates) {
            entry.state = formState(raw.state ?? raw.appearanceState ?? raw.appearance_state);
            entry.reason = clean(raw.reason ?? raw.appearanceReason ?? raw.appearance_reason, 500);
        }
        const index = forms.findIndex(item => formKey(item.name) === formKey(name));
        if (index >= 0) forms[index] = entry;
        else forms.push(entry);
        if (forms.length >= APPEARANCE_FORM_LIMIT) break;
    }
    return forms;
}

export function formatAppearanceForms(value) {
    return normalizeAppearanceForms(value).map(form => `${form.name} | ${form.appearance}`).join('\n');
}
export function parseAppearanceFormsText(value) {
    const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > APPEARANCE_FORM_LIMIT) throw new Error(`Appearance forms are limited to ${APPEARANCE_FORM_LIMIT}.`);
    const forms = [];
    const keys = new Set();
    for (const line of lines) {
        const split = line.indexOf('|');
        if (split <= 0) throw new Error('Each appearance form must use: Form name | Description');
        const name = clean(line.slice(0, split), 120);
        const appearance = appearanceText(line.slice(split + 1));
        const key = formKey(name);
        if (!name || !appearance) throw new Error('Each appearance form needs both a name and description.');
        if (!key || keys.has(key)) throw new Error(`Duplicate appearance form: ${name}`);
        keys.add(key);
        forms.push({ name, appearance });
    }
    return forms;
}
export function appearanceFormByName(npc = {}, name = '') {
    const key = formKey(name);
    if (!key) return null;
    return normalizeAppearanceForms(npc.appearanceForms ?? npc.appearance_forms).find(form => formKey(form.name) === key) || null;
}

// A cast dossier still holding the pack's own words (castFrom.first) keeps them whole: the physical text up to 1800 characters and the
// resolved appearance ("<physical>; <wears>") up to the wide limit; every other dossier keeps the usual 800.
function castWords(raw) {
    const kept = castAppearanceKept(raw);
    return { overall: kept.overall, wide: kept.overall || kept.appearance, resolved: kept.appearance && kept.split };
}

export function normalizeAppearanceModel(raw = {}, { locked = false } = {}) {
    const words = locked ? { overall: false, wide: false } : castWords(raw);
    const wideMax = words.wide ? CAST_APPEARANCE_WIDE : undefined;
    const appearance = locked ? clean(raw.appearance, 1800) : appearanceText(raw.appearance, wideMax);
    const overallAppearance = locked || words.overall
        ? clean(raw.overallAppearance ?? raw.overall_appearance, 1800)
        : appearanceText(raw.overallAppearance ?? raw.overall_appearance);
    let unclassifiedAppearance = locked
        ? clean(raw.unclassifiedAppearance ?? raw.unclassified_appearance, 1800)
        : appearanceText(raw.unclassifiedAppearance ?? raw.unclassified_appearance);
    const rawForms = raw.appearanceForms ?? raw.appearance_forms;
    let appearanceForms = normalizeAppearanceForms(rawForms);
    if (appearanceForms.length && overallAppearance && !(Number(raw.appearanceModelVersion) >= APPEARANCE_MODEL_VERSION)) {
        // A version-1 form showed the shared features combined with its own text; store exactly
        // what it showed. A form the user marked [full] (1.0.95-1.0.97) already stood alone.
        const standalone = new Set((Array.isArray(rawForms) ? rawForms : [])
            .filter(form => form && truthy(form.fullTransformation ?? form.full_transformation))
            .map(form => formKey(form.name ?? form.form ?? form.formName ?? form.form_name)));
        appearanceForms = appearanceForms.map(form => (standalone.has(formKey(form.name))
            ? form
            : { ...form, appearance: legacyFormPresentation(overallAppearance, form.appearance) }));
    }
    const currentForm = clean(raw.currentForm ?? raw.current_form, 120);
    let currentFormUnknown = truthy(raw.currentFormUnknown ?? raw.current_form_unknown);
    if (currentForm) currentFormUnknown = false;
    const convertingV1 = appearanceForms.length && overallAppearance && !(Number(raw.appearanceModelVersion) >= APPEARANCE_MODEL_VERSION);
    if (currentFormUnknown && !unclassifiedAppearance) {
        unclassifiedAppearance = appearanceForms.length && !convertingV1 ? appearance : stripOverallPrefix(appearance, overallAppearance, wideMax);
    }
    // A version-1 unknown-form presentation showed the overall features in front of it; keep that.
    if (convertingV1 && currentFormUnknown && unclassifiedAppearance) {
        unclassifiedAppearance = combineAppearance(overallAppearance, unclassifiedAppearance);
    }
    return {
        appearance,
        overallAppearance,
        unclassifiedAppearance,
        appearanceForms,
        currentForm,
        currentFormUnknown,
        appearanceModelVersion: APPEARANCE_MODEL_VERSION,
    };
}

// Version-1 composition of a named form with the shared physical features, kept only to convert
// version-1 records: a form piece that only restated a shared trait was dropped, and a shared piece
// whose every trait the form described for itself gave way to the form's version.
function legacyFormPresentation(overall, value) {
    const own = appearanceText(value);
    if (!own) return own;
    const shared = appearanceText(overall);
    if (!shared) return own;
    const local = withoutSharedPieces(stripOverallPrefix(own, shared), shared);
    // Concealment applies to the whole piece ("silver hair and blue eyes are hidden …") before it
    // is split into traits.
    const addressed = new Set(presentationSegments(local)
        .filter(segment => !CONCEALED_MENTION.test(segment))
        .flatMap(traitParts)
        .flatMap(physicalPieces)
        .flatMap(physicalTraitKeys));
    const keepsTrait = part => {
        const keys = physicalTraitKeys(part);
        return !keys.length || !keys.every(key => addressed.has(key));
    };
    let dropped = false;
    const keptShared = presentationSegments(shared).flatMap(segment => {
        const parts = traitParts(segment);
        const kept = parts.filter(keepsTrait);
        if (kept.length === parts.length) return [segment];
        dropped = true;
        return kept.length ? [kept.join(' and ')] : [];
    });
    return combineAppearance(dropped ? keptShared.join(', ') : shared, local);
}

// A scan that still sends the body as overallAppearance and only an outfit or condition for a named
// form means that body belongs to that form: write it in, so the self-contained form does not lose
// it. Only a form described entirely by clothing, gear or condition qualifies; one that names what
// the NPC is ("a silver dragon", "spirit form") or describes any body trait is left alone.
export function completeFormWithShared(overall, value) {
    const own = appearanceText(value);
    const shared = appearanceText(overall);
    if (!own || !shared) return own;
    const segments = presentationSegments(own);
    const describesBody = segments
        .filter(segment => !CONCEALED_MENTION.test(segment))
        .flatMap(physicalPieces)
        .some(piece => physicalTraitKeys(piece).length > 0);
    // Each part around "wearing / with / in …" must be clothing or condition, so "a silver dragon
    // wearing a golden collar" is a dragon, not an outfit.
    const outfitOnly = segments.length > 0 && segments
        .flatMap(segment => segment.split(MIXED_CLAUSE_SPLIT).map(part => clean(part, 400)).filter(Boolean))
        .every(part => CHANGEABLE_PRESENTATION.test(part));
    return describesBody || !outfitOnly ? own : combineAppearance(shared, own);
}

export function resolveNpcAppearance(rawNpc = {}) {
    const model = normalizeAppearanceModel(rawNpc, {
        locked: Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes('appearance'),
    });
    const current = model.currentForm ? appearanceFormByName(model, model.currentForm) : null;
    const overall = model.overallAppearance;
    if (current) return appearanceText(current.appearance);
    // An unknown transformed form of an NPC with named forms is described completely too; the
    // overall slot serves only an NPC without forms.
    if (model.currentFormUnknown && model.appearanceForms.length) return appearanceText(model.unclassifiedAppearance || model.appearance);
    const words = castWords(rawNpc);
    const wideMax = words.wide ? CAST_APPEARANCE_WIDE : undefined;
    // The stored text of a cast dossier still is "<pack's look>; <pack's wears>": it is already the resolved appearance, kept as it is
    // (resolving it again would strip the look from it and join the outfit's sentences with "; " a second time).
    if (words.resolved && !model.currentFormUnknown && !model.currentForm && model.appearance) return model.appearance;
    if (model.currentFormUnknown) return combineAppearance(overall, model.unclassifiedAppearance || model.appearance);
    if (model.currentForm) return combineAppearance(overall, model.unclassifiedAppearance || model.appearance);
    // Without a selected form, enduring physical features (the shared slot) plus the current
    // outfit/presentation make up what is visible now.
    if (model.appearance || overall) return combineAppearance(overall, model.appearance, wideMax);
    return appearanceFormByName(model, 'Base')?.appearance || model.appearanceForms[0]?.appearance || '';
}

// The editable current outfit/presentation for an NPC without a selected form: the stored current
// appearance without the enduring physical features already held in the shared slot.
export function currentPresentationText(rawNpc = {}) {
    const model = normalizeAppearanceModel(rawNpc, {
        locked: Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes('appearance'),
    });
    if (model.currentForm || model.currentFormUnknown) return '';
    return stripOverallPrefix(model.appearance, model.overallAppearance, castWords(rawNpc).wide ? CAST_APPEARANCE_WIDE : undefined);
}
