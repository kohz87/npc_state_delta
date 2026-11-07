// Recovery helpers for lineage settlement and delete/edit boundaries: user dismissals, message positions,
// matching checkpoints, linear journal restore and prefix retention. A pure part of branch.js (same owner,
// moved without change); branch.js re-exports every public name it exported before. Never imports branch.js.

import * as branchCore from './branch-core.js';
import { normalizeName } from './core.js';
import { purgeNpcStructuredReferences, removeNpcFromSocialGraph } from './social.js';
import { lineageCheckpointKeys } from './branch-lineage.js';
import { pruneBranchCheckpoints } from './branch-checkpoints.js';
import { applyRollbackUndo } from './branch-rollback-undo.js';
import { ensureRollbackJournalBaseline, normalizeRollbackJournal } from './branch-rollback-journal.js';

function npcLabels(npc) {
    return [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(normalizeName).filter(Boolean);
}

export function enforceUserDismissals(state, groups) {
    const normalizedGroups = branchCore.normalizeUserDismissedGroups(groups);
    const blockedIds = new Set(normalizedGroups.flatMap(group => group.ids));
    const historicalBlockedLabels = new Set(normalizedGroups.filter(group => !group.ids.length).flatMap(group => group.labels));
    const modernBlockedLabels = new Set(normalizedGroups.filter(group => group.ids.length).flatMap(group => group.labels));
    state.userDismissedGroups = normalizedGroups;
    if (!blockedIds.size && !historicalBlockedLabels.size) return state;
    const blockedNpc = npc => blockedIds.has(String(npc?.id || '')) || npcLabels(npc).some(label => historicalBlockedLabels.has(label));
    const removedNpcs = (Array.isArray(state.npcs) ? state.npcs : []).filter(blockedNpc);
    state.npcs = (Array.isArray(state.npcs) ? state.npcs : []).filter(npc => !blockedNpc(npc));
    for (const removedNpc of removedNpcs) {
        state.socialGraph = removeNpcFromSocialGraph(state.socialGraph, removedNpc.id);
        purgeNpcStructuredReferences(state.npcs, removedNpc);
    }
    state.candidates = (Array.isArray(state.candidates) ? state.candidates : []).filter(candidate => {
        if (blockedIds.has(String(candidate?.id || ''))) return false;
        return !npcLabels(candidate).some(label => historicalBlockedLabels.has(label));
    });
    state.pendingBackfills = (Array.isArray(state.pendingBackfills) ? state.pendingBackfills : []).filter(item => {
        if (blockedIds.has(String(item?.npcId || ''))) return false;
        const label = normalizeName(item?.label);
        return !label || !historicalBlockedLabels.has(label);
    });
    const existingDismissed = (Array.isArray(state.dismissed) ? state.dismissed : [])
        .map(normalizeName)
        .filter(label => label && !modernBlockedLabels.has(label));
    state.dismissed = [...new Set([...existingDismissed, ...historicalBlockedLabels])];
    return state;
}

export function latestAssistantMessageId(chat = []) {
    for (let i = (Array.isArray(chat) ? chat.length : 0) - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system && String(message.mes || '').trim()) return i;
    }
    return -1;
}

export function assistantMessageCountAtOrAfter(chat = [], messageId = 0) {
    const start = Math.max(0, Number.isInteger(messageId) ? messageId : 0);
    return (Array.isArray(chat) ? chat : []).slice(start).filter(message => (
        message && !message.is_user && !message.is_system && String(message.mes || '').trim()
    )).length;
}

export function matchingCheckpoints(checkpoints, lineage) {
    const keys = lineageCheckpointKeys(lineage);
    return checkpoints
        .filter(item => Number.isInteger(item?.messageId) && item.messageId >= 0 && item.messageId < keys.length)
        .filter(item => item.lineageKey === keys[item.messageId])
        .sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
}

export function restoreLinearBoundaryFromJournal(state, previousLineage, currentLineage, divergence) {
    if (!Number.isInteger(divergence) || divergence < 0) return null;
    if (!Array.isArray(previousLineage) || !Array.isArray(currentLineage)) return null;
    if (divergence > previousLineage.length || divergence > currentLineage.length) return null;
    for (let i = 0; i < divergence; i += 1) {
        if (previousLineage[i] !== currentLineage[i]) return null;
    }

    ensureRollbackJournalBaseline(state, previousLineage);
    const head = state.rollbackHead;
    if (!head?.snapshot || typeof head.snapshot !== 'object') return null;
    const targetMessageId = divergence - 1;
    const floorMessageId = Number.isInteger(state.rollbackJournalFloorMessageId)
        ? state.rollbackJournalFloorMessageId
        : head.messageId;
    if (targetMessageId < floorMessageId) return null;

    const previousKeys = lineageCheckpointKeys(previousLineage);
    if (Number.isInteger(head.messageId) && head.messageId >= 0 && head.messageId < previousKeys.length
        && head.lineageKey && head.lineageKey !== previousKeys[head.messageId]) return null;

    const entries = normalizeRollbackJournal(state.rollbackJournal);
    const bySeq = new Map(entries.map(entry => [entry.seq, entry]));
    let cursorSeq = Math.max(0, Number(head.seq || 0));
    let cursorMessageId = Number.isInteger(head.messageId) ? head.messageId : previousLineage.length - 1;
    let working = branchCore.restoreSnapshotIntoState(state, head.snapshot);
    let applied = 0;

    while (cursorMessageId >= divergence) {
        if (cursorSeq <= 0) {
            // The head can legitimately advance across raw messages that caused no canonical
            // mutation. If no mutation remains at/after the replacement boundary, the working
            // snapshot already equals the requested parent boundary.
            cursorMessageId = targetMessageId;
            break;
        }
        const entry = bySeq.get(cursorSeq);
        if (!entry) return null;
        if (entry.messageId < divergence) {
            // Unchanged raw-message boundaries may sit between the surviving mutation and the
            // requested parent. Do not undo a mutation owned by the surviving prefix.
            cursorMessageId = targetMessageId;
            break;
        }
        if (entry.messageId > cursorMessageId) return null;
        if (entry.messageId >= previousKeys.length || entry.lineageKey !== previousKeys[entry.messageId]) return null;
        const reverted = applyRollbackUndo(working, entry.undo);
        working = reverted.state;
        cursorSeq = entry.prevSeq;
        cursorMessageId = entry.beforeMessageId;
        applied += 1;
    }

    if (cursorMessageId >= divergence) return null;
    return { state: working, headSeq: cursorSeq, applied, floorMessageId, targetMessageId };
}

export function retainLinearPrefixHistory(target, source, checkpoints, currentLineage, divergence) {
    const cutoff = Math.max(0, Number(divergence) || 0);
    target.checkpoints = pruneBranchCheckpoints(
        checkpoints.filter(item => item.messageId < cutoff),
        currentLineage,
    );
    target.inlineCards = (Array.isArray(source?.inlineCards) ? source.inlineCards : [])
        .filter(item => {
            const messageId = Number(item?.messageId);
            return Number.isInteger(messageId) && messageId >= 0 && messageId < cutoff;
        })
        .map(item => structuredClone(item));
    target.rollbackJournal = normalizeRollbackJournal(source?.rollbackJournal)
        .filter(entry => entry.messageId < cutoff);
    return target;
}
