/* Social graph shapes, normalization, edge merging and reference resolution.
   Split from social.js; social.js remains the public facade. */

import {
    clean, norm, uniq, slug, confidenceRank, richer,
    SOCIAL_GRAPH_VERSION, SOCIAL_GRAPH_EDGE_LIMIT,
    SOCIAL_GRAPH_UNRESOLVED_LIMIT, SOCIAL_GRAPH_SUPPRESSED_LIMIT,
} from './social-primitives.js';
import {
    socialRelationFamily, splitRelationDynamic, withFoldedDynamic,
    sanitizeRelationshipRelation, inverseSocialRelation, mergeRelations,
} from './social-relations.js';

export function resolveNpcReference(npcs = [], labelOrId = '') {
    const raw = clean(labelOrId, 120);
    if (!raw) return null;
    const byId = (npcs || []).filter(npc => String(npc?.id || '') === raw);
    if (byId.length === 1) return byId[0];
    const key = norm(raw);
    if (!key) return null;
    const matches = (npcs || []).filter(npc => [npc?.name, ...(npc?.aliases || [])].some(value => norm(value) === key));
    return matches.length === 1 ? matches[0] : null;
}

// Normalization must be idempotent: Number(null) is 0, so an absent turn would otherwise become
// turn 0 on the next pass and no longer compare equal to its own snapshot.
function optionalTurn(value) {
    if (value === null || value === undefined || value === '') return null;
    const turn = Number(value);
    return Number.isFinite(turn) ? turn : null;
}

function edgeKey(edge) {
    const a = clean(edge?.aId, 100);
    const b = clean(edge?.bId, 100);
    const af = socialRelationFamily(edge?.aToB);
    const bf = socialRelationFamily(edge?.bToA);
    return `${a}|${b}|${af}|${bf}`;
}

function normalizeEdge(raw = {}) {
    const aId = clean(raw.aId ?? raw.a_id, 100);
    const bId = clean(raw.bId ?? raw.b_id, 100);
    if (!aId || !bId || aId === bId) return null;
    const aSplit = splitRelationDynamic(raw.aToB ?? raw.a_to_b ?? raw.relation);
    const bSplit = splitRelationDynamic(raw.bToA ?? raw.b_to_a ?? raw.reverseRelation);
    const aToB = sanitizeRelationshipRelation('', aSplit.relation);
    let bToA = sanitizeRelationshipRelation('', bSplit.relation) || inverseSocialRelation(aToB);
    // A reverse side that repeats the forward text is a mirrored copy ("half-elf cousin" both ways);
    // keep it only when the relation is genuinely its own inverse.
    if (aToB && norm(bToA) === norm(aToB) && norm(inverseSocialRelation(aToB)) !== norm(aToB)) bToA = inverseSocialRelation(aToB);
    if (!aToB && !bToA) return null;
    const confidence = clean(raw.confidence, 40) || 'migration';
    return {
        id: clean(raw.id, 120) || `edge_${slug(`${aId}-${bId}-${socialRelationFamily(aToB)}-${socialRelationFamily(bToA)}`)}`,
        aId,
        bId,
        aToB,
        bToA,
        aDynamic: withFoldedDynamic(raw.aDynamic ?? raw.a_dynamic, aSplit.dynamic),
        bDynamic: withFoldedDynamic(raw.bDynamic ?? raw.b_dynamic, bSplit.dynamic),
        provenance: clean(raw.provenance, 40) || 'migration',
        confidence,
        reason: clean(raw.reason ?? raw.evidence, 300),
        sourceMessageId: Number.isInteger(raw.sourceMessageId) ? raw.sourceMessageId : null,
        turn: optionalTurn(raw.turn),
        groupId: clean(raw.groupId ?? raw.group_id, 120),
        sharedDescriptor: clean(raw.sharedDescriptor ?? raw.shared_descriptor, 120),
        inferred: raw.inferred === true && confidenceRank(confidence) < confidenceRank('explicit'),
    };
}

function normalizeUnresolved(raw = {}) {
    const ownerId = clean(raw.ownerId ?? raw.owner_id, 100);
    const relation = clean(raw.relation, 180);
    if (!ownerId || !relation) return null;
    return {
        id: clean(raw.id, 120) || `slot_${slug(`${ownerId}-${relation}-${raw.groupId || ''}-${raw.slotIndex ?? ''}-${raw.descriptor || ''}`)}`,
        ownerId,
        relation,
        inverseRelation: clean(raw.inverseRelation ?? raw.inverse_relation, 180) || inverseSocialRelation(relation),
        groupId: clean(raw.groupId ?? raw.group_id, 120) || `group_${slug(`${ownerId}-${socialRelationFamily(relation)}`)}`,
        descriptor: clean(raw.descriptor, 180),
        sharedDescriptor: clean(raw.sharedDescriptor ?? raw.shared_descriptor, 180),
        provenance: clean(raw.provenance, 40) || 'migration',
        confidence: clean(raw.confidence, 40) || 'migration',
        reason: clean(raw.reason ?? raw.evidence, 300),
        sourceMessageId: Number.isInteger(raw.sourceMessageId) ? raw.sourceMessageId : null,
        turn: optionalTurn(raw.turn),
    };
}

export function normalizeSocialGraph(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const edges = [];
    const edgeIndex = new Map();
    const sourceEdges = (Array.isArray(source.edges) ? source.edges : [])
        .map((item, index) => ({ item, index }))
        .sort((a, b) => Number(Boolean(a.item?.inferred)) - Number(Boolean(b.item?.inferred))
            || confidenceRank(b.item?.confidence) - confidenceRank(a.item?.confidence)
            || a.index - b.index)
        .map(entry => entry.item);
    for (const item of sourceEdges) {
        const edge = normalizeEdge(item);
        if (!edge) continue;
        const key = edgeKey(edge);
        // The same shared pair stored in the opposite orientation is one edge (as in addEdge), and
        // must merge before the capacity check rather than take a unique edge's slot.
        const reverseKey = `${edge.bId}|${edge.aId}|${socialRelationFamily(edge.bToA)}|${socialRelationFamily(edge.aToB)}`;
        const existingIndex = edgeIndex.has(key) ? edgeIndex.get(key) : edgeIndex.get(reverseKey);
        if (existingIndex !== undefined) {
            const current = edges[existingIndex];
            const reversed = current.aId !== edge.aId;
            current.aToB = mergeRelations(current.aToB, reversed ? edge.bToA : edge.aToB);
            current.bToA = mergeRelations(current.bToA, reversed ? edge.aToB : edge.bToA);
            current.aDynamic = richer(current.aDynamic, reversed ? edge.bDynamic : edge.aDynamic);
            current.bDynamic = richer(current.bDynamic, reversed ? edge.aDynamic : edge.bDynamic);
            if (confidenceRank(edge.confidence) >= confidenceRank(current.confidence)) {
                current.confidence = edge.confidence;
                current.provenance = edge.provenance;
                current.reason = edge.reason || current.reason;
                current.sourceMessageId = edge.sourceMessageId ?? current.sourceMessageId;
                current.turn = edge.turn ?? current.turn;
                current.inferred = edge.inferred;
            }
            current.groupId ||= edge.groupId;
            current.sharedDescriptor ||= edge.sharedDescriptor;
            continue;
        }
        edgeIndex.set(key, edges.length);
        edges.push(edge);
        if (edges.length >= SOCIAL_GRAPH_EDGE_LIMIT) break;
    }
    const unresolved = [];
    const unresolvedSeen = new Set();
    for (const item of Array.isArray(source.unresolved) ? source.unresolved : []) {
        const slot = normalizeUnresolved(item);
        if (!slot || unresolvedSeen.has(slot.id)) continue;
        unresolvedSeen.add(slot.id);
        unresolved.push(slot);
        if (unresolved.length >= SOCIAL_GRAPH_UNRESOLVED_LIMIT) break;
    }
    // Pairs a user removed by hand that inference must not recreate from the same evidence.
    // At capacity the oldest removals give way: the newest entries are last, and dropping one just
    // made would let inference recreate the bond the user just deleted.
    const suppressed = [];
    for (const item of (Array.isArray(source.suppressed) ? source.suppressed : []).slice().reverse()) {
        const aId = clean(item?.aId, 100);
        const bId = clean(item?.bId, 100);
        if (!aId || !bId || aId === bId) continue;
        const [first, second] = [aId, bId].sort();
        const basis = clean(item?.basis, 400);
        if (suppressed.some(entry => entry.aId === first && entry.bId === second && entry.basis === basis)) continue;
        suppressed.push({ aId: first, bId: second, basis });
        if (suppressed.length >= SOCIAL_GRAPH_SUPPRESSED_LIMIT) break;
    }
    suppressed.reverse();
    return suppressed.length ? { version: SOCIAL_GRAPH_VERSION, edges, unresolved, suppressed } : { version: SOCIAL_GRAPH_VERSION, edges, unresolved };
}

function addEdge(graph, raw) {
    const edge = normalizeEdge(raw);
    if (!edge) return null;
    const key = edgeKey(edge);
    const index = graph.edges.findIndex(item => edgeKey(item) === key || (item.aId === edge.bId && item.bId === edge.aId
        && socialRelationFamily(item.aToB) === socialRelationFamily(edge.bToA)
        && socialRelationFamily(item.bToA) === socialRelationFamily(edge.aToB)));
    if (index >= 0) {
        const current = graph.edges[index];
        const reversed = current.aId === edge.bId && current.bId === edge.aId;
        const incomingAToB = reversed ? edge.bToA : edge.aToB;
        const incomingBToA = reversed ? edge.aToB : edge.bToA;
        const incomingADyn = reversed ? edge.bDynamic : edge.aDynamic;
        const incomingBDyn = reversed ? edge.aDynamic : edge.bDynamic;
        current.aToB = mergeRelations(current.aToB, incomingAToB);
        current.bToA = mergeRelations(current.bToA, incomingBToA);
        current.aDynamic = richer(current.aDynamic, incomingADyn);
        current.bDynamic = richer(current.bDynamic, incomingBDyn);
        if (confidenceRank(edge.confidence) >= confidenceRank(current.confidence)) {
            current.confidence = edge.confidence;
            current.provenance = edge.provenance;
            current.reason = edge.reason || current.reason;
            current.sourceMessageId = edge.sourceMessageId ?? current.sourceMessageId;
            current.turn = edge.turn ?? current.turn;
            current.inferred = edge.inferred;
        }
        current.groupId ||= edge.groupId;
        current.sharedDescriptor ||= edge.sharedDescriptor;
        return current;
    }
    if (graph.edges.length >= SOCIAL_GRAPH_EDGE_LIMIT) {
        const incomingRank = confidenceRank(edge.confidence);
        if (incomingRank <= confidenceRank('inferred')) return null;
        let evictionIndex = -1;
        let evictionRank = Infinity;
        for (let i = 0; i < graph.edges.length; i += 1) {
            const current = graph.edges[i];
            const rank = confidenceRank(current.confidence);
            if (rank >= incomingRank || rank >= evictionRank) continue;
            evictionRank = rank;
            evictionIndex = i;
        }
        // Capacity pressure may discard weaker inferred/migration continuity, but a new edge
        // never evicts an equal- or higher-authority explicit/manual relationship.
        if (evictionIndex < 0) return null;
        graph.edges.splice(evictionIndex, 1);
    }
    graph.edges.push(edge);
    return edge;
}

function relationFromPerspective(edge, ownerId) {
    if (edge.aId === ownerId) return { counterpartId: edge.bId, relation: edge.aToB, dynamic: edge.aDynamic, reverse: edge.bToA, reverseDynamic: edge.bDynamic };
    if (edge.bId === ownerId) return { counterpartId: edge.aId, relation: edge.bToA, dynamic: edge.bDynamic, reverse: edge.aToB, reverseDynamic: edge.aDynamic };
    return null;
}

function npcLabels(npc) {
    return uniq([npc?.name, ...(npc?.aliases || [])]);
}

function pairConnects(edge, aId, bId) {
    return (edge.aId === aId && edge.bId === bId) || (edge.aId === bId && edge.bId === aId);
}

export {
    optionalTurn, edgeKey, normalizeEdge, normalizeUnresolved, addEdge,
    relationFromPerspective, npcLabels, pairConnects,
};
