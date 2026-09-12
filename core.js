export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
export {
    normalizeNpcRecord,
    normalizeScanNpc,
    setNpcArchived,
    applyNpcStateCommand,
    mergeScanResult,
    buildNpcPortraitPrompts,
    buildInjection,
    buildScannerPrompt,
    buildBackfillPrompt,
    buildDossierImportPrompt,
    buildProfileRefreshPrompt,
} from './continuity-core.js';

// NPC State Delta application version. Persisted bundle, branch, and data schemas are versioned independently.
export const NPC_STATE_VERSION = '0.1.0';
