/* Public social-graph facade. Cohesive implementation parts live in social-*.js. */
import {
    clean,
    SOCIAL_GRAPH_VERSION, SOCIAL_GRAPH_EDGE_LIMIT, SOCIAL_GRAPH_UNRESOLVED_LIMIT,
    SOCIAL_GRAPH_SUPPRESSED_LIMIT, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS, SOCIAL_DYNAMIC_MAX_CHARS,
} from './social-primitives.js';
import { socialRelationFamily, inverseSocialRelation } from './social-relations.js';
import { parseKeyRelationshipEntry, compactSocialKeyRelationship } from './social-bonds.js';
import { resolveNpcReference, normalizeSocialGraph, addEdge } from './social-graph.js';
import {
    canonicalizeNpcKeyRelationships, alignGraphWithCanonicalRelationships,
    parseScanEdges, edgeFromKeyRelationship,
} from './social-scan.js';
import { extractUnresolvedSocialFacts, ensureUnresolvedFacts, resolveSlotsFromEdges } from './social-facts.js';
import { inferSiblingEdges } from './social-inference.js';
import {
    projectGraphToKeyRelationships, remapSocialGraphNpcIds, remapSocialGraphNpcId,
    purgeNpcStructuredReferences, removeNpcFromSocialGraph, socialGraphLabelsForNpc,
} from './social-projection.js';
import { applyManualKeyRelationshipEdit, repairMirroredKeyRelationships } from './social-manual.js';

export function reconcileSocialState(state = {}, options = {}) {
    const next = state && typeof state === 'object' ? state : {};
    const npcs = Array.isArray(next.npcs) ? next.npcs : [];
    canonicalizeNpcKeyRelationships(npcs);
    let graph = normalizeSocialGraph(next.socialGraph);
    const npcIds = new Set(npcs.map(npc => clean(npc?.id, 100)).filter(Boolean));
    graph.edges = graph.edges.filter(edge => npcIds.has(edge.aId) && npcIds.has(edge.bId));
    graph.unresolved = graph.unresolved.filter(slot => npcIds.has(slot.ownerId));
    graph = alignGraphWithCanonicalRelationships(graph, npcs);
    repairMirroredKeyRelationships(npcs, graph);
    const meta = { provenance: options.provenance || 'scanner', sourceMessageId: options.sourceMessageId, turn: options.turn };

    for (const edge of parseScanEdges(options.scanResult || {}, npcs, meta)) addEdge(graph, edge);
    for (const owner of npcs) {
        const locked = Array.isArray(owner.manualProfileFields) && owner.manualProfileFields.includes('keyRelationships');
        for (const raw of Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(raw);
            if (!parsed) continue;
            const keyConfidence = locked ? 'manual' : ((options.provenance || '') === 'scanner' ? 'strong-context' : (options.confidence || 'migration'));
            const edge = edgeFromKeyRelationship(owner, parsed, npcs, { provenance: locked ? 'manual' : (options.provenance || 'keyRelationships'), confidence: keyConfidence, reason: locked ? 'manual key relationship' : 'structured key relationship', sourceMessageId: options.sourceMessageId, turn: options.turn });
            if (edge) addEdge(graph, edge);
            else if (/^(?:daughter|son|child|sister|brother|sibling)$/i.test(parsed.subject)) {
                ensureUnresolvedFacts(graph, [{ ownerId: owner.id, count: 1, relation: parsed.subject, descriptors: [parsed.dynamic], provenance: locked ? 'manual' : 'migration', confidence: locked ? 'manual' : 'migration', reason: raw, sourceMessageId: options.sourceMessageId, turn: options.turn }]);
            }
        }
    }
    const transcriptFacts = extractUnresolvedSocialFacts(options.transcript || '', npcs, meta);
    ensureUnresolvedFacts(graph, transcriptFacts);
    resolveSlotsFromEdges(graph);
    inferSiblingEdges(graph, npcs);
    graph = normalizeSocialGraph(graph);
    const updatedIds = projectGraphToKeyRelationships(npcs, graph);
    next.socialGraph = graph;
    return { state: next, socialGraph: graph, updatedIds, unresolvedAdded: transcriptFacts.length };
}

export {
    SOCIAL_GRAPH_VERSION, SOCIAL_GRAPH_EDGE_LIMIT, SOCIAL_GRAPH_UNRESOLVED_LIMIT,
    SOCIAL_GRAPH_SUPPRESSED_LIMIT, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS, SOCIAL_DYNAMIC_MAX_CHARS,
    socialRelationFamily, inverseSocialRelation,
    parseKeyRelationshipEntry, compactSocialKeyRelationship,
    resolveNpcReference, normalizeSocialGraph,
    canonicalizeNpcKeyRelationships, extractUnresolvedSocialFacts,
    remapSocialGraphNpcIds, remapSocialGraphNpcId,
    purgeNpcStructuredReferences, removeNpcFromSocialGraph, socialGraphLabelsForNpc,
    applyManualKeyRelationshipEdit,
};
