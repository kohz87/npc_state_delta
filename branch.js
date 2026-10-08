import * as branchCore from './branch-core.js';
import { isTerminalNpcDeath, normalizeName } from './core.js';
import { parseQualifiedChatKey } from './identity.js';
import { prunePortraitAssetsInPlace } from './storage.js';
import { normalizeSocialGraph, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';

export * from './branch-core.js';

export const BRANCH_LINEAGE_VERSION = 5;
export const BRANCH_SNAPSHOT_BUDGET_BYTES = 8_000_000;
export const BRANCH_SNAPSHOT_BUDGET_CHARS = BRANCH_SNAPSHOT_BUDGET_BYTES;
export const BRANCH_SNAPSHOT_MAX_BYTES = 2_000_000;
export const ROLLBACK_JOURNAL_VERSION = 2;
export const ROLLBACK_JOURNAL_WINDOW_MESSAGES = 256;
export const ROLLBACK_JOURNAL_LIMIT = 1024;
// Diagnostic target only. The guaranteed raw-message rollback window is never silently
// shortened to satisfy this value; structure-specific undo keeps ordinary journals below it.
export const ROLLBACK_JOURNAL_BUDGET_BYTES = 12_000_000;

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

function messageFingerprint(message = {}, system = false) {
    return branchHash(JSON.stringify({
        user: Boolean(message.is_user),
        system,
        text: String(message.mes || ''),
    }));
}

export function fingerprintMessage(message = {}) {
    // Destructive lineage is narrative-content based. SillyTavern send dates, generation IDs,
    // swipe indexes, and speaker labels are mutable host metadata and never define durable state.
    // So is the system flag: hiding a message (MemoryBooks and similar extensions set is_system on
    // summarised messages) does not change what was said, and a lineage that followed the flag
    // invalidated every later checkpoint key whenever a message was hidden or unhidden. The flag is
    // therefore fixed in the hash, which keeps the value earlier versions stored for ordinary messages.
    return messageFingerprint(message, false);
}

// The value earlier versions stored for a message whose system flag was set (hidden or system).
export function legacySystemFingerprint(message = {}) {
    return messageFingerprint(message, true);
}

// Rewrites every stored lineage key from one lineage to another, in every persisted structure that
// carries one, so checkpoints, the rollback journal and inline cards keep matching the chat.
export function remapLineageKeys(state, fromLineage, toLineage) {
    const fromKeys = lineageCheckpointKeys(fromLineage);
    const toKeys = lineageCheckpointKeys(toLineage);
    const map = new Map();
    fromKeys.forEach((key, index) => { if (toKeys[index]) map.set(key, toKeys[index]); });
    const remap = value => (map.has(value) ? map.get(value) : value);
    for (const item of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
        item.lineageKey = remap(item.lineageKey);
        item.parentLineageKey = remap(item.parentLineageKey);
        if (Number.isInteger(item.messageId) && toLineage[item.messageId] && map.has(fromKeys[item.messageId])) item.fingerprint = toLineage[item.messageId];
    }
    for (const entry of Array.isArray(state.rollbackJournal) ? state.rollbackJournal : []) {
        entry.lineageKey = remap(entry.lineageKey);
        entry.parentLineageKey = remap(entry.parentLineageKey);
    }
    if (state.rollbackHead && typeof state.rollbackHead === 'object') state.rollbackHead.lineageKey = remap(state.rollbackHead.lineageKey);
    for (const card of Array.isArray(state.inlineCards) ? state.inlineCards : []) {
        card.lineageKey = remap(card.lineageKey);
        if (Number.isInteger(card.messageId) && toLineage[card.messageId] && map.has(fromKeys[card.messageId])) card.fingerprint = toLineage[card.messageId];
    }
    state.lineage = toLineage;
    return state;
}

// State saved while a message was hidden (or that is system) recorded that message under the old,
// flag-sensitive hash. When the stored lineage differs from the chat only in such messages, adopt
// the flag-independent hash and rewrite the stored keys once; real content differences are left for
// ordinary reconciliation.
export function migrateLegacyLineage(state, chat) {
    const previous = Array.isArray(state?.lineage) ? state.lineage : [];
    const messages = Array.isArray(chat) ? chat : [];
    if (!previous.length || !messages.length) return false;
    const rebased = previous.slice();
    let changed = false;
    const limit = Math.min(previous.length, messages.length);
    for (let i = 0; i < limit; i += 1) {
        if (previous[i] === fingerprintMessage(messages[i])) continue;
        if (previous[i] === legacySystemFingerprint(messages[i])) {
            rebased[i] = fingerprintMessage(messages[i]);
            changed = true;
        }
    }
    if (changed) remapLineageKeys(state, previous, rebased);
    return repairHiddenEraKeys(state, messages) || changed;
}

const eraRepairSignatures = new WeakMap();
const ERA_REPAIR_CUT_LIMIT = 400;

// Memory extensions hide messages progressively, so history saved by earlier versions holds keys
// from several "eras", each chained through the old flag-sensitive hash of the messages hidden
// by then. Older hides come first, so an era is a prefix of the currently hidden messages: try
// each prefix as the set that carried the old hash, and rewrite any stored key that matches.
function repairHiddenEraKeys(state, messages) {
    const hidden = [];
    messages.forEach((message, index) => { if (message?.is_system) hidden.push(index); });
    if (!hidden.length) return false;
    const target = messages.map(fingerprintMessage);
    const targetKeys = lineageCheckpointKeys(target);
    const holders = [];
    const add = (holder, field, messageId) => {
        const key = holder?.[field];
        if (key && Number.isInteger(messageId) && messageId >= 0 && messageId < targetKeys.length && key !== targetKeys[messageId]) holders.push({ holder, field, messageId, key });
    };
    for (const item of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
        add(item, 'lineageKey', item.messageId);
        add(item, 'parentLineageKey', item.messageId - 1);
    }
    for (const entry of Array.isArray(state.rollbackJournal) ? state.rollbackJournal : []) {
        add(entry, 'lineageKey', entry.messageId);
        add(entry, 'parentLineageKey', entry.messageId - 1);
    }
    if (state.rollbackHead && typeof state.rollbackHead === 'object') add(state.rollbackHead, 'lineageKey', state.rollbackHead.messageId);
    for (const card of Array.isArray(state.inlineCards) ? state.inlineCards : []) add(card, 'lineageKey', card.messageId);
    if (!holders.length) return false;
    const signature = `${messages.length}:${hidden.length}:${hidden[0]}:${hidden.at(-1)}:${holders.length}`;
    if (eraRepairSignatures.get(state) === signature) return false;
    eraRepairSignatures.set(state, signature);

    const wanted = new Set(holders.map(item => `${item.messageId}:${item.key}`));
    const maxId = Math.max(...holders.map(item => item.messageId));
    const legacy = new Map();
    const legacyAt = index => {
        if (!legacy.has(index)) legacy.set(index, legacySystemFingerprint(messages[index]));
        return legacy.get(index);
    };
    const step = Math.max(1, Math.ceil((hidden.length + 1) / ERA_REPAIR_CUT_LIMIT));
    const cuts = [];
    for (let cut = 0; cut <= hidden.length; cut += step) cuts.push(cut);
    if (cuts.at(-1) !== hidden.length) cuts.push(hidden.length);
    const found = new Map();
    for (const cut of cuts) {
        const legacySet = new Set(hidden.slice(0, cut));
        let parent = 'root';
        for (let index = 0; index <= maxId; index += 1) {
            parent = branchHash(`${parent}|${index}|${legacySet.has(index) ? legacyAt(index) : target[index]}`);
            const id = `${index}:${parent}`;
            if (wanted.has(id) && !found.has(id)) found.set(id, targetKeys[index]);
        }
    }
    let repaired = false;
    for (const item of holders) {
        const replacement = found.get(`${item.messageId}:${item.key}`);
        if (replacement) { item.holder[item.field] = replacement; repaired = true; }
    }
    return repaired;
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
    if (!jsonEqual(before.suppressed || [], after.suppressed || [])) undo.suppressed = structuredClone(before.suppressed || []);
    return Object.keys(undo).length > 1 ? undo : null;
}

function applySocialGraphUndo(currentGraph = {}, undo = null) {
    if (!undo || undo.kind !== 'delta') return normalizeSocialGraph(currentGraph);
    const current = normalizeSocialGraph(currentGraph);
    return normalizeSocialGraph({
        version: Object.prototype.hasOwnProperty.call(undo, 'version') ? undo.version : current.version,
        edges: applyKeyedRecordUndo(current.edges, undo.edges),
        unresolved: applyKeyedRecordUndo(current.unresolved, undo.unresolved),
        // Undo that did not change suppression keeps the current manual sibling removals.
        suppressed: Object.prototype.hasOwnProperty.call(undo, 'suppressed') ? undo.suppressed : (current.suppressed || []),
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

function assistantMessageCountAtOrAfter(chat = [], messageId = 0) {
    const start = Math.max(0, Number.isInteger(messageId) ? messageId : 0);
    return (Array.isArray(chat) ? chat : []).slice(start).filter(message => (
        message && !message.is_user && !message.is_system && String(message.mes || '').trim()
    )).length;
}

function matchingCheckpoints(checkpoints, lineage) {
    const keys = lineageCheckpointKeys(lineage);
    return checkpoints
        .filter(item => Number.isInteger(item?.messageId) && item.messageId >= 0 && item.messageId < keys.length)
        .filter(item => item.lineageKey === keys[item.messageId])
        .sort((a, b) => a.messageId - b.messageId || a.createdAt - b.createdAt);
}

function restoreLinearBoundaryFromJournal(state, previousLineage, currentLineage, divergence) {
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

// Fields that describe one thing and must be reverted (or kept) together, so a partial revert
// never leaves an NPC in a state no scan could have produced.
const NPC_REVERT_GROUPS = Object.freeze([
    ['relationship', 'relationshipProgress', 'relationshipMilestones', 'relationshipEventHistory', 'lastRelationshipChange'],
    ['appearance', 'overallAppearance', 'unclassifiedAppearance', 'appearanceForms', 'currentForm', 'currentFormUnknown', 'appearanceModelVersion'],
    ['age', 'apparentAge', 'birthDate', 'birthDateSource', 'birthDatePrecision', 'birthDateYearSource', 'birthDateReason',
        'birthDateSourceMessageId', 'birthDateCalendarFingerprint', 'birthDateDisplay', 'calendarAge', 'apparentAgeAnchor'],
    ['lifeState', 'lifeStateCertainty', 'lifeStateReason', 'archived', 'archiveReason', 'archivedAt', 'archiveSourceMessageId'],
    ['personality', 'personalityDevelopment'],
    ['speech', 'speechDevelopment'],
]);
const NPC_REVERT_LIST_FIELDS = Object.freeze(['memories', 'mannerisms', 'behaviorProfile', 'keyRelationships', 'aliases']);
const NPC_REVERT_SKIP = new Set(['id', 'portrait', 'updatedAt', 'createdAt', 'manualProfileFields', 'manualProfileLocksExplicit']);
// Presence bookkeeping alone does not make an NPC "used" by later messages, and neither does manual
// image/retention metadata (a saved seed or prompt is not a narrative appearance).
const NPC_REMOVAL_IGNORED = new Set([...NPC_REVERT_SKIP, 'present', 'worldActive', 'lastWorldActiveTurn', 'fieldChanges', 'fieldChangeDays',
    'portraitSeed', 'portraitPromptPositive', 'portraitPromptNegative', 'portraitPromptReplace', 'retentionProtected', 'minor']);

function withoutKeys(record, ignored) {
    const out = {};
    for (const [key, value] of Object.entries(record || {})) if (!ignored.has(key)) out[key] = value;
    return out;
}

function setOrDelete(target, key, source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = structuredClone(source[key]);
    else delete target[key];
}

// Removes from `current` the list items the deleted block added (present in `after`, absent in
// `before`), leaving items later messages added.
function removeAddedItems(current, before, after) {
    if (!Array.isArray(current) || !Array.isArray(after)) return current;
    const had = new Set((Array.isArray(before) ? before : []).map(item => JSON.stringify(item)));
    const added = new Set(after.filter(item => !had.has(JSON.stringify(item))).map(item => JSON.stringify(item)));
    return added.size ? current.filter(item => !added.has(JSON.stringify(item))) : current;
}

// Three-way revert of one NPC: `before` is the record just before the deleted block, `after` just
// after its last scan, `npc` the live record. A field (group) the block changed and nothing later
// touched returns to `before`; list fields also drop the items the block added. Returns the
// reverted field names.
function revertNpcAgainstDeletedBlock(npc, before, after, protectedKeys = []) {
    const locked = new Set([...(Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : []), ...protectedKeys]);
    const changed = [];
    const handled = new Set();
    const consider = (keys) => {
        const usable = keys.filter(key => !NPC_REVERT_SKIP.has(key) && !locked.has(key));
        if (!usable.length || usable.length !== keys.length) { keys.forEach(key => handled.add(key)); return; }
        keys.forEach(key => handled.add(key));
        if (keys.every(key => jsonEqual(after[key], before[key]))) return;          // the block changed nothing here
        if (!keys.every(key => jsonEqual(npc[key], after[key]))) return;            // something later touched it
        for (const key of keys) setOrDelete(npc, key, before);
        changed.push(...keys.filter(key => !jsonEqual(after[key], before[key])));
    };
    for (const group of NPC_REVERT_GROUPS) consider(group);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        if (handled.has(key) || NPC_REVERT_SKIP.has(key) || locked.has(key)) continue;
        if (jsonEqual(after[key], before[key])) continue;
        if (jsonEqual(npc[key], after[key])) { setOrDelete(npc, key, before); changed.push(key); continue; }
        if (NPC_REVERT_LIST_FIELDS.includes(key)) {
            const next = removeAddedItems(npc[key], before[key], after[key]);
            if (next !== npc[key] && next.length !== npc[key].length) { npc[key] = next; changed.push(key); }
        } else if (key === 'profileEvidence' && npc[key] && typeof npc[key] === 'object') {
            for (const field of Object.keys(after[key] || {})) {
                const next = removeAddedItems(npc[key][field], before[key]?.[field], after[key][field]);
                if (next !== npc[key][field] && next.length !== npc[key][field].length) { npc[key][field] = next; changed.push(`profileEvidence.${field}`); }
            }
        }
    }
    return changed;
}

// A message deleted from the middle of the chat leaves retained descendants that cannot be
// replayed, so canonical dossiers are kept. What the deleted block itself did can still be undone
// exactly wherever nothing later touched it: compare the live state with the state just before the
// block and just after its last scan (both from the rollback journal, else retained checkpoints).
// Only one contiguous deleted block is handled, and confirmed deaths stay terminal unless the
// deleted block itself caused the death.
export function revertDeletedBlockEffects(state, currentState, checkpoints, previousLineage, currentLineage, divergence) {
    const empty = { reverted: [], removed: [], socialEdges: 0 };
    const removedCount = previousLineage.length - currentLineage.length;
    if (!Array.isArray(currentState?.npcs) || !Number.isInteger(divergence) || divergence < 0 || removedCount <= 0) return empty;
    for (let i = 0; i < divergence; i += 1) if (previousLineage[i] !== currentLineage[i]) return empty;
    for (let i = divergence; i < currentLineage.length; i += 1) if (previousLineage[i + removedCount] !== currentLineage[i]) return empty;

    const keys = lineageCheckpointKeys(previousLineage);
    const owned = (Array.isArray(checkpoints) ? checkpoints : [])
        .filter(item => item?.snapshot && keys[item.messageId] === item.lineageKey)
        .sort((a, b) => a.messageId - b.messageId);
    const journalState = boundary => restoreLinearBoundaryFromJournal(state, previousLineage, previousLineage, boundary)?.state || null;
    // Only the exact boundary just before the block proves what the block changed; an older
    // checkpoint would attribute every retained message in between to the deletion.
    const before = journalState(divergence)
        || owned.filter(item => item.messageId === divergence - 1).at(-1)?.snapshot
        || (divergence === 0 ? state?.branchRootSnapshot : null);
    const after = journalState(divergence + removedCount)
        || owned.filter(item => item.messageId >= divergence && item.messageId < divergence + removedCount).at(-1)?.snapshot;
    if (!before || !after) return empty;

    const byId = list => new Map((Array.isArray(list) ? list : []).map(npc => [String(npc?.id || ''), npc]));
    const beforeNpcs = byId(before.npcs);
    const afterNpcs = byId(after.npcs);
    const result = { reverted: [], removed: [], socialEdges: 0 };
    const survivors = [];
    for (const npc of currentState.npcs) {
        const id = String(npc?.id || '');
        const was = beforeNpcs.get(id);
        const then = afterNpcs.get(id);
        if (!id || !then) { survivors.push(npc); continue; }
        if (!was) {
            // Introduced by the deleted block: gone with it unless a later message used the NPC. The
            // exact before-state proves it did not exist, so a death recorded in the block goes too.
            if (jsonEqual(withoutKeys(npc, NPC_REMOVAL_IGNORED), withoutKeys(then, NPC_REMOVAL_IGNORED))
                && !referencedAfterBlock(currentState.npcs, afterNpcs, npc)
                && !graphUsedAfterBlock(currentState.socialGraph, after.socialGraph, npc, currentState.npcs)) {
                result.removed.push({ id, name: String(npc.name || '') });
                continue;
            }
            survivors.push(npc);
            continue;
        }
        // A death the deleted block did not cause stays terminal, with its terminal relationship
        // record (v1.0.78); the block's other unchanged effects (mood, memories, ...) are still undone.
        let protectedKeys = [];
        if (isTerminalNpcDeath(npc)) {
            const deathGroup = NPC_REVERT_GROUPS[3];
            const causedByBlock = !isTerminalNpcDeath(was) && deathGroup.every(key => jsonEqual(npc[key], then[key]));
            if (!causedByBlock) protectedKeys = [...deathGroup, ...NPC_REVERT_GROUPS[0]];
        }
        const fields = revertNpcAgainstDeletedBlock(npc, was, then, protectedKeys);
        if (fields.length) {
            npc.updatedAt = Date.now();
            result.reverted.push({ id, name: String(npc.name || ''), fields });
        }
        survivors.push(npc);
    }
    currentState.npcs = survivors;

    if (currentState.socialGraph && before.socialGraph && after.socialGraph) {
        const graph = structuredClone(currentState.socialGraph);
        const edgeMap = list => new Map(normalizeSocialGraph({ edges: list }).edges.map(edge => [edge.id, edge]));
        const beforeEdges = edgeMap(before.socialGraph.edges);
        const afterEdges = edgeMap(after.socialGraph.edges);
        const liveIds = new Set(survivors.map(npc => String(npc?.id || '')));
        // Grouped bonds the block added and this revert removes, per endpoint and group: each one
        // may have consumed an unnamed-relative slot that must come back with it.
        const undoneGroupBonds = new Map();
        const countUndone = edge => {
            if (!edge?.groupId) return;
            for (const owner of [edge.aId, edge.bId]) {
                const key = `${owner}|${edge.groupId}`;
                undoneGroupBonds.set(key, (undoneGroupBonds.get(key) || 0) + 1);
            }
        };
        graph.edges = normalizeSocialGraph({ edges: graph.edges }).edges.flatMap(edge => {
            const id = String(edge?.id || '');
            const then = afterEdges.get(id);
            const was = beforeEdges.get(id);
            if (!id || !then || !jsonEqual(edge, then)) return [edge];
            if (!was) { result.socialEdges += 1; countUndone(edge); return []; }   // added by the block
            if (jsonEqual(was, then)) return [edge];
            result.socialEdges += 1;
            return [structuredClone(was)];                                // changed by the block
        }).filter(edge => {
            const kept = liveIds.has(String(edge?.aId || '')) && liveIds.has(String(edge?.bId || ''));
            // A bond to an NPC the block introduced goes with that NPC.
            if (!kept && afterEdges.has(edge.id) && !beforeEdges.has(edge.id)) countUndone(edge);
            return kept;
        });
        // Unresolved relative slots follow the same rule: a slot the block added and no retained
        // message touched goes with it; one the block changed reverts. Deleted family facts must
        // not survive as slots that a later scan would consume as evidence.
        const slotMap = list => new Map(normalizeSocialGraph({ unresolved: list }).unresolved.map(slot => [slot.id, slot]));
        const beforeSlots = slotMap(before.socialGraph.unresolved);
        const afterSlots = slotMap(after.socialGraph.unresolved);
        graph.unresolved = normalizeSocialGraph({ unresolved: graph.unresolved }).unresolved.flatMap(slot => {
            const id = String(slot?.id || '');
            const then = afterSlots.get(id);
            const was = beforeSlots.get(id);
            if (!id || !then || !jsonEqual(slot, then)) return [slot];
            if (!was) { result.socialEdges += 1; return []; }            // added by the block
            if (jsonEqual(was, then)) return [slot];
            result.socialEdges += 1;
            return [structuredClone(was)];                                // changed by the block
        }).filter(slot => liveIds.has(String(slot?.ownerId || '')));
        // A slot the block consumed (naming that relative) returns when the bond that named it is
        // undone; a bond a retained message kept keeps the slot consumed.
        const liveSlotIds = new Set(graph.unresolved.map(slot => slot.id));
        const consumed = [...beforeSlots.values()]
            .filter(slot => !afterSlots.has(slot.id) && !liveSlotIds.has(slot.id) && liveIds.has(String(slot.ownerId || '')))
            .sort((a, b) => a.id.localeCompare(b.id));
        for (const slot of consumed) {
            const key = `${slot.ownerId}|${slot.groupId}`;
            if (!(undoneGroupBonds.get(key) > 0)) continue;
            undoneGroupBonds.set(key, undoneGroupBonds.get(key) - 1);
            graph.unresolved.push(structuredClone(slot));
            result.socialEdges += 1;
        }
        currentState.socialGraph = graph;
    }
    currentState.candidates = removeAddedItems(currentState.candidates, before.candidates, after.candidates);
    currentState.pendingBackfills = removeAddedItems(currentState.pendingBackfills, before.pendingBackfills, after.pendingBackfills);
    return result;
}

// Whether another dossier started naming this NPC after the deleted block (a retained message used it).
function referencedAfterBlock(liveNpcs, afterNpcs, npc) {
    // Whole-word name or alias matches only: "Wayfarer" names the NPC, "dangerous" does not name Dan.
    const labels = [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(label => String(label || '').trim()).filter(label => label.length >= 2);
    if (!labels.length) return false;
    const wordPattern = (label, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, flags);
    // Resolve against the roster: a label another dossier also carries names nobody, and a label
    // found inside another dossier's longer name ("Tomas" in "Tomas Hale") is that dossier's.
    const rosterLabels = (Array.isArray(liveNpcs) ? liveNpcs : [])
        .filter(other => other && other !== npc && other.id !== npc.id)
        .flatMap(other => [other.name, ...(Array.isArray(other.aliases) ? other.aliases : [])])
        .map(label => String(label || '').trim()).filter(Boolean);
    const rosterKeys = new Set(rosterLabels.map(label => label.toLowerCase()));
    const ownLabels = labels.filter(label => !rosterKeys.has(label.toLowerCase()));
    const mentionsIn = entry => ownLabels.some(label => {
        const masked = rosterLabels
            .filter(other => other.length > label.length && wordPattern(label).test(other))
            .sort((a, b) => b.length - a.length)
            .reduce((text, other) => text.replace(wordPattern(other, 'giu'), '#'), String(entry || ''));
        return wordPattern(label).test(masked);
    });
    const mentions = other => [...(Array.isArray(other?.keyRelationships) ? other.keyRelationships : []), ...(Array.isArray(other?.memories) ? other.memories : [])]
        .some(mentionsIn);
    return (Array.isArray(liveNpcs) ? liveNpcs : []).some(other => other && other !== npc && other.id !== npc.id
        && mentions(other) && !mentions(afterNpcs.get(String(other.id || ''))));
}

// Whether a retained message gave this NPC canonical social continuity: a live, non-inferred graph
// edge to another live NPC that the deleted block's end state did not already hold. The five-item
// bond projection is only a view, so a hidden edge counts as later use too.
function graphUsedAfterBlock(liveGraph, afterGraph, npc, liveNpcs) {
    const id = String(npc?.id || '');
    if (!id) return false;
    const liveIds = new Set((Array.isArray(liveNpcs) ? liveNpcs : []).map(other => String(other?.id || '')));
    const semantic = edge => edge ? [edge.aId, edge.bId, edge.aToB, edge.bToA, edge.aDynamic, edge.bDynamic, edge.confidence].map(value => String(value ?? '')) : null;
    const afterEdges = new Map((Array.isArray(afterGraph?.edges) ? afterGraph.edges : []).map(edge => [String(edge?.id || ''), edge]));
    return (Array.isArray(liveGraph?.edges) ? liveGraph.edges : []).some(edge => {
        if (!edge || edge.inferred === true) return false;
        const a = String(edge.aId || '');
        const b = String(edge.bId || '');
        if (a !== id && b !== id) return false;
        const other = a === id ? b : a;
        if (!other || other === id || !liveIds.has(other)) return false;
        return !jsonEqual(semantic(edge), semantic(afterEdges.get(String(edge.id || ''))));
    });
}

// References to an NPC that was removed together with the deleted block.
function cleanupRemovedNpcs(restored, removed, previousNpcs) {
    for (const item of removed) {
        const record = (Array.isArray(previousNpcs) ? previousNpcs : []).find(npc => String(npc?.id || '') === item.id) || item;
        restored.socialGraph = removeNpcFromSocialGraph(restored.socialGraph, item.id);
        purgeNpcStructuredReferences(restored.npcs, record);
        restored.pendingBackfills = (Array.isArray(restored.pendingBackfills) ? restored.pendingBackfills : [])
            .filter(entry => String(entry?.npcId || '') !== item.id);
        restored.candidates = (Array.isArray(restored.candidates) ? restored.candidates : [])
            .filter(entry => String(entry?.id || '') !== item.id);
    }
    restored.socialGraph = normalizeSocialGraph(restored.socialGraph);
}

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
    inherited.branchParent = best.key;
    inherited.branchForkMessageId = best.checkpoint.messageId;
    inherited.branchFamilyId = String(best.state.branchFamilyId || '');
    ensureBranchFamilyId(inherited, best.key);
    prunePortraitAssetsInPlace(inherited);
    return inherited;
}
