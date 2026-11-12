/* Shared social-graph limits and text normalization/similarity helpers.
   Split from social.js; social.js remains the public facade. */

export const SOCIAL_GRAPH_VERSION = 1;
export const SOCIAL_GRAPH_EDGE_LIMIT = 240;
export const SOCIAL_GRAPH_UNRESOLVED_LIMIT = 120;
// Manual sibling removals; sized to the edge cap so a large family never silently loses a removal.
export const SOCIAL_GRAPH_SUPPRESSED_LIMIT = 240;
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

// How many ties a projected list keeps: 5 as ever, 8 for a person who records ties' last mentions (an object `tieSeen`, core-keyrel.js), so the
// full-list rule of the merge (the new tie replaces the weakest) can act. The stored list comes first (it scores highest), so a mirrored edge never cuts it.
export const projectedTieLimit = owner => (owner?.tieSeen && typeof owner.tieSeen === 'object' && !Array.isArray(owner.tieSeen) ? 8 : 5);

export {
    clean, normalizedWhitespace, cleanBoundary, norm, uniq, slug, confidenceRank,
    SOCIAL_SEMANTIC_STOPWORDS, semanticWords, semanticOverlap, nearDuplicateText,
    cleanDynamic, richer,
};
