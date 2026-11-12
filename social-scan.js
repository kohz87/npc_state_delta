/* Scanner social edges and canonical relationship alignment.
   Split from social.js; social.js remains the public facade. */

import { clean, norm, richer, projectedTieLimit } from './social-primitives.js';
import {
    socialRelationFamily, inverseRelationFamilies, inverseSocialRelation,
    preserveUnstructuredRelationshipText, splitRelationDynamic, withFoldedDynamic,
    sanitizeRelationshipRelation, mergeRelations,
} from './social-relations.js';
import { parseKeyRelationshipEntry, formatKeyRelationship } from './social-bonds.js';
import { resolveNpcReference, normalizeSocialGraph, npcLabels } from './social-graph.js';

export function canonicalizeNpcKeyRelationships(npcs = [], { includeLocked = false } = {}) {
    const updatedIds = [];
    const records = Array.isArray(npcs) ? npcs : [];
    for (const owner of records) {
        if (!owner) continue;
        if (!includeLocked && Array.isArray(owner.manualProfileFields) && owner.manualProfileFields.includes('keyRelationships')) continue;
        const entries = [];
        const byCounterpart = new Map();
        for (const raw of Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(raw);
            if (!parsed) {
                const fallback = clean(raw, 420);
                if (preserveUnstructuredRelationshipText(fallback)) entries.push(fallback);
                continue;
            }
            const counterpart = resolveNpcReference(records, parsed.subject);
            if (!counterpart || counterpart.id === owner.id) {
                entries.push(formatKeyRelationship(parsed.subject, parsed.relation, parsed.dynamic));
                continue;
            }
            const candidate = { counterpart, relation: parsed.relation, dynamic: parsed.dynamic };
            if (byCounterpart.has(counterpart.id)) {
                const existing = byCounterpart.get(counterpart.id);
                existing.relation = mergeRelations(existing.relation, candidate.relation);
                existing.dynamic = richer(existing.dynamic, candidate.dynamic);
            } else {
                byCounterpart.set(counterpart.id, candidate);
            }
        }
        for (const { counterpart, relation, dynamic } of byCounterpart.values()) entries.push(formatKeyRelationship(counterpart.name, relation, dynamic, counterpart));
        const structuredBodies = entries.map(parseKeyRelationshipEntry).filter(Boolean)
            .map(item => norm(`${item.relation} ${item.dynamic}`)).filter(Boolean);
        const deduped = [];
        const seen = new Set();
        for (const entry of entries) {
            const key = norm(entry);
            if (!entry || seen.has(key)) continue;
            const parsed = parseKeyRelationshipEntry(entry);
            if (!parsed && key.length >= 24 && structuredBodies.some(body => body.includes(key))) continue;
            seen.add(key);
            deduped.push(entry);
        }
        const before = JSON.stringify(owner.keyRelationships || []);
        owner.keyRelationships = deduped.slice(0, projectedTieLimit(owner));
        if (JSON.stringify(owner.keyRelationships) !== before) updatedIds.push(owner.id);
    }
    return updatedIds;
}

function establishedCounterpartRelation(owner, counterpart, npcs = []) {
    if (!owner?.id || !counterpart?.id) return '';
    for (const raw of Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []) {
        const parsed = parseKeyRelationshipEntry(raw);
        if (!parsed) continue;
        const target = resolveNpcReference(npcs, parsed.subject);
        if (target?.id === counterpart.id) return parsed.relation;
    }
    return '';
}

function relationAgreement(established, candidate) {
    const establishedFamily = socialRelationFamily(established);
    const candidateFamily = socialRelationFamily(candidate);
    if (!establishedFamily || !candidateFamily) return 0;
    return establishedFamily === candidateFamily ? 1 : 0;
}

function alignGraphWithCanonicalRelationships(graph, npcs = []) {
    for (const edge of graph.edges || []) {
        if (edge.confidence === 'explicit') continue;
        const a = npcs.find(npc => npc?.id === edge.aId);
        const b = npcs.find(npc => npc?.id === edge.bId);
        if (!a || !b) continue;
        const aEstablished = establishedCounterpartRelation(a, b, npcs);
        const bEstablished = establishedCounterpartRelation(b, a, npcs);
        if (aEstablished && inverseRelationFamilies(aEstablished, edge.aToB)) {
            edge.aToB = aEstablished;
            edge.bToA = bEstablished || inverseSocialRelation(aEstablished);
            continue;
        }
        if (bEstablished && inverseRelationFamilies(bEstablished, edge.bToA)) {
            edge.bToA = bEstablished;
            edge.aToB = aEstablished || inverseSocialRelation(bEstablished);
        }
    }
    return normalizeSocialGraph(graph);
}

function edgeDirectionGrounded(a, b, aToB, bToA, text = '') {
    const source = norm(text);
    if (!source) return 0;
    const aLabels = npcLabels(a).map(norm).filter(Boolean);
    const bLabels = npcLabels(b).map(norm).filter(Boolean);
    const aRel = norm(aToB);
    const bRel = norm(bToA);
    let givenScore = 0;
    let swappedScore = 0;
    for (const bName of bLabels) {
        for (const aName of aLabels) {
            if (aRel && (source.includes(`${bName} is ${aName}'s ${aRel}`)
                || source.includes(`${bName} is ${aName}s ${aRel}`)
                || source.includes(`${bName} is the ${aRel} of ${aName}`))) {
                givenScore += 2;
            }
            if (bRel && (source.includes(`${aName} is ${bName}'s ${bRel}`)
                || source.includes(`${aName} is ${bName}s ${bRel}`)
                || source.includes(`${aName} is the ${bRel} of ${bName}`))) {
                givenScore += 2;
            }
            if (bRel && (source.includes(`${bName} is ${aName}'s ${bRel}`)
                || source.includes(`${bName} is ${aName}s ${bRel}`)
                || source.includes(`${bName} is the ${bRel} of ${aName}`))) {
                swappedScore += 2;
            }
            if (aRel && (source.includes(`${aName} is ${bName}'s ${aRel}`)
                || source.includes(`${aName} is ${bName}s ${aRel}`)
                || source.includes(`${aName} is the ${aRel} of ${bName}`))) {
                swappedScore += 2;
            }
        }
    }
    return givenScore - swappedScore;
}

function parseScanEdges(scanResult = {}, npcs = [], meta = {}) {
    const raw = scanResult?.keyRelationshipEdges ?? scanResult?.key_relationship_edges ?? scanResult?.socialRelationships ?? scanResult?.social_relationships ?? [];
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        const a = resolveNpcReference(npcs, item?.aId ?? item?.a_id ?? item?.a ?? item?.from ?? item?.source ?? '');
        const b = resolveNpcReference(npcs, item?.bId ?? item?.b_id ?? item?.b ?? item?.to ?? item?.target ?? '');
        if (!a || !b || a.id === b.id) continue;
        const aSplit = splitRelationDynamic(item?.aToB ?? item?.a_to_b ?? item?.fromTo ?? item?.from_to ?? item?.relation ?? item?.relationship);
        const bSplit = splitRelationDynamic(item?.bToA ?? item?.b_to_a ?? item?.toFrom ?? item?.to_from ?? item?.reverseRelation ?? item?.reverse_relation);
        let aToB = sanitizeRelationshipRelation(a.name, aSplit.relation);
        let bToA = sanitizeRelationshipRelation(b.name, bSplit.relation) || inverseSocialRelation(aToB);
        let aDynamic = withFoldedDynamic(item?.aDynamic ?? item?.a_dynamic ?? item?.fromDynamic ?? item?.dynamic, aSplit.dynamic);
        let bDynamic = withFoldedDynamic(item?.bDynamic ?? item?.b_dynamic ?? item?.toDynamic, bSplit.dynamic);
        if (!aToB && !bToA) continue;
        const aEstablished = establishedCounterpartRelation(a, b, npcs);
        const bEstablished = establishedCounterpartRelation(b, a, npcs);
        const asGiven = relationAgreement(aEstablished, aToB) + relationAgreement(bEstablished, bToA);
        const swapped = relationAgreement(aEstablished, bToA) + relationAgreement(bEstablished, aToB);
        const reasonText = clean(item?.reason ?? item?.evidence, 300);
        const edgeGrounded = edgeDirectionGrounded(a, b, aToB, bToA, reasonText || meta.developmentContext || '');
        if (swapped > asGiven && edgeGrounded <= 0) {
            [aToB, bToA] = [bToA, aToB];
            [aDynamic, bDynamic] = [bDynamic, aDynamic];
        }
        out.push({
            aId: a.id, bId: b.id, aToB, bToA,
            aDynamic, bDynamic,
            reason: reasonText || 'scanner social edge',
            provenance: meta.provenance || 'scanner', confidence: 'explicit', sourceMessageId: meta.sourceMessageId, turn: meta.turn,
        });
    }
    return out;
}

function edgeFromKeyRelationship(owner, parsed, npcs, meta = {}) {
    const counterpart = resolveNpcReference(npcs, parsed.subject);
    if (!counterpart || counterpart.id === owner.id) return null;
    return {
        aId: owner.id,
        bId: counterpart.id,
        aToB: parsed.relation,
        bToA: inverseSocialRelation(parsed.relation),
        aDynamic: parsed.dynamic,
        provenance: meta.provenance || 'keyRelationships',
        confidence: meta.confidence || 'migration',
        reason: meta.reason || 'structured key relationship',
        sourceMessageId: meta.sourceMessageId,
        turn: meta.turn,
    };
}

export {
    establishedCounterpartRelation, relationAgreement, alignGraphWithCanonicalRelationships,
    edgeDirectionGrounded, parseScanEdges, edgeFromKeyRelationship,
};
