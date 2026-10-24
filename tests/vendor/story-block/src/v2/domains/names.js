// Item names: the alias index, singular/plural tolerance and story slugs. Pure.
//
// The model writes names, code keeps IDs (§2.1). A name is looked up in the inventory's
// `aliases` (lowercase name → def ID). The alias index is authoritative: an exact alias wins.
// Without one, the name's singular and plural forms are tried against the aliases and the
// defs' own names; when that finds more than one def the name is ambiguous and the caller
// rejects it rather than pick one (§4.4).

import { cutAt } from '../../text.js';

const ARTICLES = /^(?:a|an|the|some)\s+/i;

/**
 * A written name tidied for display: one line, single spaces, no leading article, in Unicode NFC (so
 * "Rópe" written precomposed or decomposed is one name) and without invisible format characters
 * (zero-width spaces and joiners, bidi marks), which would make two names that look the same.
 */
export function cleanName(name) {
    return String(name ?? '').replace(/\p{Cf}+/gu, '').normalize('NFC').replace(/\s+/g, ' ').trim().replace(ARTICLES, '').trim();
}

/** The alias index key for a name. */
export const aliasKey = name => cleanName(name).toLowerCase();

// One word's other number: "ropes" → "rope", "berries" → "berry", "box" → "boxes".
function wordForms(word) {
    const forms = new Set([word]);
    if (/[^aeiou]ies$/.test(word)) forms.add(`${word.slice(0, -3)}y`);
    if (/(?:s|x|z|ch|sh|o)es$/.test(word)) forms.add(word.slice(0, -2));
    if (/[^s]s$/.test(word)) forms.add(word.slice(0, -1));
    if (/[^aeiou]y$/.test(word)) forms.add(`${word.slice(0, -1)}ies`);
    else if (/(?:s|x|z|ch|sh)$/.test(word)) forms.add(`${word}es`);
    else forms.add(`${word}s`);
    return forms;
}

/**
 * Lookup keys for a name, the exact key first: the head word changes number
 * ("Flasks of Oil" → "flask of oil", "Healing Potion" → "healing potions").
 */
export function nameForms(name) {
    const key = aliasKey(name);
    if (!key) return [];
    const of = key.indexOf(' of ');
    const head = of > 0 ? key.slice(0, of) : key;
    const tail = of > 0 ? key.slice(of) : '';
    const cut = head.lastIndexOf(' ');
    const before = head.slice(0, cut + 1);
    const word = head.slice(cut + 1);
    return [...new Set([key, ...[...wordForms(word)].map(form => `${before}${form}${tail}`)])];
}

// ---------- tolerant lookup (fetch quests, recipes, `- item` lines) ----------
//
// The story writes the same thing in many ways: "a handful of moonpetals", "some rope", "two pieces of
// chalk", "alloy of sulfur (piece)" for "Sulfur Alloy". When the exact name and its singular/plural miss,
// the lookup tries the name without its portion words, and then a key that ignores word order: the
// name's words without portion and stop words, each made singular, sorted. Only a fallback: an exact
// alias or name always wins, and a key two defs share is ambiguous like any other.

// Portion and measure words before a thing ("a handful of", "pieces of", "a pair of", "a few").
const PORTION_WORDS = 'handful|piece|pair|bit|chunk|pinch|lump|bunch|portion|slice|scrap|sprig|strip|dash|drop|length|coil|bundle|heap|pile|couple|scoop|measure|dose|helping|sack|sliver';
const PORTION = new RegExp(`^(?:(?:a|an|one|two|three|four|five|a few|few|several|some|\\d+)\\s+)?(?:${PORTION_WORDS})(?:s|es)?\\s+of\\s+`, 'i');
const FEW = /^(?:a few|a couple of|several|few|some)\s+/i;
const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'some', 'with', 'for']);
const PORTION_SET = new Set(PORTION_WORDS.split('|').flatMap(word => [word, `${word}s`, `${word}es`]));

/** A key without its portion words: "a handful of Moonpetals" → "moonpetals" (as aliasKey writes it). */
export function portionless(name) {
    let key = aliasKey(name).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    for (let n = 0; n < 2; n += 1) key = key.replace(PORTION, '').replace(FEW, '').trim();
    return key;
}

// One word made singular, the same way for the name written and the def's name.
function singular(word) {
    if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
    if (/(?:s|x|z|ch|sh|o)es$/.test(word)) return word.slice(0, -2);
    if (/[^s]s$/.test(word)) return word.slice(0, -1);
    return word;
}

const LOOSE_CACHE = new Map();
const LOOSE_CACHE_MAX = 5000;

/**
 * The word-order-insensitive key of a name: "Alloy of Sulfur (piece)" and "sulfur alloys" → "alloy sulfur".
 * Tokens with digits keep their order after the words ("Charm 1-2" → "charm #1 2"). '' when nothing is left.
 */
export function looseKey(name) {
    const text = String(name ?? '');
    const known = LOOSE_CACHE.get(text);
    if (known !== undefined) return known;
    const words = portionless(text).split(/[^\p{L}\p{N}']+/u)
        .filter(word => word && !STOP.has(word) && !PORTION_SET.has(word))
        .map(singular);
    // Only plain words change places: a token with a digit (a number, a size) keeps its order, so
    // "Charm 1-2" and "Charm 2-1" stay two names.
    const plain = words.filter(word => !/\p{N}/u.test(word)).sort();
    const counted = words.filter(word => /\p{N}/u.test(word));
    const key = counted.length ? `${plain.join(' ')} #${counted.join(' ')}` : plain.join(' ');
    if (LOOSE_CACHE.size >= LOOSE_CACHE_MAX) LOOSE_CACHE.clear();
    LOOSE_CACHE.set(text, key);
    return key;
}

// Exact alias, then the defs' own names, then singular/plural forms: a Set of def ids.
function strictIds(defs, aliases, name) {
    const key = aliasKey(name);
    if (!key) return new Set();
    if (aliases[key] && defs[aliases[key]]) return new Set([aliases[key]]);
    const named = form => Object.keys(defs).filter(id => aliasKey(defs[id]?.name) === form);
    const ids = new Set(named(key));
    if (!ids.size) {
        for (const form of nameForms(name)) {
            if (aliases[form] && defs[aliases[form]]) ids.add(aliases[form]);
            named(form).forEach(id => ids.add(id));
        }
    }
    return ids;
}

/**
 * The def a name means in an inventory slice:
 * { status: 'found', id, ids: [id] } | { status: 'ambiguous', ids } | { status: 'none', ids: [] }.
 * Exact alias first; then names and singular/plural forms; then (tolerant) the same without portion
 * words; then the word-order key against every alias and def name.
 */
export function resolveDef(inventory, name) {
    const defs = inventory?.defs ?? {};
    const aliases = inventory?.aliases ?? {};
    const key = aliasKey(name);
    if (!key) return { status: 'none', ids: [] };
    let ids = strictIds(defs, aliases, name);
    if (!ids.size) {
        const bare = portionless(name);
        if (bare && bare !== key) ids = strictIds(defs, aliases, bare);
    }
    if (!ids.size) {
        const loose = looseKey(name);
        if (loose) {
            for (const [alias, id] of Object.entries(aliases)) if (defs[id] && looseKey(alias) === loose) ids.add(id);
            for (const id of Object.keys(defs)) if (looseKey(defs[id]?.name) === loose) ids.add(id);
        }
    }
    const list = [...ids].sort();
    if (list.length === 1) return { status: 'found', id: list[0], ids: list };
    return list.length ? { status: 'ambiguous', ids: list } : { status: 'none', ids: [] };
}

// FNV-1a over the name, in base36: a stable slug for a name with no Latin letters or digits.
function hashSlug(text) {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * "Moonveil Trout" → "moonveil-trout": ASCII letters and digits only, as check.js's DEF_ID wants
 * (accents dropped); a name with none of them ("魔剣") gets "item-<hash of the name>".
 */
export function slugify(name) {
    const key = aliasKey(name);
    const slug = key
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '');
    return slug || `item-${hashSlug(key)}`;
}

/** A note or name cut to `max` characters with an ellipsis. */
export function trimText(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${cutAt(value, max - 1).trimEnd()}…` : value;
}
