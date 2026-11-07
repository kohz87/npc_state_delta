/* NPC State Delta durable profile refinement: grounding/safety gates, morality and evolution checks,
   appearance correction, mannerism normalization and development-episode helpers. The implementation
   is split across core-durable-identity.js, core-durable-grounding.js and core-durable-episodes.js;
   this owner re-exports every name it exported before. */
export { identityMoralityMarkers, identityMoralityConflict, containsEvolutionLanguage, containsBehaviorEvolutionLanguage } from './core-durable-identity.js';
export { durableRefinementSupportText, speechSeedVetoed, speechSupportContext, durableRefinementCandidateGrounded, isSafeIdentityTextRefinement, isSafeSpeechRefinement, groundedAppearanceCorrection, presentationContinuationEvidence, npcScopedNarration, groundedAppearanceChange, isSafeUnmarkedDurableRefinement, isSafeUnmarkedDurableReplacement, isSafeUnmarkedDurableFieldReplacement, mergeDurableTextRefinement } from './core-durable-grounding.js';
export { mannerismSimilarity, normalizeMannerisms, isExplicitRecurringMannerism, filterSafeMannerismRefinements, developmentContextSegments, BATCH_EPISODE_MAX_CHARS, developmentBindingLabels, normalizedPhrasePresent, scopedEpisodeText } from './core-durable-episodes.js';
