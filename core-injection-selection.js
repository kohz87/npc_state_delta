/* NPC State Delta injection selection and budget: behavior guidance, NPC relevance selection and
   token-budget normalization. Split unchanged from core-injection.js; core-injection.js re-exports
   these public names. */
import { DEFAULT_RELATIONSHIP, DURABLE_PROFILE_LIMITS, durableSemanticSimilarity, normalizeRelationshipBaseline, RELATIONSHIP_KEYS } from './core-relationship.js';
import { cleanList, normalizeName } from './core-text.js';
import { countNormalizedPhrase } from './core-merge.js';
import { KEY_RELATIONSHIP_LIMIT, keyRelationshipSubject } from './core-keyrel.js';
import { socialGraphLabelsForNpc } from './social.js';
import { IMPORTANT_MEMORY_LIMIT } from './core-record.js';

export function buildBehaviorGuidance(npc) {
    const rel = normalizeRelationshipBaseline(npc?.relationship || DEFAULT_RELATIONSHIP);
    const material = RELATIONSHIP_KEYS
        .map(key => ({ key, value: rel[key], magnitude: Math.abs(rel[key]) }))
        .filter(item => item.magnitude >= 30)
        .sort((a, b) => b.magnitude - a.magnitude || RELATIONSHIP_KEYS.indexOf(a.key) - RELATIONSHIP_KEYS.indexOf(b.key));
    if (!material.length) return 'relationship remains mostly neutral or unsettled; let identity, goals, and current state drive behavior';

    const cues = [];
    for (const { key, value } of material) {
        if (key === 'trust') {
            if (value <= -70) cues.push('strong distrust: protect self and verify claims');
            else if (value <= -30) cues.push('distrust: remain guarded about reliance');
            else if (value < 70) cues.push('trust: some extra candor/reliance is plausible');
            else cues.push('strong trust: vulnerability/reliance is permitted when identity and context allow');
        } else if (key === 'affection') {
            if (value <= -70) cues.push('strong resentment/dislike may cool treatment');
            else if (value <= -30) cues.push('dislike/resentment is established');
            else if (value < 70) cues.push('affection: modest extra concern/attention may appear through established care style');
            else cues.push('strong affection: high emotional importance, not devotion or self-erasure');
        } else if (key === 'desire') {
            if (value <= -70) cues.push('strong aversion to intimate/romantic closeness');
            else if (value <= -30) cues.push('aversion to intimate/romantic closeness is established');
            else if (value < 70) cues.push('attraction may subtly color attention only when context supports it');
            else cues.push('strong desire may affect attention/proximity only through established expressiveness and consent');
        } else if (key === 'tension') {
            if (value <= -70) cues.push('exceptional ease/safety may lower interpersonal pressure');
            else if (value <= -30) cues.push('noticeable ease/reduced pressure is established');
            else if (value < 70) cues.push('unresolved pressure may affect delivery only in the form the scene supports');
            else cues.push('strong unresolved pressure matters, but does not imply jealousy, embarrassment, hostility, or denial');
        }
    }
    const combinations = [];
    if (rel.trust >= 70 && rel.tension >= 70) combinations.push('familiarity and strain coexist');
    if (rel.affection >= 70 && rel.trust <= -30) combinations.push('care does not erase distrust');
    if (rel.desire >= 70 && rel.trust <= -30) combinations.push('attraction does not imply safety or trust');
    return [...combinations, ...cues].join('; ');
}

export function scoreNpcRelevance(npc, text, turn = 0, socialGraph = null, allNpcs = []) {
    const haystack = normalizeName(text);
    let score = 0;
    for (const label of [npc.name, ...(npc.aliases || [])]) {
        const needle = normalizeName(label);
        if (needle && countNormalizedPhrase(haystack, needle) > 0) score += label === npc.name ? 8 : 5;
    }
    const canonicalTokens = normalizeName(npc.name).split(/\s+/).filter(Boolean);
    if (canonicalTokens.length > 1 && canonicalTokens[0].length >= 4 && countNormalizedPhrase(haystack, canonicalTokens[0]) > 0) score += 6;
    const role = normalizeName(npc.role);
    if (role && countNormalizedPhrase(haystack, role) > 0) score += 3;
    for (const entry of cleanList(npc.keyRelationships, KEY_RELATIONSHIP_LIMIT, DURABLE_PROFILE_LIMITS.keyRelationship)) {
        const subject = keyRelationshipSubject(entry);
        if (subject && countNormalizedPhrase(haystack, subject) > 0) score += 2;
    }
    for (const label of socialGraphLabelsForNpc(socialGraph, npc.id, allNpcs)) {
        const subject = normalizeName(label);
        if (subject && countNormalizedPhrase(haystack, subject) > 0) score += 2;
    }
    const goalSimilarity = npc.goal ? durableSemanticSimilarity(npc.goal, text) : 0;
    if (goalSimilarity >= 0.35) score += Math.max(1, Math.round(goalSimilarity * 4));
    const memoryMatch = cleanList(npc.memories, IMPORTANT_MEMORY_LIMIT, DURABLE_PROFILE_LIMITS.memory)
        .some(memory => durableSemanticSimilarity(memory, text) >= 0.42);
    if (memoryMatch) score += 1;
    const age = Math.max(0, Number(turn) - Number(npc.lastSeenTurn || 0));
    score += Math.max(0, 4 - age);
    // Runtime prompt-space selection is calculated from current story salience only.
    return score;
}

export function selectRelevantNpcs(npcs, text, turn = 0, limit = 3, socialGraph = null, graphRegistry = null) {
    const all = [...(npcs || [])];
    const registry = Array.isArray(graphRegistry) ? graphRegistry : all;
    return all
        .map(npc => ({ npc, score: scoreNpcRelevance(npc, text, turn, socialGraph, registry) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit))
        .map(item => item.npc);
}

export const DEFAULT_INJECTION_BUDGET_TOKENS = 4000;
// Section caps are sized for this budget and grow in proportion above it (see buildInjection).
export const INJECTION_CAP_BASE_TOKENS = 1800;
export const MIN_INJECTION_BUDGET_TOKENS = 512;
export const MAX_INJECTION_BUDGET_TOKENS = 6000;
export const APPROX_CHARS_PER_TOKEN = 4;

export function normalizeInjectionBudgetTokens(value) {
    return Math.max(MIN_INJECTION_BUDGET_TOKENS, Math.min(MAX_INJECTION_BUDGET_TOKENS, Math.round(Number(value) || DEFAULT_INJECTION_BUDGET_TOKENS)));
}

export function estimateInjectionTokens(text) {
    return Math.ceil(String(text || '').length / APPROX_CHARS_PER_TOKEN);
}
