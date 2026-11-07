// Incremental rollback undo records for dossiers, keyed records, the social graph and scalar state.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

import * as branchCore from './branch-core.js';
import { normalizeSocialGraph, removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';
import { cloneNpcList, jsonEqual } from './branch-util.js';

const ROLLBACK_SCALAR_KEYS = Object.freeze([
    'turn',
    'assistantSinceScan',
    'lastScanAt',
    'lastScannedMessageId',
    'readAhead',
    'scanCount',
]);

export function rollbackSnapshot(state) {
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
