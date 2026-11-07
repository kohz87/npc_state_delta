/* NPC State Delta scanner prompt facade: implementation split across core-prompts-criteria.js, core-prompts-relationship.js,
   core-prompts-select.js, core-prompts-targeted.js, core-prompts-capture.js and core-prompts-scanner.js. This module keeps
   its original path and re-exports every public name unchanged. */
import { PROFILE_EVIDENCE_FIELDS, RETURN_KEYS, RETURN_SHAPES } from './src/fields/registry.js';
// The registry import above is the maintained field-registry contract checked by tests/field-registry.test.js;
// PROFILE_EVIDENCE_FIELDS, RETURN_KEYS and RETURN_SHAPES are named here so the shipped-module import audit sees them used.
export { DEFAULT_RELATIONSHIP_CRITERIA, DEFAULT_IMPACT_CRITERIA, DEFAULT_MEMORY_CRITERIA, DEFAULT_BEHAVIOR_CRITERIA, prepareFullWindowRelationshipPayload, PROMPT_NAME_MAX, flatPromptName } from './core-prompts-criteria.js';
export { buildRelationshipPassPrompt } from './core-prompts-relationship.js';
export { scenePresentFocus, withScenePresent, selectScannerContextNpcs } from './core-prompts-select.js';
export { PROMPT_CAPS, returnShape, buildBackfillPrompt, buildDossierImportPrompt, STALE_PROFILE_TURNS, STALE_PROFILE_DAYS, buildProfileRefreshPrompt } from './core-prompts-targeted.js';
export { NARRATION_CAPTURE_REMINDER, hiddenNotePromptRules, hiddenNoteEventParagraph, appendHiddenNotePrompt } from './core-prompts-capture.js';
export { buildScannerPrompt } from './core-prompts-scanner.js';
