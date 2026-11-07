/* Explicit unnamed social facts and unresolved graph slots.
   Split from social.js; social.js remains the public facade. */

import { clean, norm, slug, confidenceRank, SOCIAL_GRAPH_UNRESOLVED_LIMIT } from './social-primitives.js';
import {
    socialRelationFamily, inverseSocialRelation,
    numberWord, singularRelation, collectiveRelationshipShape,
} from './social-relations.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { relationFromPerspective, normalizeUnresolved, npcLabels } from './social-graph.js';

export function extractUnresolvedSocialFacts(transcript, npcs = [], meta = {}) {
    const text = clean(transcript, 12000);
    const facts = [];
    const seen = new Set();
    const pushFact = (owner, count, relation, sharedDescriptor = '', descriptors = [], reason = '') => {
        const n = Math.max(1, Math.min(20, Number(count) || 1));
        const rel = singularRelation(relation);
        if (!owner?.id || !rel) return;
        const key = `${owner.id}|${socialRelationFamily(rel)}|${n}|${norm(sharedDescriptor)}`;
        if (seen.has(key)) return;
        seen.add(key);
        facts.push({ ownerId: owner.id, count: n, relation: rel, sharedDescriptor, descriptors, reason: reason || 'explicit unnamed social relation', provenance: meta.provenance || 'transcript', confidence: 'explicit', sourceMessageId: meta.sourceMessageId, turn: meta.turn });
    };
    const countToken = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
    const pluralRel = String.raw`(daughters|sons|children|sisters|brothers|siblings)`;
    for (const npc of npcs || []) {
        for (const label of npcLabels(npc).slice(0, 6)) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const countedPatterns = [
                new RegExp(`${escaped}\\s+(?:has|had|raises?|cares\\s+for)\\s+${countToken}\\s+(twin\\s+)?${pluralRel}\\b`, 'giu'),
                new RegExp(`${escaped}(?:['’]s|['’])\\s+${countToken}\\s+(twin\\s+)?${pluralRel}\\b`, 'giu'),
                new RegExp(`${escaped}\\s+(?:is|was|remains)?\\s*(?:the\\s+)?(?:mother|father|parent|guardian)\\s+of\\s+${countToken}\\s+(twin\\s+)?${pluralRel}\\b`, 'giu'),
                new RegExp(`${escaped}\\s*,\\s*(?:the\\s+)?(?:mother|father|parent|guardian)\\s+of\\s+${countToken}\\s+(twin\\s+)?${pluralRel}\\b`, 'giu'),
            ];
            for (const pattern of countedPatterns) {
                for (const match of text.matchAll(pattern)) {
                    const count = numberWord(match[1]);
                    const twin = Boolean(match[2]);
                    const matchStart = Number(match.index || 0);
                    const matchEnd = matchStart + match[0].length;
                    const priorBoundary = Math.max(text.lastIndexOf('.', matchStart - 1), text.lastIndexOf('!', matchStart - 1), text.lastIndexOf('?', matchStart - 1));
                    const tail = text.slice(matchEnd);
                    const nextBoundaryRel = tail.search(/[.!?]/);
                    const sentenceEnd = nextBoundaryRel >= 0 ? matchEnd + nextBoundaryRel + 1 : Math.min(text.length, matchEnd + 120);
                    const local = text.slice(priorBoundary + 1, sentenceEnd);
                    const descriptors = count === 2 && /\bolder\b/i.test(local) && /\byounger\b/i.test(local) ? ['older', 'younger'] : [];
                    pushFact(npc, count, match[3], twin ? 'twins' : '', descriptors, match[0]);
                }
            }
            const twinOnly = [
                new RegExp(`${escaped}\\s+(?:has|had|raises?|cares\\s+for)\\s+twin\\s+${pluralRel}\\b`, 'giu'),
                new RegExp(`${escaped}(?:['’]s|['’])\\s+twin\\s+${pluralRel}\\b`, 'giu'),
            ];
            for (const pattern of twinOnly) {
                for (const match of text.matchAll(pattern)) pushFact(npc, 2, match[1], 'twins', [], match[0]);
            }
            const singular = String.raw`(daughter|son|child|sister|brother|sibling)`;
            const singularPatterns = [
                new RegExp(`${escaped}\\s+(?:has|had|raises?|cares\\s+for)\\s+(?:a|an|one)\\s+${singular}\\b`, 'giu'),
                new RegExp(`${escaped}(?:['’]s|['’])\\s+${singular}\\b`, 'giu'),
            ];
            for (const pattern of singularPatterns) {
                for (const match of text.matchAll(pattern)) pushFact(npc, 1, match[1], '', [], match[0]);
            }
        }
        const background = clean(npc?.background, 1200);
        if (background) {
            const family = background.match(new RegExp(`\\b(?:mother|father|parent|guardian)\\s+of\\s+${countToken}\\s+(twin\\s+)?${pluralRel}\\b`, 'iu'));
            if (family) pushFact(npc, numberWord(family[1]), family[3], family[2] ? 'twins' : '', [], family[0]);
            const twinFamily = background.match(new RegExp(`\\b(?:mother|father|parent|guardian)\\s+of\\s+twin\\s+${pluralRel}\\b`, 'iu'));
            if (twinFamily) pushFact(npc, 2, twinFamily[1], 'twins', [], twinFamily[0]);
            const singleFamily = background.match(/\\b(?:mother|father|parent|guardian)\\s+of\\s+(?:a|an|one)\\s+(daughter|son|child)\\b/iu);
            if (singleFamily) pushFact(npc, 1, singleFamily[1], '', [], singleFamily[0]);
        }
        for (const raw of Array.isArray(npc?.keyRelationships) ? npc.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(raw);
            if (!parsed) continue;
            const shape = collectiveRelationshipShape(parsed);
            if (shape) {
                pushFact(npc, shape.expectedCount, parsed.relation, shape.sharedDescriptor, [], raw);
            }
        }
    }
    return facts;
}

function collectiveDescriptorGrounded(value, descriptor) {
    const text = norm(value);
    const shared = norm(descriptor);
    if (!shared) return true;
    if (shared === 'twins' || shared === 'twin') return /\btwins?\b/.test(text);
    return text.includes(shared);
}

function existingEdgeProvesCollectiveMembership(edge, ownerId, fact) {
    const view = relationFromPerspective(edge, ownerId);
    if (!view) return false;
    if (fact.sharedDescriptor && collectiveDescriptorGrounded(edge.sharedDescriptor, fact.sharedDescriptor)) return true;
    if (confidenceRank(edge.confidence) < confidenceRank('explicit')) return false;
    return collectiveDescriptorGrounded(`${view.relation} ${view.reverse} ${edge.reason}`, fact.sharedDescriptor);
}

function ensureUnresolvedFacts(graph, facts = []) {
    for (const fact of facts) {
        const ownerId = clean(fact.ownerId, 100);
        const relation = clean(fact.relation, 180);
        if (!ownerId || !relation) continue;
        const family = socialRelationFamily(relation);
        const existingEdges = graph.edges.filter(edge => {
            const view = relationFromPerspective(edge, ownerId);
            return view && socialRelationFamily(view.relation) === family;
        });
        const existingResolved = existingEdges.length;
        const existingSlots = graph.unresolved.filter(slot => slot.ownerId === ownerId && socialRelationFamily(slot.relation) === family);
        const desiredOpen = Math.max(0, Number(fact.count || 0) - existingResolved);
        const toAdd = Math.max(0, desiredOpen - existingSlots.length);
        const groupId = existingSlots[0]?.groupId || `group_${slug(`${ownerId}-${family}-${fact.sharedDescriptor || ''}`)}`;
        if (!existingSlots.length && fact.count >= 2 && existingEdges.length === fact.count
            && existingEdges.every(edge => existingEdgeProvesCollectiveMembership(edge, ownerId, fact))) {
            for (const edge of existingEdges) {
                edge.groupId ||= groupId;
                if (fact.sharedDescriptor) edge.sharedDescriptor ||= fact.sharedDescriptor;
            }
        }
        for (let i = 0; i < toAdd; i += 1) {
            const slotIndex = existingSlots.length + i;
            const descriptor = clean(fact.descriptors?.[slotIndex] || '', 180);
            const slot = normalizeUnresolved({
                id: `slot_${slug(`${groupId}-${slotIndex + 1}`)}`,
                ownerId,
                relation,
                inverseRelation: inverseSocialRelation(relation),
                groupId,
                descriptor,
                sharedDescriptor: fact.sharedDescriptor,
                provenance: fact.provenance,
                confidence: fact.confidence,
                reason: fact.reason,
                sourceMessageId: fact.sourceMessageId,
                turn: fact.turn,
            });
            if (slot && graph.unresolved.length < SOCIAL_GRAPH_UNRESOLVED_LIMIT) graph.unresolved.push(slot);
        }
    }
}

function resolveSlotsFromEdges(graph) {
    const remaining = [];
    for (const slot of graph.unresolved) {
        const candidates = graph.edges.filter(edge => {
            const view = relationFromPerspective(edge, slot.ownerId);
            return view && socialRelationFamily(view.relation) === socialRelationFamily(slot.relation);
        });
        const alreadyGrouped = new Set(graph.edges.filter(edge => edge.groupId === slot.groupId).map(edge => {
            const view = relationFromPerspective(edge, slot.ownerId);
            return view?.counterpartId || '';
        }).filter(Boolean));
        const available = candidates.filter(edge => {
            const view = relationFromPerspective(edge, slot.ownerId);
            return view && !alreadyGrouped.has(view.counterpartId);
        });
        let chosen = null;
        if (slot.descriptor) {
            chosen = available.find(edge => {
                const view = relationFromPerspective(edge, slot.ownerId);
                return norm(`${view?.relation || ''} ${view?.dynamic || ''}`).includes(norm(slot.descriptor));
            }) || null;
        }
        if (!chosen && available.length) chosen = available[0];
        if (!chosen) { remaining.push(slot); continue; }
        chosen.groupId ||= slot.groupId;
        chosen.sharedDescriptor ||= slot.sharedDescriptor;
    }
    graph.unresolved = remaining;
}

export {
    collectiveDescriptorGrounded, existingEdgeProvesCollectiveMembership,
    ensureUnresolvedFacts, resolveSlotsFromEdges,
};
