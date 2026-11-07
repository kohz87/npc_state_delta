/* NPC State Delta bundle import helpers: identity matching, id/slot reconciliation, and lock preservation. */
import { normalizeName } from './core.js';
import { normalizeSocialGraph } from './social.js';
import { LOCKED_FIELD_KEYS } from './src/dossier-edit.js';

export function npcKeys(npc) {
    return [...new Set([npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])]
        .map(normalizeName)
        .filter(Boolean))];
}

export function identityMatchIndex(records, npc, { stableIdOnly = false } = {}) {
    const available = records.map((candidate, index) => ({ candidate, index }));
    const incomingKeys = new Set(npcKeys(npc));
    const incomingName = normalizeName(npc?.name);
    const sameId = npc?.id
        ? available.find(entry => String(entry.candidate?.id || '') === String(npc.id))
        : null;
    if (sameId) {
        const candidateKeys = npcKeys(sameId.candidate);
        const labelsAgree = candidateKeys.some(key => incomingKeys.has(key));
        if (labelsAgree || !incomingKeys.size || !candidateKeys.length) return sameId.index;
        // Same stable id with wholly disjoint identity labels is treated as an id collision,
        // not proof that two unrelated dossiers are the same person.
    }
    // An ID-backed deletion tombstone proves that this imported stable id belongs to an older
    // identity. Never collapse it into a different current homonym merely because the names match.
    if (stableIdOnly && npc?.id) return -1;

    if (incomingName) {
        const canonical = available.filter(entry => normalizeName(entry.candidate?.name) === incomingName);
        if (canonical.length === 1) return canonical[0].index;
        if (canonical.length > 1) return -1;
    }

    const aliasMatches = available.filter(entry => npcKeys(entry.candidate).some(key => incomingKeys.has(key)));
    return aliasMatches.length === 1 ? aliasMatches[0].index : -1;
}

export function uniqueImportedId(npc, usedIds) {
    const stem = normalizeName(npc?.name || 'npc')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'npc';
    let counter = 1;
    let id = `npc_import_${stem}`;
    while (usedIds.has(id)) {
        counter += 1;
        id = `npc_import_${stem}_${counter}`;
    }
    return id.slice(0, 100);
}

// Unresolved slot and group ids are generated inside each source chat, so after the atomic id remap a
// coincident id can name a target slot that belongs to a different NPC. Such a collision does not
// make the slots the same relative: rekey the imported slot (and its group, with the imported edges
// that carry it) so both owners keep their count-aware continuity. Same-owner duplicates still merge.
export function rekeyCollidingImportedSlots(importedGraph, currentGraph) {
    const targetSlotOwner = new Map(currentGraph.unresolved.map(slot => [slot.id, slot.ownerId]));
    const targetGroupSlotOwners = new Map();
    for (const slot of currentGraph.unresolved) {
        if (!targetGroupSlotOwners.has(slot.groupId)) targetGroupSlotOwners.set(slot.groupId, new Set());
        targetGroupSlotOwners.get(slot.groupId).add(slot.ownerId);
    }
    // A named bond in a group has the owner on one end and the relative on the other, so it only
    // shows which NPCs the group may belong to; the relative end is not a competing owner.
    const targetGroupEdges = new Map();
    for (const edge of currentGraph.edges) {
        if (!edge.groupId) continue;
        if (!targetGroupEdges.has(edge.groupId)) targetGroupEdges.set(edge.groupId, []);
        targetGroupEdges.get(edge.groupId).push(edge);
    }
    const groupBelongsToOther = (groupId, ownerId) => {
        const slotOwners = targetGroupSlotOwners.get(groupId);
        if (slotOwners && [...slotOwners].some(owner => owner !== ownerId)) return true;
        const edges = targetGroupEdges.get(groupId) || [];
        return edges.length > 0 && !edges.some(edge => edge.aId === ownerId || edge.bId === ownerId);
    };
    const usedSlotIds = new Set([...targetSlotOwner.keys(), ...importedGraph.unresolved.map(slot => slot.id)]);
    const usedGroupIds = new Set([...targetGroupSlotOwners.keys(), ...targetGroupEdges.keys(), ...importedGraph.unresolved.map(slot => slot.groupId), ...importedGraph.edges.map(edge => edge.groupId).filter(Boolean)]);
    const unique = (base, used) => {
        let candidate = String(base).slice(0, 120);
        for (let n = 2; used.has(candidate); n += 1) candidate = `${String(base).slice(0, 112)}~${n}`;
        used.add(candidate);
        return candidate;
    };
    const groupRekey = new Map();
    const unresolved = importedGraph.unresolved.map(slot => {
        const next = { ...slot };
        if (groupBelongsToOther(slot.groupId, slot.ownerId)) {
            const groupKey = `${slot.groupId}|${slot.ownerId}`;
            if (!groupRekey.has(groupKey)) groupRekey.set(groupKey, unique(`${slot.groupId}~${slot.ownerId}`, usedGroupIds));
            next.groupId = groupRekey.get(groupKey);
        }
        if (targetSlotOwner.has(slot.id) && targetSlotOwner.get(slot.id) !== slot.ownerId) next.id = unique(`${slot.id}~${slot.ownerId}`, usedSlotIds);
        return next;
    });
    if (!groupRekey.size && unresolved.every((slot, index) => slot.id === importedGraph.unresolved[index].id)) return importedGraph;
    const edges = importedGraph.edges.map(edge => {
        if (!edge.groupId) return edge;
        const rekeyed = groupRekey.get(`${edge.groupId}|${edge.aId}`) || groupRekey.get(`${edge.groupId}|${edge.bId}`);
        return rekeyed ? { ...edge, groupId: rekeyed } : edge;
    });
    return normalizeSocialGraph({ ...importedGraph, edges, unresolved });
}

export function filterGraphByIds(graph, validIds, rejectedSourceIds = new Set()) {
    const normalized = normalizeSocialGraph(graph);
    return normalizeSocialGraph({
        edges: normalized.edges.filter(edge => !rejectedSourceIds.has(edge.aId)
            && !rejectedSourceIds.has(edge.bId)
            && validIds.has(edge.aId)
            && validIds.has(edge.bId)),
        unresolved: normalized.unresolved.filter(slot => !rejectedSourceIds.has(slot.ownerId) && validIds.has(slot.ownerId)),
        suppressed: (normalized.suppressed || []).filter(entry => !rejectedSourceIds.has(entry.aId)
            && !rejectedSourceIds.has(entry.bId)
            && validIds.has(entry.aId)
            && validIds.has(entry.bId)),
    });
}

export function initImportReport(report) {
    if (!report || typeof report !== 'object') return null;
    report.updated = [];
    report.added = [];
    report.skipped = [];
    report.idRemaps = [];
    report.accepted = [];
    return report;
}

export function preserveTargetManualLocks(oldNpc, importedNpc) {
    const targetLocks = new Set(Array.isArray(oldNpc?.manualProfileFields) ? oldNpc.manualProfileFields : []);
    const sourceLocks = new Set(Array.isArray(importedNpc?.manualProfileFields) ? importedNpc.manualProfileFields : []);
    const merged = { ...oldNpc, ...importedNpc };
    for (const field of targetLocks) {
        for (const key of LOCKED_FIELD_KEYS[field] || []) {
            if (Object.prototype.hasOwnProperty.call(oldNpc || {}, key)) merged[key] = structuredClone(oldNpc[key]);
            else delete merged[key];
        }
    }
    merged.manualProfileFields = [...new Set([...targetLocks, ...sourceLocks])];
    merged.manualProfileLocksExplicit = Boolean(
        oldNpc?.manualProfileLocksExplicit || importedNpc?.manualProfileLocksExplicit || merged.manualProfileFields.length,
    );
    return merged;
}

// Reply numbers (1.2.3, display only) are message indexes in the source chat. A foreign dossier keeps
// its relationship events, which then show as older records do, but never another chat's numbering.
export function withoutSourceReplyNumbers(npc) {
    if (npc.lastRelationshipChange && typeof npc.lastRelationshipChange === 'object') delete npc.lastRelationshipChange.message;
    for (const event of Array.isArray(npc.relationshipEventHistory) ? npc.relationshipEventHistory : []) {
        if (event && typeof event === 'object') delete event.message;
    }
    delete npc.fieldChangeMessages;
}

