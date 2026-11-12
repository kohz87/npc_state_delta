/* NPC State Delta key-relationship edges: compacting, subject matching, merging and normalizing key-relationship entries/edges,
   applying edges across NPCs, and extracting explicit edges from text, with KEY_RELATIONSHIP_LIMIT. A pure part of
   core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it exported before.
   Imports only core-text.js and social.js. */
import { compactSocialKeyRelationship, resolveNpcId, SOCIAL_DYNAMIC_MAX_CHARS } from './social.js';
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

export function mergeKeyRelationshipUpdates(existing, incoming, tieState = null) {
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
        else if (tieState) {
            // Full list and this person records ties' last mentions: the new tie takes the place of the weakest, least recently mentioned one.
            const victim = tieEvictionIndex(current, tieState);
            if (victim >= 0) current[victim] = entry;
        }
    }
    return current.slice(0, KEY_RELATIONSHIP_LIMIT);
}

// ---- Tie types, fading and priority (owner decisions 12 Nov). All pure; no model call. ----
// A tie's type is one of five broad kinds, read from the stored relation text with the fixed keyword table below (first matching row
// wins, in this order); no match, or a weak/one-time word, is Passing. A type set by a pack or the player (a `~ tie` tag) wins over the words.
export const TIE_TYPE_LABELS = Object.freeze({ ally: 'Ally', rival: 'Rival', owes: 'Owes', interest: 'Interest', passing: 'Passing' });
// Priority: Ally = Rival = Owes (high) > Interest > Passing. Rank 0 is the strongest.
export const TIE_TYPE_RANK = Object.freeze({ ally: 0, rival: 0, owes: 0, interest: 1, passing: 2 });
// Story days without a mention before a tie fades (one constant per tier; the owner's 14 days is the middle tier).
export const TIE_FADE_DAYS = Object.freeze({ passing: 7, interest: 14, high: 30 });
const TIE_KEYWORDS = [
    ['rival', /\b(?:rival|rivals|enemy|enemies|nemesis|foe|adversary|antagonist|arch-?enem\w*|feud\w*|hostile|hates?|loathes?|bitter)\b/i],
    ['owes', /\b(?:owes|owing|indebted|debt|beholden|creditor|obligated|oath-?bound|sworn to|saved (?:her|his|their|my) life|rescued (?:her|his|their))\b/i],
    ['ally', /\b(?:ally|allies|friends?|best friend|partner|spouse|wife|husband|lover|fianc\w+|betrothed|girlfriend|boyfriend|mother|father|parents?|mom|dad|sister|brother|sibling|daughter|son|cousin|aunt|uncle|grand\w+|family|kin|mentor|teacher|master|apprentice|student|companion|comrade|confidant\w*|guardian|ward|protector|bodyguard|crewmate|trusted|loyal|sworn)\b/i],
    ['interest', /\b(?:crush|attracted|attraction|curious|fascinat\w*|intrigu\w*|admires?|admirer|suitor|courting|flirt\w*|infatuat\w*|love interest|colleague|coworker|neighbou?r|client|employer|boss|employee|acquaintance|contact|regular)\b/i],
];
// "owed by" / "debtor": the OTHER person owes, so it is not an Owes tie for this one (owes is one-way); it falls through to the other rows.
const OWED_BY = /\b(?:owed by|owed to by|debtor)\b/i;

/** The type of one tie: `tags` (a pack/player tie tag list: rival, owes, ally) wins, else the keyword table on the relation text. */
export function tieType(relation, tags = []) {
    const set = Array.isArray(tags) ? tags : [];
    if (set.includes('owes')) return 'owes';
    for (const tag of set) if (Object.hasOwn(TIE_TYPE_RANK, tag) && TIE_TYPE_RANK[tag] === 0) return tag;
    const text = String(relation ?? '').replace(OWED_BY, ' ');
    for (const [type, pattern] of TIE_KEYWORDS) if (pattern.test(text)) return type;
    return 'passing';
}

const tieFadeDays = type => (type === 'passing' ? TIE_FADE_DAYS.passing : type === 'interest' ? TIE_FADE_DAYS.interest : TIE_FADE_DAYS.high);
const DEAD_TIE = /[;|]\s*(?:deceased|dead)\b|^surviving widow|\((?:deceased|dead)\)/i;
const tieParts = entry => {
    const text = compactKeyRelationshipEntry(entry);
    const match = text.match(/^(.+?)(?:\s+[—–-]\s+|\s*\|\s*|\s*:\s+)([\s\S]*)$/);
    return { text, name: match ? match[1].trim() : text, rest: match ? match[2].trim() : '' };
};

/** Whether this person records ties' last mentions yet (an object `tieSeen`, written by a scan that had a story day). Without it nothing fades. */
export const tiesTracked = npc => !!npc && typeof npc.tieSeen === 'object' && npc.tieSeen !== null && !Array.isArray(npc.tieSeen);

/** The name/alias → person map of a roster, for readTieRows/narratorTies/recordTieMentions: build it once per projection, not per person. */
export function tieRoster(npcs) {
    const map = new Map();
    const labels = new Map();   // person -> every name key they answer to (map.labels), so a mention check never scans the roster
    for (const other of Array.isArray(npcs) ? npcs : []) {
        for (const label of [other?.name, ...(other?.aliases || [])]) {
            if (!label) continue;
            const key = normalizeName(label);
            map.set(key, other);
            labels.set(other, [...(labels.get(other) || []), key]);
        }
    }
    map.labels = labels;
    return map;
}

/**
 * The ties of one person, read for the board and the narrator: [{ entry, name, key, type, rank, seen, state }] in priority order
 * (high types, then Interest, then Passing; most recently mentioned first inside a type). `state`: 'active', 'faded' (not mentioned for
 * its tier's days), 'left' (the other person is archived), 'died' (a death mark or the other person's life state). Only when
 * tiesTracked(npc) does anything leave 'active'; an older chat reads exactly as before. `day`: the story day now (null: no fading by time).
 * `tags(name)`: optional pack/player tie tags of the person. `roster`: tieRoster(npcs) built once by a caller that reads many people (else built here).
 */
export function readTieRows(npc, { npcs = [], day = null, tags = () => [], roster = null } = {}) {
    const tracked = tiesTracked(npc);
    const others = roster || tieRoster(npcs);
    const rows = (Array.isArray(npc?.keyRelationships) ? npc.keyRelationships : []).map((entry, index) => {
        const { text, name, rest } = tieParts(entry);
        const key = normalizeName(name);
        const type = tieType(rest, tags(name));
        const seenRaw = tracked ? npc.tieSeen[key] : undefined;
        const seen = Number.isInteger(seenRaw) ? seenRaw : null;
        const other = others.get(key);
        let state = 'active';
        if (tracked) {
            if (DEAD_TIE.test(`${rest} ${text}`) || other?.lifeState === 'deceased') state = 'died';
            else if (other?.archived) state = 'left';
            else if (seen !== null && Number.isInteger(day) && day - seen >= tieFadeDays(type)) state = 'faded';
        }
        return { entry: text, name, key, type, rank: TIE_TYPE_RANK[type], seen, state, index, quiet: seen !== null && Number.isInteger(day) ? Math.max(0, day - seen) : null };
    });
    return rows.sort((a, b) => a.rank - b.rank || (b.seen ?? -1) - (a.seen ?? -1) || a.index - b.index);
}

/** The ties the narrator may be told of: active ones in priority order, plus a died/left one only when `scene` (text) names the person. */
export function narratorTies(npc, { npcs = [], day = null, scene = '', tags, roster = null } = {}) {
    const sceneText = normalizeName(scene);
    return readTieRows(npc, { npcs, day, tags, roster }).filter(row => row.state === 'active'
        || (row.state === 'died' && row.key && sceneText.includes(row.key)));
}

// The victim when the list is full: the lowest-priority tier first, inside it the least recently mentioned (no mention recorded counts
// as the oldest). A list the reader edited by hand (`tieState.manual`) is never touched; -1 = nobody to replace (the new tie is dropped).
function tieEvictionIndex(current, tieState) {
    if (tieState.manual) return -1;
    const rows = readTieRows({ keyRelationships: current, tieSeen: tieState.seen ?? {} }, { npcs: tieState.npcs, day: null, tags: tieState.tags });
    const weakest = rows.at(-1);
    return weakest ? weakest.index : -1;
}

/**
 * `tieSeen` after a reply on story `day`: each tie whose person `text` (the reply prose) or `named` (names in tie lines) mentions is marked `day`.
 * A mention is the whole name or one of that person's known aliases (`roster`: tieRoster of the cast) as whole words; never a first word or a title
 * ("the harbour captain" is not Captain Vane).
 */
export function recordTieMentions(npc, { day, text = '', named = [], roster = null } = {}) {
    if (!npc || !Number.isInteger(day)) return undefined;
    const hay = ` ${normalizeName(text)} `;
    const tied = new Set((Array.isArray(named) ? named : []).map(entry => normalizeName(tieParts(entry).name)));
    const next = { ...(tiesTracked(npc) ? npc.tieSeen : {}) };
    for (const entry of Array.isArray(npc.keyRelationships) ? npc.keyRelationships : []) {
        const key = normalizeName(tieParts(entry).name);
        if (!key) continue;
        const labels = [key, ...(roster?.labels?.get(roster.get(key)) || [])];
        if (tied.has(key) || labels.some(label => label && hay.includes(` ${label} `))) next[key] = Math.max(day, Number.isInteger(next[key]) ? next[key] : day);
    }
    for (const key of Object.keys(next)) if (!(npc.keyRelationships || []).some(entry => normalizeName(tieParts(entry).name) === key)) delete next[key];
    return tiesTracked(npc) || Object.keys(next).length ? next : undefined;
}

/** The `tags(name)` lookup for readTieRows from the notes' tie rows ([{ name, tags, owedBy }]): a set tag wins; a person who owes this one is a debt tie (Owes). */
export function noteTieTags(rows) {
    const byName = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row?.name ?? '').toLowerCase(), row?.tags?.length ? row.tags : (row?.owedBy ? ['owes'] : [])]));
    return name => byName.get(String(name).toLowerCase()) ?? [];
}

/** A stored `tieSeen` cleaned: at most KEY_RELATIONSHIP_LIMIT people, each a whole story day >= 0; undefined when it is not an object. */
export function cleanTieSeen(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const [key, day] of Object.entries(value).slice(0, KEY_RELATIONSHIP_LIMIT)) {
        if (key && key.length <= 160 && Number.isInteger(day) && day >= 0) out[key] = day;
    }
    return out;
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

// (ONEPASSCAP-3) An endpoint is its id, then its label read as an id (a `from`/`to` that holds "npc_sieke"), each exact or folded
// (resolveNpcId), then its label as a name or alias as before.
function relationshipEdgeNpc(npcs, id, label) {
    const list = Array.isArray(npcs) ? npcs : [];
    for (const ref of [cleanText(id, 100), cleanText(label, 120)]) {
        const byId = ref ? resolveNpcId(list, ref) : null;
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
        // (ONEPASSCAP-3) An unresolved endpoint that is an id ("npc_nobody") names no one: it is never written as a tie's name.
        const aName = cleanText(aNpc?.name || (/^npc_/i.test(edge.a) ? '' : edge.a), 120);
        const bName = cleanText(bNpc?.name || (/^npc_/i.test(edge.b) ? '' : edge.b), 120);
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
