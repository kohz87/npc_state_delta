/* NPC State Delta durable-profile mannerism normalization and development-episode scoping helpers.
   Split unchanged from core-durable.js; public names are re-exported by core-durable.js, while the
   episode-label helper is internal to the grounding gates. */
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { chooseCompactEquivalent, DURABLE_PROFILE_LIMITS, durableRefinementTokens, durableSemanticSimilarity } from './core-relationship.js';

function mannerismPatternFamily(value) {
    const text = normalizeName(value);
    if (!text) return '';
    const paperwork = /\b(?:paperwork|paper|parchment|contract|notice|notices|document|documents|quill|quills|stamp|stamps|seal|seals|inkpad)\b/.test(text);
    const emphaticHandling = /\b(?:thrust|thrusts|slap|slaps|flick|flicks|shove|shoves|push|pushes|hand|hands|gesture|gestures|brisk|briskly|snap|snaps)\b/.test(text);
    if (paperwork && emphaticHandling) return 'paperwork_handling';
    return '';
}

function generalizedMannerismForFamily(family) {
    if (family === 'paperwork_handling') return 'Handles paperwork with brisk, emphatic physical gestures.';
    return '';
}

export function mannerismSimilarity(a, b) {
    const familyA = mannerismPatternFamily(a);
    const familyB = mannerismPatternFamily(b);
    if (familyA && familyA === familyB) return 0.95;
    return durableSemanticSimilarity(a, b);
}

export function normalizeMannerisms(value) {
    const items = cleanList(value, 16, DURABLE_PROFILE_LIMITS.mannerism);
    const out = [];
    const familyCounts = new Map();
    for (const item of items) {
        const family = mannerismPatternFamily(item);
        if (family) familyCounts.set(family, Number(familyCounts.get(family) || 0) + 1);
        let bestIndex = -1;
        let bestScore = 0;
        for (let i = 0; i < out.length; i += 1) {
            const score = mannerismSimilarity(out[i], item);
            if (score > bestScore) { bestScore = score; bestIndex = i; }
        }
        if (bestIndex >= 0 && bestScore >= 0.55) {
            const existingFamily = mannerismPatternFamily(out[bestIndex]);
            if (family && existingFamily === family && Number(familyCounts.get(family) || 0) >= 2) {
                out[bestIndex] = generalizedMannerismForFamily(family) || chooseCompactEquivalent(out[bestIndex], item);
            } else {
                out[bestIndex] = chooseCompactEquivalent(out[bestIndex], item);
            }
        } else if (out.length < 4) {
            out.push(item);
        }
    }
    return out.slice(0, 4);
}

function hasRecurrenceMarker(value) {
    const text = normalizeName(value);
    return /\b(habitual|habitually|always|usually|consistently|routinely|regularly|repeatedly|whenever)\b/.test(text)
        || /\btends to\b/.test(text)
        || /\beach time\b/.test(text)
        || /\bevery time\b/.test(text);
}

export function isExplicitRecurringMannerism(value, context = '') {
    const entry = cleanText(value, DURABLE_PROFILE_LIMITS.mannerism);
    const source = String(context || '').trim();
    if (!source) return hasRecurrenceMarker(entry);
    if (!hasRecurrenceMarker(source)) return false;
    const entryTokens = [...new Set(durableRefinementTokens(entry))];
    const sourceTokens = new Set(durableRefinementTokens(source));
    const overlap = entryTokens.filter(token => sourceTokens.has(token));
    return overlap.length >= Math.min(2, Math.max(1, entryTokens.length));
}

export function filterSafeMannerismRefinements(existing, incoming, allowNewPattern = false, context = '') {
    const current = normalizeMannerisms(existing);
    return normalizeMannerisms(incoming).filter(entry => {
        const related = current.some(item => mannerismSimilarity(item, entry) >= 0.55);
        return related || allowNewPattern || isExplicitRecurringMannerism(entry, context);
    });
}

export function developmentContextSegments(value) {
    return String(value || '').replace(/\r/g, '\n').split(/\n+|(?<=[.!?])\s+/)
        .map(part => cleanText(part, 1200)).filter(Boolean);
}

export const BATCH_EPISODE_MAX_CHARS = 5200;

export function developmentBindingLabels(binding = null) {
    const npc = binding?.npc && typeof binding.npc === 'object' ? binding.npc : null;
    if (!npc) return [];
    return [npc.name, ...(Array.isArray(npc.aliases) ? npc.aliases : [])]
        .map(normalizeName).filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index);
}

export function normalizedPhrasePresent(text, phrase) {
    const source = ` ${normalizeName(text)} `;
    const needle = ` ${normalizeName(phrase)} `;
    return Boolean(needle.trim()) && source.includes(needle);
}

export function episodeContainsLabel(segment, labels = []) {
    return labels.some(label => normalizedPhrasePresent(segment, label));
}

export function scopedEpisodeText(window, binding = null) {
    if (!binding) return cleanText(window, BATCH_EPISODE_MAX_CHARS);
    const targetLabels = developmentBindingLabels(binding);
    const otherLabels = (Array.isArray(binding?.otherLabels) ? binding.otherLabels : []).map(normalizeName).filter(Boolean);
    const segments = developmentContextSegments(window);
    const targetMentioned = segments.some(segment => episodeContainsLabel(segment, targetLabels));
    const otherMentioned = segments.some(segment => episodeContainsLabel(segment, otherLabels));
    if (!targetMentioned && binding?.targeted === true && !otherMentioned) return cleanText(window, BATCH_EPISODE_MAX_CHARS);

    const selected = [];
    let carryPronoun = false;
    for (const segment of segments) {
        const targetHere = episodeContainsLabel(segment, targetLabels);
        const otherHere = episodeContainsLabel(segment, otherLabels);
        if (otherHere && !targetHere) {
            carryPronoun = false;
            continue;
        }
        if (targetHere) {
            selected.push(segment);
            carryPronoun = true;
            continue;
        }
        const normalized = normalizeName(segment).replace(/^m\d+\s+/, '');
        const pronounContinuation = /^(?:(?:when\s+)?(?:she|he|they)|her|his|their|by then|during that time|during this time|throughout that time|throughout this period)\b/.test(normalized)
            || /^by\b.{0,72}\b(?:she|he|they)\b/.test(normalized);
        if (carryPronoun && pronounContinuation) {
            selected.push(segment);
            carryPronoun = false;
        } else {
            carryPronoun = false;
        }
    }
    return cleanText(selected.join(' '), BATCH_EPISODE_MAX_CHARS);
}
