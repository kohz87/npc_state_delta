/* Projection of the social graph into Important Bonds and id remapping.
   Split from social.js; social.js remains the public facade. */

import { clean, norm, uniq, confidenceRank, richer } from './social-primitives.js';
import {
    socialRelationFamily, conflictingKinship, inverseRelationFamilies,
    preserveUnstructuredRelationshipText, mergeRelations, collectiveRelationshipShape,
} from './social-relations.js';
import { parseKeyRelationshipEntry, formatKeyRelationship } from './social-bonds.js';
import { resolveNpcReference, normalizeSocialGraph, relationFromPerspective, npcLabels } from './social-graph.js';

function resolvedCollectiveGroup(ownerId, parsed, graph) {
    const shape = collectiveRelationshipShape(parsed);
    if (!shape) return null;
    const byGroup = new Map();
    for (const edge of graph.edges || []) {
        const view = relationFromPerspective(edge, ownerId);
        if (!view || socialRelationFamily(view.relation) !== shape.family || !edge.groupId) continue;
        if (shape.sharedDescriptor && norm(edge.sharedDescriptor) !== norm(shape.sharedDescriptor)) continue;
        const list = byGroup.get(edge.groupId) || [];
        if (!list.some(item => item.view.counterpartId === view.counterpartId)) list.push({ edge, view });
        byGroup.set(edge.groupId, list);
    }
    const matches = [...byGroup.entries()].filter(([groupId, members]) => {
        if (members.length !== shape.expectedCount) return false;
        return !(graph.unresolved || []).some(slot => slot.ownerId === ownerId && slot.groupId === groupId);
    });
    return matches.length === 1 ? { groupId: matches[0][0], members: matches[0][1] } : null;
}

function enrichCollectiveDynamic(ownerId, group, dynamic) {
    if (!group || !dynamic) return;
    for (const { edge } of group.members) {
        if (edge.aId === ownerId) edge.aDynamic = richer(edge.aDynamic, dynamic);
        else if (edge.bId === ownerId) edge.bDynamic = richer(edge.bDynamic, dynamic);
    }
}

function projectGraphToKeyRelationships(npcs, graph) {
    const updatedIds = [];
    for (const owner of npcs || []) {
        if (!owner || (Array.isArray(owner.manualProfileFields) && owner.manualProfileFields.includes('keyRelationships'))) continue;
        const existingParsed = [];
        const unresolvedText = [];
        for (const entry of Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(entry);
            if (!parsed) {
                const fallback = clean(entry, 420);
                if (preserveUnstructuredRelationshipText(fallback)) unresolvedText.push(fallback);
                continue;
            }
            const counterpart = resolveNpcReference(npcs, parsed.subject);
            if (!counterpart || counterpart.id === owner.id) {
                const collective = resolvedCollectiveGroup(owner.id, parsed, graph);
                if (collective) {
                    enrichCollectiveDynamic(owner.id, collective, parsed.dynamic);
                    continue;
                }
                unresolvedText.push(formatKeyRelationship(parsed.subject, parsed.relation, parsed.dynamic));
            } else existingParsed.push({ counterpartId: counterpart.id, relation: parsed.relation, dynamic: parsed.dynamic, score: 100, own: true });
        }
        const byCounterpart = new Map(existingParsed.map(item => [item.counterpartId, item]));
        for (const edge of graph.edges) {
            const view = relationFromPerspective(edge, owner.id);
            if (!view) continue;
            const counterpart = npcs.find(npc => npc?.id === view.counterpartId);
            if (!counterpart) continue;
            const score = (counterpart.present ? 40 : 0) + (counterpart.worldActive ? 10 : 0) + (counterpart.lifeState === 'deceased' ? 3 : 0) + confidenceRank(edge.confidence) * 3;
            if (byCounterpart.has(counterpart.id)) {
                const item = byCounterpart.get(counterpart.id);
                if (edge.confidence === 'explicit' && inverseRelationFamilies(socialRelationFamily(item.relation), socialRelationFamily(view.relation))) {
                    item.relation = view.relation;
                } else if (item.own && conflictingKinship(item.relation, view.relation)) {
                    // A blood tie mirrored from the other side never overrides this NPC's own
                    // statement; a wrong entry on one dossier must not spread to the other.
                } else {
                    item.relation = mergeRelations(item.relation, view.relation);
                }
                item.dynamic = richer(item.dynamic, view.dynamic);
                item.score = Math.max(item.score, score);
            } else byCounterpart.set(counterpart.id, { counterpartId: counterpart.id, relation: view.relation, dynamic: view.dynamic, score });
        }
        const rendered = [...byCounterpart.values()]
            .sort((a, b) => b.score - a.score)
            .map(item => {
                const counterpart = npcs.find(npc => npc?.id === item.counterpartId);
                return counterpart ? formatKeyRelationship(counterpart.name, item.relation, item.dynamic, counterpart) : '';
            }).filter(Boolean);
        const next = [...unresolvedText, ...rendered].filter(Boolean).slice(0, 5);
        const before = JSON.stringify(owner.keyRelationships || []);
        owner.keyRelationships = next;
        if (JSON.stringify(next) !== before) updatedIds.push(owner.id);
    }
    return updatedIds;
}

// Apply a whole old-to-new id map in one pass. Renaming one id at a time (with normalization in
// between) breaks permutations: swapping A and B first merges them into a self-edge that is dropped.
export function remapSocialGraphNpcIds(rawGraph, idMap) {
    const graph = normalizeSocialGraph(rawGraph);
    const map = new Map([...(idMap instanceof Map ? idMap.entries() : Object.entries(idMap || {}))]
        .map(([from, to]) => [clean(from, 100), clean(to, 100)])
        .filter(([from, to]) => from && to && from !== to));
    if (!map.size) return graph;
    const remap = id => (map.has(id) ? map.get(id) : id);
    for (const edge of graph.edges) {
        edge.aId = remap(edge.aId);
        edge.bId = remap(edge.bId);
    }
    for (const slot of graph.unresolved) slot.ownerId = remap(slot.ownerId);
    for (const entry of graph.suppressed || []) {
        entry.aId = remap(entry.aId);
        entry.bId = remap(entry.bId);
        entry.basis = String(entry.basis || '').split(',').filter(Boolean).map(remap).sort().join(',');
    }
    return normalizeSocialGraph(graph);
}

export function remapSocialGraphNpcId(rawGraph, fromId, toId) {
    const graph = normalizeSocialGraph(rawGraph);
    const from = clean(fromId, 100); const to = clean(toId, 100);
    if (!from || !to || from === to) return graph;
    for (const edge of graph.edges) {
        if (edge.aId === from) edge.aId = to;
        if (edge.bId === from) edge.bId = to;
    }
    for (const slot of graph.unresolved) if (slot.ownerId === from) slot.ownerId = to;
    for (const entry of graph.suppressed || []) {
        if (entry.aId === from) entry.aId = to;
        if (entry.bId === from) entry.bId = to;
        // The basis lists the shared parents' ids.
        entry.basis = String(entry.basis || '').split(',').filter(Boolean).map(id => (id === from ? to : id)).sort().join(',');
    }
    return normalizeSocialGraph(graph);
}


export function purgeNpcStructuredReferences(npcs = [], removedNpc = null) {
    if (!removedNpc) return [];
    const labels = new Set([removedNpc.name, ...(removedNpc.aliases || [])].map(norm).filter(Boolean));
    const updated = [];
    for (const npc of npcs || []) {
        if (!npc || npc.id === removedNpc.id) continue;
        const before = JSON.stringify(npc.keyRelationships || []);
        npc.keyRelationships = (Array.isArray(npc.keyRelationships) ? npc.keyRelationships : []).filter(entry => {
            const parsed = parseKeyRelationshipEntry(entry);
            return !parsed || !labels.has(norm(parsed.subject));
        });
        if (JSON.stringify(npc.keyRelationships || []) !== before) updated.push(npc.id);
    }
    return updated;
}

export function removeNpcFromSocialGraph(rawGraph, npcId) {
    const graph = normalizeSocialGraph(rawGraph);
    const id = clean(npcId, 100);
    graph.edges = graph.edges.filter(edge => edge.aId !== id && edge.bId !== id);
    graph.unresolved = graph.unresolved.filter(slot => slot.ownerId !== id);
    return graph;
}

export function socialGraphLabelsForNpc(rawGraph, npcId, npcs = []) {
    const graph = normalizeSocialGraph(rawGraph);
    const labels = [];
    for (const edge of graph.edges) {
        const view = relationFromPerspective(edge, npcId);
        if (!view) continue;
        const counterpart = npcs.find(npc => npc?.id === view.counterpartId);
        if (counterpart) labels.push(...npcLabels(counterpart));
    }
    return uniq(labels);
}

export {
    resolvedCollectiveGroup, enrichCollectiveDynamic, projectGraphToKeyRelationships,
};
