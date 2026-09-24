import { normalizeName } from './core.js';
import { normalizeSocialGraph } from './social.js';

export const BRANCH_HISTORY_LIMIT = 160;

export const DEFAULT_SCAN_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

export function createScanOperationRegistry({
    timeoutMs = DEFAULT_SCAN_OPERATION_TIMEOUT_MS,
    onExpire = null,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
    const active = new Map();
    let sequence = 0;
    const timeout = Math.max(1000, Number(timeoutMs) || DEFAULT_SCAN_OPERATION_TIMEOUT_MS);

    const keyOf = value => String(value || '').trim();
    const isBusy = key => active.has(keyOf(key));
    const isCurrent = (key, operation) => Boolean(operation && active.get(keyOf(key)) === operation && !operation.expired);

    const end = (key, operation) => {
        const normalizedKey = keyOf(key);
        if (!operation || active.get(normalizedKey) !== operation) return false;
        if (operation.timer && typeof clearTimeoutFn === 'function') clearTimeoutFn(operation.timer);
        active.delete(normalizedKey);
        operation.finished = true;
        return true;
    };

    const begin = (key, label = 'scan', metadata = {}) => {
        const normalizedKey = keyOf(key);
        if (!normalizedKey || normalizedKey === 'no-chat' || active.has(normalizedKey)) return null;
        const operation = {
            id: ++sequence,
            key: normalizedKey,
            label: String(label || 'scan'),
            metadata: metadata && typeof metadata === 'object' ? structuredClone(metadata) : {},
            startedAt: Date.now(),
            expired: false,
            finished: false,
            timer: null,
        };
        if (typeof setTimeoutFn === 'function') {
            operation.timer = setTimeoutFn(() => {
                if (active.get(normalizedKey) !== operation) return;
                active.delete(normalizedKey);
                operation.expired = true;
                operation.finished = true;
                try { onExpire?.(operation); } catch (error) { console.warn('[NPC State Delta] scan timeout cleanup callback failed', error); }
            }, timeout);
            operation.timer?.unref?.();
        }
        active.set(normalizedKey, operation);
        return operation;
    };

    const cancel = (key, reason = 'cancelled') => {
        const normalizedKey = keyOf(key);
        const operation = active.get(normalizedKey);
        if (!operation) return null;
        if (operation.timer && typeof clearTimeoutFn === 'function') clearTimeoutFn(operation.timer);
        active.delete(normalizedKey);
        operation.finished = true;
        operation.cancelled = true;
        operation.cancelReason = String(reason || 'cancelled');
        return operation;
    };

    const status = key => {
        const operation = active.get(keyOf(key));
        if (!operation) return null;
        return {
            id: operation.id,
            key: operation.key,
            label: operation.label,
            metadata: structuredClone(operation.metadata || {}),
            startedAt: operation.startedAt,
        };
    };

    return Object.freeze({ begin, end, cancel, isBusy, isCurrent, status });
}

export function firstLineageDivergence(previous = [], current = []) {
    const a = Array.isArray(previous) ? previous : [];
    const b = Array.isArray(current) ? current : [];
    const common = Math.min(a.length, b.length);
    for (let i = 0; i < common; i += 1) {
        if (a[i] !== b[i]) return i;
    }
    return a.length === b.length ? -1 : common;
}

export function classifyLineageRelationship(previous = [], current = []) {
    const a = Array.isArray(previous) ? previous : [];
    const b = Array.isArray(current) ? current : [];
    const common = Math.min(a.length, b.length);
    for (let i = 0; i < common; i += 1) {
        if (a[i] !== b[i]) return { kind: 'replacement-divergence', divergence: i, commonPrefixLength: i };
    }
    if (a.length === b.length) return { kind: 'same', divergence: -1, commonPrefixLength: common };
    if (a.length < b.length) return { kind: 'forward-extension', divergence: a.length, commonPrefixLength: common };
    return { kind: 'tail-truncation', divergence: b.length, commonPrefixLength: common };
}

export function commonPrefixLength(a = [], b = []) {
    const divergence = firstLineageDivergence(a, b);
    return divergence < 0 ? Math.min(a.length, b.length) : divergence;
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

function cloneNpcList(npcs) {
    return Array.isArray(npcs) ? structuredClone(npcs) : [];
}

function cloneNarrativeNpcs(npcs) {
    return cloneNpcList(npcs).map(npc => ({ ...npc, portrait: null }));
}

export function snapshotBranchState(state = {}) {
    return {
        npcs: cloneNarrativeNpcs(state.npcs),
        candidates: Array.isArray(state.candidates) ? structuredClone(state.candidates) : [],
        pendingBackfills: Array.isArray(state.pendingBackfills) ? structuredClone(state.pendingBackfills) : [],
        socialGraph: normalizeSocialGraph(state.socialGraph),
        dismissed: Array.isArray(state.dismissed) ? [...state.dismissed] : [],
        turn: Number(state.turn || 0),
        assistantSinceScan: Number(state.assistantSinceScan || 0),
        lastScanAt: Number(state.lastScanAt || 0),
        lastScannedMessageId: Number.isInteger(state.lastScannedMessageId) ? state.lastScannedMessageId : null,
        scanCount: Number(state.scanCount || 0),
    };
}

export function restoreSnapshotIntoState(current = {}, snapshot = null) {
    if (!snapshot) return { ...current };
    return {
        ...current,
        npcs: cloneNpcList(snapshot.npcs),
        candidates: Array.isArray(snapshot.candidates) ? structuredClone(snapshot.candidates) : [],
        pendingBackfills: Array.isArray(snapshot.pendingBackfills) ? structuredClone(snapshot.pendingBackfills) : [],
        socialGraph: normalizeSocialGraph(snapshot.socialGraph),
        dismissed: Array.isArray(snapshot.dismissed) ? [...snapshot.dismissed] : [],
        turn: Number(snapshot.turn || 0),
        assistantSinceScan: Number(snapshot.assistantSinceScan || 0),
        lastScanAt: Number(snapshot.lastScanAt || 0),
        lastScannedMessageId: Number.isInteger(snapshot.lastScannedMessageId) ? snapshot.lastScannedMessageId : null,
        scanCount: Number(snapshot.scanCount || 0),
    };
}

function npcLabels(npc) {
    return [npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(normalizeName)
        .filter(Boolean);
}

function findNpcForMetadataRestore(npc, currentNpcs = []) {
    const records = Array.isArray(currentNpcs) ? currentNpcs : [];
    if (npc?.id) {
        const exact = records.find(candidate => candidate?.id && candidate.id === npc.id);
        if (exact) return exact;
    }
    const labels = new Set(npcLabels(npc));
    if (!labels.size) return null;
    const matches = records.filter(candidate => npcLabels(candidate).some(label => labels.has(label)));
    return matches.length === 1 ? matches[0] : null;
}

export function normalizeUserDismissedGroups(value = []) {
    const groups = [];
    for (const raw of Array.isArray(value) ? value : []) {
        const labels = [...new Set((Array.isArray(raw?.labels) ? raw.labels : [raw?.primary || (typeof raw === 'string' ? raw : '')])
            .map(normalizeName)
            .filter(Boolean))];
        const ids = [...new Set([
            ...(Array.isArray(raw?.ids) ? raw.ids : []),
            raw?.npcId,
        ].map(value => String(value || '').trim()).filter(Boolean))];
        if (!labels.length && !ids.length) continue;
        const primary = normalizeName(raw?.primary) || labels[0] || '';
        groups.push({
            primary,
            labels,
            ids,
            createdAt: Number(raw?.createdAt || 0) || Date.now(),
        });
    }
    return groups;
}


export function addUserDismissedGroup(groups, npc, { historicalNpcIds = [] } = {}) {
    const labels = [...new Set(npcLabels(npc))];
    const ids = [...new Set([npc?.id, ...(Array.isArray(historicalNpcIds) ? historicalNpcIds : [])]
        .map(value => String(value || '').trim())
        .filter(Boolean))];
    if (!labels.length && !ids.length) return normalizeUserDismissedGroups(groups);
    const existing = normalizeUserDismissedGroups(groups);
    const mergedLabels = new Set(labels);
    const mergedIds = new Set(ids);
    const kept = [];
    for (const group of existing) {
        const idOverlap = group.ids.some(id => mergedIds.has(id));
        const legacyLabelOverlap = !group.ids.length && group.labels.some(label => mergedLabels.has(label));
        if (idOverlap || legacyLabelOverlap) {
            for (const label of group.labels) mergedLabels.add(label);
            for (const id of group.ids) mergedIds.add(id);
        } else kept.push(group);
    }
    kept.push({
        primary: normalizeName(npc?.name) || labels[0] || '',
        labels: [...mergedLabels],
        ids: [...mergedIds],
        createdAt: Date.now(),
    });
    return kept;
}

export function clearUserDismissedGroupsFor(groups, target, { modernByIdOnly = false } = {}) {
    const targetLabels = new Set(typeof target === 'string' ? [normalizeName(target)].filter(Boolean) : npcLabels(target));
    const targetIds = new Set(typeof target === 'string' ? [] : [target?.id, ...(Array.isArray(target?.historicalNpcIds) ? target.historicalNpcIds : [])]
        .map(value => String(value || '').trim()).filter(Boolean));
    const kept = [];
    const removedLabels = new Set();
    const removedIds = new Set();
    for (const group of normalizeUserDismissedGroups(groups)) {
        const matchesId = group.ids.some(id => targetIds.has(id));
        // Callers handling automatic/import identity reconciliation can require modern
        // tombstones to match by stable id. The default keeps the public/manual helper
        // backward-compatible for an explicit name-based resurrection action.
        const matchesLabel = (!modernByIdOnly || !group.ids.length) && group.labels.some(label => targetLabels.has(label));
        if (matchesId || matchesLabel) {
            for (const label of group.labels) removedLabels.add(label);
            for (const id of group.ids) removedIds.add(id);
        } else kept.push(group);
    }
    return { groups: kept, removedLabels: [...removedLabels], removedIds: [...removedIds] };
}


export function preserveUserNpcMetadata(restoredNpcs = [], currentNpcs = []) {
    const restored = cloneNpcList(restoredNpcs);
    const globallyPreserved = [
        'portraitPromptPositive', 'portraitPromptNegative', 'portraitPromptReplace',
        'retentionProtected', 'minor',
    ];
    for (const npc of restored) {
        // Retired dossier metadata must not be resurrected by historical checkpoints.
        delete npc.importance;
        delete npc.manual;
        const current = findNpcForMetadataRestore(npc, currentNpcs);
        if (!current) continue;
        if (current?.portrait?.dataUrl) npc.portrait = structuredClone(current.portrait);
        for (const field of globallyPreserved) {
            if (Object.prototype.hasOwnProperty.call(current, field)) npc[field] = structuredClone(current[field]);
        }
        if (current.manualProfileLocksExplicit) {
            const locked = Array.isArray(current.manualProfileFields) ? [...current.manualProfileFields] : [];
            for (const field of locked) {
                if (Object.prototype.hasOwnProperty.call(current, field)) npc[field] = structuredClone(current[field]);
            }
            npc.manualProfileFields = locked;
            npc.manualProfileLocksExplicit = true;
            if (locked.includes('name')) npc.aliases = structuredClone(current.aliases || npc.aliases || []);
        }
    }
    return restored;
}
