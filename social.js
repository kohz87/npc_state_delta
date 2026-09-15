export const SOCIAL_GRAPH_VERSION = 1;
export const SOCIAL_GRAPH_EDGE_LIMIT = 240;
export const SOCIAL_GRAPH_UNRESOLVED_LIMIT = 120;
export const SOCIAL_KEY_RELATIONSHIP_MAX_CHARS = 360;
export const SOCIAL_DYNAMIC_MAX_CHARS = 260;

function clean(value, max = 500) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanBoundary(value, max = 500, { ellipsis = true } = {}) {
    const text = normalizedWhitespace(value);
    const cap = Math.max(0, Math.floor(Number(max) || 0));
    if (!text || cap <= 0) return '';
    if (text.length <= cap) return text;
    const reserve = ellipsis && cap > 1 ? 1 : 0;
    const prefix = text.slice(0, Math.max(1, cap - reserve));
    let sentenceCut = -1;
    for (const match of prefix.matchAll(/[.!?](?=\s|$)/g)) sentenceCut = match.index + 1;
    if (sentenceCut >= Math.floor(cap * 0.45)) return prefix.slice(0, sentenceCut).trim();
    let clauseCut = -1;
    for (const match of prefix.matchAll(/[;,](?=\s|$)/g)) clauseCut = match.index;
    if (clauseCut >= Math.floor(cap * 0.45)) return prefix.slice(0, clauseCut).replace(/[|/;,\s]+$/g, '').trim();
    const wordCut = prefix.lastIndexOf(' ');
    if (wordCut <= 0) return '';
    const clipped = prefix.slice(0, wordCut).replace(/[|/;,\s]+$/g, '').trim();
    return clipped && ellipsis ? `${clipped}…` : clipped;
}

function norm(value) {
    return clean(value, 500).normalize('NFKC').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'-]+/gu, ' ').trim();
}

function uniq(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = clean(value, 240);
        const key = norm(text);
        if (!text || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function slug(value) {
    return norm(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'social';
}

function confidenceRank(value) {
    return ({ inferred: 0, migration: 1, 'strong-context': 2, explicit: 3, manual: 4 }[String(value || '').toLowerCase()] ?? 0);
}

const SOCIAL_SEMANTIC_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'her', 'his', 'their', 'they', 'them',
    'she', 'him', 'who', 'whom', 'at', 'in', 'on', 'to', 'of', 'as', 'is', 'was', 'are', 'were', 'been',
]);

function semanticWords(value) {
    return new Set(norm(value).split(/\s+/)
        .filter(token => token.length > 2 && !SOCIAL_SEMANTIC_STOPWORDS.has(token)));
}

function semanticOverlap(a, b) {
    const left = semanticWords(a);
    const right = semanticWords(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.min(left.size, right.size);
}

function nearDuplicateText(a, b) {
    const left = norm(a);
    const right = norm(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left) || semanticOverlap(left, right) >= 0.72;
}

function cleanDynamic(value, max = SOCIAL_DYNAMIC_MAX_CHARS) {
    const raw = normalizedWhitespace(value);
    if (!raw) return '';
    const kept = [];
    const parts = raw.split(/\s*(?:;|\|)\s*|\s+\/\s+/)
        .map(item => cleanBoundary(item, max))
        .filter(Boolean);
    for (const part of parts) {
        const key = norm(part);
        if (!key || (key.length < 4 && !/\d/.test(key))) continue;
        const duplicateIndex = kept.findIndex(existing => nearDuplicateText(existing, part));
        if (duplicateIndex >= 0) continue;
        kept.push(part);
    }
    let out = '';
    for (const part of kept) {
        const candidate = out ? `${out}; ${part}` : part;
        if (candidate.length <= max) {
            out = candidate;
            continue;
        }
        if (!out) out = cleanBoundary(part, max);
        break;
    }
    return out.replace(/[|/;,\s]+$/g, '').trim();
}

function richer(a, b, max = SOCIAL_DYNAMIC_MAX_CHARS) {
    const left = cleanDynamic(a, max);
    const right = cleanDynamic(b, max);
    if (!left) return right;
    if (!right) return left;
    const ln = norm(left);
    const rn = norm(right);
    if (ln === rn) return right.length >= left.length ? right : left;
    if (ln.includes(rn)) return left;
    if (rn.includes(ln)) return right;
    if (nearDuplicateText(left, right)) return right.length >= left.length ? right : left;
    return cleanDynamic(right.length >= left.length ? `${right}; ${left}` : `${left}; ${right}`, max);
}

export function socialRelationFamily(value) {
    const rel = norm(value);
    if (!rel) return '';
    if (/\b(?:daughter|son|child)\b/.test(rel)) return 'child';
    if (/\b(?:mother|father|parent)\b/.test(rel)) return 'parent';
    if (/\b(?:sister|brother|sibling)\b/.test(rel)) return 'sibling';
    if (/\b(?:wife|husband|spouse|fiance|fiancee|partner|lover|girlfriend|boyfriend)\b/.test(rel)) return 'partner';
    if (/\b(?:mentor|teacher)\b/.test(rel)) return 'mentor';
    if (/\b(?:student|apprentice|protege)\b/.test(rel)) return 'student';
    if (/\bguardian\b/.test(rel)) return 'guardian';
    if (/\bward\b/.test(rel)) return 'ward';
    if (/\b(?:friend|rival|cousin)\b/.test(rel)) return rel.match(/\b(friend|rival|cousin)\b/)?.[1] || rel;
    if (/\b(?:aunt|uncle)\b/.test(rel)) return 'aunt-uncle';
    if (/\b(?:niece|nephew)\b/.test(rel)) return 'niece-nephew';
    if (/\b(?:grandmother|grandfather|grandparent)\b/.test(rel)) return 'grandparent';
    if (/\bgrandchild\b/.test(rel)) return 'grandchild';
    return rel;
}

const KNOWN_SOCIAL_RELATION_FAMILIES = new Set([
    'child', 'parent', 'sibling', 'partner', 'mentor', 'student', 'guardian', 'ward',
    'friend', 'rival', 'cousin', 'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild',
]);

const INVERSE_SOCIAL_RELATION_FAMILIES = new Map([
    ['child', 'parent'], ['parent', 'child'], ['mentor', 'student'], ['student', 'mentor'],
    ['guardian', 'ward'], ['ward', 'guardian'], ['aunt-uncle', 'niece-nephew'], ['niece-nephew', 'aunt-uncle'],
    ['grandparent', 'grandchild'], ['grandchild', 'grandparent'],
]);

function inverseRelationFamilies(a, b) {
    const left = KNOWN_SOCIAL_RELATION_FAMILIES.has(a) ? a : socialRelationFamily(a);
    const right = KNOWN_SOCIAL_RELATION_FAMILIES.has(b) ? b : socialRelationFamily(b);
    return Boolean(left && right && INVERSE_SOCIAL_RELATION_FAMILIES.get(left) === right);
}

function relationshipSubjectLooksStructured(value) {
    const subject = clean(value, 120);
    if (!subject || /[.!?]\s*$/.test(subject)) return false;
    const words = norm(subject).split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 8) return false;
    return !/^(?:supports?|provides?|raises?|feeds?|dresses?|guides?|works?|serves?|helps?|keeps?|uses?|lives?|died|dies|has|had|is|was|were|remains?|cares?)\b/i.test(subject);
}

function preserveUnstructuredRelationshipText(value) {
    const text = clean(value, 420);
    if (!text || /[.!?]\s*$/.test(text)) return false;
    if (/^(?:supports?|provides?|raises?|feeds?|dresses?|guides?|works?|serves?|helps?|keeps?|uses?|lives?|died|dies|has|had|is|was|were|remains?|cares?)\b/i.test(text)) return false;
    const words = norm(text).split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 8;
}

function sanitizeRelationshipRelation(subject, value) {
    let relation = cleanBoundary(value, 180, { ellipsis: false });
    if (!relation) return '';
    const slash = [];
    const seen = new Set();
    for (const part of relation.split(/\s*\/\s*/).map(item => cleanBoundary(item, 180, { ellipsis: false })).filter(Boolean)) {
        const key = norm(part);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        slash.push(part);
    }
    if (slash.length === 2 && inverseRelationFamilies(slash[0], slash[1])) relation = slash[0];
    else if (slash.length) relation = cleanBoundary(slash.join(' / '), 180, { ellipsis: false });
    const subjectKey = norm(subject);
    const relationKey = norm(relation);
    if (/^late husband\b/.test(subjectKey) && /^(?:surviving )?widow\b/.test(relationKey)) return 'spouse';
    if (/^late wife\b/.test(subjectKey) && /^(?:surviving )?widower\b/.test(relationKey)) return 'spouse';
    return relation;
}

export function inverseSocialRelation(value) {
    const rel = clean(value, 180);
    const family = socialRelationFamily(rel);
    if (!family) return '';
    if (family === 'child') return 'parent';
    if (family === 'parent') return 'child';
    if (family === 'sibling') return /\bclone\b/i.test(rel) ? 'clone sibling' : (/\btwin\b/i.test(rel) ? 'twin sibling' : 'sibling');
    if (family === 'friend' || family === 'rival' || family === 'cousin') return rel;
    if (family === 'partner') {
        if (/\b(?:wife|husband|spouse)\b/i.test(rel)) return 'spouse';
        return 'partner';
    }
    if (family === 'mentor') return 'student';
    if (family === 'student') return 'mentor';
    if (family === 'guardian') return 'ward';
    if (family === 'ward') return 'guardian';
    if (family === 'aunt-uncle') return 'niece/nephew';
    if (family === 'niece-nephew') return 'aunt/uncle';
    if (family === 'grandparent') return 'grandchild';
    if (family === 'grandchild') return 'grandparent';
    return rel;
}

function relationSpecificity(value) {
    const rel = norm(value);
    let score = rel.split(/\s+/).filter(Boolean).length;
    if (/\b(?:daughter|son|mother|father|sister|brother|wife|husband)\b/.test(rel)) score += 2;
    if (/\b(?:clone|twin|adoptive|biological|step|half|older|younger|elder)\b/.test(rel)) score += 2;
    return score;
}

function mergeRelations(a, b) {
    const left = cleanBoundary(a, 180, { ellipsis: false });
    const right = cleanBoundary(b, 180, { ellipsis: false });
    if (!left) return right;
    if (!right) return left;
    const ln = norm(left);
    const rn = norm(right);
    if (ln === rn) return relationSpecificity(right) >= relationSpecificity(left) ? right : left;
    if (ln.includes(rn)) return left;
    if (rn.includes(ln)) return right;
    const lf = socialRelationFamily(left);
    const rf = socialRelationFamily(right);
    if (lf && lf === rf) return relationSpecificity(right) >= relationSpecificity(left) ? right : left;
    if (inverseRelationFamilies(lf, rf)) return left;
    return cleanBoundary(`${left} / ${right}`, 180, { ellipsis: false });
}

export function parseKeyRelationshipEntry(value) {
    const text = normalizedWhitespace(value);
    if (!text) return null;
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*:\s+)([\s\S]*)$/);
    if (!match) return null;
    const subject = cleanBoundary(match[1], 120, { ellipsis: false });
    const rest = normalizedWhitespace(match[2]);
    if (!subject || !rest || !relationshipSubjectLooksStructured(subject)) return null;
    const pipe = rest.indexOf('|');
    let relationText = pipe >= 0 ? rest.slice(0, pipe) : rest;
    let dynamicText = pipe >= 0 ? rest.slice(pipe + 1) : '';
    if (pipe < 0) {
        const semicolon = rest.indexOf(';');
        if (semicolon > 0) {
            const candidateRelation = cleanBoundary(rest.slice(0, semicolon), 180, { ellipsis: false });
            if (KNOWN_SOCIAL_RELATION_FAMILIES.has(socialRelationFamily(candidateRelation))) {
                relationText = candidateRelation;
                dynamicText = rest.slice(semicolon + 1);
            }
        }
    }
    const relation = sanitizeRelationshipRelation(subject, relationText);
    const dynamic = cleanDynamic(dynamicText, SOCIAL_DYNAMIC_MAX_CHARS);
    if (!relation) return null;
    return { subject, relation, dynamic };
}

function formatKeyRelationship(subject, relation, dynamic = '', counterpart = null) {
    const who = cleanBoundary(subject, 120, { ellipsis: false });
    const rel = sanitizeRelationshipRelation(who, relation);
    if (!who || !rel) return '';
    const base = `${who} — ${rel}`;
    const availableDynamic = Math.max(0, Math.min(SOCIAL_DYNAMIC_MAX_CHARS, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS - base.length - 3));
    let dyn = availableDynamic > 0 ? cleanDynamic(dynamic, availableDynamic) : '';
    if (counterpart?.lifeState === 'deceased' && !/\b(?:deceased|dead|late)\b/i.test(`${rel} ${dyn}`)) {
        dyn = cleanDynamic(dyn ? `${dyn}; deceased` : 'deceased', availableDynamic);
    }
    return dyn ? `${base} | ${dyn}` : base;
}

export function compactSocialKeyRelationship(value) {
    const text = normalizedWhitespace(value);
    if (!text) return '';
    const parsed = parseKeyRelationshipEntry(text);
    if (!parsed) return cleanBoundary(text, SOCIAL_KEY_RELATIONSHIP_MAX_CHARS);
    return formatKeyRelationship(parsed.subject, parsed.relation, parsed.dynamic);
}

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
    const aToB = sanitizeRelationshipRelation('', raw.aToB ?? raw.a_to_b ?? raw.relation);
    const bToAInput = raw.bToA ?? raw.b_to_a ?? raw.reverseRelation;
    const bToA = sanitizeRelationshipRelation('', bToAInput) || inverseSocialRelation(aToB);
    if (!aToB && !bToA) return null;
    const confidence = clean(raw.confidence, 40) || 'migration';
    return {
        id: clean(raw.id, 120) || `edge_${slug(`${aId}-${bId}-${socialRelationFamily(aToB)}-${socialRelationFamily(bToA)}`)}`,
        aId,
        bId,
        aToB,
        bToA,
        aDynamic: cleanDynamic(raw.aDynamic ?? raw.a_dynamic, SOCIAL_DYNAMIC_MAX_CHARS),
        bDynamic: cleanDynamic(raw.bDynamic ?? raw.b_dynamic, SOCIAL_DYNAMIC_MAX_CHARS),
        provenance: clean(raw.provenance, 40) || 'migration',
        confidence,
        reason: clean(raw.reason ?? raw.evidence, 300),
        sourceMessageId: Number.isInteger(raw.sourceMessageId) ? raw.sourceMessageId : null,
        turn: Number.isFinite(Number(raw.turn)) ? Number(raw.turn) : null,
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
        turn: Number.isFinite(Number(raw.turn)) ? Number(raw.turn) : null,
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
        if (edgeIndex.has(key)) {
            const current = edges[edgeIndex.get(key)];
            current.aToB = mergeRelations(current.aToB, edge.aToB);
            current.bToA = mergeRelations(current.bToA, edge.bToA);
            current.aDynamic = richer(current.aDynamic, edge.aDynamic);
            current.bDynamic = richer(current.bDynamic, edge.bDynamic);
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
    return { version: SOCIAL_GRAPH_VERSION, edges, unresolved };
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
        owner.keyRelationships = deduped.slice(0, 5);
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

function parseScanEdges(scanResult = {}, npcs = [], meta = {}) {
    const raw = scanResult?.keyRelationshipEdges ?? scanResult?.key_relationship_edges ?? scanResult?.socialRelationships ?? scanResult?.social_relationships ?? [];
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        const a = resolveNpcReference(npcs, item?.aId ?? item?.a_id ?? item?.a ?? item?.from ?? item?.source ?? '');
        const b = resolveNpcReference(npcs, item?.bId ?? item?.b_id ?? item?.b ?? item?.to ?? item?.target ?? '');
        if (!a || !b || a.id === b.id) continue;
        let aToB = sanitizeRelationshipRelation(a.name, item?.aToB ?? item?.a_to_b ?? item?.fromTo ?? item?.from_to ?? item?.relation ?? item?.relationship);
        let bToA = sanitizeRelationshipRelation(b.name, item?.bToA ?? item?.b_to_a ?? item?.toFrom ?? item?.to_from ?? item?.reverseRelation ?? item?.reverse_relation) || inverseSocialRelation(aToB);
        let aDynamic = cleanDynamic(item?.aDynamic ?? item?.a_dynamic ?? item?.fromDynamic ?? item?.dynamic, SOCIAL_DYNAMIC_MAX_CHARS);
        let bDynamic = cleanDynamic(item?.bDynamic ?? item?.b_dynamic ?? item?.toDynamic, SOCIAL_DYNAMIC_MAX_CHARS);
        if (!aToB && !bToA) continue;
        const aEstablished = establishedCounterpartRelation(a, b, npcs);
        const bEstablished = establishedCounterpartRelation(b, a, npcs);
        const asGiven = relationAgreement(aEstablished, aToB) + relationAgreement(bEstablished, bToA);
        const swapped = relationAgreement(aEstablished, bToA) + relationAgreement(bEstablished, aToB);
        if (swapped > asGiven) {
            [aToB, bToA] = [bToA, aToB];
            [aDynamic, bDynamic] = [bDynamic, aDynamic];
        }
        out.push({
            aId: a.id, bId: b.id, aToB, bToA,
            aDynamic, bDynamic,
            reason: clean(item?.reason ?? item?.evidence, 300) || 'scanner social edge',
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

function numberWord(value) {
    const raw = norm(value);
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twin: 2, twins: 2 };
    if (map[raw]) return map[raw];
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 20 ? n : 0;
}

function singularRelation(value) {
    const raw = norm(value);
    if (raw === 'daughters') return 'daughter';
    if (raw === 'sons') return 'son';
    if (raw === 'children') return 'child';
    if (raw === 'sisters') return 'sister';
    if (raw === 'brothers') return 'brother';
    if (raw === 'siblings') return 'sibling';
    return raw.replace(/s$/, '');
}

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
    }
    return facts;
}

function ensureUnresolvedFacts(graph, facts = []) {
    for (const fact of facts) {
        const ownerId = clean(fact.ownerId, 100);
        const relation = clean(fact.relation, 180);
        if (!ownerId || !relation) continue;
        const family = socialRelationFamily(relation);
        const existingResolved = graph.edges.filter(edge => {
            const view = relationFromPerspective(edge, ownerId);
            return view && socialRelationFamily(view.relation) === family;
        }).length;
        const existingSlots = graph.unresolved.filter(slot => slot.ownerId === ownerId && socialRelationFamily(slot.relation) === family);
        const desiredOpen = Math.max(0, Number(fact.count || 0) - existingResolved);
        const toAdd = Math.max(0, desiredOpen - existingSlots.length);
        const groupId = existingSlots[0]?.groupId || `group_${slug(`${ownerId}-${family}-${fact.sharedDescriptor || ''}`)}`;
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

function inferSiblingEdges(graph) {
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
                addEdge(graph, { aId: a.childId, bId: b.childId, aToB: twin ? 'twin sibling' : 'sibling', bToA: twin ? 'twin sibling' : 'sibling', provenance: 'inferred', confidence: 'inferred', reason: 'shared established parent', inferred: true, groupId: a.groupId && a.groupId === b.groupId ? a.groupId : '', sharedDescriptor: twin ? 'twins' : '' });
            }
        }
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
            if (!counterpart || counterpart.id === owner.id) unresolvedText.push(formatKeyRelationship(parsed.subject, parsed.relation, parsed.dynamic));
            else existingParsed.push({ counterpartId: counterpart.id, relation: parsed.relation, dynamic: parsed.dynamic, score: 100 });
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
                item.relation = mergeRelations(item.relation, view.relation);
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

export function remapSocialGraphNpcId(rawGraph, fromId, toId) {
    const graph = normalizeSocialGraph(rawGraph);
    const from = clean(fromId, 100); const to = clean(toId, 100);
    if (!from || !to || from === to) return graph;
    for (const edge of graph.edges) {
        if (edge.aId === from) edge.aId = to;
        if (edge.bId === from) edge.bId = to;
    }
    for (const slot of graph.unresolved) if (slot.ownerId === from) slot.ownerId = to;
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

function pairConnects(edge, aId, bId) {
    return (edge.aId === aId && edge.bId === bId) || (edge.aId === bId && edge.bId === aId);
}

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
        graph.edges = graph.edges.filter(edge => !pairConnects(edge, owner.id, removedId));
        const counterpart = npcs.find(npc => npc?.id === removedId);
        removeMirroredRelationship(counterpart, owner, npcs);
    }
    for (const parsed of afterEntries) replaceManualRelationshipEdge(graph, owner, parsed, npcs, meta);
    next.socialGraph = normalizeSocialGraph(graph);
    return next;
}

export function reconcileSocialState(state = {}, options = {}) {
    const next = state && typeof state === 'object' ? state : {};
    const npcs = Array.isArray(next.npcs) ? next.npcs : [];
    canonicalizeNpcKeyRelationships(npcs);
    let graph = normalizeSocialGraph(next.socialGraph);
    const npcIds = new Set(npcs.map(npc => clean(npc?.id, 100)).filter(Boolean));
    graph.edges = graph.edges.filter(edge => npcIds.has(edge.aId) && npcIds.has(edge.bId));
    graph.unresolved = graph.unresolved.filter(slot => npcIds.has(slot.ownerId));
    graph = alignGraphWithCanonicalRelationships(graph, npcs);
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
    inferSiblingEdges(graph);
    graph = normalizeSocialGraph(graph);
    const updatedIds = projectGraphToKeyRelationships(npcs, graph);
    next.socialGraph = graph;
    return { state: next, socialGraph: graph, updatedIds, unresolvedAdded: transcriptFacts.length };
}
