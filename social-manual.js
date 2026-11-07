/* Manual Important Bond edits, mirrored updates and repair.
   Split from social.js; social.js remains the public facade. */

import { clean, norm, uniq } from './social-primitives.js';
import {
    socialRelationFamily, KINSHIP_RELATION_FAMILIES, conflictingKinship,
    inverseSocialRelation, relationshipSubjectLooksStructured, kinshipParts,
} from './social-relations.js';
import { parseKeyRelationshipEntry, formatKeyRelationship } from './social-bonds.js';
import {
    resolveNpcReference, addEdge, relationFromPerspective, normalizeSocialGraph,
    pairConnects, npcLabels,
} from './social-graph.js';
import { establishedCounterpartRelation } from './social-scan.js';
import { sharedParentBasis } from './social-inference.js';

function relationshipSubjectCandidate(value) {
    const text = clean(value, 420);
    if (!text) return '';
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*:\s+)/);
    const subject = clean(match?.[1], 120);
    return relationshipSubjectLooksStructured(subject) ? subject : '';
}

function relationshipCounterpartId(npcs = [], value = '') {
    const parsed = parseKeyRelationshipEntry(value);
    const subject = parsed?.subject || relationshipSubjectCandidate(value);
    return resolveNpcReference(npcs, subject)?.id || '';
}

function relationshipTargetsNpc(value, target, npcs = []) {
    if (!target?.id) return false;
    const parsed = parseKeyRelationshipEntry(value);
    const subject = parsed?.subject || relationshipSubjectCandidate(value);
    if (!subject) return false;
    const resolved = resolveNpcReference(npcs, subject);
    if (resolved?.id === target.id) return true;
    const labels = new Set(npcLabels(target).map(norm).filter(Boolean));
    return labels.has(norm(subject));
}

function removeMirroredRelationship(counterpart, owner, npcs = []) {
    if (!counterpart || !owner) return;
    counterpart.keyRelationships = (Array.isArray(counterpart.keyRelationships) ? counterpart.keyRelationships : [])
        .filter(entry => !relationshipTargetsNpc(entry, owner, npcs));
}

function explicitReverseRelationship(counterpart, owner, npcs = []) {
    for (const raw of Array.isArray(counterpart?.keyRelationships) ? counterpart.keyRelationships : []) {
        const parsed = parseKeyRelationshipEntry(raw);
        if (!parsed) continue;
        const target = resolveNpcReference(npcs, parsed.subject);
        if (target?.id === owner.id) return parsed;
    }
    return null;
}

function replaceManualRelationshipEdge(graph, owner, parsed, npcs = [], meta = {}) {
    const counterpart = resolveNpcReference(npcs, parsed.subject);
    if (!counterpart || counterpart.id === owner.id) return null;
    const pairEdges = graph.edges.filter(edge => pairConnects(edge, owner.id, counterpart.id));
    const priorView = pairEdges.map(edge => relationFromPerspective(edge, owner.id)).find(Boolean) || null;
    const desiredReverse = inverseSocialRelation(parsed.relation);
    const explicitReverse = explicitReverseRelationship(counterpart, owner, npcs);
    const explicitReverseCompatible = explicitReverse
        && socialRelationFamily(explicitReverse.relation) === socialRelationFamily(desiredReverse);
    const priorReverseCompatible = priorView?.reverse
        && socialRelationFamily(priorView.reverse) === socialRelationFamily(desiredReverse);
    const reverseRelation = explicitReverseCompatible
        ? explicitReverse.relation
        : (priorReverseCompatible ? priorView.reverse : desiredReverse);
    const reverseDynamic = explicitReverseCompatible
        ? explicitReverse.dynamic
        : (priorReverseCompatible ? priorView.reverseDynamic : '');
    const priorEdge = pairEdges[0] || null;
    graph.edges = graph.edges.filter(edge => !pairConnects(edge, owner.id, counterpart.id));
    return addEdge(graph, {
        aId: owner.id,
        bId: counterpart.id,
        aToB: parsed.relation,
        bToA: reverseRelation,
        aDynamic: parsed.dynamic,
        bDynamic: reverseDynamic,
        provenance: 'manual',
        confidence: 'manual',
        reason: 'manual key relationship edit',
        sourceMessageId: meta.sourceMessageId,
        turn: meta.turn,
        groupId: priorEdge?.groupId || '',
        sharedDescriptor: priorEdge?.sharedDescriptor || '',
    });
}

export function applyManualKeyRelationshipEdit(state, npcId, beforeList = [], afterList = [], meta = {}) {
    const next = state && typeof state === 'object' ? state : {};
    const npcs = Array.isArray(next.npcs) ? next.npcs : [];
    const owner = npcs.find(npc => npc?.id === npcId);
    if (!owner) return next;
    let graph = normalizeSocialGraph(next.socialGraph);
    const beforeIds = new Set((beforeList || []).map(item => relationshipCounterpartId(npcs, item)).filter(Boolean));
    const afterEntries = (afterList || []).map(parseKeyRelationshipEntry).filter(Boolean);
    const afterIds = new Set((afterList || []).map(item => relationshipCounterpartId(npcs, item)).filter(Boolean));
    for (const removedId of beforeIds) {
        if (afterIds.has(removedId)) continue;
        const basis = sharedParentBasis(graph, owner.id, removedId);
        if (basis) {
            const [first, second] = [owner.id, removedId].sort();
            graph.suppressed = [...(graph.suppressed || []).filter(entry => !(entry.aId === first && entry.bId === second)), { aId: first, bId: second, basis }];
        }
        graph.edges = graph.edges.filter(edge => !pairConnects(edge, owner.id, removedId));
        const counterpart = npcs.find(npc => npc?.id === removedId);
        removeMirroredRelationship(counterpart, owner, npcs);
    }
    const beforeByCounterpart = new Map();
    for (const parsed of (beforeList || []).map(parseKeyRelationshipEntry).filter(Boolean)) {
        const id = resolveNpcReference(npcs, parsed.subject)?.id;
        if (id && !beforeByCounterpart.has(id)) beforeByCounterpart.set(id, parsed);
    }
    for (const parsed of afterEntries) {
        const counterpart = resolveNpcReference(npcs, parsed.subject);
        const previous = counterpart ? beforeByCounterpart.get(counterpart.id) : null;
        if (previous && norm(previous.relation) !== norm(parsed.relation)) syncMirroredRelationship(counterpart, owner, previous.relation, parsed.relation, npcs);
    }
    for (const parsed of afterEntries) replaceManualRelationshipEdge(graph, owner, parsed, npcs, meta);
    next.socialGraph = normalizeSocialGraph(graph);
    return next;
}

// A manual correction ("Marek — brother" instead of "parent") also corrects the counterpart's entry
// when that entry only mirrored the old relation ("Greta — child"), so it cannot restore the old one.
function syncMirroredRelationship(counterpart, owner, oldRelation, newRelation, npcs = []) {
    if (!counterpart || counterpart.id === owner.id) return;
    if (Array.isArray(counterpart.manualProfileFields) && counterpart.manualProfileFields.includes('keyRelationships')) return;
    const reverse = explicitReverseRelationship(counterpart, owner, npcs);
    const replacement = inverseSocialRelation(newRelation);
    if (!reverse || !replacement) return;
    const family = value => socialRelationFamily(kinshipParts(value)[0] || '');
    const mirroredOld = family(reverse.relation) && family(reverse.relation) === family(inverseSocialRelation(oldRelation));
    if (!mirroredOld || family(reverse.relation) === family(replacement)) return;
    counterpart.keyRelationships = counterpart.keyRelationships.map(entry => relationshipTargetsNpc(entry, owner, npcs)
        ? formatKeyRelationship(owner.name, replacement, reverse.dynamic, owner)
        : entry);
}

function speciesWords(npc) {
    return norm(npc?.species).split(/\s+/).filter(word => word.length >= 3);
}

function describesNpc(text, npc, other) {
    const words = norm(text).split(/\s+/);
    const own = speciesWords(npc);
    const others = new Set(speciesWords(other));
    return own.some(word => !others.has(word) && words.includes(word));
}

// Earlier builds mirrored a bond's whole text onto the counterpart, so both dossiers can hold the
// words one NPC uses about the other ("Hanna — disinherited half-elf cousin" on Talia). Decide
// which side the text describes and give the other side the proper inverse.
function repairMirroredKeyRelationships(npcs, graph) {
    const locked = npc => Array.isArray(npc?.manualProfileFields) && npc.manualProfileFields.includes('keyRelationships');
    const splitParts = value => value.split(/\s*\/\s*/).map(part => clean(part, 180)).filter(Boolean);
    const said = new Map();
    for (const owner of npcs) {
        if (!owner?.id) continue;
        const about = new Map();
        for (const raw of Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(raw);
            const target = parsed ? resolveNpcReference(npcs, parsed.subject) : null;
            if (target && target.id !== owner.id && !about.has(target.id)) about.set(target.id, parsed.relation);
        }
        said.set(owner.id, about);
    }
    const edges = new Map((graph.edges || []).map(edge => [[edge.aId, edge.bId].sort().join('|'), edge]));
    const byId = new Map(npcs.filter(npc => npc?.id).map(npc => [npc.id, npc]));
    const seen = new Set();
    for (const [ownerId, about] of said) {
        for (const [counterpartId, ownerText] of about) {
            const pairKey = [ownerId, counterpartId].sort().join('|');
            const counterpartText = said.get(counterpartId)?.get(ownerId);
            if (seen.has(pairKey) || !counterpartText) continue;
            seen.add(pairKey);
            const edge = edges.get(pairKey);
            const [a, b] = edge?.aId === counterpartId ? [byId.get(counterpartId), byId.get(ownerId)] : [byId.get(ownerId), byId.get(counterpartId)];
            const aText = a.id === ownerId ? ownerText : counterpartText;
            const bText = a.id === ownerId ? counterpartText : ownerText;
            const shared = splitParts(aText).filter(part => splitParts(bText).some(other => norm(other) === norm(part))
                && norm(inverseSocialRelation(part)) !== norm(part));
            if (!shared.length) continue;
            // The text belongs on the dossier of the NPC it does not describe. Otherwise the side that
            // holds extra parts absorbed the copy ("Niece / sibling" against a plain "niece"); failing
            // both, keep the side that established the edge.
            const aDescribed = shared.some(part => describesNpc(part, a, b));
            const bDescribed = shared.some(part => describesNpc(part, b, a));
            const aParts = splitParts(aText).length;
            const bParts = splitParts(bText).length;
            const copy = aDescribed !== bDescribed ? (aDescribed ? a : b) : (aParts !== bParts ? (aParts > bParts ? a : b) : b);
            const original = copy === a ? b : a;
            if (locked(copy)) continue;
            const sharedKeys = new Set(shared.map(norm));
            copy.keyRelationships = copy.keyRelationships.map(raw => {
                const parsed = parseKeyRelationshipEntry(raw);
                if (!parsed || resolveNpcReference(npcs, parsed.subject)?.id !== original.id) return raw;
                const relation = uniq(splitParts(parsed.relation)
                    .map(part => sharedKeys.has(norm(part)) ? inverseSocialRelation(part) : part)
                    .filter(Boolean)).join(' / ');
                return relation ? formatKeyRelationship(original.name, relation, parsed.dynamic, original) : '';
            }).filter(Boolean);
            if (!edge) continue;
            if (copy === a) edge.aToB = inverseSocialRelation(edge.bToA) || edge.aToB;
            else edge.bToA = inverseSocialRelation(edge.aToB) || edge.bToA;
        }
    }
    resolveConflictingKinship(npcs, said);
}

function resolveConflictingKinship(npcs, said) {
    const locked = npc => Array.isArray(npc?.manualProfileFields) && npc.manualProfileFields.includes('keyRelationships');
    const byId = new Map(npcs.filter(npc => npc?.id).map(npc => [npc.id, npc]));
    for (const owner of npcs) {
        if (!owner?.id || locked(owner) || !said.has(owner.id)) continue;
        owner.keyRelationships = (Array.isArray(owner.keyRelationships) ? owner.keyRelationships : []).map(raw => {
            const parsed = parseKeyRelationshipEntry(raw);
            const counterpart = parsed ? resolveNpcReference(npcs, parsed.subject) : null;
            if (!counterpart || counterpart.id === owner.id) return raw;
            const parts = kinshipParts(parsed.relation);
            const kin = parts.filter(part => KINSHIP_RELATION_FAMILIES.has(socialRelationFamily(part)));
            if (!kin.some((part, i) => kin.slice(i + 1).some(other => conflictingKinship(part, other)))) return raw;
            const statement = establishedCounterpartRelation(byId.get(counterpart.id), owner, npcs);
            const stated = kinshipParts(statement).filter(part => KINSHIP_RELATION_FAMILIES.has(socialRelationFamily(part)));
            const statedFamilies = new Set(stated.map(socialRelationFamily));
            if (statedFamilies.size !== 1) return raw;
            const expected = inverseSocialRelation(stated[0]);
            const family = socialRelationFamily(kinshipParts(expected)[0]);
            const matching = kin.filter(part => socialRelationFamily(part) === family);
            const relation = uniq([
                ...parts.filter(part => !KINSHIP_RELATION_FAMILIES.has(socialRelationFamily(part))),
                ...(matching.length ? matching : [expected]),
            ]).join(' / ');
            return formatKeyRelationship(counterpart.name, relation, parsed.dynamic, counterpart);
        });
    }
}


export {
    relationshipSubjectCandidate, relationshipCounterpartId, relationshipTargetsNpc,
    removeMirroredRelationship, explicitReverseRelationship, replaceManualRelationshipEdge,
    syncMirroredRelationship, speciesWords, describesNpc, repairMirroredKeyRelationships,
    resolveConflictingKinship,
};
