/* NPC State Delta durable profile refinement: grounding and safety gates for Personality/Speech/Appearance/Background text
   refinements, morality-conflict checks, appearance correction, and mannerism normalization and merging. It also holds the
   few development-episode helpers these gates read (moved with it so that this file imports no later core file). A pure
   part of core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it exported
   before. Imports only core-text.js and core-relationship.js. */
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { chooseCompactEquivalent, compactDurableText, DURABLE_PROFILE_LIMITS, durableRefinementTokens, durableSeedGrounded, durableSemanticSimilarity, durableTokenCoverage, splitDurableClaimUnits } from './core-relationship.js';

export function identityMoralityMarkers(value) {
    const text = normalizeName(value);
    // Negated descriptors must not flip polarity merely because the keyword is present.
    // This is intentionally lexical and conservative: it protects common dossier wording
    // such as "kind-hearted and never cruel" without trying to solve general sentiment.
    const kindText = text
        .replace(/\b(?:not|never|hardly|rarely)\s+(?:kind|kindhearted|kind hearted|compassionate|empathetic|considerate|merciful|humane|gentle)\b/g, ' ')
        .replace(/\b(?:without|lacking)\s+(?:kindness|compassion|empathy|mercy|gentleness)\b/g, ' ');
    const cruelText = text
        .replace(/\b(?:not|never|hardly|rarely)\s+(?:cruel|sadistic|callous|merciless|inhumane)\b/g, ' ')
        .replace(/\b(?:without|avoids?|rejects?)\s+(?:cruelty|sadism|callousness)\b/g, ' ')
        .replace(/\b(?:no|zero)\s+(?:cruelty|sadism|callousness)\b/g, ' ');
    const kind = /\b(kind|kindhearted|kind hearted|compassionate|empathetic|considerate|merciful|humane|gentle)\b/.test(kindText)
        || /avoid(?:s|ing)? (?:needless|unnecessary) (?:harm|suffering|cruelty)/.test(text);
    const cruel = /\b(cruel|sadistic|callous|merciless|inhumane)\b/.test(cruelText)
        || /\benjoy(?:s|ing)?\b(?:\s+[\p{L}\p{N}'-]+){0,3}\s+(?:pain|suffering|cruelty|harm)\b/u.test(text)
        || /gratuitous (?:harm|suffering|cruelty)/.test(text);
    return { kind, cruel };
}

export function identityMoralityConflict(existing, incoming) {
    const old = identityMoralityMarkers(existing);
    const next = identityMoralityMarkers(incoming);
    return (old.kind && next.cruel) || (old.cruel && next.kind);
}

export function containsEvolutionLanguage(value) {
    const text = normalizeName(value);
    return /\b(no longer|formerly|used to|ceased|stopped being|replaced by|rather than|instead of|became|has become|have become|grown more|grown less|increasingly|decreasingly)\b/.test(text);
}

// Lever effects often state a preference ("helps through actions rather than words"), so for
// Behavioral Levers only wording that describes a change over time counts as evolution language.
export function containsBehaviorEvolutionLanguage(value) {
    const text = normalizeName(value);
    return /\b(no longer|formerly|used to|ceased|stopped being|replaced by|became|has become|have become|grown more|grown less|increasingly|decreasingly)\b/.test(text);
}

export function durableRefinementSupportText(context = '', evidenceItems = [], binding = null) {
    const rawContext = String(context || '').trim();
    const effectiveBinding = binding?.npc || (binding && typeof binding === 'object' && binding.name ? binding : null);
    const scopedContext = (effectiveBinding && rawContext) ? scopedEpisodeText(rawContext, binding) : rawContext;
    const targetLabels = binding ? developmentBindingLabels(binding) : [];
    const otherLabels = (Array.isArray(binding?.otherLabels) ? binding.otherLabels : []).map(normalizeName).filter(Boolean);
    const evidence = (Array.isArray(evidenceItems) ? evidenceItems : [])
        .filter(value => {
            const attributed = cleanText(String(value || '').replace(/^\[m\d+\]\s*/i, ''), DURABLE_PROFILE_LIMITS.evidence);
            if (!attributed) return false;
            if (otherLabels.length && episodeContainsLabel(attributed, otherLabels) && !episodeContainsLabel(attributed, targetLabels)) return false;
            const prefix = cleanText(attributed.match(/^([^:]{1,52}):\s+/)?.[1], 52);
            const prefixKey = normalizeName(prefix);
            const targetPrefix = targetLabels.some(label => prefixKey && normalizeName(label) === prefixKey);
            const properNamePrefix = /^[\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2}$/u.test(prefix);
            if (prefix && !targetPrefix && properNamePrefix && normalizedPhrasePresent(rawContext, prefix)) return false;
            return true;
        })
        .map(value => cleanText(String(value || '')
            .replace(/^\[m\d+\]\s*/i, '')
            .replace(/^[^:]{1,52}:\s*/, ''), DURABLE_PROFILE_LIMITS.evidence))
        .filter(item => {
            if (!item) return false;
            if (otherLabels.length && episodeContainsLabel(item, otherLabels) && !episodeContainsLabel(item, targetLabels)) {
                return false;
            }
            return true;
        });
    return [scopedContext, ...evidence].filter(Boolean).join(' ');
}

// Voice evidence must describe this NPC affirmatively. Each sentence is split into clauses and each
// clause attributed: to whoever it names first, a "who/whose" clause to the person named just before
// it ("Mira, who speaks warmly" is Mira's; "listens to Noela, who speaks warmly" is Noela's), a
// "her mother ..." subject to someone else, and an unnamed clause to the clause before it. Clauses
// owned by another person, hypothetical clauses ("if she spoke ...") and negated predicates
// ("does not / neither ... nor / denies speaking warmly") are dropped. Unattributed text such as a
// "Voice:" line or "she said softly" is kept, so ordinary attributed dialogue still counts.
const NEGATED_CLAIM_RE = /\b(?:not|never|hardly|rarely|no longer|without|neither|nor|denies|denied|deny|refuses?|refused|[a-z]+n t)\b[^,;]*?(?=\s+but\b|[,;]|$)/g;
const HYPOTHETICAL_CLAIM_RE = /\b(?:if|unless|would|might|could|wishes|wished|imagines?|imagined|pretends?|pretended)\b/;
const FOREIGN_KIN_SUBJECT_RE = /^(?:her|his|their|the)\s+(?:mother|father|sister|brother|aunt|uncle|friend|husband|wife|son|daughter|master|mistress|companion|cousin|grandmother|grandfather|parent|child|children|teacher|mentor|captain|innkeeper|stranger|guard|servant|maid)\b/;
const CLAUSE_SPLIT_RE = /\s*[,;:]\s*|\s+(?=(?:while|whereas|but|because|although|though|and then)\b)/i;

function affirmativeOwnClaimText(text, binding = null) {
    const otherLabels = [
        ...(Array.isArray(binding?.otherLabels) ? binding.otherLabels : []),
        ...(Array.isArray(binding?.speechOtherLabels) ? binding.speechOtherLabels : []),
    ].map(normalizeName).filter(Boolean);
    const targetLabels = developmentBindingLabels(binding);
    const targetTokens = new Set(targetLabels.flatMap(label => label.split(/\s+/)));
    const positions = (normalized, labels) => labels.flatMap(label => {
        const found = [];
        let at = normalized.indexOf(` ${label} `);
        while (at >= 0) { found.push(at); at = normalized.indexOf(` ${label} `, at + 1); }
        return found;
    });
    return developmentContextSegments(text).map(sentence => {
        let owner = null;
        let lastNamed = null;
        const kept = [];
        for (const raw of sentence.split(CLAUSE_SPLIT_RE).map(part => String(part || '').trim()).filter(Boolean)) {
            const normalized = ` ${normalizeName(raw)} `;
            const own = positions(normalized, targetLabels);
            const other = positions(normalized, otherLabels);
            // Capitalized names after the clause start that are not this NPC count as someone else.
            const capitalized = [...raw.matchAll(/(?<=\s)\p{Lu}[\p{L}\p{M}'’-]+/gu)].map(match => normalizeName(match[0]));
            const strangerNamed = capitalized.some(token => token && !targetTokens.has(token) && !other.length);
            let clauseOwner;
            if (/^(?:who|whose|which)\b/i.test(raw)) clauseOwner = lastNamed;
            else if (FOREIGN_KIN_SUBJECT_RE.test(normalized.trim())) clauseOwner = 'other';
            else if (own.length || other.length) {
                const firstOwn = own.length ? Math.min(...own) : Infinity;
                const firstOther = other.length ? Math.min(...other) : Infinity;
                clauseOwner = firstOwn < firstOther ? 'target' : 'other';
                if (clauseOwner === 'target' && targetLabels.some(label => new RegExp(`\\b${label}\\s+s\\s+(?:mother|father|sister|brother|friend|husband|wife|son|daughter|master|companion|cousin)\\b`).test(normalized))) clauseOwner = 'other';
            } else clauseOwner = owner;
            const lastOwn = own.length ? Math.max(...own) : -1;
            const lastOther = other.length ? Math.max(...other) : -1;
            if (lastOwn >= 0 || lastOther >= 0) lastNamed = lastOther > lastOwn ? 'other' : 'target';
            if (strangerNamed) lastNamed = 'other';
            if (clauseOwner) owner = clauseOwner;
            if (clauseOwner === 'other' || HYPOTHETICAL_CLAIM_RE.test(normalized)) continue;
            kept.push(normalized.replace(NEGATED_CLAIM_RE, ' ').replace(/\s+/g, ' ').trim());
        }
        return kept.filter(Boolean).join(' ');
    }).filter(Boolean).join(' ');
}

const GENERIC_VOICE_WORDS = new Set(['speak', 'speaks', 'spoke', 'speaking', 'speech', 'voice', 'voiced', 'talk', 'talks', 'talking', 'say', 'says', 'said', 'tone', 'words', 'sentences']);

// Whether a proposed voice is borrowed from text that is not this NPC's affirmative voice: some of
// its words occur in the narration, but only inside another person's or a negated clause.
export function speechSeedVetoed(value, context = '', binding = null) {
    const raw = String(context || '').trim();
    if (!raw) return false;
    const rawTokens = new Set(durableRefinementTokens(raw));
    const ownTokens = new Set(durableRefinementTokens(affirmativeOwnClaimText(raw, binding)));
    return [...new Set(durableRefinementTokens(value))]
        .filter(token => token.length >= 3 && !/^\d+$/.test(token) && !GENERIC_VOICE_WORDS.has(token))
        .some(token => rawTokens.has(token) && !ownTokens.has(token));
}

export function speechSupportContext(context = '', binding = null) {
    const raw = String(context || '').trim();
    return raw ? affirmativeOwnClaimText(raw, binding) : '';
}

export function durableRefinementCandidateGrounded(field, existing, incoming, context = '', evidenceItems = [], binding = null) {
    const maxChars = DURABLE_PROFILE_LIMITS[field] || DURABLE_PROFILE_LIMITS.appearance;
    const oldText = compactDurableText(existing, maxChars, field === 'speech' ? 5 : (field === 'personality' ? 6 : 10));
    const newText = compactDurableText(incoming, maxChars, field === 'speech' ? 5 : (field === 'personality' ? 6 : 10));
    if (!newText) return false;
    const rawSupport = durableRefinementSupportText(context, evidenceItems, binding);
    const support = field === 'speech' && rawSupport ? affirmativeOwnClaimText(rawSupport, binding) : rawSupport;
    // Only a caller with no narration at all (structured import/API) skips grounding. Narration
    // that contains nothing about this NPC, and no evidence attributed to it, supports nothing.
    const narrationSupplied = Boolean(String(context || '').trim());
    if (!oldText) {
        if (!support) return !narrationSupplied;
        const clauses = splitDurableClaimUnits(newText);
        const supportTokens = new Set(durableRefinementTokens(support));
        return clauses.length > 0 && clauses.every(clause => {
            const tokens = [...new Set(durableRefinementTokens(clause))]
                .filter(token => token.length >= 3 && !/^\d+$/.test(token));
            if (!tokens.length) return false;
            const supported = tokens.filter(token => supportTokens.has(token)).length;
            const required = tokens.length <= 2 ? 1 : Math.max(2, Math.ceil(tokens.length * 0.55));
            return supported >= required;
        });
    }
    if (normalizeName(oldText) === normalizeName(newText)) return true;
    if (field === 'personality' && identityMoralityConflict(oldText, newText)) return false;

    // Structured import/API compatibility: callers without source narration retain the
    // established direct-refinement behavior. Runtime scanner paths always supply context.
    if (!support) return !narrationSupplied;

    const oldTokens = new Set(durableRefinementTokens(oldText));
    const supportTokens = new Set(durableRefinementTokens(support));

    // Identify novel clauses that introduce meaning absent from the accepted current summary.
    const oldClauses = splitDurableClaimUnits(oldText);
    const newClauses = splitDurableClaimUnits(newText);
    const novelClauses = newClauses.filter(clause => !oldClauses.some(oldClause =>
        normalizeName(oldClause) === normalizeName(clause)
        || durableSemanticSimilarity(oldClause, clause) >= 0.72));

    if (!novelClauses.length) {
        return durableSemanticSimilarity(oldText, newText) >= 0.72;
    }

    // Every substantive newly introduced clause must be independently grounded in support.
    // A supported clause cannot authorize unrelated additions.
    return novelClauses.every(clause => {
        const clauseTokens = [...new Set(durableRefinementTokens(clause))]
            .filter(token => !oldTokens.has(token) && token.length >= 3 && !/^\d+$/.test(token));
        if (!clauseTokens.length) return true;
        const clauseSupported = clauseTokens.filter(token => supportTokens.has(token)).length;
        const required = clauseTokens.length <= 2 ? 1 : Math.max(2, Math.ceil(clauseTokens.length * 0.55));
        return clauseSupported >= required;
    });
}

export function isSafeIdentityTextRefinement(existing, incoming, context = '', evidenceItems = [], binding = null) {
    return !containsEvolutionLanguage(incoming)
        && !identityMoralityConflict(existing, incoming)
        && isSafeUnmarkedDurableRefinement(existing, incoming)
        && durableRefinementCandidateGrounded('personality', existing, incoming, context, evidenceItems, binding);
}

export function isSafeSpeechRefinement(existing, incoming, context = '', evidenceItems = [], binding = null) {
    return !containsEvolutionLanguage(incoming)
        && isSafeUnmarkedDurableRefinement(existing, incoming)
        && durableRefinementCandidateGrounded('speech', existing, incoming, context, evidenceItems, binding);
}

const APPEARANCE_CORRECTION_CUE_RE = /\b(?:actually|in fact|contrary to|mistaken|misread|misjudged|was not|were not|is not|are not|wasn t|weren t|isn t|aren t|never was|never were|revealed?|uncovered?|exposed?|disguised|concealed|hidden|obscured|freed from|beneath|underneath)\b/i;

export function groundedAppearanceCorrection(existing, incoming, context = '', evidenceItems = [], binding = null) {
    const current = compactDurableText(existing, DURABLE_PROFILE_LIMITS.appearance, 10);
    const candidate = compactDurableText(incoming, DURABLE_PROFILE_LIMITS.appearance, 10);
    if (!current || !candidate || normalizeName(current) === normalizeName(candidate)) return false;
    const support = durableRefinementSupportText(context, evidenceItems, binding);
    if (!support || !APPEARANCE_CORRECTION_CUE_RE.test(normalizeName(support))) return false;
    return durableRefinementCandidateGrounded('appearance', current, candidate, context, evidenceItems, binding);
}

// The npcs row carries no evidence quotes, and NPC-scoped story text keeps only sentences that name
// the NPC, so an outfit change narrated in the next sentence ("A moment later she returns in a
// sundress") had no support in routine scans. Supply that story text itself: up to two sentences
// that directly follow a sentence naming only this NPC, stopping at any sentence naming another NPC.
export function presentationContinuationEvidence(context = '', npc = null, otherLabels = []) {
    const source = String(context || '').trim();
    const targetLabels = developmentBindingLabels({ npc });
    if (!source || !targetLabels.length) return [];
    const others = (Array.isArray(otherLabels) ? otherLabels : []).map(normalizeName).filter(Boolean)
        .filter(label => !targetLabels.includes(label));
    const evidence = [];
    let remaining = 0;
    for (const segment of developmentContextSegments(source)) {
        const targetHere = episodeContainsLabel(segment, targetLabels);
        const otherHere = others.length > 0 && episodeContainsLabel(segment, others);
        if (targetHere) {
            remaining = otherHere ? 0 : 2;
            continue;
        }
        if (otherHere) {
            remaining = 0;
            continue;
        }
        if (remaining > 0) {
            evidence.push(segment);
            remaining -= 1;
        }
    }
    return evidence;
}

// Story text the appearance model may ground one NPC's update in: sentences naming the NPC, its
// pronoun follow-up and the presentation continuation above. Narration that says nothing about the
// NPC yields a placeholder that grounds nothing, so another NPC's scene cannot support the update.
const NO_NPC_NARRATION = '[no narration about this NPC]';
export function npcScopedNarration(context = '', npc = null, otherLabels = []) {
    const raw = String(context || '').trim();
    if (!raw) return '';
    const scoped = [
        scopedEpisodeText(raw, { npc, otherLabels }),
        ...presentationContinuationEvidence(raw, npc, otherLabels),
    ].filter(Boolean).join(' ');
    return scoped || NO_NPC_NARRATION;
}

export function groundedAppearanceChange(existing, incoming, reason, context = '', evidenceItems = [], binding = null) {
    const why = cleanText(reason, 500);
    const support = durableRefinementSupportText(context, evidenceItems, binding);
    if (!why || !support || !durableSeedGrounded(why, support)) return false;
    // A declared current-presentation change replaces obsolete presentation rather than
    // refining it clause-by-clause. The replacement itself must still be source-grounded.
    return durableSeedGrounded(incoming, support);
}

export function isSafeUnmarkedDurableRefinement(existing, incoming) {
    const oldText = compactDurableText(existing, DURABLE_PROFILE_LIMITS.appearance, 10);
    const newText = compactDurableText(incoming, DURABLE_PROFILE_LIMITS.appearance, 10);
    if (!oldText || !newText || normalizeName(oldText) === normalizeName(newText)) return false;
    const oldTokens = new Set(durableRefinementTokens(oldText));
    const newTokens = new Set(durableRefinementTokens(newText));
    const addsGroundedDetail = [...newTokens].some(token => !oldTokens.has(token));
    return addsGroundedDetail && (durableTokenCoverage(oldText, newText) >= 0.62 || durableSemanticSimilarity(oldText, newText) >= 0.58);
}

export function isSafeUnmarkedDurableReplacement(existing, incoming) {
    if (containsEvolutionLanguage(incoming) || !isSafeUnmarkedDurableRefinement(existing, incoming)) return false;
    const oldText = compactDurableText(existing, DURABLE_PROFILE_LIMITS.appearance, 10);
    const newText = compactDurableText(incoming, DURABLE_PROFILE_LIMITS.appearance, 10);
    // Missing/keep state has no omission-as-deletion authority. It may adopt an enrichment
    // only when every established durable concept remains represented in the incoming summary.
    // Explicit evolution language such as "no longer" is rejected above so lexical retention
    // inside a negation cannot masquerade as preservation of the established meaning.
    return durableTokenCoverage(oldText, newText) >= 1;
}

export function isSafeUnmarkedDurableFieldReplacement(field, existing, incoming) {
    if (!isSafeUnmarkedDurableReplacement(existing, incoming)) return false;
    if (field === 'personality') return isSafeIdentityTextRefinement(existing, incoming);
    if (field === 'speech') return isSafeSpeechRefinement(existing, incoming);
    return isSafeUnmarkedDurableRefinement(existing, incoming);
}

export function mergeDurableTextRefinement(existing, incoming, maxChars) {
    const clauseCap = maxChars <= DURABLE_PROFILE_LIMITS.speech ? 5
        : (maxChars <= DURABLE_PROFILE_LIMITS.personality ? 6 : 10);
    const oldText = compactDurableText(existing, maxChars, clauseCap);
    const newText = compactDurableText(incoming, maxChars, clauseCap);
    if (!oldText) return newText;
    if (!newText || normalizeName(oldText) === normalizeName(newText)) return oldText;

    // `refine` is a full CURRENT summary contract. Safety/admission is decided by the caller;
    // once accepted, omitted old clauses are intentionally retired instead of appended back.
    // Historical evidence belongs in profileEvidence, not inside the current dossier field.
    return newText;
}

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

function episodeContainsLabel(segment, labels = []) {
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
