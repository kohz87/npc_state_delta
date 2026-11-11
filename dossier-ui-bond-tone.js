/* NPC State Delta dossier bond tone: maps a relation text to a display tone (close, hostile, duty, neutral)
   and to the short relation word shown under the name. Pure: no DOM, no storage. Family detection comes
   from social-relations.js; the enemy and duty words are matched here because that file has no such family. */
import { escapeHtml } from './src/util/html.js';
import { norm } from './social-primitives.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { socialRelationFamily } from './social-relations.js';

const HOSTILE_WORD = /\b(?:enem|foe|nemesis|hate)\w*/;
const DUTY_WORD = /\b(?:owes?|owed|debts?|duty|duties|oath|sworn|indebted)\b/;
const CLOSE_FAMILIES = new Set([
    'child', 'parent', 'sibling', 'partner', 'mentor', 'student', 'guardian', 'ward', 'friend',
    'cousin', 'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild',
    'parent-in-law', 'child-in-law', 'sibling-in-law',
]);
const WORD_FOR_FAMILY = { 'aunt-uncle': 'aunt/uncle', 'niece-nephew': 'niece/nephew' };
const MAX_WORD_CHARS = 24;

// Tone precedence: hostile first (a "former friend turned enemy" is hostile), then duty, then close kin or
// friend-like families, else neutral. Empty or unknown text is neutral.
export function bondTone(relationText) {
    const rel = norm(relationText);
    if (!rel) return 'neutral';
    if (HOSTILE_WORD.test(rel) || socialRelationFamily(rel) === 'rival') return 'hostile';
    if (DUTY_WORD.test(rel)) return 'duty';
    if (CLOSE_FAMILIES.has(socialRelationFamily(rel))) return 'close';
    return 'neutral';
}

// The short word to show under the name. A recognised family is shown by its name ("aunt/uncle",
// "parent in law"); otherwise the enemy or duty word itself; otherwise the first two words, capped in length.
export function bondWord(relationText) {
    const rel = norm(relationText);
    if (!rel) return '';
    const hostile = rel.match(HOSTILE_WORD);
    if (hostile) return hostile[0];
    const family = socialRelationFamily(rel);
    if (family !== rel) return WORD_FOR_FAMILY[family] || family.replace(/-/g, ' ');
    const duty = rel.match(DUTY_WORD);
    if (duty) return duty[0];
    return rel.split(' ').slice(0, 2).join(' ').slice(0, MAX_WORD_CHARS).trim();
}

// The dossier's "Important bonds" list: each entry keeps its full text, prefixed by the relation word as a
// chip carrying the tone class. Entries that do not parse as "Name — relation" are drawn plain.
export function bondsListHtml(items, empty) {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) return `<p class="delta-muted">${escapeHtml(empty)}</p>`;
    return `<ul class="delta-list delta-bond-list">${rows.map(item => {
        const relation = parseKeyRelationshipEntry(item)?.relation || '';
        const word = bondWord(relation);
        const chip = word ? `<span class="delta-bond-word delta-bond-${bondTone(relation)}">${escapeHtml(word)}</span> ` : '';
        return `<li>${chip}${escapeHtml(item)}</li>`;
    }).join('')}</ul>`;
}
