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

/**
 * The def a name means in an inventory slice:
 * { status: 'found', id, ids: [id] } | { status: 'ambiguous', ids } | { status: 'none', ids: [] }.
 */
export function resolveDef(inventory, name) {
    const defs = inventory?.defs ?? {};
    const aliases = inventory?.aliases ?? {};
    const key = aliasKey(name);
    if (!key) return { status: 'none', ids: [] };
    if (aliases[key] && defs[aliases[key]]) return { status: 'found', id: aliases[key], ids: [aliases[key]] };
    const named = form => Object.keys(defs).filter(id => aliasKey(defs[id]?.name) === form);
    const ids = new Set(named(key));
    if (!ids.size) {
        for (const form of nameForms(name)) {
            if (aliases[form] && defs[aliases[form]]) ids.add(aliases[form]);
            named(form).forEach(id => ids.add(id));
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
