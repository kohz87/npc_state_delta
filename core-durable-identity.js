/* NPC State Delta durable-profile identity and evolution checks: morality polarity and
   evolution-language detection split unchanged from core-durable.js. Public names are re-exported
   by core-durable.js. */
import { normalizeName } from './core-text.js';

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
