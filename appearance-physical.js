/* Appearance physical-feature rules: trait keys, enduring-trait carry, shared-piece deduplication and
   refinement similarity. A pure part of appearance.js (same owner, moved without change); appearance.js
   keeps the public facade and re-exports every public name. Never imports appearance.js. */
import { DURABLE_PROFILE_LIMITS } from './core-relationship.js';
import { normalizeName } from './core-text.js';
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

// (card traits win) A refine may add detail to a cast dossier's look, never swap a physical value the pack card names: the card's
// "Brown eyes" stays brown when the narrator writes "her pale eyes". Each trait has a few value axes; a word may stand on more than
// one pole (teal is blue and green). Two texts swap a trait when both name poles on one axis and share none of them. Tone words
// (pale, dark) count only against a hue they cannot be (pale brown, dark blonde) or the opposite tone. Only a grounded `change`
// (an injury, magic, dye, a disguise) may swap such a trait; a value for a trait the record does not name is a fill. Looks that
// are not the card's (story-given, or a fill guess) keep the refine rule: a later story line replaces a guess (owner, 9-10 Nov).
const HUES = Object.freeze({
    black: ['black', 'raven', 'ebony', 'jet', 'inky', 'sable', 'coal', 'onyx'],
    brown: ['brown', 'chestnut', 'umber', 'mahogany', 'chocolate', 'coffee', 'walnut', 'russet', 'tawny', 'brunette', 'bronze'],
    hazel: ['hazel'],
    gold: ['gold', 'golden', 'amber', 'honey', 'blonde', 'blond', 'flaxen', 'yellow', 'straw', 'sandy'],
    red: ['red', 'crimson', 'scarlet', 'ruby', 'auburn', 'copper', 'ginger', 'rust', 'vermilion', 'strawberry'],
    white: ['white', 'snowy', 'ivory', 'cream', 'platinum', 'silver', 'silvery', 'grey', 'gray', 'greying', 'graying', 'ashen', 'ash', 'steel', 'slate', 'pewter', 'iron', 'porcelain'],
    blue: ['blue', 'azure', 'sapphire', 'cerulean', 'cobalt', 'navy', 'icy', 'teal', 'turquoise', 'aquamarine', 'cyan'],
    green: ['green', 'emerald', 'jade', 'olive', 'moss', 'teal', 'turquoise', 'verdant'],
    violet: ['violet', 'purple', 'lilac', 'lavender', 'amethyst', 'indigo', 'plum', 'mauve'],
    pink: ['pink', 'rose', 'rosy', 'magenta'],
    orange: ['orange'],
});
const LIGHT_TONES = new Set(['pale', 'light', 'fair', 'bright']);
const DARK_TONES = new Set(['dark', 'deep']);
const LIGHT_TONE_CLASH = new Set(['black', 'brown']);
const DARK_TONE_CLASH = new Set(['white', 'gold']);
const AXES = Object.freeze({
    length: { long: ['long', 'waist', 'hip', 'ankle', 'floor', 'flowing'], shoulder: ['shoulder'], short: ['short', 'cropped', 'shaved', 'bald', 'buzzed', 'shorn', 'chin'] },
    texture: { curly: ['curly', 'curled', 'curls', 'wavy', 'frizzy', 'kinky', 'ringlets'], straight: ['straight', 'sleek'] },
    build: {
        slight: ['slender', 'slim', 'lean', 'lithe', 'lanky', 'willowy', 'wiry', 'skinny', 'thin', 'petite', 'slight', 'gaunt', 'bony'],
        heavy: ['stocky', 'curvy', 'burly', 'brawny', 'muscular', 'plump', 'heavyset', 'stout', 'full', 'broad', 'voluptuous', 'buxom', 'hulking', 'portly', 'rotund'],
    },
    height: { tall: ['tall', 'towering', 'statuesque'], short: ['short', 'diminutive', 'tiny', 'small', 'petite'] },
});
const TRAIT_AXES = Object.freeze({
    hair: ['color', 'length', 'texture'], eyes: ['color'], skin: ['color'], fur: ['color'], scales: ['color'], ears: ['color'],
    tail: ['color'], horns: ['color'], wings: ['color'], build: ['build'], height: ['height'],
});
const traitWords = text => String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
const polesOf = (words, poles) => new Set(Object.entries(poles).filter(([, list]) => list.some(word => words.includes(word))).map(([pole]) => pole));
const disjoint = (a, b) => a.size > 0 && b.size > 0 && ![...a].some(pole => b.has(pole));
// Tones only against the other side's hues (or the other tone); a tone beside a hue is a shade of it.
function toneClash(tones, hues) {
    return [...tones].some(tone => (LIGHT_TONES.has(tone) && [...hues].some(hue => LIGHT_TONE_CLASH.has(hue)))
        || (DARK_TONES.has(tone) && [...hues].some(hue => DARK_TONE_CLASH.has(hue))));
}
function colorSwapped(current, incoming) {
    const [nowHues, newHues] = [polesOf(current, HUES), polesOf(incoming, HUES)];
    if (nowHues.size && newHues.size) return disjoint(nowHues, newHues);
    const [nowTones, newTones] = [current, incoming].map(words => new Set(words.filter(word => LIGHT_TONES.has(word) || DARK_TONES.has(word))));
    if (nowHues.size) return toneClash(newTones, nowHues);
    if (newHues.size) return toneClash(nowTones, newHues);
    const light = tones => tones.size > 0 && [...tones].every(tone => LIGHT_TONES.has(tone));
    const dark = tones => tones.size > 0 && [...tones].every(tone => DARK_TONES.has(tone));
    return (light(nowTones) && dark(newTones)) || (dark(nowTones) && light(newTones));
}
// The trait pieces of a look: { text, keys } for every piece that describes an enduring trait (not clothing, not a hidden mention).
function traitPieces(value) {
    return presentationSegments(value)
        .filter(segment => !CONCEALED_MENTION.test(segment))
        .flatMap(physicalPieces)
        .flatMap(traitParts)
        .map(text => ({ text, keys: addressedTraitKeys(text).filter(key => TRAIT_AXES[key]) }))
        .filter(piece => piece.keys.length);
}
const valueWords = (pieces, key) => pieces.filter(piece => piece.keys.includes(key)).flatMap(piece => traitWords(piece.text));
function axisSwapped(axis, current, incoming) {
    return axis === 'color' ? colorSwapped(current, incoming) : disjoint(polesOf(current, AXES[axis]), polesOf(incoming, AXES[axis]));
}
// The words of an axis a text names, for the report ("pale", "brown").
function axisWords(axis, words) {
    const listed = axis === 'color' ? [...Object.values(HUES).flat(), ...LIGHT_TONES, ...DARK_TONES] : Object.values(AXES[axis]).flat();
    return [...new Set(words.filter(word => listed.includes(word)))];
}
/**
 * The physical traits `incoming` swaps against `current` (card traits win): [{ trait, said, kept }] in trait order, where `said`
 * is what the incoming text calls it and `kept` what the record holds ("eyes", "pale", "brown"); [] when nothing is swapped.
 */
export function physicalTraitSwaps(current, incoming) {
    const before = traitPieces(current);
    const after = traitPieces(incoming);
    if (!before.length || !after.length) return [];
    const swaps = [];
    for (const [trait, axes] of Object.entries(TRAIT_AXES)) {
        const now = valueWords(before, trait);
        const next = valueWords(after, trait);
        if (!now.length || !next.length) continue;
        const axis = axes.find(name => axisSwapped(name, now, next));
        if (!axis) continue;
        const said = axisWords(axis, next).filter(word => !now.includes(word));
        const kept = axisWords(axis, now).filter(word => !next.includes(word));
        swaps.push({ trait, said: said.join(' ') || axisWords(axis, next).join(' '), kept: kept.join(' ') || axisWords(axis, now).join(' ') });
    }
    return swaps;
}
/** True when `incoming` swaps a named physical value of `current`; with `traits` (a Set of trait keys), only one of those. */
export function physicalTraitSwapped(current, incoming, traits = null) {
    return physicalTraitSwaps(current, incoming).some(swap => !traits || traits.has(swap.trait));
}
/** The pack card's look of a cast dossier (castFrom.first.overallAppearance, the pack's words as first written); '' for anyone else. */
export function cardLook(npc) {
    const first = npc?.castFrom && typeof npc.castFrom === 'object' ? npc.castFrom.first : null;
    return first && typeof first === 'object' && typeof first.overallAppearance === 'string' ? first.overallAppearance : '';
}
/**
 * A refine without its swaps of the card's traits (`card`: cardLook): every incoming clause that swaps a trait the card names gives
 * way to the record's own clause(s) for that trait; the rest of the incoming text stays as written. → { text, swaps }; `text` is
 * `incoming` itself when nothing the card names is swapped (always without a card), and '' when the swap cannot be taken out
 * (the repaired text still swaps, or adds nothing to the record).
 */
export function withoutTraitSwaps(current, incoming, card = '') {
    const named = card ? new Set(traitPieces(card).flatMap(piece => piece.keys)) : null;
    const swaps = named?.size ? physicalTraitSwaps(current, incoming).filter(swap => named.has(swap.trait)) : [];
    if (!swaps.length) return { text: incoming, swaps };
    const text = appearanceText(incoming);
    const swapped = new Set(swaps.map(swap => swap.trait));
    const held = presentationSegments(current).filter(segment => traitPieces(segment).some(piece => piece.keys.some(key => swapped.has(key))));
    const used = new Set();
    const parts = text.split(/(\s*;\s*|(?<=[.!?])\s+|\s*,\s*)/);
    for (let index = 0; index < parts.length; index += 2) {
        const keys = traitPieces(parts[index]).flatMap(piece => piece.keys);
        if (!keys.some(key => swapped.has(key))) continue;
        const own = held.filter(segment => !used.has(segment)
            && traitPieces(segment).some(piece => piece.keys.some(key => swapped.has(key) && keys.includes(key))));
        own.forEach(segment => used.add(segment));
        const tail = parts[index].match(/[.!?]+$/)?.[0] || '';
        parts[index] = own.length ? `${own.join(', ')}${tail}` : '';
    }
    // Rejoin with each kept clause's own separator; a clause given way to without a held one is dropped with it.
    let joined = '';
    for (let index = 0; index < parts.length; index += 2) {
        if (parts[index].trim()) joined += (joined ? (parts[index - 1] ?? ' ') : '') + parts[index];
    }
    const repaired = appearanceText(joined);
    const usable = repaired && !physicalTraitSwapped(current, repaired, swapped) && !sameAppearance(current, repaired)
        && normalizeName(repaired) !== normalizeName(current);
    return { text: usable ? repaired : '', swaps };
}
