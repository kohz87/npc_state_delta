/* Appearance physical-feature rules: trait keys, enduring-trait carry, shared-piece deduplication and
   refinement similarity. A pure part of appearance.js (same owner, moved without change); appearance.js
   keeps the public facade and re-exports every public name. Never imports appearance.js. */
import { DURABLE_PROFILE_LIMITS, normalizeName } from './core-mechanics.js';
import { appearanceClauses, appearanceText, clean, sameAppearance } from './appearance-text.js';

export const STOPWORDS = new Set([
    'and', 'the', 'with', 'that', 'this', 'their', 'they', 'them', 'when', 'while', 'from', 'into', 'over', 'under',
    'very', 'more', 'less', 'than', 'then', 'but', 'for', 'her', 'his', 'its', 'she', 'him', 'who', 'has', 'have', 'had',
    'uses', 'use', 'often', 'usually', 'still', 'also', 'only', 'toward', 'towards', 'around', 'becomes', 'become', 'being',
    'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'by', 'or', 'it', 'he',
]);
export const ALIASES = Object.freeze({
    telepathy: 'telepath', telepathic: 'telepath', telepathically: 'telepath',
    connection: 'link', connections: 'link', connected: 'link', channel: 'link', channels: 'link', linked: 'link',
    thoughts: 'mind', thought: 'mind', minds: 'mind', mental: 'mind',
    siblings: 'sibling', sisters: 'sister', brothers: 'brother',
    courteous: 'courtesy', courteously: 'courtesy', politeness: 'polite', politely: 'polite',
    kindness: 'kind', kindhearted: 'kind', compassionate: 'compassion', compassion: 'compassion',
    reserved: 'reserve', restraint: 'restrain', restrained: 'restrain',
    gentleness: 'gentle', gently: 'gentle', motherly: 'maternal',
    speaks: 'speak', speaking: 'speak', spoken: 'speak', says: 'say', saying: 'say',
    gestures: 'gesture', gesturing: 'gesture', movements: 'movement',
    bonded: 'bond', bonding: 'bond', bonds: 'bond',
});
export function conceptToken(token) {
    let word = String(token || '').toLowerCase();
    if (!word) return '';
    if (ALIASES[word]) return ALIASES[word];
    if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
    else if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('s')) word = word.slice(0, -1);
    return ALIASES[word] || word;
}
export function refinementTokens(value) {
    return normalizeName(value).split(/\s+/)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !STOPWORDS.has(token))
        .map(conceptToken)
        .filter(token => (token.length >= 2 || /^\d+$/.test(token)) && !STOPWORDS.has(token));
}
export function grounded(value, context = '') {
    const source = String(context || '').trim();
    if (!source) return true;
    const proposed = [...new Set(refinementTokens(value))].filter(token => token.length >= 3 && !/^\d+$/.test(token));
    if (!proposed.length) return false;
    const sourceTokens = new Set(refinementTokens(source));
    const overlap = proposed.filter(token => sourceTokens.has(token));
    return overlap.length >= (proposed.length <= 2 ? 1 : 2);
}
export function similarity(a, b) {
    const left = new Set(refinementTokens(a));
    const right = new Set(refinementTokens(b));
    if (!left.size || !right.size) return normalizeName(a) === normalizeName(b) ? 1 : 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    const containment = overlap / Math.min(left.size, right.size);
    const jaccard = overlap / (left.size + right.size - overlap);
    return Math.max(jaccard, containment * 0.86, overlap >= 3 && containment >= 0.4 ? 0.62 : 0);
}
export function safeRefinement(existing, incoming) {
    const oldTokens = new Set(refinementTokens(existing));
    const newTokens = new Set(refinementTokens(incoming));
    if (!oldTokens.size || !newTokens.size || normalizeName(existing) === normalizeName(incoming)) return false;
    const addsDetail = [...newTokens].some(token => !oldTokens.has(token));
    const coverage = [...oldTokens].filter(token => newTokens.has(token)).length / oldTokens.size;
    return addsDetail && (coverage >= 0.62 || similarity(existing, incoming) >= 0.58);
}
export function mergeRefinement(existing, incoming, maxChars) {
    const current = clean(existing, maxChars);
    const next = clean(incoming, maxChars);
    if (!current) return next;
    if (!next || sameAppearance(current, next)) return current;
    // The caller has already passed safeRefinement/grounding. `refine` is a full current
    // summary for this exact appearance slot, so omitted old clauses are retired here.
    return next;
}

// Enduring physical traits (hair, eyes, build, scars, anatomy) survive an accepted current-appearance
// update that simply omits them, e.g. an outfit change narrated without restating the body. A trait is
// replaced only when the incoming presentation itself describes that trait (outside a "hidden under"
// style mention). Clothing, gear and transient condition are never carried forward: they follow the
// existing full-current-presentation replacement rule.
export const PHYSICAL_TRAITS = Object.freeze([
    ['hair', /\b(?:hair|haired|braids?|braided|ponytails?|pigtails|bangs|mane)\b/i],
    ['eyes', /\b(?:eyes?|eyed|irises|iris|pupils)\b/i],
    ['skin', /\b(?:skin|skinned|complexion|freckles?|freckled)\b/i],
    ['build', /\b(?:build|frame|figure|physique|muscular|muscles?|slender|slim|lean|lithe|stocky|petite|curvy|lanky|burly|brawny|willowy|broad[- ]shouldered)\b/i],
    ['height', /\b(?:tall|height|towering|diminutive|statuesque)\b/i],
    ['face', /\b(?:face|facial|jaw|jawline|cheekbones|nose|lips|beard|bearded|mustache|moustache|stubble)\b/i],
    ['scar', /\b(?:scars?|scarred)\b/i],
    ['tattoo', /\b(?:tattoos?|tattooed)\b/i],
    ['birthmark', /\b(?:birthmarks?|moles?)\b/i],
    ['ears', /\bears?\b/i],
    ['horns', /\b(?:horns?|horned)\b/i],
    ['tail', /\btails?\b/i],
    ['wings', /\b(?:wings?|winged)\b/i],
    ['fur', /\b(?:fur|furred)\b/i],
    ['scales', /\b(?:scales|scaled)\b/i],
    ['fangs', /\bfangs?\b/i],
    ['claws', /\bclaws?\b/i],
    ['antlers', /\bantlers?\b/i],
    ['tusks', /\btusks?\b/i],
]);
export const CHANGEABLE_PRESENTATION = /\b(?:wear(?:s|ing)?|worn|dressed|clad|outfit|attire|cloth(?:es|ing)|dress|gown|robes?|cloak|cape|coat|jacket|shirt|blouse|tunic|vest|skirt|trousers|pants|leggings|stockings|boots?|shoes?|sandals|gloves?|gauntlets?|hat|hood(?:ed)?|helmet|mask|armou?r|uniform|apron|scarf|belt|sash|jewel(?:ry|lery)|necklace|pendant|rings?|bracelets?|earrings?|ribbons?|carr(?:y|ies|ying)|hold(?:s|ing)|wield(?:s|ing)|sword|staff|dagger|bag|satchel|pack|wet|damp|soaked|drenched|blood(?:ied|y|stained)|mud(?:dy)?|dirt(?:y)?|bruised?|bleeding|wounded|injured|bandaged|sweat(?:y|ing)|flushed|tear[- ]streaked|disheveled|dishevelled)\b/i;
export const CONCEALED_MENTION = /\b(?:hid(?:e|es|den|ing)|cover(?:s|ed|ing)?|conceal(?:s|ed|ing)?|beneath|under(?:neath)?|obscur(?:e|es|ed|ing)|tucked)\b/i;

export function presentationSegments(value) {
    return appearanceText(value)
        .split(/\s*;\s*|(?<=[.!?])\s+|\s*,\s*/)
        .map(part => clean(part.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, ''), 400))
        .filter(Boolean);
}
// Size words describe height only when nothing else in the piece is a trait ("short" alone, not
// "short silver hair").
export const SIZE_ONLY = /\b(?:short|small|tiny|little|huge|giant|massive|enormous|colossal|gigantic)\b/i;
export function physicalTraitKeys(segment) {
    const keys = PHYSICAL_TRAITS.filter(([, pattern]) => pattern.test(segment)).map(([key]) => key);
    return keys.length || !SIZE_ONLY.test(segment) ? keys : ['height'];
}
// A hair mention re-describes the hair only when it says what the hair is like (colour, length,
// texture); "tied up in a bun" or "falls over her eyes" is styling and keeps the stored hair.
export const HAIR_DESCRIPTOR = /\b(?:long|short|cropped|shaved|bald|buzzed|shoulder[- ]length|waist[- ]length|chin[- ]length|ankle[- ]length|trimmed|curly|curled|curls|wavy|straight|frizzy|thick|thin|fine|coarse|silver|silvery|white|black|brown|blonde?|golden|gold|red|auburn|ginger|copper|chestnut|grey|gray|greying|graying|pink|blue|green|purple|violet|teal|(?:dark|light)(?=[- ](?:brown|blonde?|red|grey|gray|auburn|haired|hair|silver|gold|golden|chestnut))|dark-haired|raven|ebony|platinum|ashen|honey|sandy|strawberry|dyed|streaked|highlighted|bleached|colou?red)\b/i;
export function addressedTraitKeys(piece) {
    const keys = physicalTraitKeys(piece);
    return keys.includes('hair') && !HAIR_DESCRIPTOR.test(piece) ? keys.filter(key => key !== 'hair') : keys;
}
// "A and B" splits when both halves describe a trait ("Tall and slender", "long silver hair and
// violet eyes"), so one trait can give way without taking the other with it.
export function traitParts(segment) {
    const parts = segment.split(/\s+and\s+/i).map(part => clean(part, 400)).filter(Boolean);
    return parts.length > 1 && parts.every(part => physicalTraitKeys(part).length) ? parts : [segment];
}
// A clause can mix an enduring trait with changeable detail ("long silver hair tied back with a
// ribbon", "her hair is wet"). Split only such mixed clauses at their connectors and keep the pieces
// that describe a trait without any changeable wording, so the trait itself survives and a passing
// changeable mention of it does not count as re-describing it.
export const MIXED_CLAUSE_SPLIT = /\s+(?:with|and|tied|wearing|in|under|beneath|adorned|decorated|covered|while)\s+/i;
export function physicalPieces(segment) {
    const pieces = CHANGEABLE_PRESENTATION.test(segment) ? segment.split(MIXED_CLAUSE_SPLIT) : [segment];
    return pieces.map(piece => clean(piece, 400))
        .filter(piece => piece && physicalTraitKeys(piece).length && !CHANGEABLE_PRESENTATION.test(piece));
}
// The leading phrase that says what the NPC is ("A silver dragon", "A wiry old man", "Spirit form")
// rather than what she wears: an article- or form-led piece that is not clothing, gear or condition.
// A look, gaze or pose ("A tired smile", "A weary look") is passing presentation, and a sentence
// about part of the body ("The scales are dusted with ash") describes that part, not what she is.
export const NOT_IDENTITY = /\b(?:smiles?|smiling|smirks?|grins?|grinning|frowns?|frowning|scowls?|glares?|glances?|gaze|stares?|looks?|expression|blush(?:es|ing)?|tears?|pose|posture|stance|demeanou?r|air|is|are|was|were|seems?|appears?)\b/i;
export function identityPhrase(value) {
    const first = presentationSegments(value)[0] || '';
    if (!first || CHANGEABLE_PRESENTATION.test(first) || CONCEALED_MENTION.test(first) || NOT_IDENTITY.test(first)) return '';
    return /^(?:an?|the)\s+\S/i.test(first) || /\bform\b/i.test(first) ? first : '';
}
// An update that says she has become something else ("Now a towering ogre", "She has become …",
// "turned into a wolf") describes a new identity even without an article-led opening.
export const BECOMES_IDENTITY = /(?:^\s*(?:(?:she|he|they|it)\s+(?:is\s+)?)?now\s+an?\s+\S|\b(?:has|have|had)\s+become\s+an?\s+\S|\b(?:becomes?|became|turn(?:s|ed)?\s+into|transform(?:s|ed)?\s+into|shift(?:s|ed)?\s+into)\s+an?\s+\S)/i;
export function describesIdentity(value) {
    return Boolean(identityPhrase(value)) || BECOMES_IDENTITY.test(appearanceText(value));
}

export function preserveOmittedPhysicalTraits(previous, next, { alsoPresent = '' } = {}) {
    const incoming = appearanceText(next);
    const prior = appearanceText(previous);
    if (!incoming || !prior || sameAppearance(prior, incoming)) return incoming;
    const incomingNormalized = normalizeName(incoming);
    const presentNormalized = normalizeName(alsoPresent);
    const addressed = new Set(presentationSegments(incoming)
        .filter(segment => !CONCEALED_MENTION.test(segment))
        .flatMap(physicalPieces)
        .flatMap(addressedTraitKeys));
    const kept = presentationSegments(prior).flatMap(physicalPieces).filter(piece => {
        if (physicalTraitKeys(piece).some(key => addressed.has(key))) return false;
        const normalized = normalizeName(piece);
        return normalized && !incomingNormalized.includes(normalized) && !(presentNormalized && presentNormalized.includes(normalized));
    });
    // What the NPC is survives an update that only changes outfit or condition ("Dusted with ash"),
    // unless the update opens with its own description of what she is.
    const identity = identityPhrase(prior);
    const identityKey = normalizeName(identity);
    if (identity && !describesIdentity(incoming) && !incomingNormalized.includes(identityKey)
        && !(presentNormalized && presentNormalized.includes(identityKey))
        && !kept.some(piece => normalizeName(piece) === identityKey)) {
        kept.unshift(identity);
    }
    const limit = DURABLE_PROFILE_LIMITS?.appearance || 800;
    // The incoming presentation is authoritative; if the budget is tight, drop carried traits whole
    // from the end (the identity phrase, first, goes last).
    while (kept.length && `${kept.join(', ')}; ${incoming}`.length > limit) kept.pop();
    return kept.length ? appearanceText(`${kept.join(', ')}; ${incoming}`) : incoming;
}

// A current presentation may restate some of the enduring physical features held in the shared
// slot ("Long silver hair, violet eyes; wearing a gown"). Drop only comma-level pieces that exactly
// match a shared piece, so the resolved appearance does not repeat them; anything that differs,
// including negated or re-described traits, is kept.
// A piece is also redundant when every content word in it already appears in the shared slot and it
// carries no changeable or negated wording ("faintly pointed" beside shared "faintly pointed,
// swept-back ears"). A piece that adds any detail, or negates or changes a trait, is kept.
export const NEGATED_DETAIL = /\b(?:no|not|never|without|none|nor|no longer|lacks?|lacking)\b/i;
export function coveredBySharedTokens(piece, sharedTokens) {
    if (!sharedTokens.size || NEGATED_DETAIL.test(piece) || CHANGEABLE_PRESENTATION.test(piece)) return false;
    const tokens = refinementTokens(piece).filter(token => !/^\d+$/.test(token));
    return tokens.length > 0 && tokens.every(token => sharedTokens.has(token));
}
export function withoutSharedPieces(value, shared) {
    const text = appearanceText(value);
    const sharedPieces = new Set(presentationSegments(shared).map(normalizeName).filter(Boolean));
    if (!text || !sharedPieces.size) return text;
    const sharedTokens = new Set(refinementTokens(shared));
    let changed = false;
    const clauses = appearanceClauses(text).map(clause => {
        const parts = clause.split(/\s*,\s*/);
        const kept = parts.filter(part => {
            const piece = part.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, '');
            return !sharedPieces.has(normalizeName(piece)) && !coveredBySharedTokens(piece, sharedTokens);
        });
        if (kept.length !== parts.length) changed = true;
        return kept.join(', ');
    }).filter(clause => clean(clause, 800));
    return changed ? appearanceText(clauses.join('; ')) : text;
}
