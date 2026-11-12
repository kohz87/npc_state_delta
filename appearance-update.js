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
import { agreeWithStoredAge, appendedLooks, attemptsExtension, withSplitLook } from './appearance-fill.js';
import { filledGuess, guessedTraits, mergeRefinement, physicalTraitSwaps, settledGuess, preserveOmittedPhysicalTraits, withoutSharedPieces, withoutTraitSwaps } from './appearance-physical.js';
import { groundedTraitEvent } from './core-durable-grounding.js';
import { completeFormWithShared, normalizeAppearanceForms, normalizeAppearanceModel, resolveNpcAppearance } from './appearance-model.js';

function reconcileFormAppearance(existing, update, context = '', npc = {}) {
    const current = appearanceText(existing);
    const incoming = appearanceText(update?.appearance);
    if (!incoming) return current;
    if (!current) return context && !durableSeedGrounded(incoming, context) ? '' : incoming;
    if (normalizeName(current) === normalizeName(incoming)) return current;
    const state = formState(update?.state);
    if (state === 'change') {
        const reason = clean(update?.reason, 500);
        if (!reason || (context && (!durableSeedGrounded(reason, context) || !durableSeedGrounded(incoming, context)))) return current;
        const swaps = physicalTraitSwaps(current, incoming, guessedTraits(npc));
        if (swaps.length && !groundedTraitEvent(npc, swaps.map(swap => swap.said).join(' '), reason, context)) return current;
        return incoming;
    }
    // (card traits win) A refine keeps every established physical value.
    const kept = withoutTraitSwaps(current, incoming, guessedTraits(npc)).text;
    if (!kept) return current;
    const compatible = state === 'refine'
        ? (isSafeUnmarkedDurableRefinement(current, kept)
            || groundedAppearanceCorrection(current, kept, context))
        : isSafeUnmarkedDurableReplacement(current, kept);
    if (!compatible || (context && !durableRefinementCandidateGrounded('appearance', current, kept, context))) return current;
    return mergeRefinement(current, kept, DURABLE_PROFILE_LIMITS?.appearance || 800);
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

/**
 * The durable look the scan refused (NSDMAP2 §5): `before`/`after` are a person's overallAppearance before and after the scan's
 * update, `rawUpdate` the scanner's row. → { incoming } when a look was already set, the row offered a different one and the
 * record still holds the old one (no accepted refinement, no grounded `change`); { incoming, swaps } when the record took the
 * rest of it but kept a trait the row swapped (physicalTraitSwaps: [{ trait, said, kept }]); otherwise null. Forms never count.
 */
export function rejectedOverallLook(before, after, rawUpdate = {}) {
    const held = appearanceText(before);
    if (!held || !rawUpdate || typeof rawUpdate !== 'object') return null;
    if (!hasOwn(rawUpdate, 'overallAppearance') && !hasOwn(rawUpdate, 'overall_appearance')) return null;
    const incoming = appearanceText(rawUpdate.overallAppearance ?? rawUpdate.overall_appearance);
    if (!incoming || normalizeName(incoming) === normalizeName(held)) return null;
    if (normalizeName(appearanceText(after)) === normalizeName(held)) return { incoming };
    // (card traits win) The rest of a refine was taken but a trait it swapped was kept: { incoming, swaps } names each.
    const swaps = physicalTraitSwaps(after, incoming);
    return swaps.length ? { incoming, swaps } : null;
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
            // fillBlank (the Refresh of a new person, appearance-fill.js): this BLANK slot takes a fitted look without quoted support.
            if (fillBlank || !seedSupport || durableSeedGrounded(incoming, seedSupport)) next.overallAppearance = fillBlank ? agreeWithStoredAge(incoming, record) : incoming;
        } else if (fillBlank && attemptsExtension(next.overallAppearance, incoming)) {
            // A fill call (appearance-fill.js): the written text survives word for word and only a missing hair/eyes/build is added;
            // an extension that does not pass (clash, over the limit, a changed word) leaves the record as it is.
            next.overallAppearance = appendedLooks(next.overallAppearance, incoming) || next.overallAppearance;
        } else if (incoming && normalizeName(incoming) !== normalizeName(next.overallAppearance)) {
            const state = formState(rawUpdate.overallAppearanceState ?? rawUpdate.overall_appearance_state);
            if (state === 'change') {
                const reason = clean(rawUpdate.overallAppearanceReason ?? rawUpdate.overall_appearance_reason, 500);
                const swaps = physicalTraitSwaps(next.overallAppearance, incoming, guessedTraits(record));
                if (reason && (!swaps.length || groundedTraitEvent(record, swaps.map(swap => swap.said).join(' '), reason, context))
                    && (!context || (durableSeedGrounded(reason, context) && durableSeedGrounded(incoming, context)))) {
                    next.overallAppearance = preserveOmittedPhysicalTraits(next.overallAppearance, incoming);
                }
            } else {
                // (card traits win) A refine or correction never swaps a trait the pack card names (the card's brown eyes stay brown when the
                // narrator writes "pale eyes"): the held clause stays and the rest of the refine is weighed; none of it when it cannot be.
                const kept = withoutTraitSwaps(next.overallAppearance, incoming, guessedTraits(record)).text;
                const compatible = kept && (state === 'refine'
                    ? (isSafeUnmarkedDurableRefinement(next.overallAppearance, kept)
                        || groundedAppearanceCorrection(next.overallAppearance, kept, context))
                    : isSafeUnmarkedDurableReplacement(next.overallAppearance, kept));
                if (compatible && (!context || durableRefinementCandidateGrounded('appearance', next.overallAppearance, kept, context))) {
                    next.overallAppearance = mergeRefinement(next.overallAppearance, kept, DURABLE_PROFILE_LIMITS?.appearance || 800);
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
                const appearance = preserveOmittedPhysicalTraits(existing, reconcileFormAppearance(existing, form, context, record));
                if (appearance) next.appearanceForms[index] = { ...next.appearanceForms[index], name: next.appearanceForms[index].name || form.name, appearance };
            } else if (next.appearanceForms.length < APPEARANCE_FORM_LIMIT) {
                const appearance = reconcileFormAppearance('', form, context, record);
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
                    const resolved = reconcileFormAppearance(existingLocal, { ...update, appearance: incomingAppearance }, context, record);
                    const appearance = preserveOmittedPhysicalTraits(existingLocal, resolved);
                    if (appearance) next.appearanceForms[index] = { ...next.appearanceForms[index], appearance };
                } else {
                    // A flat presentation may describe a selected-but-not-yet-established form,
                    // but it cannot fabricate that named form after its own form detail failed
                    // grounding. Keep the accepted current presentation in the compatibility slot.
                    next.appearance = reconcileFormAppearance('', { ...update, appearance: incomingAppearance }, context, record);
                }
            } else if (next.currentFormUnknown) {
                const previous = next.unclassifiedAppearance;
                const standalone = next.appearanceForms.length > 0;
                next.unclassifiedAppearance = preserveOmittedPhysicalTraits(previous,
                    reconcileFormAppearance(previous, standalone ? { ...update, appearance: incomingAppearance } : update, context, record),
                    { alsoPresent: standalone ? '' : next.overallAppearance });
            } else {
                // Without a selected/unknown form the shared physical features are prepended when resolved,
                // so traits already held there are not carried into the current presentation again.
                const previous = next.appearance;
                next.appearance = withoutSharedPieces(
                    preserveOmittedPhysicalTraits(previous, reconcileFormAppearance(previous, update, fillBlank && !previous ? '' : context, record), { alsoPresent: next.overallAppearance }),
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
    // A body the scan left in the clothes field (overallAppearance blank or short) moves to overallAppearance, in its own words (appearance-fill.js splitLook).
    if (!next.currentForm && !next.currentFormUnknown && !next.appearanceForms.length) {
        const split = withSplitLook({ ...record, ...next });
        if (split.overallAppearance !== next.overallAppearance) { next.overallAppearance = split.overallAppearance; next.appearance = split.appearance; }
    }
    next.appearanceModelVersion = APPEARANCE_MODEL_VERSION;
    // (card traits win) Provenance of a fill guess: what a fill call newly wrote is replaceable, a story-given value is not.
    const lookBefore = [priorOverall, record.appearance].filter(Boolean).join('; ');
    const lookAfter = [next.overallAppearance, next.appearance].filter(Boolean).join('; ');
    const guess = fillBlank ? filledGuess(record, lookBefore, lookAfter) : settledGuess(record, lookBefore, lookAfter);
    if (guess.join() !== (Array.isArray(record.lookGuess) ? record.lookGuess : []).join()) next.lookGuess = guess;
    next.appearance = resolveNpcAppearance(next);
    return next;
}
