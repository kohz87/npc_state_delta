// Branch limits and journal constants shared by the split branch owners. A pure part of branch.js (same owner,
// moved without change); branch.js re-exports every public name it exported before. Never imports branch.js.

export const BRANCH_LINEAGE_VERSION = 5;
export const BRANCH_SNAPSHOT_BUDGET_BYTES = 8_000_000;
export const BRANCH_SNAPSHOT_MAX_BYTES = 2_000_000;
export const ROLLBACK_JOURNAL_VERSION = 2;
export const ROLLBACK_JOURNAL_WINDOW_MESSAGES = 256;
export const ROLLBACK_JOURNAL_LIMIT = 1024;
// Diagnostic target only. The guaranteed raw-message rollback window is never silently
// shortened to satisfy this value; structure-specific undo keeps ordinary journals below it.
export const ROLLBACK_JOURNAL_BUDGET_BYTES = 12_000_000;
