// Story Block's core module (§6, §7): the scene and inventory domains as one plain module definition
// for `sdk.registerModule`. This path keeps every public export; the core constants, kinds, part builder,
// merger, extra queries and module assembly live in domains/core/.

export { createPacksPart, createCoreModule } from './core/module.js';
export { CORE_MODULE_ID, CORE_BUDGET, CORE_STATIC, GEAR_ITEM_GRAMMAR, CORE_FEATURES, CORE_SETTINGS } from './core/constants.js';
export { youGrammar, CORE_KINDS } from './core/kinds.js';
export { createCorePart } from './core/part.js';
export { mergeParts } from './core/merge.js';
export { chatterBack, headMoved } from './core/extra.js';
