/* NPC State Delta identity and age helpers: clamp and value normalizers, identity kind, interim and role labels,
   slug/id/hash, age and apparent-age normalization. A pure part of core-mechanics.js (same owner, moved without
   change); core-mechanics.js re-exports every name it exported before. Imports only core-text.js. */
import { normalizeName, cleanText, cleanList } from './core-text.js';

export function clamp(value, min = 0, max = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, number));
}

export function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'on'].includes(text)) return true;
        if (['false', 'no', 'n', '0', 'off', ''].includes(text)) return false;
    }
    return Boolean(fallback);
}

export function normalizeGender(value) {
    const text = normalizeName(value);
    if (['male', 'man', 'boy'].includes(text)) return 'male';
    if (['female', 'woman', 'girl'].includes(text)) return 'female';
    return '';
}

const ROLE_LABEL_WORDS = new Set([
    'adventurer', 'apprentice', 'assistant', 'bartender', 'blacksmith', 'boy', 'captain', 'child', 'clerk', 'cook',
    'courier', 'drifter', 'elder', 'female', 'gate', 'girl', 'guard', 'guild', 'guildmaster', 'healer', 'innkeeper',
    'keeper', 'laborer', 'man', 'merchant', 'messenger', 'novice', 'officer', 'priest', 'priestess', 'receptionist',
    'refugee', 'runner', 'servant', 'soldier', 'stablehand', 'stable', 'hand', 'student', 'traveler', 'vendor', 'waiter', 'waitress',
    'watchman', 'woman', 'worker', 'butcher', 'baker', 'farmer', 'fisher', 'fisherman', 'fishmonger', 'carpenter', 'tailor',
    'cobbler', 'shopkeeper', 'storekeeper', 'grocer', 'porter', 'maid', 'hostler', 'groom', 'rancher', 'shepherd', 'herder',
    'miner', 'miller', 'brewer', 'tanner', 'scribe', 'librarian', 'teacher', 'doctor', 'nurse', 'midwife', 'barber',
    'young', 'old', 'older', 'elderly', 'masked', 'hooded', 'mysterious', 'local',
    'village', 'town', 'city', 'guildhall', 'human', 'elf', 'elven', 'dwarf', 'dwarven', 'half', 'halfelf', 'dwelf',
    'tiefling', 'orc', 'orcish', 'goblin', 'halfling', 'gnome', 'male', 'warrior', 'mage', 'wizard', 'witch', 'knight',
]);

export function inferNpcIdentityKind(name, explicit = '') {
    const stated = String(explicit ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const tokens = normalizeName(name).split(/\s+/).filter(Boolean);
    if (!tokens.length) return 'unknown';
    const roleLike = tokens.every(token => ROLE_LABEL_WORDS.has(token) || /^\d+$/.test(token));
    const inferred = roleLike ? 'role_label' : 'proper_name';
    // A model occasionally labels an obvious personal name as role_label. The deterministic
    // name heuristic wins in that direction so Conservative mode cannot strand names such as
    // Myla/Toris as candidates. Explicit proper_name remains authoritative.
    if (stated === 'proper_name') return 'proper_name';
    if (stated === 'role_label') {
        const clearlyPersonal = (tokens.length === 1 && !ROLE_LABEL_WORDS.has(tokens[0]))
            || (tokens.length > 1 && tokens.every(token => !ROLE_LABEL_WORDS.has(token) && !/^\d+$/.test(token)));
        return clearlyPersonal ? 'proper_name' : 'role_label';
    }
    return inferred;
}

const INTERIM_IDENTITY_WORDS = new Set([
    'unknown', 'unnamed', 'unidentified', 'anonymous', 'stranger', 'figure', 'person', 'npc',
    'man', 'woman', 'boy', 'girl', 'child', 'guard', 'receptionist', 'bartender', 'innkeeper',
    'merchant', 'vendor', 'clerk', 'waiter', 'waitress', 'soldier', 'officer', 'watchman', 'sentry',
    'sentinel', 'stablehand', 'blacksmith', 'healer', 'priest', 'priestess', 'servant', 'maid',
    'attendant', 'worker', 'laborer', 'courier', 'messenger', 'shopkeeper', 'keeper', 'owner',
    'proprietor', 'captain', 'chief', 'leader', 'elder', 'student', 'apprentice', 'assistant',
    'human', 'elf', 'dwarf', 'orc', 'goblin', 'halfling', 'gnome', 'tiefling', 'traveler', 'drifter',
]);

const LABEL_FILLER_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'from', 'at', 'in', 'on', 'that', 'this']);

// A label that describes a role rather than naming one person ("Innkeeper", "the innkeeper",
// "the old man", "Guard Captain"). Many people can fit it, so it never recalls a dossier and
// never merges a new NPC into a named one on its own. A label with a capitalised non-role word
// ("Red", "the Butcher of Vell", "Sister Callow") names someone.
export function isRoleDescriptionLabel(label) {
    const raw = String(label ?? '').trim();
    if (!raw || !normalizeName(raw)) return false;
    if (isInterimNpcLabel(raw)) return true;
    const content = raw.split(/\s+/).map(word => word.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean)
        .filter(word => !LABEL_FILLER_WORDS.has(word.toLowerCase()));
    return content.length > 0 && content.every(word => word === word.toLowerCase());
}

// A phrase that describes someone instead of naming them ("leader in the gambeson", "woman with the scar"): three or more words, none
// capitalised, one of them a linking word. Uncased scripts (no lowercase letter) never count, and a role label ("old man", "the innkeeper")
// has no linking word, so it stays on the role path. A new person written this way is not admitted (core-merge.js).
const LINKING_WORDS = new Set(['in', 'with', 'of', 'at', 'from', 'on', 'by', 'under', 'behind', 'beside', 'near', 'wearing', 'carrying', 'holding']);
export function isDescriptivePhrase(label) {
    const words = String(label ?? '').trim().split(/\s+/).filter(Boolean);
    return words.length >= 3 && words.some(word => /\p{Ll}/u.test(word)) && words.every(word => word === word.toLowerCase())
        && words.some(word => LINKING_WORDS.has(word));
}

export function isInterimNpcLabel(name, explicit = '') {
    const text = normalizeName(name);
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    if (inferNpcIdentityKind(name, explicit) === 'role_label') return true;
    // Catch descriptive placeholders such as "red haired woman" or "masked elf" that
    // contain free-form adjectives and therefore are not caught by the all-role-word heuristic.
    const finalToken = tokens[tokens.length - 1];
    const hasPlaceholderMarker = tokens.some(token => ['unknown', 'unnamed', 'unidentified', 'anonymous', 'mysterious', 'masked', 'hooded'].includes(token));
    return tokens.length <= 6 && (hasPlaceholderMarker || INTERIM_IDENTITY_WORDS.has(finalToken));
}

export function identityLabelsRelated(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) return false;
    return left === right || (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)));
}

export function findInterimIdentityPromotionIndex(records, incoming) {
    if (!Array.isArray(records)) return -1;
    const incomingName = cleanText(incoming?.name, 120);
    if (!incomingName || inferNpcIdentityKind(incomingName, incoming?.identityKind) !== 'proper_name') return -1;

    // An explicit sameIndividual:false is authoritative unless the model also supplied the
    // old interim label as an alias. Omitted sameIndividual is NOT treated as a veto: models
    // frequently reveal a proper name while forgetting the continuity flag.
    const incomingAliases = cleanList(incoming?.aliases, 8, 120).map(normalizeName).filter(Boolean);
    const incomingRole = cleanText(incoming?.role, 180);
    const incomingLocation = normalizeName(incoming?.location);
    const matches = [];
    for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record || !isInterimNpcLabel(record.name, record.identityKind)) continue;
        const oldLabels = [record.name, ...(record.aliases || [])].map(normalizeName).filter(Boolean);
        const aliasClaim = oldLabels.some(label => incomingAliases.includes(label));
        if (incoming?.sameIndividualProvided && !incoming.sameIndividual && !aliasClaim) continue;

        const roleMatch = incomingRole
            ? identityLabelsRelated(record.role, incomingRole) || identityLabelsRelated(record.name, incomingRole)
            : false;
        const recordLocation = normalizeName(record.location);
        const locationConflict = incomingLocation && recordLocation && incomingLocation !== recordLocation;
        if (locationConflict) continue;
        const locationMatch = Boolean(incomingLocation && recordLocation && incomingLocation === recordLocation);

        // Strong continuity can be established by any one of: explicit old-label alias,
        // unique role continuity, or sameIndividual plus a non-conflicting scene/location.
        // Requiring uniqueness below prevents fusing two generic guards/receptionists.
        const samePersonSignal = Boolean(incoming?.sameIndividual);
        if (!aliasClaim && !roleMatch && !(samePersonSignal && (locationMatch || !incomingRole))) continue;
        matches.push(i);
    }
    return matches.length === 1 ? matches[0] : -1;
}

export function normalizeDossierSignal(value) {
    const signal = String(value ?? '').trim().toLowerCase();
    return ['incidental', 'meaningful', 'persistent'].includes(signal) ? signal : 'incidental';
}

export function slugify(value) {
    const slug = normalizeName(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'npc';
}

export function makeNpcId(name, existingIds = []) {
    const base = `npc_${slugify(name)}`;
    if (!existingIds.includes(base)) return base;
    let i = 2;
    while (existingIds.includes(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function stableAgeInRange(min, max, seed) {
    const low = Math.max(0, Math.round(Number(min) || 0));
    const high = Math.max(low, Math.round(Number(max) || low));
    const span = high - low + 1;
    return low + (stableHash(seed) % span);
}

export function ageSpecificity(value) {
    const age = String(value ?? '').trim();
    if (/^\d{1,3}$/.test(age)) return 3;
    if (/^~\d{1,3}$/.test(age)) return 2;
    return age ? 1 : 0;
}

function normalizedAgeText(value) {
    return cleanText(value, 80).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

const AGE_ONES = Object.freeze({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
});
const AGE_TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const AGE_DECADES = Object.freeze({ twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, nineties: 90 });
export const AGE_NUMBER_WORD_RE = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|fifty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|sixty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|seventy(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|eighty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|ninety(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one hundred(?: and)?(?:[- ](?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|fifty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|sixty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|seventy(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|eighty(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|ninety(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))))?)';

function parseEnglishAgeNumber(value) {
    let text = normalizedAgeText(value).replace(/-/g, ' ').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (/^\d{1,3}$/.test(text)) {
        const number = Number(text);
        return number >= 0 && number <= 200 ? number : null;
    }
    if (Object.prototype.hasOwnProperty.call(AGE_ONES, text)) return AGE_ONES[text];
    const parts = text.split(' ').filter(Boolean);
    let total = 0;
    let used = false;
    for (const part of parts) {
        if (part === 'hundred') {
            if (!used || total < 1 || total > 9) return null;
            total *= 100;
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(AGE_ONES, part)) {
            total += AGE_ONES[part]; used = true; continue;
        }
        if (Object.prototype.hasOwnProperty.call(AGE_TENS, part)) {
            total += AGE_TENS[part]; used = true; continue;
        }
        return null;
    }
    return used && total >= 0 && total <= 200 ? total : null;
}

function decadeWordRange(value) {
    const decade = AGE_DECADES[normalizedAgeText(value)];
    return Number.isFinite(decade) ? [decade, decade + 9] : null;
}

function hasQualitativeAgeCue(value) {
    const lower = normalizedAgeText(value);
    return /\b(newborn|infant|toddler|child|pre[- ]?teen|adolescent|teen(?:ager)?|young adult|young|middle[- ]aged|older adult|elderly|senior|adult)\b/i.test(lower)
        || /^(?:looks?|appears?|apparent(?:ly)?)/i.test(lower)
        || /^(?:(?:about|around|approx(?:\.|imately)?)\s+)?(?:early|mid|middle|late)\s+(?:\d{2,3}s|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)$/i.test(lower)
        || /^(?:(?:about|around|approx(?:\.|imately)?)\s+)?(?:twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)$/i.test(lower)
        || /^\d{1,3}\s*(?:-|to)\s*\d{1,3}$/i.test(lower);
}

function isUnknownAgePlaceholder(value) {
    const lower = normalizedAgeText(value);
    return !lower || /^(?:unknown|unk|n\/?a|none|unspecified|not\s+(?:known|established|specified|stated)|unclear|not\s+available)$/i.test(lower);
}

/**
 * Chronological age. This field is for actual story age only, never visual-age adjectives.
 * Exact numbers are normalized; otherwise grounded chronological wording is preserved.
 */
export function normalizeAge(value) {
    const cleaned = cleanText(value, 80);
    if (!cleaned || isUnknownAgePlaceholder(cleaned)) return '';
    const lower = normalizedAgeText(cleaned);
    let match = lower.match(/^(?:age\s*[:=]?\s*)?(\d{1,3})(?:\s*(?:years?|yrs?)\s*(?:old)?)?$/i);
    if (match) {
        const number = Number(match[1]);
        if (Number.isFinite(number) && number >= 0 && number <= 999) return String(Math.round(number));
    }
    const wordMatch = lower.match(new RegExp(`^(?:age\\s*[:=]?\\s*)?(${AGE_NUMBER_WORD_RE})(?:\\s*(?:years?|yrs?)\\s*(?:old)?)?$`, 'i'));
    if (wordMatch) {
        const number = parseEnglishAgeNumber(wordMatch[1]);
        if (Number.isFinite(number)) return String(number);
    }
    // A qualitative visual cue belongs in apparentAge, not chronological age.
    if (hasQualitativeAgeCue(lower)) return '';
    return cleaned;
}

/**
 * Visual/apparent age for portrait prompting. Descriptor/range evidence becomes a stable ~N.
 * The estimate is seeded by NPC identity + evidence so repeated scans do not reroll it.
 */
export function normalizeApparentAge(value, seed = '') {
    const cleaned = cleanText(value, 80);
    if (!cleaned || isUnknownAgePlaceholder(cleaned)) return '';
    let lower = normalizedAgeText(cleaned);

    // Normalize the common prose wrappers first so the stored field remains compact.
    lower = lower
        .replace(/^(?:looks?|appears?)\s+(?:to\s+be\s+)?/i, '')
        .replace(/^apparent(?:ly)?(?:\s+age)?\s*[:=]?\s*/i, '')
        .replace(/^(?:about|around|approx(?:\.|imately)?)\s+/i, '')
        .replace(/^in\s+(?:his|her|their)\s+/i, '')
        .trim();

    let match = lower.match(/^~?(\d{1,3})(?:\s*(?:years?|yrs?)\s*(?:old)?)?$/i);
    if (match) {
        const number = Number(match[1]);
        if (Number.isFinite(number) && number >= 0 && number <= 200) return `~${Math.round(number)}`;
    }

    match = lower.match(new RegExp(`^(${AGE_NUMBER_WORD_RE})(?:\\s*(?:years?|yrs?)\\s*(?:old)?)?$`, 'i'));
    if (match) {
        const number = parseEnglishAgeNumber(match[1]);
        if (Number.isFinite(number)) return `~${number}`;
    }

    match = lower.match(/^(\d{1,3})\s*(?:-|to)\s*(\d{1,3})(?:\s*(?:years?|yrs?)\s*(?:old)?)?$/i);
    if (match) {
        const a = Number(match[1]);
        const b = Number(match[2]);
        if ([a, b].every(Number.isFinite) && a >= 0 && b >= 0 && a <= 200 && b <= 200) {
            const min = Math.min(a, b);
            const max = Math.max(a, b);
            return `~${stableAgeInRange(min, max, `${seed}|${lower}`)}`;
        }
    }

    match = lower.match(/^(early|mid|middle|late)\s+(\d{2,3})s$/i);
    if (match) {
        const decade = Number(match[2]);
        if (Number.isFinite(decade) && decade >= 10 && decade <= 190) {
            const band = match[1] === 'early' ? [decade, decade + 3]
                : (match[1] === 'late' ? [decade + 7, decade + 9] : [decade + 4, decade + 6]);
            return `~${stableAgeInRange(band[0], band[1], `${seed}|${lower}`)}`;
        }
    }

    match = lower.match(/^(early|mid|middle|late)\s+(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)$/i);
    if (match) {
        const range = decadeWordRange(match[2]);
        if (range) {
            const decade = range[0];
            const band = match[1] === 'early' ? [decade, decade + 3]
                : (match[1] === 'late' ? [decade + 7, decade + 9] : [decade + 4, decade + 6]);
            return `~${stableAgeInRange(band[0], band[1], `${seed}|${lower}`)}`;
        }
    }

    const decadeRange = decadeWordRange(lower);
    if (decadeRange) return `~${stableAgeInRange(decadeRange[0], decadeRange[1], `${seed}|${lower}`)}`;

    const qualitativeRanges = [
        [/\bnewborn\b|\binfant\b/i, 0, 2],
        [/\btoddler\b/i, 2, 4],
        [/\bpre[- ]?teen\b/i, 10, 12],
        [/\badolescent\b/i, 13, 17],
        [/\bteen(?:ager)?\b/i, 13, 19],
        [/\byoung adult\b/i, 18, 29],
        [/\byoung\b/i, 18, 29],
        [/\bmiddle[- ]aged\b/i, 40, 59],
        [/\bolder adult\b/i, 55, 74],
        [/\belderly\b|\bsenior\b/i, 65, 85],
        [/\bchild\b/i, 6, 11],
        [/\badult\b/i, 25, 44],
    ];
    for (const [pattern, min, max] of qualitativeRanges) {
        if (pattern.test(lower)) return `~${stableAgeInRange(min, max, `${seed}|${lower}`)}`;
    }

    // Apparent Age is a compact visual estimate, not a prose field. Unknown wording is
    // intentionally rejected rather than allowed to drift into "around twenties"-style text.
    return '';
}

export function normalizeAgeFields(raw = {}) {
    const seed = raw.name || raw.id || raw.species || raw.race || '';
    const rawAge = cleanText(raw.age, 80);
    const rawApparent = cleanText(raw.apparentAge ?? raw.apparent_age, 80);
    let age = normalizeAge(rawAge);
    let apparentAge = normalizeApparentAge(rawApparent, seed);

    // Defensive scanner compatibility: qualitative cues accidentally returned in age are visual age.
    if (rawAge && !age && !apparentAge) apparentAge = normalizeApparentAge(rawAge, seed);
    return { age, apparentAge };
}

export function normalizeStoredAgeFields(raw = {}) {
    const seed = raw.name || raw.id || raw.species || raw.race || '';
    return {
        age: normalizeAge(cleanText(raw.age, 80)),
        apparentAge: normalizeApparentAge(cleanText(raw.apparentAge ?? raw.apparent_age, 80), seed),
    };
}

export const NPC_LIFE_STATES = Object.freeze(['unknown', 'alive', 'deceased']);

export function normalizeLifeState(value) {
    const state = String(value ?? '').trim().toLowerCase();
    return NPC_LIFE_STATES.includes(state) ? state : 'unknown';
}
