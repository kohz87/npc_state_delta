// Trusted host glue for checked data, merged into story-block. Library discovery is read-only;
// every game-state write is a bus transaction, using detached pins and prefix witnesses.
// The implementation is split under data-modules/part/; this file keeps every public export's path.
export { validateDomain, resolveModule, moduleView, pinnedPresentation, grammarFor, replayInputs, dataModuleGuard } from './part/views.js';
export { tailRoom, summaryOf, CARD_SLOTS, blockCards } from './part/prompt.js';
export { settleReserve } from './part/timing.js';
export { createDataModulesPart } from './part/factory.js';
