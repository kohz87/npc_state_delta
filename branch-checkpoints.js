// Full branch checkpoints: normalization, active/sibling retention budgets, parent anchors and recording.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

import * as branchCore from './branch-core.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { BRANCH_LINEAGE_VERSION, BRANCH_SNAPSHOT_BUDGET_BYTES, BRANCH_SNAPSHOT_MAX_BYTES } from './branch-constants.js';
import { branchHash, chatLineage, lineageCheckpointKeys, migrateLegacyLineage } from './branch-lineage.js';
import { utf8Bytes } from './branch-util.js';
import { appendRollbackMutation, ensureRollbackJournalBaseline, settleRollbackHead } from './branch-rollback-journal.js';

function checkpointBytes(item) {
    return utf8Bytes(item?.snapshot || {}) + 256;
}
export function ensureBranchFamilyId(state, seed = '') {
    if (!state || typeof state !== 'object') return '';
    const existing = String(state.branchFamilyId || '').trim();
    if (existing) return existing;
    let id = '';
    try { id = globalThis.crypto?.randomUUID?.() || ''; } catch { /* noop */ }
    if (!id) id = `bf-${branchHash(`${seed}|${Date.now()}|${Math.random()}`)}`;
    state.branchFamilyId = id;
    return id;
}

function normalizeCheckpointV3(raw, activeLineage = []) {
    if (!raw || typeof raw !== 'object' || !raw.snapshot || typeof raw.snapshot !== 'object') return null;
    const messageId = Number(raw.messageId);
    if (!Number.isInteger(messageId) || messageId < 0) return null;
    const existingKey = String(raw.lineageKey || '').trim();
    const existingFingerprint = String(raw.fingerprint || '').trim();
    let checkpoint;
    if (existingKey && existingFingerprint) {
        // A v3 checkpoint already carries its own branch identity. Never relabel it merely
        // because another sibling is currently active; doing so would graft the wrong snapshot
        // onto the current swipe. Active/sibling classification happens later by lineageKey.
        checkpoint = {
            ...raw,
            messageId,
            lineageKey: existingKey,
            fingerprint: existingFingerprint,
            parentLineageKey: String(raw.parentLineageKey || (messageId === 0 ? 'root' : '')),
            reason: String(raw.reason || 'state'),
            createdAt: Number(raw.createdAt || 0) || Date.now(),
        };
    } else {
        if (messageId >= activeLineage.length) return null;
        const keys = lineageCheckpointKeys(activeLineage);
        checkpoint = {
            ...raw,
            messageId,
            fingerprint: activeLineage[messageId],
            lineageKey: keys[messageId],
            parentLineageKey: messageId > 0 ? keys[messageId - 1] : 'root',
            reason: String(raw.reason || 'state'),
            createdAt: Number(raw.createdAt || 0) || Date.now(),
        };
    }
    return checkpointBytes(checkpoint) <= BRANCH_SNAPSHOT_MAX_BYTES ? checkpoint : null;
}

export function normalizeBranchCheckpointsV3(checkpoints = [], activeLineage = []) {
    const byKey = new Map();
    for (const raw of Array.isArray(checkpoints) ? checkpoints : []) {
        const checkpoint = normalizeCheckpointV3(raw, activeLineage);
        if (!checkpoint) continue;
        const existing = byKey.get(checkpoint.lineageKey);
        if (!existing || checkpoint.createdAt >= existing.createdAt) byKey.set(checkpoint.lineageKey, checkpoint);
    }
    return [...byKey.values()];
}

export function pruneBranchCheckpoints(checkpoints = [], activeLineage = [], limit = branchCore.BRANCH_HISTORY_LIMIT) {
    const cap = Math.max(8, Number(limit) || branchCore.BRANCH_HISTORY_LIMIT);
    const normalized = normalizeBranchCheckpointsV3(checkpoints, activeLineage);
    const activeKeys = new Set(lineageCheckpointKeys(activeLineage));
    const active = normalized.filter(item => activeKeys.has(item.lineageKey)).sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
    const siblings = normalized.filter(item => !activeKeys.has(item.lineageKey)).sort((a, b) => b.createdAt - a.createdAt || b.messageId - a.messageId);
    const keep = new Map();

    if (normalized.length <= cap) {
        for (const item of normalized) keep.set(item.lineageKey, item);
    } else {
        const siblingBudget = Math.min(siblings.length, Math.max(8, Math.floor(cap * 0.25)));
        const activeBudget = Math.max(1, cap - siblingBudget);
        if (active.length) {
            keep.set(active[0].lineageKey, active[0]);
            for (const item of active.slice(-Math.max(1, activeBudget - 1))) keep.set(item.lineageKey, item);
        }
        for (const item of siblings.slice(0, siblingBudget)) keep.set(item.lineageKey, item);
        if (!active.length) for (const item of normalized.slice(-cap)) keep.set(item.lineageKey, item);
    }

    const selected = [...keep.values()].sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
    if (!selected.length) return [];
    const budgeted = new Map();
    let used = 0;
    const oldestActive = selected.find(item => activeKeys.has(item.lineageKey)) || null;
    if (oldestActive) {
        const size = checkpointBytes(oldestActive);
        if (size <= BRANCH_SNAPSHOT_BUDGET_BYTES) {
            budgeted.set(oldestActive.lineageKey, oldestActive);
            used += size;
        }
    }
    for (const item of [...selected].sort((a, b) => b.createdAt - a.createdAt || b.messageId - a.messageId)) {
        if (budgeted.has(item.lineageKey)) continue;
        const size = checkpointBytes(item);
        if (size > BRANCH_SNAPSHOT_MAX_BYTES || used + size > BRANCH_SNAPSHOT_BUDGET_BYTES) continue;
        budgeted.set(item.lineageKey, item);
        used += size;
    }
    return [...budgeted.values()].sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
}

export function ensureBranchParentAnchor(state, chat, messageId, reason = 'parent-anchor', limit = branchCore.BRANCH_HISTORY_LIMIT) {
    if (!state || typeof state !== 'object' || !Number.isInteger(messageId) || messageId < 0) return state;
    migrateLegacyLineage(state, chat);
    const lineage = chatLineage(chat);
    const previousLineage = Array.isArray(state.lineage) ? state.lineage : [];
    ensureRollbackJournalBaseline(state, previousLineage.length ? previousLineage : lineage.slice(0, Math.max(0, messageId)));
    if (previousLineage.length) settleRollbackHead(state, previousLineage, 'turn-settled');
    state.lineage = lineage;
    state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    ensureBranchFamilyId(state, lineage.slice(0, 4).join('|'));
    if (messageId === 0) {
        if (!state.branchRootSnapshot || typeof state.branchRootSnapshot !== 'object') {
            const snapshot = branchCore.snapshotBranchState(state);
            state.branchRootSnapshot = utf8Bytes(snapshot) <= BRANCH_SNAPSHOT_MAX_BYTES ? snapshot : null;
        }
        prunePortraitAssetsInPlace(state);
        return state;
    }
    if (messageId > lineage.length - 1) return state;
    const keys = lineageCheckpointKeys(lineage);
    const parentId = messageId - 1;
    const parentKey = keys[parentId];
    const checkpoints = normalizeBranchCheckpointsV3(state.checkpoints, lineage);
    if (!checkpoints.some(item => item.lineageKey === parentKey)) {
        const snapshot = branchCore.snapshotBranchState(state);
        if (utf8Bytes(snapshot) <= BRANCH_SNAPSHOT_MAX_BYTES) checkpoints.push({
            messageId: parentId,
            fingerprint: lineage[parentId],
            lineageKey: parentKey,
            parentLineageKey: parentId > 0 ? keys[parentId - 1] : 'root',
            reason: String(reason || 'parent-anchor'),
            createdAt: Date.now(),
            rollbackSeq: Math.max(0, Number(state.rollbackHead?.seq || 0)),
            snapshot,
        });
    }
    state.checkpoints = pruneBranchCheckpoints(checkpoints, lineage, limit);
    prunePortraitAssetsInPlace(state);
    return state;
}

export function recordBranchCheckpoint(state, chat, messageId, reason = 'state', limit = branchCore.BRANCH_HISTORY_LIMIT) {
    if (!state || typeof state !== 'object') return state;
    migrateLegacyLineage(state, chat);
    const lineage = chatLineage(chat);
    if (!Number.isInteger(messageId) || messageId < 0 || messageId >= lineage.length) {
        state.lineage = lineage;
        state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
        ensureBranchFamilyId(state, lineage.slice(0, 4).join('|'));
        prunePortraitAssetsInPlace(state);
        return state;
    }
    const keys = lineageCheckpointKeys(lineage);
    const snapshot = branchCore.snapshotBranchState(state);
    const rollbackSeq = appendRollbackMutation(state, lineage, messageId, reason, snapshot);
    state.lineage = lineage;
    state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    ensureBranchFamilyId(state, lineage.slice(0, 4).join('|'));
    if (utf8Bytes(snapshot) <= BRANCH_SNAPSHOT_MAX_BYTES) {
        const checkpoint = {
            messageId,
            fingerprint: lineage[messageId],
            lineageKey: keys[messageId],
            parentLineageKey: messageId > 0 ? keys[messageId - 1] : 'root',
            reason: String(reason || 'state'),
            createdAt: Date.now(),
            rollbackSeq,
            snapshot,
        };
        const checkpoints = normalizeBranchCheckpointsV3(state.checkpoints, lineage);
        const existingIndex = checkpoints.findIndex(item => item.lineageKey === checkpoint.lineageKey);
        if (existingIndex >= 0) checkpoints[existingIndex] = checkpoint;
        else checkpoints.push(checkpoint);
        state.checkpoints = pruneBranchCheckpoints(checkpoints, lineage, limit);
    } else {
        state.checkpoints = pruneBranchCheckpoints(state.checkpoints, lineage, limit);
    }
    prunePortraitAssetsInPlace(state);
    return state;
}
