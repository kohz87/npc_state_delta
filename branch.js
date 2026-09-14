import * as branchCore from './branch-core.js';
import { normalizeName } from './core.js';
import { parseQualifiedChatKey } from './identity.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { normalizeSocialGraph, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';

export * from './branch-core.js';

export const BRANCH_LINEAGE_VERSION = 5;
export const BRANCH_SNAPSHOT_BUDGET_BYTES = 2_000_000;
export const BRANCH_SNAPSHOT_BUDGET_CHARS = BRANCH_SNAPSHOT_BUDGET_BYTES;
export const BRANCH_SNAPSHOT_MAX_BYTES = 750_000;
export const ROLLBACK_JOURNAL_VERSION = 2;
export const ROLLBACK_JOURNAL_WINDOW_MESSAGES = 256;
export const ROLLBACK_JOURNAL_LIMIT = 1024;
// Diagnostic target only. The guaranteed raw-message rollback window is never silently
// shortened to satisfy this value; structure-specific undo keeps ordinary journals below it.
export const ROLLBACK_JOURNAL_BUDGET_BYTES = 12_000_000;
// Kept as a compatibility export for older diagnostics/tests. v1.0.8 no longer uses an
// entry-count floor to override the raw-message retention contract.
export const ROLLBACK_JOURNAL_MIN_ACTIVE_ENTRIES = 0;

let provenanceHint = Object.freeze({ mainChat: '', ownerScope: '', currentKey: '' });

export function setBranchProvenanceHint({ mainChat = '', ownerScope = '', currentKey = '' } = {}) {
    provenanceHint = Object.freeze({
        mainChat: String(mainChat || '').replace(/\.jsonl$/i, '').trim(),
        ownerScope: String(ownerScope || '').trim(),
        currentKey: String(currentKey || '').trim(),
    });
}

function fnv1a32(text, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    const input = String(text ?? '');
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function branchHash(text) {
    const input = String(text ?? '');
    return `${fnv1a32(input, 0x811c9dc5)}.${fnv1a32(input, 0x9e3779b9)}`;
}

function legacyV3FingerprintMessage(message = {}) {
    const payload = JSON.stringify({
        user: Boolean(message.is_user),
        system: Boolean(message.is_system),
        text: String(message.mes || ''),
    });
    return branchHash(payload);
}

export function legacyChatLineageV3(chat = []) {
    return (Array.isArray(chat) ? chat : []).map(legacyV3FingerprintMessage);
}

function legacyV4MessageInstanceIdentity(message = {}) {
    const sendDate = String(message.send_date ?? '').trim();
    if (sendDate) return `date:${sendDate}`;
    const generationId = String(message?.extra?.gen_id ?? '').trim();
    if (generationId) return `gen:${generationId}`;
    return '';
}

function legacyV4FingerprintMessage(message = {}) {
    const payload = JSON.stringify({
        user: Boolean(message.is_user),
        system: Boolean(message.is_system),
        text: String(message.mes || ''),
        instance: legacyV4MessageInstanceIdentity(message),
    });
    return branchHash(payload);
}

export function legacyChatLineageV4(chat = []) {
    return (Array.isArray(chat) ? chat : []).map(legacyV4FingerprintMessage);
}

export function fingerprintMessage(message = {}) {
    // v5 destructive lineage is narrative-content based. SillyTavern's send_date, gen_id and
    // swipe indexes are mutable host metadata, so they may help the host identify an alternate
    // but must never make Delta roll canonical dossier state backward by themselves.
    return legacyV3FingerprintMessage(message);
}

export function chatLineage(chat = []) {
    return (Array.isArray(chat) ? chat : []).map(fingerprintMessage);
}

export function lineageCheckpointKeys(lineage = []) {
    const source = Array.isArray(lineage) ? lineage : [];
    const keys = [];
    let parent = 'root';
    for (let i = 0; i < source.length; i += 1) {
        parent = branchHash(`${parent}|${i}|${source[i]}`);
        keys.push(parent);
    }
    return keys;
}

export function lineageCheckpointKey(lineage = [], messageId = -1) {
    if (!Number.isInteger(messageId) || messageId < 0) return '';
    return lineageCheckpointKeys(lineage)[messageId] || '';
}

function utf8Bytes(value) {
    try { return new TextEncoder().encode(JSON.stringify(value ?? {})).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
}

function checkpointBytes(item) {
    return utf8Bytes(item?.snapshot || {}) + 256;
}

const ROLLBACK_SCALAR_KEYS = Object.freeze([
    'turn',
    'assistantSinceScan',
    'lastScanAt',
    'lastScannedMessageId',
    'scanCount',
]);

function jsonEqual(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
}

function rollbackSnapshot(state) {
    return branchCore.snapshotBranchState(state || {});
}

function rollbackNpcMap(npcs = []) {
    const map = new Map();
    for (const npc of Array.isArray(npcs) ? npcs : []) {
        const id = String(npc?.id || '').trim();
        if (!id || map.has(id)) return null;
        map.set(id, npc);
    }
    return map;
}

function buildNpcUndo(beforeNpcs = [], afterNpcs = []) {
    const beforeMap = rollbackNpcMap(beforeNpcs);
    const afterMap = rollbackNpcMap(afterNpcs);
    if (!beforeMap || !afterMap) {
        return jsonEqual(beforeNpcs, afterNpcs) ? null : { full: structuredClone(beforeNpcs) };
    }

    const changes = [];
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    for (const id of ids) {
        const before = beforeMap.get(id);
        const after = afterMap.get(id);
        if (!before && after) {
            changes.push({ id, remove: true });
            continue;
        }
        if (before && !after) {
            changes.push({ id, restore: structuredClone(before) });
            continue;
        }
        if (!before || !after || jsonEqual(before, after)) continue;

        const fields = {};
        const deleteFields = [];
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of keys) {
            const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
            const afterHas = Object.prototype.hasOwnProperty.call(after, key);
            if (beforeHas && afterHas && jsonEqual(before[key], after[key])) continue;
            if (!beforeHas && afterHas) deleteFields.push(key);
            else if (beforeHas) fields[key] = structuredClone(before[key]);
        }
        if (Object.keys(fields).length || deleteFields.length) changes.push({ id, fields, deleteFields });
    }

    const beforeOrder = [...beforeMap.keys()];
    const afterOrder = [...afterMap.keys()];
    const order = jsonEqual(beforeOrder, afterOrder) ? null : beforeOrder;
    if (!changes.length && !order) return null;
    return { changes, order };
}


function keyedRecordUndo(beforeItems = [], afterItems = []) {
    const before = Array.isArray(beforeItems) ? beforeItems : [];
    const after = Array.isArray(afterItems) ? afterItems : [];
    const beforeMap = new Map();
    const afterMap = new Map();
    for (const item of before) {
        const id = String(item?.id || '').trim();
        if (!id || beforeMap.has(id)) return jsonEqual(before, after) ? null : { full: structuredClone(before) };
        beforeMap.set(id, item);
    }
    for (const item of after) {
        const id = String(item?.id || '').trim();
        if (!id || afterMap.has(id)) return jsonEqual(before, after) ? null : { full: structuredClone(before) };
        afterMap.set(id, item);
    }

    const changes = [];
    for (const id of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
        const beforeItem = beforeMap.get(id);
        const afterItem = afterMap.get(id);
        if (!beforeItem && afterItem) changes.push({ id, remove: true });
        else if (beforeItem && !afterItem) changes.push({ id, restore: structuredClone(beforeItem) });
        else if (beforeItem && afterItem && !jsonEqual(beforeItem, afterItem)) changes.push({ id, restore: structuredClone(beforeItem) });
    }
    const beforeOrder = [...beforeMap.keys()];
    const afterOrder = [...afterMap.keys()];
    const order = jsonEqual(beforeOrder, afterOrder) ? null : beforeOrder;
    if (!changes.length && !order) return null;
    return { changes, order };
}

function applyKeyedRecordUndo(currentItems = [], undo = null) {
    if (!undo) return Array.isArray(currentItems) ? structuredClone(currentItems) : [];
    if (Array.isArray(undo.full)) return structuredClone(undo.full);
    const working = Array.isArray(currentItems) ? structuredClone(currentItems) : [];
    for (const change of Array.isArray(undo.changes) ? undo.changes : []) {
        const id = String(change?.id || '').trim();
        if (!id) continue;
        const index = working.findIndex(item => String(item?.id || '') === id);
        if (change.remove === true) {
            if (index >= 0) working.splice(index, 1);
            continue;
        }
        if (change.restore && typeof change.restore === 'object') {
            if (index >= 0) working[index] = structuredClone(change.restore);
            else working.push(structuredClone(change.restore));
        }
    }
    if (Array.isArray(undo.order)) {
        const rank = new Map(undo.order.map((id, index) => [String(id), index]));
        working.sort((a, b) => {
            const ai = rank.has(String(a?.id || '')) ? rank.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
            const bi = rank.has(String(b?.id || '')) ? rank.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
    }
    return working;
}

function buildSocialGraphUndo(beforeGraph = {}, afterGraph = {}) {
    const before = normalizeSocialGraph(beforeGraph);
    const after = normalizeSocialGraph(afterGraph);
    if (jsonEqual(before, after)) return null;
    const edges = keyedRecordUndo(before.edges, after.edges);
    const unresolved = keyedRecordUndo(before.unresolved, after.unresolved);
    const undo = { kind: 'delta' };
    if (before.version !== after.version) undo.version = before.version;
    if (edges) undo.edges = edges;
    if (unresolved) undo.unresolved = unresolved;
    return Object.keys(undo).length > 1 ? undo : null;
}

function applySocialGraphUndo(currentGraph = {}, undo = null) {
    if (!undo) return normalizeSocialGraph(currentGraph);
    // v1.0.7 stored the complete previous graph. Preserve that reader during the in-place
    // journal upgrade rather than making old rollback entries unusable.
    if (undo.kind !== 'delta') return normalizeSocialGraph(undo);
    const current = normalizeSocialGraph(currentGraph);
    return normalizeSocialGraph({
        version: Object.prototype.hasOwnProperty.call(undo, 'version') ? undo.version : current.version,
        edges: applyKeyedRecordUndo(current.edges, undo.edges),
        unresolved: applyKeyedRecordUndo(current.unresolved, undo.unresolved),
    });
}

export function buildRollbackUndo(beforeSnapshot = {}, afterSnapshot = {}) {
    const undo = {};
    const npcUndo = buildNpcUndo(beforeSnapshot?.npcs || [], afterSnapshot?.npcs || []);
    if (npcUndo) undo.npcs = npcUndo;

    for (const key of ['candidates', 'pendingBackfills', 'dismissed']) {
        if (!jsonEqual(beforeSnapshot?.[key], afterSnapshot?.[key])) undo[key] = structuredClone(beforeSnapshot?.[key]);
    }
    const socialGraphUndo = buildSocialGraphUndo(beforeSnapshot?.socialGraph, afterSnapshot?.socialGraph);
    if (socialGraphUndo) undo.socialGraph = socialGraphUndo;

    const scalars = {};
    for (const key of ROLLBACK_SCALAR_KEYS) {
        if (!jsonEqual(beforeSnapshot?.[key], afterSnapshot?.[key])) scalars[key] = structuredClone(beforeSnapshot?.[key]);
    }
    if (Object.keys(scalars).length) undo.scalars = scalars;
    return Object.keys(undo).length ? undo : null;
}

function applyNpcUndo(currentNpcs = [], npcUndo = null) {
    if (!npcUndo) return { npcs: cloneNpcList(currentNpcs), removed: [] };
    if (Array.isArray(npcUndo.full)) {
        const next = cloneNpcList(npcUndo.full);
        const nextIds = new Set(next.map(npc => String(npc?.id || '')).filter(Boolean));
        const removed = cloneNpcList(currentNpcs).filter(npc => npc?.id && !nextIds.has(String(npc.id)));
        return { npcs: next, removed };
    }

    const working = cloneNpcList(currentNpcs);
    const removed = [];
    for (const change of Array.isArray(npcUndo.changes) ? npcUndo.changes : []) {
        const id = String(change?.id || '').trim();
        if (!id) continue;
        const index = working.findIndex(npc => String(npc?.id || '') === id);
        if (change.remove === true) {
            if (index >= 0) removed.push(...working.splice(index, 1));
            continue;
        }
        if (change.restore && typeof change.restore === 'object') {
            if (index >= 0) working[index] = structuredClone(change.restore);
            else working.push(structuredClone(change.restore));
            continue;
        }
        if (index < 0) continue;
        const npc = { ...working[index] };
        for (const key of Array.isArray(change.deleteFields) ? change.deleteFields : []) delete npc[key];
        for (const [key, value] of Object.entries(change.fields || {})) npc[key] = structuredClone(value);
        working[index] = npc;
    }

    if (Array.isArray(npcUndo.order)) {
        const rank = new Map(npcUndo.order.map((id, index) => [String(id), index]));
        working.sort((a, b) => {
            const ai = rank.has(String(a?.id || '')) ? rank.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
            const bi = rank.has(String(b?.id || '')) ? rank.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
    }
    return { npcs: working, removed };
}

export function applyRollbackUndo(state = {}, undo = null) {
    if (!undo || typeof undo !== 'object') return { state: { ...state }, removedNpcs: [] };
    const restored = branchCore.restoreSnapshotIntoState(state, rollbackSnapshot(state));
    const npcResult = applyNpcUndo(restored.npcs, undo.npcs);
    restored.npcs = npcResult.npcs;
    for (const key of ['candidates', 'pendingBackfills', 'dismissed']) {
        if (Object.prototype.hasOwnProperty.call(undo, key)) restored[key] = structuredClone(undo[key]);
    }
    if (Object.prototype.hasOwnProperty.call(undo, 'socialGraph')) {
        restored.socialGraph = applySocialGraphUndo(restored.socialGraph, undo.socialGraph);
    }
    for (const [key, value] of Object.entries(undo.scalars || {})) restored[key] = structuredClone(value);

    for (const removedNpc of npcResult.removed) {
        restored.socialGraph = removeNpcFromSocialGraph(restored.socialGraph, removedNpc.id);
        purgeNpcStructuredReferences(restored.npcs, removedNpc);
        restored.pendingBackfills = (Array.isArray(restored.pendingBackfills) ? restored.pendingBackfills : [])
            .filter(item => String(item?.npcId || '') !== String(removedNpc.id || ''));
        restored.candidates = (Array.isArray(restored.candidates) ? restored.candidates : [])
            .filter(item => String(item?.id || '') !== String(removedNpc.id || ''));
    }
    restored.socialGraph = normalizeSocialGraph(restored.socialGraph);
    return { state: restored, removedNpcs: npcResult.removed };
}

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

function normalizeRollbackJournal(entries = []) {
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

function refreshRollbackJournalRetention(state) {
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

function appendRollbackMutation(state, lineage, messageId, reason, afterSnapshot) {
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

function settleRollbackHead(state, lineage = [], reason = 'turn-settled') {
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

function ensureBranchFamilyId(state, seed = '') {
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

function normalizeBranchCheckpointsV3(checkpoints = [], activeLineage = []) {
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

function boundRootSnapshot(state) {
    if (!state?.branchRootSnapshot || typeof state.branchRootSnapshot !== 'object') return;
    if (utf8Bytes(state.branchRootSnapshot) > BRANCH_SNAPSHOT_MAX_BYTES) state.branchRootSnapshot = null;
}

export function migrateLegacyBranchState(state, chat, limit = branchCore.BRANCH_HISTORY_LIMIT) {
    if (!state || typeof state !== 'object') return state;
    if (Number(state.branchLineageVersion || 0) >= BRANCH_LINEAGE_VERSION) {
        state.checkpoints = pruneBranchCheckpoints(state.checkpoints, Array.isArray(state.lineage) ? state.lineage : [], limit);
        boundRootSnapshot(state);
        ensureBranchFamilyId(state, (state.lineage || []).slice(0, 4).join('|'));
        prunePortraitAssetsInPlace(state);
        return state;
    }
    const lineage = chatLineage(chat);
    const keys = lineageCheckpointKeys(lineage);
    const storedVersion = Number(state.branchLineageVersion || 0);
    const storedLineage = Array.isArray(state.lineage) ? [...state.lineage] : [];
    const proofLineage = storedVersion <= 0
        ? branchCore.legacyChatLineageV0210(chat)
        : (storedVersion === 3
            ? legacyChatLineageV3(chat)
            : (storedVersion === 4 ? legacyChatLineageV4(chat) : branchCore.chatLineage(chat)));
    const hostRenameRebase = state.hostRenameRebaseAllowed === true;
    let provenPrefixLength = hostRenameRebase ? Math.min(storedLineage.length, proofLineage.length) : 0;
    if (!hostRenameRebase) {
        const common = Math.min(storedLineage.length, proofLineage.length);
        while (provenPrefixLength < common && storedLineage[provenPrefixLength] === proofLineage[provenPrefixLength]) provenPrefixLength += 1;
    }
    const prefixMatches = messageId => {
        if (hostRenameRebase) return true;
        if (!Number.isInteger(messageId) || messageId < 0 || messageId >= proofLineage.length) return false;
        for (let i = 0; i <= messageId; i += 1) if (!storedLineage[i] || storedLineage[i] !== proofLineage[i]) return false;
        return true;
    };
    if (storedVersion < BRANCH_LINEAGE_VERSION) {
        const migrated = [];
        for (const raw of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
            const messageId = Number(raw?.messageId);
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= lineage.length || !raw?.snapshot || !prefixMatches(messageId)) continue;
            migrated.push({
                ...raw,
                messageId,
                fingerprint: lineage[messageId],
                lineageKey: keys[messageId],
                parentLineageKey: messageId > 0 ? keys[messageId - 1] : 'root',
                reason: String(raw.reason || 'v3-migrated'),
            });
        }
        state.checkpoints = migrated;
        state.inlineCards = (Array.isArray(state.inlineCards) ? state.inlineCards : []).map(entry => {
            const messageId = Number(entry?.messageId);
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= lineage.length || !prefixMatches(messageId)) return null;
            return { ...entry, fingerprint: lineage[messageId], lineageKey: keys[messageId] };
        }).filter(Boolean);
    }
    // Preserve the prior branch shape through the one-time v2 -> v3 conversion. Relabel the
    // proven common prefix with v3 fingerprints, but use deterministic historical sentinels for
    // the old suffix. The next reconciliation can therefore still detect a swipe/edit/tail
    // divergence instead of migration accidentally making old and current lineages identical.
    if (hostRenameRebase || storedVersion === 4) {
        // v4 included SillyTavern send_date/gen_id in destructive lineage. Those values can
        // legitimately change while narrative content remains valid, so a v4 sidecar upgrades
        // fail-closed onto the live v5 narrative lineage instead of manufacturing a rollback.
        // Only checkpoints whose old v4 prefix was actually proven above are migrated.
        state.lineage = lineage;
    } else {
        state.lineage = storedLineage.map((storedFingerprint, index) => index < provenPrefixLength && index < lineage.length
            ? lineage[index]
            : branchHash(`legacy-lineage-v${storedVersion}:${index}:${storedFingerprint}`));
    }
    state.branchLineageVersion = BRANCH_LINEAGE_VERSION;
    delete state.hostRenameRebaseAllowed;
    // Migrated checkpoints exist only on the proven current prefix and are keyed to current v3
    // content. Preserve them against the current lineage even while state.lineage retains the
    // previous-branch sentinels for one reconciliation cycle.
    state.checkpoints = pruneBranchCheckpoints(state.checkpoints, lineage, limit);
    boundRootSnapshot(state);
    ensureBranchFamilyId(state, lineage.slice(0, 4).join('|'));
    prunePortraitAssetsInPlace(state);
    return state;
}

export function rebaseBranchStateForHostRename(state, chat, limit = branchCore.BRANCH_HISTORY_LIMIT) {
    if (!state || typeof state !== 'object') return state;
    if (Number(state.branchLineageVersion || 0) >= BRANCH_LINEAGE_VERSION) return state;
    state.hostRenameRebaseAllowed = true;
    return migrateLegacyBranchState(state, chat, limit);
}

export function ensureBranchParentAnchor(state, chat, messageId, reason = 'parent-anchor', limit = branchCore.BRANCH_HISTORY_LIMIT) {
    if (!state || typeof state !== 'object' || !Number.isInteger(messageId) || messageId < 0) return state;
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


function cloneNpcList(npcs) {
    return Array.isArray(npcs) ? structuredClone(npcs) : [];
}

function npcLabels(npc) {
    return [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(normalizeName).filter(Boolean);
}

function enforceUserDismissals(state, groups) {
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

function latestAssistantMessageId(chat = []) {
    for (let i = (Array.isArray(chat) ? chat.length : 0) - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system && String(message.mes || '').trim()) return i;
    }
    return -1;
}

function matchingCheckpoints(checkpoints, lineage) {
    const keys = lineageCheckpointKeys(lineage);
    return checkpoints
        .filter(item => Number.isInteger(item?.messageId) && item.messageId >= 0 && item.messageId < keys.length)
        .filter(item => item.lineageKey === keys[item.messageId])
        .sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
}

function isStrictTailDeletion(previousLineage = [], currentLineage = [], divergence = -1) {
    if (!Array.isArray(previousLineage) || !Array.isArray(currentLineage)) return false;
    if (currentLineage.length >= previousLineage.length || divergence !== currentLineage.length) return false;
    for (let i = 0; i < currentLineage.length; i += 1) {
        if (previousLineage[i] !== currentLineage[i]) return false;
    }
    return true;
}

function restoreTailDeletionFromJournal(state, previousLineage, currentLineage, divergence) {
    if (!isStrictTailDeletion(previousLineage, currentLineage, divergence)) return null;
    ensureRollbackJournalBaseline(state, previousLineage);
    const head = state.rollbackHead;
    if (!head?.snapshot || typeof head.snapshot !== 'object') return null;
    const targetTailId = currentLineage.length - 1;
    const floorMessageId = Number.isInteger(state.rollbackJournalFloorMessageId)
        ? state.rollbackJournalFloorMessageId
        : head.messageId;
    if (targetTailId < floorMessageId) return null;

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
            // The head can legitimately advance across raw user/system messages that caused no
            // canonical mutation. With no remaining mutation record at/after the deleted range,
            // the current working state already equals the requested surviving boundary.
            cursorMessageId = divergence - 1;
            break;
        }
        const entry = bySeq.get(cursorSeq);
        if (!entry) return null;
        if (entry.messageId < divergence) {
            // Same case with an older surviving mutation: unchanged raw-message boundaries lie
            // between that mutation and the requested tail. Do not undo the surviving mutation.
            cursorMessageId = divergence - 1;
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
    return { state: working, headSeq: cursorSeq, applied, floorMessageId };
}

function retainLinearPrefixHistory(target, source, checkpoints, currentLineage, divergence) {
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

function normalizedRecoveryOperation(value) {
    const operation = String(value || 'auto').toLowerCase();
    return ['delete', 'edit', 'swipe'].includes(operation) ? operation : 'auto';
}

export function reconcileBranchState(state, chat, { explicitDivergence = null, operation = 'auto' } = {}) {
    migrateLegacyBranchState(state, chat);
    // Permanent UI deletion is external user authority, not narrative branch state. Normalize
    // it before establishing any rollback baseline so an old label tombstone or stale snapshot
    // cannot become a new journal mutation merely because content lineage stayed unchanged.
    enforceUserDismissals(state, state?.userDismissedGroups);
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
            restoredFromMessageId: null,
            invalidated: false,
            exactRestored: false,
            failClosed: false,
        };
    }

    let divergence = relation.kind === 'same' ? explicitDivergence : relation.divergence;
    if (hasExplicitDivergence && relation.kind !== 'same') {
        divergence = Math.min(divergence, explicitDivergence);
    }

    const currentNpcs = cloneNpcList(state?.npcs);
    const checkpoints = normalizeBranchCheckpointsV3(state?.checkpoints, previousLineage);
    const matches = matchingCheckpoints(checkpoints, currentLineage);
    const deepestMatch = matches.at(-1) || null;
    const lastAssistantId = latestAssistantMessageId(chat);
    const exactCheckpoint = deepestMatch && deepestMatch.messageId >= lastAssistantId ? deepestMatch : null;
    const prefixCheckpoint = matches.filter(item => item.messageId < divergence).at(-1) || null;
    const journalRestore = relation.kind === 'tail-truncation'
        ? restoreTailDeletionFromJournal(state, previousLineage, currentLineage, divergence)
        : null;
    let restored;
    let checkpoint;
    let exactRestored = false;
    let restoredFromJournal = false;
    let restoredFromRoot = false;
    let failClosed = false;
    let journalHeadSeq = null;
    let recoveryAction = 'fail-closed';
    if (journalRestore) {
        restored = journalRestore.state;
        exactRestored = true;
        restoredFromJournal = true;
        journalHeadSeq = journalRestore.headSeq;
        recoveryAction = 'rollback-journal';
    } else if (exactCheckpoint) {
        checkpoint = exactCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        exactRestored = true;
        recoveryAction = 'exact-checkpoint';
    } else if ((linearReplacement || recoveryOperation === 'swipe' || hasExplicitDivergence) && prefixCheckpoint) {
        checkpoint = prefixCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        recoveryAction = 'explicit-ancestor-checkpoint';
    } else if ((linearReplacement || recoveryOperation === 'swipe' || hasExplicitDivergence) && divergence === 0
        && state?.branchRootSnapshot && typeof state.branchRootSnapshot === 'object') {
        restored = branchCore.restoreSnapshotIntoState(state, state.branchRootSnapshot);
        restoredFromRoot = true;
        recoveryAction = 'explicit-root';
    } else {
        // Missing recovery evidence must never authorize a destructive walk back to an older
        // checkpoint/root. Keep accepted canonical state, rebase ownership to the live content,
        // and let a later scan repair any stale descendant facts rather than resetting dossiers.
        restored = { ...state };
        failClosed = true;
        recoveryAction = 'fail-closed-keep-current';
    }
    restored.npcs = branchCore.preserveUserNpcMetadata(restored.npcs, currentNpcs);
    // A journal/checkpoint snapshot intentionally omits portrait binaries. When an NPC
    // is restored after having disappeared from the current cast, reattach any retained
    // user-owned asset before ordinary portrait GC runs.
    for (const npc of Array.isArray(restored.npcs) ? restored.npcs : []) {
        const asset = state?.portraitAssets?.[npc?.id];
        if (!npc?.portrait?.dataUrl && asset?.dataUrl) npc.portrait = structuredClone(asset);
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
    restored.rollbackHead = {
        seq: restoredHeadSeq,
        messageId: restoredTailId,
        lineageKey: restoredTailId >= 0 ? restoredKeys[restoredTailId] : 'root',
        snapshot: rollbackSnapshot(restored),
    };
    restored.rollbackJournalFloorMessageId = restoredHeadSeq > 0
        ? Math.min(restoredTailId, Number(state?.rollbackJournalFloorMessageId ?? restoredTailId))
        : restoredTailId;
    refreshRollbackJournalRetention(restored);
    if (!exactRestored) {
        if (Number.isInteger(restored.lastScannedMessageId) && restored.lastScannedMessageId >= divergence) restored.lastScannedMessageId = null;
    }
    prunePortraitAssetsInPlace(restored);
    return {
        state: restored,
        divergence,
        lineageRelation: relation.kind,
        recoveryOperation,
        recoveryAction,
        restoredFromMessageId: restoredFromJournal ? restoredTailId : (restoredFromRoot ? -1 : (checkpoint?.messageId ?? null)),
        restoredLineageKey: restoredFromJournal ? (restored.rollbackHead?.lineageKey || '') : (restoredFromRoot ? 'root' : (checkpoint?.lineageKey || '')),
        invalidated: true,
        exactRestored,
        restoredFromJournal,
        restoredFromRoot,
        failClosed,
        linearHistoryPruned: linearReplacement,
        legacyFallback: failClosed && checkpoints.length === 0 && !state?.branchRootSnapshot,
    };
}

function candidateMatchesExplicitParent(key) {
    if (!provenanceHint.mainChat) return true;
    const parsed = parseQualifiedChatKey(key);
    return Boolean(parsed && parsed.chatId === provenanceHint.mainChat);
}

export function bestAncestorState(chats = {}, currentKey = '', currentChat = []) {
    const lineage = chatLineage(currentChat);
    const v4Lineage = legacyChatLineageV4(currentChat);
    const v3Lineage = legacyChatLineageV3(currentChat);
    const historicalLineage = branchCore.chatLineage(currentChat);
    const currentKeys = lineageCheckpointKeys(lineage);
    const historicalCurrentKeys = branchCore.lineageCheckpointKeys(historicalLineage);
    let best = null;
    const hasExplicitParent = Boolean(provenanceHint.mainChat);

    for (const [key, state] of Object.entries(chats || {})) {
        if (key === currentKey || !state || !Array.isArray(state.lineage) || !Array.isArray(state.checkpoints)) continue;
        if (hasExplicitParent && !candidateMatchesExplicitParent(key)) continue;
        const version = Number(state.branchLineageVersion || 0);
        const isCurrent = version >= BRANCH_LINEAGE_VERSION;
        const isV4 = version === 4;
        const isV3 = version === 3;
        let prefixLength = 0;
        let sourceCheckpoints = [];

        if (hasExplicitParent) {
            const comparisonLineage = isCurrent ? lineage : (isV4 ? v4Lineage : (isV3 ? v3Lineage : historicalLineage));
            prefixLength = branchCore.commonPrefixLength(state.lineage, comparisonLineage);
            const hasRoot = Boolean(state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object');
            if (prefixLength < 1 && !hasRoot) continue;
            sourceCheckpoints = (isCurrent || isV4 || isV3)
                ? normalizeBranchCheckpointsV3(state.checkpoints, state.lineage)
                : branchCore.normalizeBranchCheckpoints(state.checkpoints, state.lineage);
        } else {
            const canonical = Boolean(parseQualifiedChatKey(key));
            if (canonical && version >= 3) continue;
            const comparisonLineage = isCurrent ? lineage : (isV4 ? v4Lineage : (isV3 ? v3Lineage : historicalLineage));
            prefixLength = branchCore.commonPrefixLength(state.lineage, comparisonLineage);
            const minPrefix = canonical ? 8 : 4;
            const minUserTurns = canonical ? 3 : 2;
            if (prefixLength < minPrefix) continue;
            const sharedPrefix = (Array.isArray(currentChat) ? currentChat : []).slice(0, prefixLength);
            if (sharedPrefix.filter(message => message?.is_user).length < minUserTurns) continue;
            sourceCheckpoints = (isCurrent || isV4 || isV3)
                ? normalizeBranchCheckpointsV3(state.checkpoints, state.lineage)
                : branchCore.normalizeBranchCheckpoints(state.checkpoints, state.lineage);
        }

        let checkpoint = sourceCheckpoints
            .filter(item => item.messageId < prefixLength)
            .filter(item => {
                if (hasExplicitParent) return true;
                const keys = isCurrent ? currentKeys : historicalCurrentKeys;
                return item.lineageKey === keys[item.messageId];
            })
            .sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt)
            .at(-1);
        if (!checkpoint && hasExplicitParent && state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object') {
            checkpoint = { messageId: -1, lineageKey: 'root', createdAt: 0, snapshot: state.branchRootSnapshot };
        }
        if (!checkpoint) continue;
        if (!best || checkpoint.messageId > best.checkpoint.messageId) {
            best = { key, state, checkpoint, prefixLength, sourceCheckpoints, isCurrent };
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
    inherited.userDismissedGroups = structuredClone(branchCore.normalizeUserDismissedGroups(best.state.userDismissedGroups));
    enforceUserDismissals(inherited, inherited.userDismissedGroups);
    inherited.branchParent = best.key;
    inherited.branchForkMessageId = best.checkpoint.messageId;
    inherited.branchFamilyId = String(best.state.branchFamilyId || '');
    ensureBranchFamilyId(inherited, best.key);
    prunePortraitAssetsInPlace(inherited);
    return inherited;
}
