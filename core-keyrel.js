/* NPC State Delta key-relationship edges: compacting, subject matching, merging and normalizing key-relationship entries/edges,
   applying edges across NPCs, and extracting explicit edges from text, with KEY_RELATIONSHIP_LIMIT. A pure part of
   core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it exported before.
   Imports only core-text.js and social.js. */
import { compactSocialKeyRelationship, SOCIAL_DYNAMIC_MAX_CHARS } from './social.js';
import { cleanText, cleanTextBoundary, normalizeName } from './core-text.js';

export const KEY_RELATIONSHIP_LIMIT = 8;

export function compactKeyRelationshipEntry(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*\|\s*|\s*:\s+)([\s\S]*)$/);
    if (!match) return compactSocialKeyRelationship(text);
    const subject = cleanTextBoundary(match[1], 120, { ellipsis: false });
    let rest = String(match[2] ?? '').replace(/\s+/g, ' ').trim();
    const ambiguousDeath = /\s*\((?:deceased|dead)\)\.?\s*$/i.test(rest);
    if (ambiguousDeath) {
        rest = rest.replace(/\s*\((?:deceased|dead)\)\.?\s*$/i, '').trim();
        if (/^widow\b/i.test(rest)) rest = rest.replace(/^widow\b/i, 'Surviving widow');
        else if (/^widower\b/i.test(rest)) rest = rest.replace(/^widower\b/i, 'Surviving widower');
        else rest = `${rest}; deceased`;
    }
    return compactSocialKeyRelationship(`${subject} — ${rest}`);
}

export function keyRelationshipSubject(value) {
    const text = compactKeyRelationshipEntry(value);
    if (!text) return '';
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*\|\s*|\s*:\s+)/);
    const head = cleanText(match ? match[1] : text, 160);
    return normalizeName(head);
}

function keyRelationshipSubjectsEquivalent(a, b) {
    const left = keyRelationshipSubject(a);
    const right = keyRelationshipSubject(b);
    if (!left || !right) return false;
    if (left === right) return true;
    const leftTokens = left.split(/\s+/).filter(Boolean);
    const rightTokens = right.split(/\s+/).filter(Boolean);
    if (Math.min(leftTokens.length, rightTokens.length) < 1) return false;
    const short = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
    const long = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
    return short.length >= 1 && short.every(token => long.includes(token)) && short.join(' ').length >= 4;
}

export function mergeKeyRelationshipUpdates(existing, incoming) {
    const current = (Array.isArray(existing) ? existing : []).slice(0, KEY_RELATIONSHIP_LIMIT * 2)
        .map(compactKeyRelationshipEntry).filter(Boolean).slice(0, KEY_RELATIONSHIP_LIMIT);
    const updates = (Array.isArray(incoming) ? incoming : []).slice(0, KEY_RELATIONSHIP_LIMIT * 2)
        .map(compactKeyRelationshipEntry).filter(Boolean);
    for (const entry of updates) {
        const exact = normalizeName(entry);
        let index = current.findIndex(item => keyRelationshipSubjectsEquivalent(item, entry));
        if (index < 0 && exact) index = current.findIndex(item => normalizeName(item) === exact);
        if (index >= 0) current[index] = entry;
        else if (current.length < KEY_RELATIONSHIP_LIMIT) current.push(entry);
    }
    return current.slice(0, KEY_RELATIONSHIP_LIMIT);
}


function normalizeKeyRelationshipEdge(raw = {}) {
    const aId = cleanText(raw.aId ?? raw.a_id ?? raw.fromId ?? raw.from_id ?? raw.sourceId ?? raw.source_id, 100);
    const bId = cleanText(raw.bId ?? raw.b_id ?? raw.toId ?? raw.to_id ?? raw.targetId ?? raw.target_id, 100);
    const a = cleanText(raw.a ?? raw.from ?? raw.source ?? raw.personA ?? raw.person_a, 120);
    const b = cleanText(raw.b ?? raw.to ?? raw.target ?? raw.personB ?? raw.person_b, 120);
    const aToB = cleanTextBoundary(raw.aToB ?? raw.a_to_b ?? raw.fromTo ?? raw.from_to ?? raw.relation ?? raw.relationship, 180, { ellipsis: false });
    const bToA = cleanTextBoundary(raw.bToA ?? raw.b_to_a ?? raw.toFrom ?? raw.to_from ?? raw.reverseRelation ?? raw.reverse_relation, 180, { ellipsis: false });
    const aDynamic = cleanTextBoundary(raw.aDynamic ?? raw.a_dynamic ?? raw.fromDynamic ?? raw.from_dynamic ?? raw.dynamic, SOCIAL_DYNAMIC_MAX_CHARS);
    const bDynamic = cleanTextBoundary(raw.bDynamic ?? raw.b_dynamic ?? raw.toDynamic ?? raw.to_dynamic, SOCIAL_DYNAMIC_MAX_CHARS);
    const reason = cleanText(raw.reason ?? raw.evidence, 300);
    if ((!a && !aId) || (!b && !bId) || (!aToB && !bToA)) return null;
    return { aId, a, bId, b, aToB, bToA, aDynamic, bDynamic, reason };
}

export function normalizeKeyRelationshipEdges(scanResult = {}) {
    const raw = scanResult?.keyRelationshipEdges
        ?? scanResult?.key_relationship_edges
        ?? scanResult?.socialRelationships
        ?? scanResult?.social_relationships
        ?? [];
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        const edge = normalizeKeyRelationshipEdge(item);
        if (!edge) continue;
        const key = [edge.aId || normalizeName(edge.a), edge.bId || normalizeName(edge.b), normalizeName(edge.aToB), normalizeName(edge.bToA)].join('|');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(edge);
        if (out.length >= 12) break;
    }
    return out;
}

function relationshipEdgeNpc(npcs, id, label) {
    const list = Array.isArray(npcs) ? npcs : [];
    const cleanId = cleanText(id, 100);
    if (cleanId) {
        const byId = list.find(npc => String(npc?.id || '') === cleanId);
        if (byId) return byId;
    }
    const key = normalizeName(label);
    if (!key) return null;
    return list.find(npc => [npc?.name, ...(npc?.aliases || [])].some(value => normalizeName(value) === key)) || null;
}

function relationshipEdgeEntry(counterpart, relation, dynamic = '') {
    const who = cleanTextBoundary(counterpart, 120, { ellipsis: false });
    const rel = cleanTextBoundary(relation, 180, { ellipsis: false });
    const current = cleanTextBoundary(dynamic, SOCIAL_DYNAMIC_MAX_CHARS);
    if (!who || !rel) return '';
    return compactSocialKeyRelationship(`${who} — ${rel}${current ? ` | ${current}` : ''}`);
}

export function applyKeyRelationshipEdges(next, scanResult, excludeNames, report) {
    const edges = normalizeKeyRelationshipEdges(scanResult);
    if (!edges.length) return;
    const excluded = excludeNames instanceof Set ? excludeNames : new Set();
    const applyOne = (owner, counterpart, relation, dynamic) => {
        if (!owner || !counterpart || !relation) return;
        if (excluded.has(normalizeName(counterpart))) return;
        if ((owner.manualProfileFields || []).includes('keyRelationships')) return;
        const entry = relationshipEdgeEntry(counterpart, relation, dynamic);
        if (!entry) return;
        const before = JSON.stringify(owner.keyRelationships || []);
        owner.keyRelationships = mergeKeyRelationshipUpdates(owner.keyRelationships, [entry]);
        if (JSON.stringify(owner.keyRelationships || []) !== before && !report.updated.includes(owner.id)) report.updated.push(owner.id);
    };
    for (const edge of edges) {
        const aNpc = relationshipEdgeNpc(next.npcs, edge.aId, edge.a);
        const bNpc = relationshipEdgeNpc(next.npcs, edge.bId, edge.b);
        const aName = cleanText(aNpc?.name || edge.a, 120);
        const bName = cleanText(bNpc?.name || edge.b, 120);
        if (aNpc && bName && edge.aToB) applyOne(aNpc, bName, edge.aToB, edge.aDynamic);
        if (bNpc && aName && edge.bToA) applyOne(bNpc, aName, edge.bToA, edge.bDynamic);
    }
}

function escapeRegexLiteral(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXPLICIT_SOCIAL_RELATION = String.raw`(?:older\s+|younger\s+|elder\s+|adoptive\s+|biological\s+|step[- ]?|half[- ]?|former\s+|ex[- ]?|best\s+|close\s+|childhood\s+)?(?:sister|brother|sibling|mother|father|parent|daughter|son|child|wife|husband|spouse|fianc(?:e|ee|é|ée)|girlfriend|boyfriend|partner|lover|friend|rival|mentor|student|apprentice|prot(?:e|é)g(?:e|é)|teacher|guardian|ward|cousin|aunt|uncle|niece|nephew|grandmother|grandfather|grandparent)`;
const SYMMETRIC_SOCIAL_RELATIONS = new Set(['friend', 'best friend', 'close friend', 'childhood friend', 'rival', 'cousin', 'partner', 'lover', 'spouse', 'sibling', 'sister', 'brother']);

function inverseExplicitSocialRelation(relation) {
    const rel = cleanText(relation, 180).toLowerCase().replace(/\s+/g, ' ');
    if (!rel) return '';
    if (SYMMETRIC_SOCIAL_RELATIONS.has(rel)) return rel;
    if (/^(?:older|elder)\s+(?:sister|brother|sibling)$/.test(rel)) return 'younger sibling';
    if (/^younger\s+(?:sister|brother|sibling)$/.test(rel)) return 'older sibling';
    if (/^(?:mother|father|parent)$/.test(rel)) return 'child';
    if (/^(?:daughter|son|child)$/.test(rel)) return 'parent';
    if (/^(?:wife|husband|spouse)$/.test(rel)) return 'spouse';
    if (/^(?:girlfriend|boyfriend|partner|lover|fianc(?:e|ee|é|ée))$/.test(rel)) return 'partner';
    if (/^(?:mentor|teacher)$/.test(rel)) return 'student';
    if (/^(?:student|apprentice|prot(?:e|é)g(?:e|é))$/.test(rel)) return 'mentor';
    if (rel === 'guardian') return 'ward';
    if (rel === 'ward') return 'guardian';
    if (/^(?:aunt|uncle)$/.test(rel)) return 'niece/nephew';
    if (/^(?:niece|nephew)$/.test(rel)) return 'aunt/uncle';
    if (/^(?:grandmother|grandfather|grandparent)$/.test(rel)) return 'grandchild';
    return '';
}

export function extractExplicitKeyRelationshipEdges(transcript, existingNpcs = [], excludeNames = []) {
    // A run of 400+ characters with no space is not prose (a pasted blob, an encoded image): the name patterns below restart at
    // every capital in it, which costs the square of its length, and no relationship statement can be in it. It reads as a space.
    const text = String(transcript || '').replace(/[\r\n]+/g, ' ').replace(/\S{400,}/gu, ' ');
    if (!text.trim()) return [];
    const excluded = new Set((excludeNames || []).map(normalizeName).filter(Boolean));
    const proper = String.raw`([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2})`;
    const out = [];
    const seen = new Set();
    const push = (owner, counterpart, relation) => {
        const ownerNpc = relationshipEdgeNpc(existingNpcs, owner?.id, owner?.name);
        const ownerName = cleanText(ownerNpc?.name || owner?.name, 120);
        const other = cleanText(counterpart, 120).replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '');
        const rel = cleanText(relation, 180).toLowerCase();
        if (!ownerNpc || !ownerName || !other || !rel) return;
        if (normalizeName(other) === normalizeName(ownerName) || excluded.has(normalizeName(other))) return;
        const otherNpc = relationshipEdgeNpc(existingNpcs, '', other);
        const canonicalOther = cleanText(otherNpc?.name || other, 120);
        const inverse = inverseExplicitSocialRelation(rel);
        const key = `${ownerNpc.id}|${normalizeName(canonicalOther)}|${normalizeName(rel)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            aId: ownerNpc.id,
            a: ownerName,
            bId: otherNpc?.id || '',
            b: canonicalOther,
            aToB: rel,
            bToA: otherNpc ? inverse : '',
            reason: 'explicit relationship statement in current exchange',
        });
    };
    for (const npc of Array.isArray(existingNpcs) ? existingNpcs : []) {
        const labels = [npc?.name, ...(npc?.aliases || [])].map(value => cleanText(value, 120)).filter(Boolean).slice(0, 6);
        for (const label of labels) {
            const owner = escapeRegexLiteral(label);
            const possessive = `${owner}(?:['’]s|['’])`;
            const patterns = [
                new RegExp(`${proper}\\s+(?:is|was|remains)\\s+${possessive}\\s+(${EXPLICIT_SOCIAL_RELATION})\\b`, 'giu'),
                new RegExp(`${proper}\\s*,\\s*${possessive}\\s+(${EXPLICIT_SOCIAL_RELATION})\\b`, 'giu'),
                new RegExp(`${possessive}\\s+(${EXPLICIT_SOCIAL_RELATION})\\s+(?:is|was|remains)\\s+${proper}`, 'giu'),
            ];
            for (let pi = 0; pi < patterns.length; pi += 1) {
                for (const match of text.matchAll(patterns[pi])) {
                    if (pi < 2) push(npc, match[1], match[2]);
                    else push(npc, match[2], match[1]);
                }
            }
            const symmetric = new RegExp(`${owner}\\s+and\\s+${proper}\\s+(?:are|were|remain)\\s+((?:best\\s+|close\\s+|childhood\\s+)?friends?|rivals?|siblings?|sisters?|brothers?|partners?|lovers?|cousins?)\\b`, 'giu');
            for (const match of text.matchAll(symmetric)) {
                let rel = cleanText(match[2], 120).toLowerCase();
                rel = rel.replace(/friends$/, 'friend').replace(/rivals$/, 'rival').replace(/siblings$/, 'sibling').replace(/sisters$/, 'sister').replace(/brothers$/, 'brother').replace(/partners$/, 'partner').replace(/lovers$/, 'lover').replace(/cousins$/, 'cousin');
                push(npc, match[1], rel);
            }
        }
    }
    return out.slice(0, 12);
}
