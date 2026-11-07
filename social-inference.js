/* Shared-parent sibling inference and its suppression rules.
   Split from social.js; social.js remains the public facade. */

import { KINSHIP_RELATION_FAMILIES, socialRelationFamily, kinshipParts } from './social-relations.js';
import { addEdge, pairConnects, relationFromPerspective } from './social-graph.js';
import { establishedCounterpartRelation } from './social-scan.js';

// Two children of one parent are siblings unless either already names a different blood tie to the
// other ("Greta — aunt"); a wrong parent entry must not keep overriding what the dossiers say.
function statedOtherKinship(graph, npcs, aId, bId) {
    const a = npcs.find(npc => npc?.id === aId);
    const b = npcs.find(npc => npc?.id === bId);
    const statements = [
        a && b ? establishedCounterpartRelation(a, b, npcs) : '',
        a && b ? establishedCounterpartRelation(b, a, npcs) : '',
        ...graph.edges.filter(edge => !edge.inferred && pairConnects(edge, aId, bId)).flatMap(edge => [edge.aToB, edge.bToA]),
    ];
    return statements.some(value => {
        const family = socialRelationFamily(kinshipParts(value)[0] || '');
        return KINSHIP_RELATION_FAMILIES.has(family) && family !== 'sibling';
    });
}

// The parents that currently make two NPCs siblings; a manual removal is honoured until this changes.
function sharedParentBasis(graph, aId, bId) {
    const parentsOf = childId => new Set(graph.edges.flatMap(edge => [edge.aId, edge.bId]
        .filter(ownerId => ownerId !== childId && relationFromPerspective(edge, ownerId)?.counterpartId === childId
            && socialRelationFamily(relationFromPerspective(edge, ownerId).relation) === 'child')));
    const bParents = parentsOf(bId);
    return [...parentsOf(aId)].filter(id => bParents.has(id)).sort().join(',');
}

function inferenceSuppressed(graph, aId, bId) {
    const [first, second] = [aId, bId].sort();
    return (graph.suppressed || []).some(entry => entry.aId === first && entry.bId === second
        && entry.basis === sharedParentBasis(graph, aId, bId));
}

function inferSiblingEdges(graph, npcs = []) {
    graph.edges = graph.edges.filter(edge => !(edge.inferred && socialRelationFamily(edge.aToB) === 'sibling'
        && (statedOtherKinship(graph, npcs, edge.aId, edge.bId) || inferenceSuppressed(graph, edge.aId, edge.bId))));
    const childByParent = new Map();
    for (const edge of graph.edges) {
        for (const ownerId of [edge.aId, edge.bId]) {
            const view = relationFromPerspective(edge, ownerId);
            if (!view || socialRelationFamily(view.relation) !== 'child') continue;
            if (!childByParent.has(ownerId)) childByParent.set(ownerId, []);
            childByParent.get(ownerId).push({ childId: view.counterpartId, groupId: edge.groupId, sharedDescriptor: edge.sharedDescriptor });
        }
    }
    for (const children of childByParent.values()) {
        const unique = [...new Map(children.map(item => [item.childId, item])).values()].slice(0, 12);
        for (let i = 0; i < unique.length; i += 1) {
            for (let j = i + 1; j < unique.length; j += 1) {
                const a = unique[i]; const b = unique[j];
                const twin = a.groupId && a.groupId === b.groupId && (a.sharedDescriptor === 'twins' || b.sharedDescriptor === 'twins');
                if (statedOtherKinship(graph, npcs, a.childId, b.childId) || inferenceSuppressed(graph, a.childId, b.childId)) continue;
                addEdge(graph, { aId: a.childId, bId: b.childId, aToB: twin ? 'twin sibling' : 'sibling', bToA: twin ? 'twin sibling' : 'sibling', provenance: 'inferred', confidence: 'inferred', reason: 'shared established parent', inferred: true, groupId: a.groupId && a.groupId === b.groupId ? a.groupId : '', sharedDescriptor: twin ? 'twins' : '' });
            }
        }
    }
}

export {
    statedOtherKinship, sharedParentBasis, inferenceSuppressed, inferSiblingEdges,
};
