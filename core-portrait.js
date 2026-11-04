/* NPC State Delta portrait prompt building: visual anchor tags, appearance splitting, natural-language portrait prose,
   and buildNpcPortraitPrompts, with the portrait style limits and prompt-format normalizer it reads. A pure part of
   core-mechanics.js (same owner, moved without change); core-mechanics.js re-exports every name it exported before. Imports only
   core-text.js and core-identity.js. */
import { normalizeName, cleanText } from './core-text.js';
import { normalizeGender } from './core-identity.js';

export const DEFAULT_PORTRAIT_STYLE_POSITIVE = 'fantasy anime character illustration, refined clean linework, soft cel shading, detailed expressive eyes, elegant character design, cinematic soft lighting';
export const DEFAULT_PORTRAIT_STYLE_NEGATIVE = 'low quality, blurry, pixelated, bad anatomy, malformed hands, extra limbs, duplicate character, multiple heads, cropped face, obscured eyes, text, watermark, logo, photorealistic, 3d render';
export const DEFAULT_PORTRAIT_COMPOSITION = 'solo character portrait, upper body, centered composition, face clearly visible, portrait orientation';
export const PORTRAIT_STYLE_PROMPT_LIMIT = 12000;
export const PORTRAIT_COMPOSITION_PROMPT_LIMIT = 6000;
export const PORTRAIT_NPC_PROMPT_LIMIT = 12000;
export const PORTRAIT_PROMPT_FORMATS = Object.freeze(['hybrid', 'tags', 'natural']);
export function normalizePortraitPromptFormat(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    return PORTRAIT_PROMPT_FORMATS.includes(mode) ? mode : 'hybrid';
}

const PORTRAIT_CLOTHING_TERMS = /\b(?:dress|gown|tunic|shirt|blouse|vest|coat|cloak|jacket|robe|skirt|trousers|pants|shorts|boots?|shoes?|stockings?|gloves?|hat|hood|uniform|armou?r|badge|ribbons?|necklace|earrings?|belt|scarf|sweater|wool|leather|silk|linen|cotton|sleeves?|collar)\b/i;
const PORTRAIT_ANATOMY_TERMS = /\b(?:woman|man|girl|boy|person|face|skin|hair|eyes?|ears?|brows?|lashes?|nose|lips?|mouth|cheeks?|jaw|chin|build|figure|bust|chest|shoulders?|arms?|hands?|legs?|feet|horns?|wings?|tails?|feathers?|plumage|scales?|talons?|claws?|beak|fins?|gills?|antlers?)\b/i;
const PORTRAIT_NON_HAIR_TRAIT_TERMS = /\b(?:eyes?|skin|ears?|face|brows?|lashes?|dress|gown|tunic|shirt|blouse|vest|coat|cloak|jacket|robe|skirt|trousers|pants|boots?|shoes?|ribbons?|badge|horns?|wings?|tails?|feathers?|scales?)\b/i;
const PORTRAIT_HAIR_COLOR_TAGS = Object.freeze({
    black: 'black hair',
    brown: 'brown hair',
    red: 'red hair',
    blonde: 'blonde hair',
    gold: 'golden hair',
    white: 'white hair',
    silver: 'silver hair',
    gray: 'gray hair',
    blue: 'blue hair',
    purple: 'purple hair',
    pink: 'pink hair',
    green: 'green hair',
    orange: 'orange hair',
});
const PORTRAIT_HAIR_COLOR_RULES = Object.freeze([
    { key: 'red', pattern: /\b(?:red|ginger|auburn|crimson)\b/i, contradictions: ['white', 'silver', 'blonde', 'blue', 'purple'] },
    { key: 'black', pattern: /\bblack\b/i, contradictions: ['white', 'silver', 'blonde', 'red', 'blue'] },
    { key: 'brown', pattern: /\b(?:brown|brunette)\b/i, contradictions: ['white', 'silver', 'blonde', 'red', 'blue'] },
    { key: 'blonde', pattern: /\b(?:blond|blonde|yellow)\b/i, contradictions: ['black', 'brown', 'red', 'blue', 'purple'] },
    { key: 'gold', pattern: /\b(?:gold|golden)\b/i, contradictions: ['white', 'silver', 'gray', 'black', 'brown'] },
    { key: 'white', pattern: /\b(?:white|ivory|snow-white|platinum)\b/i, contradictions: ['blonde', 'gold', 'black', 'brown', 'red'] },
    { key: 'silver', pattern: /\b(?:silver|silvery|metallic-white)\b/i, contradictions: ['blonde', 'gold', 'brown', 'red', 'blue'] },
    { key: 'gray', pattern: /\b(?:gray|grey)\b/i, contradictions: ['blonde', 'gold', 'black', 'brown', 'red'] },
    { key: 'blue', pattern: /\b(?:blue|cobalt|azure|indigo)\b/i, contradictions: ['white', 'silver', 'blonde', 'red', 'purple'] },
    { key: 'purple', pattern: /\b(?:purple|violet)\b/i, contradictions: ['white', 'silver', 'blonde', 'blue', 'red'] },
    { key: 'pink', pattern: /\bpink\b/i, contradictions: ['white', 'silver', 'blonde', 'red', 'purple'] },
    { key: 'green', pattern: /\b(?:green|emerald)\b/i, contradictions: ['white', 'silver', 'blonde', 'blue', 'red'] },
    { key: 'orange', pattern: /\borange\b/i, contradictions: ['white', 'silver', 'blonde', 'red', 'purple'] },
]);
const PORTRAIT_NEGATED_FEATURE_RULES = Object.freeze([
    { tag: 'wings', pattern: /\bwings?\b/i },
    { tag: 'horns', pattern: /\bhorns?\b/i },
    { tag: 'tail', pattern: /\btails?\b/i },
    { tag: 'feathers', pattern: /\bfeathers?\b/i },
    { tag: 'plumage', pattern: /\bplumage\b/i },
    { tag: 'talons', pattern: /\btalons?\b/i },
    { tag: 'claws', pattern: /\bclaws?\b/i },
    { tag: 'animal ears', pattern: /\b(?:animal|beast|avian|feathered)\s+ears?\b/i },
]);


const PORTRAIT_HAIR_COLOR_SURFACE_RULES = Object.freeze([
    { pattern: /\bauburn\b/i, tag: 'auburn hair' },
    { pattern: /\bginger\b/i, tag: 'ginger hair' },
    { pattern: /\bcrimson\b/i, tag: 'crimson hair' },
    { pattern: /\bred\b/i, tag: 'red hair' },
    { pattern: /\bblack\b/i, tag: 'black hair' },
    { pattern: /\bbrunette\b/i, tag: 'brown hair' },
    { pattern: /\bbrown\b/i, tag: 'brown hair' },
    { pattern: /\bblonde?\b/i, tag: 'blonde hair' },
    { pattern: /\bplatinum\b/i, tag: 'platinum hair' },
    { pattern: /\bivory\b/i, tag: 'ivory hair' },
    { pattern: /\bwhite\b/i, tag: 'white hair' },
    { pattern: /\bsilvery\b/i, tag: 'silver hair' },
    { pattern: /\bsilver\b/i, tag: 'silver hair' },
    { pattern: /\bgrey\b/i, tag: 'gray hair' },
    { pattern: /\bgray\b/i, tag: 'gray hair' },
    { pattern: /\bgolden\b/i, tag: 'golden hair' },
    { pattern: /\bgold\b/i, tag: 'golden hair' },
    { pattern: /\bcobalt\b/i, tag: 'cobalt-blue hair' },
    { pattern: /\bazure\b/i, tag: 'azure-blue hair' },
    { pattern: /\bindigo\b/i, tag: 'indigo-blue hair' },
    { pattern: /\bblue\b/i, tag: 'blue hair' },
    { pattern: /\bviolet\b/i, tag: 'violet hair' },
    { pattern: /\bpurple\b/i, tag: 'purple hair' },
    { pattern: /\bpink\b/i, tag: 'pink hair' },
    { pattern: /\bemerald\b/i, tag: 'emerald-green hair' },
    { pattern: /\bgreen\b/i, tag: 'green hair' },
    { pattern: /\borange\b/i, tag: 'orange hair' },
]);
const PORTRAIT_HAIR_FORM_RULES = Object.freeze([
    { pattern: /\b(?:curl|curls|curly)\b/i, tag: 'curly hair' },
    { pattern: /\bwavy\b/i, tag: 'wavy hair' },
    { pattern: /\bstraight\b/i, tag: 'straight hair' },
    { pattern: /\b(?:braid|braids|braided)\b/i, tag: 'braided hair' },
    { pattern: /\b(?:tangled|messy|disheveled)\b/i, tag: 'tangled hair' },
    { pattern: /\b(?:coming\s+loose|loose)\b/i, tag: 'loose hair' },
    { pattern: /\bshoulder[- ]length\b/i, tag: 'shoulder-length hair' },
    { pattern: /\bwaist[- ]length\b/i, tag: 'waist-length hair' },
    { pattern: /\bthigh[- ]length\b/i, tag: 'thigh-length hair' },
    { pattern: /\bhip[- ]length\b/i, tag: 'hip-length hair' },
    { pattern: /\blong\b/i, tag: 'long hair' },
    { pattern: /\bshort\b/i, tag: 'short hair' },
]);
const PORTRAIT_EYE_COLOR_PATTERN = /\b((?:(?:pale|light|dark|deep|bright|icy|soft|warm|vivid)\s+)?(?:hazel|amber|brown|blue|green|gray|grey|silver|silvery|gold|golden|violet|purple|red|black))\s+eyes?\b/i;
const PORTRAIT_DIRECT_VISUAL_ANCHORS = Object.freeze([
    { pattern: /\bpointed ears?\b/i, tag: 'pointed ears' },
    { pattern: /\bordinary human ears?\b/i, tag: 'ordinary human ears' },
    { pattern: /\bhair ribbons?\b/i, tag: 'hair ribbons' },
    { pattern: /\b(?:ample|full|large)\s+bust\b/i, sourceTag: true },
    { pattern: /\b(?:slim|slender|athletic|muscular|stocky|curvy)\s+(?:figure|build)\b/i, sourceTag: true },
]);

function sourcePhrase(match) {
    return String(match?.[0] || '').replace(/\s+/g, ' ').trim();
}

function compoundHairColorTag(context) {
    const words = '(?:auburn|ginger|crimson|red|black|brunette|brown|blond|blonde|platinum|ivory|white|silver|silvery|gray|grey|gold|golden|cobalt|azure|indigo|blue|violet|purple|pink|emerald|green|orange)';
    const pattern = new RegExp('\\b(' + words + '(?:\\s*(?:-|and|\\/)\\s*' + words + ')+)\\s+(?:hair|curls?|locks?|braids?|tresses?)\\b', 'i');
    const match = String(context || '').match(pattern);
    if (!match) return '';
    return match[1].replace(/\s*(?:-|and|\/)\s*/gi, '-').toLowerCase() + ' hair';
}

function extractPortraitVisualAnchorTags(value) {
    const source = cleanText(value, 1800);
    if (!source) return [];
    const tags = [];
    const segments = source.split(/[;\n]+|\.(?:\s+|$)|,/).map(item => item.trim()).filter(Boolean);

    for (const segment of segments) {
        if (/\b(?:hair|curls?|locks?|braids?|tresses?)\b/i.test(segment)) {
            const compound = compoundHairColorTag(segment);
            if (compound) tags.push(compound);
            else {
                for (const rule of PORTRAIT_HAIR_COLOR_SURFACE_RULES) {
                    if (rule.pattern.test(segment)) tags.push(rule.tag);
                }
            }
            for (const rule of PORTRAIT_HAIR_FORM_RULES) {
                if (rule.pattern.test(segment)) tags.push(rule.tag);
            }
        }

        const eye = segment.match(PORTRAIT_EYE_COLOR_PATTERN);
        if (eye) tags.push(eye[1].replace(/\s+/g, ' ').trim().toLowerCase() + ' eyes');

        for (const rule of PORTRAIT_DIRECT_VISUAL_ANCHORS) {
            const match = segment.match(rule.pattern);
            if (match) tags.push(rule.sourceTag ? sourcePhrase(match).toLowerCase() : rule.tag);
        }
    }

    return uniquePortraitParts(tags);
}


function portraitTagFallbackParts(values = []) {
    const fallback = [];
    for (const value of values) {
        const segments = String(value || '')
            .split(/,/)
            .map(item => item.replace(/^\s*(?:and|with)\s+/i, '').trim())
            .filter(Boolean);
        for (const segment of segments) {
            if (extractPortraitVisualAnchorTags(segment).length) continue;
            fallback.push(segment);
        }
    }
    return uniquePortraitParts(fallback);
}

function portraitPartKey(value) {
    return normalizeName(value).replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniquePortraitParts(values = []) {
    const seen = new Set();
    const result = [];
    for (const raw of values) {
        const value = String(raw ?? '').replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();
        if (!value) continue;
        const key = portraitPartKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(value);
    }
    return result;
}

function normalizePortraitAppearanceClause(value, clothing = false, keepArticle = false) {
    let text = cleanText(value, 1800)
        .replace(/^(?:appearance|current appearance)\s*:\s*/i, '')
        .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
        .trim();
    if (clothing) {
        text = text
            .replace(/^(?:wears?|wearing|dressed in|clad in)\s+/i, '')
            .replace(/^(?:outfit|clothing)\s*:\s*/i, '')
            .trim();
        if (!keepArticle) text = text.replace(/^(?:a|an|the)\s+/i, '').trim();
    }
    return text;
}

function splitPortraitAppearance(value, keepArticle = false) {
    const source = cleanText(value, 1800).replace(/\r/g, '');
    if (!source) return { core: [], clothing: [] };
    const core = [];
    const clothing = [];
    const clauses = source.split(/[;\n]+|\.(?:\s+|$)/).map(item => item.trim()).filter(Boolean);
    for (const clause of clauses) {
        const clothingLead = /^(?:wears?|wearing|dressed in|clad in|outfit\s*:|clothing\s*:)/i.test(clause);
        const hasClothing = PORTRAIT_CLOTHING_TERMS.test(clause);
        const hasAnatomy = PORTRAIT_ANATOMY_TERMS.test(clause);
        const clothingOnly = clothingLead || (hasClothing && !hasAnatomy);
        const normalized = normalizePortraitAppearanceClause(clause, clothingOnly, keepArticle);
        if (!normalized) continue;
        (clothingOnly ? clothing : core).push(normalized);
    }
    return {
        core: uniquePortraitParts(core),
        clothing: uniquePortraitParts(clothing),
    };
}

function addHairColorsFromContext(context, found) {
    for (const rule of PORTRAIT_HAIR_COLOR_RULES) {
        const matcher = new RegExp(rule.pattern.source, 'ig');
        let match = null;
        while ((match = matcher.exec(context))) {
            const between = context.slice(match.index + match[0].length);
            if (!PORTRAIT_NON_HAIR_TRAIT_TERMS.test(between)) found.add(rule.key);
            if (!match[0].length) matcher.lastIndex += 1;
        }
    }
}

function explicitHairColorKeys(value) {
    const source = String(value || '');
    const found = new Set();
    const hair = /\bhairs?\b/gi;
    let match = null;
    while ((match = hair.exec(source))) {
        const before = source.slice(0, match.index);
        const boundary = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('.'), before.lastIndexOf('\n'));
        addHairColorsFromContext(before.slice(boundary + 1).slice(-120), found);

        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 96);
        const connector = after.match(/^\s*(?:(?:is|was|looks?|appears?|colored|coloured|color(?:ed)?|colour(?:ed)?)\s*[:=-]?\s*|[:=-]\s*)([^,;.\n]{1,48})/i);
        if (connector) addHairColorsFromContext(connector[1], found);
        if (!match[0].length) hair.lastIndex += 1;
    }
    return found;
}

function explicitNegatedFeatureTags(value) {
    const source = String(value || '');
    const tags = [];
    for (const rule of PORTRAIT_NEGATED_FEATURE_RULES) {
        const afterNo = new RegExp('\\b(?:no|without|lacks?|lacking)\\b[^,;.\\n]{0,48}' + rule.pattern.source, 'i');
        const notVisible = new RegExp(rule.pattern.source + '[^,;.\\n]{0,32}\\b(?:(?:is|are)\\s+)?(?:not visible|absent|not present)\\b', 'i');
        if (afterNo.test(source) || notVisible.test(source)) tags.push(rule.tag);
    }
    return tags;
}

function derivePortraitContradictionNegatives(appearance, extraPositive, replaceAutomatic = false) {
    if (replaceAutomatic) return [];
    const subjectText = [appearance, extraPositive].filter(Boolean).join('; ');
    const explicitColors = explicitHairColorKeys(subjectText);
    const colorNegatives = [];
    const seenColorKeys = new Set();
    for (const key of explicitColors) {
        const rule = PORTRAIT_HAIR_COLOR_RULES.find(item => item.key === key);
        for (const contradiction of rule?.contradictions || []) {
            if (explicitColors.has(contradiction) || seenColorKeys.has(contradiction)) continue;
            const tag = PORTRAIT_HAIR_COLOR_TAGS[contradiction];
            if (!tag) continue;
            seenColorKeys.add(contradiction);
            colorNegatives.push(tag);
            if (colorNegatives.length >= 8) break;
        }
        if (colorNegatives.length >= 8) break;
    }
    return uniquePortraitParts([
        ...colorNegatives,
        ...explicitNegatedFeatureTags(subjectText),
    ]);
}

function portraitProseLower(value) {
    const text = String(value ?? '').trim();
    const word = text.match(/^[A-Z][a-z'-]*(?=\s|$|[,;.])/);
    return word && !/[A-Z]/.test(text.slice(1, word[0].length)) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function portraitProseUpper(value) {
    const text = String(value ?? '').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function portraitProseClean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:.\s]+$/g, '').trim();
}

function portraitProseArticle(phrase) {
    const text = String(phrase || '').trim();
    if (/^(?:a|an|the|his|her|their|its|one|some)(?=\s|$)/i.test(text)) return text;
    // By sound, not by letter: "a unicorn-kin", "a utopian", "an uninvited", "an 18-year-old", "an hour-old".
    const yoo = /^(?:uni(?!n|d)|use|usu|uti(?!l)|uto|ute|uro|ura|eu|one|once|ubiq|ufo|uk)/i.test(text) || /^unanim|^unilat|^unif/i.test(text);
    const vowelSound = /^(?:8\d?|11|18)(?!\d)/.test(text)
        || (/^[aeiou]/i.test(text) && !yoo)
        || /^(?:hour|honest|honou?r|heir)/i.test(text);
    return (vowelSound ? 'an ' : 'a ') + text;
}

// A clause that is only an adjective ("burly", "tall") describes the subject itself: "a burly man", never "with burly".
// Lower case only: a capitalised word ("Red") is a name or a colour, not read as an adjective.
const PORTRAIT_ADJECTIVE = /^(?:tall|short|slim|slender|thin|lean|stout|stocky|burly|brawny|muscular|pale|dark|fair|tan|young|old|elderly|ancient|small|large|big|huge|tiny|petite|plump|fat|heavy|lithe|lanky|wiry|gaunt|frail|sturdy|rugged|handsome|beautiful|pretty|plain|striking|androgynous|scrawny|willowy|curvy|chubby|bald|blind|weathered|broad-shouldered)$/i;
const PORTRAIT_ADJECTIVE_SUFFIX = /^[a-z]{3,}(?:ed|ful|ous|ish|ive|ly)$/;
function portraitProseIsAdjective(item, original = item) {
    const text = String(item || '').trim();
    if (!/^[A-Za-z][A-Za-z-]*$/.test(text)) return false;
    // The suffix guess is for lower-case words only: "Red" is a name or a colour.
    return PORTRAIT_ADJECTIVE.test(text) || (/^[a-z]/.test(String(original || '').trim()) && PORTRAIT_ADJECTIVE_SUFFIX.test(text));
}

// A people named first and then a trade or kind ("elf ranger") is still that people; plurals ("elves") read as the singular.
const PORTRAIT_HUMANOID_FIRST = /^(?:humans?|elf|elves|elven|dwarf|dwarves|dwarven|orcs?|goblins?|halflings?|gnomes?|tieflings?|ogres?|trolls?|centaurs?)$/i;
// The head noun is judged as a whole word. A hyphenated word is judged by its own pattern (half-elf, fox-beastfolk,
// bat-kin) or by its last part (wood-elf is an elf, elf-hound is a hound); the first part never decides.
const PORTRAIT_HUMANOID_WORD = /^(?:humans?|humanoids?|persons?|people|mortals?|elf|elves|elven|dwarf|dwarves|dwarven|orcs?|goblins?|halflings?|gnomes?|tieflings?|demons?|angels?|vampires?|fae|fey|nymphs?|giants?|ogres?|trolls?|centaurs?|beast-?men|beast-?man|beast-?wom[ae]n|\w*folk|kin|\w+born)$/i;
const PORTRAIT_HUMANOID_COMPOUND = /^(?:half-\w+|\w+-kin|(?:\w+-)*beast-?(?:men|man|wom[ae]n)|(?:\w+-)*\w*folk)$/i;
// "elf ranger", "orc warchief", "troll-wife": a people named first is still that people, unless what follows is a thing or an
// animal ("troll bridge", "elf-hound").
const PORTRAIT_NON_PERSON_TAIL = /^(?:bridges?|hounds?|dogs?|wolf|wolves|spiders?|horses?|steeds?|mounts?|birds?|cats?|beasts?|golems?|constructs?|statues?|trees?|camps?|markets?|towers?|ships?|boats?|castles?|caves?|forests?|mountains?|rivers?|swamps?|hills?|villages?|cities|city|fortress|gate|gates|axes?|swords?|hammers?|shields?|banners?|drums?|fires?|stones?|rocks?|snakes?|serpents?|rats?|bears?|boars?|hawks?|eagles?|owls?|ravens?|crows?|bats?|hogs?|pigs?|lizards?|drakes?|dragons?|wyrms?|worms?|insects?|beetles?|ants?|bugs?|flies|fly|robots?|machines?|puppets?|dolls?|scarecrows?|totems?|idols?)$/i;
function portraitSpeciesIsHumanoid(words) {
    if (!words.length) return true;
    const last = words[words.length - 1];
    if (PORTRAIT_HUMANOID_COMPOUND.test(last) || PORTRAIT_HUMANOID_WORD.test(last)) return true;
    if (last.includes('-') && PORTRAIT_HUMANOID_WORD.test(last.split('-').pop())) return true;
    // A hyphenated word led by a people word is that people unless its last part is a thing or an animal (troll-wife, not elf-hound).
    if (last.includes('-') && PORTRAIT_HUMANOID_FIRST.test(last.split('-')[0]) && !PORTRAIT_NON_PERSON_TAIL.test(last.split('-').pop())) return true;
    return words.length > 1 && PORTRAIT_HUMANOID_FIRST.test(words[0]) && !PORTRAIT_NON_PERSON_TAIL.test(last);
}

function portraitProseList(items) {
    const list = items.filter(Boolean);
    if (list.length <= 1) return list.join('');
    const inner = list.some(item => item.includes(','));
    return list.slice(0, -1).join(inner ? '; ' : ', ') + (inner ? ', and ' : ' and ') + list[list.length - 1];
}

function buildNaturalPortraitProse({ name, gender, rawGender, species, visualAge, role, appearance, mood, location, composition, extraPositive, stylePositive }) {
    const noun = gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person';
    const subject = gender === 'male' ? 'He' : gender === 'female' ? 'She' : (name || 'The person');
    const possessive = gender === 'male' ? 'His' : gender === 'female' ? 'Her' : (name || 'The person') + "'s";
    const objectPronoun = gender === 'male' ? 'him' : gender === 'female' ? 'her' : (name || 'the person');
    const approximate = /^~/.test(portraitProseClean(visualAge));
    const ageText = portraitProseClean(visualAge).replace(/^~\s*/, '');
    const numericAge = /^\d+(?:\s*[-–]\s*\d+)?$/.test(ageText);
    // No parenthetical ("Elf (wood)" reads "elf"); a plural people reads as the singular ("high elves" is "a high elf man").
    const singular = (word, to) => (/^[A-Z]/.test(word) ? to.charAt(0).toUpperCase() + to.slice(1) : to);
    const speciesText = portraitProseClean(String(species ?? '').replace(/\([^)]*\)/g, ' '))
        .replace(/\belves\b/gi, word => singular(word, 'elf'))
        .replace(/\bdwarves\b/gi, word => singular(word, 'dwarf'))
        .replace(/\b(orc|goblin|halfling|gnome|tiefling|ogre|troll|centaur|human)s\b/gi, '$1');
    // A boy or a girl stays one: the gender word said so, or the age is under 18 with a male or female gender.
    const teen = /^(?:teens?|teenage|teenaged|teenager|adolescent)$/i.test(ageText);
    const youngest = numericAge ? Math.min(...ageText.match(/\d+/g).map(Number)) : Infinity;
    const young = gender && (/^(?:boy|girl)$/.test(normalizeName(rawGender)) || youngest < 18 || teen);
    const nounWord = young ? (gender === 'male' ? 'boy' : 'girl') : noun;
    const speciesHasNoun = new RegExp('\\b(?:' + nounWord + '|male|female|man|woman|boy|girl|person)\\b|(?:boy|girl)\\b|beast-?(?:wo)?man\\b', 'i').test(speciesText);
    // "His hair is white" reads "white hair".
    const possessiveIs = item => item.replace(/^(?:his|her|their|its)\s+([a-z][a-z' -]{1,30}?)\s+(?:is|are)\s+(.+)$/i, (whole, thing, value) => `${value} ${thing}`);
    // "Tall, with silver hair" is two clauses: the adjective goes on the subject, the rest follows "with".
    const rawCore = appearance.core.flatMap(item => item.split(/,\s*(?=(?:with|has|have|having)\s)/i)).map(possessiveIs).map(item => item.replace(/^(?:(?:he|she|they)\s+(?:has|have|is|are)|has|have|having|with)\s+/i, ''));
    const stripped = rawCore.map(item => portraitProseLower(item));
    const speciesWords = new Set(normalizeName(speciesText).split(' '));
    const adjectiveAt = stripped.map((item, at) => portraitProseIsAdjective(item, rawCore[at]) && !speciesWords.has(normalizeName(item)));
    const adjectives = stripped.filter((item, at) => adjectiveAt[at]);
    const core = stripped.filter((item, at) => !adjectiveAt[at]);
    // man / woman / boy / girl / person only for a human, a humanoid people or no species: a wolf, a dragon or a robot is not
    // given a human form ("a male wolf", "a robot").
    // Only the head noun (the last word) decides: "giant spider" and "demon wolf" are animals, "half-elf" a people.
    const speciesWordsList = speciesText.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
    const humanoid = !speciesText || portraitSpeciesIsHumanoid(speciesWordsList);
    const formNoun = humanoid ? (speciesHasNoun ? '' : nounWord) : '';
    const animalSex = !humanoid && gender && !speciesHasNoun ? gender : '';
    const head = [numericAge ? (approximate ? 'roughly ' : '') + ageText.replace(/\s+/g, '') + '-year-old' : (teen ? 'teenage' : ''), ...adjectives, animalSex, speciesText, formNoun].filter(Boolean).join(' ');
    const clothing = appearance.clothing.map(item => portraitProseLower(item));
    const coreKeys = new Set(core.map(portraitPartKey));
    const clothes = clothing.filter(item => !coreKeys.has(portraitPartKey(item)));

    const sentences = [];
    let first = 'A portrait of ' + portraitProseArticle(head);
    if (ageText && !numericAge && !teen) first += ', of apparent age ' + ageText;
    if (core.length) first += ' with ' + portraitProseList(core);
    sentences.push(first);
    if (role) sentences.push(subject + ' carries the look of ' + portraitProseArticle(portraitProseLower(portraitProseClean(role))));
    if (clothes.length) sentences.push(subject + ' wears ' + portraitProseList(clothes));
    if (mood) sentences.push(possessive + ' expression is ' + portraitProseLower(portraitProseClean(mood)));
    if (location) sentences.push('Behind ' + objectPronoun + ', ' + portraitProseLower(portraitProseClean(location)));
    if (composition) sentences.push(portraitProseUpper(portraitProseClean(composition)));
    if (extraPositive) sentences.push(portraitProseUpper(portraitProseClean(extraPositive)));
    if (stylePositive) sentences.push(portraitProseUpper(portraitProseClean(stylePositive)));
    return sentences.map(item => item.replace(/\s+([,.])/g, '$1') + '.').join(' ');
}

export function buildNpcPortraitPrompts(rawNpc = {}, options = {}) {
    const npc = rawNpc && typeof rawNpc === 'object' ? rawNpc : {};
    const format = normalizePortraitPromptFormat(options.format);
    const stylePositive = cleanText(options.stylePositive ?? DEFAULT_PORTRAIT_STYLE_POSITIVE, PORTRAIT_STYLE_PROMPT_LIMIT);
    const styleNegative = cleanText(options.styleNegative ?? DEFAULT_PORTRAIT_STYLE_NEGATIVE, PORTRAIT_STYLE_PROMPT_LIMIT);
    const composition = cleanText(options.composition ?? DEFAULT_PORTRAIT_COMPOSITION, PORTRAIT_COMPOSITION_PROMPT_LIMIT);
    const useMood = options.useMood !== false;
    const useLocation = options.useLocation === true;
    const extraPositive = cleanText(npc.portraitPromptPositive ?? npc.portrait_prompt_positive, PORTRAIT_NPC_PROMPT_LIMIT);
    const extraNegative = cleanText(npc.portraitPromptNegative ?? npc.portrait_prompt_negative, PORTRAIT_NPC_PROMPT_LIMIT);
    const replaceAutomatic = Boolean(npc.portraitPromptReplace ?? npc.portrait_prompt_replace);

    const visualAge = cleanText(npc.apparentAge, 80) || cleanText(npc.age, 80);
    const species = cleanText(npc.species ?? npc.race, 160);
    const gender = normalizeGender(npc.gender ?? npc.sex);
    const role = cleanText(npc.role, 240);
    const appearance = cleanText(npc.appearance, 1800);
    const mood = useMood ? cleanText(npc.mood, 240) : '';
    const location = useLocation ? cleanText(npc.location, 300) : '';
    const appearanceGroups = splitPortraitAppearance(appearance);
    const identity = uniquePortraitParts([
        species,
        gender,
        visualAge ? 'apparent age ' + visualAge : '',
    ]);
    const roleTag = normalizePortraitAppearanceClause(role);
    const moodTag = normalizePortraitAppearanceClause(mood);
    const locationTag = normalizePortraitAppearanceClause(location);

    let positive = '';
    if (replaceAutomatic && extraPositive) {
        positive = extraPositive;
    } else if (format === 'natural') {
        positive = buildNaturalPortraitProse({
            name: cleanText(npc.name, 120),
            gender,
            rawGender: cleanText(npc.gender ?? npc.sex, 40),
            species,
            visualAge,
            role,
            appearance: splitPortraitAppearance(appearance, true),
            mood,
            location,
            composition,
            extraPositive,
            stylePositive,
        });
    } else {
        const visualAnchors = format === 'tags' ? extractPortraitVisualAnchorTags(appearance) : [];
        const coreAppearance = format === 'tags'
            ? portraitTagFallbackParts(appearanceGroups.core)
            : appearanceGroups.core;
        const subjectParts = uniquePortraitParts([
            ...identity,
            ...visualAnchors,
            ...coreAppearance,
            roleTag,
            ...appearanceGroups.clothing,
            moodTag,
            locationTag,
            composition,
            extraPositive,
        ]);
        positive = [...subjectParts, stylePositive].filter(Boolean).join(format === 'tags' ? ', ' : '; ');
    }

    const configuredNegative = normalizeName([styleNegative, extraNegative].filter(Boolean).join(' '));
    const derivedNegative = derivePortraitContradictionNegatives(appearance, extraPositive, replaceAutomatic)
        .filter(tag => !configuredNegative.includes(normalizeName(tag)));
    const negative = [...derivedNegative, styleNegative, extraNegative].filter(Boolean).join(', ');
    return {
        positive: String(positive || '').replace(/\s+/g, ' ').trim(),
        negative: String(negative || '').replace(/\s+/g, ' ').trim(),
        format,
        replaceAutomatic,
    };
}
