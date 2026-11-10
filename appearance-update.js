/* Appearance update rules: form/local reconciliation, omitted physical-trait carry, and applying a
   scanner flat/form/current-form update into the canonical model. A pure part of appearance.js (same
   owner, moved without change); appearance.js keeps the public facade and re-exports every public name.
   Never imports appearance.js. */
import {
    DURABLE_PROFILE_LIMITS,
    normalizeName,
    durableSeedGrounded,
    durableRefinementCandidateGrounded,
    groundedAppearanceCorrection,
    isSafeUnmarkedDurableRefinement,
    isSafeUnmarkedDurableReplacement,
} from './core-mechanics.js';
import { APPEARANCE_FORM_LIMIT, APPEARANCE_MODEL_VERSION, appearanceText, clean, formKey, formState, hasOwn, sameAppearance, stripOverallPrefix } from './appearance-text.js';
import { appendedLooks, attemptsExtension, describedFeatures, lookOnly } from './appearance-fill.js';
import { mergeRefinement, preserveOmittedPhysicalTraits, withoutSharedPieces } from './appearance-physical.js';
import { completeFormWithShared, normalizeAppearanceForms, normalizeAppearanceModel, resolveNpcAppearance } from './appearance-model.js';

function reconcileFormAppearance(existing, update, context = '') {
    const current = appearanceText(existing);
    const incoming = appearanceText(update?.appearance);
    if (!incoming) return current;
    if (!current) return context && !durableSeedGrounded(incoming, context) ? '' : incoming;
    if (normalizeName(current) === normalizeName(incoming)) return current;
    const state = formState(update?.state);
    if (state === 'change') {
        const reason = clean(update?.reason, 500);
        if (!reason || (context && (!durableSeedGrounded(reason, context) || !durableSeedGrounded(incoming, context)))) return current;
        return incoming;
    }
    const compatible = state === 'refine'
        ? (isSafeUnmarkedDurableRefinement(current, incoming)
            || groundedAppearanceCorrection(current, incoming, context))
        : isSafeUnmarkedDurableReplacement(current, incoming);
    if (!compatible || (context && !durableRefinementCandidateGrounded('appearance', current, incoming, context))) return current;
    return mergeRefinement(current, incoming, DURABLE_PROFILE_LIMITS?.appearance || 800);
}

// The core merge applies an accepted flat Appearance update before this model sees it, so the
// flat-slot protection above would compare against text that already lost its physical traits.
// Carry them forward from the pre-scan record. Form slots keep their own text and are protected
// inside applyAppearanceUpdate.
export function carryOmittedPhysicalTraits(previous = {}, next = {}) {
    const prior = normalizeAppearanceModel(previous);
    const model = normalizeAppearanceModel(next);
    if (prior.currentForm || prior.currentFormUnknown || model.currentForm || model.currentFormUnknown) return next;
    const before = appearanceText(prior.appearance);
    const after = appearanceText(next.appearance);
    if (!before || !after || sameAppearance(before, after)) return next;
    const appearance = preserveOmittedPhysicalTraits(before, after, { alsoPresent: model.overallAppearance });
    return appearance === after ? next : { ...next, appearance };
}

export function applyAppearanceUpdate(record = {}, rawUpdate = {}, { locked = false, context = '', seedContext = '', fillBlank = false } = {}) {
    const next = normalizeAppearanceModel(record, { locked });
    if (locked || !rawUpdate || typeof rawUpdate !== 'object') return { ...next, appearance: resolveNpcAppearance(next) };
    const priorOverall = next.overallAppearance;

    const overallProvided = hasOwn(rawUpdate, 'overallAppearance') || hasOwn(rawUpdate, 'overall_appearance');
    if (overallProvided) {
        const incoming = appearanceText(rawUpdate.overallAppearance ?? rawUpdate.overall_appearance);
        if (!next.overallAppearance) {
            // First physical features may come from anywhere in the scene (an NPC is often
            // introduced before it is named) or from the NPC's own stored appearance, when enduring
            // traits move out of the current-presentation slot. Changes to established features
            // below stay grounded in story text about this NPC.
            const narration = String(seedContext || context || '').trim();
            const seedSupport = narration
                ? [narration, next.appearance, next.unclassifiedAppearance, ...next.appearanceForms.map(form => form.appearance)].filter(Boolean).join(' ')
                : '';
            // A blank shared slot may not invent a second version of a feature already in the current look.
            const clash = describedFeatures(next.appearance).some(key => describedFeatures(incoming).includes(key));
            // Ungrounded text is looks-only: anything else (a deed, a secret) needs the story's own support.
            if (fillBlank ? ((!clash && (lookOnly(incoming) || (seedSupport && durableSeedGrounded(incoming, seedSupport))))
                    || groundedAppearanceCorrection(next.appearance, incoming, context, [], { npc: record, targeted: true }))
                : (!seedSupport || durableSeedGrounded(incoming, seedSupport))) next.overallAppearance = incoming;
        } else if (fillBlank && attemptsExtension(next.overallAppearance, incoming)) {
            // A fill call (appearance-fill.js): the written text survives word for word and only a missing hair/eyes/build is added;
            // an extension that does not pass (clash, over the limit, a changed word) leaves the record as it is.
            next.overallAppearance = appendedLooks(next.overallAppearance, incoming, undefined, stripOverallPrefix(next.appearance, priorOverall)) || next.overallAppearance;
        } else if (incoming && normalizeName(incoming) !== normalizeName(next.overallAppearance)) {
            const state = formState(rawUpdate.overallAppearanceState ?? rawUpdate.overall_appearance_state);
            if (state === 'change') {
                const reason = clean(rawUpdate.overallAppearanceReason ?? rawUpdate.overall_appearance_reason, 500);
                if (reason && (!context || (durableSeedGrounded(reason, context) && durableSeedGrounded(incoming, context)))) {
                    next.overallAppearance = preserveOmittedPhysicalTraits(next.overallAppearance, incoming);
                }
            } else {
                const compatible = state === 'refine'
                    ? (isSafeUnmarkedDurableRefinement(next.overallAppearance, incoming)
                        || groundedAppearanceCorrection(next.overallAppearance, incoming, context))
                    : isSafeUnmarkedDurableReplacement(next.overallAppearance, incoming);
                if (compatible && (!context || durableRefinementCandidateGrounded('appearance', next.overallAppearance, incoming, context))) {
                    next.overallAppearance = mergeRefinement(next.overallAppearance, incoming, DURABLE_PROFILE_LIMITS?.appearance || 800);
                }
            }
        }
    }

    const formsProvided = hasOwn(rawUpdate, 'appearanceForms') || hasOwn(rawUpdate, 'appearance_forms');
    if (formsProvided) {
        for (const form of normalizeAppearanceForms(rawUpdate.appearanceForms ?? rawUpdate.appearance_forms, { updates: true })) {
            const index = next.appearanceForms.findIndex(item => formKey(item.name) === formKey(form.name));
            if (index >= 0) {
                const existing = next.appearanceForms[index].appearance;
                const appearance = preserveOmittedPhysicalTraits(existing, reconcileFormAppearance(existing, form, context));
                if (appearance) next.appearanceForms[index] = { ...next.appearanceForms[index], name: next.appearanceForms[index].name || form.name, appearance };
            } else if (next.appearanceForms.length < APPEARANCE_FORM_LIMIT) {
                const appearance = reconcileFormAppearance('', form, context);
                if (appearance) next.appearanceForms.push({ name: form.name, appearance: overallProvided ? completeFormWithShared(next.overallAppearance, appearance) : appearance });
            }
        }
    }

    const currentStateRaw = String(rawUpdate.currentFormState ?? rawUpdate.current_form_state ?? '').trim().toLowerCase();
    const incomingCurrent = clean(rawUpdate.currentForm ?? rawUpdate.current_form, 120);
    const currentAppearanceProvided = hasOwn(rawUpdate, 'appearance');
    if (['unknown', 'unspecified', 'clear'].includes(currentStateRaw)) {
        next.currentForm = '';
        next.currentFormUnknown = true;
        const incomingAppearance = appearanceText(rawUpdate.appearance);
        const reason = clean(rawUpdate.appearanceReason ?? rawUpdate.appearance_reason ?? rawUpdate.currentFormReason ?? rawUpdate.current_form_reason, 500);
        const explicitChange = formState(rawUpdate.appearanceState ?? rawUpdate.appearance_state) === 'change';
        next.unclassifiedAppearance = currentAppearanceProvided
            && incomingAppearance
            && (!context || durableSeedGrounded(incomingAppearance, context))
            && (!explicitChange || (reason && (!context || durableSeedGrounded(reason, context))))
            ? incomingAppearance
            : '';
        next.appearance = '';
    } else if (incomingCurrent || ['select', 'switch', 'change', 'current'].includes(currentStateRaw)) {
        if (incomingCurrent) next.currentForm = incomingCurrent;
        next.currentFormUnknown = false;
        // A named form owns its own anatomy. Do not carry the old compatibility scalar across
        // a switch, since that scalar may describe the previous form.
        if (incomingCurrent && !currentAppearanceProvided) next.appearance = '';
    }
    // A valid flat appearance update describes the CURRENT presentation. Reconcile it into
    // that canonical slot before resolving the compatibility/display scalar, so a selected
    // named form cannot replay stale clothing or anatomy over an accepted current update.
    if (currentAppearanceProvided) {
        const incomingAppearance = appearanceText(rawUpdate.appearance);
        if (incomingAppearance) {
            const localAppearance = stripOverallPrefix(incomingAppearance, next.overallAppearance) || incomingAppearance;
            const update = {
                appearance: localAppearance,
                state: rawUpdate.appearanceState ?? rawUpdate.appearance_state,
                reason: rawUpdate.appearanceReason ?? rawUpdate.appearance_reason,
            };
            if (next.currentForm) {
                const index = next.appearanceForms.findIndex(form => formKey(form.name) === formKey(next.currentForm));
                if (index >= 0) {
                    // A named form is its own complete appearance, so the reconciled current text is
                    // stored as given, with omitted body traits carried from the form.
                    const existingLocal = next.appearanceForms[index].appearance;
                    const resolved = reconcileFormAppearance(existingLocal, { ...update, appearance: incomingAppearance }, context);
                    const appearance = preserveOmittedPhysicalTraits(existingLocal, resolved);
                    if (appearance) next.appearanceForms[index] = { ...next.appearanceForms[index], appearance };
                } else {
                    // A flat presentation may describe a selected-but-not-yet-established form,
                    // but it cannot fabricate that named form after its own form detail failed
                    // grounding. Keep the accepted current presentation in the compatibility slot.
                    next.appearance = reconcileFormAppearance('', { ...update, appearance: incomingAppearance }, context);
                }
            } else if (next.currentFormUnknown) {
                const previous = next.unclassifiedAppearance;
                const standalone = next.appearanceForms.length > 0;
                next.unclassifiedAppearance = preserveOmittedPhysicalTraits(previous,
                    reconcileFormAppearance(previous, standalone ? { ...update, appearance: incomingAppearance } : update, context),
                    { alsoPresent: standalone ? '' : next.overallAppearance });
            } else {
                // Without a selected/unknown form the shared physical features are prepended when resolved,
                // so traits already held there are not carried into the current presentation again.
                const previous = fillBlank ? stripOverallPrefix(next.appearance, priorOverall) : next.appearance;
                const conflictsWithShared = fillBlank && !previous && describedFeatures(next.overallAppearance)
                    .some(key => describedFeatures(localAppearance).includes(key));
                next.appearance = withoutSharedPieces(
                    preserveOmittedPhysicalTraits(previous, conflictsWithShared ? previous : reconcileFormAppearance(previous, update, fillBlank && !previous && lookOnly(localAppearance, { clothes: true }) ? '' : (fillBlank && !previous ? context || '-' : context)), { alsoPresent: next.overallAppearance }),
                    next.overallAppearance,
                );
            }
        }
    }

    // New or changed physical features own their traits: the current presentation of an NPC without
    // a selected form stops repeating pieces they already cover.
    if (next.overallAppearance && next.overallAppearance !== priorOverall && !next.currentForm && !next.currentFormUnknown) {
        next.appearance = withoutSharedPieces(stripOverallPrefix(next.appearance, priorOverall), next.overallAppearance);
    }
    next.appearanceModelVersion = APPEARANCE_MODEL_VERSION;
    next.appearance = resolveNpcAppearance(next);
    return next;
}
