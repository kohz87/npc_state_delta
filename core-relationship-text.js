/* NPC State Delta durable text helpers: concept tokens, grounding coverage, semantic similarity,
   compact-equivalent choice, clause splitting, semantic deduplication and compact durable text.
   Moved unchanged out of core-relationship.js; that file re-exports every public name it exported
   before. Never imports core-relationship.js, core-mechanics.js or core.js. */
import { cleanText, normalizeName } from './core-text.js';

const DURABLE_REFINEMENT_STOPWORDS = new Set([
    'and', 'the', 'with', 'that', 'this', 'their', 'they', 'them', 'when', 'while', 'from', 'into', 'over', 'under',
    'very', 'more', 'less', 'than', 'then', 'but', 'for', 'her', 'his', 'its', 'she', 'him', 'who', 'has', 'have', 'had',
    'uses', 'use', 'often', 'usually', 'still', 'also', 'only', 'toward', 'towards', 'around', 'becomes', 'become', 'being',
    'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'by', 'or', 'it', 'he',
]);

const DURABLE_CONCEPT_ALIASES = Object.freeze({
    telepathy: 'telepath', telepathic: 'telepath', telepathically: 'telepath',
    connection: 'link', connections: 'link', connected: 'link', channel: 'link', channels: 'link', linked: 'link',
    thoughts: 'mind', thought: 'mind', minds: 'mind', mental: 'mind',
    siblings: 'sibling', sisters: 'sister', brothers: 'brother',
    courteous: 'courtesy', courteously: 'courtesy', politeness: 'polite', politely: 'polite',
    humorous: 'humor', humorously: 'humor', dryly: 'dry',
    kindness: 'kind', kindhearted: 'kind', compassionate: 'compassion', compassion: 'compassion',
    reserved: 'reserve', restraint: 'restrain', restrained: 'restrain',
    gentleness: 'gentle', gently: 'gentle', motherly: 'maternal',
    speaks: 'speak', speaking: 'speak', spoken: 'speak', says: 'say', saying: 'say',
    gestures: 'gesture', gesturing: 'gesture', movements: 'movement',
    bonded: 'bond', bonding: 'bond', bonds: 'bond',
});

function durableConceptToken(token) {
    let word = String(token || '').toLowerCase();
    if (!word) return '';
    if (DURABLE_CONCEPT_ALIASES[word]) return DURABLE_CONCEPT_ALIASES[word];
    if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
    else if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
    return DURABLE_CONCEPT_ALIASES[word] || word;
}

export function durableRefinementTokens(value) {
    return normalizeName(value).split(/\s+/)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !DURABLE_REFINEMENT_STOPWORDS.has(token))
        .map(durableConceptToken)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !DURABLE_REFINEMENT_STOPWORDS.has(token));
}

export function durableTokenCoverage(existing, incoming) {
    const oldTokens = [...new Set(durableRefinementTokens(existing))];
    if (!oldTokens.length) return 0;
    const newTokens = new Set(durableRefinementTokens(incoming));
    return oldTokens.filter(token => newTokens.has(token)).length / oldTokens.length;
}

export function durableSeedGrounded(value, context = '') {
    const source = String(context || '').trim();
    if (!source) return true; // structured import/API compatibility when no source narration is available.
    const proposed = [...new Set(durableRefinementTokens(value))]
        .filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const sourceTokens = new Set(durableRefinementTokens(source));
    const overlap = proposed.filter(token => sourceTokens.has(token));
    // One distinctive directly stated concept is enough for a tiny field; larger summaries
    // need at least two grounded concepts so one observed act cannot mint a whole personality.
    const required = proposed.length <= 2 ? 1 : 2;
    return overlap.length >= required;
}

export function durableEvidenceGroundsValue(value, evidenceItems = []) {
    const proposed = [...new Set(durableRefinementTokens(value))]
        .filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const evidenceTokens = new Set(durableRefinementTokens((Array.isArray(evidenceItems) ? evidenceItems : []).join(' ')));
    const overlap = proposed.filter(token => evidenceTokens.has(token)).length;
    const required = proposed.length <= 2 ? proposed.length : Math.ceil(proposed.length * 0.6);
    return overlap >= required;
}

export function durableSemanticSimilarity(a, b) {
    const left = new Set(durableRefinementTokens(a));
    const right = new Set(durableRefinementTokens(b));
    if (!left.size || !right.size) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    if (Math.min(left.size, right.size) < 2) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    const containment = overlap / Math.min(left.size, right.size);
    const jaccard = overlap / (left.size + right.size - overlap);
    const conceptCluster = overlap >= 3 && containment >= 0.4 ? 0.62 : 0;
    return Math.max(jaccard, containment * 0.86, conceptCluster);
}

export function chooseCompactEquivalent(existing, incoming) {
    const oldText = cleanText(existing, 1200);
    const newText = cleanText(incoming, 1200);
    if (!oldText) return newText;
    if (!newText) return oldText;
    const oldCount = new Set(durableRefinementTokens(oldText)).size;
    const newCount = new Set(durableRefinementTokens(newText)).size;
    if (newCount >= oldCount + 2) return newText;
    if (oldCount >= newCount + 2) return oldText;
    return newText.length <= oldText.length * 1.15 ? newText : oldText;
}

function splitDurableClauses(value) {
    const source = String(value ?? '')
        .replace(/\r/g, '\n')
        .replace(/[•●▪◦]+/g, ';')
        .replace(/\s+[·]\s+/g, '; ');
    return source.split(/\n+|\s*;\s*|(?<=[.!?])\s+(?=[A-Z0-9])/)
        .map(part => cleanText(part, 520))
        .filter(Boolean);
}

export function splitDurableClaimUnits(value) {
    const out = [];
    for (const clause of splitDurableClauses(value)) {
        const units = clause
            .split(/\s*,\s*|\s+\b(?:and|but|while|yet)\b\s+/iu)
            .map(part => cleanText(part, 520))
            .filter(part => durableRefinementTokens(part).some(token => token.length >= 3 && !/^\d+$/.test(token)));
        if (units.length > 1) out.push(...units);
        else out.push(clause);
    }
    return out.filter(Boolean);
}

export function semanticDedupeItems(items, { maxItems = 8, maxChars = 320, similarity = 0.62 } = {}) {
    const out = [];
    for (const raw of Array.isArray(items) ? items : []) {
        const item = cleanText(raw, maxChars);
        if (!item) continue;
        const exact = normalizeName(item);
        let match = out.findIndex(existing => normalizeName(existing) === exact || durableSemanticSimilarity(existing, item) >= similarity);
        if (match >= 0) out[match] = chooseCompactEquivalent(out[match], item);
        else out.push(item);
        if (out.length > maxItems * 2) out.splice(0, out.length - maxItems * 2);
    }
    return out.slice(-maxItems);
}

export function compactDurableText(value, maxChars, maxClauses = 8) {
    let clauses = semanticDedupeItems(splitDurableClauses(value), {
        maxItems: 64, maxChars: Math.min(520, maxChars), similarity: 0.60,
    });
    if (clauses.length > maxClauses) {
        // Preserve both the established core and the newest distinct refinements when a
        // oversized append-only field has more concepts than the compact summary can carry.
        const headCount = Math.ceil(maxClauses / 2);
        clauses = [...clauses.slice(0, headCount), ...clauses.slice(-(maxClauses - headCount))];
    }
    if (!clauses.length) return '';
    const out = [];
    let used = 0;
    for (const clause of clauses) {
        const separator = out.length ? '; ' : '';
        const available = maxChars - used - separator.length;
        if (available <= 0) break;
        if (clause.length <= available) {
            out.push(clause);
            used += separator.length + clause.length;
            continue;
        }
        if (!out.length) out.push(cleanText(clause, maxChars));
        break;
    }
    return out.join('; ');
}
