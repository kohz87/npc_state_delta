/* NPC State Delta relationship mechanics facade: re-exports the relationship model, scoring,
   evidence/event history and durable text helpers from their focused parts. The original public
   exports remain unchanged; core-mechanics.js can continue importing and re-exporting them here.
   Never imports core-mechanics.js or core.js. */
export * from './core-relationship-model.js';
export * from './core-relationship-apply.js';
export * from './core-relationship-events.js';
export * from './core-relationship-text.js';
