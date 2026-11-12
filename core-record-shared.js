/* NPC State Delta record shared primitives: admission/portrait constants, cast-appearance preservation, appearance canon,
   stored-memory normalization, label matching and scanner-citation stripping. Split from core-record.js without change;
   core-record.js re-exports the names it exported before. Never imports core-record.js, core-mechanics.js or core.js. */
import { AGE_NUMBER_WORD_RE } from './core-identity.js';
import { compactDurableText, DURABLE_PROFILE_LIMITS, durableSemanticSimilarity, semanticDedupeItems } from './core-relationship.js';
import { cleanList, cleanText, normalizeName, stripMessageCitations } from './core-text.js';
import { TEXT_FIELDS } from './src/fields/registry.js';
export const NPC_ADMISSION_MODES = Object.freeze(['conservative', 'balanced', 'manual_only']);
export const IMPORTANT_MEMORY_LIMIT = 5;

export const PORTRAIT_SEED_MAX = Number.MAX_SAFE_INTEGER;

export function normalizePortraitSeed(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const seed = Number(value);
    return Number.isSafeInteger(seed) && seed >= 0 && seed <= PORTRAIT_SEED_MAX ? seed : null;
}

export function normalizeNpcAdmissionMode(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    return NPC_ADMISSION_MODES.includes(mode) ? mode : 'conservative';
}

export function normalizeLifeStateCertainty(value) {
    const certainty = String(value ?? '').trim().toLowerCase();
    return ['explicit', 'inferred'].includes(certainty) ? certainty : '';
}

/** The longest a cast dossier's stored appearance can be: the pack's look and wears (1800 each) joined by "; ". */
export const CAST_APPEARANCE_WIDE = 3700;

/**
 * (the living cast) Which of a cast dossier's appearance fields still are the pack's own words (`castFrom.first`), and the stored
 * current appearance split into its parts. The stored `appearance` is the RESOLVED text, "<overallAppearance>; <current part>", so the
 * pack's `wears` is compared with the part after the physical words, not with the whole. Returns
 * { overall, appearance, head, part } where `overall` / `appearance` say the field still is the pack's words, `head` is the physical
 * text and `part` the stored text after it (the whole stored text when it does not start with the physical words).
 */
export function castAppearanceKept(raw) {
    const first = raw?.castFrom && typeof raw.castFrom.first === 'object' && raw.castFrom.first ? raw.castFrom.first : {};
    const text = (value, max) => (typeof value === 'string' ? cleanText(value, max) : '');
    const physical = text(raw?.overallAppearance, 1800);
    const stored = text(raw?.appearance, CAST_APPEARANCE_WIDE);
    const head = physical.replace(/[\s.;,]+$/, '');
    let part = stored;
    let split = false;
    if (physical) {
        if (stored === physical || stored === head) { part = ''; split = true; }
        else if (stored.startsWith(`${head}; `)) { part = stored.slice(head.length + 2); split = true; }
    }
    const firstPhysical = text(first.overallAppearance, 1800);
    const firstCurrent = text(first.appearance, 1800);
    const overall = Boolean(physical) && physical === firstPhysical;
    // No pack words for the current part (an entry without `wears`): the stored text is the physical words alone while it still is them.
    const appearance = Boolean(stored) && (firstCurrent ? part === firstCurrent : (overall && part === ''));
    return { overall, appearance, head, part, split };
}

export const NPC_CANDIDATE_TTL_TURNS = 15;
export const NPC_CANDIDATE_LIMIT = 60;

export function normalizeAppearanceCanon(value) {
    let text = compactDurableText(value, DURABLE_PROFILE_LIMITS.appearance, 10);
    if (!text) return '';
    const ageToken = `(?:\\d{1,3}|${AGE_NUMBER_WORD_RE})`;
    const articlePattern = new RegExp(`^(\\s*(?:a|an)\\s+)${ageToken}(?:[-\\s]+years?[-\\s]+old)\\s+`, 'i');
    const barePattern = new RegExp(`^\\s*${ageToken}(?:[-\\s]+years?[-\\s]+old)\\s+`, 'i');
    text = text.replace(articlePattern, '$1').replace(barePattern, '');
    text = text.replace(new RegExp(`^\\s*(?:aged|age)\\s+${ageToken}\\s*[,;:-]?\\s*`, 'i'), '');
    text = text.replace(/\s+/g, ' ').trim();
    if (text && /^[a-z]/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
    return cleanText(text, DURABLE_PROFILE_LIMITS.appearance);
}

export function npcMatchesLabel(npc, label) {
    const key = normalizeName(label);
    if (!key || !npc) return false;
    return [npc.name, ...(npc.aliases || [])].some(value => normalizeName(value) === key);
}

export function normalizeStoredMemories(value) {
    const cleaned = semanticDedupeItems(cleanList(value, 64, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: 64,
        maxChars: DURABLE_PROFILE_LIMITS.memory,
        similarity: 0.58,
    });
    if (cleaned.length <= IMPORTANT_MEMORY_LIMIT) return cleaned;
    // Keep only the most recent bounded set after semantic dedupe.
    return cleaned.slice(-IMPORTANT_MEMORY_LIMIT);
}


// (memory dates) `memoryStamps`: a parallel map { normalized memory text: { m: reply index, d: story date text } } beside the memories list,
// whose own shape never changes. Only memories that are stored have an entry; one stored before this had none shows no date (never guessed).
export function normalizeMemoryStamps(value, memories) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const text of Array.isArray(memories) ? memories : []) {
        const key = normalizeName(text);
        const stamp = key && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null;
        const message = Number(stamp?.m);
        if (!Number.isInteger(message) || message < 0) continue;
        const date = typeof stamp.d === 'string' ? stamp.d.trim().slice(0, 40) : '';
        out[key] = date ? { m: message, d: date } : { m: message };
    }
    return Object.keys(out).length ? out : undefined;
}

// The stamps after a change from `before` to `after`: a kept memory keeps its stamp; a new one gets the reply it was recorded in and that reply's
// story date (`dateAt(message)`); one the merge only re-worded (similar to a memory that left) inherits the old stamp; a memory gone loses its.
export function stampMemories(before, after, message = null, dateAt = null) {
    const memories = Array.isArray(after?.memories) ? after.memories : [];
    const old = normalizeMemoryStamps(after?.memoryStamps ?? before?.memoryStamps, [...(Array.isArray(before?.memories) ? before.memories : []), ...memories]) ?? {};
    const had = new Set((Array.isArray(before?.memories) ? before.memories : []).map(normalizeName));
    // (memory facts) A fact's line keeps the reply it belongs to (and that reply's story date) and never inherits a stamp by similarity.
    const factOf = new Map(Object.values(after?.memoryFacts?.entries ?? {}).map(entry => [entry.t, entry]));
    const factOld = new Set(Object.values(before?.memoryFacts?.entries ?? {}).map(entry => entry.t));
    const gone = (Array.isArray(before?.memories) ? before.memories : []).filter(text => !factOld.has(normalizeName(text)) && !memories.some(item => normalizeName(item) === normalizeName(text)));
    const out = {};
    let date = null;
    for (const text of memories) {
        const key = normalizeName(text);
        if (!key) continue;
        if (old[key]) { out[key] = old[key]; continue; }
        const fact = factOf.get(key);
        if (fact) { const day = fact.d || String(dateAt?.(fact.r) ?? '').trim().slice(0, 40); out[key] = day ? { m: fact.r, d: day } : { m: fact.r }; continue; }
        if (had.has(key)) continue;   // stored before stamps existed: no date, never a guessed one
        const reworded = gone.find(item => durableSemanticSimilarity(item, text) >= 0.58);
        if (reworded) { const inherited = old[normalizeName(reworded)]; if (inherited) out[key] = inherited; continue; }   // an undated old memory stays undated
        if (!Number.isInteger(message) || message < 0) continue;
        date ??= String(dateAt?.(message) ?? '').trim().slice(0, 40);
        out[key] = date ? { m: message, d: date } : { m: message };
    }
    return Object.keys(out).length ? out : undefined;
}

// (stage 73) Message citations ("[m1, m2]") the scanner's model appended to a field are not dossier text: normalizeNpcRecord strips them from
// every stored text field and list item, so a saved dossier is cleaned the next time it is normalized. An evidence item keeps its intended
// leading "[mN] " tag (message attribution); only citations after it go.
const CITATION_LIST_FIELDS = ['aliases', 'mannerisms', 'behaviorProfile', 'behavior_profile', 'memories', 'manualMemories', 'keyRelationships', 'key_relationships', 'innerCircle', 'inner_circle', 'family'];
const CITATION_TEXT_FIELDS = [...TEXT_FIELDS, 'overallAppearance', 'unclassifiedAppearance', 'lifeStateReason'];
const stripEvidenceCitations = item => {
    if (typeof item !== 'string') return item;
    const lead = item.match(/^\s*\[m\d+\]\s*/i);
    return lead ? lead[0] + stripMessageCitations(item.slice(lead[0].length)) : stripMessageCitations(item);
};
export function stripRecordCitations(raw) {
    const out = { ...raw };
    // The reader's own fields (locked in the editor) and a cast pack's words still as the pack wrote them are not the scanner's: left as they are.
    const locked = new Set(Array.isArray(raw?.manualProfileFields) ? raw.manualProfileFields.map(value => String(value || '').trim()) : []);
    const first = raw?.castFrom?.first && typeof raw.castFrom.first === 'object' ? raw.castFrom.first : {};
    const keep = key => locked.has(key) || (first[key] !== undefined && JSON.stringify(first[key]) === JSON.stringify(out[key]));
    for (const key of CITATION_TEXT_FIELDS) if (typeof out[key] === 'string' && !keep(key)) out[key] = stripMessageCitations(out[key]);
    for (const key of CITATION_LIST_FIELDS) if (Array.isArray(out[key]) && !keep(key)) out[key] = out[key].map(item => (typeof item === 'string' ? stripMessageCitations(item) : item));
    if (Array.isArray(out.appearanceForms)) {
        out.appearanceForms = out.appearanceForms.map(form => (form && typeof form.appearance === 'string' ? { ...form, appearance: stripMessageCitations(form.appearance) } : form));
    }
    for (const key of ['profileEvidence', 'profile_evidence']) {
        const evidence = out[key];
        if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
            out[key] = Object.fromEntries(Object.entries(evidence).map(([field, list]) => [field, Array.isArray(list) ? list.map(stripEvidenceCitations) : list]));
        }
    }
    return out;
}
