// NPC notes, ties (phase 2 item 6): ally, rival and owes tags between any two people, also used by the map's Focus lines. The slice
// record's `ties` leaf (one JSON text: { "<other key>": ["ally", "owes"] }, at most twelve people, canonical tag order), its reader
// (readTies), the story's `~ tie` change (applyTags: +tag adds, -tag drops, idempotent so a re-read or replay is a no-op), the
// canonical text for the host to store (tiesText), the read-time fallback from a bond's relation word (tagsFromRelation; stored tags
// always win and the fallback is never stored), the people who owe a given person (owedBy: "owes" is one way, the owing side stores
// it) and the dossier rows for the people in the bond list (tiesView). Pure; imports only the key, text and relation helpers.
import { clean, npcKey } from './npc-meters-config.js';
import { socialRelationFamily } from '../social-relations.js';

export const TIE_TAGS = ['ally', 'rival', 'owes'];
export const TIES_MAX_PEOPLE = 12;
export const TIES_TEXT_MAX = 1600;
const NAME_MAX = 120;
const TAG_CHANGE = /^([+-])(ally|rival|owes)$/;
const ALLY_FAMILIES = new Set(['friend', 'partner', 'ally']);
const RIVAL_FAMILIES = new Set(['rival', 'enemy']);
const OWES_FAMILIES = new Set(['benefactor', 'creditor']);

const ordered = tags => TIE_TAGS.filter(tag => tags.includes(tag));
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const keyOf = name => npcKey(clean(name, NAME_MAX));

function validTags(value) {
    return Array.isArray(value) && value.length > 0 && value.length <= TIE_TAGS.length
        && new Set(value).size === value.length && value.every(tag => TIE_TAGS.includes(tag))
        && ordered(value).join() === value.join();
}

/** The parsed ties of stored text, or null when the text is absent, too long, or not valid in every part. `{}` is a valid empty record. */
export function readTies(stored) {
    if (typeof stored !== 'string' || !stored || stored.length > TIES_TEXT_MAX) return null;
    let value;
    try { value = JSON.parse(stored); } catch { return null; }
    if (!isPlainObject(value)) return null;
    const keys = Object.keys(value);
    if (keys.length > TIES_MAX_PEOPLE) return null;
    if (!keys.every(key => npcKey(key) === key && validTags(value[key]))) return null;
    return value;
}

/** The canonical stored text of a ties object (keys sorted, tags in TIE_TAGS order), or null when no one is tied (the host drops the leaf). */
export function tiesText(ties) {
    const keys = Object.keys(ties ?? {}).filter(key => Array.isArray(ties[key]) && ties[key].length).sort();
    if (!keys.length) return null;
    const out = {};
    for (const key of keys) out[key] = ordered(ties[key]);
    return JSON.stringify(out);
}

/**
 * The story's `~ tie` change, applied to a ties object (or null). `change` is { self, with, tags }, where tags are "+ally", "-rival",
 * "+owes" (this person owes `with`). Returns { ties, changed, ignored, refused }: `ties` is a new object (the input is never mutated),
 * `ignored` lists the tag words that were not `+`/`-` plus one of ally, rival, owes, and `refused` is 'self' (tying a person to
 * themself), 'name' (a name with no key), 'people' (a new person beyond the twelve) or null.
 */
export function applyTags(ties, change) {
    const base = readTiesObject(ties);
    const selfKey = keyOf(change?.self);
    const withKey = keyOf(change?.with);
    const ignored = [];
    const refuse = (refused) => ({ ties: base, changed: false, ignored, refused });
    if (!withKey) return refuse('name');
    if (selfKey === withKey) return refuse('self');
    const current = new Set(base[withKey] ?? []);
    for (const raw of Array.isArray(change?.tags) ? change.tags : []) {
        const match = TAG_CHANGE.exec(String(raw ?? '').trim());
        if (!match) { ignored.push(String(raw ?? '')); continue; }
        if (match[1] === '+') current.add(match[2]);
        else current.delete(match[2]);
    }
    if (!current.size && !(withKey in base)) return { ties: base, changed: false, ignored, refused: null };
    if (current.size && !(withKey in base) && Object.keys(base).length >= TIES_MAX_PEOPLE) return refuse('people');
    const next = { ...base };
    if (current.size) next[withKey] = ordered([...current]);
    else delete next[withKey];
    const changed = tiesText(next) !== tiesText(base);
    return { ties: sortedCopy(next), changed, ignored, refused: null };
}

/** The tags a bond's relation word implies, read from this person's side (no storage). benefactor or creditor: this one owes them;
 * friend, partner or ally: ally; rival or enemy: rival. A debtor owes this one, which is stored on their side (see owedBy), so none here. */
export function tagsFromRelation(relation) {
    const family = socialRelationFamily(clean(relation, NAME_MAX));
    const tags = [];
    if (ALLY_FAMILIES.has(family)) tags.push('ally');
    if (RIVAL_FAMILIES.has(family)) tags.push('rival');
    if (OWES_FAMILIES.has(family)) tags.push('owes');
    return ordered(tags);
}

/** The keys of the people who owe `selfKey`: `others` maps an owner's key to that owner's ties object (or null). Sorted. */
export function owedBy(selfKey, others) {
    const owners = [];
    for (const [owner, ties] of Object.entries(others ?? {})) {
        if (owner !== selfKey && Array.isArray(ties?.[selfKey]) && ties[selfKey].includes('owes')) owners.push(owner);
    }
    return owners.sort();
}

/**
 * Dossier rows for the people in a bond list (bond strings "Name — relation | dynamic", or bare names), in bond order: only people
 * with a tag or an owed-by line, never anyone outside the list. Each row: { key, name, tags, owes, owedBy }. `owedByKeys` comes from owedBy.
 */
export function tiesView(ties, bonds, owedByKeys = []) {
    const base = readTiesObject(ties);
    const rows = [];
    const seen = new Set();
    for (const entry of Array.isArray(bonds) ? bonds : []) {
        const name = clean(String(entry ?? '').split(/\s+[—-]\s+|\s*\|/)[0], NAME_MAX);
        const key = keyOf(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const tags = ordered(base[key] ?? []);
        const owed = owedByKeys.includes(key);
        if (!tags.length && !owed) continue;
        rows.push({ key, name, tags, owes: tags.includes('owes'), owedBy: owed });
    }
    return rows;
}

function readTiesObject(ties) {
    return isPlainObject(ties) ? sortedCopy(ties) : {};
}

function sortedCopy(ties) {
    const out = {};
    for (const key of Object.keys(ties).sort()) out[key] = ordered(ties[key]);
    return out;
}
