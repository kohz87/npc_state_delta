import * as branchCore from './branch-core.js';
import { normalizeName } from './core.js';
import { parseQualifiedChatKey } from './identity.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { normalizeSocialGraph, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';

export * from './branch-core.js';

export const BRANCH_LINEAGE_VERSION = 4;
export const BRANCH_SNAPSHOT_BUDGET_BYTES = 2_000_000;
export const BRANCH_SNAPSHOT_BUDGET_CHARS = BRANCH_SNAPSHOT_BUDGET_BYTES;
export const BRANCH_SNAPSHOT_MAX_BYTES = 750_000;
export const ROLLBACK_JOURNAL_VERSION = 1;
export const ROLLBACK_JOURNAL_LIMIT = 1024;
export const ROLLBACK_JOURNAL_BUDGET_BYTES = 12_000_000;
export const ROLLBACK_JOURNAL_MIN_ACTIVE_ENTRIES = 384;

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

function messageInstanceIdentity(message = {}) {
    const sendDate = String(message.send_date ?? '').trim();
    if (sendDate) return `date:${sendDate}`;
    const generationId = String(message?.extra?.gen_id ?? '').trim();
    if (generationId) return `gen:${generationId}`;
    return '';
}

export function fingerprintMessage(message = {}) {
    const payload = JSON.stringify({
        user: Boolean(message.is_user),
        system: Boolean(message.is_system),
        text: String(message.mes || ''),
        instance: messageInstanceIdentity(message),
    });
    return branchHash(payload);
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

export function buildRollbackUndo(beforeSnapshot = {}, afterSnapshot = {}) {
    const undo = {};
    const npcUndo = buildNpcUndo(beforeSnapshot?.npcs || [], afterSnapshot?.npcs || []);
    if (npcUndo) undo.npcs = npcUndo;

    for (const key of ['candidates', 'pendingBackfills', 'socialGraph', 'dismissed']) {
        if (!jsonEqual(beforeSnapshot?.[key], afterSnapshot?.[key])) undo[key] = structuredClone(beforeSnapshot?.[key]);
    }

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
    for (const key of ['candidates', 'pendingBackfills', 'socialGraph', 'dismissed']) {
        if (Object.prototype.hasOwnProperty.call(undo, key)) restored[key] = structuredClone(undo[key]);
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

export function pruneRollbackJournal(entries = [], headSeq = 0, limit = ROLLBACK_JOURNAL_LIMIT) {
    const cap = Math.max(64, Number(limit) || ROLLBACK_JOURNAL_LIMIT);
    const normalized = normalizeRollbackJournal(entries);
    if (!normalized.length) return [];
    const bySeq = new Map(normalized.map(entry => [entry.seq, entry]));
    const active = [];
    const activeSeqs = new Set();
    let cursor = Number(headSeq) || 0;
    while (cursor > 0 && active.length < cap) {
        const entry = bySeq.get(cursor);
        if (!entry || activeSeqs.has(entry.seq)) break;
        active.push(entry);
        activeSeqs.add(entry.seq);
        cursor = entry.prevSeq;
    }

    let activeBytes = active.reduce((sum, entry) => sum + rollbackEntryBytes(entry), 0);
    while (active.length > ROLLBACK_JOURNAL_MIN_ACTIVE_ENTRIES && activeBytes > ROLLBACK_JOURNAL_BUDGET_BYTES) {
        activeBytes -= rollbackEntryBytes(active.pop());
    }

    const keep = [...active];
    const remaining = normalized
        .filter(entry => !activeSeqs.has(entry.seq))
        .sort((a, b) => b.seq - a.seq);
    let used = keep.reduce((sum, entry) => sum + rollbackEntryBytes(entry), 0);
    for (const entry of remaining) {
        if (keep.length >= cap) break;
        const size = rollbackEntryBytes(entry);
        if (used + size > ROLLBACK_JOURNAL_BUDGET_BYTES) continue;
        keep.push(entry);
        used += size;
    }
    return keep.sort((a, b) => a.seq - b.seq);
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
        state.rollbackJournalFloorMessageId = messageId;
        state.rollbackJournal = [];
        return state;
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
    state.rollbackJournal = pruneRollbackJournal(state.rollbackJournal, state.rollbackHead.seq);
    return state;
}

function appendRollbackMutation(state, lineage, messageId, reason, afterSnapshot) {
    ensureRollbackJournalBaseline(state, Array.isArray(state.lineage) ? state.lineage : lineage);
    const head = state.rollbackHead;
    const beforeSnapshot = head?.snapshot && typeof head.snapshot === 'object' ? head.snapshot : rollbackSnapshot(state);
    const undo = buildRollbackUndo(beforeSnapshot, afterSnapshot);
    const keys = lineageCheckpointKeys(lineage);
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
    state.rollbackJournal = pruneRollbackJournal(state.rollbackJournal, state.rollbackHead.seq);
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
        : (storedVersion === 3 ? legacyChatLineageV3(chat) : branchCore.chatLineage(chat));
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
    if (hostRenameRebase) {
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
    const existingDismissed = (Array.isArray(state.dismissed) ? state.dismissed : []).map(normalizeName).filter(Boolean);
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
        if (cursorSeq <= 0) return null;
        const entry = bySeq.get(cursorSeq);
        if (!entry) return null;
        if (entry.messageId < divergence) break;
        if (entry.messageId >= previousKeys.length || entry.lineageKey !== previousKeys[entry.messageId]) return null;
        const reverted = applyRollbackUndo(working, entry.undo);
        working = reverted.state;
        cursorSeq = entry.prevSeq;
        cursorMessageId = entry.beforeMessageId;
        applied += 1;
    }

    if (cursorMessageId >= divergence) return null;
    return { state: working, headSeq: cursorSeq, applied };
}

export function reconcileBranchState(state, chat, { explicitDivergence = null } = {}) {
    migrateLegacyBranchState(state, chat);
    const currentLineage = chatLineage(chat);
    const previousLineage = Array.isArray(state?.lineage) ? state.lineage : [];
    ensureRollbackJournalBaseline(state, previousLineage.length ? previousLineage : currentLineage);
    let divergence = branchCore.firstLineageDivergence(previousLineage, currentLineage);
    if (Number.isInteger(explicitDivergence) && explicitDivergence >= 0) divergence = divergence < 0 ? explicitDivergence : Math.min(divergence, explicitDivergence);
    if (divergence < 0) {
        state.lineage = currentLineage;
        prunePortraitAssetsInPlace(state);
        return { state: { ...state, lineage: currentLineage }, divergence: -1, restoredFromMessageId: null, invalidated: false, exactRestored: false };
    }

    const currentNpcs = cloneNpcList(state?.npcs);
    const checkpoints = normalizeBranchCheckpointsV3(state?.checkpoints, previousLineage);
    const matches = matchingCheckpoints(checkpoints, currentLineage);
    const deepestMatch = matches.at(-1) || null;
    const lastAssistantId = latestAssistantMessageId(chat);
    const exactCheckpoint = deepestMatch && deepestMatch.messageId >= lastAssistantId ? deepestMatch : null;
    const journalRestore = restoreTailDeletionFromJournal(state, previousLineage, currentLineage, divergence);
    let restored;
    let checkpoint;
    let exactRestored = false;
    let restoredFromJournal = false;
    let journalHeadSeq = null;
    if (journalRestore) {
        restored = journalRestore.state;
        exactRestored = true;
        restoredFromJournal = true;
        journalHeadSeq = journalRestore.headSeq;
    } else if (exactCheckpoint) {
        checkpoint = exactCheckpoint;
        restored = branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot);
        exactRestored = true;
    } else {
        checkpoint = deepestMatch || null;
        restored = checkpoint
            ? branchCore.restoreSnapshotIntoState(state, checkpoint.snapshot)
            : (state?.branchRootSnapshot && typeof state.branchRootSnapshot === 'object'
                ? branchCore.restoreSnapshotIntoState(state, state.branchRootSnapshot)
                : { ...state, lastScannedMessageId: null, assistantSinceScan: 0 });
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
    restored.checkpoints = pruneBranchCheckpoints(checkpoints, currentLineage);
    restored.inlineCards = Array.isArray(state?.inlineCards) ? structuredClone(state.inlineCards) : [];
    restored.rollbackJournalVersion = ROLLBACK_JOURNAL_VERSION;
    restored.rollbackJournalSequence = Math.max(0, Number(state?.rollbackJournalSequence || 0));
    restored.rollbackJournal = normalizeRollbackJournal(state?.rollbackJournal);
    const restoredTailId = currentLineage.length - 1;
    const restoredKeys = lineageCheckpointKeys(currentLineage);
    let restoredHeadSeq = 0;
    if (restoredFromJournal) restoredHeadSeq = Math.max(0, Number(journalHeadSeq || 0));
    else if (Number.isInteger(checkpoint?.rollbackSeq)
        && checkpoint.rollbackSeq >= 0
        && (checkpoint.rollbackSeq === 0 || restored.rollbackJournal.some(entry => entry.seq === checkpoint.rollbackSeq))) {
        restoredHeadSeq = checkpoint.rollbackSeq;
    }
    restored.rollbackHead = {
        seq: restoredHeadSeq,
        messageId: restoredTailId,
        lineageKey: restoredTailId >= 0 ? restoredKeys[restoredTailId] : 'root',
        snapshot: rollbackSnapshot(restored),
    };
    restored.rollbackJournalFloorMessageId = restoredHeadSeq > 0
        ? Number(state?.rollbackJournalFloorMessageId ?? -1)
        : restoredTailId;
    restored.rollbackJournal = pruneRollbackJournal(restored.rollbackJournal, restoredHeadSeq);
    if (!exactRestored) {
        if (Number.isInteger(restored.lastScannedMessageId) && restored.lastScannedMessageId >= divergence) restored.lastScannedMessageId = null;
    }
    prunePortraitAssetsInPlace(restored);
    return {
        state: restored,
        divergence,
        restoredFromMessageId: restoredFromJournal ? restoredTailId : (checkpoint?.messageId ?? null),
        restoredLineageKey: restoredFromJournal ? (restored.rollbackHead?.lineageKey || '') : (checkpoint?.lineageKey || ''),
        invalidated: true,
        exactRestored,
        restoredFromJournal,
        restoredFromRoot: !restoredFromJournal && !checkpoint && Boolean(state?.branchRootSnapshot),
        legacyFallback: !restoredFromJournal && !checkpoint && checkpoints.length === 0 && !state?.branchRootSnapshot,
    };
}

function candidateMatchesExplicitParent(key) {
    if (!provenanceHint.mainChat) return true;
    const parsed = parseQualifiedChatKey(key);
    return Boolean(parsed && parsed.chatId === provenanceHint.mainChat);
}

export function bestAncestorState(chats = {}, currentKey = '', currentChat = []) {
    const lineage = chatLineage(currentChat);
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
        const isV3 = version === 3;
        let prefixLength = 0;
        let sourceCheckpoints = [];

        if (hasExplicitParent) {
            const comparisonLineage = isCurrent ? lineage : (isV3 ? v3Lineage : historicalLineage);
            prefixLength = branchCore.commonPrefixLength(state.lineage, comparisonLineage);
            const hasRoot = Boolean(state.branchRootSnapshot && typeof state.branchRootSnapshot === 'object');
            if (prefixLength < 1 && !hasRoot) continue;
            sourceCheckpoints = (isCurrent || isV3)
                ? normalizeBranchCheckpointsV3(state.checkpoints, state.lineage)
                : branchCore.normalizeBranchCheckpoints(state.checkpoints, state.lineage);
        } else {
            const canonical = Boolean(parseQualifiedChatKey(key));
            if (canonical && version >= 3) continue;
            const comparisonLineage = isCurrent ? lineage : (isV3 ? v3Lineage : historicalLineage);
            prefixLength = branchCore.commonPrefixLength(state.lineage, comparisonLineage);
            const minPrefix = canonical ? 8 : 4;
            const minUserTurns = canonical ? 3 : 2;
            if (prefixLength < minPrefix) continue;
            const sharedPrefix = (Array.isArray(currentChat) ? currentChat : []).slice(0, prefixLength);
            if (sharedPrefix.filter(message => message?.is_user).length < minUserTurns) continue;
            sourceCheckpoints = (isCurrent || isV3)
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
