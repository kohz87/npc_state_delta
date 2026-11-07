// The bounded raw-message rollback journal: normalization, retention, baseline, append and settlement.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

import { ROLLBACK_JOURNAL_BUDGET_BYTES, ROLLBACK_JOURNAL_LIMIT, ROLLBACK_JOURNAL_VERSION, ROLLBACK_JOURNAL_WINDOW_MESSAGES } from './branch-constants.js';
import { lineageCheckpointKeys } from './branch-lineage.js';
import { utf8Bytes } from './branch-util.js';
import { applyRollbackUndo, buildRollbackUndo, rollbackSnapshot } from './branch-rollback-undo.js';

function normalizeRollbackJournalEntry(raw) {
    if (!raw || typeof raw !== 'object' || !raw.undo || typeof raw.undo !== 'object') return null;
    const seq = Number(raw.seq);
    const prevSeq = Number(raw.prevSeq);
    const messageId = Number(raw.messageId);
    const beforeMessageId = Number(raw.beforeMessageId);
    if (!Number.isInteger(seq) || seq <= 0 || !Number.isInteger(prevSeq) || prevSeq < 0) return null;
    if (!Number.isInteger(messageId) || messageId < 0) return null;
    return {
        ...raw,
        seq,
        prevSeq,
        messageId,
        beforeMessageId: Number.isInteger(beforeMessageId) ? beforeMessageId : Math.max(-1, messageId - 1),
        lineageKey: String(raw.lineageKey || ''),
        parentLineageKey: String(raw.parentLineageKey || ''),
        reason: String(raw.reason || 'state'),
        createdAt: Number(raw.createdAt || 0) || Date.now(),
    };
}

export function normalizeRollbackJournal(entries = []) {
    const bySeq = new Map();
    for (const raw of Array.isArray(entries) ? entries : []) {
        const entry = normalizeRollbackJournalEntry(raw);
        if (!entry) continue;
        const existing = bySeq.get(entry.seq);
        if (!existing || entry.createdAt >= existing.createdAt) bySeq.set(entry.seq, entry);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function rollbackEntryBytes(entry) {
    return utf8Bytes(entry) + 96;
}

export function pruneRollbackJournal(
    entries = [],
    headSeq = 0,
    limit = ROLLBACK_JOURNAL_LIMIT,
    headMessageId = null,
    floorMessageId = null,
    checkpointSeqs = [],
) {
    const cap = Math.max(64, Number(limit) || ROLLBACK_JOURNAL_LIMIT);
    const normalized = normalizeRollbackJournal(entries);
    if (!normalized.length) return [];
    const bySeq = new Map(normalized.map(entry => [entry.seq, entry]));
    const active = [];
    const activeSeqs = new Set();
    let cursor = Number(headSeq) || 0;
    // The active chain is authoritative. Never shorten the advertised raw-message rollback
    // window merely because its serialized bytes exceed a target; only stale/sibling extras
    // are byte-budgeted. A cycle or missing predecessor still terminates safely.
    while (cursor > 0) {
        const entry = bySeq.get(cursor);
        if (!entry || activeSeqs.has(entry.seq)) break;
        active.push(entry);
        activeSeqs.add(entry.seq);
        cursor = entry.prevSeq;
    }

    const resolvedHeadMessageId = Number.isInteger(headMessageId)
        ? headMessageId
        : (active[0]?.messageId ?? -1);
    const resolvedFloorMessageId = Number.isInteger(floorMessageId)
        ? floorMessageId
        : (resolvedHeadMessageId >= 0 ? resolvedHeadMessageId - ROLLBACK_JOURNAL_WINDOW_MESSAGES : -1);
    const keep = active.filter(entry => entry.messageId >= resolvedFloorMessageId);
    const keptSeqs = new Set(keep.map(entry => entry.seq));
    // Retained full checkpoints own their undo predecessors too. Their required history is
    // diagnostic-budgeted like the active chain; optional extras must not strand a revisit.
    for (const seq of checkpointSeqs) {
        let entry = bySeq.get(seq);
        while (entry && !keptSeqs.has(entry.seq) && entry.messageId >= resolvedFloorMessageId) {
            keep.push(entry);
            keptSeqs.add(entry.seq);
            entry = bySeq.get(entry.prevSeq);
        }
    }
    let used = keep.reduce((sum, entry) => sum + rollbackEntryBytes(entry), 0);

    // Recent sibling entries are opportunistic. They may improve branch revisits but can never
    // displace the contiguous active chain needed for the guaranteed chronological window.
    const remaining = normalized
        .filter(entry => !activeSeqs.has(entry.seq) && !keptSeqs.has(entry.seq))
        .filter(entry => entry.messageId >= resolvedFloorMessageId)
        .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
    for (const entry of remaining) {
        if (keep.length >= cap) break;
        const chain = [];
        const seen = new Set();
        let candidate = entry;
        while (candidate && !keptSeqs.has(candidate.seq) && !seen.has(candidate.seq)
            && candidate.messageId >= resolvedFloorMessageId) {
            chain.push(candidate);
            seen.add(candidate.seq);
            candidate = bySeq.get(candidate.prevSeq);
        }
        const size = chain.reduce((sum, item) => sum + rollbackEntryBytes(item), 0);
        if (keep.length + chain.length > cap || used + size > ROLLBACK_JOURNAL_BUDGET_BYTES) continue;
        keep.push(...chain);
        for (const item of chain) keptSeqs.add(item.seq);
        used += size;
    }
    return keep.sort((a, b) => a.seq - b.seq);
}

export function refreshRollbackJournalRetention(state) {
    if (!state || typeof state !== 'object') return state;
    const headMessageId = Number.isInteger(state.rollbackHead?.messageId) ? state.rollbackHead.messageId : -1;
    const baselineFloor = Number.isInteger(state.rollbackJournalFloorMessageId)
        ? state.rollbackJournalFloorMessageId
        : headMessageId;
    const rollingFloor = headMessageId >= 0 ? headMessageId - ROLLBACK_JOURNAL_WINDOW_MESSAGES : -1;
    const floorMessageId = Math.max(baselineFloor, rollingFloor);
    state.rollbackJournalFloorMessageId = floorMessageId;
    state.rollbackJournal = pruneRollbackJournal(
        state.rollbackJournal,
        state.rollbackHead?.seq,
        ROLLBACK_JOURNAL_LIMIT,
        headMessageId,
        floorMessageId,
        (state.checkpoints || []).map(checkpoint => checkpoint.rollbackSeq),
    );
    // If the last actual mutation aged out while the head advanced only across unchanged raw
    // messages, its sequence pointer must not dangle. The current head snapshot is a valid
    // baseline for the retained window because no canonical mutation occurred after that entry.
    if (Number(state.rollbackHead?.seq || 0) > 0
        && !state.rollbackJournal.some(entry => entry.seq === state.rollbackHead.seq)) {
        state.rollbackHead.seq = 0;
    }
    const bytes = state.rollbackJournal.reduce((sum, entry) => sum + rollbackEntryBytes(entry), 0);
    state.rollbackJournalBytes = bytes;
    state.rollbackJournalBudgetExceeded = bytes > ROLLBACK_JOURNAL_BUDGET_BYTES;
    state.rollbackJournalCoverageMessages = headMessageId >= floorMessageId
        ? Math.max(0, headMessageId - floorMessageId)
        : 0;
    return state;
}

export function ensureRollbackJournalBaseline(state, lineage = []) {
    if (!state || typeof state !== 'object') return state;
    const sourceLineage = Array.isArray(lineage) ? lineage : [];
    const keys = lineageCheckpointKeys(sourceLineage);
    state.rollbackJournalVersion = ROLLBACK_JOURNAL_VERSION;
    state.rollbackJournal = normalizeRollbackJournal(state.rollbackJournal);
    state.rollbackJournalSequence = Math.max(
        Number.isInteger(state.rollbackJournalSequence) ? state.rollbackJournalSequence : 0,
        ...state.rollbackJournal.map(entry => entry.seq),
        0,
    );

    const head = state.rollbackHead;
    if (!head || typeof head !== 'object' || !head.snapshot || typeof head.snapshot !== 'object') {
        const messageId = sourceLineage.length - 1;
        state.rollbackHead = {
            seq: 0,
            messageId,
            lineageKey: messageId >= 0 ? keys[messageId] : 'root',
            snapshot: rollbackSnapshot(state),
        };
        // This is the trustworthy baseline. Older history cannot be invented during an upgrade.
        state.rollbackJournalFloorMessageId = messageId;
        state.rollbackJournal = [];
        return refreshRollbackJournalRetention(state);
    }

    state.rollbackHead = {
        seq: Math.max(0, Number.isInteger(head.seq) ? head.seq : 0),
        messageId: Number.isInteger(head.messageId) ? head.messageId : sourceLineage.length - 1,
        lineageKey: String(head.lineageKey || ''),
        snapshot: structuredClone(head.snapshot),
    };
    state.rollbackJournalFloorMessageId = Number.isInteger(state.rollbackJournalFloorMessageId)
        ? state.rollbackJournalFloorMessageId
        : state.rollbackHead.messageId;
    return refreshRollbackJournalRetention(state);
}

export function appendRollbackMutation(state, lineage, messageId, reason, afterSnapshot) {
    ensureRollbackJournalBaseline(state, Array.isArray(state.lineage) ? state.lineage : lineage);
    const head = state.rollbackHead;
    const keys = lineageCheckpointKeys(lineage);

    // Multiple deterministic writers can checkpoint the same raw SillyTavern message (for
    // example scan then backfill). Coalesce them into one message-owned undo record by rebuilding
    // the delta from the earliest before-state to the latest accepted after-state.
    if (head?.seq > 0 && head.messageId === messageId && head.lineageKey === (keys[messageId] || '')) {
        const index = state.rollbackJournal.findIndex(entry => entry.seq === head.seq);
        const existing = index >= 0 ? state.rollbackJournal[index] : null;
        if (existing && existing.messageId === messageId && existing.lineageKey === head.lineageKey) {
            const earliest = applyRollbackUndo(head.snapshot, existing.undo).state;
            const combinedUndo = buildRollbackUndo(rollbackSnapshot(earliest), afterSnapshot);
            // The checkpoint at this exact lineage will be replaced below. Any other
            // checkpoint or descendant still owns the old version, including net-zero revisits.
            const referenced = state.rollbackJournal.some(entry => entry.prevSeq === existing.seq)
                || (state.checkpoints || []).some(checkpoint => checkpoint.rollbackSeq === existing.seq
                    && checkpoint.lineageKey !== head.lineageKey);
            let seq = existing.prevSeq;
            if (combinedUndo) {
                seq = referenced ? state.rollbackJournalSequence + 1 : existing.seq;
                const combined = {
                    ...existing, seq,
                    fingerprint: lineage[messageId] || existing.fingerprint || '',
                    lineageKey: keys[messageId] || existing.lineageKey || '',
                    parentLineageKey: messageId > 0 ? keys[messageId - 1] : 'root',
                    reason: String(reason || existing.reason || 'state'),
                    createdAt: Date.now(),
                    undo: combinedUndo,
                };
                if (referenced) state.rollbackJournal.push(combined);
                else state.rollbackJournal[index] = combined;
                state.rollbackJournalSequence = Math.max(state.rollbackJournalSequence, seq);
            } else if (!referenced) {
                state.rollbackJournal.splice(index, 1);
            }
            state.rollbackHead = {
                seq, messageId, lineageKey: keys[messageId] || '',
                snapshot: structuredClone(afterSnapshot),
            };
            refreshRollbackJournalRetention(state);
            return seq;
        }
    }

    const beforeSnapshot = head?.snapshot && typeof head.snapshot === 'object' ? head.snapshot : rollbackSnapshot(state);
    const undo = buildRollbackUndo(beforeSnapshot, afterSnapshot);
    if (undo) {
        const seq = Math.max(Number(state.rollbackJournalSequence || 0), ...state.rollbackJournal.map(entry => entry.seq), 0) + 1;
        const entry = {
            seq,
            prevSeq: Math.max(0, Number(head?.seq || 0)),
            messageId,
            beforeMessageId: Number.isInteger(head?.messageId) ? head.messageId : Math.max(-1, messageId - 1),
            fingerprint: lineage[messageId] || '',
            lineageKey: keys[messageId] || '',
            parentLineageKey: messageId > 0 ? keys[messageId - 1] : 'root',
            reason: String(reason || 'state'),
            createdAt: Date.now(),
            undo,
        };
        state.rollbackJournal.push(entry);
        state.rollbackJournalSequence = seq;
        state.rollbackHead = {
            seq,
            messageId,
            lineageKey: entry.lineageKey,
            snapshot: structuredClone(afterSnapshot),
        };
    } else {
        state.rollbackHead = {
            seq: Math.max(0, Number(head?.seq || 0)),
            messageId,
            lineageKey: keys[messageId] || String(head?.lineageKey || ''),
            snapshot: structuredClone(afterSnapshot),
        };
    }
    refreshRollbackJournalRetention(state);
    return state.rollbackHead.seq;
}

export function settleRollbackHead(state, lineage = [], reason = 'turn-settled') {
    if (!state || typeof state !== 'object' || !Array.isArray(lineage) || !lineage.length) return state;
    ensureRollbackJournalBaseline(state, lineage);
    const tailId = lineage.length - 1;
    const keys = lineageCheckpointKeys(lineage);
    const head = state.rollbackHead;
    if (Number.isInteger(head?.messageId) && head.messageId >= 0 && head.messageId < lineage.length
        && head.lineageKey && head.lineageKey !== keys[head.messageId]) return state;
    const currentSnapshot = rollbackSnapshot(state);
    if (buildRollbackUndo(head?.snapshot || {}, currentSnapshot)) {
        appendRollbackMutation(state, lineage, tailId, reason, currentSnapshot);
    } else if (head && (head.messageId !== tailId || head.lineageKey !== keys[tailId])) {
        state.rollbackHead = {
            seq: Math.max(0, Number(head.seq || 0)),
            messageId: tailId,
            lineageKey: keys[tailId] || 'root',
            snapshot: structuredClone(currentSnapshot),
        };
        refreshRollbackJournalRetention(state);
    }
    return state;
}
