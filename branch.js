// NPC State Delta branch owner. The implementation lives in the cohesive branch-*.js parts beside this file;
// this file keeps the original path and public exports by re-exporting them, so importers never change.

export * from './branch-core.js';
export {
    BRANCH_LINEAGE_VERSION,
    BRANCH_SNAPSHOT_BUDGET_BYTES,
    BRANCH_SNAPSHOT_MAX_BYTES,
    ROLLBACK_JOURNAL_VERSION,
    ROLLBACK_JOURNAL_WINDOW_MESSAGES,
    ROLLBACK_JOURNAL_LIMIT,
    ROLLBACK_JOURNAL_BUDGET_BYTES,
} from './branch-constants.js';
export {
    setBranchProvenanceHint,
    fingerprintMessage,
    legacySystemFingerprint,
    remapLineageKeys,
    migrateLegacyLineage,
    chatLineage,
    lineageCheckpointKeys,
    lineageCheckpointKey,
} from './branch-lineage.js';
export { buildRollbackUndo, applyRollbackUndo } from './branch-rollback-undo.js';
export { pruneRollbackJournal, ensureRollbackJournalBaseline } from './branch-rollback-journal.js';
export { pruneBranchCheckpoints, ensureBranchParentAnchor, recordBranchCheckpoint } from './branch-checkpoints.js';
export { revertDeletedBlockEffects } from './branch-delete-recovery.js';
export { reconcileBranchState } from './branch-reconcile.js';
export { bestAncestorState } from './branch-ancestry.js';
