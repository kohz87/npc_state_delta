/* NPC State Delta durable profile development. The implementation is split across
   core-development-time.js, core-development-episode.js, core-development-update.js and
   core-development-batch.js; this path keeps the original public exports and existing importers
   unchanged. Never imports core-mechanics.js or core.js. */

export { developmentEpisodeDiagnostic, developmentEpisodeEvidence, developmentScaleReady } from './core-development-episode.js';
export { applyDurableProfileUpdates, resolveInterimIdentityPromotions } from './core-development-batch.js';
