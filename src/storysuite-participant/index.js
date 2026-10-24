// NPC State Delta's timeline participant (track B6; Story Block docs/v2/TIMELINE.md): see participant.js. New files only; Delta's own
// modules, its prompts and its storage are untouched. The registration in src/storysuite-v2.js (`participant`, the `npc.identity` query,
// the runtime port) is the lead's wiring.

export { MODULE_ID, confirmedDeath, createParticipant } from './participant.js';
export { PARTICIPANT_SCHEMA, buildCheckpoint, checkpointIdOf, checkpointProblem } from './checkpoint.js';
export { NP_ID, hydrateIdentity, resolveIdentity } from './identity.js';
export { LINEAGE_ID, cleanTimeline, mintLineage, restoredState, storedTimeline, timelineOf } from './timeline.js';
export { fileVault, memoryVault } from './vault.js';
