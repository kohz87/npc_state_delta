// Reconciliation of one chat's branch state after swipes, deletes, edits and rewinds: exact journal or
// checkpoint recovery, fail-closed handling, portrait/asset restoration and the rescan decision.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

import * as branchCore from './branch-core.js';
import { portraitHasImage } from './src/portrait-file.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { BRANCH_LINEAGE_VERSION, ROLLBACK_JOURNAL_VERSION } from './branch-constants.js';
import { chatLineage, lineageCheckpointKeys, migrateLegacyLineage } from './branch-lineage.js';
import { cloneNpcList } from './branch-util.js';
import { rollbackSnapshot } from './branch-rollback-undo.js';
import { ensureRollbackJournalBaseline, normalizeRollbackJournal, refreshRollbackJournalRetention, settleRollbackHead } from './branch-rollback-journal.js';
import { ensureBranchFamilyId, normalizeBranchCheckpointsV3, pruneBranchCheckpoints } from './branch-checkpoints.js';
import { assistantMessageCountAtOrAfter, enforceUserDismissals, latestAssistantMessageId, matchingCheckpoints, restoreLinearBoundaryFromJournal, retainLinearPrefixHistory } from './branch-recovery.js';
import { cleanupRemovedNpcs, revertDeletedBlockEffects } from './branch-delete-recovery.js';

function normalizedRecoveryOperation(value) {
    const operation = String(value || 'auto').toLowerCase();
    return ['delete', 'edit', 'swipe'].includes(operation) ? operation : 'auto';
}

export function reconcileBranchState(state, chat, { explicitDivergence = null, operation = 'auto', rewindMidDelete = false } = {}) {
    // Permanent UI deletion is external user authority, not narrative branch state. Normalize
    // it before establishing any rollback baseline so an old label tombstone or stale snapshot
    // cannot become a new journal mutation merely because content lineage stayed unchanged.
    enforceUserDismissals(state, state?.userDismissedGroups);
    if (state && typeof state === 'object') migrateLegacyLineage(state, chat);
    const currentLineage = chatLineage(chat);
    const previousLineage = Array.isArray(state?.lineage) ? state.lineage : [];
    ensureRollbackJournalBaseline(state, previousLineage.length ? previousLineage : currentLineage);
    const relation = branchCore.classifyLineageRelationship(previousLineage, currentLineage);
    const recoveryOperation = normalizedRecoveryOperation(operation);
    const linearReplacement = recoveryOperation === 'delete' || recoveryOperation === 'edit';

    // v5 makes narrative content authoritative for destructive continuity. Host metadata changes
    // and explicit event indexes cannot turn identical content into a rollback. A loaded sidecar
    // whose lineage is merely an exact prefix of the live chat is likewise just behind.
    const hasExplicitDivergence = Number.isInteger(explicitDivergence) && explicitDivergence >= 0;
    if (relation.kind === 'forward-extension' || relation.kind === 'same') {
        settleRollbackHead(state, currentLineage, relation.kind);
        state.lineage = currentLineage;
        prunePortraitAssetsInPlace(state);
        return {
            state: { ...state, lineage: currentLineage },
            divergence: relation.kind === 'same' ? -1 : relation.divergence,
            lineageRelation: relation.kind,
            recoveryOperation,
            recoveryAction: relation.kind === 'same' ? 'content-unchanged' : 'forward-extension',
            requiresRescan: false,
            restoredFromMessageId: null,
            invalidated: false,
            exactRestored: false,
            failClosed: false,
        };
    }

    let divergence = relation.kind === 'same' ? explicitDivergence : relation.divergence;
    // Narrative content owns destructive recovery: a delete/edit event index is only a hint and may
    // not move recovery before the first message whose content actually changed (a stale index from
    // a hide or earlier settlement would roll back retained messages).
    if (hasExplicitDivergence && relation.kind !== 'same' && !linearReplacement) {
        divergence = Math.min(divergence, explicitDivergence);
    }

    const currentNpcs = cloneNpcList(state?.npcs);
    const checkpoints = normalizeBranchCheckpointsV3(state?.checkpoints, previousLineage);
    const matches = matchingCheckpoints(checkpoints, currentLineage);
    const deepestMatch = matches.at(-1) || null;
    const lastAssistantId = latestAssistantMessageId(chat);
    const requestedRecoveryMessageId = Number.isInteger(divergence) ? divergence - 1 : null;
    const exactBoundaryCheckpoint = Number.isInteger(requestedRecoveryMessageId) && requestedRecoveryMessageId >= 0
        ? matches.filter(item => item.messageId === requestedRecoveryMessageId).at(-1) || null
        : null;
    const nearestOlderCheckpoint = Number.isInteger(requestedRecoveryMessageId) && requestedRecoveryMessageId >= 0
        ? matches.filter(item => item.messageId < requestedRecoveryMessageId).at(-1) || null
        : null;
    const explicitSwipeLike = recoveryOperation === 'swipe' || (recoveryOperation === 'auto' && hasExplicitDivergence);
    // A checkpoint whose full lineage matches the live chat through the latest assistant is an
    // exact sibling/current-branch restore regardless of which host path surfaced the change.
    const exactCurrentCheckpoint = deepestMatch && deepestMatch.messageId >= lastAssistantId
        ? deepestMatch
        : null;
    const affectedAssistantMessages = assistantMessageCountAtOrAfter(chat, divergence);
    // A single affected assistant exchange can be rebuilt immediately after restoring its exact
    // parent. Multiple retained assistant descendants cannot be deterministically replayed by the
    // routine scanner, so rewinding them would destroy accepted continuity; preserve canonical
    // state and fail closed instead.
    const suffixReplayable = !linearReplacement || affectedAssistantMessages <= 1;
    // Opt-in: a deleted middle message rewinds every dossier to the exact state just before it, so
    // whatever the retained messages changed is discarded rather than replayed. It uses the same
    // exact journal/checkpoint boundary as a tail deletion; when that boundary is unreachable the
    // ordinary fail-closed path (undoing only the deleted block) still applies.
    const rewindRequested = rewindMidDelete === true && recoveryOperation === 'delete' && !suffixReplayable;
    const linearSuffixReplaySafe = suffixReplayable || rewindRequested;
    const recoveryBlockedByRetainedDescendants = linearReplacement && !suffixReplayable;
    const tailTruncationRecovery = relation.kind === 'tail-truncation';
    const journalRestore = tailTruncationRecovery || (linearReplacement && linearSuffixReplaySafe)
        ? restoreLinearBoundaryFromJournal(state, previousLineage, currentLineage, divergence)
        : null;
    const journalTargetReachable = Boolean(journalRestore);
    const exactCheckpointAvailable = Boolean(exactBoundaryCheckpoint);
    const olderCheckpointRejected = Boolean(nearestOlderCheckpoint && !journalRestore && !exactBoundaryCheckpoint);
    const recoveryDistance = olderCheckpointRejected
        ? Math.max(0, requestedRecoveryMessageId - nearestOlderCheckpoint.messageId)
        : null;
    let restored;
    let checkpoint;
    let exactRestored = false;
    let restoredFromJournal = false;
    let restoredFromRoot = false;
    let failClosed = false;
    let deletedEffects = { reverted: [], removed: [], socialEdges: 0 };
    let journalHeadSeq = null;
    let recoveryAction = 'fail-closed';
    if ((linearReplacement || tailTruncationRecovery) && journalRestore) {
        restored = journalRestore.state;
        exactRestored = true;
        restoredFromJournal = true;
        journalHeadSeq = journalRestore.headSeq;
        recoveryAction = 'rollback-journal';
    } else if ((tailTruncationRecovery || (linearReplacement && linearSuffixReplaySafe)) && exactBoundaryCheckpoint) {
        checkpoint = exactBoundaryCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        exactRestored = true;
        recoveryAction = 'exact-checkpoint';
    } else if (exactCurrentCheckpoint) {
        checkpoint = exactCurrentCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        exactRestored = true;
        recoveryAction = 'exact-checkpoint';
    } else if (explicitSwipeLike && exactBoundaryCheckpoint) {
        checkpoint = exactBoundaryCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        recoveryAction = 'exact-parent-checkpoint';
    } else if (explicitSwipeLike && divergence === 0
        && state?.branchRootSnapshot && typeof state.branchRootSnapshot === 'object') {
        restored = branchCore.restoreSnapshotIntoState(state, state.branchRootSnapshot);
        restoredFromRoot = true;
        recoveryAction = 'explicit-root';
    } else {
        // Recovery is exact-boundary only. An older checkpoint is evidence about an older story,
        // never permission to substitute that story for the requested parent. Keep canonical
        // state and rebase ownership when the exact journal/checkpoint proof is unavailable.
        restored = { ...state };
        failClosed = true;
        recoveryAction = 'fail-closed-keep-current';
        if (recoveryBlockedByRetainedDescendants && recoveryOperation === 'delete') {
            restored.npcs = cloneNpcList(state?.npcs);
            restored.candidates = Array.isArray(state?.candidates) ? structuredClone(state.candidates) : [];
            restored.pendingBackfills = Array.isArray(state?.pendingBackfills) ? structuredClone(state.pendingBackfills) : [];
            restored.socialGraph = structuredClone(state?.socialGraph || { edges: [], unresolved: [] });
            deletedEffects = revertDeletedBlockEffects(state, restored, checkpoints, previousLineage, currentLineage, divergence);
            cleanupRemovedNpcs(restored, deletedEffects.removed, state?.npcs);
        }
    }
    restored.npcs = branchCore.preserveUserNpcMetadata(restored.npcs, currentNpcs);
    // A journal/checkpoint snapshot intentionally omits portrait binaries. When an NPC
    // is restored after having disappeared from the current cast, reattach any retained
    // user-owned asset before ordinary portrait GC runs.
    for (const npc of Array.isArray(restored.npcs) ? restored.npcs : []) {
        const asset = state?.portraitAssets?.[npc?.id];
        if (!portraitHasImage(npc?.portrait) && portraitHasImage(asset)) npc.portrait = structuredClone(asset);
    }
    enforceUserDismissals(restored, state?.userDismissedGroups);
    restored.lineage = currentLineage;
    restored.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    restored.branchFamilyId = String(state?.branchFamilyId || restored.branchFamilyId || '');
    ensureBranchFamilyId(restored, currentLineage.slice(0, 4).join('|'));
    restored.rollbackJournalVersion = ROLLBACK_JOURNAL_VERSION;
    restored.rollbackJournalSequence = Math.max(0, Number(state?.rollbackJournalSequence || 0));
    if (linearReplacement) {
        // Delete/regenerate and edit are linear replacement operations. Their discarded
        // descendants are disposable history, not sibling branches competing for snapshot budget.
        retainLinearPrefixHistory(restored, state, checkpoints, currentLineage, divergence);
    } else {
        restored.checkpoints = pruneBranchCheckpoints(checkpoints, currentLineage);
        restored.inlineCards = Array.isArray(state?.inlineCards) ? structuredClone(state.inlineCards) : [];
        restored.rollbackJournal = normalizeRollbackJournal(state?.rollbackJournal);
    }
    const restoredTailId = currentLineage.length - 1;
    const restoredKeys = lineageCheckpointKeys(currentLineage);
    const restoredBoundaryMessageId = restoredFromJournal
        ? journalRestore.targetMessageId
        : (restoredFromRoot ? -1 : (checkpoint?.messageId ?? null));
    const restoredHistoricalBoundary = restoredFromJournal || restoredFromRoot || Boolean(checkpoint);
    let restoredHeadSeq = 0;
    if (restoredFromJournal) restoredHeadSeq = Math.max(0, Number(journalHeadSeq || 0));
    else if (Number.isInteger(checkpoint?.rollbackSeq)
        && checkpoint.rollbackSeq >= 0
        && (checkpoint.rollbackSeq === 0 || restored.rollbackJournal.some(entry => entry.seq === checkpoint.rollbackSeq))) {
        restoredHeadSeq = checkpoint.rollbackSeq;
    }
    // If the predecessor entry fell just outside the retained message window, this restored
    // boundary becomes the new safe baseline instead of retaining a dangling sequence pointer.
    if (restoredHeadSeq > 0 && !restored.rollbackJournal.some(entry => entry.seq === restoredHeadSeq)) restoredHeadSeq = 0;
    const rollbackHeadMessageId = restoredHistoricalBoundary && Number.isInteger(restoredBoundaryMessageId)
        ? restoredBoundaryMessageId
        : restoredTailId;
    restored.rollbackHead = {
        seq: restoredHeadSeq,
        messageId: rollbackHeadMessageId,
        lineageKey: rollbackHeadMessageId >= 0 ? restoredKeys[rollbackHeadMessageId] : 'root',
        snapshot: rollbackSnapshot(restored),
    };
    restored.rollbackJournalFloorMessageId = restoredHeadSeq > 0
        ? Math.min(rollbackHeadMessageId, Number(state?.rollbackJournalFloorMessageId ?? rollbackHeadMessageId))
        : rollbackHeadMessageId;
    refreshRollbackJournalRetention(restored);
    if (!exactRestored) {
        if (Number.isInteger(restored.lastScannedMessageId) && restored.lastScannedMessageId >= divergence) restored.lastScannedMessageId = null;
        // Replies read ahead from the changed message on are not the ones the chat holds now.
        const readPastChange = Array.isArray(restored.readAhead) && restored.readAhead.some(id => Number.isInteger(id) && id >= divergence);
        if (Array.isArray(restored.readAhead)) restored.readAhead = restored.readAhead.filter(id => Number.isInteger(id) && id < divergence);
        // A fail-closed restore keeps the current state, which already holds what was read ahead past the change. Those replies can no
        // longer be told apart, so as in 1.9.0 the next scan reads the latest reply only instead of reading them a second time.
        if (failClosed && readPastChange) { restored.lastScannedMessageId = null; restored.readAhead = []; }
    }
    prunePortraitAssetsInPlace(restored);
    const rewound = rewindRequested && exactRestored;
    const requiresRescan = linearReplacement
        ? affectedAssistantMessages > 0 && !rewound
        : (explicitSwipeLike ? recoveryAction !== 'exact-checkpoint' : !exactRestored);
    return {
        state: restored,
        divergence,
        lineageRelation: relation.kind,
        recoveryOperation,
        recoveryAction,
        requestedRecoveryMessageId,
        affectedAssistantMessages,
        linearSuffixReplaySafe,
        recoveryBlockedByRetainedDescendants,
        journalTargetReachable,
        exactCheckpointAvailable,
        nearestOlderCheckpointMessageId: nearestOlderCheckpoint?.messageId ?? null,
        olderCheckpointRejected,
        recoveryDistance,
        requiresRescan,
        restoredFromMessageId: restoredHistoricalBoundary ? restoredBoundaryMessageId : null,
        restoredLineageKey: restoredHistoricalBoundary ? (restored.rollbackHead?.lineageKey || '') : '',
        invalidated: true,
        exactRestored,
        restoredFromJournal,
        restoredFromRoot,
        failClosed,
        deletedEffects,
        rewoundToBoundary: rewindRequested && exactRestored,
        linearHistoryPruned: linearReplacement,
        legacyFallback: failClosed && checkpoints.length === 0 && !state?.branchRootSnapshot,
    };
}
