// Cross-chat branch ancestry: choose the nearest proven parent checkpoint for an explicit host parent.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

import * as branchCore from './branch-core.js';
import { parseQualifiedChatKey } from './identity.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { BRANCH_LINEAGE_VERSION } from './branch-constants.js';
import { chatLineage, lineageCheckpointKeys, provenanceHint } from './branch-lineage.js';
import { ensureBranchFamilyId, normalizeBranchCheckpointsV3, pruneBranchCheckpoints } from './branch-checkpoints.js';
import { enforceUserDismissals } from './branch-recovery.js';

function candidateMatchesExplicitParent(key) {
    if (!provenanceHint.mainChat) return true;
    const parsed = parseQualifiedChatKey(key);
    return Boolean(parsed && parsed.chatId === provenanceHint.mainChat);
}

export function bestAncestorState(chats = {}, currentKey = '', currentChat = []) {
    if (!provenanceHint.mainChat) return null;
    const lineage = chatLineage(currentChat);
    const currentKeys = lineageCheckpointKeys(lineage);
    let best = null;

    for (const [key, state] of Object.entries(chats || {})) {
        if (key === currentKey || !candidateMatchesExplicitParent(key) || !state
            || Number(state.branchLineageVersion || 0) !== BRANCH_LINEAGE_VERSION
            || !Array.isArray(state.lineage) || !Array.isArray(state.checkpoints)) continue;

        const prefixLength = branchCore.commonPrefixLength(state.lineage, lineage);
        const hasRoot = Boolean(state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object');
        if (prefixLength < 1 && !hasRoot) continue;
        const sourceCheckpoints = normalizeBranchCheckpointsV3(state.checkpoints, state.lineage);
        let checkpoint = sourceCheckpoints
            .filter(item => item.messageId < prefixLength)
            .sort((left, right) => left.messageId - right.messageId || left.createdAt - right.createdAt)
            .at(-1);
        if (!checkpoint && hasRoot) checkpoint = { messageId: -1, lineageKey: 'root', createdAt: 0, snapshot: state.branchRootSnapshot };
        if (!checkpoint) continue;
        if (!best || checkpoint.messageId > best.checkpoint.messageId) {
            best = { key, state, checkpoint, sourceCheckpoints };
        }
    }

    if (!best) return null;
    const inherited = branchCore.restoreSnapshotIntoState({}, best.checkpoint.snapshot);
    inherited.lineage = lineage;
    inherited.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    inherited.checkpoints = best.checkpoint.messageId < 0 ? [] : pruneBranchCheckpoints(
        best.sourceCheckpoints
            .filter(item => item.messageId <= best.checkpoint.messageId)
            .map(item => ({ ...item, lineageKey: '', parentLineageKey: '', fingerprint: '' })),
        lineage,
    );
    inherited.inlineCards = best.checkpoint.messageId < 0 ? [] : structuredClone((best.state.inlineCards || []).filter(item => {
        const messageId = Number(item?.messageId);
        return Number.isInteger(messageId) && messageId >= 0 && messageId <= best.checkpoint.messageId && messageId < lineage.length;
    }).map(item => ({ ...item, fingerprint: lineage[item.messageId], lineageKey: currentKeys[item.messageId] })));
    inherited.portraitAssets = structuredClone(best.state.portraitAssets || {});
    inherited.formPortraitAssets = structuredClone(best.state.formPortraitAssets || {});
    inherited.userDismissedGroups = structuredClone(branchCore.normalizeUserDismissedGroups(best.state.userDismissedGroups));
    enforceUserDismissals(inherited, inherited.userDismissedGroups);
    // (timeline participant) A branch is the same story line: it keeps the parent's lineage, np_ map, reserved ids and applied deaths
    // (src/storysuite-participant/timeline.js); a dossier the fork point does not have is archived by the participant's next hydration.
    if (best.state.timeline && typeof best.state.timeline === 'object' && !Array.isArray(best.state.timeline)) inherited.timeline = structuredClone(best.state.timeline);
    inherited.branchParent = best.key;
    inherited.branchForkMessageId = best.checkpoint.messageId;
    inherited.branchFamilyId = String(best.state.branchFamilyId || '');
    ensureBranchFamilyId(inherited, best.key);
    prunePortraitAssetsInPlace(inherited);
    return inherited;
}
