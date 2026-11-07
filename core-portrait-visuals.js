/* NPC State Delta portrait visual analysis: appearance typing, hair/eye/body tags, direct visual
   anchors and contradiction negatives used by the portrait prompt builder. Split unchanged from
   core-portrait.js; these helpers are module-internal rather than public core exports. */
import { cleanText, normalizeName } from './core-text.js';

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

export function extractPortraitVisualAnchorTags(value) {
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


export function portraitTagFallbackParts(values = []) {
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

export function portraitPartKey(value) {
    return normalizeName(value).replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

export function uniquePortraitParts(values = []) {
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

export function normalizePortraitAppearanceClause(value, clothing = false, keepArticle = false) {
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

export function splitPortraitAppearance(value, keepArticle = false) {
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

export function derivePortraitContradictionNegatives(appearance, extraPositive, replaceAutomatic = false) {
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
